-- ============================================================================
-- create_debt — record a payable/receivable, optionally posting the cash that
-- changed hands with it. Service-role variant used by ledger-service.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, the same
-- way as create_expense.sql / create_income.sql / create_transfer.sql.
--
-- THE OPTIONAL DISBURSEMENT (roadmap Phase 3, decision D1)
-- `debts` stores a principal but has no link to the ledger row for the money
-- itself, so recording a debt alone never moves a balance. That is right for a
-- debt you already had when you started using the app, and wrong for one you
-- take on today — borrow PHP 10,000 and the cash really is in your wallet.
--
-- _disbursement_portfolio is therefore optional:
--   NULL  -> record-only. No transaction, no balance change.
--   set   -> payable:    cash comes IN  -> an 'income'  txn + incomes.debt_id
--            receivable: cash goes OUT  -> an 'expense' txn + expenses.debt_id
--
-- incomes.debt_id / expenses.debt_id are the ONLY debt->ledger links the schema
-- offers, which is why the disbursement has to be an income/expense kind rather
-- than a neutral 'adjustment'.
--
-- REPORTING CAVEAT: borrowed money is not earnings, and money lent out is not
-- spending — both post as income/expense rows here purely to keep the debt_id
-- link. Net worth is unaffected (cash +10k, debt +10k), but Phase 5's headline
-- "income" and "spending" figures must exclude incomes.source = 'loan_received'
-- and expense rows carrying a debt_id. See docs/PHASE-3-PLAN.md §7.
--
-- Security: callable ONLY by service_role. It takes _user_id as a parameter and
-- re-checks that the debt currency and funding account belong to that user, so
-- the (already JWT-validated) identity passed by the gateway cannot write
-- across tenants. Like create_expense/create_income it does NOT consult
-- has_feature() — that helper reads auth.uid(), which is null under the service
-- role. Feature gating stays on the RLS path.
-- ============================================================================

-- STEP 1 ---------------------------------------------------------------------
-- Loan proceeds need their own source so reports can tell them apart from money
-- you actually earned. Positioned after 'gains' so `order by source` still reads
-- in rough "most like earnings first" order.
--
-- Run this block on its own first if your editor objects: ADD VALUE inside a
-- transaction is fine on PG 12+ as long as the new label is not *used* in the
-- same transaction. The literal below lives inside a function body, which is
-- not executed at CREATE time, so a single run is normally fine.
alter type public.income_source add value if not exists 'loan_received' after 'gains';

-- STEP 2 ---------------------------------------------------------------------
create or replace function public.create_debt(
  _user_id                uuid,
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
language plpgsql
set search_path = public
as $$
declare
  pf         record;
  v_debt_id  uuid;
  v_txn_id   uuid := null;
  v_cat_id   uuid;
  -- An explicit NULL argument overrides the parameter default rather than
  -- falling back to it, and transactions.txn_date is NOT NULL — so a caller
  -- that names a funding account but omits the date would hit a constraint
  -- violation instead of just getting today.
  v_date     date := coalesce(_disbursement_date, current_date);
begin
  -- principal > 0, not >= 0. The table constraint allows zero, but a zero
  -- principal debt is born 'open' with nothing outstanding and the recompute
  -- trigger can never reconcile it — it only ever fires on debt_payments.
  if _principal is null or _principal <= 0 then
    raise exception 'Principal must be greater than zero';
  end if;
  if _counterparty is null or char_length(trim(_counterparty)) = 0 then
    raise exception 'Who the debt is with is required';
  end if;
  if _interest_rate is not null and _interest_rate < 0 then
    raise exception 'Interest rate cannot be negative';
  end if;
  if not exists (select 1 from public.currencies where id = _currency_id) then
    raise exception 'Currency not found' using errcode = 'P0002';
  end if;

  insert into public.debts
    (user_id, kind, counterparty, principal_amount, outstanding_balance,
     currency_id, interest_rate, due_date, note)
  values
    (_user_id, _kind, trim(_counterparty), _principal, _principal,
     _currency_id, _interest_rate, _due_date, _note)
  returning id into v_debt_id;

  if _disbursement_portfolio is not null then
    -- FOR UPDATE so the overdraft check below cannot race a concurrent outflow.
    select * into pf from public.portfolios
      where id = _disbursement_portfolio and user_id = _user_id and not is_archived
      for update;
    if pf.id is null then
      raise exception 'Account not found, archived, or not owned by you' using errcode = 'P0002';
    end if;
    -- trg_txn_currency (BR17) would reject the mismatch anyway, but its message
    -- names a uuid. Say something a person can act on.
    if pf.currency_id <> _currency_id then
      raise exception 'The funding account must hold the same currency as the debt';
    end if;

    if _kind = 'payable' then
      -- We borrowed: the cash lands in the account.
      insert into public.transactions
        (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
      values
        (_user_id, pf.id, 'income', 'inflow', _principal, pf.currency_id, v_date,
         'Borrowed from ' || trim(_counterparty))
      returning id into v_txn_id;

      insert into public.incomes
        (user_id, transaction_id, txn_kind, source, source_name, debt_id)
      values
        (_user_id, v_txn_id, 'income', 'loan_received', trim(_counterparty), v_debt_id);
    else
      -- We lent: the cash leaves the account. Pre-check the overdraft so the
      -- error names the account and the shortfall (trg_txn_overdraft would fire
      -- regardless, but only knows the portfolio uuid).
      if not pf.allow_negative and pf.current_balance < _principal then
        raise exception 'Insufficient funds: % holds % but you are lending %',
          pf.name, pf.current_balance, _principal;
      end if;

      -- Self-healing system category, same pattern as create_transfer's
      -- 'Transfer Fee'. expenses.category_id is NOT NULL, so lending needs a
      -- home even for a user who deleted every default category.
      select id into v_cat_id from public.expense_categories
        where user_id = _user_id and is_active and lower(name) = 'money lent' limit 1;
      if v_cat_id is null then
        insert into public.expense_categories(user_id, name, is_system_default)
        values (_user_id, 'Money Lent', true) returning id into v_cat_id;
      end if;

      insert into public.transactions
        (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
      values
        (_user_id, pf.id, 'expense', 'outflow', _principal, pf.currency_id, v_date,
         'Lent to ' || trim(_counterparty))
      returning id into v_txn_id;

      insert into public.expenses
        (user_id, transaction_id, txn_kind, category_id, debt_id, is_bill)
      values
        (_user_id, v_txn_id, 'expense', v_cat_id, v_debt_id, false);
    end if;
  end if;

  return jsonb_build_object(
    'debt_id',        v_debt_id,
    'transaction_id', v_txn_id   -- null when the debt is record-only
  );
end $$;

-- Lock down execution to service_role only (the gateway-fronted service caller).
revoke all on function public.create_debt(uuid, public.debt_kind, text, numeric, uuid, numeric, date, text, uuid, date) from public;
grant execute on function public.create_debt(uuid, public.debt_kind, text, numeric, uuid, numeric, date, text, uuid, date) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
