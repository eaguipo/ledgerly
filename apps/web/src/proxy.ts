import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 renamed the `middleware` file convention to `proxy` (file + export).
// The session-refresh helper at @/lib/supabase/middleware is a plain module, not
// a file convention, so it keeps its name.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on all paths except static assets and image files:
     * - _next/static, _next/image  (build output / image optimizer)
     * - favicon.ico, *.svg/png/jpg/jpeg/gif/webp  (static assets)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
