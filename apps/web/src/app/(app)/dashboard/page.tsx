import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { dbError, startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { formatMoney } from "@/lib/format";
import { categoryLabel } from "../portfolios/constants";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader, Eyebrow } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { AllocationBars } from "@/components/charts/allocation-bars";
import { TrendChart, type TrendPoint } from "@/components/charts/trend-chart";

export const metadata: Metadata = { title: "Dashboard" };

const TREND_DAYS = 30;
/** Ceiling for the trend query; see `trendComplete` below. */
const TREND_ROW_LIMIT = 5000;

interface CurrencyInfo {
  id?: string;
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface PortfolioRow {
  id: string;
  category: string;
  current_balance: number | string;
  currency_id: string;
  currency: CurrencyInfo | CurrencyInfo[] | null;
}

interface TxnRow {
  txn_date: string;
  signed_amount: number | string;
  currency_id: string;
}

/** Only the fields the headline debt figures need — see the query below. */
interface DebtSummaryRow {
  kind: string;
  outstanding_balance: number | string;
  currency_id: string;
  due_date: string | null;
}

/** Only the fields the headline goal figures need — see the query below. */
interface GoalSummaryRow {
  target_amount: number | string;
  current_amount: number | string;
  currency_id: string;
  status: string;
}

function one<T>(v: T | T[] | null | undefined): T | undefined {
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}

/**
 * Snap a running total back onto the currency's minor unit.
 *
 * Postgres `numeric(38,18)` arrives as a string and becomes a float here, so
 * subtracting a day's flows back out of the current balance leaves residue —
 * an account opened inside the window lands on 2.9e-14 instead of 0. That
 * residue is invisible in the formatted figure but catastrophic as a divisor.
 */
function roundToMinorUnit(value: number, minorUnit: number | null | undefined) {
  const factor = 10 ** (minorUnit ?? 2);
  return Math.round(value * factor) / factor;
}

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Explicit locale so the server render and the client render always match. */
function shortDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Reconstructs the closing balance for each of the last N days by walking the
 * current balance backwards through `transactions.signed_amount`:
 *
 *   balance(d) = balance(d + 1) − netFlow(d + 1)
 *
 * Same-currency transfers net to zero across the pair, so a currency total only
 * moves on real inflows and outflows. This is measured history, not a forecast.
 */
function buildTrend(
  currentTotal: number,
  txns: TxnRow[],
  currencyId: string,
  currency: CurrencyInfo | undefined,
): TrendPoint[] {
  const netByDay = new Map<string, number>();
  for (const t of txns) {
    if (t.currency_id !== currencyId) continue;
    netByDay.set(
      t.txn_date,
      (netByDay.get(t.txn_date) ?? 0) + Number(t.signed_amount),
    );
  }

  const days: string[] = [];
  for (let i = TREND_DAYS; i >= 0; i--) days.push(isoDaysAgo(i));

  // Today's closing balance is what we have; step backwards from there.
  const values = new Array<number>(days.length);
  let running = currentTotal;
  for (let i = days.length - 1; i >= 0; i--) {
    values[i] = running;
    running -= netByDay.get(days[i]) ?? 0;
  }

  return days.map((iso, i) => {
    const value = roundToMinorUnit(values[i], currency?.minor_unit);
    return {
      label: shortDate(iso),
      value,
      display: formatMoney(value, currency),
    };
  });
}

export default async function DashboardPage() {
  const log = await requestLogger({ page: "/dashboard" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("dashboard.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const [
    { data: profile, error: profileError },
    { data: portfolios, error: portfoliosError },
    { data: debts, error: debtsError },
    { data: goals, error: goalsError },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("default_currency_id")
      .eq("id", user.id)
      .single(),
    supabase
      .from("portfolios")
      .select(
        "id, category, current_balance, currency_id, currency:currencies(id, code, symbol, minor_unit)",
      )
      .eq("is_archived", false),
    // Settled and written-off debts are excluded here rather than in the render:
    // neither is money anyone still expects to move, and a written-off debt keeps
    // a non-zero outstanding balance that would otherwise inflate the total.
    supabase
      .from("debts")
      .select("kind, outstanding_balance, currency_id, due_date")
      .eq("is_archived", false)
      .in("status", ["open", "partially_paid"]),
    // Archived and cancelled goals are excluded: neither is something the user
    // is still working toward, so neither belongs in a progress figure.
    supabase
      .from("goals")
      .select("target_amount, current_amount, currency_id, status")
      .in("status", ["active", "achieved"]),
  ]);

  // These queries discard their errors into an empty render. Logging them is the
  // difference between "the dashboard says I have no accounts" being a data
  // question and being a five-minute mystery.
  if (profileError) {
    // PGRST116 = .single() matched no row: the profiles trigger never ran for
    // this user. The page still renders, just without a default currency.
    pageLog.warn("dashboard.profile.load_failed", dbError(profileError));
  }
  if (portfoliosError) {
    pageLog.error("dashboard.portfolios.load_failed", dbError(portfoliosError));
  }
  if (debtsError) {
    // Not fatal — the debt card just doesn't render — but silently dropping it
    // reads as "I have no debts", which is the wrong thing to believe.
    pageLog.error("dashboard.debts.load_failed", dbError(debtsError));
  }
  if (goalsError) {
    pageLog.error("dashboard.goals.load_failed", dbError(goalsError));
  }

  const rows = (portfolios ?? []) as unknown as PortfolioRow[];

  // Scope the trend to the same accounts the balances above use. Filtering by
  // explicit ids rather than an embedded join keeps this a plain `in` filter —
  // one extra round trip, but no join semantics to get subtly wrong.
  const activeIds = rows.map((p) => p.id);
  const { data: txns, error: txnsError } = activeIds.length
    ? await supabase
        .from("transactions")
        .select("txn_date, signed_amount, currency_id")
        .eq("is_void", false)
        .in("portfolio_id", activeIds)
        .gte("txn_date", isoDaysAgo(TREND_DAYS))
        // Explicit order + limit. Without them PostgREST applies its own
        // max-rows cap and returns an arbitrary subset with a 200, which would
        // silently drop flows and render a confidently wrong balance curve.
        .order("txn_date", { ascending: true })
        .limit(TREND_ROW_LIMIT)
    : { data: [], error: null };

  if (txnsError) {
    // Not fatal — the balances above still render — but the trend silently
    // flattens to today's balance, so it must not fail quietly.
    pageLog.error("dashboard.trend.load_failed", {
      accounts: activeIds.length,
      since: isoDaysAgo(TREND_DAYS),
      ...dbError(txnsError),
    });
  }

  const txnRows = (txns ?? []) as unknown as TxnRow[];
  // Coming back exactly at the limit means we cannot prove we saw every flow,
  // and a partial set makes every historical point wrong. Better to show no
  // trend than a wrong one.
  const trendComplete = txnRows.length < TREND_ROW_LIMIT;
  if (!trendComplete) {
    pageLog.warn("dashboard.trend.row_limit_hit", {
      limit: TREND_ROW_LIMIT,
      accounts: activeIds.length,
      hint: "trend suppressed — raise TREND_ROW_LIMIT or aggregate server-side",
    });
  }

  // Totals per currency, and per (currency, category) for the allocation bars.
  const byCurrency = new Map<
    string,
    { total: number; currency: CurrencyInfo; categories: Map<string, number> }
  >();
  for (const p of rows) {
    const cur = one(p.currency);
    if (!cur) continue;
    const bucket = byCurrency.get(p.currency_id) ?? {
      total: 0,
      currency: cur,
      categories: new Map<string, number>(),
    };
    const amount = Number(p.current_balance);
    bucket.total += amount;
    bucket.categories.set(
      p.category,
      (bucket.categories.get(p.category) ?? 0) + amount,
    );
    byCurrency.set(p.currency_id, bucket);
  }

  if (byCurrency.size === 0) {
    // Distinguish "new user" from "the query failed / the currency embed came
    // back null", which look identical on screen.
    pageLog.info("dashboard.load.empty", {
      portfolioRows: rows.length,
      rowsMissingCurrency: rows.filter((p) => !one(p.currency)).length,
      durationMs: elapsed(),
    });
    return (
      <PageContainer>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="No accounts yet"
          description="Add your first account and Ledgerly will start tracking balances, spending and net worth across every currency you hold."
          action={
            <ButtonLink href="/portfolios" variant="primary">
              Add an account
            </ButtonLink>
          }
        />
      </PageContainer>
    );
  }

  // The hero can only honestly show ONE currency — the schema carries no FX
  // rates, so summing across currencies would invent a number. Lead with the
  // profile's default currency, fall back to the largest holding, and list the
  // rest alongside rather than folding them in.
  const ranked = [...byCurrency.entries()].sort(
    (a, b) => b[1].total - a[1].total,
  );
  const primaryId =
    profile?.default_currency_id && byCurrency.has(profile.default_currency_id)
      ? profile.default_currency_id
      : ranked[0][0];
  const primary = byCurrency.get(primaryId)!;
  const others = ranked.filter(([id]) => id !== primaryId);

  const trend = buildTrend(primary.total, txnRows, primaryId, primary.currency);
  const opening = trend[0].value;
  const delta = roundToMinorUnit(
    primary.total - opening,
    primary.currency.minor_unit,
  );

  // Only show a percentage when the starting balance is large enough for one to
  // mean anything. If every account was opened inside the window the opening
  // balance is zero, and "grew by ∞%" is noise, not information — the absolute
  // delta already tells the whole story.
  const oneMinorUnit = 1 / 10 ** (primary.currency.minor_unit ?? 2);
  const pct =
    Math.abs(opening) >= oneMinorUnit
      ? (delta / Math.abs(opening)) * 100
      : null;

  const allocation = [...primary.categories.entries()].map(([cat, value]) => ({
    label: categoryLabel(cat),
    value,
  }));

  // Debt totals for the primary currency only, for the same reason net worth is
  // single-currency: there are no FX rates, so a combined figure would be made
  // up. Debts in other currencies still count toward the overdue nudge, which is
  // a count and needs no conversion.
  const debtRows = (debts ?? []) as unknown as DebtSummaryRow[];
  const today = isoDaysAgo(0);
  const owed = debtRows
    .filter((d) => d.kind === "payable" && d.currency_id === primaryId)
    .reduce((sum, d) => sum + Number(d.outstanding_balance), 0);
  const owedToYou = debtRows
    .filter((d) => d.kind === "receivable" && d.currency_id === primaryId)
    .reduce((sum, d) => sum + Number(d.outstanding_balance), 0);
  const overdueCount = debtRows.filter(
    (d) => d.due_date !== null && d.due_date < today,
  ).length;
  const hasDebts = debtRows.length > 0;

  // Goals, same primary-currency restriction as the debt figures above. Set
  // aside is an earmark, not a balance — nothing in these numbers has moved.
  const goalRows = (goals ?? []) as unknown as GoalSummaryRow[];
  const primaryGoals = goalRows.filter((g) => g.currency_id === primaryId);
  const setAside = primaryGoals.reduce(
    (sum, g) => sum + Number(g.current_amount),
    0,
  );
  const goalTarget = primaryGoals.reduce(
    (sum, g) => sum + Number(g.target_amount),
    0,
  );
  const goalsAchieved = goalRows.filter((g) => g.status === "achieved").length;
  const hasGoals = goalRows.length > 0;

  // The figures actually rendered. When someone reports "my net worth is wrong",
  // this line says what the page computed and from how many inputs — without it
  // the only way to check is to re-run the maths by hand.
  pageLog.info("dashboard.load.ok", {
    portfolios: rows.length,
    currencies: byCurrency.size,
    primaryCurrency: primary.currency.code,
    netWorth: primary.total,
    deltaDays: TREND_DAYS,
    delta,
    trendTxns: txnRows.length,
    trendComplete,
    usedDefaultCurrency: primaryId === profile?.default_currency_id,
    liveDebts: debtRows.length,
    debtOwed: owed,
    debtOwedToYou: owedToYou,
    debtsOverdue: overdueCount,
    liveGoals: goalRows.length,
    goalsSetAside: setAside,
    goalsAchieved,
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <PageHeader
        title="Dashboard"
        description="Your position across every account."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Hero — exactly one per view. Proportional figures, not tabular:
            equal-width digits make a large number look loose. */}
        <Card className="lg:col-span-2">
          <CardBody>
            <Eyebrow>Net worth · {primary.currency.code}</Eyebrow>
            <p className="mt-2 text-[2.75rem] font-semibold leading-none tracking-[-0.035em] text-ink">
              {formatMoney(primary.total, primary.currency)}
            </p>
            <p className="mt-3 text-[13px]">
              {!trendComplete ? (
                <span className="text-muted">
                  Too many transactions in this period to chart accurately
                </span>
              ) : delta === 0 ? (
                <span className="text-muted">
                  No change in the last {TREND_DAYS} days
                </span>
              ) : (
                <>
                  <span
                    className={
                      delta > 0
                        ? "font-medium text-positive"
                        : "font-medium text-negative"
                    }
                  >
                    {delta > 0 ? "▲" : "▼"}{" "}
                    {formatMoney(Math.abs(delta), primary.currency)}
                    {pct !== null ? ` · ${Math.abs(pct).toFixed(1)}%` : ""}
                  </span>
                  <span className="text-muted">
                    {" "}
                    in the last {TREND_DAYS} days
                  </span>
                </>
              )}
            </p>

            {/* Suppressed rather than approximated: a truncated flow set makes
                every point wrong, and a wrong chart is worse than no chart. */}
            {trendComplete ? <TrendChart points={trend} /> : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Allocation"
            description={`By category, in ${primary.currency.code}`}
          />
          <CardBody>
            <AllocationBars rows={allocation} currency={primary.currency} />
          </CardBody>
        </Card>
      </div>

      {hasDebts ? (
        <Card className="mt-5">
          <CardHeader
            title="Debts"
            description={`Outstanding in ${primary.currency.code}`}
            action={
              <ButtonLink href="/debts" variant="secondary" size="sm">
                View all
              </ButtonLink>
            }
          />
          <CardBody>
            <ul className="grid gap-4 sm:grid-cols-3">
              <li>
                <Eyebrow>You owe</Eyebrow>
                <p className="mt-1.5 text-lg font-semibold text-ink">
                  <Money amount={owed} currency={primary.currency} />
                </p>
              </li>
              <li>
                <Eyebrow>Owed to you</Eyebrow>
                <p className="mt-1.5 text-lg font-semibold text-ink">
                  <Money amount={owedToYou} currency={primary.currency} />
                </p>
              </li>
              <li>
                <Eyebrow>Past due</Eyebrow>
                <p
                  className={
                    overdueCount > 0
                      ? "mt-1.5 text-lg font-semibold text-negative"
                      : "mt-1.5 text-lg font-semibold text-ink"
                  }
                >
                  {overdueCount}
                </p>
              </li>
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {hasGoals ? (
        <Card className="mt-5">
          <CardHeader
            title="Goals"
            description={`Set aside in ${primary.currency.code} — earmarked, not moved`}
            action={
              <ButtonLink href="/goals" variant="secondary" size="sm">
                View all
              </ButtonLink>
            }
          />
          <CardBody>
            <ul className="grid gap-4 sm:grid-cols-3">
              <li>
                <Eyebrow>Set aside</Eyebrow>
                <p className="mt-1.5 text-lg font-semibold text-ink">
                  <Money amount={setAside} currency={primary.currency} />
                </p>
              </li>
              <li>
                <Eyebrow>Of target</Eyebrow>
                <p className="mt-1.5 text-lg font-semibold text-ink">
                  <Money amount={goalTarget} currency={primary.currency} />
                </p>
              </li>
              <li>
                <Eyebrow>Achieved</Eyebrow>
                <p className="mt-1.5 text-lg font-semibold text-ink">
                  {goalsAchieved}
                </p>
              </li>
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {others.length > 0 ? (
        <Card className="mt-5">
          <CardHeader
            title="Other currencies"
            description="Held separately — Ledgerly does not convert between currencies."
          />
          <CardBody>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {others.map(([id, bucket]) => (
                <li key={id}>
                  <Eyebrow>{bucket.currency.code}</Eyebrow>
                  <p className="mt-1.5 text-lg font-semibold text-ink">
                    <Money amount={bucket.total} currency={bucket.currency} />
                  </p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </PageContainer>
  );
}
