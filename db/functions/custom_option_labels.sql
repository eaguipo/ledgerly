-- ============================================================================
-- custom_option_labels — let people record options the fixed lists don't have.
--
-- Run this in the Supabase SQL Editor AFTER create_expense.sql, create_income.sql
-- and authenticated_entry_points.sql. It re-creates four functions from those
-- files with one extra parameter each, so they must exist first.
--
-- WHY, and why the three fields are NOT handled the same way
--
--   /expenses  "Category"  -> public.expense_categories, a per-user TABLE.
--              A category the user invents is a first-class row, created inside
--              create_expense() so the category and the expense that needed it
--              land in one transaction (a category created by a POST that then
--              fails its overdraft guard would otherwise survive as litter).
--
--   /portfolios "Category" -> public.portfolio_category, an ENUM.
--   /income     "Source"   -> public.income_source, an ENUM.
--              These cannot take user-supplied values. `portfolios.is_liquid` is
--              a STORED GENERATED column over `category`, v_expense_by_category
--              and the dashboard's allocation split group by them, and there is
--              no migration tool here — a per-user lookup table would mean
--              hand-rewriting both columns, the generated column and every view.
--              So the enum keeps its five/seven meanings and a nullable text
--              label rides alongside it, pinned to the catch-all member:
--              'others' / 'other'. Rollups keep working (a custom account still
--              aggregates as Others); only the label the user reads changes.
--
-- The check constraints are what keep that pinning honest: a label can only
-- exist on the catch-all member, so switching an account from "Gold bullion"
-- back to Bank cannot leave a stale name behind pointing at the wrong thing.
-- ============================================================================

-- STEP 1 — the label columns -------------------------------------------------
alter table public.portfolios
  add column if not exists category_label text;

alter table public.portfolios
  drop constraint if exists portfolio_category_label_only_others;
alter table public.portfolios
  add constraint portfolio_category_label_only_others check (
    category_label is null
    or (category = 'others' and char_length(btrim(category_label)) between 1 and 40)
  );

alter table public.incomes
  add column if not exists source_label text;

alter table public.incomes
  drop constraint if exists incomes_source_label_only_other;
alter table public.incomes
  add constraint incomes_source_label_only_other check (
    source_label is null
    or (source = 'other' and char_length(btrim(source_label)) between 1 and 40)
  );

-- STEP 2 — create_expense gains inline category creation ---------------------
-- DROP first, not CREATE OR REPLACE: adding a defaulted parameter produces a
-- second OVERLOAD rather than replacing the function, and PostgREST would then
-- fail to resolve the call. Same for every function below.
drop function if exists public.create_expense(uuid, uuid, uuid, numeric, date, text, text);

create or replace function public.create_expense(
  _user_id       uuid,
  _portfolio_id  uuid,
  _category_id   uuid,
  _amount        numeric,
  _txn_date      date,
  _description   text default null,
  _merchant      text default null,
  _new_category  text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_currency uuid;
  v_txn_id   uuid;
  v_exp_id   uuid;
  v_cat_id   uuid := _category_id;
  -- Inner whitespace is collapsed, not just trimmed. The find-or-create below
  -- matches on lower(name), so "pet   CARE" would otherwise miss "Pet care" and
  -- file a near-duplicate category next to it. The web layer normalises the
  -- same way, but this is the money rule and has to hold for any caller.
  v_new_name text := nullif(regexp_replace(btrim(_new_category), '\s+', ' ', 'g'), '');
begin
  if _amount is null or _amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  -- Ownership + currency: the account must belong to the caller and be active
  -- (mirrors do_transfer / do_debt_payment, which reject archived portfolios).
  select currency_id into v_currency
  from public.portfolios
  where id = _portfolio_id and user_id = _user_id and not is_archived;
  if v_currency is null then
    raise exception 'Account not found or archived' using errcode = 'P0002';
  end if;

  -- A typed-in category is only consulted when no existing one was picked, so
  -- a form that somehow sends both can never silently create a duplicate.
  if v_cat_id is null then
    if v_new_name is null then
      raise exception 'Select a category' using errcode = 'P0002';
    end if;
    if char_length(v_new_name) > 40 then
      raise exception 'Category name must be 40 characters or fewer';
    end if;

    -- Find-or-create, matched the same way uq_expense_cat_user_active_name is
    -- indexed (lower(name) among active rows). Typing "Coffee" when Coffee
    -- already exists has to reuse it — inserting blind would raise 23505 and
    -- lose the expense along with it.
    select id into v_cat_id
    from public.expense_categories
    where user_id = _user_id and lower(name) = lower(v_new_name) and is_active;

    if v_cat_id is null then
      insert into public.expense_categories (user_id, name, is_system_default)
      values (_user_id, v_new_name, false)
      returning id into v_cat_id;
    end if;
  else
    -- The category must also belong to the caller and be active. RLS enforced
    -- this before, but the service-role caller bypasses RLS — re-check here.
    if not exists (
      select 1 from public.expense_categories
      where id = v_cat_id and user_id = _user_id and is_active
    ) then
      raise exception 'Category not found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.transactions
    (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
  values
    (_user_id, _portfolio_id, 'expense', 'outflow', _amount, v_currency, _txn_date, _description)
  returning id into v_txn_id;

  insert into public.expenses
    (user_id, transaction_id, txn_kind, category_id, merchant)
  values
    (_user_id, v_txn_id, 'expense', v_cat_id, _merchant)
  returning id into v_exp_id;

  -- category_id is returned now: an inline creation means the caller could not
  -- have known it, and the expenses list has to be able to name what it wrote.
  return jsonb_build_object(
    'expense_id', v_exp_id, 'transaction_id', v_txn_id, 'category_id', v_cat_id);
end $$;

revoke all on function public.create_expense(uuid, uuid, uuid, numeric, date, text, text, text) from public;
grant execute on function public.create_expense(uuid, uuid, uuid, numeric, date, text, text, text) to service_role;

-- STEP 3 — create_income carries the custom source label ---------------------
drop function if exists public.create_income(uuid, uuid, numeric, public.income_source, date, text, text, boolean);

create or replace function public.create_income(
  _user_id       uuid,
  _portfolio_id  uuid,
  _amount        numeric,
  _source        public.income_source,
  _txn_date      date,
  _source_name   text default null,
  _description   text default null,
  _is_recurring  boolean default false,
  _source_label  text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_currency uuid;
  v_txn_id   uuid;
  v_inc_id   uuid;
  -- Collapsed like create_expense's category name, so the autocomplete list the
  -- income form builds from these can't fill up with spacing variants.
  v_label    text := nullif(regexp_replace(btrim(_source_label), '\s+', ' ', 'g'), '');
begin
  if _amount is null or _amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  -- Ownership + currency: the account must belong to the caller and be active
  -- (mirrors create_expense / do_transfer, which reject archived portfolios).
  select currency_id into v_currency
  from public.portfolios
  where id = _portfolio_id and user_id = _user_id and not is_archived;
  if v_currency is null then
    raise exception 'Account not found or archived' using errcode = 'P0002';
  end if;

  -- Enforced by incomes_source_label_only_other too; raised here so the caller
  -- gets a sentence about the field instead of a constraint name.
  if v_label is not null then
    if _source <> 'other' then
      raise exception 'A custom source name only applies to the "Other" source';
    end if;
    if char_length(v_label) > 40 then
      raise exception 'Source name must be 40 characters or fewer';
    end if;
  end if;

  insert into public.transactions
    (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
  values
    (_user_id, _portfolio_id, 'income', 'inflow', _amount, v_currency, _txn_date, _description)
  returning id into v_txn_id;

  insert into public.incomes
    (user_id, transaction_id, txn_kind, source, source_name, is_recurring, source_label)
  values
    (_user_id, v_txn_id, 'income', _source, _source_name, coalesce(_is_recurring, false), v_label)
  returning id into v_inc_id;

  return jsonb_build_object('income_id', v_inc_id, 'transaction_id', v_txn_id);
end $$;

revoke all on function public.create_income(uuid, uuid, numeric, public.income_source, date, text, text, boolean, text) from public;
grant execute on function public.create_income(uuid, uuid, numeric, public.income_source, date, text, text, boolean, text) to service_role;

-- STEP 4 — the RLS-path wrappers follow their delegates ----------------------
-- Same contract as authenticated_entry_points.sql: no _user_id parameter, the
-- tenant is always auth.uid(). Keep it that way.
drop function if exists public.do_expense(uuid, uuid, numeric, date, text, text);

create or replace function public.do_expense(
  _portfolio_id uuid,
  _category_id  uuid,
  _amount       numeric,
  _txn_date     date,
  _description  text default null,
  _merchant     text default null,
  _new_category text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_expense(
    v_uid, _portfolio_id, _category_id, _amount, _txn_date,
    _description, _merchant, _new_category);
end $$;

drop function if exists public.do_income(uuid, numeric, public.income_source, date, text, text, boolean);

create or replace function public.do_income(
  _portfolio_id uuid,
  _amount       numeric,
  _source       public.income_source,
  _txn_date     date,
  _source_name  text    default null,
  _description  text    default null,
  _is_recurring boolean default false,
  _source_label text    default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_income(
    v_uid, _portfolio_id, _amount, _source, _txn_date,
    _source_name, _description, _is_recurring, _source_label);
end $$;

revoke all on function public.do_expense(uuid, uuid, numeric, date, text, text, text) from public;
grant execute on function public.do_expense(uuid, uuid, numeric, date, text, text, text) to authenticated;

revoke all on function public.do_income(uuid, numeric, public.income_source, date, text, text, boolean, text) from public;
grant execute on function public.do_income(uuid, numeric, public.income_source, date, text, text, boolean, text) to authenticated;

-- Ask PostgREST to reload its schema cache so the new signatures are callable.
notify pgrst, 'reload schema';
