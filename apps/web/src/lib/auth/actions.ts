"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Shared auth Server Actions for Phase 1.
 *
 * Every export here is a Server Action ("use server" at file top). They are
 * reachable via direct POST, so each one re-creates the Supabase server client
 * (anon key + RLS) and lets Supabase enforce credentials — we never trust the
 * caller.
 *
 * Verified against the bundled Next.js 16 docs and @supabase/auth-js 2.108.1:
 *  - redirect() throws NEXT_REDIRECT and MUST be called outside try/catch; it
 *    returns a 303 in a Server Action (redirect.md:11,50-52). Code after it
 *    never runs, so we never `return` it.
 *  - With useActionState the action signature is (prevState, formData) — the
 *    FormData is the SECOND argument (forms.md "the Server function signature
 *    will change to receive a new prevState ... as its first argument").
 *  - createClient() from @/lib/supabase/server is async (awaits cookies()).
 *  - signUp -> AuthResponse: on success data.session is NULL when Supabase
 *    "Confirm email" is enabled (GoTrueClient.d.ts:261-263).
 *  - signInWithPassword -> AuthTokenResponsePassword (user/session non-null on
 *    success); its error is deliberately generic, so we branch on error.code
 *    ('invalid_credentials','email_not_confirmed').
 *  - signOut defaults to GLOBAL scope; we pass { scope: 'local' }.
 */

export type AuthState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "confirm_email"; email: string };

function readCredentials(formData: FormData): {
  email: string;
  password: string;
} {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  return { email, password };
}

/**
 * Sign in with email + password. On success, revalidate the layout (so server
 * components re-read the refreshed auth cookie) and redirect to /dashboard.
 * On failure, return a serializable error state for useActionState.
 */
export async function login(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const { email, password } = readCredentials(formData);

  if (!email || !password) {
    return { status: "error", message: "Email and password are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Branch on error.code (not message) — message is deliberately generic.
    if (error.code === "email_not_confirmed") {
      return {
        status: "error",
        message: "Please confirm your email address before signing in.",
      };
    }
    // invalid_credentials covers both unknown email and wrong password
    // (anti-enumeration). Show one neutral message either way.
    if (error.code === "invalid_credentials") {
      return { status: "error", message: "Invalid email or password." };
    }
    return { status: "error", message: error.message };
  }

  // Success: data.user/data.session are guaranteed non-null. The @supabase/ssr
  // client already wrote the auth cookies. Revalidate then redirect (outside any
  // try/catch so the NEXT_REDIRECT control-flow exception is not swallowed).
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * Sign up with email + password.
 *  - If "Confirm email" is ON, data.session is null -> return a confirm_email
 *    state (UI shows "check your email"); do NOT redirect into the app.
 *  - If "Confirm email" is OFF, a session exists -> redirect to /dashboard.
 * Never inserts into `profiles` — the handle_new_user() DB trigger does that.
 */
export async function signup(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const { email, password } = readCredentials(formData);

  if (!email || !password) {
    return { status: "error", message: "Email and password are required." };
  }
  if (password.length < 6) {
    return {
      status: "error",
      message: "Password must be at least 6 characters.",
    };
  }

  const supabase = await createClient();
  const headersList = await headers();
  const origin = headersList.get("origin") ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });

  if (error) {
    if (error.code === "user_already_exists" || error.code === "email_exists") {
      // Neutral message — avoid leaking account existence.
      return {
        status: "error",
        message:
          "Could not create that account. If you already have one, try signing in.",
      };
    }
    if (error.code === "weak_password") {
      return { status: "error", message: "Please choose a stronger password." };
    }
    if (error.code === "over_email_send_rate_limit") {
      return {
        status: "error",
        message: "Too many attempts. Please wait a moment and try again.",
      };
    }
    return { status: "error", message: error.message };
  }

  // Email-confirmation gate: with "Confirm email" enabled, session is null even
  // though signUp succeeded. Do NOT redirect — show the confirm state instead.
  if (!data.session) {
    return { status: "confirm_email", email };
  }

  // "Confirm email" is disabled: a session exists, user is logged in.
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * Sign out the CURRENT session only (scope: 'local' — the default is 'global',
 * which would sign the user out of every device). Then redirect to /login.
 * Used as a plain <form action={signout}> action, so it takes no args.
 */
export async function signout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  revalidatePath("/", "layout");
  redirect("/login");
}
