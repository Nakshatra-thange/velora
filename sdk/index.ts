export interface Route {
    operator:          string;   // operator pubkey (base58)
    fee_bps:           number;   // e.g. 50 = 0.5%
    ema_reliability:   number;   // raw fixed-point, out of 1_000_000
    ema_pct:           string;   // human-readable, e.g. "99.3750%"
    fulfillment_count: number;
    total_volume_sol:  string;
    route_score:       number;   // 0–1, higher is better
    recommended?:      boolean;
  }

  export interface RoutesResponse {
    amount_lamports: number;
    routes:          Route[];
    total_operators: number;
    fetched_at:      string;
  }
   
  export interface RequestResponse {
    request_id: string;
    routes:     Route[];
  }

  export interface ScoreboardEntry {
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
   
  export interface VeloraConfig {
    aggregatorUrl: string;
    timeoutMs?:    number;   // default 10_000
  }

  export class VeloraSDK {
    private baseUrl:   string;
    private timeoutMs: number;
   
    constructor(config: VeloraConfig) {
      this.baseUrl   = config.aggregatorUrl.replace(/\/$/, ""); // strip trailing slash
      this.timeoutMs = config.timeoutMs ?? 10_000;
    }
   
    // ── internal fetch wrapper ──
    private async get<T>(path: string): Promise<T> {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Velora SDK: GET ${path} returned ${res.status}`);
        return res.json() as Promise<T>;
      } finally {
        clearTimeout(timer);
      }
    }
   
    private async post<T>(path: string, body: object): Promise<T> {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
          signal:  controller.signal,
        });
        if (!res.ok) throw new Error(`Velora SDK: POST ${path} returned ${res.status}`);
        return res.json() as Promise<T>;
      } finally {
        clearTimeout(timer);
      }
    }
   