import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { log, type Logger } from "@/lib/logger";

/**
 * Request correlation.
 *
 * One browser action fans out across three processes (web → api-gateway →
 * ledger). Without a shared id, debugging means eyeballing timestamps in three
 * `kubectl logs` streams. `proxy.ts` stamps every inbound request with
 * `x-request-id`; the helpers here read it back, `gatewayFetch` forwards it, and
 * both Fastify services adopt it as their `reqId` (they are configured with
 * `requestIdHeader: "x-request-id"`).
 *
 * So one id ties the whole flow together:
 *
 *   kubectl logs -n ledgerly deploy/web       | jq 'select(.reqId=="<id>")'
 *   kubectl logs -n ledgerly deploy/api-gateway | jq 'select(.reqId=="<id>")'
 *   kubectl logs -n ledgerly deploy/ledger    | jq 'select(.reqId=="<id>")'
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Vercel stamps every request with `x-vercel-id` and shows that same id beside
 * the entry in Runtime Logs. When we are deployed there, adopting it as our
 * reqId means a log line found in the Vercel dashboard and one found via a log
 * drain carry the same handle — so we only generate an id when nothing upstream
 * gave us one.
 */
const UPSTREAM_ID_HEADERS = [REQUEST_ID_HEADER, "x-vercel-id"] as const;

/** 16 hex chars: collision-free enough for a log correlation id, short enough to read. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** First upstream-supplied correlation id, or a fresh one. */
export function resolveRequestId(headers: Headers): string {
  for (const name of UPSTREAM_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return newRequestId();
}

/**
 * The current request's correlation id. Falls back to a fresh id when there is
 * no request scope (e.g. a build-time render), so callers never have to branch.
 */
export async function getRequestId(): Promise<string> {
  try {
    return resolveRequestId(await headers());
  } catch (err) {
    // headers() throws Next's own control-flow error in a statically rendered
    // segment — that must reach the framework, not be swallowed here.
    unstable_rethrow(err);
    return newRequestId();
  }
}

/** Logger bound to the current request id — the usual entry point in server code. */
export async function requestLogger(bindings?: Record<string, unknown>): Promise<Logger> {
  return log.child({ reqId: await getRequestId(), ...bindings });
}
