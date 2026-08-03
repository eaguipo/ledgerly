import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { ExpenseForm } from "./expense-form";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";

export const metadata: Metadata = { title: "Expenses" };

interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface Portfolio {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
}

interface ExpenseRow {
  id: string;
  merchant: string | null;
  category: { name: string } | null;
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

export default async function ExpensesPage() {
  const log = await requestLogger({ page: "/expenses" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("expenses.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // ledgerFetch picks the transport: the mesh when GATEWAY_URL is set, in-process
  // handlers over RLS-scoped Supabase on the Vercel deploy. Same paths either way.
  const [optionsRes, listRes] = await Promise.all([
    ledgerFetch("/ledger/expenses/options"),
    ledgerFetch("/ledger/expenses?limit=30"),
  ]);

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: Portfolio[];
        categories?: Category[];
      })
    : {};
  const portfolios: Portfolio[] = options.portfolios ?? [];
  const categories: Category[] = options.categories ?? [];

  const list = listRes.ok
    ? ((await listRes.json()) as { expenses?: ExpenseRow[] })
    : {};
  const rows = (list.expenses ?? []) as ExpenseRow[];

  // Distinguish "service unreachable" from a genuinely empty account — without
  // this the empty state would claim you have no expenses when in fact the
  // mesh is down.
  const serviceError = !optionsRes.ok || !listRes.ok;
  const hasAccounts = portfolios.length > 0;

  // ledgerFetch already logged each call; this line records what the PAGE
  // concluded from them — which of the two failed, and what the user ends up
  // seeing (a degraded page, an empty state, or the real list).
  if (serviceError) {
    pageLog.error("expenses.load.degraded", {
      optionsStatus: optionsRes.status,
      listStatus: listRes.status,
      failed: [
        !optionsRes.ok ? "options" : null,
        !listRes.ok ? "list" : null,
      ].filter(Boolean),
      durationMs: elapsed(),
    });
  } else {
    pageLog.info("expenses.load.ok", {
      expenses: rows.length,
      accounts: portfolios.length,
      categories: categories.length,
      // No accounts means the form is replaced by a prompt to add one — a
      // frequent "the form disappeared" report that is actually correct.
      formAvailable: hasAccounts,
      // A row whose transaction embed is null is dropped from the table, so the
      // count on screen would be lower than the count fetched.
      rowsMissingTransaction: rows.filter((e) => !one(e.transaction)).length,
      durationMs: elapsed(),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Expenses"
        description="Your most recent 30 entries, newest first."
      />

      {serviceError ? (
        <div className="mb-5">
          <Alert tone="error">
            Couldn&apos;t reach the expense service. Some data may be missing —
            please try again shortly.
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHeader
              title="Recent expenses"
              description={rows.length > 0 ? `${rows.length} shown` : undefined}
            />
            {rows.length === 0 ? (
              <CardBody>
                <EmptyState
                  title={
                    serviceError ? "Expenses unavailable" : "No expenses yet"
                  }
                  description={
                    serviceError
                      ? "The expense service didn't respond, so this list can't be shown right now."
                      : hasAccounts
                        ? "Record your first expense with the form and it will show up here straight away."
                        : "Add an account first — every expense has to come out of one."
                  }
                />
              </CardBody>
            ) : (
              <Table
                label="Recent expenses"
                head={
                  <>
                    <Th>Date</Th>
                    <Th>Detail</Th>
                    <Th>Account</Th>
                    <Th align="right">Amount</Th>
                  </>
                }
              >
                {rows.map((e) => {
                  const txn = one(e.transaction);
                  if (!txn) return null;
                  const cat = one(e.category);
                  const cur = one(txn.currency);
                  const portfolio = one(txn.portfolio);

                  return (
                    <Tr key={e.id}>
                      <Td>
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {formatDate(txn.txn_date)}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">
                            {e.merchant ?? cat?.name ?? "Expense"}
                          </span>
                          {cat ? <Badge>{cat.name}</Badge> : null}
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
                          sign="negative"
                          className="font-medium"
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>

        <Card className="lg:col-span-2 lg:sticky lg:top-6">
          <CardHeader title="Add an expense" />
          <CardBody>
            {serviceError ? (
              <p className="text-[13px] text-muted">
                Accounts and categories couldn&apos;t be loaded, so the form is
                unavailable until the expense service is reachable again.
              </p>
            ) : hasAccounts ? (
              <ExpenseForm portfolios={portfolios} categories={categories} />
            ) : (
              <p className="text-[13px] text-muted">
                You need at least one account before recording expenses.{" "}
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
