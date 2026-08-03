-- ============================================================================
-- create_goal — a savings goal. Service-role variant used by ledger-service.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, and
-- BEFORE authenticated_entry_points.sql (which wraps it as do_goal).
--
-- NO MONEY MOVES HERE (roadmap Phase 3, decision D2). A goal is an earmark laid
-- over balances you already have — creating one, or contributing to one, never
-- posts a ledger row and never changes a portfolio balance. Moving money into
-- savings for real is a Transfer. That is why this is a plain insert with
-- validation rather than a transaction-posting RPC like create_expense.
--
-- It is an RPC anyway, rather than an insert in each route, because of
-- _linked_portfolio: the account a goal is notionally backed by has to belong to
-- the caller AND hold the goal's currency, or the "you have earmarked more than
-- this account holds" advisory compares two different currencies and lies. One
-- implementation, called by both transports.
--
-- Security: callable ONLY by service_role, takes _user_id explicitly and
-- re-checks the linked account against it. The RLS path reaches it through
-- do_goal(), which supplies auth.uid() and cannot be handed another user's id.
-- ============================================================================
create or replace function public.create_goal(
  _user_id          uuid,
  _name             text,
  _target           numeric,
  _currency_id      uuid,
  _target_date      date default null,
  _linked_portfolio uuid default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  pf        record;
  v_goal_id uuid;
begin
  if _name is null or char_length(trim(_name)) = 0 then
    raise exception 'Goal name is required';
  end if;
  if _target is null or _target <= 0 then
    raise exception 'Target must be greater than zero';
  end if;
  if not exists (select 1 from public.currencies where id = _currency_id) then
    raise exception 'Currency not found' using errcode = 'P0002';
  end if;

  if _linked_portfolio is not null then
    -- No FOR UPDATE: nothing here reads or moves a balance, so there is no race
    -- to lose. This is an ownership check, not a money guard.
    select * into pf from public.portfolios
      where id = _linked_portfolio and user_id = _user_id and not is_archived;
    if pf.id is null then
      raise exception 'Account not found, archived, or not owned by you' using errcode = 'P0002';
    end if;
    if pf.currency_id <> _currency_id then
      raise exception 'The linked account must hold the same currency as the goal';
    end if;
  end if;

  -- current_amount defaults to 0 and is owned by apply_goal_contribution();
  -- setting it here would be overwritten by the first contribution anyway.
  insert into public.goals
    (user_id, name, target_amount, currency_id, target_date, linked_portfolio_id)
  values
    (_user_id, trim(_name), _target, _currency_id, _target_date, _linked_portfolio)
  returning id into v_goal_id;

  return jsonb_build_object('goal_id', v_goal_id);
end $$;

-- Lock down execution to service_role only (the gateway-fronted service caller).
revoke all on function public.create_goal(uuid, text, numeric, uuid, date, uuid) from public;
grant execute on function public.create_goal(uuid, text, numeric, uuid, date, uuid) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
