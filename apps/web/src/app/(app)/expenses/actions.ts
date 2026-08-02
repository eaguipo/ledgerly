"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type ExpenseFormState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "error"; message: string };

export async function createExpense(
  _prev: ExpenseFormState,
  formData: FormData,
): Promise<ExpenseFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const rawAmount = String(formData.get("amount") ?? "").trim();
  const portfolioId = String(formData.get("portfolio_id") ?? "").trim();
  const categoryId = String(formData.get("category_id") ?? "").trim();
  const txnDate = String(formData.get("txn_date") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const merchant = String(formData.get("merchant") ?? "").trim() || null;

  const amount = parseFloat(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0)
    return { status: "error", message: "Amount must be greater than zero." };
  if (!portfolioId) return { status: "error", message: "Select an account." };
  if (!categoryId) return { status: "error", message: "Select a category." };
  if (!txnDate) return { status: "error", message: "Date is required." };

  // Fetch the portfolio's currency_id. RLS scopes this to the owner automatically.
  const { data: portfolio } = await supabase
    .from("portfolios")
    .select("currency_id")
    .eq("id", portfolioId)
    .single();
  if (!portfolio) return { status: "error", message: "Account not found." };

  const { data: txn, error: txnErr } = await supabase
    .from("transactions")
    .insert({
      user_id: user.id,
      portfolio_id: portfolioId,
      kind: "expense",
      direction: "outflow",
      amount,
      currency_id: portfolio.currency_id,
      txn_date: txnDate,
      description,
    })
    .select("id")
    .single();

  if (txnErr || !txn)
    return {
      status: "error",
      message: txnErr?.message ?? "Failed to record expense.",
    };

  const { error: expErr } = await supabase.from("expenses").insert({
    user_id: user.id,
    transaction_id: txn.id,
    txn_kind: "expense",
    category_id: categoryId,
    merchant,
  });

  if (expErr) {
    // Roll back the transaction row so the ledger stays consistent.
    await supabase.from("transactions").delete().eq("id", txn.id);
    return { status: "error", message: expErr.message };
  }

  revalidatePath("/expenses");
  return { status: "success" };
}
