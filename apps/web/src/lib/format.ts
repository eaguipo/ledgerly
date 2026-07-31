/**
 * Format a money amount for display using a currency's symbol + decimal places.
 * `minor_unit` comes from the currencies table (PHP/USD=2, JPY=0, BTC/ETH=8, USDT=6).
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency?: { symbol?: string | null; code?: string | null; minor_unit?: number | null },
): string {
  const n = Number(amount ?? 0);
  const minor = currency?.minor_unit ?? 2;
  const num = (Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
    minimumFractionDigits: minor,
    maximumFractionDigits: minor,
  });
  const prefix = currency?.symbol || (currency?.code ? `${currency.code} ` : "");
  return `${prefix}${num}`;
}
