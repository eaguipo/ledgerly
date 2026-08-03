// Portfolio category enum (must match db public.portfolio_category).
export const PORTFOLIO_CATEGORIES = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank" },
  { value: "crypto", label: "Crypto" },
  { value: "investment", label: "Investment" },
  { value: "others", label: "Others" },
] as const;

export type PortfolioCategory = (typeof PORTFOLIO_CATEGORIES)[number]["value"];

export const CATEGORY_VALUES: string[] = PORTFOLIO_CATEGORIES.map((c) => c.value);

/**
 * The enum member a user-named category is stored as. `portfolio_category` is a
 * Postgres enum and `portfolios.is_liquid` is generated from it, so a typed-in
 * category cannot become a new member — it becomes 'others' plus a
 * `portfolios.category_label`. See db/functions/custom_option_labels.sql.
 *
 * Unlike /income, 'Others' stays in the picker: accounts are editable, and
 * dropping it would leave an account already stored as a bare 'others' with no
 * matching option — the select would silently fall through to "Cash" and the
 * next save would re-categorise it.
 */
export const CUSTOM_PORTFOLIO_CATEGORY = "others";

export function categoryLabel(value: string): string {
  return PORTFOLIO_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

/** What to call an account's category: the user's own name for it, or the enum's. */
export function categoryDisplay(
  value: string,
  label: string | null | undefined,
): string {
  return label?.trim() || categoryLabel(value);
}
