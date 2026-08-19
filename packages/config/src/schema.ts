
/**
 * packages/config/src/schema.ts
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * FLAT env-keyed input schema  â†’  transform  â†’  nested BotConfig output.
 * Loader calls BotConfigSchema.safeParse(process.env) directly â€” no mapper,
 * no drift. Every field has a safe default; garbage values fail at boot.
 * Downstream code reads ONLY the nested output (bigint lamports, typed).
 *
 * Requires: zod ^3.22
 */

import { z } from "zod";

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 1. CONSTANTS (verified against official docs, Aug 2026)
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const solToLamports = (sol: number): bigint =>
  BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));

export const lamportsToSol = (lamports: bigint): number =>
  Number(lamports) / Number(LAMPORTS_PER_SOL);

export const KNOWN_PROGRAM_IDS = {
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  // Raydium AMM v4. This previously read
  // "675kPX9MHTjS2zt1qfr1NYPz2kWcshvZ1vqkM5v1x5Vm", which is not the AMM v4
  // program and disagreed with @mayhem/solana/constants.ts and the Raydium
  // SDK. Two different "truths" for a program id is how a filter silently
  // matches nothing.
  RAYDIUM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  JUPITER_V6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  SPL_TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;

export const JITO_URLS = {
  BLOCK_ENGINE: "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  TIP_FLOOR: "https://bundles.jito.wtf/api/v1/bundles/tip_floor",
} as const;

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 2. PRIMITIVES â€” every env var is a string; coerce or fail loudly
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** Bool from "true|1|yes|on" / "false|0|no|off"; garbage fails. */
const envBool = (fallback: boolean) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === "") return fallback;
      if (typeof v === "boolean") return v;
      const s = String(v).toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
      return v; // let z.boolean() fail with a clear message
    },
    z.boolean(),
  );

/** String with fallback on missing/empty. */
const envStr = (fallback: string) =>
  z.preprocess((v) => (v === undefined || v === "" ? fallback : v), z.string());

/** Optional string (no fallback; undefined if missing/empty). */
const envStrOptional = () =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.string().optional(),
  );

/** Non-negative float. */
const envNum = (fallback: number) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === "") return undefined; // let default apply
      const n = Number(v);
      return Number.isFinite(n) ? n : v; // garbage â†’ inner schema fails
    },
    z.number().default(fallback),
  );

/** Integer 1..100 (percent). */
const envPct = (fallback: number) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    },
    z.number().int().min(1).max(100).default(fallback),
  );

/*
 * Optional numeric variants — no default, so `undefined` genuinely means
 * "not set by the operator".
 *
 * Required by the `PRIMARY ?? LEGACY` alias chains in the transform: a
 * defaulted field is never undefined after parsing, which makes `??`
 * unreachable and pins the value to the default no matter what the operator
 * configured. See docs/audits/CONFIG_AUDIT.md F1 — this cost a live bot its
 * position size.
 *
 * Garbage still fails the inner schema rather than falling back silently: a
 * typo'd number must be an error, not a default.
 */
const optionalNumeric = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    },
    inner.optional(),
  );

const envNumOptional = () => optionalNumeric(z.number());
const envPctOptional = () => optionalNumeric(z.number().int().min(1).max(100));
const envSolOptional = () => optionalNumeric(z.number().nonnegative());

/** SOL amount (human float). Lamports derived in the transform. */
const envSol = (fallback: number) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    },
    z.number().nonnegative().default(fallback),
  );

/** URL with fallback. */
const envUrl = (fallback: string) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? fallback : v),
    z.string().url({ message: "must be a valid URL" }),
  );

/** Comma-separated list â†’ string[] (empty â†’ []). */
const envList = () =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean)),
    z.array(z.string()),
  );

/** Sell ladder format: "30@2x,30@3x,40@5x". Regex-gated so the transform can't throw. */
const SELL_LADDER_RE =
  /^(\d+(?:\.\d+)?@\d+(?:\.\d+)?x)(\s*,\s*\d+(?:\.\d+)?@\d+(?:\.\d+)?x)*$/i;

const envLadder = (fallback: string) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? fallback : v),
    z.string().regex(SELL_LADDER_RE, { message: 'expected "30@2x,30@3x,40@5x"' }),
  );

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 3. FLAT ENV SCHEMA â€” input is literally process.env
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const FlatEnvSchema = z.object({
  // â”€â”€ runtime â”€â”€
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRADING_ENABLED: envBool(true),
  DRY_RUN: envBool(false),

  // â”€â”€ RPC â”€â”€
  RPC_URL_1: envUrl("https://api.mainnet-beta.solana.com"),
  RPC_URL_2: envStrOptional(),
  RPC_URL_3: envStrOptional(),
  RPC_WS_URL: envUrl("wss://api.mainnet-beta.solana.com"),
  RPC_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  RPC_FAILOVER_MS: envNum(150),
  RPC_TIMEOUT_MS: envNum(10_000),
  RPC_MAX_RETRIES: envNum(5),
  RPC_CONFIRM_POLL_MS: envNum(300),

  // â”€â”€ JITO â”€â”€
  JITO_BUNDLE_URL: envUrl(JITO_URLS.BLOCK_ENGINE),
  JITO_TIP_FLOOR_URL: envUrl(JITO_URLS.TIP_FLOOR),
  JITO_TIP_STRATEGY: z.enum(["percentile", "fixed"]).default("percentile"),
  JITO_TIP_PERCENTILE: z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : Number(v)),
    z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(95), z.literal(99)]).default(50),
  ),
  JITO_TIP_FIXED_SOL: envSol(0.005),
  JITO_MAX_TIP_SOL: envSol(0.02),
  JITO_MAX_RETRIES: envNum(5),
  JITO_RETRY_BACKOFF_MS: envNum(250),
  JITO_LANDING_TIMEOUT_MS: envNum(30_000),
  JITO_LANDING_POLL_MS: envNum(300),
  JITO_TIP_ACCOUNTS_TTL_MS: envNum(60_000),

  // â”€â”€ WALLETS (keyvault dir + ids; password stays OUT of config, read directly) â”€â”€
  KEYVAULT_DIR: envStr("/run/secrets/keys"),
  HOT_WALLET_ID: envStr("hot"),
  DEV_WALLET_ID: envStr("dev"),
  FEE_WALLET_ID: envStr("fee"),

  /*
   * â”€â”€ SNIPE â”€â”€
   *
   * The four aliased keys below (and the MAX_DRAWDOWN_ and _COOLDOWN_MS
   * pairs further down) are resolved in the transform as
   * `PRIMARY ?? LEGACY`. For that to
   * mean anything, PRIMARY must be able to be undefined — a `.default()` on it
   * makes the `??` unreachable and silently pins the value to the default.
   *
   * That is exactly what happened: MAX_POSITION_SOL defaulted to 0.5, so
   * SNIPE_POSITION_SOL could never take effect and the bot traded 0.5 SOL
   * while its config said 0.05. See docs/audits/CONFIG_AUDIT.md F1.
   *
   * So: no default on the primary. The fallback chain in the transform ends
   * in a literal, which is the single place the effective default lives.
   */
  SNIPE_POSITION_SOL: envSolOptional(),
  MAX_POSITION_SOL: envSolOptional(),
  MAX_SLIPPAGE_PCT: envPct(30),
  MAX_CONCURRENT_POSITIONS: envNumOptional(),
  MAX_OPEN_POSITIONS: envNumOptional(),
  MAX_TX_AGE_MS: envNum(5_000),
  PREFLIGHT_SIM: envBool(true),
  BACKRUN_ENABLED: envBool(false),
  MIN_WHALE_SOL: envSol(1.0),
  BACKRUN_POSITION_SOL: envSol(0.25),

  // â”€â”€ RISK SCANNER â”€â”€
  HONEYPOT_SIM_SELL: envBool(true),
  MINT_AUTHORITY: z.enum(["revoked", "active"]).default("revoked"),
  MAX_HOLDER_CONCENTRATION_PCT: envPct(20),
  LP_LOCK_REQUIRED: envBool(true),
  MIN_DEV_WALLET_EXPOSURE_DAYS: envNum(30),
  HOLDER_VELOCITY_MIN_RATE: envNum(10),
  MIN_LIQUIDITY_SOL: envSol(3),

  // â”€â”€ CIRCUIT BREAKER â”€â”€
  MAX_DAILY_LOSS_SOL: envSol(2),
  MAX_CONSECUTIVE_LOSSES: envNum(3),
  // Aliased pairs — see the SNIPE block above for why neither side may carry
  // a default. Effective defaults live in the transform.
  MAX_DRAWDOWN_PCT: envPctOptional(),
  MAX_DRAWDOWN_PERCENT: envPctOptional(),
  TRIP_COOLDOWN_MS: envNumOptional(),
  BREAKER_COOLDOWN_MS: envNumOptional(),
  PERSIST_TRIPS: envBool(true),

  // â”€â”€ EXIT LADDER â”€â”€
  SELL_LADDER: envLadder("30@2x,30@3x,40@5x"),
  TRAILING_STOP_PCT: envPct(25),
  STOP_LOSS_PCT: envPct(40),

  // â”€â”€ DATABASE â”€â”€
  PGHOST: envStr("localhost"),
  PGPORT: envNum(5432),
  PGDATABASE: envStr("mayhem"),
  PGUSER: envStr("mayhem"),
  PGPASSWORD: envStrOptional(),
  PGSSL: envBool(false),
  PG_POOL_SIZE: envNum(10),

  // â”€â”€ API â”€â”€
  // Loopback by default. The API exposes portfolio state and the
  // kill switch; binding 0.0.0.0 by default makes a misconfigured
  // deployment publicly readable. Opt in to a wider bind explicitly.
  API_HOST: envStr("127.0.0.1"),
  API_PORT: envNum(3000),
  API_KEYS: envList(),
  CORS_ORIGINS: envList(),
  RATE_LIMIT_WINDOW_MS: envNum(60_000),
  RATE_LIMIT_MAX: envNum(120),

  // â”€â”€ NOTIFICATIONS â”€â”€
  TG_ENABLED: envBool(false),
  TG_BOT_TOKEN: envStrOptional(),
  TG_CHAT_ID: envStrOptional(),
  DISCORD_ENABLED: envBool(false),
  DISCORD_WEBHOOK_URL: envStrOptional(),
  WEBHOOK_ENABLED: envBool(false),
  WEBHOOK_URL: envStrOptional(),
  ALERT_ON_ENTRY: envBool(true),
  ALERT_ON_EXIT: envBool(true),
  ALERT_ON_TRIP: envBool(true),
  ALERT_ON_KILL_SWITCH: envBool(true),

  // â”€â”€ ANALYTICS â”€â”€
  EQUITY_SNAPSHOT_INTERVAL_MS: envNum(60_000),
  METRICS_ENABLED: envBool(true),
  METRICS_PORT: envNum(9090),

  // â”€â”€ LAUNCH (your own tokens) â”€â”€
  LAUNCH_ENABLED: envBool(false),
  LAUNCH_BUNDLE_MODE: envBool(true),
  LAUNCH_INITIAL_LIQUIDITY_SOL: envSol(1),
  LAUNCH_ALLOCATION_PCT: envPct(50),
  LAUNCH_REVOKE_MINT_AUTHORITY: envBool(true),
  LAUNCH_BURN_LP: envBool(true),
  LAUNCH_TIP_SOL: envSol(0.01),
});

export type FlatEnv = z.infer<typeof FlatEnvSchema>;

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 4. TRANSFORM â†’ nested BotConfig with derived lamports
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

export type SellRung = { pct: number; multiple: number };

export function parseLadder(raw: string): SellRung[] {
  return raw.split(",").map((part) => {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)x$/i);
    if (!m) throw new Error(`bad sellLadder rung: "${part}"`);
    return { pct: parseFloat(m[1] ?? ""), multiple: parseFloat(m[2] ?? "") };
  });
}

export const BotConfigSchema = FlatEnvSchema
  .transform((e): BotConfig => {
    /*
     * Alias resolution: PRIMARY, else LEGACY, else the effective default.
     *
     * The trailing literal is the ONLY place these defaults live. Previously
     * the primaries carried Zod defaults, which made the `??` dead code and
     * pinned position size to 0.5 regardless of configuration
     * (docs/audits/CONFIG_AUDIT.md F1).
     *
     * If you add a default back onto any of these fields in FlatEnvSchema,
     * you re-break the alias — the fallback silently stops working, and the
     * failure is invisible because a plausible number still comes out.
     */
    const positionSol = e.MAX_POSITION_SOL ?? e.SNIPE_POSITION_SOL ?? 0.5;
    const maxConcurrentPositions =
      e.MAX_OPEN_POSITIONS ?? e.MAX_CONCURRENT_POSITIONS ?? 5;
    const maxDrawdownPct = e.MAX_DRAWDOWN_PERCENT ?? e.MAX_DRAWDOWN_PCT ?? 25;
    const tripCooldownMs =
      e.BREAKER_COOLDOWN_MS ?? e.TRIP_COOLDOWN_MS ?? 3_600_000;

    return {
      env: {
        nodeEnv: e.NODE_ENV,
        logLevel: e.LOG_LEVEL,
        tradingEnabled: e.TRADING_ENABLED,
        dryRun: e.DRY_RUN,
      },

      rpc: {
      http: [e.RPC_URL_1, e.RPC_URL_2, e.RPC_URL_3].filter((u): u is string => Boolean(u)),
      ws: e.RPC_WS_URL,
      commitment: e.RPC_COMMITMENT,
      failoverMs: e.RPC_FAILOVER_MS,
      timeoutMs: e.RPC_TIMEOUT_MS,
      maxRetries: e.RPC_MAX_RETRIES,
      confirmPollMs: e.RPC_CONFIRM_POLL_MS,
    },

    jito: {
      bundleUrl: e.JITO_BUNDLE_URL,
      tipFloorUrl: e.JITO_TIP_FLOOR_URL,
      tipStrategy: e.JITO_TIP_STRATEGY,
      tipPercentile: e.JITO_TIP_PERCENTILE,
      tipFixedLamports: solToLamports(e.JITO_TIP_FIXED_SOL),
      maxTipLamports: solToLamports(e.JITO_MAX_TIP_SOL),
      sendRetries: e.JITO_MAX_RETRIES,
      retryBackoffMs: e.JITO_RETRY_BACKOFF_MS,
      landingTimeoutMs: e.JITO_LANDING_TIMEOUT_MS,
      landingPollMs: e.JITO_LANDING_POLL_MS,
      tipAccountsTtlMs: e.JITO_TIP_ACCOUNTS_TTL_MS,
    },

    wallets: {
      keyvaultDir: e.KEYVAULT_DIR,
      hotWalletId: e.HOT_WALLET_ID,
      devWalletId: e.DEV_WALLET_ID,
      feeWalletId: e.FEE_WALLET_ID,
    },

    snipe: {
      positionLamports: solToLamports(positionSol),
      maxSlippagePct: e.MAX_SLIPPAGE_PCT,
      maxConcurrentPositions,
      maxTxAgeMs: e.MAX_TX_AGE_MS,
      preflightSim: e.PREFLIGHT_SIM,
      backrunEnabled: e.BACKRUN_ENABLED,
      minWhaleLamports: solToLamports(e.MIN_WHALE_SOL),
      backrunPositionLamports: solToLamports(e.BACKRUN_POSITION_SOL),
    },

    risk: {
      honeypotSimSell: e.HONEYPOT_SIM_SELL,
      mintAuthority: e.MINT_AUTHORITY,
      maxHolderConcentrationPct: e.MAX_HOLDER_CONCENTRATION_PCT,
      lpLockRequired: e.LP_LOCK_REQUIRED,
      minDevWalletExposureDays: e.MIN_DEV_WALLET_EXPOSURE_DAYS,
      holderVelocityMinRate: e.HOLDER_VELOCITY_MIN_RATE,
      minLiquidityLamports: solToLamports(e.MIN_LIQUIDITY_SOL),
    },

    breaker: {
      maxDailyLossLamports: solToLamports(e.MAX_DAILY_LOSS_SOL),
      maxConsecutiveLosses: e.MAX_CONSECUTIVE_LOSSES,
      maxDrawdownPct,
      tripCooldownMs,
      persistTrips: e.PERSIST_TRIPS,
    },

    exit: {
      ladder: parseLadder(e.SELL_LADDER), // format already regex-gated â€” cannot throw
      trailingStopPct: e.TRAILING_STOP_PCT,
      stopLossPct: e.STOP_LOSS_PCT,
    },

    database: {
      host: e.PGHOST,
      port: e.PGPORT,
      name: e.PGDATABASE,
      user: e.PGUSER,
      ...(e.PGPASSWORD === undefined ? {} : { password: e.PGPASSWORD }),
      ssl: e.PGSSL,
      poolSize: e.PG_POOL_SIZE,
    },

    api: {
      host: e.API_HOST,
      port: e.API_PORT,
      apiKeys: e.API_KEYS,
      corsOrigins: e.CORS_ORIGINS,
      rateLimit: { windowMs: e.RATE_LIMIT_WINDOW_MS, maxRequests: e.RATE_LIMIT_MAX },
    },

    notifications: {
      telegram: {
        enabled: e.TG_ENABLED,
        ...(e.TG_BOT_TOKEN === undefined ? {} : { botToken: e.TG_BOT_TOKEN }),
        ...(e.TG_CHAT_ID === undefined ? {} : { chatId: e.TG_CHAT_ID }),
      },
      discord: {
        enabled: e.DISCORD_ENABLED,
        ...(e.DISCORD_WEBHOOK_URL === undefined ? {} : { webhookUrl: e.DISCORD_WEBHOOK_URL }),
      },
      webhook: {
        enabled: e.WEBHOOK_ENABLED,
        ...(e.WEBHOOK_URL === undefined ? {} : { url: e.WEBHOOK_URL }),
      },
      alertOn: {
        entry: e.ALERT_ON_ENTRY,
        exit: e.ALERT_ON_EXIT,
        trip: e.ALERT_ON_TRIP,
        killSwitch: e.ALERT_ON_KILL_SWITCH,
      },
    },

    analytics: {
      equitySnapshotIntervalMs: e.EQUITY_SNAPSHOT_INTERVAL_MS,
      metricsEnabled: e.METRICS_ENABLED,
      metricsPort: e.METRICS_PORT,
    },

    launch: {
      enabled: e.LAUNCH_ENABLED,
      bundleMode: e.LAUNCH_BUNDLE_MODE,
      initialLiquidityLamports: solToLamports(e.LAUNCH_INITIAL_LIQUIDITY_SOL),
      allocationPct: e.LAUNCH_ALLOCATION_PCT,
      revokeMintAuthority: e.LAUNCH_REVOKE_MINT_AUTHORITY,
      burnLpTokens: e.LAUNCH_BURN_LP,
      tipLamports: solToLamports(e.LAUNCH_TIP_SOL),
    },

      constants: {
        ...KNOWN_PROGRAM_IDS,
        lampPortsPerSol: LAMPORTS_PER_SOL,
      },
    };
  })
  .superRefine((cfg, ctx) => {
    // Commitment: finalized is too slow to snipe â€” refuse at boot.
    if (cfg.rpc.commitment === "finalized") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RPC_COMMITMENT=finalized is too slow for sniping; use confirmed",
        path: ["rpc", "commitment"],
      });
    }
    // Tip cap sanity: a fixed tip above the hard cap would always clamp.
    if (cfg.jito.tipStrategy === "fixed" && cfg.jito.tipFixedLamports > cfg.jito.maxTipLamports) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JITO_TIP_FIXED_SOL exceeds JITO_MAX_TIP_SOL â€” cap would always clamp",
        path: ["jito", "tipFixedLamports"],
      });
    }
    // Ladder: rungs must be positive and sum â‰¤ 100.
    const total = cfg.exit.ladder.reduce((sum, r) => sum + r.pct, 0);
    if (total > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `SELL_LADDER rungs sum to ${total}% â€” must be â‰¤ 100%`,
        path: ["exit", "ladder"],
      });
    }
    for (const r of cfg.exit.ladder) {
      if (r.pct <= 0 || r.multiple <= 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "each ladder rung needs pct>0 and multiple>1",
          path: ["exit", "ladder"],
        });
      }
    }
    // Breaker must trip BEFORE the stop-loss alone would wipe the day.
    if (cfg.breaker.maxDrawdownPct >= 100 - cfg.exit.stopLossPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MAX_DRAWDOWN_PCT should be below (100 - STOP_LOSS_PCT) so the breaker trips first",
        path: ["breaker", "maxDrawdownPct"],
      });
    }
    // Notifications: enabled without creds = silent bot. Refuse.
    // Allow the dev combination TRADING_ENABLED=true + DRY_RUN=true when
    // running in development mode to support simulated entry testing.
    if (cfg.env.tradingEnabled && cfg.env.dryRun && cfg.env.nodeEnv !== 'development') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TRADING_ENABLED=true cannot be combined with DRY_RUN=true",
        path: ["env", "tradingEnabled"],
      });
    }
    if (cfg.notifications.telegram.enabled && (!cfg.notifications.telegram.botToken || !cfg.notifications.telegram.chatId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TG_ENABLED=true requires TG_BOT_TOKEN and TG_CHAT_ID",
        path: ["notifications", "telegram"],
      });
    }
    if (cfg.notifications.discord.enabled && !cfg.notifications.discord.webhookUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DISCORD_ENABLED=true requires DISCORD_WEBHOOK_URL",
        path: ["notifications", "discord"],
      });
    }
    // Production without API keys = kill switch endpoint open. Refuse.
    if (cfg.env.nodeEnv === "production" && cfg.api.apiKeys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires at least one API_KEYS entry (kill-switch protection)",
        path: ["api", "apiKeys"],
      });
    }
  });

export type BotConfig = {
  env: {
    nodeEnv: "development" | "test" | "production";
    logLevel: "debug" | "info" | "warn" | "error";
    tradingEnabled: boolean;
    dryRun: boolean;
    
  };
  rpc: {
    http: string[]; ws: string;
    commitment: "processed" | "confirmed" | "finalized";
    failoverMs: number; timeoutMs: number; maxRetries: number; confirmPollMs: number;
  };
  jito: {
    bundleUrl: string; tipFloorUrl: string;
    tipStrategy: "percentile" | "fixed"; tipPercentile: 25 | 50 | 75 | 95 | 99;
    tipFixedLamports: bigint; maxTipLamports: bigint;
    sendRetries: number; retryBackoffMs: number;
    landingTimeoutMs: number; landingPollMs: number; tipAccountsTtlMs: number;
  };
  wallets: { keyvaultDir: string; hotWalletId: string; devWalletId: string; feeWalletId: string };
  snipe: {
    positionLamports: bigint; maxSlippagePct: number; maxConcurrentPositions: number;
    maxTxAgeMs: number; preflightSim: boolean;
    backrunEnabled: boolean; minWhaleLamports: bigint; backrunPositionLamports: bigint;
  };
  risk: {
    honeypotSimSell: boolean; mintAuthority: "revoked" | "active";
    maxHolderConcentrationPct: number; lpLockRequired: boolean;
    minDevWalletExposureDays: number; holderVelocityMinRate: number;
    minLiquidityLamports: bigint;
  };
  breaker: {
    maxDailyLossLamports: bigint; maxConsecutiveLosses: number;
    maxDrawdownPct: number; tripCooldownMs: number; persistTrips: boolean;
  };
  exit: { ladder: SellRung[]; trailingStopPct: number; stopLossPct: number };
  database: {
    host: string; port: number; name: string; user: string;
    password?: string; ssl: boolean; poolSize: number;
  };
  api: {
    host: string; port: number; apiKeys: string[]; corsOrigins: string[];
    rateLimit: { windowMs: number; maxRequests: number };
  };
  notifications: {
    telegram: { enabled: boolean; botToken?: string; chatId?: string };
    discord: { enabled: boolean; webhookUrl?: string };
    webhook: { enabled: boolean; url?: string };
    alertOn: { entry: boolean; exit: boolean; trip: boolean; killSwitch: boolean };
  };
  analytics: { equitySnapshotIntervalMs: number; metricsEnabled: boolean; metricsPort: number };
  launch: {
    enabled: boolean; bundleMode: boolean; initialLiquidityLamports: bigint;
    allocationPct: number; revokeMintAuthority: boolean; burnLpTokens: boolean; tipLamports: bigint;
  };
  constants: typeof KNOWN_PROGRAM_IDS & { lampPortsPerSol: bigint };
};

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 5. ENV KEY MANIFEST â€” for .env.example generation & docs (single source)
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

export const ENV_KEYS = Object.keys(FlatEnvSchema.shape) as Array<keyof FlatEnv>;