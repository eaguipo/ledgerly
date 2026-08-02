/**
 * Ledgerly brand mark — "Ascent": a net-worth trend line with the current
 * point marked. Hand-written SVG so it needs no image request and inherits
 * size from the caller. Keep in sync with `src/app/icon.svg` (the favicon).
 */

export function Logo({
  size = 28,
  className,
  /**
   * Decorative by default: every current caller renders the mark immediately
   * beside the visible word "Ledgerly", and labelling it too makes screen
   * readers announce the brand name twice in a row. Pass `decorative={false}`
   * when the mark ever stands alone without adjacent text.
   */
  decorative = true,
}: {
  size?: number;
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": "Ledgerly" })}
    >
      <rect width="64" height="64" rx="16" fill="#123328" />
      <path
        d="M17 42L27 32L35 38L47 21"
        stroke="#F2EFE6"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="47" cy="21" r="4.5" fill="#7FBFA0" />
    </svg>
  );
}

/** Mark + name lockup, for the sidebar and auth pages. */
export function Wordmark({
  size = 36,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-3 ${className ?? ""}`}>
      <Logo size={size} />
      <span className="text-[21px] font-semibold tracking-tight text-ink">
        Ledger<span className="text-accent">ly</span>
      </span>
    </span>
  );
}
