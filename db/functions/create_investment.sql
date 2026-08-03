-- ============================================================================
-- create_investment — a holding you own. Service-role variant used by
-- ledger-service.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql / policies.sql, and
-- BEFORE authenticated_entry_points.sql (which wraps it as do_investment).
--
-- NO MONEY MOVES HERE (roadmap Phase 4, decision D1). Recording an investment is
-- a statement about what you hold, not a transaction: no ledger row is posted and
-- no portfolio balance changes. Buying MP2 units with money that was already in
-- your bank account is a Transfer or an Expense you record separately, and
-- `portfolio_id` here is an informational "this came out of that account" link,
-- not a movement.
--
-- That is why `investments` has no `transaction_id` column, and why this is a
-- validating insert rather than a transaction-posting RPC like create_expense.
-- If D1 is ever reversed, adding that column is the first step, not the last.
--
-- Security: callable ONLY by service_role, takes _user_id explicitly and
-- re-checks the linked account against it. The RLS path reaches it through
-- do_investment(), which supplies auth.uid() and cannot be handed another
-- user's id.
-- ============================================================================

-- STEP 1 — the custom-kind label ---------------------------------------------
-- Same pattern, and the same reasoning, as portfolios.category_label in
-- db/functions/custom_option_labels.sql: `investment_kind` is an ENUM that
-- v_investment_performance and every by-kind rollup group on, and there is no
-- migration tool here, so it cannot take user-supplied values. Instead the enum
-- keeps its seven meanings and a nullable label rides alongside it, pinned to
-- the catch-all member 'other_asset'.
--
-- This is what lets "Gold bar", "Toyota Vios" and anything else the list does
-- not name be recorded without a schema change: they are all other_asset rows
-- that aggregate as Other and read as themselves.
--
-- The check constraint is what keeps that pinning honest — re-classifying a
-- holding from other_asset to stock must clear the label rather than leave a
-- name behind pointing at the wrong thing.
alter table public.investments
  add column if not exists kind_label text;

alter table public.investments
  drop constraint if exists investment_kind_label_only_other;
alter table public.investments
  add constraint investment_kind_label_only_other check (
    kind_label is null
    or (kind = 'other_asset' and char_length(btrim(kind_label)) between 1 and 40)
  );

-- STEP 2 — the function -------------------------------------------------------
create or replace function public.create_investment(
  _user_id         uuid,
  _name            text,
  _kind            public.investment_kind,
  _currency_id     uuid,
  _invested_amount numeric,
  _symbol          text    default null,
  _quantity        numeric default null,
  _average_cost    numeric default null,
  _opened_on       date    default current_date,
  _maturity_date   date    default null,
  _portfolio_id    uuid    default null,
  _kind_label      text    default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  pf       record;
  v_inv_id uuid;
  -- Collapsed the same way create_income normalises source_label, so the
  -- autocomplete list the form builds from these cannot fill with spacing
  -- variants of one name ("Gold  bar" sitting next to "Gold bar").
  v_label  text := nullif(regexp_replace(btrim(_kind_label), '\s+', ' ', 'g'), '');
begin
  if _name is null or char_length(trim(_name)) = 0 then
    raise exception 'Give the investment a name';
  end if;
  -- The table constraint agrees (>= 0). Zero is allowed on purpose: an asset you
  -- were given, or one whose cost basis you no longer know, is still worth
  -- tracking — it just has no meaningful return %, which the view already
  -- returns as NULL rather than dividing by zero.
  if _invested_amount is null or _invested_amount < 0 then
    raise exception 'Invested amount cannot be negative';
  end if;
  if not exists (select 1 from public.currencies where id = _currency_id) then
    raise exception 'Currency not found' using errcode = 'P0002';
  end if;

  -- Enforced by investment_kind_label_only_other too; raised here so the caller
  -- gets a sentence about the field instead of a constraint name.
  if v_label is not null then
    if _kind <> 'other_asset' then
      raise exception 'A custom type name only applies to the "Other" type';
    end if;
    if char_length(v_label) > 40 then
      raise exception 'Type name must be 40 characters or fewer';
    end if;
  end if;

  if _portfolio_id is not null then
    -- No FOR UPDATE: nothing here reads or moves a balance, so there is no race
    -- to lose. This is an ownership check, not a money guard (same as
    -- create_goal's _linked_portfolio).
    select * into pf from public.portfolios
      where id = _portfolio_id and user_id = _user_id and not is_archived;
    if pf.id is null then
      raise exception 'Account not found, archived, or not owned by you' using errcode = 'P0002';
    end if;
    -- Without this, "funded from" would compare a PHP account against a USD
    -- holding, and any by-account grouping built on the link would be nonsense.
    if pf.currency_id <> _currency_id then
      raise exception 'The funding account must hold the same currency as the investment';
    end if;
  end if;

  -- current_value starts at cost, i.e. zero gain on day one, and is OWNED BY
  -- sync_investment_current_value() from the first snapshot onward. Do not let
  -- a caller set it directly: the next snapshot would overwrite it and the edit
  -- would look like it silently reverted. unrealized_gain is a generated column
  -- and is never written at all.
  insert into public.investments
    (user_id, name, kind, kind_label, symbol, quantity, average_cost,
     invested_amount, current_value, currency_id, opened_on, maturity_date,
     portfolio_id)
  values
    (_user_id, trim(_name), _kind, v_label, nullif(btrim(_symbol), ''), _quantity,
     _average_cost, _invested_amount, _invested_amount, _currency_id,
     coalesce(_opened_on, current_date), _maturity_date, _portfolio_id)
  returning id into v_inv_id;

  return jsonb_build_object('investment_id', v_inv_id);
end $$;

revoke all on function public.create_investment(
  uuid, text, public.investment_kind, uuid, numeric, text, numeric, numeric,
  date, date, uuid, text) from public;
grant execute on function public.create_investment(
  uuid, text, public.investment_kind, uuid, numeric, text, numeric, numeric,
  date, date, uuid, text) to service_role;

-- STEP 3 — the view has to learn about kind_label -----------------------------
-- DROP first: the column list changes, and CREATE OR REPLACE VIEW cannot add a
-- column in the middle of an existing one. Forgetting this step is invisible —
-- the column exists on the table and simply never reaches the UI.
drop view if exists public.v_investment_performance;
create view public.v_investment_performance
  with (security_invoker = true) as
  select i.user_id, i.id as investment_id, i.name, i.kind, i.kind_label, i.symbol,
         i.invested_amount, i.current_value, i.unrealized_gain,
         case when i.invested_amount > 0
              then round((i.current_value - i.invested_amount) / i.invested_amount * 100, 2)
              else null end as return_pct,
         c.code as currency_code
  from public.investments i join public.currencies c on c.id = i.currency_id
  where i.is_active;

-- Dropping the view dropped its grants with it, including the blanket
-- `grant all on all tables` service_role got in policies.sql §12b — that applied
-- to the tables existing when it ran, not to this new one.
grant select on public.v_investment_performance to authenticated;
grant all on public.v_investment_performance to service_role;

-- Ask PostgREST to reload its schema cache so the RPC is immediately callable.
notify pgrst, 'reload schema';
