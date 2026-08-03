-- ============================================================================
-- debt_editing_and_adjustments — correcting a debt after the fact.
--
-- Run this in the Supabase SQL Editor AFTER edit_and_delete_entries.sql. It
-- needs `debts`, `debt_payments` and the create_debt legs, and it REPLACES
-- recompute_debt() — so anything that re-applies the old definition after this
-- (schema.sql §15c, db/functions/debt_principal_recompute.sql) must carry the
-- new one too. All three copies are kept byte-identical on purpose; see
-- MAINTENANCE §1.
--
-- TWO THINGS THIS ADDS
--
-- 1. RE-TAGGING A DEBT  (payable <-> receivable)
--    `kind` was never patchable, and not by oversight: it decides the DIRECTION
--    of every ledger row hanging off the debt.
--
--        payable     disbursement = cash IN  ('income' + incomes.debt_id)
--                    each payment  = cash OUT ('debt_payment_made')
--        receivable  disbursement = cash OUT ('expense' + expenses.debt_id)
--                    each payment  = cash IN  ('debt_payment_received')
--
--    So a 10,000 payable that was disbursed put +10,000 into an account; the
--    same debt re-tagged receivable should have taken 10,000 OUT. Flipping the
--    word alone would leave the ledger contradicting the debt. update_debt()
--    therefore re-posts every leg in the opposite direction, and a record-only
--    debt (no disbursement, no payments) simply changes one word.
--
-- 2. ADJUSTING WHAT IS OWED WITHOUT MOVING CASH
--    `outstanding_balance` is DERIVED, not stored-and-edited: recompute_debt()
--    rebuilds it from the principal and the payments, and re-runs on every
--    payment and on any principal edit. Writing to the column directly is
--    pointless — the next payment overwrites it. So corrections have to change
--    an INPUT, and until now the only cash-free input was the principal, which
--    says "the debt was always this much" and is wrong for interest or for a
--    payment made outside the app.
--
--    `debt_adjustments` is that missing input: a signed, cash-free line.
--
--        +2,500  interest        the debt grew
--        -5,000  payment_off_app you paid, but not through this app
--        -all    forgiven        written down
--
--    Deliberately NOT modelled as a debt_payments row with a null
--    transaction_id. That column is `not null` AND `on delete restrict` by
--    explicit design ("every payment is backed by a ledger row", schema.sql
--    §10), and a payment with no ledger row would also render in the payment
--    history with no account against it. A separate table breaks no existing
--    constraint and reads honestly.
--
-- Security: create_*/update_*/delete_* take _user_id and are service_role only;
-- the do_* wrappers take no user id and derive it from auth.uid(). Same contract
-- as authenticated_entry_points.sql — keep it that way.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE ADJUSTMENT LINE
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'debt_adjustment_reason') then
    create type public.debt_adjustment_reason as enum (
      'interest',         -- the debt grew: interest accrued
      'fee',              -- the debt grew: a charge, penalty or fee
      'payment_off_app',  -- settled outside this app (cash, another bank)
      'forgiven',         -- written down by agreement
      'correction'        -- neither party moved; the figure was simply wrong
    );
  end if;
end $$;

create table if not exists public.debt_adjustments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  debt_id        uuid not null references public.debts(id) on delete cascade,
  -- SIGNED, and that is the whole design: positive grows what is owed, negative
  -- settles part of it. One column rather than an amount plus a direction flag,
  -- because every consumer wants the net and none of them wants to re-derive it.
  amount         numeric(38,18) not null,
  reason         public.debt_adjustment_reason not null,
  effective_on   date not null default current_date,
  note           text,
  created_at     timestamptz not null default now(),
  -- Zero would be a no-op line that still shows up in the history.
  constraint debt_adj_nonzero check (amount <> 0),
  -- The sign and the reason must agree, or a "-2,500 interest" line would read
  -- as the debt growing while it shrank. This is the constraint that keeps the
  -- charges/credits split in recompute_debt() meaningful.
  constraint debt_adj_sign_matches_reason check (
    (reason in ('interest', 'fee') and amount > 0)
    or (reason in ('payment_off_app', 'forgiven') and amount < 0)
    or reason = 'correction'
  )
);
create index if not exists idx_debt_adj_debt on public.debt_adjustments(debt_id, effective_on);
create index if not exists idx_debt_adj_user on public.debt_adjustments(user_id);

-- Owner reads; writes go through the RPCs below, exactly like debt_payments and
-- transfers. Mirrored into db/policies.sql §6 for a fresh install.
alter table public.debt_adjustments enable row level security;
drop policy if exists debt_adj_select on public.debt_adjustments;
create policy debt_adj_select on public.debt_adjustments
  for select to authenticated using (user_id = auth.uid());
grant select on public.debt_adjustments to authenticated;

-- Same audit treatment as every other money table (schema.sql §14).
drop trigger if exists trg_audit_debt_adjustments on public.debt_adjustments;
create trigger trg_audit_debt_adjustments
  after insert or update or delete on public.debt_adjustments
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- 2. recompute_debt — now aware of adjustments
--
-- KEEP BYTE-IDENTICAL to schema.sql §15c and
-- db/functions/debt_principal_recompute.sql. If they drift, re-running either of
-- those silently reverts this and every adjustment stops counting.
--
-- Behaviour is unchanged for a debt with no adjustments: charges and credits are
-- both zero, so gross = principal, settled = principal_paid, and `settled > 0`
-- is true exactly when the old `outstanding < principal` test was.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_debt(_debt_id uuid)
returns void language plpgsql set search_path = public as $$
declare
  v_principal      numeric(38,18);
  v_charges        numeric(38,18);
  v_credits        numeric(38,18);
  v_gross          numeric(38,18);
  v_principal_paid numeric(38,18);
  v_settled        numeric(38,18);
  v_outstanding    numeric(38,18);
  v_new_status     public.debt_status;
begin
  select principal_amount into v_principal from public.debts where id = _debt_id;
  if v_principal is null then return; end if;

  -- Split by sign rather than summed into one net figure. The sign is what says
  -- whether the debt GREW (interest, a fee) or was partly SETTLED without cash
  -- moving here (paid off-app, forgiven) -- and that distinction is the only
  -- thing separating 'open' from 'partially_paid' below.
  select coalesce(sum(amount) filter (where amount > 0), 0),
         coalesce(sum(-amount) filter (where amount < 0), 0)
    into v_charges, v_credits
    from public.debt_adjustments where debt_id = _debt_id;

  -- Outstanding is reduced ONLY by principal portions, so paying interest never
  -- pays down principal (Rule 14). Self-healing recompute-from-sum.
  select coalesce(sum(principal_portion), 0) into v_principal_paid
    from public.debt_payments where debt_id = _debt_id;

  v_gross       := v_principal + v_charges;
  v_settled     := v_principal_paid + v_credits;
  v_outstanding := greatest(v_gross - v_settled, 0);

  if v_outstanding = 0 then v_new_status := 'settled';
  elsif v_settled > 0 then v_new_status := 'partially_paid';
  else v_new_status := 'open'; end if;

  update public.debts
    set outstanding_balance = v_outstanding,
        -- written_off is sticky: a recovery reduces the balance without
        -- pretending the debt was collected normally.
        status = case when status = 'written_off' then 'written_off' else v_new_status end
    where id = _debt_id;
end $$;
revoke all on function public.recompute_debt(uuid) from public;
grant execute on function public.recompute_debt(uuid) to service_role;

-- The adjustments-side trigger. recompute_debt_balance() reads
-- coalesce(new.debt_id, old.debt_id), and debt_adjustments carries debt_id — so
-- the existing trigger function works here unchanged.
drop trigger if exists trg_debt_adjustment_recompute on public.debt_adjustments;
create trigger trg_debt_adjustment_recompute
  after insert or update or delete on public.debt_adjustments
  for each row execute function public.recompute_debt_balance();

-- ---------------------------------------------------------------------------
-- 3. ADJUSTMENT RPCs
-- ---------------------------------------------------------------------------

create or replace function public.create_debt_adjustment(
  _user_id      uuid,
  _debt_id      uuid,
  _amount       numeric,
  _reason       public.debt_adjustment_reason,
  _effective_on date default current_date,
  _note         text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  d      record;
  v_id   uuid;
begin
  select * into d from public.debts where id = _debt_id and user_id = _user_id;
  if d.id is null then
    raise exception 'Debt not found' using errcode = 'P0002';
  end if;
  if d.is_archived then
    raise exception 'This debt is archived. Restore it before adjusting it.';
  end if;
  if _amount is null or _amount = 0 then
    raise exception 'Enter an amount to add to or take off the debt';
  end if;

  -- Caught here so the message names the field rather than a constraint.
  if _reason in ('interest', 'fee') and _amount < 0 then
    raise exception 'Interest and fees increase the debt — enter a positive amount';
  end if;
  if _reason in ('payment_off_app', 'forgiven') and _amount > 0 then
    raise exception 'A payment or write-down reduces the debt — enter a negative amount';
  end if;

  insert into public.debt_adjustments
    (user_id, debt_id, amount, reason, effective_on, note)
  values
    (_user_id, _debt_id, _amount, _reason, coalesce(_effective_on, current_date), _note)
  returning id into v_id;

  -- trg_debt_adjustment_recompute has already rebuilt these by now; read them
  -- back so the caller can show the result without a second round trip.
  select * into d from public.debts where id = _debt_id;

  return jsonb_build_object(
    'adjustment_id',     v_id,
    'outstanding_after', d.outstanding_balance,
    'status_after',      d.status);
end $$;

create or replace function public.delete_debt_adjustment(
  _user_id       uuid,
  _adjustment_id uuid
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  a record;
  d record;
begin
  select * into a from public.debt_adjustments
   where id = _adjustment_id and user_id = _user_id;
  if a.id is null then
    raise exception 'Adjustment not found' using errcode = 'P0002';
  end if;

  -- No cash is involved either way, so unlike deleting an income entry there is
  -- no balance to check — removing the line just re-derives the outstanding.
  delete from public.debt_adjustments where id = _adjustment_id;

  select * into d from public.debts where id = a.debt_id;

  return jsonb_build_object(
    'adjustment_id',     _adjustment_id,
    'debt_id',           a.debt_id,
    'outstanding_after', d.outstanding_balance,
    'status_after',      d.status);
end $$;

-- ---------------------------------------------------------------------------
-- 4. update_debt — the descriptive fields, and the re-tag
-- ---------------------------------------------------------------------------

create or replace function public.update_debt(
  _user_id uuid,
  _debt_id uuid,
  _patch   jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  d            record;
  disb         record;
  pay          record;
  pf           record;
  v_kind       public.debt_kind;
  v_party      text;
  v_principal  numeric(38,18);
  v_rate       numeric;
  v_due        date;
  v_note       text;
  v_archived   boolean;
  v_status     public.debt_status;
  v_flipped    boolean := false;
  v_legs       uuid[] := '{}';
  v_cat_id     uuid;
  v_txn_id     uuid;
  v_new_legs   uuid[] := '{}';
begin
  select * into d from public.debts where id = _debt_id and user_id = _user_id;
  if d.id is null then
    raise exception 'Debt not found' using errcode = 'P0002';
  end if;

  v_kind := coalesce(nullif(_patch->>'kind', '')::public.debt_kind, d.kind);
  v_party := case when _patch ? 'counterparty'
                  then btrim(_patch->>'counterparty') else d.counterparty end;
  if v_party is null or char_length(v_party) = 0 then
    raise exception 'Who is this debt with?';
  end if;

  v_principal := coalesce(nullif(_patch->>'principal_amount', '')::numeric, d.principal_amount);
  if v_principal <= 0 then
    raise exception 'Principal must be greater than zero';
  end if;

  v_rate := case when _patch ? 'interest_rate'
                 then nullif(_patch->>'interest_rate', '')::numeric else d.interest_rate end;
  if v_rate is not null and v_rate < 0 then
    raise exception 'Interest rate cannot be negative';
  end if;

  v_due := case when _patch ? 'due_date'
                then nullif(_patch->>'due_date', '')::date else d.due_date end;
  v_note := case when _patch ? 'note'
                 then nullif(btrim(_patch->>'note'), '') else d.note end;
  v_archived := case when _patch ? 'is_archived'
                     then coalesce((_patch->>'is_archived')::boolean, d.is_archived)
                     else d.is_archived end;

  -- 'settled' and 'partially_paid' belong to recompute_debt(); a hand-set value
  -- would be overwritten by the next payment and misreport until then.
  v_status := coalesce(nullif(_patch->>'status', '')::public.debt_status, d.status);
  if v_status <> d.status and v_status not in ('open', 'written_off') then
    raise exception 'A debt can only be reopened or written off by hand';
  end if;

  -- ---- the re-tag -------------------------------------------------------
  if v_kind <> d.kind then
    v_flipped := true;

    -- Every ledger row hanging off this debt: the disbursement (an incomes row
    -- for a payable, an expenses row for a receivable) and one per payment.
    select coalesce(array_agg(t.id), '{}') into v_legs
      from public.transactions t
     where t.user_id = _user_id
       and (exists (select 1 from public.incomes i
                     where i.transaction_id = t.id and i.debt_id = _debt_id)
         or exists (select 1 from public.expenses e
                     where e.transaction_id = t.id and e.debt_id = _debt_id)
         or exists (select 1 from public.debt_payments dp
                     where dp.transaction_id = t.id and dp.debt_id = _debt_id));

    if array_length(v_legs, 1) > 0 then
      -- Pre-check where each account LANDS, so a refusal names the account and
      -- the shortfall. trg_txn_overdraft catches it regardless, but it knows
      -- only a uuid — and this is the one edit where the size of the swing can
      -- genuinely surprise someone.
      --
      -- Every leg's sign inverts, so an account whose legs net to S ends at
      -- balance - 2S. That is also the LOWEST point the sequence reaches
      -- whenever S is positive (the case that can overdraw), so checking the
      -- landing balance is enough — no need to model each intermediate step.
      for pf in
        select p.name, p.allow_negative, p.current_balance,
               sum(t.signed_amount) as leg_total
          from public.transactions t
          join public.portfolios p on p.id = t.portfolio_id
         where t.id = any(v_legs) and not t.is_void
         group by p.name, p.allow_negative, p.current_balance
      loop
        if not pf.allow_negative
           and (pf.current_balance - 2 * pf.leg_total) < 0 then
          raise exception
            'Re-tagging reverses this debt''s disbursement and every payment, which would leave % at %. Adjust the account first.',
            pf.name, pf.current_balance - 2 * pf.leg_total;
        end if;
      end loop;

      -- Void the OUTFLOWS first and the inflows second. Voiding an outflow
      -- credits the account back, so doing those first maximises the balance
      -- available when the inflow voids (which debit it) are checked by
      -- trg_txn_overdraft. The reverse order can fail on a debt that nets out
      -- to nothing.
      update public.transactions set is_void = true
       where id = any(v_legs) and direction = 'outflow' and not is_void;
      update public.transactions set is_void = true
       where id = any(v_legs) and direction = 'inflow' and not is_void;
    end if;

    -- Rebuild the disbursement, if there was one.
    select t.id as txn_id, t.portfolio_id, t.amount, t.txn_date, t.currency_id
      into disb
      from public.transactions t
     where t.user_id = _user_id
       and (exists (select 1 from public.incomes i
                     where i.transaction_id = t.id and i.debt_id = _debt_id)
         or exists (select 1 from public.expenses e
                     where e.transaction_id = t.id and e.debt_id = _debt_id))
     limit 1;

    if disb.txn_id is not null then
      if v_kind = 'payable' then
        -- Now a borrowing: the cash lands in the account.
        insert into public.transactions
          (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date,
           description, is_void)
        values
          (_user_id, disb.portfolio_id, 'income', 'inflow', disb.amount,
           disb.currency_id, disb.txn_date, 'Borrowed from ' || v_party, true)
        returning id into v_txn_id;

        insert into public.incomes
          (user_id, transaction_id, txn_kind, source, source_name, debt_id)
        values
          (_user_id, v_txn_id, 'income', 'loan_received', v_party, _debt_id);
      else
        -- Now a lending: the cash leaves the account. Self-healing system
        -- category, same as create_debt's.
        select id into v_cat_id from public.expense_categories
          where user_id = _user_id and is_active and lower(name) = 'money lent' limit 1;
        if v_cat_id is null then
          insert into public.expense_categories(user_id, name, is_system_default)
          values (_user_id, 'Money Lent', true) returning id into v_cat_id;
        end if;

        insert into public.transactions
          (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date,
           description, is_void)
        values
          (_user_id, disb.portfolio_id, 'expense', 'outflow', disb.amount,
           disb.currency_id, disb.txn_date, 'Lent to ' || v_party, true)
        returning id into v_txn_id;

        insert into public.expenses
          (user_id, transaction_id, txn_kind, category_id, debt_id, is_bill)
        values
          (_user_id, v_txn_id, 'expense', v_cat_id, _debt_id, false);
      end if;
      v_new_legs := v_new_legs || v_txn_id;
      -- The old detail row cascades with its transaction.
      delete from public.transactions where id = disb.txn_id;
    end if;

    -- Rebuild each payment in the opposite direction.
    for pay in
      select dp.id, dp.transaction_id, dp.amount, dp.payment_date,
             t.portfolio_id, t.currency_id
        from public.debt_payments dp
        join public.transactions t on t.id = dp.transaction_id
       where dp.debt_id = _debt_id and dp.user_id = _user_id
       order by dp.payment_date, dp.created_at
    loop
      insert into public.transactions
        (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date,
         description, is_void)
      values
        (_user_id, pay.portfolio_id,
         -- Cast explicitly: a CASE over bare literals is `text`, and neither
         -- enum column takes an implicit cast from it.
         (case when v_kind = 'payable' then 'debt_payment_made'
               else 'debt_payment_received' end)::public.txn_kind,
         (case when v_kind = 'payable' then 'outflow'
               else 'inflow' end)::public.txn_direction,
         pay.amount, pay.currency_id, pay.payment_date,
         case when v_kind = 'payable' then 'Payment to ' || v_party
              else 'Payment from ' || v_party end,
         true)
      returning id into v_txn_id;

      -- Repoint BEFORE deleting: debt_payments.transaction_id is
      -- `on delete restrict`, so the old row will not budge while referenced.
      update public.debt_payments set transaction_id = v_txn_id where id = pay.id;
      delete from public.transactions where id = pay.transaction_id;
      v_new_legs := v_new_legs || v_txn_id;
    end loop;

    -- Everything was posted VOID so no intermediate state could trip the
    -- overdraft guard on a debt that nets out. Bring them live now, inflows
    -- first for the same reason the voids went outflows first.
    if array_length(v_new_legs, 1) > 0 then
      update public.transactions set is_void = false
       where id = any(v_new_legs) and direction = 'inflow';
      update public.transactions set is_void = false
       where id = any(v_new_legs) and direction = 'outflow';
    end if;
  end if;

  update public.debts
     set kind             = v_kind,
         counterparty     = v_party,
         principal_amount = v_principal,
         interest_rate    = v_rate,
         due_date         = v_due,
         note             = v_note,
         is_archived      = v_archived,
         status           = v_status
   where id = _debt_id;

  -- Un-writing-off cannot be taken at face value: 'open' is what the caller
  -- asks for, but a debt with payments or credits against it is really
  -- 'partially_paid'. A principal change fires the recompute trigger by itself;
  -- this covers the status-only case.
  if v_status = 'open' then
    perform public.recompute_debt(_debt_id);
  end if;

  select * into d from public.debts where id = _debt_id;

  return jsonb_build_object(
    'debt_id',           _debt_id,
    -- True when every ledger leg was re-posted in the opposite direction, i.e.
    -- account balances moved. The caller uses it to decide what to revalidate.
    'retagged',          v_flipped,
    'legs_reposted',     coalesce(array_length(v_new_legs, 1), 0),
    'outstanding_after', d.outstanding_balance,
    'status_after',      d.status);
end $$;

-- ---------------------------------------------------------------------------
-- 5. RLS-PATH WRAPPERS — no _user_id; the tenant is always auth.uid().
-- ---------------------------------------------------------------------------

create or replace function public.do_debt_update(_debt_id uuid, _patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.update_debt(v_uid, _debt_id, _patch);
end $$;

create or replace function public.do_debt_adjustment(
  _debt_id      uuid,
  _amount       numeric,
  _reason       public.debt_adjustment_reason,
  _effective_on date default current_date,
  _note         text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.create_debt_adjustment(
    v_uid, _debt_id, _amount, _reason, _effective_on, _note);
end $$;

create or replace function public.do_debt_adjustment_delete(_adjustment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return public.delete_debt_adjustment(v_uid, _adjustment_id);
end $$;

-- ---------------------------------------------------------------------------
-- 6. GRANTS
-- ---------------------------------------------------------------------------

revoke all on function public.update_debt(uuid, uuid, jsonb) from public;
grant execute on function public.update_debt(uuid, uuid, jsonb) to service_role;

revoke all on function public.create_debt_adjustment(
  uuid, uuid, numeric, public.debt_adjustment_reason, date, text) from public;
grant execute on function public.create_debt_adjustment(
  uuid, uuid, numeric, public.debt_adjustment_reason, date, text) to service_role;

revoke all on function public.delete_debt_adjustment(uuid, uuid) from public;
grant execute on function public.delete_debt_adjustment(uuid, uuid) to service_role;

revoke all on function public.do_debt_update(uuid, jsonb) from public;
grant execute on function public.do_debt_update(uuid, jsonb) to authenticated;

revoke all on function public.do_debt_adjustment(
  uuid, numeric, public.debt_adjustment_reason, date, text) from public;
grant execute on function public.do_debt_adjustment(
  uuid, numeric, public.debt_adjustment_reason, date, text) to authenticated;

revoke all on function public.do_debt_adjustment_delete(uuid) from public;
grant execute on function public.do_debt_adjustment_delete(uuid) to authenticated;

notify pgrst, 'reload schema';
