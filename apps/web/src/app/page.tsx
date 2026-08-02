import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * `/` is a public path in the proxy, so it decides its own destination:
 * signed-in visitors go straight to the dashboard, everyone else to login.
 * (This replaced the Phase 0 Supabase status page.)
 */
export default async function Home() {
  const configured =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!configured) redirect("/login");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/dashboard" : "/login");
}
