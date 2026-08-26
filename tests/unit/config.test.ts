
import { resetConfigForTests, loadConfig } from "../../packages/config/src/loader";
import { BotConfigSchema } from "../../packages/config/src/schema";

afterEach(resetConfigForTests);

// `process.env` is an index signature, so `noPropertyAccessFromIndexSignature`
// requires bracket access.
test("throws when the explicit env file path is missing", () => {
  process.env['NODE_ENV'] = "production";
  process.env['API_KEYS'] = "k_0123456789abcdef0123456789abcdef";
  process.env['PGHOST'] = "db.internal";
  process.env['RPC_URL_1'] = "https://rpc.example.com";
  expect(() => loadConfig("/nonexistent")).toThrow(/Env file not found/);
});

test("rejects finalized commitment", () => {
  process.env['RPC_COMMITMENT'] = "finalized";
  expect(() => loadConfig()).toThrow(/too slow/);
});

test("accepts legacy size and breaker aliases from the boot env", () => {
  process.env['RPC_COMMITMENT'] = "confirmed";
  process.env['TRADING_ENABLED'] = "false";
  process.env['DRY_RUN'] = "true";
  process.env['SNIPE_POSITION_SOL'] = "0.5";
  process.env['MAX_POSITION_SOL'] = "0.25";
  process.env['MAX_CONCURRENT_POSITIONS'] = "4";
  process.env['MAX_OPEN_POSITIONS'] = "2";
  process.env['MAX_DRAWDOWN_PCT'] = "15";
  process.env['MAX_DRAWDOWN_PERCENT'] = "12";
  process.env['TRIP_COOLDOWN_MS'] = "3000";
  process.env['BREAKER_COOLDOWN_MS'] = "2000";

  const cfg = loadConfig();
  expect(cfg.snipe.positionLamports).toBe(250_000_000n);
  expect(cfg.snipe.maxConcurrentPositions).toBe(2);
  expect(cfg.breaker.maxDrawdownPct).toBe(12);
  expect(cfg.breaker.tripCooldownMs).toBe(2000);
});
