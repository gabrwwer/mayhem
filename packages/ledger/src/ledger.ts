
import { TimestampSchema, type Timestamp } from '@mayhem/core-types';

import { hashEntry, LedgerEntrySchema, type LedgerEntry, type LedgerEntryKind } from './entry.js';
import type { LedgerSigner, LedgerVerifier } from './signer.js';
import type { LedgerStore } from './store.js';

export type JsonSafe =
  null | boolean | number | string | readonly JsonSafe[] | { readonly [key: string]: JsonSafe };

export type LedgerPayload = Record<string, unknown>;

/**
 * Converts a payload to a form that survives a JSON round trip unchanged.
 *
 * `bigint` becomes a decimal string, because the domain's lamport amounts do
 * not fit in a double and a ledger that silently rounds is worse than none.
 * Anything with no JSON representation is rejected rather than dropped: a
 * missing field in an audit record is a lie about what happened.
 */
export function toJsonSafe(value: unknown, path = '$'): JsonSafe {
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'bigint':
      return value.toString();
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path}: non-finite number cannot be recorded`);
      }

      return value;
    case 'object':
      break;
    default:
      throw new TypeError(`${path}: ${typeof value} cannot be recorded`);
  }

  if (Array.isArray(value)) {
    return value.map((element, index) => toJsonSafe(element, `${path}[${String(index)}]`));
  }

  const result: Record<string, JsonSafe> = {};
  for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
    if (element === undefined) continue;
    result[key] = toJsonSafe(element, `${path}.${key}`);
  }

  return result;
}

export interface AuditLedgerOptions {
  readonly store: LedgerStore;
  readonly signer: LedgerSigner;
  readonly now: () => Timestamp;
}

export type VerificationFailureReason =
  'sequence_gap' | 'broken_chain' | 'hash_mismatch' | 'invalid_signature' | 'malformed_entry';

export interface VerificationFailure {
  readonly sequence: number;
  readonly reason: VerificationFailureReason;
  readonly detail: string;
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly entryCount: number;
  readonly failures: readonly VerificationFailure[];
}

/**
 * Append-only, hash-chained, signed audit trail.
 *
 * Appends are serialized through a single promise chain: two concurrent
 * callers must not read the same tail and mint the same sequence number.
 */
export class AuditLedger {
  readonly #store: LedgerStore;
  readonly #signer: LedgerSigner;
  readonly #now: () => Timestamp;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: AuditLedgerOptions) {
    this.#store = options.store;
    this.#signer = options.signer;
    this.#now = options.now;
  }

  append(kind: LedgerEntryKind, payload: LedgerPayload): Promise<LedgerEntry> {
    const queued = this.#tail.then(() => this.#appendNow(kind, payload));
    // Keep the chain alive after a rejection so one bad append is not fatal.
    this.#tail = queued.catch(() => undefined);

    return queued;
  }

  async #appendNow(kind: LedgerEntryKind, payload: LedgerPayload): Promise<LedgerEntry> {
    const previous = await this.#store.last();
    const safePayload = toJsonSafe(payload) as Record<string, unknown>;

    const hashable = {
      sequence: previous === undefined ? 0 : previous.sequence + 1,
      recordedAt: TimestampSchema.parse(this.#now()),
      kind,
      payload: safePayload,
      ...(previous === undefined ? {} : { previousHash: previous.entryHash }),
    };

    const entryHash = hashEntry(hashable);
    const entry = LedgerEntrySchema.parse({
      ...hashable,
      entryHash,
      signature: this.#signer.sign(entryHash),
      signerKeyId: this.#signer.keyId,
    });

    await this.#store.append(entry);

    return entry;
  }

  /**
   * Walks the whole chain. Reports every failure rather than stopping at the
   * first: during an incident, knowing where tampering starts and ends matters
   * more than a single boolean.
   */
  async verify(verifier?: LedgerVerifier): Promise<VerificationResult> {
    const entries = await this.#store.read();
    const failures: VerificationFailure[] = [];
    let previous: LedgerEntry | undefined;

    for (const [index, entry] of entries.entries()) {
      if (entry.sequence !== index) {
        failures.push({
          sequence: entry.sequence,
          reason: 'sequence_gap',
          detail: `entry at position ${String(index)} claims sequence ${String(entry.sequence)}`,
        });
      }

      const expectedPrevious = previous?.entryHash;
      if (entry.previousHash !== expectedPrevious) {
        failures.push({
          sequence: entry.sequence,
          reason: 'broken_chain',
          detail: `previousHash ${entry.previousHash ?? '<none>'} does not match ${
            expectedPrevious ?? '<none>'
          }`,
        });
      }

      const recomputed = hashEntry(entry);
      if (recomputed !== entry.entryHash) {
        failures.push({
          sequence: entry.sequence,
          reason: 'hash_mismatch',
          detail: `recomputed ${recomputed}, stored ${entry.entryHash}`,
        });
      }

      if (
        verifier !== undefined &&
        !verifier.verify(entry.entryHash, entry.signature, entry.signerKeyId)
      ) {
        failures.push({
          sequence: entry.sequence,
          reason: 'invalid_signature',
          detail: `signature does not verify under key ${entry.signerKeyId}`,
        });
      }

      previous = entry;
    }

    return { valid: failures.length === 0, entryCount: entries.length, failures };
  }
}