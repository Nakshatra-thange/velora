export interface VeloraRoute {
  operator: string;
  fee_bps: number;
  is_active: boolean;
  ema_reliability: number;
  fulfillment_count: number;
  total_volume: number;
  bond_lamports: number;
  route_score: number;
  recommended?: boolean;
}

export interface RoutesResponse {
  amount_lamports: number;
  routes: VeloraRoute[];
  total_operators: number;
  fetched_at: string;
  message?: string;
}

export interface SubmitRequestResponse {
  request_id: string;
  routes: VeloraRoute[];
}

export interface ConfirmFulfillmentResponse {
  request_id: string;
  fulfilled: boolean;
  request?: {
    id: string;
    merchant: string;
    amount: number;
    created_at: number;
    claimed_by?: string;
    fulfilled: boolean;
  };
}

export interface VeloraSDKConfig {
  aggregatorUrl: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class VeloraSDK {
  private readonly aggregatorUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(config: VeloraSDKConfig) {
    this.aggregatorUrl = config.aggregatorUrl.replace(/\/$/, "");
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async getRoutes(amountLamports: number): Promise<VeloraRoute[]> {
    const data = await this.get<RoutesResponse>(
      `/routes?amount=${encodeURIComponent(amountLamports)}`
    );
    return data.routes;
  }

  selectBestRoute(routes: VeloraRoute[]): VeloraRoute | null {
    if (routes.length === 0) return null;
    return [...routes].sort((a, b) => b.route_score - a.route_score)[0];
  }

  async submitRequest(
    merchant: string,
    amountLamports: number
  ): Promise<SubmitRequestResponse> {
    return this.post<SubmitRequestResponse>("/request", {
      merchant,
      amount: amountLamports,
    });
  }

  async confirmFulfillment(
    requestId: string,
    timeoutMs = this.timeoutMs
  ): Promise<ConfirmFulfillmentResponse> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const data = await this.get<ConfirmFulfillmentResponse>(
        `/request/${encodeURIComponent(requestId)}`
      );
      if (data.fulfilled) return data;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new Error(`Timed out waiting for fulfillment ${requestId}`);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.aggregatorUrl}${path}`);
    if (!res.ok) {
      throw new Error(`Velora GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.aggregatorUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Velora POST ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }
}
