-- ============================================================================
-- create_debt_payment — atomic debt payment, service-role variant.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, the same
-- way as create_expense.sql / create_income.sql / create_transfer.sql.
--
-- WHY THIS EXISTS ALONGSIDE do_debt_payment()
-- Exactly the reason create_transfer.sql exists alongside do_transfer(), and it
-- bites the same way. do_debt_payment() (schema.sql §16b) derives identity from
-- auth.uid() and is granted to `authenticated` — it is the RLS-path entry point.
-- Money mutations now go through ledger-service, which holds the SERVICE-ROLE
-- key: under that role auth.uid() is NULL, so `where user_id = auth.uid()` finds
-- nothing and do_debt_payment() fails with "Debt not found or not owned by you"
-- no matter what you pass. Keep the two in sync until do_debt_payment() retires.
--
-- WHAT IS NEW HERE (not a faithful port — these are real gaps)
--   * OVERPAYMENT is rejected. recompute_debt_balance() clamps outstanding with
--     greatest(principal - paid, 0), so a principal portion larger than the
--     balance silently settles the debt and the excess simply vanishes from the
--     arithmetic — while the cash really did leave the account.
--   * A settled or archived debt cannot take a payment.
--   * A written-off debt CAN: recovering on one is real, and the trigger already
--     keeps the status sticky, so the recovery shows without reopening the debt.
--   * Returns the post-payment state so the UI can say "settled" without a
--     second round trip.
--
-- Not SECURITY DEFINER: service_role already bypasses RLS, and definer rights
-- would only widen what a bug here could reach.
-- ============================================================================
create or replace function public.create_debt_payment(
  _user_id      uuid,
  _debt_id      uuid,
  _portfolio_id uuid,
  _amount       numeric,
  _principal    numeric default null,
  _interest     numeric default 0,
  _payment_date date    default current_date,
  _note         text    default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  dr          record;
  pf          record;
  v_principal numeric(38,18);
  v_interest  numeric(38,18);
  v_kind      public.txn_kind;
  v_dir       public.txn_direction;
  v_txn       uuid;
  v_payment   uuid;
  v_after     record;
begin
  if _amount is null or _amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  -- Blank principal means "all principal" — the common case, and what the form
  -- sends when the optional interest field is left empty.
  v_interest  := coalesce(_interest, 0);
  v_principal := coalesce(_principal, _amount - v_interest);
  if v_interest < 0 or v_principal < 0 then
    raise exception 'Principal and interest cannot be negative';
  end if;
  if v_principal + v_interest <> _amount then
    raise exception 'Principal (%) plus interest (%) must equal the amount (%)',
      v_principal, v_interest, _amount;
  end if;

  -- FOR UPDATE is load-bearing: two tabs paying off the last 1,000 of a debt
  -- serialise here, so the second one sees outstanding = 0 and is caught by the
  -- overpayment guard below instead of double-spending.
  select * into dr from public.debts
    where id = _debt_id and user_id = _user_id for update;
  if dr.id is null then
    raise exception 'Debt not found or not owned by you' using errcode = 'P0002';
  end if;
  if dr.is_archived then
    raise exception 'This debt is archived — unarchive it to record a payment';
  end if;
  if dr.status = 'settled' then
    raise exception 'This debt is already settled';
  end if;
  -- Deliberately NOT rejected: dr.status = 'written_off'. Money coming back on a
  -- write-off is real; recompute_debt_balance() keeps the status written_off.

  if v_principal > dr.outstanding_balance then
    raise exception 'Principal of % is more than the % still outstanding on this debt',
      v_principal, dr.outstanding_balance;
  end if;

  select * into pf from public.portfolios
    where id = _portfolio_id and user_id = _user_id and not is_archived for update;
  if pf.id is null then
    raise exception 'Account not found, archived, or not owned by you' using errcode = 'P0002';
  end if;
  if pf.currency_id <> dr.currency_id then
    raise exception 'The account must hold the same currency as the debt';
  end if;

  -- payable: we pay money OUT. receivable: they pay us, money comes IN.
  if dr.kind = 'payable' then
    v_kind := 'debt_payment_made'; v_dir := 'outflow';
    -- Pre-checked for the message alone; trg_txn_overdraft is the real gate and
    -- fires regardless of entry path, but it only knows the portfolio uuid.
    if not pf.allow_negative and pf.current_balance < _amount then
      raise exception 'Insufficient funds: % holds % but the payment is %',
        pf.name, pf.current_balance, _amount;
    end if;
  else
    v_kind := 'debt_payment_received'; v_dir := 'inflow';
  end if;

  insert into public.transactions
    (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
  values
    (_user_id, pf.id, v_kind, v_dir, _amount, pf.currency_id, _payment_date,
     coalesce(_note, (case when dr.kind = 'payable'
                           then 'Debt payment to '
                           else 'Debt collection from ' end) || dr.counterparty))
  returning id into v_txn;

  -- trg_debt_payment_recompute fires on this insert and rewrites
  -- debts.outstanding_balance + status from the sum of principal portions.
  insert into public.debt_payments
    (user_id, debt_id, transaction_id, amount, principal_portion, interest_portion, payment_date, note)
  values
    (_user_id, dr.id, v_txn, _amount, v_principal, v_interest, _payment_date, _note)
  returning id into v_payment;

  -- Re-read inside the same transaction so we see the trigger's own update. This
  -- is what lets the form say "settled" without the page re-fetching the debt.
  select outstanding_balance, status into v_after from public.debts where id = dr.id;

  return jsonb_build_object(
    'payment_id',        v_payment,
    'transaction_id',    v_txn,
    'debt_id',           dr.id,
    'principal_portion', v_principal,
    'interest_portion',  v_interest,
    'outstanding_after', v_after.outstanding_balance,
    'status_after',      v_after.status
  );
end $$;

-- Lock down execution to service_role only (the gateway-fronted service caller).
revoke all on function public.create_debt_payment(uuid, uuid, uuid, numeric, numeric, numeric, date, text) from public;
grant execute on function public.create_debt_payment(uuid, uuid, uuid, numeric, numeric, numeric, date, text) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
