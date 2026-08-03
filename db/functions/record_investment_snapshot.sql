-- ============================================================================
-- record_investment_snapshot — what a holding is worth on a given day.
--
-- Run this in the Supabase SQL Editor AFTER create_investment.sql, and BEFORE
-- authenticated_entry_points.sql (which wraps it as do_investment_snapshot).
--
-- NO MONEY MOVES HERE either (Phase 4, decision D1). A valuation is an
-- observation about an asset you already hold; it posts no ledger row and
-- touches no portfolio balance. Gains are unrealised until you sell, and selling
-- is an Income/Transfer you record separately.
--
-- WHAT THIS FUNCTION EXISTS TO PREVENT
--
-- sync_investment_current_value() (schema.sql §15f) picks the snapshot with the
-- newest as_of_date and copies its market_value onto investments.current_value.
-- That single line makes three things dangerous, and none of them is guarded by
-- the schema:
--
--   1. A FUTURE-DATED snapshot wins forever. One mistyped year pins current_value
--      to that row and no later real valuation can displace it, because none of
--      them will ever have a newer date. This is the sharpest edge in Phase 4.
--   2. A SECOND snapshot for the same day raises 23505 against
--      uq_inv_snap_inv_date and loses the correction — so "update today's value"
--      has to be an upsert, not an insert.
--   3. A snapshot in the WRONG CURRENCY is accepted and silently corrupts
--      current_value. transactions have trg_txn_currency to stop the equivalent;
--      investment_snapshots have nothing. The fix is to not take currency from
--      the caller at all — it is derived from the parent row below.
--
-- Security: callable ONLY by service_role, takes _user_id explicitly and
-- re-checks the parent investment against it. The snapshot RLS policy does that
-- check on the authenticated path, but service_role bypasses RLS, so it has to
-- be repeated here or the service path would accept any investment id.
-- ============================================================================
create or replace function public.record_investment_snapshot(
  _user_id       uuid,
  _investment_id uuid,
  _market_value  numeric,
  _as_of_date    date    default current_date,
  _unit_price    numeric default null,
  _quantity      numeric default null,
  _source        text    default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  inv    record;
  v_date date := coalesce(_as_of_date, current_date);
  v_id   uuid;
  v_now  record;
begin
  if _market_value is null or _market_value < 0 then
    raise exception 'Value cannot be negative';
  end if;
  -- Guard 1. Not merely odd data — a permanent one.
  if v_date > current_date then
    raise exception 'A valuation cannot be dated in the future';
  end if;

  -- FOR UPDATE here, unlike create_investment: two tabs valuing the same holding
  -- both fire the sync trigger, and serialising them means current_value ends up
  -- matching the row that actually won rather than whichever trigger ran last.
  select * into inv from public.investments
    where id = _investment_id and user_id = _user_id
    for update;
  if inv.id is null then
    raise exception 'Investment not found or not owned by you' using errcode = 'P0002';
  end if;
  if not inv.is_active then
    raise exception 'This investment is closed — reopen it to record a new value';
  end if;

  -- Guard 2 + 3. The conflict target is uq_inv_snap_inv_date, and currency_id
  -- comes from the parent, never from the caller.
  insert into public.investment_snapshots
    (user_id, investment_id, as_of_date, market_value, unit_price, quantity,
     currency_id, source)
  values
    (_user_id, inv.id, v_date, _market_value, _unit_price, _quantity,
     inv.currency_id, nullif(btrim(_source), ''))
  on conflict (investment_id, as_of_date) do update
    set market_value = excluded.market_value,
        unit_price   = excluded.unit_price,
        quantity     = excluded.quantity,
        source       = excluded.source
  returning id into v_id;

  -- The sync trigger is AFTER-row on investment_snapshots, so by the time the
  -- statement above has returned it has already run and this re-read sees the
  -- new current_value. Returning it saves the caller a round trip and, more
  -- importantly, lets the UI show what the DB actually decided rather than what
  -- the form assumed — they differ whenever an older date was back-filled and
  -- did NOT become the newest snapshot.
  select i.invested_amount, i.current_value, i.unrealized_gain,
         case when i.invested_amount > 0
              then round((i.current_value - i.invested_amount) / i.invested_amount * 100, 2)
              else null end as return_pct
    into v_now
  from public.investments i where i.id = inv.id;

  return jsonb_build_object(
    'snapshot_id',     v_id,
    'as_of_date',      v_date,
    'invested_amount', v_now.invested_amount,
    'current_value',   v_now.current_value,
    'unrealized_gain', v_now.unrealized_gain,
    'return_pct',      v_now.return_pct,
    -- Whether the headline figure now shows the number just entered. False when
    -- an older date was back-filled behind a newer snapshot: the row was saved,
    -- but current_value deliberately did not move. Compares values rather than
    -- dates on purpose — if a back-fill happens to match the newest valuation,
    -- the headline does show it, and saying otherwise would confuse.
    'is_latest',       v_now.current_value = _market_value
  );
end $$;

revoke all on function public.record_investment_snapshot(
  uuid, uuid, numeric, date, numeric, numeric, text) from public;
grant execute on function public.record_investment_snapshot(
  uuid, uuid, numeric, date, numeric, numeric, text) to service_role;

notify pgrst, 'reload schema';
