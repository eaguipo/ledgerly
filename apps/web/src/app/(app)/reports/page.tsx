import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { dbError, startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { formatMoney } from "@/lib/format";
import { incomeSourceDisplay } from "../income/constants";
import {
  PRESETS,
  dayCount,
  formatDate,
  parseQuery,
  reportHref,
  type ReportQuery,
} from "./range";
import {
  one,
  type CashflowRow,
  type CompletedGoalRow,
  type CurrencyInfo,
  type DebtOutstandingRow,
  type DebtPaymentRow,
  type ExpenseByCategoryRow,
  type IncomeBySourceRow,
  type InvestmentPerformanceRow,
  type PortfolioBalanceRow,
  type TransactionRow,
} from "./types";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader, Eyebrow } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { AllocationBars } from "@/components/charts/allocation-bars";
import { FlowBars } from "@/components/charts/flow-bars";
import { ShareDonut } from "@/components/charts/share-donut";
import { TrendChart } from "@/components/charts/trend-chart";
import { bucketFlows, granularityFor } from "./buckets";
import { TXN_SELECT, isCounted, rowLabel } from "./rows";
import { Field, Input, Select } from "@/components/ui/field";
import { Button, buttonClass } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Reports" };

/**
 * The transaction list is the one query here that is not pre-aggregated, so it
 * is the one that can run away on a wide range. Capped, with the cap detected
 * and stated rather than silently truncating — a report that quietly omits rows
 * is worse than one that admits it. Same pattern as the dashboard's trend.
 */
const TXN_ROW_LIMIT = 500;

function roundToMinorUnit(value: number, minorUnit: number | null | undefined) {
  const factor = 10 ** (minorUnit ?? 2);
  return Math.round(value * factor) / factor;
}

/** Sum a view's rows, tolerating the string form of numeric(38,18). */
function sum<T>(rows: T[], pick: (row: T) => number | string): number {
  return rows.reduce((acc, row) => {
    const n = Number(pick(row));
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
}

function PresetLinks({ query }: { query: ReportQuery }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PRESETS.map((p) => (
        <Link
          key={p.key}
          href={reportHref(query, { preset: p.key })}
          className={cn(
            buttonClass(query.preset === p.key ? "primary" : "secondary", "sm"),
          )}
        >
          {p.label}
        </Link>
      ))}
    </div>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string | string[];
    to?: string | string[];
    currency?: string | string[];
    preset?: string | string[];
  }>;
}) {
  const query = parseQuery(await searchParams); // Next 16: search params are async.

  const log = await requestLogger({ page: "/reports" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("reports.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // ROUND 1 — everything needed to decide WHICH currency this report is in.
  // The range-scoped queries below all filter on that code, so they cannot be
  // issued until it is known.
  const [
    { data: profile, error: profileError },
    { data: currencies, error: currenciesError },
    { data: balances, error: balancesError },
  ] = await Promise.all([
    supabase.from("profiles").select("default_currency_id").eq("id", user.id).single(),
    supabase
      .from("currencies")
      .select("id, code, symbol, minor_unit")
      .eq("is_active", true)
      .order("code"),
    supabase
      .from("v_portfolio_balances")
      .select("id, name, category, current_balance, is_liquid, is_archived, currency_code"),
  ]);

  if (profileError) pageLog.warn("reports.profile.load_failed", dbError(profileError));
  if (currenciesError) pageLog.error("reports.currencies.load_failed", dbError(currenciesError));
  if (balancesError) pageLog.error("reports.balances.load_failed", dbError(balancesError));

  const currencyList = (currencies ?? []) as (CurrencyInfo & { id: string })[];
  const balanceRows = (balances ?? []) as unknown as PortfolioBalanceRow[];
  const activeBalances = balanceRows.filter((b) => !b.is_archived);

  // Only offer currencies the user actually holds an account in — a picker full
  // of currencies with no data produces empty reports that look like bugs.
  const heldCodes = [...new Set(balanceRows.map((b) => b.currency_code))].sort();
  const defaultCode = currencyList.find((c) => c.id === profile?.default_currency_id)?.code;
  const code =
    query.currency && heldCodes.includes(query.currency)
      ? query.currency
      : heldCodes.includes(defaultCode ?? "")
        ? (defaultCode as string)
        : heldCodes[0];
  const currency = currencyList.find((c) => c.code === code);

  if (!code) {
    pageLog.info("reports.load.no_accounts", { durationMs: elapsed() });
    return (
      <PageContainer>
        <PageHeader title="Reports" />
        <EmptyState
          title="Nothing to report yet"
          description="Add an account and record some money moving, and this page will show where it went."
        />
      </PageContainer>
    );
  }

  // ROUND 2 — the range-scoped reads, all filtered to one currency (D3: there is
  // no FX, so a report covers exactly one currency and says which).
  const [
    { data: cashflow, error: cashflowError },
    { data: byCategory, error: byCategoryError },
    { data: bySource, error: bySourceError },
    { data: debts, error: debtsError },
    { data: payments, error: paymentsError },
    { data: investments, error: investmentsError },
    { data: goals, error: goalsError },
    { data: txns, error: txnsError },
  ] = await Promise.all([
    supabase
      .from("v_cashflow")
      .select("txn_date, direction, total, currency_code")
      .eq("currency_code", code)
      .gte("txn_date", query.from)
      .lte("txn_date", query.to),
    supabase
      .from("v_expense_by_category")
      .select("category_id, category_name, txn_date, total, currency_code")
      .eq("currency_code", code)
      .gte("txn_date", query.from)
      .lte("txn_date", query.to),
    supabase
      .from("v_income_by_source")
      .select("source, source_label, txn_date, total, currency_code")
      .eq("currency_code", code)
      .gte("txn_date", query.from)
      .lte("txn_date", query.to),
    supabase
      .from("v_debt_outstanding")
      .select("debt_id, kind, counterparty, outstanding_balance, status, currency_code")
      .eq("currency_code", code),
    // Joined to debts purely to scope this to ONE currency. debt_payments has
    // no currency column of its own, so without the !inner join this summed
    // pesos and dollars into a single figure and printed it with one symbol —
    // the exact apples-to-oranges total the rest of the report exists to avoid.
    supabase
      .from("debt_payments")
      .select("id, amount, principal_portion, interest_portion, payment_date, debt:debts!inner(currency_id)")
      .eq("debt.currency_id", currency?.id ?? "")
      .gte("payment_date", query.from)
      .lte("payment_date", query.to),
    supabase
      .from("v_investment_performance")
      .select(
        "investment_id, name, invested_amount, current_value, unrealized_gain, return_pct, currency_code",
      )
      .eq("currency_code", code),
    supabase
      .from("v_completed_goals")
      .select("goal_id, name, target_amount, current_amount, achieved_at, currency_code")
      .eq("currency_code", code),
    supabase
      .from("transactions")
      .select(TXN_SELECT)
      .eq("is_void", false)
      .eq("currency.code", code)
      .gte("txn_date", query.from)
      .lte("txn_date", query.to)
      .order("txn_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(TXN_ROW_LIMIT),
  ]);

  // v_income_by_source is the one object this phase adds. Until its SQL is run
  // the query 404s, and the "where it came from" panel is the only casualty —
  // so name it in the log rather than letting an empty breakdown look like "you
  // earned nothing".
  if (bySourceError) pageLog.error("reports.income_by_source.load_failed", dbError(bySourceError));
  if (cashflowError) pageLog.error("reports.cashflow.load_failed", dbError(cashflowError));
  if (byCategoryError) pageLog.error("reports.by_category.load_failed", dbError(byCategoryError));
  if (debtsError) pageLog.error("reports.debts.load_failed", dbError(debtsError));
  if (paymentsError) pageLog.error("reports.payments.load_failed", dbError(paymentsError));
  if (investmentsError) pageLog.error("reports.investments.load_failed", dbError(investmentsError));
  if (goalsError) pageLog.error("reports.goals.load_failed", dbError(goalsError));
  if (txnsError) pageLog.error("reports.transactions.load_failed", dbError(txnsError));

  const cashflowRows = (cashflow ?? []) as unknown as CashflowRow[];
  const categoryRows = (byCategory ?? []) as unknown as ExpenseByCategoryRow[];
  const sourceRows = (bySource ?? []) as unknown as IncomeBySourceRow[];
  const debtRows = (debts ?? []) as unknown as DebtOutstandingRow[];
  const paymentRows = (payments ?? []) as unknown as DebtPaymentRow[];
  const investmentRows = (investments ?? []) as unknown as InvestmentPerformanceRow[];
  const goalRows = (goals ?? []) as unknown as CompletedGoalRow[];
  const txnRows = (txns ?? []) as unknown as TransactionRow[];

  const minor = currency?.minor_unit;
  // Summed in Postgres per day, then across days here — the per-day rows are
  // already aggregates, so this is a handful of additions, not a scan.
  const inflow = roundToMinorUnit(
    sum(cashflowRows.filter((r) => r.direction === "inflow"), (r) => r.total),
    minor,
  );
  const outflow = roundToMinorUnit(
    sum(cashflowRows.filter((r) => r.direction === "outflow"), (r) => r.total),
    minor,
  );
  const net = roundToMinorUnit(inflow - outflow, minor);

  // Category and source breakdowns: the views give one row per (bucket, day).
  const byCategoryTotals = new Map<string, number>();
  for (const r of categoryRows) {
    byCategoryTotals.set(
      r.category_name,
      (byCategoryTotals.get(r.category_name) ?? 0) + Number(r.total),
    );
  }
  const bySourceTotals = new Map<string, number>();
  for (const r of sourceRows) {
    const label = incomeSourceDisplay(r.source, r.source_label);
    bySourceTotals.set(label, (bySourceTotals.get(label) ?? 0) + Number(r.total));
  }

  const spendRows = [...byCategoryTotals.entries()].map(([label, value]) => ({ label, value }));
  const earnRows = [...bySourceTotals.entries()].map(([label, value]) => ({ label, value }));

  // Six slices maximum, so the tail folds into one. Past ~7 classes adjacent
  // hues stop being tellable apart, and a category worth 0.4% of the month is
  // not worth a colour — but dropping it outright would make the ring lie about
  // the total, hence "Other" rather than a truncated list.
  const DONUT_SLICES = 6;
  const spendRanked = [...spendRows]
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const donutHead = spendRanked.slice(0, DONUT_SLICES - 1);
  const donutTail = spendRanked.slice(DONUT_SLICES - 1);
  const donutSlices = [
    ...donutHead,
    ...(donutTail.length > 0
      ? [{
          label: donutTail.length === 1 ? donutTail[0].label : `Other (${donutTail.length})`,
          value: donutTail.reduce((s, r) => s + r.value, 0),
        }]
      : []),
  ].map((r) => ({
    label: r.label,
    value: r.value,
    display: formatMoney(roundToMinorUnit(r.value, minor), currency),
  }));
  const donutTotal = spendRanked.reduce((s, r) => s + r.value, 0);

  // Bucketed before it reaches the chart: a year of per-day rows is 730 bar
  // pairs. Amounts are formatted here so the component never needs a currency.
  const granularity = granularityFor(query);
  const flowPoints = bucketFlows(cashflowRows, granularity).map((b) => ({
    label: b.label,
    inflow: b.inflow,
    outflow: b.outflow,
    inflowDisplay: formatMoney(roundToMinorUnit(b.inflow, minor), currency),
    outflowDisplay: formatMoney(roundToMinorUnit(b.outflow, minor), currency),
  }));

  // The running position: in minus out, accumulating across the same buckets.
  // FlowBars answers "how did this month go"; this answers "where am I overall,
  // and when did it turn" — which nothing else on the page does. Derived from
  // the same buckets on purpose, so the two charts can never disagree.
  // Accumulated by reduce rather than a running `let`: this is a render pass,
  // and a variable reassigned inside a map is exactly what react-hooks
  // /immutability forbids. Each point carries the total up to and including it.
  // `raw` is carried alongside so the running total accumulates at full
  // precision and is rounded only for display. Accumulating the rounded figure
  // instead would compound a half-centavo per bucket into a visible drift by the
  // end of a year.
  const netPoints = flowPoints
    .reduce<
      { label: string; raw: number; value: number; display: string }[]
    >((acc, b) => {
      const raw = (acc[acc.length - 1]?.raw ?? 0) + b.inflow - b.outflow;
      const rounded = roundToMinorUnit(raw, minor);
      return [
        ...acc,
        {
          label: b.label,
          raw,
          value: rounded,
          display: formatMoney(rounded, currency),
        },
      ];
    }, [])
    .map(({ label, value, display }) => ({ label, value, display }));
  const netFinal = netPoints[netPoints.length - 1]?.value ?? 0;

  // Summaries. The balance-style ones are CURRENT, not range-scoped — a balance
  // has no "as of last month" without replaying the ledger, and pretending
  // otherwise would be the most misleading thing on the page. Labelled as such.
  // Scoped to this report's currency BEFORE anything is summed. Summing
  // `activeBalances` directly would total every currency the user holds and then
  // label the result with one symbol.
  const codeBalances = activeBalances.filter((b) => b.currency_code === code);
  const owed = roundToMinorUnit(
    sum(debtRows.filter((d) => d.kind === "payable"), (d) => d.outstanding_balance),
    minor,
  );
  const owedToYou = roundToMinorUnit(
    sum(debtRows.filter((d) => d.kind === "receivable"), (d) => d.outstanding_balance),
    minor,
  );
  const paidOnDebts = roundToMinorUnit(sum(paymentRows, (p) => p.amount), minor);
  const investedNow = roundToMinorUnit(sum(investmentRows, (i) => i.current_value), minor);
  const investedCost = roundToMinorUnit(sum(investmentRows, (i) => i.invested_amount), minor);
  // Achieved INSIDE the range. achieved_at is a timestamptz; comparing its date
  // prefix keeps this on the same string-date footing as everything else.
  const goalsInRange = goalRows.filter((g) => {
    const day = g.achieved_at?.slice(0, 10);
    return day !== undefined && day >= query.from && day <= query.to;
  });

  const capHit = txnRows.length >= TXN_ROW_LIMIT;
  const countedCount = txnRows.filter(isCounted).length;
  const liquidHere = roundToMinorUnit(
    sum(codeBalances.filter((b) => b.is_liquid), (b) => b.current_balance),
    minor,
  );

  const anyError =
    cashflowError || byCategoryError || bySourceError || txnsError || balancesError;

  pageLog.info("reports.load.ok", {
    from: query.from,
    to: query.to,
    days: dayCount(query),
    currency: code,
    preset: query.preset,
    swappedRange: query.swapped,
    inflow,
    outflow,
    net,
    categories: spendRows.length,
    sources: earnRows.length,
    txnRows: txnRows.length,
    capHit,
    degraded: Boolean(anyError),
    durationMs: elapsed(),
  });

  const rangeLabel = `${formatDate(query.from)} – ${formatDate(query.to)}`;

  return (
    <PageContainer>
      <PageHeader
        title="Reports"
        description={`${rangeLabel} · ${code} · ${dayCount(query)} days`}
      />

      {query.swapped ? (
        <div className="mb-5">
          <Alert tone="error">
            Those dates were the other way round, so they&apos;ve been swapped.
            Showing {rangeLabel}.
          </Alert>
        </div>
      ) : null}

      {anyError ? (
        <div className="mb-5">
          <Alert tone="error">
            Part of this report couldn&apos;t be loaded, so some figures may be
            missing. Please try again shortly.
          </Alert>
        </div>
      ) : null}

      {/* A plain GET form: the whole point of putting the range in the URL is
          that it is shareable and survives reload, and a GET form gives that
          with no client JavaScript at all. */}
      <Card className="mb-5">
        <CardBody className="space-y-4">
          <PresetLinks query={query} />
          <form method="get" action="/reports" className="grid gap-4 sm:grid-cols-4">
            <Field label="From" htmlFor="from">
              <Input id="from" name="from" type="date" defaultValue={query.from} required />
            </Field>
            <Field label="To" htmlFor="to">
              <Input id="to" name="to" type="date" defaultValue={query.to} required />
            </Field>
            <Field
              label="Currency"
              htmlFor="currency"
              hint={heldCodes.length > 1 ? "One currency at a time — no conversion." : undefined}
            >
              <Select id="currency" name="currency" defaultValue={code}>
                {heldCodes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" className="w-full">
                Show
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardBody>
            <Eyebrow>Money in</Eyebrow>
            <p className="mt-2 text-2xl font-semibold tracking-tight">
              <Money amount={inflow} currency={currency} sign="positive" />
            </p>
            <p className="mt-1 text-[13px] text-muted">Excludes transfers and borrowing</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Eyebrow>Money out</Eyebrow>
            <p className="mt-2 text-2xl font-semibold tracking-tight">
              <Money amount={outflow} currency={currency} sign="negative" />
            </p>
            <p className="mt-1 text-[13px] text-muted">Excludes transfers and asset purchases</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Eyebrow>Net</Eyebrow>
            <p className="mt-2 text-2xl font-semibold tracking-tight">
              <Money
                amount={net}
                currency={currency}
                sign={net < 0 ? "negative" : "positive"}
              />
            </p>
            <p className="mt-1 text-[13px] text-muted">
              {net >= 0 ? "Earned more than you spent" : "Spent more than you earned"}
            </p>
          </CardBody>
        </Card>
      </div>

      {flowPoints.length > 0 ? (
        <Card className="mt-5">
          <CardHeader
            title="In and out over time"
            description={`By ${granularity}, in ${code}`}
          />
          <CardBody>
            <FlowBars points={flowPoints} />
          </CardBody>
        </Card>
      ) : null}

      {/* Needs at least two buckets: a single point is not a trend, and a
          one-point line renders as a dot with an axis. */}
      {netPoints.length > 1 ? (
        <Card className="mt-5">
          <CardHeader
            title="Running total"
            description={`Money in minus money out, accumulating across the range, in ${code}`}
          />
          <CardBody>
            <p>
              <Money
                amount={netFinal}
                currency={currency}
                sign={netFinal < 0 ? "negative" : "positive"}
                className="text-2xl font-semibold tracking-tight"
              />
            </p>
            <p className="mt-0.5 text-[13px] text-muted">
              {netFinal >= 0
                ? "ahead over this range"
                : "behind over this range"}
              {" · the dashed line is break-even"}
            </p>
            {/* baseline={0} is what makes this honest: without it the wash fills
                to the floor of the plot and a deficit reads like a gain. */}
            <TrendChart
              points={netPoints}
              label="Running total"
              baseline={0}
              interval={granularity === "day" ? "daily" : `${granularity}ly`}
            />
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Where it went" description={`Spending by category, in ${code}`} />
          <CardBody>
            {spendRows.length === 0 ? (
              <EmptyState title="No spending in this range" />
            ) : (
              <>
                {/* Two reads of one number, deliberately. The donut answers
                    "what shape was this month" at a glance; the bars below rank
                    close values against each other, which a ring cannot do, and
                    stand as the labelled table view. Neither is decoration for
                    the other — drop the bars and precision goes; drop the ring
                    and the at-a-glance shape goes. */}
                {donutSlices.length > 1 ? (
                  <div className="mb-6 border-b border-line pb-6">
                    <ShareDonut
                      slices={donutSlices}
                      total={donutTotal}
                      totalDisplay={formatMoney(
                        roundToMinorUnit(donutTotal, minor),
                        currency,
                      )}
                      caption="Total spent"
                    />
                  </div>
                ) : null}
                <AllocationBars rows={spendRows} currency={currency} />
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Where it came from" description={`Income by source, in ${code}`} />
          <CardBody>
            {bySourceError ? (
              <EmptyState
                title="Income breakdown unavailable"
                description="The v_income_by_source view hasn't been created yet — run db/functions/v_income_by_source.sql."
              />
            ) : earnRows.length === 0 ? (
              <EmptyState title="No income in this range" />
            ) : (
              <AllocationBars rows={earnRows} currency={currency} />
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Where you stand"
          description="Balances are current, not as at the end of the range"
        />
        <CardBody>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <li>
              <Eyebrow>Liquid</Eyebrow>
              <p className="mt-1.5 text-lg font-semibold text-ink">
                <Money amount={liquidHere} currency={currency} />
              </p>
              <p className="mt-0.5 text-xs text-faint">Cash and savings</p>
            </li>
            <li>
              <Eyebrow>Debt outstanding</Eyebrow>
              <p className="mt-1.5 text-lg font-semibold text-ink">
                <Money amount={owed} currency={currency} />
              </p>
              <p className="mt-0.5 text-xs text-faint">
                {paidOnDebts > 0
                  ? `${formatMoney(paidOnDebts, currency)} paid in range`
                  : "Nothing paid in range"}
                {owedToYou > 0 ? ` · ${formatMoney(owedToYou, currency)} owed to you` : ""}
              </p>
            </li>
            <li>
              <Eyebrow>Invested</Eyebrow>
              <p className="mt-1.5 text-lg font-semibold text-ink">
                <Money amount={investedNow} currency={currency} />
              </p>
              <p className="mt-0.5 text-xs text-faint">
                from {formatMoney(investedCost, currency)} · not cash
              </p>
            </li>
            <li>
              <Eyebrow>Goals achieved</Eyebrow>
              <p className="mt-1.5 text-lg font-semibold text-ink">{goalsInRange.length}</p>
              <p className="mt-0.5 text-xs text-faint">
                {goalsInRange.length > 0 ? goalsInRange.map((g) => g.name).join(", ") : "In this range"}
              </p>
            </li>
          </ul>
        </CardBody>
      </Card>

      <Card className="mt-5">
        <CardHeader
          title="Accounts"
          description={`Current balances in ${code} · ${formatMoney(liquidHere, currency)} of it liquid`}
        />
        {codeBalances.length === 0 ? (
          <CardBody>
            <EmptyState title={`No ${code} accounts`} />
          </CardBody>
        ) : (
          <Table
            label="Account balances"
            head={
              <>
                <Th>Account</Th>
                <Th align="right">Balance</Th>
              </>
            }
          >
            {codeBalances.map((b) => (
              <Tr key={b.id}>
                <Td>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-ink">{b.name}</span>
                    {b.is_liquid ? <Badge tone="accent">liquid</Badge> : null}
                  </span>
                </Td>
                <Td align="right">
                  <Money amount={b.current_balance} currency={currency} className="font-medium" />
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>

      <Card className="mt-5">
        <CardHeader
          title="Transactions"
          description={
            capHit
              ? `First ${TXN_ROW_LIMIT} of more than ${TXN_ROW_LIMIT} — narrow the range to see them all`
              : `${txnRows.length} in range · ${countedCount} counted in the totals above`
          }
          action={
            txnRows.length > 0 ? (
              // A plain link, not a fetch: the browser's own download handling
              // is what makes Content-Disposition work.
              <a
                href={`/reports/export?from=${query.from}&to=${query.to}&currency=${code}`}
                className={buttonClass("secondary", "sm")}
              >
                Export CSV
              </a>
            ) : undefined
          }
        />
        {capHit ? (
          <CardBody>
            <Alert tone="error">
              This range has more than {TXN_ROW_LIMIT} transactions, so only the
              first {TXN_ROW_LIMIT} are listed. The totals above are unaffected —
              they are summed in the database, not from this list.
            </Alert>
          </CardBody>
        ) : null}
        {txnRows.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No transactions in this range"
              description={`Nothing moved in ${code} between ${rangeLabel}.`}
            />
          </CardBody>
        ) : (
          <Table
            label="Transactions in range"
            head={
              <>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Account</Th>
                <Th align="right">Amount</Th>
              </>
            }
          >
            {txnRows.map((t) => {
              const counted = isCounted(t);
              return (
                <Tr key={t.id}>
                  <Td>
                    <span className="figure whitespace-nowrap text-[13px] text-muted">
                      {formatDate(t.txn_date)}
                    </span>
                  </Td>
                  <Td>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-ink">{rowLabel(t)}</span>
                      {/* Says why the list doesn't add up to the headline,
                          instead of leaving the reader to wonder. */}
                      {counted ? null : <Badge>not counted</Badge>}
                    </span>
                    {t.description ? (
                      <span className="mt-0.5 block text-xs text-faint">{t.description}</span>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="text-[13px] text-muted">
                      {one(t.portfolio)?.name ?? "—"}
                    </span>
                  </Td>
                  <Td align="right">
                    <Money
                      amount={t.amount}
                      currency={one(t.currency)}
                      sign={t.direction === "outflow" ? "negative" : "positive"}
                      className="font-medium"
                    />
                  </Td>
                </Tr>
              );
            })}
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}
