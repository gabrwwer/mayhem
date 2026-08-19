#!/usr/bin/env node
/**
 * Emits a CycloneDX-shaped SBOM from the installed dependency tree.
 *
 * Uses `npm ls --all --json` rather than a third-party generator so the SBOM
 * reflects exactly what is installed from the lockfile.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OUTPUT = process.argv[2] ?? 'sbom.json';

function dependencyTree() {
  // `npm ls` exits non-zero on peer-dependency warnings while still emitting JSON.
  try {
    return JSON.parse(execFileSync('npm', ['ls', '--all', '--json'], { encoding: 'utf8' }));
  } catch (error) {
    const stdout = /** @type {{ stdout?: string }} */ (error).stdout;
    if (typeof stdout === 'string' && stdout.trim() !== '') return JSON.parse(stdout);
    throw error;
  }
}

function flatten(node, into = new Map()) {
  for (const [name, info] of Object.entries(node.dependencies ?? {})) {
    if (info.version !== undefined) {
      into.set(`${name}@${info.version}`, { name, version: info.version });
    }
    flatten(info, into);
  }
  return into;
}

const tree = dependencyTree();
const components = [...flatten(tree).values()]
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
  .map((c) => ({
    type: 'library',
    name: c.name,
    version: c.version,
    purl: `pkg:npm/${c.name.replace('@', '%40')}@${c.version}`,
  }));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: tree.name ?? 'mayhem',
      version: tree.version ?? '0.0.0',
    },
  },
  components,
};

writeFileSync(OUTPUT, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`sbom: wrote ${String(components.length)} component(s) to ${OUTPUT}`);