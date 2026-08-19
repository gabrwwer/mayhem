export type TripReason =
  | "KILL_SWITCH"
  | "DAILY_LOSS_CAP"
  | "LOSS_STREAK"
  | "DRAWDOWN"
  | "COOLDOWN";

export interface BreakerConfig {
  maxDailyLossLamports: bigint;
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
  tripCooldownMs: number;
}

export interface BreakerState {
  killSwitch: boolean;
  dayStart: number;
  dailyLossLamports: bigint;
  consecutiveLosses: number;
  peakEquityLamports: bigint;
  currentEquityLamports: bigint;
  lastTripAt: number | null;
}

export interface GateResult {
  block: boolean;
  reason: TripReason | null;
}

const DAY_MS = 86_400_000;

export function freshState(peakEquityLamports: bigint): BreakerState {
  if (peakEquityLamports < 0n) {
    throw new Error("Peak equity cannot be negative");
  }

  return {
    killSwitch: false,
    dayStart: Date.now(),
    dailyLossLamports: 0n,
    consecutiveLosses: 0,
    peakEquityLamports,
    currentEquityLamports: peakEquityLamports,
    lastTripAt: null,
  };
}

export class CircuitBreaker {
  /** Reason the breaker is currently tripped, or null. Not persisted. */
  private trippedReason: TripReason | null = null;

  constructor(
    private readonly cfg: BreakerConfig,
    private state: BreakerState,
    private readonly onTrip?: (reason: TripReason) => void,
    /**
     * Called after every state mutation so the caller can persist it.
     * Without durable state a restart clears the kill switch, the daily
     * loss total and the loss streak — see ./persistence.ts.
     */
    private readonly onStateChange?: (state: BreakerState) => void,
  ) {
    if (cfg.maxDailyLossLamports < 0n) {
      throw new Error("maxDailyLossLamports cannot be negative");
    }
    if (cfg.maxConsecutiveLosses < 1) {
      throw new Error("maxConsecutiveLosses must be at least 1");
    }
    if (cfg.maxDrawdownPct < 0 || cfg.maxDrawdownPct > 100) {
      throw new Error("maxDrawdownPct must be between 0 and 100");
    }
    if (cfg.tripCooldownMs < 0) {
      throw new Error("tripCooldownMs cannot be negative");
    }
  }

  /**
   * Side-effect-free view of the gate.
   *
   * `shouldBlock()` can roll the daily window, which makes it unsafe to call
   * from anywhere that is merely *observing* state — a health endpoint that
   * calls it is silently mutating risk state on every scrape. Read paths
   * must use this instead.
   */
  peek(): GateResult {
    const now = Date.now();
    const rolled = now - this.state.dayStart >= DAY_MS;

    // Evaluate against what the state *would* be after a roll, without
    // performing the roll. Only the daily accumulator is affected by a
    // roll — the loss streak intentionally survives it (see rollWindow).
    const dailyLoss = rolled ? 0n : this.state.dailyLossLamports;

    if (this.state.killSwitch) return { block: true, reason: "KILL_SWITCH" };
    if (dailyLoss >= this.cfg.maxDailyLossLamports) {
      return { block: true, reason: "DAILY_LOSS_CAP" };
    }
    if (this.state.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      return { block: true, reason: "LOSS_STREAK" };
    }
    if (this.drawdownPct() >= this.cfg.maxDrawdownPct) {
      return { block: true, reason: "DRAWDOWN" };
    }
    if (
      this.state.lastTripAt !== null &&
      now - this.state.lastTripAt < this.cfg.tripCooldownMs
    ) {
      return { block: true, reason: "COOLDOWN" };
    }

    return { block: false, reason: null };
  }

  shouldBlock(): GateResult {
    const now = Date.now();

    if (this.state.killSwitch) {
      return { block: true, reason: "KILL_SWITCH" };
    }

    if (now - this.state.dayStart >= DAY_MS) {
      this.rollWindow(now);
    }

    if (this.state.dailyLossLamports >= this.cfg.maxDailyLossLamports) {
      return { block: true, reason: "DAILY_LOSS_CAP" };
    }

    if (this.state.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      return { block: true, reason: "LOSS_STREAK" };
    }

    if (this.drawdownPct() >= this.cfg.maxDrawdownPct) {
      return { block: true, reason: "DRAWDOWN" };
    }

    if (
      this.state.lastTripAt !== null &&
      now - this.state.lastTripAt < this.cfg.tripCooldownMs
    ) {
      return { block: true, reason: "COOLDOWN" };
    }

    return { block: false, reason: null };
  }

  recordTrade(pnlLamports: bigint): void {
    if (pnlLamports >= 0n) {
      this.state.consecutiveLosses = 0;
    } else {
      this.state.consecutiveLosses += 1;
      this.state.dailyLossLamports += -pnlLamports;
    }

    this.evaluateTrips();
    this.persist();
  }

  /**
   * Update drawdown from an actual portfolio equity snapshot.
   * Trade P&L alone is never used as a proxy for portfolio equity.
   */
  updateEquity(equityLamports: bigint): void {
    if (equityLamports < 0n) {
      throw new Error("Equity cannot be negative");
    }

    this.state.currentEquityLamports = equityLamports;

    if (equityLamports > this.state.peakEquityLamports) {
      this.state.peakEquityLamports = equityLamports;
    }

    this.evaluateTrips();
    this.persist();
  }

  kill(): void {
    if (this.state.killSwitch) {
      return;
    }

    this.state.killSwitch = true;
    this.trip("KILL_SWITCH");
    this.persist();
  }

  /**
   * Explicit administrative reset.
   * Current equity becomes the new peak so a reset cannot erase a real loss
   * by restoring an old peak.
   */
  reset(): void {
    this.state = freshState(this.state.currentEquityLamports);
    this.trippedReason = null;
    this.persist();
  }

  getState(): BreakerState {
    return {
      ...this.state,
    };
  }

  private evaluateTrips(): void {
    if (this.state.dailyLossLamports >= this.cfg.maxDailyLossLamports) {
      this.trip("DAILY_LOSS_CAP");
      return;
    }

    if (this.state.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      this.trip("LOSS_STREAK");
      return;
    }

    if (this.drawdownPct() >= this.cfg.maxDrawdownPct) {
      this.trip("DRAWDOWN");
    }
  }

  private trip(reason: TripReason): void {
    // Fire only on the TRANSITION into a tripped state.
    //
    // `evaluateTrips()` runs on every equity update — once per second in
    // dry run — and the trip conditions stay true while the breaker is
    // tripped. Without this guard the callback fired every second, filling
    // the log with identical BREAKER_TRIPPED lines and re-notifying on
    // every tick. A breaker that is already open is not news.
    const alreadyTripped = this.trippedReason === reason;
    this.trippedReason = reason;
    this.state.lastTripAt = Date.now();

    if (alreadyTripped) return;

    try {
      this.onTrip?.(reason);
    } catch (error) {
      console.error(
        "[CircuitBreaker] onTrip callback failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Hand current state to the persistence callback.
   *
   * A failure here is logged but never thrown: persistence must not be able
   * to prevent the breaker from tripping. The trade-off is explicit — a
   * write failure means the trip may not survive a restart, so the callback
   * itself is responsible for alerting.
   */
  private persist(): void {
    if (!this.onStateChange) return;

    try {
      this.onStateChange(this.getState());
    } catch (error) {
      console.error(
        "[CircuitBreaker] state persistence failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private drawdownPct(): number {
    const peak = this.state.peakEquityLamports;
    const current = this.state.currentEquityLamports;

    if (peak <= 0n || current >= peak) {
      return 0;
    }

    return Number(((peak - current) * 100n) / peak);
  }

  /**
   * Roll the daily loss window.
   *
   * Only the *daily* accumulator resets. `consecutiveLosses` deliberately
   * survives the roll: a loss streak is a statement about the strategy, not
   * about the calendar, and zeroing it at an arbitrary wall-clock boundary
   * meant a bot losing steadily through midnight got its streak forgiven
   * and carried on trading. Clearing a streak is an explicit operator
   * action — `reset()`.
   */
  private rollWindow(now: number): void {
    this.state.dayStart = now;
    this.state.dailyLossLamports = 0n;
    this.persist();
  }
}