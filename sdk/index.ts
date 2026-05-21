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