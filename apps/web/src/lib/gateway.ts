import { createClient } from "@/lib/supabase/server";
import { log, startTimer } from "@/lib/logger";
import { REQUEST_ID_HEADER, getRequestId } from "@/lib/request-context";

/**
 * Server-side helper to call the api-gateway as the current user. The web app is
 * the BFF: it holds the Supabase session and forwards the access token as a
 * bearer, which the gateway validates before routing to a microservice.
 *
 * In-cluster this resolves via Kubernetes DNS (http://api-gateway). It is only
 * meant to be called from Server Components / Server Actions.
 *
 * Every call is logged (start, outcome, duration) under the request's `reqId`,
 * which is also forwarded downstream — so the matching gateway and ledger log
 * lines carry the same id. When something fails, the log says which of the three
 * hops it failed at.
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://api-gateway";

/** How much of a failed response body to keep. Enough to read the error, not the payload. */
const ERROR_BODY_CHARS = 300;

export async function gatewayFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const reqId = await getRequestId();
  const method = (init?.method ?? "GET").toUpperCase();
  const callLog = log.child({ reqId, component: "gateway-client" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set(REQUEST_ID_HEADER, reqId);
  if (session?.access_token) {
    headers.set("authorization", `Bearer ${session.access_token}`);
  }

  // No token means the gateway will answer 401 — worth flagging as the cause
  // rather than letting it read as "the service is broken".
  if (!session?.access_token) {
    callLog.warn("gateway.request.no_session", {
      method,
      path,
      hint: "no Supabase access token on this request; the gateway will reject it with 401",
    });
  }

  callLog.debug("gateway.request.start", {
    method,
    path,
    url: `${GATEWAY_URL}${path}`,
    userId: session?.user?.id ?? null,
  });

  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (err) {
    // Network-level failure: DNS, connection refused, socket hang-up. In the
    // cluster this is usually the gateway pod not being ready yet.
    callLog.error("gateway.request.unreachable", {
      method,
      path,
      url: `${GATEWAY_URL}${path}`,
      durationMs: elapsed(),
      err,
    });
    throw err;
  }

  const durationMs = elapsed();

  if (!res.ok) {
    // clone() so the caller still gets an unread body.
    const body = await res
      .clone()
      .text()
      .then((t) => t.slice(0, ERROR_BODY_CHARS))
      .catch(() => "(unreadable)");
    callLog.warn("gateway.request.failed", {
      method,
      path,
      status: res.status,
      durationMs,
      responseBody: body,
    });
    return res;
  }

  callLog.debug("gateway.request.ok", {
    method,
    path,
    status: res.status,
    durationMs,
  });
  return res;
}
