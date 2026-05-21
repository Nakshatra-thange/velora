

import * as anchor from "@coral-xyz/anchor";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import IDL         from "../target/idl/velora.json";

// ─────────────────────────────────────────────
//  CONFIG — paste your deployed program ID here
// ─────────────────────────────────────────────
const PROGRAM_ID   = new PublicKey(process.env.PROGRAM_ID ?? (IDL as any).address);
const CLUSTER      = "devnet";

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/** Convert fixed-point u64 (scaled by 1_000_000) → human-readable percentage string */
function fmtEma(ema: anchor.BN): string {
  const pct = ema.toNumber() / 10_000; // 1_000_000 → 100.0000
  return pct.toFixed(4) + "%";
}

/** Convert lamports → SOL string */
function fmtSol(lamports: anchor.BN): string {
  return (lamports.toNumber() / 1_000_000_000).toFixed(4) + " SOL";
}

/** Format unix timestamp → readable date */
function fmtDate(ts: anchor.BN): string {
  return new Date(ts.toNumber() * 1000).toISOString();
}

/** Pad a string to a fixed width for table alignment */
function pad(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length);
}

// ─────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────

async function main() {
  const connection = new Connection(clusterApiUrl(CLUSTER), "confirmed");

  // build a read-only provider (no wallet needed — just reading accounts)
  const provider = new anchor.AnchorProvider(
    connection,
    // dummy wallet for read-only use
    {
      publicKey:      PublicKey.default,
      signTransaction:     async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    },
    { commitment: "confirmed" }
  );

  const program = new anchor.Program(
    { ...(IDL as anchor.Idl), address: PROGRAM_ID.toBase58() },
    provider
  ) as any;

  console.log("\n🔍  Fetching all ScoreCard accounts from", CLUSTER, "...\n");

  // fetch every ScoreCard PDA — program.account.scoreCard.all() uses
  // the account discriminator to filter only ScoreCard accounts
  const allScoreCards = await program.account.scoreCard.all();

  if (allScoreCards.length === 0) {
    console.log("No ScoreCard accounts found. Submit some proofs first.");
    return;
  }

  // sort descending by ema_reliability (highest score = rank 1)
  const sorted = allScoreCards.sort((a, b) =>
    b.account.emaReliability.cmp(a.account.emaReliability)
  );

  // ── print scoreboard table ──
  const divider = "─".repeat(120);

  console.log(divider);
  console.log(
    pad("RANK", 6),
    pad("OPERATOR",          46),
    pad("EMA RELIABILITY",   18),
    pad("FULFILLMENTS",      14),
    pad("TOTAL VOLUME",      16),
    pad("SLASHES",            9),
    pad("LAST PROOF",        26),
  );
  console.log(divider);

  sorted.forEach((entry, idx) => {
    const sc      = entry.account;
    const rank    = `#${idx + 1}`;
    const op      = sc.operator.toBase58();
    const ema     = fmtEma(sc.emaReliability);
    const count   = sc.fulfillmentCount.toString();
    const volume  = fmtSol(sc.totalVolume);
    const slashes = sc.slashCount.toString();
    const updated = fmtDate(sc.lastUpdated);

    // colour-code the EMA: green ≥ 90%, yellow ≥ 70%, red < 70%
    const emaNum = sc.emaReliability.toNumber();
    const emaColoured =
      emaNum >= 900_000 ? `\x1b[32m${ema}\x1b[0m` :  // green
      emaNum >= 700_000 ? `\x1b[33m${ema}\x1b[0m` :  // yellow
                          `\x1b[31m${ema}\x1b[0m`;    // red (slashable)

    console.log(
      pad(rank,    6),
      pad(op,     46),
      pad(emaColoured, 18 + 9), // +9 for ANSI escape codes that don't count as visible chars
      pad(count,  14),
      pad(volume, 16),
      pad(slashes, 9),
      pad(updated, 26),
    );
  });

  console.log(divider);
  console.log(`\n  Total operators: ${sorted.length}`);

  // ── also fetch OperatorRegistry to cross-reference is_active ──
  console.log("\n📋  Operator status cross-check:\n");
  for (const entry of sorted) {
    const [regPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("operator"), entry.account.operator.toBuffer()],
      PROGRAM_ID
    );

    try {
      const reg = await program.account.operatorRegistry.fetch(regPDA);
      const status = reg.isActive ? "\x1b[32m ACTIVE  \x1b[0m" : "\x1b[31m SLASHED \x1b[0m";
      console.log(
        ` ${status}  ${entry.account.operator.toBase58()}  fee: ${reg.feeBps} bps`
      );
    } catch {
      console.log(` UNKNOWN  ${entry.account.operator.toBase58()}`);
    }
  }

  console.log("\n✅  Done.\n");
}

main().catch((err) => {
  console.error("\n❌  Error:", err);
  process.exit(1);
});
