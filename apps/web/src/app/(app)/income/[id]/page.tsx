import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { IncomeForm } from "../income-form";
import { updateIncome, deleteIncome } from "../actions";
import { incomeSourceDisplay } from "../constants";
import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { amountInputValue } from "@/lib/format";

export const metadata: Metadata = { title: "Edit income" };

interface Portfolio {
  id: string;
  name: string;
}

/** The raw shape INCOME_EDIT_SELECT returns — ids, not display names. */
interface IncomeDetail {
  id: string;
  source: string;
  source_name: string | null;
  source_label: string | null;
  is_recurring: boolean;
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

export default async function EditIncomePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({ page: "/income/[id]", incomeId: id });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("income.edit.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const [detailRes, optionsRes] = await Promise.all([
    ledgerFetch(`/ledger/incomes/${id}`),
    ledgerFetch("/ledger/incomes/options"),
  ]);

  if (!detailRes.ok) {
    // "Not yours" and "not there" are deliberately indistinguishable — the
    // ledger filters by user_id either way.
    pageLog.warn("income.edit.not_found", {
      status: detailRes.status,
      redirectedTo: "/income",
      durationMs: elapsed(),
    });
    redirect("/income");
  }

  const detail = (await detailRes.json()) as { income: IncomeDetail };
  const income = detail.income;
  const txn = one(income.transaction);

  // A debt disbursement is an income row whose real record is the debt, and
  // update_income() refuses it. Send the user where the edit actually is.
  if (income.debt_id || income.source === "loan_received") {
    pageLog.info("income.edit.owned_elsewhere", {
      owner: "debt",
      redirectedTo: income.debt_id ? `/debts/${income.debt_id}` : "/debts",
    });
    redirect(income.debt_id ? `/debts/${income.debt_id}` : "/debts");
  }

  if (!txn) {
    // Without a ledger row there is no amount, date or account to edit.
    pageLog.error("income.edit.no_transaction", {
      redirectedTo: "/income",
      durationMs: elapsed(),
    });
    redirect("/income");
  }

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: Portfolio[];
        source_labels?: string[];
      })
    : {};
  const portfolios = options.portfolios ?? [];
  const sourceLabels = options.source_labels ?? [];

  pageLog.debug("income.edit.load_ok", {
    accounts: portfolios.length,
    source: income.source,
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href="/income"
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← Income
        </Link>
      </nav>

      <div className="max-w-xl space-y-5">
        <Card>
          <CardHeader
            title="Edit income"
            description={
              income.source_name ??
              incomeSourceDisplay(income.source, income.source_label)
            }
          />
          <CardBody>
            {optionsRes.ok ? (
              <IncomeForm
                mode="edit"
                action={updateIncome}
                portfolios={portfolios}
                sourceLabels={sourceLabels}
                income={{
                  id: income.id,
                  amount: amountInputValue(txn.amount),
                  txn_date: txn.txn_date,
                  portfolio_id: txn.portfolio_id,
                  source: income.source,
                  source_label: income.source_label,
                  source_name: income.source_name,
                  description: txn.description,
                  is_recurring: income.is_recurring,
                }}
                submitLabel="Save changes"
              />
            ) : (
              <p className="text-[13px] text-muted">
                Accounts couldn&apos;t be loaded, so the form is unavailable
                until the income service is reachable again.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Delete"
            description="Takes the money back out of the account. Refused if it has already been spent."
          />
          <CardBody>
            <ConfirmDelete
              action={deleteIncome}
              id={income.id}
              question="Delete this income entry?"
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
