
export interface BotMetrics {
  launchedDetected: number;
  sniped: number;
  rejected: number;
  openPositions: number;
  closedPositions: number;
  exitsFailed: number;
  killSwitchTripped: boolean;
  lastTripReason: string | null;
  uptimeSeconds: number;
}

export function metrics(input: {
  launchedDetected: number;
  sniped: number;
  rejected: number;
  openPositions: number;
  closedPositions: number;
  exitsFailed: number;
  killSwitchTripped: boolean;
  lastTripReason: string | null;
  startedAt: number;
}): BotMetrics {
  return {
    ...input,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - input.startedAt) / 1000)),
  };
}