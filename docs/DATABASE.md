# Database Design

PostgreSQL schema for Supabase. Designed from the business requirements PDF and verified by an
adversarial review against every requirement and rule.

Run order in the Supabase SQL Editor:

1. `db/schema.sql` — extensions, enums, tables, functions, triggers, reporting views
2. `db/policies.sql` — Row Level Security policies + grants
3. `db/seed.sql` — currencies, default expense categories, purpose-of-money tags

## At a glance

- **18 tables**, **17 functions**, **26 triggers**, **7 reporting views**, **54 RLS policies**
- Every user-data table has Row Level Security so a user only ever sees their own money
- All reporting views use `security_invoker = true` so they respect RLS (this was the critical
  bug the review caught — see Changelog)

## Core design decisions

1. **Unified ledger + thin detail tables.** One `transactions` table is the single source of
   truth for every money movement (a `kind` discriminator + inflow/outflow direction + positive
   amount + a generated `signed_amount`). `incomes` / `expenses` / `transfers` / `debt_payments`
   are thin tables that link 1:1 back to a transaction and hold only their domain fields. This
   makes inflow/outflow totals and date-range reports a single indexed query instead of UNION-ing
   five tables, while keeping strong per-module rules (e.g. every expense must have a category).

2. **Balance = ledger-as-truth + a trigger-maintained cache.** `portfolios.current_balance` is
   kept in sync by a trigger for fast reads and the overdraft check, with a reconcile function as
   a rebuild-from-ledger safety net. (For a beginner you can also just sum the ledger on read —
   pick one and stay consistent.)

3. **Transfers via an RPC.** It locks both portfolios (`SELECT … FOR UPDATE`), checks the source has
   enough, then writes a `transfer_out` + `transfer_in` pair atomically. Clients can't write the
   `transfers` table directly — they must call the RPC. This enforces Rules 11 (deduct + add) and
   12 (no overdraft) safely against race conditions.

   There are two, differing only in how they learn who is calling: `do_transfer()` reads
   `auth.uid()` (the RLS path, granted to `authenticated`), while `create_transfer()` takes
   `_user_id` as a parameter and is granted to `service_role` — that is the one ledger-service
   calls, since `auth.uid()` is NULL under the service role. Same body otherwise; keep them in sync.

4. **Transfers are excluded from inflow/outflow.** The cashflow view only counts
   income / expense / debt-payment kinds, so moving money between your own accounts never inflates
   your cash-flow totals — a common reporting bug, explicitly avoided.

5. **Roles & RLS.** `profiles.role` (`admin` / `user`), read via an `is_admin()` helper to avoid
   recursive policy checks. A trigger blocks a non-admin from changing their own role. Admins can
   manage users/features but, by default, **cannot** read other users' financial data (privacy
   first — see Decisions Needed if you want a true super-admin).

6. **Feature-level access (Rule 21).** A `features` catalog + `user_feature_access` overrides +
   a `has_feature()` helper. Feature flags gate **writes** (creating/editing) but never **reads**,
   so disabling a feature never hides a user's historical records.

7. **Historical integrity.** Transactions are append-only. Expense categories are **soft-deleted**
   (`is_active = false`, `deleted_at`) so deleting a category never erases the expenses filed under
   it (Rule 19). Portfolios/categories referenced by history use `ON DELETE RESTRICT`.

8. **Debt & goal automation.** Debt outstanding auto-recomputes from the payment ledger on every
   payment (Rule 14, and it self-heals on edits). Goals auto-flip to *achieved* when current ≥
   target (Rule 18), with a `first_achieved_at` that is never cleared so the "completed goals"
   report is stable.

9. **Multi-currency (Rule 17).** Currency is per-portfolio and copied onto every transaction. No
   automatic FX conversion in the MVP — all totals are grouped **by currency** (which is exactly
   what the reporting requirement asks for). Liquid money (Rule 16) is a generated column; crypto
   and investments are excluded.

10. **Audit trail (Rule 20).** A generic audit trigger captures before/after JSON, the owner, and
    the actor for inserts/updates/deletes on every financial table, into an append-only `audit_log`
    (admin-only read, no write policy — tamper-resistant).

11. **User-supplied options, two mechanisms.** The three "pick from a list" fields let people enter
    something the list doesn't have, but they are not the same kind of list underneath:

    - **Expense category** is a per-user table (`expense_categories`), so an invented category is a
      real row. `create_expense()` find-or-creates it (matched on `lower(name)` among active rows,
      the way `uq_expense_cat_user_active_name` is indexed) inside the same transaction as the
      expense — so a category can't survive an expense that failed a later guard.
    - **Account category** (`portfolio_category`) and **income source** (`income_source`) are
      **enums**, and they cannot grow members: `portfolios.is_liquid` is a stored generated column
      over `category`, and `v_expense_by_category` plus the dashboard allocation split group by
      both. So the enum keeps its meanings and a nullable `category_label` / `source_label` rides
      alongside it, **pinned by a check constraint to the catch-all member** (`others` / `other`).
      Rollups are unaffected — a custom account still aggregates as Others; only the label a person
      reads changes. The pinning is what stops a stale name surviving a re-categorisation.

    Consequence worth knowing: a custom account category is `others`, so it is **never liquid**
    (Rule 16 counts cash and savings banks). Naming an account "Petty cash" does not make it count
    toward liquid money — pick the Cash category for that.

## Requirement & rule coverage

All 20 business requirements and 21 business rules were mapped to concrete tables/features. A few
were "DB-satisfiable" (handled purely in the schema), others "Mixed" (schema + app logic), and a
handful are app-layer (reports, dashboards). The full mapping lives in the design output; the
notable enforcement points:

- **Rule 9** — every expense has a category: `expenses.category_id NOT NULL`.
- **Rule 12** — no overdraft: `do_transfer()` balance check + a global outflow guard trigger so
  even direct expense inserts can't push a non-credit account negative.
- **Rule 14** — debt payments reduce outstanding automatically, counting **principal only** so
  paying interest doesn't wrongly pay down principal.
- **Rule 16** — liquid = cash + bank *savings* only: `is_liquid` generated as
  `category = 'cash' OR (category = 'bank' AND is_savings)`.
- **Rule 19** — deleting a category keeps history: soft-delete, never cascade.
- **Rule 21** — admin controls feature access: enforced on writes for portfolios, income,
  expenses, transfers, debts, goals, investments.

## Review changelog (issues found & fixed before this schema was finalized)

The first draft was **rejected** by an adversarial reviewer. These fixes were applied:

**Critical**
- Reporting views were plain `CREATE VIEW`, which run as the owner and **bypass RLS** — every
  authenticated user could have read everyone's finances. All 7 views recreated with
  `security_invoker = true`.

**High**
- Feature flags were hiding **historical reads** when a feature was disabled (broke Req 18 /
  Rule 15). Flags now gate writes only.
- Feature enforcement only covered 3 of 8 features — added write-gating for the rest (Rule 21).
- Debt payments never posted to the cash ledger, so portfolio balances/cashflow silently missed
  them. Added a `do_debt_payment()` RPC that moves real money and links the payment to a ledger row.
- Debt reduction ignored the principal/interest split — fixed to reduce by principal portion.
- Money columns were `numeric(18,2)`, too coarse for the crypto currencies the schema seeds.
  Widened money columns to `numeric(38,18)`; transfer rounding now uses the destination currency's
  decimal places.

**Medium / Low**
- Overdraft guard now applies to all outflows, not just transfers (added `allow_negative` flag for
  credit-style accounts).
- Goals keep a permanent `first_achieved_at` (no longer wiped if the balance later dips).
- Detail tables (`incomes`/`expenses`) can't be linked to the wrong transaction kind anymore.
- Signup self-heals a missing default currency; `profiles.email` stays synced to auth identity;
  transfer fees post as a separate expense so they show up in cashflow.

## See also

- [DECISIONS-NEEDED.md](DECISIONS-NEEDED.md) — product choices that change how some features behave
- [ROADMAP.md](ROADMAP.md) — the phased build plan
