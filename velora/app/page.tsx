"use client";

import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  CheckCircle2,
  Gauge,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type ScoreboardRow = {
  rank: number;
  operator: string;
  ema_pct: string;
  ema_raw: number;
  fee_bps: number;
  fulfillment_count: number;
  total_volume_sol: string;
  slash_count: number;
  bond_sol: string;
  status: "healthy" | "slashable";
};

type ScoreboardResponse = {
  scoreboard: ScoreboardRow[];
  total: number;
  updated_at: string;
};

type HealthResponse = {
  status: string;
  cluster: string;
  program_id: string;
  pending_requests: number;
  uptime_seconds: number;
};

type Route = {
  operator: string;
  fee_bps: number;
  ema_reliability: number;
  fulfillment_count: number;
  route_score: number;
  recommended?: boolean;
};

const AGGREGATOR_URL =
  process.env.NEXT_PUBLIC_AGGREGATOR_URL ?? "http://localhost:3001";
const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID;

export default function Home() {
  const [scoreboard, setScoreboard] = useState<ScoreboardResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [amount, setAmount] = useState("500000000");
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    setError(null);
    try {
      const [scoreboardRes, healthRes] = await Promise.all([
        fetch(`${AGGREGATOR_URL}/scoreboard`, { cache: "no-store" }),
        fetch(`${AGGREGATOR_URL}/health`, { cache: "no-store" }),
      ]);

      if (!scoreboardRes.ok) throw new Error(await scoreboardRes.text());
      if (!healthRes.ok) throw new Error(await healthRes.text());

      setScoreboard((await scoreboardRes.json()) as ScoreboardResponse);
      setHealth((await healthRes.json()) as HealthResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    const id = window.setInterval(fetchDashboard, 5_000);
    return () => window.clearInterval(id);
  }, [fetchDashboard]);

  const stats = useMemo(() => {
    const rows = scoreboard?.scoreboard ?? [];
    const healthy = rows.filter((row) => row.status === "healthy").length;
    const fulfillments = rows.reduce((sum, row) => sum + row.fulfillment_count, 0);
    const best = rows[0];

    return {
      healthy,
      slashable: rows.length - healthy,
      fulfillments,
      bestOperator: best?.operator,
      bestEma: best?.ema_pct,
    };
  }, [scoreboard]);

  async function simulateRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRouteLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${AGGREGATOR_URL}/routes?amount=${encodeURIComponent(amount)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { routes: Route[] };
      setRoutes(data.routes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fetch routes");
    } finally {
      setRouteLoading(false);
    }
  }

  return (
    <main className="shell">
      <section className="topbar" aria-label="Velora overview">
        <div>
          <p className="eyebrow">Proof-of-facilitation</p>
          <h1>Velora operator scoreboard</h1>
        </div>
        <button className="icon-button" onClick={fetchDashboard} type="button" aria-label="Refresh dashboard">
          <RefreshCw aria-hidden="true" size={18} />
        </button>
      </section>

      {error ? (
        <section className="notice error" role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <div>
            <strong>Could not reach the aggregator</strong>
            <p>{error}</p>
          </div>
          <button type="button" onClick={fetchDashboard}>Retry</button>
        </section>
      ) : null}

      <section className="metric-grid" aria-label="Network metrics">
        <Metric icon={<RadioTower />} label="Cluster" value={health?.cluster ?? "local"} loading={loading} />
        <Metric icon={<ShieldCheck />} label="Healthy operators" value={`${stats.healthy}`} loading={loading} />
        <Metric icon={<Activity />} label="Fulfillments" value={`${stats.fulfillments}`} loading={loading} />
        <Metric icon={<WalletCards />} label="Pending requests" value={`${health?.pending_requests ?? 0}`} loading={loading} />
      </section>

      <div className="content-grid">
        <section className="panel scoreboard-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Live ranking</p>
              <h2>Reliability scoreboard</h2>
            </div>
            <StatusPill status={stats.slashable > 0 ? "slashable" : "healthy"} />
          </div>

          {loading ? <TableSkeleton /> : null}

          {!loading && scoreboard?.scoreboard.length === 0 ? (
            <EmptyState />
          ) : null}

          {!loading && scoreboard && scoreboard.scoreboard.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Operator</th>
                    <th>EMA</th>
                    <th>Fee</th>
                    <th>Proofs</th>
                    <th>Bond</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scoreboard.scoreboard.map((row) => (
                    <tr key={row.operator}>
                      <td>#{row.rank}</td>
                      <td className="mono">{shortAddress(row.operator)}</td>
                      <td>{row.ema_pct}</td>
                      <td>{row.fee_bps} bps</td>
                      <td>{row.fulfillment_count}</td>
                      <td>{row.bond_sol} SOL</td>
                      <td><StatusPill status={row.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <aside className="panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Merchant route</p>
              <h2>Route selection</h2>
            </div>
            <ArrowDownUp aria-hidden="true" size={18} />
          </div>

          <form className="route-form" onSubmit={simulateRoute}>
            <label htmlFor="amount">Amount in lamports</label>
            <div className="input-row">
              <input
                id="amount"
                inputMode="numeric"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <button type="submit" disabled={routeLoading}>
                {routeLoading ? "Routing" : "Find"}
              </button>
            </div>
          </form>

          <div className="route-list" aria-live="polite">
            {routes.length === 0 ? (
              <div className="quiet-state">
                <Gauge aria-hidden="true" size={18} />
                <p>Fetch a route to see top operators by fee, EMA, and experience.</p>
              </div>
            ) : (
              routes.map((route, index) => (
                <div className="route-card" key={route.operator}>
                  <div>
                    <span className="route-rank">#{index + 1}</span>
                    <strong className="mono">{shortAddress(route.operator)}</strong>
                  </div>
                  <p>{(route.route_score * 100).toFixed(2)} score · {route.fee_bps} bps</p>
                  {route.recommended ? <span className="recommended">Recommended</span> : null}
                </div>
              ))
            )}
          </div>

          <div className="program-box">
            <span>Program</span>
            <strong className="mono">{shortAddress(PROGRAM_ID ?? health?.program_id ?? "")}</strong>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  loading: boolean;
}) {
  return (
    <div className="metric">
      <span className="metric-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {loading ? <div className="skeleton metric-skeleton" /> : <strong>{value}</strong>}
    </div>
  );
}

function StatusPill({ status }: { status: "healthy" | "slashable" }) {
  return (
    <span className={`pill ${status}`}>
      <CheckCircle2 aria-hidden="true" size={14} />
      {status === "healthy" ? "Healthy" : "Slashable"}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="skeleton-list" aria-label="Loading scoreboard">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="skeleton row-skeleton" key={index} />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <RadioTower aria-hidden="true" size={32} />
      <strong>No operators yet</strong>
      <p>Start the aggregator and register an operator; the scoreboard will update automatically.</p>
    </div>
  );
}

function shortAddress(address: string) {
  if (!address) return "Not set";
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
