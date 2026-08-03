// Income source enum (must match db public.income_source). Order matches the
// enum's declaration order, which is also how the DB sorts it.
//
// `selectable: false` means the source exists in the DB and has to be labelled
// when a row carrying it is listed, but is not something a person picks by hand.
// 'loan_received' is only ever written by create_debt() — an unlinked loan row
// would be excluded from income reporting (borrowing is not earning) with no
// debt on the other side to offset it, which is strictly worse than recording
// the debt on /debts and letting it post the disbursement.
export const INCOME_SOURCES = [
  { value: "salary", label: "Salary", selectable: true },
  { value: "business", label: "Business", selectable: true },
  { value: "gains", label: "Gains", selectable: true },
  { value: "loan_received", label: "Loan received", selectable: false },
  { value: "debt_payment_received", label: "Debt payment to me", selectable: true },
  { value: "gift", label: "Gift", selectable: true },
  { value: "other", label: "Other", selectable: true },
] as const;

export type IncomeSource = (typeof INCOME_SOURCES)[number]["value"];

/** The sources the income form offers. */
export const SELECTABLE_INCOME_SOURCES = INCOME_SOURCES.filter(
  (s) => s.selectable,
);

export const INCOME_SOURCE_VALUES: string[] = SELECTABLE_INCOME_SOURCES.map(
  (s) => s.value,
);

/**
 * The enum member a user-named source is stored as. `income_source` is a
 * Postgres enum that reporting groups by, so a typed-in source cannot become a
 * new member — it becomes 'other' plus an `incomes.source_label`, which is what
 * the UI shows. See db/functions/custom_option_labels.sql.
 */
export const CUSTOM_INCOME_SOURCE = "other";

/**
 * What the picker actually lists. 'other' is absent on purpose: it is reached
 * by naming your own source instead, because a row labelled only "Other" tells
 * you nothing when you come back to it a month later. Rows already stored as a
 * bare 'other' still render as "Other" — see incomeSourceDisplay.
 */
export const PICKABLE_INCOME_SOURCES = SELECTABLE_INCOME_SOURCES.filter(
  (s) => s.value !== CUSTOM_INCOME_SOURCE,
);

export function incomeSourceLabel(value: string): string {
  return INCOME_SOURCES.find((s) => s.value === value)?.label ?? value;
}

/** What to call an income row: the user's own name for it, or the enum's. */
export function incomeSourceDisplay(
  value: string,
  label: string | null | undefined,
): string {
  return label?.trim() || incomeSourceLabel(value);
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
