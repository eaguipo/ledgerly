// Goal enums, mirrored from db public.goal_status, plus the display helpers the
// goals page needs.
//
// todayIso / formatDate / one are duplicated from the debts feature rather than
// shared. That follows the existing per-feature convention (transfers has its
// own copies too); lifting all three into lib/ is a worthwhile cleanup, but it
// touches three features and belongs in its own change.

export const GOAL_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  achieved: "Achieved",
  archived: "Archived",
  cancelled: "Cancelled",
};

export function goalStatusLabel(value: string): string {
  return GOAL_STATUS_LABELS[value] ?? value;
}

/** Whether a goal is still something the user is working toward. */
export function isLiveGoal(status: string): boolean {
  return status === "active" || status === "achieved";
}

/** Today as `YYYY-MM-DD` in local time — the format every date input wants. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A target date that has passed without the goal being reached. Computed, never
 * stored: `goal_status` has no value for it, and adding one would need a
 * scheduled job to keep it true. An achieved goal is never past due — it
 * finished, whenever that happened.
 */
export function isPastDue(
  targetDate: string | null,
  status: string,
  today = todayIso(),
): boolean {
  if (!targetDate || status !== "active") return false;
  // Both sides are YYYY-MM-DD, so a string compare is a date compare.
  return targetDate < today;
}

/** Progress toward the target, clamped to 0–100 for the bar's width. */
export function progressPct(
  current: number | string,
  target: number | string,
): number {
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(Math.min((Number(current) / t) * 100, 100), 0);
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** PostgREST returns an embedded one-to-one as either an object or a 1-element array. */
export function one<T>(v: T | T[] | null | undefined): T | undefined {
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}
