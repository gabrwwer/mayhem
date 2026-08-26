
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import {
  TradingConfig,
  Position,
  PositionUpdate,
  ExitCondition,
  PositionStore,
  SerializedPosition,
} from './types';
import { DecimalValue, parseAmount } from './calculations';

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

function decimalString(value: Decimal): DecimalValue {
  return value.toFixed();
}

function isPositiveDecimal(value: DecimalValue): boolean {
  try {
    return parseAmount(value).isFinite() && parseAmount(value).greaterThan(0);
  } catch {
    return false;
  }
}

function isNonNegativeDecimal(value: DecimalValue): boolean {
  try {
    return parseAmount(value).isFinite() && parseAmount(value).greaterThanOrEqualTo(0);
  } catch {
    return false;
  }
}

function decimalMax(a: DecimalValue, b: DecimalValue): DecimalValue {
  return decimalString(Decimal.max(parseAmount(a), parseAmount(b)));
}

function pctChangeDecimal(from: DecimalValue, to: DecimalValue): Decimal {
  const base = parseAmount(from);
  if (base.isZero()) return new Decimal(0);
  return parseAmount(to).minus(base).div(base).times(100);
}

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private config: TradingConfig;
  private store: PositionStore | undefined;
  private onPersistError: ((error: unknown) => void) | undefined;

  // Persistence is serialized so an older snapshot can never finish
  // after a newer snapshot and overwrite it.
  private persistQueue: Promise<void> = Promise.resolve();

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
   * Persist the open book in strict invocation order.
   *
   * IMPORTANT:
   * An exit can change an OPEN position to CLOSED between persistence
   * calls. Fire-and-forget writes can complete out of order and allow an
   * older OPEN snapshot to overwrite a newer CLOSED snapshot.
   *
   * Snapshots are captured synchronously, then writes are serialized.
   * A failed write is reported but does not break the queue, allowing
   * subsequent state changes to continue persisting.
   */
  private persist(): void {
    if (!this.store) return;

    const snapshot = this.getOpenPositions().map(serializePosition);

    this.persistQueue = this.persistQueue
      .catch(() => {
        // Keep the queue alive after a previous persistence failure.
      })
      .then(async () => {
        try {
          await this.store!.saveOpen(snapshot);
        } catch (error) {
          this.onPersistError?.(error);
        }
      });
  }

  /** Flush synchronously — call during graceful shutdown. */
  async flush(): Promise<void> {
    if (!this.store) return;
    await this.store.saveOpen(this.getOpenPositions().map(serializePosition));
  }

  openPosition(
    tokenMint: string,
    entryPrice: DecimalValue,
    quantity: DecimalValue,
    entryTx?: string,
    actualEntryPrice?: DecimalValue,
    entryFees?: DecimalValue,
    entryLiquidity?: DecimalValue,
  ): Position {
    if (!this.canOpenPosition()) {
      throw new Error(
        `Maximum open positions reached: ${this.config.maxOpenPositions}`,
      );
    }

    if (typeof tokenMint !== 'string' || tokenMint.trim().length === 0) {
      throw new Error('Invalid token mint');
    }

    if (!isPositiveDecimal(entryPrice)) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }

    if (!isPositiveDecimal(quantity)) {
      throw new Error(`Invalid quantity: ${quantity}`);
    }

    const qualifiedEntryPrice = entryPrice;
    const effectiveEntry = actualEntryPrice && isPositiveDecimal(actualEntryPrice)
      ? actualEntryPrice : entryPrice;
    const fees = entryFees ?? '0';
    if (!isNonNegativeDecimal(fees)) {
      throw new Error(`Invalid entry fees: ${fees}`);
    }
    if (
      entryLiquidity !== undefined &&
      !isNonNegativeDecimal(entryLiquidity)
    ) {
      throw new Error(`Invalid entry liquidity: ${entryLiquidity}`);
    }
    const notional = decimalString(
      parseAmount(effectiveEntry).times(parseAmount(quantity)).plus(parseAmount(fees)),
    );
    const stopLoss = decimalString(
      parseAmount(effectiveEntry).times(new Decimal(1).minus(new Decimal(this.config.stopLossPercent).div(100))),
    );
    const takeProfit = this.config.takeProfitPercent > 0
      ? decimalString(
        parseAmount(effectiveEntry).times(new Decimal(1).plus(new Decimal(this.config.takeProfitPercent).div(100))),
      )
      : '0';
    const now = Date.now();

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
      unrealizedPnl: '0',
      realizedPnl: '0',
      grossPnl: '0',
      netPnl: '0',
      netPnlPercent: '0',

      stopLoss,

      // Take-profit only applies if takeProfitPercent > 0 (0 = disabled).
      // To avoid positive values: set to Math.max(0, result).
      takeProfit,

      trailingStop: '0',

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
      entryLiquidity: entryLiquidity ?? '0',
      priceAsOf: now,
      takeProfitDeferredUntil: null,
      staleExitDeferredUntil: null,
      protectedFloorPrice: '0',
      profitManagementState: 'INITIAL_DEVELOPMENT',
      priceHistory: [{ ts: now, price: effectiveEntry }],
      peakPrice: effectiveEntry,
      troughPrice: effectiveEntry,
      mfePct: '0',
      maePct: '0',
      returns: {},
      holdDurationMs: 0,
    };

    this.positions.set(position.id, position);
    this.persist();
    return position;
  }

  updatePosition(
    id: string,
    currentPrice: DecimalValue,
  ): PositionUpdate {
    const position = this.positions.get(id);

    if (!position) {
      throw new Error(`Position ${id} not found`);
    }

    if (!isPositiveDecimal(currentPrice)) {
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
    if (!position.peakPrice || parseAmount(currentPrice).greaterThan(parseAmount(position.peakPrice))) {
      position.peakPrice = currentPrice;
    }
    if (!position.troughPrice || parseAmount(currentPrice).lessThan(parseAmount(position.troughPrice))) {
      position.troughPrice = currentPrice;
    }
    position.mfePct = position.peakPrice && position.actualEntryPrice
      ? decimalString(Decimal.max(0, pctChangeDecimal(position.actualEntryPrice, position.peakPrice)))
      : '0';
    position.maePct = position.troughPrice && position.actualEntryPrice
      ? decimalString(Decimal.max(0, pctChangeDecimal(position.troughPrice, position.actualEntryPrice)))
      : '0';

    const profitPercent = pctChangeDecimal(position.actualEntryPrice, currentPrice);

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

    const protectionActivationPercent = Math.max(
      25,
      Number.isFinite(this.config.profitLockActivationPercent)
        ? this.config.profitLockActivationPercent
        : 25,
    );
    const expectedExitCostPercent = Math.max(
      0,
      Number.isFinite(this.config.expectedExitCostPercent)
        ? this.config.expectedExitCostPercent!
        : 0,
    );

    if (profitPercent.plus(LOCK_EPSILON).greaterThanOrEqualTo(protectionActivationPercent)) {
      const principal = parseAmount(position.actualEntryPrice).times(parseAmount(position.quantity));
      const expectedExitCosts = principal.times(expectedExitCostPercent).div(100);
      const floor = principal.plus(parseAmount(position.entryFees)).plus(expectedExitCosts)
        .div(parseAmount(position.quantity));
      if (
        floor.isFinite() &&
        floor.greaterThan(parseAmount(position.protectedFloorPrice ?? '0'))
      ) {
        position.protectedFloorPrice = decimalString(floor);
      }
      position.profitManagementState =
        profitPercent.plus(LOCK_EPSILON).greaterThanOrEqualTo(50)
          ? 'TRAILING'
          : 'PROFIT_PROTECTION';
    } else {
      position.profitManagementState = 'INITIAL_DEVELOPMENT';
    }

    if (
      parseAmount(position.protectedFloorPrice ?? '0').isFinite() &&
      parseAmount(position.protectedFloorPrice ?? '0').greaterThan(parseAmount(position.stopLoss))
    ) {
      position.stopLoss = position.protectedFloorPrice!;
    }

    let selectedLock = 0;

    for (const level of LOCK_LADDER) {
      if (profitPercent.plus(LOCK_EPSILON).greaterThanOrEqualTo(level.activation)) {
        selectedLock = level.lock;
      }
    }

    if (selectedLock > position.highestLockPercent) {
      position.highestLockPercent = selectedLock;
    }

    if (position.highestLockPercent > 0) {
      position.profitLockActive = true;

      const lockedPrice = parseAmount(position.actualEntryPrice)
        .times(new Decimal(1).plus(new Decimal(position.highestLockPercent).div(100)));

      if (
        lockedPrice.isFinite() &&
        lockedPrice.greaterThan(parseAmount(position.stopLoss))
      ) {
        position.stopLoss = decimalString(lockedPrice);
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
      50,
      Number.isFinite(this.config.takeProfitPercent)
        ? this.config.takeProfitPercent
        : 50,
      Number.isFinite(this.config.trailingActivationPercent)
        ? this.config.trailingActivationPercent
        : 15,
    );

    const trailingActivated =
      profitPercent.plus(LOCK_EPSILON).greaterThanOrEqualTo(trailingActivationPercent);

    if (trailingActivated) {
      if (parseAmount(currentPrice).greaterThan(parseAmount(position.trailingStopHighPrice))) {
        position.trailingStopHighPrice = currentPrice;
      }

      const trailingMultiplier =
        1 - this.config.trailingStopPercent / 100;

      const newTrailingStop = parseAmount(position.trailingStopHighPrice).times(trailingMultiplier);

      if (
        newTrailingStop.isFinite() &&
        newTrailingStop.greaterThan(parseAmount(position.trailingStop))
      ) {
        position.trailingStop = decimalString(newTrailingStop);
      }

      if (
        parseAmount(position.trailingStop).isFinite() &&
        parseAmount(position.trailingStop).greaterThan(parseAmount(position.stopLoss))
      ) {
        position.stopLoss = position.trailingStop;
      }
    }

    if (
      parseAmount(position.protectedFloorPrice ?? '0').isFinite() &&
      parseAmount(position.protectedFloorPrice ?? '0').greaterThan(parseAmount(position.stopLoss))
    ) {
      position.stopLoss = position.protectedFloorPrice!;
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
      soldQuantity: DecimalValue;
      proceeds: DecimalValue;
      exitFees?: DecimalValue;
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

    if (!isPositiveDecimal(soldQuantity)) {
      throw new Error(`Invalid sold quantity: ${soldQuantity}`);
    }
    if (!isNonNegativeDecimal(proceeds)) {
      throw new Error(`Invalid proceeds: ${proceeds}`);
    }
    const sold = parseAmount(soldQuantity);
    const held = parseAmount(position.quantity);
    if (sold.greaterThan(held.times(new Decimal(1).plus('0.000000001')))) {
      throw new Error(
        `Fill quantity ${soldQuantity} exceeds position quantity ${position.quantity}`,
      );
    }

    const exitFees = fill.exitFees ?? '0';
    if (!isNonNegativeDecimal(exitFees)) {
      throw new Error(`Invalid exit fees: ${exitFees}`);
    }
    const realizedFraction = sold.div(held);

    // Cost basis attributable to the portion actually sold.
    const costBasisSold = parseAmount(position.entryNotional).times(realizedFraction);
    const realizedGross = parseAmount(proceeds).minus(costBasisSold).plus(parseAmount(position.entryFees).times(realizedFraction));
    const realizedNet = parseAmount(proceeds).minus(costBasisSold).minus(parseAmount(exitFees));

    const effectiveExitPrice = parseAmount(proceeds).div(sold);

    position.currentPrice = effectiveExitPrice.isFinite() && effectiveExitPrice.greaterThan(0)
      ? decimalString(effectiveExitPrice)
      : position.currentPrice;
    position.priceAsOf = Date.now();

    position.grossPnl = decimalString(parseAmount(position.grossPnl).plus(realizedGross));
    position.fees = decimalString(parseAmount(position.fees).plus(parseAmount(exitFees)));
    position.netPnl = decimalString(parseAmount(position.netPnl).plus(realizedNet));
    position.realizedPnl = position.netPnl;
    // Divide by the ORIGINAL cost basis, not the live one — the live value
    // shrinks with each partial exit and would inflate the reported return.
    position.netPnlPercent = parseAmount(position.originalEntryNotional).greaterThan(0)
      ? decimalString(parseAmount(position.netPnl).div(parseAmount(position.originalEntryNotional)).times(100))
      : '0';

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
        returns[`return_${ms / 1000}s`] = Number(
          pctChangeDecimal(position.actualEntryPrice, sample.price).toFixed(12),
        );
      } else {
        returns[`return_${ms / 1000}s`] = null;
      }
    }
    position.returns = returns;
    // Ensure final MFE/MAE reflect the lifetime values
    position.mfePct = position.mfePct ?? '0';
    position.maePct = position.maePct ?? '0';

    const residual = held.minus(sold);
    const fullyClosed = residual.lessThanOrEqualTo(held.times('0.000000001'));

    if (fullyClosed) {
      position.quantity = '0';
      position.unrealizedPnl = '0';
      position.exitReason = exitReason;
      position.status = 'closed';
    } else {
      // Partial fill: keep the remainder live so it is still monitored and
      // still has a stop-loss. Scale the remaining cost basis accordingly.
      position.quantity = decimalString(residual);
      position.entryNotional = decimalString(parseAmount(position.entryNotional).minus(costBasisSold));
      position.entryFees = decimalString(parseAmount(position.entryFees).times(new Decimal(1).minus(realizedFraction)));
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

  recordExitAttempt(id: string, error: string, quotePrice?: DecimalValue): void {
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

  /**
   * Defer take-profit re-evaluation until `until` (epoch millis).
   *
   * Safety rules:
   * - Never allow an invalid/past timestamp.
   * - Never defer TP for more than 60 seconds at a time.
   * - Persist the state so a restart cannot silently lose the lifecycle state.
   * - This only affects take-profit evaluation. Hard stop, stop-loss,
   *   trailing-stop, time-exit and stale-price exits remain independent.
   */
  deferTakeProfit(id: string, until: number): void {
    const position = this.positions.get(id);
    if (!position || position.status !== 'open') return;

    const now = Date.now();
    const requestedUntil = Number.isFinite(until) ? until : now;
    const maxDeferUntil = now + 60_000;

    position.takeProfitDeferredUntil = Math.min(
      Math.max(requestedUntil, now),
      maxDeferUntil,
    );

    this.persist();
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
    entry: DecimalValue,
    current: DecimalValue,
    quantity: DecimalValue,
  ): DecimalValue {
    return decimalString(parseAmount(current).minus(parseAmount(entry)).times(parseAmount(quantity)));
  }

  private checkTakeProfit(position: Position): ExitCondition {
    // TAKE_PROFIT_PERCENT is a profit-protection/trailing milestone, never a
    // liquidation trigger. Protection is represented by stop_loss/trailing_stop.
    return {
      type: 'take_profit',
      triggered:
        this.config.takeProfitPercent > 0 &&
        parseAmount(position.currentPrice).greaterThanOrEqualTo(parseAmount(position.takeProfit)),
      value: position.takeProfit,
    };
  }

  private checkStopLoss(position: Position): ExitCondition {
    return {
      type: 'stop_loss',
      triggered: parseAmount(position.currentPrice).lessThanOrEqualTo(parseAmount(position.stopLoss)),
      value: position.stopLoss,
    };
  }

  private checkTrailingStop(position: Position): ExitCondition {
    return {
      type: 'trailing_stop',
      triggered:
        parseAmount(position.trailingStop).greaterThan(0) &&
        parseAmount(position.currentPrice).lessThanOrEqualTo(parseAmount(position.trailingStop)),
      value: position.trailingStop,
    };
  }

  private checkTimeExit(position: Position): ExitCondition {
    // A profitable position is managed by the profit-lock/trailing state
    // machine. A wall-clock timeout must not liquidate a healthy winner.
    if (parseAmount(position.currentPrice).greaterThan(parseAmount(position.actualEntryPrice))) {
      return {
        type: 'time_exit',
        triggered: false,
        value: '0',
      };
    }

    const holdSeconds =
      (Date.now() - position.entryTime.getTime()) / 1000;

    return {
      type: 'time_exit',
      triggered: holdSeconds >= this.config.maxHoldSeconds,
      value: holdSeconds.toString(),
    };
  }

  private checkHardStop(position: Position): ExitCondition {
    const hard = Number.isFinite(this.config.hardStopLossPercent)
      ? this.config.hardStopLossPercent
      : 0;
    if (!hard || hard <= 0) {
      return { type: 'emergency', triggered: false, value: '0' };
    }

    const lossPercent = pctChangeDecimal(position.actualEntryPrice, position.currentPrice);
    return {
      type: 'emergency',
      triggered: lossPercent.lessThanOrEqualTo(-Math.abs(hard)),
      value: decimalString(lossPercent),
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
      raw.observationPrice ?? raw.signalPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? '0',
    signalPrice:
      raw.signalPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.observationPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? '0',
    qualifiedEntryPrice:
      raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.signalPrice ?? raw.observationPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? '0',
    entryPrice:
      raw.entryPrice ?? raw.qualifiedEntryPrice ?? raw.signalPrice ?? raw.observationPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? '0',
    actualEntryPrice:
      raw.actualEntryPrice ?? raw.executionPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.signalPrice ?? raw.observationPrice ?? '0',
    executionPrice:
      raw.executionPrice ?? raw.actualEntryPrice ?? raw.qualifiedEntryPrice ?? raw.entryPrice ?? raw.signalPrice ?? raw.observationPrice ?? '0',
    peakPrice:
      raw.peakPrice ?? raw.currentPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? raw.qualifiedEntryPrice ?? '0',
    troughPrice:
      raw.troughPrice ?? raw.currentPrice ?? raw.actualEntryPrice ?? raw.executionPrice ?? raw.qualifiedEntryPrice ?? '0',
    mfePct: raw.mfePct ?? '0',
    maePct: raw.maePct ?? '0',
    returns: raw.returns ?? {},
    holdDurationMs: raw.holdDurationMs ?? 0,
  };
}


