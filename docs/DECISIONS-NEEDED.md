# Decisions Needed

These are product choices the requirements doc didn't pin down. The schema picked a sensible
default for each (noted below) so you're not blocked — but your answers change how some features
behave. None of these block Phase 0/1; revisit before the phase that touches them.

| # | Question | Schema's current default | Affects |
|---|----------|--------------------------|---------|
| 1 | **Admin visibility of finances** — should an Admin be able to view *other users'* transactions/balances, or only manage accounts/features? | Admin manages users + features only; **cannot** read others' financial data (privacy-first). | Phase 1 (roles) |
| 2 | **"Bank savings" for liquid money (Rule 16)** — is liquid money *all* bank accounts, or only ones flagged as savings? | `is_liquid = cash OR (bank AND is_savings)` — you mark which bank accounts are savings. | Phase 4 |
| 3 | ~~**Debt payment double-counting**~~ — **DECIDED 2026-08-02**: one debt-payment ledger row is the single source of truth; never also log it as a separate expense. The Debts page owns tracked debts; the Income page's `debt_payment_received` source stays for informal money that was never tracked as a debt. | (schema default kept) | Phase 3 ✅ |
| 4 | ~~**Goal contributions vs real money**~~ — **DECIDED 2026-08-02**: contributions are an earmark; they never move real cash. Moving money to savings is a Transfer. | (schema default kept) | Phase 3 ✅ |
| 5 | **Cross-currency** — same-currency-only MVP (totals grouped by currency), or do you need an FX-rates table + a converted net-worth total now? | Per-currency totals only; no FX conversion. | Phase 4 |
| 6 | **Opening balances** — model a starting balance as a ledger row, or as a plain column on the portfolio? | An `opening_balance` ledger row (keeps the cached balance consistent). | Phase 1 |
| 7 | **Investments → net worth** — should an investment's current value feed a consolidated net-worth figure, and should buying an investment auto-create an outflow from a funding portfolio? | Investments tracked separately; not auto-linked to a funding portfolio. | Phase 4 |
| 8 | **Role hardening** — store role only in `profiles` (beginner-friendly, with a self-escalation guard), or also mirror it into the JWT for production-grade tamper resistance? | `profiles.role` + trigger guard now; JWT mirroring is a later hardening step. | Phase 1 / later |
| 9 | ~~**Debt origination**~~ — when you record a debt, should the cash movement be posted too? The schema had no answer: `debts` has a principal but no disbursement link. **DECIDED 2026-08-02**: *optional* linked disbursement. A funding account on the debt form posts an `income` row (payable) or `expense` row (receivable) linked via the existing `incomes.debt_id` / `expenses.debt_id`; blank means record-only. Adds a `loan_received` income source. | (new — no prior default) | Phase 3 ✅ |
| 10 | ~~**Debt payment interest split**~~ — expose it in the UI or treat every payment as pure principal? **DECIDED 2026-08-02**: optional interest field defaulting to 0; outstanding drops by principal only, so interest-only payments correctly leave the balance alone. | (schema already supports the split) | Phase 3 ✅ |

**You don't need to answer all of these now.** **#3, #4, #9 and #10** — how debts and goals interact
with real cash — were settled on 2026-08-02 ahead of Phase 3; see
[`docs/PHASE-3-PLAN.md`](./PHASE-3-PLAN.md) §1. Of what's left, **#1** (admin scope) is the most
impactful; the rest can wait until their phase.

**#2, #5 and #7 are now live** — Phase 3 is done and Phase 4 is next.
[`docs/PHASE-4-PLAN.md`](./PHASE-4-PLAN.md) §1 restates them as D1–D4 with a recommendation each and
the concrete cost of deciding the other way, plus a new **D5** (custom asset types like gold and
vehicles — reuse the `other_asset` + label pattern rather than adding tables). #7 is the fork that
shapes the most code: record-only investments are a small CRUD feature, cash-moving ones are not.
