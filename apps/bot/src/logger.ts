const LOG_LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const envLogLevel = process.env['LOG_LEVEL']?.toLowerCase() ?? 'info';
const CURRENT_LEVEL = LOG_LEVELS[envLogLevel] ?? 1;

const SECRET_PATTERNS = ["secret", "key", "password", "private"];

/*
 * Credential-bearing query parameters, redacted wherever they appear in a
 * string VALUE.
 *
 * Key-name matching alone is not enough: an RPC endpoint logged under a key
 * like `primary` or `rpc` carries `?api-key=...` in the value, and every
 * pattern above matches only the key. That is how a provider key reached the
 * first line of every captured log file.
 *
 * Applied to string values regardless of the key, so a URL logged from a new
 * call site is covered without anyone remembering to redact it.
 */
const URL_SECRET_PARAMS =
  /([?&](?:api[-_]?key|access[-_]?token|auth|token|secret|password|pwd)=)[^&\s"']+/gi;

function scrubSecretsInString(value: string): string {
  return value.replace(URL_SECRET_PARAMS, '$1REDACTED');
}

/**
 * Bound on recursion into nested log payloads.
 *
 * Guards against a cyclic or pathologically deep object turning a log call
 * into a hang. Beyond the limit the value is replaced rather than emitted
 * unscrubbed — an unreadable log line is preferable to a leaked credential.
 */
const MAX_SANITIZE_DEPTH = 6;

function sanitizeValue(key: string, value: unknown, depth = 0): unknown {
  if (SECRET_PATTERNS.some((p) => key.toLowerCase().includes(p))) {
    return "[REDACTED]";
  }

  if (typeof value === 'string') {
    return scrubSecretsInString(value);
  }

  if (value instanceof AggregateError) {
    return {
      name: value.name,
      message: value.message,
      errors: value.errors.map((err: unknown) => sanitizeError(err)),
    };
  }

  if (value instanceof Error) {
    return sanitizeError(value);
  }

  /*
   * Recurse into plain objects and arrays.
   *
   * Previously sanitisation was one level deep, so `{ rpc: { primary: url } }`
   * emitted the inner URL untouched — the nesting alone was enough to bypass
   * every rule above. Anything a caller nests is now scrubbed on the same
   * terms as a top-level field.
   */
  if (depth >= MAX_SANITIZE_DEPTH) {
    return '[TRUNCATED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    // Plain objects only. Class instances (Connection, PublicKey, BigNumber…)
    // are left alone: walking them can touch getters with side effects, and
    // their own serialisation is the caller's concern.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const nested: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        nested[k] = sanitizeValue(k, v, depth + 1);
      }
      return nested;
    }
  }

  return value;
}

function sanitizeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };

  if (error['stack']) {
    result['stack'] = error['stack'];
  }

  const aggregate = error as AggregateError;

  if (Array.isArray(aggregate['errors'])) {
    result['errors'] = (aggregate['errors'] as unknown[]).map((err: unknown) =>
      sanitizeError(err),
    );
  }

  return result;
}

function sanitize(
  data?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!data) return undefined;

  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    cleaned[key] = sanitizeValue(key, value);
  }

  return cleaned;
}

function log(
  level: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if ((LOG_LEVELS[level] ?? 1) < CURRENT_LEVEL) return;

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    msg,
  };

  const sanitized = sanitize(data);

  if (sanitized) {
    Object.assign(entry, sanitized);
  }

  console.log(JSON.stringify(entry));
}

export function info(
  msg: string,
  data?: Record<string, unknown>,
): void {
  log("info", msg, data);
}

export function warn(
  msg: string,
  data?: Record<string, unknown>,
): void {
  log("warn", msg, data);
}

export function error(
  msg: string,
  data?: Record<string, unknown>,
): void {
  log("error", msg, data);
}

export function debug(
  msg: string,
  data?: Record<string, unknown>,
): void {
  log("debug", msg, data);
}

export const logger = {
  log,
  info,
  warn,
  error,
  debug,
};