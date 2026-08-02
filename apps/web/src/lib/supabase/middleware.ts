import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { log, startTimer } from "@/lib/logger";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/request-context";

/**
 * Refreshes the Supabase auth session on every request and keeps the auth
 * cookies in sync between the request and the response.
 *
 * Phase 1: in addition to refreshing the session, this now gates protected
 * routes — unauthenticated users are redirected to /login, and authenticated
 * users visiting /login or /signup are redirected to /dashboard.
 *
 * This is also where request correlation starts: every inbound request gets an
 * `x-request-id` (reusing the caller's if one is already set), stamped onto the
 * request so Server Components/Actions can read it, and onto the response so it
 * is visible in the browser's network tab. See @/lib/request-context.
 */
export async function updateSession(request: NextRequest) {
  const reqId = resolveRequestId(request.headers);
  // Mutating the NextRequest's headers is what makes the id visible downstream:
  // `NextResponse.next({ request })` forwards these headers to the app.
  request.headers.set(REQUEST_ID_HEADER, reqId);

  const elapsed = startTimer();
  const { pathname } = request.nextUrl;
  const requestLog = log.child({ reqId });
  requestLog.debug("proxy.request.start", {
    method: request.method,
    path: pathname,
  });

  const supabaseResponse = NextResponse.next({ request });
  supabaseResponse.headers.set(REQUEST_ID_HEADER, reqId);

  // Before Supabase env vars are configured (e.g. .env.local not filled in yet),
  // skip session refresh entirely. createServerClient throws on empty url/key,
  // which would otherwise 500 every route and hide the Phase 0 status page.
  // NOTE: route protection below also will not run until these are set.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    requestLog.debug("proxy.request.skipped", {
      path: pathname,
      reason: "supabase env not configured",
      durationMs: elapsed(),
    });
    return supabaseResponse;
  }

  return refreshSession(request, supabaseResponse, reqId, elapsed);
}

/**
 * Public paths that do NOT require authentication. Everything else is gated.
 * `/auth` covers any email-confirmation / callback routes added later.
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/signup" ||
    pathname.startsWith("/signup/") ||
    pathname.startsWith("/auth")
  );
}

/**
 * Build a redirect response that carries over the refreshed Supabase auth
 * cookies AND the anti-cache headers from `source`. Without copying these, the
 * refreshed session would be dropped on the redirect, and a CDN could cache one
 * user's session for another.
 */
function redirectPreservingSession(
  request: NextRequest,
  pathname: string,
  source: NextResponse,
  reqId: string,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  const redirectResponse = NextResponse.redirect(url);

  source.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie);
  });

  // Carry the anti-cache headers (Cache-Control/Expires/Pragma) that the SSR
  // client set, so any response carrying auth cookies is never cached.
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = source.headers.get(header);
    if (value) {
      redirectResponse.headers.set(header, value);
    }
  }
  redirectResponse.headers.set(REQUEST_ID_HEADER, reqId);

  return redirectResponse;
}

async function refreshSession(
  request: NextRequest,
  initialResponse: NextResponse,
  reqId: string,
  elapsed: () => number,
) {
  let supabaseResponse = initialResponse;
  const requestLog = log.child({ reqId });
  let cookiesWritten = 0;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesWritten += cookiesToSet.length;
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          supabaseResponse.headers.set(REQUEST_ID_HEADER, reqId);
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
          // @supabase/ssr 0.12.0 passes anti-cache headers
          // (Cache-Control/Expires/Pragma) that MUST be set on any response
          // carrying refreshed auth cookies so a CDN/reverse proxy never
          // caches one user's session and serves it to another.
          if (headers) {
            Object.entries(headers).forEach(([key, value]) =>
              supabaseResponse.headers.set(key, value),
            );
          }
        },
      },
    },
  );

  // IMPORTANT: Do NOT run any logic between createServerClient and getUser().
  // Doing so can cause hard-to-debug random logouts.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // A getUser() error is normal for a signed-out visitor (no cookie), but a
  // network/5xx failure looks IDENTICAL to the app — everyone appears signed
  // out. Splitting the two here turns "random logouts" into a one-line answer.
  if (error && error.status !== 400 && error.status !== 401) {
    requestLog.error("proxy.session.refresh_failed", {
      path: pathname,
      status: error.status,
      code: error.code,
      message: error.message,
      hint: "Supabase Auth unreachable or rejecting — users will be treated as signed out",
    });
  }

  // Phase 1 route protection (optimistic pre-filter; secure getUser() checks
  // also live per-page in the Server Components themselves).

  // Unauthenticated user hitting a protected route -> /login.
  if (!user && !isPublicPath(pathname)) {
    requestLog.info("proxy.redirect.unauthenticated", {
      from: pathname,
      to: "/login",
      durationMs: elapsed(),
    });
    return redirectPreservingSession(request, "/login", supabaseResponse, reqId);
  }

  // Authenticated user hitting the auth pages -> /dashboard.
  if (user && (pathname === "/login" || pathname === "/signup")) {
    requestLog.info("proxy.redirect.authenticated", {
      userId: user.id,
      from: pathname,
      to: "/dashboard",
      durationMs: elapsed(),
    });
    return redirectPreservingSession(
      request,
      "/dashboard",
      supabaseResponse,
      reqId,
    );
  }

  requestLog.debug("proxy.request.ok", {
    method: request.method,
    path: pathname,
    userId: user?.id ?? null,
    // Non-zero means the access token was rotated on this request — the thing
    // to check first when a session dies mid-use.
    authCookiesWritten: cookiesWritten,
    durationMs: elapsed(),
  });

  return supabaseResponse;
}
