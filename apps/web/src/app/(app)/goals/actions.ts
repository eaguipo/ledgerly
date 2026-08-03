"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";

/**
 * Goal Server Actions. Goals are an earmark over balances you already hold
 * (decision D2) — nothing here moves money, posts a ledger row or changes a
 * portfolio balance. Moving money into savings for real is a Transfer.
 *
 * They still go through ledgerFetch rather than writing the tables directly,
 * because create_goal / create_goal_contribution hold validation the UI must not
 * be the only place enforcing — the linked account's currency, and the
 * over-withdrawal guard that keeps `current_amount` reconcilable with the
 * contribution rows it is derived from.
 */

export type GoalFormState =
  | { status: "idle" }
  // `goalId` doubles as the form's reset key: a new value per success remounts
  // the fields, which is how the form clears itself.
  | { status: "success"; goalId: string }
  | { status: "error"; message: string };

export type ContributionFormState =
  | { status: "idle" }
  | {
      status: "success";
      contributionId: string;
      // Carried back from the RPC so the card can react without the page having
      // to re-fetch the goal first.
      currentAmount: string;
      justAchieved: boolean;
      withdrew: boolean;
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

export async function createGoal(
  _prev: GoalFormState,
  formData: FormData,
): Promise<GoalFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("createGoal");

  const name = String(formData.get("name") ?? "").trim();
  const rawTarget = String(formData.get("target_amount") ?? "").trim();
  const currencyId = String(formData.get("currency_id") ?? "").trim();
  const targetDate = String(formData.get("target_date") ?? "").trim() || null;
  const linkedPortfolioId =
    String(formData.get("linked_portfolio_id") ?? "").trim() || null;

  const target = parseFloat(rawTarget);

  // The goal's name is the user's own wording — length only.
  log.debug("goal.create.start", {
    nameLength: name.length,
    rawTarget,
    currencyId,
    targetDate,
    linked: linkedPortfolioId !== null,
  });

  const reject = (field: string, message: string): GoalFormState => {
    log.warn("goal.create.invalid", {
      field,
      message,
      rawTarget,
      currencyId,
      targetDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!name) return reject("name", "Give the goal a name.");
  if (!Number.isFinite(target) || target <= 0)
    return reject("target_amount", "Target must be greater than zero.");
  if (!currencyId) return reject("currency_id", "Select a currency.");

  const res = await ledgerFetch("/ledger/goals", {
    method: "POST",
    body: JSON.stringify({
      name,
      target_amount: target,
      currency_id: currencyId,
      target_date: targetDate,
      linked_portfolio_id: linkedPortfolioId,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      target,
      currencyId,
      linked: linkedPortfolioId !== null,
      durationMs: elapsed(),
    };
    // 400 = a guard did its job — most often the linked account holding a
    // different currency from the goal.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("goal.create.rejected", fields);
    } else {
      log.warn("goal.create.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to create goal." };
  }

  const created = (await res.json().catch(() => null)) as {
    goal?: { goal_id?: string };
  } | null;

  log.info("goal.create.ok", {
    goalId: created?.goal?.goal_id ?? null,
    target,
    currencyId,
    targetDate,
    linked: linkedPortfolioId !== null,
    durationMs: elapsed(),
  });

  // No balance moved, so only the goals page and the dashboard's goal summary
  // are stale — /portfolios is untouched by design.
  revalidatePath("/goals");
  revalidatePath("/dashboard");

  return { status: "success", goalId: created?.goal?.goal_id ?? crypto.randomUUID() };
}

export async function contributeToGoal(
  _prev: ContributionFormState,
  formData: FormData,
): Promise<ContributionFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("contributeToGoal");

  const goalId = String(formData.get("goal_id") ?? "").trim();
  const rawAmount = String(formData.get("amount") ?? "").trim();
  const contributedOn = String(formData.get("contributed_on") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  // The card has two submit buttons sharing one set of fields; the submitter's
  // name/value is what says which way the money is being earmarked, so the user
  // never has to type a minus sign.
  const direction = String(formData.get("direction") ?? "add");

  const magnitude = parseFloat(rawAmount);

  log.debug("goal.contribute.start", {
    goalId,
    rawAmount,
    direction,
    contributedOn,
    hasNote: note !== null,
  });

  const reject = (field: string, message: string): ContributionFormState => {
    log.warn("goal.contribute.invalid", {
      field,
      message,
      goalId,
      rawAmount,
      direction,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!goalId) return reject("goal_id", "Missing goal.");
  if (direction !== "add" && direction !== "withdraw")
    return reject("direction", "Choose whether to add or take back.");
  if (!Number.isFinite(magnitude) || magnitude <= 0)
    return reject("amount", "Enter an amount greater than zero.");
  if (!contributedOn) return reject("contributed_on", "Date is required.");

  const withdrew = direction === "withdraw";
  const amount = withdrew ? -magnitude : magnitude;

  const res = await ledgerFetch(`/ledger/goals/${goalId}/contributions`, {
    method: "POST",
    body: JSON.stringify({ amount, contributed_on: contributedOn, note }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      goalId,
      amount,
      contributedOn,
      durationMs: elapsed(),
    };
    // 400 covers the two guards that matter: taking back more than is set
    // aside, and contributing to an archived or cancelled goal.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("goal.contribute.rejected", fields);
    } else {
      log.warn("goal.contribute.rejected", fields);
    }
    return {
      status: "error",
      message: body?.error ?? "Failed to update what's set aside.",
    };
  }

  const created = (await res.json().catch(() => null)) as {
    contribution?: {
      contribution_id?: string;
      current_amount?: string;
      status?: string;
      just_achieved?: boolean;
    };
  } | null;

  log.info("goal.contribute.ok", {
    goalId,
    contributionId: created?.contribution?.contribution_id ?? null,
    amount,
    contributedOn,
    currentAfter: created?.contribution?.current_amount ?? null,
    statusAfter: created?.contribution?.status ?? null,
    justAchieved: created?.contribution?.just_achieved ?? false,
    durationMs: elapsed(),
  });

  revalidatePath("/goals");
  revalidatePath("/dashboard");

  return {
    status: "success",
    contributionId: created?.contribution?.contribution_id ?? crypto.randomUUID(),
    currentAmount: String(created?.contribution?.current_amount ?? "0"),
    justAchieved: created?.contribution?.just_achieved === true,
    withdrew,
  };
}

/**
 * Reopen / archive / cancel. All three are the same PATCH with a different body
 * and are fire-and-forget from the UI's point of view (plain `<form action={…}>`,
 * no returned state) — so the log is the only place a failure surfaces.
 *
 * There is no delete. A goal's contribution history is the record of what you
 * set aside and when, and `first_achieved_at` deliberately survives a later
 * withdrawal — deleting the goal would throw both away. Archiving is reversible;
 * deleting is not.
 */
async function patchGoal(
  formData: FormData,
  verb: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const elapsed = startTimer();
  const { log } = await requireUser(`${verb}Goal`);

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn(`goal.${verb}.invalid`, { message: "missing goal id" });
    return;
  }

  const res = await ledgerFetch(`/ledger/goals/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.error(`goal.${verb}.rejected`, {
      goalId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      durationMs: elapsed(),
    });
    return;
  }

  log.info(`goal.${verb}.ok`, { goalId: id, durationMs: elapsed() });
  revalidatePath("/goals");
  revalidatePath("/dashboard");
}

export async function archiveGoal(formData: FormData): Promise<void> {
  await patchGoal(formData, "archive", { status: "archived" });
}

/** Gave up on it, as opposed to finished with it. */
export async function cancelGoal(formData: FormData): Promise<void> {
  await patchGoal(formData, "cancel", { status: "cancelled" });
}

/**
 * Back to active. 'active' is the intent, not necessarily the result:
 * `refresh_goal_status` is a BEFORE trigger on goals, so a goal already at its
 * target is corrected to 'achieved' inside the same statement.
 */
export async function reopenGoal(formData: FormData): Promise<void> {
  await patchGoal(formData, "reopen", { status: "active" });
}
