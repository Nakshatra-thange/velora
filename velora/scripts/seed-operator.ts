/**
 * scripts/seed-operators.ts
 *
 * Bootstraps 3 operators on devnet with:
 *   - register_operator (different fee tiers)
 *   - deposit_bond (1 SOL each)
 *   - initialize_scorecard
 *   - 5-10 submit_proof calls per operator (varying latency → different EMAs)
 *   - initialize_mint (once)
 *   - initialize_epoch 0 (once)
 *
 * Run from project root:
 *   PROGRAM_ID=EHHMy74EyjT2rAhMVMHEBm1N3TG349pJ4xstPX9uKjLV \
 *   npx ts-node scripts/seed-operators.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import * as borsh from "@coral-xyz/borsh";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "EHHMy74EyjT2rAhMVMHEBm1N3TG349pJ4xstPX9uKjLV"
);

const IDL = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../target/idl/velora.json"),
    "utf-8"
  )
);

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// ─────────────────────────────────────────────
//  LOAD KEYPAIRS
// ─────────────────────────────────────────────

function loadKeypair(filePath: string): Keypair {
  const abs = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(abs, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// the three operator keypairs you created
const OPERATORS = [
  { keypair: loadKeypair("./keys/operator1.json"), feeBps: 50,  label: "Operator 1 (0.5% fee)" },
  { keypair: loadKeypair("./keys/operator2.json"), feeBps: 80,  label: "Operator 2 (0.8% fee)" },
  { keypair: loadKeypair("./keys/operator3.json"), feeBps: 120, label: "Operator 3 (1.2% fee)" },
];

// a fake merchant keypair — signs proof co-signatures
const MERCHANT = Keypair.generate();

// payer = your default wallet (has the most SOL)
const PAYER_KEYPAIR = loadKeypair(
  process.env.PAYER_KEYPAIR ??
  path.join(process.env.HOME!, ".config/solana/id.json")
);

// ─────────────────────────────────────────────
//  ANCHOR SETUP
// ─────────────────────────────────────────────

function makeProvider(signer: Keypair) {
  const wallet = new anchor.Wallet(signer);
  return new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

function makeProgram(signer: Keypair) {
  return new anchor.Program(
    { ...(IDL as anchor.Idl), address: PROGRAM_ID.toBase58() },
    makeProvider(signer)
  ) as any;
}

// ─────────────────────────────────────────────
//  PDA HELPERS
// ─────────────────────────────────────────────

const pda = (seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const regPDA   = (op: PublicKey) => pda([Buffer.from("operator"),    op.toBuffer()]);
const vaultPDA = (op: PublicKey) => pda([Buffer.from("escrow"),      op.toBuffer()]);
const scorePDA = (op: PublicKey) => pda([Buffer.from("score"),       op.toBuffer()]);
const mintPDA  = ()              => pda([Buffer.from("velora_mint")]);
const epochPDA = (n: number)     => pda([Buffer.from("epoch"), Buffer.from(new BN(n).toArray("le", 8))]);

// ─────────────────────────────────────────────
//  PROOF SERIALISATION
// ─────────────────────────────────────────────

const PROOF_LAYOUT = borsh.struct([
  borsh.u64("amount"),
  borsh.u32("latency_ms"),
  borsh.publicKey("merchant"),
  borsh.publicKey("operator"),
]);

function serializeProof(
  amount: BN,
  latencyMs: number,
  merchant: PublicKey,
  operator: PublicKey
): Buffer {
  const buf = Buffer.alloc(PROOF_LAYOUT.span);
  PROOF_LAYOUT.encode({ amount, latency_ms: latencyMs, merchant, operator }, buf);
  return buf;
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

async function confirm(sig: string) {
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh });
  return sig;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string) {
  console.log(`  ${msg}`);
}

// ─────────────────────────────────────────────
//  SUBMIT ONE PROOF
// ─────────────────────────────────────────────

async function submitProof(
  operatorKeypair: Keypair,
  amountLamports: number,
  latencyMs: number
): Promise<string> {
  const program  = makeProgram(operatorKeypair);
  const provider = makeProvider(operatorKeypair);
  const op       = operatorKeypair.publicKey;
  const amountBN = new BN(amountLamports);

  const proofBytes = serializeProof(amountBN, latencyMs, MERCHANT.publicKey, op);
  const sig        = nacl.sign.detached(proofBytes, MERCHANT.secretKey);

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: MERCHANT.publicKey.toBytes(),
    message:   proofBytes,
    signature: sig,
  });

  const submitIx = await program.methods
    .submitProof({
      amount:    amountBN,
      latencyMs,
      merchant:  MERCHANT.publicKey,
      operator:  op,
    })
    .accounts({
      operator:           op,
      operatorRegistry:   regPDA(op),
      scoreCard:          scorePDA(op),
      escrowVault:        vaultPDA(op),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const tx = new Transaction().add(ed25519Ix, submitIx);
  return provider.sendAndConfirm(tx, [operatorKeypair]);
}

// ─────────────────────────────────────────────
//  SETUP ONE OPERATOR
// ─────────────────────────────────────────────

async function setupOperator(
  operatorKeypair: Keypair,
  feeBps: number,
  label: string,
  proofLatencies: number[]  // one latency per proof to submit
) {
  const op      = operatorKeypair.publicKey;
  const program = makeProgram(operatorKeypair);
  const provider = makeProvider(operatorKeypair);

  console.log(`\n▶  ${label}`);
  log(`pubkey: ${op.toBase58()}`);

  // ── 1. register ──
  log("registering...");
  try {
    await program.methods
      .registerOperator(feeBps)
      .accounts({
        operator:         op,
        operatorRegistry: regPDA(op),
        escrowVault:      vaultPDA(op),
      })
      .signers([operatorKeypair])
      .rpc();
    log(`✅ registered (fee: ${feeBps} bps)`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      log("⚠️  already registered — skipping");
    } else {
      throw e;
    }
  }

  await sleep(1000);

  // ── 2. deposit bond (1 SOL) ──
  log("depositing 1 SOL bond...");
  try {
    await program.methods
      .depositBond(new BN(1 * LAMPORTS_PER_SOL))
      .accounts({
        operator:    op,
        escrowVault: vaultPDA(op),
      })
      .signers([operatorKeypair])
      .rpc();
    log("✅ bond deposited");
  } catch (e: any) {
    log(`⚠️  deposit skipped: ${e.message?.slice(0, 60)}`);
  }

  await sleep(1000);

  // ── 3. initialize scorecard ──
  log("initializing scorecard...");
  try {
    await program.methods
      .initializeScorecard()
      .accounts({
        operator:         op,
        operatorRegistry: regPDA(op),
        escrowVault:      vaultPDA(op),
        scoreCard:        scorePDA(op),
      })
      .signers([operatorKeypair])
      .rpc();
    log("✅ scorecard initialized (EMA: 100%)");
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      log("⚠️  scorecard already exists — skipping");
    } else {
      throw e;
    }
  }

  await sleep(1000);

  // ── 4. submit proofs ──
  log(`submitting ${proofLatencies.length} proofs...`);
  for (let i = 0; i < proofLatencies.length; i++) {
    const latencyMs = proofLatencies[i];
    const amount    = 200_000_000 + i * 50_000_000; // slightly varying amounts
    try {
      const sig = await submitProof(operatorKeypair, amount, latencyMs);
      log(`  proof ${i + 1}/${proofLatencies.length} — ${latencyMs}ms latency — ${sig.slice(0, 20)}...`);
      await sleep(800); // rate limit buffer
    } catch (e: any) {
      log(`  ⚠️  proof ${i + 1} failed: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── 5. print final scorecard ──
  try {
    const sc = await program.account.scoreCard.fetch(scorePDA(op));
    const ema = sc.emaReliability.toNumber();
    log(`📊 final EMA: ${(ema / 10_000).toFixed(4)}% | fulfillments: ${sc.fulfillmentCount.toNumber()} | volume: ${sc.totalVolume.toNumber() / LAMPORTS_PER_SOL} SOL`);
  } catch {
    log("⚠️  could not fetch scorecard");
  }
}

// ─────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────

async function main() {
  console.log("\n🌱  Velora devnet seed script");
  console.log(`    program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`    payer:    ${PAYER_KEYPAIR.publicKey.toBase58()}`);
  console.log(`    merchant: ${MERCHANT.publicKey.toBase58()}\n`);

  // ── Step 1: initialize global mint (once, payer pays) ──
  console.log("── Step 1: initialize global mint");
  const payerProgram = makeProgram(PAYER_KEYPAIR);
  try {
    await payerProgram.methods
      .initializeMint()
      .accounts({
        payer: PAYER_KEYPAIR.publicKey,
        mint: mintPDA(),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([PAYER_KEYPAIR])
      .rpc();
    console.log(`  ✅ mint created: ${mintPDA().toBase58()}`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log(`  ⚠️  mint already exists — skipping`);
    } else {
      console.log(`  ⚠️  mint init failed: ${e.message?.slice(0, 80)}`);
    }
  }

  await sleep(1000);

  // ── Step 2: initialize epoch 0 (once, payer pays) ──
  console.log("\n── Step 2: initialize epoch 0");
  try {
    await payerProgram.methods
      .initializeEpoch(new BN(0))
      .accounts({ payer: PAYER_KEYPAIR.publicKey, epochState: epochPDA(0) })
      .signers([PAYER_KEYPAIR])
      .rpc();
    console.log(`  ✅ epoch 0 created: ${epochPDA(0).toBase58()}`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log(`  ⚠️  epoch 0 already exists — skipping`);
    } else {
      console.log(`  ⚠️  epoch init failed: ${e.message?.slice(0, 80)}`);
    }
  }

  await sleep(1000);

  // ── Step 3: setup operators with different proof quality profiles ──
  console.log("\n── Step 3: register operators + submit proofs");

  // Operator 1 — fast, reliable (low latency → high EMA → top of scoreboard)
  await setupOperator(
    OPERATORS[0].keypair,
    OPERATORS[0].feeBps,
    OPERATORS[0].label,
    [200, 150, 300, 100, 250, 200, 180, 220]  // fast proofs → EMA ~98%
  );

  // Operator 2 — medium reliability
  await setupOperator(
    OPERATORS[1].keypair,
    OPERATORS[1].feeBps,
    OPERATORS[1].label,
    [500, 800, 400, 1200, 600, 700, 500, 900] // medium proofs → EMA ~92%
  );

  // Operator 3 — lower quality but cheapest fee
  await setupOperator(
    OPERATORS[2].keypair,
    OPERATORS[2].feeBps,
    OPERATORS[2].label,
    [1500, 1800, 2500, 1200, 3000, 1600, 2000, 1400] // slow proofs → EMA ~82%
  );

  // ── Step 4: print final scoreboard state ──
  console.log("\n── Final scoreboard state\n");
  console.log("  OPERATOR                                      EMA          FEE    FULFILLMENTS");
  console.log("  " + "─".repeat(80));

  for (const { keypair, label } of OPERATORS) {
    const op = keypair.publicKey;
    try {
      const sc  = await payerProgram.account.scoreCard.fetch(scorePDA(op));
      const reg = await payerProgram.account.operatorRegistry.fetch(regPDA(op));
      const ema = sc.emaReliability.toNumber();
      const emaPct = (ema / 10_000).toFixed(4) + "%";
      console.log(
        `  ${op.toBase58().slice(0, 8)}...  ${emaPct.padEnd(12)} ${reg.feeBps.toString().padEnd(6)} bps  ${sc.fulfillmentCount.toNumber()}`
      );
    } catch {
      console.log(`  ${label}: could not fetch`);
    }
  }

  console.log("\n✅  Seed complete. Start the aggregator and check /scoreboard\n");
  console.log(`  PROGRAM_ID=${PROGRAM_ID.toBase58()} npx ts-node aggregator/index.ts\n`);

  console.log("  Explorer links:");
  for (const { keypair, label } of OPERATORS) {
    const sc = scorePDA(keypair.publicKey);
    console.log(`  ${label}: https://explorer.solana.com/address/${sc.toBase58()}?cluster=devnet`);
  }
  console.log(`  Mint: https://explorer.solana.com/address/${mintPDA().toBase58()}?cluster=devnet`);
  console.log(`  Epoch 0: https://explorer.solana.com/address/${epochPDA(0).toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error("\n❌  seed failed:", err);
  process.exit(1);
});
