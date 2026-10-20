-- =============================================================================
-- Migration 161: client access policies (envelopes) + client-defined roles
--                (05-RBAC-SPEC §1.6, §5.7 R-5) — wave 1
-- =============================================================================
-- core.client_access_policies   one row per client (pk org_id, location_id)
--   client_roles_enabled        may this client's admin author client roles?
--   envelope_permission_set_id  -> core.permission_sets (is_envelope): the MOST any client
--                                  role / set may contain
--   client_admin_may_invite     bool
--   firm_approval_required_for  text[] ⊆ actions — client-role versions granting these
--                                  need a tenant grantor's approval before they publish
--   max_client_members          optional seat cap
--   mfa_required                floor on client-staff auth
--   updated_by, created_at, updated_at
-- core.organizations
--   + default_client_access_policy jsonb (tenant defaults by tenant type, 05 §1.6 / IA Q6):
--       firm    → client roles OFF, "Client staff envelope", firm approval for
--                 approve / release / post / configure, MFA on
--       company → client roles ON,  "Company staff envelope", no firm approval, MFA off
--
-- Client-defined roles live in core.role_definitions / core.permission_sets with
-- owner_level = 'client' (mig 158/159). This migration adds their guardrails:
--   * a client role / set can only be created when the client's policy enables it;
--   * every grant on a client-owned version must lie INSIDE the client envelope
--     (capability present in the envelope's Current grants with every action) — the DB
--     refuses anything else (the resolver also intersects at read time, defense in depth);
--   * publishing a client-role version that grants a firm-approval action requires
--     second_approval_by (a tenant grantor) on the draft.
--
-- core.rbac_provision_tenant(org) — the one idempotent entry point for a tenant:
-- import roles (158) → permission sets (159) → default policy + per-client policies →
-- assignment backfill (160). New clients get a policy row by trigger.
--
-- RLS: members READ their tenant's policies; writes service_role only. No behavior change.
-- =============================================================================

alter table core.organizations add column if not exists default_client_access_policy jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_default_cap_chk') then
    alter table core.organizations add constraint organizations_default_cap_chk
      check (default_client_access_policy is null or jsonb_typeof(default_client_access_policy) = 'object');
  end if;
end $$;

create table if not exists core.client_access_policies (
  org_id                     uuid not null references core.organizations(id) on delete cascade,
  location_id                uuid not null references core.locations(id) on delete cascade,
  client_roles_enabled       boolean not null default false,
  envelope_permission_set_id uuid references core.permission_sets(id) on delete restrict,
  client_admin_may_invite    boolean not null default true,
  firm_approval_required_for text[] not null default array['approve', 'release', 'post', 'configure'],
  max_client_members         int,
  mfa_required               boolean not null default true,
  updated_by                 uuid references core.users(id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (org_id, location_id),
  constraint cap_firm_approval_chk check (firm_approval_required_for <@ core.rbac_actions()),
  constraint cap_max_members_chk check (max_client_members is null or max_client_members > 0),
  constraint cap_enabled_needs_envelope_chk check (not client_roles_enabled or envelope_permission_set_id is not null)
);
comment on table core.client_access_policies is
  '05 R-5: per-client envelope. Client-defined roles must stay ⊆ the envelope permission set.';

create or replace function core.rbac_client_access_policies_guard() returns trigger
  language plpgsql as
$$
begin
  if not exists (select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'location % is not a client of tenant %', new.location_id, new.org_id using errcode = 'check_violation';
  end if;
  if new.envelope_permission_set_id is not null and not exists (
       select 1 from core.permission_sets s
        where s.id = new.envelope_permission_set_id and s.is_envelope
          and s.owner_level = 'tenant' and s.org_id = new.org_id) then
    raise exception 'the envelope must be an envelope permission set of the same tenant' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists trg_client_access_policies_guard on core.client_access_policies;
create trigger trg_client_access_policies_guard before insert or update on core.client_access_policies
  for each row execute function core.rbac_client_access_policies_guard();

-- ── Defaults ─────────────────────────────────────────────────────────────────
create or replace function core.rbac_default_client_access_policy(p_tenant_type text) returns jsonb
  language sql immutable as
$$
  select case when p_tenant_type = 'firm' then
    '{"client_roles_enabled": false, "envelope_key": "client_staff_envelope", "client_admin_may_invite": true,
      "firm_approval_required_for": ["approve", "release", "post", "configure"], "max_client_members": null,
      "mfa_required": true}'::jsonb
  else
    '{"client_roles_enabled": true, "envelope_key": "company_staff_envelope", "client_admin_may_invite": true,
      "firm_approval_required_for": [], "max_client_members": null, "mfa_required": false}'::jsonb
  end
$$;

create or replace function core.rbac_ensure_client_access_policy(p_org uuid, p_location uuid) returns void
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare d jsonb; v_env uuid;
begin
  if exists (select 1 from core.client_access_policies
              where org_id = p_org and location_id = p_location and envelope_permission_set_id is not null) then
    return;
  end if;
  select coalesce(o.default_client_access_policy, core.rbac_default_client_access_policy(o.tenant_type))
    into d from core.organizations o where o.id = p_org;
  if d is null then return; end if;
  select id into v_env from core.permission_sets
   where owner_level = 'tenant' and org_id = p_org and is_envelope and key = d->>'envelope_key';
  insert into core.client_access_policies
    (org_id, location_id, client_roles_enabled, envelope_permission_set_id, client_admin_may_invite,
     firm_approval_required_for, max_client_members, mfa_required)
  values (p_org, p_location,
          coalesce((d->>'client_roles_enabled')::boolean, false) and v_env is not null,
          v_env,
          coalesce((d->>'client_admin_may_invite')::boolean, true),
          array(select jsonb_array_elements_text(coalesce(d->'firm_approval_required_for', '[]'::jsonb))),
          nullif(d->>'max_client_members', '')::int,
          coalesce((d->>'mfa_required')::boolean, true))
  -- A policy created before the tenant's envelopes existed (client added before
  -- provisioning) gets its envelope + default enablement filled in; nothing else changes.
  on conflict (org_id, location_id) do update
     set envelope_permission_set_id = excluded.envelope_permission_set_id,
         client_roles_enabled = excluded.client_roles_enabled
   where core.client_access_policies.envelope_permission_set_id is null;
end
$$;
revoke all on function core.rbac_ensure_client_access_policy(uuid, uuid) from public, anon, authenticated;
grant execute on function core.rbac_ensure_client_access_policy(uuid, uuid) to service_role;

create or replace function core.rbac_location_policy_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
begin
  perform core.rbac_ensure_client_access_policy(new.org_id, new.id);
  return null;
end
$$;
drop trigger if exists trg_locations_client_access_policy on core.locations;
create trigger trg_locations_client_access_policy after insert on core.locations
  for each row execute function core.rbac_location_policy_trg();

-- ── Client-defined role guardrails ───────────────────────────────────────────
create or replace function core.rbac_client_owner_enabled_guard() returns trigger
  language plpgsql as
$$
begin
  if new.owner_level = 'client' and not exists (
       select 1 from core.client_access_policies p
        where p.org_id = new.org_id and p.location_id = new.location_id and p.client_roles_enabled) then
    raise exception 'client-defined roles are not enabled for client %', new.location_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_role_definitions_client_enabled on core.role_definitions;
create trigger trg_role_definitions_client_enabled before insert on core.role_definitions
  for each row execute function core.rbac_client_owner_enabled_guard();
drop trigger if exists trg_permission_sets_client_enabled on core.permission_sets;
create trigger trg_permission_sets_client_enabled before insert on core.permission_sets
  for each row execute function core.rbac_client_owner_enabled_guard();

-- Is (capability, actions) inside the client's envelope (its Current grants)?
create or replace function core.rbac_within_envelope(p_org uuid, p_location uuid, p_capability text, p_actions text[])
returns boolean language sql stable as
$$
  select exists (
    select 1
      from core.client_access_policies p
      join core.permission_set_versions v on v.permission_set_id = p.envelope_permission_set_id and v.state = 'published'
      join core.permission_set_grants g on g.permission_set_version_id = v.id
     where p.org_id = p_org and p.location_id = p_location
       and g.capability = p_capability and p_actions <@ g.actions)
$$;

create or replace function core.rbac_client_envelope_guard() returns trigger
  language plpgsql as
$$
declare v_owner text; v_org uuid; v_loc uuid;
begin
  if tg_table_name = 'role_grants' then
    select rd.owner_level, rd.org_id, rd.location_id into v_owner, v_org, v_loc
      from core.role_versions rv join core.role_definitions rd on rd.id = rv.role_id
     where rv.id = new.role_version_id;
  else
    select s.owner_level, s.org_id, s.location_id into v_owner, v_org, v_loc
      from core.permission_set_versions v join core.permission_sets s on s.id = v.permission_set_id
     where v.id = new.permission_set_version_id;
  end if;
  if v_owner = 'client' and not core.rbac_within_envelope(v_org, v_loc, new.capability, new.actions) then
    raise exception 'outside the client envelope: % %', new.capability, new.actions using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_role_grants_client_envelope on core.role_grants;
create trigger trg_role_grants_client_envelope before insert or update on core.role_grants
  for each row execute function core.rbac_client_envelope_guard();
drop trigger if exists trg_permission_set_grants_client_envelope on core.permission_set_grants;
create trigger trg_permission_set_grants_client_envelope before insert or update on core.permission_set_grants
  for each row execute function core.rbac_client_envelope_guard();

-- Publishing a client-role version that grants a firm-approval action needs a tenant
-- grantor's approval recorded on the draft (second_approval_by).
create or replace function core.rbac_client_role_publish_guard() returns trigger
  language plpgsql as
$$
declare v_owner text; v_org uuid; v_loc uuid; v_needs text[];
begin
  if not (old.state = 'draft' and new.state = 'published') then return new; end if;
  select rd.owner_level, rd.org_id, rd.location_id into v_owner, v_org, v_loc
    from core.role_definitions rd where rd.id = new.role_id;
  if v_owner <> 'client' then return new; end if;
  select p.firm_approval_required_for into v_needs
    from core.client_access_policies p where p.org_id = v_org and p.location_id = v_loc;
  if new.second_approval_by is null and exists (
       select 1 from core.role_grants g where g.role_version_id = new.id and g.actions && coalesce(v_needs, '{}')) then
    raise exception 'this client-role change needs approval by the firm before it publishes' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_role_versions_client_publish on core.role_versions;
create trigger trg_role_versions_client_publish before update on core.role_versions
  for each row execute function core.rbac_client_role_publish_guard();

-- ── One entry point per tenant ───────────────────────────────────────────────
create or replace function core.rbac_provision_tenant(p_org uuid) returns jsonb
  language plpgsql as
$$
declare o record; l record; v_assignments int;
begin
  select * into o from core.organizations where id = p_org;
  if not found then return jsonb_build_object('error', 'tenant not found'); end if;
  perform core.rbac_import_tenant_roles(p_org);
  perform core.rbac_import_tenant_permission_sets(p_org);
  update core.organizations
     set default_client_access_policy = core.rbac_default_client_access_policy(tenant_type)
   where id = p_org and default_client_access_policy is null;
  for l in select id from core.locations where org_id = p_org loop
    perform core.rbac_ensure_client_access_policy(p_org, l.id);
  end loop;
  v_assignments := core.rbac_backfill_assignments(p_org);
  return jsonb_build_object(
    'tenant_roles', (select count(*) from core.role_definitions where owner_level = 'tenant' and org_id = p_org),
    'permission_sets', (select count(*) from core.permission_sets where owner_level = 'tenant' and org_id = p_org),
    'client_policies', (select count(*) from core.client_access_policies where org_id = p_org),
    'assignments_created', v_assignments);
end
$$;
revoke all on function core.rbac_provision_tenant(uuid) from public, anon, authenticated;
grant execute on function core.rbac_provision_tenant(uuid) to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table core.client_access_policies enable row level security;
drop policy if exists member_read on core.client_access_policies;
drop policy if exists service_all on core.client_access_policies;
create policy member_read on core.client_access_policies for select using (org_id = public.get_org_id());
create policy service_all on core.client_access_policies for all to service_role using (true) with check (true);
revoke insert, update, delete, truncate on table core.client_access_policies from anon, authenticated;
grant select, insert, update, delete on table core.client_access_policies to service_role;

-- Data step: tenant defaults + a policy for every existing client.
do $$
declare o record; l record;
begin
  for o in select id, tenant_type from core.organizations loop
    update core.organizations
       set default_client_access_policy = core.rbac_default_client_access_policy(o.tenant_type)
     where id = o.id and default_client_access_policy is null;
    for l in select id from core.locations where org_id = o.id loop
      perform core.rbac_ensure_client_access_policy(o.id, l.id);
    end loop;
  end loop;
end $$;
