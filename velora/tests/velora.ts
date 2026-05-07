import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { Velora } from "../target/types/velora";

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

function getOperatorRegistryPDA(
  operatorPubkey: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), operatorPubkey.toBuffer()],
    programId
  );
}

function getEscrowVaultPDA(
  operatorPubkey: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), operatorPubkey.toBuffer()],
    programId
  );
}

// ─────────────────────────────────────────────
//  TEST SUITE
// ─────────────────────────────────────────────

describe("velora", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Velora as Program<Velora>;
  const connection = provider.connection;

  // fresh operator keypair per test — no shared state
  let operator: Keypair;

  beforeEach(() => {
    operator = Keypair.generate();
  });

  // airdrop using standard connection.requestAirdrop + confirmTransaction
  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature: sig,
      ...latestBlockhash,
    });
  }

  // ─────────────────────────────────────────────
  //  TEST 1 — register an operator
  // ─────────────────────────────────────────────
  it("registers an operator and populates both PDAs correctly", async () => {
    await airdrop(operator.publicKey, 10);

    const feeBps = 50; // 0.5%
    const [registryPDA] = getOperatorRegistryPDA(operator.publicKey, program.programId);
    const [vaultPDA]    = getEscrowVaultPDA(operator.publicKey, program.programId);

    await program.methods
      .registerOperator(feeBps)
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    const registry = await program.account.operatorRegistry.fetch(registryPDA);
    assert.equal(registry.operator.toBase58(), operator.publicKey.toBase58());
    assert.equal(registry.feeBps, feeBps);
    assert.isTrue(registry.isActive);
    assert.isAbove(registry.registeredAt.toNumber(), 0);

    const vault = await program.account.escrowVault.fetch(vaultPDA);
    assert.equal(vault.operator.toBase58(), operator.publicKey.toBase58());
    assert.equal(vault.depositedLamports.toNumber(), 0);
  });

  // ─────────────────────────────────────────────
  //  TEST 2 — deposit bond
  // ─────────────────────────────────────────────
  it("deposits 5 SOL into the escrow vault and updates depositedLamports", async () => {
    await airdrop(operator.publicKey, 10);

    const [registryPDA] = getOperatorRegistryPDA(operator.publicKey, program.programId);
    const [vaultPDA]    = getEscrowVaultPDA(operator.publicKey, program.programId);

    await program.methods
      .registerOperator(100)
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    await program.methods
      .depositBond(new BN(5 * LAMPORTS_PER_SOL))
      .accounts({
        operator:    operator.publicKey,
        escrowVault: vaultPDA,
      })
      .signers([operator])
      .rpc();

    const vault = await program.account.escrowVault.fetch(vaultPDA);
    assert.equal(
      vault.depositedLamports.toNumber(),
      5 * LAMPORTS_PER_SOL,
      "depositedLamports should be exactly 5 SOL"
    );
  });

  // ─────────────────────────────────────────────
  //  TEST 3 — reject duplicate registration
  // ─────────────────────────────────────────────
  it("rejects a second registration from the same operator", async () => {
    await airdrop(operator.publicKey, 10);

    const [registryPDA] = getOperatorRegistryPDA(operator.publicKey, program.programId);
    const [vaultPDA]    = getEscrowVaultPDA(operator.publicKey, program.programId);

    const accounts = {
      operator:         operator.publicKey,
      operatorRegistry: registryPDA,
      escrowVault:      vaultPDA,
    };

    // first — succeeds
    await program.methods
      .registerOperator(200)
      .accounts(accounts)
      .signers([operator])
      .rpc();

    // second — must throw
    try {
      await program.methods
        .registerOperator(200)
        .accounts(accounts)
        .signers([operator])
        .rpc();

      assert.fail("Expected duplicate registration to throw but it did not");
    } catch (err: any) {
      assert.ok(err, "Error was thrown as expected for duplicate PDA init");
    }
  });

  // ─────────────────────────────────────────────
  //  TEST 4 — full lifecycle: register → deposit → deregister
  // ─────────────────────────────────────────────
  it("deregisters the operator, sets isActive=false, returns bond to wallet", async () => {
    await airdrop(operator.publicKey, 10);

    const [registryPDA] = getOperatorRegistryPDA(operator.publicKey, program.programId);
    const [vaultPDA]    = getEscrowVaultPDA(operator.publicKey, program.programId);

    await program.methods
      .registerOperator(75)
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    await program.methods
      .depositBond(new BN(3 * LAMPORTS_PER_SOL))
      .accounts({
        operator:    operator.publicKey,
        escrowVault: vaultPDA,
      })
      .signers([operator])
      .rpc();

    const balanceBefore = await connection.getBalance(operator.publicKey);

    await program.methods
      .deregisterOperator()
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    const registry = await program.account.operatorRegistry.fetch(registryPDA);
    assert.isFalse(registry.isActive, "isActive should be false after deregister");

    const vault = await program.account.escrowVault.fetch(vaultPDA);
    assert.equal(vault.depositedLamports.toNumber(), 0, "vault should be drained");

    const balanceAfter = await connection.getBalance(operator.publicKey);
    assert.isAbove(balanceAfter, balanceBefore, "operator should get SOL back");
  });

  // ─────────────────────────────────────────────
  //  TEST 5 — deregister with no bond should fail
  // ─────────────────────────────────────────────
  it("rejects deregister when no bond has been deposited", async () => {
    await airdrop(operator.publicKey, 10);

    const [registryPDA] = getOperatorRegistryPDA(operator.publicKey, program.programId);
    const [vaultPDA]    = getEscrowVaultPDA(operator.publicKey, program.programId);

    await program.methods
      .registerOperator(300)
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    try {
      await program.methods
        .deregisterOperator()
        .accounts({
          operator:         operator.publicKey,
          operatorRegistry: registryPDA,
          escrowVault:      vaultPDA,
        })
        .signers([operator])
        .rpc();

      assert.fail("Expected NoBondDeposited error but instruction succeeded");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "NoBondDeposited",
        "Should throw VeloraError::NoBondDeposited"
      );
    }
  });
});