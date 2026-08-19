import { describe, it, expect } from 'vitest';

import { BotConfigSchema } from '@mayhem/config';

/**
 * Regression suite for docs/audits/CONFIG_AUDIT.md F1.
 *
 * FlatEnvSchema exposes four aliased pairs, resolved in the transform as
 * `PRIMARY ?? LEGACY ?? default`. If a `.default()` is ever added back to
 * either side, the `??` becomes unreachable and the legacy key silently stops
 * working — while still producing a plausible number, so nothing looks wrong.
 *
 * That defect ran in production: MAX_POSITION_SOL defaulted to 0.5, so
 * SNIPE_POSITION_SOL could never take effect, and the bot traded at 0.5 SOL
 * while its own configuration and documentation said 0.05 — a size the project
 * documents as unprofitable by construction.
 *
 * These tests exist to make that failure mode loud.
 */

const LAMPORTS_PER_SOL = 1e9;

/** Minimum env for the schema to parse; every field under test is absent. */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...overrides };
}

describe('F1: aliased config keys resolve through the fallback chain', () => {
  describe('position size', () => {
    it('uses MAX_POSITION_SOL when only it is set', () => {
      const cfg = BotConfigSchema.parse(baseEnv({ MAX_POSITION_SOL: '0.05' }));
      expect(Number(cfg.snipe.positionLamports) / LAMPORTS_PER_SOL).toBeCloseTo(0.05, 9);
    });

    it('falls back to SNIPE_POSITION_SOL when MAX_POSITION_SOL is absent', () => {
      // THE regression. Before the fix this returned 0.5 — the default on
      // MAX_POSITION_SOL — and the operator's value was discarded silently.
      const cfg = BotConfigSchema.parse(baseEnv({ SNIPE_POSITION_SOL: '0.05' }));
      expect(Number(cfg.snipe.positionLamports) / LAMPORTS_PER_SOL).toBeCloseTo(0.05, 9);
    });

    it('prefers MAX_POSITION_SOL when both are set', () => {
      const cfg = BotConfigSchema.parse(
        baseEnv({ MAX_POSITION_SOL: '0.05', SNIPE_POSITION_SOL: '0.5' }),
      );
      expect(Number(cfg.snipe.positionLamports) / LAMPORTS_PER_SOL).toBeCloseTo(0.05, 9);
    });

    it('falls back to the documented default when neither is set', () => {
      const cfg = BotConfigSchema.parse(baseEnv());
      expect(Number(cfg.snipe.positionLamports) / LAMPORTS_PER_SOL).toBeCloseTo(0.5, 9);
    });
  });

  describe('concurrent positions', () => {
    it('falls back to MAX_CONCURRENT_POSITIONS when MAX_OPEN_POSITIONS is absent', () => {
      const cfg = BotConfigSchema.parse(baseEnv({ MAX_CONCURRENT_POSITIONS: '2' }));
      expect(cfg.snipe.maxConcurrentPositions).toBe(2);
    });

    it('prefers MAX_OPEN_POSITIONS when both are set', () => {
      const cfg = BotConfigSchema.parse(
        baseEnv({ MAX_OPEN_POSITIONS: '2', MAX_CONCURRENT_POSITIONS: '5' }),
      );
      expect(cfg.snipe.maxConcurrentPositions).toBe(2);
    });
  });

  describe('drawdown and cooldown aliases', () => {
    it('falls back to MAX_DRAWDOWN_PCT when MAX_DRAWDOWN_PERCENT is absent', () => {
      const cfg = BotConfigSchema.parse(baseEnv({ MAX_DRAWDOWN_PCT: '10' }));
      expect(cfg.breaker.maxDrawdownPct).toBe(10);
    });

    it('falls back to TRIP_COOLDOWN_MS when BREAKER_COOLDOWN_MS is absent', () => {
      const cfg = BotConfigSchema.parse(baseEnv({ TRIP_COOLDOWN_MS: '1000' }));
      expect(cfg.breaker.tripCooldownMs).toBe(1000);
    });
  });

  describe('malformed values are errors, not silent defaults', () => {
    it('rejects a non-numeric position size rather than falling back', () => {
      // A typo must fail loudly. Falling back to a default here would
      // reproduce F1's core failure: a plausible number from a config the
      // operator never wrote.
      expect(() =>
        BotConfigSchema.parse(baseEnv({ MAX_POSITION_SOL: 'not-a-number' })),
      ).toThrow();
    });
  });
});
