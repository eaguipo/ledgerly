"use client";

import { useActionState } from "react";
import { PORTFOLIO_CATEGORIES } from "./constants";
import type { PortfolioFormState } from "./actions";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";

interface Currency {
  id: string;
  code: string;
  symbol: string | null;
  name: string;
}

interface PortfolioInput {
  id: string;
  name: string;
  category: string;
  currency_id: string;
  is_savings: boolean;
  institution: string | null;
}

type Action = (
  state: PortfolioFormState,
  formData: FormData,
) => Promise<PortfolioFormState>;

const initialState: PortfolioFormState = { status: "idle" };

export function PortfolioForm({
  action,
  currencies,
  mode,
  portfolio,
  defaultCurrencyId,
  submitLabel,
}: {
  action: Action;
  currencies: Currency[];
  mode: "create" | "edit";
  portfolio?: PortfolioInput;
  defaultCurrencyId?: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const currentCurrency = currencies.find(
    (c) => c.id === portfolio?.currency_id,
  );

  return (
    <form action={formAction} className="space-y-4">
      {mode === "edit" && portfolio ? (
        <input type="hidden" name="id" value={portfolio.id} />
      ) : null}

      <Field label="Account name" htmlFor="name">
        <Input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={portfolio?.name ?? ""}
          placeholder="e.g. Bank 1, Cash Wallet"
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Category" htmlFor="category">
          <Select
            id="category"
            name="category"
            defaultValue={portfolio?.category ?? "cash"}
          >
            {PORTFOLIO_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Currency" htmlFor="currency_id">
          {mode === "create" ? (
            <Select
              id="currency_id"
              name="currency_id"
              defaultValue={defaultCurrencyId ?? ""}
              required
            >
              {currencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="rounded-xl border border-line bg-raised px-3 py-2.5 text-sm text-muted">
              {currentCurrency
                ? `${currentCurrency.code} — ${currentCurrency.name}`
                : "—"}{" "}
              <span className="text-xs text-faint">(fixed)</span>
            </p>
          )}
        </Field>
      </div>

      {mode === "create" ? (
        <Field
          label="Opening balance"
          htmlFor="opening_balance"
          hint="Posts an opening-balance entry so the balance is correct from day one."
        >
          <Input
            id="opening_balance"
            name="opening_balance"
            type="number"
            min="0"
            step="any"
            defaultValue="0"
          />
        </Field>
      ) : null}

      <Field label="Institution" htmlFor="institution" optional>
        <Input
          id="institution"
          name="institution"
          type="text"
          defaultValue={portfolio?.institution ?? ""}
          placeholder="e.g. BPI, Binance"
        />
      </Field>

      <Checkbox
        name="is_savings"
        defaultChecked={portfolio?.is_savings ?? false}
        label="Savings account (counts toward liquid money)"
      />

      {state.status === "error" ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
