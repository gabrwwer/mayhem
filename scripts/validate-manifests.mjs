#!/usr/bin/env node
/**
 * Validates every agent manifest in agents/ against the runtime schema in
 * @mayhem/core-types, so a manifest can never grant a capability the system
 * refuses to honour. Requires `npm run build` first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { AgentManifestSchema } from '@mayhem/core-types';

const AGENTS_DIR = 'agents';

const manifests = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

if (manifests.length === 0) {
  console.error(`validate-manifests: no manifests found in ${AGENTS_DIR}/`);
  process.exit(1);
}

let failed = 0;

for (const file of manifests) {
  const path = join(AGENTS_DIR, file);
  const result = AgentManifestSchema.safeParse(parse(readFileSync(path, 'utf8')));

  if (result.success) {
    console.log(`  ok    ${path}`);
    continue;
  }

  failed += 1;
  console.error(`  FAIL  ${path}`);
  for (const issue of result.error.issues) {
    console.error(`          ${issue.path.join('.') || '<root>'}: ${issue.message}`);
  }
}

if (failed > 0) {
  console.error(`\nvalidate-manifests: ${String(failed)} manifest(s) invalid`);
  process.exit(1);
}

console.log(`validate-manifests: ${String(manifests.length)} manifest(s) valid`);