// Income source enum (must match db public.income_source). Order matches the
// enum's declaration order, which is also how the DB sorts it.
export const INCOME_SOURCES = [
  { value: "salary", label: "Salary" },
  { value: "business", label: "Business" },
  { value: "gains", label: "Gains" },
  { value: "debt_payment_received", label: "Debt payment to me" },
  { value: "gift", label: "Gift" },
  { value: "other", label: "Other" },
] as const;

export type IncomeSource = (typeof INCOME_SOURCES)[number]["value"];

export const INCOME_SOURCE_VALUES: string[] = INCOME_SOURCES.map((s) => s.value);

export function incomeSourceLabel(value: string): string {
  return INCOME_SOURCES.find((s) => s.value === value)?.label ?? value;
}

/** Placeholder for the "who paid you" field, which reads differently per source. */
export function sourceNamePlaceholder(value: string): string {
  switch (value) {
    case "salary":
      return "Employer name";
    case "business":
      return "Client or business name";
    case "gains":
      return "Where the gain came from";
    case "debt_payment_received":
      return "Who paid you back";
    case "gift":
      return "Who gave it to you";
    default:
      return "Where it came from";
  }
}
