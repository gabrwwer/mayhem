const { SolanaTokenProvider } = require('../packages/token-monitor/dist/solana-provider.js');

process.env.API_URL = process.env.API_URL || 'http://127.0.0.1:3001';
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'internalsecret';
process.env.API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || 'testtoken';

async function main() {
  // Instantiate with dummy RPC; we'll override getMintInfo to avoid network calls.
  const provider = new SolanaTokenProvider('http://localhost:8899', { pollingEnabled: false, subscriptionsEnabled: true });

  // Monkey-patch getMintInfo to avoid RPC calls during simulation.
  provider.getMintInfo = async (mint) => ({
    decimals: 9,
    supply: 0,
    supplyRaw: '0',
    mintAuthority: null,
    freezeAuthority: null,
  });

  const tx = { blockTime: Math.floor(Date.now() / 1000) };

  console.log('Simulating token discovery...');
  await provider.emitTokenEvent('TestMint11111111111111111111111111111111', 'FAKESIG123', tx);

  // Allow background POST to complete and logs to flush.
  await new Promise((r) => setTimeout(r, 2500));

  console.log('Simulation complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
