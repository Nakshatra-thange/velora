
 // Run: npx ts-node scripts/demo.ts
 
import * as anchor from "@coral-xyz/anchor";
import { BN }  from "@coral-xyz/anchor";
import {
  Keypair, LAMPORTS_PER_SOL, PublicKey,
  Transaction, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY,
  clusterApiUrl, Connection,
} from "@solana/web3.js";
import * as borsh from "@coral-xyz/borsh";
import nacl       from "tweetnacl";
import IDL        from "../target/idl/velora.json";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? (IDL as any).address);

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

function log(step: string, msg: string) {
  console.log(`\n[${step}] ${msg}`);
}

// ─────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet     = anchor.Wallet.local(); // reads ~/.config/solana/id.json
  const provider   = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program    = new anchor.Program(
    { ...(IDL as anchor.Idl), address: PROGRAM_ID.toBase58() },
    provider
  ) as any;

  const operator = Keypair.generate();
  const merchant = Keypair.generate();

  console.log("\n🚀  Velora end-to-end demo on devnet");
  console.log("────────────────────────────────────");
  console.log("operator:", operator.publicKey.toBase58());
  console.log("merchant:", merchant.publicKey.toBase58());

  // ── Step 1: airdrop ──────────────────────────
  log("1/8", "Airdropping SOL to operator...");
  await confirm(connection, await connection.requestAirdrop(operator.publicKey, 5 * LAMPORTS_PER_SOL));
  console.log("    balance:", (await connection.getBalance(operator.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // ── Step 2: register operator ────────────────
  log("2/8", "Registering operator (fee: 50bps = 0.5%)...");
  await program.methods.registerOperator(50)
    .accounts({ operator: operator.publicKey, operatorRegistry: regPDA(operator.publicKey), escrowVault: vaultPDA(operator.publicKey) })
    .signers([operator]).rpc();
  console.log("    OperatorRegistry PDA:", regPDA(operator.publicKey).toBase58());

  // ── Step 3: deposit bond ─────────────────────
  log("3/8", "Depositing 2 SOL bond into EscrowVault...");
  await program.methods.depositBond(new BN(2 * LAMPORTS_PER_SOL))
    .accounts({ operator: operator.publicKey, escrowVault: vaultPDA(operator.publicKey) })
    .signers([operator]).rpc();
  const vaultAcc = await program.account.escrowVault.fetch(vaultPDA(operator.publicKey));
  console.log("    vault balance:", vaultAcc.depositedLamports.toNumber() / LAMPORTS_PER_SOL, "SOL");

  // ── Step 4: initialize scorecard ─────────────
  log("4/8", "Initializing ScoreCard (EMA starts at 100%)...");
  await program.methods.initializeScorecard()
    .accounts({
      operator: operator.publicKey, operatorRegistry: regPDA(operator.publicKey),
      escrowVault: vaultPDA(operator.publicKey), scoreCard: scorePDA(operator.publicKey),
    })
    .signers([operator]).rpc();
  const sc0 = await program.account.scoreCard.fetch(scorePDA(operator.publicKey));
  console.log("    ema_reliability:", sc0.emaReliability.toNumber(), "/ 1_000_000");

  // ── Step 5: initialize mint + epoch ──────────
  log("5/8", "Initializing global mint and epoch 0...");
  try {
    await program.methods.initializeMint()
      .accounts({ payer: operator.publicKey, mint: mintPDA() })
      .signers([operator]).rpc();
    console.log("    mint PDA:", mintPDA().toBase58());
  } catch { console.log("    mint already exists — skipping"); }

  try {
    await program.methods.initializeEpoch(new BN(0))
      .accounts({ payer: operator.publicKey, epochState: epochPDA(0) })
      .signers([operator]).rpc();
    console.log("    epoch 0 PDA:", epochPDA(0).toBase58());
  } catch { console.log("    epoch 0 already exists — skipping"); }

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
  log("7/8", "Claiming token emission for epoch 0...");
  const ataAddress = await anchor.utils.token.associatedAddress({ mint: mintPDA(), owner: operator.publicKey });
  await program.methods.claimEmission(new BN(0))
    .accounts({
      operator: operator.publicKey, operatorRegistry: regPDA(operator.publicKey),
      scoreCard: scorePDA(operator.publicKey), epochState: epochPDA(0),
      mint: mintPDA(), operatorTokenAccount: ataAddress,
    })
    .signers([operator]).rpc();

  const ataInfo = await connection.getTokenAccountBalance(ataAddress);
  console.log("    tokens minted:", ataInfo.value.uiAmountString, "VLRA");

  const epochFinal = await program.account.epochState.fetch(epochPDA(0));
  console.log("    epoch_emitted:", epochFinal.epochEmitted.toString(), "raw units");

  // ── Step 8: explorer links ────────────────────
  log("8/8", "Done! Links:");
  console.log(`    program:  https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`);
  console.log(`    operator: https://explorer.solana.com/address/${regPDA(operator.publicKey)}?cluster=devnet`);
  console.log(`    scorecard: https://explorer.solana.com/address/${scorePDA(operator.publicKey)}?cluster=devnet`);
  console.log(`    mint:     https://explorer.solana.com/address/${mintPDA()}?cluster=devnet`);
  console.log("\n✅  Full proof-of-facilitation loop complete.\n");
}

main().catch(err => { console.error("\n❌", err); process.exit(1); });
