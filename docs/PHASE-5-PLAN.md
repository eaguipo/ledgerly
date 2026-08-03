# Phase 5 Plan — Reporting, analytics & dashboard

Companion to `docs/ROADMAP.md` Phase 5, written the same way the Phase 3 and Phase 4 plans were:
after auditing what already exists, so this lists only work that is genuinely missing.

**Headline: this is the first phase with no plumbing.** No new tables, no money RPCs, and — the part
that actually changes the size of the job — **no dual-transport work.** Every prior phase since PR #8
had to ship each route twice, once in `services/ledger/src/server.ts` and once in
`apps/web/src/lib/ledger-local.ts`. Reports don't: they are read-only aggregation over views that are
already `security_invoker`, so they read through the RLS-scoped client exactly as `/dashboard` and
`/portfolios` already do. See §3.

What that leaves is a phase that is almost entirely UI, over data the database can already produce.

**One thing must land first — see §4.1.** The parked "Money Invested" item makes the spending figure
this phase reports demonstrably wrong. Phase 5 is precisely the phase that surfaces it.

---

## 1. Decisions — **PROPOSED**

`docs/DECISIONS-NEEDED.md` is closed; every entry has an answer. These are design choices this phase
forces instead, recorded here in the same shape so the reasoning survives.

| # | Question | Recommendation | If you decide otherwise |
|---|----------|----------------|-------------------------|
| **D1** | Where does report data come from — direct Supabase reads, or ledger routes? | **Direct reads through the RLS client.** The views are `security_invoker`, so RLS scopes them; `/dashboard` and `/portfolios` already read this way. | Every report query gets written twice (mesh + local) for data that never mutates anything. That is the tax PR #8 imposed on *writes*; paying it on reads buys nothing. |
| **D2** | Charts: hand-rolled SVG, or add Recharts? | **Keep hand-rolling.** `apps/web` has *zero* runtime dependencies beyond `next`, `react` and the Supabase SDKs, and already ships two accessible SVG charts. `AllocationBars` is *already* the spending-by-category chart. | Recharts is the first UI dependency in the project and pulls in D3. The roadmap suggested it, but it was written before `TrendChart` and `AllocationBars` existed — they set the precedent, and both are keyboard-navigable in a way most chart libs are not by default. |
| **D3** | Multi-currency in a report | **One currency per report**, picked at the top, defaulting to the profile's default. | Repeating every figure per currency turns a report into a matrix. Phase 4 settled that currencies are never summed; scoping the whole report is the cleanest expression of that, and the picker makes the scope explicit rather than implied. |
| **D4** | What does CSV export contain? | **The in-range transaction list**, one row per transaction. | Exporting the summaries gives you six numbers you can already read on screen. The transaction list is the thing people actually want in a spreadsheet. |
| **D5** | Do investments appear in the report? | **As a summary section only**, never in inflow/outflow. | A valuation is not cash. Folding an unrealised gain into "total inflow" would repeat the exact error the Phase 4 dashboard fix removed. |

---

## 2. What already exists (verify, do not rebuild)

The roadmap line *"do aggregation in Postgres views/RPC (already provided)"* is largely true. Seven
views exist, all `security_invoker = true`:

| View | Gives you | Phase 5 use |
|------|-----------|-------------|
| `v_cashflow` | per `(currency, txn_date, direction)` totals | **the date-range report's core** — inflow, outflow, net |
| `v_expense_by_category` | per `(category, txn_date, currency)` totals | spending-by-category chart + breakdown |
| `v_liquid_by_currency` | liquid totals per currency | summary card |
| `v_portfolio_balances` | per-account balance + `is_liquid` | per-portfolio summary |
| `v_debt_outstanding` | outstanding per debt, non-archived | remaining-debt summary |
| `v_completed_goals` | ever-achieved goals | completed-goals summary |
| `v_investment_performance` | invested / current / `return_pct` | investments summary (D5) |

Two exclusions are **already handled in the views** and must not be re-implemented in the app:

- **Debt origination is excluded from `v_cashflow`** ([cashflow_excludes_debt_origination.sql](../db/functions/cashflow_excludes_debt_origination.sql)) — borrowing is not earning, lending is not spending.
- **Transfers were never included**: `v_cashflow`'s `kind in (…)` list omits `transfer_in`/`transfer_out` entirely, so moving your own money between accounts cannot inflate either side.

Debt *payments* are deliberately counted. Rule 14 makes that ledger row the single source of truth
for money actually leaving.

Reusable UI: `AllocationBars` (part-to-whole bars, already labelled and screen-readable),
`TrendChart` (one series over days, keyboard-navigable, `label` prop added in Phase 4), `Table` /
`SortableTh`, and the `?sort=&dir=` URL-state pattern from `/portfolios` — which is exactly the right
pattern for `?from=&to=&currency=`.

---

## 3. Why there are no ledger routes

Worth stating plainly, because every phase since Phase 2 has needed both transports and skipping it
will look like an oversight.

`ledgerFetch` exists because **writes** need one implementation of the money rules reachable from two
deployments. Reports write nothing. They read views that already carry `security_invoker = true`,
which means the querying user's RLS policies apply — the same boundary `/dashboard` relies on when it
reads `portfolios` and `v_investment_performance` directly.

So: `supabase.from("v_cashflow").select(…)` in a Server Component. No gateway, no ledger service, no
`ledger-local.ts` mirror, no `x-internal-secret`. If a report ever needs to *write* (a saved report,
a scheduled export), that changes — but nothing in Phase 5 does.

---

## 4. The traps

### 4.1 The spending figure is wrong until "Money Invested" is fixed — **do this first**

Buying an investment moves no cash (Phase 4, decision D1), so the only way to record the money
leaving your account today is a plain expense. That expense lands in `v_cashflow` as outflow and in
`v_expense_by_category` as spending.

**Phase 5 is the phase that makes this visible.** A date-range report will tell you that you spent
₱50,000 last month when you actually bought gold — you converted an asset, you did not consume
anything. Every headline this phase produces inherits the error.

The fix is parked and specified: an optional funding account on the investment form posting against a
self-healed `Money Invested` category, excluded from both views exactly as debt origination already
is. **Land it before the reports, not after** — otherwise the first thing the reports do is make a
known-wrong number look authoritative.

### 4.2 Never sum across currencies

Settled in Phase 4 (decision #5) and enforced everywhere else in the app. D3 handles it by scoping
the whole report to one currency. The trap is the *transaction list*: it is easy to render every
in-range row regardless of currency and then put a total under it. Filter the list by the report's
currency too.

### 4.3 Vercel Hobby's ~10s function timeout, and unbounded ranges

`v_cashflow` is pre-aggregated per day, so even a five-year range is a few thousand rows — fine. The
**transaction list is not aggregated** and is the one query that can run away: "all of 2024" on a
busy account is unbounded.

Use the pattern the dashboard already established at `TREND_ROW_LIMIT`: cap it, detect when the cap
was hit, and say so rather than silently truncating. A report that quietly omits rows is worse than
one that refuses.

### 4.4 The dashboard's "Allocation" is not spending-by-category

Existing `AllocationBars` on `/dashboard` shows **portfolio category** (cash / bank / crypto), i.e.
where your money *sits*. The roadmap's "spending by category" is **expense category** (groceries /
transport), i.e. where it *went*. Different data, same component — reuse the component, do not reuse
the query.

### 4.5 `income_source` is a closed enum for a reason

[schema.sql:287](../db/schema.sql#L287) notes that reporting groups by `source` and it must not grow
unknown members. A typed-in source is stored as `other` + `source_label`. An income-by-source
breakdown must group by the enum and show labels only within `other`, or the grouping fragments.

---

## 5. SQL to write

Almost none. One genuine gap:

### 5.1 `v_income_by_source.sql`

`v_expense_by_category` has no income-side counterpart, so "where did the money come from" cannot be
answered without aggregating in JS.

```
v_income_by_source: (user_id, source, source_label, txn_date, currency_code, total)
```

Mirrors `v_expense_by_category`'s shape. Must carry the **same `loan_received` exclusion `v_cashflow`
has** — borrowed money is not income — or the two views will disagree about the same month.
`security_invoker = true`, and mirrored into `schema.sql` §19 like every other view redefinition.

### 5.2 A report RPC — **not yet**

A single `report_summary(_from, _to, _currency)` returning one JSON blob would collapse six queries
into one round trip. Worth it only if the parallel reads prove slow; `Promise.all` over six
pre-aggregated views is the same pattern `/dashboard` already runs comfortably. Start without it.

---

## 6. Web UI

### `/reports`

State lives in the URL (`?from=&to=&currency=`) exactly like `/portfolios`' sort — so a report
survives reload, back/forward, and being shared or bookmarked. Default to the current month.

- **Range + currency controls.** Presets (this month / last month / this year / custom) alongside the
  two date inputs, because the common cases shouldn't require picking two dates.
- **Headline row** — total inflow, total outflow, net. Per D3 these are one currency, and the card
  says which.
- **Where it went** — `AllocationBars` over `v_expense_by_category`, filtered to the range.
- **Where it came from** — the same component over the new `v_income_by_source` (§5.1).
- **Inflow vs outflow over time** — a new grouped-bar component; see §7.
- **Summaries** — liquid by currency, per-portfolio balances, remaining debt + payments made in the
  period, completed goals, investments (D5). Each is a small card over an existing view.
- **Transactions in range** — the detail table, capped per §4.3, with the CSV button.

### Dashboard additions

The roadmap asks for headline cards and 1–2 charts. Phase 4 already delivered the cards (Liquid,
Beyond spendable cash, Debts, Goals) and the trend chart. What is missing is **spending by expense
category for the current month** — §4.4's distinction — and a link through to `/reports`.

### Nav

Add Reports to `NAV_ITEMS` in `components/shell/nav-items.tsx`. Inline stroke icon, no icon package.

---

## 7. Charts (D2)

- **Spending by category / income by source** — `AllocationBars`, unchanged. It already sorts
  descending, labels each row with amount and share, and needs no colour channel.
- **Inflow vs outflow over time** — the one new component. Two series over the same day axis, so
  `TrendChart`'s single-path approach doesn't fit. Grouped bars rather than two lines: the comparison
  is per-period totals, not a continuous quantity, and bars make "this month I earned more than I
  spent" readable at a glance.

  Follow `TrendChart`'s accessibility contract: `role="group"` rather than `role="img"` (so the
  readout stays in the tree), a focusable container, arrow-key navigation, and every value reachable
  as text without hovering.

  Bucket by week or month for long ranges — 365 daily bar pairs is unreadable and slow to render.

---

## 8. CSV export (D4)

A Next route handler at `/reports/export` taking the same `from`/`to`/`currency` params, returning
`text/csv` with `Content-Disposition: attachment`.

**Read `node_modules/next/dist/docs/` before writing it** — `apps/web/AGENTS.md` requires it, and
route-handler conventions are exactly the kind of thing that differs from training data in Next 16.

Three things that make a CSV actually usable, all easy to get wrong:

1. **Escape properly.** A merchant named `Bag, The` or a note containing a quote or newline breaks
   naive `join(",")`. Quote every field and double interior quotes.
2. **Dates as `YYYY-MM-DD`**, not localised — spreadsheets guess otherwise, and guess differently by
   locale.
3. **One currency per file** (D3), with the code in a column *and* in the filename. A CSV that mixes
   currencies in an `amount` column is the same lie in a different container.

Reuse the same capped query as the on-screen list, and if the cap was hit, say so — a silently
truncated export is a corrupted record.

---

## 9. Edge cases

1. **`to` before `from`** — swap them, or reject with a clear message. Do not return an empty report
   that looks like "no activity".
2. **A range with no activity** — a real empty state, distinguishable from a failed query. The
   dashboard's `dashboard.load.empty` logging exists for exactly this reason.
3. **Future date ranges** — allowed but always empty; say so rather than rendering zeros.
4. **A currency the user holds no account in** — the picker should only offer currencies with data.
5. **Archived accounts** — their transactions are still real history. Include them in a *past* range
   and label them, rather than silently dropping rows and making an old month not reconcile.
6. **Voided transactions** — `is_void = false` is already in every view; any hand-written query must
   repeat it.
7. **Same-day transfers** — excluded by the view's kind list (§2). Do not "fix" their absence.
8. **Debt payments** count as outflow, deliberately (Rule 14).
9. **A debt disbursement** does not (§2). Both are already correct in the view — the trap is
   re-deriving either in JS.
10. **Investment valuations never appear as cash** (D5).
11. **`other` income with a `source_label`** — §4.5. Group by enum, show labels within `other`.
12. **Timezone** — `txn_date` is a `date`, and every comparison is string-on-string `YYYY-MM-DD`
    (`isPastDue`, `hasMatured` already do this). Do not introduce `new Date()` comparisons; "today"
    differs between the server's UTC and the user's local day.
13. **Rounding** — sum in Postgres, not JS, and respect `currencies.minor_unit` on display.
    `roundToMinorUnit` in the dashboard exists because float residue from `numeric(38,18)` is
    invisible in a formatted figure and catastrophic as a divisor.
14. **Row cap hit** — §4.3, on screen *and* in the export.

---

## 10. Suggested split

**PR 5a — "Money Invested" first** (§4.1) ✅ *built 2026-08-03*. Not nominally Phase 5, but Phase 5 is
what makes it matter. SQL applied and verified.

**PR 5b — The date-range report** ✅ *built 2026-08-03*. `v_income_by_source.sql`, `/reports` with
URL-driven range and currency, headline figures, the two `AllocationBars` breakdowns, summaries, and
the capped transaction list.

**PR 5c — Charts + CSV** ✅ *built 2026-08-03*. `FlowBars`, the dashboard's spending-by-category card,
and `/reports/export`.

### Deviations from §6–8 as planned

- **The transaction list shows every in-range row and badges the ones the totals exclude**, rather
  than listing only counted rows. Showing only counted rows would reconcile perfectly but hide real
  movements — a transfer you made would simply be absent with no explanation. The badge says *why*
  the list doesn't sum to the headline.
- **`rows.ts` was extracted**, which the plan didn't call for. `isCounted`, `rowLabel` and the
  transaction select are shared by the page and the CSV export, because an export that labelled rows
  differently from the screen — or disagreed about which rows count — is a quietly corrupted record
  of the same range.
- **The export cap is 5000 against the screen's 500.** On screen a cap is a readability choice; in an
  export it is data loss, so the ceiling exists only for the function timeout.
- **The CSV carries a UTF-8 BOM.** Without it Excel on Windows reads the system codepage and renders
  ₱ as mojibake. Written as `"\uFEFF"`, never a literal character, so a formatter can't silently
  drop it.
- **Bucketing lives in `buckets.ts`** and runs server-side, so `FlowBars` never sees a currency or a
  date — only pre-formatted labels.

### Caught in review, after the feature "worked"

Two cross-currency bugs of exactly the kind Phase 4 existed to remove, both introduced by this phase
and both invisible in a single-currency account:

- **`debt_payments` had no currency filter.** The table carries no currency column, so "paid in
  range" summed pesos and dollars and printed the result with one symbol. Fixed with an `!inner`
  join to `debts` on `currency_id`.
- **The Accounts card's "of it liquid" figure summed every currency** while labelled with one. The
  correctly-scoped variable existed three lines away and the wrong one was used.

Neither would have failed a build, a lint, or a click-through in a single-currency account. Worth
remembering the next time a report figure "looks about right".

---

## 11. Verification

No test suite — lint and typecheck are the gates.

```bash
nvm use 20
cd apps/web && npm run lint && npm run build
```

Manual checks that actually matter:

- **RLS with two accounts** — user B's transactions must never appear in user A's report. The views
  are `security_invoker`, so this is the check that proves it.
- A month with a **transfer** in it → net is unchanged by the transfer.
- A month with a **debt disbursement** → inflow does not include the borrowed money.
- A month with a **debt payment** → outflow does include it.
- **Inflow − outflow = net**, reconciled by hand against the transaction list for one small month.
- The same range in two currencies → two separate reports, no figure shared between them.
- **CSV opens in a spreadsheet** with dates intact and a comma-containing merchant on one row.
- A range with no activity, and a range whose row cap is hit → both say so plainly.

Keep `docs/MAINTENANCE.md` and `docs/DEVELOPER-GUIDE.md` in sync: `v_income_by_source` belongs in the
views list and in the "run these SQL files" order.
