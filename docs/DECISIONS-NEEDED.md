# Decisions Needed

These are product choices the requirements doc didn't pin down. The schema picked a sensible
default for each (noted below) so you're not blocked — but your answers change how some features
behave. None of these block Phase 0/1; revisit before the phase that touches them.

| # | Question | Schema's current default | Affects |
|---|----------|--------------------------|---------|
| 1 | **Admin visibility of finances** — should an Admin be able to view *other users'* transactions/balances, or only manage accounts/features? | Admin manages users + features only; **cannot** read others' financial data (privacy-first). | Phase 1 (roles) |
| 2 | ~~**"Bank savings" for liquid money (Rule 16)**~~ — **DECIDED 2026-08-03**: kept as `is_liquid = cash OR (bank AND is_savings)`. It is a *stored generated* column with `v_liquid_by_currency` on top and no migration tool, so changing the rule means hand-dropping and re-adding both. A current account not counting as liquid is explained in the UI instead. | (schema default kept) | Phase 4 ✅ |
| 3 | ~~**Debt payment double-counting**~~ — **DECIDED 2026-08-02**: one debt-payment ledger row is the single source of truth; never also log it as a separate expense. The Debts page owns tracked debts; the Income page's `debt_payment_received` source stays for informal money that was never tracked as a debt. | (schema default kept) | Phase 3 ✅ |
| 4 | ~~**Goal contributions vs real money**~~ — **DECIDED 2026-08-02**: contributions are an earmark; they never move real cash. Moving money to savings is a Transfer. | (schema default kept) | Phase 3 ✅ |
| 5 | ~~**Cross-currency**~~ — **DECIDED 2026-08-03**: per-currency totals only, no FX. Currencies are never summed, and never *ordered* against each other either — `/portfolios` groups into a table each, and the dashboard reports one primary currency with the rest listed separately. | (schema default kept) | Phase 4 ✅ |
| 6 | **Opening balances** — model a starting balance as a ledger row, or as a plain column on the portfolio? | An `opening_balance` ledger row (keeps the cached balance consistent). | Phase 1 |
| 7 | ~~**Investments → net worth**~~ — **DECIDED 2026-08-03**: no to both. Recording an investment moves no money (`portfolio_id` is a "funded from" note, and there is no `transaction_id` on the table), and its value is reported on its own card, never folded into the headline. The dashboard hero became *Liquid* as a result. | (schema default kept) | Phase 4 ✅ |
| 8 | **Role hardening** — store role only in `profiles` (beginner-friendly, with a self-escalation guard), or also mirror it into the JWT for production-grade tamper resistance? | `profiles.role` + trigger guard now; JWT mirroring is a later hardening step. | Phase 1 / later |
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

**What's left open: #1, #6 and #8.** #1 (whether an Admin can read other users' financial data) is
the most impactful and is the last one with real design consequences.
