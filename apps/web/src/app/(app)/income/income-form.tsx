"use client";

import { useActionState, useState } from "react";
import { createIncome, type IncomeFormState } from "./actions";
import Link from "next/link";
import { PICKABLE_INCOME_SOURCES, sourceNamePlaceholder } from "./constants";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { ChoiceWithCustom } from "@/components/ui/choice-with-custom";
import { Alert } from "@/components/ui/feedback";

interface Portfolio {
  id: string;
  name: string;
}

const initial: IncomeFormState = { status: "idle" };

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function IncomeForm({
  portfolios,
  sourceLabels,
}: {
  portfolios: Portfolio[];
  sourceLabels: string[];
}) {
  const [state, action, pending] = useActionState(createIncome, initial);

  // Clearing the form is a remount, not a pile of setState calls in an effect:
  // a new income id per success changes the key, React throws the old fields
  // away, and every default (including today's date) re-initialises for free.
  return (
    <IncomeFields
      key={state.status === "success" ? state.incomeId : "entry"}
      portfolios={portfolios}
      sourceLabels={sourceLabels}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function IncomeFields({
  portfolios,
  sourceLabels,
  action,
  pending,
  state,
}: {
  portfolios: Portfolio[];
  sourceLabels: string[];
  action: (formData: FormData) => void;
  pending: boolean;
  state: IncomeFormState;
}) {
  // Only drives the placeholder and hint of the "from" field — the value itself
  // is read from FormData, so this never has to round-trip to the server.
  const [source, setSource] = useState("");

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

      <Field
        label="Into account"
        htmlFor="portfolio_id"
        hint="The amount is recorded in this account's own currency."
      >
        <Select id="portfolio_id" name="portfolio_id" required defaultValue="">
          <option value="">Select account…</option>
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>

      {/* Naming your own source stores 'other' plus the name — the enum can't
          grow members without a migration, and income reporting groups by it. */}
      <ChoiceWithCustom
        label="Source"
        name="source"
        required
        placeholder="Select source…"
        options={PICKABLE_INCOME_SOURCES.map((s) => ({
          value: s.value,
          label: s.label,
        }))}
        addLabel="+ Name my own source…"
        custom={{
          name: "source_label",
          label: "Source name",
          placeholder: "e.g. Royalties",
          suggestions: sourceLabels,
        }}
        onValueChange={setSource}
      />

      <Field
        label="From"
        htmlFor="source_name"
        optional
        hint={
          // Deliberate split (Phase 3, decision D3): a repayment recorded here
          // is cash in and nothing more. Only /debts decrements a tracked debt,
          // so there is exactly one source of truth for what is still owed.
          source === "debt_payment_received" ? (
            <>
              This adds the cash but doesn&apos;t reduce a tracked debt. If
              you&apos;re tracking it,{" "}
              <Link
                href="/debts"
                className="font-medium text-accent underline-offset-4 hover:underline"
              >
                record it on the debt instead
              </Link>
              .
            </>
          ) : undefined
        }
      >
        <Input
          id="source_name"
          name="source_name"
          type="text"
          placeholder={sourceNamePlaceholder(source)}
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

      <Checkbox id="is_recurring" name="is_recurring" label="This repeats regularly" />

      {/* Both mounted always, filled conditionally — a live region created at
          the same moment it gains text is usually not announced, and the
          success message is the only confirmation the form gives. */}
      <Alert tone="error">
        {state.status === "error" ? state.message : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success" ? "Income added." : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Add income"}
      </Button>
    </form>
  );
}
