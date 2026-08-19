
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TimestampSchema, type Timestamp } from '@mayhem/core-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { hashEntry, LedgerEntrySchema } from './entry.js';
import { AuditLedger, toJsonSafe } from './ledger.js';
import { LocalEd25519Signer } from './signer.js';
import { FileLedgerStore, InMemoryLedgerStore, LedgerAppendError } from './store.js';

const signer = LocalEd25519Signer.generate('test-key-1');

function clock(start = 1_700_000_000_000): () => Timestamp {
  let t = start;

  return () => TimestampSchema.parse(t++);
}

describe('toJsonSafe', () => {
  it('renders bigint as an exact decimal string', () => {
    expect(toJsonSafe({ lamports: 2n ** 70n })).toEqual({ lamports: '1180591620717411303424' });
  });

  it('refuses values with no JSON representation', () => {
    expect(() => toJsonSafe({ fn: () => 1 })).toThrow(/function cannot be recorded/);
    expect(() => toJsonSafe({ n: Number.NaN })).toThrow(/non-finite/);
  });

  it('names the offending path', () => {
    expect(() => toJsonSafe({ a: { b: [Number.NaN] } })).toThrow('$.a.b[0]');
  });
});

describe('AuditLedger', () => {
  let store: InMemoryLedgerStore;
  let ledger: AuditLedger;

  beforeEach(() => {
    store = new InMemoryLedgerStore();
    ledger = new AuditLedger({ store, signer, now: clock() });
  });

  it('starts the chain with an unchained genesis entry', async () => {
    const entry = await ledger.append('kill_switch', { engaged: true });

    expect(entry.sequence).toBe(0);
    expect(entry.previousHash).toBeUndefined();
    expect(entry.signerKeyId).toBe('test-key-1');
  });

  it('chains each entry to its predecessor', async () => {
    const first = await ledger.append('decision', { a: 1 });
    const second = await ledger.append('decision', { a: 2 });

    expect(second.previousHash).toBe(first.entryHash);
    expect(second.sequence).toBe(1);
  });

  it('verifies a well-formed chain, signatures included', async () => {
    await ledger.append('order_intent', { amountIn: 1_000n });
    await ledger.append('risk_verdict', { approved: false });

    await expect(ledger.verify(signer)).resolves.toEqual({
      valid: true,
      entryCount: 2,
      failures: [],
    });
  });

  it('assigns distinct sequences to concurrent appends', async () => {
    const entries = await Promise.all([
      ledger.append('decision', { i: 0 }),
      ledger.append('decision', { i: 1 }),
      ledger.append('decision', { i: 2 }),
    ]);

    expect(entries.map((e) => e.sequence)).toEqual([0, 1, 2]);
    await expect(ledger.verify(signer)).resolves.toMatchObject({ valid: true });
  });

  it('keeps accepting appends after one fails', async () => {
    await expect(ledger.append('decision', { bad: Number.NaN })).rejects.toThrow(TypeError);

    const entry = await ledger.append('decision', { good: true });
    expect(entry.sequence).toBe(0);
  });

  it('records amounts losslessly through the payload', async () => {
    const entry = await ledger.append('fill', { feeLamports: 9_007_199_254_740_993n });

    expect(entry.payload['feeLamports']).toBe('9007199254740993');
  });

  describe('tamper detection', () => {
    it('detects an edited payload', async () => {
      await ledger.append('fill', { amount: '10' });
      await ledger.append('fill', { amount: '20' });

      const entries = await store.read();
      const forged = { ...entries[0], payload: { amount: '999' } };
      const tampered = new InMemoryLedgerStore();
      await tampered.append(LedgerEntrySchema.parse(forged));
      await tampered.append(LedgerEntrySchema.parse({ ...entries[1], sequence: 1 }));

      const result = await new AuditLedger({ store: tampered, signer, now: clock() }).verify(
        signer,
      );

      expect(result.valid).toBe(false);
      expect(result.failures.map((f) => f.reason)).toContain('hash_mismatch');
    });

    it('detects a rehashed payload, because the signature no longer matches', async () => {
      await ledger.append('fill', { amount: '10' });

      const [original] = await store.read();
      const payload = { amount: '999' };
      const forged = LedgerEntrySchema.parse({
        ...original,
        payload,
        entryHash: hashEntry({
          sequence: 0,
          recordedAt: original?.recordedAt ?? TimestampSchema.parse(0),
          kind: 'fill',
          payload,
        }),
      });

      const tampered = new InMemoryLedgerStore();
      await tampered.append(forged);

      const result = await new AuditLedger({ store: tampered, signer, now: clock() }).verify(
        signer,
      );

      expect(result.valid).toBe(false);
      expect(result.failures.map((f) => f.reason)).toEqual(['invalid_signature']);
    });

    it('detects a removed entry', async () => {
      await ledger.append('decision', { i: 0 });
      await ledger.append('decision', { i: 1 });
      await ledger.append('decision', { i: 2 });

      const entries = await store.read();
      const truncated = new InMemoryLedgerStore();
      await truncated.append(entries[0] as never);
      // Skip sequence 1; the store rejects the gap outright.
      await expect(truncated.append(entries[2] as never)).rejects.toBeInstanceOf(LedgerAppendError);
    });

    it('reports every failure, not just the first', async () => {
      await ledger.append('decision', { i: 0 });
      await ledger.append('decision', { i: 1 });

      const entries = await store.read();
      const tampered = new InMemoryLedgerStore();
      for (const entry of entries) {
        await tampered.append(LedgerEntrySchema.parse({ ...entry, payload: { i: 99 } }));
      }

      const result = await new AuditLedger({ store: tampered, signer, now: clock() }).verify(
        signer,
      );

      expect(result.failures).toHaveLength(2);
    });

    it('rejects a signature from a different key', async () => {
      await ledger.append('decision', { i: 0 });

      const other = LocalEd25519Signer.generate('test-key-2');
      const result = await ledger.verify(other);

      expect(result.valid).toBe(false);
      expect(result.failures[0]?.reason).toBe('invalid_signature');
    });
  });
});

describe('InMemoryLedgerStore', () => {
  it('refuses a non-contiguous sequence', async () => {
    const store = new InMemoryLedgerStore();
    const ledger = new AuditLedger({ store, signer, now: clock() });
    const entry = await ledger.append('decision', {});

    await expect(store.append(entry)).rejects.toBeInstanceOf(LedgerAppendError);
  });
});

describe('FileLedgerStore', () => {
  it('survives a reopen and keeps chaining', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mayhem-ledger-'));
    const path = join(dir, 'nested', 'audit.jsonl');

    const first = new AuditLedger({ store: new FileLedgerStore(path), signer, now: clock() });
    await first.append('decision', { i: 0 });

    const reopened = new AuditLedger({
      store: new FileLedgerStore(path),
      signer,
      now: clock(1_700_000_100_000),
    });
    const second = await reopened.append('decision', { i: 1 });

    expect(second.sequence).toBe(1);
    await expect(reopened.verify(signer)).resolves.toMatchObject({ valid: true, entryCount: 2 });
    expect((await readFile(path, 'utf8')).trimEnd().split('\n')).toHaveLength(2);
  });

  it('refuses to load a file whose lines are not entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mayhem-ledger-'));
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, '{"sequence":0}\n', 'utf8');

    await expect(new FileLedgerStore(path).read()).rejects.toBeInstanceOf(LedgerAppendError);
  });
});