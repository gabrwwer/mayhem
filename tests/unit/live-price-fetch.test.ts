import { SimulatedExecutionEngine } from '../../packages/execution/src/simulator';

describe('SimulatedExecutionEngine live price fetch', () => {
  test('fetches a real price from Jupiter for a known token mint', async () => {
    const sim = new SimulatedExecutionEngine({
      slippageBps: 0,
      failureRate: 0,
      initialSolBalance: 10,
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    const tokenMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const price = await sim.getPrice(tokenMint);

    expect(price).toBeGreaterThan(0);
    expect(price).toBeLessThan(1);
  }, 30000);
});