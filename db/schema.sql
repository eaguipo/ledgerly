-- ============================================================================
-- PERSONAL FINANCE TRACKER — CANONICAL SCHEMA (schemaSql)  [REVISED]
-- PostgreSQL / Supabase. Tables + enums + functions + triggers + indexes.
-- Run order: extensions -> enums -> reference tables -> profiles -> user data
-- -> ledger -> detail tables -> triggers. RLS lives in the separate rls block.
--
-- Money precision: ledger/portfolio/transfer money columns are numeric(38,18)
-- so crypto (BTC/ETH 8dp, USDT 6dp) holdings are not truncated (Req 13/BR17).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. EXTENSIONS
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive username/email

-- ---------------------------------------------------------------------------
-- 1. ENUM TYPES  (created first; tables depend on them)
-- ---------------------------------------------------------------------------
create type public.app_role          as enum ('admin','user');
create type public.portfolio_category as enum ('cash','bank','crypto','investment','others');
create type public.txn_kind          as enum (
  'income','expense','transfer_out','transfer_in',
  'debt_payment_made','debt_payment_received','adjustment','opening_balance');
create type public.txn_direction     as enum ('inflow','outflow');
create type public.income_source     as enum ('salary','business','gains','debt_payment_received','gift','other');
create type public.debt_kind         as enum ('payable','receivable');
create type public.debt_status       as enum ('open','partially_paid','settled','written_off');
create type public.goal_status       as enum ('active','achieved','archived','cancelled');
create type public.investment_kind   as enum ('mp2','crypto','stock','mutual_fund','bond','real_estate','other_asset');
create type public.audit_action      as enum ('insert','update','delete');

-- ---------------------------------------------------------------------------
-- 2. GENERIC HELPER: updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Resolve a currency's minor_unit (decimal places) for rounding. Defaults to 2.
-- plpgsql (not sql) so the body is NOT validated against catalog objects at CREATE
-- time — public.currencies is created later (same pattern as has_feature below).
create or replace function public.currency_minor_unit(_currency_id uuid)
returns smallint language plpgsql stable as $$
begin
  return coalesce((select minor_unit from public.currencies where id = _currency_id), 2::smallint);
end $$;

-- ---------------------------------------------------------------------------
-- 3. REFERENCE TABLES (shared, world-readable, admin-writable)
-- ---------------------------------------------------------------------------
create table public.currencies (
  id          uuid primary key default gen_random_uuid(),
  -- text, not char(3): ISO 4217 codes are 3 chars but crypto pseudo-codes are
  -- longer (USDT=4, USDC=4, ...). char(3) also blank-pads, which is undesirable.
  code        text not null unique,
  name        text    not null,
  symbol      text    not null default '',
  minor_unit  smallint not null default 2,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint currencies_code_len check (char_length(code) between 3 and 10),
  constraint currencies_minor_unit_range check (minor_unit between 0 and 18)
);

create table public.features (
  id                 uuid primary key default gen_random_uuid(),
  key                text not null unique,
  name               text not null,
  description        text,
  is_default_enabled boolean not null default true,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. PROFILES — app user record, 1:1 with auth.users (BR1-4, Rule 1)
--    NOTE: profiles.email is a synced copy of auth.users.email (see 18b sync
--    trigger). Auth (Rule 2) always uses auth.users; this copy is for app reads
--    and uniqueness (Rule 3) and is kept in step via the sync trigger.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  full_name           text not null default '',
  username            citext not null unique,
  email               citext not null unique,
  role                public.app_role not null default 'user',
  default_currency_id uuid references public.currencies(id),
  avatar_url          text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_profiles_role on public.profiles(role);
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. ROLE / FEATURE HELPERS (SECURITY DEFINER, bypass RLS)
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

-- plpgsql so the body is NOT validated against catalog objects at CREATE time
-- (user_feature_access is created later); reference resolves at first execution.
create or replace function public.has_feature(_key text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_enabled boolean;
begin
  select coalesce(
    (select uf.is_enabled from public.user_feature_access uf
      where uf.user_id = auth.uid() and uf.feature_id = (select f.id from public.features f where f.key = _key)),
    (select f.is_default_enabled from public.features f where f.key = _key),
    false)
  into v_enabled;
  return v_enabled;
end $$;

-- ---------------------------------------------------------------------------
-- 6. PER-USER LOOKUPS
-- ---------------------------------------------------------------------------
create table public.money_purpose_tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  is_system  boolean not null default false,
  color      text,
  created_at timestamptz not null default now(),
  constraint purpose_tag_name_not_blank check (char_length(trim(name)) > 0)
);
create unique index uq_purpose_tag_user_name on public.money_purpose_tags(user_id, lower(name));
create index idx_purpose_tags_user on public.money_purpose_tags(user_id);

create table public.expense_categories (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  name              text not null,
  is_system_default boolean not null default false,
  icon              text,
  color             text,
  is_active         boolean not null default true,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint expense_cat_name_not_blank check (char_length(trim(name)) > 0)
);
create unique index uq_expense_cat_user_active_name
  on public.expense_categories(user_id, lower(name)) where is_active;
create index idx_expense_cat_user on public.expense_categories(user_id);
create index idx_expense_cat_user_active on public.expense_categories(user_id) where is_active;
create trigger trg_expense_cat_updated_at before update on public.expense_categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. PORTFOLIOS (current_balance is a trigger-maintained cache; ledger is truth)
--    is_liquid = cash OR (bank AND is_savings) per Rule 16 (savings only).
--    allow_negative lets credit-style accounts go below zero (overdraft guard).
-- ---------------------------------------------------------------------------
create table public.portfolios (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  category        public.portfolio_category not null,
  currency_id     uuid not null references public.currencies(id),
  purpose_tag_id  uuid references public.money_purpose_tags(id) on delete set null,
  opening_balance numeric(38,18) not null default 0,
  current_balance numeric(38,18) not null default 0,
  institution     text,
  is_savings      boolean not null default false,
  allow_negative  boolean not null default false,
  is_liquid       boolean generated always as
                    (category = 'cash' or (category = 'bank' and is_savings)) stored,
  sort_order      integer not null default 0,
  is_archived     boolean not null default false,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint portfolio_name_not_blank check (char_length(trim(name)) > 0)
);
create index idx_portfolios_user on public.portfolios(user_id);
create index idx_portfolios_user_category on public.portfolios(user_id, category);
create index idx_portfolios_user_active on public.portfolios(user_id) where is_archived = false;
create trigger trg_portfolios_updated_at before update on public.portfolios
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 8. DEBTS (outstanding_balance maintained by debt_payments trigger)
-- ---------------------------------------------------------------------------
create table public.debts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  kind                public.debt_kind not null,
  counterparty        text not null,
  principal_amount    numeric(38,18) not null,
  outstanding_balance numeric(38,18) not null,
  currency_id         uuid not null references public.currencies(id),
  interest_rate       numeric(7,4),
  status              public.debt_status not null default 'open',
  due_date            date,
  expense_category_id uuid references public.expense_categories(id) on delete set null,
  note                text,
  is_archived         boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint debt_principal_nonneg   check (principal_amount >= 0),
  constraint debt_outstanding_nonneg check (outstanding_balance >= 0)
);
create index idx_debts_user_kind on public.debts(user_id, kind);
create index idx_debts_user_status on public.debts(user_id, status);
create index idx_debts_open on public.debts(user_id) where status <> 'settled';
create trigger trg_debts_updated_at before update on public.debts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. TRANSACTIONS — THE UNIFIED LEDGER (single source of truth)
--    unique(id, kind) backs the composite FK used by detail tables (incomes/
--    expenses) to guarantee they link only to a transaction of the right kind.
-- ---------------------------------------------------------------------------
create table public.transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  portfolio_id      uuid not null references public.portfolios(id) on delete restrict,
  kind              public.txn_kind not null,
  direction         public.txn_direction not null,
  amount            numeric(38,18) not null,
  signed_amount     numeric(38,18) generated always as
                      (case when direction = 'inflow' then amount else -amount end) stored,
  currency_id       uuid not null references public.currencies(id),
  txn_date          date not null default current_date,
  occurred_at       timestamptz not null default now(),
  description       text,
  purpose_tag_id    uuid references public.money_purpose_tags(id) on delete set null,
  transfer_group_id uuid,
  is_void           boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint txn_amount_positive check (amount > 0),
  constraint txn_kind_direction_consistent check (
    (kind in ('income','transfer_in','debt_payment_received','opening_balance') and direction = 'inflow')
    or (kind in ('expense','transfer_out','debt_payment_made') and direction = 'outflow')
    or (kind = 'adjustment')
  ),
  constraint uq_txn_id_kind unique (id, kind)
);
create index idx_txn_user_date     on public.transactions(user_id, txn_date desc);
create index idx_txn_portfolio_date on public.transactions(portfolio_id, txn_date);
create index idx_txn_user_kind_date on public.transactions(user_id, kind, txn_date);
create index idx_txn_transfer_group on public.transactions(transfer_group_id) where transfer_group_id is not null;
create index idx_txn_user_active    on public.transactions(user_id, txn_date) where is_void = false;
create trigger trg_txn_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 10. DETAIL TABLES (thin; link 1:1 back to ledger)
--     incomes/expenses carry a denormalized txn_kind tied to the parent via a
--     composite FK so the link kind cannot be mismatched.
-- ---------------------------------------------------------------------------
create table public.incomes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  txn_kind       public.txn_kind not null,
  source         public.income_source not null,
  source_name    text,
  debt_id        uuid references public.debts(id) on delete set null,
  is_recurring   boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint incomes_kind_allowed check (txn_kind in ('income','debt_payment_received')),
  constraint incomes_txn_kind_fk
    foreign key (transaction_id, txn_kind)
    references public.transactions(id, kind) on delete cascade
);
create index idx_incomes_user on public.incomes(user_id);
create index idx_incomes_source on public.incomes(user_id, source);

create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  txn_kind       public.txn_kind not null default 'expense',
  category_id    uuid not null references public.expense_categories(id) on delete restrict,
  merchant       text,
  is_bill        boolean not null default false,
  debt_id        uuid references public.debts(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint expenses_kind_allowed check (txn_kind = 'expense'),
  constraint expenses_txn_kind_fk
    foreign key (transaction_id, txn_kind)
    references public.transactions(id, kind) on delete cascade
);
create index idx_expenses_user on public.expenses(user_id);
create index idx_expenses_category on public.expenses(category_id);
create index idx_expenses_user_cat on public.expenses(user_id, category_id);

create table public.transfers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  from_portfolio_id  uuid not null references public.portfolios(id) on delete restrict,
  to_portfolio_id    uuid not null references public.portfolios(id) on delete restrict,
  amount             numeric(38,18) not null,
  fee                numeric(38,18) not null default 0,
  from_currency_id   uuid not null references public.currencies(id),
  to_currency_id     uuid not null references public.currencies(id),
  exchange_rate      numeric(38,18) not null default 1,
  amount_received    numeric(38,18) not null,
  out_transaction_id uuid unique references public.transactions(id) on delete set null,
  in_transaction_id  uuid unique references public.transactions(id) on delete set null,
  fee_transaction_id uuid unique references public.transactions(id) on delete set null,
  txn_date           date not null default current_date,
  note               text,
  created_at         timestamptz not null default now(),
  constraint transfer_distinct_portfolios check (to_portfolio_id <> from_portfolio_id),
  constraint transfer_amount_positive     check (amount > 0),
  constraint transfer_fee_nonneg          check (fee >= 0),
  constraint transfer_rate_positive       check (exchange_rate > 0),
  constraint transfer_received_positive   check (amount_received > 0)
);
create index idx_transfers_user_date on public.transfers(user_id, txn_date);
create index idx_transfers_from on public.transfers(from_portfolio_id);
create index idx_transfers_to on public.transfers(to_portfolio_id);

create table public.debt_payments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  debt_id           uuid not null references public.debts(id) on delete cascade,
  -- NOT NULL + restrict: every payment is backed by a ledger row (via RPC).
  transaction_id    uuid not null unique references public.transactions(id) on delete restrict,
  amount            numeric(38,18) not null,
  principal_portion numeric(38,18) not null default 0,
  interest_portion  numeric(38,18) not null default 0,
  payment_date      date not null default current_date,
  note              text,
  created_at        timestamptz not null default now(),
  constraint debt_pay_amount_positive  check (amount > 0),
  constraint debt_pay_principal_nonneg check (principal_portion >= 0),
  constraint debt_pay_interest_nonneg  check (interest_portion >= 0),
  constraint debt_pay_split_matches    check (principal_portion + interest_portion = amount)
);
create index idx_debt_payments_debt on public.debt_payments(debt_id);
create index idx_debt_payments_user_date on public.debt_payments(user_id, payment_date);

-- ---------------------------------------------------------------------------
-- 11. GOALS + CONTRIBUTIONS (Rule 18 auto-achieve)
--     first_achieved_at is set on first completion and NEVER cleared, so
--     historical achievement (and v_completed_goals) survives later withdrawals.
-- ---------------------------------------------------------------------------
create table public.goals (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  name                text not null,
  target_amount       numeric(38,18) not null,
  current_amount      numeric(38,18) not null default 0,
  currency_id         uuid not null references public.currencies(id),
  purpose_tag_id      uuid references public.money_purpose_tags(id) on delete set null,
  linked_portfolio_id uuid references public.portfolios(id) on delete set null,
  status              public.goal_status not null default 'active',
  target_date         date,
  achieved_at         timestamptz,
  first_achieved_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint goal_name_not_blank  check (char_length(trim(name)) > 0),
  constraint goal_target_positive check (target_amount > 0),
  constraint goal_current_nonneg  check (current_amount >= 0)
);
create index idx_goals_user on public.goals(user_id);
create index idx_goals_user_status on public.goals(user_id, status);
create index idx_goals_first_achieved on public.goals(user_id) where first_achieved_at is not null;
create trigger trg_goals_updated_at before update on public.goals
  for each row execute function public.set_updated_at();

create table public.goal_contributions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  goal_id        uuid not null references public.goals(id) on delete cascade,
  amount         numeric(38,18) not null,
  transaction_id uuid references public.transactions(id) on delete set null,
  contributed_on date not null default current_date,
  note           text,
  created_at     timestamptz not null default now(),
  constraint goal_contrib_nonzero check (amount <> 0)
);
create index idx_goal_contrib_goal on public.goal_contributions(goal_id, contributed_on);

-- ---------------------------------------------------------------------------
-- 12. INVESTMENTS + SNAPSHOTS (qty/price numeric(28,8); money numeric(38,18))
-- ---------------------------------------------------------------------------
create table public.investments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  portfolio_id    uuid references public.portfolios(id) on delete set null,
  name            text not null,
  kind            public.investment_kind not null,
  symbol          text,
  quantity        numeric(28,8),
  average_cost    numeric(28,8),
  invested_amount numeric(38,18) not null default 0,
  current_value   numeric(38,18) not null default 0,
  currency_id     uuid not null references public.currencies(id),
  unrealized_gain numeric(38,18) generated always as (current_value - invested_amount) stored,
  opened_on       date,
  maturity_date   date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint investment_name_not_blank  check (char_length(trim(name)) > 0),
  constraint investment_invested_nonneg check (invested_amount >= 0)
);
create index idx_investments_user on public.investments(user_id);
create index idx_investments_user_kind on public.investments(user_id, kind);
create trigger trg_investments_updated_at before update on public.investments
  for each row execute function public.set_updated_at();

create table public.investment_snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  investment_id uuid not null references public.investments(id) on delete cascade,
  as_of_date    date not null default current_date,
  market_value  numeric(38,18) not null,
  unit_price    numeric(28,8),
  quantity      numeric(28,8),
  currency_id   uuid not null references public.currencies(id),
  source        text,
  created_at    timestamptz not null default now(),
  constraint snapshot_value_nonneg check (market_value >= 0)
);
create unique index uq_inv_snap_inv_date on public.investment_snapshots(investment_id, as_of_date);
create index idx_inv_snap_inv_date on public.investment_snapshots(investment_id, as_of_date desc);

-- ---------------------------------------------------------------------------
-- 13. USER FEATURE ACCESS (Rule 21)
-- ---------------------------------------------------------------------------
create table public.user_feature_access (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  feature_id uuid not null references public.features(id) on delete cascade,
  is_enabled boolean not null default true,
  granted_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint uq_user_feature unique (user_id, feature_id)
);
create index idx_ufa_user on public.user_feature_access(user_id);
create trigger trg_ufa_updated_at before update on public.user_feature_access
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 14. AUDIT LOG (Rule 20) — append-only; written by SECURITY DEFINER trigger
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.profiles(id) on delete set null,
  actor_id   uuid references public.profiles(id) on delete set null,
  table_name text not null,
  record_id  uuid,
  action     public.audit_action not null,
  old_data   jsonb,
  new_data   jsonb,
  changed_at timestamptz not null default now(),
  ip_address inet
);
create index idx_audit_user_time on public.audit_log(user_id, changed_at desc);
create index idx_audit_table_record on public.audit_log(table_name, record_id);
create index idx_audit_new_data_gin on public.audit_log using gin (new_data);

-- ===========================================================================
-- 15. TRIGGER FUNCTIONS — balances, debts, goals, investments, currency, audit
-- ===========================================================================

-- 15a. Ledger -> portfolio.current_balance cache. Voided rows contribute 0.
create or replace function public.apply_txn_to_balance()
returns trigger language plpgsql as $$
declare old_delta numeric(38,18) := 0; new_delta numeric(38,18) := 0;
begin
  if tg_op in ('UPDATE','DELETE') and not old.is_void then old_delta := old.signed_amount; end if;
  if tg_op in ('UPDATE','INSERT') and not new.is_void then new_delta := new.signed_amount; end if;
  if tg_op = 'INSERT' then
    update public.portfolios set current_balance = current_balance + new_delta where id = new.portfolio_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.portfolios set current_balance = current_balance - old_delta where id = old.portfolio_id;
    return old;
  else
    if old.portfolio_id = new.portfolio_id then
      update public.portfolios set current_balance = current_balance - old_delta + new_delta where id = new.portfolio_id;
    else
      update public.portfolios set current_balance = current_balance - old_delta where id = old.portfolio_id;
      update public.portfolios set current_balance = current_balance + new_delta where id = new.portfolio_id;
    end if;
    return new;
  end if;
end $$;
create trigger trg_txn_balance after insert or update or delete on public.transactions
  for each row execute function public.apply_txn_to_balance();

-- 15a-2. Overdraft guard (balance integrity). BEFORE INSERT/UPDATE: a live
-- outflow that would drive a non-allow_negative portfolio below zero is blocked,
-- regardless of entry path (not just do_transfer). Voids and inflows pass.
create or replace function public.txn_overdraft_guard()
returns trigger language plpgsql as $$
declare v_allow boolean; v_balance numeric(38,18); v_old_delta numeric(38,18) := 0; v_new_delta numeric(38,18) := 0;
begin
  if tg_op = 'UPDATE' and not old.is_void then v_old_delta := old.signed_amount; end if;
  -- NOTE: new.signed_amount is a STORED generated column and is NOT yet computed
  -- inside a BEFORE trigger (it would be NULL), so derive the delta directly from
  -- amount/direction. (old.signed_amount above is fine: the old row is persisted.)
  if not new.is_void then
    v_new_delta := case when new.direction = 'inflow' then new.amount else -new.amount end;
  end if;
  -- Only a net reduction on the target portfolio can cause an overdraft.
  if (v_new_delta - case when tg_op = 'UPDATE' and old.portfolio_id = new.portfolio_id then v_old_delta else 0 end) >= 0 then
    return new;
  end if;
  select allow_negative, current_balance into v_allow, v_balance
    from public.portfolios where id = new.portfolio_id for update;
  if v_allow then return new; end if;
  -- Projected balance after this row posts.
  if tg_op = 'UPDATE' and old.portfolio_id = new.portfolio_id then
    if (v_balance - v_old_delta + v_new_delta) < 0 then
      raise exception 'Insufficient funds: posting this transaction would make portfolio % negative', new.portfolio_id;
    end if;
  else
    if (v_balance + v_new_delta) < 0 then
      raise exception 'Insufficient funds: posting this transaction would make portfolio % negative', new.portfolio_id;
    end if;
  end if;
  return new;
end $$;
create trigger trg_txn_overdraft before insert or update on public.transactions
  for each row execute function public.txn_overdraft_guard();

-- 15b. Currency integrity: transaction currency must match its portfolio (BR17).
create or replace function public.txn_enforce_currency()
returns trigger language plpgsql as $$
declare p_currency uuid;
begin
  select currency_id into p_currency from public.portfolios where id = new.portfolio_id;
  if p_currency is null then raise exception 'Portfolio % not found', new.portfolio_id; end if;
  if new.currency_id <> p_currency then
    raise exception 'Transaction currency must match portfolio currency (BR17)';
  end if;
  return new;
end $$;
create trigger trg_txn_currency before insert or update on public.transactions
  for each row execute function public.txn_enforce_currency();

-- 15c. Debt auto-reduction + status (Rule 14). Outstanding is reduced ONLY by
-- principal portions, so paying interest never pays down principal. Self-healing
-- recompute-from-sum.
--
-- The arithmetic lives in recompute_debt(uuid) so that BOTH entry points can use
-- it: a payment changing the sum paid, and the principal itself being corrected.
-- Keep this block byte-identical to db/functions/debt_principal_recompute.sql,
-- which applies the same definitions to an already-provisioned database — if the
-- two drift, re-running this file silently reverts the fix.
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
revoke all on function public.recompute_debt(uuid) from public;
grant execute on function public.recompute_debt(uuid) to service_role;

-- Payment-side trigger: the row here carries debt_id.
create or replace function public.recompute_debt_balance()
returns trigger language plpgsql set search_path = public as $$
begin
  perform public.recompute_debt(coalesce(new.debt_id, old.debt_id));
  return coalesce(new, old);
end $$;
create trigger trg_debt_payment_recompute after insert or update or delete on public.debt_payments
  for each row execute function public.recompute_debt_balance();

-- Principal-side trigger: correcting principal_amount has to recompute too, or a
-- debt of 10,000 paid down 3,000 and then corrected to 8,000 keeps reporting
-- 7,000 outstanding until the next payment happens to fire the other trigger.
-- The row here has `id`, not `debt_id`, hence a second entry point.
create or replace function public.recompute_debt_on_debts()
returns trigger language plpgsql set search_path = public as $$
begin
  perform public.recompute_debt(new.id);
  return new;
end $$;
-- `of principal_amount` plus the WHEN clause keep this from re-firing on
-- recompute_debt()'s own UPDATE, which only touches outstanding_balance/status.
create trigger trg_debt_principal_recompute
  after update of principal_amount on public.debts
  for each row
  when (old.principal_amount is distinct from new.principal_amount)
  execute function public.recompute_debt_on_debts();

-- 15d. Goal auto-status (Rule 18). Achieve on completion; stamp first_achieved_at
-- once and never clear it. Demotion preserves first_achieved_at for history.
create or replace function public.refresh_goal_status()
returns trigger language plpgsql as $$
begin
  if new.current_amount >= new.target_amount then
    if new.status not in ('achieved','archived','cancelled') then
      new.status := 'achieved'; new.achieved_at := now();
    end if;
    if new.first_achieved_at is null then new.first_achieved_at := now(); end if;
  else
    if new.status = 'achieved' then new.status := 'active'; new.achieved_at := null; end if;
    -- first_achieved_at intentionally left intact (lossy demotion avoided).
  end if;
  return new;
end $$;
create trigger trg_goal_status before insert or update on public.goals
  for each row execute function public.refresh_goal_status();

-- 15e. goal_contributions -> goals.current_amount (drives Rule 18).
create or replace function public.apply_goal_contribution()
returns trigger language plpgsql as $$
declare v_goal_id uuid := coalesce(new.goal_id, old.goal_id);
begin
  update public.goals g
    set current_amount = greatest(coalesce((
      select sum(amount) from public.goal_contributions where goal_id = v_goal_id), 0), 0)
    where g.id = v_goal_id;
  return coalesce(new, old);
end $$;
create trigger trg_goal_contrib_apply after insert or update or delete on public.goal_contributions
  for each row execute function public.apply_goal_contribution();

-- 15f. Investment snapshot -> investments.current_value (newest snapshot wins).
create or replace function public.sync_investment_current_value()
returns trigger language plpgsql as $$
declare v_inv uuid := coalesce(new.investment_id, old.investment_id);
begin
  update public.investments i
    set current_value = coalesce((
      select s.market_value from public.investment_snapshots s
       where s.investment_id = v_inv order by s.as_of_date desc, s.created_at desc limit 1), i.current_value)
    where i.id = v_inv;
  return coalesce(new, old);
end $$;
create trigger trg_inv_snapshot_sync after insert or update or delete on public.investment_snapshots
  for each row execute function public.sync_investment_current_value();

-- 15g. Generic audit logger (Rule 20). SECURITY DEFINER -> bypasses RLS to write.
create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_record uuid; v_action public.audit_action;
begin
  v_action := lower(tg_op)::public.audit_action;
  if tg_op = 'DELETE' then
    v_owner := (to_jsonb(old)->>'user_id')::uuid; v_record := (to_jsonb(old)->>'id')::uuid;
  else
    v_owner := (to_jsonb(new)->>'user_id')::uuid; v_record := (to_jsonb(new)->>'id')::uuid;
  end if;
  insert into public.audit_log(user_id, actor_id, table_name, record_id, action, old_data, new_data)
  values (v_owner, auth.uid(), tg_table_name, v_record, v_action,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
create trigger trg_audit_transactions  after insert or update or delete on public.transactions   for each row execute function public.audit_trigger();
create trigger trg_audit_portfolios    after insert or update or delete on public.portfolios     for each row execute function public.audit_trigger();
create trigger trg_audit_debts         after insert or update or delete on public.debts          for each row execute function public.audit_trigger();
create trigger trg_audit_debt_payments after insert or update or delete on public.debt_payments  for each row execute function public.audit_trigger();
create trigger trg_audit_transfers     after insert or update or delete on public.transfers      for each row execute function public.audit_trigger();
create trigger trg_audit_goals         after insert or update or delete on public.goals          for each row execute function public.audit_trigger();
create trigger trg_audit_investments   after insert or update or delete on public.investments    for each row execute function public.audit_trigger();
create trigger trg_audit_profiles      after insert or update or delete on public.profiles       for each row execute function public.audit_trigger();
create trigger trg_audit_user_features after insert or update or delete on public.user_feature_access for each row execute function public.audit_trigger();

-- ===========================================================================
-- 16. TRANSFER RPC (BR8; Rules 11,12) — atomic legs + overdraft + fee-as-expense
--     - amount_received rounds to the DESTINATION currency's minor_unit.
--     - the fee posts as a separate 'expense' transaction so it shows in
--       v_cashflow outflow (Req 20). The transfer_out leg carries amount only.
-- ===========================================================================
create or replace function public.do_transfer(
  _from_portfolio uuid, _to_portfolio uuid, _amount numeric, _fee numeric default 0,
  _exchange_rate numeric default 1, _txn_date date default current_date, _note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare s record; d record; v_group uuid := gen_random_uuid();
  v_out uuid; v_in uuid; v_fee_txn uuid := null; v_recv numeric(38,18); v_transfer uuid;
  v_to_minor smallint; v_fee_cat uuid;
begin
  if _amount is null or _amount <= 0 then raise exception 'Transfer amount must be positive'; end if;
  if _fee is null or _fee < 0 then raise exception 'Fee cannot be negative'; end if;
  if _exchange_rate is null or _exchange_rate <= 0 then raise exception 'Exchange rate must be positive'; end if;
  select * into s from public.portfolios where id = _from_portfolio and user_id = auth.uid() and not is_archived for update;
  select * into d from public.portfolios where id = _to_portfolio   and user_id = auth.uid() and not is_archived for update;
  if s.id is null or d.id is null then raise exception 'Portfolio not found, archived, or not owned by you'; end if;
  if s.id = d.id then raise exception 'Cannot transfer to the same portfolio'; end if;
  -- Overdraft guard for the whole outflow (amount + fee), unless source allows negative.
  if not s.allow_negative and s.current_balance < (_amount + _fee) then
    raise exception 'Insufficient funds: balance % < % (amount + fee)', s.current_balance, (_amount + _fee);
  end if;
  v_to_minor := public.currency_minor_unit(d.currency_id);
  v_recv := round(_amount * _exchange_rate, v_to_minor);
  if v_recv <= 0 then raise exception 'Converted amount rounds to zero'; end if;

  -- OUT leg: principal only (fee is posted separately below).
  insert into public.transactions(user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description, transfer_group_id)
  values (auth.uid(), s.id, 'transfer_out', 'outflow', _amount, s.currency_id, _txn_date, coalesce(_note,'Transfer to '||d.name), v_group)
  returning id into v_out;

  -- IN leg.
  insert into public.transactions(user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description, transfer_group_id)
  values (auth.uid(), d.id, 'transfer_in', 'inflow', v_recv, d.currency_id, _txn_date, coalesce(_note,'Transfer from '||s.name), v_group)
  returning id into v_in;

  -- FEE leg: a real expense so cashflow/expense reporting counts it (Req 20).
  if _fee > 0 then
    select id into v_fee_cat from public.expense_categories
      where user_id = auth.uid() and is_active and lower(name) = 'transfer fee' limit 1;
    if v_fee_cat is null then
      insert into public.expense_categories(user_id, name, is_system_default)
      values (auth.uid(), 'Transfer Fee', true) returning id into v_fee_cat;
    end if;
    insert into public.transactions(user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description, transfer_group_id)
    values (auth.uid(), s.id, 'expense', 'outflow', _fee, s.currency_id, _txn_date, 'Transfer fee', v_group)
    returning id into v_fee_txn;
    insert into public.expenses(user_id, transaction_id, txn_kind, category_id, is_bill)
    values (auth.uid(), v_fee_txn, 'expense', v_fee_cat, false);
  end if;

  insert into public.transfers(user_id, from_portfolio_id, to_portfolio_id, amount, fee, from_currency_id, to_currency_id, exchange_rate, amount_received, out_transaction_id, in_transaction_id, fee_transaction_id, txn_date, note)
  values (auth.uid(), s.id, d.id, _amount, _fee, s.currency_id, d.currency_id, _exchange_rate, v_recv, v_out, v_in, v_fee_txn, _txn_date, _note)
  returning id into v_transfer;
  return v_transfer;
end $$;
revoke all on function public.do_transfer(uuid,uuid,numeric,numeric,numeric,date,text) from public;
grant execute on function public.do_transfer(uuid,uuid,numeric,numeric,numeric,date,text) to authenticated;

-- 16b. DEBT PAYMENT RPC (Rules 14,20; Req 20) — atomic: posts the ledger row
-- that moves cash out of (payable) / into (receivable) a portfolio, then the
-- linked debt_payments row. recompute_debt_balance handles outstanding/status.
create or replace function public.do_debt_payment(
  _debt_id uuid, _portfolio_id uuid, _amount numeric,
  _principal numeric default null, _interest numeric default 0,
  _payment_date date default current_date, _note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare dr record; pf record; v_principal numeric(38,18); v_interest numeric(38,18);
  v_kind public.txn_kind; v_dir public.txn_direction; v_txn uuid; v_payment uuid;
begin
  if _amount is null or _amount <= 0 then raise exception 'Payment amount must be positive'; end if;
  v_interest  := coalesce(_interest, 0);
  v_principal := coalesce(_principal, _amount - v_interest);
  if v_interest < 0 or v_principal < 0 then raise exception 'Principal/interest portions cannot be negative'; end if;
  if v_principal + v_interest <> _amount then
    raise exception 'principal (%) + interest (%) must equal amount (%)', v_principal, v_interest, _amount;
  end if;

  select * into dr from public.debts where id = _debt_id and user_id = auth.uid() for update;
  if dr.id is null then raise exception 'Debt not found or not owned by you'; end if;
  select * into pf from public.portfolios where id = _portfolio_id and user_id = auth.uid() and not is_archived for update;
  if pf.id is null then raise exception 'Portfolio not found, archived, or not owned by you'; end if;
  if pf.currency_id <> dr.currency_id then raise exception 'Portfolio currency must match debt currency'; end if;

  -- payable: we pay money OUT. receivable: counterparty pays us, money comes IN.
  if dr.kind = 'payable' then
    v_kind := 'debt_payment_made'; v_dir := 'outflow';
    if not pf.allow_negative and pf.current_balance < _amount then
      raise exception 'Insufficient funds: balance % < payment %', pf.current_balance, _amount;
    end if;
  else
    v_kind := 'debt_payment_received'; v_dir := 'inflow';
  end if;

  insert into public.transactions(user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
  values (auth.uid(), pf.id, v_kind, v_dir, _amount, pf.currency_id, _payment_date,
          coalesce(_note, (case when dr.kind='payable' then 'Debt payment to ' else 'Debt collection from ' end)||dr.counterparty))
  returning id into v_txn;

  insert into public.debt_payments(user_id, debt_id, transaction_id, amount, principal_portion, interest_portion, payment_date, note)
  values (auth.uid(), dr.id, v_txn, _amount, v_principal, v_interest, _payment_date, _note)
  returning id into v_payment;
  return v_payment;
end $$;
revoke all on function public.do_debt_payment(uuid,uuid,numeric,numeric,numeric,date,text) from public;
grant execute on function public.do_debt_payment(uuid,uuid,numeric,numeric,numeric,date,text) to authenticated;

-- ===========================================================================
-- 17. BALANCE RECONCILIATION (admin/scheduled safety net for the cache)
-- ===========================================================================
create or replace function public.reconcile_portfolio_balances()
returns void language sql security definer set search_path = public as $$
  update public.portfolios p set current_balance = coalesce((
    select sum(t.signed_amount) from public.transactions t
     where t.portfolio_id = p.id and t.is_void = false), 0);
$$;
revoke all on function public.reconcile_portfolio_balances() from public;

-- ===========================================================================
-- 18. NEW-USER ONBOARDING — profile + seed defaults (AFTER INSERT auth.users)
--     Self-heals the PHP currency if seedSql has not yet run (order-robust).
-- ===========================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_php uuid; cat text; tag text;
  default_categories text[] := array[
    'Food','Grocery','Toiletries','Electricity','Internet','Gas','House Share',
    'Dog Care','Debt - Credit Card','Debt - TikTok','Debt - Shopee',
    'Life Insurance','Health Insurance','St Peter Life Plan'];
  default_tags text[] := array['Savings','Emergency Fund','Investments','Cash','Travel Fund'];
begin
  select id into v_php from public.currencies where code = 'PHP' limit 1;
  if v_php is null then
    insert into public.currencies (code, name, symbol, minor_unit)
    values ('PHP','Philippine Peso','₱',2)
    on conflict (code) do nothing;
    select id into v_php from public.currencies where code = 'PHP' limit 1;
  end if;

  insert into public.profiles (id, full_name, username, email, role, default_currency_id)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''),
          coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)),
          new.email, 'user', v_php);
  foreach cat in array default_categories loop
    insert into public.expense_categories (user_id, name, is_system_default) values (new.id, cat, true);
  end loop;
  foreach tag in array default_tags loop
    insert into public.money_purpose_tags (user_id, name, is_system) values (new.id, tag, true);
  end loop;
  insert into public.user_feature_access (user_id, feature_id, is_enabled)
  select new.id, f.id, f.is_default_enabled from public.features f;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 18b. EMAIL SYNC — keep profiles.email aligned with auth.users.email (Rule 3).
-- Auth (Rule 2) always uses auth.users; this keeps the app-side copy fresh.
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;
create trigger on_auth_user_email_updated after update of email on auth.users
  for each row execute function public.sync_profile_email();

-- ===========================================================================
-- 19. REPORTING VIEWS (Rule 15 date-range; BR16,19,20)
--     SECURITY INVOKER: each view runs with the QUERYING user's privileges so
--     RLS on the base tables applies — every user sees ONLY their own rows.
--     (Plain views run as the view OWNER and would leak all tenants' data.)
-- ===========================================================================
create or replace view public.v_portfolio_balances
  with (security_invoker = true) as
  select p.id, p.user_id, p.name, p.category, p.currency_id, c.code as currency_code,
         p.current_balance, p.is_liquid, p.is_archived
  from public.portfolios p join public.currencies c on c.id = p.currency_id;

create or replace view public.v_liquid_by_currency
  with (security_invoker = true) as
  select p.user_id, c.code as currency_code, sum(p.current_balance) as liquid_total
  from public.portfolios p join public.currencies c on c.id = p.currency_id
  where p.is_liquid and not p.is_archived group by p.user_id, c.code;

-- Debt ORIGINATION is excluded for the same reason transfer_in/transfer_out are
-- absent from the kind list: it changes the form of your net worth, not what you
-- earned or spent. Borrowing swaps a liability for cash; lending swaps cash for a
-- receivable. Counting either would report a 10,000 loan as 10,000 of income and
-- a 500 loan-out as 500 of spending — the same double-count the transfer
-- exclusion was added to prevent. Debt *payments* stay counted: servicing a debt
-- is real cash leaving, and Rule 14 makes that ledger row the single source of
-- truth for it.
create or replace view public.v_cashflow
  with (security_invoker = true) as
  select t.user_id, c.code as currency_code, t.txn_date, t.direction, sum(t.amount) as total
  from public.transactions t join public.currencies c on c.id = t.currency_id
  where t.is_void = false and t.kind in ('income','expense','debt_payment_made','debt_payment_received')
    and not exists (select 1 from public.incomes i
                     where i.transaction_id = t.id and i.source = 'loan_received')
    and not exists (select 1 from public.expenses e
                     where e.transaction_id = t.id and e.debt_id is not null)
  group by t.user_id, c.code, t.txn_date, t.direction;

-- Same exclusion: money lent out is not a spending category. `debt_id is null`
-- is safe as the marker because Rule 14 / DECISIONS-NEEDED #3 make the debt
-- payment its own ledger kind — a debt-linked EXPENSE only ever comes from
-- create_debt()'s lending leg.
create or replace view public.v_expense_by_category
  with (security_invoker = true) as
  select e.user_id, ec.id as category_id, ec.name as category_name, t.txn_date,
         c.code as currency_code, sum(t.amount) as total
  from public.expenses e
  join public.transactions t on t.id = e.transaction_id and t.is_void = false
  join public.expense_categories ec on ec.id = e.category_id
  join public.currencies c on c.id = t.currency_id
  where e.debt_id is null
  group by e.user_id, ec.id, ec.name, t.txn_date, c.code;

create or replace view public.v_debt_outstanding
  with (security_invoker = true) as
  select d.user_id, d.id as debt_id, d.kind, d.counterparty, d.outstanding_balance, d.status, c.code as currency_code
  from public.debts d join public.currencies c on c.id = d.currency_id where not d.is_archived;

create or replace view public.v_completed_goals
  with (security_invoker = true) as
  select g.user_id, g.id as goal_id, g.name, g.target_amount, g.current_amount,
         coalesce(g.achieved_at, g.first_achieved_at) as achieved_at, g.first_achieved_at, g.status,
         c.code as currency_code
  from public.goals g join public.currencies c on c.id = g.currency_id
  where g.first_achieved_at is not null;   -- ever-achieved survives later withdrawals

create or replace view public.v_investment_performance
  with (security_invoker = true) as
  select i.user_id, i.id as investment_id, i.name, i.kind, i.symbol, i.invested_amount, i.current_value, i.unrealized_gain,
         case when i.invested_amount > 0 then round((i.current_value - i.invested_amount) / i.invested_amount * 100, 2) else null end as return_pct,
         c.code as currency_code
  from public.investments i join public.currencies c on c.id = i.currency_id where i.is_active;