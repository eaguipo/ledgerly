"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "./nav-items";

function useIsActive() {
  const pathname = usePathname();
  return (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
}

/** Desktop sidebar links. */
export function SidebarLinks() {
  const isActive = useIsActive();

  return (
    <nav className="space-y-0.5" aria-label="Main">
      {NAV_ITEMS.map(({ href, label, Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2 text-[13.5px] font-medium transition-colors",
              active
                ? "bg-raised text-ink"
                : "text-muted hover:bg-raised hover:text-ink",
            )}
          >
            <Icon className={active ? "text-accent" : "text-faint"} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Mobile bottom tab bar — the sidebar is hidden below `lg`. */
export function MobileTabs() {
  const isActive = useIsActive();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface lg:hidden"
    >
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-2 pb-[env(safe-area-inset-bottom)]">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 rounded-lg py-2.5 text-[11px] font-medium transition-colors",
                active ? "text-accent" : "text-muted",
              )}
            >
              <Icon />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
