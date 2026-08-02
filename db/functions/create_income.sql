-- ============================================================================
-- create_income — atomic income entry RPC used by ledger-service.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, the same
-- way as create_expense.sql. Two parts:
--
--   STEP 1  widen the income_source enum with 'gains' and 'gift'
--   STEP 2  create the RPC
--
-- Both can be run in one go: ADD VALUE inside a transaction is fine on PG 12+
-- as long as the new label is not *used* in that same transaction, and the
-- function body only ever receives it as a parameter. If your editor still
-- objects, run the STEP 1 block on its own first.
--
-- Security: callable ONLY by service_role. It takes _user_id as a parameter and
-- re-checks that the target account belongs to that user, so the (already
-- JWT-validated) identity passed by the gateway cannot write across tenants.
-- Like create_expense, it does NOT consult has_feature() — that helper reads
-- auth.uid(), which is null under the service role. Feature gating stays on the
-- RLS path.
-- ============================================================================

-- STEP 1 ---------------------------------------------------------------------
-- Positioned rather than appended so `order by source` still reads sensibly:
-- salary, business, gains, debt_payment_received, gift, other.
alter type public.income_source add value if not exists 'gains' after 'business';
alter type public.income_source add value if not exists 'gift'  after 'debt_payment_received';

-- STEP 2 ---------------------------------------------------------------------
create or replace function public.create_income(
  _user_id       uuid,
  _portfolio_id  uuid,
  _amount        numeric,
  _source        public.income_source,
  _txn_date      date,
  _source_name   text default null,
  _description   text default null,
  _is_recurring  boolean default false
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_currency uuid;
  v_txn_id   uuid;
  v_inc_id   uuid;
begin
  if _amount is null or _amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  -- Ownership + currency: the account must belong to the caller and be active
  -- (mirrors create_expense / do_transfer, which reject archived portfolios).
  -- The amount is always posted in the account's own currency — trg_txn_currency
  -- (BR17) rejects anything else, so income needs no FX handling.
  select currency_id into v_currency
  from public.portfolios
  where id = _portfolio_id and user_id = _user_id and not is_archived;
  if v_currency is null then
    raise exception 'Account not found or archived' using errcode = 'P0002';
  end if;

  -- kind is always 'income', never 'debt_payment_received', even when the
  -- source says the money came from someone repaying you. The dedicated kind
  -- belongs to do_debt_payment(), which also decrements debts.outstanding_balance;
  -- posting it here would look like a debt was serviced when no debt row moved.
  -- incomes.debt_id therefore stays null until the debts UI (Phase 3) links them.
  insert into public.transactions
    (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
  values
    (_user_id, _portfolio_id, 'income', 'inflow', _amount, v_currency, _txn_date, _description)
  returning id into v_txn_id;

  insert into public.incomes
    (user_id, transaction_id, txn_kind, source, source_name, is_recurring)
  values
    (_user_id, v_txn_id, 'income', _source, _source_name, coalesce(_is_recurring, false))
  returning id into v_inc_id;

  return jsonb_build_object('income_id', v_inc_id, 'transaction_id', v_txn_id);
end $$;

-- Lock down execution to service_role only (the gateway-fronted service caller).
revoke all on function public.create_income(uuid, uuid, numeric, public.income_source, date, text, text, boolean) from public;
grant execute on function public.create_income(uuid, uuid, numeric, public.income_source, date, text, text, boolean) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
