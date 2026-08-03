// Row shapes returned by the ledger's /goals routes. Money arrives as a string
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

/** The account a goal is notionally backed by, embedded on the goal row. */
export interface LinkedPortfolio {
  name: string;
  current_balance: number | string;
}

export interface GoalRow {
  id: string;
  name: string;
  target_amount: number | string;
  current_amount: number | string;
  currency_id: string;
  linked_portfolio_id: string | null;
  status: string;
  target_date: string | null;
  achieved_at: string | null;
  // Stamped on first completion and NEVER cleared, so a goal that was reached
  // and later drawn down still counts as ever-achieved (schema.sql §11).
  first_achieved_at: string | null;
  created_at: string;
  currency: Currency | Currency[] | null;
  linked_portfolio: LinkedPortfolio | LinkedPortfolio[] | null;
}

/** An account a goal can be linked to. */
export interface GoalAccount {
  id: string;
  name: string;
  current_balance: number | string;
  currency: Currency | Currency[] | null;
}
