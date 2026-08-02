"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { gatewayFetch } from "@/lib/gateway";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";

export type ExpenseFormState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "error"; message: string };

export async function createExpense(
  _prev: ExpenseFormState,
  formData: FormData,
): Promise<ExpenseFormState> {
  const log = await requestLogger({ action: "createExpense" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("expense.create.unauthenticated", {
      hint: "Server Action reached without a session — redirecting to /login",
    });
    redirect("/login");
  }

  const rawAmount = String(formData.get("amount") ?? "").trim();
  const portfolioId = String(formData.get("portfolio_id") ?? "").trim();
  const categoryId = String(formData.get("category_id") ?? "").trim();
  const txnDate = String(formData.get("txn_date") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const merchant = String(formData.get("merchant") ?? "").trim() || null;

  const actionLog = log.child({ userId: user.id });
  // Free text (merchant, description) is deliberately reduced to a flag: it is
  // the user's own private data and adds nothing to a debugging session.
  actionLog.debug("expense.create.start", {
    rawAmount,
    portfolioId,
    categoryId,
    txnDate,
    hasDescription: description !== null,
    hasMerchant: merchant !== null,
  });

  const amount = parseFloat(rawAmount);
  const reject = (field: string, message: string): ExpenseFormState => {
    actionLog.warn("expense.create.invalid", {
      field,
      message,
      rawAmount,
      portfolioId,
      categoryId,
      txnDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return reject("amount", "Amount must be greater than zero.");
  if (!portfolioId) return reject("portfolio_id", "Select an account.");
  if (!categoryId) return reject("category_id", "Select a category.");
  if (!txnDate) return reject("txn_date", "Date is required.");

  // The ledger microservice (via the api-gateway) owns writes to the ledger now.
  // It validates ownership, derives the account currency, and inserts the
  // transaction + expense atomically through the create_expense RPC.
  let res: Response;
  try {
    res = await gatewayFetch("/ledger/expenses", {
      method: "POST",
      body: JSON.stringify({
        amount,
        portfolio_id: portfolioId,
        category_id: categoryId,
        txn_date: txnDate,
        description,
        merchant,
      }),
    });
  } catch (err) {
    actionLog.error("expense.create.service_unreachable", {
      amount,
      portfolioId,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Expense service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      amount,
      portfolioId,
      categoryId,
      txnDate,
      durationMs: elapsed(),
    };
    // 400 = a guard did its job (insufficient funds, archived account, currency
    // mismatch); 401/403/5xx = the mesh itself is unhappy. Different problems,
    // so log them at different levels.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      actionLog.error("expense.create.rejected", fields);
    } else {
      actionLog.warn("expense.create.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to record expense." };
  }

  // create_expense returns { expense_id, transaction_id } — log both, they are
  // the handles for looking the row up in Supabase afterwards.
  const created = (await res.json().catch(() => null)) as {
    expense?: { expense_id?: string; transaction_id?: string };
  } | null;

  actionLog.info("expense.create.ok", {
    expenseId: created?.expense?.expense_id ?? null,
    transactionId: created?.expense?.transaction_id ?? null,
    amount,
    portfolioId,
    categoryId,
    txnDate,
    durationMs: elapsed(),
  });

  revalidatePath("/expenses");
  return { status: "success" };
}
