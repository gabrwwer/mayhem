function formatNumber(n: number, decimals: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * Format a price with enough precision to be readable at memecoin scale.
 *
 * The previous implementation capped at 6 decimal places for any value below
 * 0.01. A pump.fun token trades around 3e-8 SOL, so every one of them rendered
 * as "0.000000" — visually identical to a worthless token, and identical to
 * every other token on the page. A price display that collapses five orders of
 * magnitude into the same string is worse than showing nothing.
 *
 * Below 0.01 the precision is derived from the magnitude so roughly four
 * significant figures survive: 2.8e-8 renders as 0.000000027960 rather than
 * 0.000000. Above it, the original fixed-decimal behaviour is unchanged.
 *
 * `toLocaleString` accepts at most 20 fraction digits, so the derived
 * precision is clamped well inside that.
 */
export function formatPrice(n: number, decimals?: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";

  const abs = Math.abs(n);

  if (decimals !== undefined) {
    return formatNumber(n, decimals);
  }

  if (abs >= 10000) return formatNumber(n, 1);
  if (abs >= 100) return formatNumber(n, 2);
  if (abs >= 1) return formatNumber(n, 3);
  if (abs >= 0.01) return formatNumber(n, 4);

  // Leading zeros after the decimal point, e.g. 2.8e-8 has 7 of them.
  const leadingZeros = Math.max(0, -Math.floor(Math.log10(abs)) - 1);
  const precision = Math.min(leadingZeros + 4, 18);

  return formatNumber(n, precision);
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

export function formatSignedPercent(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatTime(value: number | Date | null | undefined): string {
  if (value == null) return "—";
  const timestamp = typeof value === "number" ? value : value.valueOf();
  if (!Number.isFinite(timestamp)) return "—";
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDateTime(value: number | Date | string | null | undefined): string {
  if (value == null) return "—";
  const date =
    typeof value === "string"
      ? new Date(value)
      : typeof value === "number"
      ? new Date(value)
      : value;
  if (!Number.isFinite(date.valueOf())) return "—";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

/** SOL amount. 4dp is the smallest increment worth showing at position size. */
export function formatSol(n: number, decimals = 4): string {
  if (!Number.isFinite(n)) return "—";
  return `${formatNumber(n, decimals)} SOL`;
}

/** Signed SOL, for P&L columns where the sign carries the meaning. */
export function formatSignedSol(n: number, decimals = 4): string {
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${formatNumber(n, decimals)} SOL`;
}

export function formatUsd(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return "—";
  return `$${formatNumber(n, decimals)}`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return formatNumber(n, 0);
}

export function formatMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}ms`;
}

export function formatPercent(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return "—";
  return `${formatNumber(n, decimals)}%`;
}

/**
 * Millisecond-precision clock for the event log. Local time — the operator
 * correlates these against their own wall clock, not UTC.
 */
export function formatLogTime(value: string | number | Date | null | undefined): string {
  if (value == null) return "—";
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.valueOf();
  if (!Number.isFinite(ms)) return "—";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const mmm = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/** Elapsed time since an ISO timestamp, for position age columns. */
export function elapsedSince(iso: string | null | undefined): string {
  if (!iso) return "—";
  const started = new Date(iso).valueOf();
  if (!Number.isFinite(started)) return "—";
  return ageLabel(Math.max(0, Math.floor((Date.now() - started) / 1000)));
}

export function shortAddress(value: string | null | undefined, prefix = 6, suffix = 4): string {
  if (!value) return "—";
  const text = String(value);
  if (text.length <= prefix + suffix + 1) return text;
  return `${text.slice(0, prefix)}…${text.slice(-suffix)}`;
}
