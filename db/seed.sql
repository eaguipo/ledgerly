-- ============================================================================
-- PERSONAL FINANCE TRACKER — SEED DATA (seedSql)  [REVISED]
-- Run AFTER schema + rls. Seeds GLOBAL reference tables (currencies, features).
-- Per-user defaults (14 categories, 5 purpose tags, feature access) are created
-- automatically by handle_new_user() on signup. The back-fills below also apply
-- those defaults to any pre-existing users (idempotent).
--
-- ORDERING: this block (currencies + features) MUST run before any signup so
-- handle_new_user can resolve PHP and seed feature access. handle_new_user now
-- self-heals a missing PHP currency, but running this first is the supported path.
-- ============================================================================

-- 1. CURRENCIES (BR17). ISO 4217 + crypto pseudo-codes. PHP is the default.
--    minor_unit drives rounding (do_transfer rounds to destination minor_unit);
--    crypto holds up to 8/6 dp now that ledger money is numeric(38,18).
insert into public.currencies (code, name, symbol, minor_unit) values
  ('PHP', 'Philippine Peso',   '₱',   2),
  ('USD', 'US Dollar',         '$',   2),
  ('EUR', 'Euro',              '€',   2),
  ('GBP', 'British Pound',     '£',   2),
  ('JPY', 'Japanese Yen',      '¥',   0),
  ('SGD', 'Singapore Dollar',  'S$',  2),
  ('AUD', 'Australian Dollar', 'A$',  2),
  ('CAD', 'Canadian Dollar',   'C$',  2),
  ('HKD', 'Hong Kong Dollar',  'HK$', 2),
  ('AED', 'UAE Dirham',        'د.إ', 2),
  ('BTC', 'Bitcoin',           '₿',   8),
  ('ETH', 'Ethereum',          'Ξ',   8),
  ('USDT','Tether',            '₮',   6)
on conflict (code) do nothing;

-- 2. FEATURES catalog (Rule 21). is_default_enabled = grant for new users.
--    Enforcement: portfolios, income, expenses, transfers, debts, goals,
--    investments are enforced in RLS write policies. 'reports' is advisory
--    (gated at the API layer; see rls section 13).
insert into public.features (key, name, description, is_default_enabled) values
  ('portfolios',  'Portfolios / Accounts', 'Create and manage money holders',  true),
  ('income',      'Income',                'Record income transactions',        true),
  ('expenses',    'Expenses',              'Record daily expenses by category', true),
  ('transfers',   'Fund Transfers',        'Move money between portfolios',     true),
  ('debts',       'Debt Management',       'Track payables and receivables',    true),
  ('goals',       'Goal Tracking',         'Savings and financial goals',       true),
  ('investments', 'Investment Tracking',   'MP2, crypto, stocks, assets',       true),
  ('reports',     'Reports & Analytics',   'Date-range reports (API-gated)',    true)
on conflict (key) do nothing;

-- 3. DEFAULT EXPENSE CATEGORIES (per-user). Back-fill existing users (idempotent).
insert into public.expense_categories (user_id, name, is_system_default)
select p.id, cat.name, true
from public.profiles p
cross join (values
  ('Food'),('Grocery'),('Toiletries'),('Electricity'),('Internet'),('Gas'),
  ('House Share'),('Dog Care'),('Debt - Credit Card'),('Debt - TikTok'),
  ('Debt - Shopee'),('Life Insurance'),('Health Insurance'),('St Peter Life Plan')
) as cat(name)
where not exists (
  select 1 from public.expense_categories ec
  where ec.user_id = p.id and lower(ec.name) = lower(cat.name));

-- 4. DEFAULT "PURPOSE OF MONEY" TAGS (per-user). Back-fill (idempotent).
insert into public.money_purpose_tags (user_id, name, is_system)
select p.id, tag.name, true
from public.profiles p
cross join (values
  ('Savings'),('Emergency Fund'),('Investments'),('Cash'),('Travel Fund')
) as tag(name)
where not exists (
  select 1 from public.money_purpose_tags mt
  where mt.user_id = p.id and lower(mt.name) = lower(tag.name));

-- 5. BACK-FILL feature access for existing users (idempotent).
insert into public.user_feature_access (user_id, feature_id, is_enabled)
select p.id, f.id, f.is_default_enabled
from public.profiles p
cross join public.features f
where not exists (
  select 1 from public.user_feature_access uf
  where uf.user_id = p.id and uf.feature_id = f.id);

-- 6. BACK-FILL profiles.email from auth.users where it has drifted (idempotent).
--    Keeps the synced copy correct for users created before the sync trigger.
update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and p.email is distinct from u.email;

-- 7. SAMPLE PORTFOLIOS — per-user, OPTIONAL onboarding (NOT auto-created).
--    Sample set: Bank 1, Bank 2, Bank 3, Cash Wallet, Crypto Wallet, MP2 Investment.
--    Replace :user_id with a real profiles.id (or call from a Next.js onboarding
--    route using the service role). Opening balances post an 'opening_balance'
--    ledger row so current_balance reflects them via the cache trigger. Mark a
--    bank account is_savings=true to count it as liquid (Rule 16). Use
--    allow_negative=true for credit-style accounts that may go below zero.
--
--   insert into public.portfolios (user_id, name, category, currency_id, is_savings, sort_order)
--   select :user_id, v.name, v.cat::public.portfolio_category,
--          (select id from public.currencies where code='PHP'), v.savings, v.ord
--   from (values
--     ('Bank 1','bank',true,1),('Bank 2','bank',true,2),('Bank 3','bank',false,3),
--     ('Cash Wallet','cash',false,4),('Crypto Wallet','crypto',false,5),
--     ('MP2 Investment','investment',false,6)
--   ) as v(name, cat, savings, ord);
--
--   -- Seed an opening balance as a ledger row (cache trigger updates the portfolio):
--   insert into public.transactions (user_id, portfolio_id, kind, direction, amount, currency_id, txn_date, description)
--   values (:user_id, :portfolio_id, 'opening_balance', 'inflow', 5000.00,
--           (select id from public.currencies where code='PHP'), current_date, 'Opening balance');