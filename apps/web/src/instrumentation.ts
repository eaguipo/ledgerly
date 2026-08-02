import type { Instrumentation } from "next";
import { log, activeLogLevel } from "@/lib/logger";
import { REQUEST_ID_HEADER } from "@/lib/request-context";

/**
 * Observability hooks for the web app (Next.js `instrumentation` file
 * convention — see node_modules/next/dist/docs/.../instrumentation.md).
 *
 *  - `register()`      runs once per server instance, before the first request.
 *  - `onRequestError()` runs for EVERY server-side error Next.js captures:
 *    Server Components, Server Actions, Route Handlers and the proxy. It is the
 *    safety net — anything a `try/catch` misses still gets logged here with the
 *    route that produced it.
 */

/** Boot summary. Reports which config is present, never what it contains. */
export function register() {
  log.info("web.boot", {
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    nodeEnv: process.env.NODE_ENV,
    logLevel: activeLogLevel,
    gatewayUrl: process.env.GATEWAY_URL ?? "http://api-gateway (default)",
    supabaseUrlSet: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnonKeySet: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    serviceRoleKeySet: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });

  // A missing Supabase URL/key does not crash the app — `updateSession` skips
  // session refresh and every page silently behaves as signed-out. Say so at
  // boot rather than letting it look like a login bug later.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    log.warn("web.boot.supabase_unconfigured", {
      hint: "auth is disabled until NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set (apps/web/.env.local)",
    });
  }
}

export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => {
  const headers = request.headers as Record<string, string | string[]>;
  const reqId = headers[REQUEST_ID_HEADER];

  // Next types `err` as `unknown` here — anything can be thrown, not just an
  // Error — so `digest` has to be read defensively rather than dereferenced.
  const digest =
    typeof err === "object" && err !== null && "digest" in err
      ? (err as { digest?: unknown }).digest
      : undefined;

  log.error("web.request.error", {
    reqId: Array.isArray(reqId) ? reqId[0] : reqId,
    method: request.method,
    path: request.path,
    // `routeType` is the single most useful field here: it says whether the
    // failure was a page render, a Server Action, a Route Handler or the proxy.
    routeType: context.routeType,
    routePath: context.routePath,
    routerKind: context.routerKind,
    renderSource: context.renderSource,
    revalidateReason: context.revalidateReason,
    // The digest is what the browser shows the user in production; it is the
    // only handle they can quote back to you. Keep it next to the stack.
    digest,
    err,
  });
};
