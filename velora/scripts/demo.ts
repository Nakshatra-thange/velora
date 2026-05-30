
 // Run: npx ts-node scripts/demo.ts
 
import * as anchor from "@coral-xyz/anchor";
import { BN }  from "@coral-xyz/anchor";
import {
  Keypair, LAMPORTS_PER_SOL, PublicKey,
  Transaction, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY,
  clusterApiUrl, Connection,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import * as borsh from "@coral-xyz/borsh";
import nacl       from "tweetnacl";
import IDL        from "../target/idl/velora.json";
import fs from "fs";
import path from "path";

const PROGRAM_ID_TEXT = process.env.PROGRAM_ID ?? (IDL as any).address;

if (!PROGRAM_ID_TEXT || PROGRAM_ID_TEXT === "YOUR_REAL_ID" || PROGRAM_ID_TEXT.includes("YOUR_")) {
  throw new Error(
    "Set PROGRAM_ID to your deployed Velora program id, e.g. PROGRAM_ID=EHHMy74EyjT2rAhMVMHEBm1N3TG349pJ4xstPX9uKjLV npx ts-node scripts/demo.ts"
  );
}

const PROGRAM_ID = new PublicKey(PROGRAM_ID_TEXT);
const DEMO_BOND_LAMPORTS = 1 * LAMPORTS_PER_SOL;
const DEMO_TARGET_BALANCE = 2 * LAMPORTS_PER_SOL;
const DEMO_EPOCH_NUMBER = Number(process.env.EPOCH_NUMBER ?? Math.floor(Date.now() / 1000));

// ── PDAs ──────────────────────────────────────
const pda = (seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const regPDA   = (op: PublicKey) => pda([Buffer.from("operator"), op.toBuffer()]);
const vaultPDA = (op: PublicKey) => pda([Buffer.from("escrow"),   op.toBuffer()]);
const scorePDA = (op: PublicKey) => pda([Buffer.from("score"),    op.toBuffer()]);
const mintPDA  = ()              => pda([Buffer.from("velora_mint")]);
const epochPDA = (n: number)     => pda([Buffer.from("epoch"), Buffer.from(new BN(n).toArray("le", 8))]);

// ── Proof serialisation ───────────────────────
const PROOF_LAYOUT = borsh.struct([
  borsh.u64("amount"), borsh.u32("latency_ms"),
  borsh.publicKey("merchant"), borsh.publicKey("operator"),
]);
function serializeProof(amount: BN, latencyMs: number, merchant: PublicKey, operator: PublicKey) {
  const buf = Buffer.alloc(PROOF_LAYOUT.span);
  PROOF_LAYOUT.encode({ amount, latency_ms: latencyMs, merchant, operator }, buf);
  return buf;
}

async function confirm(connection: Connection, sig: string) {
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });
}

async function fundToTargetBalance(connection: Connection, pubkey: PublicKey, targetLamports: number) {
  let balance = await connection.getBalance(pubkey);
  let lastError: unknown;

  while (balance < targetLamports) {
    const remaining = targetLamports - balance;
    const chunks = [
      Math.min(1 * LAMPORTS_PER_SOL, remaining),
      Math.min(0.5 * LAMPORTS_PER_SOL, remaining),
      Math.min(0.25 * LAMPORTS_PER_SOL, remaining),
    ].filter((chunk) => chunk > 0);

    let funded = false;
    for (const chunk of chunks) {
      try {
        const sig = await connection.requestAirdrop(pubkey, chunk);
        await confirm(connection, sig);
        balance = await connection.getBalance(pubkey);
        funded = true;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }

    if (!funded) break;
  }

  if (balance < targetLamports) throw lastError ?? new Error("Unable to fund operator");
}

function loadOperatorKeypair() {
  const defaultKeypairPath = path.join(process.env.HOME ?? "", ".config/solana/id.json");
  const keypairPath = process.env.OPERATOR_KEYPAIR
    ?? (fs.existsSync(defaultKeypairPath) ? defaultKeypairPath : undefined);
  if (!keypairPath) return Keypair.generate();

  const raw = JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function log(step: string, msg: string) {
  console.log(`\n[${step}] ${msg}`);
}

// ─────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const operator = loadOperatorKeypair();
  const merchant = Keypair.generate();
  const wallet     = new anchor.Wallet(operator);
  const provider   = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program    = new anchor.Program(
    { ...(IDL as anchor.Idl), address: PROGRAM_ID.toBase58() },
    provider
  ) as any;

  console.log("\n🚀  Velora end-to-end demo on devnet");
  console.log("────────────────────────────────────");
  console.log("operator:", operator.publicKey.toBase58());
  console.log("merchant:", merchant.publicKey.toBase58());

  // ── Step 1: airdrop ──────────────────────────
  log("1/8", "Funding operator...");
  const startingBalance = await connection.getBalance(operator.publicKey);
  if (startingBalance < DEMO_TARGET_BALANCE) {
    try {
      await fundToTargetBalance(connection, operator.publicKey, DEMO_TARGET_BALANCE);
    } catch (err) {
      throw new Error(
        `Devnet faucet failed before the demo could start. Retry later, or run with a funded keypair: OPERATOR_KEYPAIR=/path/to/keypair.json PROGRAM_ID=${PROGRAM_ID.toBase58()} npx ts-node scripts/demo.ts\nOriginal error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  console.log("    balance:", (await connection.getBalance(operator.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // ── Step 2: register operator ────────────────
  log("2/8", "Registering operator (fee: 50bps = 0.5%)...");
  try {
    await program.methods.registerOperator(50)
      .accounts({ operator: operator.publicKey, operatorRegistry: regPDA(operator.publicKey), escrowVault: vaultPDA(operator.publicKey) })
      .signers([operator]).rpc();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("already in use")) throw err;
    console.log("    already registered — continuing");
  }
  console.log("    OperatorRegistry PDA:", regPDA(operator.publicKey).toBase58());

  // ── Step 3: deposit bond ─────────────────────
  log("3/8", "Depositing 1 SOL bond into EscrowVault...");
  const vaultBefore = await program.account.escrowVault.fetch(vaultPDA(operator.publicKey));
  const depositNeeded = Math.max(0, DEMO_BOND_LAMPORTS - vaultBefore.depositedLamports.toNumber());
  if (depositNeeded > 0) {
    await program.methods.depositBond(new BN(depositNeeded))
      .accounts({ operator: operator.publicKey, escrowVault: vaultPDA(operator.publicKey) })
      .signers([operator]).rpc();
  } else {
    console.log("    bond already funded — continuing");
  }
  const vaultAcc = await program.account.escrowVault.fetch(vaultPDA(operator.publicKey));
  console.log("    vault balance:", vaultAcc.depositedLamports.toNumber() / LAMPORTS_PER_SOL, "SOL");

  // ── Step 4: initialize scorecard ─────────────
  log("4/8", "Initializing ScoreCard (EMA starts at 100%)...");
  try {
    await program.methods.initializeScorecard()
      .accounts({
        operator: operator.publicKey, operatorRegistry: regPDA(operator.publicKey),
        escrowVault: vaultPDA(operator.publicKey), scoreCard: scorePDA(operator.publicKey),
      })
      .signers([operator]).rpc();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("already in use")) throw err;
    console.log("    scorecard already exists — continuing");
  }
  const sc0 = await program.account.scoreCard.fetch(scorePDA(operator.publicKey));
  console.log("    ema_reliability:", sc0.emaReliability.toNumber(), "/ 1_000_000");

  // ── Step 5: initialize mint + epoch ──────────
  log("5/8", `Initializing global mint and epoch ${DEMO_EPOCH_NUMBER}...`);
  try {
    await program.methods.initializeMint()
      .accounts({
        payer: operator.publicKey,
        mint: mintPDA(),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([operator]).rpc();
    console.log("    mint PDA:", mintPDA().toBase58());
  } catch { console.log("    mint already exists — skipping"); }

  try {
    await program.methods.initializeEpoch(new BN(DEMO_EPOCH_NUMBER))
      .accounts({ payer: operator.publicKey, epochState: epochPDA(DEMO_EPOCH_NUMBER) })
      .signers([operator]).rpc();
    console.log(`    epoch ${DEMO_EPOCH_NUMBER} PDA:`, epochPDA(DEMO_EPOCH_NUMBER).toBase58());
  } catch { console.log(`    epoch ${DEMO_EPOCH_NUMBER} already exists — skipping`); }

  // ── Step 6: submit 5 proofs ───────────────────
  log("6/8", "Submitting 5 fulfillment proofs (latency: 300ms each)...");
  for (let i = 0; i < 5; i++) {
    const amount      = new BN(200_000_000); // 0.2 SOL per proof
    const latencyMs   = 300;
    const proofBytes  = serializeProof(amount, latencyMs, merchant.publicKey, operator.publicKey);
    const sig         = nacl.sign.detached(proofBytes, merchant.secretKey);
    const ed25519Ix   = Ed25519Program.createInstructionWithPublicKey({
      publicKey: merchant.publicKey.toBytes(), message: proofBytes, signature: sig,
    });
    const submitIx = await program.methods
      .submitProof({ amount, latencyMs, merchant: merchant.publicKey, operator: operator.publicKey })
      .accounts({
        operator: operator.publicKey, operatorRegistry: regPDA(operator.publicKey),
        scoreCard: scorePDA(operator.publicKey), escrowVault: vaultPDA(operator.publicKey),
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      }).signers([operator]).instruction();

    const tx = new Transaction().add(ed25519Ix, submitIx);
    tx.feePayer = operator.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(operator);
    const txSig = await connection.sendRawTransaction(tx.serialize());
    await confirm(connection, txSig);
    process.stdout.write(`    proof ${i + 1}/5 confirmed\r`);
  }

  const scFinal = await program.account.scoreCard.fetch(scorePDA(operator.publicKey));
  console.log(`\n    fulfillment_count: ${scFinal.fulfillmentCount.toNumber()}`);
  console.log(`    ema_reliability:   ${scFinal.emaReliability.toNumber()} / 1_000_000 (${(scFinal.emaReliability.toNumber() / 10_000).toFixed(4)}%)`);
  console.log(`    total_volume:      ${scFinal.totalVolume.toNumber() / LAMPORTS_PER_SOL} SOL`);

  // ── Step 7: claim emission ────────────────────
  log("7/8", `Claiming token emission for epoch ${DEMO_EPOCH_NUMBER}...`);
  const ataAddress = getAssociatedTokenAddressSync(
    mintPDA(),
    operator.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  await program.methods.claimEmission(new BN(DEMO_EPOCH_NUMBER))
    .accounts({
      operator: operator.publicKey, operatorRegistry: regPDA(operator.publicKey),
      scoreCard: scorePDA(operator.publicKey), epochState: epochPDA(DEMO_EPOCH_NUMBER),
      mint: mintPDA(), operatorTokenAccount: ataAddress,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([operator]).rpc();

  const ataInfo = await connection.getTokenAccountBalance(ataAddress);
  console.log("    tokens minted:", ataInfo.value.uiAmountString, "VLRA");

  const epochFinal = await program.account.epochState.fetch(epochPDA(DEMO_EPOCH_NUMBER));
  console.log("    epoch_emitted:", epochFinal.epochEmitted.toString(), "raw units");

  // ── Step 8: explorer links ────────────────────
  log("8/8", "Done! Links:");
  console.log(`    program:  https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`);
  console.log(`    operator: https://explorer.solana.com/address/${regPDA(operator.publicKey)}?cluster=devnet`);
  console.log(`    scorecard: https://explorer.solana.com/address/${scorePDA(operator.publicKey)}?cluster=devnet`);
  console.log(`    mint:     https://explorer.solana.com/address/${mintPDA()}?cluster=devnet`);
  console.log(`    epoch:    https://explorer.solana.com/address/${epochPDA(DEMO_EPOCH_NUMBER)}?cluster=devnet`);
  console.log("\n✅  Full proof-of-facilitation loop complete.\n");
}

main().catch(err => { console.error("\n❌", err); process.exit(1); });
