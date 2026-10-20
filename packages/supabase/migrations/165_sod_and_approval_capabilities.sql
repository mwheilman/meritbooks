-- =============================================================================
-- Migration 165: separation of duties (05-RBAC-SPEC §4.1 H1/H6, §4.3, R-8) +
--                approval workflows on capability (§3.4, R-12) — wave 2C
-- =============================================================================
-- core.organizations
--   + sole_approver_mode boolean      (Q1) approver may also release. Default OFF.
--   + je_self_post_threshold_cents    (Q4) manual JEs at/above this are posted by
--                                     someone other than the preparer. Default $25,000.
--
-- core.sod_rules            the conflict-rule catalog. org_id null = PLATFORM rule
--   id, org_id, key, rule_type (role | transaction), name, description (one plain
--   sentence — the UI never shows `key`), suggested_fix, conflict jsonb (role rules:
--   an array of LEGS, each an array of 'capability:action' alternatives, '*:action' =
--   any capability with that action; the rule fires when EVERY leg is held in the same
--   person's effective set on the same client), enforcement (soft | hard | txn_only),
--   tenant_type_override jsonb ({"firm":"hard"} — tighten-only), platform_locked
--   (a 05 §4.1 hard rule — "always on", never excepted), status (active | disabled),
--   created_by, created_at, updated_at.
--   PLATFORM rows are immutable to everyone but core.sod_seed_platform_rules() — a
--   tenant can never disable, demote or edit one. Tenants add their OWN role rules
--   (org_id set) and may disable / re-enable those.
-- core.sod_rule_settings    tenant promotion of a platform soft rule → hard (05 §4.3:
--   "A tenant may promote soft → hard. Only the platform can demote.")
-- core.sod_exceptions       "allowed conflicts": approved, time-boxed (≤ 1 year),
--   justification + optional compensating control; approver ≠ grantee and grantor ≠
--   grantee (H1); never for a hard / platform-locked / transaction rule; immutable
--   except a one-time revocation. Referenced by access_assignments.sod_exception_ids
--   (validated by trigger: same tenant, same membership).
--
-- core.sod_effective_grants(membership, location)  the effective 'cap:action' set on a
--   client (roles + permission sets − mutes − read-only; tenant-scoped grants count
--   everywhere). Ceilings/envelopes only REMOVE grants, so ignoring them can only
--   over-detect a conflict — never miss one.
-- core.sod_conflicts_for_membership(membership)    every role-rule conflict, per client,
--   with its effective enforcement and any active allowed-conflict exception.
-- core.sod_effective_enforcement(org, rule)       base ⊕ tenant-type override ⊕ tenant
--   promotion (strictest wins).
--
-- H6 in the DB (05 §4.1 + IA Q5 "money-release SoD stays DB-enforced regardless"):
--   public.approvals gains a release guard — released_by <> prepared_by ALWAYS, and
--   released_by <> approved_by unless the tenant is in sole-approver mode.
--
-- R-12 approval workflows on capability:
--   public.approval_workflow_steps + approver_capability ('ap.bills:approve'),
--   min_approver_limit_cents (the approver's own approval limit must be ≥ this; null =
--   any holder), approver_client_set_id (optional). approver_role becomes NULLABLE
--   (compat for one release): a step with approver_role set keeps today's role-rank
--   routing EXACTLY; a step with approver_role null routes on capability + floor.
--   Backfill: every existing step gets the capability its doc type approves on (the
--   05 §2.3 legacy map: bills → ap.bills, JEs → gl.journal_entries, payments →
--   pay.batches, expenses → exp.reports, payroll → payroll.runs) — informational
--   until R-14 drops approver_role, so configured workflows route identically.
--   public.approval_requests + location_id (the client the document belongs to; the
--   capability check runs in that client's context).
--
-- RLS on every new table: members READ their tenant's rows (+ platform rules); writes
-- service_role only (the app writes via the admin client after a permission check).
-- ADDITIVE + IDEMPOTENT + PGlite-compatible. Apply to Supabase FIRST.
-- =============================================================================

-- ── tenant SoD settings (Q1, Q4) ─────────────────────────────────────────────
alter table core.organizations add column if not exists sole_approver_mode boolean not null default false;
alter table core.organizations add column if not exists je_self_post_threshold_cents bigint not null default 2500000;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_je_self_post_threshold_chk') then
    alter table core.organizations add constraint organizations_je_self_post_threshold_chk
      check (je_self_post_threshold_cents >= 0);
  end if;
end $$;
comment on column core.organizations.sole_approver_mode is
  '05 Q1: when true the approver of a payment may also release it (preparer still never may). Off by default.';
comment on column core.organizations.je_self_post_threshold_cents is
  '05 Q4: manual journal entries at or above this amount (bigint cents) must be posted by someone other than the preparer.';

-- ── conflict validation ──────────────────────────────────────────────────────
-- A role-rule conflict is a JSON array of ≥ 2 legs; each leg a non-empty array of
-- 'capability:action' strings ('*:action' = any capability with that action).
create or replace function core.sod_valid_conflict(p jsonb) returns boolean
  language sql immutable as
$$
  select p is not null and jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) >= 2
     and not exists (
       select 1 from jsonb_array_elements(p) leg
        where jsonb_typeof(leg) <> 'array' or jsonb_array_length(leg) = 0
           or exists (select 1 from jsonb_array_elements(leg) alt
                       where jsonb_typeof(alt) <> 'string'
                          or (alt #>> '{}') !~ '^(\*|[a-z0-9_]+(\.[a-z0-9_]+)+):(view|create|edit|delete|approve|post|release|export|configure)$'))
$$;

-- Tenant-type override: {"firm"|"company": "soft"|"hard"}.
create or replace function core.sod_valid_override(p jsonb) returns boolean
  language sql immutable as
$$
  select p is not null and jsonb_typeof(p) = 'object'
     and not exists (select 1 from jsonb_each_text(p) o
                      where o.key not in ('firm', 'company') or o.value not in ('soft', 'hard'))
$$;

-- ── core.sod_rules ───────────────────────────────────────────────────────────
create table if not exists core.sod_rules (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid references core.organizations(id) on delete cascade,
  key                  text not null,
  rule_type            text not null default 'role',
  name                 text not null,
  description          text not null,
  suggested_fix        text,
  conflict             jsonb not null default '[]'::jsonb,
  enforcement          text not null default 'soft',
  tenant_type_override jsonb not null default '{}'::jsonb,
  platform_locked      boolean not null default false,
  status               text not null default 'active',
  sort_order           int not null default 100,
  created_by           uuid references core.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint sod_rules_key_chk check (key ~ '^[A-Za-z0-9_]+$'),
  constraint sod_rules_type_chk check (rule_type in ('role', 'transaction')),
  constraint sod_rules_name_chk check (length(btrim(name)) > 0),
  constraint sod_rules_description_chk check (length(btrim(description)) > 0),
  constraint sod_rules_enforcement_chk check (enforcement in ('soft', 'hard', 'txn_only')),
  constraint sod_rules_status_chk check (status in ('active', 'disabled')),
  constraint sod_rules_conflict_chk check (
       (rule_type = 'role' and core.sod_valid_conflict(conflict))
    or (rule_type = 'transaction' and conflict = '[]'::jsonb)),
  constraint sod_rules_override_chk check (core.sod_valid_override(tenant_type_override)),
  constraint sod_rules_locked_chk check (not platform_locked or org_id is null),
  constraint sod_rules_tenant_shape_chk check (
    org_id is null or (rule_type = 'role' and enforcement in ('soft', 'hard') and tenant_type_override = '{}'::jsonb))
);
create unique index if not exists uq_sod_rules_platform_key on core.sod_rules (key) where org_id is null;
create unique index if not exists uq_sod_rules_tenant_key   on core.sod_rules (org_id, key) where org_id is not null;
create index if not exists idx_sod_rules_org on core.sod_rules (org_id);
comment on table core.sod_rules is
  '05 R-8: separation-of-duties rule catalog. org_id null = platform rule (immutable to tenants). Codes are internal; the UI shows description + suggested_fix only.';

-- Platform rows change ONLY inside core.sod_seed_platform_rules (which sets a local GUC).
-- Tenant rows: capabilities in the conflict must exist in the catalog.
create or replace function core.sod_rules_guard() returns trigger
  language plpgsql as
$$
declare v_row core.sod_rules%rowtype; alt text;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if (v_row.org_id is null or (tg_op = 'UPDATE' and old.org_id is null))
     and coalesce(current_setting('meritbooks.sod_platform_maintenance', true), '') <> 'on' then
    raise exception 'platform conflict rules can only be changed by the platform'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise exception 'a conflict rule cannot move between tenants' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.rule_type = 'role' then
    for alt in select jsonb_array_elements_text(leg) from jsonb_array_elements(new.conflict) leg loop
      if split_part(alt, ':', 1) <> '*'
         and not core.capability_has_action(split_part(alt, ':', 1), split_part(alt, ':', 2)) then
        raise exception 'conflict rule references unknown capability %', alt using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists trg_sod_rules_guard on core.sod_rules;
create trigger trg_sod_rules_guard before insert or update or delete on core.sod_rules
  for each row execute function core.sod_rules_guard();

-- Seed / refresh platform rules from JSON (idempotent upsert by key; never deletes).
create or replace function core.sod_seed_platform_rules(p_rules jsonb) returns integer
  language plpgsql as
$$
declare n integer := 0; r jsonb;
begin
  perform set_config('meritbooks.sod_platform_maintenance', 'on', true);
  for r in select * from jsonb_array_elements(p_rules) loop
    insert into core.sod_rules as s
      (org_id, key, rule_type, name, description, suggested_fix, conflict, enforcement,
       tenant_type_override, platform_locked, status, sort_order)
    values (null, r->>'key', r->>'rule_type', r->>'name', r->>'description', r->>'suggested_fix',
            coalesce(r->'conflict', '[]'::jsonb), r->>'enforcement',
            coalesce(r->'tenant_type_override', '{}'::jsonb),
            coalesce((r->>'platform_locked')::boolean, false), 'active',
            coalesce((r->>'sort_order')::int, 100))
    on conflict (key) where org_id is null do update set
      rule_type = excluded.rule_type, name = excluded.name, description = excluded.description,
      suggested_fix = excluded.suggested_fix, conflict = excluded.conflict,
      enforcement = excluded.enforcement, tenant_type_override = excluded.tenant_type_override,
      platform_locked = excluded.platform_locked, status = 'active', sort_order = excluded.sort_order
    where (s.rule_type, s.name, s.description, s.suggested_fix, s.conflict, s.enforcement,
           s.tenant_type_override, s.platform_locked, s.status, s.sort_order)
      is distinct from
          (excluded.rule_type, excluded.name, excluded.description, excluded.suggested_fix,
           excluded.conflict, excluded.enforcement, excluded.tenant_type_override,
           excluded.platform_locked, 'active', excluded.sort_order);
    n := n + 1;
  end loop;
  perform set_config('meritbooks.sod_platform_maintenance', 'off', true);
  return n;
end
$$;

-- ── core.sod_rule_settings (tenant promotion soft → hard) ────────────────────
create table if not exists core.sod_rule_settings (
  org_id      uuid not null references core.organizations(id) on delete cascade,
  rule_id     uuid not null references core.sod_rules(id) on delete cascade,
  enforcement text not null default 'hard' check (enforcement = 'hard'),
  updated_by  uuid references core.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (org_id, rule_id)
);
comment on table core.sod_rule_settings is
  '05 §4.3: a tenant may promote a platform soft rule to hard (blocks instead of warning). Only the platform can demote.';

create or replace function core.sod_rule_settings_guard() returns trigger
  language plpgsql as
$$
declare r core.sod_rules%rowtype;
begin
  select * into r from core.sod_rules where id = new.rule_id;
  if r.id is null or r.org_id is not null then
    raise exception 'only platform conflict rules take a tenant setting (edit a tenant rule directly)'
      using errcode = 'check_violation';
  end if;
  if r.rule_type <> 'role' or r.enforcement = 'txn_only' or r.platform_locked then
    raise exception 'this conflict rule is checked on every transaction and cannot be changed'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists trg_sod_rule_settings_guard on core.sod_rule_settings;
create trigger trg_sod_rule_settings_guard before insert or update on core.sod_rule_settings
  for each row execute function core.sod_rule_settings_guard();

-- Effective enforcement for a tenant: strictest of base, tenant-type override, promotion.
create or replace function core.sod_effective_enforcement(p_org uuid, p_rule_id uuid) returns text
  language sql stable as
$$
  select case
           when r.enforcement in ('hard', 'txn_only') then r.enforcement
           when r.tenant_type_override ->> o.tenant_type = 'hard' then 'hard'
           when exists (select 1 from core.sod_rule_settings s
                         where s.org_id = p_org and s.rule_id = r.id and s.enforcement = 'hard') then 'hard'
           else r.enforcement
         end
    from core.sod_rules r
    left join core.organizations o on o.id = p_org
   where r.id = p_rule_id
$$;

-- ── core.sod_exceptions ("allowed conflicts") ────────────────────────────────
create table if not exists core.sod_exceptions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  rule_id              uuid not null references core.sod_rules(id) on delete restrict,
  rule_key             text not null,
  membership_id        uuid not null references core.memberships(id) on delete cascade,
  location_id          uuid references core.locations(id) on delete cascade,
  justification        text not null,
  compensating_control text,
  granted_by           uuid references core.users(id) on delete set null,
  approved_by          uuid not null references core.users(id) on delete restrict,
  approved_at          timestamptz not null default now(),
  expires_at           timestamptz not null default (now() + interval '1 year'),
  revoked_at           timestamptz,
  revoked_by           uuid references core.users(id) on delete set null,
  revoke_reason        text,
  created_at           timestamptz not null default now(),
  constraint sod_exceptions_justification_chk check (length(btrim(justification)) >= 10),
  constraint sod_exceptions_window_chk check (
    expires_at > approved_at and expires_at <= approved_at + interval '1 year' + interval '1 day'),
  constraint sod_exceptions_revoke_chk check ((revoked_at is null) = (revoked_by is null))
);
create index if not exists idx_sod_exceptions_membership on core.sod_exceptions (membership_id, rule_id);
create index if not exists idx_sod_exceptions_org on core.sod_exceptions (org_id, expires_at);
comment on table core.sod_exceptions is
  '05 R-8: allowed conflicts — approved, time-boxed (≤ 1 year) SoD exceptions with a reason. Approver ≠ grantee (H1). Shown in every access review until removed.';

create or replace function core.sod_exceptions_guard() returns trigger
  language plpgsql as
$$
declare m record; r core.sod_rules%rowtype; v_enf text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'allowed conflicts are never deleted — revoke instead' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- Only a one-time revocation may change a row.
    if old.revoked_at is not null then
      raise exception 'a revoked allowed conflict is final' using errcode = 'check_violation';
    end if;
    if (new.id, new.org_id, new.rule_id, new.rule_key, new.membership_id, new.location_id, new.justification,
        new.compensating_control, new.granted_by, new.approved_by, new.approved_at, new.expires_at, new.created_at)
       is distinct from
       (old.id, old.org_id, old.rule_id, old.rule_key, old.membership_id, old.location_id, old.justification,
        old.compensating_control, old.granted_by, old.approved_by, old.approved_at, old.expires_at, old.created_at) then
      raise exception 'an allowed conflict is immutable; revoke it and grant a new one' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select ms.id, ms.org_id, ms.user_id into m from core.memberships ms where ms.id = new.membership_id;
  if m.id is null or m.org_id <> new.org_id then
    raise exception 'membership % is not a seat in tenant %', new.membership_id, new.org_id using errcode = 'check_violation';
  end if;
  select * into r from core.sod_rules where id = new.rule_id;
  if r.id is null or (r.org_id is not null and r.org_id <> new.org_id) then
    raise exception 'conflict rule % is not available to tenant %', new.rule_id, new.org_id using errcode = 'check_violation';
  end if;
  new.rule_key := r.key;
  if r.rule_type <> 'role' or r.platform_locked then
    raise exception 'this conflict is always blocked and cannot be allowed' using errcode = 'check_violation';
  end if;
  v_enf := core.sod_effective_enforcement(new.org_id, r.id);
  if v_enf <> 'soft' then
    raise exception 'this conflict rule blocks the combination outright; an allowed conflict is not possible'
      using errcode = 'check_violation';
  end if;
  if new.location_id is not null and not exists (
       select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'location % is not a client of tenant %', new.location_id, new.org_id using errcode = 'check_violation';
  end if;
  -- H1: nobody allows their own conflict.
  if new.approved_by = m.user_id or new.granted_by = m.user_id then
    raise exception 'H1: nobody may allow a conflict on their own access' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_sod_exceptions_guard on core.sod_exceptions;
create trigger trg_sod_exceptions_guard before insert or update or delete on core.sod_exceptions
  for each row execute function core.sod_exceptions_guard();

-- access_assignments.sod_exception_ids must point at this membership's exceptions.
create or replace function core.sod_assignment_exceptions_guard() returns trigger
  language plpgsql as
$$
begin
  if cardinality(new.sod_exception_ids) > 0 and exists (
       select 1 from unnest(new.sod_exception_ids) x(id)
        where not exists (select 1 from core.sod_exceptions e
                           where e.id = x.id and e.org_id = new.org_id and e.membership_id = new.membership_id)) then
    raise exception 'sod_exception_ids must reference this member''s allowed conflicts' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_access_assignments_sod_exceptions on core.access_assignments;
create trigger trg_access_assignments_sod_exceptions before insert or update of sod_exception_ids on core.access_assignments
  for each row execute function core.sod_assignment_exceptions_guard();

-- ── effective set + conflict detection ───────────────────────────────────────
-- Effective 'capability:action' set of a membership on one client (null = tenant-level
-- context). Tenant-scoped assignments count everywhere (access admin is tenant-wide).
create or replace function core.sod_effective_grants(p_membership_id uuid, p_location_id uuid)
returns table (capability text, action text)
language sql stable as
$$
  with m as (
    select id from core.memberships where id = p_membership_id and status = 'active'
  ), a as (
    select aa.id, aa.role_id, aa.permission_set_id, aa.read_only, aa.muted
      from core.access_assignments aa join m on m.id = aa.membership_id
     where aa.status = 'active'
       and aa.effective_from <= now()
       and (aa.effective_to is null or aa.effective_to > now())
       and (aa.scope_type in ('all_clients', 'tenant')
            or (aa.scope_type = 'client' and aa.location_id = p_location_id)
            or (aa.scope_type = 'client_set' and exists (
                  select 1 from core.client_set_members csm
                   where csm.set_id = aa.client_set_id and csm.location_id = p_location_id)))
  ), g as (
    select a.read_only, a.muted, rg.capability, unnest(rg.actions) as action
      from a
      join core.role_versions rv on rv.role_id = a.role_id and rv.state = 'published'
      join core.role_grants rg on rg.role_version_id = rv.id
    union all
    select a.read_only, a.muted, pg.capability, unnest(pg.actions) as action
      from a
      join core.permission_set_versions pv on pv.permission_set_id = a.permission_set_id and pv.state = 'published'
      join core.permission_set_grants pg on pg.permission_set_version_id = pv.id
  )
  select distinct g.capability, g.action
    from g
   where not (g.read_only and g.action not in ('view', 'export'))
     and not coalesce((g.muted -> g.capability) ? g.action, false)
$$;

create or replace function core.sod_conflicts_for_membership(p_membership_id uuid)
returns table (
  rule_id uuid, rule_key text, rule_name text, description text, suggested_fix text,
  enforcement text, location_id uuid, matched text[],
  exception_id uuid, exception_expires_at timestamptz
)
language plpgsql stable as
$$
#variable_conflict use_column
declare
  v_org uuid; v_loc uuid; v_locs uuid[]; v_set text[]; r core.sod_rules%rowtype;
  leg jsonb; v_hit text; v_ok boolean; v_matched text[];
begin
  select org_id into v_org from core.memberships where id = p_membership_id and status = 'active';
  if v_org is null then return; end if;

  -- Client contexts this person can act on.
  if exists (select 1 from core.access_assignments aa
              where aa.membership_id = p_membership_id and aa.status = 'active' and aa.scope_type = 'all_clients'
                and aa.effective_from <= now() and (aa.effective_to is null or aa.effective_to > now())) then
    select array_agg(l.id order by l.id) into v_locs from core.locations l where l.org_id = v_org;
  else
    select array_agg(distinct x.loc) into v_locs from (
      select aa.location_id as loc from core.access_assignments aa
       where aa.membership_id = p_membership_id and aa.status = 'active' and aa.scope_type = 'client'
         and aa.effective_from <= now() and (aa.effective_to is null or aa.effective_to > now())
      union
      select csm.location_id from core.access_assignments aa
        join core.client_set_members csm on csm.set_id = aa.client_set_id
       where aa.membership_id = p_membership_id and aa.status = 'active' and aa.scope_type = 'client_set'
         and aa.effective_from <= now() and (aa.effective_to is null or aa.effective_to > now())
    ) x where x.loc is not null;
  end if;
  if v_locs is null or cardinality(v_locs) = 0 then v_locs := array[null::uuid]; end if;

  foreach v_loc in array v_locs loop
    select coalesce(array_agg(g.capability || ':' || g.action), '{}') into v_set
      from core.sod_effective_grants(p_membership_id, v_loc) g;
    if cardinality(v_set) = 0 then continue; end if;
    for r in select * from core.sod_rules sr
              where sr.rule_type = 'role' and sr.status = 'active'
                and (sr.org_id is null or sr.org_id = v_org)
              order by sr.sort_order, sr.key loop
      v_ok := true; v_matched := '{}';
      for leg in select value from jsonb_array_elements(r.conflict) loop
        select s into v_hit
          from jsonb_array_elements_text(leg) alt
          join unnest(v_set) s
            on s = alt or (split_part(alt, ':', 1) = '*' and split_part(s, ':', 2) = split_part(alt, ':', 2))
         order by s limit 1;
        if v_hit is null then v_ok := false; exit; end if;
        v_matched := v_matched || v_hit;
      end loop;
      if not v_ok then continue; end if;
      rule_id := r.id; rule_key := r.key; rule_name := r.name; description := r.description;
      suggested_fix := r.suggested_fix; enforcement := core.sod_effective_enforcement(v_org, r.id);
      location_id := v_loc; matched := v_matched;
      exception_id := null; exception_expires_at := null;
      select e.id, e.expires_at into exception_id, exception_expires_at
        from core.sod_exceptions e
       where e.membership_id = p_membership_id and e.rule_id = r.id
         and e.revoked_at is null and e.expires_at > now()
         and (e.location_id is null or e.location_id is not distinct from v_loc)
       order by e.expires_at desc limit 1;
      return next;
    end loop;
  end loop;
end
$$;

-- ── H6 in the DB: release guard on the money-approval primitive (mig 042) ────
create or replace function public.approvals_release_sod_guard() returns trigger
  language plpgsql security definer set search_path = public, core, pg_temp as
$$
declare v_sole boolean;
begin
  if new.released_by is null then return new; end if;
  if tg_op = 'UPDATE' and new.released_by is not distinct from old.released_by
     and new.approved_by is not distinct from old.approved_by then
    return new;
  end if;
  if new.released_by = new.prepared_by then
    raise exception 'Separation of duties: the person who prepared this payment cannot release it.'
      using errcode = 'check_violation';
  end if;
  if new.approved_by is not null and new.released_by = new.approved_by then
    select o.sole_approver_mode into v_sole from core.organizations o where o.id = new.org_id;
    if not coalesce(v_sole, false) then
      raise exception 'Separation of duties: the person who approved this payment cannot also release it.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
do $$ begin
  if to_regclass('public.approvals') is not null then
    drop trigger if exists trg_approvals_release_sod on public.approvals;
    create trigger trg_approvals_release_sod before insert or update of released_by, approved_by on public.approvals
      for each row execute function public.approvals_release_sod_guard();
  end if;
end $$;

-- ── R-12: approval workflow steps on capability + dollar floor ───────────────
alter table public.approval_workflow_steps add column if not exists approver_capability text;
alter table public.approval_workflow_steps add column if not exists min_approver_limit_cents bigint;
alter table public.approval_workflow_steps add column if not exists approver_client_set_id uuid;
alter table public.approval_workflow_steps alter column approver_role drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'approval_workflow_steps_client_set_fkey') then
    alter table public.approval_workflow_steps add constraint approval_workflow_steps_client_set_fkey
      foreign key (approver_client_set_id) references core.client_sets(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_workflow_steps_capability_fmt') then
    alter table public.approval_workflow_steps add constraint approval_workflow_steps_capability_fmt
      check (approver_capability is null
             or approver_capability ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+:(approve|post|release)$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_workflow_steps_floor_chk') then
    alter table public.approval_workflow_steps add constraint approval_workflow_steps_floor_chk
      check (min_approver_limit_cents is null or min_approver_limit_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_workflow_steps_approver_chk') then
    alter table public.approval_workflow_steps add constraint approval_workflow_steps_approver_chk
      check (approver_role is not null or approver_capability is not null);
  end if;
end $$;
comment on column public.approval_workflow_steps.approver_capability is
  '05 R-12: capability an approver must hold (e.g. ap.bills:approve). Routes the step when approver_role is null.';
comment on column public.approval_workflow_steps.min_approver_limit_cents is
  '05 §3.4: the approver''s own approval limit must be at least this (bigint cents). Null = any holder of the capability.';
comment on column public.approval_workflow_steps.approver_role is
  'COMPAT (one release, 05 R-12): legacy role-rank routing. When set, routing is unchanged; null = capability routing.';

-- The capability must exist in the catalog with that action.
create or replace function public.approval_workflow_steps_capability_guard() returns trigger
  language plpgsql as
$$
begin
  if new.approver_capability is not null
     and not core.capability_has_action(split_part(new.approver_capability, ':', 1), split_part(new.approver_capability, ':', 2)) then
    raise exception 'unknown approver capability %', new.approver_capability using errcode = 'check_violation';
  end if;
  if new.approver_client_set_id is not null and not exists (
       select 1 from core.client_sets s where s.id = new.approver_client_set_id and s.org_id = new.org_id) then
    raise exception 'approver client set is not in this tenant' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_approval_workflow_steps_capability on public.approval_workflow_steps;
create trigger trg_approval_workflow_steps_capability before insert or update on public.approval_workflow_steps
  for each row execute function public.approval_workflow_steps_capability_guard();

-- Backfill: the capability each doc type approves on (05 §2.3 map). Informational while
-- approver_role is set — routing stays role-based for every existing step.
update public.approval_workflow_steps s
   set approver_capability = case w.doc_type
         when 'BILL'          then 'ap.bills:approve'
         when 'JOURNAL_ENTRY' then 'gl.journal_entries:approve'
         when 'PAYMENT'       then 'pay.batches:approve'
         when 'EXPENSE'       then 'exp.reports:approve'
         when 'PAYROLL'       then 'payroll.runs:approve'
       end
  from public.approval_workflows w
 where w.id = s.workflow_id and s.approver_capability is null;

alter table public.approval_requests add column if not exists location_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_location_fkey') then
    alter table public.approval_requests add constraint approval_requests_location_fkey
      foreign key (location_id) references core.locations(id) on delete set null;
  end if;
end $$;
comment on column public.approval_requests.location_id is
  '05 R-12: the client the document belongs to — capability-routed steps check the approver''s grant on this client.';

-- ── function privileges (M1 lesson: revoke from everyone, re-grant service_role) ─
revoke all on function core.sod_seed_platform_rules(jsonb) from public, anon, authenticated;
grant execute on function core.sod_seed_platform_rules(jsonb) to service_role;
revoke all on function core.sod_effective_grants(uuid, uuid) from public, anon, authenticated;
grant execute on function core.sod_effective_grants(uuid, uuid) to service_role;
revoke all on function core.sod_conflicts_for_membership(uuid) from public, anon, authenticated;
grant execute on function core.sod_conflicts_for_membership(uuid) to service_role;
revoke all on function core.sod_effective_enforcement(uuid, uuid) from public, anon, authenticated;
grant execute on function core.sod_effective_enforcement(uuid, uuid) to service_role, authenticated;
revoke all on function public.approvals_release_sod_guard() from public, anon, authenticated;
grant execute on function public.approvals_release_sod_guard() to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['sod_rules', 'sod_rule_settings', 'sod_exceptions'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('drop policy if exists member_read on core.%I', t);
    execute format('drop policy if exists service_all on core.%I', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select on table core.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;
create policy member_read on core.sod_rules for select to authenticated
  using (org_id is null or org_id = public.get_org_id());
create policy member_read on core.sod_rule_settings for select to authenticated
  using (org_id = public.get_org_id());
create policy member_read on core.sod_exceptions for select to authenticated
  using (org_id = public.get_org_id());

-- ── platform rule seed (05 §4.1 H1/H6 + §4.3 S1–S9) ──────────────────────────
-- Codes stay internal. Text is what the UI shows.
select core.sod_seed_platform_rules($seed$[
  {"key":"H6_PREPARER_APPROVER","rule_type":"transaction","enforcement":"hard","platform_locked":true,"sort_order":1,
   "name":"Preparer can't approve",
   "description":"The person who prepares a bill, payment, journal entry or payroll run can never approve it.",
   "suggested_fix":"Route the item to someone else to approve."},
  {"key":"H6_PREPARER_RELEASER","rule_type":"transaction","enforcement":"hard","platform_locked":true,"sort_order":2,
   "name":"Preparer can't release",
   "description":"The person who prepares a payment can never release the money.",
   "suggested_fix":"Have a second person release the payment."},
  {"key":"H6_APPROVER_RELEASER","rule_type":"transaction","enforcement":"hard","platform_locked":true,"sort_order":3,
   "name":"Approver can't release",
   "description":"The person who approves a payment can't also release it, unless one-person approval is turned on.",
   "suggested_fix":"Have a different person release approved payments."},
  {"key":"H6_JE_SELF_POST","rule_type":"transaction","enforcement":"hard","platform_locked":true,"sort_order":4,
   "name":"Large journal entries need a second person",
   "description":"Journal entries at or above the self-post amount must be posted by someone other than the person who prepared them.",
   "suggested_fix":"Ask a reviewer to post the entry."},
  {"key":"H6_BANK_CHANGE_RELEASE","rule_type":"transaction","enforcement":"hard","platform_locked":true,"sort_order":5,
   "name":"No paying an account you just changed",
   "description":"Nobody can release a payment to a vendor whose bank details they changed or approved in the last 10 days.",
   "suggested_fix":"Have someone else release payments to that vendor."},
  {"key":"H1_SELF_ADMIN","rule_type":"transaction","enforcement":"hard","platform_locked":true,"sort_order":6,
   "name":"No granting yourself access",
   "description":"Nobody can grant, extend or approve their own access, limits or allowed conflicts.",
   "suggested_fix":"Ask another admin to make the change."},
  {"key":"S1","rule_type":"role","enforcement":"soft","sort_order":10,
   "conflict":[["pay.batches:create"],["pay.batches:approve"],["pay.batches:release"]],
   "name":"Whole payment run in one person",
   "description":"Could prepare, approve and release the same payment run alone.",
   "suggested_fix":"Remove one of the three steps, or require a second person on releases over $10,000."},
  {"key":"S2","rule_type":"role","enforcement":"soft","tenant_type_override":{"firm":"hard"},"sort_order":11,
   "conflict":[["pay.vendor_bank_details:edit"],["pay.batches:release"]],
   "name":"Change bank details and pay",
   "description":"Could change a vendor's bank details and then release payments to that account.",
   "suggested_fix":"Remove bank-detail editing from people who release payments."},
  {"key":"S3","rule_type":"role","enforcement":"soft","sort_order":12,
   "conflict":[["ar.credit_memos:approve","ar.write_offs:approve"],["pay.customer_payments:create"]],
   "name":"Record cash and approve credits",
   "description":"Could record customer payments and also approve credits or write-offs that hide missing cash.",
   "suggested_fix":"Have someone who doesn't record payments approve credits and write-offs."},
  {"key":"S4","rule_type":"role","enforcement":"soft","tenant_type_override":{"firm":"hard"},"sort_order":13,
   "conflict":[["payroll.employees:edit"],["payroll.runs:release"]],
   "name":"Edit pay and release payroll",
   "description":"Could change an employee's pay or bank details and then release payroll.",
   "suggested_fix":"Separate employee maintenance from payroll release."},
  {"key":"S5","rule_type":"role","enforcement":"soft","sort_order":14,
   "conflict":[["gl.journal_entries:post"],["gl.periods:edit"]],
   "name":"Reopen a period and post into it",
   "description":"Could reopen a closed period and post entries into it without a second person.",
   "suggested_fix":"Remove period reopening from people who post, or review entries posted to reopened periods."},
  {"key":"S6","rule_type":"role","enforcement":"soft","sort_order":15,
   "conflict":[["core.access.assignments:create"],["*:release"]],
   "name":"Give access and move money",
   "description":"Could give people access and also release money.",
   "suggested_fix":"Keep access administration with people who don't release money."},
  {"key":"S7","rule_type":"role","enforcement":"soft","sort_order":16,
   "conflict":[["mdm.vendors:create"],["ap.bills:approve"],["pay.batches:release"]],
   "name":"Create a vendor and pay it",
   "description":"Could both create vendors and release payments to them, approving the bills in between.",
   "suggested_fix":"Remove vendor creation, or have a second person release payments."},
  {"key":"S8","rule_type":"role","enforcement":"soft","sort_order":17,
   "conflict":[["ai.autonomy:configure"],["pay.batches:release"]],
   "name":"Turn on automation and release",
   "description":"Could turn on automatic actions and release the payments those actions prepare.",
   "suggested_fix":"Keep automation settings with someone who doesn't release payments."},
  {"key":"S9","rule_type":"role","enforcement":"txn_only","sort_order":18,
   "conflict":[["bank.reconciliations:edit"],["bank.reconciliations:approve"]],
   "name":"Prepare and sign off a reconciliation",
   "description":"Can prepare and sign off reconciliations, but never both on the same one.",
   "suggested_fix":"Nothing to change — each reconciliation is checked when it is signed off."}
]$seed$::jsonb);

-- Wave-2 integration: re-apply client-scope RLS (163) so any client-owned table or
-- location_id column created above gets its restrictive policy.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
