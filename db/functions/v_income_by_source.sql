-- ============================================================================
-- v_income_by_source — the income-side counterpart to v_expense_by_category.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql and after
-- create_debt.sql (it references the 'loan_received' income source that file
-- adds). View only — no data is touched, and it is safe to re-run.
--
-- WHY
-- "Where did the money go" has had a view since Phase 1; "where did it come
-- from" has not, so a report would have to pull every income row and aggregate
-- in JS — the thing the roadmap's free-tier notes exist to avoid.
--
-- THE EXCLUSION IS NOT OPTIONAL. v_cashflow already drops incomes with
-- source = 'loan_received' (borrowing is not earning — see
-- cashflow_excludes_debt_origination.sql). If this view counted them, the same
-- month would report a different total depending on which view you asked, and
-- the report's "where it came from" breakdown would not add up to its own
-- inflow headline.
--
-- GROUPING BY THE ENUM, NOT THE LABEL, is deliberate. A user-typed source is
-- stored as source = 'other' plus source_label (schema.sql §9), and
-- income_source is a closed enum precisely so reporting has a fixed set of
-- buckets. source_label rides along so the UI can name the 'other' rows without
-- fragmenting the grouping — one row per (source, label) pair, which collapses
-- to one row for every source except 'other'.
--
-- Mirrored into db/schema.sql §19 so a fresh install produces the same view.
-- Keep the two in sync.
-- ============================================================================

create or replace view public.v_income_by_source
  with (security_invoker = true) as
  select i.user_id, i.source, i.source_label, t.txn_date,
         c.code as currency_code, sum(t.amount) as total
  from public.incomes i
  join public.transactions t on t.id = i.transaction_id and t.is_void = false
  join public.currencies c on c.id = t.currency_id
  where i.source <> 'loan_received'
  group by i.user_id, i.source, i.source_label, t.txn_date, c.code;

grant select on public.v_income_by_source to authenticated;
grant all on public.v_income_by_source to service_role;

notify pgrst, 'reload schema';
