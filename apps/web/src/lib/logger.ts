/**
 * Structured logging for the web app (the BFF layer).
 *
 * SERVER ONLY. Do not import this from a client component — it reads
 * `process.env.LOG_LEVEL`, which Next.js does not expose to the browser. Client
 * components use `@/lib/client-logger` instead.
 *
 * Shape: one JSON object per line on stdout, using the SAME field names the
 * Fastify services emit (`level`, `time`, `service`, `msg`, `reqId`), so one
 * filter works across all three processes:
 *
 *   kubectl logs -n ledgerly deploy/web | jq 'select(.reqId == "<id>")'
 *   kubectl logs -n ledgerly deploy/web | jq 'select(.level == "error")'
 *
 * In development the same record is printed as a compact human-readable line.
 * Force one or the other with LOG_FORMAT=json | pretty.
 *
 * Message names are dotted and past-tense-free — `<domain>.<action>.<outcome>`
 * (e.g. `expense.create.ok`) — so grepping one flow across services is a
 * substring match, not a regex.
 *
 * Never pass secrets in `fields`. Values under keys that look sensitive
 * (token/secret/password/cookie/authorization/apikey) are replaced with
 * "[redacted]" as a backstop, but the first line of defence is not logging them.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export type LogFields = Record<string, unknown>;

const IS_PROD = process.env.NODE_ENV === "production";

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw in LEVEL_VALUE) return raw as LogLevel;
  return IS_PROD ? "info" : "debug";
}

const THRESHOLD = LEVEL_VALUE[resolveLevel()];
const PRETTY =
  (process.env.LOG_FORMAT ?? (IS_PROD ? "json" : "pretty")).toLowerCase() ===
  "pretty";

// ── redaction / sanitising ───────────────────────────────────────────────────

const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|^authorization$|^cookie$|api_?key|credential|service_role/i;
const REDACTED = "[redacted]";
const MAX_STRING = 512;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;
const MAX_STACK_LINES = 8;

function truncate(s: string): string {
  return s.length <= MAX_STRING
    ? s
    : `${s.slice(0, MAX_STRING)}… (+${s.length - MAX_STRING} chars)`;
}

/**
 * Flatten an Error into loggable fields. Picks up the non-standard properties
 * that actually matter here: Postgres/PostgREST errors carry `code`/`details`/
 * `hint`, Supabase auth errors carry `code`/`status`, and Next.js attaches a
 * `digest` that also shows up in the browser — that digest is what ties a
 * user-visible "something went wrong" to the line in these logs.
 */
function serializeError(err: Error): LogFields {
  const e = err as Error & {
    code?: unknown;
    status?: unknown;
    digest?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  const out: LogFields = { type: err.name, message: truncate(err.message) };
  if (e.code !== undefined) out.code = e.code;
  if (e.status !== undefined) out.status = e.status;
  if (e.digest !== undefined) out.digest = e.digest;
  if (e.details !== undefined) out.details = sanitize(e.details, MAX_DEPTH - 1);
  if (e.hint !== undefined) out.hint = e.hint;
  if (err.stack) {
    out.stack = err.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n");
  }
  if (err.cause !== undefined) {
    out.cause =
      err.cause instanceof Error
        ? serializeError(err.cause)
        : sanitize(err.cause, MAX_DEPTH - 1);
  }
  return out;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();

  switch (typeof value) {
    case "string":
      return truncate(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
      return "[function]";
    case "symbol":
      return String(value);
  }

  if (depth >= MAX_DEPTH) return "[depth-limit]";

  if (Array.isArray(value)) {
    const out: unknown[] = value
      .slice(0, MAX_ARRAY)
      .map((v) => sanitize(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY})`);
    return out;
  }

  const out: LogFields = {};
  for (const [key, val] of Object.entries(value as object)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(val, depth + 1);
  }
  return out;
}

// ── emit ────────────────────────────────────────────────────────────────────

const PRETTY_TAG: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  fatal: "FATAL",
};

function prettyValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? `"${value}"` : value;
  return JSON.stringify(value) ?? String(value);
}

function writePretty(
  level: LogLevel,
  time: string,
  service: unknown,
  msg: string,
  rest: LogFields,
) {
  const pairs: string[] = [];
  let errBlock = "";
  for (const [key, value] of Object.entries(rest)) {
    // The stack is the one thing worth its own lines in a terminal.
    if (key === "err" && value && typeof value === "object") {
      const e = value as LogFields;
      pairs.push(`err=${prettyValue(`${e.type}: ${e.message}`)}`);
      for (const k of ["code", "status", "details", "hint", "digest"]) {
        if (e[k] !== undefined) pairs.push(`err.${k}=${prettyValue(e[k])}`);
      }
      if (typeof e.stack === "string") errBlock = `\n${e.stack}`;
      continue;
    }
    pairs.push(`${key}=${prettyValue(value)}`);
  }
  const line = `${time.slice(11, 23)} ${PRETTY_TAG[level]} [${String(service)}] ${msg}${
    pairs.length ? ` · ${pairs.join(" ")}` : ""
  }${errBlock}`;

  if (LEVEL_VALUE[level] >= LEVEL_VALUE.error) console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function write(
  level: LogLevel,
  bindings: LogFields,
  msg: string,
  fields?: LogFields,
): void {
  if (LEVEL_VALUE[level] < THRESHOLD) return;

  const time = new Date().toISOString();
  const rest = { ...bindings, ...(fields ? (sanitize(fields) as LogFields) : {}) };
  const { service, ...tail } = rest;

  if (PRETTY) {
    writePretty(level, time, service ?? "web", msg, tail);
    return;
  }

  let line: string;
  try {
    line = JSON.stringify({ level, time, service: service ?? "web", msg, ...tail });
  } catch {
    // Circular reference that survived sanitise() — never lose the event.
    line = JSON.stringify({ level, time, service: service ?? "web", msg, fieldsError: "unserializable" });
  }
  if (LEVEL_VALUE[level] >= LEVEL_VALUE.error) console.error(line);
  else console.log(line);
}

// ── public API ──────────────────────────────────────────────────────────────

export interface Logger {
  /** Returns a logger that stamps `bindings` onto every record it writes. */
  child(bindings: LogFields): Logger;
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
}

function createLogger(bindings: LogFields): Logger {
  return {
    child: (extra) => createLogger({ ...bindings, ...extra }),
    trace: (msg, fields) => write("trace", bindings, msg, fields),
    debug: (msg, fields) => write("debug", bindings, msg, fields),
    info: (msg, fields) => write("info", bindings, msg, fields),
    warn: (msg, fields) => write("warn", bindings, msg, fields),
    error: (msg, fields) => write("error", bindings, msg, fields),
    fatal: (msg, fields) => write("fatal", bindings, msg, fields),
  };
}

/** Root logger for the web app. Prefer `log.child({ reqId, … })` per request. */
export const log: Logger = createLogger({ service: "web" });

/** The level actually in effect — logged once at boot by instrumentation.ts. */
export const activeLogLevel: LogLevel = resolveLevel();

/**
 * Wall-clock stopwatch. Every log line that closes an operation should carry a
 * `durationMs` — "the expense saved" is far less useful than "it saved in 3.2s".
 */
export function startTimer(): () => number {
  const started = performance.now();
  return () => Math.round((performance.now() - started) * 10) / 10;
}

/** `alice@example.com` → `a***e@example.com`. Enough to correlate, not to leak. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "(none)";
  const [name, domain] = email.split("@");
  if (!domain) return "(malformed)";
  const head = name.slice(0, 1);
  const tail = name.length > 2 ? name.slice(-1) : "";
  return `${head}***${tail}@${domain}`;
}

/**
 * Supabase-js returns errors as plain objects rather than throwing, so they
 * bypass the Error branch of sanitize(). This lifts the fields that matter.
 */
export function dbError(error: unknown): LogFields {
  if (!error || typeof error !== "object") return { err: sanitize(error) };
  const e = error as {
    message?: unknown;
    code?: unknown;
    details?: unknown;
    hint?: unknown;
    status?: unknown;
    name?: unknown;
  };
  return {
    err: {
      type: e.name ?? "PostgrestError",
      message: typeof e.message === "string" ? truncate(e.message) : e.message,
      code: e.code,
      details: e.details,
      hint: e.hint,
      status: e.status,
    },
  };
}
