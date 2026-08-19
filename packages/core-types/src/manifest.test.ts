
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AgentManifestSchema, ORCHESTRATOR_FORBIDDEN_PERMISSIONS } from './manifest.js';

/** Vitest runs from the workspace root. */
const MANIFEST_PATH = join(process.cwd(), 'agents/quantum_master_supervisor.yaml');

function loadSupervisorManifest(): unknown {
  return parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

describe('AgentManifestSchema', () => {
  it('accepts the committed supervisor manifest', () => {
    const result = AgentManifestSchema.safeParse(loadSupervisorManifest());
    expect(result.error?.issues ?? []).toStrictEqual([]);
    expect(result.success).toBe(true);
  });

  it.each(ORCHESTRATOR_FORBIDDEN_PERMISSIONS)(
    'rejects an orchestrator granted %s',
    (permission) => {
      const manifest = loadSupervisorManifest() as {
        permissions: Record<string, boolean>;
      };
      manifest.permissions[permission] = true;

      const result = AgentManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    },
  );

  it('rejects an orchestrator that drops a human approval gate', () => {
    const manifest = loadSupervisorManifest() as { human_approval_required_for: string[] };
    manifest.human_approval_required_for = manifest.human_approval_required_for.filter(
      (gate) => gate !== 'any_action_affecting_wallets',
    );

    expect(AgentManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a retention period below the ten-year commitment', () => {
    const manifest = loadSupervisorManifest() as { audit: { retention_days: number } };
    manifest.audit.retention_days = 30;

    expect(AgentManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a fallback policy other than requiring human approval', () => {
    const manifest = loadSupervisorManifest() as {
      decision_policies: { fallback_policy: string };
    };
    manifest.decision_policies.fallback_policy = 'auto_approve';

    expect(AgentManifestSchema.safeParse(manifest).success).toBe(false);
  });
});