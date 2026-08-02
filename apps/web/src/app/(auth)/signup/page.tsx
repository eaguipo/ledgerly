import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { SignupForm } from "./signup-form";
import { Card, CardBody } from "@/components/ui/card";

export const metadata: Metadata = { title: "Create your account" };

/**
 * Signup page (Server Component). Redirects already-authenticated users to
 * /dashboard. The SignupForm handles the "check your email" state when Supabase
 * "Confirm email" is enabled.
 */
export default async function SignupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Create your account
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          Use your email and a password of at least 6 characters.
        </p>
      </div>

      <Card>
        <CardBody>
          <SignupForm />
        </CardBody>
      </Card>

      <p className="mt-5 text-center text-[13px] text-muted">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
