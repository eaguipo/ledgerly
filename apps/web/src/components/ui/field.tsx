import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Shared control surface. One definition so inputs, selects and the read-only
 * "fixed value" panel can never drift apart visually.
 */
export const controlClass =
  "w-full rounded-xl border border-field-border bg-raised px-3 py-2.5 text-sm text-ink " +
  // `hover:border-muted` and not an alpha modifier: `border-ink/40` would
  // compile to a full-strength ink border, because alpha is lost on var-backed
  // theme tokens (see globals.css).
  "placeholder:text-faint transition-colors hover:border-muted " +
  "focus:border-accent focus:bg-surface";

export function Field({
  label,
  htmlFor,
  hint,
  optional,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-[13px] font-medium text-muted"
      >
        {label}
        {optional ? (
          <span className="ml-1 font-normal text-faint">(optional)</span>
        ) : null}
      </label>
      {children}
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cn(controlClass, className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={cn(controlClass, className)} />;
}

export function Checkbox({
  label,
  ...props
}: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted">
      <input
        type="checkbox"
        {...props}
        className="h-4 w-4 rounded border-field-border accent-accent"
      />
      {label}
    </label>
  );
}
