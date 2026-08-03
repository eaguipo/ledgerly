"use client";

import { useActionState, useState } from "react";
import { createGoal, type GoalFormState } from "./actions";
import { one } from "./constants";
import type { CurrencyOption, GoalAccount } from "./types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

const initial: GoalFormState = { status: "idle" };

export function GoalForm({
  accounts,
  currencies,
  defaultCurrencyId,
}: {
  accounts: GoalAccount[];
  currencies: CurrencyOption[];
  defaultCurrencyId?: string;
}) {
  const [state, action, pending] = useActionState(createGoal, initial);

  // Clearing the form is a remount, not a pile of setState calls: a new goal id
  // per success changes the key and React throws the old fields away.
  return (
    <GoalFields
      key={state.status === "success" ? state.goalId : "entry"}
      accounts={accounts}
      currencies={currencies}
      defaultCurrencyId={defaultCurrencyId}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function GoalFields({
  accounts,
  currencies,
  defaultCurrencyId,
  action,
  pending,
  state,
}: {
  accounts: GoalAccount[];
  currencies: CurrencyOption[];
  defaultCurrencyId?: string;
  action: (formData: FormData) => void;
  pending: boolean;
  state: GoalFormState;
}) {
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
      <Field label="What are you saving for?" htmlFor="name">
        <Input
          id="name"
          name="name"
          type="text"
          required
          maxLength={120}
          placeholder="e.g. Emergency fund"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Target" htmlFor="target_amount">
          <Input
            id="target_amount"
            name="target_amount"
            type="number"
            step="any"
            min="0.01"
            required
            placeholder="0.00"
          />
        </Field>

        <Field label="Currency" htmlFor="currency_id">
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
        </Field>
      </div>

      <Field label="Target date" htmlFor="target_date" optional>
        <Input id="target_date" name="target_date" type="date" />
      </Field>

      <Field
        label="Backed by"
        htmlFor="linked_portfolio_id"
        optional
        hint={
          eligible.length === 0
            ? `You have no ${currency?.code ?? ""} account to link this to.`
            : "Only used to warn you when you've earmarked more than the account holds. No money moves either way."
        }
      >
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
        {pending ? "Creating…" : "Create goal"}
      </Button>
    </form>
  );
}
