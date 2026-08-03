import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { IncomeForm } from "./income-form";
import { createIncome } from "./actions";
import { incomeSourceDisplay } from "./constants";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";

export const metadata: Metadata = { title: "Income" };

interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface Portfolio {
  id: string;
  name: string;
}

interface IncomeRow {
  id: string;
  source: string;
  source_name: string | null;
  /** The user's own name for an 'other' source; null on the enum's members. */
  source_label: string | null;
  is_recurring: boolean;
  // Set when this row is create_debt()'s disbursement leg. Never shown — used
  // only to withhold the Edit link, since update_income() refuses it.
  debt_id: string | null;
  transaction: {
    id: string;
    amount: number | string;
    txn_date: string;
    description: string | null;
    currency: Currency | null;
    portfolio: { name: string } | null;
  } | null;
}

function one<T>(v: T | T[] | null | undefined): T | undefined {
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function IncomePage() {
  const log = await requestLogger({ page: "/income" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("income.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // ledgerFetch picks the transport: the mesh when GATEWAY_URL is set, in-process
  // handlers over RLS-scoped Supabase on the Vercel deploy. Same paths either way.
  const [optionsRes, listRes] = await Promise.all([
    ledgerFetch("/ledger/incomes/options"),
    ledgerFetch("/ledger/incomes?limit=30"),
  ]);

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: Portfolio[];
        source_labels?: string[];
      })
    : {};
  const portfolios: Portfolio[] = options.portfolios ?? [];
  // Custom source names this user has typed before — offered back as
  // autocomplete so the same source doesn't accumulate three spellings.
  const sourceLabels: string[] = options.source_labels ?? [];

  const list = listRes.ok
    ? ((await listRes.json()) as { incomes?: IncomeRow[] })
    : {};
  const rows = (list.incomes ?? []) as IncomeRow[];

  // Distinguish "service unreachable" from a genuinely empty account — without
  // this the empty state would claim you have no income when in fact the mesh
  // is down.
  const serviceError = !optionsRes.ok || !listRes.ok;
  const hasAccounts = portfolios.length > 0;

  if (serviceError) {
    pageLog.error("income.load.degraded", {
      optionsStatus: optionsRes.status,
      listStatus: listRes.status,
      failed: [
        !optionsRes.ok ? "options" : null,
        !listRes.ok ? "list" : null,
      ].filter(Boolean),
      durationMs: elapsed(),
    });
  } else {
    pageLog.info("income.load.ok", {
      incomes: rows.length,
      accounts: portfolios.length,
      formAvailable: hasAccounts,
      rowsMissingTransaction: rows.filter((i) => !one(i.transaction)).length,
      durationMs: elapsed(),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Income"
        description="Money coming in from outside your accounts — your most recent 30 entries."
      />

      {serviceError ? (
        <div className="mb-5">
          <Alert tone="error">
            Couldn&apos;t reach the income service. Some data may be missing —
            please try again shortly.
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHeader
              title="Recent income"
              description={rows.length > 0 ? `${rows.length} shown` : undefined}
            />
            {rows.length === 0 ? (
              <CardBody>
                <EmptyState
                  title={serviceError ? "Income unavailable" : "No income yet"}
                  description={
                    serviceError
                      ? "The income service didn't respond, so this list can't be shown right now."
                      : hasAccounts
                        ? "Record your first income with the form and it will show up here straight away."
                        : "Add an account first — income has to land somewhere."
                  }
                />
              </CardBody>
            ) : (
              <Table
                label="Recent income"
                head={
                  <>
                    <Th>Date</Th>
                    <Th>Detail</Th>
                    <Th>Account</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </>
                }
              >
                {rows.map((i) => {
                  const txn = one(i.transaction);
                  if (!txn) return null;
                  const cur = one(txn.currency);
                  const portfolio = one(txn.portfolio);
                  // A debt disbursement is owned by the debt, and
                  // update_income() refuses it — link to the owner instead.
                  const ownedByDebt =
                    Boolean(i.debt_id) || i.source === "loan_received";

                  return (
                    <Tr key={i.id}>
                      <Td>
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {formatDate(txn.txn_date)}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">
                            {i.source_name ??
                              incomeSourceDisplay(i.source, i.source_label)}
                          </span>
                          <Badge>
                            {incomeSourceDisplay(i.source, i.source_label)}
                          </Badge>
                          {i.is_recurring ? (
                            <Badge tone="accent">recurring</Badge>
                          ) : null}
                        </span>
                        {txn.description ? (
                          <span className="mt-0.5 block text-xs text-faint">
                            {txn.description}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <span className="text-[13px] text-muted">
                          {portfolio?.name ?? "—"}
                        </span>
                      </Td>
                      <Td align="right">
                        <Money
                          amount={txn.amount}
                          currency={cur}
                          sign="positive"
                          className="font-medium"
                        />
                      </Td>
                      <Td align="right">
                        {ownedByDebt ? (
                          <Link
                            href={i.debt_id ? `/debts/${i.debt_id}` : "/debts"}
                            className="whitespace-nowrap rounded-lg px-2 py-1 text-[13px] text-muted transition-colors hover:bg-raised hover:text-ink"
                          >
                            Debt →
                          </Link>
                        ) : (
                          <Link
                            href={`/income/${i.id}`}
                            className="rounded-lg px-2 py-1 text-[13px] text-muted transition-colors hover:bg-raised hover:text-ink"
                          >
                            Edit
                          </Link>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>

        <Card className="lg:col-span-2 lg:sticky lg:top-6">
          <CardHeader title="Add income" />
          <CardBody>
            {serviceError ? (
              <p className="text-[13px] text-muted">
                Accounts couldn&apos;t be loaded, so the form is unavailable
                until the income service is reachable again.
              </p>
            ) : hasAccounts ? (
              <IncomeForm
                mode="create"
                action={createIncome}
                portfolios={portfolios}
                sourceLabels={sourceLabels}
                submitLabel="Add income"
              />
            ) : (
              <p className="text-[13px] text-muted">
                You need at least one account before recording income.{" "}
                <Link
                  href="/portfolios"
                  className="font-medium text-accent underline-offset-4 hover:underline"
                >
                  Add an account
                </Link>
                .
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
