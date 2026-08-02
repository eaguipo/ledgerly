import type { ReactNode } from "react";
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
      className={cn(
        "border-b border-line px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
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
