import { gatewayFetch } from "@/lib/gateway";
import { localLedger } from "@/lib/ledger-local";

/**
 * The one way pages and Server Actions reach the ledger, whichever way this
 * copy of the app is deployed.
 *
 *   mesh (k3d, Tilt)  GATEWAY_URL set   → api-gateway → ledger-service → Supabase
 *   Vercel (`main`)   GATEWAY_URL unset → in-process handlers → Supabase (RLS)
 *
 * `main` has no services and no cluster (CLAUDE.md, DEVELOPER-GUIDE §7), so the
 * ledger-backed features had nothing to call there and every one of those routes
 * failed. Rather than fork the pages, both deployments keep calling the same
 * `/ledger/*` paths and this picks the transport.
 *
 * The switch is deliberately the presence of GATEWAY_URL rather than NODE_ENV or
 * a feature flag: it is the single piece of config that actually says whether a
 * gateway exists to talk to. The Helm chart sets it, `.env.local` sets it for a
 * local mesh run, and Vercel does not.
 *
 * Both paths enforce tenancy, by different means — the mesh validates the JWT at
 * the gateway and re-checks ownership inside each service-role RPC, the local
 * path runs everything under the user's own session so RLS applies. Neither
 * gives the web tier the service-role key.
 */
export function ledgerFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return process.env.GATEWAY_URL
    ? gatewayFetch(path, init)
    : localLedger(path, init);
}

/** True when this deployment reaches the ledger through the mesh. */
export const usingGateway = (): boolean => Boolean(process.env.GATEWAY_URL);
