"use client";

import { useActionState, useState } from "react";
import { createTransfer, type TransferFormState } from "./actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";
import { formatMoney } from "@/lib/format";

interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

export interface TransferPortfolio {
  id: string;
  name: string;
  current_balance: number | string;
  currency: Currency | Currency[] | null;
}

const initial: TransferFormState = { status: "idle" };

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function currencyOf(p: TransferPortfolio | undefined): Currency | undefined {
  if (!p) return undefined;
  return (Array.isArray(p.currency) ? p.currency[0] : p.currency) ?? undefined;
}

export function TransferForm({
  portfolios,
}: {
  portfolios: TransferPortfolio[];
}) {
  const [state, action, pending] = useActionState(createTransfer, initial);

  // Clearing the form is a remount, not five setState calls in an effect: a new
  // transfer id per success changes the key, React throws the old fields away,
  // and every default (including today's date) re-initialises for free.
  return (
    <TransferFields
      key={state.status === "success" ? state.transferId : "entry"}
      portfolios={portfolios}
      action={action}
      pending={pending}
      state={state}
    />
  );
}

function TransferFields({
  portfolios,
  action,
  pending,
  state,
}: {
  portfolios: TransferPortfolio[];
  action: (formData: FormData) => void;
  pending: boolean;
  state: TransferFormState;
}) {
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [rate, setRate] = useState("");

  const from = portfolios.find((p) => p.id === fromId);
  const to = portfolios.find((p) => p.id === toId);
  const fromCur = currencyOf(from);
  const toCur = currencyOf(to);

  // The exchange rate only means anything when the two sides differ; asking for
  // it otherwise invites someone to type 1.05 into a PHP→PHP move and silently
  // conjure money.
  const crossCurrency = !!fromCur && !!toCur && fromCur.code !== toCur.code;

  const amountNum = parseFloat(amount);
  const feeNum = fee === "" ? 0 : parseFloat(fee);
  const rateNum = rate === "" ? 1 : parseFloat(rate);

  const validAmount = Number.isFinite(amountNum) && amountNum > 0;
  const validFee = Number.isFinite(feeNum) && feeNum >= 0;
  const validRate = Number.isFinite(rateNum) && rateNum > 0;

  const received =
    validAmount && validRate
      ? Number(
          (amountNum * (crossCurrency ? rateNum : 1)).toFixed(
            toCur?.minor_unit ?? 2,
          ),
        )
      : null;

  const totalOut = validAmount && validFee ? amountNum + feeNum : null;
  const fromBalance = from ? Number(from.current_balance) : null;
  // A soft warning only — the DB's overdraft guard is the real gate, and it
  // knows about allow_negative accounts, which this does not.
  const wouldOverdraw =
    totalOut !== null && fromBalance !== null && totalOut > fromBalance;

  const sameAccount = Boolean(fromId) && fromId === toId;

  return (
    <form action={action} className="space-y-4">
      <Field label="From" htmlFor="from_portfolio_id">
        <Select
          id="from_portfolio_id"
          name="from_portfolio_id"
          required
          value={fromId}
          onChange={(e) => setFromId(e.target.value)}
        >
          <option value="">Select account…</option>
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {formatMoney(p.current_balance, currencyOf(p))}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="To" htmlFor="to_portfolio_id">
        <Select
          id="to_portfolio_id"
          name="to_portfolio_id"
          required
          value={toId}
          onChange={(e) => setToId(e.target.value)}
        >
          <option value="">Select account…</option>
          {portfolios
            .filter((p) => p.id !== fromId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatMoney(p.current_balance, currencyOf(p))}
              </option>
            ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Amount"
          htmlFor="amount"
          hint={fromCur ? `In ${fromCur.code}` : undefined}
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
        label="Fee"
        htmlFor="fee"
        optional
        hint="Charged to the source account and recorded as an expense."
      >
        <Input
          id="fee"
          name="fee"
          type="number"
          step="any"
          min="0"
          placeholder="0.00"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
        />
      </Field>

      {crossCurrency && fromCur && toCur ? (
        <Field
          label={`Exchange rate (1 ${fromCur.code} → ${toCur.code})`}
          htmlFor="exchange_rate"
          hint={
            received !== null
              ? `They'll receive ${formatMoney(received, toCur)}`
              : "These accounts hold different currencies."
          }
        >
          <Input
            id="exchange_rate"
            name="exchange_rate"
            type="number"
            step="any"
            min="0.000001"
            required
            placeholder="1.00"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </Field>
      ) : null}

      <Field label="Note" htmlFor="note" optional>
        <Input
          id="note"
          name="note"
          type="text"
          placeholder="What is this for?"
        />
      </Field>

      {/* Both mounted always, filled conditionally — a live region created at
          the same moment it gains text is usually not announced. */}
      <Alert tone="error">
        {state.status === "error"
          ? state.message
          : sameAccount
            ? "Pick two different accounts."
            : wouldOverdraw
              ? `That's more than ${from?.name} holds (${formatMoney(fromBalance, fromCur)}${feeNum > 0 ? ", fee included" : ""}).`
              : null}
      </Alert>
      <Alert tone="success">
        {state.status === "success" ? "Transfer recorded." : null}
      </Alert>

      <Button
        type="submit"
        disabled={pending || sameAccount}
        className="w-full"
      >
        {pending ? "Transferring…" : "Transfer"}
      </Button>
    </form>
  );
}
