"use client";

import { useActionState, useEffect, useRef } from "react";
import { createExpense, type ExpenseFormState } from "./actions";

interface Category {
  id: string;
  name: string;
}

interface Portfolio {
  id: string;
  name: string;
}

const initial: ExpenseFormState = { status: "idle" };

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ExpenseForm({
  categories,
  portfolios,
}: {
  categories: Category[];
  portfolios: Portfolio[];
}) {
  const [state, action, pending] = useActionState(createExpense, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="amount"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Amount
          </label>
          <input
            id="amount"
            name="amount"
            type="number"
            step="any"
            min="0.01"
            required
            placeholder="0.00"
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>

        <div>
          <label
            htmlFor="txn_date"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Date
          </label>
          <input
            id="txn_date"
            name="txn_date"
            type="date"
            defaultValue={todayIso()}
            required
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="portfolio_id"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Account
          </label>
          <select
            id="portfolio_id"
            name="portfolio_id"
            required
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          >
            <option value="">Select account…</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="category_id"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Category
          </label>
          <select
            id="category_id"
            name="category_id"
            required
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          >
            <option value="">Select category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="merchant"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Merchant{" "}
            <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <input
            id="merchant"
            name="merchant"
            type="text"
            placeholder="Where did you spend?"
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>

        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Note{" "}
            <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <input
            id="description"
            name="description"
            type="text"
            placeholder="Add a note…"
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
      </div>

      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      )}
      {state.status === "success" && (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          Expense added.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? "Saving…" : "Add expense"}
      </button>
    </form>
  );
}
