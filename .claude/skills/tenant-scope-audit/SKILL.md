---
name: tenant-scope-audit
description: Audit the ledger service for queries that are not scoped to a single user. The ledger uses the Supabase service-role client, which bypasses RLS, so a missing .eq("user_id", userId) leaks one user's finances to another. Invoke before committing or reviewing any change under services/ledger/, when adding a route or table to the ledger service, when the user asks "is this tenant-safe", "does this leak", "is this scoped", or types /tenant-scope-audit. Also invoke when adding a new service that uses the service-role key. Do NOT invoke for changes confined to apps/web — that path goes through the RLS-scoped anon client instead.
---

# tenant-scope-audit

Find queries in the ledger service that could return or mutate another user's rows.

**Why this needs its own check.** RLS is the security boundary everywhere else in Ledgerly.
The ledger service is the one place it does not apply: `services/ledger/src/supabase.ts`
builds the client with `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses every policy in
`db/policies.sql`**. There is no backstop. A single missing filter is a cross-user data
leak in a finance app, and nothing in lint, typecheck, or the type system will catch it.

## The invariant

Every query in `services/ledger/src/` against a user-owned table must constrain rows to the
caller — via `.eq("user_id", userId)` on a table query, or `_user_id: userId` on an RPC.

Three tables are legitimately global and need no scoping. Do not flag them:

- `currencies` — reference data
- `features` — flag definitions
- `profiles` — keyed by `id` (the auth user id), not `user_id`

**Derive this list; do not trust it.** It was accurate on 2026-08-07 but the schema moves.
A table is global only if `db/schema.sql` gives it no `user_id` column:

```bash
awk '/^create table/{t=$0; buf=""} {buf=buf" "$0} /\);/{ if (t!="" && buf !~ /user_id/) print t; t="" }' db/schema.sql
```

## Step 1 — enumerate every query

```bash
grep -n '\.from("' services/ledger/src/*.ts
grep -n '\.rpc("'  services/ledger/src/*.ts
```

As of 2026-08-07 the baseline is **28 `.from()` calls and 18 `.rpc()` calls, all correctly
scoped**. If the counts have grown, the new ones are what to inspect. A clean audit should
stay clean — a first-ever violation is far more likely to be new code than something missed.

## Step 2 — check each one against the full statement, not a grep window

Do **not** conclude from a line-window grep. Supabase query chains span a variable number of
lines, so a fixed window both misses scoping that appears later and borrows scoping from the
next query. This produces false clean results, which is the dangerous direction.

For each `.from("<table>")` hit: read the whole statement, from `.from(` to where the chain
terminates. Then classify.

| Finding | Verdict |
|---|---|
| `.eq("user_id", userId)` present, `userId` from the request identity | scoped |
| Table has no `user_id` column in `db/schema.sql` | global — fine |
| Scoped by a foreign key only (e.g. `.eq("portfolio_id", …)`) | **VIOLATION** unless the parent row was itself verified to belong to `userId` earlier in the same handler — check, don't assume |
| `.eq("user_id", …)` with anything other than the request's user id | **VIOLATION** — a client-supplied user id is the leak |
| No user constraint at all | **VIOLATION** |

For each `.rpc("<fn>")` hit: confirm `_user_id: userId` is passed (this codebase uses a
leading underscore, not `p_`), then open the function in `db/functions/` and confirm it
actually filters on that argument. **An RPC that accepts `_user_id` and ignores it is a
violation the call site cannot reveal** — the parameter looks right at every call.

## Step 3 — check where `userId` comes from

Scoping to the wrong identity is not scoping. Trace `userId` in the handler back to the
`x-user-id` header set by the api-gateway after it validated the JWT. Flag it if it comes
from a request body, query string, or route param — those are client-controlled, and
`.eq("user_id", req.body.userId)` reads as safe while being a total bypass.

Also confirm the route is behind the internal-secret hook. A handler reachable without
`x-internal-secret` is exposed regardless of how well it scopes.

## Step 4 — report

State the baseline you measured, then findings. If clean, say so plainly with the counts —
"28 `.from()`, 18 `.rpc()`, all scoped" is a useful result and worth recording.

For each violation:

```
services/ledger/src/server.ts:<line>  <table>
  Leak:  <whose rows are exposed, and through which route>
  Fix:   <the specific filter to add>
```

Rank by reachability: a violation on a GET that returns rows leaks data immediately; one on
a mutation path corrupts it. Both matter, but report reads first.

## What this does not cover

- **`apps/web/src/lib/ledger-local.ts`** — the Vercel path, which goes through the *anon*
  client with RLS active and writes via `do_*` RPCs that derive identity from `auth.uid()`.
  Different threat model. The check there is that the web tier never *builds a client* with
  the service-role key:

  ```bash
  grep -rn "SERVICE_ROLE" apps/web/src
  ```

  This is **not** expected to be empty. As of 2026-08-07 it has exactly one hit —
  `instrumentation.ts:25`, a boot log recording `Boolean(...)`, i.e. whether the variable is
  set, never its value. That is fine. What would be a real finding is the key reaching
  `createClient(...)`, a fetch header, or anything rendered client-side. Judge each hit by
  what it does with the key, not by the name appearing.
- **RLS policy correctness** in `db/policies.sql` — that governs the web path, not this one.
- Whether the *data* is right. This checks who can reach it, not whether the math is correct.
