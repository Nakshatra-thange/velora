import { Connection, Keypair, Transaction, Ed25519Program, sendAndConfirmTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";

async function main() {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const payer = Keypair.generate();
    console.log("Requesting airdrop...");
    const sig = await connection.requestAirdrop(payer.publicKey, 1000000000);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh });

    const merchant = Keypair.generate();
    const proofBytes = Buffer.alloc(10);
    const signature = nacl.sign.detached(proofBytes, merchant.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: merchant.publicKey.toBytes(),
        message: proofBytes,
        signature: signature,
    });

    const tx = new Transaction().add(ed25519Ix);
    try {
        await sendAndConfirmTransaction(connection, tx, [payer]);
        console.log("Ed25519 SUCCESS!");
    } catch (e: any) {
        console.error("Ed25519 FAILED:", e);
    }
}

main().catch(console.error);
