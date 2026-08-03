import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { dbError, startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { PortfolioForm } from "../portfolio-form";
import { updatePortfolio } from "../actions";
import { distinctLabels } from "@/lib/custom-choice";
import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Edit account" };

export default async function EditPortfolioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({ page: "/portfolios/[id]", portfolioId: id });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("portfolio.edit.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const [
    { data: portfolio, error: portfolioError },
    { data: currencies, error: currenciesError },
    { data: labelRows },
  ] = await Promise.all([
    supabase
      .from("portfolios")
      .select("id, name, category, category_label, currency_id, is_savings, institution")
      .eq("id", id)
      .single(), // RLS scopes this to the owner; others get no row.
    supabase
      .from("currencies")
      .select("id, code, symbol, name, minor_unit")
      .eq("is_active", true)
      .order("code"),
    // Category names this user has invented elsewhere, so re-categorising an
    // account can reuse one instead of spawning a near-duplicate spelling.
    // A failure here only costs autocomplete, so it is not surfaced.
    supabase
      .from("portfolios")
      .select("category_label")
      .not("category_label", "is", null),
  ]);

  if (currenciesError) {
    pageLog.error("portfolio.edit.currencies_failed", dbError(currenciesError));
  }

  if (!portfolio) {
    // Bouncing to /portfolios looks the same whether the id is a typo, the
    // account belongs to someone else (RLS returned nothing), or the query
    // errored outright. PGRST116 = "no rows", anything else is a real failure.
    pageLog.warn("portfolio.edit.not_found", {
      redirectedTo: "/portfolios",
      durationMs: elapsed(),
      ...(portfolioError ? dbError(portfolioError) : {}),
    });
    redirect("/portfolios");
  }

  pageLog.debug("portfolio.edit.load_ok", {
    currencyOptions: currencies?.length ?? 0,
    durationMs: elapsed(),
  });

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
              customCategories={distinctLabels(
                (labelRows ?? []).map((r) => r.category_label),
              )}
              submitLabel="Save changes"
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
