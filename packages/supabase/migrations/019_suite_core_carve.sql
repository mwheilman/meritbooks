-- Migration 019: Suite Core carve (Session 14)
-- =============================================================
-- Establishes the Merit Enterprise Suite "core" layer: a dedicated `core`
-- Postgres schema (same database) that OWNS the eight shared master-data
-- objects every module references. Future modules (Projects, Inventory, HRIS)
-- reference these by UUID FK and never copy or re-sync them.
--
-- The eight core-owned objects:
--   organizations, locations (the entity/company), departments,
--   customers, vendors, items, employees, jobs
--
-- This migration is the SECOND HALF of a coordinated change: the application
-- (tar.gz delivered with this migration) schema-qualifies every read/write of
-- these tables to `core`. RUN THIS MIGRATION FIRST, THEN DEPLOY THE CODE,
-- OR the order does not matter because there is no data and the app cannot
-- reach the tables until both are in place. After running, complete the ONE
-- dashboard step in section 6 to expose `core` to the REST API.
--
-- Safe to run on the current tabula-rasa DB (only COA seed + wipeable Acme
-- data present). No data re-keying: all UUID PKs/FKs are preserved by moving
-- whole tables with SET SCHEMA (dependencies resolve by OID, so existing FKs
-- from Books tables — bills.vendor_id, invoices.customer_id, line item_id,
-- jobs.location_id, etc. — and the five financial views are NOT broken).
--
-- Idempotent: re-running is harmless.
-- =============================================================

-- =============================================================
-- 1. CREATE THE CORE SCHEMA
-- =============================================================

create schema if not exists core;

comment on schema core is
  'Merit Enterprise Suite shared master data. Owned by Suite Core; referenced by every module via UUID FK. Modules never copy or re-sync these objects.';

-- =============================================================
-- 2. MOVE THE EIGHT CORE-OWNED TABLES INTO `core`
-- =============================================================
-- SET SCHEMA preserves the table OID, so RLS policies, triggers, indexes,
-- and all inbound/outbound foreign keys travel with the table untouched.
-- Guarded so a re-run (table already in core) is a no-op.

do $$
declare
  t text;
  core_tables text[] := array[
    'organizations','locations','departments','customers',
    'vendors','items','employees','jobs'
  ];
begin
  foreach t in array core_tables loop
    if exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      execute format('alter table public.%I set schema core', t);
      raise notice 'Moved public.% -> core.%', t, t;
    else
      raise notice 'Skipped % (not in public; already moved or absent)', t;
    end if;
  end loop;
end $$;

-- =============================================================
-- 3. THIN-CANONICAL FIELD ADDITIONS (core holds only what every module needs)
-- =============================================================

-- ── items: canonical SKU + type + income/COGS account mapping ──────────────
-- Reserved for the future Inventory module (NOT added here): UOM conversions,
-- serialization, lots, remnants, per-location / truck stock, BOM.

-- Canonical identifier is `sku` (was `code`). Rename only if not already done.
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'core' and table_name = 'items' and column_name = 'code'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'core' and table_name = 'items' and column_name = 'sku'
  ) then
    alter table core.items rename column code to sku;
  end if;
end $$;

alter table core.items
  add column if not exists item_type text not null default 'INVENTORY'
    check (item_type in ('INVENTORY','NON_INVENTORY','SERVICE','LABOR','OTHER'));

-- income/COGS account mapping points into the Books COA (public.accounts).
-- These are Books-owned columns co-located on a core table (documented).
alter table core.items
  add column if not exists income_account_id uuid references public.accounts(id);
alter table core.items
  add column if not exists cogs_account_id uuid references public.accounts(id);

-- ── employees: payroll account mapping ─────────────────────────────────────
-- Reserved for the future HRIS/payroll module (NOT added here): benefits,
-- certifications, full payroll, time tracking. Labor columns already retired
-- in migration 017.
alter table core.employees
  add column if not exists payroll_account_id uuid references public.accounts(id);

-- ── jobs: thin identity only (no change needed) ────────────────────────────
-- core.jobs holds thin job identity and remains a GL dimension. The budget /
-- actuals / rev-rec columns already present are Books-owned-and-co-located
-- (NOT part of the core contract). Operational job layer (phases, scheduling,
-- dispatch, change orders, daily logs, field/portal) is reserved for
-- MeritProjects (Module 2), which will extend core.jobs. The existing
-- job_phases / job_cost_codes / job_cost_entries / change_orders tables stay
-- Books-owned for now and FK into core.jobs; operational ownership transfers
-- to MeritProjects when it lands.

-- =============================================================
-- 4. RLS — confirm enabled on moved tables (policies travelled with them)
-- =============================================================
-- The org_isolation policies and RLS enablement moved with each table. We
-- re-assert ENABLE defensively (no-op if already enabled). get_org_id() lives
-- in public and is referenced fully-qualified by the policies, so it keeps
-- working across the schema boundary.

alter table core.organizations enable row level security;
alter table core.locations    enable row level security;
alter table core.departments  enable row level security;
alter table core.customers    enable row level security;
alter table core.vendors      enable row level security;
alter table core.items        enable row level security;
alter table core.employees    enable row level security;
alter table core.jobs         enable row level security;

-- =============================================================
-- 5. GRANTS — let the API roles reach core (required for PostgREST)
-- =============================================================
-- Supabase API roles must have USAGE on the schema and table privileges, or
-- every query 404s/403s. RLS still governs row visibility.

grant usage on schema core to anon, authenticated, service_role;

grant select, insert, update, delete
  on all tables in schema core
  to anon, authenticated, service_role;

grant usage, select
  on all sequences in schema core
  to anon, authenticated, service_role;

-- Future tables/sequences added to core inherit these grants automatically.
alter default privileges in schema core
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema core
  grant usage, select on sequences to anon, authenticated, service_role;

-- =============================================================
-- 6. EXPOSE `core` TO THE REST API  ← ONE DASHBOARD STEP REQUIRED
-- =============================================================
-- PostgREST only serves schemas on its exposed list (default: just `public`).
-- The grants above are necessary but NOT sufficient; the schema must also be
-- added to the exposed list. The canonical, durable way on Supabase is the
-- dashboard toggle:
--
--   Supabase Dashboard → Project Settings → API →
--   "Exposed schemas" → add  core  (keep public, graphql_public) → Save
--
-- That is the only non-SQL action in this session and takes ~20 seconds.
-- (A role-config attempt is included below for completeness, but the managed
-- platform treats the dashboard list as canonical, so DO the dashboard step.)

do $$ begin
  begin
    execute 'alter role authenticator set pgrst.db_schemas = ''public, core, graphql_public''';
    perform pg_notify('pgrst', 'reload config');
  exception when others then
    raise notice 'Role-config exposure skipped (use the dashboard Exposed schemas toggle).';
  end;
end $$;

-- =============================================================
-- DONE. core now owns the eight master-data objects. Books is unchanged.
-- =============================================================
