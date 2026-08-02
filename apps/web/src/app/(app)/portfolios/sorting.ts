/**
 * Column sorting for the accounts table, driven through the URL (`?sort=&dir=`)
 * rather than component state so the order survives reload, back/forward and a
 * shared link.
 *
 * No sort param means the table's default order (`sort_order`, then
 * `created_at`) — clicking a header is an explicit override of that, not a
 * replacement for it.
 */

export type SortKey = "name" | "category" | "balance";
export type SortDir = "asc" | "desc";

export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/** URL sort key → the `portfolios` column PostgREST orders by. */
const COLUMN: Record<SortKey, string> = {
  name: "name",
  category: "category",
  balance: "current_balance",
};

/**
 * The direction a column sorts on its *first* click. Names read A→Z, money
 * reads biggest-first — defaulting everything to ascending would make the
 * balance header need two clicks to do the useful thing.
 */
const FIRST_CLICK: Record<SortKey, SortDir> = {
  name: "asc",
  category: "asc",
  balance: "desc",
};

function isSortKey(v: string | undefined): v is SortKey {
  return v === "name" || v === "category" || v === "balance";
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Anything unrecognised resolves to `null` — the default order. A hand-edited
 * or stale URL therefore degrades to the normal table instead of erroring, and
 * `sort` can never reach `.order()` as an arbitrary string.
 */
export function parseSort(params: {
  sort?: string | string[];
  dir?: string | string[];
}): Sort | null {
  const key = first(params.sort);
  if (!isSortKey(key)) return null;

  const dir = first(params.dir);
  return {
    key,
    dir: dir === "asc" || dir === "desc" ? dir : FIRST_CLICK[key],
  };
}

/** Arguments for the Supabase `.order()` call. */
export function sortColumn(sort: Sort): {
  column: string;
  ascending: boolean;
} {
  return { column: COLUMN[sort.key], ascending: sort.dir === "asc" };
}

/**
 * Where a header links to: the active column flips direction, any other column
 * starts at its own first-click direction.
 */
export function sortHref(key: SortKey, current: Sort | null): string {
  const dir =
    current?.key === key
      ? current.dir === "asc"
        ? "desc"
        : "asc"
      : FIRST_CLICK[key];

  return `/portfolios?sort=${key}&dir=${dir}`;
}

/** `null` when this column is not the active sort — drives the header arrow. */
export function directionOf(key: SortKey, current: Sort | null): SortDir | null {
  return current?.key === key ? current.dir : null;
}
