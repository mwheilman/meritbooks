-- Migration 130: Customizable RBAC — custom roles + per-(role, feature, action) overrides
--
-- OWNER NEED (session 44): keep the 9 SYSTEM roles as the shipped DEFAULTS, but allow
-- FULL customization — create org-specific custom roles (cloned from a base system role)
-- and toggle any individual permission per role. Everything resolves FAIL-CLOSED.
--
-- This migration is ADDITIVE and idempotent. It does NOT touch the reserved RBAC spine
-- (apps/web/src/lib/rbac/permissions.ts) — the system defaults stay hardcoded there.
-- These tables only store the org's DELTAS on top of those defaults. The effective
-- permission is computed by lib/rbac/resolve-permissions.ts (system default MERGED with
-- the org's overrides). Wiring the resolver into the guards is done separately, under
-- security review (see the "FOR THE LEAD" handoff).
--
-- Model:
--   core.custom_roles              — org-defined roles, each cloned from a base system role.
--                                     custom_roles.key is stored as the caller's role
--                                     (core.memberships.role / core.employees.role) exactly
--                                     like a system role key.
--   core.role_permission_overrides — one row per (org, role_key, feature, action) delta,
--                                     where role_key is EITHER a system role key (the org
--                                     tweaks a shipped default) OR a core.custom_roles.key.
--                                     `allowed` is an explicit boolean that WINS over the
--                                     system default for that exact (feature, action) cell.
--
-- NOTE: a legacy, code-UNUSED `public.role_permission_overrides` exists from migration 014
-- (a wide-column tier/individual design that never drove enforcement — grep shows no
-- consumers). This migration intentionally introduces a fresh, narrow, cell-shaped table in
-- the `core` schema alongside the rest of the identity spine; the two are schema-qualified
-- and never collide. The legacy table is left dormant and untouched.

-- ─────────────────────────────────────────────────────────────────────────────
-- core.custom_roles
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists core.custom_roles (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  key          text not null,            -- stable slug, unique per org; stored as the caller's role
  name         text not null,            -- human label
  description  text,                     -- plain-English "what this role is for"
  base_role    text,                     -- a system UserRole key to clone defaults from
                                          --   (nullable => deny-all base, fully explicit via overrides)
  created_by   text,                     -- clerk user id (audit)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint custom_roles_key_not_blank  check (length(btrim(key)) > 0),
  constraint custom_roles_name_not_blank check (length(btrim(name)) > 0)
);

create unique index if not exists uq_custom_roles_org_key
  on core.custom_roles (org_id, key);

alter table core.custom_roles enable row level security;

drop policy if exists custom_roles_org_isolation on core.custom_roles;
create policy custom_roles_org_isolation on core.custom_roles
  for all
  using (org_id = public.get_org_id())
  with check (org_id = public.get_org_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- core.role_permission_overrides
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists core.role_permission_overrides (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  role_key     text not null,            -- a system UserRole key OR a core.custom_roles.key
  feature      text not null,            -- FEATURE_CATALOG id (validated in the app layer)
  action       text not null,            -- FeatureAction  (validated in the app layer)
  allowed      boolean not null,         -- explicit grant/deny; WINS over the system default
  set_by       text,                     -- clerk user id (audit)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint rpo_role_key_not_blank check (length(btrim(role_key)) > 0),
  constraint rpo_feature_not_blank  check (length(btrim(feature)) > 0),
  constraint rpo_action_not_blank   check (length(btrim(action)) > 0)
);

-- One override cell per (org, role, feature, action). Enables idempotent upsert.
create unique index if not exists uq_role_override_cell
  on core.role_permission_overrides (org_id, role_key, feature, action);

-- Fast per-role matrix fetch (resolver + UI).
create index if not exists idx_role_override_lookup
  on core.role_permission_overrides (org_id, role_key);

alter table core.role_permission_overrides enable row level security;

drop policy if exists role_permission_overrides_org_isolation on core.role_permission_overrides;
create policy role_permission_overrides_org_isolation on core.role_permission_overrides
  for all
  using (org_id = public.get_org_id())
  with check (org_id = public.get_org_id());
