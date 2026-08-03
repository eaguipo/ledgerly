-- ============================================================================
-- create_goal_contribution — set money aside toward a goal, or take it back.
-- Service-role variant used by ledger-service.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, and
-- BEFORE authenticated_entry_points.sql (which wraps it as do_goal_contribution).
--
-- STILL NO MONEY MOVES (decision D2). transaction_id is deliberately left NULL:
-- a contribution is an earmark over balances you already hold, so nothing is
-- posted to the ledger and no portfolio balance changes. goal_contributions
-- carries a transaction_id column for a future variant that does move cash; if
-- that ever ships it belongs in a different function, not in this one.
--
-- THE GUARD THAT MATTERS
-- apply_goal_contribution() (schema.sql §15e) sets
--   current_amount = greatest(sum(amount), 0)
-- so a withdrawal larger than what is set aside clamps current_amount at zero
-- while the underlying sum goes negative — and the two never reconcile again.
-- Every later contribution is then measured from a phantom deficit. Rejecting
-- the over-withdrawal is the only way to keep the cached total and the rows it
-- is derived from telling the same story. (Same class of bug as overpaying a
-- debt — see create_debt_payment.sql.)
--
-- Security: callable ONLY by service_role, takes _user_id explicitly and
-- re-checks the goal against it.
-- ============================================================================
create or replace function public.create_goal_contribution(
  _user_id        uuid,
  _goal_id        uuid,
  _amount         numeric,
  _contributed_on date default current_date,
  _note           text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  g              record;
  v_after        record;
  v_contrib_id   uuid;
  v_status_before public.goal_status;
  -- An explicit NULL argument overrides the parameter default rather than
  -- falling back to it, and goal_contributions.contributed_on is NOT NULL.
  v_date         date := coalesce(_contributed_on, current_date);
begin
  if _amount is null or _amount = 0 then
    raise exception 'Enter an amount to set aside or take back';
  end if;

  -- FOR UPDATE serialises two tabs withdrawing the last of a goal, so the second
  -- one sees the reduced current_amount and hits the guard below.
  select * into g from public.goals
    where id = _goal_id and user_id = _user_id for update;
  if g.id is null then
    raise exception 'Goal not found or not owned by you' using errcode = 'P0002';
  end if;

  -- refresh_goal_status() declines to promote an archived or cancelled goal to
  -- 'achieved', but current_amount would still move — leaving a goal you closed
  -- quietly filling up in the background.
  if g.status in ('archived', 'cancelled') then
    raise exception 'This goal is % — reopen it before changing what is set aside', g.status;
  end if;

  if _amount < 0 and (-_amount) > g.current_amount then
    raise exception 'You can only take back the % currently set aside', g.current_amount;
  end if;

  v_status_before := g.status;

  -- trg_goal_contrib_apply recomputes goals.current_amount from the sum of these
  -- rows, and trg_goal_status then promotes or demotes the goal (Rule 18).
  insert into public.goal_contributions
    (user_id, goal_id, amount, contributed_on, note)
  values
    (_user_id, g.id, _amount, v_date, _note)
  returning id into v_contrib_id;

  -- Re-read inside the same transaction so we see both triggers' work. This is
  -- what lets the form say "that completes it" without re-fetching the goal.
  select current_amount, target_amount, status, first_achieved_at
    into v_after from public.goals where id = g.id;

  return jsonb_build_object(
    'contribution_id', v_contrib_id,
    'goal_id',         g.id,
    'current_amount',  v_after.current_amount,
    'target_amount',   v_after.target_amount,
    'status',          v_after.status,
    -- Distinguishes "you just finished this" from "this was already finished
    -- and you added more", which read identically from status alone.
    'just_achieved',   v_after.status = 'achieved' and v_status_before <> 'achieved'
  );
end $$;

-- Lock down execution to service_role only (the gateway-fronted service caller).
revoke all on function public.create_goal_contribution(uuid, uuid, numeric, date, text) from public;
grant execute on function public.create_goal_contribution(uuid, uuid, numeric, date, text) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
