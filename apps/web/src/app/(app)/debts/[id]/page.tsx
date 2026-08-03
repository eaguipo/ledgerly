import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { PaymentForm } from "./payment-form";
import { AdjustmentForm } from "./adjustment-form";
import {
  archiveDebt,
  deleteDebtAdjustment,
  reopenDebt,
  restoreDebt,
  writeOffDebt,
} from "../actions";
import {
  adjustmentReasonLabel,
  debtKind,
  debtStatusLabel,
  formatDate,
  isLiveDebt,
  isOverdue,
  one,
  todayIso,
} from "../constants";
import type {
  DebtAccount,
  DebtAdjustmentRow,
  DebtPaymentRow,
  DebtRow,
} from "../types";
import { PageContainer } from "@/components/shell/page-header";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { Card, CardBody, CardHeader, Eyebrow } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Debt" };

/** A single-action form button — archive/restore/write-off/reopen all share it. */
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

export default async function DebtDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({ page: "/debts/[id]", debtId: id });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("debt.detail.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const [detailRes, optionsRes] = await Promise.all([
    ledgerFetch(`/ledger/debts/${id}`),
    ledgerFetch("/ledger/debts/options"),
  ]);

  if (!detailRes.ok) {
    // Bouncing to /debts looks the same whether the id is a typo or the debt
    // belongs to someone else — the ledger filters by user_id, so "not yours"
    // and "not there" are deliberately indistinguishable.
    pageLog.warn("debt.detail.not_found", {
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
  };
  const debt = detail.debt;
  const payments = detail.payments ?? [];
  const adjustments = detail.adjustments ?? [];

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as { portfolios?: DebtAccount[] })
    : {};
  const currency = one(debt.currency);
  // A transaction must match its account's currency (BR17), so an account in
  // any other currency simply cannot take this payment.
  const accounts = (options.portfolios ?? []).filter(
    (a) => one(a.currency)?.code === currency?.code,
  );

  const copy = debtKind(debt.kind);
  const principal = Number(debt.principal_amount);
  const outstanding = Number(debt.outstanding_balance);
  const overdue = isOverdue(debt.due_date, debt.status, todayIso());
  const interestPaid = payments.reduce(
    (sum, p) => sum + Number(p.interest_portion),
    0,
  );

  // The same arithmetic recompute_debt() does, re-derived here so the page can
  // SHOW it rather than print an outstanding figure the reader has to take on
  // faith. `paid = principal - outstanding` was right before adjustments existed
  // and is wrong now: interest raises what's owed without anything being paid,
  // and an off-app payment lowers it without a payment row.
  const charges = adjustments
    .map((a) => Number(a.amount))
    .filter((n) => n > 0)
    .reduce((sum, n) => sum + n, 0);
  const credits = adjustments
    .map((a) => Number(a.amount))
    .filter((n) => n < 0)
    .reduce((sum, n) => sum - n, 0);
  const principalPaid = payments.reduce(
    (sum, p) => sum + Number(p.principal_portion),
    0,
  );
  const gross = principal + charges;
  const settled = principalPaid + credits;
  const pct = gross > 0 ? Math.min((settled / gross) * 100, 100) : 0;

  // Settled, archived and written-off debts all take no payment: the first two
  // are rejected by the RPC outright, and offering the form for the third would
  // suggest that chasing it is the expected next step.
  const canPay = isLiveDebt(debt.status) && !debt.is_archived;

  pageLog.info("debt.detail.load_ok", {
    kind: debt.kind,
    status: debt.status,
    payments: payments.length,
    eligibleAccounts: accounts.length,
    optionsOk: optionsRes.ok,
    canPay,
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href="/debts"
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← Debts
        </Link>
      </nav>

      {debt.is_archived ? (
        <div className="mb-5">
          <Alert tone="error">
            This debt is archived. Restore it to record payments again.
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card>
            <CardHeader
              title={debt.counterparty}
              description={
                <span className="flex flex-wrap items-center gap-2">
                  <span>{copy.heading}</span>
                  <Badge>{debtStatusLabel(debt.status)}</Badge>
                  {overdue ? <Badge tone="accent">overdue</Badge> : null}
                  {debt.is_archived ? <Badge>archived</Badge> : null}
                </span>
              }
            />
            <CardBody className="space-y-5">
              <div>
                <Eyebrow>Outstanding</Eyebrow>
                <p className="mt-1">
                  <Money
                    amount={outstanding}
                    currency={currency}
                    className="text-3xl font-semibold tracking-tight"
                  />
                </p>
                <div
                  className="mt-3 h-2 w-full overflow-hidden rounded-full bg-raised"
                  role="progressbar"
                  aria-valuenow={Math.round(pct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Principal paid"
                >
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-2 text-[13px] text-muted">
                  {formatMoney(settled, currency)} of{" "}
                  {formatMoney(gross, currency)} settled
                  {interestPaid > 0
                    ? ` · ${formatMoney(interestPaid, currency)} interest paid on top`
                    : ""}
                </p>

                {/* Spelled out only when an adjustment actually moved the
                    figure. Without one, `gross` is just the principal and this
                    would be four lines restating a number already on screen. */}
                {adjustments.length > 0 ? (
                  <dl className="mt-3 space-y-1 border-t border-line pt-3 text-[13px]">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Principal</dt>
                      <dd className="figure text-ink">
                        {formatMoney(principal, currency)}
                      </dd>
                    </div>
                    {charges > 0 ? (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Interest &amp; fees added</dt>
                        <dd className="figure text-ink">
                          + {formatMoney(charges, currency)}
                        </dd>
                      </div>
                    ) : null}
                    {principalPaid > 0 ? (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Paid through an account</dt>
                        <dd className="figure text-ink">
                          − {formatMoney(principalPaid, currency)}
                        </dd>
                      </div>
                    ) : null}
                    {credits > 0 ? (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">
                          Paid off-app or written down
                        </dt>
                        <dd className="figure text-ink">
                          − {formatMoney(credits, currency)}
                        </dd>
                      </div>
                    ) : null}
                    <div className="flex justify-between gap-3 border-t border-line pt-1 font-medium">
                      <dt className="text-ink">Outstanding</dt>
                      <dd className="figure text-ink">
                        {formatMoney(outstanding, currency)}
                      </dd>
                    </div>
                  </dl>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-4 text-[13px] sm:grid-cols-3">
                <div>
                  <dt className="text-muted">Due</dt>
                  <dd className="figure mt-0.5 text-ink">
                    {debt.due_date ? formatDate(debt.due_date) : "No due date"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Interest rate</dt>
                  <dd className="figure mt-0.5 text-ink">
                    {debt.interest_rate !== null
                      ? `${Number(debt.interest_rate)}%`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Recorded</dt>
                  <dd className="figure mt-0.5 text-ink">
                    {formatDate(debt.created_at.slice(0, 10))}
                  </dd>
                </div>
              </dl>

              {debt.note ? (
                <p className="text-[13px] text-muted">{debt.note}</p>
              ) : null}

              {debt.interest_rate !== null ? (
                <p className="text-xs text-faint">
                  The rate is recorded for reference only — nothing accrues on
                  its own. Enter any interest you actually pay on each payment.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                {/* Where re-tagging payable <-> receivable lives. It is an edit,
                    not a one-click action, precisely because on a funded debt it
                    moves account balances. */}
                <ButtonLink href={`/debts/${debt.id}/edit`} size="sm">
                  Edit
                </ButtonLink>
                {debt.is_archived ? (
                  <ActionButton id={debt.id} action={restoreDebt} label="Restore" />
                ) : (
                  <ActionButton id={debt.id} action={archiveDebt} label="Archive" />
                )}
                {debt.status === "written_off" ? (
                  <ActionButton id={debt.id} action={reopenDebt} label="Undo write-off" />
                ) : debt.status !== "settled" ? (
                  <ActionButton
                    id={debt.id}
                    action={writeOffDebt}
                    label="Write off"
                    variant="danger"
                  />
                ) : null}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Payments"
              description={
                payments.length > 0 ? `${payments.length} recorded` : undefined
              }
            />
            {payments.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="No payments yet"
                  description={
                    debt.kind === "payable"
                      ? "Every payment you record moves real money out of an account and reduces this balance."
                      : "Every collection you record moves real money into an account and reduces this balance."
                  }
                />
              </CardBody>
            ) : (
              <Table
                label="Payments"
                head={
                  <>
                    <Th>Date</Th>
                    <Th>Account</Th>
                    <Th align="right">Principal</Th>
                    <Th align="right">Amount</Th>
                  </>
                }
              >
                {payments.map((p) => {
                  const portfolio = one(p.transaction?.portfolio);
                  const interest = Number(p.interest_portion);
                  return (
                    <Tr key={p.id}>
                      <Td>
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {formatDate(p.payment_date)}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-ink">
                            {portfolio?.name ?? "—"}
                          </span>
                          {interest > 0 ? (
                            <Badge>
                              interest {formatMoney(interest, currency)}
                            </Badge>
                          ) : null}
                        </span>
                        {p.note ? (
                          <span className="mt-0.5 block text-xs text-faint">
                            {p.note}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {formatMoney(p.principal_portion, currency)}
                        </span>
                      </Td>
                      <Td align="right">
                        <Money
                          amount={p.amount}
                          currency={currency}
                          sign={debt.kind === "payable" ? "negative" : "positive"}
                          className="font-medium"
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            )}
          </Card>

          {/* Deliberately a separate card from Payments. Both change what is
              owed, but only one moved money, and merging them into one history
              would lose exactly the distinction that makes an adjustment
              trustworthy. */}
          {adjustments.length > 0 ? (
            <Card>
              <CardHeader
                title="Adjustments"
                description={`${adjustments.length} recorded · no cash moved`}
              />
              <Table
                label="Adjustments"
                head={
                  <>
                    <Th>Date</Th>
                    <Th>What changed</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </>
                }
              >
                {adjustments.map((a) => {
                  const amount = Number(a.amount);
                  return (
                    <Tr key={a.id}>
                      <Td>
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {formatDate(a.effective_on)}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-ink">
                          {adjustmentReasonLabel(a.reason)}
                        </span>
                        {a.note ? (
                          <span className="mt-0.5 block text-xs text-faint">
                            {a.note}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        {/* Signed against the DEBT, not against an account: a
                            positive adjustment grew what is owed. */}
                        <Money
                          amount={Math.abs(amount)}
                          currency={currency}
                          sign={amount > 0 ? "negative" : "positive"}
                          className="font-medium"
                        />
                      </Td>
                      <Td align="right">
                        <ConfirmDelete
                          action={deleteDebtAdjustment}
                          id={a.id}
                          extra={{ debt_id: debt.id }}
                          label="Remove"
                          question="Remove this adjustment?"
                          confirmLabel="Remove"
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            </Card>
          ) : null}
        </div>

        <Card className="lg:col-span-2 lg:sticky lg:top-6">
          <CardHeader title={copy.paymentTitle} />
          <CardBody>
            {!canPay ? (
              <p className="text-[13px] text-muted">
                {debt.is_archived
                  ? "Restore this debt to record payments against it."
                  : debt.status === "settled"
                    ? "This debt is fully settled — there is nothing left to pay."
                    : "This debt is written off. Undo the write-off if money does come back."}
              </p>
            ) : !optionsRes.ok ? (
              <p className="text-[13px] text-muted">
                Accounts couldn&apos;t be loaded, so the form is unavailable
                until the debt service is reachable again.
              </p>
            ) : accounts.length === 0 ? (
              <p className="text-[13px] text-muted">
                This debt is in {currency?.code ?? "another currency"} and you
                have no active account in it — a payment has to post to an
                account of the same currency.{" "}
                <Link
                  href="/portfolios"
                  className="font-medium text-accent underline-offset-4 hover:underline"
                >
                  Add one
                </Link>
                .
              </p>
            ) : (
              <PaymentForm debt={debt} accounts={accounts} />
            )}
          </CardBody>
        </Card>

        {/* Its own card, below the payment form, because it answers a different
            question: not "money moved, record it" but "the debt changed and no
            money moved". Needs no account at all, which is why it stays
            available when the payment form is disabled for want of one. */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="What's owed"
            description="Correct the balance without moving money — interest, a payment made elsewhere, or a write-down."
          />
          <CardBody>
            {debt.is_archived ? (
              <p className="text-[13px] text-muted">
                Restore this debt to adjust what it says.
              </p>
            ) : (
              <AdjustmentForm debt={debt} />
            )}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
