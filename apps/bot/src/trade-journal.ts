import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';

/**
 * Durable record of every closed paper trade.
 *
 * WHY THIS EXISTS
 * ---------------
 * `DryRunTracker` keeps trades in memory and prints running totals, which
 * vanish on restart. That is enough to watch a session and nowhere near
 * enough to answer the only question that matters: does this configuration
 * have positive expectancy?
 *
 * Answering that needs (a) trades that survive restarts, and (b) the
 * settings that produced them, recorded alongside. Without the settings, a
 * journal spanning several tuning rounds is uninterpretable — you cannot
 * tell which trades came from which configuration.
 *
 * Format is JSON Lines: one self-contained JSON object per line, appended
 * atomically. Survives a crash mid-write (you lose at most the last line),
 * needs no schema migration, and is trivially readable by any tool.
 */

export interface TradeRecord {
  /** Groups every trade from one bot process. */
  runId: string;
  recordedAt: string;

  positionId: string;
  tokenMint: string;

  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryNotionalSol: number;

  grossPnlSol: number;
  netPnlSol: number;
  netPnlPercent: number;
  feesSol: number;

  exitReason: string;
  holdSeconds: number;

  /** Observed pool/curve liquidity at entry, when known. */
  entryLiquiditySol: number;

  /**
   * The settings that produced this trade.
   *
   * Denormalised onto every record on purpose. A journal is appended across
   * many runs with different settings; carrying them per-trade means any
   * analysis can group by configuration without a second file to join to.
   */
  config: TradeConfigSnapshot;
}

export interface TradeConfigSnapshot {
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  maxHoldSeconds: number;
  slippageBps: number;
  maxPositionSol: number;
  maxOpenPositions: number;
  minRiskScore: number;
  momentumConfirmEnabled: boolean;
  minMomentumChangePct: number;
  /*
   * Entry-signal thresholds (STRATEGY.md §3.4).
   *
   * These are denormalised onto every trade record deliberately. The promotion
   * gate in §7.2 requires a sample in which no parameter changed; that can only
   * be verified after the fact if each trade carries the settings that produced
   * it. A journal that records outcomes without settings cannot distinguish one
   * hundred-trade sample from twelve unrelated ones.
   */
  minBuyPressure: number;
  maxMomentumVolatility: number;
  maxMomentumDrawdownPct: number;
  minMomentumSamples: number;
  momentumWindowMs: number;
  momentumIntervalMs: number;
  minLiquiditySol: number;
}

const DEFAULT_JOURNAL = 'data/trades.jsonl';

export class TradeJournal {
  private readonly filePath: string;
  private readonly runId: string;
  private readonly config: TradeConfigSnapshot;
  private written = 0;
  private failed = false;

  constructor(config: TradeConfigSnapshot, filePath = DEFAULT_JOURNAL) {
    this.config = config;
    this.runId = randomUUID();
    this.filePath = path.resolve(filePath);

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (error) {
      this.failed = true;
      logger.error('TRADE_JOURNAL_INIT_FAILED', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    logger.info('TRADE_JOURNAL_READY', {
      path: this.filePath,
      runId: this.runId,
      config,
    });
  }

  getRunId(): string {
    return this.runId;
  }

  /**
   * Append one closed trade.
   *
   * Never throws: a journalling failure must not interfere with trading.
   * It is logged once rather than on every trade, so a full disk does not
   * itself flood the log.
   */
  record(position: {
    id: string;
    tokenMint: string;
    actualEntryPrice: number;
    entryPrice: number;
    currentPrice: number;
    quantity: number;
    originalEntryNotional?: number;
    entryNotional: number;
    grossPnl: number;
    netPnl: number;
    netPnlPercent: number;
    fees: number;
    exitReason: string | null;
    entryTime: Date | string;
    entryLiquidity?: number;
  }): void {
    if (this.failed) return;

    const entryTimeMs =
      position.entryTime instanceof Date
        ? position.entryTime.getTime()
        : new Date(position.entryTime).getTime();

    const record: TradeRecord = {
      runId: this.runId,
      recordedAt: new Date().toISOString(),
      positionId: position.id,
      tokenMint: position.tokenMint,
      entryPrice: position.actualEntryPrice ?? position.entryPrice,
      exitPrice: position.currentPrice,
      quantity: position.quantity,
      entryNotionalSol:
        position.originalEntryNotional ?? position.entryNotional,
      grossPnlSol: position.grossPnl,
      netPnlSol: position.netPnl,
      netPnlPercent: position.netPnlPercent,
      feesSol: position.fees,
      exitReason: position.exitReason ?? 'unknown',
      holdSeconds: Number.isFinite(entryTimeMs)
        ? (Date.now() - entryTimeMs) / 1000
        : 0,
      entryLiquiditySol: position.entryLiquidity ?? 0,
      config: this.config,
    };

    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
      });
      this.written += 1;
    } catch (error) {
      this.failed = true;
      logger.error('TRADE_JOURNAL_WRITE_FAILED', {
        path: this.filePath,
        written: this.written,
        error: error instanceof Error ? error.message : String(error),
        note: 'journalling disabled for the rest of this run; trading continues',
      });
    }
  }

  getWrittenCount(): number {
    return this.written;
  }
}
