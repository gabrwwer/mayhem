/*
 * One complete paper trade, offline.
 *
 * WHAT THIS IS
 * ------------
 * A deterministic walk-through of the real trading pipeline: the actual
 * MayhemEngine, the actual PositionManager, the actual
 * SimulatedExecutionEngine. No mocks, no stubs — the same classes the bot
 * runs. It drives one token from entry, up through the profit-lock ladder,
 * to a take-profit exit, and prints the resulting P&L.
 *
 * It makes ZERO network calls. No RPC, no discovery, no API, no dashboard.
 * Everything that has been blocking a first trade is removed from the path,
 * so what remains is a straight answer to one question: does the
 * entry -> ladder -> exit -> P&L machinery work?
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT evidence that the strategy is profitable. The price path is
 * scripted — the token goes up because this file says so. A profitable
 * trade here proves the plumbing computes P&L correctly; it says nothing
 * about whether real tokens go up. Only a live paper run over time can
 * answer that, and that is the week-long step, not this one.
 *
 * Run:
 *   pnpm exec ts-node --transpile-only scripts/development/paper-demo.ts
 */

import { SimulatedExecutionEngine } from '@mayhem/execution';
import {
  MayhemEngine,
  PositionManager,
  type TradingConfig,
} from '@mayhem/trading-engine';

const MINT = 'DemoPaperTradeMint1111111111111111111111111';
const ENTRY_PRICE = 0.00001;

const config: TradingConfig = {
  entryEnabled: true,
  maxPositionSol: 0.1,
  takeProfitPercent: 20,
  profitMonitorActivationPercent: 5,
  profitLockActivationPercent: 10,
  profitLockPercent: 50,
  trailingActivationPercent: 15,
  aggressiveTrailingActivationPercent: 20,
  stopLossPercent: 10,
  hardStopLossPercent: 10,
  trailingStopPercent: 8,
  maxHoldSeconds: 3_600,
  maxOpenPositions: 3,
  entryDelayMs: 0,
  newLaunchMode: true,
  maxQuoteAgeMs: 5_000,
  maxSellPriceImpactPercent: 50,
  exitRetryMaxAttempts: 3,
  exitRetryDelayMs: 0,
  minRiskScore: 80,
  maxLiquidityParticipationBps: 100,
  maxPriceAgeMs: 60_000,
  takeProfitRetryDelayMs: 0,
};

function line(): void {
  console.log('-'.repeat(72));
}

async function main(): Promise<void> {
  // No rpcUrl: prices come from the in-memory simulator, not the network.
  const execution = new SimulatedExecutionEngine({
    slippageBps: 100,
    failureRate: 0,
    initialSolBalance: 10,
    volatility: 0,
  });

  const positions = new PositionManager(config);
  const engine = new MayhemEngine(config, positions, execution, {});

  execution.setPrice(MINT, ENTRY_PRICE);

  line();
  console.log('PAPER TRADE DEMO — no network calls');
  console.log(`starting balance : ${execution.getBalance()} SOL`);
  console.log(`entry price      : ${ENTRY_PRICE}`);
  line();

  // ---- Entry -------------------------------------------------------
  // riskScore 100 stands in for a token that passed the gate; the gate
  // itself is exercised by tests/unit/token-safety-scanner.test.ts.
  //
  // Liquidity must be a real positive figure: evaluateToken now fails closed
  // on unmeasurable liquidity, so the previous `0` here would skip the entry
  // and the demo would exit non-zero. Sized so the 1% participation cap is
  // not the binding constraint — maxPositionSol is.
  const DEMO_LIQUIDITY_SOL = 1_000;
  const signal = engine.evaluateToken(MINT, ENTRY_PRICE, DEMO_LIQUIDITY_SOL, 100);

  if (!signal) {
    console.error('FAILED: evaluateToken produced no signal');
    process.exit(1);
  }

  console.log(`SIGNAL     size=${signal.amount} SOL @ ${signal.price}`);

  const position = await engine.executeEntry(signal);

  if (!position) {
    console.error('FAILED: executeEntry did not open a position');
    process.exit(1);
  }

  console.log(
    `ENTRY      qty=${position.quantity.toFixed(2)} ` +
      `@ ${position.actualEntryPrice.toExponential(4)} ` +
      `cost=${position.entryNotional.toFixed(6)} SOL`,
  );
  console.log(
    `           stopLoss=${position.stopLoss.toExponential(4)} ` +
      `takeProfit=${position.takeProfit.toExponential(4)}`,
  );
  line();

  // ---- Price path --------------------------------------------------
  // Stepped upward so the profit-lock ladder engages before the exit.
  // Each step runs a real monitorPositions() tick.
  const path = [1.05, 1.12, 1.18, 1.22, 1.28];

  for (const multiple of path) {
    const price = ENTRY_PRICE * multiple;
    execution.setPrice(MINT, price);

    await engine.monitorPositions();

    const live = positions.getPosition(position.id);
    if (!live) break;

    const pnlPct =
      ((price - live.actualEntryPrice) / live.actualEntryPrice) * 100;

    console.log(
      `TICK  ${String(Math.round((multiple - 1) * 100)).padStart(3)}%  ` +
        `price=${price.toExponential(4)}  ` +
        `stop=${live.stopLoss.toExponential(4)}  ` +
        `lock=${live.highestLockPercent}%  ` +
        `unrealised=${live.unrealizedPnl.toFixed(6)} SOL  ` +
        `(${pnlPct.toFixed(1)}%)`,
    );

    if (live.status === 'closed') break;
  }

  line();

  // ---- Result ------------------------------------------------------
  const finished = positions.getPosition(position.id);

  if (!finished) {
    console.error('FAILED: position vanished');
    process.exit(1);
  }

  if (finished.status !== 'closed') {
    console.log('Position still open at end of price path.');
    console.log(`  status         : ${finished.status}`);
    console.log(`  unrealised P&L : ${finished.unrealizedPnl.toFixed(6)} SOL`);
    console.log(
      '\nThe ladder and stop are working, but no exit condition fired. ' +
        'Extend the price path or lower takeProfitPercent.',
    );
    process.exit(1);
  }

  console.log('TRADE CLOSED');
  console.log(`  reason         : ${finished.exitReason}`);
  console.log(`  entry          : ${finished.actualEntryPrice.toExponential(4)}`);
  console.log(`  exit           : ${finished.currentPrice.toExponential(4)}`);
  console.log(`  gross P&L      : ${finished.grossPnl.toFixed(6)} SOL`);
  console.log(`  fees           : ${finished.fees.toFixed(6)} SOL`);
  console.log(`  NET P&L        : ${finished.netPnl.toFixed(6)} SOL`);
  console.log(`  return         : ${finished.netPnlPercent.toFixed(2)}%`);
  console.log(`  final balance  : ${execution.getBalance().toFixed(6)} SOL`);
  line();

  if (finished.netPnl > 0) {
    console.log('RESULT: profitable paper trade completed.');
    console.log(
      '\nNote: the price path in this file is scripted. This proves the\n' +
        'entry/ladder/exit/P&L pipeline computes correctly — NOT that the\n' +
        'strategy makes money on real tokens.',
    );
    process.exit(0);
  }

  console.log('RESULT: trade closed at a LOSS — pipeline works, path was unfavourable.');
  process.exit(1);
}

main().catch((error) => {
  console.error('Demo failed:', error);
  process.exit(1);
});
