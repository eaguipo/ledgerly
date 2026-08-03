"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export interface FlowPoint {
  label: string;
  inflow: number;
  outflow: number;
  /** Pre-formatted for display — the component never sees a currency. */
  inflowDisplay: string;
  outflowDisplay: string;
}

/**
 * Money in vs money out, per period.
 *
 * Grouped bars rather than two lines: the comparison is between two totals for
 * the same bucket, not a continuous quantity over time, and a bar pair makes
 * "this month I earned more than I spent" readable without tracing two paths.
 * The one place colour carries meaning in this app — in and out are opposites,
 * so hue is doing work a bar length cannot.
 *
 * Bucketing is the caller's job (see `bucketFlows`): 30 daily pairs is readable,
 * 365 is not, so a long range arrives here already grouped by week or month.
 *
 * Accessibility follows TrendChart's contract deliberately:
 *   - `role="group"`, never `role="img"` — the latter makes the subtree
 *     children-presentational and would strip the readout below out of the tree,
 *     leaving arrow-key navigation announcing nothing.
 *   - Every value is reachable as text without hovering: the focused bucket
 *     prints under the plot, and the whole series is in a visually-hidden table.
 */
export function FlowBars({ points }: { points: FlowPoint[] }) {
  const [active, setActive] = useState<number | null>(null);

  if (points.length === 0) return null;

  // One scale for both series, or the bars would lie about their relationship.
  const max = Math.max(...points.map((p) => Math.max(p.inflow, p.outflow)), 0);
  const scale = max > 0 ? max : 1;
  const current = active === null ? null : points[active];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setActive((prev) => {
      const from = prev ?? points.length - 1;
      const next = from + (e.key === "ArrowRight" ? 1 : -1);
      return Math.min(Math.max(next, 0), points.length - 1);
    });
  };

  return (
    <div>
      <div
        tabIndex={0}
        role="group"
        onKeyDown={onKeyDown}
        onFocus={() => setActive((p) => p ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        aria-label={`Money in versus money out, ${points.length} periods from ${points[0].label} to ${points[points.length - 1].label}. Use the left and right arrow keys to read each period.`}
        className="flex h-36 items-end gap-1 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {points.map((p, i) => (
          <div
            key={p.label}
            className={cn(
              "flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 rounded-md px-0.5 transition-colors",
              active === i && "bg-raised",
            )}
            onPointerEnter={() => setActive(i)}
          >
            {/* min-height so a non-zero amount is never invisible, and a true
                zero stays flat — a 1px sliver for "nothing happened" reads as a
                rounding artefact. */}
            <span
              className="w-full rounded-t-sm bg-positive"
              style={{
                height: `${p.inflow > 0 ? Math.max((p.inflow / scale) * 100, 2) : 0}%`,
              }}
            />
            <span
              className="w-full rounded-t-sm bg-negative"
              style={{
                height: `${p.outflow > 0 ? Math.max((p.outflow / scale) * 100, 2) : 0}%`,
              }}
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-3 text-xs text-faint">
        <span>{points[0].label}</span>
        <span aria-hidden className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-positive" /> in
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-negative" /> out
          </span>
        </span>
        <span>{points[points.length - 1].label}</span>
      </div>

      {/* The focused bucket, as text. Rendered always so the live region exists
          before it gains content — a status node mounted at the same moment it
          gets text is frequently not announced. */}
      <p role="status" className="mt-2 min-h-[1.25rem] text-[13px]">
        {current ? (
          <>
            <span className="text-muted">{current.label}: </span>
            <span className="figure font-medium text-positive">{current.inflowDisplay}</span>
            <span className="text-muted"> in · </span>
            <span className="figure font-medium text-negative">{current.outflowDisplay}</span>
            <span className="text-muted"> out</span>
          </>
        ) : null}
      </p>

      {/* Every value without hovering or focusing. AllocationBars doubles as its
          own table by labelling each row; a bar chart cannot, so it carries one. */}
      <table className="sr-only">
        <caption>Money in versus money out by period</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">In</th>
            <th scope="col">Out</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label}>
              <th scope="row">{p.label}</th>
              <td>{p.inflowDisplay}</td>
              <td>{p.outflowDisplay}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
