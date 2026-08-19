import { useCallback, useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/**
 * Blocks a type parameter from being inferred at this position.
 *
 * Without it, `initial: SortState<K>` participates in inference and the literal
 * `{ key: "ageSec" }` narrows K to `"ageSec"` alone, so every other column key
 * is rejected. K must come from `accessors` only.
 *
 * Written by hand rather than using the built-in `NoInfer<T>` so this does not
 * depend on the resolved TypeScript being >= 5.4.
 */
type NoInferK<T> = [T][T extends unknown ? 0 : never];

/**
 * Client-side table sorting with null-last ordering.
 *
 * Nulls sort last in both directions on purpose: a missing metric is not a
 * small value, and letting it sort as if it were zero would put unenriched
 * tokens at the top of an "ascending liquidity" view as though they were
 * genuinely illiquid.
 */
export function useSortableRows<T, K extends string>(
  rows: T[] | null,
  accessors: Record<K, (row: T) => number | string | null>,
  initial: SortState<NoInferK<K>>,
) {
  const [sort, setSort] = useState<SortState<K>>(initial as SortState<K>);

  const toggle = useCallback((key: K) => {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  }, []);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const get = accessors[sort.key];
    if (!get) return rows;

    const factor = sort.dir === "asc" ? 1 : -1;

    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);

      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;

      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * factor;
      }
      return (av - bv) * factor;
    });
    // `accessors` is rebuilt every render by callers, so it is deliberately
    // excluded from the dependency list. Accessors are pure projections of a
    // row, so this cannot go stale in a way that affects the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);

  return { sorted, sort, toggle };
}

export interface SortableHeaderProps {
  "data-sortable": "true";
  "data-sorted": "true" | undefined;
  onClick: () => void;
  "aria-sort": "ascending" | "descending" | "none";
}

/** Props for a sortable <th>. Keeps header markup consistent across tables. */
export function sortableHeader<K extends string>(
  key: K,
  sort: SortState<K>,
  toggle: (key: K) => void,
): SortableHeaderProps {
  const active = sort.key === key;

  return {
    "data-sortable": "true",
    "data-sorted": active ? "true" : undefined,
    onClick: () => toggle(key),
    "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : "none",
  };
}
