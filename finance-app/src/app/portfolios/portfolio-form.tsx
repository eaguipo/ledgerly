"use client";

import { useActionState } from "react";
import { PORTFOLIO_CATEGORIES } from "./constants";
import type { PortfolioFormState } from "./actions";

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

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
const labelClass =
  "block text-sm font-medium text-zinc-700 dark:text-zinc-300";

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

      <div className="space-y-1">
        <label htmlFor="name" className={labelClass}>
          Account name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={portfolio?.name ?? ""}
          placeholder="e.g. Bank 1, Cash Wallet, Crypto Wallet"
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="category" className={labelClass}>
            Category
          </label>
          <select
            id="category"
            name="category"
            defaultValue={portfolio?.category ?? "cash"}
            className={inputClass}
          >
            {PORTFOLIO_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="currency_id" className={labelClass}>
            Currency
          </label>
          {mode === "create" ? (
            <select
              id="currency_id"
              name="currency_id"
              defaultValue={defaultCurrencyId ?? ""}
              required
              className={inputClass}
            >
              {currencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {currentCurrency
                ? `${currentCurrency.code} — ${currentCurrency.name}`
                : "—"}{" "}
              <span className="text-xs">(fixed)</span>
            </p>
          )}
        </div>
      </div>

      {mode === "create" ? (
        <div className="space-y-1">
          <label htmlFor="opening_balance" className={labelClass}>
            Opening balance
          </label>
          <input
            id="opening_balance"
            name="opening_balance"
            type="number"
            min="0"
            step="any"
            defaultValue="0"
            className={inputClass}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Posts an opening-balance entry so the balance is correct from day one.
          </p>
        </div>
      ) : null}

      <div className="space-y-1">
        <label htmlFor="institution" className={labelClass}>
          Institution <span className="text-zinc-400">(optional)</span>
        </label>
        <input
          id="institution"
          name="institution"
          type="text"
          defaultValue={portfolio?.institution ?? ""}
          placeholder="e.g. BPI, Binance"
          className={inputClass}
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="is_savings"
          defaultChecked={portfolio?.is_savings ?? false}
          className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500/40 dark:border-zinc-700"
        />
        Savings account (counts toward liquid money)
      </label>

      {state.status === "error" ? (
        <p
          role="alert"
          className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
