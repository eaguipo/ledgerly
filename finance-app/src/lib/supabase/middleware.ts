import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session on every request and keeps the auth
 * cookies in sync between the request and the response.
 *
 * Phase 1: in addition to refreshing the session, this now gates protected
 * routes — unauthenticated users are redirected to /login, and authenticated
 * users visiting /login or /signup are redirected to /dashboard.
 */
export async function updateSession(request: NextRequest) {
  const supabaseResponse = NextResponse.next({ request });

  // Before Supabase env vars are configured (e.g. .env.local not filled in yet),
  // skip session refresh entirely. createServerClient throws on empty url/key,
  // which would otherwise 500 every route and hide the Phase 0 status page.
  // NOTE: route protection below also will not run until these are set.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return supabaseResponse;
  }

  return refreshSession(request, supabaseResponse);
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

  return redirectResponse;
}

async function refreshSession(
  request: NextRequest,
  initialResponse: NextResponse,
) {
  let supabaseResponse = initialResponse;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
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
  } = await supabase.auth.getUser();

  // Phase 1 route protection (optimistic pre-filter; secure getUser() checks
  // also live per-page in the Server Components themselves).
  const { pathname } = request.nextUrl;

  // Unauthenticated user hitting a protected route -> /login.
  if (!user && !isPublicPath(pathname)) {
    return redirectPreservingSession(request, "/login", supabaseResponse);
  }

  // Authenticated user hitting the auth pages -> /dashboard.
  if (user && (pathname === "/login" || pathname === "/signup")) {
    return redirectPreservingSession(request, "/dashboard", supabaseResponse);
  }

  return supabaseResponse;
}
