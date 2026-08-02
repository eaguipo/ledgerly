import { createClient } from "@/lib/supabase/server";

/**
 * Server-side helper to call the api-gateway as the current user. The web app is
 * the BFF: it holds the Supabase session and forwards the access token as a
 * bearer, which the gateway validates before routing to a microservice.
 *
 * In-cluster this resolves via Kubernetes DNS (http://api-gateway). It is only
 * meant to be called from Server Components / Server Actions.
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://api-gateway";

export async function gatewayFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (session?.access_token) {
    headers.set("authorization", `Bearer ${session.access_token}`);
  }

  return fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}
