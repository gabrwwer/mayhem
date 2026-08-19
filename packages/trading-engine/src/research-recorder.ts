import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PriceLifecycleEvent,
  ResearchRecord,
  PerformanceMeasurement,
  MEASUREMENT_WINDOWS_MS,
  ResearchStatistics,
} from './research-metrics';

/**
 * Minimal logger that doesn't break on failures.
 * Research recording must never interfere with trading logic.
 */
const log = {
  info: (tag: string, data?: unknown) => {
    if (process.env['LOG_LEVEL'] !== 'silent') {
      console.log(`[${tag}]`, data);
    }
  },
  error: (tag: string, data?: unknown) => {
    if (process.env['LOG_LEVEL'] !== 'silent') {
      console.error(`[${tag}]`, data);
    }
  },
};

export interface ResearchRecorderOptions {
  filePath?: string;
  dryRun: boolean;
  tradingEnabled: boolean;
}

/**
 * Collects research data on token price lifecycles without affecting trading logic.
 *
 * Records:
 * 1. observation/signal/qualification/execution timestamps and prices
 * 2. post-entry price history
 * 3. performance measurements at each window from each lifecycle price
 *
 * Writes to JSON Lines format so data survives restarts and can be analyzed
 * independently of trading decisions.
 */
export class ResearchRecorder {
  private readonly filePath: string;
  private readonly dryRun: boolean;
  private readonly tradingEnabled: boolean;
  private readonly seenRecordKeys = new Set<string>();
  private written = 0;
  private failed = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastWriteError: Error | null = null;

  constructor(options: ResearchRecorderOptions) {
    this.filePath = path.resolve(options.filePath ?? path.join(process.cwd(), 'data', 'research.jsonl'));
    this.dryRun = options.dryRun;
    this.tradingEnabled = options.tradingEnabled;

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      log.info('RESEARCH_RECORDER_READY', {
        path: this.filePath,
        pathIsAbsolute: path.isAbsolute(this.filePath),
        cwd: process.cwd(),
        dryRun: this.dryRun,
        tradingEnabled: this.tradingEnabled,
        exists: fs.existsSync(this.filePath),
      });
    } catch (error) {
      this.failed = true;
      log.error('RESEARCH_RECORDER_INIT_FAILED', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Record a complete token lifecycle with post-entry performance metrics.
   *
   * Never throws; research failures must not interfere with trading.
   */
  recordLifecycle(
    tokenMint: string,
    lifecycle: PriceLifecycleEvent,
    positionOpened: boolean,
    positionId?: string,
    priceHistory?: Array<{ timestamp: number; price: number }>,
  ): void {
    if (this.failed) return;

    const history = priceHistory ?? [];
    const record = this.buildRecord(
      tokenMint,
      lifecycle,
      positionOpened,
      positionId,
      history,
    );

    const line = `${JSON.stringify(record)}\n`;
    this.enqueueWrite(line);
  }

  recordDiscovery(record: Record<string, unknown>): void {
    this.recordTypedEvent('DISCOVERY', record);
  }

  recordObservation(record: Record<string, unknown>): void {
    this.recordTypedEvent('OBSERVATION', record);
  }

  recordDecision(record: Record<string, unknown>): void {
    this.recordTypedEvent('DECISION', record);
  }

  recordOutcome(record: Record<string, unknown>): void {
    this.recordTypedEvent('OUTCOME', record);
  }

  recordExecution(record: Record<string, unknown>): void {
    this.recordTypedEvent('EXECUTION', record);
  }

  /**
   * Record a non-position research observation, such as discovery, execution, or momentum
   * sampling data. Missing values are kept as null and duplicate event IDs are
   * dropped to prevent repeated internal events from being written twice.
   */
  private recordTypedEvent(recordType: 'DISCOVERY' | 'OBSERVATION' | 'DECISION' | 'EXECUTION' | 'OUTCOME', record: Record<string, unknown>): void {
    if (this.failed) {
      log.info('RESEARCH_RECORD_ATTEMPT', {
        type: recordType,
        mint: record['tokenMint'] ?? record['mint'],
        failedPreviously: true,
      });
      return;
    }

    log.info('RESEARCH_RECORD_ATTEMPT', {
      type: recordType,
      mint: record['tokenMint'] ?? record['mint'],
      recordId: record['recordId'],
      filePath: this.filePath,
    });

    const normalized = this.normalizeJsonRecord({
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      recordType,
      ...(record['event'] ? { event: record['event'] } : {}),
      ...record,
    });

    try {
      this.validateResearchRecord(normalized as Record<string, unknown>);
    } catch (validationError) {
      log.error('RESEARCH_RECORD_VALIDATION_FAILED', {
        type: recordType,
        mint: record['tokenMint'] ?? record['mint'],
        error: validationError instanceof Error ? validationError.message : String(validationError),
      });
      return;
    }

    const identity = this.eventIdentity(normalized as Record<string, unknown>);
    if (identity && this.seenRecordKeys.has(identity)) {
      log.info('RESEARCH_RECORD_DEDUPLICATED', {
        type: recordType,
        mint: record['tokenMint'] ?? record['mint'],
        identity,
      });
      return;
    }
    if (identity) {
      this.seenRecordKeys.add(identity);
    }

    log.info('RESEARCH_WRITE_ENQUEUED', {
      type: recordType,
      mint: record['tokenMint'] ?? record['mint'],
      filePath: this.filePath,
      queuedWrites: this.written,
    });

    this.enqueueWrite(`${JSON.stringify(normalized)}\n`);
  }

  private eventIdentity(record: Record<string, unknown>): string | null {
    const mint = typeof record['mint'] === 'string' ? record['mint'] : typeof record['tokenMint'] === 'string' ? record['tokenMint'] : null;
    const event = typeof record['event'] === 'string' ? record['event'] : null;
    const signature = typeof record['signature'] === 'string'
      ? record['signature']
      : typeof record['txSignature'] === 'string'
        ? record['txSignature']
        : null;
    const type = typeof record['recordType'] === 'string' ? record['recordType'] : 'OBSERVATION';
    const ts = typeof record['timestamp'] === 'string' ? record['timestamp'] : typeof record['recordedAt'] === 'string' ? record['recordedAt'] : null;
    const recordId = typeof record['recordId'] === 'string' ? record['recordId'] : null;

    if (!type) return null;
    if (mint && event) return `${type}:${mint}:${event}`;
    if (mint && recordId) return `${type}:${mint}:${recordId}`;
    if (mint && signature) return `${type}:${mint}:${signature}`;
    if (mint && ts) return `${type}:${mint}:${ts}`;
    if (ts && signature) return `${type}:${ts}:${signature}`;
    return type === 'DISCOVERY' ? `${type}:${randomUUID()}` : null;
  }

  private enqueueWrite(line: string): void {
    const currentWrite = this.writeQueue.then(async () => {
      try {
        await fs.promises.appendFile(this.filePath, line, 'utf8');
        this.written += 1;
        log.info('RESEARCH_WRITE_SUCCESS', {
          path: this.filePath,
          totalWritten: this.written,
          lineSize: line.length,
        });
      } catch (error) {
        this.failed = true;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.lastWriteError = normalizedError;
        log.error('RESEARCH_WRITE_FAILED', {
          path: this.filePath,
          written: this.written,
          error: normalizedError.message,
          errorCode: (error as any)?.code,
          note: 'research recording disabled for the rest of this run',
        });
      }
    });

    this.writeQueue = currentWrite.catch(() => {
      // Keep the queue alive after a failure so later writes can continue.
      // The failure remains observable via lastWriteError and flush().
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;

    if (this.lastWriteError) {
      const error = this.lastWriteError;
      this.lastWriteError = null;
      throw error;
    }
  }

  private normalizeJsonRecord(value: unknown): unknown {
    if (value === undefined) {
      return null;
    }

    if (Array.isArray(value)) {
      throw new Error('Research records must not contain arrays.');
    }

    if (value !== null && typeof value === 'object') {
      const normalized: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const redactedKey = key.toLowerCase();
        if (
          redactedKey.includes('secret') ||
          redactedKey.includes('authorization') ||
          redactedKey.includes('api_key') ||
          redactedKey.includes('apikey') ||
          redactedKey.includes('private') ||
          redactedKey.includes('password') ||
          redactedKey.includes('seed') ||
          redactedKey.includes('mnemonic') ||
          redactedKey.includes('token') && !['tokenMint', 'tokenSymbol', 'tokenName', 'tokenMonitor'].includes(key)
        ) {
          normalized[key] = '[REDACTED]';
          continue;
        }
        normalized[key] = this.normalizeJsonRecord(entry);
      }
      return normalized;
    }

    return value;
  }

  private validateResearchRecord(record: Record<string, unknown>): void {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Research record must be a JSON object.');
    }

    if (record['schemaVersion'] !== 1) {
      throw new Error('Research record schemaVersion must be 1.');
    }

    const type = record['recordType'];
    if (typeof type !== 'string' || !['DISCOVERY', 'OBSERVATION', 'DECISION', 'EXECUTION', 'OUTCOME'].includes(type)) {
      throw new Error(`Research recordType must be one of DISCOVERY, OBSERVATION, DECISION, EXECUTION, OUTCOME: ${String(type)}`);
    }

    if (typeof record['recordedAt'] !== 'string' || Number.isNaN(Date.parse(record['recordedAt'] as string))) {
      throw new Error('Research record recordedAt must be a valid ISO timestamp.');
    }

    const mint = typeof record['mint'] === 'string' ? record['mint'] : typeof record['tokenMint'] === 'string' ? record['tokenMint'] : null;
    if (!mint && type !== 'OUTCOME') {
      throw new Error('Research record requires a mint or tokenMint.');
    }
  }

  private buildRecord(
    tokenMint: string,
    lifecycle: PriceLifecycleEvent,
    positionOpened: boolean,
    positionId: string | undefined,
    priceHistory: Array<{ timestamp: number; price: number }>,
  ): ResearchRecord {
    const performanceFromObservation = this.calculatePerformance(
      lifecycle.observationPrice,
      lifecycle.observationTime,
      priceHistory,
    );
    const performanceFromSignal = this.calculatePerformance(
      lifecycle.signalPrice,
      lifecycle.signalTime,
      priceHistory,
    );
    const performanceFromQualified = this.calculatePerformance(
      lifecycle.qualifiedEntryPrice,
      lifecycle.qualificationTime,
      priceHistory,
    );
    const performanceFromExecution = lifecycle.executionTime
      ? this.calculatePerformance(
          lifecycle.executionPrice ?? lifecycle.qualifiedEntryPrice,
          lifecycle.executionTime,
          priceHistory,
        )
      : {};

    const slippageBps =
      lifecycle.executionPrice && lifecycle.qualifiedEntryPrice
        ? ((lifecycle.executionPrice - lifecycle.qualifiedEntryPrice) /
            lifecycle.qualifiedEntryPrice) *
          10000
        : undefined;

    const record: ResearchRecord = {
      recordId: randomUUID(),
      tokenMint,
      recordedAt: new Date().toISOString(),
      lifecycle,
      positionOpened,
      positionId: positionId ?? undefined,
      priceHistory,
      performanceFromObservationPrice: performanceFromObservation,
      performanceFromSignalPrice: performanceFromSignal,
      performanceFromQualifiedEntryPrice: performanceFromQualified,
      performanceFromExecutionPrice: Object.keys(performanceFromExecution).length > 0 ? performanceFromExecution : undefined,
      slippageBps: slippageBps ?? undefined,
      slippagePercent: slippageBps ? slippageBps / 100 : undefined,
      config: {
        dryRun: this.dryRun,
        tradingEnabled: this.tradingEnabled,
      },
    };

    return record;
  }

  private calculatePerformance(
    referencePrice: number,
    referenceTime: number,
    priceHistory: Array<{ timestamp: number; price: number }>,
  ): Record<string, PerformanceMeasurement> {
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      return {};
    }

    const measurements: Record<string, PerformanceMeasurement> = {};

    for (const windowMs of MEASUREMENT_WINDOWS_MS) {
      const windowEnd = referenceTime + windowMs;
      const windowPrices = priceHistory.filter(
        (p) => p.timestamp >= referenceTime && p.timestamp <= windowEnd,
      );

      if (windowPrices.length === 0) {
        continue; // Not enough data for this window
      }

      const lastPrice = windowPrices[windowPrices.length - 1];
      if (!lastPrice) continue;

      const finalPrice = lastPrice.price;
      const maxPrice = Math.max(...windowPrices.map((p) => p.price));
      const minPrice = Math.min(...windowPrices.map((p) => p.price));

      const returnPercent =
        ((finalPrice - referencePrice) / referencePrice) * 100;
      const mfePercent = ((maxPrice - referencePrice) / referencePrice) * 100;
      const maePercent = ((referencePrice - minPrice) / referencePrice) * 100;
      const maxDrawdownPercent =
        ((maxPrice - minPrice) / maxPrice) * 100;

      const timeToPercent = (targetPercent: number): number | null => {
        const targetPrice = referencePrice * (1 + targetPercent / 100);
        const crossing = windowPrices.find((p) => p.price >= targetPrice);
        if (crossing) {
          return crossing.timestamp - referenceTime;
        }
        return null;
      };

      const timeToNegativePercent = (targetPercent: number): number | null => {
        const targetPrice = referencePrice * (1 - targetPercent / 100);
        const crossing = windowPrices.find((p) => p.price <= targetPrice);
        if (crossing) {
          return crossing.timestamp - referenceTime;
        }
        return null;
      };

      const measurement: PerformanceMeasurement = {
        windowMs,
        measurementTime: windowEnd,
        price: finalPrice,
        returnPercent,
        mfePercent,
        maePercent,
        maxDrawdownPercent,
        timeToPlus5Percent: timeToPercent(5),
        timeToPlus10Percent: timeToPercent(10),
        timeToPlus25Percent: timeToPercent(25),
        timeToPlus50Percent: timeToPercent(50),
        timeToMinus5Percent: timeToNegativePercent(5),
        timeToMinus10Percent: timeToNegativePercent(10),
        timeToMinus20Percent: timeToNegativePercent(20),
      };

      measurements[`window_${windowMs}ms`] = measurement;
    }

    return measurements;
  }

  getWrittenCount(): number {
    return this.written;
  }
}
