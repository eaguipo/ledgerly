import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { ValuationForm } from "../valuation-form";
import { closeInvestment, reopenInvestment } from "../actions";
import {
  formatDate,
  formatQuantity,
  hasMatured,
  investmentKindLabel,
  one,
  returnPct,
  todayIso,
} from "../constants";
import type { InvestmentRow, SnapshotRow } from "../types";
import { PageContainer } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, Eyebrow } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Investment" };

/** A single-action form button — close/reopen share it. */
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

export default async function InvestmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({ page: "/investments/[id]", investmentId: id });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("investment.detail.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const detailRes = await ledgerFetch(`/ledger/investments/${id}`);

  if (!detailRes.ok) {
    // Bouncing to /investments looks the same whether the id is a typo or the
    // holding belongs to someone else — the ledger filters by user_id, so "not
    // yours" and "not there" are deliberately indistinguishable.
    pageLog.warn("investment.detail.not_found", {
      status: detailRes.status,
      redirectedTo: "/investments",
      durationMs: elapsed(),
    });
    redirect("/investments");
  }

  const detail = (await detailRes.json()) as {
    investment: InvestmentRow;
    snapshots?: SnapshotRow[];
  };
  const investment = detail.investment;
  const snapshots = detail.snapshots ?? [];

  const currency = one(investment.currency);
  const funding = one(investment.portfolio);
  const invested = Number(investment.invested_amount);
  const current = Number(investment.current_value);
  const gain = current - invested;
  const pct = returnPct(invested, current);
  const today = todayIso();
  const matured = hasMatured(investment.maturity_date, today);
  const quantity = formatQuantity(investment.quantity);

  // The row the sync trigger is currently reading — newest as_of_date wins, and
  // the list arrives in that order. Worth naming because a back-filled valuation
  // sits in this table without being the one the headline reflects.
  const latest = snapshots[0];

  pageLog.info("investment.detail.load_ok", {
    kind: investment.kind,
    isActive: investment.is_active,
    snapshots: snapshots.length,
    matured,
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href="/investments"
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← Investments
        </Link>
      </nav>

      {!investment.is_active ? (
        <div className="mb-5">
          <Alert tone="error">
            This investment is closed, so it&apos;s left your totals. Reopen it
            to record new values.
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card>
            <CardHeader
              title={investment.name}
              description={
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {investmentKindLabel(investment.kind, investment.kind_label)}
                    {investment.symbol ? ` · ${investment.symbol}` : ""}
                  </span>
                  {matured ? <Badge>matured</Badge> : null}
                  {!investment.is_active ? <Badge>closed</Badge> : null}
                </span>
              }
            />
            <CardBody className="space-y-5">
              <div>
                <Eyebrow>Current value</Eyebrow>
                <p className="mt-1">
                  <Money
                    amount={current}
                    currency={currency}
                    className="text-3xl font-semibold tracking-tight"
                  />
                </p>
                <p className="mt-2 text-[13px] text-muted">
                  <Money
                    amount={gain}
                    currency={currency}
                    sign={gain < 0 ? "negative" : "positive"}
                  />{" "}
                  {pct === null
                    ? "against no recorded cost"
                    : `(${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) on ${formatMoney(invested, currency)} invested`}
                </p>
                {latest ? (
                  <p className="mt-1.5 text-xs text-faint">
                    Last valued {formatDate(latest.as_of_date)}
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-faint">
                    No valuation recorded yet — this is still showing what you
                    put in.
                  </p>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-4 text-[13px] sm:grid-cols-3">
                <div>
                  <dt className="text-muted">Opened</dt>
                  <dd className="figure mt-0.5 text-ink">
                    {investment.opened_on ? formatDate(investment.opened_on) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Matures</dt>
                  <dd className="figure mt-0.5 text-ink">
                    {investment.maturity_date
                      ? formatDate(investment.maturity_date)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Quantity</dt>
                  <dd className="figure mt-0.5 text-ink">{quantity ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted">Average cost</dt>
                  <dd className="figure mt-0.5 text-ink">
                    {investment.average_cost !== null
                      ? formatMoney(investment.average_cost, currency)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Paid from</dt>
                  <dd className="mt-0.5 text-ink">{funding?.name ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted">Recorded</dt>
                  <dd className="figure mt-0.5 text-ink">
                    {formatDate(investment.created_at.slice(0, 10))}
                  </dd>
                </div>
              </dl>

              {investment.maturity_date ? (
                <p className="text-xs text-faint">
                  The maturity date is recorded for reference only — nothing
                  grows on its own. Record what it&apos;s worth whenever you
                  check.
                </p>
              ) : null}

              {funding ? (
                <p className="text-xs text-faint">
                  Paid from {funding.name}. Holdings recorded before this was
                  supported may show an account here without a matching payment —
                  the link was informational then.
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {investment.is_active ? (
                  <ActionButton
                    id={investment.id}
                    action={closeInvestment}
                    label="Close"
                  />
                ) : (
                  <ActionButton
                    id={investment.id}
                    action={reopenInvestment}
                    label="Reopen"
                  />
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Value history"
              description={
                snapshots.length > 0 ? `${snapshots.length} recorded` : undefined
              }
            />
            {snapshots.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="No values recorded yet"
                  description="Record what this is worth whenever you check it. The newest date is what the current value reflects."
                />
              </CardBody>
            ) : (
              <Table
                label="Value history"
                head={
                  <>
                    <Th>Date</Th>
                    <Th align="right">Unit price</Th>
                    <Th align="right">Quantity</Th>
                    <Th align="right">Value</Th>
                  </>
                }
              >
                {snapshots.map((s) => {
                  const snapQuantity = formatQuantity(s.quantity);
                  return (
                    <Tr key={s.id}>
                      <Td>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="figure whitespace-nowrap text-[13px] text-muted">
                            {formatDate(s.as_of_date)}
                          </span>
                          {/* Only the newest row feeds current_value, so say
                              which one that is — a back-filled valuation sits
                              here without being the figure above. */}
                          {s.id === latest?.id ? (
                            <Badge tone="accent">current</Badge>
                          ) : null}
                        </span>
                        {s.source ? (
                          <span className="mt-0.5 block text-xs text-faint">
                            {s.source}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {s.unit_price !== null
                            ? formatMoney(s.unit_price, currency)
                            : "—"}
                        </span>
                      </Td>
                      <Td align="right">
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {snapQuantity ?? "—"}
                        </span>
                      </Td>
                      <Td align="right">
                        <Money
                          amount={s.market_value}
                          currency={currency}
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
          <CardHeader
            title="Record a value"
            description="What it's worth now. Gains stay unrealised until you sell."
          />
          <CardBody>
            {investment.is_active ? (
              <ValuationForm investment={investment} />
            ) : (
              <p className="text-[13px] text-muted">
                This investment is closed. Reopen it to record a new value.
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
