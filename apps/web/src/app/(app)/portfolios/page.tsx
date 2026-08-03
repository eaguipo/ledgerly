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
import {
  groupByCurrency,
  type CurrencyEmbed,
  type CurrencyGroup,
} from "./currency-groups";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Th, SortableTh, Tr, Td } from "@/components/ui/table";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Portfolios" };

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

/**
 * The strip above a currency's table. Only rendered when the user actually holds
 * more than one currency — a single-currency account list needs no banner
 * telling it which currency it is in.
 *
 * The subtotal is the only total on this page, and it exists precisely because
 * it covers one currency. There is deliberately no grand total underneath: with
 * no FX rates, summing the groups would produce a number that means nothing.
 */
function CurrencyBanner({
  group,
  showTotal = true,
}: {
  group: CurrencyGroup<PortfolioRow>;
  showTotal?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line bg-raised px-5 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
        {group.code}
      </span>
      <span className="text-[13px] text-muted">
        {showTotal ? (
          <>
            <span className="figure font-medium text-ink">
              {formatMoney(group.total, group.currency)}
            </span>{" "}
            ·{" "}
          </>
        ) : null}
        {group.rows.length} {group.rows.length === 1 ? "account" : "accounts"}
      </span>
    </div>
  );
}

/**
 * Row bodies, extracted so the grouped and ungrouped branches render the same
 * markup. Everything currency-dependent inside a row already reads its own
 * `currencyOf(p)` — grouping changes where a row sits, never how it is drawn.
 */
function ActiveRows({ rows }: { rows: PortfolioRow[] }) {
  return (
    <>
      {rows.map((p) => (
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
    </>
  );
}

function ArchivedRows({ rows }: { rows: PortfolioRow[] }) {
  return (
    <>
      {rows.map((p) => (
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
    </>
  );
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

  // Balances in different currencies are not comparable — there is no FX in v1
  // (DECISIONS-NEEDED #5) — so once there is more than one, the table splits
  // into a section each rather than presenting one ordered list. Sorting by
  // balance across currencies was the visible symptom; the subtotals are the
  // part that was missing entirely.
  const defaultCurrencyCode = currencies?.find(
    (c) => c.id === profile?.default_currency_id,
  )?.code;
  const activeGroups = groupByCurrency(
    active,
    currencyOf,
    (p) => p.current_balance,
    defaultCurrencyCode,
  );
  const archivedGroups = groupByCurrency(
    archived,
    currencyOf,
    (p) => p.current_balance,
    defaultCurrencyCode,
  );
  // Keyed off the ACTIVE groups alone: an archived account in a currency you no
  // longer hold shouldn't split the live table into sections of one.
  const multiCurrency = activeGroups.length > 1;

  // Shared between the grouped and ungrouped branches so the two can't drift.
  const activeHead = (
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
  );

  // Both tables come from one query, so a sort reorders the archived rows too.
  // Making these headers live as well keeps that visible instead of looking
  // like a random reshuffle.
  const archivedHead = (
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
  );

  pageLog.info("portfolios.load.ok", {
    active: active.length,
    archived: archived.length,
    currencies: activeGroups.length,
    grouped: multiCurrency,
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
              description={
                multiCurrency
                  ? `${active.length} active · grouped by currency, which are never added together`
                  : `${active.length} active`
              }
            />
            {active.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="No accounts yet"
                  description="Add your first account using the form — balances, expenses and everything on the dashboard follow from it."
                />
              </CardBody>
            ) : multiCurrency ? (
              // One table per currency. The rows keep the order the query gave
              // them, so a "balance descending" sort is still descending inside
              // each group — it just no longer interleaves pesos with dollars.
              activeGroups.map((group) => (
                <div key={group.code}>
                  <CurrencyBanner group={group} />
                  <Table
                    label={`Your accounts in ${group.code}`}
                    head={activeHead}
                  >
                    <ActiveRows rows={group.rows} />
                  </Table>
                </div>
              ))
            ) : (
              <Table label="Your accounts" head={activeHead}>
                <ActiveRows rows={active} />
              </Table>
            )}
          </Card>

          {archived.length > 0 ? (
            <Card className="mt-5">
              <CardHeader
                title="Archived"
                description={`${archived.length} hidden from balances and totals`}
              />
              {multiCurrency ? (
                archivedGroups.map((group) => (
                  <div key={group.code}>
                    {/* No subtotal: archived accounts are excluded from every
                        total on purpose, so showing one here would invite the
                        reader to add it to the active figures above. */}
                    <CurrencyBanner group={group} showTotal={false} />
                    <Table
                      label={`Archived accounts in ${group.code}`}
                      head={archivedHead}
                    >
                      <ArchivedRows rows={group.rows} />
                    </Table>
                  </div>
                ))
              ) : (
                <Table label="Archived accounts" head={archivedHead}>
                  <ArchivedRows rows={archived} />
                </Table>
              )}
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
