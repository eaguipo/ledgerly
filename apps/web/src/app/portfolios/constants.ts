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

export function categoryLabel(value: string): string {
  return PORTFOLIO_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}
