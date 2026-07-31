# Ledgerly

A multi-user personal finance web app: track income & daily expenses, manage portfolios
(cash / bank / crypto / investment accounts), transfer funds, track debts, set goals, and
generate date-range financial reports.

Built to be shipped **for free**: a responsive web app (works great on a phone browser, can
be installed as a PWA later) instead of a native mobile app — far easier to build and deploy
at zero cost.

## Tech stack (all free tier)

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend + API | **Next.js** (React, App Router, TypeScript) | One framework for UI and server logic |
| Database + Auth | **Supabase** (PostgreSQL + Auth + Row Level Security) | Gives login, roles, and per-user data isolation out of the box |
| Hosting | **Vercel** (Hobby tier) | Connect GitHub → auto-deploy to a live HTTPS URL |

> Web vs mobile: a web app wins for a free first launch — no $99/yr Apple or $25 Google fee,
> no app-store review on every update, one codebase for phone + desktop. Native mobile is a
> listed *future enhancement*, not core.

## What's in this folder

```
personal-finance-tracker/
├── README.md                 ← you are here
├── apps/
│   └── web/                  ← Next.js 16 frontend / BFF (formerly finance-app/)
├── services/                 ← backend microservices (Phase B onward)
├── deploy/
│   ├── k3d/                  ← local Kubernetes cluster definition
│   └── helm/                 ← reusable service chart + ledgerly umbrella chart
├── Tiltfile                  ← live-reload dev loop
├── Makefile                  ← `make` for cluster/dev/deploy workflow
├── db/
│   ├── schema.sql            ← tables, enums, functions, triggers, reporting views
│   ├── policies.sql          ← Row Level Security policies + grants (run AFTER schema)
│   └── seed.sql              ← default expense categories, purpose tags, currencies
└── docs/
    ├── DEVELOPER-GUIDE.md    ← build, run & test the system (start here)
    ├── MAINTENANCE.md        ← architecture, change recipes, debugging playbooks
    ├── INFRA.md              ← Docker/Kubernetes local mesh — architecture + runbook
    ├── DATABASE.md           ← design decisions + requirement-coverage matrix
    ├── ROADMAP.md            ← phased build plan (MVP → full app) + first setup steps
    └── DECISIONS-NEEDED.md   ← open questions that need your answer before going further
```

## Two ways to run

| Path | How | When |
|------|-----|------|
| **Vercel + managed Supabase** | push `main`, Vercel auto-deploys | shipping to real users (recommended) |
| **Local Kubernetes mesh** | `make cluster-up && make dev` on the `infra/*` branch | learning Docker/K8s/microservices — see [docs/INFRA.md](docs/INFRA.md) |

The database schema was designed directly from the business requirements doc and put through
an **adversarial review pass**: every one of the 20 business requirements and 21 business rules
was checked against the actual SQL, a critical cross-tenant data-leak was caught and fixed, and
13 issues total were resolved before this was written. See [docs/DATABASE.md](docs/DATABASE.md).

## Quick start (high level)

1. Create a **Supabase** project (free), copy the Project URL + anon key + service_role key.
2. In the Supabase **SQL Editor**, run the files in this order: `db/schema.sql` →
   `db/policies.sql` → `db/seed.sql`.
3. Create the Next.js app: `npx create-next-app@latest finance-app` (TypeScript, App Router,
   Tailwind — all Yes), then `npm install @supabase/supabase-js @supabase/ssr`.
4. Add your Supabase keys to `.env.local` (never commit it).
5. Push to GitHub, import the repo into **Vercel**, paste the same env vars, deploy.

Full step-by-step instructions are in [docs/ROADMAP.md](docs/ROADMAP.md) → "First steps".

## Status

- [x] Database schema, security model, and seed data designed + verified
- [ ] Phase 0 — deploy an empty app live (prove the pipeline)
- [ ] Phase 1 — MVP: auth + portfolios + daily expenses
- [ ] Phase 2 — income + fund transfers
- [ ] Phase 3 — debts + goals
- [ ] Phase 4 — investments + multi-currency
- [ ] Phase 5 — reporting, analytics & dashboard

Before building, please read [docs/DECISIONS-NEEDED.md](docs/DECISIONS-NEEDED.md) — a few
product choices affect how some features behave.
