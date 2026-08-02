import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { admin } from "./supabase";
import {
  LOG_LEVEL,
  REQUEST_ID_HEADER,
  dbErrorFields,
  genReqId,
  installProcessLogging,
  loggerOptions,
  quietLogController,
} from "./logging";

const PORT = Number(process.env.PORT ?? 8080);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Defense-in-depth: only the gateway knows this shared secret. It backs the
// x-user-id trust (which alone is forgeable by any pod that can reach us) and
// works regardless of NetworkPolicy/CNI enforcement. Set via Helm secretEnv.
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

const app = Fastify({
  logger: loggerOptions("ledger"),
  // Adopt the caller's correlation id so these lines line up with the web app's
  // and the gateway's for the same user action. See ./logging.ts.
  requestIdHeader: REQUEST_ID_HEADER,
  genReqId,
  logController: quietLogController(["/healthz"]),
});

/** Milliseconds since `from`, one decimal place. */
function since(from: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - from) / 1e5) / 10;
}

// Reject any caller that isn't the gateway (health checks exempt).
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/healthz") return;
  if (INTERNAL_SECRET) {
    const got = req.headers["x-internal-secret"];
    const val = Array.isArray(got) ? got[0] : got;
    if (val !== INTERNAL_SECRET) {
      // The single most common cause of a 403 here is the gateway and the
      // ledger holding different INTERNAL_API_SECRET values (e.g. only one pod
      // was restarted after the secret changed). Say which of the two it is:
      // a missing header means the caller is not the gateway at all.
      req.log.warn(
        {
          url: req.url,
          remoteAddress: req.ip,
          secretPresented: val !== undefined,
          hint:
            val === undefined
              ? "no x-internal-secret header — caller is not the api-gateway"
              : "x-internal-secret mismatch — gateway and ledger disagree on INTERNAL_API_SECRET",
        },
        "ledger.auth.internal_secret_rejected",
      );
      reply.code(403).send({ error: "forbidden" });
      return reply;
    }
  } else {
    req.log.warn(
      { url: req.url },
      "INTERNAL_API_SECRET is not set — gateway trust is unenforced",
    );
  }
});

/** Identity comes from the gateway, which sets x-user-id after validating the JWT. */
function userIdOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const raw = req.headers["x-user-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    req.log.warn(
      {
        url: req.url,
        present: id !== undefined,
        // The value itself is a plain uuid, but log only its shape when it is
        // malformed — a garbage header is not something to echo back verbatim.
        length: typeof id === "string" ? id.length : 0,
      },
      "ledger.auth.user_id_invalid",
    );
    reply.code(401).send({ error: "missing or invalid x-user-id" });
    return null;
  }
  return id;
}

// The expense row shape the web app renders. `expenses` has TWO foreign keys to
// `transactions` (plain transaction_id + the composite (transaction_id,txn_kind)),
// so PostgREST needs the FK name to disambiguate the embed. transaction_id is
// NOT NULL, so this is effectively an inner join.
const EXPENSE_SELECT =
  "id, merchant, category:expense_categories(name), " +
  "transaction:transactions!expenses_txn_kind_fk(id, amount, txn_date, description, " +
  "currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))";

app.get("/healthz", async () => ({ status: "ok" }));

// Recent expenses for the current user.
app.get("/expenses", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const q = req.query as { limit?: string };
  const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 200);
  const startedAt = process.hrtime.bigint();

  const { data, error } = await admin()
    .from("expenses")
    .select(EXPENSE_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error(
      { userId, limit, dbMs: since(startedAt), ...dbErrorFields(error) },
      "ledger.expenses.list_failed",
    );
    return reply.code(500).send({ error: error.message });
  }

  // dbMs is the Supabase round trip alone; Fastify's "request completed" line
  // carries the total. A wide gap between them points at this process, not the DB.
  req.log.debug(
    { userId, limit, returned: data?.length ?? 0, dbMs: since(startedAt) },
    "ledger.expenses.list_ok",
  );
  return { expenses: data ?? [] };
});

// Form options: the user's active accounts + active expense categories.
app.get("/expenses/options", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const sb = admin();
  const startedAt = process.hrtime.bigint();

  const [portfolios, categories] = await Promise.all([
    sb
      .from("portfolios")
      .select("id, name")
      .eq("user_id", userId)
      .eq("is_archived", false)
      .order("sort_order")
      .order("created_at"),
    sb
      .from("expense_categories")
      .select("id, name")
      .eq("user_id", userId) // categories are per-user; service-role bypasses RLS
      .eq("is_active", true)
      .order("name"),
  ]);

  if (portfolios.error || categories.error) {
    const error = portfolios.error ?? categories.error;
    req.log.error(
      {
        userId,
        failed: portfolios.error ? "portfolios" : "categories",
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.expenses.options_failed",
    );
    return reply.code(500).send({ error: error?.message });
  }

  const portfolioCount = portfolios.data?.length ?? 0;
  const categoryCount = categories.data?.length ?? 0;

  // Either list coming back empty disables the expense form in the UI, and the
  // usual cause is seed data never being run for this user — not a bug in the
  // form. Flag it here so the answer is one grep away.
  if (portfolioCount === 0 || categoryCount === 0) {
    req.log.warn(
      {
        userId,
        portfolios: portfolioCount,
        categories: categoryCount,
        dbMs: since(startedAt),
        hint: "expense form will be unavailable — user has no active accounts and/or no active categories",
      },
      "ledger.expenses.options_empty",
    );
  } else {
    req.log.debug(
      {
        userId,
        portfolios: portfolioCount,
        categories: categoryCount,
        dbMs: since(startedAt),
      },
      "ledger.expenses.options_ok",
    );
  }

  return { portfolios: portfolios.data ?? [], categories: categories.data ?? [] };
});

// Create an expense atomically via the create_expense RPC (mirrors do_transfer).
app.post("/expenses", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;

  const b = (req.body ?? {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  const portfolioId = String(b.portfolio_id ?? "");
  const categoryId = String(b.category_id ?? "");
  const txnDate = String(b.txn_date ?? "");
  const description = b.description ? String(b.description) : null;
  const merchant = b.merchant ? String(b.merchant) : null;

  // Money in, money out: log the request before touching the DB so a request
  // that never returns still leaves a trace of what it was trying to do. Free
  // text (merchant/description) stays out — it is the user's private data and
  // tells you nothing when debugging.
  req.log.debug(
    {
      userId,
      amount,
      portfolioId,
      categoryId,
      txnDate,
      hasDescription: description !== null,
      hasMerchant: merchant !== null,
    },
    "ledger.expense.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, field, amount, portfolioId, categoryId, txnDate },
      "ledger.expense.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return invalid("amount", "Amount must be greater than zero.");
  if (!UUID_RE.test(portfolioId))
    return invalid("portfolio_id", "Select an account.");
  if (!UUID_RE.test(categoryId))
    return invalid("category_id", "Select a category.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate))
    return invalid("txn_date", "Date is required.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_expense", {
    _user_id: userId,
    _portfolio_id: portfolioId,
    _category_id: categoryId,
    _amount: amount,
    _txn_date: txnDate,
    _description: description,
    _merchant: merchant,
  });

  if (error) {
    // Surface DB guard messages (insufficient funds, currency mismatch, …) as 400.
    // The Postgres error code separates "the guard fired" (P0001 raise, P0002
    // not-found, 23514 check constraint) from "the RPC is missing / the schema
    // cache is stale" (42883, PGRST202) — which is a deploy problem, not a
    // user one, and is worth finding without re-reading the SQL.
    req.log.warn(
      {
        userId,
        amount,
        portfolioId,
        categoryId,
        txnDate,
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.expense.create_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }

  const created = (data ?? {}) as {
    expense_id?: string;
    transaction_id?: string;
  };

  // The one line that proves money moved. `transactionId` is the handle for
  // finding the row in Supabase; `dbMs` is how long the atomic RPC took.
  req.log.info(
    {
      userId,
      expenseId: created.expense_id,
      transactionId: created.transaction_id,
      amount,
      portfolioId,
      categoryId,
      txnDate,
      dbMs: since(startedAt),
    },
    "ledger.expense.create_ok",
  );
  return reply.code(201).send({ expense: data });
});

// The income row shape the web app renders. `incomes` mirrors `expenses`: two
// foreign keys to `transactions`, so the composite FK name disambiguates the embed.
const INCOME_SELECT =
  "id, source, source_name, is_recurring, " +
  "transaction:transactions!incomes_txn_kind_fk(id, amount, txn_date, description, " +
  "currency:currencies(code, symbol, minor_unit), portfolio:portfolios(name))";

// `transfers` carries two FKs to portfolios and two to currencies; the !column
// hints tell PostgREST which leg each embed belongs to. The three transaction
// legs are deliberately not embedded — the list renders from the transfer row
// itself, which already holds both amounts.
const TRANSFER_SELECT =
  "id, amount, fee, exchange_rate, amount_received, txn_date, note, " +
  "from_portfolio:portfolios!from_portfolio_id(name), " +
  "to_portfolio:portfolios!to_portfolio_id(name), " +
  "from_currency:currencies!from_currency_id(code, symbol, minor_unit), " +
  "to_currency:currencies!to_currency_id(code, symbol, minor_unit)";

// Mirrors the public.income_source enum. Validating here turns a bad value into
// a clean 400 instead of a Postgres "invalid input value for enum" 500.
const INCOME_SOURCES = new Set([
  "salary",
  "business",
  "gains",
  "debt_payment_received",
  "gift",
  "other",
]);

/** The user's active accounts, with the currency the transfer form needs. */
async function activePortfolios(userId: string) {
  return admin()
    .from("portfolios")
    .select(
      "id, name, current_balance, currency:currencies(code, symbol, minor_unit)",
    )
    .eq("user_id", userId)
    .eq("is_archived", false)
    .order("sort_order")
    .order("created_at");
}

// Recent income entries for the current user.
app.get("/incomes", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const q = req.query as { limit?: string };
  const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 200);
  const startedAt = process.hrtime.bigint();

  const { data, error } = await admin()
    .from("incomes")
    .select(INCOME_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error(
      { userId, limit, dbMs: since(startedAt), ...dbErrorFields(error) },
      "ledger.incomes.list_failed",
    );
    return reply.code(500).send({ error: error.message });
  }

  req.log.debug(
    { userId, limit, returned: data?.length ?? 0, dbMs: since(startedAt) },
    "ledger.incomes.list_ok",
  );
  return { incomes: data ?? [] };
});

// Form options: the user's active accounts. Income sources are a fixed enum and
// are labelled in the web layer, the same way portfolio categories are.
app.get("/incomes/options", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const startedAt = process.hrtime.bigint();

  const { data, error } = await activePortfolios(userId);

  if (error) {
    req.log.error(
      { userId, dbMs: since(startedAt), ...dbErrorFields(error) },
      "ledger.incomes.options_failed",
    );
    return reply.code(500).send({ error: error.message });
  }

  const count = data?.length ?? 0;
  if (count === 0) {
    req.log.warn(
      {
        userId,
        portfolios: 0,
        dbMs: since(startedAt),
        hint: "income form will be unavailable — user has no active accounts",
      },
      "ledger.incomes.options_empty",
    );
  } else {
    req.log.debug(
      { userId, portfolios: count, dbMs: since(startedAt) },
      "ledger.incomes.options_ok",
    );
  }

  return { portfolios: data ?? [] };
});

// Record income atomically via the create_income RPC.
app.post("/incomes", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;

  const b = (req.body ?? {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  const portfolioId = String(b.portfolio_id ?? "");
  const source = String(b.source ?? "");
  const txnDate = String(b.txn_date ?? "");
  const sourceName = b.source_name ? String(b.source_name) : null;
  const description = b.description ? String(b.description) : null;
  const isRecurring = b.is_recurring === true;

  // Free text (source_name/description) stays out of the logs — it is the
  // user's private data and tells you nothing when debugging.
  req.log.debug(
    {
      userId,
      amount,
      portfolioId,
      source,
      txnDate,
      isRecurring,
      hasSourceName: sourceName !== null,
      hasDescription: description !== null,
    },
    "ledger.income.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, field, amount, portfolioId, source, txnDate },
      "ledger.income.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return invalid("amount", "Amount must be greater than zero.");
  if (!UUID_RE.test(portfolioId))
    return invalid("portfolio_id", "Select an account.");
  if (!INCOME_SOURCES.has(source))
    return invalid("source", "Select where the money came from.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate))
    return invalid("txn_date", "Date is required.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_income", {
    _user_id: userId,
    _portfolio_id: portfolioId,
    _amount: amount,
    _source: source,
    _txn_date: txnDate,
    _source_name: sourceName,
    _description: description,
    _is_recurring: isRecurring,
  });

  if (error) {
    // Same split as create_expense: P0001/P0002/23514 are guards doing their job
    // (400); 42883/PGRST202 mean create_income.sql was never applied or the
    // schema cache is stale — a deploy problem worth spotting immediately.
    req.log.warn(
      {
        userId,
        amount,
        portfolioId,
        source,
        txnDate,
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.income.create_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }

  const created = (data ?? {}) as {
    income_id?: string;
    transaction_id?: string;
  };

  req.log.info(
    {
      userId,
      incomeId: created.income_id,
      transactionId: created.transaction_id,
      amount,
      portfolioId,
      source,
      txnDate,
      dbMs: since(startedAt),
    },
    "ledger.income.create_ok",
  );
  return reply.code(201).send({ income: data });
});

// Recent transfers for the current user.
app.get("/transfers", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const q = req.query as { limit?: string };
  const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 200);
  const startedAt = process.hrtime.bigint();

  const { data, error } = await admin()
    .from("transfers")
    .select(TRANSFER_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error(
      { userId, limit, dbMs: since(startedAt), ...dbErrorFields(error) },
      "ledger.transfers.list_failed",
    );
    return reply.code(500).send({ error: error.message });
  }

  req.log.debug(
    { userId, limit, returned: data?.length ?? 0, dbMs: since(startedAt) },
    "ledger.transfers.list_ok",
  );
  return { transfers: data ?? [] };
});

// Form options: active accounts with currency + balance. The form needs the
// currency to decide whether to ask for an exchange rate, and the balance to
// warn before the DB's overdraft guard has to.
app.get("/transfers/options", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const startedAt = process.hrtime.bigint();

  const { data, error } = await activePortfolios(userId);

  if (error) {
    req.log.error(
      { userId, dbMs: since(startedAt), ...dbErrorFields(error) },
      "ledger.transfers.options_failed",
    );
    return reply.code(500).send({ error: error.message });
  }

  const count = data?.length ?? 0;
  // Transfers need TWO accounts, not one — a single-account user sees the same
  // disabled form as a zero-account one, which is a common "why is it greyed
  // out" report.
  if (count < 2) {
    req.log.warn(
      {
        userId,
        portfolios: count,
        dbMs: since(startedAt),
        hint: "transfer form will be unavailable — needs at least two active accounts",
      },
      "ledger.transfers.options_insufficient",
    );
  } else {
    req.log.debug(
      { userId, portfolios: count, dbMs: since(startedAt) },
      "ledger.transfers.options_ok",
    );
  }

  return { portfolios: data ?? [] };
});

// Move money between two accounts atomically via the create_transfer RPC.
app.post("/transfers", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;

  const b = (req.body ?? {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  const fee = b.fee === undefined || b.fee === null || b.fee === "" ? 0 : Number(b.fee);
  const exchangeRate =
    b.exchange_rate === undefined || b.exchange_rate === null || b.exchange_rate === ""
      ? 1
      : Number(b.exchange_rate);
  const fromPortfolioId = String(b.from_portfolio_id ?? "");
  const toPortfolioId = String(b.to_portfolio_id ?? "");
  const txnDate = String(b.txn_date ?? "");
  const note = b.note ? String(b.note) : null;

  req.log.debug(
    {
      userId,
      amount,
      fee,
      exchangeRate,
      fromPortfolioId,
      toPortfolioId,
      txnDate,
      hasNote: note !== null,
    },
    "ledger.transfer.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, field, amount, fee, exchangeRate, fromPortfolioId, toPortfolioId, txnDate },
      "ledger.transfer.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return invalid("amount", "Amount must be greater than zero.");
  if (!Number.isFinite(fee) || fee < 0)
    return invalid("fee", "Fee cannot be negative.");
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0)
    return invalid("exchange_rate", "Exchange rate must be greater than zero.");
  if (!UUID_RE.test(fromPortfolioId))
    return invalid("from_portfolio_id", "Select the account to move money from.");
  if (!UUID_RE.test(toPortfolioId))
    return invalid("to_portfolio_id", "Select the account to move money to.");
  if (fromPortfolioId === toPortfolioId)
    return invalid("to_portfolio_id", "Pick two different accounts.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate))
    return invalid("txn_date", "Date is required.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_transfer", {
    _user_id: userId,
    _from_portfolio: fromPortfolioId,
    _to_portfolio: toPortfolioId,
    _amount: amount,
    _fee: fee,
    _exchange_rate: exchangeRate,
    _txn_date: txnDate,
    _note: note,
  });

  if (error) {
    // Insufficient funds and "converted amount rounds to zero" both land here as
    // P0001 raises — user-facing guards, hence 400 rather than 500.
    req.log.warn(
      {
        userId,
        amount,
        fee,
        exchangeRate,
        fromPortfolioId,
        toPortfolioId,
        txnDate,
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.transfer.create_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }

  const created = (data ?? {}) as {
    transfer_id?: string;
    out_transaction_id?: string;
    in_transaction_id?: string;
    fee_transaction_id?: string | null;
    amount_received?: string;
  };

  // Both legs logged: a transfer that debits but never credits is the failure
  // mode worth being able to prove did not happen.
  req.log.info(
    {
      userId,
      transferId: created.transfer_id,
      outTransactionId: created.out_transaction_id,
      inTransactionId: created.in_transaction_id,
      feeTransactionId: created.fee_transaction_id ?? null,
      amount,
      amountReceived: created.amount_received,
      fee,
      exchangeRate,
      fromPortfolioId,
      toPortfolioId,
      txnDate,
      dbMs: since(startedAt),
    },
    "ledger.transfer.create_ok",
  );
  return reply.code(201).send({ transfer: data });
});

// ---------------------------------------------------------------------------
// DEBTS (Phase 3)
// ---------------------------------------------------------------------------

// Debts carry their own currency (a debt can be in a currency you hold no
// account in), so the currency embed is not optional here the way it is on rows
// that inherit it from a portfolio.
const DEBT_SELECT =
  "id, kind, counterparty, principal_amount, outstanding_balance, interest_rate, " +
  "status, due_date, note, is_archived, created_at, " +
  "currency:currencies(code, symbol, minor_unit)";

const DEBT_PAYMENT_SELECT =
  "id, amount, principal_portion, interest_portion, payment_date, note, " +
  "transaction:transactions(id, kind, portfolio:portfolios(name))";

/**
 * `status` off a PostgREST row whose type the client could not infer. An
 * `.update(patch)` where `patch` is a plain Record widens the following
 * `.select()` to include a parse-error branch, so the row is not statically a
 * debt — but it is one at runtime, and the status is worth having in the log.
 */
function statusOf(row: unknown): string | null {
  return typeof row === "object" && row !== null && "status" in row
    ? String((row as { status: unknown }).status)
    : null;
}

const DEBT_KINDS = new Set(["payable", "receivable"]);
// Mirrors public.debt_status. 'settled' and 'partially_paid' are derived by the
// recompute trigger and are deliberately NOT settable through the PATCH route —
// only the two states a person actually chooses are.
const DEBT_STATUSES = new Set([
  "open",
  "partially_paid",
  "settled",
  "written_off",
]);
const USER_SETTABLE_DEBT_STATUSES = new Set(["open", "written_off"]);

/** Debts a user owes / is owed, newest first. */
app.get("/debts", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const q = req.query as {
    kind?: string;
    status?: string;
    include_archived?: string;
    limit?: string;
  };
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
  const includeArchived = q.include_archived === "true";
  const startedAt = process.hrtime.bigint();

  let query = admin()
    .from("debts")
    .select(DEBT_SELECT)
    .eq("user_id", userId) // service-role bypasses RLS — this is the boundary
    .limit(limit);

  if (!includeArchived) query = query.eq("is_archived", false);
  if (q.kind && DEBT_KINDS.has(q.kind)) query = query.eq("kind", q.kind);
  if (q.status && DEBT_STATUSES.has(q.status))
    query = query.eq("status", q.status);

  // Due-soonest first, undated last — the order a person chases debts in.
  // nullsFirst:false is what pushes open-ended debts to the bottom.
  const { data, error } = await query
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    req.log.error(
      { userId, limit, dbMs: since(startedAt), ...dbErrorFields(error) },
      "ledger.debts.list_failed",
    );
    return reply.code(500).send({ error: error.message });
  }

  req.log.debug(
    { userId, limit, returned: data?.length ?? 0, dbMs: since(startedAt) },
    "ledger.debts.list_ok",
  );
  return { debts: data ?? [] };
});

// Form options: active accounts (with balance + currency, so the form can warn
// before the overdraft guard has to) and the currency list a debt can be in.
app.get("/debts/options", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const startedAt = process.hrtime.bigint();

  const [portfolios, currencies] = await Promise.all([
    activePortfolios(userId),
    admin()
      .from("currencies")
      .select("id, code, symbol, minor_unit")
      .eq("is_active", true) // matches what the portfolios form offers
      .order("code"),
  ]);

  if (portfolios.error || currencies.error) {
    const error = portfolios.error ?? currencies.error;
    req.log.error(
      {
        userId,
        failed: portfolios.error ? "portfolios" : "currencies",
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.debts.options_failed",
    );
    return reply.code(500).send({ error: error?.message });
  }

  req.log.debug(
    {
      userId,
      portfolios: portfolios.data?.length ?? 0,
      currencies: currencies.data?.length ?? 0,
      dbMs: since(startedAt),
    },
    "ledger.debts.options_ok",
  );

  // Unlike expenses/transfers, zero accounts does NOT disable this form — a
  // record-only debt needs no account at all. Only the disbursement picker and
  // the payment form care.
  return {
    portfolios: portfolios.data ?? [],
    currencies: currencies.data ?? [],
  };
});

// One debt plus its payment history — backs the detail page.
app.get("/debts/:id", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "Invalid debt id." });
  const startedAt = process.hrtime.bigint();

  const [debt, payments] = await Promise.all([
    admin()
      .from("debts")
      .select(DEBT_SELECT)
      .eq("user_id", userId)
      .eq("id", id)
      .maybeSingle(),
    admin()
      .from("debt_payments")
      .select(DEBT_PAYMENT_SELECT)
      .eq("user_id", userId)
      .eq("debt_id", id)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);

  if (debt.error || payments.error) {
    const error = debt.error ?? payments.error;
    req.log.error(
      {
        userId,
        debtId: id,
        failed: debt.error ? "debt" : "payments",
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.debts.get_failed",
    );
    return reply.code(500).send({ error: error?.message });
  }

  // maybeSingle + an explicit user_id filter: a debt belonging to someone else
  // is indistinguishable from one that does not exist, which is the point.
  if (!debt.data) {
    req.log.warn({ userId, debtId: id }, "ledger.debts.get_not_found");
    return reply.code(404).send({ error: "Debt not found." });
  }

  req.log.debug(
    {
      userId,
      debtId: id,
      payments: payments.data?.length ?? 0,
      dbMs: since(startedAt),
    },
    "ledger.debts.get_ok",
  );
  return { debt: debt.data, payments: payments.data ?? [] };
});

// Record a debt, optionally posting the cash that changed hands (create_debt).
app.post("/debts", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;

  const b = (req.body ?? {}) as Record<string, unknown>;
  const kind = String(b.kind ?? "");
  const counterparty = String(b.counterparty ?? "").trim();
  const principal = Number(b.principal_amount);
  const currencyId = String(b.currency_id ?? "");
  const interestRate =
    b.interest_rate === undefined || b.interest_rate === null || b.interest_rate === ""
      ? null
      : Number(b.interest_rate);
  const dueDate = b.due_date ? String(b.due_date) : null;
  const note = b.note ? String(b.note) : null;
  // Optional by design (decision D1): a debt that predates the app has no
  // disbursement to post.
  const disbursementPortfolio = b.disbursement_portfolio_id
    ? String(b.disbursement_portfolio_id)
    : null;
  const disbursementDate = b.disbursement_date ? String(b.disbursement_date) : null;

  // counterparty and note are the user's private data — presence only.
  req.log.debug(
    {
      userId,
      kind,
      principal,
      currencyId,
      hasInterestRate: interestRate !== null,
      dueDate,
      hasNote: note !== null,
      disburses: disbursementPortfolio !== null,
    },
    "ledger.debt.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, field, kind, principal, currencyId, dueDate },
      "ledger.debt.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  if (!DEBT_KINDS.has(kind))
    return invalid("kind", "Choose whether you owe this or are owed it.");
  if (!counterparty) return invalid("counterparty", "Who is this debt with?");
  if (!Number.isFinite(principal) || principal <= 0)
    return invalid("principal_amount", "Principal must be greater than zero.");
  if (!UUID_RE.test(currencyId)) return invalid("currency_id", "Select a currency.");
  if (interestRate !== null && (!Number.isFinite(interestRate) || interestRate < 0))
    return invalid("interest_rate", "Interest rate cannot be negative.");
  if (dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
    return invalid("due_date", "Due date is not a valid date.");
  if (disbursementPortfolio !== null && !UUID_RE.test(disbursementPortfolio))
    return invalid("disbursement_portfolio_id", "Select a valid account.");
  if (disbursementDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(disbursementDate))
    return invalid("disbursement_date", "Disbursement date is not a valid date.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_debt", {
    _user_id: userId,
    _kind: kind,
    _counterparty: counterparty,
    _principal: principal,
    _currency_id: currencyId,
    _interest_rate: interestRate,
    _due_date: dueDate,
    _note: note,
    _disbursement_portfolio: disbursementPortfolio,
    // The RPC defaults to current_date, but "today" there is the DB's timezone,
    // not the user's — send the browser's date whenever we have it.
    _disbursement_date: disbursementDate,
  });

  if (error) {
    // Same split as the other create_* RPCs: P0001/P0002/23514 are guards doing
    // their job (400); 42883/PGRST202 mean create_debt.sql was never applied or
    // the schema cache is stale — a deploy problem, not a user one.
    req.log.warn(
      {
        userId,
        kind,
        principal,
        currencyId,
        disburses: disbursementPortfolio !== null,
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.debt.create_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }

  const created = (data ?? {}) as { debt_id?: string; transaction_id?: string | null };

  req.log.info(
    {
      userId,
      debtId: created.debt_id,
      // Null here means record-only — no money moved, which is a legitimate
      // outcome and worth being able to tell apart from a failed disbursement.
      transactionId: created.transaction_id ?? null,
      kind,
      principal,
      currencyId,
      dbMs: since(startedAt),
    },
    "ledger.debt.create_ok",
  );
  return reply.code(201).send({ debt: data });
});

// Edit a debt's descriptive fields. No hard DELETE route exists: debts cascade
// to debt_payments, whose transaction_id is `on delete restrict` on the
// transactions side — deleting a debt would drop its payment rows and orphan
// ledger transactions that moved real money. Archive instead.
app.patch("/debts/:id", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "Invalid debt id." });

  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  const invalid = (field: string, message: string) => {
    req.log.warn({ userId, debtId: id, field }, "ledger.debt.update_invalid");
    return reply.code(400).send({ error: message });
  };

  if (b.counterparty !== undefined) {
    const counterparty = String(b.counterparty).trim();
    if (!counterparty) return invalid("counterparty", "Who is this debt with?");
    patch.counterparty = counterparty;
  }
  if (b.principal_amount !== undefined) {
    const principal = Number(b.principal_amount);
    if (!Number.isFinite(principal) || principal <= 0)
      return invalid("principal_amount", "Principal must be greater than zero.");
    // trg_debt_principal_recompute rewrites outstanding_balance and status from
    // the payment history when this lands — see db/functions/debt_principal_recompute.sql.
    patch.principal_amount = principal;
  }
  if (b.interest_rate !== undefined) {
    const rate = b.interest_rate === null || b.interest_rate === "" ? null : Number(b.interest_rate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0))
      return invalid("interest_rate", "Interest rate cannot be negative.");
    patch.interest_rate = rate;
  }
  if (b.due_date !== undefined) {
    const dueDate = b.due_date === null || b.due_date === "" ? null : String(b.due_date);
    if (dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
      return invalid("due_date", "Due date is not a valid date.");
    patch.due_date = dueDate;
  }
  if (b.note !== undefined) patch.note = b.note === null || b.note === "" ? null : String(b.note);
  if (b.is_archived !== undefined) patch.is_archived = b.is_archived === true;
  if (b.status !== undefined) {
    const status = String(b.status);
    // 'settled' and 'partially_paid' are the recompute trigger's to assign; a
    // user setting them by hand would be overwritten by the next payment and
    // would misreport the balance until then.
    if (!USER_SETTABLE_DEBT_STATUSES.has(status))
      return invalid("status", "A debt can only be reopened or written off by hand.");
    patch.status = status;
  }

  if (Object.keys(patch).length === 0)
    return invalid("body", "Nothing to update.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin()
    .from("debts")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select(DEBT_SELECT)
    .maybeSingle();

  if (error) {
    req.log.warn(
      {
        userId,
        debtId: id,
        fields: Object.keys(patch),
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.debt.update_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }
  if (!data) {
    req.log.warn({ userId, debtId: id }, "ledger.debt.update_not_found");
    return reply.code(404).send({ error: "Debt not found." });
  }

  // Un-writing-off is the one status change we cannot take at face value.
  // 'open' is what the caller asks for, but a debt with payments against it is
  // really 'partially_paid' — and nothing would correct that until the next
  // payment fired the recompute trigger. Derive it from the payment history now.
  let debt = data;
  if (patch.status === "open") {
    const recomputed = await admin().rpc("recompute_debt", { _debt_id: id });
    if (recomputed.error) {
      // The debt IS reopened at this point; only the derived status may be
      // stale, and the next payment fixes it. Worth a line, not a failure.
      req.log.error(
        { userId, debtId: id, ...dbErrorFields(recomputed.error) },
        "ledger.debt.reopen_recompute_failed",
      );
    } else {
      const fresh = await admin()
        .from("debts")
        .select(DEBT_SELECT)
        .eq("user_id", userId)
        .eq("id", id)
        .maybeSingle();
      if (fresh.data) debt = fresh.data;
    }
  }

  req.log.info(
    {
      userId,
      debtId: id,
      fields: Object.keys(patch),
      statusAfter: statusOf(debt),
      dbMs: since(startedAt),
    },
    "ledger.debt.update_ok",
  );
  return { debt };
});

// Record a payment against a debt (create_debt_payment). Moves real cash AND
// reduces the outstanding balance in one transaction.
app.post("/debts/:id/payments", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "Invalid debt id." });

  const b = (req.body ?? {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  // Blank interest means the whole payment is principal — the common case.
  const interest =
    b.interest_portion === undefined || b.interest_portion === null || b.interest_portion === ""
      ? 0
      : Number(b.interest_portion);
  const portfolioId = String(b.portfolio_id ?? "");
  const paymentDate = String(b.payment_date ?? "");
  const note = b.note ? String(b.note) : null;

  req.log.debug(
    { userId, debtId: id, amount, interest, portfolioId, paymentDate, hasNote: note !== null },
    "ledger.debt_payment.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, debtId: id, field, amount, interest, portfolioId, paymentDate },
      "ledger.debt_payment.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return invalid("amount", "Amount must be greater than zero.");
  if (!Number.isFinite(interest) || interest < 0)
    return invalid("interest_portion", "Interest cannot be negative.");
  if (interest > amount)
    return invalid("interest_portion", "Interest cannot be more than the payment.");
  if (!UUID_RE.test(portfolioId)) return invalid("portfolio_id", "Select an account.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate))
    return invalid("payment_date", "Date is required.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_debt_payment", {
    _user_id: userId,
    _debt_id: id,
    _portfolio_id: portfolioId,
    _amount: amount,
    // Derived rather than sent, so the DB's principal + interest = amount
    // constraint cannot be tripped by a form that disagrees with itself.
    _principal: amount - interest,
    _interest: interest,
    _payment_date: paymentDate,
    _note: note,
  });

  if (error) {
    // Overpayment, already-settled, archived, currency mismatch and insufficient
    // funds all land here as P0001 raises — user-facing guards, hence 400.
    req.log.warn(
      {
        userId,
        debtId: id,
        amount,
        interest,
        portfolioId,
        paymentDate,
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.debt_payment.create_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }

  const created = (data ?? {}) as {
    payment_id?: string;
    transaction_id?: string;
    outstanding_after?: string;
    status_after?: string;
  };

  // outstanding_after/status_after are logged because "did this settle the
  // debt?" is the question you ask when reading these lines back.
  req.log.info(
    {
      userId,
      debtId: id,
      paymentId: created.payment_id,
      transactionId: created.transaction_id,
      amount,
      interest,
      portfolioId,
      paymentDate,
      outstandingAfter: created.outstanding_after,
      statusAfter: created.status_after,
      dbMs: since(startedAt),
    },
    "ledger.debt_payment.create_ok",
  );
  return reply.code(201).send({ payment: data });
});

installProcessLogging(app);

app
  .listen({ host: "0.0.0.0", port: PORT })
  .then((addr) => {
    // Config summary at boot: presence only, never values. A ledger that starts
    // with no SUPABASE_SERVICE_ROLE_KEY looks healthy (/healthz passes) and
    // fails on the first real query — this line is the early warning.
    app.log.info(
      {
        address: addr,
        logLevel: LOG_LEVEL,
        nodeEnv: process.env.NODE_ENV ?? "development",
        supabaseUrlSet: Boolean(process.env.SUPABASE_URL),
        serviceRoleKeySet: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        internalSecretSet: Boolean(INTERNAL_SECRET),
      },
      "ledger.boot",
    );
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      app.log.error(
        { hint: "every query will fail until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set" },
        "ledger.boot.supabase_unconfigured",
      );
    }
  })
  .catch((err) => {
    app.log.fatal({ err, port: PORT }, "ledger.boot.listen_failed");
    process.exit(1);
  });
