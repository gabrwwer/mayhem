/**
 * Regression tests for the scoped mint-authority veto (audit finding F1).
 *
 * Context: `requireMintAuthorityRevoked` vetoed every pre-graduation pump.fun
 * token, because such a mint's authority is held by its own bonding-curve PDA
 * until migration. That rejected 100% of the target universe for a risk that
 * does not exist — the PDA is a program account with no keypair, so nobody can
 * sign a mint instruction with it.
 *
 * The fix narrows the check rather than disabling it. These tests exist to stop
 * that narrowing from ever widening: the ONLY additional authority that may
 * pass is the exact address the caller derived from the mint. A deployer
 * keypair holding mint authority must still veto, or the check is worthless.
 */

import { TokenSafetyScanner } from '@mayhem/risk-engine/scanner';
import { RiskConfig, TokenMetadata, PoolInfo } from '@mayhem/risk-engine/types';

const CURVE_PDA = 'BondingCurvePda11111111111111111111111111111';
const DEPLOYER = 'DeployerKeypair11111111111111111111111111111';

function makeConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    minLiquiditySol: 0,
    maxTopHolderPercent: 20,
    minHolders: 0,
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
    decimals: 6,
    supply: 1_000_000_000,
    mintAuthority: null,
    freezeAuthority: null,
    metadata: { uri: 'https://example.com' },
    ...overrides,
  };
}

function makePool(overrides: Partial<PoolInfo> = {}): PoolInfo {
  return {
    address: '',
    tokenMint: 'TokenMint111111111111111111111111111111111111',
    liquiditySol: 0,
    liquidityToken: 0,
    price: 0.0001,
    volume24h: 0,
    active: true,
    ...overrides,
  };
}

function mintCheck(scanner: TokenSafetyScanner, token: TokenMetadata, expected?: string | null) {
  const result = scanner.scan(token, makePool(), undefined, {
    concentrationApplicable: false,
    ...(expected !== undefined ? { expectedMintAuthority: expected } : {}),
  });
  return {
    check: result.checks.find((c) => c.name === 'mint_authority')!,
    result,
  };
}

describe('mint authority veto — scoped to the derived bonding-curve PDA', () => {
  it('PASSES when the authority is the expected curve PDA', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const { check, result } = mintCheck(
      scanner,
      makeToken({ mintAuthority: CURVE_PDA }),
      CURVE_PDA,
    );

    expect(check.passed).toBe(true);
    expect(result.level).not.toBe('BLOCKED');
    expect(result.score).toBeGreaterThan(0);
  });

  it('still VETOES a deployer-controlled authority even when an expectation is supplied', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const { check, result } = mintCheck(
      scanner,
      makeToken({ mintAuthority: DEPLOYER }),
      CURVE_PDA,
    );

    expect(check.passed).toBe(false);
    expect(result.level).toBe('BLOCKED');
    // A vetoed token must not carry a passing score downstream.
    expect(result.score).toBe(0);
  });

  it('PASSES a revoked (null) authority regardless of expectation', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    expect(mintCheck(scanner, makeToken(), CURVE_PDA).check.passed).toBe(true);
    expect(mintCheck(scanner, makeToken(), null).check.passed).toBe(true);
    expect(mintCheck(scanner, makeToken()).check.passed).toBe(true);
  });

  it('preserves the original rule when no expectation is supplied', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const { check, result } = mintCheck(scanner, makeToken({ mintAuthority: CURVE_PDA }));

    // Same address, but the caller did not vouch for it — must still veto.
    expect(check.passed).toBe(false);
    expect(result.level).toBe('BLOCKED');
  });

  it('cannot be widened by an empty or null expectation', () => {
    const scanner = new TokenSafetyScanner(makeConfig());

    expect(mintCheck(scanner, makeToken({ mintAuthority: DEPLOYER }), '').check.passed).toBe(false);
    expect(mintCheck(scanner, makeToken({ mintAuthority: DEPLOYER }), null).check.passed).toBe(false);
    // An empty on-chain authority string must not match an empty expectation.
    expect(mintCheck(scanner, makeToken({ mintAuthority: '' }), '').check.passed).toBe(false);
  });

  it('matches exactly — no prefix, case, or whitespace tolerance', () => {
    const scanner = new TokenSafetyScanner(makeConfig());

    expect(
      mintCheck(scanner, makeToken({ mintAuthority: CURVE_PDA.toLowerCase() }), CURVE_PDA)
        .check.passed,
    ).toBe(false);
    expect(
      mintCheck(scanner, makeToken({ mintAuthority: CURVE_PDA.slice(0, -1) }), CURVE_PDA)
        .check.passed,
    ).toBe(false);
    expect(
      mintCheck(scanner, makeToken({ mintAuthority: ` ${CURVE_PDA}` }), CURVE_PDA).check.passed,
    ).toBe(false);
  });

  it('does not affect the freeze-authority veto', () => {
    const scanner = new TokenSafetyScanner(makeConfig());
    const result = scanner.scan(
      makeToken({ mintAuthority: CURVE_PDA, freezeAuthority: DEPLOYER }),
      makePool(),
      undefined,
      { concentrationApplicable: false, expectedMintAuthority: CURVE_PDA },
    );

    expect(result.checks.find((c) => c.name === 'freeze_authority')!.passed).toBe(false);
    expect(result.level).toBe('BLOCKED');
  });
});
