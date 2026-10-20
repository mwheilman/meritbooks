-- =============================================================================
-- Migration 160: client sets + access assignments + backfill (05-RBAC-SPEC §1.4, R-4) — wave 1
-- =============================================================================
-- An ASSIGNMENT is membership × scope × (role | permission set). It is the only source of
-- authority in the new model (IA §1.1). One person can be Bookkeeper on client A and
-- Reviewer on client B; grants stack by union; mutes / read-only narrow ONLY their own
-- assignment.
--
-- core.client_sets          id, org_id, key, name, description, kind (static | rule),
--                           rule jsonb, is_system, created_by, created_at, updated_at
-- core.client_set_members   set_id, location_id, org_id, added_at, added_by
--                           (static: written explicitly; rule: materialized by
--                            core.rbac_refresh_client_set — re-run on client changes)
-- core.access_assignments   id, org_id, membership_id, grant_type (role | permission_set),
--                           role_id | permission_set_id,
--                           scope_type (all_clients | client | client_set |
--                                       consolidation_group | tenant),
--                           location_id | client_set_id | group_id,
--                           read_only, muted jsonb {cap: [actions]},
--                           constraint_overrides jsonb (tighten-only), effective_from,
--                           effective_to, status (pending_approval | active | suspended |
--                           expired | revoked), granted_by, approved_by, reason,
--                           sod_exception_ids uuid[], source (invite | manual |
--                           client_admin | jit_request | emergency | backfill),
--                           backfill_key, created_at, updated_at
-- core.memberships          + role_definition_id (PRIMARY role: display / invite default
--                             only — never authority), audience, access_epoch bigint
-- core.membership_invitations + intended_assignments jsonb
--
-- Integrity (trigger): membership, role / set, location and client set all belong to the
-- assignment's tenant; platform templates are never assigned directly; a CLIENT-owned
-- role / set is assignable only on its own client; client-staff members only on one
-- client; H1 no self-administration (granted_by / approved_by ≠ the grantee, approver ≠
-- grantor); a role's max_assignment_days forces effective_to.
-- access_epoch is bumped on every assignment change and on every publish of a role / set
-- someone holds (05 §5.4) — wave 2's snapshot cache keys on it.
--
-- BACKFILL (core.rbac_backfill_assignments(org), idempotent via backfill_key):
--   primary role = memberships.role normalized exactly like role-normalize.ts (owner /
--   admin / org_admin → company_admin), else a mig-130 custom key; scope from the legacy
--   companyScope:  all → all_clients;  portcos_and_3rdparty → system client set
--   "All clients except own books";  assigned / own_company → one `client` assignment per
--   active employee_locations row (M3: not membership_locations). company_admin also gets
--   "Legacy full books"; merit_controller also gets "Legacy controller release" —
--   so effective access is unchanged. External auditors get a 120-day time box.
--   Membership role is authoritative (it is what page-guard and canApprove read). Where
--   core.employees.role (what requirePermission reads) disagrees, the report flags it (C4).
--
-- REPORT: core.v_access_backfill_report (service-role only). Run after applying:
--     select org_id, membership_id, clerk_user_id, membership_role, employee_role,
--            legacy_role, tenant_role_key, scopes, permission_sets, issues
--       from core.v_access_backfill_report
--      order by org_id, cardinality(issues) desc, clerk_user_id;
--
-- membership_locations is NOT converted to a compat view here (that is a drop + view,
-- i.e. not additive); it stays a table until R-11/R-14.
-- RLS: members READ their tenant's rows; writes service_role only. No behavior change.
-- =============================================================================

-- ── memberships / invitations ────────────────────────────────────────────────
alter table core.memberships add column if not exists role_definition_id uuid;
alter table core.memberships add column if not exists audience text not null default 'internal_staff';
alter table core.memberships add column if not exists access_epoch bigint not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_role_definition_fkey') then
    alter table core.memberships add constraint memberships_role_definition_fkey
      foreign key (role_definition_id) references core.role_definitions(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'memberships_audience_chk') then
    alter table core.memberships add constraint memberships_audience_chk
      check (audience in ('internal_staff', 'client_staff', 'external', 'platform'));
  end if;
end $$;
comment on column core.memberships.role_definition_id is
  '05 R-4: primary role for display and invite defaults ONLY. Authority comes from core.access_assignments.';

do $$ begin
  if to_regclass('core.membership_invitations') is not null then
    alter table core.membership_invitations add column if not exists intended_assignments jsonb;
    if not exists (select 1 from pg_constraint where conname = 'membership_invitations_intended_chk') then
      alter table core.membership_invitations add constraint membership_invitations_intended_chk
        check (intended_assignments is null or jsonb_typeof(intended_assignments) = 'array');
    end if;
  end if;
end $$;

-- ── client sets ──────────────────────────────────────────────────────────────
create or replace function core.rbac_valid_client_set_rule(p jsonb) returns boolean
  language sql immutable as
$$
  select p is not null and jsonb_typeof(p) = 'object'
     and not exists (select 1 from jsonb_object_keys(p) k
                      where k not in ('include_all', 'exclude_own_books', 'tags_any', 'tags_all',
                                      'industries', 'client_statuses', 'location_ids', 'exclude_location_ids'))
$$;

create table if not exists core.client_sets (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.organizations(id) on delete cascade,
  key         text,
  name        text not null,
  description text,
  kind        text not null default 'static' check (kind in ('static', 'rule')),
  rule        jsonb not null default '{}'::jsonb,
  is_system   boolean not null default false,
  created_by  uuid references core.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint client_sets_name_chk check (length(btrim(name)) > 0),
  constraint client_sets_rule_chk check (core.rbac_valid_client_set_rule(rule))
);
create unique index if not exists uq_client_sets_org_name on core.client_sets (org_id, lower(name));
create unique index if not exists uq_client_sets_org_key  on core.client_sets (org_id, key) where key is not null;

create table if not exists core.client_set_members (
  set_id      uuid not null references core.client_sets(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  org_id      uuid not null references core.organizations(id) on delete cascade,
  added_at    timestamptz not null default now(),
  added_by    uuid references core.users(id) on delete set null,
  primary key (set_id, location_id)
);
create index if not exists idx_client_set_members_location on core.client_set_members (location_id);

-- ── access assignments ───────────────────────────────────────────────────────
create table if not exists core.access_assignments (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  membership_id        uuid not null references core.memberships(id) on delete cascade,
  grant_type           text not null,
  role_id              uuid references core.role_definitions(id) on delete restrict,
  permission_set_id    uuid references core.permission_sets(id) on delete restrict,
  scope_type           text not null,
  location_id          uuid references core.locations(id) on delete cascade,
  client_set_id        uuid references core.client_sets(id) on delete restrict,
  group_id             uuid,
  read_only            boolean not null default false,
  muted                jsonb not null default '{}'::jsonb,
  constraint_overrides jsonb not null default '{}'::jsonb,
  effective_from       timestamptz not null default now(),
  effective_to         timestamptz,
  status               text not null default 'active',
  granted_by           uuid references core.users(id) on delete set null,
  approved_by          uuid references core.users(id) on delete set null,
  reason               text,
  sod_exception_ids    uuid[] not null default '{}',
  source               text not null default 'manual',
  backfill_key         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint access_assignments_grant_type_chk check (
       (grant_type = 'role' and role_id is not null and permission_set_id is null)
    or (grant_type = 'permission_set' and permission_set_id is not null and role_id is null)),
  constraint access_assignments_scope_chk check (
       (scope_type = 'all_clients'         and location_id is null and client_set_id is null and group_id is null)
    or (scope_type = 'tenant'              and location_id is null and client_set_id is null and group_id is null)
    or (scope_type = 'client'              and location_id is not null and client_set_id is null and group_id is null)
    or (scope_type = 'client_set'          and client_set_id is not null and location_id is null and group_id is null)
    or (scope_type = 'consolidation_group' and group_id is not null and location_id is null and client_set_id is null)),
  constraint access_assignments_status_chk check (status in ('pending_approval', 'active', 'suspended', 'expired', 'revoked')),
  constraint access_assignments_source_chk check (source in ('invite', 'manual', 'client_admin', 'jit_request', 'emergency', 'backfill')),
  constraint access_assignments_dates_chk check (effective_to is null or effective_to > effective_from),
  constraint access_assignments_muted_chk check (jsonb_typeof(muted) = 'object'),
  constraint access_assignments_overrides_chk check (core.rbac_valid_constraints(constraint_overrides))
);
create index if not exists idx_access_assignments_membership on core.access_assignments (membership_id);
create index if not exists idx_access_assignments_org on core.access_assignments (org_id);
create index if not exists idx_access_assignments_location on core.access_assignments (location_id) where location_id is not null;
create index if not exists idx_access_assignments_role on core.access_assignments (role_id) where role_id is not null;
create index if not exists idx_access_assignments_set on core.access_assignments (permission_set_id) where permission_set_id is not null;
create unique index if not exists uq_access_assignments_backfill
  on core.access_assignments (membership_id, backfill_key) where backfill_key is not null;
comment on table core.access_assignments is
  '05 R-4: membership × scope × (role | permission set) — THE source of authority. Not enforced until the wave-2 flip.';

create or replace function core.rbac_access_assignments_guard() returns trigger
  language plpgsql as
$$
declare
  m record; v_owner text; v_owner_org uuid; v_owner_loc uuid; v_max_days int; v_status text;
begin
  select ms.id, ms.org_id, ms.user_id, ms.audience into m from core.memberships ms where ms.id = new.membership_id;
  if m.id is null or m.org_id <> new.org_id then
    raise exception 'membership % is not a seat in tenant %', new.membership_id, new.org_id using errcode = 'check_violation';
  end if;

  if new.grant_type = 'role' then
    select owner_level, org_id, location_id, max_assignment_days, status
      into v_owner, v_owner_org, v_owner_loc, v_max_days, v_status
      from core.role_definitions where id = new.role_id;
  else
    select owner_level, org_id, location_id, max_assignment_days, status
      into v_owner, v_owner_org, v_owner_loc, v_max_days, v_status
      from core.permission_sets where id = new.permission_set_id;
  end if;
  if v_owner is null or v_owner = 'platform' or v_owner_org <> new.org_id then
    raise exception 'only roles / permission sets of the same tenant can be assigned (platform templates are cloned, never assigned)'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' and v_status in ('deprecated', 'archived') then
    raise exception 'a % role / permission set takes no new assignments', v_status using errcode = 'check_violation';
  end if;
  if v_owner = 'client' and (new.scope_type <> 'client' or new.location_id is distinct from v_owner_loc) then
    raise exception 'a client-defined role / set is assignable only on its own client' using errcode = 'check_violation';
  end if;

  if new.location_id is not null and not exists (
       select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'location % is not a client of tenant %', new.location_id, new.org_id using errcode = 'check_violation';
  end if;
  if new.client_set_id is not null and not exists (
       select 1 from core.client_sets s where s.id = new.client_set_id and s.org_id = new.org_id) then
    raise exception 'client set % is not in tenant %', new.client_set_id, new.org_id using errcode = 'check_violation';
  end if;

  -- client-staff people are never assignable to another client
  if m.audience = 'client_staff' and new.status in ('active', 'pending_approval') then
    if new.scope_type <> 'client' then
      raise exception 'client-staff members can only hold single-client assignments' using errcode = 'check_violation';
    end if;
    if exists (select 1 from core.access_assignments a
                where a.membership_id = new.membership_id and a.id <> new.id
                  and a.status in ('active', 'pending_approval')
                  and a.location_id is distinct from new.location_id) then
      raise exception 'client-staff members belong to exactly one client' using errcode = 'check_violation';
    end if;
  end if;

  -- H1: no self-administration
  if new.granted_by is not null and new.granted_by = m.user_id then
    raise exception 'H1: nobody may grant access to themselves' using errcode = 'check_violation';
  end if;
  if new.approved_by is not null and (new.approved_by = m.user_id or new.approved_by = new.granted_by) then
    raise exception 'H1: the second approver must differ from the grantor and the grantee' using errcode = 'check_violation';
  end if;

  -- forced time box
  if v_max_days is not null then
    if new.effective_to is null or new.effective_to > new.effective_from + make_interval(days => v_max_days) then
      raise exception 'this role / set requires an end date within % days', v_max_days using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists trg_access_assignments_guard on core.access_assignments;
create trigger trg_access_assignments_guard before insert or update on core.access_assignments
  for each row execute function core.rbac_access_assignments_guard();

-- ── access epoch (05 §5.4) ───────────────────────────────────────────────────
create or replace function core.rbac_bump_epoch(p_membership_ids uuid[]) returns void
  language sql as
$$ update core.memberships set access_epoch = access_epoch + 1 where id = any (p_membership_ids) $$;

create or replace function core.rbac_assignment_epoch_trg() returns trigger
  language plpgsql as
$$
begin
  perform core.rbac_bump_epoch(array[coalesce(new.membership_id, old.membership_id)]);
  return null;
end
$$;
drop trigger if exists trg_access_assignments_epoch on core.access_assignments;
create trigger trg_access_assignments_epoch after insert or update or delete on core.access_assignments
  for each row execute function core.rbac_assignment_epoch_trg();

create or replace function core.rbac_publish_epoch_trg() returns trigger
  language plpgsql as
$$
begin
  if new.current_version is distinct from old.current_version then
    if tg_table_name = 'role_definitions' then
      perform core.rbac_bump_epoch(array(select distinct membership_id from core.access_assignments where role_id = new.id));
    else
      perform core.rbac_bump_epoch(array(select distinct membership_id from core.access_assignments where permission_set_id = new.id));
    end if;
  end if;
  return null;
end
$$;
drop trigger if exists trg_role_definitions_epoch on core.role_definitions;
create trigger trg_role_definitions_epoch after update of current_version on core.role_definitions
  for each row execute function core.rbac_publish_epoch_trg();
drop trigger if exists trg_permission_sets_epoch on core.permission_sets;
create trigger trg_permission_sets_epoch after update of current_version on core.permission_sets
  for each row execute function core.rbac_publish_epoch_trg();

-- ── client-set materialization ───────────────────────────────────────────────
-- SECURITY DEFINER: it is fired by writes to core.locations (still member-writable) and
-- must write the service-only membership table. It only ever recomputes set membership
-- from the set's own rule — it takes no caller-supplied membership.
create or replace function core.rbac_refresh_client_set(p_set_id uuid) returns integer
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare s core.client_sets%rowtype; v_changed int := 0;
begin
  select * into s from core.client_sets where id = p_set_id;
  if not found or s.kind <> 'rule' then return 0; end if;
  with target as (
    select l.id as location_id from core.locations l
     where l.org_id = s.org_id
       and (
            coalesce((s.rule->>'include_all')::boolean, false)
         or (s.rule ? 'tags_any' and l.tags && array(select jsonb_array_elements_text(s.rule->'tags_any')))
         or (s.rule ? 'tags_all' and l.tags @> array(select jsonb_array_elements_text(s.rule->'tags_all')))
         or (s.rule ? 'industries' and l.industry = any (array(select jsonb_array_elements_text(s.rule->'industries'))))
         or (s.rule ? 'location_ids' and l.id::text = any (array(select jsonb_array_elements_text(s.rule->'location_ids')))))
       and (not coalesce((s.rule->>'exclude_own_books')::boolean, false) or not l.is_tenant_own_books)
       and (not (s.rule ? 'client_statuses') or l.client_status = any (array(select jsonb_array_elements_text(s.rule->'client_statuses'))))
       and (not (s.rule ? 'exclude_location_ids') or not (l.id::text = any (array(select jsonb_array_elements_text(s.rule->'exclude_location_ids')))))
  ), del as (
    delete from core.client_set_members m
     where m.set_id = s.id and not exists (select 1 from target t where t.location_id = m.location_id)
    returning 1
  ), ins as (
    insert into core.client_set_members (set_id, location_id, org_id)
    select s.id, t.location_id, s.org_id from target t
    on conflict (set_id, location_id) do nothing
    returning 1
  )
  select (select count(*) from del) + (select count(*) from ins) into v_changed;

  if v_changed > 0 then
    perform core.rbac_bump_epoch(array(select distinct membership_id from core.access_assignments where client_set_id = s.id));
  end if;
  return v_changed;
end
$$;
revoke all on function core.rbac_refresh_client_set(uuid) from public, anon, authenticated;
grant execute on function core.rbac_refresh_client_set(uuid) to service_role;

create or replace function core.rbac_refresh_org_client_sets_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare s record; v_org uuid;
begin
  v_org := coalesce(new.org_id, old.org_id);
  for s in select id from core.client_sets where org_id = v_org and kind = 'rule' loop
    perform core.rbac_refresh_client_set(s.id);
  end loop;
  return null;
end
$$;
drop trigger if exists trg_locations_refresh_client_sets on core.locations;
create trigger trg_locations_refresh_client_sets
  after insert or delete or update of tags, industry, is_management_company, client_status on core.locations
  for each row execute function core.rbac_refresh_org_client_sets_trg();

create or replace function core.rbac_client_sets_after_trg() returns trigger
  language plpgsql as
$$
begin
  if new.kind = 'rule' then perform core.rbac_refresh_client_set(new.id); end if;
  return null;
end
$$;
drop trigger if exists trg_client_sets_refresh on core.client_sets;
create trigger trg_client_sets_refresh after insert or update of rule, kind on core.client_sets
  for each row execute function core.rbac_client_sets_after_trg();

-- The system set "All clients except own books" (legacy portcos_and_3rdparty).
create or replace function core.rbac_ensure_all_except_own_books_set(p_org uuid) returns uuid
  language plpgsql as
$$
declare v_id uuid;
begin
  select id into v_id from core.client_sets where org_id = p_org and key = 'all_except_own_books';
  if v_id is null then
    insert into core.client_sets (org_id, key, name, description, kind, rule, is_system)
    values (p_org, 'all_except_own_books', 'All clients except own books',
            'Every client except the tenant''s own books, including clients added later. Created by the access backfill to preserve the legacy "portfolio companies + third party" scope.',
            'rule', '{"include_all": true, "exclude_own_books": true}'::jsonb, true)
    returning id into v_id;
  end if;
  return v_id;
end
$$;

-- ── BACKFILL ─────────────────────────────────────────────────────────────────
create or replace function core.rbac_backfill_assignments(p_org uuid) returns integer
  language plpgsql as
$$
declare
  m record; v_legacy text; v_role core.role_definitions%rowtype; v_scope text; v_base text;
  v_set_id uuid; v_loc uuid; v_to timestamptz; v_n int := 0; v_ps uuid; v_ps_key text; v_rows int;
begin
  for m in
    select ms.id, ms.role, ms.role_definition_id, u.clerk_user_id
      from core.memberships ms join core.users u on u.id = ms.user_id
     where ms.org_id = p_org
       and coalesce(ms.status, 'active') = 'active'   -- security review M2: never backfill suspended/removed seats
  loop
    v_legacy := core.rbac_normalize_legacy_role(m.role);
    v_role := null;
    if v_legacy is not null then
      select * into v_role from core.role_definitions
       where owner_level = 'tenant' and org_id = p_org and legacy_role_key = v_legacy;
      v_base := v_legacy;
    else
      select * into v_role from core.role_definitions
       where owner_level = 'tenant' and org_id = p_org and legacy_role_key = btrim(m.role);
      select core.rbac_normalize_legacy_role(cr.base_role) into v_base
        from core.custom_roles cr where cr.org_id = p_org and cr.key = btrim(m.role);
    end if;
    continue when v_role.id is null; -- unmapped role → reported, no access granted

    if v_role.audience = 'external' then
      v_scope := 'assigned';
    else
      select scope_kind into v_scope from core.legacy_roles where role_key = v_base;
      v_scope := coalesce(v_scope, 'assigned');
    end if;
    v_to := case when v_role.max_assignment_days is not null
                 then now() + make_interval(days => v_role.max_assignment_days) end;

    if v_scope = 'all_clients' then
      insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type,
                                           effective_to, source, reason, backfill_key)
      values (p_org, m.id, 'role', v_role.id, 'all_clients', v_to, 'backfill',
              format('Backfilled from legacy role %s (scope: all companies)', m.role), 'legacy:role:all')
      on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
      get diagnostics v_rows = row_count; v_n := v_n + v_rows;
    elsif v_scope = 'all_except_own_books' then
      v_set_id := core.rbac_ensure_all_except_own_books_set(p_org);
      insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, client_set_id,
                                           effective_to, source, reason, backfill_key)
      values (p_org, m.id, 'role', v_role.id, 'client_set', v_set_id, v_to, 'backfill',
              format('Backfilled from legacy role %s (scope: all companies except own books)', m.role), 'legacy:role:set')
      on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
      get diagnostics v_rows = row_count; v_n := v_n + v_rows;
    else
      for v_loc in
        select el.location_id
          from public.employee_locations el
          join core.employees e on e.id = el.employee_id
         where e.org_id = p_org and e.is_active and e.clerk_user_id = m.clerk_user_id
        -- security review M3: employee_locations is the live authority; membership_locations is a
        -- one-way mirror that never drops rows, so unioning it could widen scope.
      loop
        continue when not exists (select 1 from core.locations l where l.id = v_loc and l.org_id = p_org);
        insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id,
                                             effective_to, source, reason, backfill_key)
        values (p_org, m.id, 'role', v_role.id, 'client', v_loc, v_to, 'backfill',
                format('Backfilled from legacy role %s (assigned company)', m.role), 'legacy:role:loc:' || v_loc)
        on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
        get diagnostics v_rows = row_count; v_n := v_n + v_rows;
      end loop;
    end if;

    -- Legacy permission sets keep effective access identical.
    v_ps_key := case v_legacy when 'company_admin' then 'legacy_full_books'
                              when 'merit_controller' then 'legacy_controller_release' end;
    if v_ps_key is not null then
      select id into v_ps from core.permission_sets where owner_level = 'tenant' and org_id = p_org and key = v_ps_key;
      if v_ps is not null then
        insert into core.access_assignments (org_id, membership_id, grant_type, permission_set_id, scope_type,
                                             source, reason, backfill_key)
        values (p_org, m.id, 'permission_set', v_ps, 'all_clients', 'backfill',
                format('Legacy access kept for %s — review in the first access review', m.role), 'legacy:set:' || v_ps_key)
        on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
        get diagnostics v_rows = row_count; v_n := v_n + v_rows;
      end if;
    end if;

    if m.role_definition_id is null then
      update core.memberships set role_definition_id = v_role.id, audience = v_role.audience where id = m.id;
    end if;
  end loop;
  return v_n;
end
$$;
revoke all on function core.rbac_backfill_assignments(uuid) from public, anon, authenticated;
grant execute on function core.rbac_backfill_assignments(uuid) to service_role;
revoke all on function core.rbac_ensure_all_except_own_books_set(uuid) from public, anon, authenticated;
grant execute on function core.rbac_ensure_all_except_own_books_set(uuid) to service_role;
revoke all on function core.rbac_bump_epoch(uuid[]) from public, anon, authenticated;
grant execute on function core.rbac_bump_epoch(uuid[]) to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['client_sets', 'client_set_members', 'access_assignments'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('drop policy if exists member_read on core.%I', t);
    execute format('drop policy if exists service_all on core.%I', t);
    execute format('create policy member_read on core.%I for select using (org_id = public.get_org_id())', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

-- ── Backfill report (service-role only) ──────────────────────────────────────
create or replace view core.v_access_backfill_report with (security_invoker = true) as
with mem as (
  select ms.org_id, ms.id as membership_id, u.clerk_user_id, ms.role as membership_role, ms.status,
         ms.admin_scope,
         (select e.role from core.employees e
           where e.org_id = ms.org_id and e.clerk_user_id = u.clerk_user_id and e.is_active
           order by e.created_at limit 1) as employee_role,
         core.rbac_normalize_legacy_role(ms.role) as legacy_role
    from core.memberships ms join core.users u on u.id = ms.user_id
), asg as (
  select a.membership_id,
         jsonb_agg(jsonb_build_object('scope', a.scope_type, 'location_id', a.location_id,
                                      'client_set', cs.name, 'effective_to', a.effective_to)
                   order by a.scope_type, a.location_id) filter (where a.grant_type = 'role') as scopes,
         jsonb_agg(ps.key) filter (where a.grant_type = 'permission_set') as permission_sets,
         min(rd.key) filter (where a.grant_type = 'role') as tenant_role_key,
         bool_or(a.effective_to is not null) as time_boxed
    from core.access_assignments a
    left join core.role_definitions rd on rd.id = a.role_id
    left join core.permission_sets ps on ps.id = a.permission_set_id
    left join core.client_sets cs on cs.id = a.client_set_id
   where a.status = 'active'
   group by a.membership_id
)
select mem.org_id, mem.membership_id, mem.clerk_user_id, mem.membership_role, mem.employee_role,
       mem.legacy_role, asg.tenant_role_key, coalesce(asg.scopes, '[]'::jsonb) as scopes,
       coalesce(asg.permission_sets, '[]'::jsonb) as permission_sets,
       array_remove(array[
         case when asg.membership_id is null then 'no_access_backfilled (unmapped role or assigned scope with no companies)' end,
         case when mem.employee_role is not null
               and core.rbac_normalize_legacy_role(mem.employee_role) is distinct from mem.legacy_role
              then 'C4: employees.role (requirePermission) differs from memberships.role (page-guard)' end,
         case when mem.admin_scope is not null and cardinality(mem.admin_scope) > 0
              then 'admin_scope present (fail-open mig-109 layer, folds into capabilities in wave 2)' end,
         case when mem.legacy_role is not null
               and exists (select 1 from core.legacy_role_cells c where c.role_key = mem.legacy_role and c.cell = 'vendors::edit')
               and not exists (select 1 from core.legacy_role_cells c where c.role_key = mem.legacy_role
                                and c.cell in ('bills::approve', 'checks::approve', 'payroll::approve'))
              then 'tighten: vendor bank-detail edit withheld (05 §2.3)' end,
         case when asg.time_boxed then 'time-boxed (external auditor 120 days)' end,
         case when mem.status <> 'active' then 'membership ' || mem.status end
       ], null) as issues
  from mem left join asg on asg.membership_id = mem.membership_id
union all
select e.org_id, null, e.clerk_user_id, null, e.role, core.rbac_normalize_legacy_role(e.role), null,
       '[]'::jsonb, '[]'::jsonb,
       array['employee_without_membership: legacy page-guard fallback only; not backfilled until the membership is provisioned']
  from core.employees e
 where e.is_active and e.clerk_user_id is not null
   and not exists (select 1 from core.memberships ms join core.users u on u.id = ms.user_id
                    where ms.org_id = e.org_id and u.clerk_user_id = e.clerk_user_id);
revoke all on core.v_access_backfill_report from public, anon, authenticated;
grant select on core.v_access_backfill_report to service_role;

-- Data step for every existing tenant.
do $$
declare o record;
begin
  for o in select id from core.organizations loop
    perform core.rbac_backfill_assignments(o.id);
  end loop;
end $$;
