-- ============================================================================
-- debt_principal_recompute — keep debts.outstanding_balance honest when the
-- PRINCIPAL is edited, not just when a payment is recorded.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql.
--
-- THE GAP
-- schema.sql §15c wires recompute_debt_balance() to `debt_payments` only. Record
-- a debt of 10,000, pay 3,000, then correct the principal to 8,000 and nothing
-- recomputes: outstanding_balance stays 7,000 when it should be 5,000, and it
-- stays wrong until the next payment happens to fire the trigger.
--
-- THE SHAPE OF THE FIX
-- recompute_debt_balance() reads coalesce(new.debt_id, old.debt_id), which only
-- exists on a debt_payments row — attaching it to `debts` would fail at runtime
-- with "record new has no field debt_id". So the arithmetic moves into a plain
-- recompute_debt(uuid) helper and BOTH triggers call it. The debt_payments
-- trigger function is replaced in place; its behaviour is unchanged.
--
-- NO RECURSION: recompute_debt() updates outstanding_balance and status, never
-- principal_amount, so the WHEN clause on the new trigger is false on the second
-- pass and it does not re-fire.
-- ============================================================================

-- 1. The arithmetic, once. Outstanding is reduced ONLY by principal portions, so
--    paying interest never pays down principal (Rule 14). Self-healing
--    recompute-from-sum rather than an incremental delta.
create or replace function public.recompute_debt(_debt_id uuid)
returns void language plpgsql set search_path = public as $$
declare
  v_principal      numeric(38,18);
  v_principal_paid numeric(38,18);
  v_outstanding    numeric(38,18);
  v_new_status     public.debt_status;
begin
  select principal_amount into v_principal from public.debts where id = _debt_id;
  if v_principal is null then return; end if;

  select coalesce(sum(principal_portion), 0) into v_principal_paid
    from public.debt_payments where debt_id = _debt_id;

  v_outstanding := greatest(v_principal - v_principal_paid, 0);
  if v_outstanding = 0 then v_new_status := 'settled';
  elsif v_outstanding < v_principal then v_new_status := 'partially_paid';
  else v_new_status := 'open'; end if;

  update public.debts
    set outstanding_balance = v_outstanding,
        -- written_off is sticky: a recovery reduces the balance without
        -- pretending the debt was collected normally.
        status = case when status = 'written_off' then 'written_off' else v_new_status end
    where id = _debt_id;
end $$;

-- 2. Same trigger, same wiring, body now delegates. schema.sql §15c carries these
--    identical definitions so a fresh install needs nothing extra — this file is
--    the re-application path for a database provisioned before the fix. Keep the
--    two byte-identical: if they drift, re-running schema.sql reverts the fix.
create or replace function public.recompute_debt_balance()
returns trigger language plpgsql set search_path = public as $$
begin
  perform public.recompute_debt(coalesce(new.debt_id, old.debt_id));
  return coalesce(new, old);
end $$;

-- 2b. ledger-service calls recompute_debt() directly after un-writing-off a
--     debt: clearing 'written_off' by hand would otherwise leave the status at
--     'open' on a debt that is really 'partially_paid', until the next payment
--     happened to correct it. Callable by the service role only, like the
--     create_* RPCs.
revoke all on function public.recompute_debt(uuid) from public;
grant execute on function public.recompute_debt(uuid) to service_role;

-- 3. A debts-shaped entry point — the row here has `id`, not `debt_id`. Must be
--    defined before the trigger that names it.
create or replace function public.recompute_debt_on_debts()
returns trigger language plpgsql set search_path = public as $$
begin
  perform public.recompute_debt(new.id);
  return new;
end $$;

-- 4. The new trigger. `of principal_amount` narrows it to statements that touch
--    the column; the WHEN clause narrows it again to ones that actually change
--    the value — which is also what stops recompute_debt()'s own UPDATE from
--    re-entering this trigger.
drop trigger if exists trg_debt_principal_recompute on public.debts;
create trigger trg_debt_principal_recompute
  after update of principal_amount on public.debts
  for each row
  when (old.principal_amount is distinct from new.principal_amount)
  execute function public.recompute_debt_on_debts();

notify pgrst, 'reload schema';
