import { createClient } from "@/lib/supabase/server";

/**
 * Personal Finance Tracker — Phase 0 status page.
 *
 * Server Component. Reports whether the Supabase environment variables are
 * present (without ever printing their values) and does a lightweight,
 * fail-safe connectivity probe against the project's server client.
 */

type Connection = "reachable" | "unreachable" | "skipped";

async function probeConnection(configured: boolean): Promise<Connection> {
  if (!configured) {
    return "skipped";
  }

  try {
    const supabase = await createClient();
    // Trivial call. Any non-network response (including an auth error such as
    // "no session") means the project is reachable. Only a thrown
    // network-level error counts as unreachable.
    await supabase.auth.getClaims();
    return "reachable";
  } catch {
    return "unreachable";
  }
}

export default async function Home() {
  const hasUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const hasAnonKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const configured = hasUrl && hasAnonKey;

  const connection = await probeConnection(configured);

  const connectionLabel: Record<Connection, string> = {
    reachable: "reachable",
    unreachable: "unreachable",
    skipped: "skipped",
  };

  const nextStep = !configured
    ? "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev server."
    : connection === "unreachable"
      ? "Env vars are set but the project could not be reached — check the URL and your network."
      : "Supabase is configured and reachable. You're ready to start Phase 1 (auth & route protection).";

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-black">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Ledgerly — Phase 0
        </h1>

        <dl className="mt-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              Supabase configured
            </dt>
            <dd
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                configured
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              }`}
            >
              {configured ? "yes" : "no"}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              Connection
            </dt>
            <dd
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                connection === "reachable"
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : connection === "unreachable"
                    ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                    : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {connectionLabel[connection]}
            </dd>
          </div>
        </dl>

        <p className="mt-6 border-t border-zinc-200 pt-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          {nextStep}
        </p>
      </section>
    </main>
  );
}
