/**
 * Splitting a list of accounts into one bucket per currency.
 *
 * WHY THIS EXISTS
 *
 * There is no FX conversion in v1 (ROADMAP Phase 4, DECISIONS-NEEDED #5), so any
 * place the app puts amounts from different currencies in a single ordered list
 * or a single sum is telling a lie with real numbers. Sorting `/portfolios` by
 * balance ascending used to produce:
 *
 *     GCash        ₱665.47
 *     Wise Dollar  $850.00      <- neither the smallest nor in the right place
 *     Tonik        ₱1,274.47
 *
 * Arithmetically correct, economically meaningless. Grouping first and sorting
 * inside each group is the cheap half of that fix; the other half is that a
 * subtotal now exists at all, and only ever covers one currency.
 *
 * The rows keep whatever order they arrived in, so the caller's `ORDER BY` still
 * decides the order WITHIN a group — a global "balance descending" is still
 * descending once the currencies are separated.
 */

export interface CurrencyEmbed {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

export interface CurrencyGroup<T> {
  code: string;
  currency: CurrencyEmbed | undefined;
  rows: T[];
  /** Sum of this group's rows. Never comparable to another group's. */
  total: number;
}

/**
 * Group `rows` by currency code.
 *
 * Group ORDER is the user's default currency first, then alphabetical by code.
 * Deliberately NOT by total: ranking the groups by size would compare a peso
 * total against a dollar total, which is the exact comparison this function was
 * written to remove. Alphabetical is arbitrary but honest, and stable across
 * sort directions so the groups don't jump around when a header is clicked.
 *
 * Rows whose currency embed failed to load fall into a "—" group rather than
 * being dropped: a row that vanishes from an account list is a worse bug than
 * one with a missing symbol.
 */
export function groupByCurrency<T>(
  rows: readonly T[],
  currencyOf: (row: T) => CurrencyEmbed | undefined,
  amountOf: (row: T) => number | string,
  preferredCode?: string,
): CurrencyGroup<T>[] {
  const groups = new Map<string, CurrencyGroup<T>>();

  for (const row of rows) {
    const currency = currencyOf(row);
    const code = currency?.code ?? "—";
    const group = groups.get(code) ?? {
      code,
      currency,
      rows: [] as T[],
      total: 0,
    };
    group.rows.push(row);
    const amount = Number(amountOf(row));
    group.total += Number.isFinite(amount) ? amount : 0;
    // A later row may carry the embed an earlier one was missing.
    group.currency = group.currency ?? currency;
    groups.set(code, group);
  }

  return [...groups.values()].sort((a, b) => {
    if (preferredCode) {
      if (a.code === preferredCode) return -1;
      if (b.code === preferredCode) return 1;
    }
    return a.code.localeCompare(b.code);
  });
}
