# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ledgerly — a multi-user personal finance web app (expenses, portfolios, transfers, debts, goals, reports). Two deployment paths:

- **`main`**: stays Vercel-deployable (Next.js + managed Supabase). This is how the product actually ships.
- **`infra/docker-k8s-microservices`**: a learning-focused local Kubernetes microservice mesh (k3d + Helm + Tilt). See `docs/INFRA.md` for the architecture and runbook.

## Commands

**Node 20+ is required for all JS workspaces; the shell defaults to Node 18. Run `nvm use 20` first.**

There is no test suite yet. Lint/typecheck are the verification tools.

```bash
# Web app (apps/web) — Next.js 16
cd apps/web && npm run dev      # local dev server (outside the cluster)
cd apps/web && npm run lint     # eslint
cd apps/web && npm run build    # production build (also typechecks)

# Microservices (services/api-gateway, services/ledger)
npm run dev                     # tsx watch
npm run build                   # tsc typecheck + emit to dist/

# Infra workflow (run `make` for full help)
make cluster-up                 # start colima, create k3d cluster, install ingress-nginx
make dev                        # Tilt live-reload dev loop (builds images, deploys umbrella chart)
make dev-down                   # stop Tilt
make status                     # pods/svc/ingress in the ledgerly namespace
make logs                       # tail web pod logs
make template                   # render the Helm chart to stdout — no cluster needed
make lint                       # helm lint the umbrella chart
```

App entry points when the mesh is running: `http://ledgerly.local:8080` (ingress) or `http://localhost:3000` (port-forward). Gateway is port-forwarded to 8082, ledger to 8081. (Not 8080 — that is the ingress.)

## Architecture

Monorepo: `apps/web` (Next.js 16 frontend/BFF) · `services/api-gateway` · `services/ledger` (Fastify) · `deploy/helm` · `deploy/k3d` · `db/` (Supabase SQL).

### Request flow (the core thing to understand)

```
Browser → web (Next.js BFF) → api-gateway → ledger service → Supabase Postgres
```

- **Web is the BFF**: it holds the Supabase session (cookie-based via `@supabase/ssr`). Server Components/Actions reach the ledger through `apps/web/src/lib/ledger.ts` (`ledgerFetch`) — never `gatewayFetch` directly, and never from a client component.
- **`ledgerFetch` has two transports, chosen by whether `GATEWAY_URL` is set.** Set (the mesh): `gatewayFetch` forwards the user's access token to the api-gateway. Unset (the Vercel deploy of `main`, which has no services): `lib/ledger-local.ts` answers the same `/ledger/*` paths in-process, reading through the RLS-scoped anon client and writing through the `do_*` RPCs, which derive identity from `auth.uid()`. The web tier never gets the service-role key on either path.
- **api-gateway** validates the JWT (HS256 locally when `SUPABASE_JWT_SECRET` is set, otherwise Supabase Auth introspection), then proxies `/ledger/*` downstream. It deliberately does **not** forward the client's Authorization header — identity is asserted via `x-user-id` plus a shared `x-internal-secret` (`INTERNAL_API_SECRET`), backed by NetworkPolicy.
- **ledger service** rejects any request lacking the internal secret, then uses the Supabase **service-role** client — which **bypasses RLS**, so every query must explicitly filter `.eq("user_id", userId)`. Money mutations go through SQL RPCs (`create_expense` in `db/functions/`) for atomicity, and DB guard errors (insufficient funds, currency mismatch) surface as 400s.

Adding a new domain service follows the ledger pattern: Fastify + internal-secret hook + service-role client + a new aliased instance of the reusable Helm subchart.

### Deploy/dev loop

- `deploy/helm/charts/service` is a **generic reusable subchart**; `deploy/helm/ledgerly` is the umbrella that instantiates it once per service (aliased as `web`, `api-gateway`, `ledger`). `make helm-deps` vendors the subchart; run it after editing the subchart.
- The **Tiltfile** is the dev loop: builds dev images (live-synced source, `tsx watch` / `next dev`), pushes to the k3d local registry, deploys the umbrella chart. It reads all Supabase creds from `apps/web/.env.local` — the single source of truth for secrets; nothing secret goes in values files.

### Database

Single managed Supabase Postgres + Auth (never self-hosted). `db/schema.sql` → `db/policies.sql` → `db/seed.sql`, run in that order in the Supabase SQL editor; there is no migration tool. All money movement is rows in `transactions` with kind-specific detail tables (`expenses`, `incomes`, `transfers`, …); balances come from views (`v_portfolio_balances`). RLS is the security boundary for the web app's direct Supabase access; services bypass it (see above). Design rationale and requirement coverage: `docs/DATABASE.md`.

## Conventions

- **Next.js 16**: conventions differ from training data (e.g. `middleware.ts` → `proxy.ts`). `apps/web/AGENTS.md` requires reading the docs in `node_modules/next/dist/docs/` before writing Next-specific code.
- Git commits: do **not** add a `Co-Authored-By: Claude` trailer in this repo.
- `docs/ROADMAP.md` tracks the phased build plan; `docs/DECISIONS-NEEDED.md` holds open product questions — check it before making product-behavior choices.
- `docs/DEVELOPER-GUIDE.md` (build/run/test) and `docs/MAINTENANCE.md` (architecture, change recipes, debugging, invariants) are the human-facing developer docs — keep them in sync when the architecture, commands, or config change.
