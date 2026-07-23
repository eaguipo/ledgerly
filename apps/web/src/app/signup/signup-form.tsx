"use client";

import { useActionState } from "react";
import { signup, type AuthState } from "@/lib/auth/actions";

const initialState: AuthState = { status: "idle" };

/**
 * Signup form (Client Component). On a successful signUp with "Confirm email"
 * enabled, the action returns { status: 'confirm_email', email } and we replace
 * the form with a "check your email" panel instead of redirecting into the app.
 */
export function SignupForm() {
  const [state, formAction, pending] = useActionState(signup, initialState);

  if (state.status === "confirm_email") {
    return (
      <div className="mt-6 rounded-lg bg-emerald-100 px-4 py-4 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        <p className="font-medium">Check your email to confirm your account</p>
        <p className="mt-1">
          We sent a confirmation link to{" "}
          <span className="font-medium">{state.email}</span>. Click it to finish
          creating your account, then sign in.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-6 space-y-4">
      <div className="space-y-1">
        <label
          htmlFor="email"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      <div className="space-y-1">
        <label
          htmlFor="password"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          required
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      {state.status === "error" ? (
        <p
          role="alert"
          className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-600 dark:hover:bg-emerald-500"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
