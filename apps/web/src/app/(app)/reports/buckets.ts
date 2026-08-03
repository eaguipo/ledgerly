/**
 * Grouping the per-day cashflow rows into something a bar chart can show.
 *
 * `v_cashflow` returns one row per (day, direction). A year of that is 730 bar
 * pairs — unreadable, and slow to render. So a long range is bucketed by week or
 * month before it reaches the chart.
 *
 * Every date is handled as a `YYYY-MM-DD` string. Parsing into a Date would pull
 * in the server's timezone, and `txn_date` is a Postgres `date` with no zone —
 * a UTC-parsed "2026-08-01" is July 31st for anyone west of Greenwich, which
 * would move transactions between buckets at the boundary.
 */

import { dayCount, type Range } from "./range";

export type Granularity = "day" | "week" | "month";

export interface FlowBucket {
  key: string;
  label: string;
  inflow: number;
  outflow: number;
}

/**
 * How finely to bucket a range. The thresholds are about how many bars fit, not
 * about calendar meaning: ~31 daily pairs is comfortable, ~27 weekly pairs
 * covers half a year, and anything longer goes monthly.
 */
export function granularityFor(range: Range): Granularity {
  const days = dayCount(range);
  if (days <= 31) return "day";
  if (days <= 186) return "week";
  return "month";
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The bucket an ISO date falls in, as a sortable key plus a display label.
 *
 * Week buckets are keyed by the Monday that starts them. `Date.UTC` is used only
 * for the day-of-week arithmetic — both input and output stay ISO strings, so no
 * local timezone ever touches the value.
 */
function bucketOf(iso: string, granularity: Granularity): { key: string; label: string } {
  const [y, m, d] = iso.split("-").map(Number);

  if (granularity === "day") {
    return { key: iso, label: `${MONTHS[m - 1]} ${d}` };
  }
  if (granularity === "month") {
    return { key: `${y}-${String(m).padStart(2, "0")}`, label: `${MONTHS[m - 1]} ${y}` };
  }

  const utc = Date.UTC(y, m - 1, d);
  // getUTCDay: 0 = Sunday. Shift so Monday starts the week.
  const dow = new Date(utc).getUTCDay();
  const monday = new Date(utc - ((dow + 6) % 7) * 86_400_000);
  const my = monday.getUTCFullYear();
  const mm = monday.getUTCMonth();
  const md = monday.getUTCDate();
  return {
    key: `${my}-${String(mm + 1).padStart(2, "0")}-${String(md).padStart(2, "0")}`,
    label: `${MONTHS[mm]} ${md}`,
  };
}

/**
 * Fold per-day rows into buckets, ordered oldest first.
 *
 * Only buckets with activity appear. An empty week inside a range renders as a
 * gap in the axis rather than a zero-height pair, which is honest: the chart is
 * a comparison of periods that had money moving, not a calendar.
 */
export function bucketFlows(
  rows: readonly { txn_date: string; direction: "inflow" | "outflow"; total: number | string }[],
  granularity: Granularity,
): FlowBucket[] {
  const buckets = new Map<string, FlowBucket>();

  for (const row of rows) {
    const { key, label } = bucketOf(row.txn_date, granularity);
    const bucket = buckets.get(key) ?? { key, label, inflow: 0, outflow: 0 };
    const amount = Number(row.total);
    const safe = Number.isFinite(amount) ? amount : 0;
    if (row.direction === "inflow") bucket.inflow += safe;
    else bucket.outflow += safe;
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}
