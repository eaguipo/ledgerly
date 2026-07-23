import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import { categoryLabel } from "./constants";
import { PortfolioForm } from "./portfolio-form";
import { createPortfolio, archivePortfolio, restorePortfolio } from "./actions";

interface CurrencyEmbed {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface PortfolioRow {
  id: string;
  name: string;
  category: string;
  currency_id: string;
  current_balance: number | string;
  is_savings: boolean;
  is_liquid: boolean;
  is_archived: boolean;
  institution: string | null;
  currency: CurrencyEmbed | CurrencyEmbed[] | null;
}

function currencyOf(p: PortfolioRow): CurrencyEmbed | undefined {
  const c = Array.isArray(p.currency) ? p.currency[0] : p.currency;
  return c ?? undefined;
}

export default async function PortfoliosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: currencies }, { data: profile }, { data: portfolios }] =
    await Promise.all([
      supabase
        .from("currencies")
        .select("id, code, symbol, name, minor_unit")
        .eq("is_active", true)
        .order("code"),
      supabase
        .from("profiles")
        .select("default_currency_id")
        .eq("id", user.id)
        .single(),
      supabase
        .from("portfolios")
        .select(
          "id, name, category, currency_id, current_balance, is_savings, is_liquid, is_archived, institution, currency:currencies(code, symbol, minor_unit)",
        )
        .order("is_archived")
        .order("sort_order")
        .order("created_at"),
    ]);

  const rows = (portfolios ?? []) as PortfolioRow[];
  const active = rows.filter((p) => !p.is_archived);
  const archived = rows.filter((p) => p.is_archived);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Portfolios
        </h1>
        <Link
          href="/dashboard"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← Dashboard
        </Link>
      </div>

      {/* Add account */}
      <section className="mb-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Add an account
        </h2>
        <PortfolioForm
          mode="create"
          action={createPortfolio}
          currencies={currencies ?? []}
          defaultCurrencyId={profile?.default_currency_id ?? undefined}
          submitLabel="Add account"
        />
      </section>

      {/* Active accounts */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Your accounts{" "}
          <span className="text-sm font-normal text-zinc-400">
            ({active.length})
          </span>
        </h2>
        {active.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            No accounts yet. Add your first one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((p) => {
              const cur = currencyOf(p);
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-zinc-900 dark:text-zinc-50">
                        {p.name}
                      </span>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {categoryLabel(p.category)}
                      </span>
                      {p.is_liquid ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                          liquid
                        </span>
                      ) : null}
                    </div>
                    {p.institution ? (
                      <p className="truncate text-xs text-zinc-400">
                        {p.institution}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="whitespace-nowrap font-medium tabular-nums text-zinc-900 dark:text-zinc-50">
                      {formatMoney(p.current_balance, cur)}
                    </span>
                    <Link
                      href={`/portfolios/${p.id}`}
                      className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                    >
                      Edit
                    </Link>
                    <form action={archivePortfolio}>
                      <input type="hidden" name="id" value={p.id} />
                      <button
                        type="submit"
                        className="text-sm text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
                      >
                        Archive
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Archived accounts */}
      {archived.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
            Archived ({archived.length})
          </h2>
          <ul className="space-y-2">
            {archived.map((p) => {
              const cur = currencyOf(p);
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 opacity-70 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <span className="truncate text-zinc-600 dark:text-zinc-400">
                    {p.name}{" "}
                    <span className="text-xs text-zinc-400">
                      ({categoryLabel(p.category)})
                    </span>
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="whitespace-nowrap text-sm tabular-nums text-zinc-500">
                      {formatMoney(p.current_balance, cur)}
                    </span>
                    <form action={restorePortfolio}>
                      <input type="hidden" name="id" value={p.id} />
                      <button
                        type="submit"
                        className="text-sm text-emerald-600 hover:text-emerald-500"
                      >
                        Restore
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
