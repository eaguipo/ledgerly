"use client";

import { useActionState, useState } from "react";
import type { InvestmentFormState } from "./actions";
import {
  CUSTOM_INVESTMENT_KIND,
  one,
  PICKABLE_INVESTMENT_KINDS,
  todayIso,
} from "./constants";
import type { CurrencyOption, InvestmentAccount } from "./types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { ChoiceWithCustom } from "@/components/ui/choice-with-custom";
import { CUSTOM_CHOICE } from "@/lib/custom-choice";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

/** The subset of a holding the edit form fills itself in from. */
export interface InvestmentInput {
  id: string;
  name: string;
  kind: string;
  kind_label: string | null;
  currency_id: string;
  invested_amount: string;
  symbol: string | null;
  quantity: string;
  opened_on: string | null;
  maturity_date: string | null;
  portfolio_id: string | null;
  /** True when a real purchase was posted, i.e. editing the cost basis moves cash. */
  has_purchase: boolean;
}

type Action = (
  state: InvestmentFormState,
  formData: FormData,
) => Promise<InvestmentFormState>;

const initial: InvestmentFormState = { status: "idle" };

interface FormProps {
  action: Action;
  accounts: InvestmentAccount[];
  currencies: CurrencyOption[];
  kindLabels: string[];
  mode: "create" | "edit";
  investment?: InvestmentInput;
  defaultCurrencyId?: string;
  submitLabel: string;
}

export function InvestmentForm(props: FormProps) {
  const [state, action, pending] = useActionState(props.action, initial);

  // Clearing the form is a remount, not a pile of setState calls: a new id per
  // success changes the key and React throws the old fields away. In edit mode
  // the key never changes — updateInvestment redirects to the detail page rather
  // than returning a success state.
  return (
    <InvestmentFields
      key={state.status === "success" ? state.investmentId : "entry"}
      {...props}
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
  mode,
  investment,
  defaultCurrencyId,
  submitLabel,
  action,
  pending,
  state,
}: Omit<FormProps, "action"> & {
  action: (formData: FormData) => void;
  pending: boolean;
  state: InvestmentFormState;
}) {
  const editing = mode === "edit" && investment !== undefined;

  // The profile's default currency, NOT currencies[0] — the list is ordered by
  // code, so falling back to the first entry would quietly denominate a peso
  // holding in dirhams. Fixed once the holding exists: the purchase leg has to
  // match the paying account's currency (BR17), so re-denominating is a new
  // record rather than an edit.
  const [currencyId, setCurrencyId] = useState(
    investment?.currency_id ??
      currencies.find((c) => c.id === defaultCurrencyId)?.id ??
      currencies[0]?.id ??
      "",
  );
  const [accountId, setAccountId] = useState(investment?.portfolio_id ?? "");

  // 'other_asset' is not in the picker — naming your own type IS that member —
  // so a holding already stored against it reopens on the custom entry with its
  // name filled in.
  const isCustomKind = investment?.kind === CUSTOM_INVESTMENT_KIND;

  const currency = currencies.find((c) => c.id === currencyId);
  // create_investment / update_investment reject a paying account in a different
  // currency — trg_txn_currency (BR17) requires a transaction to match its
  // account, and this posts a real transaction.
  const eligible = accounts.filter(
    (a) => one(a.currency)?.code === currency?.code,
  );
  const selectedAccount = eligible.find((a) => a.id === accountId);

  return (
    <form action={action} className="space-y-4">
      {editing ? <input type="hidden" name="id" value={investment.id} /> : null}

      <Field label="What did you invest in?" htmlFor="name">
        <Input
          id="name"
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={investment?.name ?? ""}
          placeholder="e.g. Pag-IBIG MP2 2026"
        />
      </Field>

      <ChoiceWithCustom
        label="Type"
        name="kind"
        required
        placeholder="Select type…"
        defaultValue={
          isCustomKind ? CUSTOM_CHOICE : (investment?.kind ?? "")
        }
        options={PICKABLE_INVESTMENT_KINDS}
        addLabel="+ Name my own type…"
        custom={{
          name: "kind_label",
          label: "Type name",
          placeholder: "e.g. Gold bar",
          defaultValue: investment?.kind_label ?? undefined,
          suggestions: kindLabels,
        }}
      />

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Amount invested"
          htmlFor="invested_amount"
          hint={
            // Correcting the cost basis on a holding that was paid for moves the
            // account balance with it. That is the fix update_investment() exists
            // for, and it should not be a surprise.
            editing && investment.has_purchase
              ? "Changing this re-posts the payment, so the account balance moves too."
              : undefined
          }
        >
          <Input
            id="invested_amount"
            name="invested_amount"
            type="number"
            step="any"
            min="0"
            required
            defaultValue={investment?.invested_amount}
            placeholder="0.00"
          />
        </Field>

        <Field label="Currency" htmlFor="currency_id">
          {editing ? (
            <>
              <p className="rounded-xl border border-line bg-raised px-3 py-2.5 text-sm text-muted">
                {currency ? currency.code : "—"}{" "}
                <span className="text-xs text-faint">(fixed)</span>
              </p>
              <input
                type="hidden"
                name="currency_id"
                value={investment.currency_id}
              />
            </>
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

      <div className="grid grid-cols-2 gap-4">
        <Field label="Ticker / symbol" htmlFor="symbol" optional>
          <Input
            id="symbol"
            name="symbol"
            type="text"
            maxLength={24}
            defaultValue={investment?.symbol ?? ""}
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
            defaultValue={investment?.quantity}
            placeholder="e.g. 0.05"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Opened on"
          htmlFor="opened_on"
          optional
          hint={
            editing && investment.has_purchase
              ? "Also the payment's date."
              : undefined
          }
        >
          <Input
            id="opened_on"
            name="opened_on"
            type="date"
            defaultValue={investment?.opened_on ?? todayIso()}
          />
        </Field>

        <Field
          label="Matures on"
          htmlFor="maturity_date"
          optional
          hint="Informational only — nothing grows on its own."
        >
          <Input
            id="maturity_date"
            name="maturity_date"
            type="date"
            defaultValue={investment?.maturity_date ?? ""}
          />
        </Field>
      </div>

      {/* Naming this "Paid from" rather than "Funded from" is the whole point:
          picking an account MOVES REAL MONEY out of it, dated the opened-on
          date above. Leaving it blank is how you record something you already
          owned — same rule as a debt that predates the app. On an edit, clearing
          it un-records the payment and gives the cash back. */}
      <Field
        label="Paid from"
        htmlFor="portfolio_id"
        optional
        hint={
          eligible.length === 0
            ? `You have no ${currency?.code ?? ""} account to pay from.`
            : selectedAccount
              ? `The amount invested comes out of ${selectedAccount.name}, dated the opened-on date. It won't count as spending.`
              : editing && investment.has_purchase
                ? "Clearing this gives the money back and leaves the holding as a record only."
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
          accounts that are allowed to go negative. The RPC holds the row under
          FOR UPDATE and returns a message naming the account and the
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
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
