// Investment enums, mirrored from db public.investment_kind, plus the display
// helpers the investments pages need.
//
// todayIso / formatDate / one are duplicated from the goals and debts features
// rather than shared. That follows the existing per-feature convention; lifting
// them into lib/ is a worthwhile cleanup that now touches four features and
// belongs in its own change.

/** The catch-all member. A typed-in type name is stored against this. */
export const CUSTOM_INVESTMENT_KIND = "other_asset";

export const INVESTMENT_KIND_LABELS: Record<string, string> = {
  mp2: "Pag-IBIG MP2",
  crypto: "Crypto",
  stock: "Stock",
  mutual_fund: "Mutual fund",
  bond: "Bond",
  real_estate: "Real estate",
  other_asset: "Other",
};

export const INVESTMENT_KIND_VALUES = Object.keys(INVESTMENT_KIND_LABELS);

/**
 * The types offered in the picker. `other_asset` is omitted on purpose: the
 * "+ Name my own type…" entry the ChoiceWithCustom component appends IS that
 * member, and offering both would give the user two ways to pick the same enum
 * value — one of which silently records no name.
 */
export const PICKABLE_INVESTMENT_KINDS = INVESTMENT_KIND_VALUES.filter(
  (v) => v !== CUSTOM_INVESTMENT_KIND,
).map((value) => ({ value, label: INVESTMENT_KIND_LABELS[value] }));

/**
 * What to call a holding's type. A custom name replaces the generic "Other"
 * entirely — someone who typed "Gold bar" should read "Gold bar", not
 * "Other (Gold bar)".
 */
export function investmentKindLabel(
  kind: string,
  kindLabel?: string | null,
): string {
  const custom = kindLabel?.trim();
  if (custom) return custom;
  return INVESTMENT_KIND_LABELS[kind] ?? kind;
}

/** Today as `YYYY-MM-DD` in local time — the format every date input wants. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Return on a holding, or null when there is nothing to divide by.
 *
 * Mirrors v_investment_performance's own guard. A zero cost basis is legitimate
 * — an asset you were given, or one whose purchase price you no longer know —
 * so this has to be "no answer", not 0% and not NaN%.
 */
export function returnPct(
  invested: number | string,
  current: number | string,
): number | null {
  const cost = Number(invested);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return ((Number(current) - cost) / cost) * 100;
}

/**
 * A maturity date that has passed. Computed, never stored — like a debt's
 * overdue flag, there is no status for it and adding one would need a scheduled
 * job to keep it true.
 */
export function hasMatured(
  maturityDate: string | null,
  today = todayIso(),
): boolean {
  if (!maturityDate) return false;
  // Both sides are YYYY-MM-DD, so a string compare is a date compare.
  return maturityDate < today;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Quantities are numeric(28,8) — trailing zeros make a share count unreadable. */
export function formatQuantity(value: number | string | null): string | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** PostgREST returns an embedded one-to-one as either an object or a 1-element array. */
export function one<T>(v: T | T[] | null | undefined): T | undefined {
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}
