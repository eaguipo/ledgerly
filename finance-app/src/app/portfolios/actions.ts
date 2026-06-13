"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { CATEGORY_VALUES } from "./constants";

/**
 * Portfolio (account) Server Actions. All writes go through the anon-key server
 * client, so RLS enforces ownership (user_id = auth.uid()) and the 'portfolios'
 * feature gate. We still re-fetch the user via getUser() (network-verified).
 */

export type PortfolioFormState =
  | { status: "idle" }
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

export async function createPortfolio(
  _prev: PortfolioFormState,
  formData: FormData,
): Promise<PortfolioFormState> {
  const f = parseForm(formData);
  const invalid = validate(f);
  if (invalid) return { status: "error", message: invalid };
  if (!Number.isFinite(f.openingBalance) || f.openingBalance < 0) {
    return { status: "error", message: "Opening balance must be 0 or more." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

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

  if (error) return { status: "error", message: error.message };

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
      await supabase.from("portfolios").delete().eq("id", portfolio.id);
      return { status: "error", message: `Could not set opening balance: ${txnErr.message}` };
    }
  }

  revalidatePath("/portfolios");
  redirect("/portfolios");
}

export async function updatePortfolio(
  _prev: PortfolioFormState,
  formData: FormData,
): Promise<PortfolioFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { status: "error", message: "Missing account id." };
  const f = parseForm(formData);
  if (!f.name) return { status: "error", message: "Account name is required." };
  if (!CATEGORY_VALUES.includes(f.category)) return { status: "error", message: "Pick a valid category." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Currency and opening balance are fixed after creation (changing currency
  // would break the per-portfolio currency invariant on existing ledger rows).
  const { error } = await supabase
    .from("portfolios")
    .update({
      name: f.name,
      category: f.category,
      is_savings: f.is_savings,
      institution: f.institution || null,
    })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return { status: "error", message: error.message };

  revalidatePath("/portfolios");
  redirect("/portfolios");
}

/** Soft-delete: archive (ledger history makes hard delete unsafe; reversible). */
export async function archivePortfolio(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await supabase
    .from("portfolios")
    .update({ is_archived: true, archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);
  revalidatePath("/portfolios");
}

export async function restorePortfolio(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await supabase
    .from("portfolios")
    .update({ is_archived: false, archived_at: null })
    .eq("id", id)
    .eq("user_id", user.id);
  revalidatePath("/portfolios");
}
