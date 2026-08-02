import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Data tables. Wrapped in an overflow-x container so a wide table scrolls
 * itself instead of pushing the page sideways on mobile.
 */
export function Table({
  head,
  children,
  label,
}: {
  head: ReactNode;
  children: ReactNode;
  /** Names the scrollable region for screen readers. */
  label?: string;
}) {
  return (
    // tabIndex={0} makes the scroll container reachable by keyboard: on a
    // narrow viewport the columns that overflow are otherwise unreachable
    // without a pointer. role+label stop it being an unlabelled tab stop.
    <div
      className="overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label={label ?? "Table, scrolls horizontally"}
    >
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

type SortDirection = "asc" | "desc";

const TH_BASE =
  "border-b border-line px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted";

export function Th({
  children,
  align = "left",
}: {
  children?: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={cn(TH_BASE, align === "right" ? "text-right" : "text-left")}
    >
      {children}
    </th>
  );
}

/**
 * A column header that links to a sorted view of the same table. Purely
 * presentational — the caller owns where `href` points and which column is
 * active, so this works for both URL-driven and in-memory sorting.
 *
 * `aria-sort` is what announces the state to screen readers; the arrow is
 * decorative and hidden from them.
 */
export function SortableTh({
  children,
  align = "left",
  href,
  direction,
}: {
  children?: ReactNode;
  align?: "left" | "right";
  href: string;
  /** `null` when this column is not the one currently sorted. */
  direction?: SortDirection | null;
}) {
  return (
    <th
      scope="col"
      aria-sort={
        direction ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={cn(TH_BASE, align === "right" ? "text-right" : "text-left")}
    >
      <Link
        href={href}
        // Sorting rewrites the rows in place; jumping the viewport to the top
        // of the table would lose the row the user was looking at.
        scroll={false}
        className={cn(
          "group inline-flex items-center gap-1 rounded-sm uppercase tracking-[0.1em] transition-colors hover:text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          direction && "text-ink",
          // On a right-aligned column the arrow goes before the label, so the
          // label itself stays flush with the right edge the numbers align to.
          align === "right" && "flex-row-reverse",
        )}
      >
        {children}
        <span
          aria-hidden="true"
          className={cn(
            "text-[10px] leading-none",
            direction
              ? "opacity-100"
              : "opacity-0 transition-opacity group-hover:opacity-50",
          )}
        >
          {direction === "asc" ? "↑" : direction === "desc" ? "↓" : "↕"}
        </span>
      </Link>
    </th>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b border-line last:border-0 hover:bg-raised">
      {children}
    </tr>
  );
}

export function Td({
  children,
  align = "left",
  className,
}: {
  children?: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-5 py-3.5 align-middle",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}
