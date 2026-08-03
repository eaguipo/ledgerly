"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { DEBT_KIND_VALUES } from "./constants";

/**
 * Debt Server Actions. Every write goes through ledgerFetch — the api-gateway →
 * ledger-service hop in the mesh, in-process RLS-scoped handlers on Vercel —
 * which owns the ledger: recording a debt can post a disbursement, and a payment
 * moves cash AND decrements the outstanding balance — both have to be atomic, so
 * both are RPCs behind the service.
 *
 * `createDebt` and `recordDebtPayment` return a success state rather than
 * redirecting; both forms live on the page they would redirect to, so a redirect
 * is a no-op navigation whose only job would be clearing the pending state — the
 * failure mode that left the add-account button stuck on "Saving…" (see
 * portfolios/actions.ts).
 */

export type DebtFormState =
  | { status: "idle" }
  // `debtId` doubles as the form's reset key: a new value per success remounts
  // the fields, which is how the form clears itself.
  | { status: "success"; debtId: string; disbursed: boolean }
  | { status: "error"; message: string };

export type PaymentFormState =
  | { status: "idle" }
  | {
      status: "success";
      paymentId: string;
      // Carried back from the RPC so the form can say "that settles it" without
      // the page having to re-fetch the debt first.
      outstandingAfter: string;
      statusAfter: string;
    }
  | { status: "error"; message: string };

/** Everything after this point needs a session; centralised so each action reads shorter. */
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

export async function createDebt(
  _prev: DebtFormState,
  formData: FormData,
): Promise<DebtFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("createDebt");

  const kind = String(formData.get("kind") ?? "").trim();
  const counterparty = String(formData.get("counterparty") ?? "").trim();
  const rawPrincipal = String(formData.get("principal_amount") ?? "").trim();
  const currencyId = String(formData.get("currency_id") ?? "").trim();
  const rawRate = String(formData.get("interest_rate") ?? "").trim();
  const dueDate = String(formData.get("due_date") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  const disbursementPortfolioId =
    String(formData.get("disbursement_portfolio_id") ?? "").trim() || null;
  const disbursementDate =
    String(formData.get("disbursement_date") ?? "").trim() || null;

  const principal = parseFloat(rawPrincipal);
  const interestRate = rawRate === "" ? null : parseFloat(rawRate);

  // counterparty and note are the user's private data — presence only.
  log.debug("debt.create.start", {
    kind,
    rawPrincipal,
    currencyId,
    dueDate,
    hasNote: note !== null,
    disburses: disbursementPortfolioId !== null,
  });

  const reject = (field: string, message: string): DebtFormState => {
    log.warn("debt.create.invalid", {
      field,
      message,
      kind,
      rawPrincipal,
      currencyId,
      dueDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!DEBT_KIND_VALUES.includes(kind))
    return reject("kind", "Choose whether you owe this or are owed it.");
  if (!counterparty) return reject("counterparty", "Who is this debt with?");
  if (!Number.isFinite(principal) || principal <= 0)
    return reject("principal_amount", "Principal must be greater than zero.");
  if (!currencyId) return reject("currency_id", "Select a currency.");
  if (interestRate !== null && (!Number.isFinite(interestRate) || interestRate < 0))
    return reject("interest_rate", "Interest rate cannot be negative.");

  let res: Response;
  try {
    res = await ledgerFetch("/ledger/debts", {
      method: "POST",
      body: JSON.stringify({
        kind,
        counterparty,
        principal_amount: principal,
        currency_id: currencyId,
        interest_rate: interestRate,
        due_date: dueDate,
        note,
        disbursement_portfolio_id: disbursementPortfolioId,
        // Only meaningful alongside a funding account; the RPC ignores it
        // otherwise. Sent from the browser's clock so "today" is the user's.
        disbursement_date: disbursementPortfolioId ? disbursementDate : null,
      }),
    });
  } catch (err) {
    log.error("debt.create.service_unreachable", {
      kind,
      principal,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Debt service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      kind,
      principal,
      currencyId,
      disburses: disbursementPortfolioId !== null,
      durationMs: elapsed(),
    };
    // 400 = a guard did its job — most often a currency mismatch between the
    // debt and the funding account, or lending more than the account holds.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("debt.create.rejected", fields);
    } else {
      log.warn("debt.create.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to record debt." };
  }

  const created = (await res.json().catch(() => null)) as {
    debt?: { debt_id?: string; transaction_id?: string | null };
  } | null;
  const disbursed = Boolean(created?.debt?.transaction_id);

  log.info("debt.create.ok", {
    debtId: created?.debt?.debt_id ?? null,
    transactionId: created?.debt?.transaction_id ?? null,
    kind,
    principal,
    currencyId,
    disbursed,
    durationMs: elapsed(),
  });

  revalidatePath("/debts");
  // A disbursement moved a balance and posted an income/expense row, so those
  // lists are stale too. A record-only debt touched nothing but /debts.
  if (disbursed) {
    revalidatePath("/portfolios");
    revalidatePath("/dashboard");
    revalidatePath(kind === "payable" ? "/income" : "/expenses");
  }

  return {
    status: "success",
    debtId: created?.debt?.debt_id ?? crypto.randomUUID(),
    disbursed,
  };
}

export async function recordDebtPayment(
  _prev: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("recordDebtPayment");

  const debtId = String(formData.get("debt_id") ?? "").trim();
  const rawAmount = String(formData.get("amount") ?? "").trim();
  const rawInterest = String(formData.get("interest_portion") ?? "").trim();
  const portfolioId = String(formData.get("portfolio_id") ?? "").trim();
  const paymentDate = String(formData.get("payment_date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  const amount = parseFloat(rawAmount);
  // Blank means the whole payment is principal — the common case, and what the
  // form sends when the optional interest field is untouched.
  const interest = rawInterest === "" ? 0 : parseFloat(rawInterest);

  log.debug("debt.payment.start", {
    debtId,
    rawAmount,
    rawInterest,
    portfolioId,
    paymentDate,
    hasNote: note !== null,
  });

  const reject = (field: string, message: string): PaymentFormState => {
    log.warn("debt.payment.invalid", {
      field,
      message,
      debtId,
      rawAmount,
      rawInterest,
      portfolioId,
      paymentDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!debtId) return reject("debt_id", "Missing debt.");
  if (!Number.isFinite(amount) || amount <= 0)
    return reject("amount", "Amount must be greater than zero.");
  if (!Number.isFinite(interest) || interest < 0)
    return reject("interest_portion", "Interest cannot be negative.");
  if (interest > amount)
    return reject("interest_portion", "Interest cannot be more than the payment.");
  if (!portfolioId) return reject("portfolio_id", "Select an account.");
  if (!paymentDate) return reject("payment_date", "Date is required.");

  let res: Response;
  try {
    res = await ledgerFetch(`/ledger/debts/${debtId}/payments`, {
      method: "POST",
      body: JSON.stringify({
        amount,
        interest_portion: interest,
        portfolio_id: portfolioId,
        payment_date: paymentDate,
        note,
      }),
    });
  } catch (err) {
    log.error("debt.payment.service_unreachable", {
      debtId,
      amount,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Debt service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      debtId,
      amount,
      interest,
      portfolioId,
      paymentDate,
      durationMs: elapsed(),
    };
    // 400 covers the guards that matter here: overpayment, an already-settled or
    // archived debt, a currency mismatch, and insufficient funds.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("debt.payment.rejected", fields);
    } else {
      log.warn("debt.payment.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to record payment." };
  }

  const created = (await res.json().catch(() => null)) as {
    payment?: {
      payment_id?: string;
      transaction_id?: string;
      outstanding_after?: string;
      status_after?: string;
    };
  } | null;

  log.info("debt.payment.ok", {
    debtId,
    paymentId: created?.payment?.payment_id ?? null,
    transactionId: created?.payment?.transaction_id ?? null,
    amount,
    interest,
    portfolioId,
    paymentDate,
    outstandingAfter: created?.payment?.outstanding_after ?? null,
    statusAfter: created?.payment?.status_after ?? null,
    durationMs: elapsed(),
  });

  // A payment always moves cash, so balances and the dashboard are stale. The
  // detail page is a dynamic segment, hence the route pattern + type (a literal
  // path would only match if it were spelled exactly as visited).
  revalidatePath("/debts");
  revalidatePath("/debts/[id]", "page");
  revalidatePath("/portfolios");
  revalidatePath("/dashboard");

  return {
    status: "success",
    paymentId: created?.payment?.payment_id ?? crypto.randomUUID(),
    outstandingAfter: String(created?.payment?.outstanding_after ?? "0"),
    statusAfter: String(created?.payment?.status_after ?? ""),
  };
}

/**
 * Archive / restore / write off / reopen. All four are the same PATCH with a
 * different body, and all four are fire-and-forget from the UI's point of view
 * (plain `<form action={…}>`, no returned state) — so the log is the only place
 * a failure surfaces.
 *
 * There is deliberately no delete: `debts` cascades to `debt_payments`, whose
 * `transaction_id` is `on delete restrict` on the transactions side, so removing
 * a debt would drop its payment rows and leave orphaned ledger transactions that
 * really did move money.
 */
async function patchDebt(
  formData: FormData,
  verb: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const elapsed = startTimer();
  const { log } = await requireUser(`${verb}Debt`);

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn(`debt.${verb}.invalid`, { message: "missing debt id" });
    return;
  }

  let res: Response;
  try {
    res = await ledgerFetch(`/ledger/debts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  } catch (err) {
    log.error(`debt.${verb}.service_unreachable`, {
      debtId: id,
      durationMs: elapsed(),
      err,
    });
    return;
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.error(`debt.${verb}.rejected`, {
      debtId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      durationMs: elapsed(),
    });
    return;
  }

  log.info(`debt.${verb}.ok`, { debtId: id, durationMs: elapsed() });
  revalidatePath("/debts");
  revalidatePath("/debts/[id]", "page");
}

export async function archiveDebt(formData: FormData): Promise<void> {
  await patchDebt(formData, "archive", { is_archived: true });
}

export async function restoreDebt(formData: FormData): Promise<void> {
  await patchDebt(formData, "restore", { is_archived: false });
}

/**
 * Giving up on a debt. The status is sticky in the DB: a later recovery reduces
 * the outstanding balance without silently relabelling it as collected.
 */
export async function writeOffDebt(formData: FormData): Promise<void> {
  await patchDebt(formData, "writeOff", { status: "written_off" });
}

/**
 * Undo a write-off. 'open' is the intent, not necessarily the result — the
 * ledger re-derives the real status from the payment history afterwards, so a
 * debt that was half paid before being written off comes back as
 * 'partially_paid' rather than looking untouched.
 */
export async function reopenDebt(formData: FormData): Promise<void> {
  await patchDebt(formData, "reopen", { status: "open" });
}
