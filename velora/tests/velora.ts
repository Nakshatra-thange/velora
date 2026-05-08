import * as anchor from "@coral-xyz/anchor";
import { Program, BN }  from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import * as borsh from "@coral-xyz/borsh";
import nacl        from "tweetnacl";
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

// ─────────────────────────────────────────────
//  PROOF SERIALISATION
//  Must exactly mirror the Rust struct field order:
//  FulfillmentProof { amount: u64, latency_ms: u32, merchant: [u8;32], operator: [u8;32] }
// ─────────────────────────────────────────────

const PROOF_LAYOUT = borsh.struct([
  borsh.u64("amount"),
  borsh.u32("latency_ms"),
  borsh.publicKey("merchant"),
  borsh.publicKey("operator"),
]);

function serializeProof(
  amount:     BN,
  latencyMs:  number,
  merchant:   PublicKey,
  operator:   PublicKey,
): Buffer {
  const buf = Buffer.alloc(PROOF_LAYOUT.span);
  PROOF_LAYOUT.encode(
    { amount, latency_ms: latencyMs, merchant, operator },
    buf,
  );
  return buf;
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
  const program    = anchor.workspace.Velora as Program<Velora>;
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
    const proofBytes = serializeProof(amountBN, latencyMs, merchant.publicKey, operator.publicKey);

    // merchant signs the serialised proof off-chain with their raw secret key
    const sig = nacl.sign.detached(proofBytes, merchant.secretKey);

    // ed25519 precompile instruction — must be ix[0] in the transaction
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: merchant.secretKey,
      message:    proofBytes,
    });


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
      .signers([operator])
      .instruction();

    // both instructions in one atomic transaction
    // ed25519 ix MUST come before submit_proof so load_current_index - 1 points to it
    const tx         = new Transaction().add(ed25519Ix, submitIx);
   

    const txSig = await provider.sendAndConfirm(tx, [operator]);
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