import { vi } from 'vitest';

/**
 * Vitest setup.
 *
 * This file is referenced by `vitest.config.mts` (`setupFiles`) but did not
 * exist, which makes Vitest fail before collecting a single test. Combined
 * with the CI workflow that could not install dependencies, the practical
 * effect was that NO test in this repository had been running — the suite
 * looked comprehensive and enforced nothing.
 *
 * It also provides a `jest` compatibility shim. Several existing suites
 * (tests/unit/trading-engine.test.ts, tests/unit/exit-engine-hardened.test.ts)
 * call `jest.fn()` / `jest.clearAllMocks()`. Vitest does not define a `jest`
 * global, so those files would throw `ReferenceError: jest is not defined`
 * at import time. Rather than rewrite them in the same change as a set of
 * safety fixes — which would make the diff harder to review — the shim maps
 * the handful of APIs actually used onto `vi`.
 *
 * New tests should use `vi` directly; this shim exists to keep existing
 * coverage alive, not to encourage more of it.
 */
const jestShim = {
  fn: vi.fn,
  spyOn: vi.spyOn,
  mock: vi.mock,
  clearAllMocks: vi.clearAllMocks,
  resetAllMocks: vi.resetAllMocks,
  restoreAllMocks: vi.restoreAllMocks,
  useFakeTimers: vi.useFakeTimers,
  useRealTimers: vi.useRealTimers,
  advanceTimersByTime: vi.advanceTimersByTime,
  setSystemTime: vi.setSystemTime,
};

(globalThis as typeof globalThis & { jest?: unknown }).jest ??= jestShim;

/**
 * Fail loudly on an unhandled rejection instead of letting a test pass
 * while an async assertion silently died. In a trading codebase a
 * swallowed rejection in an exit path is exactly the bug a test suite
 * exists to catch.
 */
process.on('unhandledRejection', (reason) => {
  throw reason instanceof Error ? reason : new Error(String(reason));
});
