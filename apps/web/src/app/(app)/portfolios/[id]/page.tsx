import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PortfolioForm } from "../portfolio-form";
import { updatePortfolio } from "../actions";
import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Edit account" };

export default async function EditPortfolioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: portfolio }, { data: currencies }] = await Promise.all([
    supabase
      .from("portfolios")
      .select("id, name, category, currency_id, is_savings, institution")
      .eq("id", id)
      .single(), // RLS scopes this to the owner; others get no row.
    supabase
      .from("currencies")
      .select("id, code, symbol, name, minor_unit")
      .eq("is_active", true)
      .order("code"),
  ]);

  if (!portfolio) redirect("/portfolios");

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href="/portfolios"
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← Portfolios
        </Link>
      </nav>

      <div className="max-w-xl">
        <Card>
          <CardHeader
            title="Edit account"
            description={portfolio.name}
          />
          <CardBody>
            <PortfolioForm
              mode="edit"
              action={updatePortfolio}
              currencies={currencies ?? []}
              portfolio={portfolio}
              submitLabel="Save changes"
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
