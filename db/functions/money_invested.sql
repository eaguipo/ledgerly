-- ============================================================================
-- money_invested — buying an investment moves real cash, and buying an asset is
-- not spending.
--
-- Run this in the Supabase SQL Editor AFTER create_investment.sql and AFTER
-- cashflow_excludes_debt_origination.sql — it re-creates create_investment() and
-- both of that file's views. Safe to re-run.
--
-- THE GAP
-- Phase 4 decision D1 made investments record-only: creating one posted no
-- ledger row, and investments.portfolio_id ("Funded from") was a label. So
-- buying 50,000 of gold left the funding account 50,000 too high, and the only
-- way to correct it was a plain expense — which then reported as SPENDING:
--
--   buy 50,000 of gold  ->  v_cashflow reports 50,000 of OUTFLOW
--                           v_expense_by_category files it under some category
--
-- Neither is true. You converted an asset; you did not consume anything. This is
-- the identical error cashflow_excludes_debt_origination.sql already fixed for
-- borrowing and lending, reached through a third door — and Phase 5's reports are
-- what would have made it authoritative.
--
-- THE FIX, in the shape the codebase already uses twice
-- An optional funding account now posts a REAL outflow against a self-healing
-- 'Money Invested' category (exactly like create_debt's 'Money Lent' and
-- create_transfer's 'Transfer Fee'), and expenses.investment_id marks that row so
-- both report views can exclude it — exactly like expenses.debt_id.
--
-- Selling is NOT covered here. Realising a gain is a separate movement and
-- nothing in Phase 4 or 5 models it yet.
--
-- WHAT CHANGES FOR EXISTING DATA: nothing retroactively. Investments already
-- recorded with a funding account keep their label and stay without a ledger row.
-- Only new ones post an outflow.
--
-- Mirrored into db/schema.sql (§10 expenses, §19 views) so a fresh install
-- produces the same objects. Keep the two in sync.
-- ============================================================================

-- STEP 1 — mark the ledger row as an asset purchase --------------------------
-- Mirrors expenses.debt_id exactly, including `on delete set null`: an
-- investment can be closed but the cash that bought it really did leave the
-- account, so the ledger row must outlive the link rather than cascade away.
-- Column and constraint added separately, and the constraint named explicitly,
-- so this is idempotent and matches schema.sql byte for byte. In schema.sql the
-- FK has to be deferred to §12 anyway — `expenses` is created before
-- `investments`, so an inline reference would fail on a fresh install.
alter table public.expenses
  add column if not exists investment_id uuid;

alter table public.expenses
  drop constraint if exists expenses_investment_id_fkey;
alter table public.expenses
  add constraint expenses_investment_id_fkey
  foreign key (investment_id) references public.investments(id) on delete set null;

create index if not exists idx_expenses_investment
  on public.expenses(investment_id) where investment_id is not null;

-- STEP 2 — create_investment posts the outflow -------------------------------
-- Same signature as create_investment.sql, so this is a plain replace and
-- do_investment() needs no change. _opened_on doubles as the purchase date: it
-- is already "when this holding started", which is when the money left.
create or replace function public.create_investment(
  _user_id         uuid,
  _name            text,
  _kind            public.investment_kind,
  _currency_id     uuid,
  _invested_amount numeric,
  _symbol          text    default null,
  _quantity        numeric default null,
  _average_cost    numeric default null,
  _opened_on       date    default current_date,
  _maturity_date   date    default null,
  _portfolio_id    uuid    default null,
  _kind_label      text    default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  pf       record;
  v_inv_id uuid;
  v_txn_id uuid;
  v_cat_id uuid;
  v_date   date := coalesce(_opened_on, current_date);
  v_label  text := nullif(regexp_replace(btrim(_kind_label), '\s+', ' ', 'g'), '');
begin
  if _name is null or char_length(trim(_name)) = 0 then
    raise exception 'Give the investment a name';
  end if;
  if _invested_amount is null or _invested_amount < 0 then
    raise exception 'Invested amount cannot be negative';
  end if;
  if not exists (select 1 from public.currencies where id = _currency_id) then
    raise exception 'Currency not found' using errcode = 'P0002';
  end if;

  if v_label is not null then
    if _kind <> 'other_asset' then
      raise exception 'A custom type name only applies to the "Other" type';
    end if;
    if char_length(v_label) > 40 then
      raise exception 'Type name must be 40 characters or fewer';
    end if;
  end if;

  if _portfolio_id is not null then
    -- FOR UPDATE now, unlike the Phase 4 version, which explicitly took no lock
    -- because nothing moved. Money moves here, so the overdraft check below must
    -- not race a concurrent outflow.
    select * into pf from public.portfolios
      where id = _portfolio_id and user_id = _user_id and not is_archived
      for update;
    if pf.id is null then
      raise exception 'Account not found, archived, or not owned by you' using errcode = 'P0002';
    end if;
    -- trg_txn_currency (BR17) would reject the mismatch anyway, but its message
    -- names a uuid. Say something a person can act on.
    if pf.currency_id <> _currency_id then
      raise exception 'The funding account must hold the same currency as the investment';
    end if;
    -- Pre-check so the error names the account and the shortfall; the trigger
    -- would fire regardless but only knows the portfolio uuid.
    if _invested_amount > 0 and not pf.allow_negative and pf.current_balance < _invested_amount then
      raise exception 'Insufficient funds: % holds % but the purchase is %',
        pf.name, pf.current_balance, _invested_amount;
    end if;
  end if;

  insert into public.investments
    (user_id, name, kind, kind_label, symbol, quantity, average_cost,
     invested_amount, current_value, currency_id, opened_on, maturity_date,
     portfolio_id)
  values
    (_user_id, trim(_name), _kind, v_label, nullif(btrim(_symbol), ''), _quantity,
     _average_cost, _invested_amount, _invested_amount, _currency_id,
     v_date, _maturity_date, _portfolio_id)
  returning id into v_inv_id;

  -- A zero-cost holding (inherited, gifted, or cost basis unknown) posts nothing:
  -- there is no cash movement to record, and a zero-amount transaction would fail
  -- the amount > 0 check anyway.
  if _portfolio_id is not null and _invested_amount > 0 then
    -- Self-healing system category, same pattern as create_debt's 'Money Lent'.
    -- expenses.category_id is NOT NULL, so this needs a home even for a user who
    -- deleted every default category.
    select id into v_cat_id from public.expense_categories
      where user_id = _user_id and is_active and lower(name) = 'money invested' limit 1;
    if v_cat_id is null then
      insert into public.expense_categories(user_id, name, is_system_default)
      values (_user_id, 'Money Invested', true) returning id into v_cat_id;
    end if;

    insert into public.transactions
      (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
    values
      (_user_id, pf.id, 'expense', 'outflow', _invested_amount, pf.currency_id, v_date,
       'Bought ' || trim(_name))
    returning id into v_txn_id;

    insert into public.expenses
      (user_id, transaction_id, txn_kind, category_id, investment_id, is_bill)
    values
      (_user_id, v_txn_id, 'expense', v_cat_id, v_inv_id, false);
  end if;

  return jsonb_build_object(
    'investment_id',  v_inv_id,
    'transaction_id', v_txn_id   -- null when the holding is record-only
  );
end $$;

revoke all on function public.create_investment(
  uuid, text, public.investment_kind, uuid, numeric, text, numeric, numeric,
  date, date, uuid, text) from public;
grant execute on function public.create_investment(
  uuid, text, public.investment_kind, uuid, numeric, text, numeric, numeric,
  date, date, uuid, text) to service_role;

-- STEP 3 — keep asset purchases out of the reports ---------------------------
-- The two exclusions are folded into one subquery rather than two: both mark the
-- same thing — an expense row that is not consumption.
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
-- same reason: the only writer is create_investment()'s purchase leg.
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
