-- Migration 029: Posting-Engine Foundation (GATE 2 — Session 21)
-- =============================================================
-- The deterministic posting engine rests on four foundations, all ADDITIVE and
-- idempotent (safe to re-run, safe on the live single-org DB):
--
--   1. ENTITY HIERARCHY on core.locations (the company/entity) — parent_entity_id
--      + ownership_pct. Built now because multi-entity CONSOLIDATION (the core
--      PE/holding-company value) is a committed build that depends on it.
--   2. CURRENCY SEAM — a `currency` (NOT NULL, home-currency default) + nullable
--      `fx_rate` on every monetary-bearing row, plus `home_currency` on the org.
--      INERT today (all math stays home-currency); the columns exist so a future
--      multi-currency engine populates rather than migrates. The one deferred item.
--   3. TRANSACTION-TYPE CATALOG (core.transaction_types) — the enumerated universe
--      from the Transaction & Posting Engine Spec Part E, plus reserved slots for
--      purchase_order / po_receipt / inventory_adjustment / encumbrance (GATE 11).
--   4. ACCOUNT-ROLE TAGGING — core.account_role_keys (the controlled vocabulary +
--      each role's default standard account number + scope) and public.account_roles
--      (per-org / per-location mapping role -> real account). Posting templates
--      resolve ROLES, never hard-coded account numbers. Seeded from the standard
--      COA via public.seed_account_roles(); editable per tenant.
--
-- Schema facts this migration relies on (verified against the repo, not assumed):
--   - core.organizations, core.locations are in the `core` schema (migration 019).
--   - accounts stays in `public` (public.accounts) with account_number, account_type,
--     account_sub_type, is_control_account, is_company_specific, company_location_id.
--   - Monetary tables in public: gl_entry_lines, bills, invoices, bank_transactions,
--     receipts, internal_invoices.
--   - RLS everywhere via public.get_org_id().
--
-- Requires: 001 (orgs), 003 (accounts), 004 (GL), 015 (internal_invoices),
--           019 (core carve). Next migration number after this: 030.
-- =============================================================

-- ---- Guard: confirm the core carve has run ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'locations') then
    raise exception 'core.locations not found — deploy migration 019 (core carve) before 029.';
  end if;
end $$;

-- =============================================================
-- 1. ENTITY HIERARCHY (on core.locations = the company/entity)
-- =============================================================
-- A tenant (core.organizations) contains a tree of companies (core.locations).
-- parent_entity_id is a self-reference within locations; the root(s) have NULL.
-- ownership_pct is the parent's ownership of this entity (default 100 = wholly owned),
-- consumed later by the consolidation gate for minority-interest handling.

alter table core.locations
  add column if not exists parent_entity_id uuid references core.locations(id),
  add column if not exists ownership_pct numeric(7,4) not null default 100
    check (ownership_pct >= 0 and ownership_pct <= 100);

-- An entity cannot be its own parent. (Deep-cycle prevention is deferred to the
-- consolidation gate, which walks the tree; a self-parent is the only case the
-- foundation must reject outright.)
do $$ begin
  alter table core.locations
    add constraint chk_location_not_self_parent
    check (parent_entity_id is null or parent_entity_id <> id);
exception when duplicate_object then null; end $$;

create index if not exists idx_locations_parent on core.locations(parent_entity_id)
  where parent_entity_id is not null;

-- =============================================================
-- 2. CURRENCY SEAM (inert; the one deferred feature)
-- =============================================================
-- Home currency on the tenant. All amounts stay in home currency today.
alter table core.organizations
  add column if not exists home_currency text not null default 'USD';

-- Add `currency` (NOT NULL, default 'USD') + nullable `fx_rate` to every
-- monetary-bearing table that exists. Guarded so the migration never fails on a
-- table that was renamed or not yet created.
do $$
declare
  t text;
  monetary_tables text[] := array[
    'gl_entry_lines', 'bills', 'invoices', 'bank_transactions',
    'receipts', 'internal_invoices'
  ];
begin
  foreach t in array monetary_tables loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format(
        'alter table public.%I
           add column if not exists currency text not null default ''USD'',
           add column if not exists fx_rate numeric(18,8)', t);
      raise notice 'Currency seam added to public.%', t;
    else
      raise notice 'Skipped public.% (table not present)', t;
    end if;
  end loop;
end $$;

-- =============================================================
-- 3. TRANSACTION-TYPE CATALOG (the posting universe)
-- =============================================================
create table if not exists core.transaction_types (
  code text primary key,
  label text not null,
  category text not null,         -- groups for UI/reporting
  lifecycle text not null default 'ONE_STEP'
    check (lifecycle in ('ONE_STEP', 'TWO_STEP', 'SCHEDULE', 'SYSTEM')),
  is_reserved boolean not null default false,  -- reserved future slot (no builder yet)
  display_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Catalog is reference data shared by all tenants (not org-scoped). Read-only to
-- API roles; no RLS needed (no tenant rows).
grant select on core.transaction_types to anon, authenticated, service_role;

insert into core.transaction_types (code, label, category, lifecycle, is_reserved, display_order) values
  -- Purchases & operating expenses
  ('vendor_bill',            'Vendor bill (on account)',        'PURCHASES', 'TWO_STEP',  false, 10),
  ('bill_payment',           'Bill payment',                    'PURCHASES', 'TWO_STEP',  false, 11),
  ('direct_expense',         'Direct expense (paid now)',       'PURCHASES', 'ONE_STEP',  false, 12),
  ('prepaid_purchase',       'Prepaid expense',                 'PURCHASES', 'SCHEDULE',  false, 13),
  ('inventory_purchase',     'Inventory purchase',              'PURCHASES', 'TWO_STEP',  false, 14),
  ('vendor_credit',          'Vendor credit / refund',          'PURCHASES', 'ONE_STEP',  false, 15),
  -- Revenue & receivables
  ('customer_invoice',       'Customer invoice (on account)',   'REVENUE',   'TWO_STEP',  false, 20),
  ('cash_sale',              'Cash / point-of-sale',            'REVENUE',   'ONE_STEP',  false, 21),
  ('customer_payment',       'Customer payment',                'REVENUE',   'TWO_STEP',  false, 22),
  ('deferred_revenue',       'Customer deposit / deferred',     'REVENUE',   'SCHEDULE',  false, 23),
  ('progress_billing',       'Progress billing',                'REVENUE',   'TWO_STEP',  false, 24),
  ('retainage',              'Retainage',                       'REVENUE',   'TWO_STEP',  false, 25),
  ('customer_refund',        'Customer refund / return',        'REVENUE',   'ONE_STEP',  false, 26),
  ('bad_debt',               'Bad-debt write-off',              'REVENUE',   'ONE_STEP',  false, 27),
  -- Cash & bank
  ('bank_transfer',          'Bank transfer (own accounts)',    'CASH',      'ONE_STEP',  false, 30),
  ('bank_fee',               'Bank / merchant fee',             'CASH',      'ONE_STEP',  false, 31),
  ('interest_income',        'Interest income',                 'CASH',      'ONE_STEP',  false, 32),
  ('undeposited_funds',      'Undeposited funds / deposit',     'CASH',      'TWO_STEP',  false, 33),
  ('nsf_reversal',           'NSF / bounced payment',           'CASH',      'ONE_STEP',  false, 34),
  -- Credit cards
  ('cc_charge',              'Credit-card charge',              'CREDIT_CARD','TWO_STEP', false, 40),
  ('cc_payment',             'Credit-card statement payment',   'CREDIT_CARD','TWO_STEP', false, 41),
  ('cc_refund',              'Credit-card refund / credit',     'CREDIT_CARD','ONE_STEP', false, 42),
  -- Payroll
  ('payroll_run',            'Payroll run',                     'PAYROLL',   'ONE_STEP',  false, 50),
  ('payroll_remittance',     'Payroll tax / benefit remittance','PAYROLL',   'TWO_STEP',  false, 51),
  -- Fixed assets
  ('asset_acquisition',      'Fixed-asset acquisition',         'FIXED_ASSET','ONE_STEP', false, 60),
  ('depreciation',           'Depreciation',                    'FIXED_ASSET','SCHEDULE', false, 61),
  ('asset_disposal',         'Asset disposal / sale',           'FIXED_ASSET','ONE_STEP', false, 62),
  -- Debt & financing
  ('loan_draw',              'Loan / LOC draw',                 'DEBT',      'ONE_STEP',  false, 70),
  ('loan_payment',           'Loan payment (principal+interest)','DEBT',     'SCHEDULE',  false, 71),
  ('accrued_interest',       'Accrued interest',                'DEBT',      'SCHEDULE',  false, 72),
  -- Equity
  ('owner_contribution',     'Owner contribution',              'EQUITY',    'ONE_STEP',  false, 80),
  ('owner_draw',             'Owner draw',                      'EQUITY',    'ONE_STEP',  false, 81),
  -- Tax
  ('sales_tax_remittance',   'Sales-tax remittance',            'TAX',       'TWO_STEP',  false, 90),
  ('income_tax_accrual',     'Income-tax accrual',              'TAX',       'SCHEDULE',  false, 91),
  -- Period-end & inter-company
  ('accrual',                'Accrual',                         'PERIOD_END','SCHEDULE',  false, 100),
  ('deferral',               'Deferral',                        'PERIOD_END','SCHEDULE',  false, 101),
  ('lease_inception',        'Lease inception (ASC 842)',       'PERIOD_END','SCHEDULE',  false, 102),
  ('lease_payment',          'Lease payment',                   'PERIOD_END','SCHEDULE',  false, 103),
  ('internal_invoice',       'Inter-department internal invoice','INTERNAL', 'TWO_STEP',  false, 110),
  -- Reserved future slots (GATE 11) — registered so the engine never reshapes
  ('purchase_order',         'Purchase order (commitment)',     'PROCUREMENT','SYSTEM',   true,  200),
  ('po_receipt',             'PO receipt',                      'PROCUREMENT','SYSTEM',   true,  201),
  ('inventory_adjustment',   'Inventory adjustment',            'INVENTORY', 'SYSTEM',    true,  202),
  ('encumbrance',            'Encumbrance / commitment entry',  'PROCUREMENT','SYSTEM',   true,  203)
on conflict (code) do update
  set label = excluded.label,
      category = excluded.category,
      lifecycle = excluded.lifecycle,
      is_reserved = excluded.is_reserved,
      display_order = excluded.display_order;

-- =============================================================
-- 4a. ACCOUNT-ROLE VOCABULARY (role -> standard number + scope)
-- =============================================================
-- scope ORG      => one mapping per org (shared control accounts)
-- scope LOCATION => one mapping per (org, location) (company-specific cash/CC)
create table if not exists core.account_role_keys (
  role_key text primary key,
  label text not null,
  scope text not null check (scope in ('ORG', 'LOCATION')),
  default_account_number text,   -- standard COA number used to auto-seed; nullable
  created_at timestamptz not null default now()
);

grant select on core.account_role_keys to anon, authenticated, service_role;

insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('AP_CONTROL',          'Accounts Payable (control)',        'ORG',      '2000'),
  ('AR_CONTROL',          'Accounts Receivable (control)',     'ORG',      '1100'),
  ('OPERATING_BANK',      'Operating bank (default)',          'LOCATION', '1000'),
  ('CASH_ON_HAND',        'Cash on hand / petty cash',         'LOCATION', '1050'),
  ('UNDEPOSITED_FUNDS',   'Undeposited funds',                 'ORG',      '1090'),
  ('CREDIT_CARD_PAYABLE', 'Credit card payable (default)',     'LOCATION', '2100'),
  ('SALES_TAX_PAYABLE',   'Sales / use tax payable',           'ORG',      '2300'),
  ('DEFERRED_REVENUE',    'Deferred revenue (billings)',       'ORG',      '2410'),
  ('UNBILLED_RECEIVABLE', 'Unbilled receivable (contract asset)','ORG',    '1180'),
  ('CUSTOMER_DEPOSITS',   'Customer deposits',                 'ORG',      '2420'),
  ('RETAINAGE_RECEIVABLE','Retainage receivable',              'ORG',      '1110'),
  ('RETAINAGE_PAYABLE',   'Retainage payable',                 'ORG',      '2010'),
  ('ACCRUED_EXPENSES',    'Accrued expenses',                  'ORG',      '2400'),
  ('ALLOWANCE_DOUBTFUL',  'Allowance for doubtful accounts',   'ORG',      '1150'),
  ('RETAINED_EARNINGS',   'Retained earnings',                 'ORG',      '3020'),
  ('CURRENT_YEAR_EARNINGS','Current-year earnings',            'ORG',      '3030'),
  ('OWNERS_CAPITAL',      'Owner''s capital',                  'ORG',      '3000'),
  ('OWNERS_DRAW',         'Owner''s draw',                     'ORG',      '3010'),
  ('JOB_WIP',             'Work in progress (job/inventory)',  'ORG',      '1210'),
  ('INTERCOMPANY_AR',     'Intercompany receivable',           'ORG',      '1160'),
  ('INTERCOMPANY_AP',     'Intercompany payable',              'ORG',      '2020')
on conflict (role_key) do update
  set label = excluded.label,
      scope = excluded.scope,
      default_account_number = excluded.default_account_number;

-- =============================================================
-- 4b. ACCOUNT-ROLE MAPPING (per-org / per-location -> real account)
-- =============================================================
create table if not exists public.account_roles (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  role_key text not null references core.account_role_keys(role_key),
  account_id uuid not null references public.accounts(id),
  location_id uuid references core.locations(id) on delete cascade, -- NULL = org-wide
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One org-wide mapping per role; one per (location, role) for location-scoped roles.
create unique index if not exists uq_account_roles_org
  on public.account_roles(org_id, role_key) where location_id is null;
create unique index if not exists uq_account_roles_loc
  on public.account_roles(org_id, role_key, location_id) where location_id is not null;
create index if not exists idx_account_roles_lookup on public.account_roles(org_id, role_key);

alter table public.account_roles enable row level security;
do $$ begin
  create policy "org_isolation" on public.account_roles
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_account_roles_updated before update on public.account_roles
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;

-- =============================================================
-- 4c. SEEDER — map roles to the org's COA by standard account number
-- =============================================================
-- Idempotent. ORG-scope roles map to the org-wide (non-company-specific) account
-- with the matching number. LOCATION-scope roles map per company-specific account
-- to its owning location. Existing mappings are never overwritten (ON CONFLICT
-- DO NOTHING) so a tenant's manual override is preserved.
create or replace function public.seed_account_roles(p_org uuid)
returns int as $$
declare
  inserted int := 0;
begin
  -- ORG-scope
  with ins as (
    insert into public.account_roles (org_id, role_key, account_id, location_id)
    select p_org, k.role_key, a.id, null
    from core.account_role_keys k
    join public.accounts a
      on a.org_id = p_org
     and a.account_number = k.default_account_number
     and a.is_company_specific = false
    where k.scope = 'ORG'
      and k.default_account_number is not null
    on conflict do nothing
    returning 1
  )
  select inserted + count(*) into inserted from ins;

  -- LOCATION-scope (company-specific accounts -> their owning location)
  with ins2 as (
    insert into public.account_roles (org_id, role_key, account_id, location_id)
    select p_org, k.role_key, a.id, a.company_location_id
    from core.account_role_keys k
    join public.accounts a
      on a.org_id = p_org
     and a.account_number = k.default_account_number
     and a.is_company_specific = true
     and a.company_location_id is not null
    where k.scope = 'LOCATION'
      and k.default_account_number is not null
    on conflict do nothing
    returning 1
  )
  select inserted + count(*) into inserted from ins2;

  return inserted;
end;
$$ language plpgsql;

-- Run the seeder for every existing org (single-org deployment today; safe for many).
do $$
declare o record;
begin
  for o in select id from core.organizations loop
    perform public.seed_account_roles(o.id);
  end loop;
end $$;

-- =============================================================
-- DONE. Foundation in place: entity hierarchy, currency seam,
-- transaction-type catalog, account-role tagging (seeded + editable).
-- Lifecycle state machines + settlement builders land in the next migration/step.
-- =============================================================
