
import { randomUUID } from 'crypto';
import {
  TradingConfig,
  Position,
  PositionUpdate,
  ExitCondition,
  PositionStore,
  SerializedPosition,
} from './types';

const LOCK_EPSILON = 1e-9;

const LOCK_LADDER: ReadonlyArray<{ activation: number; lock: number }> = [
  { activation: 15, lock: 10 },
  { activation: 20, lock: 15 },
  { activation: 25, lock: 20 },
  { activation: 35, lock: 27 },
  { activation: 50, lock: 40 },
  { activation: 75, lock: 60 },
  { activation: 100, lock: 80 },
];

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private config: TradingConfig;
  private store: PositionStore | undefined;
  private onPersistError: ((error: unknown) => void) | undefined;

  constructor(
    config: TradingConfig,
    store?: PositionStore,
    onPersistError?: (error: unknown) => void,
  ) {
    this.config = config;
    this.store = store;
    this.onPersistError = onPersistError;
  }

  /**
   * Rehydrate open positions at boot.
   *
   * Must be awaited before the engine starts monitoring, otherwise the
   * first monitor tick sees an empty book and the process happily opens
   * new positions on top of holdings it has forgotten about.
   */
  async restore(): Promise<{ restored: number }> {
    if (!this.store) return { restored: 0 };

    const persisted = await this.store.loadOpen();
    for (const raw of persisted) {
      const position = deserializePosition(raw);
      this.positions.set(position.id, position);
    }
    return { restored: persisted.length };
  }

  /**
   * Persist the open book. Fire-and-forget by design: a storage failure
   * must not block an exit. The error hook exists so the caller can alert —
   * silently swallowing it would recreate the "state vanished on restart"
   * bug with extra steps.
   */
  private persist(): void {
    if (!this.store) return;

    const snapshot = this.getOpenPositions().map(serializePosition);
    void this.store.saveOpen(snapshot).catch((error) => {
      this.onPersistError?.(error);
    });
  }

  /** Flush synchronously — call during graceful shutdown. */
  async flush(): Promise<void> {
    if (!this.store) return;
    await this.store.saveOpen(this.getOpenPositions().map(serializePosition));
  }

  openPosition(
    tokenMint: string,
    entryPrice: number,
    quantity: number,
    entryTx?: string,
    actualEntryPrice?: number,
    entryFees?: number,
    entryLiquidity?: number,
  ): Position {
    if (!this.canOpenPosition()) {
      throw new Error(
        `Maximum open positions reached: ${this.config.maxOpenPositions}`,
      );
    }

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid quantity: ${quantity}`);
    }

    const qualifiedEntryPrice = entryPrice;
    const effectiveEntry = actualEntryPrice && actualEntryPrice > 0
      ? actualEntryPrice : entryPrice;
    const fees = entryFees ?? 0;
    const notional = effectiveEntry * quantity + fees;

    const position: Position = {
      id: randomUUID(),
      tokenMint,
      observationPrice: qualifiedEntryPrice,
      signalPrice: qualifiedEntryPrice,
      qualifiedEntryPrice,
      entryPrice: qualifiedEntryPrice,
      actualEntryPrice: effectiveEntry,
      executionPrice: effectiveEntry,
      entryTime: new Date(),
      quantity,
      entryNotional: notional,
      originalEntryNotional: notional,
      entryFees: fees,
      entryTx: entryTx ?? null,
      currentPrice: effectiveEntry,
      unrealizedPnl: 0,
      realizedPnl: 0,
      grossPnl: 0,
      netPnl: 0,
      netPnlPercent: 0,

      stopLoss:
        effectiveEntry * (1 - this.config.stopLossPercent / 100),

      // Take-profit only applies if takeProfitPercent > 0 (0 = disabled).
      // To avoid positive values: set to Math.max(0, result).
      takeProfit:
        this.config.takeProfitPercent > 0
          ? effectiveEntry * (1 + this.config.takeProfitPercent / 100)
          : Infinity, // Disabled: can never reach Infinity

      trailingStop: 0,

      trailingStopHighPrice: effectiveEntry,

      profitLockActive: false,
      highestLockPercent: 0,
      aggressiveTrailingActive: false,

      exitReason: null,
      exitTx: null,
      fees,
      slippage: 0,
      status: 'open',

      exitAttemptCount: 0,
      lastExitAttemptAt: null,
      lastExitError: null,
      lastExitQuotePrice: null,
      entryLiquidity: entryLiquidity ?? 0,
      priceAsOf: Date.now(),
      takeProfitDeferredUntil: null,
      staleExitDeferredUntil: null,
      priceHistory: [{ ts: Date.now(), price: effectiveEntry }],
      peakPrice: effectiveEntry,
      troughPrice: effectiveEntry,
      mfePct: 0,
      maePct: 0,
      returns: {},
      holdDurationMs: 0,
    };

    this.positions.set(position.id, position);
    this.persist();
    return position;
  }

  updatePosition(
    id: string,
    currentPrice: number,
  ): PositionUpdate {
    const position = this.positions.get(id);

    if (!position) {
      throw new Error(`Position ${id} not found`);
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      throw new Error(`Invalid current price: ${currentPrice}`);
    }

    if (position.status !== 'open') {
      return {
        positionId: id,
        currentPrice: position.currentPrice,
        unrealizedPnl: position.unrealizedPnl,
        exitConditions: [],
      };
    }

    position.currentPrice = currentPrice;
    position.priceAsOf = Date.now();
    // A successful refresh means the feed recovered; drop the stale-exit
    // back-off so a genuine future staleness is acted on immediately.
    position.staleExitDeferredUntil = null;

    position.unrealizedPnl = this.calculatePnl(
      position.actualEntryPrice,
      currentPrice,
      position.quantity,
    );

    // Append to price history for MFE/MAE and return snapshots. Keep a modest
    // cap to avoid unbounded growth in long-running processes.
    const now = Date.now();
    if (!position.priceHistory) position.priceHistory = [];
    position.priceHistory.push({ ts: now, price: currentPrice });
    if (position.priceHistory.length > 600) {
      // keep last ~10 minutes at 1s cadence
      position.priceHistory.shift();
    }

    // Update peak/trough and MFE/MAE
    if (!position.peakPrice || currentPrice > position.peakPrice) {
      position.peakPrice = currentPrice;
    }
    if (!position.troughPrice || currentPrice < position.troughPrice) {
      position.troughPrice = currentPrice;
    }
    position.mfePct = position.peakPrice && position.actualEntryPrice
      ? Math.max(0, ((position.peakPrice - position.actualEntryPrice) / position.actualEntryPrice) * 100)
      : 0;
    position.maePct = position.troughPrice && position.actualEntryPrice
      ? Math.max(0, ((position.actualEntryPrice - position.troughPrice) / position.actualEntryPrice) * 100)
      : 0;

    const profitPercent =
      ((currentPrice - position.actualEntryPrice) /
        position.actualEntryPrice) * 100;

    /*
     * ============================================================
     * MAYHEM LOCK LADDER V4
     * ============================================================
     *
     * Progressive profit protection based on ACTUAL EXECUTED
     * ENTRY PRICE.
     *
     * Activation       Locked Profit
     * --------------------------------
     * +15%             +10%
     * +20%             +15%
     * +25%             +20%
     * +35%             +27%
     * +50%             +40%
     * +75%             +60%
     * +100%            +80%
     *
     * Rules:
     *
     * 1. The initial stop loss remains untouched before +15%.
     * 2. The ladder activates at +15%.
     * 3. Ladder locks are calculated from actualEntryPrice.
     * 4. A higher ladder level replaces a lower level.
     * 5. stopLoss can NEVER move downward.
     * 6. A pullback can NEVER loosen an established lock.
     * 7. Trailing cannot override or lower a ladder lock.
     *
     * ============================================================
     */

    let selectedLock = 0;

    for (const level of LOCK_LADDER) {
      if (profitPercent + LOCK_EPSILON >= level.activation) {
        selectedLock = level.lock;
      }
    }

    if (selectedLock > position.highestLockPercent) {
      position.highestLockPercent = selectedLock;
    }

    if (position.highestLockPercent > 0) {
      position.profitLockActive = true;

      const lockedPrice =
        position.actualEntryPrice *
        (1 + position.highestLockPercent / 100);

      if (
        Number.isFinite(lockedPrice) &&
        lockedPrice > position.stopLoss
      ) {
        position.stopLoss = lockedPrice;
      }
    }

    /*
     * TRAILING STOP
     *
     * Trailing cannot activate before +15%, preventing it from
     * defeating the ladder. Once the ladder has established a lock,
     * trailing can only raise stopLoss above the ladder lock, never
     * lower it.
     */

    const trailingActivationPercent = Math.max(
      15,
      Number.isFinite(this.config.trailingActivationPercent)
        ? this.config.trailingActivationPercent
        : 15,
    );

    const trailingActivated =
      profitPercent + LOCK_EPSILON >= trailingActivationPercent;

    if (trailingActivated) {
      if (currentPrice > position.trailingStopHighPrice) {
        position.trailingStopHighPrice = currentPrice;
      }

      const trailingMultiplier =
        1 - this.config.trailingStopPercent / 100;

      const newTrailingStop =
        position.trailingStopHighPrice * trailingMultiplier;

      if (
        Number.isFinite(newTrailingStop) &&
        newTrailingStop > position.trailingStop
      ) {
        position.trailingStop = newTrailingStop;
      }

      if (
        Number.isFinite(position.trailingStop) &&
        position.trailingStop > position.stopLoss
      ) {
        position.stopLoss = position.trailingStop;
      }
    }

    const exitConditions = this.buildExitConditions(position);

    return {
      positionId: id,
      currentPrice,
      unrealizedPnl: position.unrealizedPnl,
      exitConditions,
    };
  }

  /**
   * Evaluate exit conditions against the LAST KNOWN price, without
   * refreshing it.
   *
   * Used when a price fetch failed but the cached price is still within
   * tolerance: the stop-loss must still be checked, but `priceAsOf` must
   * NOT advance — otherwise a permanently dead feed would look perpetually
   * fresh and the staleness force-exit would never fire.
   */
  evaluateExitConditions(id: string): ExitCondition[] {
    const position = this.positions.get(id);
    if (!position || position.status !== 'open') return [];
    return this.buildExitConditions(position);
  }

  private buildExitConditions(position: Position): ExitCondition[] {
    const conditions: ExitCondition[] = [
      this.checkHardStop(position),
      this.checkStopLoss(position),
      this.checkTrailingStop(position),
      this.checkTimeExit(position),
      this.checkTakeProfit(position),
    ];

    return conditions;
  }

  /**
   * Close a position from an ACTUAL fill.
   *
   * `soldQuantity` and `proceeds` come from the executed transaction, not
   * from the pre-trade quote. Booking realised P&L off a quote (the previous
   * behaviour) corrupts the number the circuit breaker, the dry-run tracker
   * and the dashboard all consume — and the quote-vs-fill gap is widest
   * exactly during the volatility that triggers the exit.
   *
   * A partial fill leaves the position OPEN with the residual quantity, and
   * realises P&L only on the portion actually sold. Marking a partially
   * filled position `closed` is how tokens get silently abandoned on-chain.
   */
  closePosition(
    id: string,
    fill: {
      soldQuantity: number;
      proceeds: number;
      exitFees?: number;
      exitTx?: string;
    },
    exitReason: string,
  ): Position {
    const position = this.positions.get(id);

    if (!position) {
      throw new Error(`Position ${id} not found`);
    }

    if (position.status === 'closed') {
      return position;
    }

    const { soldQuantity, proceeds } = fill;

    if (!Number.isFinite(soldQuantity) || soldQuantity <= 0) {
      throw new Error(`Invalid sold quantity: ${soldQuantity}`);
    }
    if (!Number.isFinite(proceeds) || proceeds < 0) {
      throw new Error(`Invalid proceeds: ${proceeds}`);
    }
    if (soldQuantity > position.quantity * (1 + 1e-9)) {
      throw new Error(
        `Fill quantity ${soldQuantity} exceeds position quantity ${position.quantity}`,
      );
    }

    const exitFees = fill.exitFees ?? 0;
    const realizedFraction = soldQuantity / position.quantity;

    // Cost basis attributable to the portion actually sold.
    const costBasisSold = position.entryNotional * realizedFraction;
    const realizedGross = proceeds - costBasisSold + position.entryFees * realizedFraction;
    const realizedNet = proceeds - costBasisSold - exitFees;

    const effectiveExitPrice = proceeds / soldQuantity;

    position.currentPrice = Number.isFinite(effectiveExitPrice) && effectiveExitPrice > 0
      ? effectiveExitPrice
      : position.currentPrice;
    position.priceAsOf = Date.now();

    position.grossPnl += realizedGross;
    position.fees += exitFees;
    position.netPnl += realizedNet;
    position.realizedPnl = position.netPnl;
    // Divide by the ORIGINAL cost basis, not the live one — the live value
    // shrinks with each partial exit and would inflate the reported return.
    position.netPnlPercent = position.originalEntryNotional > 0
      ? (position.netPnl / position.originalEntryNotional) * 100
      : 0;

    position.exitTx = fill.exitTx ?? position.exitTx;

    // Compute hold duration and return snapshots (1s,3s,5s,10s,30s,60s,5m)
    const now = Date.now();
    position.holdDurationMs = now - position.entryTime.getTime();
    const intervals = [1, 3, 5, 10, 30, 60, 300].map((s) => s * 1000);
    const returns: Record<string, number | null> = {};
    const history = position.priceHistory ?? [];
    for (const ms of intervals) {
      const target = position.entryTime.getTime() + ms;
      // find the first sample at or after target
      const sample = history.find((h) => h.ts >= target) || null;
      if (sample) {
        returns[`return_${ms / 1000}s`] = ((sample.price - position.actualEntryPrice) / position.actualEntryPrice) * 100;
      } else {
        returns[`return_${ms / 1000}s`] = null;
      }
    }
    position.returns = returns;
    // Ensure final MFE/MAE reflect the lifetime values
    position.mfePct = position.mfePct ?? 0;
    position.maePct = position.maePct ?? 0;

    const residual = position.quantity - soldQuantity;
    const fullyClosed = residual <= position.quantity * 1e-9;

    if (fullyClosed) {
      position.quantity = 0;
      position.unrealizedPnl = 0;
      position.exitReason = exitReason;
      position.status = 'closed';
    } else {
      // Partial fill: keep the remainder live so it is still monitored and
      // still has a stop-loss. Scale the remaining cost basis accordingly.
      position.quantity = residual;
      position.entryNotional -= costBasisSold;
      position.entryFees *= 1 - realizedFraction;
      position.exitReason = `${exitReason}:partial`;
      position.status = 'open';
      position.unrealizedPnl = this.calculatePnl(
        position.actualEntryPrice,
        position.currentPrice,
        position.quantity,
      );
    }

    this.persist();
    return position;
  }

  recordExitAttempt(id: string, error: string, quotePrice?: number): void {
    const position = this.positions.get(id);
    if (!position) return;

    position.exitAttemptCount++;
    position.lastExitAttemptAt = new Date();
    position.lastExitError = error;
    if (quotePrice !== undefined) {
      position.lastExitQuotePrice = quotePrice;
    }
  }

  markExiting(id: string): boolean {
    const position = this.positions.get(id);
    if (!position || position.status !== 'open') return false;
    position.status = 'exiting';
    this.persist();
    return true;
  }

  releaseExiting(id: string): void {
    const position = this.positions.get(id);
    if (position && position.status === 'exiting') {
      position.status = 'open';
      this.persist();
    }
  }

  /** Defer take-profit re-evaluation until `until` (epoch millis). */
  deferTakeProfit(id: string, until: number): void {
    const position = this.positions.get(id);
    if (position) position.takeProfitDeferredUntil = until;
  }

  /** Defer the next stale-price force-exit attempt until `until`. */
  deferStaleExit(id: string, until: number): void {
    const position = this.positions.get(id);
    if (position) position.staleExitDeferredUntil = until;
  }

  /** True when the last known price is older than `maxAgeMs`. */
  isPriceStale(id: string, maxAgeMs: number, now = Date.now()): boolean {
    const position = this.positions.get(id);
    if (!position) return true;
    return now - position.priceAsOf > maxAgeMs;
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === 'open' || p.status === 'exiting',
    );
  }

  canOpenPosition(): boolean {
    return (
      this.getOpenPositions().length < this.config.maxOpenPositions
    );
  }

  calculatePnl(
    entry: number,
    current: number,
    quantity: number,
  ): number {
    return (current - entry) * quantity;
  }

  private checkTakeProfit(position: Position): ExitCondition {
    // Only trigger take-profit if explicitly configured with positive threshold
    // and current price has crossed the target. takeProfitPercent=0 means disabled.
    const isEnabled = this.config.takeProfitPercent > 0;
    return {
      type: 'take_profit',
      triggered: isEnabled && position.currentPrice >= position.takeProfit,
      value: position.takeProfit,
    };
  }

  private checkStopLoss(position: Position): ExitCondition {
    return {
      type: 'stop_loss',
      triggered: position.currentPrice <= position.stopLoss,
      value: position.stopLoss,
    };
  }

  private checkTrailingStop(position: Position): ExitCondition {
    return {
      type: 'trailing_stop',
      triggered:
        position.trailingStop > 0 &&
        position.currentPrice <= position.trailingStop,
      value: position.trailingStop,
    };
  }

  private checkTimeExit(position: Position): ExitCondition {
    const holdSeconds =
      (Date.now() - position.entryTime.getTime()) / 1000;

    return {
      type: 'time_exit',
      triggered: holdSeconds >= this.config.maxHoldSeconds,
      value: holdSeconds,
    };
  }

  private checkHardStop(position: Position): ExitCondition {
    const hard = Number.isFinite(this.config.hardStopLossPercent)
      ? this.config.hardStopLossPercent
      : 0;
    if (!hard || hard <= 0) {
      return { type: 'emergency', triggered: false, value: 0 };
    }

    const lossPercent = ((position.currentPrice - position.actualEntryPrice) / position.actualEntryPrice) * 100;
    return {
      type: 'emergency',
      triggered: lossPercent <= -Math.abs(hard),
      value: lossPercent,
    };
  }
}

export function serializePosition(position: Position): SerializedPosition {
  return {
    ...position,
    entryTime: position.entryTime.getTime(),
    lastExitAttemptAt: position.lastExitAttemptAt
      ? position.lastExitAttemptAt.getTime()
      : null,
  };
}

export function deserializePosition(raw: SerializedPosition): Position {
  return {
    ...raw,
    entryTime: new Date(raw.entryTime),
    lastExitAttemptAt:
      raw.lastExitAttemptAt === null ? null : new Date(raw.lastExitAttemptAt),
    // A restored position's price is by definition from before the restart.
    // Marking it fresh would let a stop-loss evaluate against a price from
    // an arbitrary time in the past; force a refresh instead.
    priceAsOf: 0,
    // Never inherit an exiting state across a restart — the in-flight exit
    // it referred to is gone. Re-derive it from the next monitor tick.
    status: raw.status === 'exiting' ? 'open' : raw.status,
    takeProfitDeferredUntil: null,
    staleExitDeferredUntil: null,
    // Preserve analytics fields where present in persistence. Provide
    // safe defaults so restored positions satisfy strict typing.
    priceHistory: raw.priceHistory ?? [],
    observationPrice:
      raw.observationPrice ?? raw.signalPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? 0,
    signalPrice:
      raw.signalPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.observationPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? 0,
    qualifiedEntryPrice:
      raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.signalPrice ?? raw.observationPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? 0,
    entryPrice:
      raw.entryPrice ?? raw.qualifiedEntryPrice ?? raw.signalPrice ?? raw.observationPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? 0,
    actualEntryPrice:
      raw.actualEntryPrice ?? raw.executionPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.signalPrice ?? raw.observationPrice ?? 0,
    executionPrice:
      raw.executionPrice ?? raw.actualEntryPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.signalPrice ?? raw.observationPrice ?? 0,
    peakPrice:
      raw.peakPrice ?? raw.currentPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? raw.qualifiedEntryPrice ?? 0,
    troughPrice:
      raw.troughPrice ?? raw.currentPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? raw.qualifiedEntryPrice ?? 0,
    mfePct: raw.mfePct ?? 0,
    maePct: raw.maePct ?? 0,
    returns: raw.returns ?? {},
    holdDurationMs: raw.holdDurationMs ?? 0,
  };
}