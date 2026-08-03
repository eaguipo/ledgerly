import { createClient } from "@/lib/supabase/server";
import { log, startTimer } from "@/lib/logger";
import { getRequestId } from "@/lib/request-context";

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
const EXPENSE_SELECT =
  "id, merchant, category:expense_categories(name), " +
  "transaction:transactions!expenses_txn_kind_fk(id, amount, txn_date, description, " +
  "currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))";

const INCOME_SELECT =
  "id, source, source_name, is_recurring, " +
  "transaction:transactions!incomes_txn_kind_fk(id, amount, txn_date, description, " +
  "currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))";

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
      _category_id: body.category_id,
      _amount: body.amount,
      _txn_date: body.txn_date,
      _description: body.description ?? null,
      _merchant: body.merchant ?? null,
    });
    return done(error ? dbFail(error) : json({ expense: data }, 201));
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
    const { data, error } = await activePortfolios(sb);
    return done(error ? dbFail(error) : json({ portfolios: data ?? [] }));
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
    });
    return done(error ? dbFail(error) : json({ income: data }, 201));
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

  if (debtId && method === "GET") {
    if (!UUID_RE.test(debtId)) return done(json({ error: "Invalid debt id." }, 400));
    const [debt, payments] = await Promise.all([
      sb.from("debts").select(DEBT_SELECT).eq("id", debtId).maybeSingle(),
      sb.from("debt_payments").select(DEBT_PAYMENT_SELECT).eq("debt_id", debtId)
        .order("payment_date", { ascending: false }),
    ]);
    const error = debt.error ?? payments.error;
    if (error) return done(dbFail(error));
    if (!debt.data) return done(json({ error: "Debt not found." }, 404));
    return done(json({ debt: debt.data, payments: payments.data ?? [] }));
  }

  if (debtId && method === "PATCH") {
    if (!UUID_RE.test(debtId)) return done(json({ error: "Invalid debt id." }, 400));
    const { data, error } = await sb
      .from("debts")
      .update(body)
      .eq("id", debtId)
      .select(DEBT_SELECT)
      .maybeSingle();
    if (error) return done(dbFail(error));
    if (!data) return done(json({ error: "Debt not found." }, 404));
    // Mirrors the ledger route: un-writing-off has to re-derive the status from
    // the payment history, or a debt with payments reopens as 'open'.
    if (body.status === "open") {
      const { error: recErr } = await sb.rpc("recompute_debt", { _debt_id: debtId });
      if (recErr) {
        callLog.error("ledger.local.reopen_recompute_failed", { debtId, message: recErr.message });
      } else {
        const { data: fresh } = await sb
          .from("debts").select(DEBT_SELECT).eq("id", debtId).maybeSingle();
        if (fresh) return done(json({ debt: fresh }));
      }
    }
    return done(json({ debt: data }));
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

  callLog.warn("ledger.local.unknown_route", { method, route });
  return done(json({ error: `No local handler for ${method} ${route}` }, 404));
}
