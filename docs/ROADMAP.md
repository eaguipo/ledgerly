# Build Roadmap

A realistic, beginner-friendly path to ship this app for free with Next.js + Supabase + Vercel.
Build in phases — each phase ends with something you can actually use and (after Phase 0) deploy.

## Phase 0 — Foundation & deploy skeleton

**Goal:** get a real (empty) app live on Vercel talking to Supabase *before* writing features, so
deployment is never a scary unknown later. Beginners who deploy last always get stuck — deploy
first, then iterate.

- Create a Supabase project (free tier, closest region). Save the Project URL, anon key, and
  service_role key from Settings → API.
- `npx create-next-app@latest finance-app` — TypeScript, App Router, Tailwind, ESLint, `src/` → all Yes.
- `npm install @supabase/supabase-js @supabase/ssr`.
- Create `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
  `SUPABASE_SERVICE_ROLE_KEY` (server-only). Confirm `.env.local` is gitignored.
- Build a browser Supabase client + a server client (the `@supabase/ssr` cookie pattern — copy once, reuse).
- Push to GitHub, import into Vercel, paste the same env vars, deploy. Confirm the `*.vercel.app` URL loads.
- Run `db/schema.sql`, `db/policies.sql`, `db/seed.sql` in the Supabase SQL Editor.

**Deliverable:** a blank but **live** app, wired to Supabase, with env vars working locally and in
production, and a `profiles` row auto-created on signup. The pipeline is proven.

## Phase 1 — MVP: auth + portfolios + daily expenses  *(High Priority)*

**Goal:** the smallest genuinely useful app — log in, create accounts, log daily expenses by
category. This alone covers the client's stated High Priority Features.

- **Auth:** Supabase email + password for register/login/logout. Build `/login`, `/signup`, and a
  protected `/dashboard`; use Next.js middleware to redirect unauthenticated users.
- **CRUD UI:** Portfolios page (add/edit/delete accounts — name, category, currency, balance).
  Expenses page: a form (amount, category, portfolio, date defaulting to today, optional note) and
  a recent-expenses list.
- **Verify RLS:** create two accounts and confirm each sees only its own data. This is the single
  most important security check.
- Deploy, then use it yourself for a few real expenses to shake out bugs.

**Deliverable:** a working expense tracker — sign up, create your real accounts (Bank 1, Cash
Wallet, Crypto Wallet…), add custom categories, log daily expenses, see balances update. A
legitimate v1 you could stop at.

## Phase 2 — Income + fund transfers

**Goal:** complete the money-in / money-between picture. Reuses the existing ledger — small surface.

- **Income:** income form (salary / business / debt payment received / other); inserting income
  increments the portfolio balance.
- **Transfers:** call the `do_transfer()` RPC — deduct source, add destination (Rule 11), block if
  source balance is insufficient (Rule 12). Surface the insufficient-funds error nicely in the UI.
- **Dashboard v0:** total inflow vs outflow for the current month + a per-portfolio balance list.

**Deliverable:** record income, move money between portfolios safely, see a basic monthly
inflow-vs-outflow summary.

## Phase 3 — Debts (payable + receivable) + goals

**Goal:** track what you owe / are owed, and savings goals.

- **Debts:** payable vs receivable, principal, outstanding, due date, status.
- **Debt payments:** call `do_debt_payment()` — moves real cash out of a portfolio *and* reduces the
  outstanding balance (counting principal). Status flips to settled at zero.
- **Goals:** target amount, contributions, progress bars; auto-completes when current ≥ target.
- Apply RLS to every new table (don't forget — each new table needs it).

**Deliverable:** debts tracked both directions with auto-decrementing balances; savings/emergency
goals with auto-completing progress.

## Phase 4 — Investments + multi-currency polish

**Goal:** separate liquid money from investments; handle MP2 / crypto / stocks correctly.

- **Investments:** type (MP2/crypto/stock/asset), invested vs current value; performance =
  current − invested.
- **Liquid vs investment separation (Rules 16 & 17):** liquid sums only cash + bank-savings;
  investments reported separately. Dashboards must never lump these together.
- **Multi-currency:** report totals grouped **by currency** (no FX conversion in v1 — defer that).

**Deliverable:** investments tracked separately from spendable cash with basic performance; all
totals correctly grouped by currency.

## Phase 5 — Reporting, analytics & dashboard

**Goal:** the date-range reports and financial-summary dashboard the client asked for. Mostly
read-only aggregation over data you already have.

- **Date-range report (Rule 15):** start/end pickers showing only in-range transactions — incoming
  cash, all expenses, total inflow, total outflow, net.
- **Summaries:** liquid money by currency; investment accounts + balances; remaining debt + payments
  in period; completed goals; per-portfolio balance summaries.
- **Dashboard:** headline cards (net worth, this-month inflow/outflow, total debt) + 1–2 charts
  (spending by category, inflow vs outflow over time) with a light lib like Recharts.
- Do aggregation in Postgres views/RPC (already provided) — small results, fast, low bandwidth.
- CSV export of a report — a cheap, nice win.

**Deliverable:** a real dashboard and date-range report covering every Reporting Requirement.

---

## First steps (exact order)

1. **Create the Supabase project** — supabase.com → New Project, name it, set a strong DB password
   (save it), closest region. Wait ~2 min.
2. **Grab credentials** — Project Settings → API. Copy Project URL, `anon` key, `service_role` key
   (keep service_role secret — server-side only).
3. **Run the SQL** — SQL Editor → New query → run `db/schema.sql`, then `db/policies.sql`, then
   `db/seed.sql`.
4. **Create the Next.js app** — `npx create-next-app@latest finance-app` (all Yes), then
   `cd finance-app && npm install @supabase/supabase-js @supabase/ssr`.
5. **Env vars locally** — `.env.local` with the two `NEXT_PUBLIC_…` keys + `SUPABASE_SERVICE_ROLE_KEY`.
   Never prefix service_role with `NEXT_PUBLIC_`. Confirm it's gitignored.
6. **Run locally** — `npm run dev` → http://localhost:3000, confirm a test query works.
7. **Push to GitHub** — `git init`, commit, `gh repo create`, push.
8. **Deploy to Vercel** — import the repo, add the same three env vars, deploy. Do this in Phase 0
   while the app is empty so deployment is never a late surprise.

## Free-tier notes (read these)

- **Supabase pauses a free project after ~7 days of inactivity.** Restoring is one click in the
  dashboard. Fine for daily personal use; don't build a fake pinger to keep it awake.
- **Supabase free limits:** 500 MB DB, 1 GB storage, 50k monthly active users — a personal finance
  app uses a tiny fraction. No automated backups on free, so export your data occasionally.
- **Vercel Hobby is non-commercial only.** Personal use is fine; if you ever charge users, upgrade
  to Pro ($20/mo).
- **Vercel Hobby limits:** ~100 GB bandwidth/mo, ~10s function timeout. Do heavy report queries in
  Postgres (views/RPC, already provided) and return small results — keeps you well under limits.
- **Keep `service_role` server-side only.** If it reaches the browser it bypasses RLS. Normal user
  reads/writes use the anon key + RLS — RLS is your real security boundary.
- Cold starts after idle are normal on free tiers, not a bug.

## Explicitly out of scope for v1 (future enhancements)

Don't over-build for these — the schema leaves room where cheap:

- Full Admin RBAC + the admin UI for managing users/features (the columns exist; default everyone
  to `user` and treat Admin as a later step — don't block the MVP on it).
- Multi-currency **conversion** with live FX rates (per-currency totals are enough for v1).
- PWA / installable + offline (responsive web is fully useful first).
- Recurring transactions / bill reminders, receipt uploads, CSV/bank import.
- Realtime updates, email/push notifications, advanced forecasting analytics.
