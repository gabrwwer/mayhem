import { freshState, type BreakerState } from './circuit-breaker';

/**
 * Persistence port for circuit-breaker state.
 *
 * The breaker is the last line of defence against a losing strategy. Held
 * only in memory it is trivially bypassed: kill the process, start it
 * again, and the kill switch, daily loss total, loss streak and equity peak
 * all reset to zero. Any deployment that can restart (crash loop,
 * supervisor, container reschedule, or an operator who does not realise
 * what a restart clears) therefore has no effective loss limit at all.
 *
 * Implementations must be durable across process restarts. `load` returning
 * null means "no prior state recorded", which is only safe on a genuinely
 * first run — see `restoreBreakerState` for the fail-closed policy.
 */
export interface BreakerStateStore {
  load(): Promise<PersistedBreakerState | null>;
  save(state: PersistedBreakerState): Promise<void>;
}

/** Wire format: bigints are serialised as decimal strings. */
export interface PersistedBreakerState {
  killSwitch: boolean;
  dayStart: number;
  dailyLossLamports: string;
  consecutiveLosses: number;
  peakEquityLamports: string;
  currentEquityLamports: string;
  lastTripAt: number | null;
  /** Schema version so a future migration cannot be silently misread. */
  version: 1;
}

export function serializeBreakerState(state: BreakerState): PersistedBreakerState {
  return {
    version: 1,
    killSwitch: state.killSwitch,
    dayStart: state.dayStart,
    dailyLossLamports: state.dailyLossLamports.toString(),
    consecutiveLosses: state.consecutiveLosses,
    peakEquityLamports: state.peakEquityLamports.toString(),
    currentEquityLamports: state.currentEquityLamports.toString(),
    lastTripAt: state.lastTripAt,
  };
}

export function deserializeBreakerState(raw: PersistedBreakerState): BreakerState {
  if (raw.version !== 1) {
    throw new Error(`Unsupported breaker state version: ${String(raw.version)}`);
  }

  const state: BreakerState = {
    killSwitch: Boolean(raw.killSwitch),
    dayStart: Number(raw.dayStart),
    dailyLossLamports: BigInt(raw.dailyLossLamports),
    consecutiveLosses: Number(raw.consecutiveLosses),
    peakEquityLamports: BigInt(raw.peakEquityLamports),
    currentEquityLamports: BigInt(raw.currentEquityLamports),
    lastTripAt: raw.lastTripAt === null ? null : Number(raw.lastTripAt),
  };

  if (!Number.isFinite(state.dayStart)) {
    throw new Error('Persisted breaker state has an invalid dayStart');
  }
  if (!Number.isInteger(state.consecutiveLosses) || state.consecutiveLosses < 0) {
    throw new Error('Persisted breaker state has an invalid consecutiveLosses');
  }
  if (state.dailyLossLamports < 0n || state.peakEquityLamports < 0n || state.currentEquityLamports < 0n) {
    throw new Error('Persisted breaker state has a negative lamport field');
  }

  return state;
}

export interface RestoreOptions {
  store: BreakerStateStore;
  /** Used only when the store confirms there is no prior state. */
  firstRunEquityLamports: bigint;
  /**
   * When true (the default) an unreadable store produces a killed breaker
   * rather than a fresh one. Trading without knowing whether you are
   * already tripped is strictly worse than not trading.
   */
  failClosed?: boolean;
  logger?: {
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
  };
}

export interface RestoreResult {
  state: BreakerState;
  /** 'restored' | 'first-run' | 'fail-closed' */
  origin: 'restored' | 'first-run' | 'fail-closed';
}

/**
 * Load breaker state at boot, failing CLOSED on any error.
 *
 * The three outcomes are deliberately distinguishable so the caller can
 * alert on 'fail-closed' — a breaker that is killed because the database is
 * unreachable looks identical to a breaker that is killed because the
 * strategy blew up, and those need very different operator responses.
 */
export async function restoreBreakerState(
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { store, logger } = options;
  const failClosed = options.failClosed ?? true;

  // Clamp rather than trust: `freshState` throws on a negative peak, and a
  // throw from inside the fail-closed handler would defeat the entire point
  // of this function.
  const firstRunEquityLamports =
    options.firstRunEquityLamports < 0n ? 0n : options.firstRunEquityLamports;

  try {
    const persisted = await store.load();

    if (persisted === null) {
      logger?.info('BREAKER_STATE_FIRST_RUN', {
        equityLamports: firstRunEquityLamports.toString(),
      });
      return {
        origin: 'first-run',
        state: freshState(firstRunEquityLamports),
      };
    }

    const state = deserializeBreakerState(persisted);
    logger?.info('BREAKER_STATE_RESTORED', {
      killSwitch: state.killSwitch,
      consecutiveLosses: state.consecutiveLosses,
      dailyLossLamports: state.dailyLossLamports.toString(),
    });
    return { origin: 'restored', state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!failClosed) {
      logger?.warn('BREAKER_STATE_LOAD_FAILED_OPEN', { error: message });
      return { origin: 'first-run', state: freshState(firstRunEquityLamports) };
    }

    logger?.error('BREAKER_STATE_LOAD_FAILED_CLOSED', { error: message });

    return {
      origin: 'fail-closed',
      state: {
        ...freshState(firstRunEquityLamports),
        killSwitch: true,
        lastTripAt: Date.now(),
      },
    };
  }
}

/** In-memory store. Test double only — never use in a live process. */
export class InMemoryBreakerStateStore implements BreakerStateStore {
  private state: PersistedBreakerState | null = null;

  async load(): Promise<PersistedBreakerState | null> {
    return this.state;
  }

  async save(state: PersistedBreakerState): Promise<void> {
    this.state = state;
  }
}
