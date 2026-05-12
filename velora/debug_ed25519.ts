import { Keypair, Ed25519Program } from "@solana/web3.js";
import nacl from "tweetnacl";

const merchant = Keypair.generate();
const proofBytes = Buffer.alloc(10);
const sig = nacl.sign.detached(proofBytes, merchant.secretKey);

const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
  publicKey:  merchant.publicKey.toBytes(),
  message:    proofBytes,
  signature:  sig,
});

console.log("Ed25519 program id:", ed25519Ix.programId.toBase58());
