import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '@mayhem/config';
import { SolanaConnection } from '@mayhem/solana';
import {
  SimulatedExecutionEngine,
  SnipeEngine,
  SnipeEngineAdapter,
  JitoClient,
  FeeBudget,
  isPumpFunToken,
  readBondingCurve,
  OrderReconciliationService,
} from '@mayhem/execution';
import { PublicKey } from '@solana/web3.js';
import { enrichToken } from './enrichment';
import {
  RiskEngine,
  CircuitBreaker,
  restoreBreakerState,
  serializeBreakerState,
  InMemoryBreakerStateStore,
  type BreakerStateStore,
  type PersistedBreakerState,
} from '@mayhem/risk-engine';
import {
  MayhemEngine,
  PositionManager,
  TradingConfig,
  type PositionStore,
  type SerializedPosition,
} from '@mayhem/trading-engine';
import {
  TokenMonitor,
  SolanaTokenProvider,
  DISCOVERY_SCOPES,
  RaydiumLpProvider,
  MempoolMonitor,
  LiquidityMonitor,
} from '@mayhem/token-monitor';
import { RapidLaunchAdapter } from '@mayhem/rapidlaunch-adapter';
import {
  DatabaseClient,
  EngineStateRepository,
  PostgresBreakerStateStore,
  PostgresPositionStore,
  PostgresOrderStore,
} from '@mayhem/database';
import { logger } from './logger';
import { NewLaunchHandler } from './new-launch-handler';
import { DryRunTracker } from './dry-run-tracker';
import { TradeJournal } from './trade-journal';
import { RiskGateAdapter } from './risk-gate-adapter';
import { InternalApiClient } from './internal-api-client';
import { loadLiveWallet } from './wallet-loader';

const VERSION = '1.0.0';

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.toString()) {
      for (const key of u.searchParams.keys()) {
        u.searchParams.set(key, 'REDACTED');
      }
    }
    if (u.password) u.password = 'REDACTED';
    return u.toString();
  } catch {
    return url.replace(/[?].*$/, '?REDACTED');
  }
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function envOptionalString(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}


function findEnvFile(): string {
  const localEnv = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(localEnv)) return localEnv;

  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return localEnv;
}


async function main(): Promise<void> {
  const envPath = findEnvFile();
  const config = loadConfig(envPath);
  const dryRun = config.env.dryRun;
  const tradingEnabled = config.env.tradingEnabled;
  const useLiveAdapter = config.env.useLiveAdapter;
  if (useLiveAdapter && (dryRun || !tradingEnabled)) {
    throw new Error(
      'USE_LIVE_ADAPTER requires DRY_RUN=false and TRADING_ENABLED=true; refusing to fall back to simulation',
    );
  }
  const solanaRpcUrl = envString('SOLANA_RPC_URL', config.rpc.http[0] ?? 'https://api.mainnet-beta.solana.com');
  const solanaBackupRpcUrl = envOptionalString('SOLANA_BACKUP_RPC_URL') ?? config.rpc.http[1] ?? config.rpc.http[2];

  const maxPositionSol = Number(config.snipe.positionLamports) / 1e9;
  const minLiquiditySol = Number(config.risk.minLiquidityLamports) / 1e9;
  const maxOpenPositions = config.snipe.maxConcurrentPositions;

  logger.info('BOT_STARTED', {
    version: VERSION,
    mode: dryRun ? 'DRY_RUN' : 'LIVE',
    tradingEnabled,
    useLiveAdapter,
    env: config.env.nodeEnv,
    // redactUrl, not the raw values: these URLs carry the RPC provider API
    // key in the query string, and this line is written before any other
    // startup logging — so an unredacted copy landed at the top of every
    // captured log file.
    rpc: {
      primary: redactUrl(solanaRpcUrl),
      backup: solanaBackupRpcUrl ? redactUrl(solanaBackupRpcUrl) : 'none',
    },
  });

  if (dryRun) {
    logger.info('DRY RUN mode active. No real transactions will be executed.');
  }

  if (!tradingEnabled) {
    logger.info('Trading disabled. Bot is in monitor-only mode.');
  }

  if (!dryRun && tradingEnabled) {
    logger.warn('Live trading is configured, but this workspace currently supports dry-run or monitor-only mode only.');
  }

  // ========== CONFIG RESOLVED DUMP — Validate runtime configuration ==========
  // This dump proves what configuration the bot is actually running with,
  // not what was intended in .env. Use this to debug configuration mismatches.
  logger.info('CONFIG_RESOLVED', {
    // Entry strategy
    entryMode: envString('ENTRY_MODE', 'MOMENTUM'),
    
    // Risk gate
    minRiskScore: envNumber('MIN_RISK_SCORE', 70),
    
    // Position sizing
    maxPositionSol: maxPositionSol,
    maxOpenPositions: maxOpenPositions,
    maxConcurrentEvaluations: envNumber('MAX_CONCURRENT_EVALUATIONS', 8),
    
    // Early-flow parameters (if ENTRY_MODE=EARLY_FLOW)
    earlyFlowWindowMs: envNumber('EARLY_FLOW_WINDOW_MS', 5000),
    earlyFlowSampleIntervalMs: envNumber('EARLY_FLOW_SAMPLE_INTERVAL_MS', 1000),
    minEarlyFlowSamples: envNumber('MIN_EARLY_FLOW_SAMPLES', 3),
    maxEarlyFlowSamples: envNumber('MAX_EARLY_FLOW_SAMPLES', 5),
    minNetFlowPct: envNumber('MIN_NET_FLOW_PCT', 5),
    maxEarlyDrawdownPct: envNumber('MAX_EARLY_DRAWDOWN_PCT', 15),
    maxEarlyVolatility: envNumber('MAX_EARLY_VOLATILITY', 0.50),
    
    // Wallet/transaction metrics
    minUniqueBuyers: envNumber('MIN_UNIQUE_BUYERS', 3),
    minBuyTransactions: envNumber('MIN_BUY_TRANSACTIONS', 3),
    maxTopBuyerConcentration: envNumber('MAX_TOP_BUYER_CONCENTRATION', 0.50),
    maxSellPressure: envNumber('MAX_SELL_PRESSURE', 0.45),
    
    // Momentum parameters (if ENTRY_MODE=MOMENTUM)
    momentumConfirmDurationMs: envNumber('MOMENTUM_CONFIRM_DURATION_MS', 60000),
    momentumConfirmIntervalMs: envNumber('MOMENTUM_CONFIRM_INTERVAL_MS', 2000),
    minMomentumSamples: config.snipe.minMomentumSamples,
    minMomentumChangePct: envNumber('MIN_MOMENTUM_CHANGE_PCT', 2),
    minBuyPressure: envNumber('MIN_BUY_PRESSURE', 0.65),
    maxMomentumDrawdownPct: envNumber('MAX_MOMENTUM_DRAWDOWN_PCT', 10),
    maxMomentumVolatility: envNumber('MAX_MOMENTUM_VOLATILITY', 0.5),
    maxFlatRatio: envNumber('MAX_FLAT_RATIO', 0.75),
    
    // Execution quality
    maxSlippagePct: envNumber('MAX_SLIPPAGE_PCT', 8),
    targetMaxSlippagePct: envNumber('TARGET_MAX_SLIPPAGE_PCT', 5),
    maxEntryPriceImpactBps: envNumber('MAX_ENTRY_PRICE_IMPACT_BPS', 750),
    maxQuoteAgeMs: envNumber('MAX_QUOTE_AGE_MS', 750),
    
    // Exit conditions
    takeProfitPercent: config.exit.takeProfitPct,
    stopLossPercent: envNumber('STOP_LOSS_PCT', 15),
    trailingStopPct: config.exit.trailingStopPct,
    maxHoldSeconds: config.exit.maxHoldSeconds,
    minHoldMs: envNumber('MIN_HOLD_MS', 100),
    
    // Retry & monitoring
    monitorIntervalMs: envNumber('MONITOR_INTERVAL_MS', 500),
    exitRetryMaxAttempts: envNumber('EXIT_RETRY_MAX_ATTEMPTS', 7),
    exitRetryDelayMs: envNumber('EXIT_RETRY_DELAY_MS', 500),
    
    // Simulation
    dryRun: dryRun,
    tradingEnabled: tradingEnabled,
    simFailureRate: envNumber('SIM_FAILURE_RATE', 0),
    simInitialSol: envNumber('SIM_INITIAL_SOL', 10),
    simVolatility: envNumber('SIM_VOLATILITY', 0.05),
  });

  const solanaConnection = new SolanaConnection(
    solanaRpcUrl,
    solanaBackupRpcUrl,
  );

  const rapidLaunchApiUrl = envOptionalString('RAPIDLAUNCH_API_URL');
  const rapidLaunchApiKey = envOptionalString('RAPIDLAUNCH_API_KEY');
  const dbUrl = envOptionalString('DATABASE_URL');
  const liquidityDropExitPercent = envNumber('LIQUIDITY_DROP_EXIT_PERCENT', 20);
  const maxPriceDropPercent = envNumber('MAX_PRICE_DROP_PERCENT', 10);
  const creatorSellDetection = envBool('CREATOR_SELL_DETECTION', false);
  const mempoolSnipeEnabled = envBool('MEMPOOL_SNIPE_ENABLED', false);

  // Raydium entries are opt-in. The pool verifier proves a pool is real,
  // owned by the Raydium program, paired against WSOL and holding a
  // positive SOL reserve — it does NOT prove the LP is locked or burned,
  // so a verified pool can still be drained by its deployer.
  const raydiumEntriesEnabled = envBool('RAYDIUM_ENTRIES_ENABLED', false);

  // Restrict processing to pump.fun unless Raydium entries are on. Every
  // event past this point costs an enrichment pass and a risk-evidence
  // lookup, so leaving it on while Raydium is disabled would spend RPC
  // budget on tokens the launch handler rejects anyway.
  const pumpFunOnly = envBool('PUMPFUN_ONLY', !raydiumEntriesEnabled);

  // ─────────────────────────────────────────────────────────────────────
  // Durable state.
  //
  // Established BEFORE the circuit breaker and position manager are
  // constructed, because both must be rehydrated from it. Previously the
  // database was connected near the end of startup and neither component
  // used it, so every restart began with a clean kill switch, a zeroed
  // daily loss and an empty position book.
  // ─────────────────────────────────────────────────────────────────────
  let db: DatabaseClient | null = null;
  let breakerStore: BreakerStateStore;
  let positionStore: PositionStore | undefined;
  let orderStore: PostgresOrderStore | undefined;
  let stateDurable = false;

  if (dbUrl) {
    try {
      db = new DatabaseClient(
        dbUrl,
        {
          maxConnections: envNumber('DATABASE_POOL_MAX', 20),
          idleTimeoutMs: envNumber('DATABASE_POOL_IDLE_TIMEOUT_MS', 30_000),
          connectionTimeoutMs: envNumber('DATABASE_CONNECTION_TIMEOUT_MS', 10_000),
          statementTimeoutMs: envNumber('DATABASE_QUERY_TIMEOUT_MS', 5_000),
        },
        logger,
      );
      await db.connect();
      await db.query('SELECT 1');
      const engineState = new EngineStateRepository(db);
      await engineState.ensureSchema();
      // Typed explicitly rather than cast — a cast here would hide a shape
      // mismatch in exactly the state that governs the loss limits.
      breakerStore = new PostgresBreakerStateStore<PersistedBreakerState>(engineState);
      positionStore = new PostgresPositionStore<SerializedPosition>(engineState);
      orderStore = new PostgresOrderStore(engineState);
      stateDurable = true;
      logger.info('STATE_STORE_READY', { backend: 'postgres', poolStats: db.getPoolStats() });
    } catch (err) {
      logger.error('STATE_STORE_UNAVAILABLE', {
        error: err instanceof Error ? err.message : String(err),
      });
      db = null;
      breakerStore = new InMemoryBreakerStateStore();
    }
  } else {
    logger.warn('STATE_STORE_NOT_CONFIGURED', {
      note: 'DATABASE_URL unset — breaker and position state will NOT survive a restart',
    });
    breakerStore = new InMemoryBreakerStateStore();
  }

  // Refuse to trade live without durable risk state. A restart would
  // otherwise clear the kill switch and the daily loss cap, which means
  // there is effectively no loss limit at all. Dry run is allowed to
  // proceed on volatile state because no capital is at risk.
  if (!dryRun && !stateDurable) {
    throw new Error(
      'Live trading requires durable state (DATABASE_URL). Without it a restart ' +
        'resets the circuit breaker and orphans open positions.',
    );
  }

  // Declared here (not at first use) because the launch handler below
  // takes it as a constructor dependency.
  const apiUrl = process.env['API_URL'] ?? 'http://localhost:3001';
  const internalApi = new InternalApiClient({
    baseUrl: apiUrl,
    secret: envString('INTERNAL_API_SECRET', ''),
  });

  const runtimeConfig = {
    ...config,
    TRADING_ENABLED: tradingEnabled,
    MIN_LIQUIDITY_SOL: minLiquiditySol,
    MAX_QUOTE_AGE_MS: envNumber('MAX_QUOTE_AGE_MS', 750),
    MAX_ENTRY_PRICE_IMPACT_BPS: envNumber('MAX_ENTRY_PRICE_IMPACT_BPS', 750),
    MOMENTUM_CONFIRM_ENABLED: envBool('MOMENTUM_CONFIRM_ENABLED', false),
    // Defaults per STRATEGY.md §3.2: 2s cadence over a 60s window. The prior
    // 10s/90s pair yielded ~6 usable samples and could not resolve the phase
    // where pump.fun price movement actually occurs.
    MOMENTUM_CONFIRM_DURATION_MS: envNumber('MOMENTUM_CONFIRM_DURATION_MS', 60_000),
    MOMENTUM_CONFIRM_INTERVAL_MS: envNumber('MOMENTUM_CONFIRM_INTERVAL_MS', 2_000),
    // Bounds discovery-side RPC load. Sustained cost is roughly
    // MAX_CONCURRENT_EVALUATIONS / (MOMENTUM_CONFIRM_INTERVAL_MS / 1000)
    // calls per second, before risk evidence and position monitoring.
    MAX_CONCURRENT_EVALUATIONS: envNumber('MAX_CONCURRENT_EVALUATIONS', 8),
    MIN_MOMENTUM_CHANGE_PCT: envNumber('MIN_MOMENTUM_CHANGE_PCT', 2),
    MIN_NET_FLOW_PCT: envNumber('MIN_NET_FLOW_PCT', 5),
    MIN_BUY_PRESSURE: envNumber('MIN_BUY_PRESSURE', 0.65),
    MAX_MOMENTUM_VOLATILITY: envNumber('MAX_MOMENTUM_VOLATILITY', 0.5),
    MAX_MOMENTUM_DRAWDOWN_PCT: envNumber('MAX_MOMENTUM_DRAWDOWN_PCT', 10),
    MAX_FLAT_RATIO: envNumber('MAX_FLAT_RATIO', 0.75),
    MIN_MOMENTUM_SAMPLES: config.snipe.minMomentumSamples,
    MIN_RISK_SCORE: envNumber('MIN_RISK_SCORE', 70),
  };

  const tradingConfig: TradingConfig = {
    entryEnabled: tradingEnabled,
    maxPositionSol,
    takeProfitPercent: config.exit.takeProfitPct,
    profitMonitorActivationPercent: envNumber('PROFIT_MONITOR_ACTIVATION_PERCENT', 5),
    profitLockActivationPercent: envNumber('PROFIT_LOCK_ACTIVATION_PERCENT', 10),
    profitLockPercent: envNumber('PROFIT_LOCK_PERCENT', 50),
    trailingActivationPercent: envNumber('TRAILING_ACTIVATION_PERCENT', 10),
    aggressiveTrailingActivationPercent: envNumber('AGGRESSIVE_TRAILING_ACTIVATION_PERCENT', 15),
    stopLossPercent: config.exit.stopLossPct,
    hardStopLossPercent: config.exit.stopLossPct,
    trailingStopPercent: config.exit.trailingStopPct,
    maxHoldSeconds: config.exit.maxHoldSeconds,
    maxOpenPositions,
    entryDelayMs: envNumber('ENTRY_DELAY_MS', 0),
    newLaunchMode: envBool('NEW_LAUNCH_MODE_ENABLED', false),
    maxQuoteAgeMs: envNumber('MAX_QUOTE_AGE_MS', 750),
    maxSellPriceImpactPercent: envNumber('MAX_SELL_PRICE_IMPACT_PERCENT', 500),
    exitRetryMaxAttempts: envNumber('EXIT_RETRY_MAX_ATTEMPTS', 7),
    exitRetryDelayMs: envNumber('EXIT_RETRY_DELAY_MS', 500),

    // Single source of truth for the entry risk threshold. The engine used
    // to hardcode a different value while the launch handler enforced MIN_RISK_SCORE.
    minRiskScore: envNumber('MIN_RISK_SCORE', 70),

    // Was hardcoded as `liquidity * 0.01`.
    maxLiquidityParticipationBps: envNumber('MAX_LIQUIDITY_PARTICIPATION_BPS', 100),

    // Beyond this the engine refuses to evaluate exits on a remembered
    // price and force-exits instead.
    maxPriceAgeMs: envNumber('MAX_PRICE_AGE_MS', 15_000),

    takeProfitRetryDelayMs: envNumber('TAKE_PROFIT_RETRY_DELAY_MS', 10_000),
    expectedExitCostPercent: config.exit.expectedExitCostPct,
    aggressiveExitOnMomentumReversal: envBool(
      'AGGRESSIVE_EXIT_ON_MOMENTUM_REVERSAL',
      true,
    ),
  };

  let executionEngine: SimulatedExecutionEngine | SnipeEngineAdapter;
  const simulator = new SimulatedExecutionEngine({
    // Config is expressed as a percentage; simulator execution consumes bps.
    slippageBps: envNumber(
      'SLIPPAGE_BPS',
      config.snipe.maxSlippagePct * 100,
    ),
    failureRate: envNumber('SIM_FAILURE_RATE', 0),
    initialSolBalance: envNumber('SIM_INITIAL_SOL', 10),
    volatility: envNumber('SIM_VOLATILITY', 0.05),
    rpcUrl: solanaRpcUrl,
  });
  const riskConfig = {
    minLiquiditySol,
    maxTopHolderPercent: config.risk.maxHolderConcentrationPct,
    minHolders: envNumber('MIN_HOLDERS', 10),
    requireMintAuthorityRevoked: config.risk.mintAuthority === 'revoked',
    requireFreezeAuthorityRevoked: envBool('REQUIRE_FREEZE_AUTHORITY_REVOKED', true),
    maxDailyLossSol: Number(config.breaker.maxDailyLossLamports) / 1e9,
    maxExposureSol: Number(config.snipe.positionLamports) * maxOpenPositions / 1e9,
    cooldownMs: config.breaker.tripCooldownMs,
    emergencyStop: false,
  };

  const riskEngine = new RiskEngine(riskConfig);

  const positionManager = new PositionManager(
    tradingConfig,
    positionStore,
    (error) => {
      // Persistence failure is loud: it means the next restart will not
      // know about these positions.
      logger.error('POSITION_PERSIST_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );

  const { restored } = await positionManager.restore();
  if (restored > 0) {
    logger.warn('POSITIONS_RESTORED', {
      count: restored,
      note: 'prices are stale until the first monitor tick refreshes them',
    });
  }

  const breakerConfig = {
    maxDailyLossLamports: config.breaker.maxDailyLossLamports,
    maxConsecutiveLosses: config.breaker.maxConsecutiveLosses,
    maxDrawdownPct: config.breaker.maxDrawdownPct,
    tripCooldownMs: config.breaker.tripCooldownMs,
  };
  const initialEquityLamports = BigInt(
    Math.round(envNumber('SIM_INITIAL_SOL', 10) * 1e9),
  );

  // Restore breaker state, failing CLOSED when it cannot be read. A killed
  // breaker on a database outage is a false positive an operator can clear;
  // a fresh breaker hiding yesterday's trip is a false negative that keeps
  // losing money.
  const breakerRestore = await restoreBreakerState({
    store: breakerStore,
    firstRunEquityLamports: initialEquityLamports,
    failClosed: true,
    logger,
  });

  if (breakerRestore.origin === 'fail-closed') {
    logger.error('BREAKER_FAIL_CLOSED', {
      note: 'breaker state unreadable — starting killed; clear manually after investigating',
    });
  }

  // The BREAKER_RESET_ON_START handling lives immediately after the
  // CircuitBreaker is constructed — see below. It cannot go here: the
  // breaker does not exist yet.

  const circuitBreaker = new CircuitBreaker(
    breakerConfig,
    breakerRestore.state,
    (reason) => logger.error('BREAKER_TRIPPED', { reason }),
    (state) => {
      void breakerStore
        .save(serializeBreakerState(state))
        .catch((error: unknown) => {
          logger.error('BREAKER_PERSIST_FAILED', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  );

  if (useLiveAdapter) {
    if (!dbUrl || !db || !orderStore || !stateDurable) {
      throw new Error('live execution requires verified PostgreSQL persistence');
    }

    try {
      if (!/^https?:\/\//.test(config.jito.bundleUrl)) {
        throw new Error('invalid Jito bundle URL');
      }
      if (!Number.isFinite(Number(config.jito.maxTipLamports)) || Number(config.jito.maxTipLamports) < 0) {
        throw new Error('invalid fee configuration');
      }
      const wallet = await loadLiveWallet(process.env, logger);
      const jito = new JitoClient(config.jito.bundleUrl, {
        retries: config.jito.sendRetries,
        backoffMs: config.jito.retryBackoffMs,
        timeoutMs: config.rpc.timeoutMs,
        pollMs: config.jito.landingPollMs,
        tipAccountsTtlMs: config.jito.tipAccountsTtlMs,
      });
      const feeBudget = new FeeBudget({
        strategy: config.jito.tipStrategy,
        percentile: config.jito.tipPercentile,
        fixedLamports: Number(config.jito.tipFixedLamports),
        maxTipLamports: Number(config.jito.maxTipLamports),
        tipFloorUrl: config.jito.tipFloorUrl,
        cacheMs: config.jito.tipAccountsTtlMs,
      });
      const snipeEngine = new SnipeEngine(
        solanaConnection.getConnection(),
        jito,
        feeBudget,
        circuitBreaker,
        {
          hotWallet: wallet,
          positionSolLamports: config.snipe.positionLamports,
          maxSlippagePct: config.snipe.maxSlippagePct,
          maxConcurrentPositions: config.snipe.maxConcurrentPositions,
          maxTxAgeMs: config.snipe.maxTxAgeMs,
          landingTimeoutMs: config.jito.landingTimeoutMs,
          preflightSim: config.snipe.preflightSim,
          orderStore,
        },
      );
      executionEngine = new SnipeEngineAdapter(snipeEngine, logger);
      logger.info('LIVE_EXECUTION_ENGINE_SELECTED', {
        wallet: wallet.publicKey.toBase58(),
        persistence: 'postgres',
        jito: redactUrl(config.jito.bundleUrl),
      });
    } catch (error) {
      logger.error('LIVE_EXECUTION_INITIALIZATION_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } else {
    executionEngine = simulator;
    logger.info('SIMULATED_EXECUTION_ENGINE_SELECTED', {
      dryRun,
      tradingEnabled,
      useLiveAdapter: config.env.useLiveAdapter,
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Order Reconciliation on Startup (Live Adapter Only)
  // ─────────────────────────────────────────────────────────────────────
  if (useLiveAdapter && db && orderStore && stateDurable) {
    try {
      const jito = (executionEngine as SnipeEngineAdapter).engine?.jitoClient;
      if (!jito) {
        throw new Error('Jito client not available for reconciliation');
      }

      const reconciliationService = new OrderReconciliationService(
        solanaConnection.getConnection(),
        jito,
        db,
        new EngineStateRepository(db),
        logger,
        envNumber('RECONCILIATION_TIMEOUT_MS', 30_000),
      );

      let reconciliationResult = null;
      if (envBool('RECONCILE_ON_STARTUP', true)) {
        try {
          reconciliationResult = await reconciliationService.reconcileOnStartup();
          await reconciliationService.logReconciliation(reconciliationResult);
          
          if (reconciliationResult.orphanedPositions.length > 0) {
            logger.warn('Orphaned positions detected during reconciliation', {
              count: reconciliationResult.orphanedPositions.length,
              positions: reconciliationResult.orphanedPositions,
            });
          }
        } catch (err) {
          logger.error('Order reconciliation failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    } catch (error) {
      logger.error('ORDER_RECONCILIATION_INITIALIZATION_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const mayhemEngine = new MayhemEngine(
    tradingConfig,
    positionManager,
    executionEngine,
    riskEngine,
    logger,
    {
      filePath: path.resolve(process.cwd(), 'data', 'research.jsonl'),
      dryRun,
      tradingEnabled,
    },
  );

  /*
   * Discard persisted breaker state and re-base peak equity to the current
   * balance.
   *
   * Needed because the persistence works: a peak recorded in an earlier
   * session gets measured against today's balance, so a paper account that
   * resets to its starting SOL every run looks like a drawdown against a
   * peak it never actually had — and the breaker correctly refuses to
   * trade.
   *
   * DRY RUN ONLY, deliberately. In live trading this would mean a crash
   * loop erases the loss limit on every restart, which is the exact
   * failure the persistence was added to prevent.
   */
  if (envBool('BREAKER_RESET_ON_START', false)) {
    if (!dryRun) {
      throw new Error(
        'BREAKER_RESET_ON_START is not permitted outside DRY_RUN: it would let ' +
          'a restart clear the loss limits the circuit breaker exists to enforce.',
      );
    }

    circuitBreaker.reset();
    logger.warn('BREAKER_RESET_ON_START', {
      equityLamports: initialEquityLamports.toString(),
      note: 'persisted breaker state discarded; peak equity re-based to current balance',
    });
  }

  const riskGate = new RiskGateAdapter(
    riskEngine,
    solanaConnection.getConnection(),
    riskConfig,
    // Honeypot detection: the simulator exposes a sell quote path we can
    // use as a proxy for "is this sellable at all".
    {
      canSell: async (tokenMint: string) => {
        try {
          const quote = await executionEngine.quoteSell(tokenMint, '1');
          return quote?.outputAmount != null && Number.isFinite(Number(quote.outputAmount)) && Number(quote.outputAmount) > 0;
        } catch {
          return false;
        }
      },
    },
    { requireSellSimulation: config.risk.honeypotSimSell },
  );

  const launchHandler = new NewLaunchHandler(
    mayhemEngine, executionEngine, runtimeConfig as any, riskGate, circuitBreaker,
    internalApi,
  );

  const tokenMonitor = new TokenMonitor();

  /*
   * Discovery providers are individually switchable, because they have very
   * different costs and you rarely want both:
   *
   *  - SolanaTokenProvider subscribes to the SPL Token AND Token-2022
   *    program logs, i.e. EVERY mint created on Solana, and does a
   *    getParsedTransaction per candidate signature. This is the firehose;
   *    it exists to catch pump.fun launches at mint time.
   *  - RaydiumLpProvider subscribes to the two Raydium programs only, and
   *    is the correct source when trading graduated//LP-launched tokens.
   *
   * Running both means paying for the whole Solana mint stream while
   * trading Raydium pools — which is what exhausted the RPC budget.
   */
  const enableSplProvider = envBool('ENABLE_SPL_PROVIDER', !raydiumEntriesEnabled);
  const enableRaydiumProvider = envBool('ENABLE_RAYDIUM_PROVIDER', raydiumEntriesEnabled);

  if (enableRaydiumProvider) {
    tokenMonitor.addProvider(
      new RaydiumLpProvider(solanaRpcUrl, { entriesEnabled: raydiumEntriesEnabled }),
    );
  }

  if (enableSplProvider) {
    // Scope the subscription to the programs we actually trade.
    //
    // The default (`allMints`) subscribes to the SPL Token and Token-2022
    // programs — that is a log stream covering most of Solana, and every
    // entry mentioning `initializeMint` costs a parsed-transaction fetch.
    // With PUMPFUN_ONLY we were paying for that entire stream and then
    // discarding all but the pump.fun mints in our own callback.
    //
    // pump.fun's `create` CPIs into the token program, so `initializeMint`
    // still shows up in inner instructions and the same parsing finds the
    // same mints — from a far smaller stream.
    const scope = pumpFunOnly
      ? DISCOVERY_SCOPES.pumpFun
      : DISCOVERY_SCOPES.allMints;

    tokenMonitor.addProvider(
      new SolanaTokenProvider(solanaRpcUrl, {
        programs: scope,
        // Discovery mode. Subscriptions are lower latency but their cost is
        // set by how busy the watched program is — onLogs delivers every
        // transaction touching it, which for pump.fun means every buy and
        // sell, not just launches. Polling costs (1 + batchSize) calls per
        // program per interval no matter what the chain is doing.
        //
        // On a rate-limited endpoint, predictable beats fast: a bot that
        // reliably sees some launches is worth more than one that sees all
        // of them until it gets throttled and then sees none.
        subscriptionsEnabled: envBool('TOKEN_SUBSCRIPTIONS_ENABLED', false),
        pollingEnabled: envBool('TOKEN_POLLING_ENABLED', true),
        pollIntervalMs: envNumber('TOKEN_POLL_INTERVAL_MS', 10_000),
        batchSize: envNumber('TOKEN_POLL_BATCH_SIZE', 5),
        // Hard ceiling on discoveries processed per minute. This is what
        // decouples RPC usage from pump.fun's launch rate — without it the
        // market decides how many requests you make, and a rate-limited
        // endpoint just fails.
        maxDiscoveriesPerMinute: envNumber('MAX_DISCOVERIES_PER_MINUTE', 20),
      }),
    );
  }

  if (!enableSplProvider && !enableRaydiumProvider) {
    throw new Error(
      'No discovery provider enabled. Set ENABLE_SPL_PROVIDER or ENABLE_RAYDIUM_PROVIDER.',
    );
  }

  logger.info('VENUES_CONFIGURED', {
    splProvider: enableSplProvider,
    raydiumProvider: enableRaydiumProvider,
    raydiumEntries: raydiumEntriesEnabled,
    pumpFunOnly,
  });

  // Pump.fun mints currently believed to be pre-migration (still on the
  // bonding curve). Polled below until the on-chain `complete` flag
  // flips true, at which point we push a GRADUATED stage update.
  const pendingGraduation = new Set<string>();

  // `unknown` rather than `Record<string, unknown>`: an interface without an
  // index signature (EnrichmentResult) is not assignable to the latter, and
  // the payload is serialised to JSON anyway — the narrower type bought
  // nothing and rejected valid callers.
  function postTokenUpdate(payload: unknown): void {
    void internalApi.post('/internal/tokens', payload);
  }

  /*
   * Admission control for discovery work.
   *
   * Every event that reaches handleNewToken costs RPC: risk evidence, a
   * quote, sometimes enrichment. Discovery rate is set by the chain, not by
   * us, so without a ceiling the bot's RPC usage is unbounded — and when
   * the endpoint starts rate-limiting, the calls that fail are as likely to
   * be an exit quote as a discovery lookup. Being slower to evaluate new
   * tokens is a much cheaper failure than being unable to exit a position.
   *
   * Excess events are DROPPED, not queued. A queue would just add latency
   * to work whose value decays in seconds — a launch evaluated 30s late is
   * not a trade you want anyway.
   */
  const discoveryConcurrency = envNumber('DISCOVERY_CONCURRENCY', 2);
  let discoveryInFlight = 0;
  let discoveryDropped = 0;

  // Enrichment is display-only — it feeds the dashboard and never gates a
  // trade. It is the first thing to turn off when RPC is the constraint,
  // because switching it off costs you nothing but numbers on a panel.
  const enrichmentEnabled = envBool('ENRICHMENT_ENABLED', true);

  const dropLogTimer = setInterval(() => {
    if (discoveryDropped > 0) {
      logger.warn('DISCOVERY_SHED', {
        dropped: discoveryDropped,
        concurrency: discoveryConcurrency,
        note: 'events dropped to protect the RPC budget; raise DISCOVERY_CONCURRENCY or reduce venues',
      });
      discoveryDropped = 0;
    }
  }, 30_000);
  dropLogTimer.unref?.();

  // Providers are registered above, gated by ENABLE_SPL_PROVIDER /
  // ENABLE_RAYDIUM_PROVIDER.
  tokenMonitor.onToken(async (event) => {
    // A Raydium LP-creation event means liquidity has already been added;
    // a pump.fun mint starts life on the bonding curve, pre-migration.
    // Identify pump.fun tokens by DISCOVERY SOURCE first, address suffix
    // second.
    //
    // `isPumpFunToken` tests `mint.endsWith('pump')`, which relies on
    // pump.fun's vanity-address grinding. That is a convention, not a
    // guarantee — and when discovery is scoped to the pump.fun program
    // (PUMPFUN_ONLY), every token found came from that program by
    // construction, so the suffix test can only produce false negatives
    // that silently drop real launches before the risk gate ever sees them.
    const fromPumpProgram = pumpFunOnly && event.source.startsWith('solana-onchain');
    const isPumpFun = fromPumpProgram || isPumpFunToken(event.tokenMint);
    const stage = isPumpFun ? 'BONDING_CURVE' : 'LP_ADDED';

    // Venue restriction.
    //
    // The token provider subscribes to SPL Token AND Token-2022 program
    // logs, i.e. every mint created on Solana. Each event that gets past
    // this point costs an enrichment pass and a risk-evidence lookup, so
    // the discovery firehose — not the trading logic — is what exhausts
    // the RPC budget.
    //
    // Restricting to pump.fun is also the only venue this bot can actually
    // price: `readBondingCurve` gives exact reserves from a single account,
    // whereas the Raydium path is documented as observation-only (no pool
    // address is forwarded, so enrichment returns nulls and the risk gate
    // blocks it anyway). Filtering here just stops paying for work whose
    // outcome is already decided.
    if (pumpFunOnly && !isPumpFun) {
      return;
    }

    if (isPumpFun) {
      pendingGraduation.add(event.tokenMint);
    }

    // Forward discovery to local API for dashboard sync (best-effort, no
    // RPC cost — this is a local HTTP post).
    postTokenUpdate({ ...event, stage });

    // Record the raw discovery observation so the research JSONL is populated
    // even for tokens that are rejected before reaching a position lifecycle.
    logger.info('DISCOVERY_RECEIVED', { mint: event.tokenMint, source: event.source });
    mayhemEngine.getResearchRecorder().recordDiscovery({
      event: 'TOKEN_DISCOVERED',
      mint: event.tokenMint,
      tokenMint: event.tokenMint,
      source: event.source,
      stage,
      isPumpFun,
      creator: event.creator ?? null,
      creatorSource: event.creatorSource ?? null,
      createdAt: event.createdAt ? event.createdAt.toISOString() : null,
      poolAddress: event.poolAddress ?? null,
      quoteToken: event.quoteToken ?? null,
      initialLiquidity: event.initialLiquidity ?? null,
      decimals: event.decimals ?? null,
      name: event.name ?? null,
      symbol: event.symbol ?? null,
      supply: event.supply ?? null,
      supplyRaw: event.supplyRaw ?? null,
      mintAuthority: event.mintAuthority ?? null,
      freezeAuthority: event.freezeAuthority ?? null,
      metadataUri: event.metadataUri ?? null,
      txSignature: event.txSignature ?? null,
      dexProgramId: event.dexProgramId ?? null,
      poolType: event.poolType ?? null,
      poolVerifiedAtMs: event.poolVerifiedAtMs ?? null,
      detectedSlot: event.detectedSlot ?? null,
      initializationSlot: event.initializationSlot ?? null,
      observedViaWebsocket: event.observedViaWebsocket ?? null,
      poolVerificationStatus: event.poolVerificationStatus ?? null,
      poolVerificationReason: event.poolVerificationReason ?? null,
      baseVault: event.baseVault ?? null,
      quoteVault: event.quoteVault ?? null,
      quoteReserveSol: event.quoteReserveSol ?? null,
      totalLiquiditySol: event.totalLiquiditySol ?? null,
      lpMint: event.lpMint ?? null,
      lpPositionAddress: event.lpPositionAddress ?? null,
      lpLockOrBurnVerified: event.lpLockOrBurnVerified ?? null,
    });

    // Admission control. Everything below this line costs RPC, so shed
    // load rather than letting the chain's event rate dictate ours.
    if (discoveryInFlight >= discoveryConcurrency) {
      discoveryDropped += 1;
      return;
    }

    discoveryInFlight += 1;
    try {
      // Enrichment (price/liquidity/holder-concentration/heuristic risk
      // score) is display-only and never gates trading — see
      // apps/bot/src/enrichment.ts. Awaited rather than fire-and-forget so
      // it counts against the concurrency budget; previously it could fan
      // out without limit alongside the gated work.
      if (enrichmentEnabled) {
        try {
          const result = await enrichToken(solanaConnection.getConnection(), event);
          postTokenUpdate(result);
        } catch (err) {
          logger.warn('TOKEN_ENRICHMENT_FAILED', {
            mint: event.tokenMint,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Pass the venue determination down rather than letting the handler
    // re-derive it from the address suffix — that produced a REJECTED_NO_POOL
    // for every pump.fun mint whose address does not end in "pump".
    await launchHandler.handleNewToken({ ...event, isPumpFun });
    } finally {
      discoveryInFlight -= 1;
    }
  });

  // Periodically re-check pending pump.fun mints for graduation.
  //
  // This is an unbounded fan-out: one RPC call per pending mint per tick.
  // Previously nothing ever left the set except by graduating, so after an
  // hour of discovery it was re-reading hundreds of bonding curves every
  // 30s — a background load that grew all day and competed with the
  // trading path. Two bounds now apply:
  //   - entries expire after GRADUATION_MAX_AGE_MS (most mints never
  //     graduate; watching them forever has no payoff);
  //   - each tick checks at most GRADUATION_BATCH mints, oldest first, so
  //     a large backlog spreads over several ticks instead of bursting.
  const graduationPollMs = envNumber('GRADUATION_POLL_MS', 30_000);
  const graduationMaxAgeMs = envNumber('GRADUATION_MAX_AGE_MS', 3_600_000);
  const graduationBatch = envNumber('GRADUATION_BATCH', 20);

  /** mint -> first seen, so entries can age out. */
  const graduationSeenAt = new Map<string, number>();

  const graduationPollTimer = setInterval(() => {
    void (async () => {
      const now = Date.now();

      for (const mint of [...pendingGraduation]) {
        const seen = graduationSeenAt.get(mint) ?? now;
        graduationSeenAt.set(mint, seen);
        if (now - seen > graduationMaxAgeMs) {
          pendingGraduation.delete(mint);
          graduationSeenAt.delete(mint);
        }
      }

      const batch = [...pendingGraduation]
        .sort((a, b) => (graduationSeenAt.get(a) ?? 0) - (graduationSeenAt.get(b) ?? 0))
        .slice(0, graduationBatch);

      for (const mint of batch) {
        try {
          const curve = await readBondingCurve(
            solanaConnection.getConnection(),
            new PublicKey(mint),
          );
          if (curve?.complete === true) {
            pendingGraduation.delete(mint);
            graduationSeenAt.delete(mint);
            postTokenUpdate({
              tokenMint: mint,
              stage: 'GRADUATED',
              graduatedAt: new Date().toISOString(),
            });
            logger.info('TOKEN_GRADUATED', { mint });
          }
        } catch (err) {
          logger.warn('GRADUATION_CHECK_FAILED', {
            mint,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
  }, graduationPollMs);
  graduationPollTimer.unref?.();

  const liquidityMonitor = new LiquidityMonitor(solanaConnection, {
    // Was hardcoded at 3s. This polls every watched pool, so cost scales
    // with the number of open positions on top of the position monitor.
    pollIntervalMs: envNumber('LIQUIDITY_POLL_INTERVAL_MS', 10_000),
    liquidityDropExitPercent,
    maxPriceDropPercent,
    creatorSellDetection,
  });

  liquidityMonitor.onAlert((alert) => {
    logger.warn('LIQUIDITY_ALERT', {
      pool: alert.poolAddress,
      token: alert.tokenMint,
      type: alert.alertType,
      severity: alert.severity,
      details: alert.details,
    });
    if (alert.severity === 'critical') {
      launchHandler.handleLiquidityAlert(alert);
    }
  });

  let mempoolMonitor: MempoolMonitor | null = null;
  if (mempoolSnipeEnabled) {
    mempoolMonitor = new MempoolMonitor(solanaRpcUrl);
    mempoolMonitor.onPendingLp(async (event) => {
      logger.info('MEMPOOL_PENDING_LP', {
        mint: event.tokenMint,
        pool: event.poolAddress,
        sig: event.signature,
        program: event.programId,
        liquidity: event.estimatedLiquidity,
        latencyMs: Date.now() - event.detectedAt,
      });
      await launchHandler.handleMempoolSnipe(event);
    });
    logger.info('Mempool monitor configured (processed commitment)');
  }

  let rapidLaunchStatus = { configured: false, subscribed: false, error: null as string | null };
  if (rapidLaunchApiUrl) {
    rapidLaunchStatus.configured = true;
    const rapidLaunch = new RapidLaunchAdapter({
      apiUrl: rapidLaunchApiUrl,
      apiKey: rapidLaunchApiKey,
    });

    try {
      rapidLaunch.subscribeToLaunches((token) => {
        logger.info('RapidLaunch token detected', { mint: token.mint, name: token.name });
      });
      rapidLaunchStatus.subscribed = true;
      logger.info('RapidLaunch adapter subscribed (polling). Note: endpoint connectivity unverified until first poll.');
    } catch (err) {
      rapidLaunchStatus.error = String(err);
      logger.warn('RapidLaunch subscription failed', { error: String(err) });
    }
  } else {
    logger.info('RapidLaunch adapter not configured. Using on-chain monitoring only.');
  }

  const dryRunTracker = dryRun ? new DryRunTracker() : null;

  // Durable trade journal. The in-memory tracker above prints running
  // totals that vanish on restart; this survives, and carries the settings
  // that produced each trade so runs can be compared.
  const tradeJournal = new TradeJournal(
    {
      takeProfitPercent: tradingConfig.takeProfitPercent,
      stopLossPercent: tradingConfig.stopLossPercent,
      trailingStopPercent: tradingConfig.trailingStopPercent,
      maxHoldSeconds: tradingConfig.maxHoldSeconds,
      slippageBps: envNumber('SLIPPAGE_BPS', 100),
      maxPositionSol,
      maxOpenPositions,
      minRiskScore: tradingConfig.minRiskScore,
      momentumConfirmEnabled: envBool('MOMENTUM_CONFIRM_ENABLED', false),
      minMomentumChangePct: envNumber('MIN_MOMENTUM_CHANGE_PCT', 2),
      minBuyPressure: envNumber('MIN_BUY_PRESSURE', 0.65),
      maxMomentumVolatility: envNumber('MAX_MOMENTUM_VOLATILITY', 0.5),
      maxMomentumDrawdownPct: envNumber('MAX_MOMENTUM_DRAWDOWN_PCT', 10),
      minMomentumSamples: envNumber('MIN_MOMENTUM_SAMPLES', 4),
      momentumWindowMs: envNumber('MOMENTUM_CONFIRM_DURATION_MS', 60000),
      momentumIntervalMs: envNumber('MOMENTUM_CONFIRM_INTERVAL_MS', 2000),
      minLiquiditySol,
    },
    envString('TRADE_JOURNAL_PATH', 'data/trades.jsonl'),
  );

  mayhemEngine.on('entry', (position: any) => {
    logger.info('ENTRY_SUCCESS', {
      id: position.id, token: position.tokenMint,
      entry: position.entryPrice, qty: position.quantity,
    });
  });

  mayhemEngine.on('exit', (position: any) => {
    logger.info('EXIT_SUCCESS', {
      id: position.id, token: position.tokenMint,
      reason: position.exitReason, pnl: position.realizedPnl,
    });
    if (dryRunTracker) dryRunTracker.recordTrade(position);
    tradeJournal.record(position);
    const pnlLamports = BigInt(Math.round(position.realizedPnl * 1e9));
    circuitBreaker.recordTrade(pnlLamports);
    circuitBreaker.updateEquity(
      executionEngine.getPortfolioEquityLamports(),
    );
    // Free the mint only once the position is fully closed, so the same
    // token cannot be re-entered while a position in it is still open.
    launchHandler.releaseMint(position.tokenMint);
  });

  // A partial exit leaves a live residual position — the mint stays
  // reserved and no completed trade is recorded to the breaker.
  mayhemEngine.on('partial_exit', (position: any) => {
    logger.warn('EXIT_PARTIAL', {
      id: position.id,
      token: position.tokenMint,
      residualQuantity: position.quantity,
    });
  });

  // Capital may be committed but the outcome is unknown. This needs a
  // human: it is exactly the state that produces duplicate orders if the
  // bot guesses.
  mayhemEngine.on('unreconciled', (event: any) => {
    logger.error('UNRECONCILED_TRANSACTION', event);
  });

  mayhemEngine.on('stale_price', (event: any) => {
    logger.error('STALE_PRICE_FORCED_EXIT', event);
  });

  mayhemEngine.on('emergency', (reason: string) => {
    logger.error('EMERGENCY_STOP', { reason });
  });

  mayhemEngine.on('error', (error: any) => {
    logger.error('Engine error', { error: String(error) });
  });

  await tokenMonitor.start();
  liquidityMonitor.start();
  if (mempoolMonitor) {
    await mempoolMonitor.start();
    logger.info('Mempool monitor started (pending LP sniping active)');
  }
  const simulationInterval = dryRun
    ? setInterval(() => {
        try {
          const simulator =
            executionEngine as SimulatedExecutionEngine;

          // Only random-walk prices when there is no real price source.
          // With SOLANA_RPC_URL configured, prices come from the bonding
          // curve on every monitor tick; random-walking on top of that
          // would overwrite live market data with noise and make the P&L
          // meaningless — which is precisely what it was doing.
          if (!envString('SOLANA_RPC_URL', '')) {
            simulator.simulateAllPrices();
          }
          circuitBreaker.updateEquity(
            simulator.getPortfolioEquityLamports(),
          );
        } catch (error) {
          logger.error('SIMULATION_PRICE_UPDATE_ERROR', { error: error instanceof Error ? error.message : String(error) });
        }
      }, 1000)
    : null;

  // Position monitor cadence. Was hardcoded at 250ms, i.e. 4 price lookups
  // per second per open position — the single largest source of RPC load
  // in the process, and it competed with the discovery and exit-quote calls
  // that actually matter.
  mayhemEngine.start(envNumber('MONITOR_INTERVAL_MS', 500));

  /*
   * Mirror open positions and wallet balance to the API for the dashboard.
   *
   * Observational only: this reads state the engine already maintains and
   * pushes it. It never influences entry, exit, sizing or risk, and a failed
   * push degrades the dashboard rather than the bot — `internalApi.post` is
   * fire-and-forget and logs its own failures.
   *
   * A periodic snapshot rather than hooks on open/close, for two reasons.
   * Hooking the entry and exit paths would mean editing trading code to serve
   * a display concern, and delta delivery has to be exactly-once or a dropped
   * message strands a phantom position on the operator's screen. A snapshot is
   * self-healing: the next tick corrects any drift.
   *
   * Cadence is deliberately slower than the position monitor. This is for a
   * human reading a screen, not for the exit logic, and it shares the API's
   * rate-limit budget with the dashboard's own polling.
   */
  const positionSyncIntervalMs = envNumber('POSITION_SYNC_INTERVAL_MS', 3_000);

  const positionSyncTimer = setInterval(() => {
    try {
      const open = positionManager.getOpenPositions();

      void internalApi.post('/internal/positions', {
        positions: open.map((position) => ({
          id: position.id,
          tokenMint: position.tokenMint,
          symbol: (position as { symbol?: string }).symbol ?? position.tokenMint.slice(0, 6),
          side: 'BUY',
          status: 'open',
          entryPrice: position.actualEntryPrice ?? position.entryPrice,
          currentPrice: position.currentPrice,
          quantity: position.quantity,
          // The dashboard reports size in SOL; `entryNotional` is the cost
          // basis of the quantity still held, which is what "size" means for
          // an open position after a partial exit.
          amountSol: position.entryNotional,
          unrealizedPnl: position.unrealizedPnl,
          realizedPnl: position.realizedPnl,
          openedAt: position.entryTime instanceof Date
            ? position.entryTime.toISOString()
            : new Date(position.entryTime).toISOString(),
          txSignature: position.entryTx,
        })),
      });

      // Balance. In dry run this is the simulator's ledger — the only source
      // that exists, since there is no wallet to read.
      const engine = executionEngine as unknown as {
        getSolBalance?: () => number;
        getPortfolioEquityLamports?: () => bigint;
      };

      const sol =
        typeof engine.getSolBalance === 'function'
          ? engine.getSolBalance()
          : typeof engine.getPortfolioEquityLamports === 'function'
            ? Number(engine.getPortfolioEquityLamports()) / 1e9
            : null;

      if (sol !== null && Number.isFinite(sol)) {
        void internalApi.post('/internal/balance', { sol, tokens: {} });
      }
    } catch (error) {
      // Never let a display-sync failure disturb the trading loop.
      logger.warn('POSITION_SYNC_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, positionSyncIntervalMs);

  positionSyncTimer.unref();

  const healthServer = http.createServer((req, res) => {
    const openPositions = positionManager.getOpenPositions().length;
    const discoveredTokens = tokenMonitor.getDiscoveredTokens().length;
    const isHealthy = mayhemEngine.isRunning;

    const status = isHealthy ? 'healthy' : 'degraded';

    // Expose token list at /api/tokens for the dashboard to consume.
    if (req.url && req.url.startsWith('/api/tokens')) {
      const tokens = tokenMonitor.getDiscoveredTokens();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tokens));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status,
      version: VERSION,
      uptime: process.uptime(),
      mode: dryRun ? 'dry_run' : 'live',
      tradingEnabled,
      newLaunchMode: tradingConfig.newLaunchMode,
      openPositions,
      discoveredTokens,
      rpc: {
        primary: redactUrl(solanaRpcUrl),
        backup: solanaBackupRpcUrl
    ? redactUrl(solanaBackupRpcUrl) : "none",
      },
      tokenMonitor: { providers: 1, running: true },
      liquidityMonitor: { watchedPools: liquidityMonitor.getWatchedPools().length },
      rapidLaunch: rapidLaunchStatus,
      // peek(), not shouldBlock(): the latter can roll the daily loss
      // window, so scraping this endpoint was mutating risk state.
      circuitBreaker: circuitBreaker.peek(),
      database: { connected: db !== null, durableState: stateDurable },
      dryRunStats: dryRunTracker ? dryRunTracker.getStats() : null,
      candidates: launchHandler.getCandidateStats(),
    }));
  });

  healthServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn('Health port 3002 in use, trying 3003');
      healthServer.listen(3003);
    }
  });
  healthServer.listen(3002, () => {
    logger.info('Health endpoint listening', { port: 3002 });
  });

  logger.info('Mayhem Bot fully started', {
    rpc: redactUrl(solanaRpcUrl),
    wallet: 'disabled',
    maxPositionSol,
    maxOpenPositions,
    newLaunchMode: tradingConfig.newLaunchMode,
  });

  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('BOT_STOPPED');
    mayhemEngine.stop();
    liquidityMonitor.stop();
    if (mempoolMonitor) await mempoolMonitor.stop();
    await tokenMonitor.stop();
    if (simulationInterval) {
      clearInterval(simulationInterval);
    }
    clearInterval(graduationPollTimer);
    clearInterval(positionSyncTimer);
    healthServer.close();

    // Flush state BEFORE dropping the database connection. Open positions
    // that only exist in memory at this point would be orphaned on restart.
    try {
      await positionManager.flush();
      await breakerStore.save(serializeBreakerState(circuitBreaker.getState()));
      logger.info('STATE_FLUSHED');
    } catch (err) {
      logger.error('STATE_FLUSH_FAILED', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (db) await db.disconnect();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error('Fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
