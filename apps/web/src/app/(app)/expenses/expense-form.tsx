"use client";

import { useActionState, useEffect, useRef } from "react";
import { createExpense, type ExpenseFormState } from "./actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";

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
        <Field label="Amount" htmlFor="amount">
          <Input
            id="amount"
            name="amount"
            type="number"
            step="any"
            min="0.01"
            required
            placeholder="0.00"
          />
        </Field>

        <Field label="Date" htmlFor="txn_date">
          <Input
            id="txn_date"
            name="txn_date"
            type="date"
            defaultValue={todayIso()}
            required
          />
        </Field>
      </div>

      <Field label="Account" htmlFor="portfolio_id">
        <Select id="portfolio_id" name="portfolio_id" required defaultValue="">
          <option value="">Select account…</option>
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Category" htmlFor="category_id">
        <Select id="category_id" name="category_id" required defaultValue="">
          <option value="">Select category…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Merchant" htmlFor="merchant" optional>
        <Input
          id="merchant"
          name="merchant"
          type="text"
          placeholder="Where did you spend?"
        />
      </Field>

      <Field label="Note" htmlFor="description" optional>
        <Input
          id="description"
          name="description"
          type="text"
          placeholder="Add a note…"
        />
      </Field>

      {/* Both mounted always, filled conditionally — a live region created at
          the same moment it gains text is usually not announced, and the
          success message is the only confirmation the form gives. */}
      <Alert tone="error">
        {state.status === "error" ? state.message : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success" ? "Expense added." : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Add expense"}
      </Button>
    </form>
  );
}
