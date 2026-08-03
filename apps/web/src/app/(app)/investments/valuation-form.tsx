"use client";

import { useActionState, useState } from "react";
import { recordValuation, type SnapshotFormState } from "./actions";
import { formatDate, one, todayIso } from "./constants";
import type { InvestmentRow } from "./types";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

const initial: SnapshotFormState = { status: "idle" };

/**
 * "What's it worth now?" — the control that posts a snapshot.
 *
 * Two layouts from one component. `compact` is the version that fits on a card
 * in a grid: value + save, with the date fixed to today. The full version on the
 * detail page also exposes the date, so a valuation can be back-filled.
 *
 * The date matters more here than a contribution's does on a goal. Goals sum
 * every row regardless of date; sync_investment_current_value() picks the row
 * with the NEWEST as_of_date and copies it onto current_value — so the date is
 * what decides whether this valuation becomes the headline figure at all. That
 * is also why the input carries a max: a future date would win that race forever.
 */
export function ValuationForm({
  investment,
  compact = false,
}: {
  investment: InvestmentRow;
  compact?: boolean;
}) {
  const [state, action, pending] = useActionState(recordValuation, initial);

  return (
    <ValuationFields
      key={state.status === "success" ? state.snapshotId : "entry"}
      investment={investment}
      compact={compact}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function ValuationFields({
  investment,
  compact,
  action,
  pending,
  state,
}: {
  investment: InvestmentRow;
  compact: boolean;
  action: (formData: FormData) => void;
  pending: boolean;
  state: SnapshotFormState;
}) {
  const [value, setValue] = useState("");
  const [asOf, setAsOf] = useState(todayIso());
  const currency = one(investment.currency);
  const today = todayIso();

  const valueNum = parseFloat(value);
  const valid = Number.isFinite(valueNum) && valueNum >= 0;
  // The RPC rejects this too. Catching it here saves the round trip and, more
  // usefully, says why — a future-dated valuation is not just odd data, it would
  // pin current_value permanently.
  const future = asOf > today;

  const feedback = (
    <>
      <Alert tone="error">
        {state.status === "error"
          ? state.message
          : future
            ? "A valuation can't be dated in the future."
            : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success"
          ? state.isLatest
            ? `Now worth ${formatMoney(state.currentValue, currency)}.`
            : `Saved. A newer valuation still stands, so the current value is unchanged at ${formatMoney(state.currentValue, currency)}.`
          : null}
      </Alert>
    </>
  );

  if (compact) {
    return (
      <form action={action} className="space-y-2.5">
        <input type="hidden" name="investment_id" value={investment.id} />
        <input type="hidden" name="as_of_date" value={today} />

        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`What ${investment.name} is worth today`}
            name="market_value"
            type="number"
            step="any"
            min="0"
            required
            placeholder="Value today"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" disabled={pending || !valid}>
            {pending ? "…" : "Update value"}
          </Button>
        </div>

        {feedback}
      </form>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="investment_id" value={investment.id} />

      <div className="grid grid-cols-2 gap-4">
        <Field label="Value" htmlFor="market_value">
          <Input
            id="market_value"
            name="market_value"
            type="number"
            step="any"
            min="0"
            required
            placeholder="0.00"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>

        <Field
          label="As of"
          htmlFor="as_of_date"
          hint={
            asOf < today
              ? `Back-filling ${formatDate(asOf)} — this only becomes the current value if it's the newest one.`
              : undefined
          }
        >
          <Input
            id="as_of_date"
            name="as_of_date"
            type="date"
            required
            max={today}
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Unit price" htmlFor="unit_price" optional>
          <Input
            id="unit_price"
            name="unit_price"
            type="number"
            step="any"
            min="0"
            placeholder="0.00"
          />
        </Field>

        <Field
          label="Quantity"
          htmlFor="quantity"
          optional
          hint="Recorded against this valuation only."
        >
          <Input
            id="quantity"
            name="quantity"
            type="number"
            step="any"
            min="0"
            placeholder="e.g. 0.05"
          />
        </Field>
      </div>

      {feedback}

      <Button
        type="submit"
        disabled={pending || !valid || future}
        className="w-full"
      >
        {pending ? "Saving…" : "Record value"}
      </Button>
    </form>
  );
}
