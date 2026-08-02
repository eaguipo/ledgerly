import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/logo";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Without this file Next renders its built-in 404 inside the root layout, which
 * has a "Skip to content" link pointing at #main — an anchor with no target,
 * because only the (app) and (auth) layouts define it.
 */
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="px-5 py-5">
        <Wordmark />
      </header>
      <main
        id="main"
        className="flex flex-1 flex-col items-center justify-center px-5 pb-24 text-center"
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-muted">
          404
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
          We couldn&apos;t find that page
        </h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          The link may be out of date, or the page may have moved.
        </p>
        <ButtonLink href="/dashboard" variant="primary" className="mt-6">
          Back to dashboard
        </ButtonLink>
      </main>
    </div>
  );
}
