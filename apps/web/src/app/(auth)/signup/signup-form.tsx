"use client";

import { useActionState } from "react";
import { signup, type AuthState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";

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
      <div className="rounded-xl bg-accent-soft px-4 py-4 text-[13px] text-accent">
        <p className="font-semibold">
          Check your email to confirm your account
        </p>
        <p className="mt-1.5">
          We sent a confirmation link to{" "}
          <span className="font-medium">{state.email}</span>. Click it to finish
          creating your account, then sign in.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <Field label="Email" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          required
        />
      </Field>

      {state.status === "error" ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
