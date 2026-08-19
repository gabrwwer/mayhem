/**
 * Type declaration for the `jest` compatibility global.
 *
 * Several suites predate the move to Vitest and call `jest.fn()`,
 * `jest.clearAllMocks()` and friends. `vitest.setup.ts` provides those at
 * RUNTIME by mapping them onto `vi`, which is why the tests pass — but
 * `tsc` still reported ~55 "Cannot use namespace 'jest' as a value" errors,
 * because @types/node ships a `jest` namespace with no value side.
 *
 * This declares the value so the type checker agrees with what actually
 * runs. It is deliberately narrow: only the members the setup file really
 * provides are typed, so a suite reaching for an unimplemented jest API
 * fails at compile time rather than with `undefined is not a function`
 * halfway through a test.
 *
 * New tests should import `vi` from 'vitest' directly. This exists to keep
 * existing coverage compiling, not to bless the pattern.
 */
import type { vi as viType } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var jest: {
    fn: typeof viType.fn;
    spyOn: typeof viType.spyOn;
    mock: typeof viType.mock;
    clearAllMocks: typeof viType.clearAllMocks;
    resetAllMocks: typeof viType.resetAllMocks;
    restoreAllMocks: typeof viType.restoreAllMocks;
    useFakeTimers: typeof viType.useFakeTimers;
    useRealTimers: typeof viType.useRealTimers;
    advanceTimersByTime: typeof viType.advanceTimersByTime;
    setSystemTime: typeof viType.setSystemTime;
  };
}

export {};
