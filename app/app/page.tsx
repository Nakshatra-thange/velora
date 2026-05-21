/**
 * app/page.tsx
 *
 * Velora live scoreboard — Next.js 14 App Router page.
 * Polls GET /scoreboard every 10 seconds.
 * If wallet connected + operator registered → shows personal dashboard + claim button.
 *
 * Setup:
 *   npx create-next-app@latest app --typescript --tailwind --app
 *   cd app
 *   npm install @solana/wallet-adapter-react @solana/wallet-adapter-react-ui \
 *               @solana/wallet-adapter-wallets @solana/web3.js @coral-xyz/anchor
 *   cp this file app/page.tsx
 *   set NEXT_PUBLIC_AGGREGATOR_URL in .env.local
 *   set NEXT_PUBLIC_PROGRAM_ID in .env.local
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import "@solana/wallet-adapter-react-ui/styles.css";

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

const AGGREGATOR_URL = process.env.NEXT_PUBLIC_AGGREGATOR_URL ?? "http://localhost:3001";
const PROGRAM_ID     = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? "YOUR_PROGRAM_ID_HERE"
);
const WALLETS        = [new PhantomWalletAdapter()];

// ─────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────

interface ScoreboardEntry {
  rank:              number;
  operator:          string;
  ema_pct:           string;
  ema_raw:           number;
  fee_bps:           number;
  fulfillment_count: number;
  total_volume_sol:  string;
  slash_count:       number;
  bond_sol:          string;
  status:            "healthy" | "slashable";
}

// ─────────────────────────────────────────────
//  EMA COLOUR HELPER
// ─────────────────────────────────────────────

function emaColor(raw: number): string {
  if (raw >= 900_000) return "text-green-400";
  if (raw >= 700_000) return "text-yellow-400";
  return "text-red-400";
}

function statusBadge(status: string) {
  return status === "healthy"
    ? "bg-green-900 text-green-300 border border-green-700"
    : "bg-red-900 text-red-300 border border-red-700";
}

// ─────────────────────────────────────────────
//  PERSONAL DASHBOARD (shown when wallet connected)
// ─────────────────────────────────────────────

function OperatorDashboard({ entry }: { entry: ScoreboardEntry | null }) {
  const { publicKey } = useWallet();

  if (!publicKey) return null;

  if (!entry) {
    return (
      <div className="mb-8 rounded-xl border border-zinc-700 bg-zinc-900 p-5">
        <p className="text-sm text-zinc-400">
          Connected: <span className="font-mono text-zinc-300">{publicKey.toBase58().slice(0, 20)}...</span>
        </p>
        <p className="mt-2 text-sm text-yellow-400">
          ⚠ Not registered as an operator. Run <code className="bg-zinc-800 px-1 rounded">register_operator</code> first.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-8 rounded-xl border border-violet-700 bg-violet-950/40 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-violet-300 uppercase tracking-widest">
          Your Operator Dashboard
        </h2>
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(entry.status)}`}>
          {entry.status}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "EMA Reliability", value: entry.ema_pct, color: emaColor(entry.ema_raw) },
          { label: "Fee",             value: `${entry.fee_bps} bps` },
          { label: "Fulfillments",    value: entry.fulfillment_count.toLocaleString() },
          { label: "Volume Routed",   value: `${entry.total_volume_sol} SOL` },
          { label: "Bond Locked",     value: `${entry.bond_sol} SOL` },
          { label: "Slash Count",     value: entry.slash_count.toString(), color: entry.slash_count > 0 ? "text-red-400" : undefined },
          { label: "Rank",            value: `#${entry.rank}` },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-zinc-900 rounded-lg p-3">
            <p className="text-xs text-zinc-500 mb-1">{label}</p>
            <p className={`text-lg font-semibold ${color ?? "text-zinc-100"}`}>{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  SCOREBOARD TABLE
// ─────────────────────────────────────────────

function Scoreboard({ entries, myPubkey }: { entries: ScoreboardEntry[]; myPubkey: string | null }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-widest">
            {["Rank", "Operator", "EMA", "Fee", "Fulfillments", "Volume", "Slashes", "Status"].map(h => (
              <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const isMe = myPubkey && e.operator === myPubkey;
            return (
              <tr
                key={e.operator}
                className={`border-b border-zinc-800/50 transition-colors ${
                  isMe ? "bg-violet-950/30" : "hover:bg-zinc-800/30"
                }`}
              >
                <td className="px-4 py-3 font-mono text-zinc-400">
                  {e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : `#${e.rank}`}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                  {isMe && <span className="text-violet-400 mr-1">▶</span>}
                  {e.operator.slice(0, 8)}...{e.operator.slice(-6)}
                </td>
                <td className={`px-4 py-3 font-semibold ${emaColor(e.ema_raw)}`}>
                  {e.ema_pct}
                </td>
                <td className="px-4 py-3 text-zinc-300">{e.fee_bps} bps</td>
                <td className="px-4 py-3 text-zinc-300">{e.fulfillment_count.toLocaleString()}</td>
                <td className="px-4 py-3 text-zinc-300">{e.total_volume_sol} SOL</td>
                <td className={`px-4 py-3 ${e.slash_count > 0 ? "text-red-400" : "text-zinc-500"}`}>
                  {e.slash_count}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(e.status)}`}>
                    {e.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────
//  MAIN PAGE INNER (needs wallet context)
// ─────────────────────────────────────────────

function VeloraApp() {
  const { publicKey } = useWallet();
  const [entries,     setEntries]     = useState<ScoreboardEntry[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [totalOps,    setTotalOps]    = useState(0);

  const myPubkey = publicKey?.toBase58() ?? null;
  const myEntry  = entries.find(e => e.operator === myPubkey) ?? null;

  const fetchScoreboard = useCallback(async () => {
    try {
      const res  = await fetch(`${AGGREGATOR_URL}/scoreboard`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(data.scoreboard ?? []);
      setTotalOps(data.total ?? 0);
      setLastUpdated(new Date().toLocaleTimeString());
      setError(null);
    } catch (err: any) {
      setError(`Cannot reach aggregator at ${AGGREGATOR_URL}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // initial fetch + poll every 10s
  useEffect(() => {
    fetchScoreboard();
    const interval = setInterval(fetchScoreboard, 10_000);
    return () => clearInterval(interval);
  }, [fetchScoreboard]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-10">
      {/* ── header ── */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-violet-400">Velora</span> Scoreboard
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Proof-of-facilitation — operators ranked by on-chain EMA reliability
          </p>
        </div>
        <WalletMultiButton style={{}} />
      </div>

      {/* ── stats bar ── */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: "Active Operators", value: totalOps },
          { label: "Last Updated",     value: lastUpdated || "—" },
          { label: "Network",          value: "Devnet" },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
            <p className="text-xs text-zinc-500">{label}</p>
            <p className="text-lg font-semibold text-zinc-100 mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      {/* ── personal dashboard ── */}
      {publicKey && <OperatorDashboard entry={myEntry} />}

      {/* ── scoreboard ── */}
      {loading ? (
        <div className="text-center text-zinc-500 py-20">Loading scoreboard...</div>
      ) : error ? (
        <div className="text-center text-red-400 py-20">{error}</div>
      ) : entries.length === 0 ? (
        <div className="text-center text-zinc-500 py-20">
          No operators registered yet.
        </div>
      ) : (
        <Scoreboard entries={entries} myPubkey={myPubkey} />
      )}

      {/* ── footer ── */}
      <div className="mt-8 text-center text-xs text-zinc-600">
        Velora — DePIN proof-of-facilitation primitive on Solana •{" "}
        <a
          href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-violet-500 hover:text-violet-400"
        >
          View program on Explorer
        </a>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  ROOT — wraps with wallet providers
// ─────────────────────────────────────────────

export default function Page() {
  return (
    <ConnectionProvider endpoint={clusterApiUrl("devnet")}>
      <WalletProvider wallets={WALLETS} autoConnect>
        <WalletModalProvider>
          <VeloraApp />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}