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
// User-typed option names (a new expense category, a custom income source).
// Mirrors the 40-char ceiling in db/functions/custom_option_labels.sql — checked
// here so an over-long value is a clean 400 rather than a constraint violation.
const MAX_CUSTOM_LABEL = 40;
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
  const newCategory = b.new_category ? String(b.new_category).trim() : "";
  const txnDate = String(b.txn_date ?? "");
  const description = b.description ? String(b.description) : null;
  const merchant = b.merchant ? String(b.merchant) : null;

  // An existing category always wins over a typed one, the same precedence
  // create_expense() applies — so a caller that sends both can never end up
  // creating a duplicate category alongside the one it already picked.
  const hasCategoryId = UUID_RE.test(categoryId);

  // Money in, money out: log the request before touching the DB so a request
  // that never returns still leaves a trace of what it was trying to do. Free
  // text (merchant/description) stays out — it is the user's private data and
  // tells you nothing when debugging. A new category name is not private detail
  // but a list entry the user will see, and it is the thing being created here.
  req.log.debug(
    {
      userId,
      amount,
      portfolioId,
      categoryId,
      newCategory: hasCategoryId ? null : newCategory,
      txnDate,
      hasDescription: description !== null,
      hasMerchant: merchant !== null,
    },
    "ledger.expense.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, field, amount, portfolioId, categoryId, newCategory, txnDate },
      "ledger.expense.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  if (!Number.isFinite(amount) || amount <= 0)
    return invalid("amount", "Amount must be greater than zero.");
  if (!UUID_RE.test(portfolioId))
    return invalid("portfolio_id", "Select an account.");
  if (!hasCategoryId) {
    if (!newCategory) return invalid("category_id", "Select a category.");
    if (newCategory.length > MAX_CUSTOM_LABEL)
      return invalid(
        "new_category",
        `Category name must be ${MAX_CUSTOM_LABEL} characters or fewer.`,
      );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate))
    return invalid("txn_date", "Date is required.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_expense", {
    _user_id: userId,
    _portfolio_id: portfolioId,
    _category_id: hasCategoryId ? categoryId : null,
    _amount: amount,
    _txn_date: txnDate,
    _description: description,
    _merchant: merchant,
    _new_category: hasCategoryId ? null : newCategory,
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
        newCategory,
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
    category_id?: string;
  };

  // The one line that proves money moved. `transactionId` is the handle for
  // finding the row in Supabase; `dbMs` is how long the atomic RPC took.
  // `categoryId` comes back from the RPC because an inline creation means the
  // caller never knew it.
  req.log.info(
    {
      userId,
      expenseId: created.expense_id,
      transactionId: created.transaction_id,
      amount,
      portfolioId,
      categoryId: created.category_id ?? categoryId,
      createdCategory: hasCategoryId ? null : newCategory,
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
  "id, source, source_name, source_label, is_recurring, " +
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

/**
 * The custom source names this user has typed before, newest first, so the
 * income form can offer them back instead of making them retype. Deduped
 * case-insensitively — "Royalties" and "royalties" are one suggestion.
 * Mirrors distinctLabels in apps/web/src/lib/ledger-local.ts.
 */
function distinctLabels(rows: { source_label: string | null }[] | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows ?? []) {
    const label = r.source_label?.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out;
}

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

// Form options: the user's active accounts, plus the custom source names they
// have used before. The enum members themselves are a fixed list labelled in the
// web layer, the same way portfolio categories are — only the user's own
// additions have to come from the database.
app.get("/incomes/options", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const startedAt = process.hrtime.bigint();

  const [portfolios, labels] = await Promise.all([
    activePortfolios(userId),
    // Capped: this only feeds an autocomplete list, and a user with thousands of
    // income rows would otherwise pull them all to find a handful of names.
    admin()
      .from("incomes")
      .select("source_label")
      .eq("user_id", userId) // service-role bypasses RLS — scope explicitly
      .not("source_label", "is", null)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const { data, error } = portfolios;
  if (error || labels.error) {
    req.log.error(
      {
        userId,
        failed: error ? "portfolios" : "source_labels",
        dbMs: since(startedAt),
        ...dbErrorFields(error ?? labels.error),
      },
      "ledger.incomes.options_failed",
    );
    return reply.code(500).send({ error: (error ?? labels.error)?.message });
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

  return { portfolios: data ?? [], source_labels: distinctLabels(labels.data) };
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
  const sourceLabel = b.source_label ? String(b.source_label).trim() : "";
  const description = b.description ? String(b.description) : null;
  const isRecurring = b.is_recurring === true;

  // Free text (source_name/description) stays out of the logs — it is the
  // user's private data and tells you nothing when debugging. sourceLabel is
  // different: it names a source type, not a counterparty, and it is what
  // makes an 'other' row readable.
  req.log.debug(
    {
      userId,
      amount,
      portfolioId,
      source,
      sourceLabel: sourceLabel || null,
      txnDate,
      isRecurring,
      hasSourceName: sourceName !== null,
      hasDescription: description !== null,
    },
    "ledger.income.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, field, amount, portfolioId, source, sourceLabel, txnDate },
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
  // incomes_source_label_only_other enforces this too; rejecting it here turns
  // a 23514 constraint violation into a sentence about the field.
  if (sourceLabel && source !== "other")
    return invalid(
      "source_label",
      'A custom source name only applies to the "Other" source.',
    );
  if (sourceLabel.length > MAX_CUSTOM_LABEL)
    return invalid(
      "source_label",
      `Source name must be ${MAX_CUSTOM_LABEL} characters or fewer.`,
    );
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
    _source_label: sourceLabel || null,
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

// ---------------------------------------------------------------------------
// GOALS (Phase 3)
//
// Goals move no money (decision D2) — a contribution is an earmark over
// balances you already hold, so nothing here posts a ledger row. The routes are
// still service-side rather than direct table writes from the web tier because
// create_goal / create_goal_contribution hold validation the UI must not be the
// only place enforcing: the linked account's currency, and the over-withdrawal
// guard that keeps current_amount reconcilable with its contribution rows.
// ---------------------------------------------------------------------------

// goals has exactly one FK to portfolios, but the column hint costs nothing and
// survives someone adding a second one later.
const GOAL_SELECT =
  "id, name, target_amount, current_amount, currency_id, linked_portfolio_id, " +
  "status, target_date, achieved_at, first_achieved_at, created_at, " +
  "currency:currencies(code, symbol, minor_unit), " +
  "linked_portfolio:portfolios!linked_portfolio_id(name, current_balance)";

// 'achieved' is absent on purpose: refresh_goal_status() derives it from
// current_amount vs target_amount, and a hand-set value would be overwritten by
// the next contribution while misreporting progress until then.
const USER_SETTABLE_GOAL_STATUSES = new Set(["active", "archived", "cancelled"]);

/** Goals for the current user, newest first. */
app.get("/goals", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const q = req.query as { include_archived?: string; limit?: string };
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
  const includeArchived = q.include_archived === "true";
  const startedAt = process.hrtime.bigint();

  let query = admin()
    .from("goals")
    .select(GOAL_SELECT)
    .eq("user_id", userId) // service-role bypasses RLS — this is the boundary
    .limit(limit);

  // Cancelled goals hide with archived ones: both mean "not something I'm
  // working toward", and neither should pad the list of live goals.
  if (!includeArchived) query = query.not("status", "in", "(archived,cancelled)");

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    req.log.error(
      { userId, limit, dbMs: since(startedAt), ...dbErrorFields(error) },
      "ledger.goals.list_failed",
    );
    return reply.code(500).send({ error: error.message });
  }

  req.log.debug(
    { userId, limit, returned: data?.length ?? 0, dbMs: since(startedAt) },
    "ledger.goals.list_ok",
  );
  return { goals: data ?? [] };
});

// Form options: active accounts (to link a goal to) and the currency list.
// Identical shape to /debts/options — the goal form needs the same two lists.
app.get("/goals/options", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const startedAt = process.hrtime.bigint();

  const [portfolios, currencies] = await Promise.all([
    activePortfolios(userId),
    admin()
      .from("currencies")
      .select("id, code, symbol, minor_unit")
      .eq("is_active", true)
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
      "ledger.goals.options_failed",
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
    "ledger.goals.options_ok",
  );
  return {
    portfolios: portfolios.data ?? [],
    currencies: currencies.data ?? [],
  };
});

// Create a goal via the create_goal RPC.
app.post("/goals", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;

  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = String(b.name ?? "").trim();
  const target = Number(b.target_amount);
  const currencyId = String(b.currency_id ?? "");
  const targetDate = b.target_date ? String(b.target_date) : null;
  const linkedPortfolio = b.linked_portfolio_id ? String(b.linked_portfolio_id) : null;

  // The goal's name is the user's own wording — presence and length only.
  req.log.debug(
    {
      userId,
      nameLength: name.length,
      target,
      currencyId,
      targetDate,
      linked: linkedPortfolio !== null,
    },
    "ledger.goal.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, field, target, currencyId, targetDate },
      "ledger.goal.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  if (!name) return invalid("name", "Give the goal a name.");
  if (!Number.isFinite(target) || target <= 0)
    return invalid("target_amount", "Target must be greater than zero.");
  if (!UUID_RE.test(currencyId)) return invalid("currency_id", "Select a currency.");
  if (targetDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    return invalid("target_date", "Target date is not a valid date.");
  if (linkedPortfolio !== null && !UUID_RE.test(linkedPortfolio))
    return invalid("linked_portfolio_id", "Select a valid account.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_goal", {
    _user_id: userId,
    _name: name,
    _target: target,
    _currency_id: currencyId,
    _target_date: targetDate,
    _linked_portfolio: linkedPortfolio,
  });

  if (error) {
    req.log.warn(
      {
        userId,
        target,
        currencyId,
        linked: linkedPortfolio !== null,
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.goal.create_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }

  const created = (data ?? {}) as { goal_id?: string };
  req.log.info(
    {
      userId,
      goalId: created.goal_id,
      target,
      currencyId,
      targetDate,
      linked: linkedPortfolio !== null,
      dbMs: since(startedAt),
    },
    "ledger.goal.create_ok",
  );
  return reply.code(201).send({ goal: data });
});

// Edit a goal's name, target, target date or status.
//
// linked_portfolio_id is deliberately NOT patchable: changing it has to re-check
// that the account holds the goal's currency, and create_goal is the one place
// that check lives. Re-pointing a goal means making a new one for now.
//
// No DELETE either. Goals archive or cancel, like portfolios and debts archive —
// keeping the contribution history is the whole point of first_achieved_at
// surviving a later withdrawal.
app.patch("/goals/:id", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "Invalid goal id." });

  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  const invalid = (field: string, message: string) => {
    req.log.warn({ userId, goalId: id, field }, "ledger.goal.update_invalid");
    return reply.code(400).send({ error: message });
  };

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return invalid("name", "Give the goal a name.");
    patch.name = name;
  }
  if (b.target_amount !== undefined) {
    const target = Number(b.target_amount);
    if (!Number.isFinite(target) || target <= 0)
      return invalid("target_amount", "Target must be greater than zero.");
    // trg_goal_status re-evaluates achievement on this update, so lowering the
    // target below what is already set aside completes the goal, and raising it
    // above demotes it back to active. Both are correct and automatic.
    patch.target_amount = target;
  }
  if (b.target_date !== undefined) {
    const targetDate =
      b.target_date === null || b.target_date === "" ? null : String(b.target_date);
    if (targetDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
      return invalid("target_date", "Target date is not a valid date.");
    patch.target_date = targetDate;
  }
  if (b.status !== undefined) {
    const status = String(b.status);
    if (!USER_SETTABLE_GOAL_STATUSES.has(status))
      return invalid("status", "A goal can only be reopened, archived or cancelled.");
    // Reopening a goal that is already at its target lands on 'active' here and
    // trg_goal_status immediately corrects it back to 'achieved'. Self-healing,
    // so there is nothing to special-case the way un-writing-off a debt needs.
    patch.status = status;
  }

  if (Object.keys(patch).length === 0) return invalid("body", "Nothing to update.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin()
    .from("goals")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select(GOAL_SELECT)
    .maybeSingle();

  if (error) {
    req.log.warn(
      {
        userId,
        goalId: id,
        fields: Object.keys(patch),
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.goal.update_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }
  if (!data) {
    req.log.warn({ userId, goalId: id }, "ledger.goal.update_not_found");
    return reply.code(404).send({ error: "Goal not found." });
  }

  req.log.info(
    {
      userId,
      goalId: id,
      fields: Object.keys(patch),
      statusAfter: statusOf(data),
      dbMs: since(startedAt),
    },
    "ledger.goal.update_ok",
  );
  return { goal: data };
});

// Set money aside toward a goal, or take it back (a negative amount).
app.post("/goals/:id/contributions", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "Invalid goal id." });

  const b = (req.body ?? {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  const contributedOn = String(b.contributed_on ?? "");
  const note = b.note ? String(b.note) : null;

  req.log.debug(
    { userId, goalId: id, amount, contributedOn, hasNote: note !== null },
    "ledger.goal_contribution.create_start",
  );

  const invalid = (field: string, message: string) => {
    req.log.warn(
      { userId, goalId: id, field, amount, contributedOn },
      "ledger.goal_contribution.create_invalid",
    );
    return reply.code(400).send({ error: message });
  };

  // Zero is the only forbidden amount — negative is how you take money back out.
  if (!Number.isFinite(amount) || amount === 0)
    return invalid("amount", "Enter an amount to set aside or take back.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contributedOn))
    return invalid("contributed_on", "Date is required.");

  const startedAt = process.hrtime.bigint();
  const { data, error } = await admin().rpc("create_goal_contribution", {
    _user_id: userId,
    _goal_id: id,
    _amount: amount,
    _contributed_on: contributedOn,
    _note: note,
  });

  if (error) {
    // Over-withdrawal and archived/cancelled goals both land here as P0001
    // raises — user-facing guards, hence 400.
    req.log.warn(
      {
        userId,
        goalId: id,
        amount,
        contributedOn,
        dbMs: since(startedAt),
        ...dbErrorFields(error),
      },
      "ledger.goal_contribution.create_rejected",
    );
    return reply.code(400).send({ error: error.message });
  }

  const created = (data ?? {}) as {
    contribution_id?: string;
    current_amount?: string;
    status?: string;
    just_achieved?: boolean;
  };

  req.log.info(
    {
      userId,
      goalId: id,
      contributionId: created.contribution_id,
      amount,
      contributedOn,
      currentAfter: created.current_amount,
      statusAfter: created.status,
      justAchieved: created.just_achieved ?? false,
      dbMs: since(startedAt),
    },
    "ledger.goal_contribution.create_ok",
  );
  return reply.code(201).send({ contribution: data });
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
