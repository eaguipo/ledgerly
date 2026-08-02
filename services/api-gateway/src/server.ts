import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt, { type JwtPayload } from "jsonwebtoken";

const PORT = Number(process.env.PORT ?? 8080);
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";
const LEDGER_URL = (process.env.LEDGER_URL ?? "http://ledger").replace(/\/+$/, "");
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";
const UPSTREAM_TIMEOUT_MS = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the Supabase user id from a bearer access token.
 *   1. If SUPABASE_JWT_SECRET is set → verify HS256 locally (fast, offline).
 *   2. Otherwise → introspect via Supabase Auth (`GET /auth/v1/user`),
 *      which works regardless of the token's signing algorithm.
 * Returns the user id (uuid) or null when the token is invalid.
 */
async function resolveUserId(token: string): Promise<string | null> {
  if (JWT_SECRET) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
      }) as JwtPayload;
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      return sub && UUID_RE.test(sub) ? sub : null;
    } catch {
      return null; // secret configured but signature/claims invalid → reject
    }
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: unknown };
    const id = typeof user.id === "string" ? user.id : null;
    return id && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function bearer(header: unknown): string {
  const h = Array.isArray(header) ? header[0] : header;
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

async function main() {
  const app = Fastify({ logger: true });
  // Key the limiter on the caller's token, not the source IP — all traffic
  // arrives from the single web BFF pod, so per-IP would be one shared bucket.
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
    keyGenerator: (req) => bearer(req.headers["authorization"]) || req.ip,
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Reverse-proxy /ledger/* → ledger-service with the validated identity.
  app.all("/ledger/*", async (req, reply) => {
    const token = bearer(req.headers["authorization"]);
    if (!token) return reply.code(401).send({ error: "missing bearer token" });

    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: "invalid or expired token" });

    const subpath = req.url.slice("/ledger".length) || "/"; // keeps query string
    const target = `${LEDGER_URL}${subpath}`;
    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && req.body != null;

    try {
      const upstream = await fetch(target, {
        method,
        // NOTE: the client's Authorization is intentionally NOT forwarded.
        // Identity is asserted via x-user-id, backed by the shared internal
        // secret (+ NetworkPolicy) so the header alone isn't the trust anchor.
        headers: {
          "x-user-id": userId,
          "x-internal-secret": INTERNAL_SECRET,
          "content-type": "application/json",
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await upstream.text();
      reply.code(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) reply.header("content-type", ct);
      return reply.send(text);
    } catch (err) {
      req.log.error({ err, target }, "upstream proxy failed");
      return reply.code(502).send({ error: "upstream unavailable" });
    }
  });

  await app.listen({ host: "0.0.0.0", port: PORT });
  app.log.info(
    `api-gateway on ${PORT} → ledger ${LEDGER_URL} (auth: ${JWT_SECRET ? "local HS256" : "Supabase introspection"})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
