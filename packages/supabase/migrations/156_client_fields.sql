-- =============================================================================
-- Migration 156: client fields (IA-SPEC §1.6 M-2) — wave 1 "access foundations"
-- =============================================================================
-- core.locations IS the Client. Adds:
--   is_tenant_own_books          GENERATED from is_management_company (see below)
--   client_status                onboarding | active | paused | archived (default active)
--   client_number                text, unique per org when set
--   primary_contact_membership_id uuid -> core.memberships
--   close_due_business_day       int (null = tenant default)
--   tags                         text[] not null default '{}'  (drives client-set rules, 05 R-4)
--   industry                     text (already present on live; add-if-missing)
--   modules_in_use               jsonb (null = computed fallback; set by onboarding 08)
-- core.customers:
--   is_related_client            GENERATED from is_portfolio_company
--   related_location_id          uuid -> core.locations
--
-- THE RENAME, DONE ADDITIVELY. M-2 renames is_management_company → is_tenant_own_books
-- with a one-release alias. A rename (or drop) is not additive and would break every
-- current reader/writer (api/me, add-company dialog, team routes). So the NEW name is
-- added as a STORED GENERATED alias of the OLD column: writers keep writing
-- is_management_company, every new reader (client sets, access assignments) reads
-- is_tenant_own_books, and the two can never disagree. Wave 8 (R-14) flips it: rename
-- the real column and make the old name the alias. Same pattern for
-- customers.is_portfolio_company → is_related_client.
--
-- Data step:
--   * client_status = 'archived' for inactive clients (first run: only rows still at the
--     column default AND inactive), 'onboarding' is NOT inferred (onboarding_status is a
--     separate, per-company lifecycle from mig 121).
--   * Tenant's own books: the ONLY generic signal is is_management_company (mig 111);
--     no name matching (white-label rule, CANON §1). On the live DB (checked 2026-10-20)
--     no location in either tenant carries it — the working tenant's clients are
--     "[SANDBOX] Coho Flooring", "[SANDBOX] Northwind Construction", "Acme Test Co"; no
--     "Merit Management Group LLC" location exists — so own books stays unset and is
--     reported to the lead/owner.
--
-- ADDITIVE + IDEMPOTENT. No behavior change.
-- SECURITY NOTE (for wave 2): core.locations / core.customers are still member-WRITABLE
-- (policy org_isolation FOR ALL). Once tags / is_management_company drive rule-based
-- client sets and therefore access, those writes must move server-side (154 pattern)
-- before enforcement flips. Flagged in the wave-1 report.
-- =============================================================================

-- ── core.locations ───────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'core' and table_name = 'locations' and column_name = 'is_tenant_own_books') then
    alter table core.locations
      add column is_tenant_own_books boolean generated always as (coalesce(is_management_company, false)) stored;
  end if;
end $$;

alter table core.locations add column if not exists client_status text not null default 'active';
alter table core.locations add column if not exists client_number text;
alter table core.locations add column if not exists primary_contact_membership_id uuid;
alter table core.locations add column if not exists close_due_business_day int;
alter table core.locations add column if not exists tags text[] not null default '{}';
alter table core.locations add column if not exists industry text;
alter table core.locations add column if not exists modules_in_use jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'locations_client_status_chk') then
    alter table core.locations add constraint locations_client_status_chk
      check (client_status in ('onboarding', 'active', 'paused', 'archived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'locations_primary_contact_membership_fkey') then
    alter table core.locations add constraint locations_primary_contact_membership_fkey
      foreign key (primary_contact_membership_id) references core.memberships(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'locations_close_due_bd_chk') then
    alter table core.locations add constraint locations_close_due_bd_chk
      check (close_due_business_day is null or close_due_business_day between 1 and 31);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'locations_modules_in_use_obj_chk') then
    alter table core.locations add constraint locations_modules_in_use_obj_chk
      check (modules_in_use is null or jsonb_typeof(modules_in_use) = 'object');
  end if;
end $$;

create unique index if not exists uq_locations_org_client_number
  on core.locations (org_id, client_number) where client_number is not null;
create index if not exists idx_locations_tags on core.locations using gin (tags);

-- At most one own-books client per tenant. Guarded: if existing data already has more
-- than one flagged location, skip (and say so) rather than fail the migration.
do $$ begin
  if not exists (select 1 from pg_indexes where schemaname = 'core' and indexname = 'uq_locations_one_own_books') then
    if exists (select 1 from core.locations where is_tenant_own_books group by org_id having count(*) > 1) then
      raise notice 'migration 156: a tenant has >1 own-books location; uq_locations_one_own_books NOT created';
    else
      create unique index uq_locations_one_own_books on core.locations (org_id) where is_tenant_own_books;
    end if;
  end if;
end $$;

comment on column core.locations.is_tenant_own_books is
  'IA M-2: the client that IS the tenant. Generated alias of is_management_company for one release (writers keep writing the old column).';
comment on column core.locations.tags is
  'IA M-2: free tags (e.g. HVAC) — drive rule-based client sets (05 R-4), compare sets and the Industries filter.';

-- Data step: archived clients (first run only — rows still at the default).
update core.locations
   set client_status = 'archived'
 where is_active = false and client_status = 'active';

-- ── core.customers ───────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('core.customers') is not null then
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'core' and table_name = 'customers' and column_name = 'is_related_client') then
      if exists (select 1 from information_schema.columns
                  where table_schema = 'core' and table_name = 'customers' and column_name = 'is_portfolio_company') then
        execute 'alter table core.customers add column is_related_client boolean generated always as (coalesce(is_portfolio_company, false)) stored';
      else
        execute 'alter table core.customers add column is_related_client boolean not null default false';
      end if;
    end if;
    execute 'alter table core.customers add column if not exists related_location_id uuid';
    if not exists (select 1 from pg_constraint where conname = 'customers_related_location_fkey') then
      execute 'alter table core.customers add constraint customers_related_location_fkey
                 foreign key (related_location_id) references core.locations(id) on delete set null';
    end if;
  end if;
end $$;
