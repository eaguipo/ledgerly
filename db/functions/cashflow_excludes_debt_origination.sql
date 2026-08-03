-- ============================================================================
-- cashflow_excludes_debt_origination — keep debt origination out of the
-- inflow/outflow and spending-by-category reports.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, and after
-- create_debt.sql (it references incomes.source = 'loan_received', which that
-- file adds to the enum). Views only — no data is touched, and it is safe to
-- re-run.
--
-- THE GAP
-- v_cashflow counts kind in ('income','expense','debt_payment_made',
-- 'debt_payment_received'). create_debt() posts its optional disbursement as a
-- plain 'income' row (payable) or 'expense' row (receivable), so:
--
--   borrow 10,000  ->  v_cashflow reports 10,000 of INFLOW
--   lend      500  ->  v_cashflow reports    500 of OUTFLOW,
--                      and v_expense_by_category shows 500 of "Money Lent"
--
-- Neither is true. Borrowing is not earning and lending is not spending — both
-- swap one asset/liability for another and leave what you earned and spent
-- untouched. This is exactly the double-count the schema already avoids by
-- keeping transfer_in / transfer_out out of the kind list (see DATABASE.md §4),
-- reached through a different door.
--
-- Debt *payments* remain counted. Servicing a debt is real cash leaving the
-- account, and Rule 14 makes that ledger row the single source of truth for it.
--
-- The same two views also carry the asset-purchase exclusion added by
-- money_invested.sql (`expenses.investment_id`), so that all THREE copies —
-- here, schema.sql §19, and money_invested.sql — are identical and the apply
-- order between them cannot matter. Without that, running this file after
-- money_invested.sql would silently revert the investment exclusion.
--
-- Mirrored into db/schema.sql §19 so a fresh install produces the same views.
-- Keep all three in sync.
-- ============================================================================

create or replace view public.v_cashflow
  with (security_invoker = true) as
  select t.user_id, c.code as currency_code, t.txn_date, t.direction, sum(t.amount) as total
  from public.transactions t join public.currencies c on c.id = t.currency_id
  where t.is_void = false and t.kind in ('income','expense','debt_payment_made','debt_payment_received')
    and not exists (select 1 from public.incomes i
                     where i.transaction_id = t.id and i.source = 'loan_received')
    and not exists (select 1 from public.expenses e
                     where e.transaction_id = t.id
                       and (e.debt_id is not null or e.investment_id is not null))
  group by t.user_id, c.code, t.txn_date, t.direction;

-- `debt_id is null` is safe as the marker because Rule 14 / DECISIONS-NEEDED #3
-- make the debt payment its own ledger kind — a debt-linked EXPENSE only ever
-- comes from create_debt()'s lending leg. `investment_id is null` is safe for the
-- same reason: its only writer is create_investment()'s purchase leg.
create or replace view public.v_expense_by_category
  with (security_invoker = true) as
  select e.user_id, ec.id as category_id, ec.name as category_name, t.txn_date,
         c.code as currency_code, sum(t.amount) as total
  from public.expenses e
  join public.transactions t on t.id = e.transaction_id and t.is_void = false
  join public.expense_categories ec on ec.id = e.category_id
  join public.currencies c on c.id = t.currency_id
  where e.debt_id is null and e.investment_id is null
  group by e.user_id, ec.id, ec.name, t.txn_date, c.code;

notify pgrst, 'reload schema';
