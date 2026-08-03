-- ============================================================================
-- do_income / do_expense / do_debt — RLS-path entry points for the money RPCs.
--
-- Run this in the Supabase SQL Editor AFTER create_expense.sql, create_income.sql
-- and create_debt.sql — it calls all three, so they must exist first.
--
-- WHY
-- `main` ships on Vercel with no api-gateway and no ledger service (CLAUDE.md,
-- DEVELOPER-GUIDE §7), so the web app has to be able to post money itself there.
-- The create_* RPCs cannot be used for that: they take _user_id as a parameter,
-- and granting one of those to `authenticated` would let any signed-in user pass
-- somebody else's uuid and write across tenants.
--
-- So the identity comes from auth.uid() instead, and the body is delegated. That
-- keeps ONE implementation of every money rule — the create_* function stays the
-- single source of truth — while exposing two safe entry points:
--
--   ledger-service (service_role)  ->  create_income(_user_id, …)
--   web on Vercel  (authenticated) ->  do_income(…)  -> create_income(auth.uid(), …)
--
-- SECURITY DEFINER is required and is safe here precisely because these take no
-- user id: it lets the wrapper reach a create_* function that `authenticated`
-- cannot call directly, while the tenant is always auth.uid() and can never be
-- supplied by the caller. Keep it that way — the moment one of these grows a
-- _user_id parameter it becomes a cross-tenant write primitive.
--
-- do_transfer() and do_debt_payment() already existed as full RLS-path COPIES of
-- the logic (schema.sql §16/§16b). They are replaced below by wrappers of the
-- same shape as the rest, because copies drift and this one already had:
-- create_debt_payment() rejects overpayment, settled and archived debts, and
-- returns the post-payment state; do_debt_payment() does none of that. Leaving
-- it in place meant the Vercel deploy silently ran weaker guards than the mesh
-- and reported the wrong outstanding balance back to the form.
--
-- They are DROPped first because a wrapper returns jsonb where the originals
-- returned uuid, and CREATE OR REPLACE cannot change a return type. Nothing else
-- calls them — they have been dead code since the microservice split.
-- ============================================================================

create or replace function public.do_income(
  _portfolio_id uuid,
  _amount       numeric,
  _source       public.income_source,
  _txn_date     date,
  _source_name  text    default null,
  _description  text    default null,
  _is_recurring boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_income(
    v_uid, _portfolio_id, _amount, _source, _txn_date,
    _source_name, _description, _is_recurring);
end $$;

create or replace function public.do_expense(
  _portfolio_id uuid,
  _category_id  uuid,
  _amount       numeric,
  _txn_date     date,
  _description  text default null,
  _merchant     text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_expense(
    v_uid, _portfolio_id, _category_id, _amount, _txn_date, _description, _merchant);
end $$;

create or replace function public.do_debt(
  _kind                   public.debt_kind,
  _counterparty           text,
  _principal              numeric,
  _currency_id            uuid,
  _interest_rate          numeric default null,
  _due_date               date    default null,
  _note                   text    default null,
  _disbursement_portfolio uuid    default null,
  _disbursement_date      date    default current_date
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_debt(
    v_uid, _kind, _counterparty, _principal, _currency_id,
    _interest_rate, _due_date, _note, _disbursement_portfolio, _disbursement_date);
end $$;

-- Replacing the two legacy copies. Same names and argument lists so any existing
-- caller keeps compiling; the body now delegates and the return type becomes the
-- same jsonb summary the create_* functions produce.
drop function if exists public.do_transfer(uuid, uuid, numeric, numeric, numeric, date, text);
create or replace function public.do_transfer(
  _from_portfolio uuid,
  _to_portfolio   uuid,
  _amount         numeric,
  _fee            numeric default 0,
  _exchange_rate  numeric default 1,
  _txn_date       date    default current_date,
  _note           text    default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_transfer(
    v_uid, _from_portfolio, _to_portfolio, _amount, _fee, _exchange_rate, _txn_date, _note);
end $$;

drop function if exists public.do_debt_payment(uuid, uuid, numeric, numeric, numeric, date, text);
create or replace function public.do_debt_payment(
  _debt_id      uuid,
  _portfolio_id uuid,
  _amount       numeric,
  _principal    numeric default null,
  _interest     numeric default 0,
  _payment_date date    default current_date,
  _note         text    default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_debt_payment(
    v_uid, _debt_id, _portfolio_id, _amount, _principal, _interest, _payment_date, _note);
end $$;

revoke all on function public.do_transfer(uuid, uuid, numeric, numeric, numeric, date, text) from public;
grant execute on function public.do_transfer(uuid, uuid, numeric, numeric, numeric, date, text) to authenticated;

revoke all on function public.do_debt_payment(uuid, uuid, numeric, numeric, numeric, date, text) from public;
grant execute on function public.do_debt_payment(uuid, uuid, numeric, numeric, numeric, date, text) to authenticated;

revoke all on function public.do_income(uuid, numeric, public.income_source, date, text, text, boolean) from public;
grant execute on function public.do_income(uuid, numeric, public.income_source, date, text, text, boolean) to authenticated;

revoke all on function public.do_expense(uuid, uuid, numeric, date, text, text) from public;
grant execute on function public.do_expense(uuid, uuid, numeric, date, text, text) to authenticated;

revoke all on function public.do_debt(public.debt_kind, text, numeric, uuid, numeric, date, text, uuid, date) from public;
grant execute on function public.do_debt(public.debt_kind, text, numeric, uuid, numeric, date, text, uuid, date) to authenticated;

-- Un-writing-off a debt has to re-derive its status from the payment history,
-- so the web tier needs this too. Unlike the wrappers above it is NOT security
-- definer, so it runs as the caller and its `update public.debts` is filtered by
-- RLS — a user can only ever recompute their own debt, whatever id they pass.
grant execute on function public.recompute_debt(uuid) to authenticated;

notify pgrst, 'reload schema';
