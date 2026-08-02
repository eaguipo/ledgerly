import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ExpenseForm } from "./expense-form";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";

export const metadata: Metadata = { title: "Expenses" };

interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: portfolios }, { data: categories }, { data: expenses }] =
    await Promise.all([
      supabase
        .from("portfolios")
        .select("id, name")
        .eq("is_archived", false)
        .order("sort_order")
        .order("created_at"),
      supabase
        .from("expense_categories")
        .select("id, name")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("expenses")
        .select(
          "id, merchant, category:expense_categories(name), transaction:transactions!inner(id, amount, txn_date, description, currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))",
        )
        .order("created_at", { ascending: false })
        .limit(30),
    ]);

  const rows = (expenses ?? []) as unknown as ExpenseRow[];
  const hasAccounts = (portfolios ?? []).length > 0;

  return (
    <PageContainer>
      <PageHeader
        title="Expenses"
        description="Your most recent 30 entries, newest first."
      />

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
                  title="No expenses yet"
                  description={
                    hasAccounts
                      ? "Record your first expense with the form and it will show up here straight away."
                      : "Add an account first — every expense has to come out of one."
                  }
                />
              </CardBody>
            ) : (
              <Table
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
            {hasAccounts ? (
              <ExpenseForm
                portfolios={portfolios ?? []}
                categories={categories ?? []}
              />
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
