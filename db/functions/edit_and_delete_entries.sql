-- ============================================================================
-- edit_and_delete_entries — correcting and removing entries you already made.
--
-- Run this in the Supabase SQL Editor LAST, after custom_option_labels.sql. It
-- reads columns that earlier files add (incomes.source_label from
-- custom_option_labels.sql, expenses.investment_id from money_invested.sql) and
-- re-uses the same find-or-create category rule create_expense() defines, so
-- every one of them has to exist first. It defines only NEW objects — nothing
-- here is a redefinition of something schema.sql creates, so re-running
-- schema.sql cannot revert it.
--
-- WHY THIS FILE EXISTS
-- Until now the app could only ever ADD. Typing 1,500 instead of 150 left you
-- with no way to fix it: `transactions` has no delete policy (policies.sql §5)
-- and trg_txn_immutable rejects any change to portfolio, kind, direction,
-- amount, currency or date. That is the right default — it stops a client
-- rewriting money history — but it left the owner of the data unable to correct
-- their own typo.
--
-- HOW A CORRECTION WORKS: THE LEDGER ROW IS REPLACED, NOT MUTATED
-- trg_txn_immutable is a table trigger, so SECURITY DEFINER does not get around
-- it and nothing here tries to. A money-changing edit instead does, in ONE
-- transaction:
--
--     1. void the old row      -> trg_txn_balance reverses its effect
--     2. insert the new row    -> trg_txn_overdraft sees the freed balance
--     3. repoint the detail row at the new transaction
--     4. delete the old row    -> already void, so the balance does not move
--
-- Step 1 before step 2 is the whole trick. Doing it the other way round means
-- raising an expense from 100 to 120 on an account holding exactly 100 is
-- rejected for insufficient funds, because both rows are briefly live — a
-- change that nets out to -20 would fail on an account that can afford it.
--
-- A descriptive-only edit (note, merchant, category, source) skips all of that
-- and updates in place: `transactions.description` is deliberately NOT in
-- trg_txn_immutable's tuple, so it was always editable.
--
-- WHAT IS AUDITED
-- trg_audit_transactions logs the void, the insert and the delete (schema.sql
-- §14/§15). The before-and-after of every correction is therefore in audit_log
-- even though the ledger row itself is gone — which is what makes deleting
-- acceptable here rather than accumulating voided rows every list, view and
-- export would then have to learn to filter.
--
-- WHAT CANNOT BE EDITED HERE, AND WHY
-- An expense carrying `debt_id` is create_debt()'s lending leg; one carrying
-- `investment_id` is create_investment()'s purchase leg; an income carrying
-- `debt_id` or source='loan_received' is a debt disbursement. All four are the
-- cash side of a record that lives somewhere else, and editing one from
-- /expenses or /income would desynchronise it from its debt or holding. They
-- are rejected with a message naming the page that does own them.
--
-- Transfers and debt payments have no editor at all: a transfer is three ledger
-- rows that must move together, and debt_payments.transaction_id is
-- `on delete restrict` precisely so a payment's cash cannot be dropped from
-- under it. Both still archive or repost rather than edit.
--
-- Security: the create_*/update_*/delete_* functions take _user_id and are
-- granted to service_role only; the do_* wrappers take no user id and derive it
-- from auth.uid(). Identical contract to authenticated_entry_points.sql — keep
-- it that way, since a _user_id parameter on a wrapper is a cross-tenant write.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. EXPENSES
-- ---------------------------------------------------------------------------

-- The patch arrives as jsonb rather than as twenty defaulted parameters so that
-- "leave this alone" and "set this to null" stay distinguishable: `_patch ? 'x'`
-- is the presence test a nullable scalar parameter cannot express. Both
-- transports already build exactly this object.
create or replace function public.update_expense(
  _user_id    uuid,
  _expense_id uuid,
  _patch      jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  e           record;
  t           record;
  v_portfolio uuid;
  v_currency  uuid;
  v_amount    numeric;
  v_date      date;
  v_desc      text;
  v_merchant  text;
  v_cat_id    uuid;
  v_txn_id    uuid;
  v_replaced  boolean;
  -- Collapsed exactly as create_expense() collapses it: the find-or-create
  -- below matches on lower(name), so "pet   CARE" must not file a near-duplicate
  -- next to "Pet care".
  v_new_name  text := nullif(regexp_replace(btrim(_patch->>'new_category'), '\s+', ' ', 'g'), '');
begin
  select * into e from public.expenses where id = _expense_id and user_id = _user_id;
  if e.id is null then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  -- The two ledger legs owned by another feature. See the header.
  if e.investment_id is not null then
    raise exception 'This entry is an investment purchase. Edit it on the investment instead.';
  end if;
  if e.debt_id is not null then
    raise exception 'This entry is money you lent. Edit it on the debt instead.';
  end if;

  select * into t from public.transactions where id = e.transaction_id;
  if t.id is null then
    raise exception 'Expense has no ledger row' using errcode = 'P0002';
  end if;

  -- Account: also re-derives the currency, because moving an expense to an
  -- account in another currency has to move the transaction's currency with it
  -- or trg_txn_currency (BR17) rejects the insert.
  v_portfolio := coalesce(nullif(_patch->>'portfolio_id', '')::uuid, t.portfolio_id);
  select currency_id into v_currency
  from public.portfolios
  where id = v_portfolio and user_id = _user_id and not is_archived;
  if v_currency is null then
    raise exception 'Account not found or archived' using errcode = 'P0002';
  end if;

  v_amount := coalesce(nullif(_patch->>'amount', '')::numeric, t.amount);
  if v_amount is null or v_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  v_date := coalesce(nullif(_patch->>'txn_date', '')::date, t.txn_date);

  -- Present-but-null clears; absent keeps. Blank strings are treated as null so
  -- an emptied text input does not store "".
  v_desc := case when _patch ? 'description'
                 then nullif(btrim(_patch->>'description'), '')
                 else t.description end;
  v_merchant := case when _patch ? 'merchant'
                     then nullif(btrim(_patch->>'merchant'), '')
                     else e.merchant end;

  -- Category: an existing id wins over a typed name, the same precedence
  -- create_expense() applies, so a form sending both cannot spawn a duplicate.
  if nullif(_patch->>'category_id', '') is not null then
    v_cat_id := (_patch->>'category_id')::uuid;
    if not exists (
      select 1 from public.expense_categories
      where id = v_cat_id and user_id = _user_id and is_active
    ) then
      raise exception 'Category not found' using errcode = 'P0002';
    end if;
  elsif v_new_name is not null then
    if char_length(v_new_name) > 40 then
      raise exception 'Category name must be 40 characters or fewer';
    end if;
    select id into v_cat_id
    from public.expense_categories
    where user_id = _user_id and lower(name) = lower(v_new_name) and is_active;
    if v_cat_id is null then
      insert into public.expense_categories (user_id, name, is_system_default)
      values (_user_id, v_new_name, false)
      returning id into v_cat_id;
    end if;
  else
    v_cat_id := e.category_id;
  end if;

  -- Only these three live in the ledger row. Everything else is detail, and
  -- detail is editable in place.
  v_replaced := (v_portfolio, v_amount, v_date)
                is distinct from (t.portfolio_id, t.amount, t.txn_date);

  if v_replaced then
    -- Void BEFORE inserting the replacement — see the header for why the order
    -- is load-bearing rather than stylistic.
    update public.transactions set is_void = true where id = t.id;

    insert into public.transactions
      (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
    values
      (_user_id, v_portfolio, 'expense', 'outflow', v_amount, v_currency, v_date, v_desc)
    returning id into v_txn_id;

    -- Repoint before the delete, or the cascade on transaction_id takes the
    -- expense row with it and there is nothing left to correct.
    update public.expenses
       set transaction_id = v_txn_id, category_id = v_cat_id, merchant = v_merchant
     where id = _expense_id;

    delete from public.transactions where id = t.id;
  else
    v_txn_id := t.id;
    update public.transactions set description = v_desc where id = t.id;
    update public.expenses
       set category_id = v_cat_id, merchant = v_merchant
     where id = _expense_id;
  end if;

  return jsonb_build_object(
    'expense_id',     _expense_id,
    'transaction_id', v_txn_id,
    'category_id',    v_cat_id,
    -- True when the ledger row was replaced, i.e. a balance actually moved.
    -- The caller uses it to decide what to revalidate.
    'ledger_replaced', v_replaced);
end $$;

create or replace function public.delete_expense(
  _user_id    uuid,
  _expense_id uuid
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  e record;
  t record;
begin
  select * into e from public.expenses where id = _expense_id and user_id = _user_id;
  if e.id is null then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if e.investment_id is not null then
    raise exception 'This entry is an investment purchase. Delete it from the investment instead.';
  end if;
  if e.debt_id is not null then
    raise exception 'This entry is money you lent. Manage it on the debt instead.';
  end if;

  select * into t from public.transactions where id = e.transaction_id;

  -- One delete does both: expenses.transaction_id is `on delete cascade`, so the
  -- detail row goes with it, and trg_txn_balance credits the account back. No
  -- overdraft check is needed — removing an outflow can only raise a balance.
  delete from public.transactions where id = e.transaction_id;

  return jsonb_build_object(
    'expense_id',     _expense_id,
    'transaction_id', e.transaction_id,
    'portfolio_id',   t.portfolio_id,
    'amount',         t.amount);
end $$;

-- ---------------------------------------------------------------------------
-- 2. INCOME
-- ---------------------------------------------------------------------------

create or replace function public.update_income(
  _user_id   uuid,
  _income_id uuid,
  _patch     jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  i           record;
  t           record;
  pf          record;
  v_portfolio uuid;
  v_currency  uuid;
  v_amount    numeric;
  v_date      date;
  v_desc      text;
  v_source    public.income_source;
  v_name      text;
  v_recurring boolean;
  v_label     text;
  v_txn_id    uuid;
  v_replaced  boolean;
  v_projected numeric;
begin
  select * into i from public.incomes where id = _income_id and user_id = _user_id;
  if i.id is null then
    raise exception 'Income entry not found' using errcode = 'P0002';
  end if;
  -- Debt-linked income is create_debt()'s disbursement leg, and a
  -- 'debt_payment_received' row is create_debt_payment()'s. Both belong to a
  -- debt whose outstanding balance would silently disagree if this edited them.
  if i.debt_id is not null or i.source = 'loan_received' or i.txn_kind <> 'income' then
    raise exception 'This entry belongs to a debt. Edit it on the debt instead.';
  end if;

  select * into t from public.transactions where id = i.transaction_id;
  if t.id is null then
    raise exception 'Income entry has no ledger row' using errcode = 'P0002';
  end if;

  v_portfolio := coalesce(nullif(_patch->>'portfolio_id', '')::uuid, t.portfolio_id);
  select currency_id into v_currency
  from public.portfolios
  where id = v_portfolio and user_id = _user_id and not is_archived;
  if v_currency is null then
    raise exception 'Account not found or archived' using errcode = 'P0002';
  end if;

  v_amount := coalesce(nullif(_patch->>'amount', '')::numeric, t.amount);
  if v_amount is null or v_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  v_date := coalesce(nullif(_patch->>'txn_date', '')::date, t.txn_date);
  v_desc := case when _patch ? 'description'
                 then nullif(btrim(_patch->>'description'), '')
                 else t.description end;
  v_name := case when _patch ? 'source_name'
                 then nullif(btrim(_patch->>'source_name'), '')
                 else i.source_name end;
  v_recurring := case when _patch ? 'is_recurring'
                      then coalesce((_patch->>'is_recurring')::boolean, false)
                      else i.is_recurring end;

  v_source := coalesce(nullif(_patch->>'source', '')::public.income_source, i.source);
  if v_source = 'loan_received' then
    raise exception 'Borrowing is recorded on /debts, not as income';
  end if;

  v_label := case when _patch ? 'source_label'
                  then nullif(regexp_replace(btrim(_patch->>'source_label'), '\s+', ' ', 'g'), '')
                  else i.source_label end;
  if v_label is not null and v_source <> 'other' then
    if _patch ? 'source_label' then
      raise exception 'A custom source name only applies to the "Other" source';
    end if;
    -- Re-classified away from the catch-all without touching the label: it has
    -- to be cleared in the same statement or incomes_source_label_only_other
    -- rejects the update with a constraint name instead of a sentence.
    v_label := null;
  end if;
  if v_label is not null and char_length(v_label) > 40 then
    raise exception 'Source name must be 40 characters or fewer';
  end if;

  v_replaced := (v_portfolio, v_amount, v_date)
                is distinct from (t.portfolio_id, t.amount, t.txn_date);

  if v_replaced then
    -- Reducing or moving an INFLOW lowers a balance, so this can overdraw an
    -- account whose money has already been spent. trg_txn_overdraft catches it
    -- on the void below, but only knows the portfolio's uuid — check first so
    -- the message names the account and the shortfall.
    select p.name, p.allow_negative, p.current_balance into pf
      from public.portfolios p where p.id = t.portfolio_id for update;
    v_projected := pf.current_balance - t.amount
                   + case when v_portfolio = t.portfolio_id then v_amount else 0 end;
    if not pf.allow_negative and v_projected < 0 then
      raise exception 'This change would leave % at %. Adjust what it paid for first.',
        pf.name, v_projected;
    end if;

    update public.transactions set is_void = true where id = t.id;

    insert into public.transactions
      (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
    values
      (_user_id, v_portfolio, 'income', 'inflow', v_amount, v_currency, v_date, v_desc)
    returning id into v_txn_id;

    update public.incomes
       set transaction_id = v_txn_id, source = v_source, source_name = v_name,
           is_recurring = v_recurring, source_label = v_label
     where id = _income_id;

    delete from public.transactions where id = t.id;
  else
    v_txn_id := t.id;
    update public.transactions set description = v_desc where id = t.id;
    update public.incomes
       set source = v_source, source_name = v_name,
           is_recurring = v_recurring, source_label = v_label
     where id = _income_id;
  end if;

  return jsonb_build_object(
    'income_id',       _income_id,
    'transaction_id',  v_txn_id,
    'ledger_replaced', v_replaced);
end $$;

create or replace function public.delete_income(
  _user_id   uuid,
  _income_id uuid
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  i  record;
  t  record;
  pf record;
begin
  select * into i from public.incomes where id = _income_id and user_id = _user_id;
  if i.id is null then
    raise exception 'Income entry not found' using errcode = 'P0002';
  end if;
  if i.debt_id is not null or i.source = 'loan_received' or i.txn_kind <> 'income' then
    raise exception 'This entry belongs to a debt. Manage it on the debt instead.';
  end if;

  select * into t from public.transactions where id = i.transaction_id;

  -- trg_txn_overdraft is BEFORE INSERT OR UPDATE only — a DELETE that drives the
  -- balance negative would go through unremarked. This is the guard for it.
  select p.name, p.allow_negative, p.current_balance into pf
    from public.portfolios p where p.id = t.portfolio_id for update;
  if not pf.allow_negative and (pf.current_balance - t.amount) < 0 then
    raise exception 'Deleting this would leave % at %. Remove what it paid for first.',
      pf.name, (pf.current_balance - t.amount);
  end if;

  delete from public.transactions where id = i.transaction_id;

  return jsonb_build_object(
    'income_id',      _income_id,
    'transaction_id', i.transaction_id,
    'portfolio_id',   t.portfolio_id,
    'amount',         t.amount);
end $$;

-- ---------------------------------------------------------------------------
-- 3. INVESTMENTS
--
-- Editing a holding was already possible — both transports PATCH the table
-- directly — but that write knew nothing about the funding leg
-- money_invested.sql posts, so correcting "amount invested" from 50,000 to
-- 60,000 left the paying account 10,000 too high. This replaces that direct
-- write on both transports so the cash and the cost basis cannot disagree.
-- ---------------------------------------------------------------------------

create or replace function public.update_investment(
  _user_id       uuid,
  _investment_id uuid,
  _patch         jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  inv           record;
  fund          record;
  pf            record;
  v_name        text;
  v_kind        public.investment_kind;
  v_label       text;
  v_symbol      text;
  v_quantity    numeric;
  v_avg_cost    numeric;
  v_invested    numeric;
  v_opened      date;
  v_maturity    date;
  v_portfolio   uuid;
  v_active      boolean;
  v_touches_cash boolean;
  v_has_snaps   boolean;
  v_cat_id      uuid;
  v_txn_id      uuid;
  v_cash_moved  boolean := false;
begin
  select * into inv from public.investments
   where id = _investment_id and user_id = _user_id;
  if inv.id is null then
    raise exception 'Investment not found' using errcode = 'P0002';
  end if;

  v_name := case when _patch ? 'name' then btrim(_patch->>'name') else inv.name end;
  if v_name is null or char_length(v_name) = 0 then
    raise exception 'Give the investment a name';
  end if;

  v_kind := coalesce(nullif(_patch->>'kind', '')::public.investment_kind, inv.kind);
  v_label := case when _patch ? 'kind_label'
                  then nullif(regexp_replace(btrim(_patch->>'kind_label'), '\s+', ' ', 'g'), '')
                  else inv.kind_label end;
  if v_label is not null and v_kind <> 'other_asset' then
    if _patch ? 'kind_label' then
      raise exception 'A custom type name only applies to the "Other" type';
    end if;
    -- Same rule as update_income's source_label: re-classifying away from the
    -- catch-all must clear the name in the SAME statement, or
    -- investment_kind_label_only_other rejects the update.
    v_label := null;
  end if;
  if v_label is not null and char_length(v_label) > 40 then
    raise exception 'Type name must be 40 characters or fewer';
  end if;

  v_symbol := case when _patch ? 'symbol'
                   then nullif(btrim(_patch->>'symbol'), '') else inv.symbol end;
  v_quantity := case when _patch ? 'quantity'
                     then nullif(_patch->>'quantity', '')::numeric else inv.quantity end;
  v_avg_cost := case when _patch ? 'average_cost'
                     then nullif(_patch->>'average_cost', '')::numeric else inv.average_cost end;
  v_maturity := case when _patch ? 'maturity_date'
                     then nullif(_patch->>'maturity_date', '')::date else inv.maturity_date end;
  v_opened := case when _patch ? 'opened_on'
                   then nullif(_patch->>'opened_on', '')::date else inv.opened_on end;
  v_invested := coalesce(nullif(_patch->>'invested_amount', '')::numeric, inv.invested_amount);
  v_portfolio := case when _patch ? 'portfolio_id'
                      then nullif(_patch->>'portfolio_id', '')::uuid else inv.portfolio_id end;
  v_active := case when _patch ? 'is_active'
                   then coalesce((_patch->>'is_active')::boolean, inv.is_active)
                   else inv.is_active end;

  if v_invested < 0 then
    raise exception 'Amount invested cannot be negative';
  end if;
  if v_quantity is not null and v_quantity < 0 then
    raise exception 'Quantity cannot be negative';
  end if;
  if v_avg_cost is not null and v_avg_cost < 0 then
    raise exception 'Average cost cannot be negative';
  end if;

  -- The purchase leg this holding already posted, if any. Record-only holdings
  -- and everything created before money_invested.sql have none.
  select e.id as expense_id, e.transaction_id, t.portfolio_id, t.amount, t.txn_date
    into fund
    from public.expenses e
    join public.transactions t on t.id = e.transaction_id
   where e.investment_id = _investment_id and e.user_id = _user_id
   order by t.txn_date, t.created_at
   limit 1;

  -- First gate: the patch has to MENTION a cash field. Close/reopen and any
  -- other narrow patch send none of the three and must never move money, not
  -- even to repair a holding whose leg is already out of step.
  v_touches_cash := _patch ? 'portfolio_id'
                 or _patch ? 'invested_amount'
                 or _patch ? 'opened_on';

  -- Second gate, inside: a holding with NO leg only gets one when the paying
  -- account itself CHANGES. Two cases depend on this and pull in opposite
  -- directions — the edit form posts every field on every save, so mentioning a
  -- field says nothing about intent:
  --
  --   record-only holding, user picks an account   -> post the purchase (asked for)
  --   holding from before money_invested.sql, user
  --   fixes a typo in the name or the cost basis   -> post NOTHING. It carries a
  --                                                   portfolio_id that was only
  --                                                   ever a label, and money
  --                                                   left that account years ago
  --                                                   if it left at all.
  --
  -- A holding that DOES have a leg is kept in step unconditionally, which is the
  -- correctness fix this function exists for.
  if v_touches_cash then
    if v_portfolio is not null and v_invested > 0 then
      select p.* into pf from public.portfolios p
        where p.id = v_portfolio and p.user_id = _user_id and not p.is_archived
        for update;
      if pf.id is null then
        raise exception 'Account not found, archived, or not owned by you' using errcode = 'P0002';
      end if;
      if pf.currency_id <> inv.currency_id then
        raise exception 'The funding account must hold the same currency as the investment';
      end if;
    end if;

    if fund.expense_id is not null
       and (v_portfolio is null or v_invested = 0) then
      -- The purchase is being un-recorded: give the cash back and leave the
      -- holding as record-only.
      delete from public.transactions where id = fund.transaction_id;
      v_cash_moved := true;

    elsif v_portfolio is not null and v_invested > 0
       and ((fund.expense_id is not null
             and (v_portfolio, v_invested, coalesce(v_opened, fund.txn_date))
                 is distinct from (fund.portfolio_id, fund.amount, fund.txn_date))
            -- The no-leg case: only an actual CHANGE of paying account counts as
            -- "record the payment now". See the two-case note above.
            or (fund.expense_id is null
                and v_portfolio is distinct from inv.portfolio_id)) then

      -- Self-healing system category, identical to create_investment's.
      select id into v_cat_id from public.expense_categories
        where user_id = _user_id and is_active and lower(name) = 'money invested' limit 1;
      if v_cat_id is null then
        insert into public.expense_categories(user_id, name, is_system_default)
        values (_user_id, 'Money Invested', true) returning id into v_cat_id;
      end if;

      if fund.expense_id is not null then
        -- Void first, for the same reason update_expense does: raising the cost
        -- basis must not be rejected by an overdraft the old row is causing.
        update public.transactions set is_void = true where id = fund.transaction_id;
      end if;

      insert into public.transactions
        (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
      values
        (_user_id, v_portfolio, 'expense', 'outflow', v_invested, pf.currency_id,
         coalesce(v_opened, fund.txn_date, current_date), 'Bought ' || v_name)
      returning id into v_txn_id;

      if fund.expense_id is not null then
        update public.expenses
           set transaction_id = v_txn_id, category_id = v_cat_id
         where id = fund.expense_id;
        delete from public.transactions where id = fund.transaction_id;
      else
        insert into public.expenses
          (user_id, transaction_id, txn_kind, category_id, investment_id, is_bill)
        values
          (_user_id, v_txn_id, 'expense', v_cat_id, _investment_id, false);
      end if;
      v_cash_moved := true;
    end if;
  end if;

  -- current_value belongs to sync_investment_current_value() from the first
  -- snapshot onward. Before that it is just the seed create_investment() set to
  -- the amount invested, so a corrected cost basis has to carry it along —
  -- otherwise fixing 50,000 to 60,000 invents a 10,000 unrealised loss.
  select exists (
    select 1 from public.investment_snapshots where investment_id = _investment_id
  ) into v_has_snaps;

  update public.investments
     set name            = v_name,
         kind            = v_kind,
         kind_label      = v_label,
         symbol          = v_symbol,
         quantity        = v_quantity,
         average_cost    = v_avg_cost,
         invested_amount = v_invested,
         current_value   = case when v_has_snaps then current_value else v_invested end,
         opened_on       = v_opened,
         maturity_date   = v_maturity,
         portfolio_id    = v_portfolio,
         is_active       = v_active
   where id = _investment_id;

  return jsonb_build_object(
    'investment_id', _investment_id,
    -- True when a balance moved, so the caller knows to revalidate /portfolios
    -- and /expenses as well as the investment pages.
    'cash_moved',    v_cash_moved);
end $$;

create or replace function public.delete_investment(
  _user_id       uuid,
  _investment_id uuid
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  inv       record;
  v_txns    uuid[];
  v_txn     uuid;
  v_snaps   integer := 0;
  v_refunds integer := 0;
begin
  select * into inv from public.investments
   where id = _investment_id and user_id = _user_id;
  if inv.id is null then
    raise exception 'Investment not found' using errcode = 'P0002';
  end if;

  select count(*) into v_snaps
    from public.investment_snapshots where investment_id = _investment_id;

  -- The purchase goes with the holding. expenses.investment_id is
  -- `on delete set null`, so leaving the leg behind would turn it into an
  -- ordinary expense — and v_cashflow / v_expense_by_category exclude asset
  -- purchases by exactly that column, so the row would start reading as
  -- spending the moment the holding disappeared.
  --
  -- Collected into an array BEFORE deleting anything: deleting a transaction
  -- cascades into `expenses`, and iterating a cursor over the very table the
  -- cascade is removing rows from is not something to rely on.
  select coalesce(array_agg(t.id), '{}') into v_txns
    from public.expenses e
    join public.transactions t on t.id = e.transaction_id
   where e.investment_id = _investment_id and e.user_id = _user_id;

  foreach v_txn in array v_txns loop
    delete from public.transactions where id = v_txn;
    v_refunds := v_refunds + 1;
  end loop;

  -- Cascades investment_snapshots (schema.sql §12).
  delete from public.investments where id = _investment_id;

  return jsonb_build_object(
    'investment_id',       _investment_id,
    'snapshots_deleted',   v_snaps,
    'purchases_reversed',  v_refunds);
end $$;

-- ---------------------------------------------------------------------------
-- 4. RLS-PATH WRAPPERS
--     Same contract as authenticated_entry_points.sql: no _user_id parameter,
--     the tenant is always auth.uid(). SECURITY DEFINER is what lets them reach
--     the functions above, which `authenticated` cannot call directly.
-- ---------------------------------------------------------------------------

create or replace function public.do_expense_update(_expense_id uuid, _patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.update_expense(v_uid, _expense_id, _patch);
end $$;

create or replace function public.do_expense_delete(_expense_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.delete_expense(v_uid, _expense_id);
end $$;

create or replace function public.do_income_update(_income_id uuid, _patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.update_income(v_uid, _income_id, _patch);
end $$;

create or replace function public.do_income_delete(_income_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.delete_income(v_uid, _income_id);
end $$;

create or replace function public.do_investment_update(_investment_id uuid, _patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.update_investment(v_uid, _investment_id, _patch);
end $$;

create or replace function public.do_investment_delete(_investment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.delete_investment(v_uid, _investment_id);
end $$;

-- ---------------------------------------------------------------------------
-- 5. GRANTS — the _user_id functions to service_role, the wrappers to users.
-- ---------------------------------------------------------------------------

revoke all on function public.update_expense(uuid, uuid, jsonb) from public;
grant execute on function public.update_expense(uuid, uuid, jsonb) to service_role;

revoke all on function public.delete_expense(uuid, uuid) from public;
grant execute on function public.delete_expense(uuid, uuid) to service_role;

revoke all on function public.update_income(uuid, uuid, jsonb) from public;
grant execute on function public.update_income(uuid, uuid, jsonb) to service_role;

revoke all on function public.delete_income(uuid, uuid) from public;
grant execute on function public.delete_income(uuid, uuid) to service_role;

revoke all on function public.update_investment(uuid, uuid, jsonb) from public;
grant execute on function public.update_investment(uuid, uuid, jsonb) to service_role;

revoke all on function public.delete_investment(uuid, uuid) from public;
grant execute on function public.delete_investment(uuid, uuid) to service_role;

revoke all on function public.do_expense_update(uuid, jsonb) from public;
grant execute on function public.do_expense_update(uuid, jsonb) to authenticated;

revoke all on function public.do_expense_delete(uuid) from public;
grant execute on function public.do_expense_delete(uuid) to authenticated;

revoke all on function public.do_income_update(uuid, jsonb) from public;
grant execute on function public.do_income_update(uuid, jsonb) to authenticated;

revoke all on function public.do_income_delete(uuid) from public;
grant execute on function public.do_income_delete(uuid) to authenticated;

revoke all on function public.do_investment_update(uuid, jsonb) from public;
grant execute on function public.do_investment_update(uuid, jsonb) to authenticated;

revoke all on function public.do_investment_delete(uuid) from public;
grant execute on function public.do_investment_delete(uuid) to authenticated;

-- Ask PostgREST to reload its schema cache so the new RPCs are callable.
notify pgrst, 'reload schema';
