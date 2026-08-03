"use client";

import { useActionState, useState } from "react";
import type { IncomeFormState } from "./actions";
import Link from "next/link";
import {
  CUSTOM_INCOME_SOURCE,
  PICKABLE_INCOME_SOURCES,
  sourceNamePlaceholder,
} from "./constants";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { ChoiceWithCustom } from "@/components/ui/choice-with-custom";
import { CUSTOM_CHOICE } from "@/lib/custom-choice";
import { Alert } from "@/components/ui/feedback";

interface Portfolio {
  id: string;
  name: string;
}

/** The subset of an income entry the edit form fills itself in from. */
export interface IncomeInput {
  id: string;
  amount: string;
  txn_date: string;
  portfolio_id: string;
  source: string;
  source_label: string | null;
  source_name: string | null;
  description: string | null;
  is_recurring: boolean;
}

type Action = (
  state: IncomeFormState,
  formData: FormData,
) => Promise<IncomeFormState>;

const initial: IncomeFormState = { status: "idle" };

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface FormProps {
  action: Action;
  portfolios: Portfolio[];
  sourceLabels: string[];
  mode: "create" | "edit";
  income?: IncomeInput;
  submitLabel: string;
}

export function IncomeForm(props: FormProps) {
  const [state, action, pending] = useActionState(props.action, initial);

  // Clearing the form is a remount, not a pile of setState calls in an effect:
  // a new income id per success changes the key, React throws the old fields
  // away, and every default (including today's date) re-initialises for free.
  //
  // In edit mode the key never changes: updateIncome redirects to the list
  // rather than returning a success state, so there is nothing to clear.
  return (
    <IncomeFields
      key={state.status === "success" ? state.incomeId : "entry"}
      {...props}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function IncomeFields({
  portfolios,
  sourceLabels,
  mode,
  income,
  submitLabel,
  action,
  pending,
  state,
}: Omit<FormProps, "action"> & {
  action: (formData: FormData) => void;
  pending: boolean;
  state: IncomeFormState;
}) {
  const editing = mode === "edit" && income !== undefined;

  // 'other' is not in the picker — naming your own source IS that member — so a
  // row already stored against it reopens on the custom entry with its name
  // filled in, rather than on a blank select that would erase it on save.
  const isCustomSource = income?.source === CUSTOM_INCOME_SOURCE;

  // Only drives the placeholder and hint of the "from" field — the value itself
  // is read from FormData, so this never has to round-trip to the server.
  const [source, setSource] = useState(
    isCustomSource ? CUSTOM_CHOICE : (income?.source ?? ""),
  );

  return (
    <form action={action} className="space-y-4">
      {editing ? <input type="hidden" name="id" value={income.id} /> : null}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount" htmlFor="amount">
          <Input
            id="amount"
            name="amount"
            type="number"
            step="any"
            min="0.01"
            required
            defaultValue={income?.amount}
            placeholder="0.00"
          />
        </Field>

        <Field label="Date" htmlFor="txn_date">
          <Input
            id="txn_date"
            name="txn_date"
            type="date"
            defaultValue={income?.txn_date ?? todayIso()}
            required
          />
        </Field>
      </div>

      <Field
        label="Into account"
        htmlFor="portfolio_id"
        hint={
          editing
            ? "Changing this moves the money to the other account's balance."
            : "The amount is recorded in this account's own currency."
        }
      >
        <Select
          id="portfolio_id"
          name="portfolio_id"
          required
          defaultValue={income?.portfolio_id ?? ""}
        >
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
        defaultValue={isCustomSource ? CUSTOM_CHOICE : (income?.source ?? "")}
        options={PICKABLE_INCOME_SOURCES.map((s) => ({
          value: s.value,
          label: s.label,
        }))}
        addLabel="+ Name my own source…"
        custom={{
          name: "source_label",
          label: "Source name",
          placeholder: "e.g. Royalties",
          defaultValue: income?.source_label ?? undefined,
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
          defaultValue={income?.source_name ?? ""}
          placeholder={sourceNamePlaceholder(source)}
        />
      </Field>

      <Field label="Note" htmlFor="description" optional>
        <Input
          id="description"
          name="description"
          type="text"
          defaultValue={income?.description ?? ""}
          placeholder="Add a note…"
        />
      </Field>

      <Checkbox
        id="is_recurring"
        name="is_recurring"
        defaultChecked={income?.is_recurring ?? false}
        label="This repeats regularly"
      />

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
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
