"use client";

import { useState } from "react";

export interface ShareSlice {
  label: string;
  value: number;
  /** Pre-formatted on the server, so SSR and the client agree on the money. */
  display: string;
}

/**
 * Part-to-whole at a glance.
 *
 * This is the ONE job a donut does better than bars: "is this category most of
 * my spending, or a sliver?" read in a single glance, without comparing lengths.
 * It does NOT do the other job — ranking close values against each other — which
 * is why it ships beside AllocationBars rather than instead of it. The bars stay
 * the precise read and the table view; this is the shape of the month.
 *
 * Hard cap of six slices, and the caller folds the tail into "Other". Past ~7
 * classes adjacent hues blur together and the ring stops meaning anything, so a
 * seventh category is never a seventh colour.
 *
 * Colour here carries IDENTITY, not magnitude — the one place in this app that
 * is true. The hues come from --series-1..6 in globals.css, assigned in fixed
 * order and never cycled, and every slice is also named and valued in the legend
 * so identity is never colour-alone.
 */

const SIZE = 168;
const STROKE = 26;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;
/** Surface-coloured gap between slices, per the mark spec. In path units. */
const GAP = 2;

export function ShareDonut({
  slices,
  total,
  totalDisplay,
  caption,
}: {
  slices: ShareSlice[];
  total: number;
  /** The centre figure. Pre-formatted, like every other amount here. */
  totalDisplay: string;
  /** What the total IS — "Total spent", say. Named, never left to inference. */
  caption: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  // Zero total would divide by zero below; the caller renders an empty state
  // instead, but a defensive guard costs nothing and avoids a NaN ring.
  if (slices.length === 0 || total <= 0) return null;

  // Each slice starts where every slice before it ended. Built by reduce rather
  // than a running `let` because the render pass must not mutate — the lint rule
  // is right that a value reassigned mid-map is a stale-closure waiting to
  // happen once this ever memoises.
  const arcs = slices.reduce<
    {
      slice: ShareSlice;
      share: number;
      dash: number;
      offset: number;
      color: string;
    }[]
  >((acc, slice, i) => {
    const share = Math.max(slice.value, 0) / total;
    const previous = acc[acc.length - 1];
    const offset = previous ? previous.offset + previous.share * C : 0;
    return [
      ...acc,
      {
        slice,
        share,
        // The gap is taken off the arc, never added between them, so the ring
        // still closes exactly at 360°. A slice thinner than the gap collapses
        // to a hairline rather than rendering a backwards dash.
        dash: Math.max(share * C - GAP, 0.5),
        offset,
        color: `var(--series-${i + 1})`,
      },
    ];
  }, []);

  const shown = active === null ? null : arcs[active];

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6">
      <div className="relative shrink-0">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          // Decorative: every slice is named, valued and shared in the legend
          // beside it, so the ring adds shape rather than information. Labelling
          // it would make a screen reader read the same six rows twice.
          aria-hidden
        >
          {/* Rotated so the first slice starts at 12 o'clock, which is where a
              reader's eye lands and where "biggest first" has to begin. */}
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            {arcs.map((arc, i) => (
              <circle
                key={arc.slice.label}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                fill="none"
                stroke={arc.color}
                strokeWidth={STROKE}
                strokeDasharray={`${arc.dash} ${C - arc.dash}`}
                strokeDashoffset={-arc.offset}
                // Dimming the others rather than growing the hovered one: a
                // slice that changes size on hover misreports its share for as
                // long as the pointer is on it.
                opacity={active === null || active === i ? 1 : 0.35}
                className="transition-opacity"
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                style={{ cursor: "default" }}
              />
            ))}
          </g>
        </svg>

        {/* The hole earns its keep: the total lives here, so the chart answers
            "how much altogether" without a separate stat tile. On hover it
            becomes the hovered slice — same position, so the eye never moves. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <span className="figure text-[15px] font-semibold leading-tight text-ink">
            {shown ? shown.slice.display : totalDisplay}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-muted">
            {shown
              ? `${shown.slice.label} · ${Math.round(shown.share * 100)}%`
              : caption}
          </span>
        </div>
      </div>

      {/* Legend, always present: six slices is well past the four where direct
          labels on the ring would still fit, and colour alone is never identity.
          Values live here too — the light palette has hues under 3:1 against the
          surface, and that obliges a labelled read rather than a colour one. */}
      <ul className="w-full min-w-0 space-y-2">
        {arcs.map((arc, i) => (
          <li
            key={arc.slice.label}
            className="flex items-baseline gap-2.5 text-[13px]"
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
          >
            <span
              aria-hidden
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: arc.color }}
            />
            {/* Text wears ink tokens, never the series colour — the swatch
                beside it carries identity. */}
            <span className="min-w-0 flex-1 truncate text-muted">
              {arc.slice.label}
            </span>
            <span className="figure shrink-0 text-ink">{arc.slice.display}</span>
            <span className="figure w-9 shrink-0 text-right text-faint">
              {Math.round(arc.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
