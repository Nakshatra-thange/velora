import * as anchor from "@coral-xyz/anchor";
import { Program, BN }  from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assert }  from "chai";
import { Velora }  from "../target/types/velora";

// ─────────────────────────────────────────────
//  PDA HELPERS
// ─────────────────────────────────────────────

function registryPDA(op: PublicKey, pid: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("operator"), op.toBuffer()], pid)[0];
}
function vaultPDA(op: PublicKey, pid: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("escrow"), op.toBuffer()], pid)[0];
}
function scorePDA(op: PublicKey, pid: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("score"), op.toBuffer()], pid)[0];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
//  SEND HELPERS
// ─────────────────────────────────────────────

async function confirm(connection: anchor.web3.Connection, sig: string) {
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh });
}

// ─────────────────────────────────────────────
//  SUITE
// ─────────────────────────────────────────────

describe("velora — week 2", () => {
  const provider   = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program    = anchor.workspace.Velora as any;
  const connection = provider.connection;

  // fresh keypairs per test — no shared state bleeds between tests
  let operator: Keypair;
  let merchant: Keypair;

  beforeEach(() => {
    operator = Keypair.generate();
    merchant = Keypair.generate();
  });

  // ── airdrop ───────────────────────────────────
  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await confirm(connection, sig);
  }

  // ── full setup: register + deposit bond ───────
  async function setupOperator(feeBps = 50, bondSol = 2) {
    await airdrop(operator.publicKey, bondSol + 5);

    const reg   = registryPDA(operator.publicKey, program.programId);
    const vault = vaultPDA(operator.publicKey, program.programId);
    const score = scorePDA(operator.publicKey, program.programId);

    await program.methods
      .registerOperator(feeBps)
      .accounts({ operator: operator.publicKey, operatorRegistry: reg, escrowVault: vault })
      .signers([operator])
      .rpc();

    await program.methods
      .depositBond(new BN(bondSol * LAMPORTS_PER_SOL))
      .accounts({ operator: operator.publicKey, escrowVault: vault })
      .signers([operator])
      .rpc();

    return { reg, vault, score };
  }

  // ── setup + initialize scorecard ──────────────
  async function setupWithScorecard(feeBps = 50, bondSol = 2) {
    const pdas = await setupOperator(feeBps, bondSol);

    await program.methods
      .initializeScorecard()
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: pdas.reg,
        escrowVault:      pdas.vault,
        scoreCard:        pdas.score,
      })
      .signers([operator])
      .rpc();

    return pdas;
  }

  // ── submit one proof (ed25519 precompile + submit_proof in one tx) ──
  async function submitProof(
    pdas:      { reg: PublicKey; vault: PublicKey; score: PublicKey },
    amount:    number,
    latencyMs: number,
  ) {
    const amountBN   = new BN(amount);

    // build the submit_proof anchor instruction
    const submitIx = await program.methods
      .submitProof({
        amount:    amountBN,
        latencyMs,
        merchant:  merchant.publicKey,
        operator:  operator.publicKey,
      })
      .accounts({
        operator:           operator.publicKey,
        operatorRegistry:   pdas.reg,
        scoreCard:          pdas.score,
        escrowVault:        pdas.vault,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const before = await program.account.scoreCard.fetch(pdas.score);
    const expectedCount = before.fulfillmentCount.toNumber() + 1;

    const tx = new Transaction().add(submitIx);
    const txSig = await provider.sendAndConfirm(tx, [operator]);

    for (let i = 0; i < 50; i++) {
      const status = (await connection.getSignatureStatuses([txSig])).value[0];
      if (status?.err) throw new Error(`submitProof failed: ${JSON.stringify(status.err)}`);

      const sc = await program.account.scoreCard.fetch(pdas.score);
      if (sc.fulfillmentCount.toNumber() >= expectedCount) return;
      await sleep(100);
    }
    throw new Error(`submitProof not observed for signature ${txSig}`);
  }

  // ═══════════════════════════════════════════════
  //  TEST 1 — initialize scorecard for active operator
  // ═══════════════════════════════════════════════
  it("initializes scorecard: ema = 1_000_000, all counters zero", async () => {
    const { reg, vault, score } = await setupOperator();

    await program.methods
      .initializeScorecard()
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: reg,
        escrowVault:      vault,
        scoreCard:        score,
      })
      .signers([operator])
      .rpc();

    const sc = await program.account.scoreCard.fetch(score);

    assert.equal(sc.emaReliability.toNumber(),   1_000_000, "ema should start at 100%");
    assert.equal(sc.fulfillmentCount.toNumber(),  0,        "fulfillment_count should be 0");
    assert.equal(sc.totalVolume.toNumber(),        0,        "total_volume should be 0");
    assert.equal(sc.slashCount,                    0,        "slash_count should be 0");
    assert.equal(sc.operator.toBase58(), operator.publicKey.toBase58());
  });

  // ═══════════════════════════════════════════════
  //  TEST 2 — inactive operator cannot get a scorecard
  // ═══════════════════════════════════════════════
  it("rejects scorecard init for an inactive (deregistered) operator", async () => {
    const { reg, vault, score } = await setupOperator();

    // deregister — sets is_active = false and returns bond
    await program.methods
      .deregisterOperator()
      .accounts({ operator: operator.publicKey, operatorRegistry: reg, escrowVault: vault })
      .signers([operator])
      .rpc();

    try {
      await program.methods
        .initializeScorecard()
        .accounts({
          operator:         operator.publicKey,
          operatorRegistry: reg,
          escrowVault:      vault,
          scoreCard:        score,
        })
        .signers([operator])
        .rpc();

      assert.fail("Expected InactiveOperator — instruction should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "InactiveOperator");
    }
  });

  // ═══════════════════════════════════════════════
  //  TEST 3 — submit a valid proof, assert scorecard updates
  // ═══════════════════════════════════════════════
  it("valid proof: fulfillment_count+1, total_volume updated, EMA updated correctly", async () => {
    const pdas = await setupWithScorecard();

    const amount    = 500_000_000; // 0.5 SOL
    const latencyMs = 500;         // fast — 500ms

    await submitProof(pdas, amount, latencyMs);

    const sc = await program.account.scoreCard.fetch(pdas.score);

    // fulfillment count must increment
    assert.equal(sc.fulfillmentCount.toNumber(), 1, "fulfillment_count should be 1");

    // volume must accumulate
    assert.equal(sc.totalVolume.toNumber(), amount, "total_volume should equal proof amount");

    // EMA math (trace):
    //   score_for_500ms = SCALE - (SCALE * 500 / 4000) = 1_000_000 - 125_000 = 875_000
    //   new_ema = (950_000 * 1_000_000 + 50_000 * 875_000) / 1_000_000
    //           = (950_000_000_000 + 43_750_000_000) / 1_000_000
    //           = 993_750_000_000 / 1_000_000
    //           = 993_750
    assert.equal(sc.emaReliability.toNumber(), 993_750, "EMA should be 993_750 after one 500ms proof");
  });

  // ═══════════════════════════════════════════════
  //  TEST 4 — bond below minimum rejects scorecard init
  // ═══════════════════════════════════════════════
  it("rejects scorecard init when bond < MIN_BOND_LAMPORTS (1 SOL)", async () => {
    await airdrop(operator.publicKey, 10);

    const reg   = registryPDA(operator.publicKey, program.programId);
    const vault = vaultPDA(operator.publicKey, program.programId);
    const score = scorePDA(operator.publicKey, program.programId);

    await program.methods
      .registerOperator(50)
      .accounts({ operator: operator.publicKey, operatorRegistry: reg, escrowVault: vault })
      .signers([operator])
      .rpc();

    // deposit only 0.5 SOL — below the 1 SOL MIN_BOND threshold
    await program.methods
      .depositBond(new BN(0.5 * LAMPORTS_PER_SOL))
      .accounts({ operator: operator.publicKey, escrowVault: vault })
      .signers([operator])
      .rpc();

    try {
      await program.methods
        .initializeScorecard()
        .accounts({
          operator:         operator.publicKey,
          operatorRegistry: reg,
          escrowVault:      vault,
          scoreCard:        score,
        })
        .signers([operator])
        .rpc();

      assert.fail("Expected InsufficientBond — should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "InsufficientBond");
    }
  });

  // ═══════════════════════════════════════════════
  //  TEST 5 — slash operator below EMA threshold
  // ═══════════════════════════════════════════════
  it("slashes operator below threshold: 20% to cranker, isActive=false, vault reduced", async () => {
    // Use 5 SOL bond so slash math is easy: 20% of 5 SOL = 1 SOL
    const pdas = await setupWithScorecard(50, 5);

    // Submit many zero-score proofs (latency >= 4000ms) to tank the EMA below 700_000.
    // At 0 score each round: new_ema = 0.95 * old_ema
    // We need ema < 700_000 starting from 1_000_000.
    // 0.95^n * 1_000_000 < 700_000  →  n > log(0.7)/log(0.95) ≈ 6.9 → 7 proofs
    // We'll submit 8 to be safe — all with latency = 9999ms (scores 0).
    for (let i = 0; i < 8; i++) {
      await submitProof(pdas, 1_000, 9_999); // 9999ms → score = 0
    }

    // verify EMA is now below threshold before slashing
    const scBefore = await program.account.scoreCard.fetch(pdas.score);
    assert.isBelow(
      scBefore.emaReliability.toNumber(),
      700_000,
      "EMA must be below SLASH_THRESHOLD before this test is valid"
    );

    const cranker = Keypair.generate();
    await airdrop(cranker.publicKey, 1);

    const vaultBefore   = (await program.account.escrowVault.fetch(pdas.vault)).depositedLamports.toNumber();
    const crankerBefore = await connection.getBalance(cranker.publicKey);

    await program.methods
      .slashOperator()
      .accounts({
        cranker:          cranker.publicKey,
        operatorRegistry: pdas.reg,
        scoreCard:        pdas.score,
        escrowVault:      pdas.vault,
      })
      .signers([cranker])
      .rpc();

    const registry     = await program.account.operatorRegistry.fetch(pdas.reg);
    const vaultAfter   = await program.account.escrowVault.fetch(pdas.vault);
    const crankerAfter = await connection.getBalance(cranker.publicKey);

    // operator must be deactivated
    assert.isFalse(registry.isActive, "operator must be inactive after slash");

    // slash amount = 20% of bond at time of slash
    const expectedSlash = Math.floor((vaultBefore * 2_000) / 10_000);

    // cranker received the slash reward (minus tx fee, allow 10_000 lamport tolerance)
    assert.approximately(
      crankerAfter - crankerBefore,
      expectedSlash,
      10_000,
      "cranker should receive 20% of bond"
    );

    // vault reduced by exactly slash_amount
    assert.equal(
      vaultAfter.depositedLamports.toNumber(),
      vaultBefore - expectedSlash,
      "vault deposited_lamports must decrease by slash amount"
    );

    // slash_count incremented
    const scAfter = await program.account.scoreCard.fetch(pdas.score);
    assert.equal(scAfter.slashCount, 1, "slash_count should be 1");
  });

  // ═══════════════════════════════════════════════
  //  TEST 6 — healthy operator cannot be slashed
  // ═══════════════════════════════════════════════
  it("rejects slash when operator EMA is above threshold", async () => {
    const pdas = await setupWithScorecard();
    // scorecard freshly initialized at 1_000_000 — well above 700_000

    const cranker = Keypair.generate();
    await airdrop(cranker.publicKey, 1);

    try {
      await program.methods
        .slashOperator()
        .accounts({
          cranker:          cranker.publicKey,
          operatorRegistry: pdas.reg,
          scoreCard:        pdas.score,
          escrowVault:      pdas.vault,
        })
        .signers([cranker])
        .rpc();

      assert.fail("Expected SlashConditionNotMet — should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "SlashConditionNotMet");
    }
  });
});

// ═══════════════════════════════════════════════════════════
//  WEEK 3 — Emission Engine
// ═══════════════════════════════════════════════════════════

describe("velora — week 3", () => {
  const provider   = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program    = anchor.workspace.Velora as any;
  const connection = provider.connection;

  let operator: Keypair;
  let merchant: Keypair;
  let nextEpochNumber = Math.floor(Date.now() / 1000);

  // ── PDA helpers (same as week 2) ──
  const pid = () => program.programId;
  const reg   = (op: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("operator"), op.toBuffer()], pid())[0];
  const vault = (op: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("escrow"),   op.toBuffer()], pid())[0];
  const score = (op: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("score"),    op.toBuffer()], pid())[0];
  const mint  = ()              => PublicKey.findProgramAddressSync([Buffer.from("velora_mint")],             pid())[0];
  const epoch = (n: number)     => PublicKey.findProgramAddressSync([Buffer.from("epoch"), Buffer.from(new BN(n).toArray("le", 8))], pid())[0];
  const freshEpochNumber = () => nextEpochNumber++;

  beforeEach(() => {
    operator = Keypair.generate();
    merchant = Keypair.generate();
  });

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });
  }

  // Full setup through scorecard init
  async function fullSetup(bondSol = 2, feeBps = 50) {
    await airdrop(operator.publicKey, bondSol + 5);
    const r = reg(operator.publicKey);
    const v = vault(operator.publicKey);
    const s = score(operator.publicKey);

    await program.methods.registerOperator(feeBps)
      .accounts({ operator: operator.publicKey, operatorRegistry: r, escrowVault: v })
      .signers([operator]).rpc();

    await program.methods.depositBond(new BN(bondSol * LAMPORTS_PER_SOL))
      .accounts({ operator: operator.publicKey, escrowVault: v })
      .signers([operator]).rpc();

    await program.methods.initializeScorecard()
      .accounts({ operator: operator.publicKey, operatorRegistry: r, escrowVault: v, scoreCard: s })
      .signers([operator]).rpc();

    return { r, v, s };
  }

  // Submit N proofs with given latency to build up fulfillment_count
  async function submitNProofs(pdas: { r: PublicKey; v: PublicKey; s: PublicKey }, n: number, latencyMs = 100) {
    for (let i = 0; i < n; i++) {
      const amount    = new BN(100_000_000);
      const submitIx = await program.methods
        .submitProof({ amount, latencyMs, merchant: merchant.publicKey, operator: operator.publicKey })
        .accounts({
          operator: operator.publicKey, operatorRegistry: pdas.r,
          scoreCard: pdas.s, escrowVault: pdas.v,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const before = await program.account.scoreCard.fetch(pdas.s);
      const expectedCount = before.fulfillmentCount.toNumber() + 1;
      const tx = new Transaction().add(submitIx);
      const txSig = await provider.sendAndConfirm(tx, [operator]);

      for (let attempt = 0; attempt < 50; attempt++) {
        const status = (await connection.getSignatureStatuses([txSig])).value[0];
        if (status?.err) throw new Error(`submitProof failed: ${JSON.stringify(status.err)}`);

        const sc = await program.account.scoreCard.fetch(pdas.s);
        if (sc.fulfillmentCount.toNumber() >= expectedCount) break;
        await sleep(100);
        if (attempt === 49) throw new Error(`submitProof not observed for signature ${txSig}`);
      }
    }
  }

  async function ensureMint(payer: Keypair) {
    const mintPDA = mint();
    if (!(await connection.getAccountInfo(mintPDA))) {
      await program.methods.initializeMint()
        .accounts({
          payer: payer.publicKey,
          mint: mintPDA,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([payer]).rpc();
    }
    return mintPDA;
  }

  async function ensureEpoch(payer: Keypair, epochNumber: number) {
    const epochPDA = epoch(epochNumber);
    if (!(await connection.getAccountInfo(epochPDA))) {
      await program.methods.initializeEpoch(new BN(epochNumber))
        .accounts({ payer: payer.publicKey, epochState: epochPDA })
        .signers([payer]).rpc();
    }
    return epochPDA;
  }

  function operatorAta(mintPDA: PublicKey, owner: PublicKey) {
    return getAssociatedTokenAddressSync(mintPDA, owner, false, TOKEN_2022_PROGRAM_ID);
  }

  // ══════════════════════════════════════════════
  //  TEST 1 — initialize mint
  // ══════════════════════════════════════════════
  console.log("RUNNING MINT INIT TEST"); it("initializes the Velora mint PDA with correct decimals and authority", async () => {
    const payer   = Keypair.generate();
    await airdrop(payer.publicKey, 2);
    const mintPDA = mint();

    await ensureMint(payer);

    const mintInfo = await connection.getParsedAccountInfo(mintPDA);
    const data     = (mintInfo.value?.data as any)?.parsed?.info;
    assert.equal(data.decimals, 6, "decimals should be 6");
    assert.equal(data.mintAuthority, mintPDA.toBase58(), "mint authority should be the mint PDA itself");
    assert.isNull(data.freezeAuthority, "freeze authority should be null");
  });

  // ══════════════════════════════════════════════
  //  TEST 2 — initialize epoch
  // ══════════════════════════════════════════════
  it("initializes epoch 0 with full budget and zero emitted", async () => {
    const payer    = Keypair.generate();
    await airdrop(payer.publicKey, 2);
    const epochNumber = freshEpochNumber();
    const epochPDA = epoch(epochNumber);

    await ensureEpoch(payer, epochNumber);

    const state = await program.account.epochState.fetch(epochPDA);
    assert.equal(state.epochNumber.toNumber(),  epochNumber);
    assert.equal(state.epochBudget.toString(),  "1000000000000"); // 1M tokens
    assert.equal(state.epochEmitted.toNumber(), 0);
    assert.isAbove(state.epochStartSlot.toNumber(), 0);
  });

  // ══════════════════════════════════════════════
  //  TEST 3 — claim emission after valid proofs
  // ══════════════════════════════════════════════
  it("claims emission: ATA balance increases, epoch_emitted updates, last_claim_epoch set", async () => {
    const payer    = Keypair.generate();
    await airdrop(payer.publicKey, 3);

    const mintPDA  = mint();
    const epochNumber = freshEpochNumber();
    const epochPDA = epoch(epochNumber);

    await ensureMint(payer);
    await ensureEpoch(payer, epochNumber);

    const pdas = await fullSetup();
    await submitNProofs(pdas, 5); // hit MIN_PROOFS_FOR_EMISSION

    const ataAddress = operatorAta(mintPDA, operator.publicKey);
    const epochBefore = await program.account.epochState.fetch(epochPDA);

    await program.methods.claimEmission(new BN(epochNumber))
      .accounts({
        operator:             operator.publicKey,
        operatorRegistry:     pdas.r,
        scoreCard:            pdas.s,
        epochState:           epochPDA,
        mint:                 mintPDA,
        operatorTokenAccount: ataAddress,
        tokenProgram:         TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([operator]).rpc();

    // ATA balance > 0
    const ataInfo = await connection.getTokenAccountBalance(ataAddress);
    assert.isAbove(Number(ataInfo.value.amount), 0, "operator should have received tokens");

    // epoch_emitted increased
    const epochAfter = await program.account.epochState.fetch(epochPDA);
    assert.isAbove(epochAfter.epochEmitted.toNumber(), epochBefore.epochEmitted.toNumber());

    // last_claim_epoch = 0
    const sc = await program.account.scoreCard.fetch(pdas.s);
    assert.equal(sc.lastClaimEpoch.toNumber(), epochNumber);
  });

  // ══════════════════════════════════════════════
  //  TEST 4 — double-claim same epoch rejected
  // ══════════════════════════════════════════════
  it("rejects a second claim in the same epoch", async () => {
    const payer    = Keypair.generate();
    await airdrop(payer.publicKey, 3);
    const mintPDA  = mint();
    const epochNumber = freshEpochNumber();
    const epochPDA = epoch(epochNumber);
    await ensureMint(payer);
    await ensureEpoch(payer, epochNumber);

    const pdas       = await fullSetup();
    await submitNProofs(pdas, 5);
    const ataAddress = operatorAta(mintPDA, operator.publicKey);

    const claimAccounts = {
      operator: operator.publicKey, operatorRegistry: pdas.r,
      scoreCard: pdas.s, epochState: epochPDA,
      mint: mintPDA, operatorTokenAccount: ataAddress,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    };

    // first claim — succeeds
    await program.methods.claimEmission(new BN(epochNumber)).accounts(claimAccounts).signers([operator]).rpc();

    // second claim — must throw
    try {
      await program.methods.claimEmission(new BN(epochNumber)).accounts(claimAccounts).signers([operator]).rpc();
      assert.fail("Expected AlreadyClaimedThisEpoch");
    } catch (err: any) {
      assert.include(err.toString(), "AlreadyClaimedThisEpoch");
    }
  });

  // ══════════════════════════════════════════════
  //  TEST 5 — claim with fewer than MIN_PROOFS rejected
  // ══════════════════════════════════════════════
  it("rejects claim when fulfillment_count < MIN_PROOFS_FOR_EMISSION", async () => {
    const payer    = Keypair.generate();
    await airdrop(payer.publicKey, 3);
    const mintPDA  = mint();
    const epochNumber = freshEpochNumber();
    const epochPDA = epoch(epochNumber);
    await ensureMint(payer);
    await ensureEpoch(payer, epochNumber);

    const pdas       = await fullSetup();
    await submitNProofs(pdas, 3); // only 3 — below minimum of 5

    const ataAddress = operatorAta(mintPDA, operator.publicKey);

    try {
      await program.methods.claimEmission(new BN(epochNumber))
        .accounts({
          operator: operator.publicKey, operatorRegistry: pdas.r,
          scoreCard: pdas.s, epochState: epochPDA,
          mint: mintPDA, operatorTokenAccount: ataAddress,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([operator]).rpc();
      assert.fail("Expected InsufficientProofs");
    } catch (err: any) {
      assert.include(err.toString(), "InsufficientProofs");
    }
  });

  // ══════════════════════════════════════════════
  //  TEST 6 — advance_epoch guards work
  // ══════════════════════════════════════════════
  it("rejects advance_epoch before slots have elapsed", async () => {
    const payer    = Keypair.generate();
    await airdrop(payer.publicKey, 3);
    const epochNumber = freshEpochNumber();
    const epoch0   = epoch(epochNumber);
    const epoch1   = epoch(epochNumber + 1);
    await ensureEpoch(payer, epochNumber);

    try {
      await program.methods.advanceEpoch(new BN(epochNumber))
        .accounts({ payer: payer.publicKey, currentEpochState: epoch0, nextEpochState: epoch1 })
        .signers([payer]).rpc();
      assert.fail("Expected EpochNotElapsed");
    } catch (err: any) {
      assert.include(err.toString(), "EpochNotElapsed");
    }
  });
});
