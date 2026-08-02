-- ============================================================================
-- create_expense — atomic expense entry RPC used by ledger-service.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql. It adds a
-- function the ledger microservice calls via the service-role key. The whole
-- body runs in one transaction, so if the expense detail insert fails the ledger
-- transaction row rolls back too (replacing the app's old manual rollback). The
-- existing triggers still fire: balance update, overdraft guard, currency match.
--
-- Security: callable ONLY by service_role. It takes _user_id as a parameter and
-- re-checks that the target account belongs to that user, so the (already
-- JWT-validated) identity passed by the gateway cannot write across tenants.
-- ============================================================================
create or replace function public.create_expense(
  _user_id       uuid,
  _portfolio_id  uuid,
  _category_id   uuid,
  _amount        numeric,
  _txn_date      date,
  _description   text default null,
  _merchant      text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_currency uuid;
  v_txn_id   uuid;
  v_exp_id   uuid;
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

  -- The category must also belong to the caller and be active. RLS enforced
  -- this before, but the service-role caller bypasses RLS — re-check here.
  if not exists (
    select 1 from public.expense_categories
    where id = _category_id and user_id = _user_id and is_active
  ) then
    raise exception 'Category not found' using errcode = 'P0002';
  end if;

  insert into public.transactions
    (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
  values
    (_user_id, _portfolio_id, 'expense', 'outflow', _amount, v_currency, _txn_date, _description)
  returning id into v_txn_id;

  insert into public.expenses
    (user_id, transaction_id, txn_kind, category_id, merchant)
  values
    (_user_id, v_txn_id, 'expense', _category_id, _merchant)
  returning id into v_exp_id;

  return jsonb_build_object('expense_id', v_exp_id, 'transaction_id', v_txn_id);
end $$;

-- Lock down execution to service_role only (the gateway-fronted service caller).
revoke all on function public.create_expense(uuid, uuid, uuid, numeric, date, text, text) from public;
grant execute on function public.create_expense(uuid, uuid, uuid, numeric, date, text, text) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
