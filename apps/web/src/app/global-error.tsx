"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import "./globals.css";
import { clientError, clientErrorFields } from "@/lib/client-logger";

/**
 * Last-resort boundary: it catches failures in the ROOT layout, which the
 * per-segment error.tsx cannot. It replaces the root layout when active, so it
 * has to bring its own <html>/<body> and stylesheet.
 *
 * Its real job here is to make sure such a failure is never silent — the root
 * layout blowing up would otherwise render a blank page with nothing logged
 * anywhere on the client.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    clientError("web.boundary.global_error", clientErrorFields(error));
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased dark">
      <body className="flex min-h-full flex-col items-center justify-center bg-canvas p-6 text-ink">
        <title>Something went wrong · Ledgerly</title>
        <div className="w-full max-w-md rounded-2xl border border-line p-8 text-center">
          <h1 className="text-lg font-semibold">Ledgerly hit an error</h1>
          <p className="mt-2 text-[13px] text-muted">
            The failure has been logged.
            {error.digest ? (
              <>
                {" "}
                Reference: <span className="figure">{error.digest}</span>
              </>
            ) : null}
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="mt-6 inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
