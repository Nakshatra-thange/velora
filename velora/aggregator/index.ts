

import express, { Request, Response } from "express";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, clusterApiUrl } from "@solana/web3.js";
import IDL         from "../target/idl/velora.json";
import { randomUUID } from "crypto";

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

const PORT       = process.env.PORT || 3001;
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? (IDL as any).address);
const CLUSTER    = (process.env.CLUSTER ?? "devnet") as anchor.web3.Cluster;
const SCALE      = 1_000_000;

// ─────────────────────────────────────────────
//  ANCHOR SETUP (read-only, no wallet needed)
// ─────────────────────────────────────────────

const connection = new Connection(clusterApiUrl(CLUSTER), "confirmed");

const provider = new anchor.AnchorProvider(
  connection,
  {
    publicKey:           PublicKey.default,
    signTransaction:     async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  },
  { commitment: "confirmed" }
);

const program = new anchor.Program(
  { ...(IDL as anchor.Idl), address: PROGRAM_ID.toBase58() },
  provider
) as any;

// ─────────────────────────────────────────────
//  IN-MEMORY PENDING REQUEST QUEUE
//  Merchants POST /request → queued here
//  Solvers   GET /requests → poll here
//  Solvers   POST /claim   → remove from queue
// ─────────────────────────────────────────────

interface PendingRequest {
  id:          string;
  merchant:    string;   // merchant pubkey (base58)
  amount:      number;   // lamports
  created_at:  number;   // unix ms
  claimed_by?: string;   // operator pubkey that claimed it
  fulfilled:   boolean;
}

const queue: Map<string, PendingRequest> = new Map();

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/** Fetch all active OperatorRegistry + ScoreCard pairs from on-chain. */
async function fetchOperators() {
  // Fetch all OperatorRegistry accounts
  const allRegistries = await program.account.operatorRegistry.all();
  const active        = allRegistries.filter((r) => r.account.isActive);

  // For each active operator, fetch their ScoreCard
  const results = await Promise.allSettled(
    active.map(async (reg) => {
      const [scorePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("score"), reg.account.operator.toBuffer()],
        PROGRAM_ID
      );

      const [vaultPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), reg.account.operator.toBuffer()],
        PROGRAM_ID
      );

      const [scoreCard, vault] = await Promise.all([
        program.account.scoreCard.fetch(scorePDA).catch(() => null),
        program.account.escrowVault.fetch(vaultPDA).catch(() => null),
      ]);

      if (!scoreCard) return null;

      return {
        operator:          reg.account.operator.toBase58(),
        fee_bps:           reg.account.feeBps,
        is_active:         reg.account.isActive,
        registered_at:     reg.account.registeredAt.toNumber(),
        ema_reliability:   scoreCard.emaReliability.toNumber(),
        total_volume:      scoreCard.totalVolume.toNumber(),
        fulfillment_count: scoreCard.fulfillmentCount.toNumber(),
        slash_count:       scoreCard.slashCount,
        last_updated:      scoreCard.lastUpdated.toNumber(),
        bond_lamports:     vault?.depositedLamports.toNumber() ?? 0,
      };
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

/**
 * Route score formula:
 *   score = fee_factor * 0.4 + ema_factor * 0.4 + reliability_factor * 0.2
 *
 * fee_factor:         1 - fee_bps / 10_000       (lower fee = higher score)
 * ema_factor:         ema_reliability / SCALE     (higher EMA = higher score)
 * reliability_factor: fulfillment_count normalised to [0,1] capped at 1000
 *                     (more experience = more reliable estimate)
 */
function computeRouteScore(op: any): number {
  const fee_factor         = 1 - op.fee_bps / 10_000;
  const ema_factor         = op.ema_reliability / SCALE;
  const reliability_factor = Math.min(op.fulfillment_count / 1000, 1);
  return fee_factor * 0.4 + ema_factor * 0.4 + reliability_factor * 0.2;
}

// ─────────────────────────────────────────────
//  EXPRESS APP
// ─────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── CORS for local frontend dev ──
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ────────────────────────────────────────────
//  GET /routes?amount=<lamports>
//
//  Returns top 3 operators sorted by route score.
//  The merchant SDK calls this to pick a fulfillment route.
// ────────────────────────────────────────────
app.get("/routes", async (req: Request, res: Response) => {
  try {
    const amount = Number(req.query.amount ?? 0);

    const operators = await fetchOperators();

    if (operators.length === 0) {
      return res.json({ routes: [], message: "No active operators found" });
    }

    // compute score for each and sort descending
    const scored = operators
      .map((op) => ({ ...op, route_score: computeRouteScore(op) }))
      .sort((a, b) => b.route_score - a.route_score);

    const top3 = scored.slice(0, 3);

    // mark the best route
    if (top3.length > 0) {
      top3[0].recommended = true;
    }

    return res.json({
      amount_lamports: amount,
      routes:          top3,
      total_operators: operators.length,
      fetched_at:      new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[/routes]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────
//  GET /scoreboard
//
//  All operators sorted by EMA descending.
//  Frontend scoreboard polls this.
// ────────────────────────────────────────────
app.get("/scoreboard", async (_req: Request, res: Response) => {
  try {
    const operators = await fetchOperators();

    const sorted = operators.sort(
      (a, b) => b.ema_reliability - a.ema_reliability
    );

    const ranked = sorted.map((op, i) => ({
      rank:              i + 1,
      operator:          op.operator,
      ema_pct:           (op.ema_reliability / 10_000).toFixed(4) + "%",
      ema_raw:           op.ema_reliability,
      fee_bps:           op.fee_bps,
      fulfillment_count: op.fulfillment_count,
      total_volume_sol:  (op.total_volume / 1e9).toFixed(4),
      slash_count:       op.slash_count,
      bond_sol:          (op.bond_lamports / 1e9).toFixed(4),
      status:            op.ema_reliability >= 700_000 ? "healthy" : "slashable",
    }));

    return res.json({
      scoreboard: ranked,
      total:      ranked.length,
      updated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[/scoreboard]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────
//  POST /request
//
//  Merchant submits a fulfillment request.
//  Body: { merchant: string, amount: number }
//  Returns: { id, routes } — merchant gets a request ID + top routes
// ────────────────────────────────────────────
app.post("/request", async (req: Request, res: Response) => {
  try {
    const { merchant, amount } = req.body;

    if (!merchant || !amount) {
      return res.status(400).json({ error: "merchant and amount are required" });
    }

    const operators = await fetchOperators();
    const scored    = operators
      .map((op) => ({ ...op, route_score: computeRouteScore(op) }))
      .sort((a, b) => b.route_score - a.route_score)
      .slice(0, 3);

    const request: PendingRequest = {
      id:         randomUUID(),
      merchant,
      amount:     Number(amount),
      created_at: Date.now(),
      fulfilled:  false,
    };

    queue.set(request.id, request);

    console.log(`[/request] new request ${request.id} from ${merchant} for ${amount} lamports`);

    return res.status(201).json({
      request_id: request.id,
      routes:     scored,
    });
  } catch (err: any) {
    console.error("[/request]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────
//  GET /request/:id
//
//  Merchant SDK polls this to confirm fulfillment.
// ────────────────────────────────────────────
app.get("/request/:id", (req: Request, res: Response) => {
  const requestId = String(req.params.id);
  const request = queue.get(requestId);

  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  return res.json({
    request_id: request.id,
    fulfilled: request.fulfilled,
    request,
  });
});

// ────────────────────────────────────────────
//  GET /requests
//
//  Solver polls this to find unfulfilled requests
//  where it appears in the top-3 routes.
// ────────────────────────────────────────────
app.get("/requests", async (req: Request, res: Response) => {
  try {
    const operator_pubkey = req.query.operator as string;

    if (!operator_pubkey) {
      return res.status(400).json({ error: "operator query param required" });
    }

    // return all unclaimed, unfulfilled requests
    const pending = Array.from(queue.values()).filter(
      (r) => !r.fulfilled && !r.claimed_by
    );

    // for each, check if this operator is in the top-3 routes
    const relevant = await Promise.all(
      pending.map(async (r) => {
        const operators = await fetchOperators();
        const top3      = operators
          .map((op) => ({ ...op, route_score: computeRouteScore(op) }))
          .sort((a, b) => b.route_score - a.route_score)
          .slice(0, 3);

        const inTop3 = top3.some((op) => op.operator === operator_pubkey);
        return inTop3 ? r : null;
      })
    );

    const filtered = relevant.filter(Boolean);

    return res.json({ requests: filtered });
  } catch (err: any) {
    console.error("[/requests]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────
//  POST /claim
//
//  Solver claims a request before fulfilling it.
//  Body: { request_id, operator }
// ────────────────────────────────────────────
app.post("/claim", (req: Request, res: Response) => {
  const { request_id, operator } = req.body;

  const request = queue.get(request_id);

  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }
  if (request.claimed_by) {
    return res.status(409).json({ error: "Already claimed", claimed_by: request.claimed_by });
  }
  if (request.fulfilled) {
    return res.status(409).json({ error: "Already fulfilled" });
  }

  request.claimed_by = operator;
  queue.set(request_id, request);

  console.log(`[/claim] ${operator} claimed request ${request_id}`);

  return res.json({ ok: true, request });
});

// ────────────────────────────────────────────
//  POST /fulfill
//
//  Solver reports fulfillment after submitting the on-chain proof.
//  Body: { request_id, operator, tx_sig }
// ────────────────────────────────────────────
app.post("/fulfill", (req: Request, res: Response) => {
  const { request_id, operator, tx_sig } = req.body;

  const request = queue.get(request_id);

  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }
  if (request.claimed_by !== operator) {
    return res.status(403).json({ error: "Not the claimer of this request" });
  }

  request.fulfilled = true;
  queue.set(request_id, request);

  console.log(`[/fulfill] ${operator} fulfilled request ${request_id} — tx: ${tx_sig}`);

  return res.json({ ok: true, tx_sig });
});

// ────────────────────────────────────────────
//  GET /health
// ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    cluster:         CLUSTER,
    program_id:      PROGRAM_ID.toBase58(),
    pending_requests: queue.size,
    uptime_seconds:  Math.floor(process.uptime()),
  });
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n🚀  Velora aggregator running on http://localhost:${PORT}`);
  console.log(`    cluster:    ${CLUSTER}`);
  console.log(`    program_id: ${PROGRAM_ID.toBase58()}`);
  console.log(`\n    endpoints:`);
  console.log(`      GET  /routes?amount=<lamports>  — top 3 routes for merchant`);
  console.log(`      GET  /scoreboard                — all operators ranked by EMA`);
  console.log(`      POST /request                   — merchant submits fulfillment request`);
  console.log(`      GET  /requests?operator=<pubkey>— solver polls for assigned requests`);
  console.log(`      POST /claim                     — solver claims a request`);
  console.log(`      POST /fulfill                   — solver reports completion`);
  console.log(`      GET  /health                    — uptime + stats\n`);
});

const keepAlive = setInterval(() => undefined, 1 << 30);

function shutdown() {
  clearInterval(keepAlive);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
