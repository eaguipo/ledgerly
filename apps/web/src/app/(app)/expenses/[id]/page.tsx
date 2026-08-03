import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { ExpenseForm } from "../expense-form";
import { updateExpense, deleteExpense } from "../actions";
import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { amountInputValue } from "@/lib/format";

export const metadata: Metadata = { title: "Edit expense" };

interface Portfolio {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
}

/** The raw shape EXPENSE_EDIT_SELECT returns — ids, not display names. */
interface ExpenseDetail {
  id: string;
  merchant: string | null;
  category_id: string;
  investment_id: string | null;
  debt_id: string | null;
  transaction: {
    id: string;
    amount: number | string;
    txn_date: string;
    description: string | null;
    portfolio_id: string;
  } | null;
}

function one<T>(v: T | T[] | null | undefined): T | undefined {
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}

export default async function EditExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({ page: "/expenses/[id]", expenseId: id });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("expense.edit.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const [detailRes, optionsRes] = await Promise.all([
    ledgerFetch(`/ledger/expenses/${id}`),
    ledgerFetch("/ledger/expenses/options"),
  ]);

  if (!detailRes.ok) {
    // Bouncing to /expenses looks the same whether the id is a typo or the row
    // belongs to someone else — the ledger filters by user_id, so "not yours"
    // and "not there" are deliberately indistinguishable.
    pageLog.warn("expense.edit.not_found", {
      status: detailRes.status,
      redirectedTo: "/expenses",
      durationMs: elapsed(),
    });
    redirect("/expenses");
  }

  const detail = (await detailRes.json()) as { expense: ExpenseDetail };
  const expense = detail.expense;
  const txn = one(expense.transaction);

  // These two rows are the cash side of a record that lives elsewhere, and
  // update_expense() refuses them. Send the user where the edit actually is
  // rather than showing a form whose save can only fail.
  if (expense.investment_id) {
    pageLog.info("expense.edit.owned_elsewhere", {
      owner: "investment",
      redirectedTo: `/investments/${expense.investment_id}`,
    });
    redirect(`/investments/${expense.investment_id}`);
  }
  if (expense.debt_id) {
    pageLog.info("expense.edit.owned_elsewhere", {
      owner: "debt",
      redirectedTo: `/debts/${expense.debt_id}`,
    });
    redirect(`/debts/${expense.debt_id}`);
  }

  if (!txn) {
    // An expense with no ledger row cannot be edited into a consistent state —
    // the amount, date and account all live on the transaction.
    pageLog.error("expense.edit.no_transaction", {
      redirectedTo: "/expenses",
      durationMs: elapsed(),
    });
    redirect("/expenses");
  }

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: Portfolio[];
        categories?: Category[];
      })
    : {};
  const portfolios = options.portfolios ?? [];
  const categories = options.categories ?? [];

  pageLog.debug("expense.edit.load_ok", {
    accounts: portfolios.length,
    categories: categories.length,
    // The picker is filtered to active categories, so an expense filed under a
    // deactivated one opens with nothing selected and has to be re-picked.
    categoryStillOffered: categories.some((c) => c.id === expense.category_id),
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href="/expenses"
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← Expenses
        </Link>
      </nav>

      <div className="max-w-xl space-y-5">
        <Card>
          <CardHeader
            title="Edit expense"
            description={expense.merchant ?? "Correct the amount, date or account."}
          />
          <CardBody>
            {optionsRes.ok ? (
              <ExpenseForm
                mode="edit"
                action={updateExpense}
                categories={categories}
                portfolios={portfolios}
                expense={{
                  id: expense.id,
                  amount: amountInputValue(txn.amount),
                  txn_date: txn.txn_date,
                  portfolio_id: txn.portfolio_id,
                  category_id: expense.category_id,
                  merchant: expense.merchant,
                  description: txn.description,
                }}
                submitLabel="Save changes"
              />
            ) : (
              <p className="text-[13px] text-muted">
                Accounts and categories couldn&apos;t be loaded, so the form is
                unavailable until the expense service is reachable again.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Delete"
            description="Removes the entry and puts the money back in the account. This can't be undone."
          />
          <CardBody>
            <ConfirmDelete
              action={deleteExpense}
              id={expense.id}
              question="Delete this expense?"
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
