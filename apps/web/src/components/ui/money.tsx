import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";

interface Currency {
  symbol?: string | null;
  code?: string | null;
  minor_unit?: number | null;
}

/**
 * A money figure. `sign` controls the leading −/+ and the colour: expenses read
 * as negative (muted terracotta), inflows as positive (accent green). Neutral
 * amounts — balances, transfers — stay ink-coloured, because colouring every
 * number turns the page into a traffic light.
 *
 * When an explicit `sign` is given the magnitude is formatted, so passing an
 * already-negative amount with sign="negative" cannot produce "−₱-84.20".
 * With sign="none" the amount's own sign is preserved, so a negative balance
 * still reads as negative.
 */
export function Money({
  amount,
  currency,
  sign = "none",
  className,
}: {
  amount: number | string | null | undefined;
  currency?: Currency;
  sign?: "none" | "negative" | "positive";
  className?: string;
}) {
  const n = Number(amount ?? 0);
  const safe = Number.isFinite(n) ? n : 0;

  const prefix = sign === "negative" ? "−" : sign === "positive" ? "+" : "";
  const value = sign === "none" ? safe : Math.abs(safe);

  return (
    <span
      className={cn(
        "figure whitespace-nowrap",
        sign === "negative" && "text-negative",
        sign === "positive" && "text-positive",
        className,
      )}
    >
      {prefix}
      {formatMoney(value, currency)}
    </span>
  );
}
