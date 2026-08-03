import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { dbError, startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { categoryDisplay } from "./constants";
import { distinctLabels } from "@/lib/custom-choice";
import { PortfolioForm } from "./portfolio-form";
import { createPortfolio, archivePortfolio, restorePortfolio } from "./actions";
import { parseSort, sortColumn, sortHref, directionOf } from "./sorting";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Th, SortableTh, Tr, Td } from "@/components/ui/table";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";

export const metadata: Metadata = { title: "Portfolios" };

interface CurrencyEmbed {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface PortfolioRow {
  id: string;
  name: string;
  category: string;
  /** The user's own name for an 'others' account; null on the enum's members. */
  category_label: string | null;
  currency_id: string;
  current_balance: number | string;
  is_savings: boolean;
  is_liquid: boolean;
  is_archived: boolean;
  institution: string | null;
  currency: CurrencyEmbed | CurrencyEmbed[] | null;
}

function currencyOf(p: PortfolioRow): CurrencyEmbed | undefined {
  const c = Array.isArray(p.currency) ? p.currency[0] : p.currency;
  return c ?? undefined;
}

export default async function PortfoliosPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string | string[]; dir?: string | string[] }>;
}) {
  const sort = parseSort(await searchParams); // Next 16: search params are async.

  const log = await requestLogger({ page: "/portfolios" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("portfolios.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // A header sort replaces the manual `sort_order` ordering rather than
  // refining it — leading with `sort_order` would win every comparison and the
  // click would look like it did nothing. `created_at` stays as the tiebreaker
  // either way so equal rows never shuffle between renders.
  const orderBy = sort
    ? [sortColumn(sort), { column: "created_at", ascending: true }]
    : [
        { column: "is_archived", ascending: true },
        { column: "sort_order", ascending: true },
        { column: "created_at", ascending: true },
      ];

  let portfoliosQuery = supabase
    .from("portfolios")
    .select(
      "id, name, category, category_label, currency_id, current_balance, is_savings, is_liquid, is_archived, institution, currency:currencies(code, symbol, minor_unit)",
    );

  for (const { column, ascending } of orderBy) {
    portfoliosQuery = portfoliosQuery.order(column, { ascending });
  }

  const [
    { data: currencies, error: currenciesError },
    { data: profile, error: profileError },
    { data: portfolios, error: portfoliosError },
  ] = await Promise.all([
    supabase
      .from("currencies")
      .select("id, code, symbol, name, minor_unit")
      .eq("is_active", true)
      .order("code"),
    supabase
      .from("profiles")
      .select("default_currency_id")
      .eq("id", user.id)
      .single(),
    portfoliosQuery,
  ]);

  // An empty `currencies` list silently disables the whole add-account form
  // (no currency to pick), which reads as a UI bug rather than a data one.
  if (currenciesError) {
    pageLog.error("portfolios.currencies.load_failed", dbError(currenciesError));
  }
  if (profileError) {
    pageLog.warn("portfolios.profile.load_failed", dbError(profileError));
  }
  if (portfoliosError) {
    pageLog.error("portfolios.list.load_failed", dbError(portfoliosError));
  }

  const rows = (portfolios ?? []) as PortfolioRow[];
  const active = rows.filter((p) => !p.is_archived);
  const archived = rows.filter((p) => p.is_archived);
  // Names the user has already invented, offered back in the add form. Taken
  // from the rows already fetched — including archived ones, since a category
  // you named once is still a category you might reuse — rather than a query.
  const customCategories = distinctLabels(rows.map((p) => p.category_label));

  pageLog.info("portfolios.load.ok", {
    active: active.length,
    archived: archived.length,
    currencyOptions: currencies?.length ?? 0,
    defaultCurrencyId: profile?.default_currency_id ?? null,
    sort: sort ? `${sort.key}:${sort.dir}` : "default",
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <PageHeader
        title="Portfolios"
        description="Every account you hold money in, and what's currently in it."
      />

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHeader
              title="Your accounts"
              description={`${active.length} active`}
            />
            {active.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="No accounts yet"
                  description="Add your first account using the form — balances, expenses and net worth all follow from it."
                />
              </CardBody>
            ) : (
              <Table
                label="Your accounts"
                head={
                  <>
                    <SortableTh
                      href={sortHref("name", sort)}
                      direction={directionOf("name", sort)}
                    >
                      Account
                    </SortableTh>
                    <SortableTh
                      href={sortHref("category", sort)}
                      direction={directionOf("category", sort)}
                    >
                      Category
                    </SortableTh>
                    <SortableTh
                      align="right"
                      href={sortHref("balance", sort)}
                      direction={directionOf("balance", sort)}
                    >
                      Balance
                    </SortableTh>
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </>
                }
              >
                {active.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/portfolios/${p.id}`}
                          className="font-medium text-ink hover:text-accent"
                        >
                          {p.name}
                        </Link>
                        {p.is_liquid ? <Badge tone="accent">liquid</Badge> : null}
                      </span>
                      {p.institution ? (
                        <span className="mt-0.5 block text-xs text-faint">
                          {p.institution}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="text-[13px] text-muted">
                        {categoryDisplay(p.category, p.category_label)}
                      </span>
                    </Td>
                    <Td align="right">
                      <Money
                        amount={p.current_balance}
                        currency={currencyOf(p)}
                        className="font-medium text-ink"
                      />
                    </Td>
                    <Td align="right">
                      <span className="flex items-center justify-end gap-1">
                        <Link
                          href={`/portfolios/${p.id}`}
                          className="rounded-lg px-2 py-1 text-[13px] text-muted transition-colors hover:bg-raised hover:text-ink"
                        >
                          Edit
                        </Link>
                        <form action={archivePortfolio}>
                          <input type="hidden" name="id" value={p.id} />
                          <button
                            type="submit"
                            className="rounded-lg px-2 py-1 text-[13px] text-muted transition-colors hover:bg-negative-soft hover:text-negative"
                          >
                            Archive
                          </button>
                        </form>
                      </span>
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          {archived.length > 0 ? (
            <Card className="mt-5">
              <CardHeader
                title="Archived"
                description={`${archived.length} hidden from balances and totals`}
              />
              <Table
                label="Archived accounts"
                head={
                  // Both tables come from one query, so a sort reorders the
                  // archived rows too. Making these headers live as well keeps
                  // that visible instead of looking like a random reshuffle.
                  <>
                    <SortableTh
                      href={sortHref("name", sort)}
                      direction={directionOf("name", sort)}
                    >
                      Account
                    </SortableTh>
                    <SortableTh
                      align="right"
                      href={sortHref("balance", sort)}
                      direction={directionOf("balance", sort)}
                    >
                      Balance
                    </SortableTh>
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </>
                }
              >
                {archived.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <span className="text-muted">{p.name}</span>
                      <span className="ml-2 text-xs text-faint">
                        {categoryDisplay(p.category, p.category_label)}
                      </span>
                    </Td>
                    <Td align="right">
                      <Money
                        amount={p.current_balance}
                        currency={currencyOf(p)}
                        className="text-muted"
                      />
                    </Td>
                    <Td align="right">
                      <form action={restorePortfolio}>
                        <input type="hidden" name="id" value={p.id} />
                        <button
                          type="submit"
                          className="rounded-lg px-2 py-1 text-[13px] font-medium text-accent transition-colors hover:bg-accent-soft"
                        >
                          Restore
                        </button>
                      </form>
                    </Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          ) : null}
        </div>

        <Card className="lg:col-span-2 lg:sticky lg:top-6">
          <CardHeader title="Add an account" />
          <CardBody>
            <PortfolioForm
              mode="create"
              action={createPortfolio}
              currencies={currencies ?? []}
              defaultCurrencyId={profile?.default_currency_id ?? undefined}
              customCategories={customCategories}
              submitLabel="Add account"
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
