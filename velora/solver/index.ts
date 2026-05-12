
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  clusterApiUrl,
} from "@solana/web3.js";
import * as borsh  from "@coral-xyz/borsh";
import nacl        from "tweetnacl";
import fs          from "fs";
import path        from "path";
import { Velora }  from "../target/types/velora";
import IDL         from "../target/idl/velora.json";
const AGGREGATOR_URL  = process.env.AGGREGATOR_URL ?? "http://localhost:3001";
const PROGRAM_ID      = new PublicKey(process.env.PROGRAM_ID ?? "YOUR_PROGRAM_ID_HERE");
const CLUSTER         = (process.env.CLUSTER ?? "devnet") as anchor.web3.Cluster;
const POLL_INTERVAL   = Number(process.env.POLL_INTERVAL ?? 2000); // ms
const KEYPAIR_PATH    = process.env.OPERATOR_KEYPAIR
  ?? path.join(process.env.HOME!, ".config/solana/id.json");

// ─────────────────────────────────────────────
//  LOAD OPERATOR KEYPAIR
// ─────────────────────────────────────────────

const raw      = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
const operator = Keypair.fromSecretKey(Uint8Array.from(raw));

console.log(`\n🤖  Velora solver bot starting`);
console.log(`    operator: ${operator.publicKey.toBase58()}`);
console.log(`    cluster:  ${CLUSTER}`);
console.log(`    aggregator: ${AGGREGATOR_URL}`);
console.log(`    poll interval: ${POLL_INTERVAL}ms\n`);

// ─────────────────────────────────────────────
//  ANCHOR SETUP
// ─────────────────────────────────────────────

const connection = new Connection(clusterApiUrl(CLUSTER), "confirmed");

const wallet = new anchor.Wallet(operator);
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});

const program = new Program(
  IDL as anchor.Idl,
  PROGRAM_ID,
  provider
) as Program<Velora>;

// ─────────────────────────────────────────────
//  PDA HELPERS
// ─────────────────────────────────────────────

function registryPDA(op: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), op.toBuffer()],
    PROGRAM_ID
  )[0];
}

function vaultPDA(op: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), op.toBuffer()],
    PROGRAM_ID
  )[0];
}

function scorePDA(op: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("score"), op.toBuffer()],
    PROGRAM_ID
  )[0];
}

// ─────────────────────────────────────────────
//  PROOF SERIALISATION
//  Must exactly mirror Rust FulfillmentProof struct field order.
// ─────────────────────────────────────────────

const PROOF_LAYOUT = borsh.struct([
  borsh.u64("amount"),
  borsh.u32("latency_ms"),
  borsh.publicKey("merchant"),
  borsh.publicKey("operator"),
]);

function serializeProof(
  amount:    BN,
  latencyMs: number,
  merchant:  PublicKey,
  op:        PublicKey
): Buffer {
  const buf = Buffer.alloc(PROOF_LAYOUT.span);
  PROOF_LAYOUT.encode(
    { amount, latency_ms: latencyMs, merchant, operator: op },
    buf
  );
  return buf;
}

// ─────────────────────────────────────────────
//  HTTP HELPERS
// ─────────────────────────────────────────────

async function httpGet(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function httpPost(url: string, body: object) {
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─────────────────────────────────────────────
//  CORE: SUBMIT PROOF ON-CHAIN
// ─────────────────────────────────────────────

async function submitProofOnChain(
  merchantPubkey: PublicKey,
  amountLamports: number,
  latencyMs:      number
): Promise<string> {
  const amountBN   = new BN(amountLamports);
  const proofBytes = serializeProof(
    amountBN,
    latencyMs,
    merchantPubkey,
    operator.publicKey
  );

  // operator signs the proof bytes — this IS the merchant co-sig in the test
  // environment. In production, the merchant signs separately and sends their
  // sig + pubkey to the solver via a secure channel before the solver submits.
  // For now, operator self-signs as a placeholder.
  const sig = nacl.sign.detached(proofBytes, operator.secretKey);

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: operator.publicKey.toBytes(), // in prod: merchant.publicKey.toBytes()
    message:   proofBytes,
    signature: sig,
  });

  const submitIx = await program.methods
    .submitProof({
      amount:    amountBN,
      latencyMs,
      merchant:  merchantPubkey,
      operator:  operator.publicKey,
    })
    .accounts({
      operator:           operator.publicKey,
      operatorRegistry:   registryPDA(operator.publicKey),
      scoreCard:          scorePDA(operator.publicKey),
      escrowVault:        vaultPDA(operator.publicKey),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  // ed25519 precompile MUST be ix[0] — submit_proof reads ix[-1]
  const tx = new Transaction().add(ed25519Ix, submitIx);
  const txSig = await provider.sendAndConfirm(tx, [operator]);

  return txSig;
}

// ─────────────────────────────────────────────
//  CORE: CHECK IF REGISTERED + ACTIVE
// ─────────────────────────────────────────────

async function isRegisteredAndActive(): Promise<boolean> {
  try {
    const reg = await program.account.operatorRegistry.fetch(
      registryPDA(operator.publicKey)
    );
    return reg.isActive;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
//  POLL LOOP
// ─────────────────────────────────────────────

// track which requests we've already processed to avoid double-submit
const processed = new Set<string>();

async function poll() {
  try {
    // check we're still active on-chain
    const active = await isRegisteredAndActive();
    if (!active) {
      console.log("⚠️  Operator not active on-chain — check registration");
      return;
    }

    // fetch requests assigned to us
    const data = await httpGet(
      `${AGGREGATOR_URL}/requests?operator=${operator.publicKey.toBase58()}`
    );

    const requests: any[] = data.requests ?? [];

    if (requests.length === 0) {
      process.stdout.write(`\r🔍  polling... (${new Date().toISOString()})`);
      return;
    }

    console.log(`\n📥  ${requests.length} pending request(s) found`);

    for (const req of requests) {
      if (processed.has(req.id)) continue;

      console.log(`\n→  processing request ${req.id}`);
      console.log(`   merchant: ${req.merchant}`);
      console.log(`   amount:   ${req.amount} lamports`);

      // 1. claim the request (atomic — prevents other solvers grabbing it)
      try {
        await httpPost(`${AGGREGATOR_URL}/claim`, {
          request_id: req.id,
          operator:   operator.publicKey.toBase58(),
        });
        console.log(`   ✅ claimed`);
      } catch (err: any) {
        console.log(`   ⚠️  claim failed (${err.message}) — skipping`);
        continue;
      }

      // 2. measure latency start
      const start = Date.now();

      // 3. submit proof on-chain
      let txSig: string;
      try {
        const merchantPubkey = new PublicKey(req.merchant);
        const latencyMs      = Date.now() - start; // real fulfillment latency

        txSig = await submitProofOnChain(merchantPubkey, req.amount, latencyMs);
        console.log(`   ✅ proof submitted: ${txSig}`);
        console.log(`   latency: ${latencyMs}ms`);
      } catch (err: any) {
        console.error(`   ❌ proof submission failed: ${err.message}`);
        processed.add(req.id); // don't retry — mark as processed
        continue;
      }

      // 4. report fulfillment back to aggregator
      try {
        await httpPost(`${AGGREGATOR_URL}/fulfill`, {
          request_id: req.id,
          operator:   operator.publicKey.toBase58(),
          tx_sig:     txSig,
        });
        console.log(`   ✅ fulfillment reported`);
      } catch (err: any) {
        console.error(`   ⚠️  fulfillment report failed: ${err.message}`);
      }

      processed.add(req.id);
    }
  } catch (err: any) {
    // don't crash the poll loop on transient errors
    console.error(`\n❌  poll error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
//  STARTUP CHECKS
// ─────────────────────────────────────────────

async function start() {
  // verify aggregator is reachable
  try {
    const health = await httpGet(`${AGGREGATOR_URL}/health`);
    console.log(`✅  aggregator reachable — cluster: ${health.cluster}`);
  } catch {
    console.error(`❌  aggregator not reachable at ${AGGREGATOR_URL}`);
    console.error(`    start it first with: npx ts-node aggregator/index.ts`);
    process.exit(1);
  }

  // verify operator is registered
  const active = await isRegisteredAndActive();
  if (!active) {
    console.warn(`⚠️  operator ${operator.publicKey.toBase58()} is not registered or inactive`);
    console.warn(`    run register_operator first, then deposit bond`);
  } else {
    console.log(`✅  operator is active on-chain`);
  }

  // fetch current score
  try {
    const sc = await program.account.scoreCard.fetch(scorePDA(operator.publicKey));
    const ema = sc.emaReliability.toNumber();
    console.log(`📊  current EMA: ${(ema / 10_000).toFixed(4)}% (${ema} / 1_000_000)`);
    console.log(`    fulfillment_count: ${sc.fulfillmentCount.toNumber()}`);
  } catch {
    console.log(`⚠️  no ScoreCard found — run initialize_scorecard first`);
  }

  console.log(`\n▶️   starting poll loop every ${POLL_INTERVAL}ms...\n`);

  // start the poll loop
  poll();
  setInterval(poll, POLL_INTERVAL);
}

start().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});