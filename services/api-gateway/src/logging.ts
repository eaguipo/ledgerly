import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { LogController } from "fastify";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

/**
 * Shared logging setup for the Fastify services.
 *
 * Kept byte-identical between services/ledger and services/api-gateway — they
 * are separate npm packages with no shared workspace, so this file is copied
 * rather than imported. Change one, change the other.
 *
 * Every record is a JSON line with the same field names the web app emits
 * (`level` as a string, ISO `time`, `service`, `msg`, `reqId`), so one filter
 * spans all three processes:
 *
 *   kubectl logs -n ledgerly deploy/ledger | jq 'select(.reqId == "<id>")'
 *
 * Level is LOG_LEVEL (trace|debug|info|warn|error|fatal), defaulting to `info`
 * in production and `debug` elsewhere.
 */

/**
 * Correlation id header. The web app stamps it, the gateway forwards it, and
 * `requestIdHeader` below makes Fastify adopt it as `reqId` instead of a
 * per-process counter — which is what ties the three log streams together.
 */
export const REQUEST_ID_HEADER = "x-request-id";

const DEFAULT_LEVEL = process.env.NODE_ENV === "production" ? "info" : "debug";
export const LOG_LEVEL = (process.env.LOG_LEVEL ?? DEFAULT_LEVEL).toLowerCase();

const MAX_STACK_LINES = 8;

function headerValue(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : undefined;
}

/** 16 hex chars — matches the id shape the web app generates. */
export function genReqId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Fastify's `logger` option. Fastify already logs "incoming request" and
 * "request completed" (with `responseTime`) for every request; this shapes those
 * records and makes sure no credential rides along in them.
 */
export function loggerOptions(service: string) {
  return {
    level: LOG_LEVEL,
    base: { service, pid: process.pid, hostname: hostname() },

    // ISO timestamps rather than pino's default epoch millis: these logs get
    // read side by side with `kubectl logs --timestamps` and the web app's.
    // (Same output as pino.stdTimeFunctions.isoTime — inlined because pino is
    // only a transitive dependency here, not a declared one.)
    timestamp: () => `,"time":"${new Date().toISOString()}"`,

    formatters: {
      // "level":"info" instead of pino's numeric 30, matching @/lib/logger in
      // the web app so `jq 'select(.level=="error")'` works on every stream.
      level: (label: string) => ({ level: label }),
    },

    // Backstop only — the serializers below never emit these in the first place.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-internal-secret"]',
        "req.headers.apikey",
        "headers.authorization",
        'headers["x-internal-secret"]',
        "token",
        "accessToken",
      ],
      censor: "[redacted]",
    },

    serializers: {
      req(req: FastifyRequest) {
        return {
          method: req.method,
          url: req.url,
          remoteAddress: req.ip,
          // Identity as asserted by the gateway (never the bearer token itself).
          userId: headerValue(req.headers["x-user-id"]),
          userAgent: headerValue(req.headers["user-agent"]),
        };
      },
      // Typed structurally, not as FastifyReply: Fastify calls this with a
      // partial reply in some paths, so a narrower parameter is the honest one.
      res(res: Pick<FastifyReply, "statusCode">) {
        return { statusCode: res.statusCode };
      },
      // Anything can end up here — a rejected promise carries whatever was
      // thrown, not necessarily an Error — so every field is read defensively.
      err(err: FastifyError) {
        const e = err as Partial<FastifyError> & { cause?: unknown };
        return {
          type: e.name ?? "Error",
          message: e.message ?? String(err),
          code: e.code,
          statusCode: e.statusCode,
          stack: e.stack?.split("\n").slice(0, MAX_STACK_LINES).join("\n") ?? "",
          cause: e.cause instanceof Error ? e.cause.message : e.cause,
        };
      },
    },
  };
}

/**
 * Fastify logs "incoming request" + "request completed" for EVERY request. The
 * kubelet probes /healthz every 10 seconds per pod, so left alone that is a few
 * thousand identical lines a day burying the traffic you actually care about.
 * This keeps the built-in request logging for everything else and silences only
 * the probe paths. (Probe failures are still visible in `kubectl get pods` and
 * the pod's events — nothing diagnostic is lost.)
 */
export function quietLogController(silentPaths: string[] = ["/healthz"]) {
  const silent = new Set(silentPaths);
  return new (class extends LogController {
    isLogDisabled(req: FastifyRequest): boolean {
      const path = (req.url ?? "").split("?")[0];
      return silent.has(path) || super.isLogDisabled(req);
    }
  })();
}

/**
 * Turn a Supabase/PostgREST error object into log fields. These are returned,
 * not thrown, so they never reach the `err` serializer on their own — and
 * `code`/`details`/`hint` are exactly the parts worth having (`23514` is a check
 * constraint, `P0002` a not-found raised by our own RPC, `42501` an RLS denial).
 */
export function dbErrorFields(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { err: error };
  const e = error as {
    message?: unknown;
    code?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  return {
    err: {
      type: "PostgrestError",
      message: e.message,
      code: e.code,
      details: e.details,
      hint: e.hint,
    },
  };
}

/**
 * Process-level logging: the events that explain a pod restart. Without these a
 * crash shows up as nothing but a CrashLoopBackOff and an empty log tail.
 *
 * Both handlers re-exit deliberately — Node's default behaviour for an uncaught
 * exception and (since Node 15) an unhandled rejection is to terminate, and
 * installing a handler would otherwise silently turn a crash into a zombie.
 */
export function installProcessLogging(app: FastifyInstance): void {
  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ err: reason }, "process.unhandled_rejection");
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "process.uncaught_exception");
    process.exit(1);
  });

  // Kubernetes sends SIGTERM and waits before SIGKILL. Logging both ends of the
  // drain distinguishes "rolled out cleanly" from "killed mid-request".
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, "process.shutdown.start");
      app.close().then(
        () => {
          app.log.info({ signal }, "process.shutdown.ok");
          process.exit(0);
        },
        (err: unknown) => {
          app.log.error({ signal, err }, "process.shutdown.failed");
          process.exit(1);
        },
      );
    });
  }
}
