import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signout } from "@/lib/auth/actions";
import { Logo, Wordmark } from "@/components/brand/logo";
import { SidebarLinks, MobileTabs } from "@/components/shell/nav-links";
import { ThemeToggle } from "@/components/shell/theme-toggle";

/**
 * Shell for every signed-in route. Holds the persistent navigation, so moving
 * between Expenses and Portfolios no longer means backtracking through the
 * dashboard. `proxy.ts` already gates these routes; the getUser() here is the
 * server-side confirmation and also supplies the account footer.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line px-3 py-5 lg:flex">
        <div className="px-2 pb-6">
          <Wordmark />
        </div>

        <SidebarLinks />

        <div className="mt-auto border-t border-line pt-3">
          <div className="flex items-center gap-2 px-1">
            <p
              className="min-w-0 flex-1 truncate px-1 text-[12.5px] text-muted"
              title={user.email ?? undefined}
            >
              {user.email}
            </p>
            <ThemeToggle />
          </div>
          <form action={signout} className="mt-1">
            <button
              type="submit"
              className="w-full rounded-xl px-3 py-2 text-left text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile top bar */}
      {/* Solid, not translucent: an alpha modifier on a var-backed token
          compiles without alpha in Tailwind v4, so backdrop-blur would cost
          GPU for no visible frost. */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-canvas px-4 py-3 lg:hidden">
        <span className="flex items-center gap-2.5">
          <Logo size={30} />
          <span className="text-[18px] font-semibold tracking-tight">
            Ledger<span className="text-accent">ly</span>
          </span>
        </span>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <form action={signout}>
            <button
              type="submit"
              className="rounded-xl px-2.5 py-2 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/* Extra bottom padding on mobile so the tab bar never covers content. */}
      <main id="main" className="min-w-0 flex-1 pb-24 lg:pb-0">
        {children}
      </main>

      <MobileTabs />
    </div>
  );
}
