import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { InvestmentForm } from "./investment-form";
import { ValuationForm } from "./valuation-form";
import { closeInvestment, reopenInvestment } from "./actions";
import {
  formatDate,
  formatQuantity,
  hasMatured,
  investmentKindLabel,
  one,
  returnPct,
  todayIso,
} from "./constants";
import type {
  Currency,
  CurrencyOption,
  InvestmentAccount,
  InvestmentRow,
} from "./types";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, Eyebrow } from "@/components/ui/card";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Investments" };

/** A single-action form button — close/reopen share it. */
function ActionButton({
  id,
  action,
  label,
  variant = "secondary",
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
  label: string;
  variant?: "secondary" | "danger";
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant={variant} size="sm">
        {label}
      </Button>
    </form>
  );
}

/**
 * Invested vs current value per currency.
 *
 * Currencies are never summed together — there is no FX conversion in v1
 * (roadmap Phase 4, decision D4), and adding PHP to USD invents a number. Nor is
 * any of this added to a cash balance: liquid money and invested value are
 * different kinds of thing (Rule 17), and a single "net worth" that folds them
 * together is exactly what this page exists to avoid.
 */
function totalsByCurrency(investments: InvestmentRow[]) {
  const totals = new Map<
    string,
    { invested: number; current: number; currency: Currency | undefined }
  >();
  for (const inv of investments) {
    const currency = one(inv.currency);
    const code = currency?.code ?? "—";
    const prev = totals.get(code);
    totals.set(code, {
      invested: (prev?.invested ?? 0) + Number(inv.invested_amount),
      current: (prev?.current ?? 0) + Number(inv.current_value),
      currency: currency ?? prev?.currency,
    });
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function InvestmentCard({
  investment,
  today,
}: {
  investment: InvestmentRow;
  today: string;
}) {
  const currency = one(investment.currency);
  const funding = one(investment.portfolio);
  const invested = Number(investment.invested_amount);
  const current = Number(investment.current_value);
  const gain = current - invested;
  const pct = returnPct(invested, current);
  const matured = hasMatured(investment.maturity_date, today);
  const quantity = formatQuantity(investment.quantity);

  return (
    <Card as="article">
      <CardBody className="space-y-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold tracking-tight text-ink">
              <Link
                href={`/investments/${investment.id}`}
                className="underline-offset-4 hover:underline"
              >
                {investment.name}
              </Link>
            </h3>
            <p className="mt-0.5 text-xs text-faint">
              {investmentKindLabel(investment.kind, investment.kind_label)}
              {investment.symbol ? ` · ${investment.symbol}` : ""}
              {quantity ? ` · ${quantity} units` : ""}
            </p>
          </div>
          <span className="flex flex-wrap items-center gap-1.5">
            {matured ? <Badge>matured</Badge> : null}
            {!investment.is_active ? <Badge>closed</Badge> : null}
          </span>
        </div>

        <div>
          <p className="flex flex-wrap items-baseline gap-1.5">
            <Money
              amount={current}
              currency={currency}
              className="text-xl font-semibold tracking-tight"
            />
            <span className="text-[13px] text-muted">
              from {formatMoney(invested, currency)}
            </span>
          </p>
          <p className="mt-1 text-[13px]">
            {/* A loss is normal, not an error state — colour it, don't hide it.
                `sign` formats the magnitude, so the ± is never doubled up. */}
            <Money
              amount={gain}
              currency={currency}
              sign={gain < 0 ? "negative" : "positive"}
            />
            <span className="ml-1.5 text-muted">
              {/* Null when the cost basis is zero: an asset you were given has
                  no meaningful return, and 0% would claim it broke even. */}
              {pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
            </span>
          </p>
          <p className="mt-1.5 text-xs text-faint">
            {investment.opened_on ? `Opened ${formatDate(investment.opened_on)}` : "No open date"}
            {investment.maturity_date
              ? ` · matures ${formatDate(investment.maturity_date)}`
              : ""}
            {funding ? ` · funded from ${funding.name}` : ""}
          </p>
        </div>

        {investment.is_active ? (
          <ValuationForm investment={investment} compact />
        ) : (
          <p className="text-[13px] text-muted">
            Closed. Reopen it to record a new value.
          </p>
        )}

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {investment.is_active ? (
            <ActionButton
              id={investment.id}
              action={closeInvestment}
              label="Close"
            />
          ) : (
            <ActionButton
              id={investment.id}
              action={reopenInvestment}
              label="Reopen"
            />
          )}
          <Link
            href={`/investments/${investment.id}`}
            className="self-center text-[13px] text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            History
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

export default async function InvestmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ closed?: string }>;
}) {
  const { closed } = await searchParams; // Next 16: search params are async.
  const showClosed = closed === "1";

  const log = await requestLogger({ page: "/investments" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("investments.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // Investment data goes through ledgerFetch (mesh or in-process, see
  // lib/ledger.ts). The profile is a plain preference, not ledger data, so it
  // comes straight off the RLS-scoped client like every other page reads it.
  const [optionsRes, listRes, { data: profile }] = await Promise.all([
    ledgerFetch("/ledger/investments/options"),
    ledgerFetch(
      `/ledger/investments?limit=200${showClosed ? "&include_inactive=true" : ""}`,
    ),
    supabase.from("profiles").select("default_currency_id").eq("id", user.id).single(),
  ]);

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: InvestmentAccount[];
        currencies?: CurrencyOption[];
        kind_labels?: string[];
      })
    : {};
  const accounts = options.portfolios ?? [];
  const currencies = options.currencies ?? [];
  const kindLabels = options.kind_labels ?? [];

  const list = listRes.ok
    ? ((await listRes.json()) as { investments?: InvestmentRow[] })
    : {};
  const investments = list.investments ?? [];

  const serviceError = !optionsRes.ok || !listRes.ok;
  const today = todayIso();
  const open = investments.filter((i) => i.is_active);
  const totals = totalsByCurrency(open);
  const maturedCount = open.filter((i) => hasMatured(i.maturity_date, today)).length;

  // A holding needs no account at all — only a currency, since recording one
  // moves no money.
  const canCreate = currencies.length > 0;

  if (serviceError) {
    pageLog.error("investments.load.degraded", {
      optionsStatus: optionsRes.status,
      listStatus: listRes.status,
      failed: [
        !optionsRes.ok ? "options" : null,
        !listRes.ok ? "list" : null,
      ].filter(Boolean),
      durationMs: elapsed(),
    });
  } else {
    pageLog.info("investments.load.ok", {
      investments: investments.length,
      open: open.length,
      matured: maturedCount,
      currencies: totals.length,
      showClosed,
      accounts: accounts.length,
      formAvailable: canCreate,
      durationMs: elapsed(),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Investments"
        description="What you hold that isn't spendable cash. Tracked separately from your balances — values here are unrealised until you sell."
        action={
          <Link
            href={showClosed ? "/investments" : "/investments?closed=1"}
            className="text-[13px] text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            {showClosed ? "Hide closed" : "Show closed"}
          </Link>
        }
      />

      {serviceError ? (
        <div className="mb-5">
          <Alert tone="error">
            Couldn&apos;t reach the investment service. Some data may be missing
            — please try again shortly.
          </Alert>
        </div>
      ) : null}

      {totals.length > 0 ? (
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardBody>
              <Eyebrow>Current value</Eyebrow>
              <div className="mt-2 space-y-1">
                {totals.map(([code, t]) => (
                  <p
                    key={code}
                    className="figure text-2xl font-semibold tracking-tight text-ink"
                  >
                    {formatMoney(t.current, t.currency)}
                    <span className="ml-1.5 text-[13px] font-normal text-muted">
                      from {formatMoney(t.invested, t.currency)}
                    </span>
                  </p>
                ))}
              </div>
              <p className="mt-1 text-[13px] text-muted">
                across {open.length} {open.length === 1 ? "holding" : "holdings"}
                {totals.length > 1 ? " · shown per currency" : ""}
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <Eyebrow>Unrealised gain</Eyebrow>
              <div className="mt-2 space-y-1">
                {totals.map(([code, t]) => {
                  const gain = t.current - t.invested;
                  const pct = returnPct(t.invested, t.current);
                  return (
                    <p key={code} className="text-2xl font-semibold tracking-tight">
                      <Money
                        amount={gain}
                        currency={t.currency}
                        sign={gain < 0 ? "negative" : "positive"}
                      />
                      <span className="ml-1.5 text-[13px] font-normal text-muted">
                        {pct === null
                          ? "—"
                          : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
                      </span>
                    </p>
                  );
                })}
              </div>
              <p className="mt-1 text-[13px] text-muted">
                {maturedCount > 0
                  ? `${maturedCount} past its maturity date`
                  : "Not counted as cash until you sell"}
              </p>
            </CardBody>
          </Card>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {investments.length === 0 ? (
            <Card>
              <CardBody>
                <EmptyState
                  title={serviceError ? "Investments unavailable" : "No investments yet"}
                  description={
                    serviceError
                      ? "The investment service didn't respond, so this list can't be shown right now."
                      : showClosed
                        ? "Nothing here, open or closed."
                        : "Record what you hold — MP2, crypto, stocks, or anything else you'd type in yourself."
                  }
                />
              </CardBody>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {investments.map((i) => (
                <InvestmentCard key={i.id} investment={i} today={today} />
              ))}
            </div>
          )}
        </div>

        <Card className="lg:col-span-2 lg:sticky lg:top-6">
          <CardHeader title="New investment" />
          <CardBody>
            {serviceError || !canCreate ? (
              <p className="text-[13px] text-muted">
                Currencies couldn&apos;t be loaded, so the form is unavailable
                until the investment service is reachable again.
              </p>
            ) : (
              <InvestmentForm
                accounts={accounts}
                currencies={currencies}
                kindLabels={kindLabels}
                defaultCurrencyId={profile?.default_currency_id ?? undefined}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
