"use client";

import { useActionState, useState } from "react";
import { createInvestment, type InvestmentFormState } from "./actions";
import { one, PICKABLE_INVESTMENT_KINDS, todayIso } from "./constants";
import type { CurrencyOption, InvestmentAccount } from "./types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { ChoiceWithCustom } from "@/components/ui/choice-with-custom";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

const initial: InvestmentFormState = { status: "idle" };

export function InvestmentForm({
  accounts,
  currencies,
  kindLabels,
  defaultCurrencyId,
}: {
  accounts: InvestmentAccount[];
  currencies: CurrencyOption[];
  kindLabels: string[];
  defaultCurrencyId?: string;
}) {
  const [state, action, pending] = useActionState(createInvestment, initial);

  // Clearing the form is a remount, not a pile of setState calls: a new id per
  // success changes the key and React throws the old fields away.
  return (
    <InvestmentFields
      key={state.status === "success" ? state.investmentId : "entry"}
      accounts={accounts}
      currencies={currencies}
      kindLabels={kindLabels}
      defaultCurrencyId={defaultCurrencyId}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function InvestmentFields({
  accounts,
  currencies,
  kindLabels,
  defaultCurrencyId,
  action,
  pending,
  state,
}: {
  accounts: InvestmentAccount[];
  currencies: CurrencyOption[];
  kindLabels: string[];
  defaultCurrencyId?: string;
  action: (formData: FormData) => void;
  pending: boolean;
  state: InvestmentFormState;
}) {
  // The profile's default currency, NOT currencies[0] — the list is ordered by
  // code, so falling back to the first entry would quietly denominate a peso
  // holding in dirhams.
  const [currencyId, setCurrencyId] = useState(
    currencies.find((c) => c.id === defaultCurrencyId)?.id ??
      currencies[0]?.id ??
      "",
  );
  const [accountId, setAccountId] = useState("");

  const currency = currencies.find((c) => c.id === currencyId);
  // create_investment rejects a paying account in a different currency —
  // trg_txn_currency (BR17) requires a transaction to match its account, and
  // this now posts a real transaction.
  const eligible = accounts.filter(
    (a) => one(a.currency)?.code === currency?.code,
  );
  const selectedAccount = eligible.find((a) => a.id === accountId);

  return (
    <form action={action} className="space-y-4">
      <Field label="What did you invest in?" htmlFor="name">
        <Input
          id="name"
          name="name"
          type="text"
          required
          maxLength={120}
          placeholder="e.g. Pag-IBIG MP2 2026"
        />
      </Field>

      <ChoiceWithCustom
        label="Type"
        name="kind"
        required
        placeholder="Select type…"
        options={PICKABLE_INVESTMENT_KINDS}
        addLabel="+ Name my own type…"
        custom={{
          name: "kind_label",
          label: "Type name",
          placeholder: "e.g. Gold bar",
          suggestions: kindLabels,
        }}
      />

      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount invested" htmlFor="invested_amount">
          <Input
            id="invested_amount"
            name="invested_amount"
            type="number"
            step="any"
            min="0"
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

      <div className="grid grid-cols-2 gap-4">
        <Field label="Ticker / symbol" htmlFor="symbol" optional>
          <Input
            id="symbol"
            name="symbol"
            type="text"
            maxLength={24}
            placeholder="e.g. BTC"
          />
        </Field>

        <Field label="Quantity" htmlFor="quantity" optional>
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

      <div className="grid grid-cols-2 gap-4">
        <Field label="Opened on" htmlFor="opened_on" optional>
          <Input
            id="opened_on"
            name="opened_on"
            type="date"
            defaultValue={todayIso()}
          />
        </Field>

        <Field
          label="Matures on"
          htmlFor="maturity_date"
          optional
          hint="Informational only — nothing grows on its own."
        >
          <Input id="maturity_date" name="maturity_date" type="date" />
        </Field>
      </div>

      {/* Naming this "Paid from" rather than "Funded from" is the whole point:
          picking an account now MOVES REAL MONEY out of it, dated the opened-on
          date above. Leaving it blank is how you record something you already
          owned — same rule as a debt that predates the app. */}
      <Field
        label="Paid from"
        htmlFor="portfolio_id"
        optional
        hint={
          eligible.length === 0
            ? `You have no ${currency?.code ?? ""} account to pay from.`
            : selectedAccount
              ? `The amount invested comes out of ${selectedAccount.name}, dated the opened-on date. It won't count as spending.`
              : "Money leaves the account you pick. Leave blank for something you already owned."
        }
      >
        <Select
          id="portfolio_id"
          name="portfolio_id"
          value={accountId}
          disabled={eligible.length === 0}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">Don&apos;t record a payment</option>
          {eligible.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {formatMoney(a.current_balance, one(a.currency))}
            </option>
          ))}
        </Select>
      </Field>

      {/* No client-side overdraft pre-check: the options payload carries no
          `allow_negative`, so a balance comparison here would wrongly warn on
          accounts that are allowed to go negative. create_investment holds the
          row under FOR UPDATE and returns a message naming the account and the
          shortfall — that error surfaces in the Alert below. */}

      {/* Both mounted always, filled conditionally — a live region created at
          the same moment it gains text is usually not announced. */}
      <Alert tone="error">
        {state.status === "error" ? state.message : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success" ? "Investment recorded." : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Add investment"}
      </Button>
    </form>
  );
}
