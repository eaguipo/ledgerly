import { createClient } from "@/lib/supabase/server";
import { log, startTimer } from "@/lib/logger";
import { getRequestId } from "@/lib/request-context";
import { distinctLabels } from "@/lib/custom-choice";

/**
 * The ledger service's API, served in-process against Supabase.
 *
 * `main` ships on Vercel with no api-gateway and no ledger pod (CLAUDE.md,
 * DEVELOPER-GUIDE §7), so on that deploy the four ledger-backed features have
 * nothing to call. This module answers the same paths with the same JSON shapes,
 * so pages and Server Actions do not know which deployment they are running on.
 *
 * SECURITY — this is the RLS path, not a second service-role path. Reads go
 * through the anon-key server client, so every policy in db/policies.sql applies
 * and rows are scoped to the session's user without an explicit user_id filter;
 * that is the boundary here, exactly as it is for /portfolios and /dashboard.
 * Writes call the do_* RPCs, which take no user id and derive it from auth.uid()
 * (db/functions/authenticated_entry_points.sql). The web tier never touches the
 * service-role key — see the layer table in MAINTENANCE §2.1.
 *
 * Keep the response shapes identical to services/ledger/src/server.ts. A drift
 * here shows up as a page rendering empty on one deploy and fine on the other.
 */

/** Same embed strings the ledger uses — see services/ledger/src/server.ts. */
// investment_id / debt_id are for the list's benefit, not to be shown: a row
// carrying either is another feature's ledger leg, and the list uses them to
// withhold Edit and Delete rather than offer an action the RPC will refuse.
const EXPENSE_SELECT =
  "id, merchant, investment_id, debt_id, category:expense_categories(name), " +
  "transaction:transactions!expenses_txn_kind_fk(id, amount, txn_date, description, " +
  "currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))";

const INCOME_SELECT =
  "id, source, source_name, source_label, is_recurring, debt_id, " +
  "transaction:transactions!incomes_txn_kind_fk(id, amount, txn_date, description, " +
  "currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))";

/**
 * What an EDIT form needs, as opposed to what a list renders: raw ids instead of
 * display names, plus the columns that say whether this row is another feature's
 * ledger leg (`investment_id` / `debt_id`) and so belongs to that page, not this
 * one. Kept beside the display selects so the pair cannot drift apart.
 */
const EXPENSE_EDIT_SELECT =
  "id, merchant, category_id, investment_id, debt_id, " +
  "transaction:transactions!expenses_txn_kind_fk(" +
  "id, amount, txn_date, description, portfolio_id)";

const INCOME_EDIT_SELECT =
  "id, source, source_name, source_label, is_recurring, debt_id, " +
  "transaction:transactions!incomes_txn_kind_fk(" +
  "id, amount, txn_date, description, portfolio_id)";

/**
 * Fields a PATCH may carry, mirroring what services/ledger/src/server.ts
 * validates. `undefined` means "leave alone" and an explicit null means "clear",
 * which is why these are copied by presence rather than by truthiness.
 */
const EXPENSE_PATCHABLE = [
  "portfolio_id",
  "category_id",
  "new_category",
  "amount",
  "txn_date",
  "description",
  "merchant",
] as const;

const INCOME_PATCHABLE = [
  "portfolio_id",
  "amount",
  "source",
  "source_label",
  "source_name",
  "txn_date",
  "description",
  "is_recurring",
] as const;

const TRANSFER_SELECT =
  "id, amount, fee, exchange_rate, amount_received, txn_date, note, " +
  "from_portfolio:portfolios!from_portfolio_id(name), " +
  "to_portfolio:portfolios!to_portfolio_id(name), " +
  "from_currency:currencies!from_currency_id(code, symbol, minor_unit), " +
  "to_currency:currencies!to_currency_id(code, symbol, minor_unit)";

const DEBT_SELECT =
  "id, kind, counterparty, principal_amount, outstanding_balance, interest_rate, " +
  "status, due_date, note, is_archived, created_at, " +
  "currency:currencies(code, symbol, minor_unit)";

const DEBT_PAYMENT_SELECT =
  "id, amount, principal_portion, interest_portion, payment_date, note, " +
  "transaction:transactions(id, kind, portfolio:portfolios(name))";

// Cash-free corrections to what is owed. No transaction embed on purpose —
// having none is exactly what distinguishes an adjustment from a payment.
const DEBT_ADJUSTMENT_SELECT =
  "id, amount, reason, effective_on, note, created_at";

const GOAL_SELECT =
  "id, name, target_amount, current_amount, currency_id, linked_portfolio_id, " +
  "status, target_date, achieved_at, first_achieved_at, created_at, " +
  "currency:currencies(code, symbol, minor_unit), " +
  "linked_portfolio:portfolios!linked_portfolio_id(name, current_balance)";

const INVESTMENT_SELECT =
  "id, name, kind, kind_label, symbol, quantity, average_cost, invested_amount, " +
  "current_value, unrealized_gain, opened_on, maturity_date, is_active, " +
  "portfolio_id, currency_id, created_at, currency:currencies(code, symbol, minor_unit), " +
  "portfolio:portfolios(name)";

const SNAPSHOT_SELECT =
  "id, as_of_date, market_value, unit_price, quantity, source, created_at";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Postgres guard errors are the user's problem (400); anything else is ours. */
function dbFail(error: { message: string; code?: string }): Response {
  return json({ error: error.message }, 400);
}

function limitOf(url: URL): number {
  return Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 200);
}

type Supa = Awaited<ReturnType<typeof createClient>>;

async function activePortfolios(sb: Supa) {
  return sb
    .from("portfolios")
    .select("id, name, current_balance, currency:currencies(code, symbol, minor_unit)")
    .eq("is_archived", false)
    .order("sort_order")
    .order("created_at");
}

export async function localLedger(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const reqId = await getRequestId();
  const method = (init?.method ?? "GET").toUpperCase();
  const callLog = log.child({ reqId, component: "ledger-local" });
  const elapsed = startTimer();

  // Paths arrive as "/ledger/…" so the call sites stay identical to the mesh
  // path. Parse against a dummy origin to get search params for free.
  const url = new URL(`http://local${path}`);
  const route = url.pathname.replace(/^\/ledger/, "");
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

  const sb = await createClient();
  callLog.debug("ledger.local.start", { method, route });

  const done = (res: Response) => {
    callLog.debug("ledger.local.done", {
      method,
      route,
      status: res.status,
      durationMs: elapsed(),
    });
    return res;
  };

  // ---- expenses ----------------------------------------------------------
  if (route === "/expenses" && method === "GET") {
    const { data, error } = await sb
      .from("expenses")
      .select(EXPENSE_SELECT)
      .order("created_at", { ascending: false })
      .limit(limitOf(url));
    return done(error ? dbFail(error) : json({ expenses: data ?? [] }));
  }

  if (route === "/expenses/options" && method === "GET") {
    const [portfolios, categories] = await Promise.all([
      sb.from("portfolios").select("id, name").eq("is_archived", false)
        .order("sort_order").order("created_at"),
      sb.from("expense_categories").select("id, name").eq("is_active", true).order("name"),
    ]);
    const error = portfolios.error ?? categories.error;
    return done(
      error
        ? dbFail(error)
        : json({ portfolios: portfolios.data ?? [], categories: categories.data ?? [] }),
    );
  }

  if (route === "/expenses" && method === "POST") {
    const { data, error } = await sb.rpc("do_expense", {
      _portfolio_id: body.portfolio_id,
      _category_id: body.category_id ?? null,
      _amount: body.amount,
      _txn_date: body.txn_date,
      _description: body.description ?? null,
      _merchant: body.merchant ?? null,
      // Null category + a name here means "create this category as part of the
      // expense"; the RPC find-or-creates it in the same transaction.
      _new_category: body.new_category ?? null,
    });
    return done(error ? dbFail(error) : json({ expense: data }, 201));
  }

  // Matched AFTER "/expenses/options" above — "options" is a valid capture for
  // this regex, and the order is what stops it being treated as an id.
  const expenseId = route.match(/^\/expenses\/([^/]+)$/)?.[1];

  if (expenseId && method === "GET") {
    if (!UUID_RE.test(expenseId))
      return done(json({ error: "Invalid expense id." }, 400));
    const { data, error } = await sb
      .from("expenses")
      .select(EXPENSE_EDIT_SELECT)
      .eq("id", expenseId)
      .maybeSingle();
    if (error) return done(dbFail(error));
    if (!data) return done(json({ error: "Expense not found." }, 404));
    return done(json({ expense: data }));
  }

  if (expenseId && method === "PATCH") {
    if (!UUID_RE.test(expenseId))
      return done(json({ error: "Invalid expense id." }, 400));
    // Allow-listed rather than forwarded whole, so the two transports accept
    // exactly the same fields — a patch that works on the mesh and not on Vercel
    // is the failure mode this file exists to prevent.
    const patch: Record<string, unknown> = {};
    for (const field of EXPENSE_PATCHABLE) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    // An existing category wins over a typed one, the precedence create_expense
    // and update_expense both apply.
    if (patch.category_id) delete patch.new_category;
    if (Object.keys(patch).length === 0)
      return done(json({ error: "Nothing to update." }, 400));
    const { data, error } = await sb.rpc("do_expense_update", {
      _expense_id: expenseId,
      _patch: patch,
    });
    return done(error ? dbFail(error) : json({ expense: data }));
  }

  if (expenseId && method === "DELETE") {
    if (!UUID_RE.test(expenseId))
      return done(json({ error: "Invalid expense id." }, 400));
    const { data, error } = await sb.rpc("do_expense_delete", {
      _expense_id: expenseId,
    });
    return done(error ? dbFail(error) : json({ deleted: data }));
  }

  // ---- incomes -----------------------------------------------------------
  if (route === "/incomes" && method === "GET") {
    const { data, error } = await sb
      .from("incomes")
      .select(INCOME_SELECT)
      .order("created_at", { ascending: false })
      .limit(limitOf(url));
    return done(error ? dbFail(error) : json({ incomes: data ?? [] }));
  }

  if (route === "/incomes/options" && method === "GET") {
    const [portfolios, labels] = await Promise.all([
      activePortfolios(sb),
      // Capped: this only feeds an autocomplete list, and a user with thousands
      // of income rows would otherwise pull them all to find a handful of names.
      sb
        .from("incomes")
        .select("source_label")
        .not("source_label", "is", null)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    const error = portfolios.error ?? labels.error;
    return done(
      error
        ? dbFail(error)
        : json({
            portfolios: portfolios.data ?? [],
            source_labels: distinctLabels(
              (labels.data ?? []).map((r) => r.source_label),
            ),
          }),
    );
  }

  if (route === "/incomes" && method === "POST") {
    const { data, error } = await sb.rpc("do_income", {
      _portfolio_id: body.portfolio_id,
      _amount: body.amount,
      _source: body.source,
      _txn_date: body.txn_date,
      _source_name: body.source_name ?? null,
      _description: body.description ?? null,
      _is_recurring: body.is_recurring === true,
      // Only ever set alongside source='other' — the DB check constraint and
      // the RPC both reject it on any other source.
      _source_label: body.source_label ?? null,
    });
    return done(error ? dbFail(error) : json({ income: data }, 201));
  }

  const incomeId = route.match(/^\/incomes\/([^/]+)$/)?.[1];

  if (incomeId && method === "GET") {
    if (!UUID_RE.test(incomeId))
      return done(json({ error: "Invalid income id." }, 400));
    const { data, error } = await sb
      .from("incomes")
      .select(INCOME_EDIT_SELECT)
      .eq("id", incomeId)
      .maybeSingle();
    if (error) return done(dbFail(error));
    if (!data) return done(json({ error: "Income entry not found." }, 404));
    return done(json({ income: data }));
  }

  if (incomeId && method === "PATCH") {
    if (!UUID_RE.test(incomeId))
      return done(json({ error: "Invalid income id." }, 400));
    const patch: Record<string, unknown> = {};
    for (const field of INCOME_PATCHABLE) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0)
      return done(json({ error: "Nothing to update." }, 400));
    const { data, error } = await sb.rpc("do_income_update", {
      _income_id: incomeId,
      _patch: patch,
    });
    return done(error ? dbFail(error) : json({ income: data }));
  }

  if (incomeId && method === "DELETE") {
    if (!UUID_RE.test(incomeId))
      return done(json({ error: "Invalid income id." }, 400));
    const { data, error } = await sb.rpc("do_income_delete", {
      _income_id: incomeId,
    });
    return done(error ? dbFail(error) : json({ deleted: data }));
  }

  // ---- transfers ---------------------------------------------------------
  if (route === "/transfers" && method === "GET") {
    const { data, error } = await sb
      .from("transfers")
      .select(TRANSFER_SELECT)
      .order("created_at", { ascending: false })
      .limit(limitOf(url));
    return done(error ? dbFail(error) : json({ transfers: data ?? [] }));
  }

  if (route === "/transfers/options" && method === "GET") {
    const { data, error } = await activePortfolios(sb);
    return done(error ? dbFail(error) : json({ portfolios: data ?? [] }));
  }

  if (route === "/transfers" && method === "POST") {
    const { data, error } = await sb.rpc("do_transfer", {
      _from_portfolio: body.from_portfolio_id,
      _to_portfolio: body.to_portfolio_id,
      _amount: body.amount,
      _fee: body.fee ?? 0,
      _exchange_rate: body.exchange_rate ?? 1,
      _txn_date: body.txn_date,
      _note: body.note ?? null,
    });
    return done(error ? dbFail(error) : json({ transfer: data }, 201));
  }

  // ---- debts -------------------------------------------------------------
  if (route === "/debts" && method === "GET") {
    const { data, error } = await sb
      .from("debts")
      .select(DEBT_SELECT)
      .order("is_archived")
      .order("created_at", { ascending: false })
      .limit(limitOf(url));
    return done(error ? dbFail(error) : json({ debts: data ?? [] }));
  }

  if (route === "/debts/options" && method === "GET") {
    const [portfolios, currencies] = await Promise.all([
      activePortfolios(sb),
      sb.from("currencies").select("id, code, symbol, minor_unit").eq("is_active", true).order("code"),
    ]);
    const error = portfolios.error ?? currencies.error;
    return done(
      error
        ? dbFail(error)
        : json({ portfolios: portfolios.data ?? [], currencies: currencies.data ?? [] }),
    );
  }

  if (route === "/debts" && method === "POST") {
    const { data, error } = await sb.rpc("do_debt", {
      _kind: body.kind,
      _counterparty: body.counterparty,
      _principal: body.principal_amount,
      _currency_id: body.currency_id,
      _interest_rate: body.interest_rate ?? null,
      _due_date: body.due_date ?? null,
      _note: body.note ?? null,
      _disbursement_portfolio: body.disbursement_portfolio_id ?? null,
      _disbursement_date: body.disbursement_date ?? null,
    });
    return done(error ? dbFail(error) : json({ debt: data }, 201));
  }

  const debtId = route.match(/^\/debts\/([^/]+)$/)?.[1];
  const paymentsFor = route.match(/^\/debts\/([^/]+)\/payments$/)?.[1];
  const adjustmentsFor = route.match(/^\/debts\/([^/]+)\/adjustments$/)?.[1];
  const adjustmentId = route.match(/^\/debts\/[^/]+\/adjustments\/([^/]+)$/)?.[1];

  if (debtId && method === "GET") {
    if (!UUID_RE.test(debtId)) return done(json({ error: "Invalid debt id." }, 400));
    const [debt, payments, adjustments, disbIn, disbOut] = await Promise.all([
      sb.from("debts").select(DEBT_SELECT).eq("id", debtId).maybeSingle(),
      sb.from("debt_payments").select(DEBT_PAYMENT_SELECT).eq("debt_id", debtId)
        .order("payment_date", { ascending: false }),
      sb.from("debt_adjustments").select(DEBT_ADJUSTMENT_SELECT).eq("debt_id", debtId)
        .order("effective_on", { ascending: false })
        .order("created_at", { ascending: false }),
      // Did this debt post a disbursement? An incomes row for a payable, an
      // expenses row for a receivable — it decides whether re-tagging moves
      // money, and nothing else on the response answers it.
      sb.from("incomes").select("transaction_id").eq("debt_id", debtId).limit(1).maybeSingle(),
      sb.from("expenses").select("transaction_id").eq("debt_id", debtId).limit(1).maybeSingle(),
    ]);
    const error = debt.error ?? payments.error;
    if (error) return done(dbFail(error));
    if (!debt.data) return done(json({ error: "Debt not found." }, 404));
    return done(
      json({
        debt: debt.data,
        payments: payments.data ?? [],
        adjustments: adjustments.data ?? [],
        disbursement_transaction_id:
          disbIn.data?.transaction_id ?? disbOut.data?.transaction_id ?? null,
      }),
    );
  }

  if (debtId && method === "PATCH") {
    if (!UUID_RE.test(debtId)) return done(json({ error: "Invalid debt id." }, 400));
    // Allow-listed and routed through the RPC rather than written straight to
    // the table. `kind` is why: re-tagging payable <-> receivable has to re-post
    // every ledger leg in the opposite direction, and a plain
    // `update debts set kind = …` would leave the ledger contradicting the debt.
    const PATCHABLE = [
      "kind",
      "counterparty",
      "principal_amount",
      "interest_rate",
      "due_date",
      "note",
      "is_archived",
      "status",
    ] as const;
    const patch: Record<string, unknown> = {};
    for (const field of PATCHABLE) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0)
      return done(json({ error: "Nothing to update." }, 400));
    const { data, error } = await sb.rpc("do_debt_update", {
      _debt_id: debtId,
      _patch: patch,
    });
    if (error) return done(dbFail(error));
    // update_debt() already re-derived the status after an un-write-off, so
    // unlike the old direct-write version there is no second recompute here.
    const { data: fresh } = await sb
      .from("debts").select(DEBT_SELECT).eq("id", debtId).maybeSingle();
    if (!fresh) return done(json({ error: "Debt not found." }, 404));
    return done(
      json({
        debt: fresh,
        retagged: (data as { retagged?: boolean } | null)?.retagged ?? false,
      }),
    );
  }

  if (adjustmentsFor && method === "POST") {
    if (!UUID_RE.test(adjustmentsFor))
      return done(json({ error: "Invalid debt id." }, 400));
    const { data, error } = await sb.rpc("do_debt_adjustment", {
      _debt_id: adjustmentsFor,
      _amount: body.amount,
      _reason: body.reason,
      _effective_on: body.effective_on ?? null,
      _note: body.note ?? null,
    });
    return done(error ? dbFail(error) : json({ adjustment: data }, 201));
  }

  if (adjustmentId && method === "DELETE") {
    if (!UUID_RE.test(adjustmentId))
      return done(json({ error: "Invalid adjustment id." }, 400));
    const { data, error } = await sb.rpc("do_debt_adjustment_delete", {
      _adjustment_id: adjustmentId,
    });
    return done(error ? dbFail(error) : json({ deleted: data }));
  }

  if (paymentsFor && method === "POST") {
    if (!UUID_RE.test(paymentsFor)) return done(json({ error: "Invalid debt id." }, 400));
    // The form sends `interest_portion`, and the principal is DERIVED from it
    // rather than sent — same as the ledger route — so a form that disagrees
    // with itself cannot trip the DB's principal + interest = amount constraint.
    const amount = Number(body.amount);
    const interest =
      body.interest_portion === undefined ||
      body.interest_portion === null ||
      body.interest_portion === ""
        ? 0
        : Number(body.interest_portion);
    const { data, error } = await sb.rpc("do_debt_payment", {
      _debt_id: paymentsFor,
      _portfolio_id: body.portfolio_id,
      _amount: amount,
      _principal: amount - interest,
      _interest: interest,
      _payment_date: body.payment_date,
      _note: body.note ?? null,
    });
    return done(error ? dbFail(error) : json({ payment: data }, 201));
  }

  // ---- goals -------------------------------------------------------------
  if (route === "/goals" && method === "GET") {
    // Cancelled hides with archived: both mean "not something I'm working
    // toward". Matches the ledger route's filter exactly.
    let q = sb.from("goals").select(GOAL_SELECT);
    if (url.searchParams.get("include_archived") !== "true") {
      q = q.not("status", "in", "(archived,cancelled)");
    }
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .limit(limitOf(url));
    return done(error ? dbFail(error) : json({ goals: data ?? [] }));
  }

  if (route === "/goals/options" && method === "GET") {
    const [portfolios, currencies] = await Promise.all([
      activePortfolios(sb),
      sb.from("currencies").select("id, code, symbol, minor_unit").eq("is_active", true).order("code"),
    ]);
    const error = portfolios.error ?? currencies.error;
    return done(
      error
        ? dbFail(error)
        : json({ portfolios: portfolios.data ?? [], currencies: currencies.data ?? [] }),
    );
  }

  if (route === "/goals" && method === "POST") {
    const { data, error } = await sb.rpc("do_goal", {
      _name: body.name,
      _target: body.target_amount,
      _currency_id: body.currency_id,
      _target_date: body.target_date ?? null,
      _linked_portfolio: body.linked_portfolio_id ?? null,
    });
    return done(error ? dbFail(error) : json({ goal: data }, 201));
  }

  const goalId = route.match(/^\/goals\/([^/]+)$/)?.[1];
  const contributionsFor = route.match(/^\/goals\/([^/]+)\/contributions$/)?.[1];

  if (goalId && method === "GET") {
    if (!UUID_RE.test(goalId)) return done(json({ error: "Invalid goal id." }, 400));
    const { data, error } = await sb
      .from("goals")
      .select(GOAL_SELECT)
      .eq("id", goalId)
      .maybeSingle();
    if (error) return done(dbFail(error));
    if (!data) return done(json({ error: "Goal not found." }, 404));
    return done(json({ goal: data }));
  }

  if (goalId && method === "PATCH") {
    if (!UUID_RE.test(goalId)) return done(json({ error: "Invalid goal id." }, 400));
    // No status special-case here, unlike the debts PATCH: trg_goal_status is a
    // BEFORE trigger on goals, so reopening one that is already at its target
    // corrects itself to 'achieved' inside this same statement.
    const { data, error } = await sb
      .from("goals")
      .update(body)
      .eq("id", goalId)
      .select(GOAL_SELECT)
      .maybeSingle();
    if (error) return done(dbFail(error));
    if (!data) return done(json({ error: "Goal not found." }, 404));
    return done(json({ goal: data }));
  }

  if (contributionsFor && method === "POST") {
    if (!UUID_RE.test(contributionsFor))
      return done(json({ error: "Invalid goal id." }, 400));
    const { data, error } = await sb.rpc("do_goal_contribution", {
      _goal_id: contributionsFor,
      _amount: body.amount,
      _contributed_on: body.contributed_on,
      _note: body.note ?? null,
    });
    return done(error ? dbFail(error) : json({ contribution: data }, 201));
  }

  // ---- investments -------------------------------------------------------
  // Creating a holding CAN move money as of db/functions/money_invested.sql: a
  // paying account posts a real outflow, excluded from both report views so
  // buying an asset never reads as spending. Blank account = record-only, for
  // something you already owned. Snapshots still move nothing — a valuation is
  // an observation, and gains stay unrealised until you sell.
  if (route === "/investments" && method === "GET") {
    let q = sb.from("investments").select(INVESTMENT_SELECT);
    if (url.searchParams.get("include_inactive") !== "true") {
      q = q.eq("is_active", true);
    }
    const kind = url.searchParams.get("kind");
    if (kind) q = q.eq("kind", kind);
    const { data, error } = await q
      .order("is_active", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limitOf(url));
    return done(error ? dbFail(error) : json({ investments: data ?? [] }));
  }

  // Checked before the /investments/:id match below — "options" is a valid
  // capture for that regex, and the order is what stops it being treated as one.
  if (route === "/investments/options" && method === "GET") {
    const [portfolios, currencies, labels] = await Promise.all([
      activePortfolios(sb),
      sb.from("currencies").select("id, code, symbol, minor_unit").eq("is_active", true).order("code"),
      // Capped like the income form's suggestion list: this feeds autocomplete
      // and must not scale with how many holdings someone has.
      sb
        .from("investments")
        .select("kind_label")
        .not("kind_label", "is", null)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    const error = portfolios.error ?? currencies.error ?? labels.error;
    return done(
      error
        ? dbFail(error)
        : json({
            portfolios: portfolios.data ?? [],
            currencies: currencies.data ?? [],
            kind_labels: distinctLabels(
              (labels.data ?? []).map((r) => r.kind_label),
            ),
          }),
    );
  }

  if (route === "/investments" && method === "POST") {
    const { data, error } = await sb.rpc("do_investment", {
      _name: body.name,
      _kind: body.kind,
      _currency_id: body.currency_id,
      _invested_amount: body.invested_amount,
      _symbol: body.symbol ?? null,
      _quantity: body.quantity ?? null,
      _average_cost: body.average_cost ?? null,
      _opened_on: body.opened_on ?? null,
      _maturity_date: body.maturity_date ?? null,
      _portfolio_id: body.portfolio_id ?? null,
      // Only ever set alongside kind='other_asset' — the DB check constraint and
      // the RPC both reject it on any other kind.
      _kind_label: body.kind_label ?? null,
    });
    return done(error ? dbFail(error) : json({ investment: data }, 201));
  }

  const investmentId = route.match(/^\/investments\/([^/]+)$/)?.[1];
  const snapshotsFor = route.match(/^\/investments\/([^/]+)\/snapshots$/)?.[1];

  if (investmentId && method === "GET") {
    if (!UUID_RE.test(investmentId))
      return done(json({ error: "Invalid investment id." }, 400));
    const [investment, snapshots, purchase] = await Promise.all([
      sb.from("investments").select(INVESTMENT_SELECT).eq("id", investmentId).maybeSingle(),
      sb
        .from("investment_snapshots")
        .select(SNAPSHOT_SELECT)
        .eq("investment_id", investmentId)
        .order("as_of_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(200),
      // The purchase leg, if this holding posted one — NOT the same question as
      // investments.portfolio_id, which on a pre-money_invested.sql holding was
      // only ever a label. See the ledger route.
      sb
        .from("expenses")
        .select("transaction_id, transaction:transactions(amount, txn_date, portfolio_id)")
        .eq("investment_id", investmentId)
        .limit(1)
        .maybeSingle(),
    ]);
    const error = investment.error ?? snapshots.error;
    if (error) return done(dbFail(error));
    if (!investment.data) return done(json({ error: "Investment not found." }, 404));
    return done(
      json({
        investment: investment.data,
        snapshots: snapshots.data ?? [],
        purchase: purchase.data ?? null,
      }),
    );
  }

  if (investmentId && method === "PATCH") {
    if (!UUID_RE.test(investmentId))
      return done(json({ error: "Invalid investment id." }, 400));
    // Allow-listed rather than passing the body straight through, unlike the
    // debts and goals handlers above. Two columns here must never be written by
    // a caller: `current_value` is owned by sync_investment_current_value() and
    // an update would silently revert on the next snapshot, and
    // `unrealized_gain` is GENERATED and would raise. The ledger route builds
    // its patch field by field for the same reason, and the two transports have
    // to accept the same things or a write works on one deploy and not the
    // other.
    const PATCHABLE = [
      "name",
      "kind",
      "kind_label",
      "symbol",
      "invested_amount",
      "quantity",
      "average_cost",
      "opened_on",
      "maturity_date",
      "portfolio_id",
      "is_active",
    ] as const;
    const patch: Record<string, unknown> = {};
    for (const field of PATCHABLE) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0)
      return done(json({ error: "Nothing to update." }, 400));
    // Through do_investment_update rather than a direct table write: a holding
    // bought from an account has a real ledger row behind it, and a plain
    // `update investments set invested_amount = …` would leave that row — and
    // the paying account's balance — saying something different. The RPC also
    // handles clearing kind_label when the kind moves off the catch-all, which
    // this handler used to have to do itself.
    const { error } = await sb.rpc("do_investment_update", {
      _investment_id: investmentId,
      _patch: patch,
    });
    if (error) return done(dbFail(error));
    // The RPC returns a summary, not the row — re-read so this answers with the
    // same shape as the ledger route.
    const { data } = await sb
      .from("investments")
      .select(INVESTMENT_SELECT)
      .eq("id", investmentId)
      .maybeSingle();
    if (!data) return done(json({ error: "Investment not found." }, 404));
    return done(json({ investment: data }));
  }

  if (investmentId && method === "DELETE") {
    if (!UUID_RE.test(investmentId))
      return done(json({ error: "Invalid investment id." }, 400));
    // Deletes the valuation history AND the purchase that paid for the holding
    // — see the ledger route for why leaving the purchase behind would make it
    // read as ordinary spending.
    const { data, error } = await sb.rpc("do_investment_delete", {
      _investment_id: investmentId,
    });
    return done(error ? dbFail(error) : json({ deleted: data }));
  }

  if (snapshotsFor && method === "POST") {
    if (!UUID_RE.test(snapshotsFor))
      return done(json({ error: "Invalid investment id." }, 400));
    const { data, error } = await sb.rpc("do_investment_snapshot", {
      _investment_id: snapshotsFor,
      _market_value: body.market_value,
      _as_of_date: body.as_of_date,
      _unit_price: body.unit_price ?? null,
      _quantity: body.quantity ?? null,
      _source: body.source ?? null,
    });
    return done(error ? dbFail(error) : json({ snapshot: data }, 201));
  }

  callLog.warn("ledger.local.unknown_route", { method, route });
  return done(json({ error: `No local handler for ${method} ${route}` }, 404));
}
