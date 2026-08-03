"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import {
  CUSTOM_CHOICE,
  MAX_CUSTOM_LABEL,
  normalizeCustomLabel,
} from "@/lib/custom-choice";

export type ExpenseFormState =
  | { status: "idle" }
  // `expenseId` doubles as the form's reset key: a new value per success
  // remounts the fields, which is how the form clears itself.
  | { status: "success"; expenseId: string }
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
  const rawCategory = String(formData.get("category_id") ?? "").trim();
  const txnDate = String(formData.get("txn_date") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const merchant = String(formData.get("merchant") ?? "").trim() || null;

  // The picker sends either an existing category's id or the sentinel plus a
  // typed name. create_expense() find-or-creates from the name inside the same
  // transaction as the expense, so exactly one of these two is ever sent on.
  const wantsNewCategory = rawCategory === CUSTOM_CHOICE;
  const categoryId = wantsNewCategory ? null : rawCategory;
  const newCategory = wantsNewCategory
    ? normalizeCustomLabel(formData.get("new_category"))
    : null;

  const actionLog = log.child({ userId: user.id });
  // Free text (merchant, description) is deliberately reduced to a flag: it is
  // the user's own private data and adds nothing to a debugging session. A new
  // category name is a label the user will see in a shared list, not private
  // detail, and knowing which one was created is the point of the log line.
  actionLog.debug("expense.create.start", {
    rawAmount,
    portfolioId,
    categoryId,
    newCategory,
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
      newCategory,
      txnDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return reject("amount", "Amount must be greater than zero.");
  if (!portfolioId) return reject("portfolio_id", "Select an account.");
  if (wantsNewCategory) {
    if (!newCategory)
      return reject("new_category", "Name the new category.");
    if (newCategory.length > MAX_CUSTOM_LABEL)
      return reject(
        "new_category",
        `Category name must be ${MAX_CUSTOM_LABEL} characters or fewer.`,
      );
  } else if (!categoryId) {
    return reject("category_id", "Select a category.");
  }
  if (!txnDate) return reject("txn_date", "Date is required.");

  // The ledger microservice (via the api-gateway) owns writes to the ledger now.
  // It validates ownership, derives the account currency, and inserts the
  // transaction + expense atomically through the create_expense RPC.
  let res: Response;
  try {
    res = await ledgerFetch("/ledger/expenses", {
      method: "POST",
      body: JSON.stringify({
        amount,
        portfolio_id: portfolioId,
        category_id: categoryId,
        new_category: newCategory,
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
      newCategory,
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

  // create_expense returns { expense_id, transaction_id, category_id } — log
  // all three, they are the handles for looking the rows up in Supabase
  // afterwards. category_id is the only way to find a category the RPC created.
  const created = (await res.json().catch(() => null)) as {
    expense?: {
      expense_id?: string;
      transaction_id?: string;
      category_id?: string;
    };
  } | null;

  actionLog.info("expense.create.ok", {
    expenseId: created?.expense?.expense_id ?? null,
    transactionId: created?.expense?.transaction_id ?? null,
    amount,
    portfolioId,
    categoryId: created?.expense?.category_id ?? categoryId,
    createdCategory: newCategory,
    txnDate,
    durationMs: elapsed(),
  });

  // A new category has to be back in the picker's options on the next render,
  // which is the same revalidation the list already needed.
  revalidatePath("/expenses");
  // Fall back to a random id only so the reset key still changes if the service
  // ever returns a success body without one.
  return {
    status: "success",
    expenseId: created?.expense?.expense_id ?? crypto.randomUUID(),
  };
}
