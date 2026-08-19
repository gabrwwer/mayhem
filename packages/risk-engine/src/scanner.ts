
import { RiskConfig, RiskAssessment, RiskCheck, RiskLevel, TokenMetadata, PoolInfo, HolderInfo } from './types';

/**
 * Checks that VETO the trade outright when they fail.
 *
 * A purely weighted score is the wrong model for safety properties. With
 * weights alone, a token whose mint authority is still live scores 80/100
 * ("SAFE") as long as everything else passes — i.e. the single check that
 * most reliably identifies an infinite-mint rug could be outvoted by
 * cosmetics like "has a name and symbol". Failing any of these forces
 * BLOCKED regardless of score.
 */
const VETO_CHECKS: ReadonlySet<string> = new Set([
  'mint_authority',
  'freeze_authority',
  'liquidity_amount',
  'pool_status',
  'holder_concentration',
]);

export class TokenSafetyScanner {
  private config: RiskConfig;

  constructor(config: RiskConfig) {
    this.config = config;
  }

  scan(
    token: TokenMetadata,
    pool: PoolInfo,
    holders?: HolderInfo[],
    options?: {
      /**
       * Set false when holder concentration is genuinely not measurable or
       * not meaningful for this venue, rather than merely missing.
       *
       * The distinction matters. Absent-but-expected data must FAIL, because
       * "we couldn't check" is not evidence of safety. But for a
       * pre-graduation pump.fun token, `getTokenLargestAccounts` rejects the
       * mint outright (it does not support Token-2022) AND the bonding-curve
       * PDA legitimately holds nearly the entire supply — so a concentration
       * number would be both unobtainable and meaningless.
       *
       * Failing that check made the gate reject 100% of pump.fun launches.
       * Skipping it is honest; silently passing it would not be. Callers
       * must re-apply concentration analysis after graduation, when the
       * supply is distributed and the metric means something again.
       */
      concentrationApplicable?: boolean;

      /**
       * The one mint authority that is acceptable for this token, if any.
       *
       * Exists for pre-graduation pump.fun mints, whose authority is held by
       * the token's own bonding-curve PDA until migration. That address is
       * derived deterministically from the mint and is controlled by the
       * pump.fun program, not by a person — nobody can use it to mint supply
       * into their own wallet. Vetoing it rejected 100% of the target
       * universe for a risk that did not exist.
       *
       * This deliberately does NOT disable the check. An authority that is
       * absent (revoked) still passes; an authority matching this value
       * passes; ANY other authority — including a deployer keypair that
       * happens to hold it — still vetoes. Callers must derive this value
       * themselves and must never pass an address they have not derived from
       * the mint, or the check degrades to "trust whatever we were told".
       */
      expectedMintAuthority?: string | null;
    },
  ): RiskAssessment {
    const checks: RiskCheck[] = [
      this.checkMintAuthority(token, options?.expectedMintAuthority ?? null),
      this.checkFreezeAuthority(token),
      this.checkLiquidityAmount(pool),
      this.checkPoolStatus(pool),
      this.checkSupply(token),
      this.checkMetadata(token),
    ];

    const concentrationApplicable = options?.concentrationApplicable ?? true;

    if (holders && holders.length > 0) {
      checks.push(this.checkHolderConcentration(holders));
      checks.push(this.checkHolderCount(holders));
    } else if (concentrationApplicable) {
      // Absent holder data is not the same as safe holder data. Record an
      // explicit failed check so the caller can see *why* it was blocked
      // instead of the token quietly skipping concentration analysis.
      checks.push({
        name: 'holder_concentration',
        passed: false,
        value: null,
        threshold: this.config.maxTopHolderPercent,
        message: 'No holder data available — cannot verify concentration',
      });
    }
    // else: the caller has declared concentration inapplicable for this
    // venue. No check is recorded at all — deliberately not a passing one,
    // so the assessment never claims concentration was verified.

    const score = this.calculateScore(checks);
    const vetoed = checks.filter((c) => VETO_CHECKS.has(c.name) && !c.passed);
    const level: RiskLevel = vetoed.length > 0 ? 'BLOCKED' : this.scoreToLevel(score);

    return {
      tokenMint: token.mint,
      level,
      // A vetoed token must not carry a passing score downstream; callers
      // that compare `score >= MIN_RISK_SCORE` would otherwise let it in.
      score: vetoed.length > 0 ? 0 : score,
      checks,
      timestamp: new Date(),
    };
  }

  /** Names of the checks that force a BLOCKED verdict when they fail. */
  static vetoChecks(): string[] {
    return [...VETO_CHECKS];
  }

  private checkMintAuthority(
    token: TokenMetadata,
    expectedMintAuthority: string | null,
  ): RiskCheck {
    const revoked = token.mintAuthority === null;

    /*
     * A program-derived authority is not a discretionary one.
     *
     * `expectedMintAuthority` is only ever the token's own bonding-curve PDA,
     * derived from the mint by the caller. Matching it means the authority is
     * held by the pump.fun program on this specific mint's behalf — there is
     * no keypair for it, so no one can sign a mint instruction with it.
     *
     * The equality is strict and the fallback is the original rule, so a null,
     * empty, or mismatched expectation cannot widen what passes.
     */
    const heldByExpectedProgramAccount =
      expectedMintAuthority !== null &&
      expectedMintAuthority.length > 0 &&
      token.mintAuthority === expectedMintAuthority;

    const acceptable = revoked || heldByExpectedProgramAccount;

    return {
      name: 'mint_authority',
      passed: this.config.requireMintAuthorityRevoked ? acceptable : true,
      value: token.mintAuthority,
      threshold: expectedMintAuthority,
      message: revoked
        ? 'Mint authority revoked'
        : heldByExpectedProgramAccount
          ? 'Mint authority held by the token bonding-curve PDA (no keypair exists for it)'
          : 'Mint authority still active and externally controlled',
    };
  }

  private checkFreezeAuthority(token: TokenMetadata): RiskCheck {
    const revoked = token.freezeAuthority === null;
    return {
      name: 'freeze_authority',
      passed: this.config.requireFreezeAuthorityRevoked ? revoked : true,
      value: token.freezeAuthority,
      threshold: null,
      message: revoked ? 'Freeze authority revoked' : 'Freeze authority still active',
    };
  }

  private checkLiquidityAmount(pool: PoolInfo): RiskCheck {
    return {
      name: 'liquidity_amount',
      passed: pool.liquiditySol >= this.config.minLiquiditySol,
      value: pool.liquiditySol,
      threshold: this.config.minLiquiditySol,
      message: pool.liquiditySol >= this.config.minLiquiditySol
        ? `Liquidity ${pool.liquiditySol} SOL sufficient`
        : `Liquidity ${pool.liquiditySol} SOL below minimum ${this.config.minLiquiditySol} SOL`,
    };
  }

  private checkHolderConcentration(holders: HolderInfo[]): RiskCheck {
    if (holders.length === 0) {
      return {
        name: 'holder_concentration',
        passed: false,
        value: 0,
        threshold: this.config.maxTopHolderPercent,
        message: 'No holder data available',
      };
    }
    const topHolder = holders.reduce(
      (max, h) => (h.percentage > max.percentage ? h : max),
      holders[0]!,
    );
    return {
      name: 'holder_concentration',
      passed: topHolder.percentage <= this.config.maxTopHolderPercent,
      value: topHolder.percentage,
      threshold: this.config.maxTopHolderPercent,
      message: topHolder.percentage > this.config.maxTopHolderPercent
        ? `Top holder owns ${topHolder.percentage}%, exceeds max ${this.config.maxTopHolderPercent}%`
        : `Top holder owns ${topHolder.percentage}%`,
    };
  }

  private checkHolderCount(holders: HolderInfo[]): RiskCheck {
    return {
      name: 'holder_count',
      passed: holders.length >= this.config.minHolders,
      value: holders.length,
      threshold: this.config.minHolders,
      message: holders.length < this.config.minHolders
        ? `Only ${holders.length} holders, below minimum ${this.config.minHolders}`
        : `${holders.length} holders`,
    };
  }

  private checkSupply(token: TokenMetadata): RiskCheck {
    const reasonable = token.supply > 0 && token.supply < 1e18;
    return {
      name: 'supply',
      passed: reasonable,
      value: token.supply,
      threshold: '0 < supply < 1e18',
      message: reasonable ? 'Supply within reasonable range' : 'Supply outside reasonable range',
    };
  }

  private checkMetadata(token: TokenMetadata): RiskCheck {
    const hasMetadata = token.name.length > 0 && token.symbol.length > 0;
    return {
      name: 'metadata',
      passed: hasMetadata,
      value: { name: token.name, symbol: token.symbol },
      threshold: 'non-empty name and symbol',
      message: hasMetadata ? 'Token has valid metadata' : 'Token missing name or symbol',
    };
  }

  private checkPoolStatus(pool: PoolInfo): RiskCheck {
    return {
      name: 'pool_status',
      passed: pool.active,
      value: pool.active,
      threshold: true,
      message: pool.active ? 'Pool is active' : 'Pool is inactive',
    };
  }

  private calculateScore(checks: RiskCheck[]): number {
    if (checks.length === 0) return 0;

    const weights: Record<string, number> = {
      mint_authority: 20,
      freeze_authority: 15,
      liquidity_amount: 20,
      holder_concentration: 15,
      holder_count: 10,
      supply: 5,
      metadata: 5,
      pool_status: 10,
    };

    let totalWeight = 0;
    let earnedWeight = 0;

    for (const check of checks) {
      const weight = weights[check.name] ?? 10;
      totalWeight += weight;
      if (check.passed) {
        earnedWeight += weight;
      }
    }

    return totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
  }

  private scoreToLevel(score: number): RiskLevel {
    if (score >= 80) return 'SAFE';
    if (score >= 60) return 'CAUTION';
    if (score >= 40) return 'HIGH_RISK';
    return 'BLOCKED';
  }
}