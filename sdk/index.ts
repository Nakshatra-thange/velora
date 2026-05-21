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