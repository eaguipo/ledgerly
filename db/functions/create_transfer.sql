-- ============================================================================
-- create_transfer — atomic portfolio-to-portfolio transfer, service-role variant.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, the same
-- way as create_expense.sql.
--
-- WHY THIS EXISTS ALONGSIDE do_transfer()
-- do_transfer() (schema.sql §16) derives identity from auth.uid() and is granted
-- to `authenticated` — it is the RLS-path entry point, callable straight from a
-- signed-in Supabase client. Money mutations now go through ledger-service,
-- which holds the SERVICE-ROLE key: under that role auth.uid() is NULL, so every
-- `where user_id = auth.uid()` lookup misses and do_transfer() fails with
-- "Portfolio not found, archived, or not owned by you" no matter what you pass.
--
-- This is the same shift create_expense.sql made: take _user_id as an explicit
-- parameter, re-check ownership against it, and grant to service_role only. The
-- transfer logic below is otherwise a faithful port of do_transfer() — keep the
-- two in sync until do_transfer() is retired.
--
-- Not SECURITY DEFINER: service_role already bypasses RLS, and definer rights
-- would only widen what a bug here could reach.
-- ============================================================================
create or replace function public.create_transfer(
  _user_id        uuid,
  _from_portfolio uuid,
  _to_portfolio   uuid,
  _amount         numeric,
  _fee            numeric default 0,
  _exchange_rate  numeric default 1,
  _txn_date       date default current_date,
  _note           text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  s          record;
  d          record;
  v_group    uuid := gen_random_uuid();
  v_out      uuid;
  v_in       uuid;
  v_fee_txn  uuid := null;
  v_recv     numeric(38,18);
  v_transfer uuid;
  v_to_minor smallint;
  v_fee_cat  uuid;
begin
  if _amount is null or _amount <= 0 then
    raise exception 'Transfer amount must be positive';
  end if;
  if _fee is null or _fee < 0 then
    raise exception 'Fee cannot be negative';
  end if;
  if _exchange_rate is null or _exchange_rate <= 0 then
    raise exception 'Exchange rate must be positive';
  end if;

  -- FOR UPDATE: locks both accounts for the life of the transaction so two
  -- concurrent transfers cannot both pass the balance check below.
  select * into s from public.portfolios
    where id = _from_portfolio and user_id = _user_id and not is_archived for update;
  select * into d from public.portfolios
    where id = _to_portfolio   and user_id = _user_id and not is_archived for update;
  if s.id is null or d.id is null then
    raise exception 'Account not found, archived, or not owned by you' using errcode = 'P0002';
  end if;
  if s.id = d.id then
    raise exception 'Cannot transfer to the same account';
  end if;

  -- Overdraft guard covers the whole outflow (amount + fee), unless the source
  -- account is explicitly allowed to go negative.
  if not s.allow_negative and s.current_balance < (_amount + _fee) then
    raise exception 'Insufficient funds: balance % < % (amount + fee)',
      s.current_balance, (_amount + _fee);
  end if;

  v_to_minor := public.currency_minor_unit(d.currency_id);
  v_recv := round(_amount * _exchange_rate, v_to_minor);
  if v_recv <= 0 then
    raise exception 'Converted amount rounds to zero';
  end if;

  -- OUT leg: principal only (the fee is posted separately below).
  insert into public.transactions
    (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description, transfer_group_id)
  values
    (_user_id, s.id, 'transfer_out', 'outflow', _amount, s.currency_id, _txn_date,
     coalesce(_note, 'Transfer to ' || d.name), v_group)
  returning id into v_out;

  -- IN leg, in the destination's currency at the given rate.
  insert into public.transactions
    (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description, transfer_group_id)
  values
    (_user_id, d.id, 'transfer_in', 'inflow', v_recv, d.currency_id, _txn_date,
     coalesce(_note, 'Transfer from ' || s.name), v_group)
  returning id into v_in;

  -- FEE leg: a real expense so cashflow/expense reporting counts it (Req 20).
  if _fee > 0 then
    select id into v_fee_cat from public.expense_categories
      where user_id = _user_id and is_active and lower(name) = 'transfer fee' limit 1;
    if v_fee_cat is null then
      insert into public.expense_categories(user_id, name, is_system_default)
      values (_user_id, 'Transfer Fee', true) returning id into v_fee_cat;
    end if;
    insert into public.transactions
      (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description, transfer_group_id)
    values
      (_user_id, s.id, 'expense', 'outflow', _fee, s.currency_id, _txn_date, 'Transfer fee', v_group)
    returning id into v_fee_txn;
    insert into public.expenses(user_id, transaction_id, txn_kind, category_id, is_bill)
    values (_user_id, v_fee_txn, 'expense', v_fee_cat, false);
  end if;

  insert into public.transfers
    (user_id, from_portfolio_id, to_portfolio_id, amount, fee, from_currency_id, to_currency_id,
     exchange_rate, amount_received, out_transaction_id, in_transaction_id, fee_transaction_id,
     txn_date, note)
  values
    (_user_id, s.id, d.id, _amount, _fee, s.currency_id, d.currency_id,
     _exchange_rate, v_recv, v_out, v_in, v_fee_txn, _txn_date, _note)
  returning id into v_transfer;

  return jsonb_build_object(
    'transfer_id',        v_transfer,
    'out_transaction_id', v_out,
    'in_transaction_id',  v_in,
    'fee_transaction_id', v_fee_txn,
    'amount_received',    v_recv
  );
end $$;

-- Lock down execution to service_role only (the gateway-fronted service caller).
revoke all on function public.create_transfer(uuid, uuid, uuid, numeric, numeric, numeric, date, text) from public;
grant execute on function public.create_transfer(uuid, uuid, uuid, numeric, numeric, numeric, date, text) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
