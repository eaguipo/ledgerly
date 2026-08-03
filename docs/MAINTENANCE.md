# Maintenance Guide

The offline reference for working on Ledgerly: how the system is designed, why each boundary is
where it is, and step-by-step recipes for adding features, fixing bugs, and changing infrastructure
without breaking the invariants that protect user money.

This document assumes no AI assistant and no internet search. Everything you need to make a correct
change should be here or in the files it points at. For setup and commands, see
[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md).

**Contents**

1. [System map](#1-system-map)
2. [Architecture](#2-architecture)
3. [Invariants — do not break these](#3-invariants--do-not-break-these)
4. [Configuration reference](#4-configuration-reference)
5. [Recipes — making changes](#5-recipes--making-changes)
6. [Bug-fixing playbook](#6-bug-fixing-playbook)
7. [Traps and gotchas](#7-traps-and-gotchas)
8. [Security review checklist](#8-security-review-checklist)
9. [Workflow, branches, commits](#9-workflow-branches-commits)
10. [Known gaps and technical debt](#10-known-gaps-and-technical-debt)

---

## 1. System map

```
personal-finance-tracker/
├── apps/web/                      Next.js 16 frontend AND backend-for-frontend
│   ├── src/proxy.ts               Next 16 middleware (renamed: middleware.ts → proxy.ts)
│   ├── src/lib/
│   │   ├── supabase/server.ts     anon-key server client (RLS applies) — Server Components/Actions
│   │   ├── supabase/client.ts     anon-key browser client (RLS applies)
│   │   ├── supabase/middleware.ts session refresh + route protection (called by proxy.ts)
│   │   ├── gateway.ts             gatewayFetch() — the ONLY way web talks to microservices
│   │   ├── auth/actions.ts        login / signup / signout Server Actions
│   │   └── format.ts              formatMoney() — currency-aware display
│   ├── src/app/
│   │   ├── layout.tsx             root layout
│   │   ├── page.tsx               landing
│   │   ├── login/, signup/        auth pages (page.tsx + *-form.tsx client component)
│   │   ├── auth/callback/route.ts PKCE code → session exchange for email confirmation
│   │   ├── dashboard/page.tsx     balances by category & currency (direct Supabase read)
│   │   ├── portfolios/            accounts CRUD (direct Supabase, RLS-enforced)
│   │   │   ├── page.tsx, [id]/page.tsx, portfolio-form.tsx
│   │   │   ├── actions.ts         create/update/archive/restore Server Actions
│   │   │   └── constants.ts       portfolio category enum, mirrors the DB enum
│   │   ├── expenses/              expenses (through the mesh, NOT direct Supabase)
│   │   │   ├── page.tsx           reads via gatewayFetch
│   │   │   ├── actions.ts         createExpense Server Action → POST /ledger/expenses
│   │   │   └── expense-form.tsx   client component, useActionState
│   │   ├── income/                money in from outside (through the mesh)
│   │   │   ├── page.tsx, income-form.tsx
│   │   │   ├── actions.ts         createIncome → POST /ledger/incomes
│   │   │   └── constants.ts       income source enum, mirrors the DB enum
│   │   └── transfers/             money between own accounts (through the mesh)
│   │       ├── page.tsx, transfer-form.tsx
│   │       └── actions.ts         createTransfer → POST /ledger/transfers
│   ├── Dockerfile                 prod image (standalone output; NEXT_PUBLIC_* are BUILD args)
│   ├── Dockerfile.dev             dev image (next dev; Tilt live-syncs src/)
│   └── AGENTS.md                  "this is not the Next.js you know" — read the bundled docs
│
├── services/api-gateway/src/server.ts   JWT validation + reverse proxy. No database access.
├── services/ledger/src/server.ts        expense / income / transfer endpoints. Service-role DB access.
├── services/ledger/src/supabase.ts      service-role client factory (bypasses RLS)
│
├── deploy/helm/charts/service/    generic reusable chart: Deployment, Service, Ingress,
│                                  HPA, ConfigMap, Secret, NetworkPolicy
├── deploy/helm/ledgerly/          umbrella chart — one aliased instance per service
│   ├── Chart.yaml                 the alias list (web, api-gateway, ledger)
│   ├── values.yaml                per-service config; NO secrets
│   └── values.local.yaml.example  template for the non-Tilt deploy path
├── deploy/k3d/cluster.yaml        1 server + 1 agent, local registry, ingress ports, no Traefik
├── Tiltfile                       dev loop; reads apps/web/.env.local for all credentials
├── Makefile                       every workflow command (`make` prints them)
│
├── db/schema.sql                  18 tables, 17 functions, 26 triggers, 7 views
├── db/policies.sql                54 RLS policies + grants
├── db/seed.sql                    currencies, feature catalog, per-user back-fills
└── db/functions/                  atomic money RPCs, run separately after schema/policies
    ├── create_expense.sql
    ├── create_income.sql          also widens the income_source enum (gains, gift)
    ├── create_transfer.sql        service-role sibling of do_transfer()
    ├── create_debt.sql            debt + optional disbursement; widens income_source (loan_received)
    ├── create_debt_payment.sql    service-role sibling of do_debt_payment(), plus overpayment guards
    ├── debt_principal_recompute.sql  recompute_debt() helper + the debts-side trigger
    ├── cashflow_excludes_debt_origination.sql  keeps borrowing/lending out of inflow-outflow
    ├── create_goal.sql            goal + linked-account currency check (no money moves)
    ├── create_goal_contribution.sql  earmark/withdraw, plus the over-withdrawal guard
    ├── create_investment.sql      holding + funding-account currency check (no money
    │                              moves); adds investments.kind_label and re-creates
    │                              v_investment_performance to select it
    ├── record_investment_snapshot.sql  valuation upsert; rejects future dates and
    │                              derives currency from the parent holding
    ├── money_invested.sql         buying an investment posts a real outflow; adds
    │                              expenses.investment_id and re-creates both report
    │                              views to exclude asset purchases
    ├── authenticated_entry_points.sql  do_income/do_expense/do_debt/do_goal/
    │                                   do_goal_contribution/do_investment/
    │                                   do_investment_snapshot — the RLS-path wrappers
    │                                   the Vercel deploy writes through
    └── custom_option_labels.sql    user-supplied options: the two label columns,
                                    plus create_expense/create_income/do_expense/
                                    do_income re-created with one more parameter
```

Two kinds of file live in `db/functions/`, and they behave differently:

- **New objects** (`create_*.sql`, `authenticated_entry_points.sql`) exist only here. `schema.sql`
  knows nothing about them; they are applied by hand after it.
- **Redefinitions of something `schema.sql` already creates** — currently
  `debt_principal_recompute.sql` (§15c triggers), `cashflow_excludes_debt_origination.sql`
  (§19 views), the `alter table` half of `custom_option_labels.sql` (§7/§10 columns), and
  `create_investment.sql`, which is both kinds at once: a new RPC *plus* the
  `investments.kind_label` column (§12) and a re-created `v_investment_performance` (§19).
  These **must be kept byte-identical to `schema.sql`**, because re-running
  `schema.sql` on a live database would otherwise silently revert them.

Apply order matters: `create_debt.sql` before `cashflow_excludes_debt_origination.sql` (which
references the `loan_received` enum value it adds), **every** `create_*` file before
`authenticated_entry_points.sql` (which delegates to them all), and
`custom_option_labels.sql` **last** — it drops and re-creates four of the functions those two
files define, so anything applied after it would put the old signatures back.

---

## 2. Architecture

### 2.1 The four layers and what each is allowed to do

| Layer | Trusts | Database access | Never does |
|-------|--------|-----------------|------------|
| Browser / client components | nothing | anon key + RLS | hold secrets; call a microservice |
| **web** (Next.js BFF) | the Supabase session cookie | anon key + RLS — portfolios and dashboard always; everything else too when there is no gateway (Vercel) | call a microservice from a client component; **use the service-role key for user data** |
| **api-gateway** | nothing — validates every JWT itself | none | forward the client's `Authorization` header downstream |
| **ledger** | the gateway (proven by `x-internal-secret`) | **service-role — RLS is bypassed** | trust `x-user-id` without the internal secret; omit `.eq("user_id", …)` |
| Supabase Postgres | the caller's role | — | — |

### 2.2 Identity and the trust chain

This is the most important thing to understand before changing anything in `services/`.

1. The browser holds a Supabase session cookie. `@supabase/ssr` manages it; `proxy.ts` refreshes it
   on every request via `updateSession()`.
2. `gatewayFetch()` (`apps/web/src/lib/gateway.ts`) reads the session server-side and sends the
   access token as `Authorization: Bearer <token>` to the gateway.
3. The gateway calls `resolveUserId()`. If `SUPABASE_JWT_SECRET` is set it verifies HS256 locally
   (fast, offline); otherwise it introspects `GET /auth/v1/user` against Supabase Auth. Either way
   it ends up with a UUID or `null` → 401.
4. The gateway then calls the ledger with **`x-user-id`** (the validated id) and
   **`x-internal-secret`**. It deliberately does *not* forward the client's `Authorization` header,
   and it never forwards a client-supplied `x-user-id`.
5. The ledger's `onRequest` hook rejects anything without a matching `x-internal-secret` (403),
   except `/healthz`. It then reads `x-user-id` and scopes every query with `.eq("user_id", userId)`.
6. `create_expense` re-checks in SQL that the portfolio and category belong to `_user_id` — so even
   a bug in the service can't write across tenants.

Three independent controls guard the same boundary: the shared secret (application layer), the
NetworkPolicy (network layer), and the ownership re-check in the RPC (data layer). Keep it that way;
each was added because the others can fail.

**Why not just forward the user's JWT to the ledger?** Because then every service would need
Supabase Auth knowledge and its own validation path, and a leaked token would be replayable
service-to-service. Terminating auth once at the edge and asserting identity internally is the
standard gateway pattern — the cost is that internal identity is only as strong as the internal
secret plus network isolation, which is why both exist.

### 2.3 Why expenses go through the mesh but portfolios don't

Phase B extracted the **first service seam** deliberately, and only one:

- **Expenses** — web never touches expense tables. Reads and writes go
  `web → gateway → ledger → Supabase`.
- **Portfolios, dashboard, auth** — still direct Supabase calls from the web app with the anon key,
  protected by RLS.

This is intentional, not an unfinished migration in the bad sense. Portfolio balances are maintained
by **triggers on `transactions`** (plus overdraft and currency guards), so the ledger and portfolio
domains are coupled *inside the database*. Extracting the API seam is safe; extracting the data
boundary (a real `ledger` schema) requires first lifting that balance logic into the application or
event layer. **Extract the service boundary before the data boundary.**

When you add a feature, decide which side of the seam it belongs on — §5.1 gives the rule.

### 2.4 Data model essentials

One unified ledger, thin detail tables:

```
transactions            ← single source of truth for EVERY money movement
  kind (enum)              income | expense | transfer_in | transfer_out |
                           debt_payment_made | debt_payment_received | opening_balance | …
  direction (enum)         inflow | outflow
  amount                   numeric(38,18), always POSITIVE
  signed_amount            GENERATED: +amount for inflow, −amount for outflow
  currency_id              must equal the portfolio's currency (trigger-enforced)
  is_void                  soft-void; voided rows are excluded from balances and reports

  ├── incomes            1:1 detail
  ├── expenses           1:1 detail — category_id NOT NULL (Rule 9)
  ├── transfers          written only by do_transfer() / create_transfer()
  └── debt_payments      written only by do_debt_payment() / create_debt_payment()
```

Key mechanics:

- **`portfolios.current_balance` is a trigger-maintained cache** of the ledger, kept by
  `apply_txn_to_balance()`. `reconcile_portfolio_balances()` rebuilds it from the ledger if it ever
  drifts. Reads use the cache; the overdraft guard uses the cache under `SELECT … FOR UPDATE`.
- **`portfolios.opening_balance` is not authoritative and must never be summed** (DECISIONS-NEEDED
  #6). A starting balance is an `opening_balance` *ledger row*, posted by `createPortfolio`, and
  that row is what the cache and the reconcile function derive from. The column is a written-once
  note of what the account opened at — nothing reads it and no later edit maintains it. Adding it
  to any balance double-counts the ledger row it duplicates.
- **Guards fire on `transactions`, not on the API.** `txn_overdraft_guard()` blocks any outflow that
  would push a non-`allow_negative` portfolio below zero, whatever wrote it.
  `txn_enforce_currency()` requires the transaction currency to match the portfolio's.
- **Money RPCs are the write path for anything multi-row**: `create_expense()`, `create_income()`,
  `create_transfer()`, `create_debt()`, `create_debt_payment()`, `create_goal()`,
  `create_goal_contribution()`, `create_investment()`, `record_investment_snapshot()`,
  `do_transfer()`, `do_debt_payment()`. Each runs in one transaction
  and locks what it needs. Clients cannot write `transfers`, `debt_payments` or
  `goal_contributions` directly.
- **Two RPC dialects, and picking the wrong one fails confusingly.** The older `do_*` functions read
  identity from `auth.uid()` and are granted to `authenticated` — the RLS path. The newer `create_*`
  functions take `_user_id` explicitly and are granted to `service_role` — the path ledger-service
  uses. Calling a `do_*` function as service_role makes `auth.uid()` NULL, so every ownership lookup
  misses and you get "not found or not owned by you" for a row that plainly exists. `create_transfer`
  and `create_debt_payment` exist precisely because `do_transfer` / `do_debt_payment` cannot be
  called from the service. Keep each pair in sync until the `do_*` half is retired.
- **Goals move no money, and that is the whole design.** `goal_contributions` is an earmark laid
  over balances you already hold (decision D2): `transaction_id` stays NULL, no ledger row is
  posted, no portfolio balance changes. It follows that earmarks can exceed real money — the /goals
  page warns when the goals pointing at an account total more than it holds, and deliberately does
  not block it. Moving money into savings for real is a Transfer.
- **`create_goal_contribution` guards over-withdrawal for the same reason `create_debt_payment`
  guards overpayment.** `apply_goal_contribution()` sets `current_amount = greatest(sum(amount), 0)`,
  so taking back more than is set aside clamps the cached total at zero while the underlying sum
  goes negative — and every later contribution is then measured from a phantom deficit.
- **Buying an investment moves money; valuing one does not.** `investments.portfolio_id` is the
  account that *paid*, and setting it posts a real outflow against a self-healing `Money Invested`
  category (`db/functions/money_invested.sql`). Leaving it blank is record-only, for a holding that
  predates the app — the same optional shape as a debt's disbursement. Snapshots move nothing: a
  valuation is an observation, and gains stay unrealised until you sell. **Selling is not modelled.**
- **`expenses.investment_id` marks an asset purchase, and both report views exclude it.** Buying gold
  is not consumption, exactly as lending is not spending — `v_cashflow` and `v_expense_by_category`
  filter it out alongside `debt_id`. Three files carry those two view definitions (`schema.sql` §19,
  `cashflow_excludes_debt_origination.sql`, `money_invested.sql`) and **all three are byte-identical
  on purpose**, so the order they are applied in cannot matter.
- **`investments.current_value` belongs to the snapshot trigger, not to callers.**
  `sync_investment_current_value()` copies the market value of the snapshot with the NEWEST
  `as_of_date` onto it, so a value written any other way silently reverts on the next valuation. The
  `/investments` PATCH route (both transports) allow-lists columns specifically to exclude it, along
  with the generated `unrealized_gain`. `record_investment_snapshot` is the only supported way to
  move it, and it rejects future dates because one mistyped year would win that newest-date race
  permanently — no later real valuation could ever displace it.
- **Investment valuations are one row per day.** `uq_inv_snap_inv_date` is unique on
  `(investment_id, as_of_date)`, so "correct today's value" is an upsert; an insert raises 23505 and
  loses the correction. The snapshot's currency is taken from the parent holding rather than the
  caller — `investment_snapshots` has no equivalent of `txn_enforce_currency()`, so a USD valuation
  on a PHP holding would otherwise be accepted and corrupt `current_value`.
- **`create_debt_payment` is not a pure port.** It adds guards `do_debt_payment` never had: an
  overpayment is rejected rather than silently absorbed by `greatest(principal − paid, 0)`, and a
  settled or archived debt refuses payment. A *written-off* debt still accepts one — recovering on a
  write-off is real, and `recompute_debt()` keeps the status sticky so it is not relabelled as
  collected.
- **Debt outstanding is derived, never incremented.** `recompute_debt(uuid)` rebuilds
  `outstanding_balance` and `status` from the sum of principal portions, and runs from two triggers:
  on `debt_payments` (any change) and on `debts` (when `principal_amount` itself is edited). Only
  the principal portion pays a debt down, so an interest-only payment moves cash and leaves the
  balance alone.
- **All 7 reporting views are `security_invoker = true`** so RLS on the base tables applies. A plain
  `CREATE VIEW` runs as the owner and would leak every tenant's finances — this was the critical bug
  caught in the schema review. If you add a view, you must add this option.
- **History is append-only-ish**: expense categories soft-delete (`is_active = false`), portfolios
  archive (`is_archived`), transactions void rather than delete. Referenced rows use
  `ON DELETE RESTRICT`.
- **Multi-currency has no FX conversion.** Currency is per-portfolio, copied onto every transaction,
  and every total is grouped *by currency*.
- **Feature flags gate writes only** (`has_feature()` in RLS write policies). Disabling a feature
  must never hide a user's historical reads.
- **Signup is a DB trigger.** `handle_new_user()` on `auth.users` creates the `profiles` row, 14
  default expense categories, 5 purpose tags, and feature access. Application code must never insert
  into `profiles`.

Full rationale: [DATABASE.md](DATABASE.md).

### 2.5 Deployment topology

```
host :8080 ─→ k3d load balancer ─→ ingress-nginx ─→ Service/web:80 ─→ web pod :3000
                                                                          │
                                              ClusterIP api-gateway:80 ←──┘
                                                     │  (NetworkPolicy: from pods labeled name=web)
                                              ClusterIP ledger:80 ←──────┘
                                                     │  (NetworkPolicy: from pods labeled name=api-gateway)
                                                     ▼
                                         managed Supabase (external, via egress)
```

Every service is an aliased instance of the same generic chart, `deploy/helm/charts/service`. The
umbrella (`deploy/helm/ledgerly`) instantiates it once per alias, and each alias's values block
becomes that instance's `.Values`. Adding a service is therefore an entry in `Chart.yaml` plus a
values block — no new templates.

The chart renders: Deployment (with readiness + liveness probes and config/secret checksum
annotations so pods roll on config change), Service, and conditionally Ingress, HPA, ConfigMap
(`env`), Secret (`secretEnv`), NetworkPolicy.

---

## 3. Invariants — do not break these

Treat this as the review checklist for every change.

**Security**

1. `SUPABASE_SERVICE_ROLE_KEY` never appears in a `NEXT_PUBLIC_*` variable, a client component, a
   build arg, or a committed file. It bypasses RLS entirely.
2. Every query in `services/ledger` (and any future service-role service) filters by the caller's
   user id: `.eq("user_id", userId)`. RLS is *off* for these callers — the filter is the only thing
   between two users' data.
3. New tables get RLS enabled plus select/insert/update/delete policies in `db/policies.sql`.
4. New views are created `with (security_invoker = true)`.
5. New SQL functions that take a `_user_id` parameter re-verify ownership of every referenced row,
   and are `revoke all … from public` + `grant execute … to service_role`.
6. The gateway never forwards the client's `Authorization` header or a client-supplied `x-user-id`
   downstream.
7. Client components never call a microservice. `gatewayFetch` is server-only.

**Money correctness**

8. `transactions.amount` is always positive; direction carries the sign.
9. All money movement goes through `transactions` so the balance trigger and guards fire. Never
   `UPDATE portfolios SET current_balance = …` from application code.
10. Multi-row money operations go through a SQL RPC, not two sequential client calls.
11. A transaction's `currency_id` always equals its portfolio's.
12. Transfers stay excluded from inflow/outflow reporting (`v_cashflow` filters `kind`).
13. Deleting user-facing reference data soft-deletes; history never disappears.

**Operational**

14. `apps/web/.env.local` is the single source of truth for local secrets. Values files hold
    placeholders only; `values.local.yaml` is gitignored.
15. After editing `deploy/helm/charts/service`, run `make helm-deps` before deploying.
16. Node 20 for every JS workspace.
17. Before writing Next.js-specific code, read the bundled docs in
    `apps/web/node_modules/next/dist/docs/` — Next 16 differs from what you remember (see §7).

---

## 4. Configuration reference

| Variable | Consumed by | Set where | Notes |
|----------|-------------|-----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | web (browser + server) | `.env.local`; chart `web.env`; **build arg** for the prod image | Inlined into the client bundle at build time |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web (browser + server) | same | Public by design; RLS is the boundary |
| `SUPABASE_SERVICE_ROLE_KEY` | ledger (and web, unused today) | `.env.local`; chart `secretEnv` | Runtime only. Bypasses RLS |
| `GATEWAY_URL` | web server code | chart `web.env` (`http://api-gateway`); `.env.local` for local runs | **Set = use the mesh; unset = run the ledger in-process over RLS** (`lib/ledger.ts`). Unset it and `/expenses`, `/income`, `/transfers`, `/debts` keep working without a cluster — that is how the Vercel deploy runs |
| `SUPABASE_URL` | gateway, ledger | chart `env` | Trailing slashes are stripped by the gateway |
| `SUPABASE_ANON_KEY` | gateway | chart `env` | Only used for the introspection fallback |
| `SUPABASE_JWT_SECRET` | gateway | chart `secretEnv` | If set → local HS256 verify; **if set and wrong, everything 401s** (no fallback) |
| `INTERNAL_API_SECRET` | gateway + ledger | chart `secretEnv` for both | Must match. If empty on the ledger, it logs a warning and enforces nothing |
| `LEDGER_URL` | gateway | chart `env` (`http://ledger`) | In-cluster DNS name |
| `PORT` | all services | image `ENV` / chart | Services default to 8080, web to 3000 |
| `LOG_LEVEL` | web + gateway + ledger | chart `env` for all three (`info`); Tilt sets `debug` | `trace\|debug\|info\|warn\|error\|fatal`. Defaults to `info` in production, `debug` otherwise |
| `LOG_FORMAT` | web only | `.env.local` | `pretty\|json`. Defaults to `pretty` in development, `json` in production. The services are always JSON |

Where Tilt gets them: `Tiltfile:29-33` reads `apps/web/.env.local` and passes them as Helm `--set`
overrides. `INTERNAL_API_SECRET` falls back to `dev-internal-ledgerly-secret` if absent.

---

## 5. Recipes — making changes

### 5.1 Decide where the feature belongs

```
Does it move money or read financial records?
├── No  (auth, profile, settings, static pages)
│      → web only, direct Supabase with the anon key + RLS
└── Yes
    ├── Is it expenses/income (ledger domain)?
    │      → extend services/ledger + a route in web that calls gatewayFetch
    ├── Is it a new bounded context (debts, goals, investments, reporting)?
    │      → EITHER a new microservice (§5.5, the learning path)
    │         OR direct Supabase in web following the portfolios pattern (the shipping path)
    └── Does it need multi-row atomicity or a balance guard?
           → a SQL RPC is mandatory (§5.6)
```

Both patterns are legitimate here. Portfolios use direct Supabase; expenses use the mesh. Pick one
per feature and be consistent inside it — do not half-migrate a feature.

### 5.2 Add a page to the web app

1. Create `apps/web/src/app/(app)/<feature>/page.tsx` as an **async Server Component**. The
   `(app)` route group supplies the signed-in shell (sidebar, mobile tab bar, theme toggle) and
   does not affect the URL; `(auth)` is the equivalent group for `/login` and `/signup`.
2. Authenticate at the top of the page — do not rely on the proxy alone:
   ```tsx
   const supabase = await createClient();
   const { data: { user } } = await supabase.auth.getUser();
   if (!user) redirect("/login");
   ```
   `proxy.ts` is an optimistic pre-filter; `getUser()` is the network-verified check. Every
   protected page and every Server Action repeats it.
3. Fetch data: either `supabase.from(...)` (RLS applies) or `gatewayFetch("/ledger/...")`.
4. Put interactivity in a sibling `"use client"` component (`<feature>-form.tsx`) and pass plain
   serializable props. Follow `(app)/expenses/expense-form.tsx`: `useActionState(action, initial)`,
   `pending` for the disabled state, reset the form on success.
5. Build the UI from the shared primitives in `src/components/ui/` (`Button`, `Card`, `Field`,
   `Input`, `Select`, `Table`, `Money`, `Alert`, `EmptyState`) and wrap the page in
   `PageContainer` + `PageHeader`. Use the semantic tokens (`bg-surface`, `text-ink`,
   `border-line`, `text-accent`) — **never** raw Tailwind palette colours such as `zinc-200`, and
   never a `dark:` variant: the tokens flip themselves. See §5.9.
6. Add the route to `NAV_ITEMS` in `src/components/shell/nav-items.tsx` if it's a top-level
   destination — that feeds both the desktop sidebar and the mobile tab bar.
7. If the route must be public, add it to `isPublicPath()` in `src/lib/supabase/middleware.ts` —
   otherwise unauthenticated users get bounced to `/login`. A public route also belongs in the
   `(auth)` group (or outside both groups), since `(app)/layout.tsx` redirects anonymous visitors.

### 5.3 Add a Server Action

In `<feature>/actions.ts` with `"use server"` at the top of the file.

```ts
export async function doThing(prev: State, formData: FormData): Promise<State> {
  // 1. authenticate — actions are reachable by direct POST, never trust the caller
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 2. parse + validate; return { status: "error", message } for user-fixable problems
  // 3. write (supabase.from(...) or gatewayFetch)
  // 4. revalidatePath("/route") so Server Components re-read
  // 5. redirect() LAST, outside any try/catch
}
```

Rules learned the hard way (documented in `lib/auth/actions.ts`):

- `redirect()` throws `NEXT_REDIRECT` as control flow. Calling it inside `try/catch` swallows it.
  Never `return redirect(...)`.
- With `useActionState`, the signature is `(prevState, formData)` — FormData is the **second**
  argument.
- Returned state must be serializable. Return error strings; don't throw for validation failures.
- Auth errors branch on `error.code`, not `error.message`. Keep messages neutral for
  `invalid_credentials` / `user_already_exists` so account existence isn't leaked.

### 5.4 Add an endpoint to the ledger service

In `services/ledger/src/server.ts`:

```ts
app.get("/things", async (req, reply) => {
  const userId = userIdOf(req, reply);       // 401s and returns null if absent/invalid
  if (!userId) return reply;                 // note: return the reply, not undefined

  const { data, error } = await admin()
    .from("things")
    .select("id, name")
    .eq("user_id", userId)                   // MANDATORY — service-role bypasses RLS
    .limit(clamp(req.query.limit));

  if (error) {
    req.log.error({ error }, "list things failed");
    return reply.code(500).send({ error: error.message });
  }
  return { things: data ?? [] };
});
```

Conventions in this service:

- Validate every input before touching the database: UUID shape with `UUID_RE`, dates with
  `/^\d{4}-\d{2}-\d{2}$/`, amounts with `Number.isFinite(x) && x > 0`. Clamp limits
  (`Math.min(Math.max(n, 1), 200)`).
- Return **400** with a human-readable `error` for DB guard failures (insufficient funds, currency
  mismatch, not found) — the web layer renders that string directly to the user. Reserve **500** for
  genuine faults.
- Log with `req.log`, never `console.log` — Fastify's logger gives you request correlation.
- Writes that touch more than one row go through an RPC (§5.6), not sequential inserts.

Then wire the web side: `gatewayFetch("/ledger/things")`. The gateway proxies `/ledger/*`
generically, so **no gateway change is needed** for a new ledger route — that's the point of the
prefix proxy. Query strings are preserved (`req.url.slice("/ledger".length)`).

### 5.5 Add a whole new microservice

Say `portfolio-service`. Follow the ledger pattern exactly.

**1. Scaffold** `services/portfolio/`:

- `package.json` — copy `services/ledger/package.json`, rename, keep `"type": "commonjs"` and the
  three scripts (`build` = `tsc -p tsconfig.json`, `start`, `dev` = `tsx watch src/server.ts`).
- `tsconfig.json` — copy verbatim (ES2022 / CommonJS / `strict`).
- `src/supabase.ts` — copy from ledger. Keep the `ws` transport shim: Node 20 has no global
  `WebSocket` and `supabase-js` builds a Realtime client eagerly, so it crashes without it.
- `src/server.ts` — copy the internal-secret `onRequest` hook, `userIdOf()`, `/healthz`, then your
  routes.
- `Dockerfile` and `Dockerfile.dev` — copy from ledger (they're generic).
- `.dockerignore` — copy.

**2. Chart** — add the alias in `deploy/helm/ledgerly/Chart.yaml`:

```yaml
  - name: service
    alias: portfolio
    version: "0.1.0"
    repository: "file://../charts/service"
```

**3. Values** — add a `portfolio:` block in `deploy/helm/ledgerly/values.yaml`, modelled on
`ledger:`: `fullnameOverride`, image repository `k3d-registry.localhost:5000/ledgerly-portfolio`,
`containerPort: 8080`, service `port: 80 / targetPort: 8080`, `ingress.enabled: false`, probes at
`/healthz`, `env.SUPABASE_URL: ""`, `secretEnv` with `SUPABASE_SERVICE_ROLE_KEY` and
`INTERNAL_API_SECRET` as empty placeholders, and:

```yaml
  networkPolicy:
    enabled: true
    ingressFromPods:
      - { app.kubernetes.io/name: api-gateway }
```

**4. Gateway route** — add a proxy block in `services/api-gateway/src/server.ts` mirroring
`/ledger/*`, with `PORTFOLIO_URL` (default `http://portfolio`). Consider factoring the existing
handler into a `proxyTo(prefix, baseUrl)` helper the second time you write it rather than
copy-pasting a third.

**5. Tiltfile** — add a `docker_build('ledgerly-portfolio', …)` with the same `live_update` sync
block, the `--set` overrides for image/env/secrets, and
`k8s_resource('portfolio', port_forwards=['8083:8080'], labels=['backend'])`. Pick the next free
host port — 8080 is the ingress, 8081 the ledger, 8082 the gateway.

**6. Deploy** — `make helm-deps` (mandatory), then `make dev`.

**7. Verify** — `make status` shows the pod Ready; `kubectl -n ledgerly exec deploy/api-gateway --
wget -qO- http://portfolio/healthz` returns ok; an authenticated call through the gateway returns
data; a direct call without `x-internal-secret` returns 403.

Update `services/README.md` and [INFRA.md](INFRA.md) when the mesh changes shape.

### 5.6 Change the database

**There is no migration tool.** The workflow is: edit the SQL file *and* apply the change to the
live database by hand. Both, always — a file that doesn't match the deployed database is how the
next person loses a day.

For a **new object** (table, function, view):

1. Add it to `db/schema.sql` in the right numbered section, keeping the existing comment style.
2. New table → add RLS policies to `db/policies.sql`: enable RLS, then select/insert/update/delete
   scoped `using (user_id = auth.uid())`, with `has_feature('<key>')` on the write policies if the
   feature is gated. New view → `with (security_invoker = true)`.
3. Run the new statements in the Supabase SQL Editor. Idempotent forms (`create or replace`,
   `create table if not exists`, `on conflict do nothing`) let you re-run safely.
4. If it's an RPC called by a service, put it in its own file under `db/functions/` (like
   `create_expense.sql`), including the `revoke`/`grant` lines and
   `notify pgrst, 'reload schema';` at the end so PostgREST picks it up immediately. Add it to the
   run-order list in [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) §1.3 and in the chart's `NOTES.txt`.

For a **change to an existing table**, write the `alter table` in the SQL Editor *and* update the
`create table` in `schema.sql` so a fresh install produces the same result. Note the divergence in
the commit message.

Writing a money RPC — the template established by `create_expense` / `do_transfer`:

```sql
create or replace function public.do_thing(_user_id uuid, _portfolio_id uuid, _amount numeric)
returns jsonb language plpgsql set search_path = public as $$
declare v_currency uuid;
begin
  if _amount is null or _amount <= 0 then raise exception 'Amount must be greater than zero'; end if;

  -- ownership re-check: service-role callers bypass RLS, so verify here
  select currency_id into v_currency from public.portfolios
   where id = _portfolio_id and user_id = _user_id and not is_archived;
  if v_currency is null then
    raise exception 'Account not found or archived' using errcode = 'P0002';
  end if;

  -- insert into transactions (triggers apply the balance, guard overdraft, check currency)
  -- insert the detail row
  return jsonb_build_object(...);
end $$;

revoke all on function public.do_thing(uuid, uuid, numeric) from public;
grant execute on function public.do_thing(uuid, uuid, numeric) to service_role;
notify pgrst, 'reload schema';
```

Lock ordering matters when a function touches two portfolios: `do_transfer` locks both with
`SELECT … FOR UPDATE` in a deterministic order. Follow it to avoid deadlocks.

Exception messages become the user-facing 400 text — write them for a person, not a developer.

### 5.7 Change the Helm charts

- **Something that applies to every service** (a new probe field, security context, resource
  default) → edit `deploy/helm/charts/service/`, then **`make helm-deps`**, then `make template` to
  eyeball the rendered output, then `make dev` or `make deploy`.
- **Something for one service** → edit that alias's block in `deploy/helm/ledgerly/values.yaml`.
- **A new secret** → add it to `secretEnv` (placeholder empty string in `values.yaml`), add the
  `--set` line in the Tiltfile reading from `.env.local`, and document it in §4 here and in
  `values.local.yaml.example`.
- Config changes roll the pods automatically: the Deployment template annotates
  `checksum/config` and `checksum/secret` over the values.
- `make template` renders everything without a cluster — use it as your chart unit test.

### 5.8 Change the ingress or networking

- Ingress host/path live under `web.ingress` in the umbrella values. Only `web` has an ingress
  enabled; the gateway and ledger are ClusterIP-only by design. Don't expose them.
- NetworkPolicies are per-service under `networkPolicy`. `ingressFromPods` matches pod labels in the
  same namespace; the chart's selector labels are `app.kubernetes.io/name` +
  `app.kubernetes.io/instance`. Egress is allow-all (services must reach Supabase and DNS) — the
  control is on ingress.
- If you add a caller, add its label to the callee's `ingressFromPods` list, or its requests will
  silently time out.

### 5.9 Change the look of the app

The design language is dark-first and token-driven. There is no UI dependency — no component
library, no icon package, no charting library.

**Tokens.** `apps/web/src/app/globals.css` is the single source. Each token is a CSS variable
declared twice — once under `:root` (light) and once under `.dark` — and exposed to Tailwind via
`@theme inline`. The `inline` keyword is load-bearing: it makes the generated utility reference
`var(--surface)` instead of copying the value, which is what lets the `.dark` block override it.

The practical consequence: **components never write a `dark:` variant.** `bg-surface` is already
correct in both themes. If you find yourself typing `dark:`, you are working against the system.

| Token | Use for |
|---|---|
| `canvas` / `surface` / `raised` | page background · card background · insets and controls |
| `line` / `line-strong` | hairline borders · hover and emphasis borders |
| `ink` / `muted` / `faint` | primary text · secondary text · hints and disabled |
| `accent` / `accent-hover` / `accent-ink` / `accent-soft` | brand green, its hover, text on top of it, and its tinted background |
| `positive` / `negative` / `negative-soft` | inflows · outflows · error backgrounds |

**Theme switching** is class-based, not `prefers-color-scheme`. An inline script in the root layout
sets `.dark` on `<html>` before first paint, reading `localStorage["ledgerly-theme"]` and falling
back to the OS. `ThemeToggle` reads that class through `useSyncExternalStore` rather than mirroring
it into React state — do not "simplify" it into a `useEffect` + `setState`, which is a cascading
render and fails lint.

**Primitives** live in `src/components/ui/`. Add variants there rather than passing long
`className` overrides from a page; the point is that a button can't drift between routes.

**Charts** (`src/components/charts/`) are hand-written SVG. Two rules worth keeping:
- Single-series marks use one hue. Identity comes from direct labels, not colour.
- Never invent data. The dashboard trend reconstructs real history from
  `transactions.signed_amount`; if a number can't be derived, show fewer numbers.

**The brand mark** is `src/components/brand/logo.tsx`, and `src/app/icon.svg` is the favicon.
They are separate files with the same geometry — change both together.

---

## 6. Bug-fixing playbook

### 6.1 Isolate the layer first

The mesh has four hops. Guessing which one failed wastes the most time. Walk the chain outward from
the database:

```
1. Does the data look right in the Supabase SQL Editor?          → if not, it's a DB/trigger bug
2. Does ledger /healthz respond, and do its logs show the call?  → if not, service down/blocked
3. Does the gateway log the request and its upstream result?     → 401 vs 502 vs 400 tells you a lot
4. Does the web Server Component/Action get a non-ok Response?   → check what it renders on failure
5. Does the browser show it?                                     → caching/serialization/UI bug
```

Commands for each hop:

```bash
kubectl -n ledgerly get pods                              # is everything Ready?
kubectl -n ledgerly logs deploy/ledger --tail=100 -f
kubectl -n ledgerly logs deploy/api-gateway --tail=100 -f
kubectl -n ledgerly logs deploy/web --tail=100 -f
kubectl -n ledgerly exec deploy/web -- wget -qO- http://api-gateway/healthz
kubectl -n ledgerly exec deploy/api-gateway -- wget -qO- http://ledger/healthz
kubectl -n ledgerly get cm ledger-env -o yaml             # what env actually deployed
kubectl -n ledgerly describe pod -l app.kubernetes.io/name=ledger   # events, probe failures
```

Both services log every request with Fastify's logger, so a request that appears in the gateway log
but not the ledger log means the hop between them failed — secret mismatch, NetworkPolicy, or DNS.

### 6.1a Follow one request across all three logs

All three processes emit JSON lines with the same field names — `level` (a string), `time` (ISO),
`service`, `msg`, and `reqId`. `proxy.ts` stamps every inbound request with an `x-request-id`,
`gatewayFetch` forwards it, and both Fastify services are configured with
`requestIdHeader: "x-request-id"`, so **the same `reqId` appears in all three streams for one user
action**. That is the fastest way to answer "where did this go wrong":

```bash
# Find the id — every response also carries it in the x-request-id header.
kubectl -n ledgerly logs deploy/web | jq -c 'select(.msg=="expense.create.ok")'

# Then follow that one action through all three hops.
ID=<reqId>
for d in web api-gateway ledger; do
  echo "── $d"; kubectl -n ledgerly logs deploy/$d | jq -c --arg id "$ID" 'select(.reqId==$id)'
done

# Or just sweep for trouble.
kubectl -n ledgerly logs deploy/ledger | jq -c 'select(.level=="error" or .level=="warn")'
```

Message names are `<domain>.<action>.<outcome>` (`expense.create.ok`, `gateway.auth.rejected`,
`ledger.expense.create_rejected`), so grepping a whole flow is a substring match. Turn the volume up
with `LOG_LEVEL=debug` (Tilt already does); `debug` adds the start-of-operation lines and the
per-query `dbMs` timings, `info` and above is outcomes only.

What is deliberately **not** logged: access tokens (only a `tokenFingerprint`), passwords, cookies,
the internal secret, and free-text user data (merchant/description/account names appear as
`hasMerchant: true` / `nameLength: 12`). Emails are masked to `a***e@example.com`. Amounts, account
ids and user ids **are** logged — they are what makes a money bug traceable.

Health probes are excluded from the services' request logging (`quietLogController` in
`logging.ts`), so `/healthz` does not bury real traffic. Probe failures still show in
`kubectl describe pod`.

### 6.2 Symptom → cause table

| Symptom | Where to look first | Common cause |
|---------|---------------------|--------------|
| 401 "missing bearer token" | `gateway.ts` in web | No Supabase session — the Server Component didn't have cookies, or the user is logged out |
| 401 "invalid or expired token" | gateway env | `SUPABASE_JWT_SECRET` set but wrong (a set secret disables the introspection fallback), or a genuinely expired token |
| 403 "forbidden" from ledger | both `secretEnv` blocks | `INTERNAL_API_SECRET` mismatch between gateway and ledger |
| 502 "upstream unavailable" | gateway logs (`gateway.proxy.failed` — check its `timedOut` field) | Ledger pod down, wrong `LEDGER_URL`, NetworkPolicy blocking, or a >10s upstream (`UPSTREAM_TIMEOUT_MS`) |
| 500 from ledger with a PostgREST message | ledger logs | Schema drift: renamed column, missing FK, ambiguous embed (§7) |
| 400 "Account not found or archived" | `create_expense` / `create_income` / `create_transfer` | Portfolio belongs to another user, doesn't exist, or is archived |
| 400 "Could not find the function public.create_…" (PGRST202/42883) | `db/functions/` | The RPC file was never run in the SQL Editor, or PostgREST's schema cache is stale — re-run the file (it ends with `notify pgrst, 'reload schema'`) |
| 400 "invalid input value for enum income_source" | `create_income.sql` / `create_debt.sql` STEP 1 | The `alter type … add value` half was skipped, so `gains`/`gift`/`loan_received` don't exist in the DB yet |
| Transfer says "not found or not owned by you" for an account you can see | which RPC is being called | `do_transfer()` was called as service_role — `auth.uid()` is NULL there. Use `create_transfer()` (§5.6) |
| Debt says "Debt not found or not owned by you" for one that plainly exists | which RPC is being called | Same trap as above: `do_debt_payment()` called as service_role. Use `create_debt_payment()` |
| Debt outstanding looks stale after editing the principal | `debt_principal_recompute.sql` | The file was never run, so the `debts`-side trigger doesn't exist and only a payment recomputes |
| "Principal of X is more than the Y still outstanding" | `create_debt_payment` overpayment guard | Working as intended — use the form's "pay the remaining" shortcut rather than typing a larger figure |
| "You can only take back the X currently set aside" | `create_goal_contribution` guard | Working as intended — a goal cannot go negative, and clamping it silently would desync `current_amount` from its contribution rows |
| A goal reopens as "achieved" right after you reopen it | `refresh_goal_status` (schema §15d) | Correct: it is a BEFORE trigger, so a goal already at its target is promoted again inside the same update |
| Goals total more than the account backing them | nothing — advisory only | Inherent to the earmark model (D2). The /goals page warns; it never blocks |
| 400 "Insufficient funds…" | `txn_overdraft_guard` | Real overdraft, or a drifted `current_balance` cache |
| "Transaction currency must match portfolio currency" | `txn_enforce_currency` | Code derived the currency from the wrong place — always take it from the portfolio |
| Balances wrong after edits | `apply_txn_to_balance` | A void/update path that didn't go through the trigger; run `select reconcile_portfolio_balances();` |
| Empty page instead of an error | the page's `serviceError` handling | `!res.ok` branches that fall back to `{}` — check the actual status in the logs |
| Random logouts | `lib/supabase/middleware.ts` | Logic inserted between `createServerClient()` and `getUser()`, or a redirect that dropped the refreshed cookies |
| Logged-in user bounced to /login | `isPublicPath()` + `getUser()` | New route not in the public list, or cookies not carried through a redirect |
| Changes don't appear after a write | missing `revalidatePath` | Server Components cache; `gatewayFetch` already sets `cache: "no-store"` |
| Pod `Running` but never `Ready` | `kubectl describe pod` | Probe path wrong (services use `/healthz`, web uses `/`), or the app is slow to boot — raise `initialDelaySeconds` |
| `CrashLoopBackOff` on ledger | pod logs | `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing — `admin()` throws on first use |
| `CrashLoopBackOff` on web, `OOMKilled` / exit 137 | `kubectl describe pod` → Last State | `next dev` needs far more than the chart's 512Mi default while compiling; the pod boots, serves once, then dies mid-compile |
| Helm edit had no effect | — | Forgot `make helm-deps` after a subchart change |
| Everything worked yesterday | `colima status` | VM stopped; `make cluster-up` restarts it |
| Expense form missing on /expenses | ledger `ledger.expenses.options_empty` | The user has no active accounts and/or no active expense categories — seed data never ran |
| "Something went wrong" page, no obvious cause | web `web.request.error` | Match the digest shown on screen against the `digest` field; `routeType` says whether it was a render, an action or a route handler |
| Pod restarted and nothing explains it | pod logs, previous container | `process.uncaught_exception` / `process.unhandled_rejection` are logged as `fatal` before exit; a clean roll logs `process.shutdown.ok` |

### 6.3 Reproducing without the UI

Get a token and call the gateway directly — see [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) §4 Rung 5.
For a ledger-only repro inside the cluster:

```bash
SECRET=$(kubectl -n ledgerly get secret ledger-secret -o jsonpath='{.data.INTERNAL_API_SECRET}' | base64 -d)
kubectl -n ledgerly exec deploy/api-gateway -- \
  wget -qO- --header="x-user-id: <uuid>" --header="x-internal-secret: $SECRET" \
  http://ledger/expenses?limit=3
```

That bypasses JWT validation entirely and tells you whether the bug is in auth or in the data path.

### 6.4 After the fix

1. Re-run the verification ladder (DEVELOPER-GUIDE §4) — at minimum lint + build for the changed
   workspace, and the smoke test if money is involved.
2. Re-check the invariant list in §3 against your diff.
3. If the bug was a missing guard rather than a typo, add the guard at the **lowest** layer that can
   enforce it (DB constraint > trigger > RPC check > service validation > form validation). Higher
   layers are for good error messages; lower layers are for correctness.
4. If the fix changed behavior a user could notice, check [DECISIONS-NEEDED.md](DECISIONS-NEEDED.md)
   — the choice may already be recorded there.

---

## 7. Traps and gotchas

**Next.js 16 is not the Next.js in your memory.** `apps/web/AGENTS.md` exists because of this. The
authoritative docs are vendored at `apps/web/node_modules/next/dist/docs/` — read them offline
before writing framework-specific code. Known differences already hit in this repo:

- `middleware.ts` is now **`proxy.ts`**, exporting `proxy()` instead of `middleware()`.
  `src/lib/supabase/middleware.ts` keeps its name because it's a plain module, not a file
  convention.
- `cookies()` and `headers()` are async — `await` them.
- Server Action + `useActionState` signature is `(prevState, formData)`.

**PostgREST embed ambiguity.** `expenses` has two foreign keys to `transactions` (a plain
`transaction_id` and a composite `(transaction_id, txn_kind)`), so an embed must name the
constraint: `transaction:transactions!expenses_txn_kind_fk(...)`. Without it PostgREST errors on
ambiguity. Any new detail table with dual FKs needs the same treatment.

**PostgREST returns embeds as arrays sometimes.** The web code defensively handles both shapes
(`Array.isArray(e.transaction) ? e.transaction[0] : e.transaction`). Keep that when copying.

**`NEXT_PUBLIC_*` is baked in at build time.** Runtime env changes don't affect an already-built
production image. Dev images are fine because `next dev` reads env at runtime.

**A stored generated column is NULL inside a BEFORE trigger.** `txn_overdraft_guard` cannot read
`new.signed_amount`; it derives the delta from `amount`/`direction` instead. Any new BEFORE trigger
on `transactions` has the same constraint.

**Service-role bypasses RLS, silently.** A missing `.eq("user_id", …)` doesn't error — it returns
everyone's rows. There is no test that catches this. Grep for `.from(` in `services/` after any
change and confirm each has the filter.

**`SUPABASE_JWT_SECRET` has no fallback.** If it's set, the gateway *only* verifies locally; a wrong
value 401s every request even though Supabase itself is fine. Clear it to fall back to
introspection.

**`INTERNAL_API_SECRET` empty on the ledger disables enforcement.** It logs
`"INTERNAL_API_SECRET is not set — gateway trust is unenforced"` once per request. If you see that in
the logs, the ledger is currently callable by any pod that can reach it.

**Host port 8080 belongs to the ingress — never forward a service to it.** The k3d load balancer
publishes it, but a `kubectl`/Tilt forward bound to `127.0.0.1:8080` is more specific than colima's
wildcard bind and silently wins, so the app URL starts returning a Fastify `Route GET:/ not found`
404 from whatever service stole it. The Tiltfile puts the gateway on 8082 for this reason.

**`kubectl port-forward` traffic isn't pod traffic.** It arrives from the node, so NetworkPolicies
that only allow specific pods can drop it. Test service-to-service paths with `kubectl exec` from an
allowed pod instead.

**`make helm-deps` after every subchart edit.** The umbrella uses a vendored `.tgz`. Skipping this is
the most common "my change did nothing" cause.

**Node 18 is the shell default.** `nvm use 20` in every new terminal.

**Services are `"type": "commonjs"` with `module: CommonJS`.** Don't add ESM-only dependencies
without changing the whole tsconfig/package setup.

**`supabase-js` needs a WebSocket in Node 20.** It constructs a Realtime client eagerly even when
unused; `services/ledger/src/supabase.ts` injects `ws`. Copy that file when creating a service.

---

## 8. Security review checklist

Run through this before any commit that touches auth, services, SQL, or the charts:

- [ ] No secret added to a values file, a `NEXT_PUBLIC_*` var, a build arg, or a log line.
- [ ] Every new service-role query filters by `user_id`.
- [ ] Every new table has RLS enabled and complete policies; every new view is `security_invoker`.
- [ ] Every new RPC re-checks ownership of every referenced row and is granted to `service_role`
      only.
- [ ] Every new page and Server Action calls `getUser()` itself — the proxy is not the boundary.
- [ ] No new route exposes a service to the ingress.
- [ ] New callers are reflected in the callee's `networkPolicy.ingressFromPods`.
- [ ] Error messages don't leak account existence or another user's data (see the neutral-message
      pattern in `lib/auth/actions.ts`).
- [ ] Manually verified with two user accounts that neither can see the other's data.

---

## 9. Workflow, branches, commits

- **`main`** — stays Vercel-deployable: Next.js + managed Supabase, no services, no cluster. This is
  how the product ships.
- **`infra/docker-k8s-microservices`** — the local Kubernetes mesh. Everything in this document
  applies here.
- Feature work that belongs in the product should land in a shape that can merge to `main`; infra
  work stays on the infra branch. When they conflict, `main`'s deployability wins.
- **Do not add a `Co-Authored-By: Claude` trailer to commits in this repo.**
- Commit message style, from the existing history: a short imperative subject naming the phase or
  area — `Phase B: api-gateway + ledger microservice, expenses via the mesh`,
  `Dashboard: show balance totals per category and currency`.
- Update the docs in the same commit as the change: [INFRA.md](INFRA.md) for architecture,
  [DATABASE.md](DATABASE.md) for schema, [ROADMAP.md](ROADMAP.md) for phase progress, and this file
  for anything that changes how you'd maintain the system.
- Check [DECISIONS-NEEDED.md](DECISIONS-NEEDED.md) before making a product-behavior choice — several
  defaults are recorded there rather than in code.

---

## 10. Known gaps and technical debt

Things a maintainer should know are unfinished, roughly in order of how likely they are to bite:

1. **No automated tests at all.** Lint, typecheck, and manual smoke testing are the only safety net.
   The highest-value first test would be an integration test of `create_expense` against a scratch
   Supabase project, covering overdraft, currency mismatch, and cross-tenant rejection.
2. **`values.local.yaml.example` only covers `web`.** The non-Tilt `make deploy` path starts the
   gateway and ledger with empty credentials. See DEVELOPER-GUIDE §2.3 for the missing blocks.
3. **`.env.example` doesn't document `SUPABASE_JWT_SECRET` or `INTERNAL_API_SECRET`**, even though
   the Tiltfile reads both.
4. **The gateway proxy handler is single-purpose.** Adding a second service means copying the
   `/ledger/*` block; factor out a `proxyTo()` helper at that point.
5. **`x-user-id` trust is enforced by a shared secret plus NetworkPolicy.** Fine locally; a
   production deployment would want mTLS or signed internal tokens.
6. **All services still share the `public` schema.** Schema-per-service is blocked on lifting the
   balance triggers out of the database (see §2.3).
7. **No observability.** No metrics, no tracing, no log aggregation. Debugging is `kubectl logs`.
   Prometheus/Grafana/Loki is Phase E in [INFRA.md](INFRA.md).
8. **No CI.** Nothing runs lint, build, or `helm lint` on push.
9. **Ledger writes are not idempotent.** A retried `POST /expenses` creates a second expense; there
   is no request-id deduplication.
10. **Rate limiting is per-token, in-memory, per-pod.** It doesn't survive a restart or coordinate
    across replicas.
11. **`apps/web/README.md` is the untouched create-next-app boilerplate** and contradicts the real
    setup — use the docs in `docs/` instead.
12. **No FX rates anywhere.** Balances are per-currency and never converted, so the dashboard hero
    reports a single currency and lists the others separately. A combined net-worth figure needs a
    rates table first.
13. **An alpha modifier on a theme token silently loses its alpha.** `bg-canvas/95` compiles to
    plain `var(--canvas)` because the token is var-backed, so `backdrop-blur` behind it does
    nothing. Use a solid token, or write an explicit `color-mix()`.
13. **Phases C–E are unstarted**: portfolio/debt/goal/currency services, NATS event bus, reporting
    and notification workers, HPA tuning, observability, CI.

---

## Quick reference card

```
Run everything locally        3 terminals: ledger :8081, gateway :8080, web :3000
Run the mesh                  make cluster-up && make dev  →  http://ledgerly.local:8080
Verify a change               npm run lint && npm run build (web) · npm run build (services)
                              make lint && make template · smoke test · two-user RLS check
Repair drifted balances       select public.reconcile_portfolio_balances();
Who can call whom             browser→web→gateway→ledger→Supabase. Never skip a hop.
Identity                      JWT validated at the gateway → x-user-id + x-internal-secret
The one rule you can't break  service-role queries MUST filter .eq("user_id", userId)
After editing charts/service  make helm-deps
Before writing Next.js code   read apps/web/node_modules/next/dist/docs/
```
