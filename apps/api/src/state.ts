import { EventEmitter } from 'events';

export type BotStatus = 'STOPPED' | 'RUNNING' | 'PAUSED' | 'EMERGENCY_STOP' | 'DRY_RUN';

export interface TelemetryData {
  discoveryLatencyMs: number[];
  quoteLatencyMs: number[];
  txBuildTimeMs: number[];
  txConfirmTimeMs: number[];
  rpcFailures: number;
  failedTransactions: number;
  successfulTransactions: number;
  totalSlippage: number;
  totalFees: number;
  totalPnl: number;
  winCount: number;
  lossCount: number;
  maxDrawdown: number;
}

export class BotState extends EventEmitter {
  status: BotStatus = 'STOPPED';
  dryRun = true;
  tradingEnabled = false;
  emergencyStop = false;
  startedAt: Date | null = null;

  tokens: Map<string, any> = new Map();
  // Normalized discovery metrics keyed by token mint
  discoveryMetrics: Map<string, any> = new Map();
  // Historical events journal for operator-facing alerts and audit
  events: Array<Record<string, any>> = [];
  private _eventCounter = 0;
  launches: any[] = [];
  positions: Map<string, any> = new Map();
  trades: any[] = [];
  balance: { sol: number; tokens: Map<string, number> } = { sol: 0, tokens: new Map() };

  telemetry: TelemetryData = {
    discoveryLatencyMs: [],
    quoteLatencyMs: [],
    txBuildTimeMs: [],
    txConfirmTimeMs: [],
    rpcFailures: 0,
    failedTransactions: 0,
    successfulTransactions: 0,
    totalSlippage: 0,
    totalFees: 0,
    totalPnl: 0,
    winCount: 0,
    lossCount: 0,
    maxDrawdown: 0,
  };

  start(): void {
    if (this.emergencyStop) return;
    this.status = this.dryRun ? 'DRY_RUN' : 'RUNNING';
    this.startedAt = new Date();
    this.emit('started');
  }

  pause(): void {
    this.status = 'PAUSED';
    this.emit('paused');
  }

  triggerEmergencyStop(): void {
    this.emergencyStop = true;
    this.tradingEnabled = false;
    this.status = 'EMERGENCY_STOP';
    this.emit('emergency_stop');
  }

  // Capture all emitted events into an in-memory journal for the
  // dashboard's /api/events endpoint. Keep the normal EventEmitter
  // semantics by delegating to super.emit as well.
  override emit(event: string | symbol, ...args: any[]): boolean {
    try {
      if (typeof event === 'string') {
        const payload = args[0] ?? {};
        const id = `${Date.now()}-${++this._eventCounter}`;
        const record: Record<string, any> = {
          id,
          timestamp: new Date().toISOString(),
          eventType: event,
          severity: payload?.severity ?? 'info',
          message: payload?.message ?? null,
          mint: payload?.mint ?? null,
          positionId: payload?.id ?? payload?.positionId ?? null,
          metadata: payload ?? {},
        };

        this.events.push(record);
        // Keep the journal bounded to avoid unbounded memory growth.
        if (this.events.length > 10_000) this.events.shift();
      }
    } catch {
      // ignore journalling errors
    }

    return super.emit(event, ...args);
  }

  recordTrade(trade: any): void {
    this.trades.push(trade);
    if (trade.pnl > 0) this.telemetry.winCount++;
    else if (trade.pnl < 0) this.telemetry.lossCount++;
    this.telemetry.totalPnl += trade.pnl || 0;
    this.telemetry.totalFees += trade.fees || 0;
  }
}