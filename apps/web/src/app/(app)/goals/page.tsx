import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { GoalForm } from "./goal-form";
import { ContributionForm } from "./contribution-form";
import { createGoal, archiveGoal, cancelGoal, reopenGoal } from "./actions";
import {
  formatDate,
  goalStatusLabel,
  isLiveGoal,
  isPastDue,
  one,
  progressPct,
  todayIso,
} from "./constants";
import type {
  Currency,
  CurrencyOption,
  GoalAccount,
  GoalRow,
} from "./types";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader, Eyebrow } from "@/components/ui/card";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Goals" };

/** A single-action form button — archive/cancel/reopen all share it. */
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
 * Total set aside per currency. Currencies are never summed together — there is
 * no FX conversion in v1 (Phase 4), and adding PHP to USD invents a number.
 */
function totalsByCurrency(goals: GoalRow[]) {
  const totals = new Map<
    string,
    { setAside: number; target: number; currency: Currency | undefined }
  >();
  for (const g of goals) {
    const currency = one(g.currency);
    const code = currency?.code ?? "—";
    const prev = totals.get(code);
    totals.set(code, {
      setAside: (prev?.setAside ?? 0) + Number(g.current_amount),
      target: (prev?.target ?? 0) + Number(g.target_amount),
      currency: currency ?? prev?.currency,
    });
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Accounts where the goals pointing at them add up to more than the account
 * actually holds.
 *
 * This is the cost of the earmark model (decision D2): nothing stops you setting
 * aside ₱100k across three goals while holding ₱20k, because no contribution
 * ever moved money. It is advisory, never blocking — the goals are still a valid
 * plan, they just aren't funded yet.
 */
function overEarmarked(goals: GoalRow[]) {
  const byAccount = new Map<
    string,
    { name: string; earmarked: number; balance: number; currency: Currency | undefined }
  >();
  for (const g of goals) {
    const portfolio = one(g.linked_portfolio);
    if (!g.linked_portfolio_id || !portfolio) continue;
    const prev = byAccount.get(g.linked_portfolio_id);
    byAccount.set(g.linked_portfolio_id, {
      name: portfolio.name,
      earmarked: (prev?.earmarked ?? 0) + Number(g.current_amount),
      balance: Number(portfolio.current_balance),
      currency: one(g.currency) ?? prev?.currency,
    });
  }
  return [...byAccount.values()].filter((a) => a.earmarked > a.balance);
}

function GoalCard({ goal, today }: { goal: GoalRow; today: string }) {
  const currency = one(goal.currency);
  const portfolio = one(goal.linked_portfolio);
  const current = Number(goal.current_amount);
  const target = Number(goal.target_amount);
  const pct = progressPct(current, target);
  const pastDue = isPastDue(goal.target_date, goal.status, today);
  const achieved = goal.status === "achieved";
  // first_achieved_at is never cleared, so a goal that hit its target and was
  // later drawn down still reads as "reached once" rather than as if it had
  // never got there. Only worth saying when it is NOT currently achieved.
  const achievedBefore = Boolean(goal.first_achieved_at) && !achieved;

  return (
    <Card as="article">
      <CardBody className="space-y-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-[15px] font-semibold tracking-tight text-ink">
            {goal.name}
          </h3>
          <span className="flex flex-wrap items-center gap-1.5">
            {achieved ? <Badge tone="accent">achieved</Badge> : null}
            {pastDue ? <Badge>past due</Badge> : null}
            {achievedBefore ? <Badge>reached once</Badge> : null}
            {!isLiveGoal(goal.status) ? (
              <Badge>{goalStatusLabel(goal.status)}</Badge>
            ) : null}
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
              of {formatMoney(target, currency)}
            </span>
          </p>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-raised"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${goal.name} progress`}
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-faint">
            {Math.round(pct)}% there
            {goal.target_date ? ` · by ${formatDate(goal.target_date)}` : ""}
            {portfolio ? ` · backed by ${portfolio.name}` : ""}
          </p>
        </div>

        {isLiveGoal(goal.status) ? (
          <ContributionForm goal={goal} />
        ) : (
          <p className="text-[13px] text-muted">
            {goal.status === "archived"
              ? "Archived. Reopen it to start setting money aside again."
              : "Cancelled. Reopen it if you want to pick this back up."}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <ButtonLink href={`/goals/${goal.id}`} size="sm">
            Edit
          </ButtonLink>
          {isLiveGoal(goal.status) ? (
            <>
              <ActionButton id={goal.id} action={archiveGoal} label="Archive" />
              <ActionButton
                id={goal.id}
                action={cancelGoal}
                label="Cancel"
                variant="danger"
              />
            </>
          ) : (
            <ActionButton id={goal.id} action={reopenGoal} label="Reopen" />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { archived } = await searchParams; // Next 16: search params are async.
  const showArchived = archived === "1";

  const log = await requestLogger({ page: "/goals" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("goals.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // Goal data goes through ledgerFetch (mesh or in-process, see lib/ledger.ts).
  // The profile is a plain preference, not ledger data, so it comes straight off
  // the RLS-scoped client the same way /portfolios and /debts read it.
  const [optionsRes, listRes, { data: profile }] = await Promise.all([
    ledgerFetch("/ledger/goals/options"),
    ledgerFetch(`/ledger/goals?limit=200${showArchived ? "&include_archived=true" : ""}`),
    supabase.from("profiles").select("default_currency_id").eq("id", user.id).single(),
  ]);

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: GoalAccount[];
        currencies?: CurrencyOption[];
      })
    : {};
  const accounts = options.portfolios ?? [];
  const currencies = options.currencies ?? [];

  const list = listRes.ok ? ((await listRes.json()) as { goals?: GoalRow[] }) : {};
  const goals = list.goals ?? [];

  const serviceError = !optionsRes.ok || !listRes.ok;
  const today = todayIso();
  const live = goals.filter((g) => isLiveGoal(g.status));
  const totals = totalsByCurrency(live);
  const stretched = overEarmarked(live);
  const achievedCount = live.filter((g) => g.status === "achieved").length;
  const pastDueCount = goals.filter((g) =>
    isPastDue(g.target_date, g.status, today),
  ).length;

  // A goal needs no account at all — only a currency, since it is an earmark
  // rather than a money movement.
  const canCreate = currencies.length > 0;

  if (serviceError) {
    pageLog.error("goals.load.degraded", {
      optionsStatus: optionsRes.status,
      listStatus: listRes.status,
      failed: [
        !optionsRes.ok ? "options" : null,
        !listRes.ok ? "list" : null,
      ].filter(Boolean),
      durationMs: elapsed(),
    });
  } else {
    pageLog.info("goals.load.ok", {
      goals: goals.length,
      live: live.length,
      achieved: achievedCount,
      pastDue: pastDueCount,
      overEarmarkedAccounts: stretched.length,
      showArchived,
      accounts: accounts.length,
      formAvailable: canCreate,
      durationMs: elapsed(),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Goals"
        description="What you're saving toward. Setting money aside here earmarks it — it doesn't move it."
        action={
          <Link
            href={showArchived ? "/goals" : "/goals?archived=1"}
            className="text-[13px] text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            {showArchived ? "Hide closed goals" : "Show closed goals"}
          </Link>
        }
      />

      {serviceError ? (
        <div className="mb-5">
          <Alert tone="error">
            Couldn&apos;t reach the goal service. Some data may be missing —
            please try again shortly.
          </Alert>
        </div>
      ) : null}

      {totals.length > 0 ? (
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardBody>
              <Eyebrow>Set aside</Eyebrow>
              <div className="mt-2 space-y-1">
                {totals.map(([code, t]) => (
                  <p
                    key={code}
                    className="figure text-2xl font-semibold tracking-tight text-ink"
                  >
                    {formatMoney(t.setAside, t.currency)}
                    <span className="ml-1.5 text-[13px] font-normal text-muted">
                      of {formatMoney(t.target, t.currency)}
                    </span>
                  </p>
                ))}
              </div>
              <p className="mt-1 text-[13px] text-muted">
                across {live.length} {live.length === 1 ? "goal" : "goals"}
                {totals.length > 1 ? " · shown per currency" : ""}
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <Eyebrow>Achieved</Eyebrow>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">
                {achievedCount}
              </p>
              <p className="mt-1 text-[13px] text-muted">
                {pastDueCount > 0
                  ? `${pastDueCount} past its target date`
                  : "None past their target date"}
              </p>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {stretched.length > 0 ? (
        <div className="mb-5">
          <Alert tone="error">
            {stretched.map((a) => (
              <span key={a.name} className="block">
                You&apos;ve earmarked {formatMoney(a.earmarked, a.currency)}{" "}
                against {a.name}, which holds{" "}
                {formatMoney(a.balance, a.currency)}. Goals track a plan — they
                don&apos;t move money.
              </span>
            ))}
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {goals.length === 0 ? (
            <Card>
              <CardBody>
                <EmptyState
                  title={serviceError ? "Goals unavailable" : "No goals yet"}
                  description={
                    serviceError
                      ? "The goal service didn't respond, so this list can't be shown right now."
                      : showArchived
                        ? "Nothing here, closed or otherwise."
                        : "Name something you're saving for and track how close you are."
                  }
                />
              </CardBody>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {goals.map((g) => (
                <GoalCard key={g.id} goal={g} today={today} />
              ))}
            </div>
          )}
        </div>

        <Card className="lg:col-span-2 lg:sticky lg:top-6">
          <CardHeader title="New goal" />
          <CardBody>
            {serviceError || !canCreate ? (
              <p className="text-[13px] text-muted">
                Currencies couldn&apos;t be loaded, so the form is unavailable
                until the goal service is reachable again.
              </p>
            ) : (
              <GoalForm
                mode="create"
                action={createGoal}
                accounts={accounts}
                currencies={currencies}
                defaultCurrencyId={profile?.default_currency_id ?? undefined}
                submitLabel="Create goal"
              />
            )}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
