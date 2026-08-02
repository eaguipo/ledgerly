"use client";

import { useActionState, useState } from "react";
import { createDebt, type DebtFormState } from "./actions";
import { DEBT_KINDS, debtKind, one, todayIso } from "./constants";
import type { CurrencyOption, DebtAccount } from "./types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

const initial: DebtFormState = { status: "idle" };

export function DebtForm({
  accounts,
  currencies,
  defaultCurrencyId,
}: {
  accounts: DebtAccount[];
  currencies: CurrencyOption[];
  defaultCurrencyId?: string;
}) {
  const [state, action, pending] = useActionState(createDebt, initial);

  // Clearing the form is a remount, not a pile of setState calls: a new debt id
  // per success changes the key, React throws the old fields away, and every
  // default (including today's date) re-initialises for free.
  return (
    <DebtFields
      key={state.status === "success" ? state.debtId : "entry"}
      accounts={accounts}
      currencies={currencies}
      defaultCurrencyId={defaultCurrencyId}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function DebtFields({
  accounts,
  currencies,
  defaultCurrencyId,
  action,
  pending,
  state,
}: {
  accounts: DebtAccount[];
  currencies: CurrencyOption[];
  defaultCurrencyId?: string;
  action: (formData: FormData) => void;
  pending: boolean;
  state: DebtFormState;
}) {
  const [kind, setKind] = useState<string>(DEBT_KINDS[0].value);
  // The profile's default currency, NOT currencies[0] — the list is ordered by
  // code, so falling back to the first entry would quietly denominate a peso
  // debt in dirhams.
  const [currencyId, setCurrencyId] = useState(
    currencies.find((c) => c.id === defaultCurrencyId)?.id ??
      currencies[0]?.id ??
      "",
  );
  const [principal, setPrincipal] = useState("");
  const [accountId, setAccountId] = useState("");

  const copy = debtKind(kind);
  const currency = currencies.find((c) => c.id === currencyId);

  // A disbursement posts a transaction into the chosen account, and a
  // transaction must match its account's currency (BR17). Offering accounts the
  // RPC is going to reject is just a slower way of showing an error.
  const eligible = accounts.filter(
    (a) => one(a.currency)?.code === currency?.code,
  );
  const account = eligible.find((a) => a.id === accountId);

  const principalNum = parseFloat(principal);
  const validPrincipal = Number.isFinite(principalNum) && principalNum > 0;

  // Lending out more than the account holds is the one client-side warning worth
  // having here — borrowing only ever adds money. Soft, because the DB's guard
  // knows about allow_negative accounts and this does not.
  const lendingBalance = account ? Number(account.current_balance) : null;
  const wouldOverdraw =
    kind === "receivable" &&
    validPrincipal &&
    lendingBalance !== null &&
    principalNum > lendingBalance;

  return (
    <form action={action} className="space-y-4">
      <Field label="Which way does this go?" htmlFor="kind">
        <Select
          id="kind"
          name="kind"
          required
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            // The eligible-account list is filtered by currency, not kind, but
            // the *meaning* of the picked account flips — clear it so nobody
            // funds a loan from an account they chose for the opposite case.
            setAccountId("");
          }}
        >
          {DEBT_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label={kind === "payable" ? "Who you owe" : "Who owes you"}
        htmlFor="counterparty"
      >
        <Input
          id="counterparty"
          name="counterparty"
          type="text"
          required
          maxLength={120}
          placeholder="Name or organisation"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Principal" htmlFor="principal_amount">
          <Input
            id="principal_amount"
            name="principal_amount"
            type="number"
            step="any"
            min="0.01"
            required
            placeholder="0.00"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
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

      <div className="grid grid-cols-2 gap-4">
        <Field label="Due date" htmlFor="due_date" optional>
          <Input id="due_date" name="due_date" type="date" />
        </Field>

        <Field
          label="Interest rate"
          htmlFor="interest_rate"
          optional
          hint="Recorded for reference — nothing accrues on its own."
        >
          <Input
            id="interest_rate"
            name="interest_rate"
            type="number"
            step="any"
            min="0"
            placeholder="0.00"
          />
        </Field>
      </div>

      <Field
        label={copy.disbursementLabel}
        htmlFor="disbursement_portfolio_id"
        optional
        hint={
          eligible.length === 0
            ? `You have no ${currency?.code ?? ""} account, so this debt can only be recorded on its own.`
            : `${copy.disbursementHint} Leave blank if the money changed hands before you started tracking it.`
        }
      >
        <Select
          id="disbursement_portfolio_id"
          name="disbursement_portfolio_id"
          value={accountId}
          disabled={eligible.length === 0}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">No cash movement</option>
          {eligible.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {formatMoney(a.current_balance, one(a.currency))}
            </option>
          ))}
        </Select>
      </Field>

      {/* Only meaningful alongside an account, and only rendered then — a date
          input with no bearing on the outcome invites the question "which date
          is this?" */}
      {accountId ? (
        <Field label="Date the money moved" htmlFor="disbursement_date">
          <Input
            id="disbursement_date"
            name="disbursement_date"
            type="date"
            defaultValue={todayIso()}
            required
          />
        </Field>
      ) : null}

      <Field label="Note" htmlFor="note" optional>
        <Input id="note" name="note" type="text" placeholder="What is this for?" />
      </Field>

      {/* Both mounted always, filled conditionally — a live region created at
          the same moment it gains text is usually not announced. */}
      <Alert tone="error">
        {state.status === "error"
          ? state.message
          : wouldOverdraw
            ? `That's more than ${account?.name} holds (${formatMoney(lendingBalance, one(account?.currency))}).`
            : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success"
          ? state.disbursed
            ? "Debt recorded and the cash movement posted."
            : "Debt recorded. No balances changed."
          : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Record debt"}
      </Button>
    </form>
  );
}
