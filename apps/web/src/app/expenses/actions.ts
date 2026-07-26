"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { gatewayFetch } from "@/lib/gateway";

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

  // The ledger microservice (via the api-gateway) owns writes to the ledger now.
  // It validates ownership, derives the account currency, and inserts the
  // transaction + expense atomically through the create_expense RPC.
  let res: Response;
  try {
    res = await gatewayFetch("/ledger/expenses", {
      method: "POST",
      body: JSON.stringify({
        amount,
        portfolio_id: portfolioId,
        category_id: categoryId,
        txn_date: txnDate,
        description,
        merchant,
      }),
    });
  } catch {
    return { status: "error", message: "Expense service is unavailable." };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { status: "error", message: body?.error ?? "Failed to record expense." };
  }

  revalidatePath("/expenses");
  return { status: "success" };
}
