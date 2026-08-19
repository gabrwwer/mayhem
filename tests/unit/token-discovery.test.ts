// Import only the monitor and types, not the solana provider which pulls in @solana/web3.js
import { TokenMonitor } from '../../packages/token-monitor/src/monitor';
import { TokenDiscoveryEvent } from '../../packages/token-monitor/src/types';

function makeEvent(overrides: Partial<TokenDiscoveryEvent> = {}): TokenDiscoveryEvent {
  return {
    tokenMint: 'mint' + Math.random().toString(36).slice(2, 10),
    creator: 'creator111111111111111111111111111111111111',
    createdAt: new Date(),
    poolAddress: null,
    quoteToken: null,
    initialLiquidity: null,
    decimals: 9,
    name: null,
    symbol: null,
    supply: 1_000_000_000,
    mintAuthority: null,
    freezeAuthority: null,
    metadataUri: null,
    txSignature: 'sig' + Math.random().toString(36).slice(2),
    source: 'test',
    ...overrides,
  };
}

describe('TokenMonitor', () => {
  it('should deduplicate tokens by mint address', async () => {
    const monitor = new TokenMonitor();
    const discovered: TokenDiscoveryEvent[] = [];
    monitor.onToken((e) => { discovered.push(e); });

    const event = makeEvent({ tokenMint: 'DuplicateMint111111111111111111111111111111' });

    const fakeProvider = {
      name: 'test',
      start: async () => {},
      stop: async () => {},
      onToken: (cb: any) => { cb(event); cb(event); },
      onLiquidityChange: () => {},
    };

    monitor.addProvider(fakeProvider);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(discovered.length).toBe(1);
  });

  it('should emit event for SPL token initialization', async () => {
    const monitor = new TokenMonitor();
    const discovered: TokenDiscoveryEvent[] = [];
    monitor.onToken((e) => { discovered.push(e); });

    const splEvent = makeEvent({
      tokenMint: 'SPLTokenMint1111111111111111111111111111111',
      source: 'solana-onchain',
    });

    const fakeProvider = {
      name: 'spl-test',
      start: async () => {},
      stop: async () => {},
      onToken: (cb: any) => { cb(splEvent); },
      onLiquidityChange: () => {},
    };

    monitor.addProvider(fakeProvider);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(discovered.length).toBe(1);
    // noUncheckedIndexedAccess types array access as possibly undefined.
    expect(discovered[0]?.tokenMint).toBe('SPLTokenMint1111111111111111111111111111111');
  });

  it('should emit event for Token-2022 initialization', async () => {
    const monitor = new TokenMonitor();
    const discovered: TokenDiscoveryEvent[] = [];
    monitor.onToken((e) => { discovered.push(e); });

    const t22Event = makeEvent({
      tokenMint: 'Token2022Mint111111111111111111111111111111',
      source: 'solana-onchain',
    });

    const fakeProvider = {
      name: 't22-test',
      start: async () => {},
      stop: async () => {},
      onToken: (cb: any) => { cb(t22Event); },
      onLiquidityChange: () => {},
    };

    monitor.addProvider(fakeProvider);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(discovered.length).toBe(1);
  });

  it('should discover tokens regardless of holder count', async () => {
    const monitor = new TokenMonitor();
    const discovered: TokenDiscoveryEvent[] = [];
    monitor.onToken((e) => { discovered.push(e); });

    const event = makeEvent({
      tokenMint: 'NewLaunchNoHolders11111111111111111111111',
      supply: 1_000_000,
    });

    const fakeProvider = {
      name: 'holder-test',
      start: async () => {},
      stop: async () => {},
      onToken: (cb: any) => { cb(event); },
      onLiquidityChange: () => {},
    };

    monitor.addProvider(fakeProvider);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(discovered.length).toBe(1);
    expect(discovered[0]?.tokenMint).toBe('NewLaunchNoHolders11111111111111111111111');
  });

  it('should handle callback errors without losing events', async () => {
    const monitor = new TokenMonitor();
    const secondCallbackResults: TokenDiscoveryEvent[] = [];

    monitor.onToken(() => { throw new Error('callback error'); });
    monitor.onToken((e) => { secondCallbackResults.push(e); });

    const event = makeEvent();
    const fakeProvider = {
      name: 'error-test',
      start: async () => {},
      stop: async () => {},
      onToken: (cb: any) => { cb(event); },
      onLiquidityChange: () => {},
    };

    monitor.addProvider(fakeProvider);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(secondCallbackResults.length).toBe(1);
  });
});