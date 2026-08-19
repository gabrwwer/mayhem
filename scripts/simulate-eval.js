const { NewLaunchHandler } = require('../apps/bot/dist/new-launch-handler.js');

(async () => {
  // Minimal stub implementations for dependencies
  const mayhemEngine = {
    emergencyExitToken: async (tokenMint, reason) => [],
  };

  const executionEngine = {
    getPrice: async (mint) => 1.0,
  };

  const config = {
    TRADING_ENABLED: true,
    DRY_RUN: true,
    MIN_LIQUIDITY_SOL: 0,
    MOMENTUM_CONFIRM_ENABLED: false,
    MAX_CONCURRENT_EVALUATIONS: 1,
    MIN_MOMENTUM_SAMPLES: 1,
  };

  const riskGate = {
    assess: async (input) => ({ score: 100, level: 'SAFE', canTrade: true }),
  };

  const circuitBreaker = {
    shouldBlock: () => ({ block: false }),
  };

  // telemetrySink optional; pass null
  const handler = new NewLaunchHandler(mayhemEngine, executionEngine, config, riskGate, circuitBreaker, null);

  const event = {
    tokenMint: 'TestMint11111111111111111111111111111111',
    isPumpFun: true,
    creator: 'unknown',
    creatorSource: 'simulated',
    createdAt: new Date(),
    poolAddress: null,
    quoteToken: null,
    initialLiquidity: 0,
    decimals: 9,
    name: null,
    symbol: null,
    supply: 0,
    supplyRaw: '0',
    mintAuthority: null,
    freezeAuthority: null,
    metadataUri: null,
    txSignature: 'FAKESIG123',
    source: 'solana-onchain',
  };

  console.log('Invoking NewLaunchHandler.handleNewToken');
  try {
    await handler.handleNewToken(event);
    console.log('Handler invocation complete');
  } catch (err) {
    console.error('Handler error:', err);
    process.exit(1);
  }
})();
