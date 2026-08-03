// Row shapes returned by the ledger's /debts routes. Money arrives as a string
// when Postgres numeric(38,18) exceeds what JSON can hold as a number, so every
// amount is `number | string` and gets Number()'d at the point of display.

export interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

export interface CurrencyOption extends Currency {
  id: string;
}

export interface DebtRow {
  id: string;
  kind: string;
  counterparty: string;
  principal_amount: number | string;
  outstanding_balance: number | string;
  interest_rate: number | string | null;
  status: string;
  due_date: string | null;
  note: string | null;
  is_archived: boolean;
  created_at: string;
  currency: Currency | Currency[] | null;
}

export interface DebtPaymentRow {
  id: string;
  amount: number | string;
  principal_portion: number | string;
  interest_portion: number | string;
  payment_date: string;
  note: string | null;
  transaction: {
    id: string;
    kind: string;
    portfolio: { name: string } | { name: string }[] | null;
  } | null;
}

/**
 * A cash-free correction to what is owed.
 *
 * The absence of a transaction embed is the point: an adjustment records that
 * the DEBT changed (interest accrued, it was paid outside this app, it was
 * written down) while no account balance moved. `amount` is signed — positive
 * grew the debt, negative settled part of it.
 */
export interface DebtAdjustmentRow {
  id: string;
  amount: number | string;
  reason: string;
  effective_on: string;
  note: string | null;
  created_at: string;
}

/** An account usable as a debt's funding or payment source. */
export interface DebtAccount {
  id: string;
  name: string;
  current_balance: number | string;
  currency: Currency | Currency[] | null;
}
