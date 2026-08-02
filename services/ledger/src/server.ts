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
