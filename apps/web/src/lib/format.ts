/**
 * Format a money amount for display using a currency's symbol + decimal places.
 * `minor_unit` comes from the currencies table (PHP/USD=2, JPY=0, BTC/ETH=8, USDT=6).
 *
 * The minus sign goes BEFORE the symbol — `-₱500.25`, not `₱-500.25`. Formatting
 * the signed number first and then prepending the symbol puts the sign in the
 * middle, which reads as a typo at a glance and is wrong in every locale that
 * uses a leading symbol.
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency?: {
    symbol?: string | null;
    code?: string | null;
    minor_unit?: number | null;
  },
): string {
  const n = Number(amount ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  const minor = currency?.minor_unit ?? 2;

  const num = Math.abs(safe).toLocaleString("en-US", {
    minimumFractionDigits: minor,
    maximumFractionDigits: minor,
  });

  // `Math.abs` also collapses -0 to 0, so a rounded-to-zero amount never prints
  // as "-₱0.00".
  const sign = safe < 0 ? "-" : "";
  const prefix = currency?.symbol || (currency?.code ? `${currency.code} ` : "");
  return `${sign}${prefix}${num}`;
}
