import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "accent"
          ? "bg-accent-soft text-accent"
          : "border border-line bg-raised text-muted",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Renders the live region unconditionally and only fills it when there is
 * something to say. A `role="status"` element that is mounted at the same
 * moment it gains text is frequently not announced — the region has to exist
 * before the content arrives for assistive tech to notice the change.
 *
 * Callers therefore pass `children` as null/false to clear an alert rather
 * than unmounting the component.
 */
export function Alert({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: ReactNode;
}) {
  const hasContent = Boolean(children);
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        hasContent && "rounded-xl px-3 py-2.5 text-[13px]",
        hasContent &&
          (tone === "error"
            ? "bg-negative-soft text-negative"
            : "bg-accent-soft text-accent"),
      )}
    >
      {children}
    </p>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-raised", className)} />
  );
}
