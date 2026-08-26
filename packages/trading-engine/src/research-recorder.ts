import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PriceLifecycleEvent,
  ResearchRecord,
  EnhancedResearchRecord,
  PerformanceMeasurement,
  MEASUREMENT_WINDOWS_MS,
  PassingCandidateSnapshot,
  ForwardObservation,
  PassingCandidateOutcome,
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

/**
 * Options for configuring the research recorder.
 */
export interface ResearchRecorderOptions {
  filePath?: string;
  dryRun: boolean;
  tradingEnabled: boolean;
}

/**
 * Collects comprehensive research data on token lifecycle and tokenomics.
 *
 * Records:
 * 1. Complete token discovery and identity data
 * 2. Continuous observation data (price, volume, flow, liquidity, holders, etc.)
 * 3. Decision points with comprehensive scoring
 * 4. Simulated execution data with detailed fee/impact analysis
 * 5. Complete lifecycle with position simulation and outcome data
 * 6. Specialized events: LP initialization, liquidity events, momentum events,
 *    graduation, metadata updates, staleness events
 * 7. Research-specific simulations: position, take-profit, stop-loss, liquidity/risk
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
   * Enhanced to work with both legacy ResearchRecord and EnhancedResearchRecord formats.
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
    const record = this.buildLegacyRecord(
      tokenMint,
      lifecycle,
      positionOpened,
      positionId,
      history,
    );

    const line = `${JSON.stringify(record)}\n`;
    this.enqueueWrite(line);
  }

  /**
   * Record an enhanced research record with comprehensive tokenomics data.
   *
   * This is the primary method for capturing the full research taxonomy.
   */
  recordEnhancedRecord(record: EnhancedResearchRecord): void {
    this.recordTypedEnhancedEvent(record.recordType, record as unknown as Record<string, unknown>);
  }

  /**
   * Record initial token discovery with comprehensive identity data.
   *
   * Called for every unique token discovered on-chain.
   */
  recordDiscovery(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('DISCOVERY', {
      ...record,
      // Ensure required fields are present
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2, // Enhanced schema version
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'DISCOVERY',
      event: record['event'] ?? 'TOKEN_DISCOVERED',
    });
  }

  /**
   * Record continuous observation data (price, volume, flow, etc.) sampled over time.
   *
   * Called periodically during token evaluation windows.
   */
  recordObservation(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('OBSERVATION', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'OBSERVATION',
      event: record['event'] ?? 'CONTINUOUS_OBSERVATION',
    });
  }

  /**
   * Record a decision point (BUY, REJECT, QUALIFIED, etc.) with comprehensive scoring.
   */
  recordDecision(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('DECISION', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'DECISION',
      event: record['event'] ?? 'DECISION_POINT',
    });
  }

  /**
   * Record a passing candidate snapshot - captured when token passes risk+momentum gates
   */
  recordPassingCandidateSnapshot(snapshot: Partial<PassingCandidateSnapshot>): void {
    this.recordTypedEnhancedEvent('PASSING_CANDIDATE_FORWARD_OUTCOME', {
      ...snapshot,
      recordId: `passing-candidate:${snapshot['tokenMint'] ?? 'unknown'}:${snapshot['timestamp'] ?? Date.now()}`,
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      recordType: 'PASSING_CANDIDATE_FORWARD_OUTCOME',
      event: 'PASSING_CANDIDATE_SNAPSHOT',
    });
  }

  /**
   * Record a forward observation for a passing candidate
   */
  recordPassingCandidateObservation(observation: Partial<ForwardObservation>): void {
    this.recordTypedEnhancedEvent('PASSING_CANDIDATE_FORWARD_OUTCOME', {
      ...observation,
      recordId: `forward-obs:${observation['tokenMint'] ?? 'unknown'}:${observation['observationTime'] ?? Date.now()}`,
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      recordType: 'PASSING_CANDIDATE_FORWARD_OUTCOME',
      event: 'FORWARD_OBSERVATION',
    });
  }

  /**
   * Record a complete passing candidate outcome (snapshot + all observations)
   */
  recordPassingCandidateOutcome(outcome: Partial<PassingCandidateOutcome>): void {
    // First record the snapshot
    this.recordPassingCandidateSnapshot(outcome.snapshot as Partial<PassingCandidateSnapshot>);

    // Then record each observation
    for (const observation of outcome.observations ?? []) {
      this.recordPassingCandidateObservation(observation as Partial<ForwardObservation>);
    }

    // Finally, record the outcome summary
    this.recordTypedEnhancedEvent('PASSING_CANDIDATE_OUTCOME', {
      ...outcome,
      recordId: `passing-outcome:${outcome.snapshot?.tokenMint ?? 'unknown'}:${outcome.snapshot?.timestamp ?? Date.now()}`,
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      recordType: 'PASSING_CANDIDATE_OUTCOME',
      event: 'PASSING_CANDIDATE_OUTCOME_SUMMARY',
    });
  }

  /**
   * Record the outcome of a completed position (simulated or actual).
   */
  recordOutcome(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('OUTCOME', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'OUTCOME',
      event: record['event'] ?? 'POSITION_OUTCOME',
    });
  }

  /**
   * Record a simulated execution attempt (for DRY_RUN research).
   */
  recordExecution(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('EXECUTION', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'EXECUTION',
      event: record['event'] ?? 'EXECUTION_ATTEMPT',
    });
  }

  /**
   * Record LP initialization/event data.
   */
  recordLpInitialization(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('LP_INITIALIZATION', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'LP_INITIALIZATION',
      event: record['event'] ?? 'LP_INITIALIZATION_EVENT',
    });
  }

  /**
   * Record liquidity change events.
   */
  recordLiquidityEvent(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('LIQUIDITY_EVENT', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'LIQUIDITY_EVENT',
      event: record['event'] ?? 'LIQUIDITY_CHANGE',
    });
  }

  /**
   * Record specialized momentum events (e.g., momentum state changes).
   */
  recordMomentumEvent(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('MOMENTUM_EVENT', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'MOMENTUM_EVENT',
      event: record['event'] ?? 'MOMENTUM_STATE_CHANGE',
    });
  }

  /**
   * Record graduation/migration events.
   */
  recordGraduation(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('GRADUATION', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'GRADUATION',
      event: record['event'] ?? 'GRADUATION_EVENT',
    });
  }

  /**
   * Record metadata updates (name changes, social links, etc.).
   */
  recordMetadataUpdate(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('METADATA_UPDATE', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'METADATA_UPDATE',
      event: record['event'] ?? 'METADATA_UPDATE',
    });
  }

  /**
   * Record staleness detection events.
   */
  recordStaleEvent(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('STALE_EVENT', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'STALE_EVENT',
      event: record['event'] ?? 'STALENESS_DETECTION',
    });
  }

  /**
   * Record position simulation data (for hypothetical positions).
   */
  recordPositionSimulation(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('POSITION_SIMULATION', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'POSITION_SIMULATION',
      event: record['event'] ?? 'POSITION_SIMULATION_DATA',
    });
  }

  /**
   * Record take-profit research data.
   */
  recordTakeProfitResearch(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('TAKE_PROFIT_RESEARCH', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'TAKE_PROFIT_RESEARCH',
      event: record['event'] ?? 'TP_RESEARCH_DATA',
    });
  }

  /**
   * Record stop-loss research data.
   */
  recordStopLossResearch(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('STOP_LOSS_RESEARCH', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'STOP_LOSS_RESEARCH',
      event: record['event'] ?? 'SL_RESEARCH_DATA',
    });
  }

  /**
   * Record liquidity/execution risk analysis.
   */
  recordLiquidityExecutionRisk(record: Record<string, unknown>): void {
    this.recordTypedEnhancedEvent('LIQUIDITY_EXECUTION_RISK', {
      ...record,
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType: 'LIQUIDITY_EXECUTION_RISK',
      event: record['event'] ?? 'LIQUIDITY_RISK_ANALYSIS',
    });
  }

  /**
   * Record a non-position research observation with enhanced typing.
   *
   * Handles deduplication for internal events while allowing multiple
   * observations of the same token at different times.
   */
  private recordTypedEnhancedEvent(
    recordType:
      | 'DISCOVERY'
      | 'OBSERVATION'
      | 'DECISION'
      | 'EXECUTION'
      | 'OUTCOME'
      | 'LP_INITIALIZATION'
      | 'LIQUIDITY_EVENT'
      | 'MOMENTUM_EVENT'
      | 'GRADUATION'
      | 'METADATA_UPDATE'
      | 'STALE_EVENT'
      | 'POSITION_SIMULATION'
      | 'TAKE_PROFIT_RESEARCH'
      | 'STOP_LOSS_RESEARCH'
      | 'LIQUIDITY_EXECUTION_RISK'
      | 'EXIT_DECISION'
      | 'PASSING_CANDIDATE_FORWARD_OUTCOME'
      | 'PASSING_CANDIDATE_OUTCOME',
    record: Record<string, unknown>
  ): void {
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

    // Normalize the record for storage
    const normalized = this.normalizeJsonRecord({
      recordId: record['recordId'] ?? randomUUID(),
      schemaVersion: record['schemaVersion'] ?? 2,
      recordedAt: record['recordedAt'] ?? new Date().toISOString(),
      recordType,
      ...(record['event'] ? { event: record['event'] } : {}),
      ...record,
    });

    try {
      this.validateEnhancedResearchRecord(normalized as Record<string, unknown>);
    } catch (validationError) {
      log.error('RESEARCH_RECORD_VALIDATION_FAILED', {
        type: recordType,
        mint: record['tokenMint'] ?? record['mint'],
        error: validationError instanceof Error ? validationError.message : String(validationError),
      });
      return;
    }

    // Enhanced deduplication strategy:
    // - For DISCOVERY: deduplicate by mint (should only discover once)
    // - For OUTCOME: deduplicate by positionId (should only have one outcome per position)
    // - For others: allow multiple records per token (observations, decisions, etc.)
    //   but deduplicate exact duplicates by mint+event+timestamp+recordId
    let shouldDeduplicate = false;
    const identity = this.enhancedEventIdentity(normalized as Record<string, unknown>);

    if (identity) {
      if (this.seenRecordKeys.has(identity)) {
        shouldDeduplicate = true;
        log.info('RESEARCH_RECORD_DEDUPLICATED', {
          type: recordType,
          mint: record['tokenMint'] ?? record['mint'],
          identity,
        });
      } else {
        this.seenRecordKeys.add(identity);
      }
    }

    if (shouldDeduplicate) {
      return;
    }

    log.info('RESEARCH_WRITE_ENQUEUED', {
      type: recordType,
      mint: record['tokenMint'] ?? record['mint'],
      filePath: this.filePath,
      queuedWrites: this.written,
    });

    this.enqueueWrite(`${JSON.stringify(normalized)}\n`);
  }

  /**
   * Generate identity for deduplication logic.
   *
   * Different strategies for different record types to balance
   * deduplication needs with allowing multiple observations.
   */
  private enhancedEventIdentity(record: Record<string, unknown>): string | null {
    const mint = typeof record['mint'] === 'string' ? record['mint'] : typeof record['tokenMint'] === 'string' ? record['tokenMint'] : null;
    const event = typeof record['event'] === 'string' ? record['event'] : null;
    const positionId = typeof record['positionId'] === 'string' ? record['positionId'] : null;
    const signature = typeof record['signature'] === 'string'
      ? record['signature']
      : typeof record['txSignature'] === 'string'
        ? record['txSignature']
        : null;
    const type = typeof record['recordType'] === 'string' ? record['recordType'] : 'OBSERVATION';
    const ts = typeof record['timestamp'] === 'string' ? record['timestamp'] : typeof record['recordedAt'] === 'string' ? record['recordedAt'] : null;
    const recordId = typeof record['recordId'] === 'string' ? record['recordId'] : null;

    // Special handling for different types to balance deduplication needs
    if (type === 'DISCOVERY') {
      // Only one discovery per token - deduplicate by mint
      return mint ? `DISCOVERY:${mint}` : null;
    }

    if (type === 'OUTCOME') {
      // Only one outcome per position - deduplicate by positionId
      return positionId ? `OUTCOME:${positionId}` : null;
    }

    if (type === 'POSITION_SIMULATION') {
      // Simplified for clarity - in reality would have more sophisticated logic
      return positionId ? `POSITION_SIM:${positionId}` : null;
    }

    if (type === 'EXIT_DECISION') {
      // For exit decisions, deduplicate by positionId + timestamp to allow multiple exit decisions per position
      // but prevent exact duplicates
      if (positionId && ts) return `${type}:${positionId}:${ts}`;
      if (positionId && recordId) return `${type}:${positionId}:${recordId}`;
    }

    // For most other types, use comprehensive identity to allow multiple records per token
    // but prevent exact duplicates
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
  return value.map((entry) => this.normalizeJsonRecord(entry));
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

  private validateEnhancedResearchRecord(record: Record<string, unknown>): void {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Research record must be a JSON object.');
    }

    if (record['schemaVersion'] !== 1 && record['schemaVersion'] !== 2) {
      throw new Error('Research record schemaVersion must be 1 or 2.');
    }

    const type = record['recordType'];
if (typeof type !== 'string' || ![
  'DISCOVERY', 'OBSERVATION', 'DECISION', 'EXECUTION', 'OUTCOME',
  'LP_INITIALIZATION', 'LIQUIDITY_EVENT', 'MOMENTUM_EVENT', 'GRADUATION',
  'METADATA_UPDATE', 'STALE_EVENT', 'POSITION_SIMULATION',
  'TAKE_PROFIT_RESEARCH', 'STOP_LOSS_RESEARCH', 'LIQUIDITY_EXECUTION_RISK',
  'PASSING_CANDIDATE_FORWARD_OUTCOME',
].includes(type)) {
  throw new Error(`Research recordType must be one of the supported types: ${String(type)}`);
}

    if (typeof record['recordedAt'] !== 'string' || Number.isNaN(Date.parse(record['recordedAt'] as string))) {
      throw new Error('Research record recordedAt must be a valid ISO timestamp.');
    }

    const mint = typeof record['mint'] === 'string' ? record['mint'] : typeof record['tokenMint'] === 'string' ? record['tokenMint'] : null;
    // For most types we require a token identifier, but some legacy types might not have it
    // Still require it for the main enhanced types
    const requiresMint = ![
      'OUTCOME' // Outcomes reference positionId instead
    ].includes(type);

    if (requiresMint && !mint) {
      throw new Error('Research record requires a mint or tokenMint.');
    }
  }

  private buildLegacyRecord(
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