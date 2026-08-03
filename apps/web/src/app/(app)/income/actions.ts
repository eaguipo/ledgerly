"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import type { DeleteState } from "@/lib/delete-state";
import { CUSTOM_INCOME_SOURCE, INCOME_SOURCE_VALUES } from "./constants";
import {
  CUSTOM_CHOICE,
  MAX_CUSTOM_LABEL,
  normalizeCustomLabel,
} from "@/lib/custom-choice";

export type IncomeFormState =
  | { status: "idle" }
  // `incomeId` doubles as the form's reset key: a new value per success
  // remounts the fields, which is how the form clears itself.
  | { status: "success"; incomeId: string }
  | { status: "error"; message: string };

interface ParsedIncome {
  rawAmount: string;
  amount: number;
  portfolioId: string;
  source: string;
  /** Non-null only when the user named their own source. */
  sourceLabel: string | null;
  wantsCustomSource: boolean;
  txnDate: string;
  sourceName: string | null;
  description: string | null;
  isRecurring: boolean;
}

/**
 * Create and edit post the same fields, so they share one parse and one
 * validation — the shape portfolios/actions.ts already uses. Creating returns a
 * success state so the inline form can clear itself; editing redirects back to
 * the list, because it runs on a different route.
 */
function parseForm(formData: FormData): ParsedIncome {
  const rawAmount = String(formData.get("amount") ?? "").trim();
  const rawSource = String(formData.get("source") ?? "").trim();

  // A named source is stored as the enum's catch-all member plus the name the
  // user gave it; `income_source` can't grow members without a migration.
  const wantsCustomSource = rawSource === CUSTOM_CHOICE;

  return {
    rawAmount,
    amount: parseFloat(rawAmount),
    portfolioId: String(formData.get("portfolio_id") ?? "").trim(),
    source: wantsCustomSource ? CUSTOM_INCOME_SOURCE : rawSource,
    // Always null when the picker is back on a listed source — an edit that
    // moves a row off its custom name has to clear the name with it, or
    // incomes_source_label_only_other rejects the update.
    sourceLabel: wantsCustomSource
      ? normalizeCustomLabel(formData.get("source_label"))
      : null,
    wantsCustomSource,
    txnDate: String(formData.get("txn_date") ?? "").trim(),
    sourceName: String(formData.get("source_name") ?? "").trim() || null,
    description: String(formData.get("description") ?? "").trim() || null,
    isRecurring: formData.get("is_recurring") === "on",
  };
}

function validate(f: ParsedIncome): { field: string; message: string } | null {
  if (!Number.isFinite(f.amount) || f.amount <= 0)
    return { field: "amount", message: "Amount must be greater than zero." };
  if (!f.portfolioId)
    return { field: "portfolio_id", message: "Select an account." };
  if (!INCOME_SOURCE_VALUES.includes(f.source))
    return { field: "source", message: "Select where the money came from." };
  if (f.wantsCustomSource) {
    if (!f.sourceLabel)
      return { field: "source_label", message: "Name the source." };
    if (f.sourceLabel.length > MAX_CUSTOM_LABEL)
      return {
        field: "source_label",
        message: `Source name must be ${MAX_CUSTOM_LABEL} characters or fewer.`,
      };
  }
  if (!f.txnDate) return { field: "txn_date", message: "Date is required." };
  return null;
}

/**
 * Free text (source_name, description) is deliberately reduced to a flag: it is
 * the user's own private data and adds nothing to a debugging session.
 * sourceLabel is not that — it names a kind of income, not a counterparty, and
 * it is the only thing distinguishing one 'other' row from another.
 */
function logFields(f: ParsedIncome) {
  return {
    rawAmount: f.rawAmount,
    portfolioId: f.portfolioId,
    source: f.source,
    sourceLabel: f.sourceLabel,
    txnDate: f.txnDate,
    isRecurring: f.isRecurring,
    hasSourceName: f.sourceName !== null,
    hasDescription: f.description !== null,
  };
}

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

export async function createIncome(
  _prev: IncomeFormState,
  formData: FormData,
): Promise<IncomeFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("createIncome");

  const f = parseForm(formData);
  log.debug("income.create.start", logFields(f));

  const invalid = validate(f);
  if (invalid) {
    log.warn("income.create.invalid", {
      ...invalid,
      ...logFields(f),
      durationMs: elapsed(),
    });
    return { status: "error", message: invalid.message };
  }

  // The ledger microservice (via the api-gateway) owns writes to the ledger.
  // It validates ownership, derives the account currency, and inserts the
  // transaction + income atomically through the create_income RPC.
  let res: Response;
  try {
    res = await ledgerFetch("/ledger/incomes", {
      method: "POST",
      body: JSON.stringify({
        amount: f.amount,
        portfolio_id: f.portfolioId,
        source: f.source,
        source_label: f.sourceLabel,
        txn_date: f.txnDate,
        source_name: f.sourceName,
        description: f.description,
        is_recurring: f.isRecurring,
      }),
    });
  } catch (err) {
    log.error("income.create.service_unreachable", {
      ...logFields(f),
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
      ...logFields(f),
      durationMs: elapsed(),
    };
    // 400 = a guard did its job (archived account, currency mismatch);
    // 401/403/5xx = the mesh itself is unhappy. Different problems, different levels.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("income.create.rejected", fields);
    } else {
      log.warn("income.create.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to record income." };
  }

  // create_income returns { income_id, transaction_id } — both are the handles
  // for looking the row up in Supabase afterwards.
  const created = (await res.json().catch(() => null)) as {
    income?: { income_id?: string; transaction_id?: string };
  } | null;

  log.info("income.create.ok", {
    incomeId: created?.income?.income_id ?? null,
    transactionId: created?.income?.transaction_id ?? null,
    ...logFields(f),
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

/**
 * Correct an income entry that is already recorded.
 *
 * The ledger row cannot be mutated (trg_txn_immutable), so update_income()
 * replaces it — void, re-post, repoint, delete, in one DB transaction. See
 * db/functions/edit_and_delete_entries.sql.
 *
 * One asymmetry with editing an expense: reducing or moving an INFLOW lowers a
 * balance, so this can be refused for insufficient funds where an expense edit
 * never would. The RPC's message names the account and the shortfall.
 */
export async function updateIncome(
  _prev: IncomeFormState,
  formData: FormData,
): Promise<IncomeFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("updateIncome");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn("income.update.invalid", { message: "missing income id" });
    return { status: "error", message: "Missing income id." };
  }

  const f = parseForm(formData);
  log.debug("income.update.start", { incomeId: id, ...logFields(f) });

  const invalid = validate(f);
  if (invalid) {
    log.warn("income.update.invalid", {
      incomeId: id,
      ...invalid,
      ...logFields(f),
      durationMs: elapsed(),
    });
    return { status: "error", message: invalid.message };
  }

  let res: Response;
  try {
    res = await ledgerFetch(`/ledger/incomes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        amount: f.amount,
        portfolio_id: f.portfolioId,
        source: f.source,
        // Sent even when null: null CLEARS the custom name, which is exactly
        // what moving the picker back to a listed source has to do.
        source_label: f.sourceLabel,
        txn_date: f.txnDate,
        source_name: f.sourceName,
        description: f.description,
        is_recurring: f.isRecurring,
      }),
    });
  } catch (err) {
    log.error("income.update.service_unreachable", {
      incomeId: id,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Income service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      incomeId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      ...logFields(f),
      durationMs: elapsed(),
    };
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("income.update.rejected", fields);
    } else {
      log.warn("income.update.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to save the income entry." };
  }

  const updated = (await res.json().catch(() => null)) as {
    income?: { transaction_id?: string; ledger_replaced?: boolean };
  } | null;
  const ledgerReplaced = updated?.income?.ledger_replaced === true;

  log.info("income.update.ok", {
    incomeId: id,
    transactionId: updated?.income?.transaction_id ?? null,
    // False means only the source, name or note changed and no balance moved.
    ledgerReplaced,
    ...logFields(f),
    durationMs: elapsed(),
  });

  revalidatePath("/income");
  if (ledgerReplaced) {
    revalidatePath("/portfolios");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
  }
  redirect("/income");
}

/**
 * Delete an income entry, taking the money back out of the account.
 *
 * Returns state rather than being fire-and-forget because refusal is a normal
 * outcome here: `delete_income()` will not overdraw an account whose money has
 * already been spent, and that message is the whole answer to "why didn't it
 * delete?".
 */
export async function deleteIncome(
  _prev: DeleteState,
  formData: FormData,
): Promise<DeleteState> {
  const elapsed = startTimer();
  const { log } = await requireUser("deleteIncome");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn("income.delete.invalid", { message: "missing income id" });
    return { status: "error", message: "Missing income id." };
  }

  let res: Response;
  try {
    res = await ledgerFetch(`/ledger/incomes/${id}`, { method: "DELETE" });
  } catch (err) {
    log.error("income.delete.service_unreachable", {
      incomeId: id,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Income service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.warn("income.delete.rejected", {
      incomeId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      durationMs: elapsed(),
    });
    return { status: "error", message: body?.error ?? "Failed to delete the income entry." };
  }

  const removed = (await res.json().catch(() => null)) as {
    deleted?: { transaction_id?: string; portfolio_id?: string; amount?: string };
  } | null;

  // The transaction id is gone from the database after this, so this line is
  // the only remaining pointer into audit_log.
  log.info("income.delete.ok", {
    incomeId: id,
    transactionId: removed?.deleted?.transaction_id ?? null,
    portfolioId: removed?.deleted?.portfolio_id ?? null,
    amount: removed?.deleted?.amount ?? null,
    durationMs: elapsed(),
  });

  revalidatePath("/income");
  revalidatePath("/portfolios");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  redirect("/income");
}
