import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PortfolioForm } from "../portfolio-form";
import { updatePortfolio } from "../actions";

export default async function EditPortfolioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: portfolio }, { data: currencies }] = await Promise.all([
    supabase
      .from("portfolios")
      .select("id, name, category, currency_id, is_savings, institution")
      .eq("id", id)
      .single(), // RLS scopes this to the owner; others get no row.
    supabase
      .from("currencies")
      .select("id, code, symbol, name, minor_unit")
      .eq("is_active", true)
      .order("code"),
  ]);

  if (!portfolio) redirect("/portfolios");

  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Edit account
        </h1>
        <Link
          href="/portfolios"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← Portfolios
        </Link>
      </div>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <PortfolioForm
          mode="edit"
          action={updatePortfolio}
          currencies={currencies ?? []}
          portfolio={portfolio}
          submitLabel="Save changes"
        />
      </section>
    </main>
  );
}
