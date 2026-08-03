"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { INCOME_SOURCE_VALUES } from "./constants";

export type IncomeFormState =
  | { status: "idle" }
  // `incomeId` doubles as the form's reset key: a new value per success
  // remounts the fields, which is how the form clears itself.
  | { status: "success"; incomeId: string }
  | { status: "error"; message: string };

export async function createIncome(
  _prev: IncomeFormState,
  formData: FormData,
): Promise<IncomeFormState> {
  const log = await requestLogger({ action: "createIncome" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("income.create.unauthenticated", {
      hint: "Server Action reached without a session — redirecting to /login",
    });
    redirect("/login");
  }

  const rawAmount = String(formData.get("amount") ?? "").trim();
  const portfolioId = String(formData.get("portfolio_id") ?? "").trim();
  const source = String(formData.get("source") ?? "").trim();
  const txnDate = String(formData.get("txn_date") ?? "").trim();
  const sourceName = String(formData.get("source_name") ?? "").trim() || null;
  const description = String(formData.get("description") ?? "").trim() || null;
  const isRecurring = formData.get("is_recurring") === "on";

  const actionLog = log.child({ userId: user.id });
  // Free text (source_name, description) is deliberately reduced to a flag: it
  // is the user's own private data and adds nothing to a debugging session.
  actionLog.debug("income.create.start", {
    rawAmount,
    portfolioId,
    source,
    txnDate,
    isRecurring,
    hasSourceName: sourceName !== null,
    hasDescription: description !== null,
  });

  const amount = parseFloat(rawAmount);
  const reject = (field: string, message: string): IncomeFormState => {
    actionLog.warn("income.create.invalid", {
      field,
      message,
      rawAmount,
      portfolioId,
      source,
      txnDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return reject("amount", "Amount must be greater than zero.");
  if (!portfolioId) return reject("portfolio_id", "Select an account.");
  if (!INCOME_SOURCE_VALUES.includes(source))
    return reject("source", "Select where the money came from.");
  if (!txnDate) return reject("txn_date", "Date is required.");

  // The ledger microservice (via the api-gateway) owns writes to the ledger.
  // It validates ownership, derives the account currency, and inserts the
  // transaction + income atomically through the create_income RPC.
  let res: Response;
  try {
    res = await ledgerFetch("/ledger/incomes", {
      method: "POST",
      body: JSON.stringify({
        amount,
        portfolio_id: portfolioId,
        source,
        txn_date: txnDate,
        source_name: sourceName,
        description,
        is_recurring: isRecurring,
      }),
    });
  } catch (err) {
    actionLog.error("income.create.service_unreachable", {
      amount,
      portfolioId,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Income service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      amount,
      portfolioId,
      source,
      txnDate,
      durationMs: elapsed(),
    };
    // 400 = a guard did its job (archived account, currency mismatch);
    // 401/403/5xx = the mesh itself is unhappy. Different problems, different levels.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      actionLog.error("income.create.rejected", fields);
    } else {
      actionLog.warn("income.create.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to record income." };
  }

  // create_income returns { income_id, transaction_id } — both are the handles
  // for looking the row up in Supabase afterwards.
  const created = (await res.json().catch(() => null)) as {
    income?: { income_id?: string; transaction_id?: string };
  } | null;

  actionLog.info("income.create.ok", {
    incomeId: created?.income?.income_id ?? null,
    transactionId: created?.income?.transaction_id ?? null,
    amount,
    portfolioId,
    source,
    txnDate,
    durationMs: elapsed(),
  });

  // The account balance moved, so anything showing balances is now stale.
  revalidatePath("/income");
  revalidatePath("/portfolios");
  revalidatePath("/dashboard");
  // Fall back to a random id only so the reset key still changes if the service
  // ever returns a success body without one.
  return {
    status: "success",
    incomeId: created?.income?.income_id ?? crypto.randomUUID(),
  };
}
