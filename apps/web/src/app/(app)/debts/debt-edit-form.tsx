"use client";

import { useActionState, useState } from "react";
import { updateDebt, type DebtFormState } from "./actions";
import { DEBT_KINDS, debtKind } from "./constants";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";

/**
 * A separate component from DebtForm rather than a `mode` on it.
 *
 * The create form is mostly disbursement machinery — which account the cash
 * moves through, on what date, with a live overdraft warning — and none of that
 * is editable afterwards: the disbursement is a posted ledger row, not a field.
 * What editing DOES have is the re-tag warning, which has no meaning at
 * creation. The two forms share a shape and almost no behaviour, and folding
 * them together would mean a component that is half disabled in either mode.
 */
export interface DebtInput {
  id: string;
  kind: string;
  counterparty: string;
  principal_amount: string;
  interest_rate: string;
  due_date: string | null;
  note: string | null;
  currency_code: string;
  /** True when the debt has a disbursement or payments behind it. */
  has_ledger_legs: boolean;
}

const initial: DebtFormState = { status: "idle" };

export function DebtEditForm({ debt }: { debt: DebtInput }) {
  const [state, action, pending] = useActionState(updateDebt, initial);
  const [kind, setKind] = useState(debt.kind);

  const copy = debtKind(kind);
  const retagging = kind !== debt.kind;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={debt.id} />

      <Field
        label="Which way does this go?"
        htmlFor="kind"
        hint={
          debt.has_ledger_legs
            ? "Changing this re-posts the disbursement and every payment in the opposite direction, so account balances move."
            : "Nothing has moved for this debt, so changing this only changes the label."
        }
      >
        <Select
          id="kind"
          name="kind"
          required
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {DEBT_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>

      {/* The one warning worth interrupting for. A funded debt swings the
          account by TWICE its net effect — it gave you the money and now has to
          take it back, or vice versa — and that surprises people. */}
      {retagging && debt.has_ledger_legs ? (
        <div className="rounded-xl bg-negative-soft px-3 py-2.5 text-[13px] text-negative">
          This debt has money behind it. Saving will reverse its disbursement and
          every payment, which moves your account balances. If the account
          can&apos;t cover it, the change is refused and nothing happens.
        </div>
      ) : null}

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
          defaultValue={debt.counterparty}
          placeholder="Name or organisation"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Principal"
          htmlFor="principal_amount"
          hint="What was originally borrowed or lent. Interest and part-payments go under “What's owed”."
        >
          <Input
            id="principal_amount"
            name="principal_amount"
            type="number"
            step="any"
            min="0.01"
            required
            defaultValue={debt.principal_amount}
            placeholder="0.00"
          />
        </Field>

        <Field label="Currency" htmlFor="currency_id">
          {/* Fixed after creation: the disbursement leg has to match its
              account's currency (BR17), so re-denominating is a new record. */}
          <p className="rounded-xl border border-line bg-raised px-3 py-2.5 text-sm text-muted">
            {debt.currency_code}{" "}
            <span className="text-xs text-faint">(fixed)</span>
          </p>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Due date" htmlFor="due_date" optional>
          <Input
            id="due_date"
            name="due_date"
            type="date"
            defaultValue={debt.due_date ?? ""}
          />
        </Field>

        <Field
          label="Interest rate"
          htmlFor="interest_rate"
          optional
          hint="Reference only — nothing accrues on its own."
        >
          <Input
            id="interest_rate"
            name="interest_rate"
            type="number"
            step="any"
            min="0"
            defaultValue={debt.interest_rate}
            placeholder="0.00"
          />
        </Field>
      </div>

      <Field label="Note" htmlFor="note" optional>
        <Input
          id="note"
          name="note"
          type="text"
          defaultValue={debt.note ?? ""}
          placeholder="What is this for?"
        />
      </Field>

      {/* Mounted always, filled conditionally — a live region created at the
          same moment it gains text is usually not announced. */}
      <Alert tone="error">
        {state.status === "error" ? state.message : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending
          ? "Saving…"
          : retagging
            ? `Save as “${copy.heading}”`
            : "Save changes"}
      </Button>
    </form>
  );
}
