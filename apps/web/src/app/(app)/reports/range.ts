/**
 * The report's date range and currency, driven through the URL
 * (`?from=&to=&currency=`) rather than component state — so a report survives
 * reload, back/forward, and being bookmarked or shared. Same reasoning as the
 * `?sort=&dir=` pattern on /portfolios.
 *
 * Every date here is a `YYYY-MM-DD` string and every comparison is a string
 * compare, never a Date. `transactions.txn_date` is a Postgres `date` with no
 * time or zone, so parsing it into a JS Date introduces the server's UTC day —
 * which is not the user's day for roughly half of each 24 hours, and would move
 * transactions between months at the boundary.
 */

export interface Range {
  from: string;
  to: string;
}

export interface ReportQuery extends Range {
  /** Currency CODE, not id — every report view reports by code. */
  currency: string | null;
  /** Which preset produced this range, for highlighting the active button. */
  preset: PresetKey | null;
}

export type PresetKey = "this-month" | "last-month" | "this-year" | "last-30";

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "last-30", label: "Last 30 days" },
  { key: "this-year", label: "This year" },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayIso(): string {
  return iso(new Date());
}

/**
 * The range a preset means, resolved against today in LOCAL time. `new Date(y,
 * m, 0)` is the last day of month `m - 1`, which is how month-end is found
 * without a table of month lengths or a leap-year branch.
 */
export function presetRange(key: PresetKey, today = new Date()): Range {
  const y = today.getFullYear();
  const m = today.getMonth();

  switch (key) {
    case "this-month":
      return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    case "last-month":
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "last-30": {
      const start = new Date(today);
      start.setDate(start.getDate() - 29); // inclusive of today = 30 days
      return { from: iso(start), to: iso(today) };
    }
    case "this-year":
      return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) };
  }
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function isPreset(v: string | undefined): v is PresetKey {
  return PRESETS.some((p) => p.key === v);
}

/**
 * Parse the URL into a usable query. Anything missing or malformed falls back to
 * the current month rather than erroring, so a hand-edited or stale link
 * degrades into a valid report.
 *
 * **A reversed range is swapped, not rejected.** Someone who picks the dates in
 * the wrong order wants the range between them; returning an empty report would
 * look identical to "you had no activity", which is the one wrong answer here.
 */
export function parseQuery(params: {
  from?: string | string[];
  to?: string | string[];
  currency?: string | string[];
  preset?: string | string[];
}): ReportQuery & { swapped: boolean } {
  const presetParam = first(params.preset);
  if (isPreset(presetParam)) {
    return {
      ...presetRange(presetParam),
      currency: first(params.currency) ?? null,
      preset: presetParam,
      swapped: false,
    };
  }

  const rawFrom = first(params.from);
  const rawTo = first(params.to);
  const fallback = presetRange("this-month");

  let from = rawFrom && ISO.test(rawFrom) ? rawFrom : fallback.from;
  let to = rawTo && ISO.test(rawTo) ? rawTo : fallback.to;

  const swapped = from > to;
  if (swapped) [from, to] = [to, from];

  return {
    from,
    to,
    currency: first(params.currency) ?? null,
    // Report a preset when the explicit dates happen to match one, so the button
    // still highlights after a round trip through the date inputs.
    preset: PRESETS.find((p) => {
      const r = presetRange(p.key);
      return r.from === from && r.to === to;
    })?.key ?? null,
    swapped,
  };
}

/** A `/reports` href with one field replaced — used by the preset buttons. */
export function reportHref(
  current: ReportQuery,
  patch: Partial<ReportQuery> & { preset?: PresetKey | null },
): string {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.preset) {
    params.set("preset", next.preset);
  } else {
    params.set("from", next.from);
    params.set("to", next.to);
  }
  if (next.currency) params.set("currency", next.currency);
  return `/reports?${params.toString()}`;
}

/** Inclusive day count, for "N days" copy. Both ends are plain ISO dates. */
export function dayCount(range: Range): number {
  const [fy, fm, fd] = range.from.split("-").map(Number);
  const [ty, tm, td] = range.to.split("-").map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.floor(ms / 86_400_000) + 1;
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
