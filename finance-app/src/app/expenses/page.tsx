import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import { ExpenseForm } from "./expense-form";

interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface ExpenseRow {
  id: string;
  merchant: string | null;
  category: { name: string } | null;
  transaction: {
    id: string;
    amount: number | string;
    txn_date: string;
    description: string | null;
    currency: Currency | null;
    portfolio: { name: string } | null;
  } | null;
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function ExpensesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: portfolios }, { data: categories }, { data: expenses }] =
    await Promise.all([
      supabase
        .from("portfolios")
        .select("id, name")
        .eq("is_archived", false)
        .order("sort_order")
        .order("created_at"),
      supabase
        .from("expense_categories")
        .select("id, name")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("expenses")
        .select(
          "id, merchant, category:expense_categories(name), transaction:transactions!inner(id, amount, txn_date, description, currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))",
        )
        .order("created_at", { ascending: false })
        .limit(30),
    ]);

  const rows = (expenses ?? []) as unknown as ExpenseRow[];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Expenses
        </h1>
        <Link
          href="/dashboard"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← Dashboard
        </Link>
      </div>

      {/* Add expense */}
      <section className="mb-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Add an expense
        </h2>
        {portfolios && portfolios.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            You need at least one account before recording expenses.{" "}
            <Link href="/portfolios" className="underline">
              Add an account
            </Link>
            .
          </p>
        ) : (
          <ExpenseForm
            portfolios={portfolios ?? []}
            categories={categories ?? []}
          />
        )}
      </section>

      {/* Recent expenses */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Recent expenses{" "}
          <span className="text-sm font-normal text-zinc-400">
            ({rows.length})
          </span>
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            No expenses yet. Add your first one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((e) => {
              const txn = Array.isArray(e.transaction)
                ? e.transaction[0]
                : e.transaction;
              const cat = Array.isArray(e.category)
                ? e.category[0]
                : e.category;
              const cur = txn?.currency
                ? (Array.isArray(txn.currency)
                    ? txn.currency[0]
                    : txn.currency)
                : undefined;
              const portfolio = txn?.portfolio
                ? (Array.isArray(txn.portfolio)
                    ? txn.portfolio[0]
                    : txn.portfolio)
                : undefined;

              if (!txn) return null;

              return (
                <li
                  key={e.id}
                  className="flex items-start justify-between gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                        {cat?.name ?? "—"}
                      </span>
                      {e.merchant ? (
                        <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {e.merchant}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                      <span>{formatDate(txn.txn_date)}</span>
                      {portfolio ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{portfolio.name}</span>
                        </>
                      ) : null}
                      {txn.description ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="italic">{txn.description}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap font-medium tabular-nums text-red-600 dark:text-red-400">
                    −{formatMoney(txn.amount, cur)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
