/**
 * The contract between a "+ Add my own…" picker and the Server Action that
 * receives it.
 *
 * This deliberately does NOT live in components/ui/choice-with-custom.tsx.
 * That file is "use client", and every export of a client module becomes a
 * client reference when a Server Action imports it — `CUSTOM_CHOICE` would
 * arrive as a proxy rather than the string, and the comparison would silently
 * never match. A plain module is importable from both sides as itself.
 */

/** Select value meaning "I typed my own". Never reaches the database. */
export const CUSTOM_CHOICE = "__custom__";

/** Matches the 40-char ceiling the DB check constraints enforce. */
export const MAX_CUSTOM_LABEL = 40;

/**
 * A typed-in label as it should be stored: trimmed, inner runs of whitespace
 * collapsed, empty treated as absent. Not truncated — a value over the limit is
 * the caller's error to report, not something to quietly shorten.
 */
export function normalizeCustomLabel(
  raw: FormDataEntryValue | null | undefined,
): string | null {
  const value = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return value === "" ? null : value;
}

/**
 * The labels a user has already typed, in the order given, for offering back as
 * autocomplete. Deduped case-insensitively — "Royalties" and "royalties" are one
 * suggestion, and the first spelling seen is the one shown.
 */
export function distinctLabels(
  values: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const label = value?.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out;
}
