import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";

/**
 * Auth callback route — exchanges the PKCE authorization code for a session.
 *
 * Supabase redirects here after the user clicks the confirmation link in their
 * email. The URL looks like: /auth/callback?code=<code>
 *
 * We exchange the code for a session (writes the auth cookie via @supabase/ssr)
 * then redirect to /dashboard. On failure we redirect to /login with an error
 * flag so the user can retry.
 *
 * The user sees only "confirmation_failed" here, and the causes are wildly
 * different (link already used, link expired, wrong project, PKCE verifier
 * cookie missing because the link was opened in another browser). The logs below
 * carry the Supabase error code that tells them apart. The `code` itself is a
 * single-use credential and is never logged.
 */
export async function GET(request: Request) {
  const log = await requestLogger({ route: "/auth/callback" });
  const elapsed = startTimer();
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  // Supabase sends error details on the URL when it rejects the link itself.
  const urlError = searchParams.get("error");
  const urlErrorCode = searchParams.get("error_code");

  if (code) {
    log.debug("auth.callback.start", { origin, hasCode: true });
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      log.info("auth.callback.ok", {
        userId: data.user?.id,
        durationMs: elapsed(),
      });
      return NextResponse.redirect(`${origin}/dashboard`);
    }
    log.error("auth.callback.exchange_failed", {
      code: error.code,
      status: error.status,
      message: error.message,
      durationMs: elapsed(),
    });
  } else {
    log.warn("auth.callback.no_code", {
      origin,
      urlError,
      urlErrorCode,
      urlErrorDescription: searchParams.get("error_description"),
      durationMs: elapsed(),
    });
  }

  return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
}
