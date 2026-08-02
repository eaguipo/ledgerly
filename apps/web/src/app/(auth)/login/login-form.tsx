"use client";

import { useActionState } from "react";
import { login, type AuthState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/feedback";

const initialState: AuthState = { status: "idle" };

/**
 * Login form (Client Component — needs useActionState for pending/errors).
 * The Server Action `login` is imported (you cannot DEFINE a Server Action in a
 * Client Component) and passed to <form action>. With useActionState the action
 * is invoked as (prevState, formData); we only read formData inside the action.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

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
          autoComplete="current-password"
          required
        />
      </Field>

      {/* Mounted always, filled conditionally — see Alert's note on live regions. */}
      <Alert tone="error">
        {state.status === "error" ? state.message : null}
      </Alert>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
