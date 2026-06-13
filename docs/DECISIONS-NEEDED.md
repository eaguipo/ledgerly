# Decisions Needed

These are product choices the requirements doc didn't pin down. The schema picked a sensible
default for each (noted below) so you're not blocked — but your answers change how some features
behave. None of these block Phase 0/1; revisit before the phase that touches them.

| # | Question | Schema's current default | Affects |
|---|----------|--------------------------|---------|
| 1 | **Admin visibility of finances** — should an Admin be able to view *other users'* transactions/balances, or only manage accounts/features? | Admin manages users + features only; **cannot** read others' financial data (privacy-first). | Phase 1 (roles) |
| 2 | **"Bank savings" for liquid money (Rule 16)** — is liquid money *all* bank accounts, or only ones flagged as savings? | `is_liquid = cash OR (bank AND is_savings)` — you mark which bank accounts are savings. | Phase 4 |
| 3 | **Debt payment double-counting** — should paying a debt be an *expense* (in a "Debt - X" category), a *debt payment* (reduces outstanding), or one ledger row used by both? Reports must pick one source of truth. | A `do_debt_payment()` posts one ledger row linked to the debt; don't also log it as a separate expense. | Phase 3 |
| 4 | **Goal contributions vs real money** — does saving toward a goal *move* real money out of a portfolio, or is a goal just a progress tracker layered on existing balances? | Goal contributions are an earmark/tag; they don't move real money. | Phase 3 |
| 5 | **Cross-currency** — same-currency-only MVP (totals grouped by currency), or do you need an FX-rates table + a converted net-worth total now? | Per-currency totals only; no FX conversion. | Phase 4 |
| 6 | **Opening balances** — model a starting balance as a ledger row, or as a plain column on the portfolio? | An `opening_balance` ledger row (keeps the cached balance consistent). | Phase 1 |
| 7 | **Investments → net worth** — should an investment's current value feed a consolidated net-worth figure, and should buying an investment auto-create an outflow from a funding portfolio? | Investments tracked separately; not auto-linked to a funding portfolio. | Phase 4 |
| 8 | **Role hardening** — store role only in `profiles` (beginner-friendly, with a self-escalation guard), or also mirror it into the JWT for production-grade tamper resistance? | `profiles.role` + trigger guard now; JWT mirroring is a later hardening step. | Phase 1 / later |

**You don't need to answer all of these now.** The most impactful early ones are **#1** (admin
scope) and **#3 / #4** (how debts and goals interact with real cash) — those shape the data you
record from day one. The rest can wait until their phase.
