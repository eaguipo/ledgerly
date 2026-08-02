"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { dbError, startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { CATEGORY_VALUES } from "./constants";

/**
 * Portfolio (account) Server Actions. All writes go through the anon-key server
 * client, so RLS enforces ownership (user_id = auth.uid()) and the 'portfolios'
 * feature gate. We still re-fetch the user via getUser() (network-verified).
 *
 * `createPortfolio` returns a success state instead of redirecting. It used to
 * end with `redirect("/portfolios")` — a redirect to the route the form is
 * already on — which meant the only thing that could clear the button's
 * "Saving…" state was a navigation completing. Any stall there (a slow dev
 * compile, an interrupted transition) left the button stuck with no recourse
 * but a reload, and the user got no success confirmation either way. Returning
 * state settles `useActionState` directly and matches createExpense /
 * createIncome / createTransfer.
 *
 * `updatePortfolio` still redirects, and should: it runs on /portfolios/[id]
 * and sends you back to the list, which is a real navigation to a different
 * route rather than a no-op refresh.
 */

export type PortfolioFormState =
  | { status: "idle" }
  // `portfolioId` doubles as the form's reset key: a new value per success
  // remounts the fields, which is how the create form clears itself.
  | { status: "success"; portfolioId: string }
  | { status: "error"; message: string };

interface ParsedForm {
  name: string;
  category: string;
  currency_id: string;
  openingBalance: number;
  is_savings: boolean;
  institution: string;
}

function parseForm(formData: FormData): ParsedForm {
  return {
    name: String(formData.get("name") ?? "").trim(),
    category: String(formData.get("category") ?? ""),
    currency_id: String(formData.get("currency_id") ?? ""),
    openingBalance: Number(String(formData.get("opening_balance") ?? "0").trim() || "0"),
    is_savings: formData.get("is_savings") === "on",
    institution: String(formData.get("institution") ?? "").trim(),
  };
}

function validate(f: ParsedForm): string | null {
  if (!f.name) return "Account name is required.";
  if (!CATEGORY_VALUES.includes(f.category)) return "Pick a valid category.";
  if (!f.currency_id) return "Pick a currency.";
  return null;
}

/** The shape of a parsed form that is safe to log (no free-text account name). */
function formFields(f: ParsedForm) {
  return {
    category: f.category,
    currencyId: f.currency_id,
    openingBalance: f.openingBalance,
    isSavings: f.is_savings,
    hasInstitution: Boolean(f.institution),
    nameLength: f.name.length,
  };
}

export async function createPortfolio(
  _prev: PortfolioFormState,
  formData: FormData,
): Promise<PortfolioFormState> {
  const log = await requestLogger({ action: "createPortfolio" });
  const elapsed = startTimer();

  const f = parseForm(formData);
  log.debug("portfolio.create.start", formFields(f));

  const invalid = validate(f);
  if (invalid) {
    log.warn("portfolio.create.invalid", {
      message: invalid,
      ...formFields(f),
      durationMs: elapsed(),
    });
    return { status: "error", message: invalid };
  }
  if (!Number.isFinite(f.openingBalance) || f.openingBalance < 0) {
    log.warn("portfolio.create.invalid", {
      message: "opening balance out of range",
      field: "opening_balance",
      openingBalance: f.openingBalance,
      durationMs: elapsed(),
    });
    return { status: "error", message: "Opening balance must be 0 or more." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("portfolio.create.unauthenticated");
    redirect("/login");
  }

  const actionLog = log.child({ userId: user.id });

  const { data: portfolio, error } = await supabase
    .from("portfolios")
    .insert({
      user_id: user.id,
      name: f.name,
      category: f.category,
      currency_id: f.currency_id,
      opening_balance: f.openingBalance,
      is_savings: f.is_savings,
      institution: f.institution || null,
    })
    .select("id, currency_id")
    .single();

  if (error) {
    // RLS denials arrive as 42501; a duplicate name as 23505. The code is the
    // fastest way to tell "policy rejected this" from "constraint rejected it".
    actionLog.error("portfolio.create.db_failed", {
      ...formFields(f),
      durationMs: elapsed(),
      ...dbError(error),
    });
    return { status: "error", message: error.message };
  }

  actionLog.debug("portfolio.create.row_inserted", {
    portfolioId: portfolio.id,
    durationMs: elapsed(),
  });

  // Opening balance is modeled as an 'opening_balance' ledger row so the cached
  // current_balance stays consistent with the ledger (and reconcile_* agrees).
  if (f.openingBalance > 0) {
    const { error: txnErr } = await supabase.from("transactions").insert({
      user_id: user.id,
      portfolio_id: portfolio.id,
      kind: "opening_balance",
      direction: "inflow",
      amount: f.openingBalance,
      currency_id: portfolio.currency_id,
      description: "Opening balance",
    });
    if (txnErr) {
      // Best-effort rollback: nothing references this portfolio yet, so it deletes.
      const { error: rollbackErr } = await supabase
        .from("portfolios")
        .delete()
        .eq("id", portfolio.id);
      actionLog.error("portfolio.create.opening_balance_failed", {
        portfolioId: portfolio.id,
        openingBalance: f.openingBalance,
        currencyId: portfolio.currency_id,
        // If the rollback ALSO failed, an account exists with no opening ledger
        // row — the balance will read 0. That needs manual cleanup, so say it.
        rolledBack: !rollbackErr,
        durationMs: elapsed(),
        ...dbError(txnErr),
      });
      if (rollbackErr) {
        actionLog.error("portfolio.create.rollback_failed", {
          portfolioId: portfolio.id,
          hint: "orphaned portfolio row — delete it manually in Supabase",
          ...dbError(rollbackErr),
        });
      }
      return { status: "error", message: `Could not set opening balance: ${txnErr.message}` };
    }
    actionLog.info("portfolio.opening_balance.ok", {
      portfolioId: portfolio.id,
      amount: f.openingBalance,
      currencyId: portfolio.currency_id,
    });
  }

  actionLog.info("portfolio.create.ok", {
    portfolioId: portfolio.id,
    ...formFields(f),
    durationMs: elapsed(),
  });

  // revalidatePath alone re-renders the list in place — no navigation needed,
  // since the form lives on /portfolios already. An opening balance also moves
  // net worth, so the dashboard is stale too.
  revalidatePath("/portfolios");
  if (f.openingBalance > 0) revalidatePath("/dashboard");
  return { status: "success", portfolioId: portfolio.id };
}

export async function updatePortfolio(
  _prev: PortfolioFormState,
  formData: FormData,
): Promise<PortfolioFormState> {
  const log = await requestLogger({ action: "updatePortfolio" });
  const elapsed = startTimer();

  const id = String(formData.get("id") ?? "");
  if (!id) {
    log.warn("portfolio.update.invalid", { message: "missing account id" });
    return { status: "error", message: "Missing account id." };
  }
  const f = parseForm(formData);
  log.debug("portfolio.update.start", { portfolioId: id, ...formFields(f) });

  if (!f.name) {
    log.warn("portfolio.update.invalid", {
      portfolioId: id,
      field: "name",
      durationMs: elapsed(),
    });
    return { status: "error", message: "Account name is required." };
  }
  if (!CATEGORY_VALUES.includes(f.category)) {
    log.warn("portfolio.update.invalid", {
      portfolioId: id,
      field: "category",
      category: f.category,
      durationMs: elapsed(),
    });
    return { status: "error", message: "Pick a valid category." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("portfolio.update.unauthenticated", { portfolioId: id });
    redirect("/login");
  }

  const actionLog = log.child({ userId: user.id });

  // Currency and opening balance are fixed after creation (changing currency
  // would break the per-portfolio currency invariant on existing ledger rows).
  const { error, count } = await supabase
    .from("portfolios")
    .update(
      {
        name: f.name,
        category: f.category,
        is_savings: f.is_savings,
        institution: f.institution || null,
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    actionLog.error("portfolio.update.db_failed", {
      portfolioId: id,
      ...formFields(f),
      durationMs: elapsed(),
      ...dbError(error),
    });
    return { status: "error", message: error.message };
  }

  // count === 0 is the silent failure mode: no error, nothing changed, because
  // the id does not exist or belongs to somebody else (RLS filtered it out).
  if (count === 0) {
    actionLog.warn("portfolio.update.no_rows", {
      portfolioId: id,
      hint: "account id not found for this user — nothing was updated",
      durationMs: elapsed(),
    });
  } else {
    actionLog.info("portfolio.update.ok", {
      portfolioId: id,
      ...formFields(f),
      durationMs: elapsed(),
    });
  }

  revalidatePath("/portfolios");
  redirect("/portfolios");
}

/** Soft-delete: archive (ledger history makes hard delete unsafe; reversible). */
export async function archivePortfolio(formData: FormData): Promise<void> {
  await setArchived(formData, true);
}

export async function restorePortfolio(formData: FormData): Promise<void> {
  await setArchived(formData, false);
}

/**
 * Archive/restore share everything but the flag. Both are fire-and-forget from
 * the UI's point of view (plain `<form action={…}>`, no returned state), so the
 * log is the ONLY place a failure shows up — hence the error branch.
 */
async function setArchived(formData: FormData, archived: boolean): Promise<void> {
  const verb = archived ? "archive" : "restore";
  const log = await requestLogger({ action: `${verb}Portfolio` });
  const elapsed = startTimer();

  const id = String(formData.get("id") ?? "");
  if (!id) {
    log.warn(`portfolio.${verb}.invalid`, { message: "missing account id" });
    return;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn(`portfolio.${verb}.unauthenticated`, { portfolioId: id });
    redirect("/login");
  }

  const actionLog = log.child({ userId: user.id });
  const { error, count } = await supabase
    .from("portfolios")
    .update(
      {
        is_archived: archived,
        archived_at: archived ? new Date().toISOString() : null,
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    actionLog.error(`portfolio.${verb}.db_failed`, {
      portfolioId: id,
      durationMs: elapsed(),
      ...dbError(error),
    });
  } else if (count === 0) {
    actionLog.warn(`portfolio.${verb}.no_rows`, {
      portfolioId: id,
      hint: "account id not found for this user — nothing changed",
      durationMs: elapsed(),
    });
  } else {
    actionLog.info(`portfolio.${verb}.ok`, {
      portfolioId: id,
      durationMs: elapsed(),
    });
  }

  revalidatePath("/portfolios");
}
