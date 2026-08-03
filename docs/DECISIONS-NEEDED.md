# Decisions Needed

These are product choices the requirements doc didn't pin down. The schema picked a sensible
default for each (noted below) so you're not blocked — but your answers change how some features
behave. None of these block Phase 0/1; revisit before the phase that touches them.

| # | Question | Schema's current default | Affects |
|---|----------|--------------------------|---------|
| 1 | ~~**Admin visibility of finances**~~ — **DECIDED 2026-08-03**, *reversing the schema's privacy-first default*: an Admin **may read** other users' transactions and balances, read-only; writes stay owner-only. Paired with #8, every cross-tenant read must leave an audit trail, which is why this is implemented as explicit audited RPCs rather than by widening the RLS `SELECT` policies. Note it only works on the RLS path — ledger-service filters by the gateway's `x-user-id` and cannot serve an admin. | (default **overridden**) | Phase 1 (roles) |
| 2 | ~~**"Bank savings" for liquid money (Rule 16)**~~ — **DECIDED 2026-08-03**: kept as `is_liquid = cash OR (bank AND is_savings)`. It is a *stored generated* column with `v_liquid_by_currency` on top and no migration tool, so changing the rule means hand-dropping and re-adding both. A current account not counting as liquid is explained in the UI instead. | (schema default kept) | Phase 4 ✅ |
| 3 | ~~**Debt payment double-counting**~~ — **DECIDED 2026-08-02**: one debt-payment ledger row is the single source of truth; never also log it as a separate expense. The Debts page owns tracked debts; the Income page's `debt_payment_received` source stays for informal money that was never tracked as a debt. | (schema default kept) | Phase 3 ✅ |
| 4 | ~~**Goal contributions vs real money**~~ — **DECIDED 2026-08-02**: contributions are an earmark; they never move real cash. Moving money to savings is a Transfer. | (schema default kept) | Phase 3 ✅ |
| 5 | ~~**Cross-currency**~~ — **DECIDED 2026-08-03**: per-currency totals only, no FX. Currencies are never summed, and never *ordered* against each other either — `/portfolios` groups into a table each, and the dashboard reports one primary currency with the rest listed separately. | (schema default kept) | Phase 4 ✅ |
| 6 | ~~**Opening balances**~~ — **DECIDED 2026-08-03**: the `opening_balance` ledger row, which is what Phase 1 already built. `portfolios.opening_balance` is kept as a written-once historical note and is **not authoritative** — nothing reads it, and `reconcile_portfolio_balances()` derives the balance from transactions alone. Never sum it into anything. | (schema default kept) | Phase 1 ✅ |
| 7 | ~~**Investments → net worth**~~ — **DECIDED 2026-08-03**, then **half-revised 2026-08-03**. *Net worth:* unchanged — an investment's value is reported on its own card and never folded into the headline, which is why the dashboard hero became *Liquid*. *Buying:* **reversed.** Record-only made the funding account permanently overstated, and the only fix — a plain expense — made buying an asset read as spending, which Phase 5's reports would have made authoritative. A paying account now posts a real outflow, excluded from `v_cashflow` and `v_expense_by_category` exactly as lending is (`db/functions/money_invested.sql`). Blank stays record-only, matching #9's optional disbursement. | (default kept, then buying reversed) | Phase 4 ✅ / 5a ✅ |
| 8 | ~~**Role hardening**~~ — **DECIDED 2026-08-03**: keep `profiles.role` + `profiles_guard_role()`; **no JWT mirroring**. A mirrored claim goes stale until the token refreshes, so a demoted admin would keep access for up to an hour — unacceptable once #1 makes the role a key to everyone's finances. The performance argument for mirroring doesn't apply either: `is_admin()` is `stable` and argument-free, so it evaluates once per statement. The hardening effort goes to auditing admin reads instead. | (schema default kept, scope changed) | Phase 1 ✅ |
| 9 | ~~**Debt origination**~~ — when you record a debt, should the cash movement be posted too? The schema had no answer: `debts` has a principal but no disbursement link. **DECIDED 2026-08-02**: *optional* linked disbursement. A funding account on the debt form posts an `income` row (payable) or `expense` row (receivable) linked via the existing `incomes.debt_id` / `expenses.debt_id`; blank means record-only. Adds a `loan_received` income source. | (new — no prior default) | Phase 3 ✅ |
| 10 | ~~**Debt payment interest split**~~ — expose it in the UI or treat every payment as pure principal? **DECIDED 2026-08-02**: optional interest field defaulting to 0; outstanding drops by principal only, so interest-only payments correctly leave the balance alone. | (schema already supports the split) | Phase 3 ✅ |

**You don't need to answer all of these now.** **#3, #4, #9 and #10** — how debts and goals interact
with real cash — were settled on 2026-08-02 ahead of Phase 3; see
[`docs/PHASE-3-PLAN.md`](./PHASE-3-PLAN.md) §1. Of what's left, **#1** (admin scope) is the most
impactful; the rest can wait until their phase.

**#2, #5 and #7 were settled on 2026-08-03** as Phase 4 was built; see
[`docs/PHASE-4-PLAN.md`](./PHASE-4-PLAN.md) §1, which records them as D1–D5 along with what deciding
the other way would have cost. All three kept the schema's default. The one addition was **D5**:
custom asset types (gold, vehicles) reuse the `other_asset` + label pattern rather than getting
their own tables.

**#1, #6 and #8 were settled on 2026-08-03, closing the list.** Every question in this file now has
an answer. #6 and #8 confirmed what was already built; **#1 is the only entry that ever overrode the
schema's default**, and it is the one with work still outstanding.

**#1 and #8 have to be built together, and that constrains the design.** Widening the RLS `SELECT`
policies — the obvious way to give an admin read access — provides no hook to record that a read
happened, because Postgres has no `SELECT` trigger and a policy expression cannot have side effects.
So cross-tenant admin reads go through explicit `security definer` RPCs that write an `audit_log`
row and then return the data. That is narrower than blanket policies (an admin reads what the RPCs
expose, nothing more) and it is the only shape that satisfies both decisions at once.

Until an admin UI exists, none of this is reachable: `profiles.role` defaults everyone to `user`,
nothing in the app ever sets it, and there is no admin route. See ROADMAP "out of scope for v1".
