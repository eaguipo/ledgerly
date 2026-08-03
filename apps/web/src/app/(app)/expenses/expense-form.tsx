"use client";

import { useActionState } from "react";
import { createExpense, type ExpenseFormState } from "./actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { ChoiceWithCustom } from "@/components/ui/choice-with-custom";
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

  // Clearing the form is a remount keyed on the new expense's id, matching
  // /income and /portfolios. It used to be formRef.current.reset(), which only
  // resets DOM inputs — the category picker now holds React state ("am I
  // showing the new-category box?"), and reset() would leave that stranded
  // open above a select that had snapped back to "Select category…".
  return (
    <ExpenseFields
      key={state.status === "success" ? state.expenseId : "entry"}
      categories={categories}
      portfolios={portfolios}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function ExpenseFields({
  categories,
  portfolios,
  action,
  pending,
  state,
}: {
  categories: Category[];
  portfolios: Portfolio[];
  action: (formData: FormData) => void;
  pending: boolean;
  state: ExpenseFormState;
}) {
  return (
    <form action={action} className="space-y-4">
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

      {/* Unlike the account and income pickers, a category typed in here becomes
          a real expense_categories row, so it is offered back in this list on
          the next render — no separate "manage categories" screen needed. */}
      <ChoiceWithCustom
        label="Category"
        name="category_id"
        required
        placeholder="Select category…"
        options={categories.map((c) => ({ value: c.id, label: c.name }))}
        addLabel="+ Add a new category…"
        custom={{
          name: "new_category",
          label: "New category",
          placeholder: "e.g. Pet care",
          hint: "Saved to your category list when the expense is recorded.",
        }}
      />

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
