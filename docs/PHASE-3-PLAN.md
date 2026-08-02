# Phase 3 Plan — Debts (payable + receivable) + Goals

Companion to `docs/ROADMAP.md` Phase 3. Written after auditing what the schema already provides,
so this plan only lists work that is genuinely missing.

**Headline:** the data model is already done. `debts`, `debt_payments`, `goals`,
`goal_contributions` exist with their triggers, RLS policies and views. Phase 3 is ~90% service-role
RPCs + ledger routes + UI, plus a handful of guards the original `auth.uid()`-era functions never
needed.

---

## 1. Decisions (settled 2026-08-02)

| # | Question | Decision |
|---|----------|----------|
| D1 | Does creating a debt move real cash? | **Optional linked disbursement.** The debt form has an optional "cash received into / paid out of" account picker. Set → posts a linked ledger row. Blank → record-only, for debts that predate the app. |
| D2 | Do goal contributions move real money? | **No — earmark only** (confirms DECISIONS-NEEDED #4). Goals are a tracker over existing balances. Moving money to savings is already Transfers. |
| D3 | Debt repayment vs the Income page | **Debts page owns tracked debts** (confirms DECISIONS-NEEDED #3). Income's `debt_payment_received` source stays for untracked, informal money, with a hint linking to Debts. |
| D4 | Principal/interest split | **Optional interest field**, defaulting to 0. The DB already enforces `principal + interest = amount` and reduces outstanding by principal only. |

---

## 2. What already exists (verify, do not rebuild)

| Object | Where | Note |
|--------|-------|------|
| `debts`, `debt_payments` | `db/schema.sql` §8, §10 | statuses `open / partially_paid / settled / written_off` |
| `goals`, `goal_contributions` | `db/schema.sql` §11 | `first_achieved_at` stamped once and never cleared |
| `recompute_debt_balance()` | §15c | `outstanding = greatest(principal − Σ principal_portion, 0)`; `written_off` is sticky |
| `refresh_goal_status()` | §15d | auto-achieve on `current ≥ target`; demote clears `achieved_at` but keeps `first_achieved_at` |
| `apply_goal_contribution()` | §15e | `current_amount = greatest(Σ contributions, 0)` |
| RLS on all four tables | `db/policies.sql` §7, §8 | writes gated on `has_feature('debts')` / `has_feature('goals')`, both default-enabled |
| `v_debt_outstanding`, `v_completed_goals` | §19 | `security_invoker = true` |
| Audit triggers | §15g | `debts`, `debt_payments`, `goals` already wired |
| Gateway proxy | `services/api-gateway` | generic `app.all("/ledger/*")` — **no gateway changes needed** |

The roadmap line *"Apply RLS to every new table (don't forget)"* is already satisfied — this phase
adds no new tables.

---

## 3. The trap to avoid first

`do_debt_payment()` (schema §16b) derives identity from `auth.uid()` and is granted to
`authenticated`. **It cannot be called from ledger-service**, which holds the service-role key where
`auth.uid()` is NULL — every `where user_id = auth.uid()` lookup misses and it fails with
*"Debt not found or not owned by you"* no matter what you pass.

This is the identical trap Phase 2 hit with `do_transfer()` (see MAINTENANCE §5.6). The fix is the
same: a `create_debt_payment(_user_id, …)` port granted to `service_role` only. Keep the two in sync
until `do_debt_payment()` is retired.

Consequence carried forward: like `create_expense` / `create_income` / `create_transfer`, the new
RPCs **cannot consult `has_feature()`** (also `auth.uid()`-based). Feature gating stays on the RLS
path only. Closing that gap later means having ledger-service read `user_feature_access` explicitly
— out of scope for Phase 3, but it is a known hole, not an oversight.

---

## 4. SQL to write (`db/functions/`)

### 4.1 `create_debt.sql`

```
create_debt(_user_id, _kind, _counterparty, _principal, _currency_id,
            _interest_rate, _due_date, _note,
            _disbursement_portfolio default null, _disbursement_date default current_date)
  returns jsonb  -- { debt_id, transaction_id }
```

- Inserts the debt with `outstanding_balance = principal`.
- **Guard `_principal > 0`.** The table constraint only says `>= 0`, and a zero-principal debt is
  born `open` with nothing outstanding — a state the recompute trigger can never reconcile because
  it only fires on `debt_payments`.
- If `_disbursement_portfolio` is set (D1):
  - **payable** → cash came *to* us: `transactions(kind='income', direction='inflow')` +
    `incomes(debt_id = new debt, source = 'loan_received')`.
  - **receivable** → cash left us: `transactions(kind='expense', direction='outflow')` +
    `expenses(debt_id = new debt, category_id = …)`, self-healing a `Money Lent` system category the
    same way `create_transfer` self-heals `Transfer Fee`.
  - Guards: portfolio owned + not archived; **portfolio currency must equal debt currency**;
    for receivable, the overdraft guard (`allow_negative` respected), all under `for update`.
- `incomes.debt_id` / `expenses.debt_id` are the only debt→ledger links the schema offers, which is
  why the disbursement must be an `income`/`expense` kind rather than an `adjustment`.
- Widens the enum: `alter type public.income_source add value if not exists 'loan_received'`, using
  the STEP 1 / STEP 2 file split `create_income.sql` established.

### 4.2 `create_debt_payment.sql`

Service-role port of `do_debt_payment()`, plus guards the original silently skips:

| Guard | Why |
|-------|-----|
| `principal_portion > outstanding_balance` → reject | Today `greatest(…, 0)` absorbs the overpayment and flips the debt to `settled` — money leaves the account and simply vanishes from the debt's arithmetic. |
| `status = 'settled'` → reject | Otherwise a stray payment moves cash against a closed debt. |
| `is_archived` → reject, "unarchive to record a payment" | |
| `status = 'written_off'` → **allow** | A recovered write-off is real. The trigger already keeps the status sticky; the UI shows a "recovered" badge. |
| currency mismatch, archived/foreign portfolio, insufficient funds | Ported from the original. |

Returns richer JSON than the original's bare uuid — `{ payment_id, transaction_id,
outstanding_after, status_after }` — so the UI can say "settled!" without a re-fetch.

The `select … for update` on the debt row is load-bearing: two tabs paying off the last ₱1,000
serialise, and the second one hits the new overpayment guard instead of double-spending.

### 4.3 `create_goal_contribution.sql`

```
create_goal_contribution(_user_id, _goal_id, _amount, _contributed_on, _note)
  returns jsonb  -- { contribution_id, current_amount, target_amount, status, just_achieved }
```

- `_amount` may be negative (a withdrawal) — `goal_contrib_nonzero` is the only table constraint.
- **Guard withdrawal ≤ `current_amount`.** Same class of bug as debt overpayment: `greatest(Σ, 0)`
  clamps `current_amount` at zero while the contribution sum goes negative, and the two silently
  diverge forever.
- Reject contributions to `archived` / `cancelled` goals — `refresh_goal_status` declines to promote
  them but `current_amount` still moves, leaving a cancelled goal quietly filling up.
- `transaction_id` stays NULL (D2 — earmark, no money moves).

### 4.4 `debt_principal_recompute.sql`

`recompute_debt_balance()` fires only on `debt_payments`. Editing `debts.principal_amount` after
payments exist leaves `outstanding_balance` stale. Add:

```sql
create trigger trg_debt_principal_recompute
  after update of principal_amount on public.debts
  for each row when (old.principal_amount is distinct from new.principal_amount)
  execute function public.recompute_debt_balance();
```

The `when` clause is what stops recursion — the recompute's own `update debts` leaves
`principal_amount` unchanged, so the trigger does not re-fire.

`refresh_goal_status()` needs no equivalent: it is already `before insert or update on goals`, so
editing a target re-evaluates achievement correctly.

---

## 5. Ledger service routes (`services/ledger/src/server.ts`)

Follow the existing shape exactly: `userIdOf()` → validate → RPC or filtered query → `dbErrorFields`
logging → 400 for guard failures, 500 for infrastructure.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/debts` | filters `kind`, `status`, `include_archived`; embeds currency |
| GET | `/debts/options` | active portfolios (id, name, balance, currency) + currencies |
| GET | `/debts/:id` | debt + payment history |
| POST | `/debts` | → `create_debt` |
| PATCH | `/debts/:id` | counterparty, due_date, interest_rate, note, principal_amount, `written_off`, `is_archived` |
| POST | `/debts/:id/payments` | → `create_debt_payment` |
| GET | `/goals` | includes progress; `include_archived` flag |
| GET | `/goals/options` | currencies + active portfolios for `linked_portfolio_id` |
| POST | `/goals` | plain insert (no money moves) — validate goal currency == linked portfolio currency |
| PATCH | `/goals/:id` | name, target_amount, target_date, status (archive/cancel) |
| POST | `/goals/:id/contributions` | → `create_goal_contribution` |
| DELETE | `/goals/:id` | **only when zero contributions**; otherwise 409 → archive instead |

**No `DELETE /debts/:id`.** `debts → debt_payments` is `on delete cascade`, and
`debt_payments.transaction_id` is `on delete restrict` on the *transactions* side — so deleting a
debt cascades its payment rows away and leaves orphaned ledger transactions that already moved real
money. Archive only.

Every route filters `.eq("user_id", userId)` explicitly — service-role bypasses RLS.

---

## 6. Web UI (`apps/web/src/app/(app)/`)

Mirror `transfers/` — server page fetches via `gatewayFetch`, form is a client component driven by a
Server Action, success returns a new id that doubles as the form reset key.

- **`/debts`** — summary cards (owed by you / owed to you, **grouped by currency**, overdue count),
  Payable / Receivable split, new-debt form with the optional disbursement picker, per-row
  "Record payment".
- **`/debts/[id]`** — header, paid-vs-principal progress, payment history, payment form (amount +
  optional interest, source account, date), edit / write-off / archive.
- **`/goals`** — goal cards with progress bars, new-goal form, contribute / withdraw.
- **Nav** — add Debts and Goals to `NAV_ITEMS` in `components/shell/nav-items.tsx` (inline stroke
  icons, no icon package).
- **Dashboard** — a "Total debt" card (payable outstanding by currency) and an active-goals summary.
- **Income form** — per D3, add a hint under the `debt payment received` source linking to `/debts`.

Revalidate after mutations: `/debts` or `/goals`, plus `/portfolios` and `/dashboard` whenever a
balance moved, plus `/income` (payable disbursement) or `/expenses` (receivable disbursement, and
the `Money Lent` category).

---

## 7. Edge cases

### Debts

1. **`do_debt_payment()` is unusable from ledger-service** — §3. Do this first or everything 500s.
2. **Overpayment** silently settles the debt and swallows the excess → reject; offer a
   "pay exact remaining" shortcut in the form.
3. **Payment against a settled debt** → reject.
4. **Payment against an archived debt** → reject with an actionable message.
5. **Payment against a written-off debt** → allowed (recovery); status stays `written_off`.
6. **Currency mismatch** — `trg_txn_currency` (BR17) would raise anyway, but pre-check for a decent
   message, and filter the account picker to matching-currency accounts.
7. **Insufficient funds** on a payable payment → 400 carrying the DB's own message, unless the
   source account has `allow_negative`.
8. **Receivable collection** is an inflow — no overdraft guard, correctly.
9. **Editing `principal_amount` after payments** leaves `outstanding_balance` stale → §4.4 trigger.
10. **Hard-deleting a debt** orphans money-moving transactions → archive only (§5).
11. **Zero-principal debt** is born `open` with nothing outstanding → guard `principal > 0`.
12. **Concurrent payments** from two tabs → `for update` serialises; the loser hits the overpayment
    guard.
13. **Overdue** is not a status — compute in the UI: `status not in ('settled','written_off') and
    due_date < today`. Do not add an enum value.
14. **No due date** — nullable. Sort overdue first, undated last.
15. **`interest_rate` accrues nothing.** It is informational; say so in the UI or users will expect
    balances to grow on their own.
16. **`principal + interest ≠ amount`** — DB constraint plus an RPC guard; the form derives
    `principal = amount − interest` so it cannot be entered wrong.
17. **Future-dated payment** — the balance moves *now* regardless of `payment_date`. Default to
    today and warn on future dates.
18. **Archived portfolio as payment source** → rejected by the RPC; filter it out of the picker.
19. **Debt in a currency you hold no account in** — the payment form has no valid source. Show a
    real empty state, not an empty dropdown.
20. **Income-page double count** — D3. Only the Debts page decrements a tracked debt.
21. **Feature gating is not enforced on the service path** — `has_feature()` is `auth.uid()`-based;
    service-role bypasses RLS. Carried forward from Phases 1–2, documented not fixed.
22. **Borrowed money is not income.** A payable disbursement posts an `income` row, so a naive
    "total inflow" overstates earnings. Phase 5 reports must exclude `incomes.source =
    'loan_received'` and debt-linked expenses from headline income/spending. Net worth is unaffected
    (cash +10k, debt +10k).
23. **Precision** — money is `numeric(38,18)` server-side but crosses JS as `Number`. Fine for
    fiat; only a concern for very large crypto amounts. Consistent with Phases 1–2.

### Goals

1. **Withdrawal exceeding `current_amount`** clamps at zero while the sum goes negative → reject.
2. **Contribution to an archived/cancelled goal** still moves `current_amount` → reject.
3. **Lowering the target below current** auto-achieves the goal. Correct, but confirm in the UI so
   it doesn't look like a bug.
4. **Raising the target on an achieved goal** demotes to `active` and clears `achieved_at` while
   keeping `first_achieved_at`. Correct by design.
5. **`target_amount <= 0`** — table constraint; validate early for a better message.
6. **Goal currency vs `linked_portfolio_id` currency** — nothing in the schema enforces a match.
   Validate in the route; a PHP goal linked to a USD account is meaningless.
7. **Earmarks can exceed real money** — inherent to D2. You can earmark ₱100k while holding ₱20k.
   Show an advisory when total earmarked > liquid total; do not block.
8. **Several goals on one linked portfolio** — allowed, same advisory.
9. **Deleting a goal with contributions** loses history → archive by default, delete only at zero
   contributions.
10. **`target_date` passed but unachieved** — no status for it. UI badge only.
11. **`first_achieved_at` is never cleared**, so `v_completed_goals` keeps ever-achieved goals
    forever. Label "achieved once" separately from "currently achieved".
12. **Future-dated contribution** counts immediately — the trigger sums all rows regardless of date.
    Default to today.
13. **Currency** — group goal totals by currency, never sum across (consistent with Phase 4).

---

## 8. Suggested split

Two PRs; debts is roughly three times the work.

**PR 3a — Debts** ✅ *built 2026-08-02*
1. ✅ `create_debt.sql` (+ `loan_received` enum), `create_debt_payment.sql`,
   `debt_principal_recompute.sql` — **still to be run in the Supabase SQL editor.**
2. ✅ Ledger routes `/debts*` (list, options, detail, create, patch, payments).
3. ✅ `/debts` + `/debts/[id]` pages, forms, actions.
4. ✅ Nav entry, dashboard debt card, income-form hint.

One addition beyond the plan: `recompute_debt(uuid)` is also called directly by the ledger after an
un-write-off, so a debt that was half paid before being written off comes back as `partially_paid`
rather than `open`.

**PR 3b — Goals**
1. `create_goal_contribution.sql`.
2. Ledger routes `/goals*`.
3. `/goals` page, forms, actions.
4. Nav entry, dashboard goals summary.

## 9. Verification

No test suite — lint and typecheck are the gates.

```bash
nvm use 20
cd apps/web && npm run lint && npm run build
cd services/ledger && npm run build
```

Manual checks that actually matter:

- **RLS with two accounts** — user B must not see user A's debts or goals.
- Pay a debt down to exactly zero → status `settled`, outstanding `0`.
- Attempt an overpayment → clean 400, no cash moved.
- Interest-only payment → cash out, outstanding unchanged.
- Create a payable with a disbursement → portfolio balance rises, income row carries `debt_id`.
- Contribute past a goal's target → `achieved`; withdraw below → back to `active`, still listed in
  `v_completed_goals`.
- Edit a debt's principal after paying → outstanding recomputes.

Keep `docs/MAINTENANCE.md` and `docs/DEVELOPER-GUIDE.md` in sync — the new RPCs belong in the
"run these SQL files" list, and the `do_debt_payment()` vs `create_debt_payment()` split belongs
next to the existing `do_transfer()` note (§5.6).
