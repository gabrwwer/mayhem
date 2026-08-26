import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createRoutes } from "./routes";
import { BotState } from "./state";
import { createAuthMiddleware } from "./middleware/auth";
import { createRateLimit } from "./middleware/rate-limit";
import { createInternalAuth } from "./middleware/internal-auth";
import { resolveBotEnvPath } from "./env-file";

/**
 * Locate the .env file this process should load.
 *
 * Order:
 *   1. Walk up from cwd looking for a .env — an API-specific or repo-root
 *      file wins, so a deployment can give the API its own credentials.
 *   2. Fall back to the bot's .env (apps/bot/.env).
 *
 * Step 2 exists because in local development that is the only .env in the
 * tree, and it already holds API_KEYS, INTERNAL_API_SECRET and DRY_RUN. The
 * walk in step 1 starts at apps/api and never reaches it, so the API refused
 * to boot with "No API credentials configured" while the credentials were
 * sitting in the file the project treats as the source of truth.
 *
 * Duplicating those secrets into a second .env would be worse: two files that
 * must agree on DRY_RUN is exactly how a process ends up trading live while
 * its operator is reading a dry-run config.
 */
function findEnvFile(): string {
  let dir = process.cwd();

  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, ".env");

    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  const botEnv = resolveBotEnvPath();

  if (fs.existsSync(botEnv)) {
    return botEnv;
  }

  return path.resolve(process.cwd(), ".env");
}

dotenv.config({
  path: findEnvFile(),
  override: false,
});

const app = express();

app.disable("x-powered-by");

app.use(helmet());

/**
 * CORS
 *
 * Development:
 *   If CORS_ORIGINS is not configured, allow the default CORS behavior.
 *
 * Production:
 *   If CORS_ORIGINS is not configured, reject cross-origin requests.
 */
const corsOrigins = (process.env["CORS_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors(
    corsOrigins.length > 0
      ? {
          origin: corsOrigins,
        }
      : process.env["NODE_ENV"] === "production"
        ? {
            origin: false,
          }
        : undefined,
  ),
);

/**
 * Capture the raw body so the internal HMAC can be verified against the
 * exact bytes that were signed. Re-serialising `req.body` would not
 * reproduce them (key ordering, number formatting).
 */
app.use(
  express.json({
    limit: "256kb",
    verify: (req: IncomingMessage, _res: ServerResponse, buf: Buffer) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);

/**
 * Bot state
 */
const state = new BotState();

state.dryRun =
  (process.env['DRY_RUN'] as string | undefined)?.trim().toLowerCase() !== "false";

const requestedTradingEnabled =
  (process.env['TRADING_ENABLED'] as string | undefined)?.trim().toLowerCase() === "true";

// Reflect the requested flag in state so the dashboard can show the
// user's intention. The runtime will still honor `dryRun` and the
// execution service prevents real trading when DRY_RUN=true.
state.tradingEnabled = requestedTradingEnabled;

state.status = state.dryRun ? "DRY_RUN" : "RUNNING";
state.startedAt = new Date();

/**
 * API authentication
 *
 * Supports:
 *   API_AUTH_TOKEN=...
 *
 * and:
 *   API_KEYS=key1,key2,key3
 */
const configuredTokens = [
  process.env['API_AUTH_TOKEN'],
  ...((process.env['API_KEYS'] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)),
].filter(
  (value): value is string => Boolean(value),
);

const production =
  process.env['NODE_ENV'] === "production";

/**
 * There is deliberately no API_AUTH_DISABLED escape hatch any more.
 *
 * It previously overrode the mandatory-auth-in-production check, so a
 * single environment variable made the kill switch and every portfolio
 * endpoint public. A flag that can disable authentication will eventually
 * be set in the wrong environment.
 */
if (process.env['API_AUTH_DISABLED'] !== undefined) {
  throw new Error(
    "API_AUTH_DISABLED is no longer supported. Remove it and configure " +
      "API_AUTH_TOKEN or API_KEYS instead.",
  );
}

if (configuredTokens.length === 0) {
  // Refuse to start rather than serve an unauthenticated API. Starting and
  // returning 503 per-request would leave an operator believing the service
  // is up; failing at boot is unmissable.
  throw new Error(
    "No API credentials configured. Set API_AUTH_TOKEN or API_KEYS before starting the API.",
  );
}

// Auth behaviour is deliberately identical in every environment, so the
// middleware takes no `production` flag — a knob that varied auth by
// NODE_ENV is what allowed "it's only dev" to become a security boundary.
const authMiddleware = createAuthMiddleware({ tokens: configuredTokens });

const rateLimitWindowMs = Number(process.env['RATE_LIMIT_WINDOW_MS'] ?? 60_000);

/**
 * Operator-facing traffic (/api/*). Sized for one dashboard polling a handful
 * of endpoints, with headroom for manual refreshes.
 */
const apiRateLimit = createRateLimit({
  windowMs: rateLimitWindowMs,
  max: Number(process.env['RATE_LIMIT_MAX'] ?? 120),
});

/**
 * Bot -> API ingest (/internal/*). Its own bucket, because discovery is bursty
 * by nature: one POST per detected token plus telemetry, which on an active
 * market trivially exceeds an operator-sized quota. Sharing a bucket with
 * /api/* meant a busy bot blanked the dashboard.
 *
 * Still bounded — these routes are HMAC-authenticated but the limiter is what
 * stops a compromised or looping bot from filling memory with state.
 */
const internalRateLimit = createRateLimit({
  windowMs: rateLimitWindowMs,
  max: Number(process.env['INTERNAL_RATE_LIMIT_MAX'] ?? 1200),
});

const internalSecret = process.env['INTERNAL_API_SECRET'] ?? "";
if (!internalSecret) {
  throw new Error(
    "INTERNAL_API_SECRET is required: /internal routes accept data that is " +
      "rendered to the operator and must not be spoofable.",
  );
}
const internalAuth = createInternalAuth({ secret: internalSecret });

/**
 * Health endpoint.
 *
 * Registered BEFORE the rate limiter and without authentication so
 * deployment/load-balancer probes can always reach it. Rate-limiting the
 * health check would make a burst of traffic look like a dead service and
 * get the instance pulled from rotation — an availability bug created by a
 * security control.
 *
 * It deliberately exposes nothing beyond liveness.
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Rate limit both route classes, in separate buckets. Applied before the
// routes so an unauthenticated caller cannot burn RPC quota via /api/balance
// or brute-force tokens. The /health probe above is deliberately excluded.
//
// Keyed on req.ip. Behind a reverse proxy this collapses all callers into
// one bucket unless `app.set('trust proxy', ...)` is configured to match
// the deployment; the API binds loopback by default, where this is correct.
app.use('/api', apiRateLimit);
app.use('/internal', internalRateLimit);

/**
 * API routes
 */
const routes = createRoutes(state);

/**
 * Read-only endpoints.
 *
 * These now require authentication. "Read-only" is not "harmless": these
 * routes disclose wallet balance, open positions, trade history and the
 * full risk configuration — everything an attacker needs to front-run the
 * bot or size an attack against it. /api/balance additionally performs
 * Solana RPC calls on the caller's behalf.
 */
app.get("/api/status", authMiddleware, routes.getStatus);
app.get("/api/tokens", authMiddleware, routes.getTokens);
app.get("/api/launches", authMiddleware, routes.getLaunches);
app.get("/api/positions", authMiddleware, routes.getPositions);
app.get("/api/trades", authMiddleware, routes.getTrades);
app.get("/api/balance", authMiddleware, routes.getBalance);
app.get("/api/config", authMiddleware, routes.getConfig);
app.get("/api/config/exits", authMiddleware, routes.getExits);
app.get("/api/telemetry", authMiddleware, routes.getTelemetry);
app.get("/api/rejections", authMiddleware, routes.getRejections);

/**
 * Internal endpoints (bot -> API sync).
 *
 * HMAC-signed with INTERNAL_API_SECRET. Unauthenticated, these let anyone
 * on the network inject fake token discoveries and telemetry into the
 * dashboard an operator uses to decide whether to intervene.
 */
app.post('/internal/tokens', internalAuth, routes.postInternalTokens);
app.post('/internal/flow', internalAuth, routes.postInternalFlow);
app.post('/internal/telemetry', internalAuth, routes.postInternalTelemetry);
app.post('/internal/positions', internalAuth, routes.postInternalPositions);
app.post('/internal/balance', internalAuth, routes.postInternalBalance);

/**
 * Mutating endpoints
 *
 * These require API authentication.
 */
app.post(
  "/api/start",
  authMiddleware,
  routes.start,
);

app.post(
  "/api/pause",
  authMiddleware,
  routes.pause,
);

app.post(
  "/api/emergency-stop",
  authMiddleware,
  routes.emergencyStop,
);

app.post(
  "/api/positions/:id/close",
  authMiddleware,
  routes.closePosition,
);

// Partial close is not currently implemented.
// app.post(
//   "/api/positions/:id/partial-close",
//   authMiddleware,
//   routes.partialClose,
// );

// Position modification is not currently implemented.
// app.post(
//   "/api/positions/:id/modify",
//   authMiddleware,
//   routes.modifyPosition,
// );

// Stop-loss modification is not currently implemented.
// app.post(
//   "/api/positions/:id/stop-loss",
//   authMiddleware,
//   routes.stopLoss,
// );

// Trailing-stop modification is not currently implemented.
// app.post(
//   "/api/positions/:id/trailing-stop",
//   authMiddleware,
//   routes.trailingStop,
// );

// Take-profit modification is not currently implemented.
// app.post(
//   "/api/positions/:id/take-profit",
//   authMiddleware,
//   routes.takeProfit,
// );

app.post(
  "/api/config",
  authMiddleware,
  routes.updateConfig,
);

app.post(
  "/api/tokens/clear",
  authMiddleware,
  routes.clearTokens,
);

/**
 * Server configuration
 */
// Loopback by default. Exposing the portfolio API and kill switch on all
// interfaces should be a deliberate, explicit act — not what happens when
// API_HOST is unset.
const host =
  (process.env['API_HOST'] as string | undefined) || "127.0.0.1";

if (host === "0.0.0.0" && !production) {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "API_HOST=0.0.0.0 outside production — the API is reachable from the network",
      timestamp: new Date().toISOString(),
    }),
  );
}

const parsedPort = Number.parseInt(
  (process.env['API_PORT'] as string | undefined) || "3001",
  10,
);

const port =
  Number.isFinite(parsedPort) && parsedPort > 0
    ? parsedPort
    : 3001;

/**
 * Start server
 */
const server = app.listen(
  port,
  host,
  () => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: `API listening on ${host}:${port}`,
        timestamp: new Date().toISOString(),
        dryRun: state.dryRun,
        tradingEnabled: state.tradingEnabled,
      }),
    );
  },
);

/**
 * Graceful shutdown
 */
let shuttingDown = false;

const shutdown = (signal: string): void => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    JSON.stringify({
      level: "info",
      msg: `API shutdown requested (${signal})`,
      timestamp: new Date().toISOString(),
    }),
  );

  server.close((error) => {
    if (error) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: `Failed to shut down cleanly: ${error.message}`,
          signal,
          timestamp: new Date().toISOString(),
        }),
      );

      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify({
        level: "info",
        msg: `API shut down (${signal})`,
        timestamp: new Date().toISOString(),
      }),
    );
  });
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

export default app;
