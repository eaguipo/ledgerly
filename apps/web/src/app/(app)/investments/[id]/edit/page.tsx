import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { InvestmentForm } from "../../investment-form";
import { updateInvestment, deleteInvestment } from "../../actions";
import { one } from "../../constants";
import type {
  CurrencyOption,
  InvestmentAccount,
  InvestmentRow,
  PurchaseLeg,
} from "../../types";
import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { amountInputValue } from "@/lib/format";

export const metadata: Metadata = { title: "Edit investment" };

export default async function EditInvestmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({
    page: "/investments/[id]/edit",
    investmentId: id,
  });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("investment.edit.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const [detailRes, optionsRes] = await Promise.all([
    ledgerFetch(`/ledger/investments/${id}`),
    ledgerFetch("/ledger/investments/options"),
  ]);

  if (!detailRes.ok) {
    // "Not yours" and "not there" are deliberately indistinguishable — the
    // ledger filters by user_id either way.
    pageLog.warn("investment.edit.not_found", {
      status: detailRes.status,
      redirectedTo: "/investments",
      durationMs: elapsed(),
    });
    redirect("/investments");
  }

  const detail = (await detailRes.json()) as {
    investment: InvestmentRow;
    purchase?: PurchaseLeg | null;
  };
  const investment = detail.investment;
  const hasPurchase = Boolean(detail.purchase);

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

  const currency = one(investment.currency);

  pageLog.debug("investment.edit.load_ok", {
    kind: investment.kind,
    // The difference that decides whether saving a new cost basis moves an
    // account balance — and the first thing to check when someone reports that
    // it did (or didn't).
    hasPurchase,
    accounts: accounts.length,
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href={`/investments/${id}`}
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← {investment.name}
        </Link>
      </nav>

      <div className="max-w-xl space-y-5">
        <Card>
          <CardHeader
            title="Edit investment"
            description={
              hasPurchase
                ? "This holding was paid for from an account, so the amount, date and account below move real money."
                : "Recorded only — nothing here moves money unless you pick an account to pay from."
            }
          />
          <CardBody>
            {optionsRes.ok ? (
              <InvestmentForm
                mode="edit"
                action={updateInvestment}
                accounts={accounts}
                // The currency is fixed after creation and the form renders it
                // read-only, but it still has to be in this list to be named.
                // An inactive currency is absent from /options, so fall back to
                // the one embedded on the holding itself.
                currencies={
                  currencies.some((c) => c.id === investment.currency_id) ||
                  !currency
                    ? currencies
                    : [...currencies, { id: investment.currency_id, ...currency }]
                }
                kindLabels={kindLabels}
                investment={{
                  id: investment.id,
                  name: investment.name,
                  kind: investment.kind,
                  kind_label: investment.kind_label,
                  currency_id: investment.currency_id,
                  invested_amount: amountInputValue(investment.invested_amount),
                  symbol: investment.symbol,
                  quantity: amountInputValue(investment.quantity),
                  opened_on: investment.opened_on,
                  maturity_date: investment.maturity_date,
                  portfolio_id: investment.portfolio_id,
                  has_purchase: hasPurchase,
                }}
                submitLabel="Save changes"
              />
            ) : (
              <p className="text-[13px] text-muted">
                Accounts and currencies couldn&apos;t be loaded, so the form is
                unavailable until the investment service is reachable again.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Delete"
            description={
              hasPurchase
                ? "Throws away every recorded valuation and reverses the payment, putting the cash back. Closing it instead keeps the history."
                : "Throws away every recorded valuation. Closing it instead keeps the history."
            }
          />
          <CardBody>
            <ConfirmDelete
              action={deleteInvestment}
              id={investment.id}
              question={
                hasPurchase
                  ? "Delete this holding, its valuations, and the payment?"
                  : "Delete this holding and its valuations?"
              }
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
