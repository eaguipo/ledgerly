# Phase 4 Plan — Investments + multi-currency polish

Companion to `docs/ROADMAP.md` Phase 4, written the same way `docs/PHASE-3-PLAN.md` was: after
auditing what already exists, so this lists only work that is genuinely missing.

**Headline:** same shape as Phase 3 — the data model is done and unused. `investments`,
`investment_snapshots`, their trigger, their RLS policies, the `investments` feature flag and
`v_investment_performance` all exist. Phase 4 is RPCs + ledger routes (**both transports**) + UI,
plus a display-layer correction to figures that already ship.

Phase 4 differs from Phase 3 in one important way: **most of the risk is not in the new feature.**
Investments, as the schema models them, move no money. The risk is in §7 — the moment a number on
the dashboard starts meaning something different, every existing figure has to be re-read.

---

## 1. Decisions — **PROPOSED, not settled**

`docs/DECISIONS-NEEDED.md` parks three questions on this phase (#2, #5, #7). Unlike Phase 3, these
have **not** been answered yet. Recommendations below; each says what changes if you decide the
other way, so the cost of the alternative is visible before you pick.

| # | Question | Recommendation | If you decide otherwise |
|---|----------|----------------|-------------------------|
| **D1** (=#7) | Does buying an investment move real cash out of a funding account? | **No — record-only**, keeping the schema default. `investments.portfolio_id` stays an optional, informational link. | It becomes a money-movement feature: `create_investment` must post an `expense`/`transfer_out` row atomically, take the overdraft guard, and get a `for update` lock — roughly the weight of `create_debt`'s disbursement leg. Note there is **no `investments.transaction_id`**, so a real link needs a schema change; `debts` at least had `incomes.debt_id` to reuse. |
| **D2** (=#7b) | Does an investment's `current_value` feed the net-worth headline? | **No for the headline, yes as a stated second figure.** Show "Liquid" and "Invested" as separate cards, never one sum. This is Rule 17 restated. | A combined figure re-introduces exactly the apples-to-oranges problem the per-currency grouping was added to prevent, and invites the double-count in §8.3. |
| **D3** (=#2) | Is liquid money all bank accounts, or only savings-flagged ones? | **Keep `cash + (bank AND is_savings)`.** Don't touch it. | `is_liquid` is a **stored generated column** (`schema.sql:179`) with `v_liquid_by_currency` on top. Changing the rule means dropping and re-adding the column and re-creating the view by hand, in the SQL editor, with no migration tool. Real cost for a definition you can also express in the UI. |
| **D4** (=#5) | Per-currency totals, or an FX table now? | **Per-currency only** — option (a) from the backlog note. | An `fx_rates` table + base currency + a `converted_amount` helper, and then every rate is a number you have to keep fresh or knowingly show stale. Explicitly out of scope for v1 in the roadmap. |
| **D5** | Gold, vehicles and other named asset types (backlog item) | **Use `investment_kind.other_asset` + a `kind_label`**, exactly like `portfolios.category_label`. No enum change, no new table. | A `gold_assets` table with weight/purity/condition columns is a real schema addition needing its own RLS policies — and none of it is on the roadmap. |

D5 is new here. It exists because the branch that just landed (`657cc7e`) established the pattern:
a catch-all enum member plus a nullable label pinned to it by a check constraint. `investment_kind`
already has `other_asset` as its catch-all, so "Gold bar", "Toyota Vios" and "Pag-IBIG MP2 #2" all
fit with no migration. See `db/functions/custom_option_labels.sql` for the reasoning about why enums
get a label and tables get a row.

---

## 2. What already exists (verify, do not rebuild)

| Object | Where | Note |
|--------|-------|------|
| `investments` | `db/schema.sql` §12 (410–434) | `unrealized_gain` is **generated** (`current_value − invested_amount`) — never write it |
| `investment_snapshots` | §12 (436–450) | unique on `(investment_id, as_of_date)` — one valuation per day, upsert don't insert |
| `sync_investment_current_value()` | §15f (668–680) | newest snapshot by `(as_of_date, created_at)` wins; fires on insert **and** update **and** delete |
| `investment_kind` enum | §21 | `mp2, crypto, stock, mutual_fund, bond, real_estate, other_asset` |
| RLS on both tables | `db/policies.sql` §9 (152–165) | writes gated on `has_feature('investments')`; snapshot insert also re-checks parent ownership |
| `investments` feature row | `db/seed.sql:43` | `is_default_enabled = true` |
| `v_investment_performance` | §19 (947–952) | `security_invoker = true`; already computes `return_pct` |
| Audit trigger | §15g (705) | `investments` already wired; **snapshots are not** — deliberate, they are high-volume |
| `is_liquid` + `v_liquid_by_currency` | §7 (179), §19 (894) | built, correct, and **unused by the app** |
| Gateway proxy | `services/api-gateway` | generic `app.all("/ledger/*")` — no gateway changes |

**This phase adds no new tables.** Under D5 it adds one nullable column and one check constraint.

---

## 3. The traps to avoid first

### 3.1 Two transports, or it 503s on one deploy

PR #8 landed after the Phase 3 plan was written. `ledgerFetch` picks a transport by whether
`GATEWAY_URL` is set: the mesh goes through `services/ledger/src/server.ts`, and Vercel `main`
answers the same `/ledger/*` paths in-process from `apps/web/src/lib/ledger-local.ts`. **Every
route below has to be written twice** or investments work in the cluster and 503 in production.

`ledger-local.ts` is 410 lines against `server.ts`'s 1707 — it is the thinner one and the easier one
to forget.

### 3.2 `has_feature('investments')` behaves differently per transport

`investments` is the fourth feature whose RLS *write* policies gate on `has_feature()`, which is
`auth.uid()`-based. On the local transport (anon client, RLS enforced) the gate is live. On the mesh
transport (service-role, RLS bypassed) it is dead. Both are harmless today only because the flag
defaults to `true` for everyone — this is the known gap carried since Phase 1, not a new one. Do not
"fix" it here; do not rely on it either.

### 3.3 There is no `do_investment()` to be trapped by

Phases 2 and 3 both lost time to an `auth.uid()`-era function that could not run under service-role
(`do_transfer`, `do_debt_payment`). Investments have **no** pre-existing `do_*` function at all, so
for once there is nothing to port. Write `create_investment(_user_id, …)` service-role-only first,
then wrap it as `do_investment()` in `authenticated_entry_points.sql` for the RLS path — the order
`create_goal.sql` established.

### 3.4 `unrealized_gain` and `current_value` are not yours to set directly

`unrealized_gain` is a generated column: writing to it errors. `current_value` is a plain column
**owned by the snapshot trigger** the moment any snapshot exists. Seed it at creation
(`current_value = invested_amount`, i.e. zero gain on day one) and let snapshots own it thereafter —
otherwise an edit form silently reverts on the next valuation.

---

## 4. SQL to write (`db/functions/`)

### 4.1 `create_investment.sql`

```
create_investment(_user_id, _name, _kind, _currency_id,
                  _invested_amount, _symbol default null, _quantity default null,
                  _average_cost default null, _opened_on default current_date,
                  _maturity_date default null, _portfolio_id default null,
                  _kind_label default null)
  returns jsonb  -- { investment_id }
```

- **Guard `_invested_amount >= 0`** (the table constraint agrees) and `_name` non-blank.
- **Guard the currency exists**, `using errcode = 'P0002'`, like `create_goal`.
- If `_portfolio_id` is set: must be owned, not archived, and **currency must match** — same check
  and the same reason as `create_goal`'s `_linked_portfolio`. A PHP holding hung off a USD account
  makes any "invested from this account" grouping lie. No `for update`: under D1 nothing moves, so
  there is no race to lose.
- `current_value := _invested_amount` (§3.4).
- `_kind_label` only valid when `_kind = 'other_asset'`, ≤ 40 chars, whitespace-collapsed with
  `regexp_replace(btrim(…), '\s+', ' ', 'g')` — copy the normalisation from `create_income`'s
  `source_label` verbatim so the autocomplete list can't fill with spacing variants.

**Under D1-alternative only** (buying moves cash): add `_funding_portfolio`, post
`transactions(kind='expense', direction='outflow')`, take `for update` on the portfolio, honour
`allow_negative`, and add an `investments.transaction_id` column — there is no existing link column
to reuse.

### 4.2 `record_investment_snapshot.sql`

```
record_investment_snapshot(_user_id, _investment_id, _market_value,
                           _as_of_date default current_date,
                           _unit_price default null, _quantity default null,
                           _source default null)
  returns jsonb  -- { snapshot_id, current_value, invested_amount, unrealized_gain, return_pct }
```

- **Upsert, not insert.** `uq_inv_snap_inv_date` is unique on `(investment_id, as_of_date)`, so
  "update today's value" twice raises `23505` and loses the second valuation. Use
  `on conflict (investment_id, as_of_date) do update`.
- Re-check the investment is owned by `_user_id` and `is_active` — service-role bypasses RLS, and
  the snapshot RLS policy's parent-ownership check does **not** run on that path.
- **Snapshot currency must equal the investment's currency.** Nothing in the schema enforces this
  (unlike transactions, which have `trg_txn_currency`) — a USD valuation on a PHP holding would be
  accepted and silently corrupt `current_value`. Take `currency_id` from the parent row rather than
  from the caller and the class of bug disappears.
- **Guard `_market_value >= 0`** (constraint agrees) and reject future `_as_of_date` — the trigger
  orders by `as_of_date desc`, so one fat-fingered 2027 row pins `current_value` forever and no
  later real valuation can displace it. This is the sharpest edge in the whole phase.
- Return the recomputed figures so the UI needn't re-fetch, matching `create_debt_payment`'s
  richer-JSON convention.

### 4.3 `investment_kind_label.sql` (D5)

Follows `custom_option_labels.sql` exactly:

```sql
alter table public.investments add column if not exists kind_label text;
alter table public.investments drop constraint if exists investment_kind_label_only_other;
alter table public.investments add constraint investment_kind_label_only_other check (
  kind_label is null
  or (kind = 'other_asset' and char_length(btrim(kind_label)) between 1 and 40)
);
```

The constraint is what keeps the pinning honest: re-classifying "Gold bar" from `other_asset` to
`stock` must clear the label rather than leave a name pointing at the wrong thing.

`v_investment_performance` must be re-created to select `kind_label` — it is `create or replace`,
and the column list changes, so expect to `drop view` first if Postgres refuses the replace.

### 4.4 `authenticated_entry_points.sql` — append

`do_investment(...)` and `do_investment_snapshot(...)`: `security definer`, no `_user_id` parameter,
`auth.uid()` or raise `28000`. Same contract as `do_goal` / `do_goal_contribution`. Keep the
`revoke all … from public; grant execute … to authenticated;` pair and the trailing
`notify pgrst, 'reload schema'`.

---

## 5. Ledger service routes (`services/ledger/src/server.ts`)

Existing shape: `userIdOf()` → validate → RPC or filtered query → `dbErrorFields` logging → 400 for
guard failures, 500 for infrastructure. Every read filters `.eq("user_id", userId)` explicitly.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/investments` | filters `kind`, `include_inactive`; embeds currency; returns performance fields |
| GET | `/investments/options` | currencies + active portfolios (for the optional link) + distinct existing `kind_label`s for autocomplete |
| GET | `/investments/:id` | investment + its snapshot history, newest first |
| POST | `/investments` | → `create_investment` |
| PATCH | `/investments/:id` | name, symbol, kind, `kind_label`, maturity_date, `is_active`, `portfolio_id`, `invested_amount` |
| POST | `/investments/:id/snapshots` | → `record_investment_snapshot` |

**No `DELETE`.** `investment_snapshots` is `on delete cascade` from `investments`, so deleting takes
the valuation history with it. Use `is_active = false` — the same archive-not-delete rule debts and
goals already follow, and `v_investment_performance` already filters on `is_active`.

**`invested_amount` is patchable but `current_value` is not.** Editing cost basis is legitimate
(you bought more); editing market value is what snapshots are for. If no snapshot exists yet,
patching `invested_amount` should also move `current_value` with it, or a brand-new holding shows a
phantom gain the moment its cost basis is corrected.

Mirror every one of these in `apps/web/src/lib/ledger-local.ts` (§3.1), reading through the
RLS-scoped anon client and writing through the `do_*` RPCs.

---

## 6. Web UI (`apps/web/src/app/(app)/`)

Mirror `goals/` — server page fetches via `ledgerFetch`, form is a client component driven by a
Server Action, success returns an id that doubles as the form reset key.

- **`/investments`** — summary cards **grouped by currency** (invested / current value / unrealized
  gain), a holdings list with per-row return %, a new-investment form, and a "Update value" action
  per row that posts a snapshot.
- **`/investments/[id]`** — header with cost basis vs current value, the snapshot history as a
  simple table (a chart is Phase 5's job, with Recharts), edit / deactivate.
- **Kind picker** — the `CustomSelect` from `657cc7e`; typing a value it doesn't have sets
  `kind = 'other_asset'` + `kind_label`. That is how gold and vehicles get in.
- **Nav** — add Investments to `NAV_ITEMS` in `components/shell/nav-items.tsx` (inline stroke icon,
  no icon package).
- Revalidate `/investments` and `/dashboard` after mutations. **Not** `/portfolios` — under D1
  nothing moved.

---

## 7. The dashboard correction (Rules 16 & 17)

This is the part that touches shipped behaviour, and it deserves more care than the new page.

`dashboard/page.tsx:247–267` builds `byCurrency` by summing `current_balance` over **every**
portfolio, then calls the result "net worth" (line 368 logs it under that name). Under Rule 16 that
figure mixes spendable cash with crypto and investment-category accounts, and under D2 it omits the
`investments` table entirely. Three changes:

1. **Split the bucket.** Carry `liquid` and `nonLiquid` alongside `total`, keyed off the `is_liquid`
   flag that `v_portfolio_balances` already exposes and the current query does not select. Add
   `is_liquid` to the `.select(...)` at line 165.
2. **Re-label the hero.** Lead with **Liquid** (cash + savings, per currency), and show
   **Invested** as its own card sourced from `v_investment_performance`. If a single "net worth"
   figure stays, it must be per-currency and must state what it includes — the existing comment at
   293–296 already makes exactly this argument for currencies; extend it to asset classes.
3. **Keep the primary-currency discipline.** The debt (329–343) and goal (346–359) figures already
   restrict to `primaryId` with a comment explaining why. Investment cards do the same. Do not
   invent a cross-currency total to make the card look fuller.

Note what is already right and should not be "fixed": picking a primary currency from
`profiles.default_currency_id` with a largest-holding fallback, suppressing the percentage when the
opening balance is under one minor unit, and listing other currencies alongside rather than folding
them in.

---

## 8. Multi-currency polish (D4 = option (a))

1. **`/portfolios` balance sort is the live bug** — confirmed 2026-08-02: sorting by Balance
   ascending puts `Wise Dollar $850.00` between `GCash ₱665.47` and `Tonik ₱1,274.47`.
   `sorting.ts:23` maps `balance → current_balance` and the DB orders on the raw numeric. Fix by
   **grouping the table by currency** and sorting within each group, or by showing per-currency
   subtotals. Do not bolt FX onto the sort.
2. **Every summing surface states its currency** — debts, goals, investments and the dashboard all
   already group; the rule is that no new card may sum across currencies, and any figure that is
   restricted to the primary currency must *say so* on screen rather than only in a code comment.
3. **`currencies.minor_unit` is not the gap.** `formatMoney` and the transfer RPC already round to
   it. Precision is handled; conversion is what's absent, and D4 says it stays absent.

---

## 9. Edge cases

1. **Future-dated snapshot pins `current_value` forever** — the trigger takes the newest
   `as_of_date`. Reject future dates (§4.2). Sharpest edge in the phase.
2. **Second snapshot on the same date** hits `uq_inv_snap_inv_date` → upsert, don't insert.
3. **Deleting a snapshot** re-fires the trigger and correctly falls back to the previous newest —
   this works; the `coalesce(…, i.current_value)` means deleting the *only* snapshot leaves the last
   value standing rather than resetting to invested. Defensible, but say so in the UI.
4. **Double-counting an investment held in an investment-category portfolio** — a user who both
   creates a `category='investment'` portfolio *and* an `investments` row for the same holding sees
   it twice in any combined figure. D2 (never combine) contains this; the UI should also nudge when
   an investment is linked to a portfolio whose category is `investment` and whose balance ≈ the
   invested amount.
5. **Snapshot currency ≠ investment currency** — nothing enforces it (§4.2). Derive it from the
   parent.
6. **`invested_amount = 0`** — `return_pct` is `null` by design (division guard in the view). Render
   "—", not `0%` or `NaN%`.
7. **Negative unrealized gain** is normal, not an error state. Colour it, don't hide it.
8. **`maturity_date` accrues nothing** — like `debts.interest_rate`, it is informational. An MP2
   holding will not grow on its own. Say so, or users will report a bug that isn't one.
9. **`quantity` / `average_cost` are `numeric(28,8)` but cross JS as `Number`** — fine for fiat and
   share counts, lossy at the extremes for large crypto quantities. Same known limit as Phases 1–3.
10. **`portfolio_id` is `on delete set null`** — deleting a linked account silently unlinks the
    investment rather than blocking. Correct, but the UI should not present the link as durable.
11. **Deactivating an investment** removes it from `v_investment_performance` and therefore from
    every dashboard figure. Intended; make the toggle's consequence explicit.
12. **`is_liquid` cannot be overridden per account** — it is generated from category + `is_savings`.
    A user who wants their checking account counted as liquid must flag it as savings, which is
    D3's whole subject. Explain it in the portfolio form rather than changing the column.
13. **Feature gating still isn't enforced on the service path** — §3.2. Documented, not fixed.
14. **`v_investment_performance` needs re-creating for `kind_label`** (§4.3) — easy to forget, and
    the symptom is a column that exists in the table but never reaches the UI.

---

## 10. Suggested split

Three PRs. The third is the one that can break existing behaviour, so it lands last and alone.

**PR 4a — Investments core** ✅ *built 2026-08-03*
1. ✅ `create_investment.sql`, `record_investment_snapshot.sql`, plus `do_investment` /
   `do_investment_snapshot` appended to `authenticated_entry_points.sql` — **still to be run in the
   Supabase SQL editor**, in that order.
2. ✅ Ledger routes `/investments*` **and** the matching `ledger-local.ts` handlers.
3. ✅ `/investments` + `/investments/[id]` pages, forms, actions.
4. ✅ Nav entry.

Four deviations from §4–6 as planned, all deliberate:

- **`investment_kind_label.sql` was folded into `create_investment.sql`** rather than shipped as a
  third file. There is no migration tool — every file is applied by hand in the SQL editor — and the
  label column, its check constraint and the view that has to expose it are one change. Three files
  to run in a required order is three chances to run two of them.
- **The view re-creation grants explicitly.** `drop view` takes its grants with it, including the
  blanket `grant all on all tables` service_role got in `policies.sql` §12b — that applied to the
  tables existing when it ran, not to a view created later. Both grants are restated in the file.
- **`ledger-local.ts`'s PATCH allow-lists columns**, unlike the debts and goals handlers next to it,
  which pass the request body straight into `.update()`. Investments have two columns that must
  never be written by a caller — `current_value` (owned by the snapshot trigger, so a write reverts
  on the next valuation) and the generated `unrealized_gain` (which raises) — and the two transports
  have to accept the same things or a write works on one deploy and not the other.
- **`distinctLabels` in the ledger service now takes values, not rows.** Two columns feed it
  (`incomes.source_label`, `investments.kind_label`), and its web-side twin in `lib/custom-choice.ts`
  already had that signature.

The `is_latest` flag the snapshot RPC returns was not in the plan either. It exists because
back-filling an older date is a legitimate thing to do and produces a confusing result otherwise:
the row saves, and the headline figure correctly does not move. The form says so rather than
looking broken.

**PR 4b — Multi-currency polish** (§8) — independent of 4a; could land first if you want a quick
win. Closes the `/portfolios` sort bug.

**PR 4c — Dashboard liquid/invested split** (§7). Depends on 4a for the invested figure. Touches
numbers people have already looked at, so it wants its own diff and its own before/after check.

---

## 11. Verification

No test suite — lint and typecheck are the gates.

```bash
nvm use 20
cd apps/web && npm run lint && npm run build
cd services/ledger && npm run build
```

Manual checks that actually matter:

- **RLS with two accounts** — user B must not see user A's investments or snapshots.
- **Both transports** — exercise `/investments` with `GATEWAY_URL` set (mesh) and unset (local).
  This is the check PR #8 exists to enforce.
- Create an investment → `current_value = invested_amount`, gain `0`, `return_pct` `0`.
- Post a snapshot above cost → gain and `return_pct` both positive; below cost → both negative.
- Post a second snapshot for **the same date** → updates, does not 500.
- Attempt a future-dated snapshot → clean 400, `current_value` unchanged.
- Type a kind the list doesn't have ("Gold bar") → stored as `other_asset` + `kind_label`, and it
  still aggregates under Other.
- Deactivate an investment → it leaves the dashboard figures.
- Dashboard with one PHP cash account and one USD investment → **no card sums them**.
- `/portfolios` sorted by balance with mixed currencies → no interleaving.

Keep `docs/MAINTENANCE.md` and `docs/DEVELOPER-GUIDE.md` in sync: the new RPCs belong in the "run
these SQL files" list, and the snapshot trigger's newest-wins rule belongs with the other invariants.
Update `docs/DECISIONS-NEEDED.md` when D1–D5 are actually settled — strike them through with the
date, the way #3, #4, #9 and #10 were.
