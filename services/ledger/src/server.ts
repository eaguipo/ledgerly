import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { admin } from "./supabase";

const PORT = Number(process.env.PORT ?? 8080);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Defense-in-depth: only the gateway knows this shared secret. It backs the
// x-user-id trust (which alone is forgeable by any pod that can reach us) and
// works regardless of NetworkPolicy/CNI enforcement. Set via Helm secretEnv.
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

const app = Fastify({ logger: true });

// Reject any caller that isn't the gateway (health checks exempt).
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/healthz") return;
  if (INTERNAL_SECRET) {
    const got = req.headers["x-internal-secret"];
    const val = Array.isArray(got) ? got[0] : got;
    if (val !== INTERNAL_SECRET) {
      reply.code(403).send({ error: "forbidden" });
      return reply;
    }
  } else {
    req.log.warn("INTERNAL_API_SECRET is not set — gateway trust is unenforced");
  }
});

/** Identity comes from the gateway, which sets x-user-id after validating the JWT. */
function userIdOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const raw = req.headers["x-user-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
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

  const { data, error } = await admin()
    .from("expenses")
    .select(EXPENSE_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error({ error }, "list expenses failed");
    return reply.code(500).send({ error: error.message });
  }
  return { expenses: data ?? [] };
});

// Form options: the user's active accounts + active expense categories.
app.get("/expenses/options", async (req, reply) => {
  const userId = userIdOf(req, reply);
  if (!userId) return reply;
  const sb = admin();

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
    req.log.error({ error }, "options failed");
    return reply.code(500).send({ error: error?.message });
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

  if (!Number.isFinite(amount) || amount <= 0)
    return reply.code(400).send({ error: "Amount must be greater than zero." });
  if (!UUID_RE.test(portfolioId))
    return reply.code(400).send({ error: "Select an account." });
  if (!UUID_RE.test(categoryId))
    return reply.code(400).send({ error: "Select a category." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate))
    return reply.code(400).send({ error: "Date is required." });

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
    req.log.warn({ error }, "create_expense rejected");
    return reply.code(400).send({ error: error.message });
  }
  return reply.code(201).send({ expense: data });
});

app
  .listen({ host: "0.0.0.0", port: PORT })
  .then((addr) => app.log.info(`ledger-service listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
