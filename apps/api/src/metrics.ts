export type MetricStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'STALE' | 'ERROR';

export interface Timestamped<T> {
  value: T | null;
  status: MetricStatus;
  observedAt?: number;
}

export interface VolumeWindow {
  oneMinute: Timestamped<number>;
  fiveMinute: Timestamped<number>;
  oneHour: Timestamped<number>;
}

export interface FlowMetrics {
  buyVolume1mSol: Timestamped<number>;
  sellVolume1mSol: Timestamped<number>;
  buyTransactions1m: Timestamped<number>;
  sellTransactions1m: Timestamped<number>;
  transactionVelocity1m: Timestamped<number>;
  uniqueBuyers1m: Timestamped<number>;
  uniqueSellers1m: Timestamped<number>;
}

export interface HolderMetrics {
  holderCount: Timestamped<number>;
  holderGrowthPct: Timestamped<number>;
  holderGrowthWindowMs: number;
}

export interface LiquidityMetrics {
  liquiditySol: Timestamped<number>;
  curveReserveSol: Timestamped<number>;
  curveProgressPct: Timestamped<number>;
}

export interface DexInfo {
  dexSource: Timestamped<string>;
}

export interface SmartMoneyMetrics {
  smartMoneyAccumulation: Timestamped<number>;
  smartMoneyBuyerCount: Timestamped<number>;
  smartMoneyBuyVolumeSol: Timestamped<number>;
  smartMoneySellVolumeSol: Timestamped<number>;
  smartMoneyStatus: MetricStatus;
}

export interface MayhemScoreComponent {
  value: number | null;
  weight: number;
  status: MetricStatus;
  contribution: number | null;
}

export interface MayhemScore {
  score: number | null;
  scoreConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  status: MetricStatus;
  components: Record<string, MayhemScoreComponent>;
}

export interface NormalizedDiscoveryMetrics {
  mint: string;
  observedAt: number;
  price: Timestamped<number>;
  priceChangePct: Timestamped<number>;
  volume: VolumeWindow & { surgeRatio: Timestamped<number>; surgeReason?: string };
  flow: FlowMetrics;
  holders: HolderMetrics;
  liquidity: LiquidityMetrics;
  dex: DexInfo;
  smartMoney: SmartMoneyMetrics;
  mayhemScore: MayhemScore;
}

// Simple in-memory rolling windows and baseline history. This module
// provides deterministic, auditable aggregation but does not attempt to
// fabricate missing data: unavailable values are explicitly marked.

interface TxRecord {
  ts: number;
  mint: string;
  side: 'buy' | 'sell';
  amountSol: number;
  buyer?: string | null;
  seller?: string | null;
  signature?: string | null;
}

const txStore: Map<string, TxRecord[]> = new Map();
const holderHistory: Map<string, { ts: number; count: number }[]> = new Map();
const liquidityStore: Map<string, { ts: number; liquiditySol: number | null; curveReserveSol: number | null; curveProgressPct: number | null; dex?: string | null }[]> = new Map();
const seenSignatures: Map<string, number> = new Map();
const oneMinute = 60_000;
const fiveMinute = 5 * 60_000;
const oneHour = 60 * 60_000;

export function ingestTransaction(tx: TxRecord) {
  // Deduplicate when a signature is provided
  if (tx.signature && typeof tx.signature === 'string') {
    if (seenSignatures.has(tx.signature)) return;
    seenSignatures.set(tx.signature, Date.now());
    // Keep map bounded: trim oldest when too large
    if (seenSignatures.size > 50_000) {
      const entries = [...seenSignatures.entries()];
      // keep the newest 25k
      const keep = new Map(entries.slice(-25_000));
      seenSignatures.clear();
      for (const [k, v] of keep) seenSignatures.set(k, v);
    }
  }

  const list = txStore.get(tx.mint) ?? [];
  list.push(tx);
  txStore.set(tx.mint, list);
}

export function ingestHolderObservation(mint: string, ts: number, count: number) {
  const list = holderHistory.get(mint) ?? [];
  list.push({ ts, count });
  holderHistory.set(mint, list);
}

export function ingestLiquidityObservation(mint: string, ts: number, liquiditySol: number | null, curveReserveSol: number | null, curveProgressPct: number | null, dex?: string | null) {
  const list = liquidityStore.get(mint) ?? [];
  list.push({ ts, liquiditySol, curveReserveSol, curveProgressPct, dex: dex ?? null });
  liquidityStore.set(mint, list);
}

function aggregateWindow(mint: string, now: number, windowMs: number) {
  const recs = txStore.get(mint) ?? [];
  const cutoff = now - windowMs;
  let buyVol = 0;
  let sellVol = 0;
  const buyTx = new Set<string>();
  const sellTx = new Set<string>();
  for (const r of recs) {
    if (r.ts < cutoff) continue;
    if (r.side === 'buy') {
      buyVol += r.amountSol;
      if (r.buyer) buyTx.add(r.buyer);
    } else {
      sellVol += r.amountSol;
      if (r.seller) sellTx.add(r.seller);
    }
  }
  return {
    buyVol,
    sellVol,
    buyTxCount: buyTx.size,
    sellTxCount: sellTx.size,
    txCount: recs.filter(r => r.ts >= cutoff).length,
    uniqueBuyers: buyTx.size,
    uniqueSellers: sellTx.size,
  };
}

function historicalBaseline(mint: string, now: number) {
  // Build 1-minute buckets for the last 24 hours (limited).
  const recs = txStore.get(mint) ?? [];
  const buckets: number[] = [];
  const bucketMs = oneMinute;
  const start = now - 24 * 60 * 60_000;
  const n = Math.floor((now - start) / bucketMs);
  // Create map minuteStart -> sum
  const map = new Map<number, number>();
  for (const r of recs) {
    if (r.ts < start || r.ts >= now) continue;
    const key = Math.floor(r.ts / bucketMs) * bucketMs;
    map.set(key, (map.get(key) ?? 0) + r.amountSol);
  }
  for (let i = 0; i < n; i++) {
    const key = start + i * bucketMs;
    const v = map.get(key) ?? 0;
    buckets.push(v);
  }
  return buckets;
}

export function computeMetricsForMint(mint: string): NormalizedDiscoveryMetrics {
  const now = Date.now();
  const vol1 = aggregateWindow(mint, now, oneMinute);
  const vol5 = aggregateWindow(mint, now, fiveMinute);
  const vol60 = aggregateWindow(mint, now, oneHour);

  // Volume fields
  const volume = {
    oneMinute: { value: vol1.buyVol + vol1.sellVol, status: 'AVAILABLE' as MetricStatus, observedAt: now },
    fiveMinute: { value: vol5.buyVol + vol5.sellVol, status: 'AVAILABLE' as MetricStatus, observedAt: now },
    oneHour: { value: vol60.buyVol + vol60.sellVol, status: 'AVAILABLE' as MetricStatus, observedAt: now },
    surgeRatio: { value: null as number | null, status: 'UNAVAILABLE' as MetricStatus },
  } as any;

  // Compute surge baseline
  const buckets = historicalBaseline(mint, now);
  const nonZero = buckets.filter(v => v > 0);
  if (nonZero.length >= 5) {
    const avg = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
    if (avg > 0) {
      volume.surgeRatio = { value: volume.oneMinute.value / avg, status: 'AVAILABLE' as MetricStatus, observedAt: now };
    } else {
      volume.surgeRatio = { value: null, status: 'UNAVAILABLE' as MetricStatus, surgeReason: 'ZERO_BASELINE' };
    }
  } else {
    volume.surgeRatio = { value: null, status: 'UNAVAILABLE' as MetricStatus, surgeReason: 'INSUFFICIENT_HISTORY' };
  }

  // Flow metrics (1m)
  const flow: FlowMetrics = {
    buyVolume1mSol: { value: vol1.buyVol, status: 'AVAILABLE', observedAt: now },
    sellVolume1mSol: { value: vol1.sellVol, status: 'AVAILABLE', observedAt: now },
    buyTransactions1m: { value: vol1.buyTxCount, status: 'AVAILABLE', observedAt: now },
    sellTransactions1m: { value: vol1.sellTxCount, status: 'AVAILABLE', observedAt: now },
    transactionVelocity1m: { value: vol1.txCount, status: 'AVAILABLE', observedAt: now },
    uniqueBuyers1m: { value: vol1.uniqueBuyers, status: 'AVAILABLE', observedAt: now },
    uniqueSellers1m: { value: vol1.uniqueSellers, status: 'AVAILABLE', observedAt: now },
  };

  // Holder metrics: use last two observations within 5 minutes
  const holdersList = holderHistory.get(mint) ?? [];
  const nowCut = now;
  const prevCut = now - fiveMinute;
  const recent = holdersList.filter(h => h.ts >= prevCut && h.ts <= nowCut);
  let holderCountVal: Timestamped<number> = { value: null, status: 'UNAVAILABLE' };
  let holderGrowthPct: Timestamped<number> = { value: null, status: 'UNAVAILABLE' };
  if (recent.length > 0) {
    const latest = recent[recent.length - 1]?.count ?? null;
    if (latest !== null) {
      holderCountVal = { value: latest, status: 'AVAILABLE', observedAt: now };
      const firstRecentTs = recent[0]?.ts ?? null;
      let prevCandidate = undefined as { ts: number; count: number } | undefined;
      if (firstRecentTs !== null) {
        prevCandidate = holdersList.slice(0, -1).reverse().find(h => h.ts < firstRecentTs);
      }
      if (prevCandidate && typeof prevCandidate.count === 'number') {
        const prevCount = prevCandidate.count;
        if (prevCount === 0) {
          holderGrowthPct = { value: null, status: 'UNAVAILABLE' };
        } else {
          holderGrowthPct = { value: ((latest - prevCount) / prevCount) * 100, status: 'AVAILABLE', observedAt: now };
        }
      } else {
        holderGrowthPct = { value: null, status: 'UNAVAILABLE' };
      }
    }
  }

  const holders: HolderMetrics = {
    holderCount: holderCountVal,
    holderGrowthPct: holderGrowthPct,
    holderGrowthWindowMs: fiveMinute,
  };

  // Liquidity/dex/smartMoney: unknown until data arrives via discovery or liquidity callbacks
  const liquidity: LiquidityMetrics = {
    liquiditySol: { value: null, status: 'UNAVAILABLE' },
    curveReserveSol: { value: null, status: 'UNAVAILABLE' },
    curveProgressPct: { value: null, status: 'UNAVAILABLE' },
  };

  const dex: DexInfo = {
    dexSource: { value: null, status: 'UNAVAILABLE' },
  };

  // Pick latest liquidity observation if present
  const liqList = liquidityStore.get(mint) ?? [];
  if (liqList.length > 0) {
    const latest = liqList[liqList.length - 1]!;
    if (latest.liquiditySol !== null && latest.liquiditySol !== undefined) {
      liquidity.liquiditySol = { value: latest.liquiditySol, status: 'AVAILABLE', observedAt: now };
    }
    if (latest.curveReserveSol !== null && latest.curveReserveSol !== undefined) {
      liquidity.curveReserveSol = { value: latest.curveReserveSol, status: 'AVAILABLE', observedAt: now };
    }
    if (latest.curveProgressPct !== null && latest.curveProgressPct !== undefined) {
      liquidity.curveProgressPct = { value: latest.curveProgressPct, status: 'AVAILABLE', observedAt: now };
    }
    if (latest.dex) {
      dex.dexSource = { value: latest.dex, status: 'AVAILABLE', observedAt: now };
    }
  }

  const smartMoney: SmartMoneyMetrics = {
    smartMoneyAccumulation: { value: null, status: 'UNAVAILABLE' },
    smartMoneyBuyerCount: { value: null, status: 'UNAVAILABLE' },
    smartMoneyBuyVolumeSol: { value: null, status: 'UNAVAILABLE' },
    smartMoneySellVolumeSol: { value: null, status: 'UNAVAILABLE' },
    smartMoneyStatus: 'UNAVAILABLE',
  };

  // MAYHEM score: only when core components are available.
  const components: Record<string, MayhemScoreComponent> = {
    flowScore: { value: null, weight: 0.25, status: 'UNAVAILABLE', contribution: null },
    volumeScore: { value: null, weight: 0.25, status: 'UNAVAILABLE', contribution: null },
    holderScore: { value: null, weight: 0.15, status: 'UNAVAILABLE', contribution: null },
    liquidityScore: { value: null, weight: 0.15, status: 'UNAVAILABLE', contribution: null },
    smartMoneyScore: { value: null, weight: 0.1, status: 'UNAVAILABLE', contribution: null },
    riskScore: { value: null, weight: 0.1, status: 'UNAVAILABLE', contribution: null },
  };

  let mayhemScore: MayhemScore = { score: null, scoreConfidence: null, status: 'UNAVAILABLE', components };

  // If essential flow and volume are available, produce a deterministic composite score.
  if (flow.buyVolume1mSol.status === 'AVAILABLE' && volume.oneMinute.status === 'AVAILABLE') {
    const flowVal = Math.min(100, Math.round(Math.log10((flow.buyVolume1mSol.value ?? 0) + 1) * 20));
    const volVal = Math.min(100, Math.round(Math.log10((volume.oneMinute.value ?? 0) + 1) * 20));
    components['flowScore'] = { value: flowVal, weight: 0.25, status: 'AVAILABLE', contribution: flowVal * 0.25 };
    components['volumeScore'] = { value: volVal, weight: 0.25, status: 'AVAILABLE', contribution: volVal * 0.25 };
    // holder
    if (holders.holderCount.status === 'AVAILABLE') {
      const h = Math.min(100, Math.round((holders.holderCount.value ?? 0) > 0 ? 100 : 0));
      components['holderScore'] = { value: h, weight: 0.15, status: 'AVAILABLE', contribution: h * 0.15 };
    }
    mayhemScore.score = Object.values(components).reduce((acc, c) => acc + (c.contribution ?? 0), 0);
    const totalWeight = Object.values(components).reduce((a, b) => a + (b.weight ?? 0), 0) || 1;
    mayhemScore.score = Math.round((mayhemScore.score ?? 0) / totalWeight);
    mayhemScore.status = 'AVAILABLE';
    mayhemScore.scoreConfidence = 'MEDIUM';
  }

  const normalized: NormalizedDiscoveryMetrics = {
    mint,
    observedAt: now,
    price: { value: null, status: 'UNAVAILABLE' },
    priceChangePct: { value: null, status: 'UNAVAILABLE' },
    volume: volume as any,
    flow,
    holders,
    liquidity,
    dex,
    smartMoney,
    mayhemScore,
  };

  return normalized;
}

export function getComputedMetrics(mint: string) {
  return computeMetricsForMint(mint);
}
