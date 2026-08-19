
import { z } from 'zod';
import { AgentIdSchema } from './primitives.js';
import { ApprovalGateSchema } from './decisions.js';

export const AgentRoleSchema = z.enum([
  'orchestrator',
  'analyst',
  'detector',
  'executor',
  'auditor',
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Capabilities an agent may exercise. These are enforced by the capability
 * service at runtime; the manifest is the declaration, not the enforcement.
 */
export const AgentPermissionsSchema = z
  .object({
    assign_tasks: z.boolean(),
    read_system_state: z.boolean(),
    write_system_state: z.boolean(),
    enforce_rbac: z.boolean(),
    launch_audits: z.boolean(),
    launch_simulations: z.boolean(),
    evaluate_metrics: z.boolean(),
    modify_templates: z.boolean(),
    wallet_control: z.boolean(),
    access_secrets: z.boolean(),
    modify_infrastructure_controls: z.boolean(),
  })
  .strict();
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

/**
 * Capabilities that must never be granted to an orchestrator. Signing
 * authority lives solely in the execution service, so a supervisor that can
 * both direct agents and move funds would collapse the separation of duties
 * the whole design rests on.
 */
export const ORCHESTRATOR_FORBIDDEN_PERMISSIONS = [
  'wallet_control',
  'access_secrets',
  'modify_infrastructure_controls',
] as const satisfies readonly (keyof AgentPermissions)[];

export const AgentManifestSchema = z
  .object({
    id: AgentIdSchema,
    display_name: z.string().min(1),
    role: AgentRoleSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be semver'),
    maintainer: z.string().min(1),
    description: z.string().min(1),
    responsibilities: z.array(z.record(z.string(), z.string())).min(1),
    permissions: AgentPermissionsSchema,
    human_approval_required_for: z.array(ApprovalGateSchema),
    protected_controls: z.array(z.string().min(1)),
    decision_policies: z
      .object({
        conflict_resolution: z.string().min(1),
        fallback_policy: z.literal('require_human_approval'),
      })
      .strict(),
    audit: z
      .object({
        enabled: z.literal(true),
        trail_type: z.literal('append_only_ledger'),
        storage: z.string().min(1),
        retention_days: z.number().int().min(3_650),
        signing: z.literal(true),
      })
      .strict(),
    safety: z
      .object({
        max_concurrent_assignments: z.number().int().positive(),
        rate_limits: z.record(z.string(), z.number().positive()),
        anomaly_detection: z
          .object({
            enabled: z.literal(true),
            sensitivity: z.enum(['low', 'medium', 'high']),
          })
          .strict(),
        heartbeat_interval_seconds: z.number().int().positive(),
      })
      .strict(),
    observability: z
      .object({
        emit_metrics: z.literal(true),
        metrics_namespace: z.string().min(1),
        alerting: z
          .array(
            z
              .object({
                on: z.string().min(1),
                severity: z.enum(['low', 'medium', 'high', 'critical']),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.role !== 'orchestrator') return;

    for (const permission of ORCHESTRATOR_FORBIDDEN_PERMISSIONS) {
      if (manifest.permissions[permission]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions', permission],
          message: `an orchestrator must never be granted ${permission}`,
        });
      }
    }

    for (const gate of ApprovalGateSchema.options) {
      if (!manifest.human_approval_required_for.includes(gate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['human_approval_required_for'],
          message: `an orchestrator must gate ${gate} behind human approval`,
        });
      }
    }
  });
export type AgentManifest = z.infer<typeof AgentManifestSchema>;