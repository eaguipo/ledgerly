"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";

export type TransferFormState =
  | { status: "idle" }
  // `transferId` doubles as the form's reset key: a new value per success
  // remounts the fields, which is how the form clears itself.
  | { status: "success"; transferId: string }
  | { status: "error"; message: string };

export async function createTransfer(
  _prev: TransferFormState,
  formData: FormData,
): Promise<TransferFormState> {
  const log = await requestLogger({ action: "createTransfer" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("transfer.create.unauthenticated", {
      hint: "Server Action reached without a session — redirecting to /login",
    });
    redirect("/login");
  }

  const rawAmount = String(formData.get("amount") ?? "").trim();
  const rawFee = String(formData.get("fee") ?? "").trim();
  const rawRate = String(formData.get("exchange_rate") ?? "").trim();
  const fromPortfolioId = String(formData.get("from_portfolio_id") ?? "").trim();
  const toPortfolioId = String(formData.get("to_portfolio_id") ?? "").trim();
  const txnDate = String(formData.get("txn_date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  const actionLog = log.child({ userId: user.id });
  actionLog.debug("transfer.create.start", {
    rawAmount,
    rawFee,
    rawRate,
    fromPortfolioId,
    toPortfolioId,
    txnDate,
    hasNote: note !== null,
  });

  const amount = parseFloat(rawAmount);
  // Both are optional in the form: blank fee means none, blank rate means the
  // accounts share a currency and the field was never shown.
  const fee = rawFee === "" ? 0 : parseFloat(rawFee);
  const exchangeRate = rawRate === "" ? 1 : parseFloat(rawRate);

  const reject = (field: string, message: string): TransferFormState => {
    actionLog.warn("transfer.create.invalid", {
      field,
      message,
      rawAmount,
      rawFee,
      rawRate,
      fromPortfolioId,
      toPortfolioId,
      txnDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return reject("amount", "Amount must be greater than zero.");
  if (!Number.isFinite(fee) || fee < 0)
    return reject("fee", "Fee cannot be negative.");
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0)
    return reject("exchange_rate", "Exchange rate must be greater than zero.");
  if (!fromPortfolioId)
    return reject("from_portfolio_id", "Select the account to move money from.");
  if (!toPortfolioId)
    return reject("to_portfolio_id", "Select the account to move money to.");
  if (fromPortfolioId === toPortfolioId)
    return reject("to_portfolio_id", "Pick two different accounts.");
  if (!txnDate) return reject("txn_date", "Date is required.");

  // The ledger microservice (via the api-gateway) owns writes to the ledger. It
  // posts both legs plus any fee atomically through the create_transfer RPC, so
  // a debit can never land without its matching credit.
  let res: Response;
  try {
    res = await ledgerFetch("/ledger/transfers", {
      method: "POST",
      body: JSON.stringify({
        amount,
        fee,
        exchange_rate: exchangeRate,
        from_portfolio_id: fromPortfolioId,
        to_portfolio_id: toPortfolioId,
        txn_date: txnDate,
        note,
      }),
    });
  } catch (err) {
    actionLog.error("transfer.create.service_unreachable", {
      amount,
      fromPortfolioId,
      toPortfolioId,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Transfer service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      amount,
      fee,
      exchangeRate,
      fromPortfolioId,
      toPortfolioId,
      txnDate,
      durationMs: elapsed(),
    };
    // 400 = a guard did its job — most often insufficient funds, which is the
    // single most likely way a transfer legitimately fails.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      actionLog.error("transfer.create.rejected", fields);
    } else {
      actionLog.warn("transfer.create.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to record transfer." };
  }

  const created = (await res.json().catch(() => null)) as {
    transfer?: {
      transfer_id?: string;
      out_transaction_id?: string;
      in_transaction_id?: string;
      fee_transaction_id?: string | null;
      amount_received?: string;
    };
  } | null;

  actionLog.info("transfer.create.ok", {
    transferId: created?.transfer?.transfer_id ?? null,
    outTransactionId: created?.transfer?.out_transaction_id ?? null,
    inTransactionId: created?.transfer?.in_transaction_id ?? null,
    feeTransactionId: created?.transfer?.fee_transaction_id ?? null,
    amount,
    amountReceived: created?.transfer?.amount_received ?? null,
    fee,
    exchangeRate,
    fromPortfolioId,
    toPortfolioId,
    txnDate,
    durationMs: elapsed(),
  });

  // Two balances moved, so anything showing balances is now stale.
  revalidatePath("/transfers");
  revalidatePath("/portfolios");
  revalidatePath("/dashboard");
  // A fee posts a real expense row, so the expenses list changed too.
  if (fee > 0) revalidatePath("/expenses");
  // Fall back to a random id only so the reset key still changes if the service
  // ever returns a success body without one.
  return {
    status: "success",
    transferId: created?.transfer?.transfer_id ?? crypto.randomUUID(),
  };
}
