import { TokenSafetyScanner } from '@mayhem/risk-engine/scanner';
import { RiskConfig, TokenMetadata, PoolInfo, HolderInfo } from '@mayhem/risk-engine/types';

// --- Factories ---

function makeConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    minLiquiditySol: 5,
    maxTopHolderPercent: 20,
    minHolders: 10,
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    maxDailyLossSol: 1,
    maxExposureSol: 0.5,
    cooldownMs: 5000,
    emergencyStop: false,
    ...overrides,
  };
}

function makeToken(overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  return {
    mint: 'TokenMint111111111111111111111111111111111111',
    name: 'TestToken',
    symbol: 'TEST',
    decimals: 9,
    supply: 1_000_000_000,
    mintAuthority: null,
    freezeAuthority: null,
    metadata: { uri: 'https://example.com' },
    ...overrides,
  };
}

function makePool(overrides: Partial<PoolInfo> = {}): PoolInfo {
  return {
    address: 'PoolAddr1111111111111111111111111111111111111',
    tokenMint: 'TokenMint111111111111111111111111111111111111',
    liquiditySol: 50,
    liquidityToken: 500_000,
    price: 0.0001,
    volume24h: 100,
    active: true,
    ...overrides,
  };
}

function makeHolders(count: number, topPercent: number = 5): HolderInfo[] {
  const holders: HolderInfo[] = [];
  const remaining = 100 - topPercent;
  holders.push({ address: 'TopHolder1', percentage: topPercent });
  for (let i = 1; i < count; i++) {
    holders.push({ address: `Holder${i}`, percentage: remaining / (count - 1) });
  }
  return holders;
}

// --- Tests ---

describe('TokenSafetyScanner', () => {
  it('returns SAFE for a well-configured token', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const result = scanner.scan(makeToken(), makePool(), makeHolders(20, 5));

    expect(result.level).toBe('SAFE');
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.checks.every(c => c.passed)).toBe(true);
    expect(result.tokenMint).toBe('TokenMint111111111111111111111111111111111111');
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('BLOCKS when mint authority is not revoked', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const token = makeToken({ mintAuthority: 'SomeAuthority111' });
    const result = scanner.scan(token, makePool(), makeHolders(20, 5));

    const mintCheck = result.checks.find(c => c.name === 'mint_authority');
    expect(mintCheck!.passed).toBe(false);

    // Previously this only cost 20 of 100 weighted points, so a token with
    // a live mint authority could still score 80 and be labelled SAFE.
    // Safety checks veto now: a live mint authority is a total block.
    expect(result.level).toBe('BLOCKED');
    expect(result.score).toBe(0);
  });

  it('BLOCKS when freeze authority is not revoked', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const token = makeToken({ freezeAuthority: 'SomeFreezer111' });
    const result = scanner.scan(token, makePool(), makeHolders(20, 5));

    const freezeCheck = result.checks.find(c => c.name === 'freeze_authority');
    expect(freezeCheck!.passed).toBe(false);
    expect(result.level).toBe('BLOCKED');
    expect(result.score).toBe(0);
  });

  it('returns BLOCKED when liquidity is below minimum', () => {
    const scanner = new TokenSafetyScanner(makeConfig({ minLiquiditySol: 100 }));
    const token = makeToken({ mintAuthority: 'x', freezeAuthority: 'y' });
    const pool = makePool({ liquiditySol: 1 });
    // No holders -> fewer checks -> more weight on failing ones
    const result = scanner.scan(token, pool);

    // mint(20)+freeze(15)+liquidity(20)+pool_status(10)+supply(5)+metadata(5) = 75 total
    // only supply(5)+metadata(5)+pool_status(10) pass = 20/75 = 26 -> BLOCKED
    expect(result.level).toBe('BLOCKED');
    expect(result.score).toBeLessThan(40);
  });

  it('returns CAUTION when top holder has >20%', () => {
    const scanner = new TokenSafetyScanner(makeConfig({ maxTopHolderPercent: 20 }));
    const holders = makeHolders(15, 25);
    const result = scanner.scan(makeToken(), makePool(), holders);

    const holderCheck = result.checks.find(c => c.name === 'holder_concentration');
    expect(holderCheck!.passed).toBe(false);
    expect(holderCheck!.value).toBe(25);
  });

  it('returns CAUTION when holder count is low', () => {
    const scanner = new TokenSafetyScanner(makeConfig({ minHolders: 50 }));
    const holders = makeHolders(10, 5);
    const result = scanner.scan(makeToken(), makePool(), holders);

    const countCheck = result.checks.find(c => c.name === 'holder_count');
    expect(countCheck!.passed).toBe(false);
    expect(countCheck!.value).toBe(10);
  });

  it('correctly calculates weighted risk score when every check passes', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    // Holder data must be supplied: absent concentration data is now
    // recorded as a FAILED check rather than silently skipped, because
    // "we could not measure concentration" is not evidence of safety.
    const result = scanner.scan(makeToken(), makePool(), makeHolders(20, 5));
    expect(result.score).toBe(100);
    expect(result.level).toBe('SAFE');
  });

  it('BLOCKS when holder data is unavailable rather than skipping the check', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const result = scanner.scan(makeToken(), makePool());

    const holderCheck = result.checks.find(c => c.name === 'holder_concentration');
    expect(holderCheck!.passed).toBe(false);
    expect(result.level).toBe('BLOCKED');
  });

  it('handles missing/null metadata gracefully', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const token = makeToken({ name: '', symbol: '' });
    const result = scanner.scan(token, makePool());

    const metaCheck = result.checks.find(c => c.name === 'metadata');
    expect(metaCheck!.passed).toBe(false);
    expect(metaCheck!.message).toContain('missing');
  });

  it('passes mint/freeze checks when config does not require revocation', () => {
    const scanner = new TokenSafetyScanner(
      makeConfig({ requireMintAuthorityRevoked: false, requireFreezeAuthorityRevoked: false }),
    );
    const token = makeToken({ mintAuthority: 'Active', freezeAuthority: 'Active' });
    const result = scanner.scan(token, makePool());

    const mintCheck = result.checks.find(c => c.name === 'mint_authority');
    const freezeCheck = result.checks.find(c => c.name === 'freeze_authority');
    expect(mintCheck!.passed).toBe(true);
    expect(freezeCheck!.passed).toBe(true);
  });

  it('marks inactive pool as failed', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const pool = makePool({ active: false });
    const result = scanner.scan(makeToken(), pool);

    const poolCheck = result.checks.find(c => c.name === 'pool_status');
    expect(poolCheck!.passed).toBe(false);
  });

  it('marks unreasonable supply as failed', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const token = makeToken({ supply: 0 });
    const result = scanner.scan(token, makePool());

    const supplyCheck = result.checks.find(c => c.name === 'supply');
    expect(supplyCheck!.passed).toBe(false);
  });
});