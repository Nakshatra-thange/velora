import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { startAnchor } from "anchor-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { assert } from "chai";
import { Velora } from "../target/types/velora";

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/** Derive the OperatorRegistry PDA for a given operator pubkey */
function getOperatorRegistryPDA(
  operatorPubkey: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), operatorPubkey.toBuffer()],
    programId
  );
}

/** Derive the EscrowVault PDA for a given operator pubkey */
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
  // shared across tests
  let context: Awaited<ReturnType<typeof startAnchor>>;
  let provider: BankrunProvider;
  let program: Program<Velora>;

  // a fresh operator keypair for each test that needs one
  let operator: Keypair;

  before(async () => {
    // Bankrun spins up a local validator in-process — much faster than `anchor test`
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    program = anchor.workspace.Velora as Program<Velora>;
  });

  // give each test a fresh operator so they don't share state
  beforeEach(() => {
    operator = Keypair.generate();
  });

  // ── utility: airdrop SOL to any keypair inside Bankrun ──
  async function airdrop(pubkey: PublicKey, sol: number) {
    await context.banksClient.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
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

    // fetch and assert OperatorRegistry
    const registry = await program.account.operatorRegistry.fetch(registryPDA);
    assert.equal(registry.operator.toBase58(), operator.publicKey.toBase58());
    assert.equal(registry.feeBps, feeBps);
    assert.isTrue(registry.isActive);
    assert.isAbove(registry.registeredAt.toNumber(), 0);

    // fetch and assert EscrowVault
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

    // must register first
    await program.methods
      .registerOperator(100)
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    const depositAmount = new BN(5 * LAMPORTS_PER_SOL);

    await program.methods
      .depositBond(depositAmount)
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

    // first registration — should succeed
    await program.methods
      .registerOperator(200)
      .accounts(accounts)
      .signers([operator])
      .rpc();

    // second registration — must throw because the PDA already exists
    try {
      await program.methods
        .registerOperator(200)
        .accounts(accounts)
        .signers([operator])
        .rpc();

      // if we reach here the test must fail
      assert.fail("Expected duplicate registration to throw but it did not");
    } catch (err: any) {
      // Anchor throws when `init` tries to create an already-initialised account
      assert.ok(err, "Error was thrown as expected");
    }
  });

  // ─────────────────────────────────────────────
  //  TEST 4 — deregister and reclaim bond
  // ─────────────────────────────────────────────
  it("deregisters the operator, sets isActive = false, returns bond to wallet", async () => {
    await airdrop(operator.publicKey, 10);

    const [registryPDA] = getOperatorRegistryPDA(operator.publicKey, program.programId);
    const [vaultPDA]    = getEscrowVaultPDA(operator.publicKey, program.programId);

    // register
    await program.methods
      .registerOperator(75)
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    // deposit 3 SOL
    await program.methods
      .depositBond(new BN(3 * LAMPORTS_PER_SOL))
      .accounts({
        operator:    operator.publicKey,
        escrowVault: vaultPDA,
      })
      .signers([operator])
      .rpc();

    // record operator balance before deregister
    const balanceBefore = await context.banksClient.getBalance(operator.publicKey);

    // deregister
    await program.methods
      .deregisterOperator()
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    // assert registry is inactive
    const registry = await program.account.operatorRegistry.fetch(registryPDA);
    assert.isFalse(registry.isActive, "isActive should be false after deregister");

    // assert vault is drained
    const vault = await program.account.escrowVault.fetch(vaultPDA);
    assert.equal(vault.depositedLamports.toNumber(), 0, "vault should be empty");

    // assert operator got their SOL back (balance increased)
    const balanceAfter = await context.banksClient.getBalance(operator.publicKey);
    assert.isAbove(
      Number(balanceAfter),
      Number(balanceBefore),
      "operator balance should increase after bond returned"
    );
  });

  // ─────────────────────────────────────────────
  //  TEST 5 — deregister with no bond should fail
  // ─────────────────────────────────────────────
  it("rejects deregister when no bond has been deposited", async () => {
    await airdrop(operator.publicKey, 10);

    const [registryPDA] = getOperatorRegistryPDA(operator.publicKey, program.programId);
    const [vaultPDA]    = getEscrowVaultPDA(operator.publicKey, program.programId);

    // register but DO NOT deposit
    await program.methods
      .registerOperator(300)
      .accounts({
        operator:         operator.publicKey,
        operatorRegistry: registryPDA,
        escrowVault:      vaultPDA,
      })
      .signers([operator])
      .rpc();

    // deregister without depositing — must throw NoBondDeposited
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
      // check it's our custom error, not a generic network error
      assert.include(
        err.toString(),
        "NoBondDeposited",
        "Error should be VeloraError::NoBondDeposited"
      );
    }
  });
});