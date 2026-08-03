// Row shapes for the reporting views. Money arrives as a string when Postgres
// numeric(38,18) exceeds what JSON holds as a number, so every amount is
// `number | string` and gets Number()'d at the point of display.
//
// Every one of these views reports by currency CODE, not currency id — which is
// why the report is scoped by code throughout.

export interface CurrencyInfo {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

/** v_cashflow — one row per (day, direction). */
export interface CashflowRow {
  txn_date: string;
  direction: "inflow" | "outflow";
  total: number | string;
  currency_code: string;
}

/** v_expense_by_category — one row per (category, day). */
export interface ExpenseByCategoryRow {
  category_id: string;
  category_name: string;
  txn_date: string;
  total: number | string;
  currency_code: string;
}

/**
 * v_income_by_source — one row per (source, label, day). `source_label` is only
 * ever set when `source` is 'other'.
 */
export interface IncomeBySourceRow {
  source: string;
  source_label: string | null;
  txn_date: string;
  total: number | string;
  currency_code: string;
}

/** v_portfolio_balances — current, not range-scoped. */
export interface PortfolioBalanceRow {
  id: string;
  name: string;
  category: string;
  current_balance: number | string;
  is_liquid: boolean;
  is_archived: boolean;
  currency_code: string;
}

/** v_debt_outstanding — current, not range-scoped. */
export interface DebtOutstandingRow {
  debt_id: string;
  kind: string;
  counterparty: string;
  outstanding_balance: number | string;
  status: string;
  currency_code: string;
}

/** v_investment_performance — current, not range-scoped. */
export interface InvestmentPerformanceRow {
  investment_id: string;
  name: string;
  invested_amount: number | string;
  current_value: number | string;
  unrealized_gain: number | string;
  return_pct: number | string | null;
  currency_code: string;
}

/** v_completed_goals — filtered to the range by `achieved_at`. */
export interface CompletedGoalRow {
  goal_id: string;
  name: string;
  target_amount: number | string;
  current_amount: number | string;
  achieved_at: string | null;
  currency_code: string;
}

/** A debt payment made inside the range. Read from the table, not a view. */
export interface DebtPaymentRow {
  id: string;
  amount: number | string;
  principal_portion: number | string;
  interest_portion: number | string;
  payment_date: string;
}

/**
 * One row of the in-range transaction list.
 *
 * The embeds exist to answer "is this counted in the headline?" — `v_cashflow`
 * drops debt-linked and investment-linked expenses and `loan_received` income,
 * and this list has to be able to say so rather than silently disagreeing with
 * the totals above it.
 */
export interface TransactionRow {
  id: string;
  txn_date: string;
  kind: string;
  direction: "inflow" | "outflow";
  amount: number | string;
  description: string | null;
  currency: CurrencyInfo | CurrencyInfo[] | null;
  portfolio: { name: string } | { name: string }[] | null;
  expense:
    | { debt_id: string | null; investment_id: string | null; category: { name: string } | { name: string }[] | null }
    | { debt_id: string | null; investment_id: string | null; category: { name: string } | { name: string }[] | null }[]
    | null;
  income:
    | { source: string; source_label: string | null }
    | { source: string; source_label: string | null }[]
    | null;
}

/** PostgREST returns an embedded one-to-one as either an object or a 1-element array. */
export function one<T>(v: T | T[] | null | undefined): T | undefined {
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}
