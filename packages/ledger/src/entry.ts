
import { createHash } from 'node:crypto';

import { TimestampSchema } from '@mayhem/core-types';
import { z } from 'zod';

import { canonicalize, type CanonicalValue } from './canonical.js';

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha-256 digest');

export const LedgerEntryKindSchema = z.enum([
  'decision',
  'order_intent',
  'risk_verdict',
  'order_state_change',
  'fill',
  'approval',
  'reconciliation',
  'config_change',
  'kill_switch',
]);
export type LedgerEntryKind = z.infer<typeof LedgerEntryKindSchema>;

/**
 * One record in the append-only trail.
 *
 * `entryHash` covers the entry's own fields *and* `previousHash`, so altering
 * any earlier entry invalidates every entry after it. `signature` covers
 * `entryHash`, so an attacker who can write to the store still cannot forge a
 * chain without the signing key.
 */
export const LedgerEntrySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    recordedAt: TimestampSchema,
    kind: LedgerEntryKindSchema,
    payload: z.record(z.unknown()),
    /** Digest of the preceding entry; absent only for the genesis entry. */
    previousHash: Sha256HexSchema.optional(),
    entryHash: Sha256HexSchema,
    signature: z.string().min(1),
    signerKeyId: z.string().min(1).max(200),
  })
  .strict()
  .refine((entry) => (entry.sequence === 0) === (entry.previousHash === undefined), {
    message: 'exactly the genesis entry may omit previousHash',
    path: ['previousHash'],
  });
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** The hashed fields, in the order the digest covers them. */
export type HashableEntry = Pick<
  LedgerEntry,
  'sequence' | 'recordedAt' | 'kind' | 'payload' | 'previousHash'
>;

export function hashEntry(entry: HashableEntry): string {
  const preimage = canonicalize({
    sequence: entry.sequence,
    recordedAt: entry.recordedAt,
    kind: entry.kind,
    payload: entry.payload as CanonicalValue,
    previousHash: entry.previousHash ?? null,
  });

  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}