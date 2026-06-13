import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import { signout } from "@/lib/auth/actions";

const CATEGORY_LABEL: Record<string, string> = {
  cash: "Cash",
  bank: "Bank",
  crypto: "Crypto",
  investment: "Investment",
  others: "Others",
};
const CATEGORY_ORDER = ["cash", "bank", "crypto", "investment", "others"];

interface CurrencyInfo {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface PortfolioRow {
  category: string;
  current_balance: number | string;
  currency: CurrencyInfo | CurrencyInfo[] | null;
}

function buildSummary(portfolios: PortfolioRow[]) {
  const summary = new Map<string, Map<string, { total: number; currency: CurrencyInfo }>>();
  for (const p of portfolios) {
    const cur = Array.isArray(p.currency) ? p.currency[0] : p.currency;
    if (!cur) continue;
    if (!summary.has(p.category)) summary.set(p.category, new Map());
    const catMap = summary.get(p.category)!;
    const existing = catMap.get(cur.code);
    if (existing) {
      existing.total += Number(p.current_balance);
    } else {
      catMap.set(cur.code, { total: Number(p.current_balance), currency: cur });
    }
  }
  return summary;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: portfolios } = await supabase
    .from("portfolios")
    .select("category, current_balance, currency:currencies(code, symbol, minor_unit)")
    .eq("is_archived", false);

  const summary = buildSummary((portfolios ?? []) as unknown as PortfolioRow[]);
  const activeCategories = CATEGORY_ORDER.filter((c) => summary.has(c));

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-black">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Dashboard
        </h1>

        <dl className="mt-6 space-y-1">
          <div className="flex items-center justify-between gap-4 py-1">
            <dt className="text-sm text-zinc-500 dark:text-zinc-400">
              Signed in as
            </dt>
            <dd className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {user.email}
            </dd>
          </div>
        </dl>

        {/* Balance summary by category */}
        {activeCategories.length > 0 && (
          <div className="mt-6 rounded-xl border border-zinc-100 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Balances by category
            </p>
            <dl className="space-y-3">
              {activeCategories.map((cat) => {
                const totals = [...summary.get(cat)!.values()];
                return (
                  <div key={cat} className="flex items-start justify-between gap-4">
                    <dt className="text-sm text-zinc-600 dark:text-zinc-400">
                      {CATEGORY_LABEL[cat]}
                    </dt>
                    <dd className="text-right">
                      {totals.map(({ total, currency }) => (
                        <div
                          key={currency.code}
                          className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50"
                        >
                          {formatMoney(total, currency)}
                        </div>
                      ))}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}

        <nav className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <Link
            href="/portfolios"
            className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Portfolios
            <span aria-hidden className="text-zinc-400">→</span>
          </Link>
          <Link
            href="/expenses"
            className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Expenses
            <span aria-hidden className="text-zinc-400">→</span>
          </Link>
        </nav>

        <form
          action={signout}
          className="mt-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
        >
          <button
            type="submit"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
          >
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
