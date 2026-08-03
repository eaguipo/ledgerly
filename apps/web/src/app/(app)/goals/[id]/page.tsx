import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ledgerFetch } from "@/lib/ledger";
import { startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { GoalForm } from "../goal-form";
import { updateGoal } from "../actions";
import { one } from "../constants";
import type { CurrencyOption, GoalAccount, GoalRow } from "../types";
import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { amountInputValue, formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Edit goal" };

export default async function EditGoalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // Next 16: route params are async.

  const log = await requestLogger({ page: "/goals/[id]", goalId: id });
  const elapsed = startTimer();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("goal.edit.unauthenticated");
    redirect("/login");
  }

  const pageLog = log.child({ userId: user.id });

  const [detailRes, optionsRes] = await Promise.all([
    ledgerFetch(`/ledger/goals/${id}`),
    ledgerFetch("/ledger/goals/options"),
  ]);

  if (!detailRes.ok) {
    // "Not yours" and "not there" are deliberately indistinguishable — the
    // ledger filters by user_id either way.
    pageLog.warn("goal.edit.not_found", {
      status: detailRes.status,
      redirectedTo: "/goals",
      durationMs: elapsed(),
    });
    redirect("/goals");
  }

  const detail = (await detailRes.json()) as { goal: GoalRow };
  const goal = detail.goal;
  const currency = one(goal.currency);
  const linked = one(goal.linked_portfolio);

  const options = optionsRes.ok
    ? ((await optionsRes.json()) as {
        portfolios?: GoalAccount[];
        currencies?: CurrencyOption[];
      })
    : {};

  pageLog.debug("goal.edit.load_ok", {
    status: goal.status,
    durationMs: elapsed(),
  });

  return (
    <PageContainer>
      <nav className="mb-4">
        <Link
          href="/goals"
          className="text-[13px] text-muted transition-colors hover:text-ink"
        >
          ← Goals
        </Link>
      </nav>

      <div className="max-w-xl">
        <Card>
          <CardHeader
            title="Edit goal"
            description={`${formatMoney(goal.current_amount, currency)} set aside so far`}
          />
          <CardBody>
            <GoalForm
              mode="edit"
              action={updateGoal}
              accounts={options.portfolios ?? []}
              currencies={options.currencies ?? []}
              goal={{
                id: goal.id,
                name: goal.name,
                target_amount: amountInputValue(goal.target_amount),
                target_date: goal.target_date,
                currency_code: currency?.code ?? "—",
                linked_portfolio_name: linked?.name ?? null,
              }}
              submitLabel="Save changes"
            />
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
