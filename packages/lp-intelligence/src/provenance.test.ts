import { SlotSchema, TimestampSchema, type Slot, type Timestamp } from '@mayhem/core-types';
import { describe, expect, it } from 'vitest';

import {
  ObservedNumberSchema,
  estimated,
  hasValue,
  isObservedOnChain,
  mapObserved,
  observed,
  observedValueOrNull,
  unavailable,
} from './provenance.js';

const SLOT: Slot = SlotSchema.parse(250_000_000);
const NOW: Timestamp = TimestampSchema.parse(1_700_000_000_000);
const SOURCE = 'test:vault';

describe('observed()', () => {
  it('records an on-chain reading with its slot', () => {
    const o = observed(12.5, { slot: SLOT, observedAt: NOW, source: SOURCE });

    expect(o.value).toBe(12.5);
    expect(o.provenance).toBe('OBSERVED_ONCHAIN');
    expect(o.slot).toBe(SLOT);
    expect(isObservedOnChain(o)).toBe(true);
  });

  it('defaults txSignature to null rather than omitting it', () => {
    const o = observed(1, { slot: SLOT, observedAt: NOW, source: SOURCE });
    expect(o.txSignature).toBeNull();
  });
});

describe('estimated()', () => {
  it('never carries a slot, so it cannot be mistaken for a reading', () => {
    const e = estimated(9, { observedAt: NOW, source: SOURCE });

    expect(e.provenance).toBe('ESTIMATED');
    expect(e.slot).toBeNull();
    expect(e.txSignature).toBeNull();
  });

  it('is not accepted as an on-chain observation', () => {
    const e = estimated(9, { observedAt: NOW, source: SOURCE });

    expect(isObservedOnChain(e)).toBe(false);
    expect(observedValueOrNull(e)).toBeNull();
    // It does still carry a value — an estimate is not an absence.
    expect(hasValue(e)).toBe(true);
  });
});

describe('unavailable()', () => {
  it('carries no value at all', () => {
    const u = unavailable<number>({ observedAt: NOW, source: SOURCE });

    expect(u.value).toBeNull();
    expect(u.provenance).toBe('UNAVAILABLE');
    expect(hasValue(u)).toBe(false);
    expect(observedValueOrNull(u)).toBeNull();
  });

  it('is distinguishable from an observed zero', () => {
    const zero = observed(0, { slot: SLOT, observedAt: NOW, source: SOURCE });
    const missing = unavailable<number>({ observedAt: NOW, source: SOURCE });

    // The whole point: a pool with no liquidity and a pool we could not read
    // must not compare equal.
    expect(isObservedOnChain(zero)).toBe(true);
    expect(isObservedOnChain(missing)).toBe(false);
    expect(zero.value).toBe(0);
    expect(missing.value).toBeNull();
  });
});

describe('ObservedNumberSchema invariants', () => {
  it('rejects a null value that does not claim UNAVAILABLE', () => {
    const result = ObservedNumberSchema.safeParse({
      value: null,
      provenance: 'OBSERVED_ONCHAIN',
      slot: SLOT,
      txSignature: null,
      observedAt: NOW,
      source: SOURCE,
    });

    expect(result.success).toBe(false);
  });

  it('rejects an UNAVAILABLE observation that carries a value', () => {
    const result = ObservedNumberSchema.safeParse({
      value: 5,
      provenance: 'UNAVAILABLE',
      slot: null,
      txSignature: null,
      observedAt: NOW,
      source: SOURCE,
    });

    expect(result.success).toBe(false);
  });

  it('rejects an on-chain observation with no slot', () => {
    const result = ObservedNumberSchema.safeParse({
      value: 5,
      provenance: 'OBSERVED_ONCHAIN',
      slot: null,
      txSignature: null,
      observedAt: NOW,
      source: SOURCE,
    });

    expect(result.success).toBe(false);
  });

  it('accepts an estimate with no slot', () => {
    const result = ObservedNumberSchema.safeParse(
      estimated(5, { observedAt: NOW, source: SOURCE }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts a well-formed observation', () => {
    const result = ObservedNumberSchema.safeParse(
      observed(5, { slot: SLOT, observedAt: NOW, source: SOURCE }),
    );

    expect(result.success).toBe(true);
  });
});

describe('mapObserved()', () => {
  it('applies the mapper to a present value and keeps the evidence', () => {
    const o = observed(2, { slot: SLOT, observedAt: NOW, source: SOURCE });
    const mapped = mapObserved(o, (n) => n * 10);

    expect(mapped.value).toBe(20);
    expect(mapped.slot).toBe(SLOT);
    expect(mapped.provenance).toBe('OBSERVED_ONCHAIN');
  });

  it('never invokes the mapper on an unavailable observation', () => {
    let called = false;
    const u = unavailable<number>({ observedAt: NOW, source: SOURCE });

    const mapped = mapObserved(u, (n) => {
      called = true;
      return n * 10;
    });

    expect(called).toBe(false);
    expect(mapped.value).toBeNull();
    expect(mapped.provenance).toBe('UNAVAILABLE');
  });
});
