import { SimulatedExecutionEngine } from '../../packages/execution/src/simulator';
import { parseAmount } from '../../packages/trading-engine/src/calculations';

describe('SimulatedExecutionEngine', () => {
  let sim: SimulatedExecutionEngine;

  beforeEach(() => {
    sim = new SimulatedExecutionEngine({ initialSolBalance: 10, failureRate: 0, slippageBps: 100 });
  });

  test('quoteBuy returns valid simulated quote', async () => {
    const quote = await sim.quoteBuy('MINT1', '0.05');
    expect(quote.inputAmount).toBe('0.05');
    expect(parseAmount(quote.outputAmount).greaterThan(0)).toBe(true);
    expect(parseAmount(quote.pricePerToken).greaterThan(0)).toBe(true);
    expect(quote.route).toBe('simulated-paper');
  });

  test('quoteSell returns valid simulated quote', async () => {
    const quote = await sim.quoteSell('MINT1', '1000');
    expect(quote.inputAmount).toBe('1000');
    expect(parseAmount(quote.outputAmount).greaterThan(0)).toBe(true);
  });

  test('signAndSendTransaction returns fake signature', async () => {
    const quote = await sim.quoteBuy('MINT1', '0.05');
    const result = await sim.signAndSendTransaction(quote);
    expect(result.signature).toMatch(/^sim-/);
    expect(result.status).toBe('confirmed');
    expect(result.error).toBeNull();
  });

  test('balance decreases after buy', async () => {
    const before = sim.getBalance();
    const quote = await sim.quoteBuy('MINT1', '1');
    await sim.signAndSendTransaction(quote);
    const after = sim.getBalance();
    expect(after).toBeLessThan(before);
  });

  test('100% failure rate causes all transactions to fail', async () => {
    const failSim = new SimulatedExecutionEngine({ initialSolBalance: 10, failureRate: 1, slippageBps: 100 });
    const quote = await failSim.quoteBuy('MINT1', '0.05');
    const result = await failSim.signAndSendTransaction(quote);
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });

  test('simulatePrice generates value within expected range', () => {
    const prices: number[] = [];
    for (let i = 0; i < 100; i++) {
      prices.push(sim.simulatePrice('MINT1', 1.0, 0.05));
    }
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(5);
  });
});
