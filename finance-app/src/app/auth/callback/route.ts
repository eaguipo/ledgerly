import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback route — exchanges the PKCE authorization code for a session.
 *
 * Supabase redirects here after the user clicks the confirmation link in their
 * email. The URL looks like: /auth/callback?code=<code>
 *
 * We exchange the code for a session (writes the auth cookie via @supabase/ssr)
 * then redirect to /dashboard. On failure we redirect to /login with an error
 * flag so the user can retry.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}/dashboard`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
}
