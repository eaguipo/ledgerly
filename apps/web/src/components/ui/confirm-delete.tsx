"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { idleDelete, type DeleteState } from "@/lib/delete-state";

/**
 * Delete, behind a deliberate second click.
 *
 * Deleting an entry rewrites an account balance and cannot be undone from the
 * UI, so it does not get the one-click treatment archive/restore get — those are
 * reversible and this is not.
 *
 * The confirmation is inline rather than `window.confirm()`. A native dialog
 * cannot be styled, is suppressed outright in some embedded browsers, and above
 * all cannot say WHAT is about to happen — which for an investment (its
 * valuations and the purchase that paid for it go too) is the entire point of
 * asking.
 */
export function ConfirmDelete({
  action,
  id,
  extra,
  label = "Delete",
  confirmLabel = "Yes, delete",
  question = "Delete this permanently?",
  size = "sm",
}: {
  action: (state: DeleteState, formData: FormData) => Promise<DeleteState>;
  id: string;
  /**
   * Extra hidden fields the action needs alongside the id — a debt adjustment,
   * for instance, redirects back to its parent debt and cannot work that out
   * from the adjustment id alone.
   */
  extra?: Record<string, string>;
  label?: string;
  /** The button that actually deletes, once armed. */
  confirmLabel?: string;
  /** What the user is agreeing to. Say what else goes with it. */
  question?: ReactNode;
  size?: "sm" | "md";
}) {
  const [armed, setArmed] = useState(false);
  const [state, formAction, pending] = useActionState(action, idleDelete);

  // The form is rendered even while disarmed so a failed attempt's message
  // survives the component snapping back to the plain button — otherwise the
  // one thing the user needs to read disappears with the confirmation.
  return (
    <div className="space-y-1.5">
      {armed ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="id" value={id} />
          {Object.entries(extra ?? {}).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <span className="text-[13px] text-muted">{question}</span>
          <Button
            type="submit"
            variant="danger"
            size={size}
            disabled={pending}
            className="bg-negative-soft text-negative"
          >
            {pending ? "Deleting…" : confirmLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size={size}
            disabled={pending}
            onClick={() => setArmed(false)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          variant="danger"
          size={size}
          onClick={() => setArmed(true)}
        >
          {label}
        </Button>
      )}

      {state.status === "error" ? (
        <p role="alert" className="text-[13px] text-negative">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
