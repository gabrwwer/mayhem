
import { describe, expect, it } from 'vitest';

import { canonicalize } from './canonical.js';

describe('canonicalize', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('encodes bigint exactly, beyond the safe integer range', () => {
    expect(canonicalize({ lamports: 9_007_199_254_740_993n })).toBe(
      '{"lamports":"9007199254740993"}',
    );
  });

  it('does not conflate a bigint with the number of the same value', () => {
    expect(canonicalize({ n: 1n })).not.toBe(canonicalize({ n: 1 }));
  });

  it('drops undefined rather than encoding it', () => {
    expect(canonicalize({ a: 1, b: undefined as never })).toBe('{"a":1}');
  });

  it('collapses negative zero', () => {
    expect(canonicalize({ n: -0 })).toBe(canonicalize({ n: 0 }));
  });

  it('refuses non-finite numbers, which have no JSON form', () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('escapes strings so delimiters cannot be smuggled in', () => {
    expect(canonicalize({ a: '","b":"' })).toBe('{"a":"\\",\\"b\\":\\""}');
  });
});