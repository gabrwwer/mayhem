import { describe, expect, it } from "vitest";
import { assertRuntimeSafetyConfig } from "./runtime-safety";

describe("assertRuntimeSafetyConfig", () => {
  const valid = {
    maxPositionSol: 0.05,
    maxOpenPositions: 3,
    takeProfitPercent: 50,
    stopLossPercent: 15,
    trailingStopPercent: 25,
    maxHoldSeconds: 600,
  };

  it("accepts valid runtime safety configuration", () => {
    expect(assertRuntimeSafetyConfig(valid)).toEqual(valid);
  });

  it("rejects non-positive maxPositionSol", () => {
    expect(() =>
      assertRuntimeSafetyConfig({
        ...valid,
        maxPositionSol: 0,
      }),
    ).toThrow(/maxPositionSol must be > 0/);
  });

  it("rejects negative maxPositionSol", () => {
    expect(() =>
      assertRuntimeSafetyConfig({
        ...valid,
        maxPositionSol: -1,
      }),
    ).toThrow(/maxPositionSol must be > 0/);
  });

  it("rejects invalid maxOpenPositions", () => {
    expect(() =>
      assertRuntimeSafetyConfig({
        ...valid,
        maxOpenPositions: 0,
      }),
    ).toThrow(/maxOpenPositions must be >= 1/);
  });

  it("rejects invalid takeProfitPercent", () => {
    expect(() =>
      assertRuntimeSafetyConfig({
        ...valid,
        takeProfitPercent: 0,
      }),
    ).toThrow(/takeProfitPercent must be > 0/);
  });

  it("rejects stopLossPercent >= 100", () => {
    expect(() =>
      assertRuntimeSafetyConfig({
        ...valid,
        stopLossPercent: 100,
      }),
    ).toThrow(/stopLossPercent must be > 0 and < 100/);
  });

  it("rejects zero trailingStopPercent", () => {
    expect(() =>
      assertRuntimeSafetyConfig({
        ...valid,
        trailingStopPercent: 0,
      }),
    ).toThrow(/trailingStopPercent must be > 0 and < 100/);
  });

  it("rejects zero maxHoldSeconds", () => {
    expect(() =>
      assertRuntimeSafetyConfig({
        ...valid,
        maxHoldSeconds: 0,
      }),
    ).toThrow(/maxHoldSeconds must be > 0/);
  });
});
