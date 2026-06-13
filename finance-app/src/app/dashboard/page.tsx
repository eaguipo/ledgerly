import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signout } from "@/lib/auth/actions";

/**
 * Protected dashboard (Server Component).
 *
 * Even though the proxy redirects unauthenticated users, the Next.js auth guide
 * frames the proxy as an OPTIMISTIC pre-filter — secure checks belong close to
 * the data. So we independently call getUser() (network-verified) here and
 * redirect to /login if there is no user. This is the authoritative check.
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-black">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Dashboard
        </h1>

        <dl className="mt-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              Signed in as
            </dt>
            <dd className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {user.email}
            </dd>
          </div>
        </dl>

        <nav className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <Link
            href="/portfolios"
            className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Portfolios
            <span aria-hidden className="text-zinc-400">
              →
            </span>
          </Link>
          <Link
            href="/expenses"
            className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Expenses
            <span aria-hidden className="text-zinc-400">
              →
            </span>
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
