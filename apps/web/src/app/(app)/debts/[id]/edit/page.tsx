import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { DebtEditForm } from "../../debt-edit-form";
import { one } from "../../constants";
import type { DebtAdjustmentRow, DebtPaymentRow, DebtRow } from "../../types";
import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { amountInputValue } from "@/lib/format";

export const metadata: Metadata = { title: "Edit debt" };

export default async function EditDebtPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({ page: "/debts/[id]/edit", debtId: id });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("debt.edit.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const detailRes = await ledgerFetch(`/ledger/debts/${id}`);
  if (!detailRes.ok) {
    // "Not yours" and "not there" are deliberately indistinguishable — the
    // ledger filters by user_id either way.
    pageLog.warn("debt.edit.not_found", {
      status: detailRes.status,
      redirectedTo: "/debts",
      durationMs: elapsed(),
    });
    redirect("/debts");
  }

  const detail = (await detailRes.json()) as {
    debt: DebtRow;
    payments?: DebtPaymentRow[];
    adjustments?: DebtAdjustmentRow[];
    disbursement_transaction_id?: string | null;
  };
  const debt = detail.debt;
  const payments = detail.payments ?? [];
  const currency = one(debt.currency);

  // Exactly what update_debt() will re-post: the disbursement, if there was one,
  // plus one leg per payment. Both have to be checked — a debt can have a
  // disbursement and no payments, or payments recorded against a debt that was
  // never disbursed through this app.
  const hasLedgerLegs =
    payments.length > 0 || Boolean(detail.disbursement_transaction_id);

  pageLog.debug("debt.edit.load_ok", {
    kind: debt.kind,
    payments: payments.length,
    // The difference between "re-tagging just renames this" and "re-tagging
    // moves your balances", which is what the form warns about.
    hasLedgerLegs,
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href={`/debts/${id}`}
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← {debt.counterparty}
        </Link>
      </nav>

      <div className="max-w-xl">
        <Card>
          <CardHeader
            title="Edit debt"
            description="Correct how this debt is tagged, who it's with, or what was originally borrowed or lent."
          />
          <CardBody>
            <DebtEditForm
              debt={{
                id: debt.id,
                kind: debt.kind,
                counterparty: debt.counterparty,
                principal_amount: amountInputValue(debt.principal_amount),
                interest_rate: amountInputValue(debt.interest_rate),
                due_date: debt.due_date,
                note: debt.note,
                currency_code: currency?.code ?? "—",
                has_ledger_legs: hasLedgerLegs,
              }}
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
