/*
 * Expectancy report over the paper-trade journal.
 *
 * Answers one question: does this configuration make money, and is the
 * sample large enough to believe the answer?
 *
 * Reads data/trades.jsonl (see apps/bot/src/trade-journal.ts) and reports
 * per configuration, because a journal spans many tuning rounds and mixing
 * them produces a number that describes nothing.
 *
 * Run:
 *   pnpm exec ts-node --transpile-only scripts/development/trade-report.ts
 *   pnpm exec ts-node --transpile-only scripts/development/trade-report.ts --by-run
 */

import fs from 'node:fs';
import path from 'node:path';

interface TradeRecord {
  runId: string;
  recordedAt: string;
  tokenMint: string;
  netPnlSol: number;
  netPnlPercent: number;
  exitReason: string;
  holdSeconds: number;
  config: Record<string, unknown>;
}

interface Stats {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  /** Expected % return per trade. THE number that matters. */
  expectancyPct: number;
  totalPnlSol: number;
  profitFactor: number;
  maxDrawdownSol: number;
  avgHoldSeconds: number;
  exitReasons: Record<string, number>;
}

function computeStats(label: string, trades: TradeRecord[]): Stats {
  const wins = trades.filter((t) => t.netPnlSol > 0);
  const losses = trades.filter((t) => t.netPnlSol <= 0);

  const avgWinPct = wins.length
    ? wins.reduce((s, t) => s + t.netPnlPercent, 0) / wins.length
    : 0;
  const avgLossPct = losses.length
    ? losses.reduce((s, t) => s + t.netPnlPercent, 0) / losses.length
    : 0;

  const winRate = trades.length ? wins.length / trades.length : 0;

  // Expectancy: average % return per trade. Positive means the
  // configuration makes money over enough trades; negative means it does
  // not, regardless of how good any individual trade looked.
  const expectancyPct = winRate * avgWinPct + (1 - winRate) * avgLossPct;

  const grossWin = wins.reduce((s, t) => s + t.netPnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnlSol, 0));

  // Peak-to-trough of cumulative P&L, in order. This is what would have
  // hurt while running, as opposed to the final total.
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    cumulative += t.netPnlSol;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  }

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: winRate * 100,
    avgWinPct,
    avgLossPct,
    expectancyPct,
    totalPnlSol: trades.reduce((s, t) => s + t.netPnlSol, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownSol: maxDrawdown,
    avgHoldSeconds: trades.length
      ? trades.reduce((s, t) => s + t.holdSeconds, 0) / trades.length
      : 0,
    exitReasons,
  };
}

/**
 * Rough guide to whether the sample means anything.
 *
 * With a ~50% win rate you need on the order of 100 trades before the
 * observed expectancy is distinguishable from noise. Reporting a verdict
 * from 12 trades is how people convince themselves a losing configuration
 * works.
 */
function confidenceNote(n: number): string {
  if (n < 30) return 'FAR TOO FEW TRADES — this is noise, not a result';
  if (n < 100) return 'SMALL SAMPLE — directional at best';
  if (n < 300) return 'moderate sample — treat as provisional';
  return 'reasonable sample';
}

function print(stats: Stats): void {
  const pf = stats.profitFactor === Infinity ? 'inf' : stats.profitFactor.toFixed(2);

  console.log('='.repeat(74));
  console.log(stats.label);
  console.log('='.repeat(74));
  console.log(`  trades            ${stats.trades}   (${confidenceNote(stats.trades)})`);
  console.log(`  wins / losses     ${stats.wins} / ${stats.losses}`);
  console.log(`  win rate          ${stats.winRatePct.toFixed(1)}%`);
  console.log(`  avg win           ${stats.avgWinPct >= 0 ? '+' : ''}${stats.avgWinPct.toFixed(2)}%`);
  console.log(`  avg loss          ${stats.avgLossPct.toFixed(2)}%`);
  console.log(`  EXPECTANCY        ${stats.expectancyPct >= 0 ? '+' : ''}${stats.expectancyPct.toFixed(3)}% per trade`);
  console.log(`  profit factor     ${pf}`);
  console.log(`  total P&L         ${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(6)} SOL`);
  console.log(`  max drawdown      ${stats.maxDrawdownSol.toFixed(6)} SOL`);
  console.log(`  avg hold          ${stats.avgHoldSeconds.toFixed(0)}s`);
  console.log(`  exits             ${JSON.stringify(stats.exitReasons)}`);

  const verdict =
    stats.trades < 30
      ? 'INCONCLUSIVE — keep running'
      : stats.expectancyPct > 0
        ? 'POSITIVE expectancy on this sample'
        : 'NEGATIVE expectancy — this configuration loses money';

  console.log(`  verdict           ${verdict}`);
  console.log('');
}

/*
 * Grouping key for the report.
 *
 * Every parameter that can change the entry or exit decision must appear here.
 * A parameter that varies across trades but is absent from the key silently
 * pools two different strategies into one sample — which is precisely the
 * failure STRATEGY.md §7.2 exists to prevent, and it produces a confident
 * verdict about a configuration that was never actually run.
 */
/**
 * Every config field `configKey` interpolates.
 *
 * The journal schema has grown over time: records written by an older build
 * simply lack the fields added later. Interpolating a missing field yields the
 * literal string "undefined" in the group label, which reads like a config
 * that ran with filters disabled. It is not — it is a record that predates
 * those fields being journalled, and what the filters were set to is
 * unknowable from the journal alone.
 *
 * Those are different claims with opposite implications, so the report must
 * not silently present one as the other.
 */
const REQUIRED_CONFIG_KEYS = [
  'takeProfitPercent',
  'stopLossPercent',
  'trailingStopPercent',
  'maxHoldSeconds',
  'slippageBps',
  'maxPositionSol',
  'minRiskScore',
  'momentumConfirmEnabled',
  'minMomentumChangePct',
  'minBuyPressure',
  'maxMomentumVolatility',
  'maxMomentumDrawdownPct',
  'minMomentumSamples',
  'momentumWindowMs',
  'momentumIntervalMs',
] as const;

/** Config fields `configKey` would render as "undefined". */
function missingConfigKeys(config: Record<string, unknown>): string[] {
  if (config === null || typeof config !== 'object') {
    return [...REQUIRED_CONFIG_KEYS];
  }
  return REQUIRED_CONFIG_KEYS.filter((key) => config[key] === undefined);
}

function configKey(config: Record<string, unknown>): string {
  return [
    `tp=${config['takeProfitPercent']}`,
    `sl=${config['stopLossPercent']}`,
    `trail=${config['trailingStopPercent']}`,
    `hold=${config['maxHoldSeconds']}s`,
    `slip=${config['slippageBps']}bps`,
    `size=${config['maxPositionSol']}`,
    `risk=${config['minRiskScore']}`,
    `momentum=${config['momentumConfirmEnabled']}`,
    `minMove=${config['minMomentumChangePct']}%`,
    `bp=${config['minBuyPressure']}`,
    `vol=${config['maxMomentumVolatility']}`,
    `dd=${config['maxMomentumDrawdownPct']}%`,
    `n=${config['minMomentumSamples']}`,
    `win=${config['momentumWindowMs']}/${config['momentumIntervalMs']}ms`,
  ].join(' ');
}

function main(): void {
  const journalPath = path.resolve(
    process.env['TRADE_JOURNAL_PATH'] ?? 'data/trades.jsonl',
  );

  if (!fs.existsSync(journalPath)) {
    console.error(`No journal at ${journalPath}`);
    console.error('Run the bot in DRY_RUN and let some trades close first.');
    process.exit(1);
  }

  const trades: TradeRecord[] = [];
  let malformed = 0;

  for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      trades.push(JSON.parse(line) as TradeRecord);
    } catch {
      // A crash mid-append can leave one truncated line. Skip it rather
      // than discarding the whole journal.
      malformed += 1;
    }
  }

  if (malformed > 0) {
    console.warn(`(skipped ${malformed} malformed line(s))\n`);
  }

  if (trades.length === 0) {
    console.error('Journal is empty — no closed trades recorded yet.');
    process.exit(1);
  }

  const groupByRun = process.argv.includes('--by-run');
  const includeIncomplete = process.argv.includes('--include-incomplete');

  // Separate records whose config snapshot is incomplete. Their strategy
  // parameters are unknown, so they cannot be attributed to a configuration
  // and must not be pooled into one — including the combined total, which
  // would otherwise inherit the same ambiguity without saying so.
  const complete: TradeRecord[] = [];
  const incomplete: TradeRecord[] = [];
  const missingFieldCounts = new Map<string, number>();

  for (const trade of trades) {
    const missing = includeIncomplete ? [] : missingConfigKeys(trade.config ?? {});
    if (missing.length === 0) {
      complete.push(trade);
      continue;
    }
    incomplete.push(trade);
    for (const key of missing) {
      missingFieldCounts.set(key, (missingFieldCounts.get(key) ?? 0) + 1);
    }
  }

  if (incomplete.length > 0) {
    console.warn('='.repeat(74));
    console.warn(`QUARANTINED — ${incomplete.length} trade(s) with an incomplete config snapshot`);
    console.warn('='.repeat(74));
    console.warn('  These records predate one or more config fields being journalled.');
    console.warn('  Their actual strategy parameters are UNKNOWN, not disabled.');
    console.warn('  They are excluded from every group below, including the total.');
    console.warn('');
    for (const [key, count] of [...missingFieldCounts.entries()].sort()) {
      console.warn(`    missing ${key}  (${count} trade(s))`);
    }
    const runIds = [...new Set(incomplete.map((t) => t.runId.slice(0, 8)))];
    console.warn('');
    console.warn(`  affected run(s): ${runIds.join(', ')}`);
    console.warn('  re-run with --include-incomplete to pool them anyway (not advised)');
    console.warn('');
  }

  if (complete.length === 0) {
    console.error('No trades with a complete config snapshot — nothing can be attributed.');
    console.error('Re-run the bot on the current build, or use --include-incomplete.');
    process.exit(1);
  }

  const groups = new Map<string, TradeRecord[]>();
  for (const trade of complete) {
    // Group by configuration by default: that is the unit being evaluated.
    // Mixing settings produces an average that describes no real strategy.
    const key = groupByRun ? `run ${trade.runId.slice(0, 8)}` : configKey(trade.config);
    const bucket = groups.get(key);
    if (bucket) bucket.push(trade);
    else groups.set(key, [trade]);
  }

  console.log(`\n${complete.length} closed trades across ${groups.size} configuration(s)\n`);

  const sorted = [...groups.entries()].sort(
    (a, b) => computeStats('', b[1]).expectancyPct - computeStats('', a[1]).expectancyPct,
  );

  for (const [label, group] of sorted) {
    print(computeStats(label, group));
  }

  print(computeStats('ALL TRADES COMBINED (mixed settings — indicative only)', complete));
}

main();
