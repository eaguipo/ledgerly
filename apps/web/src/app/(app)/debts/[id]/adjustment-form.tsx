"use client";

import { useActionState, useState } from "react";
import { adjustDebt, type AdjustmentFormState } from "../actions";
import { ADJUSTMENT_REASONS, adjustmentReason, todayIso } from "../constants";
import type { Currency, DebtRow } from "../types";
import { one } from "../constants";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

const initial: AdjustmentFormState = { status: "idle" };

/**
 * Change what's owed without any cash moving.
 *
 * The amount is always entered as a positive magnitude and the REASON decides
 * the sign — interest raises the debt, an off-app payment lowers it — so nobody
 * has to reason about minus signs. 'Correction' is the one reason that can go
 * either way, and it is the only one that asks.
 */
export function AdjustmentForm({ debt }: { debt: DebtRow }) {
  const [state, action, pending] = useActionState(adjustDebt, initial);

  return (
    <AdjustmentFields
      key={state.status === "success" ? state.adjustmentId : "entry"}
      debt={debt}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function AdjustmentFields({
  debt,
  action,
  pending,
  state,
}: {
  debt: DebtRow;
  action: (formData: FormData) => void;
  pending: boolean;
  state: AdjustmentFormState;
}) {
  // Typed as plain string: ADJUSTMENT_REASONS is `as const`, so inferring from
  // the first entry would narrow this to that one literal.
  const [reason, setReason] = useState<string>(ADJUSTMENT_REASONS[0].value);
  const meta = adjustmentReason(reason);
  const currency = one(debt.currency) as Currency | undefined;
  const needsDirection = meta.grows === null;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="debt_id" value={debt.id} />

      <Field label="What changed?" htmlFor="reason" hint={meta.hint}>
        <Select
          id="reason"
          name="reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {ADJUSTMENT_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>

      {/* Only 'correction' can point either way, so only it asks. Every other
          reason has one honest direction and the server derives it. */}
      {needsDirection ? (
        <Field label="Which way?" htmlFor="direction">
          <Select id="direction" name="direction" required defaultValue="decrease">
            <option value="decrease">Lower what&apos;s owed</option>
            <option value="increase">Raise what&apos;s owed</option>
          </Select>
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Amount"
          htmlFor="amount"
          hint={
            needsDirection
              ? undefined
              : meta.grows
                ? "Added to what's owed."
                : "Taken off what's owed."
          }
        >
          <Input
            id="amount"
            name="amount"
            type="number"
            step="any"
            min="0.01"
            required
            placeholder="0.00"
          />
        </Field>

        <Field label="Date" htmlFor="effective_on">
          <Input
            id="effective_on"
            name="effective_on"
            type="date"
            defaultValue={todayIso()}
            required
          />
        </Field>
      </div>

      <Field label="Note" htmlFor="note" optional>
        <Input
          id="note"
          name="note"
          type="text"
          placeholder="e.g. March statement interest"
        />
      </Field>

      <p className="text-xs text-faint">
        No account balance changes — this only changes what the debt says.
      </p>

      {/* Both mounted always, filled conditionally. */}
      <Alert tone="error">
        {state.status === "error" ? state.message : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success"
          ? `Recorded. ${formatMoney(state.outstandingAfter, currency)} outstanding${
              state.statusAfter === "settled" ? " — that settles it." : "."
            }`
          : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Record adjustment"}
      </Button>
    </form>
  );
}
