import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { TransferForm, type TransferPortfolio } from "./transfer-form";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Th, Tr, Td } from "@/components/ui/table";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Money } from "@/components/ui/money";

export const metadata: Metadata = { title: "Transfers" };

interface Currency {
  code: string;
  symbol: string | null;
  minor_unit: number;
}

interface TransferRow {
  id: string;
  amount: number | string;
  fee: number | string;
  exchange_rate: number | string;
  amount_received: number | string;
  txn_date: string;
  note: string | null;
  from_portfolio: { name: string } | null;
  to_portfolio: { name: string } | null;
  from_currency: Currency | null;
  to_currency: Currency | null;
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

export default async function TransfersPage() {
  const log = await requestLogger({ page: "/transfers" });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("transfers.load.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  // ledgerFetch picks the transport: the mesh when GATEWAY_URL is set, in-process
  // handlers over RLS-scoped Supabase on the Vercel deploy. Same paths either way.
  const [optionsRes, listRes] = await Promise.all([
    ledgerFetch("/ledger/transfers/options"),
    ledgerFetch("/ledger/transfers?limit=30"),
  ]);

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as { portfolios?: TransferPortfolio[] })
    : {};
  const portfolios: TransferPortfolio[] = options.portfolios ?? [];

  const list = listRes.ok
    ? ((await listRes.json()) as { transfers?: TransferRow[] })
    : {};
  const rows = (list.transfers ?? []) as TransferRow[];

  const serviceError = !optionsRes.ok || !listRes.ok;
  // A transfer needs somewhere to come from AND somewhere to go, so one account
  // is as unusable as none.
  const canTransfer = portfolios.length >= 2;

  if (serviceError) {
    pageLog.error("transfers.load.degraded", {
      optionsStatus: optionsRes.status,
      listStatus: listRes.status,
      failed: [
        !optionsRes.ok ? "options" : null,
        !listRes.ok ? "list" : null,
      ].filter(Boolean),
      durationMs: elapsed(),
    });
  } else {
    pageLog.info("transfers.load.ok", {
      transfers: rows.length,
      accounts: portfolios.length,
      formAvailable: canTransfer,
      durationMs: elapsed(),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Transfers"
        description="Money moved between your own accounts — your most recent 30."
      />

      {serviceError ? (
        <div className="mb-5">
          <Alert tone="error">
            Couldn&apos;t reach the transfer service. Some data may be missing —
            please try again shortly.
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHeader
              title="Recent transfers"
              description={rows.length > 0 ? `${rows.length} shown` : undefined}
            />
            {rows.length === 0 ? (
              <CardBody>
                <EmptyState
                  title={
                    serviceError ? "Transfers unavailable" : "No transfers yet"
                  }
                  description={
                    serviceError
                      ? "The transfer service didn't respond, so this list can't be shown right now."
                      : canTransfer
                        ? "Move money between two of your accounts and it will show up here."
                        : "You need at least two accounts before you can move money between them."
                  }
                />
              </CardBody>
            ) : (
              <Table
                label="Recent transfers"
                head={
                  <>
                    <Th>Date</Th>
                    <Th>Route</Th>
                    <Th align="right">Sent</Th>
                    <Th align="right">Received</Th>
                  </>
                }
              >
                {rows.map((t) => {
                  const fromCur = one(t.from_currency);
                  const toCur = one(t.to_currency);
                  const fromP = one(t.from_portfolio);
                  const toP = one(t.to_portfolio);
                  const feeNum = Number(t.fee);
                  // Same amount on both sides is the common case; showing the
                  // rate then is noise.
                  const converted = fromCur?.code !== toCur?.code;

                  return (
                    <Tr key={t.id}>
                      <Td>
                        <span className="figure whitespace-nowrap text-[13px] text-muted">
                          {formatDate(t.txn_date)}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">
                            {fromP?.name ?? "—"} → {toP?.name ?? "—"}
                          </span>
                          {feeNum > 0 ? (
                            <Badge>fee {Number(t.fee).toLocaleString()}</Badge>
                          ) : null}
                          {converted ? (
                            <Badge tone="accent">
                              @ {Number(t.exchange_rate).toLocaleString()}
                            </Badge>
                          ) : null}
                        </span>
                        {t.note ? (
                          <span className="mt-0.5 block text-xs text-faint">
                            {t.note}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <Money
                          amount={t.amount}
                          currency={fromCur}
                          sign="negative"
                          className="font-medium"
                        />
                      </Td>
                      <Td align="right">
                        <Money
                          amount={t.amount_received}
                          currency={toCur}
                          sign="positive"
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
          <CardHeader title="Move money" />
          <CardBody>
            {serviceError ? (
              <p className="text-[13px] text-muted">
                Accounts couldn&apos;t be loaded, so the form is unavailable
                until the transfer service is reachable again.
              </p>
            ) : canTransfer ? (
              <TransferForm portfolios={portfolios} />
            ) : (
              <p className="text-[13px] text-muted">
                Transfers need two accounts — you have {portfolios.length}.{" "}
                <Link
                  href="/portfolios"
                  className="font-medium text-accent underline-offset-4 hover:underline"
                >
                  Add another account
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
