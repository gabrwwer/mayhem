#!/usr/bin/env node
/**
 * Secret scanner for tracked files.
 *
 * Fails closed: any finding exits non-zero. This is a pre-commit/CI gate, not a
 * substitute for a full scanner (gitleaks/trufflehog) in a hosted pipeline.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;

const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.mp4',
  '.wasm',
]);

const SKIP_PATHS = [
  /^package-lock\.json$/,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
];

/**
 * `allowPlaceholders` marks rules loose enough to fire on documentation. The
 * high-confidence rules below it never yield to the allowlist: a string shaped
 * exactly like a live credential is a finding even if it sits next to the word
 * "example", because the cost of rotating one is far below the cost of leaking
 * one.
 */
const RULES = [
  {
    id: 'private-key-block',
    description: 'PEM private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
    allowPlaceholders: false,
  },
  {
    id: 'solana-keypair-array',
    description: 'Solana keypair byte array (64 numbers)',
    pattern: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g,
    allowPlaceholders: false,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    allowPlaceholders: false,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    allowPlaceholders: false,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    allowPlaceholders: false,
  },
  {
    id: 'generic-assigned-secret',
    description: 'Hardcoded secret assignment',
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|password|passphrase|mnemonic|seed[_-]?phrase)\b\s*[:=]\s*['"][^'"\s${}]{12,}['"]/gi,
    allowPlaceholders: true,
  },
  {
    id: 'rpc-url-with-key',
    description: 'RPC endpoint with embedded API key',
    pattern:
      /https:\/\/[a-z0-9.-]*(?:helius|quicknode|alchemy|triton|syndica)[a-z0-9.-]*\/[^\s'"]{16,}/gi,
    allowPlaceholders: true,
  },
];

/**
 * Patterns marking a match as a placeholder rather than a live credential.
 *
 * These are tested against the matched text alone, never the whole line: a real
 * key sitting next to a `process.env` reference must still be reported.
 */
const ALLOWLIST = [
  /\$\{[A-Z_][A-Z0-9_]*\}/,
  /\bprocess\.env\./,
  /\b(?:example|placeholder|redacted|changeme|your[\w-]*here|xxx+|<[^>]+>)\b/i,
];

function isPlaceholder(match) {
  return ALLOWLIST.some((a) => a.test(match));
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function shouldSkip(file) {
  if (SKIP_EXTENSIONS.has(extname(file).toLowerCase())) return true;
  if (SKIP_PATHS.some((p) => p.test(file))) return true;
  // The scanner and its fixtures necessarily contain credential-shaped strings.
  if (file === 'scripts/secret-scan.mjs' || file === 'scripts/secret-scan.test.mjs') return true;
  return false;
}

/**
 * Scans one file's contents. Exported so the rules can be tested directly
 * rather than only through a git checkout.
 */
export function scanContent(content, file = '<input>') {
  const findings = [];

  for (const [index, line] of content.split('\n').entries()) {
    for (const rule of RULES) {
      for (const [match] of line.matchAll(rule.pattern)) {
        if (rule.allowPlaceholders && isPlaceholder(match)) continue;
        findings.push({ file, line: index + 1, rule: rule.id, description: rule.description });
      }
    }
  }

  return findings;
}

function scanRepository() {
  const findings = [];

  for (const file of trackedFiles()) {
    if (shouldSkip(file)) continue;

    let stats;
    try {
      stats = statSync(file);
    } catch {
      continue; // gitlink or otherwise unreadable
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) continue;

    const content = readFileSync(file, 'utf8');
    if (content.includes('\0')) continue;

    findings.push(...scanContent(content, file));
  }

  return findings;
}

function main() {
  const findings = scanRepository();

  if (findings.length > 0) {
    console.error(`secret-scan: ${String(findings.length)} finding(s)\n`);
    for (const f of findings) {
      console.error(`  ${f.file}:${String(f.line)}  [${f.rule}] ${f.description}`);
    }
    console.error('\nRemove the secret and rotate it. Never commit credentials.');
    process.exit(1);
  }

  console.log('secret-scan: clean');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();