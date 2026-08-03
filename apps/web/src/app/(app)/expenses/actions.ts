"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import type { DeleteState } from "@/lib/delete-state";
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

interface ParsedExpense {
  rawAmount: string;
  amount: number;
  portfolioId: string;
  /** Exactly one of these two is ever sent on — see below. */
  categoryId: string | null;
  newCategory: string | null;
  wantsNewCategory: boolean;
  txnDate: string;
  description: string | null;
  merchant: string | null;
}

/**
 * Create and edit post the same fields, so they parse and validate through the
 * same pair of helpers — the shape portfolios/actions.ts already uses. The one
 * asymmetry is what happens afterwards: creating returns a success state so the
 * inline form can clear itself, editing redirects back to the list.
 */
function parseForm(formData: FormData): ParsedExpense {
  const rawAmount = String(formData.get("amount") ?? "").trim();
  const rawCategory = String(formData.get("category_id") ?? "").trim();

  // The picker sends either an existing category's id or the sentinel plus a
  // typed name. create_expense() / update_expense() find-or-create from the name
  // inside the same transaction as the expense, so exactly one of these two is
  // ever sent on.
  const wantsNewCategory = rawCategory === CUSTOM_CHOICE;

  return {
    rawAmount,
    amount: parseFloat(rawAmount),
    portfolioId: String(formData.get("portfolio_id") ?? "").trim(),
    categoryId: wantsNewCategory ? null : rawCategory,
    newCategory: wantsNewCategory
      ? normalizeCustomLabel(formData.get("new_category"))
      : null,
    wantsNewCategory,
    txnDate: String(formData.get("txn_date") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim() || null,
    merchant: String(formData.get("merchant") ?? "").trim() || null,
  };
}

/** Returns the field that failed and why, or null when the form is good. */
function validate(f: ParsedExpense): { field: string; message: string } | null {
  if (!Number.isFinite(f.amount) || f.amount <= 0)
    return { field: "amount", message: "Amount must be greater than zero." };
  if (!f.portfolioId)
    return { field: "portfolio_id", message: "Select an account." };
  if (f.wantsNewCategory) {
    if (!f.newCategory)
      return { field: "new_category", message: "Name the new category." };
    if (f.newCategory.length > MAX_CUSTOM_LABEL)
      return {
        field: "new_category",
        message: `Category name must be ${MAX_CUSTOM_LABEL} characters or fewer.`,
      };
  } else if (!f.categoryId) {
    return { field: "category_id", message: "Select a category." };
  }
  if (!f.txnDate) return { field: "txn_date", message: "Date is required." };
  return null;
}

/**
 * Free text (merchant, description) is deliberately reduced to a flag: it is the
 * user's own private data and adds nothing to a debugging session. A new
 * category name is a label the user will see in a shared list, not private
 * detail, and knowing which one was created is the point of the log line.
 */
function logFields(f: ParsedExpense) {
  return {
    rawAmount: f.rawAmount,
    portfolioId: f.portfolioId,
    categoryId: f.categoryId,
    newCategory: f.newCategory,
    txnDate: f.txnDate,
    hasDescription: f.description !== null,
    hasMerchant: f.merchant !== null,
  };
}

/** Everything past this point needs a session. */
async function requireUser(action: string) {
  const log = await requestLogger({ action });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn(`${action}.unauthenticated`, {
      hint: "Server Action reached without a session — redirecting to /login",
    });
    redirect("/login");
  }
  return { log: log.child({ userId: user.id }) };
}

export async function createExpense(
  _prev: ExpenseFormState,
  formData: FormData,
): Promise<ExpenseFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("createExpense");

  const f = parseForm(formData);
  log.debug("expense.create.start", logFields(f));

  const invalid = validate(f);
  if (invalid) {
    log.warn("expense.create.invalid", {
      ...invalid,
      ...logFields(f),
      durationMs: elapsed(),
    });
    return { status: "error", message: invalid.message };
  }

  // The ledger microservice (via the api-gateway) owns writes to the ledger now.
  // It validates ownership, derives the account currency, and inserts the
  // transaction + expense atomically through the create_expense RPC.
  let res: Response;
  try {
    res = await ledgerFetch("/ledger/expenses", {
      method: "POST",
      body: JSON.stringify({
        amount: f.amount,
        portfolio_id: f.portfolioId,
        category_id: f.categoryId,
        new_category: f.newCategory,
        txn_date: f.txnDate,
        description: f.description,
        merchant: f.merchant,
      }),
    });
  } catch (err) {
    log.error("expense.create.service_unreachable", {
      ...logFields(f),
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
      ...logFields(f),
      durationMs: elapsed(),
    };
    // 400 = a guard did its job (insufficient funds, archived account, currency
    // mismatch); 401/403/5xx = the mesh itself is unhappy. Different problems,
    // so log them at different levels.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("expense.create.rejected", fields);
    } else {
      log.warn("expense.create.rejected", fields);
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

  log.info("expense.create.ok", {
    expenseId: created?.expense?.expense_id ?? null,
    transactionId: created?.expense?.transaction_id ?? null,
    ...logFields(f),
    categoryId: created?.expense?.category_id ?? f.categoryId,
    createdCategory: f.newCategory,
    durationMs: elapsed(),
  });

  // A new category has to be back in the picker's options on the next render,
  // which is the same revalidation the list already needed. The account balance
  // moved too, so anything showing balances is stale.
  revalidatePath("/expenses");
  revalidatePath("/portfolios");
  revalidatePath("/dashboard");
  // Fall back to a random id only so the reset key still changes if the service
  // ever returns a success body without one.
  return {
    status: "success",
    expenseId: created?.expense?.expense_id ?? crypto.randomUUID(),
  };
}

/**
 * Correct an expense that is already recorded.
 *
 * The ledger row cannot be mutated (trg_txn_immutable), so update_expense()
 * replaces it — void, re-post, repoint, delete, in one DB transaction. That is
 * invisible from here: this sends a patch and the RPC decides whether anything
 * financial actually changed. See db/functions/edit_and_delete_entries.sql.
 *
 * Redirects on success rather than returning a state, the same way
 * updatePortfolio does: this runs on /expenses/[id] and sends you back to the
 * list, which is a real navigation to a different route.
 */
export async function updateExpense(
  _prev: ExpenseFormState,
  formData: FormData,
): Promise<ExpenseFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("updateExpense");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn("expense.update.invalid", { message: "missing expense id" });
    return { status: "error", message: "Missing expense id." };
  }

  const f = parseForm(formData);
  log.debug("expense.update.start", { expenseId: id, ...logFields(f) });

  const invalid = validate(f);
  if (invalid) {
    log.warn("expense.update.invalid", {
      expenseId: id,
      ...invalid,
      ...logFields(f),
      durationMs: elapsed(),
    });
    return { status: "error", message: invalid.message };
  }

  let res: Response;
  try {
    res = await ledgerFetch(`/ledger/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        amount: f.amount,
        portfolio_id: f.portfolioId,
        category_id: f.categoryId,
        new_category: f.newCategory,
        txn_date: f.txnDate,
        // Sent even when null: null CLEARS the note, absent would leave the old
        // one in place, and an emptied field has to mean cleared.
        description: f.description,
        merchant: f.merchant,
      }),
    });
  } catch (err) {
    log.error("expense.update.service_unreachable", {
      expenseId: id,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Expense service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      expenseId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      ...logFields(f),
      durationMs: elapsed(),
    };
    // The refusals worth expecting here: the account can't cover a raised
    // amount, or the row is a debt/investment leg this page does not own.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("expense.update.rejected", fields);
    } else {
      log.warn("expense.update.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to save the expense." };
  }

  const updated = (await res.json().catch(() => null)) as {
    expense?: { transaction_id?: string; ledger_replaced?: boolean };
  } | null;
  const ledgerReplaced = updated?.expense?.ledger_replaced === true;

  log.info("expense.update.ok", {
    expenseId: id,
    transactionId: updated?.expense?.transaction_id ?? null,
    // False means this was a note/category/merchant edit and no balance moved —
    // the difference between the two is the first thing you want when reading
    // these lines back.
    ledgerReplaced,
    ...logFields(f),
    durationMs: elapsed(),
  });

  revalidatePath("/expenses");
  if (ledgerReplaced) {
    revalidatePath("/portfolios");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
  }
  redirect("/expenses");
}

/**
 * Delete an expense: the ledger row goes and the account is credited back.
 *
 * Returns state instead of being fire-and-forget because the refusals are real
 * — an investment purchase or a lending leg is rejected outright — and the row
 * would otherwise just sit there unchanged with no explanation.
 */
export async function deleteExpense(
  _prev: DeleteState,
  formData: FormData,
): Promise<DeleteState> {
  const elapsed = startTimer();
  const { log } = await requireUser("deleteExpense");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn("expense.delete.invalid", { message: "missing expense id" });
    return { status: "error", message: "Missing expense id." };
  }

  let res: Response;
  try {
    res = await ledgerFetch(`/ledger/expenses/${id}`, { method: "DELETE" });
  } catch (err) {
    log.error("expense.delete.service_unreachable", {
      expenseId: id,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Expense service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.warn("expense.delete.rejected", {
      expenseId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      durationMs: elapsed(),
    });
    return { status: "error", message: body?.error ?? "Failed to delete the expense." };
  }

  const removed = (await res.json().catch(() => null)) as {
    deleted?: { transaction_id?: string; portfolio_id?: string; amount?: string };
  } | null;

  // Money leaving the ledger is logged with the same weight as money entering
  // it: the transaction id is gone from the database, so this line is the only
  // remaining pointer into audit_log.
  log.info("expense.delete.ok", {
    expenseId: id,
    transactionId: removed?.deleted?.transaction_id ?? null,
    portfolioId: removed?.deleted?.portfolio_id ?? null,
    amount: removed?.deleted?.amount ?? null,
    durationMs: elapsed(),
  });

  revalidatePath("/expenses");
  revalidatePath("/portfolios");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  redirect("/expenses");
}
