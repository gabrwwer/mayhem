import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Locates and edits the .env file that the *bot* process actually reads
 * (apps/bot/.env), independent of whichever .env the API process itself
 * loaded at boot (apps/api walks up from its own cwd and may resolve to
 * a different file, e.g. the repo-root .env, in local dev).
 *
 * The dashboard's "Config" panel edits bot behavior, so reads and writes
 * here must target the bot's actual config file — otherwise a saved
 * change could silently have no effect on the running bot.
 */

let cachedBotEnvPath: string | null = null;

export function resolveBotEnvPath(): string {
  if (cachedBotEnvPath && fs.existsSync(cachedBotEnvPath)) {
    return cachedBotEnvPath;
  }

  const override = process.env['BOT_ENV_FILE_PATH'];
  if (override && fs.existsSync(override)) {
    cachedBotEnvPath = override;
    return override;
  }

  // Walk up from this file's location to find the monorepo root
  // (identified by a package.json with a "workspaces" field), then
  // resolve apps/bot/.env relative to it.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
        if (Array.isArray(pkg['workspaces'])) {
          const candidate = path.join(dir, 'apps', 'bot', '.env');
          if (fs.existsSync(candidate)) {
            cachedBotEnvPath = candidate;
            return candidate;
          }
        }
      } catch {
        // ignore malformed package.json and keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: assume apps/api and apps/bot are siblings.
  const fallback = path.resolve(__dirname, '..', '..', 'bot', '.env');
  cachedBotEnvPath = fallback;
  return fallback;
}

/** Read and parse the bot's .env file. Returns {} if the file is missing. */
export function readBotEnvFile(): Record<string, string> {
  const filePath = resolveBotEnvPath();
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Update specific keys in the bot's .env file in place, preserving
 * comments, ordering, and every key not listed in `updates`. Only
 * replaces keys that already exist in the file — never appends new
 * keys, to avoid silently introducing unreviewed config surface.
 *
 * Returns the list of keys that were NOT found (and therefore not
 * written), so the caller can surface that as an error rather than
 * silently drop a change.
 */
export function writeBotEnvUpdates(
  updates: Record<string, string>,
): { written: string[]; missing: string[] } {
  const filePath = resolveBotEnvPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Bot .env file not found at ${String(filePath)}`);
  }

  const original = fs.readFileSync(filePath, 'utf8');
  const lines = original.split(/\r?\n/);
  const remaining = new Set(Object.keys(updates));
  const written: string[] = [];

  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    // `noUncheckedIndexedAccess` types capture groups as possibly
    // undefined. It cannot actually be undefined when the regex matched,
    // but narrowing it explicitly is cheaper than an assertion — and an
    // assertion here would be a lie the compiler could not check.
    const key = match?.[1];
    if (key === undefined) return line;

    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      remaining.delete(key);
      written.push(key);
      // Values are validated and range-checked by the caller
      // (routes.ts CONFIG_FIELDS), so they are numeric literals here.
      // Reject anything containing a newline anyway: one injected line
      // break would let a single field write an arbitrary second variable.
      const value = String(updates[key]);
      if (/[\r\n]/.test(value)) {
        throw new Error(`Refusing to write ${key}: value contains a line break`);
      }
      return `${key}=${value}`;
    }
    return line;
  });

  // Atomic replace. A direct writeFileSync that is interrupted (crash,
  // full disk, container eviction) leaves the bot's .env truncated — and a
  // truncated .env means the next boot silently falls back to default risk
  // limits rather than the operator's configured ones.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const handle = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeFileSync(handle, next.join('\n'));
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // Never leave the temp file behind masquerading as config.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort
    }
    throw error;
  }

  return { written, missing: [...remaining] };
}
