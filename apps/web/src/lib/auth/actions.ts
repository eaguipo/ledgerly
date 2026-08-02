"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { maskEmail, startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";

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
 *
 * Logging rules for this file, which handles credentials:
 *  - passwords are NEVER logged, not even their length;
 *  - emails are masked (a***e@example.com) — enough to follow one person's
 *    attempts through the log, not enough to harvest addresses;
 *  - Supabase `error.code` IS logged. The message shown to the user is
 *    deliberately vague for anti-enumeration reasons, so the code is the only
 *    way to tell "wrong password" from "unconfirmed email" from "Auth is down".
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
  const log = await requestLogger({ action: "login" });
  const elapsed = startTimer();
  const { email, password } = readCredentials(formData);

  if (!email || !password) {
    log.warn("auth.login.invalid", {
      reason: !email ? "missing email" : "missing password",
    });
    return { status: "error", message: "Email and password are required." };
  }

  log.debug("auth.login.start", { email: maskEmail(email) });

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // A known code is a normal, expected rejection; an unknown one usually
    // means Supabase Auth itself is unhappy (rate limit, outage, misconfig).
    const known =
      error.code === "email_not_confirmed" || error.code === "invalid_credentials";
    const fields = {
      email: maskEmail(email),
      code: error.code,
      status: error.status,
      message: error.message,
      durationMs: elapsed(),
    };
    if (known) log.warn("auth.login.rejected", fields);
    else log.error("auth.login.failed", fields);

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

  log.info("auth.login.ok", {
    userId: data.user?.id,
    email: maskEmail(email),
    durationMs: elapsed(),
  });

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
  const log = await requestLogger({ action: "signup" });
  const elapsed = startTimer();
  const { email, password } = readCredentials(formData);

  if (!email || !password) {
    log.warn("auth.signup.invalid", {
      reason: !email ? "missing email" : "missing password",
    });
    return { status: "error", message: "Email and password are required." };
  }
  if (password.length < 6) {
    log.warn("auth.signup.invalid", {
      email: maskEmail(email),
      reason: "password shorter than 6 characters",
    });
    return {
      status: "error",
      message: "Password must be at least 6 characters.",
    };
  }

  const supabase = await createClient();
  const headersList = await headers();
  const origin = headersList.get("origin") ?? "http://localhost:3000";

  // The confirmation email links back to `origin` — if that is wrong (proxy not
  // forwarding Origin, wrong ingress host) every confirmation link 404s, and
  // this line is where you find out.
  log.debug("auth.signup.start", {
    email: maskEmail(email),
    emailRedirectTo: `${origin}/auth/callback`,
  });

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });

  if (error) {
    const known =
      error.code === "user_already_exists" ||
      error.code === "email_exists" ||
      error.code === "weak_password" ||
      error.code === "over_email_send_rate_limit";
    const fields = {
      email: maskEmail(email),
      code: error.code,
      status: error.status,
      message: error.message,
      durationMs: elapsed(),
    };
    if (known) log.warn("auth.signup.rejected", fields);
    else log.error("auth.signup.failed", fields);

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
    log.info("auth.signup.confirm_email_sent", {
      userId: data.user?.id,
      email: maskEmail(email),
      durationMs: elapsed(),
    });
    return { status: "confirm_email", email };
  }

  // "Confirm email" is disabled: a session exists, user is logged in.
  log.info("auth.signup.ok", {
    userId: data.user?.id,
    email: maskEmail(email),
    autoSignedIn: true,
    durationMs: elapsed(),
  });
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * Sign out the CURRENT session only (scope: 'local' — the default is 'global',
 * which would sign the user out of every device). Then redirect to /login.
 * Used as a plain <form action={signout}> action, so it takes no args.
 */
export async function signout(): Promise<void> {
  const log = await requestLogger({ action: "signout" });
  const elapsed = startTimer();
  const supabase = await createClient();

  // Read the id from the cookie (no network call) before it is torn down.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) {
    // The cookies are cleared regardless, so the user still lands signed out —
    // but a recurring error here means the Auth server is rejecting revocations.
    log.error("auth.signout.failed", {
      userId: session?.user?.id ?? null,
      code: error.code,
      status: error.status,
      message: error.message,
      durationMs: elapsed(),
    });
  } else {
    log.info("auth.signout.ok", {
      userId: session?.user?.id ?? null,
      durationMs: elapsed(),
    });
  }

  revalidatePath("/", "layout");
  redirect("/login");
}
