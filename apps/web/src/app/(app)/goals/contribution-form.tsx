"use client";

import { useActionState, useState } from "react";
import { contributeToGoal, type ContributionFormState } from "./actions";
import { one, todayIso } from "./constants";
import type { GoalRow } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

const initial: ContributionFormState = { status: "idle" };

/**
 * The set-aside control on a goal card. Compact on purpose: one amount field and
 * two submit buttons, because a card in a grid cannot carry a four-field form.
 *
 * `contributed_on` is a hidden today. In the earmark model a contribution has no
 * ledger effect and `apply_goal_contribution` sums every row regardless of date,
 * so the date is a label rather than something that changes a number. When a
 * contribution history view exists, that is the moment to expose it — and the
 * note field with it.
 */
export function ContributionForm({ goal }: { goal: GoalRow }) {
  const [state, action, pending] = useActionState(contributeToGoal, initial);

  return (
    <ContributionFields
      key={state.status === "success" ? state.contributionId : "entry"}
      goal={goal}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function ContributionFields({
  goal,
  action,
  pending,
  state,
}: {
  goal: GoalRow;
  action: (formData: FormData) => void;
  pending: boolean;
  state: ContributionFormState;
}) {
  const [amount, setAmount] = useState("");
  const currency = one(goal.currency);
  const current = Number(goal.current_amount);

  const amountNum = parseFloat(amount);
  const valid = Number.isFinite(amountNum) && amountNum > 0;
  // The RPC rejects taking back more than is set aside, because clamping it
  // would leave current_amount and its contribution rows disagreeing forever.
  // Catching it here saves the round trip and names the number.
  const overWithdrawing = valid && amountNum > current;

  return (
    <form action={action} className="space-y-2.5">
      <input type="hidden" name="goal_id" value={goal.id} />
      <input type="hidden" name="contributed_on" value={todayIso()} />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={`Amount to set aside for ${goal.name}`}
          name="amount"
          type="number"
          step="any"
          min="0.01"
          required
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="min-w-0 flex-1"
        />
        {/* Two submitters over one set of fields: the name/value of whichever
            button was pressed arrives in FormData, so the user never types a
            minus sign to take money back out. */}
        <Button
          type="submit"
          name="direction"
          value="add"
          size="sm"
          disabled={pending || !valid}
        >
          {pending ? "…" : "Set aside"}
        </Button>
        <Button
          type="submit"
          name="direction"
          value="withdraw"
          variant="secondary"
          size="sm"
          disabled={pending || !valid || overWithdrawing || current <= 0}
        >
          Take back
        </Button>
      </div>

      <Alert tone="error">
        {state.status === "error"
          ? state.message
          : overWithdrawing
            ? `Only ${formatMoney(current, currency)} is set aside.`
            : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success"
          ? state.justAchieved
            ? "That completes this goal."
            : state.withdrew
              ? `Taken back. ${formatMoney(state.currentAmount, currency)} still set aside.`
              : `Set aside. ${formatMoney(state.currentAmount, currency)} in total.`
          : null}
      </Alert>
    </form>
  );
}
