"use client";

/**
 * Browser-side logging. Deliberately tiny and separate from `@/lib/logger`:
 * that module reads server-only env vars, and importing it from a client
 * component would drag them into the browser bundle.
 *
 * Records use the same field names as the server logger so the two read alike.
 * `next.config.ts` sets `logging.browserToTerminal`, so in dev these lines also
 * land in the terminal running `next dev` — no need to open devtools to see a
 * client-side render error.
 */

export type ClientLogFields = Record<string, unknown>;

function emit(level: "warn" | "error", msg: string, fields: ClientLogFields) {
  const record = {
    level,
    time: new Date().toISOString(),
    service: "web-client",
    msg,
    path: typeof location !== "undefined" ? location.pathname : undefined,
    ...fields,
  };
  if (level === "error") console.error("[ledgerly]", record);
  else console.warn("[ledgerly]", record);
}

export function clientWarn(msg: string, fields: ClientLogFields = {}) {
  emit("warn", msg, fields);
}

export function clientError(msg: string, fields: ClientLogFields = {}) {
  emit("error", msg, fields);
}

/**
 * Flatten an error for the browser console. `digest` is the important one: for
 * errors thrown on the server it is the ONLY link back to the full stack in the
 * server logs (production deliberately withholds the message from the client).
 */
export function clientErrorFields(error: unknown): ClientLogFields {
  if (error instanceof Error) {
    const e = error as Error & { digest?: string };
    return {
      err: {
        type: e.name,
        message: e.message,
        digest: e.digest,
        stack: e.stack?.split("\n").slice(0, 8).join("\n"),
      },
    };
  }
  return { err: { type: typeof error, message: String(error) } };
}
