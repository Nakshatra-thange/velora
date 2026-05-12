import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import * as borsh from "@coral-xyz/borsh";
import nacl from "tweetnacl";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    
    // We will just read the idl to get the program ID, or rely on workspace.
    const program = anchor.workspace.Velora as any;
    const connection = provider.connection;
    
    const operator = Keypair.generate();
    const merchant = Keypair.generate();
    
    const sig = await connection.requestAirdrop(operator.publicKey, 10 * 10**9);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });

    // Setup...
    const pid = program.programId;
    const reg = PublicKey.findProgramAddressSync([Buffer.from("operator"), operator.publicKey.toBuffer()], pid)[0];
    const vault = PublicKey.findProgramAddressSync([Buffer.from("escrow"), operator.publicKey.toBuffer()], pid)[0];
    const score = PublicKey.findProgramAddressSync([Buffer.from("score"), operator.publicKey.toBuffer()], pid)[0];

    console.log("Registering operator...");
    await program.methods.registerOperator(50)
      .accounts({ operator: operator.publicKey, operatorRegistry: reg, escrowVault: vault })
      .signers([operator]).rpc();

    console.log("Depositing bond...");
    await program.methods.depositBond(new BN(2 * 10**9))
      .accounts({ operator: operator.publicKey, escrowVault: vault })
      .signers([operator]).rpc();

    console.log("Initializing scorecard...");
    await program.methods.initializeScorecard()
      .accounts({ operator: operator.publicKey, operatorRegistry: reg, escrowVault: vault, scoreCard: score })
      .signers([operator]).rpc();

    console.log("Submitting proof...");
    const PROOF_LAYOUT = borsh.struct([
        borsh.u64("amount"),
        borsh.u32("latency_ms"),
        borsh.publicKey("merchant"),
        borsh.publicKey("operator"),
    ]);

    const amountBN = new BN(500000000);
    const latencyMs = 500;
    const buf = Buffer.alloc(PROOF_LAYOUT.span);
    PROOF_LAYOUT.encode({ amount: amountBN, latency_ms: latencyMs, merchant: merchant.publicKey, operator: operator.publicKey }, buf);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: merchant.publicKey.toBytes(),
        message: buf,
        signature: nacl.sign.detached(buf, merchant.secretKey),
    });
    
    const submitIx = await program.methods.submitProof({ amount: amountBN, latencyMs, merchant: merchant.publicKey, operator: operator.publicKey })
        .accounts({
            operator: operator.publicKey,
            operatorRegistry: reg,
            scoreCard: score,
            escrowVault: vault,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

    const tx = new Transaction().add(ed25519Ix, submitIx);
    try {
        await provider.sendAndConfirm(tx, [operator]);
        console.log("SUCCESS!");
    } catch (e: any) {
        console.error("FAILED:");
        console.error(e);
        console.log("Transaction instructions:");
        for (let i = 0; i < tx.instructions.length; i++) {
            console.log(`IX ${i} programId:`, tx.instructions[i].programId.toBase58());
            console.log(`IX ${i} keys:`, tx.instructions[i].keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })));
        }
    }
}

main().catch(console.error);
