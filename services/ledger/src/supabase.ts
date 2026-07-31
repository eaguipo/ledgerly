import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

/**
 * Service-role Supabase client. This BYPASSES Row Level Security, so every
 * query in this service MUST scope by user_id explicitly — the gateway is the
 * only thing that establishes identity (via the validated JWT → x-user-id).
 */
let client: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Plain Node 20 has no global WebSocket; supabase-js constructs a Realtime
    // client eagerly, so provide `ws`. (We don't use realtime subscriptions.)
    // Cast: ws's constructor signature differs slightly from the expected type.
    realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
  });
  return client;
}
