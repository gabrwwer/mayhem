export type TipPercentile = 25 | 50 | 75 | 95 | 99;

export interface TipFloorRow {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

export interface FeeBudgetConfig {
  strategy: "percentile" | "fixed";
  percentile?: TipPercentile;      // default 50
  fixedLamports?: number;
  maxTipLamports: number;          // HARD CAP â€” tips must never eat the edge
  tipFloorUrl?: string;            // default https://bundles.jito.wtf/api/v1/bundles/tip_floor
  cacheMs?: number;                // default 30_000
}

export class FeeBudget {
  private last: { row: TipFloorRow; at: number } | null = null;

  constructor(private readonly cfg: FeeBudgetConfig) {}

  async tipLamports(): Promise<number> {
    let lamports: number;
    if (this.cfg.strategy === "fixed") {
      lamports = this.cfg.fixedLamports ?? 0;
    } else {
      const row = await this.floor();
      const pct = this.cfg.percentile ?? 50;
      lamports = Math.ceil(row[`landed_tips_${pct}th_percentile`] * 1_000_000_000);
    }
    return Math.max(0, Math.min(lamports, this.cfg.maxTipLamports));
  }

  private async floor(): Promise<TipFloorRow> {
    const now = Date.now();
    const cacheMs = this.cfg.cacheMs ?? 30_000;
    if (this.last && now - this.last.at < cacheMs) return this.last.row;
    const url = this.cfg.tipFloorUrl ?? "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
    const res: Awaited<ReturnType<typeof fetch>> = await fetch(url);

    const status = (res as unknown as { status: number }).status;
    if (status < 200 || status >= 300) {
      throw new Error(`tip_floor: HTTP ${status}`);
    }

    const rows = (await (res as unknown as { json(): Promise<unknown> }).json()) as TipFloorRow[];
    if (rows.length === 0) {
      throw new Error("tip_floor: no data returned");
    }
    const row = rows[rows.length - 1]; // newest entry
    if (!row) {
      throw new Error("tip_floor: no data returned");
    }
    this.last = { row, at: now };
    return row;
  }
}