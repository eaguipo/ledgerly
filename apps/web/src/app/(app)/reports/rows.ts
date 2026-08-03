/**
 * The transaction-row logic the report page and the CSV export both need.
 *
 * Shared rather than duplicated because these two must agree: an export that
 * labelled rows differently from the screen, or disagreed about which rows the
 * totals count, would be a quietly corrupted record of the same range.
 */

import { incomeSourceDisplay } from "../income/constants";
import { one, type TransactionRow } from "./types";

/**
 * The embed used by both readers.
 *
 * `expenses` has TWO foreign keys to `transactions` (a plain `transaction_id`
 * and the composite `(transaction_id, txn_kind)`), so PostgREST needs the FK
 * name to disambiguate. The embeds exist to answer "is this counted?" — see
 * `isCounted`. They come back as arrays, empty when a transaction has no
 * expense/income detail row, which `one()` flattens.
 */
export const TXN_SELECT =
  "id, txn_date, kind, direction, amount, description, " +
  "currency:currencies!inner(code, symbol, minor_unit), portfolio:portfolios(name), " +
  "expense:expenses!expenses_txn_kind_fk(debt_id, investment_id, category:expense_categories(name)), " +
  "income:incomes!incomes_txn_kind_fk(source, source_label)";

export const TXN_KIND_LABELS: Record<string, string> = {
  income: "Income",
  expense: "Expense",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  debt_payment_made: "Debt payment",
  debt_payment_received: "Debt collected",
  adjustment: "Adjustment",
  opening_balance: "Opening balance",
};

/** Kinds `v_cashflow` considers at all. Everything else is movement, not flow. */
const COUNTED_KINDS = new Set([
  "income",
  "expense",
  "debt_payment_made",
  "debt_payment_received",
]);

/**
 * Whether a transaction is counted in the headline totals.
 *
 * **This mirrors `v_cashflow`'s filter and must change with it.** The view
 * excludes transfers and opening balances by kind, debt-linked and
 * investment-linked expenses (lending out and buying an asset are not spending),
 * and `loan_received` income (borrowing is not earning). If the two drift, the
 * report's detail contradicts its own summary.
 */
export function isCounted(t: TransactionRow): boolean {
  if (!COUNTED_KINDS.has(t.kind)) return false;

  const expense = one(t.expense);
  if (expense && (expense.debt_id !== null || expense.investment_id !== null)) {
    return false;
  }

  const income = one(t.income);
  if (income && income.source === "loan_received") return false;

  return true;
}

/** What to call a row: its expense category, its income source, or its kind. */
export function rowLabel(t: TransactionRow): string {
  const expense = one(t.expense);
  if (expense) return one(expense.category)?.name ?? "—";

  const income = one(t.income);
  if (income) return incomeSourceDisplay(income.source, income.source_label);

  return TXN_KIND_LABELS[t.kind] ?? t.kind;
}
