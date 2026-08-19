
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { BotConfigSchema, type BotConfig } from "./schema";

export type { BotConfig };

let cached: BotConfig | null = null;

export function loadConfig(envPath?: string): BotConfig {
  if (cached) return cached; // parse exactly once per process

  const resolvedEnvPath = envPath ?? path.resolve(process.cwd(), ".env");

  if (existsSync(resolvedEnvPath)) {
    const out = dotenv.config({
      path: resolvedEnvPath,
      override: false, // real env vars win; .env only fills gaps
      quiet: true,     // no "injecting env" noise on every boot
    });
    if (out.error) throw out.error;
  } else if (envPath) {
    // Explicit path requested but missing ? fail loudly, never boot with defaults
    throw new Error(`Env file not found: ${resolvedEnvPath}`);
  }
  // No .env ? rely on real environment (Docker/k8s/systemd)

  const result = BotConfigSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid bot configuration:\n${formatted}`);
  }

  cached = Object.freeze(result.data) as BotConfig;
  return cached;
}

/** Tests only ï¿½ clear the memo so a fixture envPath can be parsed. */
export function resetConfigForTests(): void {
  cached = null;
}