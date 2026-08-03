"use client";

import { useActionState, useState } from "react";
import type { GoalFormState } from "./actions";
import { one } from "./constants";
import type { CurrencyOption, GoalAccount } from "./types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

/** The subset of a goal the edit form fills itself in from. */
export interface GoalInput {
  id: string;
  name: string;
  target_amount: string;
  target_date: string | null;
  currency_code: string;
  /** Shown read-only: re-pointing a goal is a new goal, not an edit. */
  linked_portfolio_name: string | null;
}

type Action = (
  state: GoalFormState,
  formData: FormData,
) => Promise<GoalFormState>;

const initial: GoalFormState = { status: "idle" };

interface FormProps {
  action: Action;
  accounts: GoalAccount[];
  currencies: CurrencyOption[];
  mode: "create" | "edit";
  goal?: GoalInput;
  defaultCurrencyId?: string;
  submitLabel: string;
}

export function GoalForm(props: FormProps) {
  const [state, action, pending] = useActionState(props.action, initial);

  // Clearing the form is a remount, not a pile of setState calls: a new goal id
  // per success changes the key and React throws the old fields away. In edit
  // mode the key never changes — updateGoal redirects to the list instead of
  // returning a success state.
  return (
    <GoalFields
      key={state.status === "success" ? state.goalId : "entry"}
      {...props}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function GoalFields({
  accounts,
  currencies,
  mode,
  goal,
  defaultCurrencyId,
  submitLabel,
  action,
  pending,
  state,
}: Omit<FormProps, "action"> & {
  action: (formData: FormData) => void;
  pending: boolean;
  state: GoalFormState;
}) {
  const editing = mode === "edit" && goal !== undefined;

  // The profile's default currency, NOT currencies[0] — the list is ordered by
  // code, so falling back to the first entry would quietly denominate a peso
  // goal in dirhams.
  const [currencyId, setCurrencyId] = useState(
    currencies.find((c) => c.id === defaultCurrencyId)?.id ??
      currencies[0]?.id ??
      "",
  );
  const [accountId, setAccountId] = useState("");

  const currency = currencies.find((c) => c.id === currencyId);
  // create_goal rejects a linked account in a different currency — the whole
  // point of the link is comparing what's earmarked against what the account
  // holds, and that comparison is meaningless across currencies.
  const eligible = accounts.filter(
    (a) => one(a.currency)?.code === currency?.code,
  );

  return (
    <form action={action} className="space-y-4">
      {editing ? <input type="hidden" name="id" value={goal.id} /> : null}

      <Field label="What are you saving for?" htmlFor="name">
        <Input
          id="name"
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={goal?.name ?? ""}
          placeholder="e.g. Emergency fund"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Target"
          htmlFor="target_amount"
          hint={
            // trg_goal_status re-evaluates achievement on this update, so the
            // goal can change state without the user touching a status control.
            editing
              ? "Dropping this to at or below what's set aside marks the goal achieved."
              : undefined
          }
        >
          <Input
            id="target_amount"
            name="target_amount"
            type="number"
            step="any"
            min="0.01"
            required
            defaultValue={goal?.target_amount}
            placeholder="0.00"
          />
        </Field>

        <Field label="Currency" htmlFor="currency_id">
          {editing ? (
            // Fixed after creation: create_goal() is the one place that checks a
            // linked account holds the goal's currency, so changing it here
            // would leave that pairing unvalidated.
            <p className="rounded-xl border border-line bg-raised px-3 py-2.5 text-sm text-muted">
              {goal.currency_code}{" "}
              <span className="text-xs text-faint">(fixed)</span>
            </p>
          ) : (
            <Select
              id="currency_id"
              name="currency_id"
              required
              value={currencyId}
              onChange={(e) => {
                setCurrencyId(e.target.value);
                setAccountId(""); // the eligible list just changed
              }}
            >
              {currencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field label="Target date" htmlFor="target_date" optional>
        <Input
          id="target_date"
          name="target_date"
          type="date"
          defaultValue={goal?.target_date ?? ""}
        />
      </Field>

      <Field
        label="Backed by"
        htmlFor="linked_portfolio_id"
        optional
        hint={
          editing
            ? "Fixed after creation — pointing a goal at a different account means making a new one."
            : eligible.length === 0
              ? `You have no ${currency?.code ?? ""} account to link this to.`
              : "Only used to warn you when you've earmarked more than the account holds. No money moves either way."
        }
      >
        {editing ? (
          <p className="rounded-xl border border-line bg-raised px-3 py-2.5 text-sm text-muted">
            {goal.linked_portfolio_name ?? "No account"}
          </p>
        ) : (
          <Select
            id="linked_portfolio_id"
            name="linked_portfolio_id"
            value={accountId}
            disabled={eligible.length === 0}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">No account</option>
            {eligible.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {formatMoney(a.current_balance, one(a.currency))}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {/* Both mounted always, filled conditionally — a live region created at
          the same moment it gains text is usually not announced. */}
      <Alert tone="error">
        {state.status === "error" ? state.message : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success" ? "Goal created." : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
