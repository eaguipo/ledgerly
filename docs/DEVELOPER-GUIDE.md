# Developer Guide — Build, Run & Test

How to get Ledgerly running on a new machine, how to build every artifact, and how to verify a
change before you commit it. Written for the `infra/docker-k8s-microservices` branch (the local
Kubernetes mesh). Where `main` differs, it's called out.

For *why* the system is shaped this way and how to change it, see [MAINTENANCE.md](MAINTENANCE.md).

---

## 0. What you are running

Three deployable units plus a managed database:

| Unit | Path | Runtime | Port (container) |
|------|------|---------|------------------|
| `web` | `apps/web` | Next.js 16 (React 19) — frontend **and** BFF | 3000 |
| `api-gateway` | `services/api-gateway` | Fastify — validates the Supabase JWT, proxies `/ledger/*` | 8080 |
| `ledger` | `services/ledger` | Fastify — expense reads/writes via the service-role key | 8080 |
| Postgres + Auth | — | **Managed Supabase** (never self-hosted, never in the cluster) | — |

Request path:

```
Browser → web (holds the Supabase session cookie)
            │ Authorization: Bearer <supabase access_token>
            ▼
        api-gateway  → validates JWT, injects x-user-id + x-internal-secret
            ▼
        ledger       → service-role Supabase client (bypasses RLS)
            ▼
        Supabase Postgres
```

Two things follow from that and shape everything below:

- **Nothing works without a Supabase project.** There is no local database. Even `npm run dev` on
  the web app alone needs real Supabase credentials.
- **The expenses feature needs all three processes running.** Portfolios/dashboard talk to Supabase
  directly from the web app; expenses go through the mesh.

---

## 1. One-time setup

### 1.1 Toolchain

```bash
make prereqs      # brew install colima docker k3d kubectl helm tilt
make hosts        # adds ledgerly.local + k3d-registry.localhost to /etc/hosts (sudo)
```

**Node 20 is required.** The shell defaults to Node 18, which will fail the Next.js build.

```bash
nvm use 20        # do this in every new terminal, or `nvm alias default 20`
node -v           # must print v20.x
```

`apps/web/.nvmrc` pins `20`; the Docker images are all `node:20-alpine`.

### 1.2 Supabase project

1. Create a free project at supabase.com. Pick the closest region; save the DB password.
2. **Settings → API** — copy the Project URL, the `anon` key, and the `service_role` key.
3. **Settings → API → JWT Settings** — copy the JWT secret (optional but recommended; it lets the
   gateway verify tokens locally instead of calling Supabase on every request).

### 1.3 Run the SQL, in this exact order

Supabase SQL Editor → New query → paste and run each file, one at a time:

```
1. db/schema.sql              tables, enums, functions, triggers, reporting views
2. db/policies.sql            Row Level Security policies + grants
3. db/seed.sql                currencies, feature catalog, per-user default back-fills
4. db/functions/*.sql         the RPCs ledger-service calls — every file, in any order:
     create_expense.sql             expenses
     create_income.sql              income (also widens income_source: gains, gift)
     create_transfer.sql            transfers (service-role sibling of do_transfer)
     create_debt.sql                debts + optional disbursement (widens income_source: loan_received)
     create_debt_payment.sql        debt payments (service-role sibling of do_debt_payment)
     create_goal.sql                goals (validates the linked account's currency)
     create_goal_contribution.sql   goal earmarks + the over-withdrawal guard
     create_investment.sql          holdings + investments.kind_label; re-creates
                                    v_investment_performance to expose it
     record_investment_snapshot.sql valuations: upsert-per-day, no future dates,
                                    currency taken from the parent holding
     money_invested.sql             AFTER create_investment.sql — buying an
                                    investment posts a real outflow; adds
                                    expenses.investment_id and excludes asset
                                    purchases from both report views
     debt_principal_recompute.sql   keeps outstanding_balance right when a principal is edited
5. db/functions/custom_option_labels.sql   LAST — user-supplied options: adds
     portfolios.category_label / incomes.source_label and re-creates
     create_expense / create_income / do_expense / do_income with one more
     parameter each. Must run after the four functions it replaces.
```

Order matters for 1–3: `policies.sql` references objects created in `schema.sql`, and `seed.sql`
must run before the first signup so `handle_new_user()` can resolve the default PHP currency. The
step-4 `db/functions/` files are independent of each other; `custom_option_labels.sql` is not —
it redefines functions the others create, so it goes last.

Step 4 is easy to forget — without it the matching feature fails with a PostgREST "function not
found" error (PGRST202/42883), which reads like a bug in the app rather than a missing migration.
There is no migration tool; running these files by hand *is* the migration process.

### 1.4 Credentials file

`apps/web/.env.local` is the **single source of truth for secrets**. The Tiltfile reads it and
injects the values into the cluster, so you fill this in once and never put secrets in a values
file.

```bash
cp apps/web/.env.example apps/web/.env.local
```

Then fill it in. Note that `.env.example` only documents the first three; the last three are read
by the Tiltfile and by local service runs:

```bash
# --- documented in .env.example ---
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...            # safe in the browser; RLS is the boundary
SUPABASE_SERVICE_ROLE_KEY=eyJ...                # SERVER ONLY — bypasses RLS, never NEXT_PUBLIC_

# --- also read by the Tiltfile (Tiltfile:29-33) ---
SUPABASE_JWT_SECRET=your-jwt-secret             # optional: gateway verifies HS256 locally
INTERNAL_API_SECRET=dev-internal-ledgerly-secret # gateway → ledger shared secret (any value)

# --- only needed for the all-local run mode in §2.1 ---
GATEWAY_URL=http://localhost:8080
```

`.env.local` is gitignored. Never commit it, and never let `service_role` reach the browser.

### 1.5 Install dependencies

```bash
nvm use 20
(cd apps/web && npm ci)
(cd services/api-gateway && npm ci)
(cd services/ledger && npm ci)
```

---

## 2. Running the system

Three modes. Pick by what you're changing.

### 2.1 Mode A — all-local, no containers (fastest inner loop)

Best for app-code work: React/Next changes, Fastify route changes, debugging with a Node debugger.
No Docker, no cluster, no Kubernetes. Three terminals, all on Node 20:

```bash
# Terminal 1 — ledger service on :8081
cd services/ledger
SUPABASE_URL=https://YOUR-REF.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
INTERNAL_API_SECRET=dev-internal-ledgerly-secret \
PORT=8081 npm run dev

# Terminal 2 — api-gateway on :8080
cd services/api-gateway
SUPABASE_URL=https://YOUR-REF.supabase.co \
SUPABASE_ANON_KEY=eyJ... \
SUPABASE_JWT_SECRET=your-jwt-secret \
INTERNAL_API_SECRET=dev-internal-ledgerly-secret \
LEDGER_URL=http://localhost:8081 \
PORT=8080 npm run dev

# Terminal 3 — web on :3000 (reads apps/web/.env.local, incl. GATEWAY_URL)
cd apps/web && npm run dev
```

Open http://localhost:3000.

Both services use `tsx watch`, so they restart on save. `next dev` gives HMR.

`INTERNAL_API_SECRET` must be **identical** in terminals 1 and 2 or every ledger call returns 403.
`GATEWAY_URL=http://localhost:8080` in `.env.local` is only consumed by the web app's server code;
the Tiltfile ignores it, so it can't leak into the cluster.

### 2.2 Mode B — the full mesh with Tilt (the real dev loop)

Best for anything touching Docker, Helm, Kubernetes, networking, or the service seam.

```bash
make cluster-up     # starts colima, creates the k3d cluster, installs ingress-nginx
make dev            # tilt up: builds images → pushes to the k3d registry → deploys the chart
```

Then open **http://ledgerly.local:8080** (through ingress-nginx) or **http://localhost:3000**
(Tilt's port-forward to the web pod). Tilt's UI is at http://localhost:10350.

What `make dev` does: reads `apps/web/.env.local`, builds the three **dev** images
(`Dockerfile.dev`, running `next dev` / `tsx watch`), pushes them to
`k3d-registry.localhost:5000`, and deploys the `deploy/helm/ledgerly` umbrella chart with the
Supabase values passed as `--set` overrides. Source under `apps/web/src` and `services/*/src` is
live-synced into the running containers — you do not rebuild to see a code change.

Stop with `make dev-down` (removes the release, keeps the cluster) or `make cluster-down`
(deletes the cluster entirely).

Tilt forwards the gateway to **8082** and the ledger to **8081**. The gateway deliberately does not
use 8080: the k3d load balancer publishes host `8080` → ingress `:80`, and a forward bound to
`127.0.0.1:8080` is more specific than colima's wildcard bind, so it silently wins and every request
to `ledgerly.local:8080` reaches the gateway instead of the app — which answers with a Fastify
`{"message":"Route GET:/ not found"}` 404 that looks nothing like a port conflict.

### 2.3 Mode C — Helm without Tilt

For testing the chart itself, or the production images, without the Tilt dev loop.

```bash
cp deploy/helm/ledgerly/values.local.yaml.example deploy/helm/ledgerly/values.local.yaml
# edit it — see the warning below
make deploy         # helm upgrade --install with -f values.local.yaml
```

> **The example file is incomplete.** It only fills in the `web:` block. `make deploy` will start
> `api-gateway` and `ledger` with empty Supabase credentials, so every expense call fails. Add
> these before deploying:
>
> ```yaml
> api-gateway:
>   env:
>     SUPABASE_URL: "https://YOUR-REF.supabase.co"
>     SUPABASE_ANON_KEY: "your-anon-key"
>   secretEnv:
>     SUPABASE_JWT_SECRET: "your-jwt-secret"
>     INTERNAL_API_SECRET: "pick-a-shared-secret"
> ledger:
>   env:
>     SUPABASE_URL: "https://YOUR-REF.supabase.co"
>   secretEnv:
>     SUPABASE_SERVICE_ROLE_KEY: "your-service-role-key"
>     INTERNAL_API_SECRET: "pick-a-shared-secret"   # must match the gateway's
> ```
>
> `values.local.yaml` is gitignored. It holds real secrets — keep it that way.

Mode C also needs images in the registry. Either let Tilt build them once, or build and push
manually (§3.3).

---

## 3. Building

### 3.1 Web app

```bash
cd apps/web
nvm use 20
npm run build        # production build — also runs the full TypeScript typecheck
npm run start        # serve the production build locally on :3000
npm run lint         # eslint (next core-web-vitals + typescript configs)
```

`next.config.ts` sets `output: "standalone"`, so the build emits a self-contained
`.next/standalone` bundle used by the production Docker image.

### 3.2 Services

Each service is an independent npm workspace with no shared library yet.

```bash
cd services/api-gateway   # or services/ledger
npm run build             # tsc -p tsconfig.json → typechecks and emits dist/
npm start                 # node dist/server.js
```

There is no linter configured for the services — `npm run build` (i.e. `tsc --strict`) is the only
static check they have.

### 3.3 Container images

```bash
# Dev images (what Tilt builds — next dev / tsx watch, source live-synced)
docker build -f apps/web/Dockerfile.dev            -t ledgerly-web:dev         apps/web
docker build -f services/api-gateway/Dockerfile.dev -t ledgerly-api-gateway:dev services/api-gateway
docker build -f services/ledger/Dockerfile.dev      -t ledgerly-ledger:dev      services/ledger

# Production images
docker build -f services/ledger/Dockerfile -t ledgerly-ledger:prod services/ledger
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://YOUR-REF.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
  -t ledgerly-web:prod apps/web
```

> **The web production image needs `NEXT_PUBLIC_*` as build args, not runtime env.** Next inlines
> those values into the client bundle at build time. If you skip the build args, the image will run
> but every browser-side Supabase call 500s with no obvious cause. The dev image doesn't have this
> problem — `next dev` reads them from the environment at runtime, which is why Tilt passes them
> through the chart instead.

Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_API_SECRET`) are **never** build args —
they arrive at runtime through the Kubernetes Secret rendered by the chart.

To push to the cluster registry, tag as `k3d-registry.localhost:5000/<name>:<tag>` and
`docker push`.

### 3.4 Helm charts

```bash
make helm-deps      # vendors deploy/helm/charts/service into the umbrella (run after editing the subchart)
make lint           # helm lint
make template       # render all manifests to stdout — no cluster required
```

`make helm-deps` is not optional after a subchart edit. The umbrella consumes a vendored
`charts/service-0.1.0.tgz`; without re-vendoring, your template change silently doesn't deploy.

---

## 4. Testing & verification

**There is no automated test suite.** Lint, typecheck, chart rendering, and a manual smoke test are
the verification tools. Run the ladder below top to bottom before committing; each rung is cheap and
catches a different class of failure.

### Rung 1 — static checks (seconds)

```bash
nvm use 20
(cd apps/web && npm run lint && npm run build)
(cd services/api-gateway && npm run build)
(cd services/ledger && npm run build)
make lint && make template >/dev/null
```

### Rung 2 — process health

```bash
# Mode A (local)
curl -s localhost:8080/healthz     # {"status":"ok"} from the gateway
curl -s localhost:8081/healthz     # {"status":"ok"} from ledger

# Mode B (cluster)
make status                        # all pods should be 1/1 Running
kubectl -n ledgerly rollout status deploy/web deploy/api-gateway deploy/ledger
```

`/healthz` is deliberately exempt from the internal-secret check, so it's always reachable.

Each process logs a config summary at boot — `web.boot`, `gateway.boot`, `ledger.boot`. Read those
first: they report which credentials are **present** (never their values), the resolved log level,
and for the gateway which auth mode it picked. A misconfigured service starts and passes `/healthz`
regardless, so the boot line is usually faster than guessing.

### Rung 2a — reading the logs

All three processes emit one JSON object per line with the same fields (`level` as a string, ISO
`time`, `service`, `msg`, `reqId`). Messages are named `<domain>.<action>.<outcome>`.

```bash
# Follow one user action across all three hops (see MAINTENANCE.md §6.1a).
ID=<reqId from any log line, or the x-request-id response header>
kubectl -n ledgerly logs deploy/web         | jq -c --arg i "$ID" 'select(.reqId==$i)'
kubectl -n ledgerly logs deploy/api-gateway | jq -c --arg i "$ID" 'select(.reqId==$i)'
kubectl -n ledgerly logs deploy/ledger      | jq -c --arg i "$ID" 'select(.reqId==$i)'

# Anything that went wrong, anywhere.
kubectl -n ledgerly logs deploy/ledger | jq -c 'select(.level=="error" or .level=="warn")'

# Money that actually moved.
kubectl -n ledgerly logs deploy/ledger | jq -c 'select(.msg=="ledger.expense.create_ok")'
```

`LOG_LEVEL` (`trace|debug|info|warn|error|fatal`) is read by all three; Tilt sets `debug`, the chart
defaults to `info`. `debug` adds start-of-operation lines and per-query `dbMs` timings. In Mode A the
web app prints a human-readable line instead of JSON (`LOG_FORMAT=json` overrides that).

### Rung 3 — the smoke test (do this for any change that touches money)

Run through the app in a browser. This is the closest thing to an end-to-end test:

1. **Sign up** with a fresh email → the "confirm your email" state appears (if email confirmation is
   on in Supabase), and a `profiles` row plus 14 default categories and 5 purpose tags are created
   by the `handle_new_user()` trigger.
2. **Confirm + log in** → lands on `/dashboard`.
3. **Create a portfolio** at `/portfolios` — e.g. Cash Wallet, category `cash`, PHP, opening balance
   1000. Confirm the balance shows 1000 (the opening balance posts as an `opening_balance` ledger
   row, and the balance trigger applies it).
4. **Log an expense** at `/expenses` — 250, any category, that account, today. It should appear in
   the recent list immediately. This exercises the whole chain: Server Action → gateway → JWT
   validation → ledger → `create_expense` RPC → triggers.
5. **Check the dashboard** → Cash total is now 750.
6. **Sign out** → redirected to `/login`; visiting `/dashboard` bounces you back to `/login`.

### Rung 4 — negative tests (the invariants that actually protect the data)

| Test | How | Expected |
|------|-----|----------|
| **Multi-tenant isolation** | Sign up a second user, create data on both, log in as each | Each sees only their own portfolios/expenses. This is the single most important check in the app. |
| **Overdraft guard** | Expense larger than the account balance | Rejected with an "Insufficient funds" message surfaced in the form (400 from ledger) |
| **Unauthenticated gateway call** | `curl -i localhost:8080/ledger/expenses` | `401 {"error":"missing bearer token"}` |
| **Forged identity** | Call the gateway with `-H 'x-user-id: <someone-else>'` | Ignored — the gateway sets `x-user-id` itself from the validated token |
| **Direct ledger call without the secret** | `curl -i localhost:8081/expenses -H 'x-user-id: <uuid>'` | `403 {"error":"forbidden"}` |
| **Cross-tenant write** | Post an expense with another user's `portfolio_id` | 400 "Account not found or archived" — `create_expense` re-checks ownership |

### Rung 5 — API-level testing with curl

Get a real access token without a browser:

```bash
SUPABASE_URL=https://YOUR-REF.supabase.co
ANON=eyJ...
TOKEN=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
```

Then exercise the gateway (Mode A, or via a port-forward in Mode B):

```bash
curl -s localhost:8080/ledger/expenses/options -H "Authorization: Bearer $TOKEN"
curl -s localhost:8080/ledger/expenses?limit=5 -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8080/ledger/expenses \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"amount":12.5,"portfolio_id":"<uuid>","category_id":"<uuid>","txn_date":"2026-07-31","merchant":"Test"}'
```

In the cluster, `kubectl port-forward` traffic arrives from the node, not from a pod, so the
NetworkPolicies may drop it. If a forwarded call to the gateway or ledger hangs or resets, that's
the policy working — test from inside the mesh instead:

```bash
kubectl -n ledgerly exec deploy/web -- wget -qO- http://api-gateway/healthz
```

### Rung 6 — data-level verification (Supabase SQL Editor)

```sql
-- Cached balances agree with the ledger (the trigger cache is the thing most likely to drift)
select p.name, p.current_balance,
       coalesce(sum(t.signed_amount) filter (where not t.is_void), 0) as ledger_total
from portfolios p left join transactions t on t.portfolio_id = p.id
group by p.id, p.name, p.current_balance
having p.current_balance <> coalesce(sum(t.signed_amount) filter (where not t.is_void), 0);

-- Repair if they disagree
select public.reconcile_portfolio_balances();
```

---

## 5. Command cheat sheet

```bash
# Cluster lifecycle
make cluster-up / make cluster-down / make status / make logs

# Dev loop
make dev / make dev-down

# Charts
make helm-deps / make lint / make template / make deploy

# Inspect a running mesh
kubectl -n ledgerly get pods,svc,ingress
kubectl -n ledgerly logs deploy/api-gateway --tail=50 -f
kubectl -n ledgerly logs deploy/ledger --tail=50 -f
kubectl -n ledgerly describe pod -l app.kubernetes.io/name=web
kubectl -n ledgerly get cm web-env -o yaml            # non-secret env actually deployed
kubectl -n ledgerly exec -it deploy/ledger -- sh      # shell inside a service
helm -n ledgerly list

# Logs (JSON lines — see §4 Rung 2a)
kubectl -n ledgerly logs deploy/ledger | jq -c 'select(.level=="error")'
kubectl -n ledgerly logs deploy/web    | jq -c --arg i "$ID" 'select(.reqId==$i)'
```

`make` with no target prints the full annotated target list.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Next build fails with a syntax/engine error | Shell is on Node 18 | `nvm use 20` |
| `ledgerly.local` doesn't resolve | `/etc/hosts` entry missing | `make hosts` |
| `ImagePullBackOff` on `k3d-registry.localhost:5000/...` | Registry host not in `/etc/hosts`, or the cluster wasn't created from `deploy/k3d/cluster.yaml` | `make hosts`; recreate with `make cluster-down && make cluster-up` |
| Every page 500s on Supabase | `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` missing, or the prod image was built without the build args | Check `apps/web/.env.local` (Tilt) or `values.local.yaml` (Helm); rebuild with `--build-arg` |
| Expenses page shows "Couldn't reach the expense service" | Gateway or ledger down/misconfigured | `kubectl -n ledgerly logs deploy/api-gateway`, then `deploy/ledger` |
| Every ledger call is `403 forbidden` | `INTERNAL_API_SECRET` differs between gateway and ledger | Make them identical; in Tilt both come from `.env.local` |
| Every ledger call is `401 invalid or expired token` | `SUPABASE_JWT_SECRET` is set but wrong (a set secret disables the introspection fallback) | Fix or clear the secret |
| Adding an expense fails with "function ... does not exist" | `db/functions/create_expense.sql` was never run | Run it in the SQL Editor |
| "Insufficient funds" on a legitimate expense | Real guard, or the cached balance drifted | Verify with the SQL in §4 Rung 6; `select reconcile_portfolio_balances();` |
| Helm change has no effect | Subchart edit not re-vendored | `make helm-deps` then redeploy |
| `ledgerly.local:8080` returns a Fastify `Route GET:/ not found` 404 | A port-forward bound `127.0.0.1:8080` and shadowed the ingress | Nothing should forward to 8080; the gateway is on 8082 (`lsof -nP -iTCP:8080 -sTCP:LISTEN` to find the squatter) |
| Web pod `CrashLoopBackOff` with `OOMKilled` / exit 137 | `next dev` + Turbopack exceeds the chart's 512Mi limit while compiling | The Tiltfile raises web to 2Gi for the dev loop; if you deploy via Helm, raise `web.resources.limits.memory` too |
| colima slow or OOM | Under-provisioned VM | `colima stop && colima start --cpu 4 --memory 8` |
| A pod is `Running` but never `Ready` | Probe path/port wrong, or NetworkPolicy blocking probes | `kubectl describe pod ...`, check `probes.path` in the values |

---

## 7. Deploying `main` (Vercel path)

`main` has no services and no cluster — the web app talks to Supabase directly and ships on Vercel.

That includes the ledger-backed features. `lib/ledger.ts` routes `/ledger/*` to the mesh when
`GATEWAY_URL` is set and to in-process handlers over RLS-scoped Supabase when it is not, so
Expenses, Income, Transfers, Debts and Goals all work on Vercel without a gateway. **Do not set
`GATEWAY_URL` on Vercel** — there is nothing there for it to reach, and setting it turns every one
of those pages into the degraded "couldn't reach the service" state.

1. Push to GitHub, import the repo into Vercel, set the root directory to `apps/web`.
2. Add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   as project environment variables. Leave `GATEWAY_URL` unset.
3. Apply everything under `db/functions/` in the Supabase SQL Editor — the write path on this
   deploy goes through `do_income` / `do_expense` / `do_debt` / `do_goal` /
   `do_goal_contribution` from `authenticated_entry_points.sql`, which delegate to the `create_*`
   functions.
4. Deploy; confirm the `*.vercel.app` URL loads and signup works.

Free-tier constraints worth knowing (Supabase pauses after ~7 idle days, Vercel Hobby is
non-commercial, ~10s function timeout) are documented in [ROADMAP.md](ROADMAP.md).

---

## See also

- [MAINTENANCE.md](MAINTENANCE.md) — architecture, change recipes, debugging playbooks
- [INFRA.md](INFRA.md) — the Docker/Kubernetes architecture and its rationale
- [DATABASE.md](DATABASE.md) — schema design decisions and requirement coverage
- [ROADMAP.md](ROADMAP.md) — phased build plan
- [DECISIONS-NEEDED.md](DECISIONS-NEEDED.md) — open product questions; check before changing behavior
