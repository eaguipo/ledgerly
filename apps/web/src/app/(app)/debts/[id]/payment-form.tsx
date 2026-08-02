"use client";

import { useActionState, useState } from "react";
import { recordDebtPayment, type PaymentFormState } from "../actions";
import { debtKind, one, todayIso } from "../constants";
import type { DebtAccount, DebtRow } from "../types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

const initial: PaymentFormState = { status: "idle" };

export function PaymentForm({
  debt,
  accounts,
}: {
  debt: DebtRow;
  accounts: DebtAccount[];
}) {
  const [state, action, pending] = useActionState(recordDebtPayment, initial);

  return (
    <PaymentFields
      key={state.status === "success" ? state.paymentId : "entry"}
      debt={debt}
      accounts={accounts}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function PaymentFields({
  debt,
  accounts,
  action,
  pending,
  state,
}: {
  debt: DebtRow;
  accounts: DebtAccount[];
  action: (formData: FormData) => void;
  pending: boolean;
  state: PaymentFormState;
}) {
  const copy = debtKind(debt.kind);
  const currency = one(debt.currency);
  const outstanding = Number(debt.outstanding_balance);

  const [amount, setAmount] = useState("");
  const [interest, setInterest] = useState("");
  const [accountId, setAccountId] = useState("");

  const account = accounts.find((a) => a.id === accountId);

  const amountNum = parseFloat(amount);
  const interestNum = interest === "" ? 0 : parseFloat(interest);
  const validAmount = Number.isFinite(amountNum) && amountNum > 0;
  const validInterest = Number.isFinite(interestNum) && interestNum >= 0;

  // Only the principal portion pays a debt down, so this — not the amount — is
  // what the overpayment guard compares against.
  const principalNum =
    validAmount && validInterest ? amountNum - interestNum : null;
  const interestTooBig = validAmount && validInterest && interestNum > amountNum;
  const overpaying =
    principalNum !== null && !interestTooBig && principalNum > outstanding;

  // Paying money out can overdraw; collecting money in never can.
  const balance = account ? Number(account.current_balance) : null;
  const wouldOverdraw =
    debt.kind === "payable" &&
    validAmount &&
    balance !== null &&
    amountNum > balance;

  const blocked = interestTooBig || overpaying;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="debt_id" value={debt.id} />

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Amount"
          htmlFor="amount"
          hint={
            currency ? `In ${currency.code}` : undefined
          }
        >
          <Input
            id="amount"
            name="amount"
            type="number"
            step="any"
            min="0.01"
            required
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <Field label="Date" htmlFor="payment_date">
          <Input
            id="payment_date"
            name="payment_date"
            type="date"
            defaultValue={todayIso()}
            // The balance moves the moment this posts, whatever date is on it —
            // so a future date would show money leaving before it has.
            max={todayIso()}
            required
          />
        </Field>
      </div>

      {/* One click to close the debt out. Typing the remainder by hand is where
          overpayments come from, and the DB rejects those outright. */}
      <button
        type="button"
        onClick={() => {
          setAmount(String(outstanding));
          setInterest("");
        }}
        className="text-[13px] font-medium text-accent underline-offset-4 hover:underline"
      >
        Pay the remaining {formatMoney(outstanding, currency)}
      </button>

      <Field
        label="Of which interest"
        htmlFor="interest_portion"
        optional
        hint={
          principalNum !== null && !interestTooBig && interestNum > 0
            ? `${formatMoney(principalNum, currency)} comes off the balance; the rest is interest.`
            : "Interest is cash out that doesn't reduce what you owe."
        }
      >
        <Input
          id="interest_portion"
          name="interest_portion"
          type="number"
          step="any"
          min="0"
          placeholder="0.00"
          value={interest}
          onChange={(e) => setInterest(e.target.value)}
        />
      </Field>

      <Field
        label={copy.accountLabel}
        htmlFor="portfolio_id"
        hint={
          accounts.length === 0
            ? `You have no active ${currency?.code ?? ""} account, so this payment has nowhere to post.`
            : undefined
        }
      >
        <Select
          id="portfolio_id"
          name="portfolio_id"
          required
          disabled={accounts.length === 0}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">Select account…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {formatMoney(a.current_balance, one(a.currency))}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Note" htmlFor="note" optional>
        <Input id="note" name="note" type="text" placeholder="Anything to remember?" />
      </Field>

      <Alert tone="error">
        {state.status === "error"
          ? state.message
          : interestTooBig
            ? "Interest can't be more than the payment."
            : overpaying
              ? `That's more than the ${formatMoney(outstanding, currency)} still outstanding.`
              : wouldOverdraw
                ? `That's more than ${account?.name} holds (${formatMoney(balance, one(account?.currency))}).`
                : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success"
          ? state.statusAfter === "settled"
            ? "Paid in full — this debt is settled."
            : `Payment recorded. ${formatMoney(state.outstandingAfter, currency)} still outstanding.`
          : null}
      </Alert>

      <Button
        type="submit"
        disabled={pending || blocked || accounts.length === 0}
        className="w-full"
      >
        {pending ? "Recording…" : `${copy.paymentVerb} now`}
      </Button>
    </form>
  );
}
