-- ============================================================================
-- PERSONAL FINANCE TRACKER — ROW LEVEL SECURITY + GRANTS (rlsSql)  [REVISED]
-- Run AFTER the schema block. Default-deny: RLS on + no policy = zero rows.
-- Ownership predicate: user_id = auth.uid().
--
-- KEY CHANGE: has_feature(...) gates WRITES only (create/edit/delete). SELECT is
-- NOT feature-gated, so disabling a feature never erases visibility of already-
-- recorded historical data (Req 18) and reporting keeps working (Rule 15).
-- Views in the schema use security_invoker, so they honor these SELECT policies.
-- ============================================================================

-- 1. REFERENCE TABLES — world-readable to authenticated; admin-writable.
alter table public.currencies enable row level security;
create policy currencies_read on public.currencies for select to authenticated using (true);
create policy currencies_admin_write on public.currencies for all to authenticated using (public.is_admin()) with check (public.is_admin());

alter table public.features enable row level security;
create policy features_read on public.features for select to authenticated using (true);
create policy features_admin_write on public.features for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 2. PROFILES (BR4, Rule 4). Own row, or any row for admins. No client INSERT
--    (created by on_auth_user_created definer). Role escalation blocked below.
alter table public.profiles enable row level security;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_all on public.profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.profiles_guard_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin may change a user role';
  end if;
  if new.is_active is distinct from old.is_active and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin may activate/deactivate a user';
  end if;
  return new;
end $$;
create trigger trg_profiles_guard_role before update on public.profiles
  for each row execute function public.profiles_guard_role();

-- 3. PER-USER LOOKUPS
alter table public.money_purpose_tags enable row level security;
create policy purpose_tags_select on public.money_purpose_tags for select to authenticated using (user_id = auth.uid());
create policy purpose_tags_insert on public.money_purpose_tags for insert to authenticated with check (user_id = auth.uid());
create policy purpose_tags_update on public.money_purpose_tags for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy purpose_tags_delete on public.money_purpose_tags for delete to authenticated using (user_id = auth.uid());

-- expense_categories writes are gated by the 'expenses' feature (Rule 21).
alter table public.expense_categories enable row level security;
create policy expense_cat_select on public.expense_categories for select to authenticated using (user_id = auth.uid());
create policy expense_cat_insert on public.expense_categories for insert to authenticated with check (user_id = auth.uid() and public.has_feature('expenses'));
create policy expense_cat_update on public.expense_categories for update to authenticated using (user_id = auth.uid() and public.has_feature('expenses')) with check (user_id = auth.uid() and public.has_feature('expenses'));
-- NO delete policy: categories are SOFT-DELETED (is_active=false) for Rule 19;
-- expenses.category_id ON DELETE RESTRICT is the safety net.

-- 4. PORTFOLIOS (BR5-7). Owner-scoped CRUD. Writes gated by 'portfolios' (Rule 21).
alter table public.portfolios enable row level security;
create policy portfolios_select on public.portfolios for select to authenticated using (user_id = auth.uid());
create policy portfolios_insert on public.portfolios for insert to authenticated with check (user_id = auth.uid() and public.has_feature('portfolios'));
create policy portfolios_update on public.portfolios for update to authenticated using (user_id = auth.uid() and public.has_feature('portfolios')) with check (user_id = auth.uid() and public.has_feature('portfolios'));
create policy portfolios_delete on public.portfolios for delete to authenticated using (user_id = auth.uid() and public.has_feature('portfolios'));
-- Hard delete is blocked by transactions.portfolio_id ON DELETE RESTRICT when
-- history exists; UI should ARCHIVE (is_archived=true) instead (BR6/BR18).

-- 5. TRANSACTIONS — APPEND-ONLY ledger. SELECT (never gated) + INSERT + void UPDATE.
--    INSERT is gated per-kind: income->'income', expense->'expense',
--    transfer_*->'transfers', debt_payment_*->'debts'. Other kinds (opening_balance,
--    adjustment, transfer legs posted by SECURITY DEFINER RPCs) bypass the user
--    check since RPCs run as definer.
alter table public.transactions enable row level security;
create policy txn_select on public.transactions for select to authenticated using (user_id = auth.uid());
create policy txn_insert on public.transactions for insert to authenticated
  with check (user_id = auth.uid()
    and exists (select 1 from public.portfolios p where p.id = portfolio_id and p.user_id = auth.uid())
    and (
      (kind = 'income'  and public.has_feature('income'))
      or (kind = 'expense' and public.has_feature('expenses'))
      or (kind in ('transfer_in','transfer_out') and public.has_feature('transfers'))
      or (kind in ('debt_payment_made','debt_payment_received') and public.has_feature('debts'))
      or (kind in ('opening_balance','adjustment'))
    ));
create policy txn_update_void on public.transactions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.txn_immutable_guard()
returns trigger language plpgsql as $$
begin
  if (new.portfolio_id, new.kind, new.direction, new.amount, new.currency_id, new.txn_date, new.user_id)
     is distinct from
     (old.portfolio_id, old.kind, old.direction, old.amount, old.currency_id, old.txn_date, old.user_id) then
    raise exception 'Ledger rows are immutable; post an adjustment or void instead';
  end if;
  return new;
end $$;
create trigger trg_txn_immutable before update on public.transactions
  for each row execute function public.txn_immutable_guard();
-- NO delete policy -> ledger rows cannot be deleted by clients.

-- 6. DETAIL TABLES — owner-scoped; INSERT validates the parent ledger row.
--    Writes gated by the matching feature; SELECT always open (Req 18).
alter table public.incomes enable row level security;
create policy incomes_select on public.incomes for select to authenticated using (user_id = auth.uid());
create policy incomes_insert on public.incomes for insert to authenticated
  with check (user_id = auth.uid() and public.has_feature('income')
    and exists (select 1 from public.transactions t where t.id = transaction_id and t.user_id = auth.uid()));
create policy incomes_update on public.incomes for update to authenticated using (user_id = auth.uid() and public.has_feature('income')) with check (user_id = auth.uid() and public.has_feature('income'));
create policy incomes_delete on public.incomes for delete to authenticated using (user_id = auth.uid() and public.has_feature('income'));

alter table public.expenses enable row level security;
create policy expenses_select on public.expenses for select to authenticated using (user_id = auth.uid());
create policy expenses_insert on public.expenses for insert to authenticated
  with check (user_id = auth.uid() and public.has_feature('expenses')
    and exists (select 1 from public.transactions t where t.id = transaction_id and t.user_id = auth.uid())
    and exists (select 1 from public.expense_categories ec where ec.id = category_id and ec.user_id = auth.uid()));
create policy expenses_update on public.expenses for update to authenticated using (user_id = auth.uid() and public.has_feature('expenses')) with check (user_id = auth.uid() and public.has_feature('expenses'));
create policy expenses_delete on public.expenses for delete to authenticated using (user_id = auth.uid() and public.has_feature('expenses'));

-- transfers: created only by RPC — do_transfer() on the RLS path, or
-- create_transfer() when ledger-service calls in as service_role. Owner reads;
-- no direct writes either way.
alter table public.transfers enable row level security;
create policy transfers_select on public.transfers for select to authenticated using (user_id = auth.uid());

-- debt_payments: created only by do_debt_payment() RPC (links to ledger row).
-- Owner reads; SELECT not feature-gated so history stays visible (Req 18).
alter table public.debt_payments enable row level security;
create policy debt_pay_select on public.debt_payments for select to authenticated using (user_id = auth.uid());

-- 7. DEBTS — writes feature-gated ('debts'); SELECT open for historical reporting.
alter table public.debts enable row level security;
create policy debts_select on public.debts for select to authenticated using (user_id = auth.uid());
create policy debts_insert on public.debts for insert to authenticated with check (user_id = auth.uid() and public.has_feature('debts'));
create policy debts_update on public.debts for update to authenticated using (user_id = auth.uid() and public.has_feature('debts')) with check (user_id = auth.uid() and public.has_feature('debts'));
create policy debts_delete on public.debts for delete to authenticated using (user_id = auth.uid() and public.has_feature('debts'));

-- 8. GOALS + CONTRIBUTIONS — writes feature-gated ('goals'); SELECT open.
alter table public.goals enable row level security;
create policy goals_select on public.goals for select to authenticated using (user_id = auth.uid());
create policy goals_insert on public.goals for insert to authenticated with check (user_id = auth.uid() and public.has_feature('goals'));
create policy goals_update on public.goals for update to authenticated using (user_id = auth.uid() and public.has_feature('goals')) with check (user_id = auth.uid() and public.has_feature('goals'));
create policy goals_delete on public.goals for delete to authenticated using (user_id = auth.uid() and public.has_feature('goals'));

alter table public.goal_contributions enable row level security;
create policy goal_contrib_select on public.goal_contributions for select to authenticated using (user_id = auth.uid());
create policy goal_contrib_insert on public.goal_contributions for insert to authenticated
  with check (user_id = auth.uid() and public.has_feature('goals')
    and exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()));
create policy goal_contrib_update on public.goal_contributions for update to authenticated using (user_id = auth.uid() and public.has_feature('goals')) with check (user_id = auth.uid() and public.has_feature('goals'));
create policy goal_contrib_delete on public.goal_contributions for delete to authenticated using (user_id = auth.uid() and public.has_feature('goals'));

-- 9. INVESTMENTS + SNAPSHOTS — writes feature-gated ('investments'); SELECT open.
alter table public.investments enable row level security;
create policy inv_select on public.investments for select to authenticated using (user_id = auth.uid());
create policy inv_insert on public.investments for insert to authenticated with check (user_id = auth.uid() and public.has_feature('investments'));
create policy inv_update on public.investments for update to authenticated using (user_id = auth.uid() and public.has_feature('investments')) with check (user_id = auth.uid() and public.has_feature('investments'));
create policy inv_delete on public.investments for delete to authenticated using (user_id = auth.uid() and public.has_feature('investments'));

alter table public.investment_snapshots enable row level security;
create policy inv_snap_select on public.investment_snapshots for select to authenticated using (user_id = auth.uid());
create policy inv_snap_insert on public.investment_snapshots for insert to authenticated
  with check (user_id = auth.uid() and public.has_feature('investments')
    and exists (select 1 from public.investments i where i.id = investment_id and i.user_id = auth.uid()));
create policy inv_snap_update on public.investment_snapshots for update to authenticated using (user_id = auth.uid() and public.has_feature('investments')) with check (user_id = auth.uid() and public.has_feature('investments'));
create policy inv_snap_delete on public.investment_snapshots for delete to authenticated using (user_id = auth.uid() and public.has_feature('investments'));

-- 10. USER FEATURE ACCESS (Rule 21). Users READ own; only admins WRITE.
alter table public.user_feature_access enable row level security;
create policy ufa_select on public.user_feature_access for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy ufa_admin_write on public.user_feature_access for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 11. AUDIT LOG (Rule 20). Admin-only read; NO client write (definer trigger).
alter table public.audit_log enable row level security;
create policy audit_admin_read on public.audit_log for select to authenticated using (public.is_admin());

-- 12. GRANTS (PostgREST table-level privileges; RLS still governs rows).
grant usage on schema public to anon, authenticated;
grant select on public.currencies, public.features to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.money_purpose_tags, public.expense_categories,
  public.portfolios, public.transactions, public.incomes, public.expenses,
  public.debts, public.debt_payments, public.goals, public.goal_contributions,
  public.investments, public.investment_snapshots, public.user_feature_access
to authenticated;
grant select on public.transfers to authenticated;   -- writes via transfer RPCs only
grant select on public.audit_log to authenticated;    -- RLS limits to admins
grant select on
  public.v_portfolio_balances, public.v_liquid_by_currency, public.v_cashflow,
  public.v_expense_by_category, public.v_income_by_source, public.v_debt_outstanding,
  public.v_completed_goals, public.v_investment_performance
to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- 12b. SERVICE ROLE — the trusted server-side key (secret; never sent to the
-- browser; bypasses RLS). Supabase's "Automatically expose new tables" is OFF
-- (we grant explicitly), and that toggle is what would normally grant
-- service_role too — so grant it here. Needed for server-side/admin/onboarding
-- code (e.g. the sample-portfolio onboarding in seed.sql) via the Data API.
-- This does NOT widen the public surface: anon/authenticated stay locked down.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all routines in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

-- 13. NOTE on reports feature: report VIEWS use security_invoker and cannot
-- self-check has_feature('reports'); gate report ROUTES at the API layer. The
-- 'reports' feature flag is therefore advisory at the DB level by design.