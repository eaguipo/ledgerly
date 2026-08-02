import { Money } from "@/components/ui/money";

interface Currency {
  symbol?: string | null;
  code?: string | null;
  minor_unit?: number | null;
}

export interface AllocationRow {
  label: string;
  value: number;
}

/**
 * Part-to-whole by category. Bars rather than a donut: with five similar-sized
 * categories a donut makes close values impossible to compare, and the row
 * labels already carry identity — so every bar uses the SAME hue. Colouring
 * each bar differently would burn the colour channel on information the bar
 * length already shows.
 *
 * This doubles as its own table view: each row is directly labelled with the
 * amount and share, so nothing is reachable only by hovering.
 */
export function AllocationBars({
  rows,
  currency,
}: {
  rows: AllocationRow[];
  currency?: Currency;
}) {
  const total = rows.reduce((sum, r) => sum + Math.max(r.value, 0), 0);
  const ordered = [...rows].sort((a, b) => b.value - a.value);

  return (
    <ul className="space-y-4">
      {ordered.map((row) => {
        const share = total > 0 ? Math.max(row.value, 0) / total : 0;
        return (
          <li key={row.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-muted">{row.label}</span>
              <span className="flex items-baseline gap-2">
                <Money
                  amount={row.value}
                  currency={currency}
                  className="text-[13px] font-medium text-ink"
                />
                <span className="figure w-9 text-right text-[11px] text-faint">
                  {(share * 100).toFixed(0)}%
                </span>
              </span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-r-full bg-accent"
                style={{ width: `${Math.max(share * 100, share > 0 ? 1.5 : 0)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
