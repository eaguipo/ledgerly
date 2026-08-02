/**
 * Join class names, dropping falsy values. Deliberately tiny — the app has no
 * runtime styling dependency, and Tailwind conflicts are avoided by keeping
 * variant maps in the primitives rather than merging arbitrary overrides.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
