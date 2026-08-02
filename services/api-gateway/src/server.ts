import Fastify, { type FastifyBaseLogger } from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { createHash } from "node:crypto";
import {
  LOG_LEVEL,
  REQUEST_ID_HEADER,
  genReqId,
  installProcessLogging,
  loggerOptions,
  quietLogController,
} from "./logging";

const PORT = Number(process.env.PORT ?? 8080);
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";
const LEDGER_URL = (process.env.LEDGER_URL ?? "http://ledger").replace(/\/+$/, "");
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";
const UPSTREAM_TIMEOUT_MS = 10_000;
const RATE_LIMIT_MAX = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stable, non-reversible handle for a token. Two requests from the same
 * session share a fingerprint, so a burst of rejections can be traced to one
 * client — without ever putting a usable credential in the logs.
 */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Milliseconds since `from`, one decimal place. */
function since(from: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - from) / 1e5) / 10;
}

/**
 * Why a token was refused. Every branch returns a distinct reason: from the
 * client's side all of these are an identical 401, so the logs are the only
 * place the difference exists — and "expired" (re-login), "bad signature"
 * (wrong project/secret) and "auth unreachable" need completely different fixes.
 */
type AuthResult =
  | { ok: true; userId: string; via: "local-hs256" | "introspection" }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/**
 * Resolve the Supabase user id from a bearer access token.
 *   1. If SUPABASE_JWT_SECRET is set → verify HS256 locally (fast, offline).
 *   2. Otherwise → introspect via Supabase Auth (`GET /auth/v1/user`),
 *      which works regardless of the token's signing algorithm.
 */
async function resolveUserId(
  token: string,
  log: FastifyBaseLogger,
): Promise<AuthResult> {
  if (JWT_SECRET) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
      }) as JwtPayload;
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      if (!sub) return { ok: false, reason: "token has no sub claim" };
      if (!UUID_RE.test(sub))
        return { ok: false, reason: "sub claim is not a uuid" };
      return { ok: true, userId: sub, via: "local-hs256" };
    } catch (err) {
      // secret configured but signature/claims invalid → reject
      const name = err instanceof Error ? err.name : "unknown";
      const expired = name === "TokenExpiredError";
      return {
        ok: false,
        reason: expired ? "token expired" : "local HS256 verification failed",
        detail: {
          errorType: name,
          message: err instanceof Error ? err.message : String(err),
          hint: expired
            ? "the client's session needs refreshing"
            : "usually SUPABASE_JWT_SECRET belongs to a different Supabase project than the token",
        },
      };
    }
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      ok: false,
      reason: "gateway cannot verify tokens",
      detail: {
        supabaseUrlSet: Boolean(SUPABASE_URL),
        supabaseAnonKeySet: Boolean(SUPABASE_ANON_KEY),
        hint: "set SUPABASE_JWT_SECRET (local verify) or SUPABASE_URL + SUPABASE_ANON_KEY (introspection)",
      },
    };
  }

  const startedAt = process.hrtime.bigint();
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const introspectMs = since(startedAt);
    if (!res.ok) {
      return {
        ok: false,
        reason: "Supabase rejected the token",
        detail: { status: res.status, introspectMs },
      };
    }
    const user = (await res.json()) as { id?: unknown };
    const id = typeof user.id === "string" ? user.id : null;
    if (!id || !UUID_RE.test(id)) {
      return {
        ok: false,
        reason: "introspection returned no usable user id",
        detail: { introspectMs },
      };
    }
    // Every request pays this round trip. If it is slow, the whole app is slow —
    // which is the argument for setting SUPABASE_JWT_SECRET.
    log.debug({ introspectMs }, "gateway.auth.introspected");
    return { ok: true, userId: id, via: "introspection" };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut
        ? "Supabase Auth timed out"
        : "Supabase Auth request failed",
      detail: {
        errorType: err instanceof Error ? err.name : "unknown",
        message: err instanceof Error ? err.message : String(err),
        introspectMs: since(startedAt),
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      },
    };
  }
}

function bearer(header: unknown): string {
  const h = Array.isArray(header) ? header[0] : header;
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

async function main() {
  const app = Fastify({
    logger: loggerOptions("api-gateway"),
    // Adopt the web app's correlation id so a browser action can be followed
    // through this hop and into the ledger. See ./logging.ts.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId,
    logController: quietLogController(["/healthz"]),
  });

  // Key the limiter on the caller's token, not the source IP — all traffic
  // arrives from the single web BFF pod, so per-IP would be one shared bucket.
  await app.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: (req) => bearer(req.headers["authorization"]) || req.ip,
    // A 429 reaches the UI as a generic failure with no explanation. This is
    // the only place it is identifiable as rate limiting rather than a bug.
    // (`onExceeding` is deliberately NOT used — it fires on every request under
    // the limit, so it would log a line per request.) The bucket key is the
    // caller's access token, so it is fingerprinted, never logged.
    onExceeded: (req, key) => {
      req.log.warn(
        {
          url: req.url,
          limit: RATE_LIMIT_MAX,
          windowSeconds: 60,
          bucket: tokenFingerprint(key),
        },
        "gateway.ratelimit.exceeded",
      );
    },
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Reverse-proxy /ledger/* → ledger-service with the validated identity.
  app.all("/ledger/*", async (req, reply) => {
    const token = bearer(req.headers["authorization"]);
    if (!token) {
      req.log.warn(
        {
          url: req.url,
          authorizationHeaderPresent: req.headers["authorization"] !== undefined,
          hint: "the web BFF only attaches a bearer when a Supabase session exists",
        },
        "gateway.auth.missing_token",
      );
      return reply.code(401).send({ error: "missing bearer token" });
    }

    const auth = await resolveUserId(token, req.log);
    if (!auth.ok) {
      req.log.warn(
        {
          url: req.url,
          reason: auth.reason,
          tokenFingerprint: tokenFingerprint(token),
          authMode: JWT_SECRET ? "local-hs256" : "introspection",
          ...auth.detail,
        },
        "gateway.auth.rejected",
      );
      return reply.code(401).send({ error: "invalid or expired token" });
    }

    const userId = auth.userId;
    const subpath = req.url.slice("/ledger".length) || "/"; // keeps query string
    const target = `${LEDGER_URL}${subpath}`;
    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && req.body != null;
    const startedAt = process.hrtime.bigint();

    req.log.debug(
      { userId, method, target, via: auth.via, hasBody },
      "gateway.proxy.start",
    );

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
          // Carry the correlation id one hop further, so the ledger's lines
          // for this call share the reqId printed above.
          [REQUEST_ID_HEADER]: String(req.id),
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await upstream.text();
      const upstreamMs = since(startedAt);

      if (!upstream.ok) {
        // A 403 from the ledger means the shared secret does not match; a 401
        // means x-user-id did not arrive. Both are configuration, not user error.
        req.log.warn(
          {
            userId,
            method,
            target,
            status: upstream.status,
            upstreamMs,
            responseBody: text.slice(0, 300),
            ...(upstream.status === 403
              ? { hint: "ledger rejected the internal secret — check INTERNAL_API_SECRET on both pods" }
              : {}),
          },
          "gateway.proxy.upstream_error",
        );
      } else {
        req.log.debug(
          { userId, method, target, status: upstream.status, upstreamMs },
          "gateway.proxy.ok",
        );
      }

      reply.code(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) reply.header("content-type", ct);
      return reply.send(text);
    } catch (err) {
      // Separate "the ledger is not answering" (pod down, wrong LEDGER_URL,
      // NetworkPolicy blocking) from "it answered too slowly" — a 502 in the UI
      // looks the same either way, but the fix does not.
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      req.log.error(
        {
          err,
          userId,
          method,
          target,
          upstreamMs: since(startedAt),
          timedOut,
          timeoutMs: UPSTREAM_TIMEOUT_MS,
          hint: timedOut
            ? "ledger exceeded the upstream timeout"
            : "ledger unreachable — check the pod, LEDGER_URL and the NetworkPolicy",
        },
        "gateway.proxy.failed",
      );
      return reply.code(502).send({ error: "upstream unavailable" });
    }
  });

  installProcessLogging(app);

  await app.listen({ host: "0.0.0.0", port: PORT });

  // Config summary at boot: presence only, never values. Getting the auth mode
  // wrong is the classic cause of "everything 401s", and it is invisible at
  // runtime otherwise.
  app.log.info(
    {
      port: PORT,
      ledgerUrl: LEDGER_URL,
      authMode: JWT_SECRET ? "local HS256" : "Supabase introspection",
      logLevel: LOG_LEVEL,
      nodeEnv: process.env.NODE_ENV ?? "development",
      supabaseUrlSet: Boolean(SUPABASE_URL),
      supabaseAnonKeySet: Boolean(SUPABASE_ANON_KEY),
      internalSecretSet: Boolean(INTERNAL_SECRET),
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    },
    "gateway.boot",
  );

  if (!INTERNAL_SECRET) {
    app.log.warn(
      { hint: "the ledger will accept unauthenticated calls unless it also has INTERNAL_API_SECRET unset" },
      "gateway.boot.internal_secret_missing",
    );
  }
  if (!JWT_SECRET && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
    app.log.error(
      { hint: "no way to verify tokens — every /ledger/* request will 401" },
      "gateway.boot.auth_unconfigured",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
