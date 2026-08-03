"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export interface TrendPoint {
  /** Pre-formatted on the server with an explicit locale, so SSR and the
   *  client always agree — no hydration mismatch on dates or money. */
  label: string;
  display: string;
  value: number;
}

const VB_W = 600;
const VB_H = 120;
const PAD_Y = 10;

/**
 * A balance trend. One series, so no legend — the card title names it.
 * Values are also reachable without hovering: the current figure is the hero
 * above, and the endpoints are labelled under the plot.
 *
 * `label` names the series for screen readers. It is a prop rather than the
 * hardcoded "Net worth" it used to be because the caller decides which accounts
 * the series covers — the dashboard's is liquid money only (Rule 16), and an
 * announcement of "net worth" over that would be a plain misstatement.
 */
export function TrendChart({
  points,
  label = "Balance",
}: {
  points: TrendPoint[];
  label?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const { line, area, coords } = useMemo(() => {
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series would divide by zero; render it as a centred straight line.
    const span = max - min || 1;
    const lastIndex = Math.max(points.length - 1, 1);

    const coords = points.map((p, i) => ({
      x: (i / lastIndex) * VB_W,
      y:
        max === min
          ? VB_H / 2
          : VB_H - PAD_Y - ((p.value - min) / span) * (VB_H - PAD_Y * 2),
    }));

    const line = coords
      .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
      .join(" ");
    const area = `${line} L${VB_W} ${VB_H} L0 ${VB_H} Z`;
    return { line, area, coords };
  }, [points]);

  const pick = useCallback(
    (clientX: number) => {
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      const ratio = (clientX - box.left) / box.width;
      const i = Math.round(ratio * (points.length - 1));
      setActive(Math.min(Math.max(i, 0), points.length - 1));
    },
    [points.length],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setActive((prev) => {
      const from = prev ?? points.length - 1;
      const next = from + (e.key === "ArrowRight" ? 1 : -1);
      return Math.min(Math.max(next, 0), points.length - 1);
    });
  };

  const last = coords[coords.length - 1];
  const cur = active === null ? null : points[active];
  const curXY = active === null ? null : coords[active];

  return (
    <div className="mt-5">
      <div
        ref={wrapRef}
        className="relative"
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((p) => p ?? points.length - 1)}
        onBlur={() => setActive(null)}
        tabIndex={0}
        // Deliberately NOT role="img": that makes the subtree
        // children-presentational, which would strip the crosshair readout
        // below out of the accessibility tree and leave the arrow-key
        // navigation announcing nothing. A focusable group keeps the live
        // region readable.
        role="group"
        aria-label={`${label} trend, ${points.length} daily points from ${points[0]?.label} to ${
          points[points.length - 1]?.label
        }. Use the left and right arrow keys to read each day.`}
      >
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="h-28 w-full"
          preserveAspectRatio="none"
          aria-hidden
        >
          {/* 10% wash, never a saturated block. */}
          <path d={area} className="fill-accent opacity-10" />
          <path
            d={line}
            fill="none"
            className="stroke-accent"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {curXY ? (
            <line
              x1={curXY.x}
              x2={curXY.x}
              y1={0}
              y2={VB_H}
              className="stroke-line-strong"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>

        {/* End marker and crosshair dot: 8px wide with a 2px surface ring so
            they stay legible where they cross the line. Rendered as HTML, not
            SVG circles, because preserveAspectRatio="none" would squash them. */}
        {last ? (
          <Dot x={last.x / VB_W} y={last.y / VB_H} />
        ) : null}
        {curXY && active !== points.length - 1 ? (
          <Dot x={curXY.x / VB_W} y={curXY.y / VB_H} />
        ) : null}

        {cur ? (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-center shadow-sm"
            style={{
              left: `${Math.min(Math.max((curXY!.x / VB_W) * 100, 8), 92)}%`,
            }}
          >
            <span className="block text-[11px] text-muted">{cur.label}</span>
            <span className="block figure text-[13px] font-medium text-ink">
              {cur.display}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>

      {/* Always mounted so the region is registered before it ever has text —
          a live region created at the same moment it gains content is usually
          not announced. This is what makes arrow-key navigation audible. */}
      <p aria-live="polite" className="sr-only">
        {cur ? `${cur.label}: ${cur.display}` : ""}
      </p>
    </div>
  );
}

function Dot({ x, y }: { x: number; y: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface"
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
    />
  );
}
