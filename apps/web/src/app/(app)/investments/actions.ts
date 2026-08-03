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
import {
  CUSTOM_INVESTMENT_KIND,
  INVESTMENT_KIND_VALUES,
  todayIso,
} from "./constants";

/**
 * Investment Server Actions.
 *
 * Creating a holding CAN move money, as of db/functions/money_invested.sql: a
 * paying account posts a real outflow against a self-healing 'Money Invested'
 * category, and both report views exclude it so buying an asset never reads as
 * spending. Leaving the account blank keeps the Phase 4 behaviour — record-only,
 * for something you already owned. Valuations still move nothing: a snapshot is
 * an observation, and gains stay unrealised until you sell.
 *
 * They go through ledgerFetch rather than writing the tables directly because
 * create_investment / record_investment_snapshot hold validation the UI must not
 * be the only place enforcing: the paying account's currency and overdraft
 * guard, and the future-date and wrong-currency guards that stop one bad
 * valuation pinning current_value permanently.
 */

export type InvestmentFormState =
  | { status: "idle" }
  // `investmentId` doubles as the form's reset key: a new value per success
  // remounts the fields, which is how the form clears itself.
  | { status: "success"; investmentId: string }
  | { status: "error"; message: string };

export type SnapshotFormState =
  | { status: "idle" }
  | {
      status: "success";
      snapshotId: string;
      // Carried back from the RPC so the card can react without re-fetching.
      currentValue: string;
      returnPct: string | null;
      // False when an older date was back-filled behind a newer snapshot: the
      // valuation was saved, but the headline figure deliberately did not move.
      isLatest: boolean;
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

/** "" / absent → null, so an untouched optional number field is not sent as 0. */
function optionalNumber(raw: FormDataEntryValue | null): number | null {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

interface ParsedInvestment {
  name: string;
  kind: string;
  /** Non-null only when the user named their own type. */
  kindLabel: string | null;
  wantsCustomKind: boolean;
  currencyId: string;
  rawInvested: string;
  invested: number;
  symbol: string | null;
  quantity: number | null;
  openedOn: string | null;
  maturityDate: string | null;
  portfolioId: string | null;
}

/**
 * Create and edit post the same fields, so they share one parse and one
 * validation. `currency_id` is the exception: it is fixed after creation (the
 * RPC does not accept it, and changing it would break the funding leg's
 * currency match), so the edit form renders it read-only and this reads back
 * whatever the page put in the hidden field.
 */
function parseForm(formData: FormData): ParsedInvestment {
  const rawKind = String(formData.get("kind") ?? "").trim();
  const rawInvested = String(formData.get("invested_amount") ?? "").trim();

  // A type the list doesn't have is stored as the enum's catch-all member plus
  // the name the user gave it; `investment_kind` can't grow members without a
  // migration, and v_investment_performance groups on it.
  const wantsCustomKind = rawKind === CUSTOM_CHOICE;

  return {
    name: String(formData.get("name") ?? "").trim(),
    kind: wantsCustomKind ? CUSTOM_INVESTMENT_KIND : rawKind,
    // Always null when the picker is back on a listed type — an edit that moves
    // a holding off its custom name has to clear the name with it, or
    // investment_kind_label_only_other rejects the update.
    kindLabel: wantsCustomKind
      ? normalizeCustomLabel(formData.get("kind_label"))
      : null,
    wantsCustomKind,
    currencyId: String(formData.get("currency_id") ?? "").trim(),
    rawInvested,
    invested: parseFloat(rawInvested),
    symbol: String(formData.get("symbol") ?? "").trim() || null,
    quantity: optionalNumber(formData.get("quantity")),
    openedOn: String(formData.get("opened_on") ?? "").trim() || null,
    maturityDate: String(formData.get("maturity_date") ?? "").trim() || null,
    portfolioId: String(formData.get("portfolio_id") ?? "").trim() || null,
  };
}

function validate(
  f: ParsedInvestment,
): { field: string; message: string } | null {
  if (!f.name) return { field: "name", message: "Give the investment a name." };
  if (!INVESTMENT_KIND_VALUES.includes(f.kind))
    return { field: "kind", message: "Choose a type." };
  if (f.wantsCustomKind) {
    if (!f.kindLabel) return { field: "kind_label", message: "Name the type." };
    if (f.kindLabel.length > MAX_CUSTOM_LABEL)
      return {
        field: "kind_label",
        message: `Type name must be ${MAX_CUSTOM_LABEL} characters or fewer.`,
      };
  }
  if (!f.currencyId)
    return { field: "currency_id", message: "Select a currency." };
  // Zero is allowed on purpose — an asset you were given still has a value worth
  // tracking, and its return % reads as "—" rather than 0%.
  if (!Number.isFinite(f.invested) || f.invested < 0)
    return {
      field: "invested_amount",
      message: "Amount invested cannot be negative.",
    };
  return null;
}

/**
 * The holding's name is the user's own wording — length only. kindLabel is not
 * that: it names a kind of asset, not a private detail, and it is the only thing
 * distinguishing one other_asset row from another.
 */
function logFields(f: ParsedInvestment) {
  return {
    nameLength: f.name.length,
    kind: f.kind,
    kindLabel: f.kindLabel,
    currencyId: f.currencyId,
    rawInvested: f.rawInvested,
    linked: f.portfolioId !== null,
  };
}

export async function createInvestment(
  _prev: InvestmentFormState,
  formData: FormData,
): Promise<InvestmentFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("createInvestment");

  const f = parseForm(formData);
  log.debug("investment.create.start", logFields(f));

  const invalid = validate(f);
  if (invalid) {
    log.warn("investment.create.invalid", {
      ...invalid,
      ...logFields(f),
      durationMs: elapsed(),
    });
    return { status: "error", message: invalid.message };
  }

  const { kind, kindLabel, currencyId, invested, portfolioId } = f;

  const res = await ledgerFetch("/ledger/investments", {
    method: "POST",
    body: JSON.stringify({
      name: f.name,
      kind,
      kind_label: kindLabel,
      currency_id: currencyId,
      invested_amount: invested,
      symbol: f.symbol,
      quantity: f.quantity,
      opened_on: f.openedOn,
      maturity_date: f.maturityDate,
      portfolio_id: portfolioId,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      kind,
      currencyId,
      invested,
      linked: portfolioId !== null,
      durationMs: elapsed(),
    };
    // 400 = a guard did its job — most often the funding account holding a
    // different currency from the investment.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("investment.create.rejected", fields);
    } else {
      log.warn("investment.create.rejected", fields);
    }
    return {
      status: "error",
      message: body?.error ?? "Failed to record the investment.",
    };
  }

  const created = (await res.json().catch(() => null)) as {
    investment?: { investment_id?: string };
  } | null;

  log.info("investment.create.ok", {
    investmentId: created?.investment?.investment_id ?? null,
    ...logFields(f),
    durationMs: elapsed(),
  });

  // A paying account means real money left it, so far more is stale than when
  // investments were record-only: the account balance, the expenses list (the
  // purchase posts an expense row under 'Money Invested'), and the dashboard's
  // liquid figure. Revalidating only /investments here was correct before this
  // change and is wrong after it.
  revalidatePath("/investments");
  revalidatePath("/dashboard");
  if (portfolioId) {
    revalidatePath("/portfolios");
    revalidatePath("/expenses");
  }

  return {
    status: "success",
    investmentId: created?.investment?.investment_id ?? crypto.randomUUID(),
  };
}

export async function recordValuation(
  _prev: SnapshotFormState,
  formData: FormData,
): Promise<SnapshotFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("recordValuation");

  const investmentId = String(formData.get("investment_id") ?? "").trim();
  const rawValue = String(formData.get("market_value") ?? "").trim();
  const asOfDate = String(formData.get("as_of_date") ?? "").trim();
  const unitPrice = optionalNumber(formData.get("unit_price"));
  const quantity = optionalNumber(formData.get("quantity"));

  const marketValue = parseFloat(rawValue);

  log.debug("investment.valuation.start", {
    investmentId,
    rawValue,
    asOfDate,
  });

  const reject = (field: string, message: string): SnapshotFormState => {
    log.warn("investment.valuation.invalid", {
      field,
      message,
      investmentId,
      rawValue,
      asOfDate,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!investmentId) return reject("investment_id", "Missing investment.");
  if (!Number.isFinite(marketValue) || marketValue < 0)
    return reject("market_value", "Value cannot be negative.");
  if (!asOfDate) return reject("as_of_date", "Date is required.");
  // Checked here as well as in the RPC because this one is worth catching before
  // the round trip: a future-dated valuation would win the newest-date race
  // forever and no later real one could displace it.
  if (asOfDate > todayIso())
    return reject("as_of_date", "A valuation can't be dated in the future.");

  const res = await ledgerFetch(`/ledger/investments/${investmentId}/snapshots`, {
    method: "POST",
    body: JSON.stringify({
      market_value: marketValue,
      as_of_date: asOfDate,
      unit_price: unitPrice,
      quantity,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      status: res.status,
      reason: body?.error ?? "(no error body)",
      investmentId,
      marketValue,
      asOfDate,
      durationMs: elapsed(),
    };
    // 400 covers the two guards that matter: a future date, and a valuation
    // against a closed holding.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("investment.valuation.rejected", fields);
    } else {
      log.warn("investment.valuation.rejected", fields);
    }
    return { status: "error", message: body?.error ?? "Failed to save the value." };
  }

  const created = (await res.json().catch(() => null)) as {
    snapshot?: {
      snapshot_id?: string;
      current_value?: string;
      return_pct?: string | null;
      is_latest?: boolean;
    };
  } | null;

  log.info("investment.valuation.ok", {
    investmentId,
    snapshotId: created?.snapshot?.snapshot_id ?? null,
    marketValue,
    asOfDate,
    currentAfter: created?.snapshot?.current_value ?? null,
    returnPct: created?.snapshot?.return_pct ?? null,
    isLatest: created?.snapshot?.is_latest ?? true,
    durationMs: elapsed(),
  });

  revalidatePath("/investments");
  revalidatePath(`/investments/${investmentId}`);
  revalidatePath("/dashboard");

  return {
    status: "success",
    snapshotId: created?.snapshot?.snapshot_id ?? crypto.randomUUID(),
    currentValue: String(created?.snapshot?.current_value ?? "0"),
    returnPct:
      created?.snapshot?.return_pct === null ||
      created?.snapshot?.return_pct === undefined
        ? null
        : String(created.snapshot.return_pct),
    isLatest: created?.snapshot?.is_latest !== false,
  };
}

/**
 * Correct a holding: its name, type, cost basis, dates, or which account paid
 * for it.
 *
 * `currency_id` is deliberately absent from the patch — the funding leg's
 * transaction has to match the account's currency (BR17), so re-denominating a
 * holding is a new record rather than an edit.
 *
 * Everything else, including the cost basis, goes through update_investment(),
 * which rebuilds the purchase leg money_invested.sql posted whenever the amount,
 * the paying account or the opened-on date changes. That is the whole reason the
 * RPC exists: the old direct table write left the paying account's balance
 * disagreeing with the corrected figure.
 */
export async function updateInvestment(
  _prev: InvestmentFormState,
  formData: FormData,
): Promise<InvestmentFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("updateInvestment");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn("investment.update.invalid", { message: "missing investment id" });
    return { status: "error", message: "Missing investment id." };
  }

  const f = parseForm(formData);
  log.debug("investment.update.start", { investmentId: id, ...logFields(f) });

  const invalid = validate(f);
  if (invalid) {
    log.warn("investment.update.invalid", {
      investmentId: id,
      ...invalid,
      ...logFields(f),
      durationMs: elapsed(),
    });
    return { status: "error", message: invalid.message };
  }

  const res = await ledgerFetch(`/ledger/investments/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: f.name,
      kind: f.kind,
      // Sent even when null: null CLEARS the custom name, which is what moving
      // the picker back to a listed type has to do.
      kind_label: f.kindLabel,
      invested_amount: f.invested,
      symbol: f.symbol,
      quantity: f.quantity,
      opened_on: f.openedOn,
      maturity_date: f.maturityDate,
      portfolio_id: f.portfolioId,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const fields = {
      investmentId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      ...logFields(f),
      durationMs: elapsed(),
    };
    // 400 = a guard did its job: the paying account holding a different
    // currency, or not covering a raised cost basis.
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      log.error("investment.update.rejected", fields);
    } else {
      log.warn("investment.update.rejected", fields);
    }
    return {
      status: "error",
      message: body?.error ?? "Failed to save the investment.",
    };
  }

  log.info("investment.update.ok", {
    investmentId: id,
    ...logFields(f),
    durationMs: elapsed(),
  });

  // The purchase leg may have been rebuilt, so revalidate the cash pages too —
  // the route does not report whether it was, and guessing wrong here leaves a
  // stale balance on screen.
  revalidatePath("/investments");
  revalidatePath(`/investments/${id}`);
  revalidatePath("/portfolios");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  redirect(`/investments/${id}`);
}

/**
 * Delete a holding outright: its valuation history goes, and so does the
 * purchase that paid for it — the cash comes back to the account.
 *
 * Taking the purchase along is not optional. `expenses.investment_id` is
 * `on delete set null` and both report views exclude asset purchases by exactly
 * that column, so a leg left behind would turn into an ordinary expense and
 * start reading as spending the moment the holding disappeared.
 *
 * Closing (below) stays the reversible option and is what the detail page offers
 * first; this is for a holding recorded by mistake.
 */
export async function deleteInvestment(
  _prev: DeleteState,
  formData: FormData,
): Promise<DeleteState> {
  const elapsed = startTimer();
  const { log } = await requireUser("deleteInvestment");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn("investment.delete.invalid", { message: "missing investment id" });
    return { status: "error", message: "Missing investment id." };
  }

  let res: Response;
  try {
    res = await ledgerFetch(`/ledger/investments/${id}`, { method: "DELETE" });
  } catch (err) {
    log.error("investment.delete.service_unreachable", {
      investmentId: id,
      durationMs: elapsed(),
      err,
    });
    return { status: "error", message: "Investment service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.warn("investment.delete.rejected", {
      investmentId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      durationMs: elapsed(),
    });
    return {
      status: "error",
      message: body?.error ?? "Failed to delete the investment.",
    };
  }

  const removed = (await res.json().catch(() => null)) as {
    deleted?: { snapshots_deleted?: number; purchases_reversed?: number };
  } | null;

  // Both counts are the irreversible part — say what was actually thrown away.
  log.info("investment.delete.ok", {
    investmentId: id,
    snapshotsDeleted: removed?.deleted?.snapshots_deleted ?? 0,
    purchasesReversed: removed?.deleted?.purchases_reversed ?? 0,
    durationMs: elapsed(),
  });

  revalidatePath("/investments");
  revalidatePath("/portfolios");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  redirect("/investments");
}

/**
 * Close / reopen. Both are the same PATCH with a different body, and are
 * fire-and-forget from the UI's point of view (plain `<form action={…}>`, no
 * returned state) — so the log is the only place a failure surfaces.
 *
 * Neither touches money: update_investment() only rebuilds the purchase leg when
 * the patch mentions the amount, the paying account or the opened-on date, and
 * these send none of the three.
 */
async function patchInvestment(
  formData: FormData,
  verb: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const elapsed = startTimer();
  const { log } = await requireUser(`${verb}Investment`);

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    log.warn(`investment.${verb}.invalid`, { message: "missing investment id" });
    return;
  }

  const res = await ledgerFetch(`/ledger/investments/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.error(`investment.${verb}.rejected`, {
      investmentId: id,
      status: res.status,
      reason: body?.error ?? "(no error body)",
      durationMs: elapsed(),
    });
    return;
  }

  log.info(`investment.${verb}.ok`, { investmentId: id, durationMs: elapsed() });
  revalidatePath("/investments");
  revalidatePath(`/investments/${id}`);
  revalidatePath("/dashboard");
}

/**
 * Sold, matured, or otherwise done with. A closed holding leaves
 * v_investment_performance — and therefore every dashboard figure — which is
 * the intended effect, not a side effect.
 */
export async function closeInvestment(formData: FormData): Promise<void> {
  await patchInvestment(formData, "close", { is_active: false });
}

export async function reopenInvestment(formData: FormData): Promise<void> {
  await patchInvestment(formData, "reopen", { is_active: true });
}
