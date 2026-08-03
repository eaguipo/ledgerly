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
import {
  CUSTOM_INVESTMENT_KIND,
  INVESTMENT_KIND_VALUES,
  todayIso,
} from "./constants";

/**
 * Investment Server Actions. Nothing here moves money (Phase 4, decision D1):
 * recording a holding is a statement about what you own, and a snapshot is an
 * observation of what it is worth. No ledger row is posted and no portfolio
 * balance changes — which is why none of these revalidate /portfolios.
 *
 * They still go through ledgerFetch rather than writing the tables directly,
 * because create_investment / record_investment_snapshot hold validation the UI
 * must not be the only place enforcing: the funding account's currency, and the
 * future-date and wrong-currency guards that stop one bad valuation pinning
 * current_value permanently.
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

export async function createInvestment(
  _prev: InvestmentFormState,
  formData: FormData,
): Promise<InvestmentFormState> {
  const elapsed = startTimer();
  const { log } = await requireUser("createInvestment");

  const name = String(formData.get("name") ?? "").trim();
  const rawKind = String(formData.get("kind") ?? "").trim();
  const currencyId = String(formData.get("currency_id") ?? "").trim();
  const rawInvested = String(formData.get("invested_amount") ?? "").trim();
  const symbol = String(formData.get("symbol") ?? "").trim() || null;
  const quantity = optionalNumber(formData.get("quantity"));
  const openedOn = String(formData.get("opened_on") ?? "").trim() || null;
  const maturityDate = String(formData.get("maturity_date") ?? "").trim() || null;
  const portfolioId = String(formData.get("portfolio_id") ?? "").trim() || null;

  // A type the list doesn't have is stored as the enum's catch-all member plus
  // the name the user gave it; `investment_kind` can't grow members without a
  // migration, and v_investment_performance groups on it.
  const wantsCustomKind = rawKind === CUSTOM_CHOICE;
  const kind = wantsCustomKind ? CUSTOM_INVESTMENT_KIND : rawKind;
  const kindLabel = wantsCustomKind
    ? normalizeCustomLabel(formData.get("kind_label"))
    : null;

  const invested = parseFloat(rawInvested);

  // The holding's name is the user's own wording — length only. kindLabel is
  // not that: it names a kind of asset, not a private detail, and it is the only
  // thing distinguishing one other_asset row from another.
  log.debug("investment.create.start", {
    nameLength: name.length,
    kind,
    kindLabel,
    currencyId,
    rawInvested,
    linked: portfolioId !== null,
  });

  const reject = (field: string, message: string): InvestmentFormState => {
    log.warn("investment.create.invalid", {
      field,
      message,
      kind,
      currencyId,
      rawInvested,
      durationMs: elapsed(),
    });
    return { status: "error", message };
  };

  if (!name) return reject("name", "Give the investment a name.");
  if (!INVESTMENT_KIND_VALUES.includes(kind))
    return reject("kind", "Choose a type.");
  if (wantsCustomKind) {
    if (!kindLabel) return reject("kind_label", "Name the type.");
    if (kindLabel.length > MAX_CUSTOM_LABEL)
      return reject(
        "kind_label",
        `Type name must be ${MAX_CUSTOM_LABEL} characters or fewer.`,
      );
  }
  if (!currencyId) return reject("currency_id", "Select a currency.");
  // Zero is allowed on purpose — an asset you were given still has a value worth
  // tracking, and its return % reads as "—" rather than 0%.
  if (!Number.isFinite(invested) || invested < 0)
    return reject("invested_amount", "Amount invested cannot be negative.");

  const res = await ledgerFetch("/ledger/investments", {
    method: "POST",
    body: JSON.stringify({
      name,
      kind,
      kind_label: kindLabel,
      currency_id: currencyId,
      invested_amount: invested,
      symbol,
      quantity,
      opened_on: openedOn,
      maturity_date: maturityDate,
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
    kind,
    kindLabel,
    currencyId,
    invested,
    linked: portfolioId !== null,
    durationMs: elapsed(),
  });

  // No balance moved, so /portfolios is untouched by design. The dashboard
  // carries the invested total, so it is stale either way.
  revalidatePath("/investments");
  revalidatePath("/dashboard");

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
 * Close / reopen. Both are the same PATCH with a different body, and are
 * fire-and-forget from the UI's point of view (plain `<form action={…}>`, no
 * returned state) — so the log is the only place a failure surfaces.
 *
 * There is no delete. `investments → investment_snapshots` is `on delete
 * cascade`, so deleting a holding throws away the valuation history that is the
 * entire record of how it performed. Closing it is reversible; deleting is not.
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
