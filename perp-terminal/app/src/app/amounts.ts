
// ---------------------------------------------------------------------------
// Amount parsing / formatting helpers. All parsing is defensive: bad input
// falls back to a safe default instead of producing NaN in the UI.
// ---------------------------------------------------------------------------

export function parseAmount(v: string | number | null | undefined, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (v == null) return fallback;
  const n = Number(String(v).replace(/[,\s$]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function roundTo(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function priceDecimalsFor(price: number): number {
  if (price >= 10_000) return 1;
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 4;
  return 6;
}

export function formatPrice(n: number, decimals?: number): string {
  if (!Number.isFinite(n)) return 'â€”';
  const d = decimals ?? priceDecimalsFor(Math.abs(n));
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function formatAmount(n: number, decimals = 4): string {
  if (!Number.isFinite(n)) return 'â€”';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function formatSigned(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return 'â€”';
  const sign = n > 0 ? '+' : '';
  return (
    sign +
    n.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return 'â€”';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

export function pctChange(now: number, prev: number): number {
  if (!Number.isFinite(prev) || prev === 0) return 0;
  return ((now - prev) / Math.abs(prev)) * 100;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'â€”';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}