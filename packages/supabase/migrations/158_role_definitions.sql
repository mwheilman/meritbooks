-- =============================================================================
-- Migration 158: role definitions + versions + grants (05-RBAC-SPEC §5.7 R-2) — wave 1
-- =============================================================================
-- A role is DATA, owned at one of three levels (05 §1.2):
--   platform  standard templates (Mike authors)       org_id null, location_id null
--   tenant    standard (cloned) or custom roles       org_id set,  location_id null
--   client    roles a client defines for its staff    org_id set,  location_id set
--
-- core.role_definitions
--   id, owner_level, org_id, location_id, key, name, description,
--   kind (standard | custom), audience (internal_staff | client_staff | external | platform),
--   upstream_template_id -> role_definitions, upstream_version, home_template_id (IA A-4),
--   default_scope (all_clients | assigned), field_policy jsonb, auth_policy jsonb,
--   max_assignment_days, assignable_band (tenant_admin_only | managers | any_grantor),
--   status (draft | active | deprecated | archived), current_version int,
--   legacy_role_key (provenance: the permissions.ts key / mig-130 custom key it was
--   imported from — also how a legacy membership.role string resolves to this role),
--   created_by -> core.users, created_at, updated_at
-- core.role_versions
--   id, role_id, version, state (draft | published | superseded), published_at,
--   published_by, effective_at, reason, changelog jsonb, second_approval_by/_at,
--   created_by, created_at.  unique (role_id, version)
--   CURRENT vs PROPOSED (05 §1.7 owner review, Oct 20 2026): at most ONE published
--   version (= Current, what holders resolve to) and at most ONE draft (= Proposed
--   changes) per role — both enforced by partial unique indexes. Published / superseded
--   versions are IMMUTABLE (trigger); only a draft's grants may change.
-- core.role_grants
--   id, role_version_id, capability -> capabilities(key), actions text[], constraints jsonb
--   unique (role_version_id, capability). Validated by trigger: actions ⊆ the
--   capability's actions; constraint keys ⊆ the 05 §3 schema; H5 (platform capabilities
--   only in platform-audience roles, and platform roles hold no tenant capability);
--   H3 (external audiences never hold post / release / configure, approve on money,
--   any locked capability or core.access.*).
--
-- Legacy reference tables (compat until R-14; GENERATED from lib/rbac/legacy-map.ts):
--   core.legacy_roles, core.legacy_role_cells, core.legacy_feature_catalog,
--   core.legacy_cell_rules  — the 05 §2.3 mapping, so the SQL backfill and the TS
--   dual-run comparator expand legacy permissions IDENTICALLY.
--
-- Data step (05 R-2):
--   (a) seed the platform templates (05 §7 + IA A-1 employee / lender_viewer) — GENERATED;
--   (b) per tenant, clone every non-platform template into a tenant STANDARD role;
--       the 9 legacy roles' tenant roles carry EXACTLY their legacy grants (effective
--       access unchanged), except company_admin → Tenant admin (template grants; the rest
--       of its books access goes to the "Legacy full books" permission set, mig 159) and
--       merit_controller → Controller (legacy grants minus money release; the release
--       goes to "Legacy controller release", mig 159);
--   (c) mig-130 overrides on a system key fold into that tenant role's version 2
--       (changelog "imported override");
--   (d) each core.custom_roles row becomes a tenant CUSTOM role, version 1 = base
--       defaults ⊕ its overrides;
--   (e) the mig-145 external auditor custom role maps onto the tenant's standard
--       External auditor role (grants unioned); holders get a 120-day time box in R-4.
--   All of it is core.rbac_import_tenant_roles(org) — idempotent, re-runnable, and
--   called again by core.rbac_provision_tenant(org) (mig 161) for new tenants.
--
-- RLS: members READ platform templates + their own tenant's roles; writes service_role
-- only (154 pattern). No behavior change: nothing enforces from these tables until the
-- wave-2 flip.
-- =============================================================================

-- ── Tables ───────────────────────────────────────────────────────────────────
create table if not exists core.role_definitions (
  id                   uuid primary key default gen_random_uuid(),
  owner_level          text not null,
  org_id               uuid references core.organizations(id) on delete cascade,
  location_id          uuid references core.locations(id) on delete cascade,
  key                  text not null,
  name                 text not null,
  description          text,
  kind                 text not null default 'custom',
  audience             text not null default 'internal_staff',
  upstream_template_id uuid references core.role_definitions(id) on delete set null,
  upstream_version     int,
  home_template_id     uuid references core.role_definitions(id) on delete set null,
  default_scope        text not null default 'assigned',
  field_policy         jsonb not null default '{}'::jsonb,
  auth_policy          jsonb not null default '{}'::jsonb,
  max_assignment_days  int,
  assignable_band      text not null default 'managers',
  status               text not null default 'active',
  current_version      int,
  legacy_role_key      text,
  created_by           uuid references core.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint role_definitions_owner_level_chk check (owner_level in ('platform', 'tenant', 'client')),
  constraint role_definitions_owner_shape_chk check (
       (owner_level = 'platform' and org_id is null and location_id is null)
    or (owner_level = 'tenant'   and org_id is not null and location_id is null)
    or (owner_level = 'client'   and org_id is not null and location_id is not null)),
  constraint role_definitions_key_chk check (length(btrim(key)) > 0),
  constraint role_definitions_name_chk check (length(btrim(name)) > 0),
  constraint role_definitions_kind_chk check (kind in ('standard', 'custom')),
  constraint role_definitions_audience_chk check (audience in ('internal_staff', 'client_staff', 'external', 'platform')),
  constraint role_definitions_platform_audience_chk check (audience <> 'platform' or owner_level = 'platform'),
  constraint role_definitions_client_audience_chk check (owner_level <> 'client' or audience in ('client_staff', 'external')),
  constraint role_definitions_default_scope_chk check (default_scope in ('all_clients', 'assigned')),
  constraint role_definitions_band_chk check (assignable_band in ('tenant_admin_only', 'managers', 'any_grantor')),
  constraint role_definitions_status_chk check (status in ('draft', 'active', 'deprecated', 'archived')),
  constraint role_definitions_max_days_chk check (max_assignment_days is null or max_assignment_days > 0),
  constraint role_definitions_policies_chk check (jsonb_typeof(field_policy) = 'object' and jsonb_typeof(auth_policy) = 'object')
);
create unique index if not exists uq_role_def_platform_key on core.role_definitions (key) where owner_level = 'platform';
create unique index if not exists uq_role_def_tenant_key   on core.role_definitions (org_id, key) where owner_level = 'tenant';
create unique index if not exists uq_role_def_client_key   on core.role_definitions (org_id, location_id, key) where owner_level = 'client';
create unique index if not exists uq_role_def_tenant_legacy on core.role_definitions (org_id, legacy_role_key)
  where owner_level = 'tenant' and legacy_role_key is not null;
create index if not exists idx_role_def_org on core.role_definitions (org_id);
comment on table core.role_definitions is
  '05 R-2: role definitions at platform / tenant / client level. Authority comes from core.access_assignments, never from this table alone.';

create table if not exists core.role_versions (
  id                 uuid primary key default gen_random_uuid(),
  role_id            uuid not null references core.role_definitions(id) on delete cascade,
  version            int not null check (version > 0),
  state              text not null default 'draft' check (state in ('draft', 'published', 'superseded')),
  published_at       timestamptz,
  published_by       uuid references core.users(id) on delete set null,
  effective_at       timestamptz,
  reason             text,
  changelog          jsonb not null default '{}'::jsonb,
  second_approval_by uuid references core.users(id) on delete set null,
  second_approval_at timestamptz,
  created_by         uuid references core.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (role_id, version)
);
create unique index if not exists uq_role_versions_one_draft     on core.role_versions (role_id) where state = 'draft';
create unique index if not exists uq_role_versions_one_published on core.role_versions (role_id) where state = 'published';
comment on table core.role_versions is
  '05 R-2: immutable role versions. One published (Current) + at most one draft (Proposed changes) per role.';

create or replace function core.rbac_valid_constraints(p jsonb) returns boolean
  language sql immutable as
$$
  select p is not null
     and jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(p) k
        where k not in ('amount_limit','dimension_restriction','doc_types','ownership','period','delivered_to_me','assigned_to_me'))
     and (not (p ? 'amount_limit')
          or (jsonb_typeof(p->'amount_limit') = 'object'
              and jsonb_typeof(p->'amount_limit'->'max_per_item_cents') = 'number'
              and (p->'amount_limit'->>'max_per_item_cents')::numeric >= 0))
     and (not (p ? 'ownership') or p->>'ownership' in ('own', 'team', 'all'))
     and (not (p ? 'period') or p->>'period' in ('open_only', 'allow_soft_closed'))
$$;

create table if not exists core.role_grants (
  id              uuid primary key default gen_random_uuid(),
  role_version_id uuid not null references core.role_versions(id) on delete cascade,
  capability      text not null references core.capabilities(key),
  actions         text[] not null,
  constraints     jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (role_version_id, capability),
  constraint role_grants_actions_chk check (cardinality(actions) > 0 and actions <@ core.rbac_actions()),
  constraint role_grants_constraints_chk check (core.rbac_valid_constraints(constraints))
);
create index if not exists idx_role_grants_capability on core.role_grants (capability);

-- ── Hard-rule grant check shared by role + permission-set grants (H3, H5) ──────
-- Returns null when legal, else a human-readable reason.
create or replace function core.rbac_grant_violation(p_audience text, p_capability text, p_actions text[])
returns text language plpgsql stable as
$$
declare c core.capabilities%rowtype; a text;
begin
  select * into c from core.capabilities where key = p_capability;
  if not found then return format('unknown capability %s', p_capability); end if;
  foreach a in array p_actions loop
    if not (a = any (c.actions)) then
      return format('%s does not support action %s', p_capability, a);
    end if;
  end loop;
  -- H5: platform capabilities only in platform roles; platform roles hold no tenant capability.
  if c.platform_only and p_audience <> 'platform' then
    return format('H5: %s is platform-only', p_capability);
  end if;
  if p_audience = 'platform' and not c.platform_only then
    return format('H5: platform roles hold no tenant capability (%s)', p_capability);
  end if;
  -- H3: external audience ceiling.
  if p_audience = 'external' then
    if p_actions && array['post', 'release', 'configure']::text[] then
      return format('H3: external audiences never post / release / configure (%s)', p_capability);
    end if;
    if 'approve' = any (p_actions) and 'money' = any (c.tags) then
      return format('H3: external audiences never approve money (%s)', p_capability);
    end if;
    if 'locked' = any (c.tags) then
      return format('H3: external audiences never hold locked capabilities (%s)', p_capability);
    end if;
    if p_capability like 'core.access.%' then
      return format('H3: external audiences never administer access (%s)', p_capability);
    end if;
  end if;
  return null;
end
$$;

-- Immutability + validation for role grants.
create or replace function core.rbac_role_grants_guard() returns trigger
  language plpgsql as
$$
declare v_state text; v_audience text; v_version_id uuid; v_reason text;
begin
  v_version_id := coalesce(new.role_version_id, old.role_version_id);
  select rv.state, rd.audience into v_state, v_audience
    from core.role_versions rv join core.role_definitions rd on rd.id = rv.role_id
   where rv.id = v_version_id;
  if tg_op = 'DELETE' then
    -- cascades from a deleted version / role / tenant are allowed (trigger depth > 1)
    if v_state is distinct from 'draft' and pg_trigger_depth() <= 1 then
      raise exception 'role grants of a % version are immutable', v_state using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if v_state is distinct from 'draft' then
    raise exception 'role grants of a % version are immutable', coalesce(v_state, 'missing') using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.role_version_id <> old.role_version_id then
    raise exception 'a grant cannot move between versions' using errcode = 'check_violation';
  end if;
  v_reason := core.rbac_grant_violation(v_audience, new.capability, new.actions);
  if v_reason is not null then
    raise exception 'illegal role grant: %', v_reason using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_role_grants_guard on core.role_grants;
create trigger trg_role_grants_guard before insert or update or delete on core.role_grants
  for each row execute function core.rbac_role_grants_guard();

-- Version immutability: only draft → published, published → superseded; content frozen.
create or replace function core.rbac_role_versions_guard() returns trigger
  language plpgsql as
$$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'draft' and pg_trigger_depth() <= 1 then
      raise exception 'a % role version cannot be deleted', old.state using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.state = 'draft' then
    if new.role_id <> old.role_id or new.version <> old.version then
      raise exception 'role version identity is immutable' using errcode = 'check_violation';
    end if;
    if new.state not in ('draft', 'published') then
      raise exception 'a draft can only be published' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.state = 'published' and new.state = 'superseded'
     and (new.role_id, new.version, new.published_at, new.published_by, new.reason, new.changelog)
         is not distinct from (old.role_id, old.version, old.published_at, old.published_by, old.reason, old.changelog) then
    return new;
  end if;
  raise exception 'a % role version is immutable', old.state using errcode = 'check_violation';
end
$$;
drop trigger if exists trg_role_versions_guard on core.role_versions;
create trigger trg_role_versions_guard before update or delete on core.role_versions
  for each row execute function core.rbac_role_versions_guard();

-- Definition integrity: client location belongs to the tenant; upstream / home template
-- is a platform role or a role of the same tenant.
create or replace function core.rbac_role_definitions_guard() returns trigger
  language plpgsql as
$$
begin
  if new.owner_level = 'client' and not exists (
       select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'client role location % is not a client of tenant %', new.location_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.upstream_template_id is not null and not exists (
       select 1 from core.role_definitions u
        where u.id = new.upstream_template_id
          and (u.owner_level = 'platform' or u.org_id = new.org_id)) then
    raise exception 'upstream role must be a platform template or a role of the same tenant'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists trg_role_definitions_guard on core.role_definitions;
create trigger trg_role_definitions_guard before insert or update on core.role_definitions
  for each row execute function core.rbac_role_definitions_guard();

-- ── Version helpers ──────────────────────────────────────────────────────────
-- Publish a draft: previous Current → superseded, this → Current. Changelog = adds /
-- removes vs the previous Current (computed, never trusted from the caller).
create or replace function core.rbac_publish_role_version(p_version_id uuid, p_actor uuid default null, p_reason text default null)
returns int language plpgsql as
$$
declare v core.role_versions%rowtype; v_prev uuid; v_changelog jsonb;
begin
  select * into v from core.role_versions where id = p_version_id for update;
  if not found then raise exception 'role version % not found', p_version_id; end if;
  if v.state <> 'draft' then raise exception 'only a draft can be published (version % is %)', v.version, v.state; end if;
  perform 1 from core.role_definitions where id = v.role_id for update;
  select id into v_prev from core.role_versions where role_id = v.role_id and state = 'published';
  select jsonb_build_object(
           'adds', coalesce((select jsonb_agg(jsonb_build_object('capability', n.capability, 'action', n.a) order by n.capability, n.a)
                               from (select g.capability, unnest(g.actions) a from core.role_grants g where g.role_version_id = v.id) n
                              where not exists (select 1 from core.role_grants pg
                                                 where pg.role_version_id = v_prev and pg.capability = n.capability and n.a = any (pg.actions))), '[]'::jsonb),
           'removes', coalesce((select jsonb_agg(jsonb_build_object('capability', o.capability, 'action', o.a) order by o.capability, o.a)
                               from (select g.capability, unnest(g.actions) a from core.role_grants g where g.role_version_id = v_prev) o
                              where not exists (select 1 from core.role_grants ng
                                                 where ng.role_version_id = v.id and ng.capability = o.capability and o.a = any (ng.actions))), '[]'::jsonb))
    into v_changelog;
  if v_prev is not null then
    update core.role_versions set state = 'superseded' where id = v_prev;
  end if;
  update core.role_versions
     set state = 'published', published_at = now(), published_by = p_actor,
         effective_at = coalesce(effective_at, now()), reason = coalesce(p_reason, reason),
         changelog = coalesce(changelog, '{}'::jsonb) || v_changelog
   where id = v.id;
  update core.role_definitions
     set current_version = v.version, status = case when status = 'draft' then 'active' else status end
   where id = v.role_id;
  return v.version;
end
$$;

-- Create + publish a new version from a JSON grant list [{capability, actions[], constraints}].
create or replace function core.rbac_publish_role_grants(p_role_id uuid, p_grants jsonb, p_reason text, p_actor uuid default null)
returns int language plpgsql as
$$
declare v_id uuid; v_next int;
begin
  select coalesce(max(version), 0) + 1 into v_next from core.role_versions where role_id = p_role_id;
  insert into core.role_versions (role_id, version, state, reason, created_by)
       values (p_role_id, v_next, 'draft', p_reason, p_actor)
    returning id into v_id;
  insert into core.role_grants (role_version_id, capability, actions, constraints)
  select v_id, e->>'capability',
         array(select jsonb_array_elements_text(e->'actions')),
         coalesce(e->'constraints', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) e
   where jsonb_array_length(e->'actions') > 0;
  return core.rbac_publish_role_version(v_id, p_actor, p_reason);
end
$$;

-- Current grants of a role as JSON (the "Current" tab).
create or replace function core.rbac_role_current_grants(p_role_id uuid) returns jsonb
  language sql stable as
$$
  select coalesce(jsonb_agg(jsonb_build_object('capability', g.capability, 'actions', to_jsonb(g.actions), 'constraints', g.constraints)
                            order by g.capability), '[]'::jsonb)
    from core.role_versions v join core.role_grants g on g.role_version_id = v.id
   where v.role_id = p_role_id and v.state = 'published'
$$;

-- ── Legacy reference tables (GENERATED data) ─────────────────────────────────
create table if not exists core.legacy_roles (
  role_key           text primary key,
  template_key       text not null,
  label              text not null,
  company_scope      text not null,
  scope_kind         text not null check (scope_kind in ('all_clients', 'all_except_own_books', 'assigned')),
  payroll_visibility text not null,
  mfa_required       boolean not null,
  field_policy       jsonb not null,
  assignable_band    text not null,
  split              text not null check (split in ('none', 'template_plus_legacy_set', 'money_release_set')),
  legacy_set_key     text
);
create table if not exists core.legacy_feature_catalog (
  feature text primary key,
  actions text[] not null
);
create table if not exists core.legacy_role_cells (
  role_key text not null references core.legacy_roles(role_key) on delete cascade,
  cell     text not null,
  primary key (role_key, cell)
);
create table if not exists core.legacy_cell_rules (
  rule_no      int not null,
  cell         text not null,
  capability   text not null references core.capabilities(key),
  actions      text[] not null,
  requires_all text[] not null default '{}',
  requires_any text[] not null default '{}',
  primary key (rule_no, capability)
);
comment on table core.legacy_cell_rules is
  '05 §2.3 legacy (feature::action) → capability mapping, generated from lib/rbac/legacy-map.ts. Compat until R-14.';

-- Normalize a raw membership / employee role string exactly like
-- lib/rbac/role-normalize.ts: trim, lowercase, strip "org:", owner/admin/org_admin →
-- company_admin, a known legacy key → itself, anything else → null.
create or replace function core.rbac_normalize_legacy_role(p_raw text) returns text
  language sql stable as
$$
  with k as (select regexp_replace(lower(btrim(coalesce(p_raw, ''))), '^org:', '') as key)
  select case
           when k.key = '' then null
           when k.key in ('owner', 'admin', 'org_admin', 'company_admin') then 'company_admin'
           when exists (select 1 from core.legacy_roles r where r.role_key = k.key) then k.key
           else null
         end
    from k
$$;

-- Legacy cells for a (tenant, role key): the base system role's cells, with the
-- tenant's mig-130 overrides applied when p_with_overrides. role key = a legacy system
-- key OR a core.custom_roles.key. Invalid override cells are dropped (fail closed),
-- exactly like resolve-permissions.ts fetchOverrides().
create or replace function core.rbac_legacy_cells(p_org uuid, p_role_key text, p_with_overrides boolean default true)
returns text[] language plpgsql stable as
$$
declare v_base text; v_override_key text; v_cells text[];
begin
  v_base := core.rbac_normalize_legacy_role(p_role_key);
  if v_base is not null then
    v_override_key := v_base;
  else
    select core.rbac_normalize_legacy_role(cr.base_role), cr.key
      into v_base, v_override_key
      from core.custom_roles cr where cr.org_id = p_org and cr.key = btrim(p_role_key);
    if v_override_key is null then return '{}'::text[]; end if;
  end if;
  select coalesce(array_agg(c.cell), '{}') into v_cells from core.legacy_role_cells c where c.role_key = v_base;
  if p_with_overrides then
    select coalesce(array_agg(x.cell), '{}') into v_cells from (
      select cell from unnest(v_cells) cell
       where not exists (select 1 from core.role_permission_overrides o
                          where o.org_id = p_org and o.role_key = v_override_key
                            and o.feature || '::' || o.action = cell and o.allowed = false)
      union
      select o.feature || '::' || o.action
        from core.role_permission_overrides o
        join core.legacy_feature_catalog f on f.feature = o.feature and o.action = any (f.actions)
       where o.org_id = p_org and o.role_key = v_override_key and o.allowed = true
    ) x;
  end if;
  return v_cells;
end
$$;

-- Expand legacy cells → capability grants (05 §2.3), as JSON [{capability, actions, constraints}].
create or replace function core.rbac_legacy_grants(p_cells text[]) returns jsonb
  language sql stable as
$$
  with fired as (
    select r.capability, a.action
      from core.legacy_cell_rules r
      cross join lateral unnest(r.actions) a(action)
     where r.cell = any (p_cells)
       and r.requires_all <@ p_cells
       and (cardinality(r.requires_any) = 0 or r.requires_any && p_cells)
  ), per_cap as (
    select f.capability,
           array(select x.a from unnest(core.rbac_actions()) with ordinality x(a, o)
                  where x.a in (select f2.action from fired f2 where f2.capability = f.capability)
                  order by x.o) as actions
      from fired f group by f.capability
  )
  select coalesce(jsonb_agg(jsonb_build_object('capability', capability, 'actions', to_jsonb(actions), 'constraints', '{}'::jsonb)
                            order by capability), '[]'::jsonb)
    from per_cap
$$;

-- Grant-set algebra on the JSON grant lists.
create or replace function core.rbac_grants_minus(p_a jsonb, p_b jsonb) returns jsonb
  language sql immutable as
$$
  with a as (select e->>'capability' cap, x.act from jsonb_array_elements(p_a) e, jsonb_array_elements_text(e->'actions') x(act)),
       b as (select e->>'capability' cap, x.act from jsonb_array_elements(p_b) e, jsonb_array_elements_text(e->'actions') x(act)),
       d as (select a.cap, a.act from a except select b.cap, b.act from b)
  select coalesce(jsonb_agg(jsonb_build_object('capability', cap, 'actions', acts, 'constraints', '{}'::jsonb) order by cap), '[]'::jsonb)
    from (select d.cap,
                 to_jsonb(array(select x.a from unnest(core.rbac_actions()) with ordinality x(a, o)
                                 where x.a in (select d2.act from d d2 where d2.cap = d.cap) order by x.o)) acts
            from d group by d.cap) s
$$;
create or replace function core.rbac_grants_union(p_a jsonb, p_b jsonb) returns jsonb
  language sql immutable as
$$
  with u as (select e->>'capability' cap, x.act from jsonb_array_elements(p_a || p_b) e, jsonb_array_elements_text(e->'actions') x(act))
  select coalesce(jsonb_agg(jsonb_build_object('capability', cap, 'actions', acts, 'constraints', '{}'::jsonb) order by cap), '[]'::jsonb)
    from (select distinct u.cap,
                 to_jsonb(array(select x.a from unnest(core.rbac_actions()) with ordinality x(a, o)
                                 where x.a in (select u2.act from u u2 where u2.cap = u.cap) order by x.o)) acts
            from u) s
$$;
-- Only the release actions on money-tagged capabilities.
create or replace function core.rbac_grants_money_release(p_a jsonb) returns jsonb
  language sql stable as
$$
  select coalesce(jsonb_agg(jsonb_build_object('capability', e->>'capability', 'actions', '["release"]'::jsonb, 'constraints', '{}'::jsonb)
                            order by e->>'capability'), '[]'::jsonb)
    from jsonb_array_elements(p_a) e
    join core.capabilities c on c.key = e->>'capability'
   where 'money' = any (c.tags) and (e->'actions') ? 'release'
$$;

-- ── Platform template seeding ────────────────────────────────────────────────
-- Upsert a platform template's metadata; publish version 1 from the given grants only if
-- the template has no version yet (template changes ship as NEW versions, never edits).
create or replace function core.rbac_seed_platform_roles(p_templates jsonb) returns integer
  language plpgsql as
$$
declare t jsonb; v_id uuid; n int := 0;
begin
  for t in select * from jsonb_array_elements(p_templates) loop
    insert into core.role_definitions as rd
      (owner_level, key, name, description, kind, audience, default_scope, field_policy, auth_policy,
       max_assignment_days, assignable_band, status)
    values ('platform', t->>'key', t->>'name', t->>'description', 'standard', t->>'audience',
            t->>'default_scope', t->'field_policy', t->'auth_policy',
            nullif(t->>'max_assignment_days', '')::int, t->>'assignable_band', 'active')
    on conflict (key) where owner_level = 'platform' do update set
      name = excluded.name, description = excluded.description, audience = excluded.audience,
      default_scope = excluded.default_scope, field_policy = excluded.field_policy,
      auth_policy = excluded.auth_policy, max_assignment_days = excluded.max_assignment_days,
      assignable_band = excluded.assignable_band
    returning id into v_id;
    if not exists (select 1 from core.role_versions where role_id = v_id) then
      perform core.rbac_publish_role_grants(v_id, t->'grants', 'MeritBooks standard template (05 §7)');
    end if;
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ── Tenant import (05 R-2 data step b–e) ─────────────────────────────────────
create or replace function core.rbac_import_tenant_roles(p_org uuid) returns void
  language plpgsql as
$$
declare
  t record; lr record; cr record;
  v_role_id uuid; v_grants jsonb; v_default jsonb; v_key text; v_upstream uuid; v_base text;
  v_has_overrides boolean;
begin
  if not exists (select 1 from core.organizations where id = p_org) then return; end if;

  -- (b) clone every non-platform template; legacy-mapped ones carry legacy-exact grants.
  for t in
    select rd.* from core.role_definitions rd
     where rd.owner_level = 'platform' and rd.audience <> 'platform' and rd.status = 'active'
     order by rd.key
  loop
    if exists (select 1 from core.role_definitions x
                where x.owner_level = 'tenant' and x.org_id = p_org and x.key = t.key) then
      continue; -- idempotent
    end if;
    select * into lr from core.legacy_roles where template_key = t.key;
    v_has_overrides := false;
    if found and lr.split <> 'template_plus_legacy_set' then
      v_default := core.rbac_legacy_grants(core.rbac_legacy_cells(p_org, lr.role_key, false));
      v_grants  := core.rbac_legacy_grants(core.rbac_legacy_cells(p_org, lr.role_key, true));
      if lr.split = 'money_release_set' then
        v_default := core.rbac_grants_minus(v_default, core.rbac_grants_money_release(v_default));
        v_grants  := core.rbac_grants_minus(v_grants,  core.rbac_grants_money_release(v_grants));
      end if;
      v_has_overrides := v_grants is distinct from v_default;
    else
      v_default := core.rbac_role_current_grants(t.id);
      v_grants := v_default;
    end if;

    insert into core.role_definitions
      (owner_level, org_id, key, name, description, kind, audience, upstream_template_id, upstream_version,
       home_template_id, default_scope, field_policy, auth_policy, max_assignment_days, assignable_band,
       status, legacy_role_key)
    values ('tenant', p_org, t.key, t.name, t.description, 'standard', t.audience, t.id, t.current_version,
            t.id,
            case when lr.role_key is not null then (case when lr.scope_kind = 'all_clients' then 'all_clients' else 'assigned' end) else t.default_scope end,
            case when lr.role_key is not null then lr.field_policy else t.field_policy end,
            case when lr.role_key is not null then t.auth_policy || jsonb_build_object('mfa_required', lr.mfa_required) else t.auth_policy end,
            t.max_assignment_days,
            coalesce(lr.assignable_band, t.assignable_band),
            'active', lr.role_key)
    returning id into v_role_id;

    perform core.rbac_publish_role_grants(v_role_id, v_default,
      case when lr.role_key is not null and lr.split <> 'template_plus_legacy_set'
           then format('Imported from legacy role %s (effective access unchanged)', lr.role_key)
           else 'Cloned from the MeritBooks standard role' end);
    -- (c) mig-130 overrides on the system key → version 2.
    if v_has_overrides then
      perform core.rbac_publish_role_grants(v_role_id, v_grants, 'imported override (mig 130)');
    end if;
  end loop;

  -- (d)/(e) mig-130 custom roles.
  for cr in select * from core.custom_roles where org_id = p_org order by key loop
    if exists (select 1 from core.role_definitions x
                where x.owner_level = 'tenant' and x.org_id = p_org and x.legacy_role_key = cr.key) then
      continue; -- already imported
    end if;
    v_grants := core.rbac_legacy_grants(core.rbac_legacy_cells(p_org, cr.key, true));
    v_base := core.rbac_normalize_legacy_role(cr.base_role);

    if lower(btrim(cr.key)) = 'external_auditor' then
      -- (e) fold into the tenant's standard External auditor role, grants unioned.
      select id into v_role_id from core.role_definitions
       where owner_level = 'tenant' and org_id = p_org and key = 'external_auditor';
      if v_role_id is not null then
        update core.role_definitions set legacy_role_key = cr.key where id = v_role_id and legacy_role_key is null;
        v_grants := core.rbac_grants_union(core.rbac_role_current_grants(v_role_id), v_grants);
        -- External ceiling (H3) still applies: drop anything the auditor audience may not hold.
        select coalesce(jsonb_agg(e), '[]'::jsonb) into v_grants
          from jsonb_array_elements(v_grants) e
         where core.rbac_grant_violation('external', e->>'capability',
                 array(select jsonb_array_elements_text(e->'actions'))) is null;
        if v_grants is distinct from core.rbac_role_current_grants(v_role_id) then
          perform core.rbac_publish_role_grants(v_role_id, v_grants, 'imported external auditor custom role (mig 145), grants unioned');
        end if;
        continue;
      end if;
    end if;

    v_key := cr.key;
    if exists (select 1 from core.role_definitions x where x.owner_level = 'tenant' and x.org_id = p_org and x.key = v_key) then
      v_key := cr.key || '_custom';
    end if;
    select id into v_upstream from core.role_definitions
     where owner_level = 'platform'
       and key = (select template_key from core.legacy_roles where role_key = v_base);
    select * into lr from core.legacy_roles where role_key = v_base;

    insert into core.role_definitions
      (owner_level, org_id, key, name, description, kind, audience, upstream_template_id, upstream_version,
       home_template_id, default_scope, field_policy, auth_policy, assignable_band, status, legacy_role_key)
    values ('tenant', p_org, v_key, cr.name, cr.description, 'custom', 'internal_staff', v_upstream,
            (select current_version from core.role_definitions where id = v_upstream), v_upstream,
            case when lr.scope_kind = 'all_clients' then 'all_clients' else 'assigned' end,
            coalesce(lr.field_policy, '{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb),
            jsonb_build_object('mfa_required', coalesce(lr.mfa_required, false)),
            coalesce(lr.assignable_band, 'managers'), 'active', cr.key)
    returning id into v_role_id;
    perform core.rbac_publish_role_grants(v_role_id, v_grants, 'imported custom role (mig 130)');
  end loop;
end
$$;

-- Mutating functions are service-side only (core is exposed over PostgREST).
revoke all on function core.rbac_publish_role_version(uuid, uuid, text) from public, anon, authenticated;
grant execute on function core.rbac_publish_role_version(uuid, uuid, text) to service_role;
revoke all on function core.rbac_publish_role_grants(uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function core.rbac_publish_role_grants(uuid, jsonb, text, uuid) to service_role;
revoke all on function core.rbac_seed_platform_roles(jsonb) from public, anon, authenticated;
grant execute on function core.rbac_seed_platform_roles(jsonb) to service_role;
revoke all on function core.rbac_import_tenant_roles(uuid) from public, anon, authenticated;
grant execute on function core.rbac_import_tenant_roles(uuid) to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['role_definitions', 'role_versions', 'role_grants',
                           'legacy_roles', 'legacy_feature_catalog', 'legacy_role_cells', 'legacy_cell_rules'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('drop policy if exists member_read on core.%I', t);
    execute format('drop policy if exists service_all on core.%I', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;
create policy member_read on core.role_definitions for select
  using (owner_level = 'platform' or org_id = public.get_org_id());
create policy member_read on core.role_versions for select
  using (exists (select 1 from core.role_definitions rd
                  where rd.id = role_versions.role_id
                    and (rd.owner_level = 'platform' or rd.org_id = public.get_org_id())));
create policy member_read on core.role_grants for select
  using (exists (select 1 from core.role_versions rv join core.role_definitions rd on rd.id = rv.role_id
                  where rv.id = role_grants.role_version_id
                    and (rd.owner_level = 'platform' or rd.org_id = public.get_org_id())));
create policy member_read on core.legacy_roles for select to authenticated using (true);
create policy member_read on core.legacy_feature_catalog for select to authenticated using (true);
create policy member_read on core.legacy_role_cells for select to authenticated using (true);
create policy member_read on core.legacy_cell_rules for select to authenticated using (true);

-- BEGIN GENERATED legacy (apps/web/scripts/rbac/generate-access-seed.ts — do not edit by hand)
insert into core.legacy_roles (role_key, template_key, label, company_scope, scope_kind, payroll_visibility, mfa_required, field_policy, assignable_band, split, legacy_set_key) values
  ('company_admin', 'tenant_admin', 'Company Admin', 'all', 'all_clients', 'ungrouped', true, '{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'tenant_admin_only', 'template_plus_legacy_set', 'legacy_full_books'),
  ('cfo', 'cfo', 'CFO', 'all', 'all_clients', 'ungrouped', true, '{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'tenant_admin_only', 'none', null),
  ('merit_controller', 'controller', 'Merit Controller', 'all', 'all_clients', 'ungrouped', false, '{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'managers', 'money_release_set', 'legacy_controller_release'),
  ('assistant_cfo', 'finance_director', 'Assistant CFO', 'portcos_and_3rdparty', 'all_except_own_books', 'ungrouped', false, '{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'managers', 'none', null),
  ('accounting_manager', 'accounting_manager', 'Accounting Manager', 'portcos_and_3rdparty', 'all_except_own_books', 'ungrouped', false, '{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'managers', 'none', null),
  ('accounting_specialist', 'bookkeeper', 'Accounting Specialist', 'assigned', 'assigned', 'grouped', false, '{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'managers', 'none', null),
  ('check_processor', 'payments_clerk', 'Check Processor', 'assigned', 'assigned', 'none', false, '{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'managers', 'none', null),
  ('general_admin', 'data_entry', 'General Admin / Data Entry', 'assigned', 'assigned', 'grouped', false, '{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'managers', 'none', null),
  ('business_user', 'owner', 'Business User (3rd Party)', 'own_company', 'assigned', 'ungrouped', false, '{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"}'::jsonb, 'managers', 'none', null)
on conflict (role_key) do update set template_key = excluded.template_key, label = excluded.label, company_scope = excluded.company_scope, scope_kind = excluded.scope_kind, payroll_visibility = excluded.payroll_visibility, mfa_required = excluded.mfa_required, field_policy = excluded.field_policy, assignable_band = excluded.assignable_band, split = excluded.split, legacy_set_key = excluded.legacy_set_key;
insert into core.legacy_feature_catalog (feature, actions) values
  ('dashboard', array['view']::text[]),
  ('bank_feed', array['view', 'edit', 'approve']::text[]),
  ('credit_cards', array['view', 'edit', 'approve']::text[]),
  ('receipts', array['view', 'edit', 'approve']::text[]),
  ('bills', array['view', 'create', 'approve']::text[]),
  ('journal_entries', array['view', 'create', 'post']::text[]),
  ('flagged', array['view', 'resolve']::text[]),
  ('vendors', array['view', 'create', 'edit']::text[]),
  ('customers', array['view', 'create', 'edit']::text[]),
  ('invoices', array['view', 'create', 'approve']::text[]),
  ('jobs', array['view', 'create', 'edit']::text[]),
  ('reports', array['view', 'export']::text[]),
  ('chart_of_accounts', array['view', 'request', 'approve']::text[]),
  ('reconciliation', array['view', 'reconcile']::text[]),
  ('close_mgmt', array['view', 'manage']::text[]),
  ('payroll', array['view', 'create', 'approve']::text[]),
  ('intercompany', array['view', 'create']::text[]),
  ('payments', array['view', 'run']::text[]),
  ('payments_execute', array['view', 'run']::text[]),
  ('check_run', array['view', 'run']::text[]),
  ('ap_disbursement_release', array['view', 'run']::text[]),
  ('payroll_release', array['view', 'run']::text[]),
  ('cash_position', array['view']::text[]),
  ('forecast', array['view', 'edit']::text[]),
  ('team', array['view', 'manage']::text[]),
  ('user_permissions', array['view', 'assign']::text[]),
  ('compliance', array['view', 'manage']::text[]),
  ('fixed_assets', array['view', 'create']::text[]),
  ('recurring', array['view', 'create']::text[]),
  ('settings_acct', array['view', 'edit']::text[]),
  ('settings_system', array['view', 'edit']::text[]),
  ('import', array['view', 'run']::text[]),
  ('audit_trail', array['view']::text[]),
  ('checks', array['view', 'create', 'approve']::text[]),
  ('biz_dashboard', array['view']::text[]),
  ('biz_reports', array['view', 'export']::text[]),
  ('biz_invoices', array['view']::text[]),
  ('biz_payroll', array['view']::text[]),
  ('biz_jobs', array['view']::text[]),
  ('biz_cash', array['view']::text[])
on conflict (feature) do update set actions = excluded.actions;
delete from core.legacy_role_cells;
insert into core.legacy_role_cells (role_key, cell) values
  ('company_admin', 'ap_disbursement_release::run'),
  ('company_admin', 'ap_disbursement_release::view'),
  ('company_admin', 'audit_trail::view'),
  ('company_admin', 'bank_feed::approve'),
  ('company_admin', 'bank_feed::edit'),
  ('company_admin', 'bank_feed::view'),
  ('company_admin', 'bills::approve'),
  ('company_admin', 'bills::create'),
  ('company_admin', 'bills::view'),
  ('company_admin', 'biz_cash::view'),
  ('company_admin', 'biz_dashboard::view'),
  ('company_admin', 'biz_invoices::view'),
  ('company_admin', 'biz_jobs::view'),
  ('company_admin', 'biz_payroll::view'),
  ('company_admin', 'biz_reports::export'),
  ('company_admin', 'biz_reports::view'),
  ('company_admin', 'cash_position::view'),
  ('company_admin', 'chart_of_accounts::approve'),
  ('company_admin', 'chart_of_accounts::request'),
  ('company_admin', 'chart_of_accounts::view'),
  ('company_admin', 'check_run::run'),
  ('company_admin', 'check_run::view'),
  ('company_admin', 'checks::approve'),
  ('company_admin', 'checks::create'),
  ('company_admin', 'checks::view'),
  ('company_admin', 'close_mgmt::manage'),
  ('company_admin', 'close_mgmt::view'),
  ('company_admin', 'compliance::manage'),
  ('company_admin', 'compliance::view'),
  ('company_admin', 'credit_cards::approve'),
  ('company_admin', 'credit_cards::edit'),
  ('company_admin', 'credit_cards::view'),
  ('company_admin', 'customers::create'),
  ('company_admin', 'customers::edit'),
  ('company_admin', 'customers::view'),
  ('company_admin', 'dashboard::view'),
  ('company_admin', 'fixed_assets::create'),
  ('company_admin', 'fixed_assets::view'),
  ('company_admin', 'flag::canEditAccountingSettings'),
  ('company_admin', 'flag::canEditSystemSettings'),
  ('company_admin', 'flag::canManageUsers'),
  ('company_admin', 'flagged::resolve'),
  ('company_admin', 'flagged::view'),
  ('company_admin', 'forecast::edit'),
  ('company_admin', 'forecast::view'),
  ('company_admin', 'import::run'),
  ('company_admin', 'import::view'),
  ('company_admin', 'intercompany::create'),
  ('company_admin', 'intercompany::view'),
  ('company_admin', 'invoices::approve'),
  ('company_admin', 'invoices::create'),
  ('company_admin', 'invoices::view'),
  ('company_admin', 'jobs::create'),
  ('company_admin', 'jobs::edit'),
  ('company_admin', 'jobs::view'),
  ('company_admin', 'journal_entries::create'),
  ('company_admin', 'journal_entries::post'),
  ('company_admin', 'journal_entries::view'),
  ('company_admin', 'payments::run'),
  ('company_admin', 'payments::view'),
  ('company_admin', 'payments_execute::run'),
  ('company_admin', 'payments_execute::view'),
  ('company_admin', 'payroll::approve'),
  ('company_admin', 'payroll::create'),
  ('company_admin', 'payroll::view'),
  ('company_admin', 'payroll_release::run'),
  ('company_admin', 'payroll_release::view'),
  ('company_admin', 'receipts::approve'),
  ('company_admin', 'receipts::edit'),
  ('company_admin', 'receipts::view'),
  ('company_admin', 'reconciliation::reconcile'),
  ('company_admin', 'reconciliation::view'),
  ('company_admin', 'recurring::create'),
  ('company_admin', 'recurring::view'),
  ('company_admin', 'reports::export'),
  ('company_admin', 'reports::view'),
  ('company_admin', 'settings_acct::edit'),
  ('company_admin', 'settings_acct::view'),
  ('company_admin', 'settings_system::edit'),
  ('company_admin', 'settings_system::view'),
  ('company_admin', 'team::manage'),
  ('company_admin', 'team::view'),
  ('company_admin', 'user_permissions::assign'),
  ('company_admin', 'user_permissions::view'),
  ('company_admin', 'vendors::create'),
  ('company_admin', 'vendors::edit'),
  ('company_admin', 'vendors::view'),
  ('cfo', 'ap_disbursement_release::run'),
  ('cfo', 'ap_disbursement_release::view'),
  ('cfo', 'audit_trail::view'),
  ('cfo', 'bank_feed::view'),
  ('cfo', 'bills::view'),
  ('cfo', 'cash_position::view'),
  ('cfo', 'chart_of_accounts::approve'),
  ('cfo', 'chart_of_accounts::request'),
  ('cfo', 'chart_of_accounts::view'),
  ('cfo', 'check_run::run'),
  ('cfo', 'check_run::view'),
  ('cfo', 'checks::view'),
  ('cfo', 'close_mgmt::manage'),
  ('cfo', 'close_mgmt::view'),
  ('cfo', 'compliance::manage'),
  ('cfo', 'compliance::view'),
  ('cfo', 'credit_cards::view'),
  ('cfo', 'customers::view'),
  ('cfo', 'dashboard::view'),
  ('cfo', 'fixed_assets::view'),
  ('cfo', 'flag::canEditAccountingSettings'),
  ('cfo', 'flagged::view'),
  ('cfo', 'forecast::edit'),
  ('cfo', 'forecast::view'),
  ('cfo', 'import::view'),
  ('cfo', 'intercompany::view'),
  ('cfo', 'invoices::view'),
  ('cfo', 'jobs::view'),
  ('cfo', 'journal_entries::view'),
  ('cfo', 'payments::run'),
  ('cfo', 'payments::view'),
  ('cfo', 'payments_execute::run'),
  ('cfo', 'payments_execute::view'),
  ('cfo', 'payroll::view'),
  ('cfo', 'payroll_release::run'),
  ('cfo', 'payroll_release::view'),
  ('cfo', 'receipts::view'),
  ('cfo', 'reconciliation::view'),
  ('cfo', 'recurring::view'),
  ('cfo', 'reports::export'),
  ('cfo', 'reports::view'),
  ('cfo', 'settings_acct::edit'),
  ('cfo', 'settings_acct::view'),
  ('cfo', 'settings_system::view'),
  ('cfo', 'team::view'),
  ('cfo', 'user_permissions::view'),
  ('cfo', 'vendors::view'),
  ('merit_controller', 'ap_disbursement_release::run'),
  ('merit_controller', 'ap_disbursement_release::view'),
  ('merit_controller', 'audit_trail::view'),
  ('merit_controller', 'bank_feed::approve'),
  ('merit_controller', 'bank_feed::edit'),
  ('merit_controller', 'bank_feed::view'),
  ('merit_controller', 'bills::approve'),
  ('merit_controller', 'bills::create'),
  ('merit_controller', 'bills::view'),
  ('merit_controller', 'cash_position::view'),
  ('merit_controller', 'chart_of_accounts::request'),
  ('merit_controller', 'chart_of_accounts::view'),
  ('merit_controller', 'check_run::run'),
  ('merit_controller', 'check_run::view'),
  ('merit_controller', 'checks::approve'),
  ('merit_controller', 'checks::create'),
  ('merit_controller', 'checks::view'),
  ('merit_controller', 'close_mgmt::manage'),
  ('merit_controller', 'close_mgmt::view'),
  ('merit_controller', 'compliance::manage'),
  ('merit_controller', 'compliance::view'),
  ('merit_controller', 'credit_cards::approve'),
  ('merit_controller', 'credit_cards::edit'),
  ('merit_controller', 'credit_cards::view'),
  ('merit_controller', 'customers::create'),
  ('merit_controller', 'customers::edit'),
  ('merit_controller', 'customers::view'),
  ('merit_controller', 'dashboard::view'),
  ('merit_controller', 'fixed_assets::create'),
  ('merit_controller', 'fixed_assets::view'),
  ('merit_controller', 'flagged::resolve'),
  ('merit_controller', 'flagged::view'),
  ('merit_controller', 'forecast::edit'),
  ('merit_controller', 'forecast::view'),
  ('merit_controller', 'import::run'),
  ('merit_controller', 'import::view'),
  ('merit_controller', 'intercompany::create'),
  ('merit_controller', 'intercompany::view'),
  ('merit_controller', 'invoices::approve'),
  ('merit_controller', 'invoices::create'),
  ('merit_controller', 'invoices::view'),
  ('merit_controller', 'jobs::create'),
  ('merit_controller', 'jobs::edit'),
  ('merit_controller', 'jobs::view'),
  ('merit_controller', 'journal_entries::create'),
  ('merit_controller', 'journal_entries::post'),
  ('merit_controller', 'journal_entries::view'),
  ('merit_controller', 'payments::run'),
  ('merit_controller', 'payments::view'),
  ('merit_controller', 'payments_execute::run'),
  ('merit_controller', 'payments_execute::view'),
  ('merit_controller', 'payroll::approve'),
  ('merit_controller', 'payroll::create'),
  ('merit_controller', 'payroll::view'),
  ('merit_controller', 'payroll_release::run'),
  ('merit_controller', 'payroll_release::view'),
  ('merit_controller', 'receipts::approve'),
  ('merit_controller', 'receipts::edit'),
  ('merit_controller', 'receipts::view'),
  ('merit_controller', 'reconciliation::reconcile'),
  ('merit_controller', 'reconciliation::view'),
  ('merit_controller', 'recurring::create'),
  ('merit_controller', 'recurring::view'),
  ('merit_controller', 'reports::export'),
  ('merit_controller', 'reports::view'),
  ('merit_controller', 'team::view'),
  ('merit_controller', 'vendors::create'),
  ('merit_controller', 'vendors::edit'),
  ('merit_controller', 'vendors::view'),
  ('assistant_cfo', 'ap_disbursement_release::run'),
  ('assistant_cfo', 'ap_disbursement_release::view'),
  ('assistant_cfo', 'audit_trail::view'),
  ('assistant_cfo', 'bank_feed::approve'),
  ('assistant_cfo', 'bank_feed::edit'),
  ('assistant_cfo', 'bank_feed::view'),
  ('assistant_cfo', 'bills::approve'),
  ('assistant_cfo', 'bills::create'),
  ('assistant_cfo', 'bills::view'),
  ('assistant_cfo', 'cash_position::view'),
  ('assistant_cfo', 'chart_of_accounts::request'),
  ('assistant_cfo', 'chart_of_accounts::view'),
  ('assistant_cfo', 'check_run::run'),
  ('assistant_cfo', 'check_run::view'),
  ('assistant_cfo', 'checks::approve'),
  ('assistant_cfo', 'checks::create'),
  ('assistant_cfo', 'checks::view'),
  ('assistant_cfo', 'close_mgmt::view'),
  ('assistant_cfo', 'compliance::view'),
  ('assistant_cfo', 'credit_cards::approve'),
  ('assistant_cfo', 'credit_cards::edit'),
  ('assistant_cfo', 'credit_cards::view'),
  ('assistant_cfo', 'customers::create'),
  ('assistant_cfo', 'customers::edit'),
  ('assistant_cfo', 'customers::view'),
  ('assistant_cfo', 'dashboard::view'),
  ('assistant_cfo', 'fixed_assets::create'),
  ('assistant_cfo', 'fixed_assets::view'),
  ('assistant_cfo', 'flagged::resolve'),
  ('assistant_cfo', 'flagged::view'),
  ('assistant_cfo', 'forecast::edit'),
  ('assistant_cfo', 'forecast::view'),
  ('assistant_cfo', 'import::run'),
  ('assistant_cfo', 'import::view'),
  ('assistant_cfo', 'invoices::approve'),
  ('assistant_cfo', 'invoices::create'),
  ('assistant_cfo', 'invoices::view'),
  ('assistant_cfo', 'jobs::create'),
  ('assistant_cfo', 'jobs::edit'),
  ('assistant_cfo', 'jobs::view'),
  ('assistant_cfo', 'journal_entries::create'),
  ('assistant_cfo', 'journal_entries::post'),
  ('assistant_cfo', 'journal_entries::view'),
  ('assistant_cfo', 'payments::run'),
  ('assistant_cfo', 'payments::view'),
  ('assistant_cfo', 'payments_execute::run'),
  ('assistant_cfo', 'payments_execute::view'),
  ('assistant_cfo', 'payroll::create'),
  ('assistant_cfo', 'payroll::view'),
  ('assistant_cfo', 'payroll_release::run'),
  ('assistant_cfo', 'payroll_release::view'),
  ('assistant_cfo', 'receipts::approve'),
  ('assistant_cfo', 'receipts::edit'),
  ('assistant_cfo', 'receipts::view'),
  ('assistant_cfo', 'reconciliation::reconcile'),
  ('assistant_cfo', 'reconciliation::view'),
  ('assistant_cfo', 'recurring::create'),
  ('assistant_cfo', 'recurring::view'),
  ('assistant_cfo', 'reports::export'),
  ('assistant_cfo', 'reports::view'),
  ('assistant_cfo', 'team::view'),
  ('assistant_cfo', 'vendors::create'),
  ('assistant_cfo', 'vendors::edit'),
  ('assistant_cfo', 'vendors::view'),
  ('accounting_manager', 'ap_disbursement_release::run'),
  ('accounting_manager', 'ap_disbursement_release::view'),
  ('accounting_manager', 'audit_trail::view'),
  ('accounting_manager', 'bank_feed::approve'),
  ('accounting_manager', 'bank_feed::edit'),
  ('accounting_manager', 'bank_feed::view'),
  ('accounting_manager', 'bills::approve'),
  ('accounting_manager', 'bills::create'),
  ('accounting_manager', 'bills::view'),
  ('accounting_manager', 'cash_position::view'),
  ('accounting_manager', 'chart_of_accounts::approve'),
  ('accounting_manager', 'chart_of_accounts::request'),
  ('accounting_manager', 'chart_of_accounts::view'),
  ('accounting_manager', 'check_run::run'),
  ('accounting_manager', 'check_run::view'),
  ('accounting_manager', 'checks::approve'),
  ('accounting_manager', 'checks::create'),
  ('accounting_manager', 'checks::view'),
  ('accounting_manager', 'close_mgmt::manage'),
  ('accounting_manager', 'close_mgmt::view'),
  ('accounting_manager', 'compliance::manage'),
  ('accounting_manager', 'compliance::view'),
  ('accounting_manager', 'credit_cards::approve'),
  ('accounting_manager', 'credit_cards::edit'),
  ('accounting_manager', 'credit_cards::view'),
  ('accounting_manager', 'customers::create'),
  ('accounting_manager', 'customers::edit'),
  ('accounting_manager', 'customers::view'),
  ('accounting_manager', 'dashboard::view'),
  ('accounting_manager', 'fixed_assets::create'),
  ('accounting_manager', 'fixed_assets::view'),
  ('accounting_manager', 'flag::canEditAccountingSettings'),
  ('accounting_manager', 'flagged::resolve'),
  ('accounting_manager', 'flagged::view'),
  ('accounting_manager', 'forecast::edit'),
  ('accounting_manager', 'forecast::view'),
  ('accounting_manager', 'import::run'),
  ('accounting_manager', 'import::view'),
  ('accounting_manager', 'invoices::approve'),
  ('accounting_manager', 'invoices::create'),
  ('accounting_manager', 'invoices::view'),
  ('accounting_manager', 'jobs::create'),
  ('accounting_manager', 'jobs::edit'),
  ('accounting_manager', 'jobs::view'),
  ('accounting_manager', 'journal_entries::create'),
  ('accounting_manager', 'journal_entries::post'),
  ('accounting_manager', 'journal_entries::view'),
  ('accounting_manager', 'payments::run'),
  ('accounting_manager', 'payments::view'),
  ('accounting_manager', 'payments_execute::run'),
  ('accounting_manager', 'payments_execute::view'),
  ('accounting_manager', 'payroll::approve'),
  ('accounting_manager', 'payroll::create'),
  ('accounting_manager', 'payroll::view'),
  ('accounting_manager', 'payroll_release::run'),
  ('accounting_manager', 'payroll_release::view'),
  ('accounting_manager', 'receipts::approve'),
  ('accounting_manager', 'receipts::edit'),
  ('accounting_manager', 'receipts::view'),
  ('accounting_manager', 'reconciliation::reconcile'),
  ('accounting_manager', 'reconciliation::view'),
  ('accounting_manager', 'recurring::create'),
  ('accounting_manager', 'recurring::view'),
  ('accounting_manager', 'reports::export'),
  ('accounting_manager', 'reports::view'),
  ('accounting_manager', 'settings_acct::edit'),
  ('accounting_manager', 'settings_acct::view'),
  ('accounting_manager', 'team::manage'),
  ('accounting_manager', 'team::view'),
  ('accounting_manager', 'user_permissions::assign'),
  ('accounting_manager', 'user_permissions::view'),
  ('accounting_manager', 'vendors::create'),
  ('accounting_manager', 'vendors::edit'),
  ('accounting_manager', 'vendors::view'),
  ('accounting_specialist', 'audit_trail::view'),
  ('accounting_specialist', 'bank_feed::approve'),
  ('accounting_specialist', 'bank_feed::edit'),
  ('accounting_specialist', 'bank_feed::view'),
  ('accounting_specialist', 'bills::create'),
  ('accounting_specialist', 'bills::view'),
  ('accounting_specialist', 'cash_position::view'),
  ('accounting_specialist', 'chart_of_accounts::request'),
  ('accounting_specialist', 'chart_of_accounts::view'),
  ('accounting_specialist', 'close_mgmt::view'),
  ('accounting_specialist', 'compliance::view'),
  ('accounting_specialist', 'credit_cards::approve'),
  ('accounting_specialist', 'credit_cards::edit'),
  ('accounting_specialist', 'credit_cards::view'),
  ('accounting_specialist', 'customers::create'),
  ('accounting_specialist', 'customers::edit'),
  ('accounting_specialist', 'customers::view'),
  ('accounting_specialist', 'dashboard::view'),
  ('accounting_specialist', 'fixed_assets::view'),
  ('accounting_specialist', 'flagged::resolve'),
  ('accounting_specialist', 'flagged::view'),
  ('accounting_specialist', 'forecast::view'),
  ('accounting_specialist', 'invoices::create'),
  ('accounting_specialist', 'invoices::view'),
  ('accounting_specialist', 'jobs::create'),
  ('accounting_specialist', 'jobs::edit'),
  ('accounting_specialist', 'jobs::view'),
  ('accounting_specialist', 'journal_entries::create'),
  ('accounting_specialist', 'journal_entries::view'),
  ('accounting_specialist', 'payroll::view'),
  ('accounting_specialist', 'receipts::approve'),
  ('accounting_specialist', 'receipts::edit'),
  ('accounting_specialist', 'receipts::view'),
  ('accounting_specialist', 'reconciliation::reconcile'),
  ('accounting_specialist', 'reconciliation::view'),
  ('accounting_specialist', 'recurring::view'),
  ('accounting_specialist', 'reports::export'),
  ('accounting_specialist', 'reports::view'),
  ('accounting_specialist', 'vendors::create'),
  ('accounting_specialist', 'vendors::edit'),
  ('accounting_specialist', 'vendors::view'),
  ('check_processor', 'checks::approve'),
  ('check_processor', 'checks::create'),
  ('check_processor', 'checks::view'),
  ('check_processor', 'dashboard::view'),
  ('general_admin', 'bills::create'),
  ('general_admin', 'bills::view'),
  ('general_admin', 'customers::create'),
  ('general_admin', 'customers::edit'),
  ('general_admin', 'customers::view'),
  ('general_admin', 'dashboard::view'),
  ('general_admin', 'receipts::edit'),
  ('general_admin', 'receipts::view'),
  ('general_admin', 'vendors::create'),
  ('general_admin', 'vendors::edit'),
  ('general_admin', 'vendors::view'),
  ('business_user', 'biz_cash::view'),
  ('business_user', 'biz_dashboard::view'),
  ('business_user', 'biz_invoices::view'),
  ('business_user', 'biz_jobs::view'),
  ('business_user', 'biz_payroll::view'),
  ('business_user', 'biz_reports::export'),
  ('business_user', 'biz_reports::view');
delete from core.legacy_cell_rules;
insert into core.legacy_cell_rules (rule_no, cell, capability, actions, requires_all, requires_any) values
  (1, 'dashboard::view', 'home.workspace', array['view']::text[], '{}'::text[], '{}'::text[]),
  (1, 'dashboard::view', 'home.client', array['view']::text[], '{}'::text[], '{}'::text[]),
  (1, 'dashboard::view', 'ai.assist', array['view']::text[], '{}'::text[], '{}'::text[]),
  (2, 'bank_feed::view', 'bank.transactions', array['view']::text[], '{}'::text[], '{}'::text[]),
  (3, 'bank_feed::edit', 'bank.transactions', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (3, 'bank_feed::edit', 'bank.rules', array['view', 'create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (4, 'bank_feed::approve', 'bank.transactions', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (5, 'credit_cards::view', 'cards.transactions', array['view']::text[], '{}'::text[], '{}'::text[]),
  (6, 'credit_cards::edit', 'cards.transactions', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (7, 'credit_cards::approve', 'cards.transactions', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (8, 'receipts::view', 'exp.receipts', array['view']::text[], '{}'::text[], '{}'::text[]),
  (9, 'receipts::edit', 'exp.receipts', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (10, 'receipts::approve', 'exp.receipts', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (11, 'bills::view', 'ap.bills', array['view']::text[], '{}'::text[], '{}'::text[]),
  (11, 'bills::view', 'ap.purchase_orders', array['view']::text[], '{}'::text[], '{}'::text[]),
  (11, 'bills::view', 'ap.vendor_credits', array['view']::text[], '{}'::text[], '{}'::text[]),
  (12, 'bills::create', 'ap.bills', array['create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (12, 'bills::create', 'ap.purchase_orders', array['create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (12, 'bills::create', 'ap.vendor_credits', array['create']::text[], '{}'::text[], '{}'::text[]),
  (13, 'bills::approve', 'ap.bills', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (13, 'bills::approve', 'ap.purchase_orders', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (13, 'bills::approve', 'ap.vendor_credits', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (14, 'journal_entries::view', 'gl.journal_entries', array['view']::text[], '{}'::text[], '{}'::text[]),
  (15, 'journal_entries::create', 'gl.journal_entries', array['create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (16, 'journal_entries::post', 'gl.journal_entries', array['post']::text[], '{}'::text[], '{}'::text[]),
  (17, 'flagged::view', 'ctl.exceptions', array['view']::text[], '{}'::text[], '{}'::text[]),
  (18, 'flagged::resolve', 'ctl.exceptions', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (19, 'vendors::view', 'mdm.vendors', array['view']::text[], '{}'::text[], '{}'::text[]),
  (19, 'vendors::view', 'pay.vendor_bank_details', array['view']::text[], '{}'::text[], '{}'::text[]),
  (20, 'vendors::create', 'mdm.vendors', array['create']::text[], '{}'::text[], '{}'::text[]),
  (21, 'vendors::edit', 'mdm.vendors', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (22, 'vendors::edit', 'pay.vendor_bank_details', array['edit']::text[], '{}'::text[], array['bills::approve', 'checks::approve', 'payroll::approve']::text[]),
  (23, 'customers::view', 'mdm.customers', array['view']::text[], '{}'::text[], '{}'::text[]),
  (24, 'customers::create', 'mdm.customers', array['create']::text[], '{}'::text[], '{}'::text[]),
  (25, 'customers::edit', 'mdm.customers', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.invoices', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.estimates', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.deposits', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.collections', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.statements', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.recurring', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.credit_memos', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'ar.write_offs', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'revrec.methods', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'revrec.runs', array['view']::text[], '{}'::text[], '{}'::text[]),
  (26, 'invoices::view', 'revrec.schedules', array['view']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.invoices', array['create', 'edit', 'post', 'release']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.estimates', array['create', 'edit', 'delete', 'release']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.deposits', array['create', 'post']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.collections', array['edit', 'release']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.statements', array['release']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.recurring', array['create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.credit_memos', array['create']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'ar.write_offs', array['create']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'revrec.methods', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (27, 'invoices::create', 'revrec.runs', array['create', 'post']::text[], '{}'::text[], '{}'::text[]),
  (28, 'invoices::approve', 'ar.invoices', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (28, 'invoices::approve', 'ar.credit_memos', array['approve', 'post']::text[], '{}'::text[], '{}'::text[]),
  (28, 'invoices::approve', 'ar.write_offs', array['approve', 'post']::text[], '{}'::text[], '{}'::text[]),
  (29, 'jobs::view', 'jobs.jobs', array['view']::text[], '{}'::text[], '{}'::text[]),
  (29, 'jobs::view', 'jobs.change_orders', array['view']::text[], '{}'::text[], '{}'::text[]),
  (29, 'jobs::view', 'jobs.wip', array['view']::text[], '{}'::text[], '{}'::text[]),
  (30, 'jobs::create', 'jobs.jobs', array['create']::text[], '{}'::text[], '{}'::text[]),
  (30, 'jobs::create', 'jobs.change_orders', array['create']::text[], '{}'::text[], '{}'::text[]),
  (31, 'jobs::edit', 'jobs.jobs', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (31, 'jobs::edit', 'jobs.wip', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'reports.financial', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'reports.saved_views', array['view', 'create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'reports.packs', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'reports.board_package', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'fpa.budgets', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'fpa.scenarios', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'fpa.profitability', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'debt.borrowing_base', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'debt.loans', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'debt.covenants', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'debt.certificates', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'tax.sales_tax', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'tax.filings', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'tax.1099', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'tax.provision', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'exp.reports', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'exp.reimbursements', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'inv.items', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'inv.movements', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'inv.valuation', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'docs.documents', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'ai.agents', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'ctl.ai_decisions', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'cash.obligations', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'gl.dimensions', array['view']::text[], '{}'::text[], '{}'::text[]),
  (32, 'reports::view', 'ai.assist', array['view']::text[], '{}'::text[], '{}'::text[]),
  (33, 'reports::export', 'reports.financial', array['export']::text[], '{}'::text[], '{}'::text[]),
  (33, 'reports::export', 'fpa.budgets', array['export']::text[], '{}'::text[], '{}'::text[]),
  (33, 'reports::export', 'fpa.profitability', array['export']::text[], '{}'::text[], '{}'::text[]),
  (34, 'chart_of_accounts::view', 'gl.accounts', array['view']::text[], '{}'::text[], '{}'::text[]),
  (35, 'chart_of_accounts::request', 'gl.accounts', array['create']::text[], '{}'::text[], '{}'::text[]),
  (36, 'chart_of_accounts::approve', 'gl.accounts', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (37, 'reconciliation::view', 'bank.reconciliations', array['view']::text[], '{}'::text[], '{}'::text[]),
  (38, 'reconciliation::reconcile', 'bank.reconciliations', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (38, 'reconciliation::reconcile', 'bank.statements', array['create']::text[], '{}'::text[], '{}'::text[]),
  (39, 'reconciliation::reconcile', 'bank.reconciliations', array['approve']::text[], '{}'::text[], array['bills::approve', 'checks::approve', 'payroll::approve']::text[]),
  (40, 'close_mgmt::view', 'close.checklist', array['view']::text[], '{}'::text[], '{}'::text[]),
  (40, 'close_mgmt::view', 'gl.periods', array['view']::text[], '{}'::text[], '{}'::text[]),
  (41, 'close_mgmt::manage', 'close.checklist', array['edit', 'approve']::text[], '{}'::text[], '{}'::text[]),
  (41, 'close_mgmt::manage', 'gl.periods', array['edit', 'approve']::text[], '{}'::text[], '{}'::text[]),
  (42, 'payroll::view', 'payroll.register', array['view']::text[], '{}'::text[], '{}'::text[]),
  (42, 'payroll::view', 'payroll.runs', array['view']::text[], '{}'::text[], '{}'::text[]),
  (42, 'payroll::view', 'payroll.employees', array['view']::text[], '{}'::text[], '{}'::text[]),
  (43, 'payroll::create', 'payroll.register', array['create', 'post']::text[], '{}'::text[], '{}'::text[]),
  (43, 'payroll::create', 'payroll.runs', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (43, 'payroll::create', 'payroll.employees', array['edit']::text[], '{}'::text[], '{}'::text[]),
  (44, 'payroll::approve', 'payroll.runs', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (45, 'intercompany::view', 'gl.intercompany', array['view']::text[], '{}'::text[], '{}'::text[]),
  (45, 'intercompany::view', 'gl.internal_invoices', array['view']::text[], '{}'::text[], '{}'::text[]),
  (46, 'intercompany::create', 'gl.intercompany', array['create', 'edit', 'post']::text[], '{}'::text[], '{}'::text[]),
  (46, 'intercompany::create', 'gl.internal_invoices', array['create', 'edit', 'release']::text[], '{}'::text[], '{}'::text[]),
  (47, 'payments_execute::view', 'pay.customer_payments', array['view']::text[], '{}'::text[], '{}'::text[]),
  (48, 'payments_execute::run', 'pay.customer_payments', array['create', 'edit', 'post']::text[], '{}'::text[], '{}'::text[]),
  (49, 'check_run::view', 'pay.batches', array['view']::text[], '{}'::text[], '{}'::text[]),
  (50, 'check_run::run', 'pay.batches', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (51, 'ap_disbursement_release::view', 'pay.batches', array['view']::text[], '{}'::text[], '{}'::text[]),
  (52, 'ap_disbursement_release::run', 'pay.batches', array['release']::text[], '{}'::text[], '{}'::text[]),
  (53, 'payroll_release::view', 'payroll.runs', array['view']::text[], '{}'::text[], '{}'::text[]),
  (54, 'payroll_release::run', 'payroll.runs', array['release']::text[], '{}'::text[], '{}'::text[]),
  (55, 'cash_position::view', 'cash.position', array['view']::text[], '{}'::text[], '{}'::text[]),
  (56, 'forecast::view', 'cash.forecast', array['view']::text[], '{}'::text[], '{}'::text[]),
  (56, 'forecast::view', 'cash.obligations', array['view']::text[], '{}'::text[], '{}'::text[]),
  (57, 'forecast::edit', 'cash.forecast', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (57, 'forecast::edit', 'cash.obligations', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (58, 'team::view', 'core.access.members', array['view']::text[], '{}'::text[], '{}'::text[]),
  (58, 'team::view', 'ws.assignments', array['view']::text[], '{}'::text[], '{}'::text[]),
  (59, 'team::manage', 'core.access.members', array['create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (59, 'team::manage', 'ws.assignments', array['create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (60, 'user_permissions::view', 'core.access.roles', array['view']::text[], '{}'::text[], '{}'::text[]),
  (60, 'user_permissions::view', 'core.access.assignments', array['view']::text[], '{}'::text[], '{}'::text[]),
  (61, 'user_permissions::assign', 'core.access.roles', array['create', 'edit', 'delete', 'configure']::text[], '{}'::text[], '{}'::text[]),
  (61, 'user_permissions::assign', 'core.access.assignments', array['create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (62, 'compliance::view', 'ctl.vendor_compliance', array['view']::text[], '{}'::text[], '{}'::text[]),
  (62, 'compliance::view', 'ctl.compliance', array['view']::text[], '{}'::text[], '{}'::text[]),
  (62, 'compliance::view', 'ctl.pbc', array['view']::text[], '{}'::text[], '{}'::text[]),
  (63, 'compliance::manage', 'ctl.vendor_compliance', array['edit', 'approve']::text[], '{}'::text[], '{}'::text[]),
  (63, 'compliance::manage', 'ctl.compliance', array['edit', 'approve']::text[], '{}'::text[], '{}'::text[]),
  (63, 'compliance::manage', 'ctl.pbc', array['create', 'edit', 'approve']::text[], '{}'::text[], '{}'::text[]),
  (64, 'fixed_assets::view', 'fa.assets', array['view']::text[], '{}'::text[], '{}'::text[]),
  (64, 'fixed_assets::view', 'fa.leases', array['view']::text[], '{}'::text[], '{}'::text[]),
  (64, 'fixed_assets::view', 'fa.prepaids', array['view']::text[], '{}'::text[], '{}'::text[]),
  (65, 'fixed_assets::create', 'fa.assets', array['create', 'edit', 'post']::text[], '{}'::text[], '{}'::text[]),
  (65, 'fixed_assets::create', 'fa.leases', array['create', 'edit', 'post']::text[], '{}'::text[], '{}'::text[]),
  (65, 'fixed_assets::create', 'fa.prepaids', array['create', 'edit', 'post']::text[], '{}'::text[], '{}'::text[]),
  (66, 'recurring::view', 'gl.recurring_entries', array['view']::text[], '{}'::text[], '{}'::text[]),
  (67, 'recurring::create', 'gl.recurring_entries', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (68, 'recurring::create', 'gl.recurring_entries', array['post']::text[], array['journal_entries::post']::text[], '{}'::text[]),
  (69, 'settings_acct::view', 'core.tenant.accounting_settings', array['view']::text[], '{}'::text[], '{}'::text[]),
  (70, 'settings_acct::edit', 'core.tenant.accounting_settings', array['configure']::text[], '{}'::text[], '{}'::text[]),
  (71, 'settings_system::view', 'core.tenant.settings', array['view']::text[], '{}'::text[], '{}'::text[]),
  (71, 'settings_system::view', 'core.tenant.billing', array['view']::text[], '{}'::text[], '{}'::text[]),
  (71, 'settings_system::view', 'pay.provider_connections', array['view']::text[], '{}'::text[], '{}'::text[]),
  (71, 'settings_system::view', 'ctl.approval_workflows', array['view']::text[], '{}'::text[], '{}'::text[]),
  (71, 'settings_system::view', 'ai.autonomy', array['view']::text[], '{}'::text[], '{}'::text[]),
  (71, 'settings_system::view', 'int.connections', array['view']::text[], '{}'::text[], '{}'::text[]),
  (71, 'settings_system::view', 'ws.client_health', array['view']::text[], '{}'::text[], '{}'::text[]),
  (72, 'settings_system::edit', 'core.tenant.settings', array['configure']::text[], '{}'::text[], '{}'::text[]),
  (72, 'settings_system::edit', 'core.tenant.billing', array['configure']::text[], '{}'::text[], '{}'::text[]),
  (72, 'settings_system::edit', 'pay.provider_connections', array['configure']::text[], '{}'::text[], '{}'::text[]),
  (72, 'settings_system::edit', 'ctl.approval_workflows', array['configure']::text[], '{}'::text[], '{}'::text[]),
  (72, 'settings_system::edit', 'ai.autonomy', array['configure']::text[], '{}'::text[], '{}'::text[]),
  (72, 'settings_system::edit', 'int.connections', array['create', 'delete', 'configure']::text[], '{}'::text[], '{}'::text[]),
  (73, 'import::view', 'onb.imports', array['view']::text[], '{}'::text[], '{}'::text[]),
  (73, 'import::view', 'onb.conversion', array['view']::text[], '{}'::text[], '{}'::text[]),
  (74, 'import::run', 'onb.imports', array['create']::text[], '{}'::text[], '{}'::text[]),
  (74, 'import::run', 'onb.conversion', array['approve', 'post']::text[], '{}'::text[], '{}'::text[]),
  (75, 'import::run', 'onb.imports', array['post']::text[], array['journal_entries::post']::text[], '{}'::text[]),
  (76, 'audit_trail::view', 'ctl.audit_trail', array['view']::text[], '{}'::text[], '{}'::text[]),
  (76, 'audit_trail::view', 'ctl.ai_decisions', array['view']::text[], '{}'::text[], '{}'::text[]),
  (77, 'checks::view', 'pay.checks', array['view']::text[], '{}'::text[], '{}'::text[]),
  (78, 'checks::create', 'pay.checks', array['create', 'edit']::text[], '{}'::text[], '{}'::text[]),
  (79, 'checks::approve', 'pay.batches', array['approve']::text[], '{}'::text[], '{}'::text[]),
  (80, 'biz_dashboard::view', 'home.client', array['view']::text[], '{}'::text[], '{}'::text[]),
  (81, 'biz_reports::view', 'reports.financial', array['view']::text[], '{}'::text[], '{}'::text[]),
  (82, 'biz_reports::export', 'reports.financial', array['export']::text[], '{}'::text[], '{}'::text[]),
  (83, 'biz_invoices::view', 'ar.invoices', array['view']::text[], '{}'::text[], '{}'::text[]),
  (84, 'biz_payroll::view', 'payroll.register', array['view']::text[], '{}'::text[], '{}'::text[]),
  (85, 'biz_jobs::view', 'jobs.jobs', array['view']::text[], '{}'::text[], '{}'::text[]),
  (86, 'biz_cash::view', 'cash.position', array['view']::text[], '{}'::text[], '{}'::text[]),
  (87, 'flag::canManageUsers', 'core.access.members', array['view', 'create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (87, 'flag::canManageUsers', 'core.access.roles', array['view', 'create', 'edit', 'delete', 'configure']::text[], '{}'::text[], '{}'::text[]),
  (87, 'flag::canManageUsers', 'core.access.assignments', array['view', 'create', 'edit', 'delete']::text[], '{}'::text[], '{}'::text[]),
  (87, 'flag::canManageUsers', 'core.access.reviews', array['view', 'create', 'approve', 'export']::text[], '{}'::text[], '{}'::text[]),
  (87, 'flag::canManageUsers', 'core.access.simulate', array['view']::text[], '{}'::text[], '{}'::text[]),
  (87, 'flag::canManageUsers', 'core.access.sod_policy', array['view', 'configure']::text[], '{}'::text[], '{}'::text[]),
  (88, 'flag::canEditAccountingSettings', 'core.tenant.accounting_settings', array['view', 'configure']::text[], '{}'::text[], '{}'::text[]),
  (89, 'flag::canEditSystemSettings', 'core.tenant.settings', array['view', 'configure']::text[], '{}'::text[], '{}'::text[]);
-- END GENERATED legacy

-- BEGIN GENERATED role_templates (apps/web/scripts/rbac/generate-access-seed.ts — do not edit by hand)
select core.rbac_seed_platform_roles($seed$[
  {"key":"platform_admin","name":"Platform admin","description":"Operates MeritBooks. Tenant data only through a support grant.","audience":"platform","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"home.platform","actions":["view"],"constraints":{}},{"capability":"platform.billing","actions":["view","configure"],"constraints":{}},{"capability":"platform.break_glass","actions":["create"],"constraints":{}},{"capability":"platform.entitlements","actions":["view","configure"],"constraints":{}},{"capability":"platform.health","actions":["view"],"constraints":{}},{"capability":"platform.support","actions":["view","create"],"constraints":{}},{"capability":"platform.templates","actions":["view","create","edit","configure"],"constraints":{}},{"capability":"platform.tenants","actions":["view","create","edit"],"constraints":{}}]},
  {"key":"platform_support","name":"Platform support","description":"Read-only inside an approved support session.","audience":"platform","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"home.platform","actions":["view"],"constraints":{}},{"capability":"platform.health","actions":["view"],"constraints":{}},{"capability":"platform.support","actions":["view","create"],"constraints":{}},{"capability":"platform.tenants","actions":["view"],"constraints":{}}]},
  {"key":"tenant_admin","name":"Tenant admin","description":"Administers the workspace: people, access, settings and billing. Books view only.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"ai.agents","actions":["view","configure"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ai.autonomy","actions":["view","configure"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ap.bills","actions":["view"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view"],"constraints":{}},{"capability":"ar.collections","actions":["view"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view"],"constraints":{}},{"capability":"ar.deposits","actions":["view"],"constraints":{}},{"capability":"ar.estimates","actions":["view"],"constraints":{}},{"capability":"ar.invoices","actions":["view"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view"],"constraints":{}},{"capability":"bank.connections","actions":["view"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view"],"constraints":{}},{"capability":"bank.rules","actions":["view"],"constraints":{}},{"capability":"bank.statements","actions":["view"],"constraints":{}},{"capability":"bank.transactions","actions":["view"],"constraints":{}},{"capability":"bank.transfers","actions":["view"],"constraints":{}},{"capability":"cards.cardholders","actions":["view"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view"],"constraints":{}},{"capability":"cash.forecast","actions":["view"],"constraints":{}},{"capability":"cash.obligations","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"consol.eliminations","actions":["view"],"constraints":{}},{"capability":"consol.groups","actions":["view"],"constraints":{}},{"capability":"consol.statements","actions":["view"],"constraints":{}},{"capability":"core.access.assignments","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"core.access.members","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"core.access.reviews","actions":["view","create","approve","export"],"constraints":{}},{"capability":"core.access.roles","actions":["view","create","edit","delete","configure"],"constraints":{}},{"capability":"core.access.simulate","actions":["view"],"constraints":{}},{"capability":"core.access.sod_policy","actions":["view","configure"],"constraints":{}},{"capability":"core.tenant.accounting_settings","actions":["view","configure"],"constraints":{}},{"capability":"core.tenant.billing","actions":["view","configure"],"constraints":{}},{"capability":"core.tenant.dashboard_layouts","actions":["view","configure"],"constraints":{}},{"capability":"core.tenant.export","actions":["export"],"constraints":{}},{"capability":"core.tenant.settings","actions":["view","configure"],"constraints":{}},{"capability":"core.tenant.support_access","actions":["view","approve"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view","configure"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view"],"constraints":{}},{"capability":"ctl.pbc","actions":["view"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view"],"constraints":{}},{"capability":"debt.certificates","actions":["view"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view"],"constraints":{}},{"capability":"exp.reports","actions":["view"],"constraints":{}},{"capability":"fa.assets","actions":["view"],"constraints":{}},{"capability":"fa.leases","actions":["view"],"constraints":{}},{"capability":"fa.prepaids","actions":["view"],"constraints":{}},{"capability":"fpa.budgets","actions":["view"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view"],"constraints":{}},{"capability":"gl.accounts","actions":["view"],"constraints":{}},{"capability":"gl.dimensions","actions":["view"],"constraints":{}},{"capability":"gl.intercompany","actions":["view"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view"],"constraints":{}},{"capability":"gl.periods","actions":["view"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view"],"constraints":{}},{"capability":"gl.year_end","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.api_keys","actions":["view","create","delete"],"constraints":{}},{"capability":"int.connections","actions":["view","create","delete","configure"],"constraints":{}},{"capability":"int.mappings","actions":["view"],"constraints":{}},{"capability":"int.sync_runs","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view"],"constraints":{}},{"capability":"inv.movements","actions":["view"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"onb.clients","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.conversion","actions":["view"],"constraints":{}},{"capability":"onb.imports","actions":["view"],"constraints":{}},{"capability":"onb.wizard","actions":["view"],"constraints":{}},{"capability":"pay.batches","actions":["view"],"constraints":{}},{"capability":"pay.checks","actions":["view"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view"],"constraints":{}},{"capability":"pay.refunds","actions":["view"],"constraints":{}},{"capability":"pay.vendor_bank_details","actions":["view"],"constraints":{}},{"capability":"payroll.employees","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"payroll.remittances","actions":["view"],"constraints":{}},{"capability":"payroll.runs","actions":["view"],"constraints":{}},{"capability":"payroll.settings","actions":["view"],"constraints":{}},{"capability":"portal.client","actions":["view","configure"],"constraints":{}},{"capability":"portal.customer","actions":["view","configure"],"constraints":{}},{"capability":"portal.vendor","actions":["view","configure"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}},{"capability":"tax.1099","actions":["view"],"constraints":{}},{"capability":"tax.filings","actions":["view"],"constraints":{}},{"capability":"tax.provision","actions":["view"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view"],"constraints":{}},{"capability":"ws.assignments","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"owner","name":"Owner","description":"Makes the decisions: approves and releases, reads the numbers.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"visible","tin":"reveal_logged","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10,"session_max_hours":12,"idle_timeout_minutes":60},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"ai.agents","actions":["view"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ai.autonomy","actions":["view"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","approve"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","approve"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view","approve"],"constraints":{}},{"capability":"ar.collections","actions":["view"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view"],"constraints":{}},{"capability":"ar.deposits","actions":["view"],"constraints":{}},{"capability":"ar.estimates","actions":["view"],"constraints":{}},{"capability":"ar.invoices","actions":["view","export"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view"],"constraints":{}},{"capability":"bank.connections","actions":["view"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view"],"constraints":{}},{"capability":"bank.rules","actions":["view"],"constraints":{}},{"capability":"bank.statements","actions":["view"],"constraints":{}},{"capability":"bank.transactions","actions":["view"],"constraints":{}},{"capability":"cards.cardholders","actions":["view"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view"],"constraints":{}},{"capability":"cash.forecast","actions":["view"],"constraints":{}},{"capability":"cash.obligations","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"core.access.assignments","actions":["view"],"constraints":{}},{"capability":"core.access.members","actions":["view"],"constraints":{}},{"capability":"core.access.reviews","actions":["view"],"constraints":{}},{"capability":"core.access.roles","actions":["view"],"constraints":{}},{"capability":"core.access.simulate","actions":["view"],"constraints":{}},{"capability":"core.access.sod_policy","actions":["view"],"constraints":{}},{"capability":"core.tenant.accounting_settings","actions":["view"],"constraints":{}},{"capability":"core.tenant.billing","actions":["view"],"constraints":{}},{"capability":"core.tenant.settings","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view"],"constraints":{}},{"capability":"ctl.pbc","actions":["view"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view","approve"],"constraints":{}},{"capability":"debt.certificates","actions":["view","approve","release"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","approve"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","approve"],"constraints":{}},{"capability":"exp.reports","actions":["view","approve"],"constraints":{}},{"capability":"fa.assets","actions":["view"],"constraints":{}},{"capability":"fa.leases","actions":["view"],"constraints":{}},{"capability":"fa.prepaids","actions":["view"],"constraints":{}},{"capability":"fpa.budgets","actions":["view","approve"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view"],"constraints":{}},{"capability":"gl.accounts","actions":["view","export"],"constraints":{}},{"capability":"gl.dimensions","actions":["view"],"constraints":{}},{"capability":"gl.intercompany","actions":["view"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","export"],"constraints":{}},{"capability":"gl.periods","actions":["view"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view"],"constraints":{}},{"capability":"gl.year_end","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.api_keys","actions":["view"],"constraints":{}},{"capability":"int.connections","actions":["view"],"constraints":{}},{"capability":"int.mappings","actions":["view"],"constraints":{}},{"capability":"int.sync_runs","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view"],"constraints":{}},{"capability":"inv.movements","actions":["view"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"onb.clients","actions":["view"],"constraints":{}},{"capability":"onb.conversion","actions":["view"],"constraints":{}},{"capability":"onb.imports","actions":["view"],"constraints":{}},{"capability":"onb.wizard","actions":["view"],"constraints":{}},{"capability":"pay.batches","actions":["view","approve","release"],"constraints":{}},{"capability":"pay.checks","actions":["view"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view"],"constraints":{}},{"capability":"pay.refunds","actions":["view","approve","release"],"constraints":{}},{"capability":"pay.vendor_bank_details","actions":["view"],"constraints":{}},{"capability":"payroll.employees","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"payroll.runs","actions":["view","approve","release"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view","release"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit","release"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}},{"capability":"tax.1099","actions":["view"],"constraints":{}},{"capability":"tax.filings","actions":["view","approve"],"constraints":{}},{"capability":"tax.provision","actions":["view"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view"],"constraints":{}},{"capability":"ws.assignments","actions":["view"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"cfo","name":"CFO","description":"Final release and hard close; financial oversight across clients.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"visible","tin":"reveal_logged","bank":"reveal_logged","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10,"session_max_hours":12,"idle_timeout_minutes":60},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"ai.agents","actions":["view"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ai.autonomy","actions":["view","configure"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","approve"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","approve"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view","approve"],"constraints":{}},{"capability":"ar.collections","actions":["view"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view","approve"],"constraints":{}},{"capability":"ar.deposits","actions":["view"],"constraints":{}},{"capability":"ar.estimates","actions":["view"],"constraints":{}},{"capability":"ar.invoices","actions":["view","approve","export"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view","approve"],"constraints":{}},{"capability":"bank.connections","actions":["view"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view","approve"],"constraints":{}},{"capability":"bank.rules","actions":["view"],"constraints":{}},{"capability":"bank.statements","actions":["view"],"constraints":{}},{"capability":"bank.transactions","actions":["view","approve"],"constraints":{}},{"capability":"bank.transfers","actions":["view","approve","release"],"constraints":{}},{"capability":"cards.cardholders","actions":["view"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view","approve"],"constraints":{}},{"capability":"cash.forecast","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.obligations","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view","approve"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"consol.eliminations","actions":["view"],"constraints":{}},{"capability":"consol.groups","actions":["view"],"constraints":{}},{"capability":"consol.statements","actions":["view","export"],"constraints":{}},{"capability":"core.access.assignments","actions":["view"],"constraints":{}},{"capability":"core.access.members","actions":["view"],"constraints":{}},{"capability":"core.access.reviews","actions":["view"],"constraints":{}},{"capability":"core.access.roles","actions":["view"],"constraints":{}},{"capability":"core.access.simulate","actions":["view"],"constraints":{}},{"capability":"core.access.sod_policy","actions":["view"],"constraints":{}},{"capability":"core.tenant.accounting_settings","actions":["view","configure"],"constraints":{}},{"capability":"core.tenant.settings","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view","configure"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view","approve"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view","approve"],"constraints":{}},{"capability":"ctl.pbc","actions":["view","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view","approve"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view","create","approve","release"],"constraints":{}},{"capability":"debt.certificates","actions":["view","create","approve","release"],"constraints":{}},{"capability":"debt.covenants","actions":["view","edit","configure"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view","create","edit","configure"],"constraints":{}},{"capability":"debt.loans","actions":["view","create","edit"],"constraints":{}},{"capability":"docs.documents","actions":["view"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","approve"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","approve"],"constraints":{}},{"capability":"exp.reports","actions":["view","approve"],"constraints":{}},{"capability":"fa.assets","actions":["view"],"constraints":{}},{"capability":"fa.leases","actions":["view"],"constraints":{}},{"capability":"fa.prepaids","actions":["view"],"constraints":{}},{"capability":"fpa.budgets","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view","create","edit"],"constraints":{}},{"capability":"gl.accounts","actions":["view","approve","export"],"constraints":{}},{"capability":"gl.dimensions","actions":["view"],"constraints":{}},{"capability":"gl.intercompany","actions":["view","approve"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view","approve"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","approve","export"],"constraints":{}},{"capability":"gl.periods","actions":["view","approve"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view","approve"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view"],"constraints":{}},{"capability":"gl.year_end","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.api_keys","actions":["view"],"constraints":{}},{"capability":"int.connections","actions":["view"],"constraints":{}},{"capability":"int.mappings","actions":["view"],"constraints":{}},{"capability":"int.sync_runs","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view"],"constraints":{}},{"capability":"inv.movements","actions":["view"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view","export"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"onb.clients","actions":["view"],"constraints":{}},{"capability":"onb.conversion","actions":["view"],"constraints":{}},{"capability":"onb.imports","actions":["view"],"constraints":{}},{"capability":"onb.wizard","actions":["view"],"constraints":{}},{"capability":"pay.batches","actions":["view","approve","release"],"constraints":{}},{"capability":"pay.checks","actions":["view"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view"],"constraints":{}},{"capability":"pay.refunds","actions":["view","approve","release"],"constraints":{}},{"capability":"pay.vendor_bank_details","actions":["view"],"constraints":{}},{"capability":"payroll.employees","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"payroll.remittances","actions":["view","release"],"constraints":{}},{"capability":"payroll.runs","actions":["view","approve","release"],"constraints":{}},{"capability":"portal.client","actions":["view"],"constraints":{}},{"capability":"portal.customer","actions":["view"],"constraints":{}},{"capability":"portal.vendor","actions":["view"],"constraints":{}},{"capability":"reports.board_package","actions":["view","release"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view","release"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view","export"],"constraints":{}},{"capability":"tax.1099","actions":["view"],"constraints":{}},{"capability":"tax.filings","actions":["view","approve","release"],"constraints":{}},{"capability":"tax.provision","actions":["view"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view"],"constraints":{}},{"capability":"ws.assignments","actions":["view"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"controller","name":"Controller","description":"Runs the books and the close; approves up to $250,000. Release off by default.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"visible","tin":"masked","bank":"reveal_logged","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10,"session_max_hours":12,"idle_timeout_minutes":60},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.agents","actions":["view"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ai.autonomy","actions":["view","configure"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","create","edit","delete","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","create","edit","delete","approve"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"ap.vendor_credits","actions":["view","create","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"ar.collections","actions":["view","edit"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view","create","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"ar.deposits","actions":["view","create","post"],"constraints":{}},{"capability":"ar.estimates","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ar.invoices","actions":["view","create","edit","delete","approve","post"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view","create","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"bank.connections","actions":["view","create","delete"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"bank.rules","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"bank.statements","actions":["view","create"],"constraints":{}},{"capability":"bank.transactions","actions":["view","edit","approve"],"constraints":{}},{"capability":"bank.transfers","actions":["view","create","approve"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"cards.cardholders","actions":["view","edit"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view","edit","approve"],"constraints":{}},{"capability":"cash.forecast","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.obligations","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view","edit","approve","configure"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"consol.eliminations","actions":["view","create","post"],"constraints":{}},{"capability":"consol.groups","actions":["view","create","edit","delete","configure"],"constraints":{}},{"capability":"consol.statements","actions":["view"],"constraints":{}},{"capability":"core.access.assignments","actions":["view"],"constraints":{}},{"capability":"core.access.members","actions":["view"],"constraints":{}},{"capability":"core.access.reviews","actions":["view"],"constraints":{}},{"capability":"core.access.roles","actions":["view"],"constraints":{}},{"capability":"core.access.simulate","actions":["view"],"constraints":{}},{"capability":"core.access.sod_policy","actions":["view"],"constraints":{}},{"capability":"core.tenant.accounting_settings","actions":["view","configure"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view","configure"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view","edit","approve"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view","edit","approve"],"constraints":{}},{"capability":"ctl.pbc","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view","edit","approve"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view","create"],"constraints":{}},{"capability":"debt.certificates","actions":["view","create"],"constraints":{}},{"capability":"debt.covenants","actions":["view","edit"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view","create","edit"],"constraints":{}},{"capability":"debt.loans","actions":["view","create","edit","post"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","create","approve"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"exp.reports","actions":["view","create","edit","approve"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"fa.assets","actions":["view","create","edit","delete","post"],"constraints":{}},{"capability":"fa.leases","actions":["view","create","edit","post"],"constraints":{}},{"capability":"fa.prepaids","actions":["view","create","edit","post"],"constraints":{}},{"capability":"fpa.budgets","actions":["view","create","edit"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view","create","edit"],"constraints":{}},{"capability":"gl.accounts","actions":["view","create","edit","delete","approve","configure"],"constraints":{}},{"capability":"gl.dimensions","actions":["view","create","edit","delete","configure"],"constraints":{}},{"capability":"gl.intercompany","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","create","edit","delete","approve","post"],"constraints":{}},{"capability":"gl.periods","actions":["view","edit","approve","configure"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view","create","edit","delete","approve","post"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view","create","edit","post"],"constraints":{}},{"capability":"gl.year_end","actions":["view","post"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.api_keys","actions":["view"],"constraints":{}},{"capability":"int.connections","actions":["view"],"constraints":{}},{"capability":"int.mappings","actions":["view"],"constraints":{}},{"capability":"int.sync_runs","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"inv.movements","actions":["view","create","approve","post"],"constraints":{}},{"capability":"inv.valuation","actions":["view","post"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view","create"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"jobs.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"jobs.wip","actions":["view","edit","post"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.clients","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.conversion","actions":["view","approve","post"],"constraints":{}},{"capability":"onb.imports","actions":["view","create","post"],"constraints":{}},{"capability":"onb.wizard","actions":["view","edit"],"constraints":{}},{"capability":"pay.batches","actions":["view","create","edit","approve"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"pay.checks","actions":["view","create","edit"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view","create","edit"],"constraints":{}},{"capability":"pay.refunds","actions":["view","create","approve"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"pay.vendor_bank_details","actions":["view","edit"],"constraints":{}},{"capability":"payroll.employees","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"payroll.remittances","actions":["view"],"constraints":{}},{"capability":"payroll.runs","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":25000000}}},{"capability":"portal.client","actions":["view"],"constraints":{}},{"capability":"portal.customer","actions":["view","release"],"constraints":{}},{"capability":"portal.vendor","actions":["view","release"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view","release"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit","release"],"constraints":{}},{"capability":"revrec.methods","actions":["view","edit","configure"],"constraints":{}},{"capability":"revrec.runs","actions":["view","create","post"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}},{"capability":"tax.1099","actions":["view","create","edit"],"constraints":{}},{"capability":"tax.filings","actions":["view","create"],"constraints":{}},{"capability":"tax.provision","actions":["view","create","edit","post"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view","edit","post"],"constraints":{}},{"capability":"ws.assignments","actions":["view"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"finance_director","name":"Finance director","description":"CFO-like within assigned clients; approves and releases up to $100,000.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10,"session_max_hours":12,"idle_timeout_minutes":60},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.agents","actions":["view"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"ap.vendor_credits","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"ar.collections","actions":["view"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"ar.deposits","actions":["view"],"constraints":{}},{"capability":"ar.estimates","actions":["view"],"constraints":{}},{"capability":"ar.invoices","actions":["view","approve"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"bank.connections","actions":["view"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view"],"constraints":{}},{"capability":"bank.rules","actions":["view"],"constraints":{}},{"capability":"bank.statements","actions":["view"],"constraints":{}},{"capability":"bank.transactions","actions":["view"],"constraints":{}},{"capability":"bank.transfers","actions":["view","approve","release"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"cards.cardholders","actions":["view"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view"],"constraints":{}},{"capability":"cash.forecast","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.obligations","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"consol.eliminations","actions":["view"],"constraints":{}},{"capability":"consol.groups","actions":["view"],"constraints":{}},{"capability":"consol.statements","actions":["view"],"constraints":{}},{"capability":"core.access.assignments","actions":["view"],"constraints":{}},{"capability":"core.access.members","actions":["view"],"constraints":{}},{"capability":"core.access.reviews","actions":["view"],"constraints":{}},{"capability":"core.access.roles","actions":["view"],"constraints":{}},{"capability":"core.access.simulate","actions":["view"],"constraints":{}},{"capability":"core.access.sod_policy","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view","approve"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view","approve"],"constraints":{}},{"capability":"ctl.pbc","actions":["view","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view","approve"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view","approve"],"constraints":{}},{"capability":"debt.certificates","actions":["view","approve"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","approve"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"exp.reports","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"fa.assets","actions":["view"],"constraints":{}},{"capability":"fa.leases","actions":["view"],"constraints":{}},{"capability":"fa.prepaids","actions":["view"],"constraints":{}},{"capability":"fpa.budgets","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view","create","edit"],"constraints":{}},{"capability":"gl.accounts","actions":["view","approve"],"constraints":{}},{"capability":"gl.dimensions","actions":["view"],"constraints":{}},{"capability":"gl.intercompany","actions":["view","approve"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view","approve"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","approve"],"constraints":{}},{"capability":"gl.periods","actions":["view"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view","approve"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view"],"constraints":{}},{"capability":"gl.year_end","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view"],"constraints":{}},{"capability":"inv.movements","actions":["view"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"onb.clients","actions":["view"],"constraints":{}},{"capability":"onb.conversion","actions":["view"],"constraints":{}},{"capability":"onb.imports","actions":["view"],"constraints":{}},{"capability":"onb.wizard","actions":["view"],"constraints":{}},{"capability":"pay.batches","actions":["view","approve","release"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"pay.checks","actions":["view"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view"],"constraints":{}},{"capability":"pay.refunds","actions":["view","approve","release"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"pay.vendor_bank_details","actions":["view"],"constraints":{}},{"capability":"payroll.employees","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"payroll.runs","actions":["view","approve"],"constraints":{"amount_limit":{"max_per_item_cents":10000000}}},{"capability":"portal.client","actions":["view"],"constraints":{}},{"capability":"portal.customer","actions":["view"],"constraints":{}},{"capability":"portal.vendor","actions":["view"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}},{"capability":"tax.1099","actions":["view"],"constraints":{}},{"capability":"tax.filings","actions":["view"],"constraints":{}},{"capability":"tax.provision","actions":["view"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view"],"constraints":{}},{"capability":"ws.assignments","actions":["view"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"accounting_manager","name":"Accounting manager","description":"Reviews and posts; approves up to $25,000; staffs bookkeepers within their own access.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10,"session_max_hours":12,"idle_timeout_minutes":60},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.agents","actions":["view"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","create","edit","delete","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","create","edit","delete","approve"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"ap.vendor_credits","actions":["view","create","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"ar.collections","actions":["view","edit"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view","create","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"ar.deposits","actions":["view","create","post"],"constraints":{}},{"capability":"ar.estimates","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ar.invoices","actions":["view","create","edit","delete","approve","post"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view","create","approve","post"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"bank.connections","actions":["view","create","delete"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"bank.rules","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"bank.statements","actions":["view","create"],"constraints":{}},{"capability":"bank.transactions","actions":["view","edit","approve"],"constraints":{}},{"capability":"bank.transfers","actions":["view","create","approve"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"cards.cardholders","actions":["view","edit"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view","edit","approve"],"constraints":{}},{"capability":"cash.forecast","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.obligations","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view","edit","approve"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"core.access.assignments","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"core.access.members","actions":["view","create","edit"],"constraints":{}},{"capability":"core.access.roles","actions":["view"],"constraints":{}},{"capability":"core.access.simulate","actions":["view"],"constraints":{}},{"capability":"core.tenant.accounting_settings","actions":["view"],"constraints":{}},{"capability":"core.tenant.billing","actions":["view"],"constraints":{}},{"capability":"core.tenant.dashboard_layouts","actions":["view"],"constraints":{}},{"capability":"core.tenant.settings","actions":["view"],"constraints":{}},{"capability":"core.tenant.support_access","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view","edit","approve"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view","edit","approve"],"constraints":{}},{"capability":"ctl.pbc","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view","edit","approve"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view","create"],"constraints":{}},{"capability":"debt.certificates","actions":["view","create"],"constraints":{}},{"capability":"debt.covenants","actions":["view","edit"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view","create","edit"],"constraints":{}},{"capability":"debt.loans","actions":["view","create","edit"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","create","approve"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"exp.reports","actions":["view","create","edit","approve"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"fa.assets","actions":["view","create","edit","delete","post"],"constraints":{}},{"capability":"fa.leases","actions":["view","create","edit","post"],"constraints":{}},{"capability":"fa.prepaids","actions":["view","create","edit","post"],"constraints":{}},{"capability":"fpa.budgets","actions":["view"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view"],"constraints":{}},{"capability":"gl.accounts","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"gl.dimensions","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"gl.intercompany","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","create","edit","delete","approve","post"],"constraints":{}},{"capability":"gl.periods","actions":["view","edit"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view","create","edit","delete","approve","post"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view","create","edit","post"],"constraints":{}},{"capability":"gl.year_end","actions":["view","post"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.api_keys","actions":["view"],"constraints":{}},{"capability":"int.connections","actions":["view"],"constraints":{}},{"capability":"int.mappings","actions":["view"],"constraints":{}},{"capability":"int.sync_runs","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"inv.movements","actions":["view","create","approve"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view","create"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"jobs.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"jobs.wip","actions":["view","edit","post"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.clients","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.conversion","actions":["view","post"],"constraints":{}},{"capability":"onb.imports","actions":["view","create","post"],"constraints":{}},{"capability":"onb.wizard","actions":["view","edit"],"constraints":{}},{"capability":"pay.batches","actions":["view","create","edit","approve"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"pay.checks","actions":["view","create","edit"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view","create","edit"],"constraints":{}},{"capability":"pay.refunds","actions":["view","create","approve"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"pay.vendor_bank_details","actions":["view"],"constraints":{}},{"capability":"payroll.employees","actions":["view","create","edit"],"constraints":{}},{"capability":"payroll.register","actions":["view","create"],"constraints":{}},{"capability":"payroll.remittances","actions":["view","create"],"constraints":{}},{"capability":"payroll.runs","actions":["view","create","edit","approve"],"constraints":{"amount_limit":{"max_per_item_cents":2500000}}},{"capability":"portal.client","actions":["view"],"constraints":{}},{"capability":"portal.customer","actions":["view","release"],"constraints":{}},{"capability":"portal.vendor","actions":["view","release"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view","release"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit","release"],"constraints":{}},{"capability":"revrec.methods","actions":["view","edit"],"constraints":{}},{"capability":"revrec.runs","actions":["view","create","post"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}},{"capability":"tax.1099","actions":["view","create","edit"],"constraints":{}},{"capability":"tax.filings","actions":["view","create"],"constraints":{}},{"capability":"tax.provision","actions":["view","create","edit"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view","edit"],"constraints":{}},{"capability":"ws.assignments","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"bookkeeper","name":"Bookkeeper","description":"Keeps the books on assigned clients. No money approval or release.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.agents","actions":["view"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view","create"],"constraints":{}},{"capability":"ar.collections","actions":["view","edit","release"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view","create"],"constraints":{}},{"capability":"ar.deposits","actions":["view","create"],"constraints":{}},{"capability":"ar.estimates","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"ar.invoices","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ar.statements","actions":["view","release"],"constraints":{}},{"capability":"ar.write_offs","actions":["view","create"],"constraints":{}},{"capability":"bank.connections","actions":["view"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view","create","edit"],"constraints":{}},{"capability":"bank.rules","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"bank.statements","actions":["view","create"],"constraints":{}},{"capability":"bank.transactions","actions":["view","edit","approve"],"constraints":{}},{"capability":"bank.transfers","actions":["view"],"constraints":{}},{"capability":"cards.cardholders","actions":["view","edit"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view","edit","approve"],"constraints":{}},{"capability":"cash.forecast","actions":["view"],"constraints":{}},{"capability":"cash.obligations","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view","edit"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view","edit"],"constraints":{}},{"capability":"ctl.pbc","actions":["view"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view"],"constraints":{}},{"capability":"debt.certificates","actions":["view"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","create"],"constraints":{}},{"capability":"exp.reports","actions":["view","create","edit"],"constraints":{}},{"capability":"fa.assets","actions":["view"],"constraints":{}},{"capability":"fa.leases","actions":["view"],"constraints":{}},{"capability":"fa.prepaids","actions":["view"],"constraints":{}},{"capability":"gl.accounts","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"gl.dimensions","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"gl.intercompany","actions":["view","create","edit"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view","create","edit"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"gl.periods","actions":["view"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view","create","edit"],"constraints":{}},{"capability":"gl.year_end","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.api_keys","actions":["view"],"constraints":{}},{"capability":"int.connections","actions":["view"],"constraints":{}},{"capability":"int.mappings","actions":["view"],"constraints":{}},{"capability":"int.sync_runs","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"inv.movements","actions":["view","create"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view","create"],"constraints":{}},{"capability":"jobs.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"jobs.wip","actions":["view","edit"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.clients","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.conversion","actions":["view"],"constraints":{}},{"capability":"onb.imports","actions":["view","create"],"constraints":{}},{"capability":"onb.wizard","actions":["view","edit"],"constraints":{}},{"capability":"pay.batches","actions":["view"],"constraints":{}},{"capability":"pay.checks","actions":["view"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view"],"constraints":{}},{"capability":"pay.refunds","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view","create"],"constraints":{}},{"capability":"portal.client","actions":["view"],"constraints":{}},{"capability":"portal.customer","actions":["view"],"constraints":{}},{"capability":"portal.vendor","actions":["view"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit","release"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}},{"capability":"tax.1099","actions":["view","create","edit"],"constraints":{}},{"capability":"tax.filings","actions":["view"],"constraints":{}},{"capability":"tax.provision","actions":["view"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view","edit"],"constraints":{}},{"capability":"ws.assignments","actions":["view"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"ap_clerk","name":"AP clerk","description":"Bills in, pay runs prepared.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view","create"],"constraints":{}},{"capability":"cards.cardholders","actions":["view"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view"],"constraints":{}},{"capability":"ctl.pbc","actions":["view"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","create"],"constraints":{}},{"capability":"exp.reports","actions":["view","create","edit"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"pay.batches","actions":["view","create","edit"],"constraints":{}},{"capability":"pay.checks","actions":["view","create","edit"],"constraints":{}},{"capability":"reports.financial","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit"],"constraints":{}},{"capability":"tax.1099","actions":["view"],"constraints":{}}]},
  {"key":"ar_clerk","name":"AR clerk","description":"Invoices out, cash in.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ar.collections","actions":["view","edit","release"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view","create"],"constraints":{}},{"capability":"ar.deposits","actions":["view","create"],"constraints":{}},{"capability":"ar.estimates","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"ar.invoices","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ar.statements","actions":["view","release"],"constraints":{}},{"capability":"ar.write_offs","actions":["view","create"],"constraints":{}},{"capability":"bank.transactions","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view"],"constraints":{}},{"capability":"ctl.pbc","actions":["view"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view","create","edit","post"],"constraints":{}},{"capability":"portal.customer","actions":["view","release"],"constraints":{}},{"capability":"reports.financial","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit","release"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}}]},
  {"key":"payments_clerk","name":"Check processor","description":"Queues, prints and files payments. Never approves or releases.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"pay.batches","actions":["view","create","edit","export"],"constraints":{}},{"capability":"pay.checks","actions":["view","create","edit"],"constraints":{}},{"capability":"reports.financial","actions":["view"],"constraints":{}}]},
  {"key":"data_entry","name":"Data entry","description":"Receipts, bills and master records.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","create"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","create"],"constraints":{}},{"capability":"exp.reports","actions":["view","create","edit"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit"],"constraints":{}}]},
  {"key":"hr_payroll","name":"HR / payroll","description":"Prepares payroll and maintains employees. Release only through a permission set.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"visible","tin":"reveal_logged","bank":"reveal_logged","personal":"visible"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.agents","actions":["view"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"cash.forecast","actions":["view"],"constraints":{}},{"capability":"cash.obligations","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view"],"constraints":{}},{"capability":"ctl.pbc","actions":["view"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view"],"constraints":{}},{"capability":"exp.reports","actions":["view"],"constraints":{}},{"capability":"fpa.budgets","actions":["view"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.api_keys","actions":["view"],"constraints":{}},{"capability":"int.connections","actions":["view"],"constraints":{}},{"capability":"int.mappings","actions":["view"],"constraints":{}},{"capability":"int.sync_runs","actions":["view"],"constraints":{}},{"capability":"payroll.employees","actions":["view","create","edit"],"constraints":{}},{"capability":"payroll.register","actions":["view","create","post"],"constraints":{}},{"capability":"payroll.remittances","actions":["view","create","release"],"constraints":{}},{"capability":"payroll.runs","actions":["view","create","edit"],"constraints":{}},{"capability":"payroll.settings","actions":["view","configure"],"constraints":{}},{"capability":"reports.financial","actions":["view"],"constraints":{}},{"capability":"tax.filings","actions":["view"],"constraints":{}}]},
  {"key":"department_head","name":"Department head","description":"Approves their own department's spend up to $5,000.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"grouped","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","approve"],"constraints":{"dimension_restriction":{"dimension":"department","values":"my_departments","mode":"edit_only","include_unassigned":false},"amount_limit":{"max_per_item_cents":500000}}},{"capability":"ap.purchase_orders","actions":["view","create","edit","delete","approve"],"constraints":{"dimension_restriction":{"dimension":"department","values":"my_departments","mode":"edit_only","include_unassigned":false},"amount_limit":{"max_per_item_cents":500000}}},{"capability":"exp.receipts","actions":["view","approve"],"constraints":{"dimension_restriction":{"dimension":"department","values":"my_departments","mode":"edit_only","include_unassigned":false},"amount_limit":{"max_per_item_cents":500000}}},{"capability":"exp.reports","actions":["view","approve"],"constraints":{"dimension_restriction":{"dimension":"department","values":"my_departments","mode":"edit_only","include_unassigned":false},"amount_limit":{"max_per_item_cents":500000}}},{"capability":"fpa.budgets","actions":["view","create","edit"],"constraints":{"dimension_restriction":{"dimension":"department","values":"my_departments","mode":"edit_only","include_unassigned":false}}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view"],"constraints":{"dimension_restriction":{"dimension":"department","values":"my_departments","mode":"view_and_edit"}}},{"capability":"req.client_requests","actions":["view","edit"],"constraints":{}}]},
  {"key":"employee","name":"Employee / cardholder","description":"Own card charges, receipts and expense reports only.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"any_grantor","grants":[{"capability":"cards.transactions","actions":["view"],"constraints":{"ownership":"own"}},{"capability":"docs.documents","actions":["view","create"],"constraints":{"ownership":"own"}},{"capability":"exp.receipts","actions":["view","create","edit","delete"],"constraints":{"ownership":"own"}},{"capability":"exp.reports","actions":["view","create","edit"],"constraints":{"ownership":"own"}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","edit"],"constraints":{"assigned_to_me":true}}]},
  {"key":"external_auditor","name":"External auditor","description":"Read, export and PBC on assigned clients for a fixed period.","audience":"external","default_scope":"assigned","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":120,"assignable_band":"managers","grants":[{"capability":"ap.bills","actions":["view","export"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view"],"constraints":{}},{"capability":"ar.collections","actions":["view"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view"],"constraints":{}},{"capability":"ar.deposits","actions":["view"],"constraints":{}},{"capability":"ar.estimates","actions":["view"],"constraints":{}},{"capability":"ar.invoices","actions":["view","export"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view"],"constraints":{}},{"capability":"bank.connections","actions":["view"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view","export"],"constraints":{}},{"capability":"bank.rules","actions":["view"],"constraints":{}},{"capability":"bank.statements","actions":["view"],"constraints":{}},{"capability":"bank.transactions","actions":["view","export"],"constraints":{}},{"capability":"bank.transfers","actions":["view"],"constraints":{}},{"capability":"cards.cardholders","actions":["view"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view","export"],"constraints":{}},{"capability":"cash.forecast","actions":["view"],"constraints":{}},{"capability":"cash.obligations","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view"],"constraints":{}},{"capability":"close.package","actions":["view","export"],"constraints":{}},{"capability":"consol.eliminations","actions":["view"],"constraints":{}},{"capability":"consol.groups","actions":["view"],"constraints":{}},{"capability":"consol.statements","actions":["view","export"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view","export"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view","export"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view"],"constraints":{}},{"capability":"ctl.pbc","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view"],"constraints":{}},{"capability":"debt.certificates","actions":["view"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view"],"constraints":{}},{"capability":"exp.reports","actions":["view"],"constraints":{}},{"capability":"fa.assets","actions":["view"],"constraints":{}},{"capability":"fa.leases","actions":["view"],"constraints":{}},{"capability":"fa.prepaids","actions":["view"],"constraints":{}},{"capability":"fpa.budgets","actions":["view","export"],"constraints":{}},{"capability":"fpa.profitability","actions":["view","export"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view"],"constraints":{}},{"capability":"gl.accounts","actions":["view","export"],"constraints":{}},{"capability":"gl.dimensions","actions":["view"],"constraints":{}},{"capability":"gl.intercompany","actions":["view"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","export"],"constraints":{}},{"capability":"gl.periods","actions":["view"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view"],"constraints":{}},{"capability":"gl.year_end","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view"],"constraints":{}},{"capability":"inv.movements","actions":["view"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view","export"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"pay.batches","actions":["view","export"],"constraints":{}},{"capability":"pay.checks","actions":["view"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view"],"constraints":{}},{"capability":"pay.refunds","actions":["view"],"constraints":{}},{"capability":"payroll.employees","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"payroll.remittances","actions":["view"],"constraints":{}},{"capability":"payroll.runs","actions":["view"],"constraints":{}},{"capability":"payroll.settings","actions":["view"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view","export"],"constraints":{}},{"capability":"tax.1099","actions":["view","export"],"constraints":{}},{"capability":"tax.filings","actions":["view"],"constraints":{}},{"capability":"tax.provision","actions":["view"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view"],"constraints":{}}]},
  {"key":"lender_viewer","name":"Lender viewer","description":"Sees only certificates and packs delivered to them.","audience":"external","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":365,"assignable_band":"managers","grants":[{"capability":"debt.borrowing_base","actions":["view"],"constraints":{"delivered_to_me":true}},{"capability":"debt.certificates","actions":["view"],"constraints":{"delivered_to_me":true}},{"capability":"home.portal","actions":["view"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{"delivered_to_me":true}},{"capability":"reports.packs","actions":["view"],"constraints":{"delivered_to_me":true}},{"capability":"req.client_requests","actions":["view","edit"],"constraints":{"assigned_to_me":true}}]},
  {"key":"view_only","name":"View-only","description":"Read-only books, no export.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ap.bills","actions":["view"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view"],"constraints":{}},{"capability":"ar.collections","actions":["view"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view"],"constraints":{}},{"capability":"ar.deposits","actions":["view"],"constraints":{}},{"capability":"ar.estimates","actions":["view"],"constraints":{}},{"capability":"ar.invoices","actions":["view"],"constraints":{}},{"capability":"ar.payment_links","actions":["view"],"constraints":{}},{"capability":"ar.recurring","actions":["view"],"constraints":{}},{"capability":"ar.statements","actions":["view"],"constraints":{}},{"capability":"ar.write_offs","actions":["view"],"constraints":{}},{"capability":"bank.connections","actions":["view"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view"],"constraints":{}},{"capability":"bank.rules","actions":["view"],"constraints":{}},{"capability":"bank.statements","actions":["view"],"constraints":{}},{"capability":"bank.transactions","actions":["view"],"constraints":{}},{"capability":"bank.transfers","actions":["view"],"constraints":{}},{"capability":"cards.cardholders","actions":["view"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view"],"constraints":{}},{"capability":"cash.forecast","actions":["view"],"constraints":{}},{"capability":"cash.obligations","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view"],"constraints":{}},{"capability":"close.package","actions":["view"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view"],"constraints":{}},{"capability":"ctl.compliance","actions":["view"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view"],"constraints":{}},{"capability":"ctl.pbc","actions":["view"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view"],"constraints":{}},{"capability":"debt.certificates","actions":["view"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view"],"constraints":{}},{"capability":"exp.reports","actions":["view"],"constraints":{}},{"capability":"fa.assets","actions":["view"],"constraints":{}},{"capability":"fa.leases","actions":["view"],"constraints":{}},{"capability":"fa.prepaids","actions":["view"],"constraints":{}},{"capability":"fpa.budgets","actions":["view"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view"],"constraints":{}},{"capability":"gl.accounts","actions":["view"],"constraints":{}},{"capability":"gl.dimensions","actions":["view"],"constraints":{}},{"capability":"gl.intercompany","actions":["view"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view"],"constraints":{}},{"capability":"gl.periods","actions":["view"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view"],"constraints":{}},{"capability":"gl.year_end","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"inv.items","actions":["view"],"constraints":{}},{"capability":"inv.movements","actions":["view"],"constraints":{}},{"capability":"inv.valuation","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view"],"constraints":{}},{"capability":"mdm.items","actions":["view"],"constraints":{}},{"capability":"mdm.vendors","actions":["view"],"constraints":{}},{"capability":"pay.batches","actions":["view"],"constraints":{}},{"capability":"pay.checks","actions":["view"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view"],"constraints":{}},{"capability":"pay.refunds","actions":["view"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view"],"constraints":{}},{"capability":"reports.packs","actions":["view"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"revrec.methods","actions":["view"],"constraints":{}},{"capability":"revrec.runs","actions":["view"],"constraints":{}},{"capability":"revrec.schedules","actions":["view"],"constraints":{}},{"capability":"tax.1099","actions":["view"],"constraints":{}},{"capability":"tax.filings","actions":["view"],"constraints":{}},{"capability":"tax.provision","actions":["view"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view"],"constraints":{}}]},
  {"key":"client_admin","name":"Client admin","description":"Manages the client's own staff and roles inside the client envelope.","audience":"client_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"ap.policy","actions":["view"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view","create","approve"],"constraints":{}},{"capability":"ar.estimates","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"ar.invoices","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"bank.transactions","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view"],"constraints":{}},{"capability":"cash.forecast","actions":["view"],"constraints":{}},{"capability":"cash.obligations","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"core.access.assignments","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"core.access.members","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"core.access.roles","actions":["view","create","edit","delete","configure"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","create","approve"],"constraints":{}},{"capability":"exp.reports","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"fpa.budgets","actions":["view"],"constraints":{}},{"capability":"fpa.profitability","actions":["view"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit"],"constraints":{}}]},
  {"key":"client_contact","name":"Client contact","description":"Answers requests and uploads documents. Never the ledger.","audience":"external","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"any_grantor","grants":[{"capability":"docs.documents","actions":["view","create"],"constraints":{"ownership":"own"}},{"capability":"home.portal","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","edit"],"constraints":{"assigned_to_me":true}}]}
]$seed$::jsonb);
-- END GENERATED role_templates

-- Data step (b)–(e) for every existing tenant.
do $$
declare o record;
begin
  for o in select id from core.organizations loop
    perform core.rbac_import_tenant_roles(o.id);
  end loop;
end $$;
