import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { DebtForm } from "./debt-form";
import {
  DEBT_KINDS,
  debtStatusLabel,
  formatDate,
  isLiveDebt,
  isOverdue,
  one,
  todayIso,
} from "./constants";
import type { Currency, CurrencyOption, DebtAccount, DebtRow } from "./types";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader, Eyebrow } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Debts" };

/**
 * Outstanding totals per currency for one side of the ledger. Currencies are
 * never summed together — there is no FX conversion in v1 (Phase 4), and adding
 * PHP to USD would produce a number that means nothing.
 *
 * Settled and written-off debts are excluded: neither is money anyone still
 * expects to move, and a written-off debt keeps a non-zero balance.
 */
function totalsByCurrency(debts: DebtRow[]) {
  const totals = new Map<
    string,
    { total: number; currency: Currency | undefined }
  >();
  for (const d of debts) {
    if (!isLiveDebt(d.status)) continue;
    const currency = one(d.currency);
    const code = currency?.code ?? "—";
    const prev = totals.get(code);
    totals.set(code, {
      total: (prev?.total ?? 0) + Number(d.outstanding_balance),
      currency: currency ?? prev?.currency,
    });
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function DebtTable({ debts, today }: { debts: DebtRow[]; today: string }) {
  return (
    <Table
      label="Debts"
      head={
        <>
          <Th>Who</Th>
          <Th>Due</Th>
          <Th align="right">Outstanding</Th>
          <Th align="right">Of principal</Th>
        </>
      }
    >
      {debts.map((d) => {
        const currency = one(d.currency);
        const overdue = isOverdue(d.due_date, d.status, today);
        return (
          <Tr key={d.id}>
            <Td>
              <span className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/debts/${d.id}`}
                  className="font-medium text-ink underline-offset-4 hover:underline"
                >
                  {d.counterparty}
                </Link>
                {d.status !== "open" ? (
                  <Badge>{debtStatusLabel(d.status)}</Badge>
                ) : null}
                {overdue ? <Badge tone="accent">overdue</Badge> : null}
              </span>
              {d.note ? (
                <span className="mt-0.5 block text-xs text-faint">{d.note}</span>
              ) : null}
            </Td>
            <Td>
              <span className="figure whitespace-nowrap text-[13px] text-muted">
                {d.due_date ? formatDate(d.due_date) : "—"}
              </span>
            </Td>
            <Td align="right">
              <Money
                amount={d.outstanding_balance}
                currency={currency}
                className="font-medium"
              />
            </Td>
            <Td align="right">
              <span className="figure whitespace-nowrap text-[13px] text-muted">
                {formatMoney(d.principal_amount, currency)}
              </span>
            </Td>
          </Tr>
        );
      })}
    </Table>
  );
}

export default async function DebtsPage() {
  const log = await requestLogger({ page: "/debts" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("debts.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // ledgerFetch picks the transport: the mesh when GATEWAY_URL is set, in-process
  // handlers over RLS-scoped Supabase on the Vercel deploy (no direct DB
  // access). The profile is a plain preference, not ledger data, so it comes
  // straight off the RLS-scoped client the same way /portfolios reads it.
  const [optionsRes, listRes, { data: profile }] = await Promise.all([
    ledgerFetch("/ledger/debts/options"),
    ledgerFetch("/ledger/debts?limit=200"),
    supabase.from("profiles").select("default_currency_id").eq("id", user.id).single(),
  ]);

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: DebtAccount[];
        currencies?: CurrencyOption[];
      })
    : {};
  const accounts = options.portfolios ?? [];
  const currencies = options.currencies ?? [];

  const list = listRes.ok ? ((await listRes.json()) as { debts?: DebtRow[] }) : {};
  const debts = list.debts ?? [];

  const serviceError = !optionsRes.ok || !listRes.ok;
  const payables = debts.filter((d) => d.kind === "payable");
  const receivables = debts.filter((d) => d.kind === "receivable");
  const today = todayIso();
  const overdueCount = debts.filter((d) =>
    isOverdue(d.due_date, d.status, today),
  ).length;

  // Unlike expenses and transfers, a debt needs no account at all — a
  // record-only debt is the whole point of the optional disbursement. Only the
  // currency list can disable this form.
  const canRecord = currencies.length > 0;

  if (serviceError) {
    pageLog.error("debts.load.degraded", {
      optionsStatus: optionsRes.status,
      listStatus: listRes.status,
      failed: [
        !optionsRes.ok ? "options" : null,
        !listRes.ok ? "list" : null,
      ].filter(Boolean),
      durationMs: elapsed(),
    });
  } else {
    pageLog.info("debts.load.ok", {
      debts: debts.length,
      payables: payables.length,
      receivables: receivables.length,
      overdue: overdueCount,
      accounts: accounts.length,
      formAvailable: canRecord,
      durationMs: elapsed(),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Debts"
        description="What you owe and what you're owed, with every payment posted against a real account."
      />

      {serviceError ? (
        <div className="mb-5">
          <Alert tone="error">
            Couldn&apos;t reach the debt service. Some data may be missing —
            please try again shortly.
          </Alert>
        </div>
      ) : null}

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        {DEBT_KINDS.map((k) => {
          const side = k.value === "payable" ? payables : receivables;
          const totals = totalsByCurrency(side);
          return (
            <Card key={k.value}>
              <CardBody>
                <Eyebrow>{k.heading}</Eyebrow>
                {totals.length === 0 ? (
                  <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">
                    —
                  </p>
                ) : (
                  <div className="mt-2 space-y-1">
                    {totals.map(([code, t]) => (
                      <p
                        key={code}
                        className="figure text-2xl font-semibold tracking-tight text-ink"
                      >
                        {formatMoney(t.total, t.currency)}
                      </p>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-[13px] text-muted">
                  {side.filter((d) => isLiveDebt(d.status)).length} open
                  {totals.length > 1 ? " · totals shown per currency" : ""}
                </p>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {overdueCount > 0 ? (
        <div className="mb-5">
          <Alert tone="error">
            {overdueCount === 1
              ? "1 debt is past its due date."
              : `${overdueCount} debts are past their due date.`}
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          {DEBT_KINDS.map((k) => {
            const side = k.value === "payable" ? payables : receivables;
            return (
              <Card key={k.value}>
                <CardHeader
                  title={k.heading}
                  description={side.length > 0 ? `${side.length} shown` : undefined}
                />
                {side.length === 0 ? (
                  <CardBody>
                    <EmptyState
                      title={
                        serviceError
                          ? "Debts unavailable"
                          : k.value === "payable"
                            ? "Nothing owed"
                            : "Nobody owes you"
                      }
                      description={
                        serviceError
                          ? "The debt service didn't respond, so this list can't be shown right now."
                          : k.value === "payable"
                            ? "Money you borrow or still have to pay will show up here."
                            : "Money you lend out will show up here."
                      }
                    />
                  </CardBody>
                ) : (
                  <DebtTable debts={side} today={today} />
                )}
              </Card>
            );
          })}
        </div>

        <Card className="lg:col-span-2 lg:sticky lg:top-6">
          <CardHeader title="Record a debt" />
          <CardBody>
            {serviceError || !canRecord ? (
              <p className="text-[13px] text-muted">
                Currencies couldn&apos;t be loaded, so the form is unavailable
                until the debt service is reachable again.
              </p>
            ) : (
              <DebtForm
                accounts={accounts}
                currencies={currencies}
                defaultCurrencyId={profile?.default_currency_id ?? undefined}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
