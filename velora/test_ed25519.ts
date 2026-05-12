import { Connection, Keypair, Transaction, Ed25519Program, sendAndConfirmTransaction } from "@solana/web3.js";

async function main() {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const payer = Keypair.generate();
    
    console.log("Airdropping to payer...");
    const sig = await connection.requestAirdrop(payer.publicKey, 1000000000);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh });

    console.log("Sending ed25519 transaction...");
    const message = Buffer.from("hello world");
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: payer.secretKey,
        message: message,
    });

    const tx = new Transaction().add(ed25519Ix);
    try {
        await sendAndConfirmTransaction(connection, tx, [payer]);
        console.log("Success!");
    } catch (err) {
        console.error("Error:", err);
    }
}

main().catch(console.error);
