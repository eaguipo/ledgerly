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
  const prefix = sign === "negative" ? "−" : sign === "positive" ? "+" : "";
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
      {formatMoney(amount, currency)}
    </span>
  );
}
