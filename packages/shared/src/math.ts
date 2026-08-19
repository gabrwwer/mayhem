
export function safeAdd(a: number, b: number): number {
  return Number.isFinite(a) && Number.isFinite(b) ? a + b : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toBps(percent: number): number {
  return Math.round(percent * 100);
}

export function fromBps(bps: number): number {
  return bps / 100;
}