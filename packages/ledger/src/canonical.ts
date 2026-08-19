
/**
 * Canonical JSON encoding.
 *
 * The hash chain is only as trustworthy as the bytes it covers, so the
 * encoding has to be a function of the value alone: object key order must not
 * matter, and `bigint` â€” which `JSON.stringify` refuses outright â€” has to
 * survive as an exact decimal string rather than a lossy `number`.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly CanonicalValue[]
  // `undefined` is admitted only to be dropped: an absent key and a key set to
  // undefined must produce the same digest.
  | { readonly [key: string]: CanonicalValue | undefined };

export function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number: ${String(value)}`);
      }
      // -0 and 0 must not produce different digests for the same quantity.
      return JSON.stringify(value === 0 ? 0 : value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalize(element as CanonicalValue)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter((entry): entry is [string, CanonicalValue] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalize(v)}`);

  return `{${entries.join(',')}}`;
}