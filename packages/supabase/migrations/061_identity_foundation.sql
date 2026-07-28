-- =============================================================================
-- Migration 061: identity foundation (multi-tenancy spine)
-- =============================================================================
-- The first-class identity layer from docs/FPB-identity-multitenancy.md §5.
-- ADDITIVE AND SAFE: creates new tables + a mapping column, changes NO route
-- behavior, removes nothing, backfills no data. The API keeps working exactly as
-- it does today. This is the schema the route-conversion + Clerk-JWT work
-- (a later phase, gated on Mike's Clerk dashboard steps) will build on.
--
-- Reconciliation fact (FPB §4): the 17 portfolio companies are already `locations`
-- inside ONE `organizations` row. "Organization" already means TENANT. This layer
-- sits ABOVE that — many tenant orgs, a user↔org membership spine, and a
-- platform-admin role that can cross tenants under audit.
--
-- Every new table gets RLS enabled (the schema RLS test enforces this; a
-- public/core table without RLS is reachable via the anon key).
-- =============================================================================

-- Clerk org  →  MeritBooks org uuid. The JWT template will emit the uuid as the
-- org_id claim so get_org_id() stays as written; this column is for provisioning
-- and reconciliation.
alter table core.organizations add column if not exists clerk_org_id text;
create unique index if not exists uq_org_clerk_org_id
  on core.organizations (clerk_org_id) where clerk_org_id is not null;

-- ---- core.users : one row per human, keyed to Clerk --------------------------
create table if not exists core.users (
  id                uuid primary key default gen_random_uuid(),
  clerk_user_id     text unique not null,
  email             text,
  first_name        text,
  last_name         text,
  -- coarse gate that a row MAY hold platform roles; authority is the membership
  -- role, not this flag (FPB §8 — deliberately NOT a super-user switch).
  is_platform_staff boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table core.users is
  'First-class identity, keyed to Clerk user_xxx. NOT the HR record (that stays core.employees). Auth/access decisions read users + memberships.';

-- ---- core.memberships : the user ↔ org ↔ role many-to-many spine ------------
create table if not exists core.memberships (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references core.users(id) on delete cascade,
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  role                   text not null,          -- role set: FPB §5.3
  status                 text not null default 'active'
                           check (status in ('active','invited','suspended')),
  clerk_org_membership_id text,                  -- mirror of Clerk membership id
  invited_by             uuid references core.users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (user_id, org_id)                       -- one role per user per org
);
comment on table core.memberships is
  'Membership spine: which user belongs to which tenant org, with what role. Role escalation is an UPDATE, not a second row.';
create index if not exists idx_memberships_user on core.memberships (user_id);
create index if not exists idx_memberships_org  on core.memberships (org_id);

-- ---- core.membership_locations : which locations a membership may access -----
-- Supersedes employee_locations (FPB §5.4). employee_locations is left in place;
-- migrating its rows is a later data step, not this additive migration.
create table if not exists core.membership_locations (
  id            uuid primary key default gen_random_uuid(),
  membership_id uuid not null references core.memberships(id) on delete cascade,
  location_id   uuid not null references core.locations(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (membership_id, location_id)
);

-- ---- core.platform_admin_sessions : audit spine for cross-org access ---------
create table if not exists core.platform_admin_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references core.users(id),          -- the platform admin
  target_org_id uuid not null references core.organizations(id),  -- org reached into
  reason        text,                                             -- ticket / fee-change ref
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  created_at    timestamptz not null default now()
);
comment on table core.platform_admin_sessions is
  'Every time a platform admin acts on a merchant org, a session is opened here. Cross-tenant access is explicit and audited, not an ambient super-user.';
create index if not exists idx_pas_user on core.platform_admin_sessions (user_id);
create index if not exists idx_pas_org  on core.platform_admin_sessions (target_org_id);

-- ---- RLS : every new table. service_role for the app; org-scope where possible.
alter table core.users                   enable row level security;
alter table core.memberships             enable row level security;
alter table core.membership_locations    enable row level security;
alter table core.platform_admin_sessions enable row level security;

do $$
begin
  -- users: self-read by Clerk sub claim; service_role full. anon denied.
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='users' and policyname='self_read') then
    create policy "self_read" on core.users for select
      using (clerk_user_id = (current_setting('request.jwt.claims', true)::json->>'sub'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='users' and policyname='service_all') then
    create policy "service_all" on core.users for all to service_role using (true) with check (true);
  end if;

  -- memberships: org-scoped read; service_role full.
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='memberships' and policyname='org_read') then
    create policy "org_read" on core.memberships for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='memberships' and policyname='service_all') then
    create policy "service_all" on core.memberships for all to service_role using (true) with check (true);
  end if;

  -- membership_locations: service_role only for now (join-scoped read added with route conversion).
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='membership_locations' and policyname='service_all') then
    create policy "service_all" on core.membership_locations for all to service_role using (true) with check (true);
  end if;

  -- platform_admin_sessions: platform audit — service_role only.
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='platform_admin_sessions' and policyname='service_all') then
    create policy "service_all" on core.platform_admin_sessions for all to service_role using (true) with check (true);
  end if;
end $$;
