import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";
import { Card, CardBody } from "@/components/ui/card";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Login page (Server Component). The proxy already redirects unauthenticated
 * users here, but we also redirect AUTHENTICATED users away to /dashboard so a
 * logged-in user never sees the login form. getUser() network-verifies the JWT
 * (the only safe server-side auth check).
 */
export default async function LoginPage() {
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
          Welcome back
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          Sign in to pick up where your money left off.
        </p>
      </div>

      <Card>
        <CardBody>
          <LoginForm />
        </CardBody>
      </Card>

      <p className="mt-5 text-center text-[13px] text-muted">
        Don&apos;t have an account?{" "}
        <Link
          href="/signup"
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          Create one
        </Link>
      </p>
    </>
  );
}
