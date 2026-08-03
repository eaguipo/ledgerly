// Row shapes returned by the ledger's /investments routes. Money arrives as a
// string when Postgres numeric(38,18) exceeds what JSON can hold as a number, so
// every amount is `number | string` and gets Number()'d at the point of display.

export interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

export interface CurrencyOption extends Currency {
  id: string;
}

/** The account a holding was funded from, embedded on the investment row. */
export interface FundingPortfolio {
  name: string;
}

export interface InvestmentRow {
  id: string;
  name: string;
  kind: string;
  /** Set only when kind is 'other_asset' — the name the user typed instead. */
  kind_label: string | null;
  symbol: string | null;
  quantity: number | string | null;
  average_cost: number | string | null;
  invested_amount: number | string;
  /** Owned by sync_investment_current_value() once any snapshot exists. */
  current_value: number | string;
  /** Generated column: current_value − invested_amount. Never written. */
  unrealized_gain: number | string;
  opened_on: string | null;
  maturity_date: string | null;
  is_active: boolean;
  portfolio_id: string | null;
  created_at: string;
  currency: Currency | Currency[] | null;
  portfolio: FundingPortfolio | FundingPortfolio[] | null;
}

/** One valuation. `market_value` is what the sync trigger reads. */
export interface SnapshotRow {
  id: string;
  as_of_date: string;
  market_value: number | string;
  unit_price: number | string | null;
  quantity: number | string | null;
  source: string | null;
  created_at: string;
}

/** An account a holding can be linked to as its funding source. */
export interface InvestmentAccount {
  id: string;
  name: string;
  current_balance: number | string;
  currency: Currency | Currency[] | null;
}
