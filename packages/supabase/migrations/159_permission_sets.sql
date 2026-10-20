-- =============================================================================
-- Migration 159: permission sets (05-RBAC-SPEC §1.5, §5.7 R-3) — wave 1
-- =============================================================================
-- Add-on grant bundles assigned like roles (scope, dates, reason), often time-boxed.
-- Same three owner levels and the same immutable Current / Proposed versioning as roles.
--
-- core.permission_sets
--   id, owner_level (platform | tenant | client), org_id, location_id, key, name,
--   description, kind (standard | custom), audience, upstream_template_id -> permission_sets,
--   upstream_version, field_policy jsonb, auth_policy jsonb, max_assignment_days,
--   assignable_band, status (draft | active | deprecated | archived), current_version,
--   is_envelope bool (a client envelope, 05 §1.6), is_sealed bool (emergency sets, 05 §4.5),
--   activators uuid[] (memberships allowed to activate a sealed set), legacy_role_key,
--   created_by, created_at, updated_at
-- core.permission_set_versions   (same shape as role_versions; one draft + one published)
-- core.permission_set_grants     (same shape + validation as role_grants)
--
-- Seeded platform sets (GENERATED from lib/rbac/access-templates.ts):
--   client_staff_envelope, company_staff_envelope, legacy_full_books,
--   legacy_controller_release, payroll_comp_visibility, consolidation_manage,
--   emergency_finance_access (sealed template).
--
-- Data step, per tenant (core.rbac_import_tenant_permission_sets, idempotent):
--   * clone every non-legacy platform set into a tenant standard set;
--   * "Legacy full books (company_admin)" = legacy company_admin grants (with the
--     tenant's mig-130 overrides) MINUS the tenant's Tenant admin role grants;
--   * "Legacy controller release" = the money-release actions legacy merit_controller held;
--   so  role ∪ legacy set  ==  legacy grants  exactly (backfill in mig 160 assigns both).
--
-- RLS: members READ platform + own-tenant sets; writes service_role only. No behavior change.
-- =============================================================================

create table if not exists core.permission_sets (
  id                   uuid primary key default gen_random_uuid(),
  owner_level          text not null,
  org_id               uuid references core.organizations(id) on delete cascade,
  location_id          uuid references core.locations(id) on delete cascade,
  key                  text not null,
  name                 text not null,
  description          text,
  kind                 text not null default 'custom',
  audience             text not null default 'internal_staff',
  upstream_template_id uuid references core.permission_sets(id) on delete set null,
  upstream_version     int,
  field_policy         jsonb not null default '{}'::jsonb,
  auth_policy          jsonb not null default '{}'::jsonb,
  max_assignment_days  int,
  assignable_band      text not null default 'managers',
  status               text not null default 'active',
  current_version      int,
  is_envelope          boolean not null default false,
  is_sealed            boolean not null default false,
  activators           uuid[] not null default '{}',
  legacy_role_key      text,
  created_by           uuid references core.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint permission_sets_owner_level_chk check (owner_level in ('platform', 'tenant', 'client')),
  constraint permission_sets_owner_shape_chk check (
       (owner_level = 'platform' and org_id is null and location_id is null)
    or (owner_level = 'tenant'   and org_id is not null and location_id is null)
    or (owner_level = 'client'   and org_id is not null and location_id is not null)),
  constraint permission_sets_key_chk check (length(btrim(key)) > 0),
  constraint permission_sets_name_chk check (length(btrim(name)) > 0),
  constraint permission_sets_kind_chk check (kind in ('standard', 'custom')),
  constraint permission_sets_audience_chk check (audience in ('internal_staff', 'client_staff', 'external', 'platform')),
  constraint permission_sets_platform_audience_chk check (audience <> 'platform' or owner_level = 'platform'),
  constraint permission_sets_client_audience_chk check (owner_level <> 'client' or audience in ('client_staff', 'external')),
  constraint permission_sets_band_chk check (assignable_band in ('tenant_admin_only', 'managers', 'any_grantor')),
  constraint permission_sets_status_chk check (status in ('draft', 'active', 'deprecated', 'archived')),
  constraint permission_sets_max_days_chk check (max_assignment_days is null or max_assignment_days > 0),
  constraint permission_sets_envelope_chk check (not is_envelope or owner_level in ('platform', 'tenant')),
  constraint permission_sets_policies_chk check (jsonb_typeof(field_policy) = 'object' and jsonb_typeof(auth_policy) = 'object')
);
create unique index if not exists uq_perm_set_platform_key on core.permission_sets (key) where owner_level = 'platform';
create unique index if not exists uq_perm_set_tenant_key   on core.permission_sets (org_id, key) where owner_level = 'tenant';
create unique index if not exists uq_perm_set_client_key   on core.permission_sets (org_id, location_id, key) where owner_level = 'client';
create index if not exists idx_perm_sets_org on core.permission_sets (org_id);

create table if not exists core.permission_set_versions (
  id                 uuid primary key default gen_random_uuid(),
  permission_set_id  uuid not null references core.permission_sets(id) on delete cascade,
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
  unique (permission_set_id, version)
);
create unique index if not exists uq_perm_set_versions_one_draft     on core.permission_set_versions (permission_set_id) where state = 'draft';
create unique index if not exists uq_perm_set_versions_one_published on core.permission_set_versions (permission_set_id) where state = 'published';

create table if not exists core.permission_set_grants (
  id                         uuid primary key default gen_random_uuid(),
  permission_set_version_id  uuid not null references core.permission_set_versions(id) on delete cascade,
  capability                 text not null references core.capabilities(key),
  actions                    text[] not null,
  constraints                jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  unique (permission_set_version_id, capability),
  constraint permission_set_grants_actions_chk check (cardinality(actions) > 0 and actions <@ core.rbac_actions()),
  constraint permission_set_grants_constraints_chk check (core.rbac_valid_constraints(constraints))
);
create index if not exists idx_perm_set_grants_capability on core.permission_set_grants (capability);

-- ── Guards (same rules as roles) ─────────────────────────────────────────────
create or replace function core.rbac_set_grants_guard() returns trigger
  language plpgsql as
$$
declare v_state text; v_audience text; v_reason text;
begin
  select v.state, s.audience into v_state, v_audience
    from core.permission_set_versions v join core.permission_sets s on s.id = v.permission_set_id
   where v.id = coalesce(new.permission_set_version_id, old.permission_set_version_id);
  if tg_op = 'DELETE' then
    if v_state is distinct from 'draft' and pg_trigger_depth() <= 1 then
      raise exception 'permission-set grants of a % version are immutable', v_state using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if v_state is distinct from 'draft' then
    raise exception 'permission-set grants of a % version are immutable', coalesce(v_state, 'missing') using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.permission_set_version_id <> old.permission_set_version_id then
    raise exception 'a grant cannot move between versions' using errcode = 'check_violation';
  end if;
  v_reason := core.rbac_grant_violation(v_audience, new.capability, new.actions);
  if v_reason is not null then
    raise exception 'illegal permission-set grant: %', v_reason using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop trigger if exists trg_permission_set_grants_guard on core.permission_set_grants;
create trigger trg_permission_set_grants_guard before insert or update or delete on core.permission_set_grants
  for each row execute function core.rbac_set_grants_guard();

create or replace function core.rbac_set_versions_guard() returns trigger
  language plpgsql as
$$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'draft' and pg_trigger_depth() <= 1 then
      raise exception 'a % permission-set version cannot be deleted', old.state using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.state = 'draft' then
    if new.permission_set_id <> old.permission_set_id or new.version <> old.version then
      raise exception 'permission-set version identity is immutable' using errcode = 'check_violation';
    end if;
    if new.state not in ('draft', 'published') then
      raise exception 'a draft can only be published' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.state = 'published' and new.state = 'superseded'
     and (new.permission_set_id, new.version, new.published_at, new.published_by, new.reason, new.changelog)
         is not distinct from (old.permission_set_id, old.version, old.published_at, old.published_by, old.reason, old.changelog) then
    return new;
  end if;
  raise exception 'a % permission-set version is immutable', old.state using errcode = 'check_violation';
end
$$;
drop trigger if exists trg_permission_set_versions_guard on core.permission_set_versions;
create trigger trg_permission_set_versions_guard before update or delete on core.permission_set_versions
  for each row execute function core.rbac_set_versions_guard();

create or replace function core.rbac_permission_sets_guard() returns trigger
  language plpgsql as
$$
begin
  if new.owner_level = 'client' and not exists (
       select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'client permission set location % is not a client of tenant %', new.location_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.upstream_template_id is not null and not exists (
       select 1 from core.permission_sets u
        where u.id = new.upstream_template_id and (u.owner_level = 'platform' or u.org_id = new.org_id)) then
    raise exception 'upstream permission set must be a platform template or a set of the same tenant'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists trg_permission_sets_guard on core.permission_sets;
create trigger trg_permission_sets_guard before insert or update on core.permission_sets
  for each row execute function core.rbac_permission_sets_guard();

-- ── Version helpers ──────────────────────────────────────────────────────────
create or replace function core.rbac_publish_set_version(p_version_id uuid, p_actor uuid default null, p_reason text default null)
returns int language plpgsql as
$$
declare v core.permission_set_versions%rowtype; v_prev uuid;
begin
  select * into v from core.permission_set_versions where id = p_version_id for update;
  if not found then raise exception 'permission-set version % not found', p_version_id; end if;
  if v.state <> 'draft' then raise exception 'only a draft can be published'; end if;
  perform 1 from core.permission_sets where id = v.permission_set_id for update;
  select id into v_prev from core.permission_set_versions where permission_set_id = v.permission_set_id and state = 'published';
  if v_prev is not null then
    update core.permission_set_versions set state = 'superseded' where id = v_prev;
  end if;
  update core.permission_set_versions
     set state = 'published', published_at = now(), published_by = p_actor,
         effective_at = coalesce(effective_at, now()), reason = coalesce(p_reason, reason)
   where id = v.id;
  update core.permission_sets
     set current_version = v.version, status = case when status = 'draft' then 'active' else status end
   where id = v.permission_set_id;
  return v.version;
end
$$;

create or replace function core.rbac_publish_set_grants(p_set_id uuid, p_grants jsonb, p_reason text, p_actor uuid default null)
returns int language plpgsql as
$$
declare v_id uuid; v_next int;
begin
  select coalesce(max(version), 0) + 1 into v_next from core.permission_set_versions where permission_set_id = p_set_id;
  insert into core.permission_set_versions (permission_set_id, version, state, reason, created_by)
       values (p_set_id, v_next, 'draft', p_reason, p_actor)
    returning id into v_id;
  insert into core.permission_set_grants (permission_set_version_id, capability, actions, constraints)
  select v_id, e->>'capability', array(select jsonb_array_elements_text(e->'actions')), coalesce(e->'constraints', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) e
   where jsonb_array_length(e->'actions') > 0;
  return core.rbac_publish_set_version(v_id, p_actor, p_reason);
end
$$;

create or replace function core.rbac_set_current_grants(p_set_id uuid) returns jsonb
  language sql stable as
$$
  select coalesce(jsonb_agg(jsonb_build_object('capability', g.capability, 'actions', to_jsonb(g.actions), 'constraints', g.constraints)
                            order by g.capability), '[]'::jsonb)
    from core.permission_set_versions v join core.permission_set_grants g on g.permission_set_version_id = v.id
   where v.permission_set_id = p_set_id and v.state = 'published'
$$;

create or replace function core.rbac_seed_platform_permission_sets(p_sets jsonb) returns integer
  language plpgsql as
$$
declare t jsonb; v_id uuid; n int := 0;
begin
  for t in select * from jsonb_array_elements(p_sets) loop
    insert into core.permission_sets as ps
      (owner_level, key, name, description, kind, audience, field_policy, max_assignment_days,
       is_envelope, is_sealed, status)
    values ('platform', t->>'key', t->>'name', t->>'description', 'standard', t->>'audience',
            t->'field_policy', nullif(t->>'max_assignment_days', '')::int,
            (t->>'is_envelope')::boolean, (t->>'is_sealed')::boolean, 'active')
    on conflict (key) where owner_level = 'platform' do update set
      name = excluded.name, description = excluded.description, audience = excluded.audience,
      field_policy = excluded.field_policy, max_assignment_days = excluded.max_assignment_days,
      is_envelope = excluded.is_envelope, is_sealed = excluded.is_sealed
    returning id into v_id;
    if not exists (select 1 from core.permission_set_versions where permission_set_id = v_id) then
      perform core.rbac_publish_set_grants(v_id, t->'grants', 'MeritBooks standard permission set (05 R-3)');
    end if;
    n := n + 1;
  end loop;
  return n;
end
$$;

-- Per-tenant clone + legacy sets (idempotent).
create or replace function core.rbac_import_tenant_permission_sets(p_org uuid) returns void
  language plpgsql as
$$
declare
  t record; v_id uuid; v_grants jsonb; v_role_grants jsonb;
begin
  if not exists (select 1 from core.organizations where id = p_org) then return; end if;
  for t in
    select * from core.permission_sets
     where owner_level = 'platform' and status = 'active' and audience <> 'platform'
     order by key
  loop
    if exists (select 1 from core.permission_sets x where x.owner_level = 'tenant' and x.org_id = p_org and x.key = t.key) then
      continue;
    end if;
    if t.key = 'legacy_full_books' then
      select core.rbac_role_current_grants(rd.id) into v_role_grants
        from core.role_definitions rd where rd.owner_level = 'tenant' and rd.org_id = p_org and rd.key = 'tenant_admin';
      v_grants := core.rbac_grants_minus(
        core.rbac_legacy_grants(core.rbac_legacy_cells(p_org, 'company_admin', true)),
        coalesce(v_role_grants, '[]'::jsonb));
    elsif t.key = 'legacy_controller_release' then
      v_grants := core.rbac_grants_money_release(
        core.rbac_legacy_grants(core.rbac_legacy_cells(p_org, 'merit_controller', true)));
    else
      v_grants := core.rbac_set_current_grants(t.id);
    end if;

    insert into core.permission_sets
      (owner_level, org_id, key, name, description, kind, audience, upstream_template_id, upstream_version,
       field_policy, auth_policy, max_assignment_days, assignable_band, status, is_envelope, is_sealed,
       legacy_role_key)
    values ('tenant', p_org, t.key, t.name, t.description, 'standard', t.audience, t.id, t.current_version,
            t.field_policy, t.auth_policy, t.max_assignment_days,
            case when t.key like 'legacy_%' then 'tenant_admin_only' else t.assignable_band end,
            'active', t.is_envelope, t.is_sealed,
            case t.key when 'legacy_full_books' then 'company_admin'
                       when 'legacy_controller_release' then 'merit_controller' end)
    returning id into v_id;
    perform core.rbac_publish_set_grants(v_id, v_grants,
      case when t.key like 'legacy_%' then 'Imported legacy access (effective access unchanged; review and drop)'
           else 'Cloned from the MeritBooks standard permission set' end);
  end loop;
end
$$;

revoke all on function core.rbac_publish_set_version(uuid, uuid, text) from public, anon, authenticated;
grant execute on function core.rbac_publish_set_version(uuid, uuid, text) to service_role;
revoke all on function core.rbac_publish_set_grants(uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function core.rbac_publish_set_grants(uuid, jsonb, text, uuid) to service_role;
revoke all on function core.rbac_seed_platform_permission_sets(jsonb) from public, anon, authenticated;
grant execute on function core.rbac_seed_platform_permission_sets(jsonb) to service_role;
revoke all on function core.rbac_import_tenant_permission_sets(uuid) from public, anon, authenticated;
grant execute on function core.rbac_import_tenant_permission_sets(uuid) to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['permission_sets', 'permission_set_versions', 'permission_set_grants'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('drop policy if exists member_read on core.%I', t);
    execute format('drop policy if exists service_all on core.%I', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;
create policy member_read on core.permission_sets for select
  using (owner_level = 'platform' or org_id = public.get_org_id());
create policy member_read on core.permission_set_versions for select
  using (exists (select 1 from core.permission_sets s
                  where s.id = permission_set_versions.permission_set_id
                    and (s.owner_level = 'platform' or s.org_id = public.get_org_id())));
create policy member_read on core.permission_set_grants for select
  using (exists (select 1 from core.permission_set_versions v join core.permission_sets s on s.id = v.permission_set_id
                  where v.id = permission_set_grants.permission_set_version_id
                    and (s.owner_level = 'platform' or s.org_id = public.get_org_id())));

-- BEGIN GENERATED permission_sets (apps/web/scripts/rbac/generate-access-seed.ts — do not edit by hand)
select core.rbac_seed_platform_permission_sets($seed$[
  {"key":"client_staff_envelope","name":"Client staff envelope","description":"The most a client-defined role may contain in a firm tenant.","audience":"client_staff","field_policy":{"comp":"hidden","tin":"masked","bank":"masked"},"max_assignment_days":null,"is_envelope":true,"is_sealed":false,"grants":[{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"ap.bills","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"ar.estimates","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"ar.invoices","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"bank.transactions","actions":["view"],"constraints":{}},{"capability":"cards.transactions","actions":["view"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"debt.covenants","actions":["view"],"constraints":{}},{"capability":"debt.loans","actions":["view"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete","export"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view"],"constraints":{}},{"capability":"exp.policy","actions":["view"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"exp.reports","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"fpa.budgets","actions":["view"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.portal","actions":["view"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view"],"constraints":{}},{"capability":"jobs.jobs","actions":["view"],"constraints":{}},{"capability":"jobs.wip","actions":["view"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"reports.board_package","actions":["view"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view"],"constraints":{}},{"capability":"reports.saved_views","actions":["view"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit","release"],"constraints":{}}]},
  {"key":"company_staff_envelope","name":"Company staff envelope","description":"The most a client-defined role may contain in a company tenant.","audience":"client_staff","field_policy":{"comp":"grouped","tin":"masked","bank":"masked"},"max_assignment_days":null,"is_envelope":true,"is_sealed":false,"grants":[{"capability":"ai.agents","actions":["view","create","configure"],"constraints":{}},{"capability":"ai.assist","actions":["view"],"constraints":{}},{"capability":"alerts.watch_rules","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ap.bills","actions":["view","create","edit","delete","approve","post","export"],"constraints":{}},{"capability":"ap.policy","actions":["view","configure"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["view","create","approve","post"],"constraints":{}},{"capability":"ar.collections","actions":["view","edit","release"],"constraints":{}},{"capability":"ar.credit_memos","actions":["view","create","approve","post"],"constraints":{}},{"capability":"ar.deposits","actions":["view","create","post"],"constraints":{}},{"capability":"ar.estimates","actions":["view","create","edit","delete","release"],"constraints":{}},{"capability":"ar.invoices","actions":["view","create","edit","delete","approve","post","release","export"],"constraints":{}},{"capability":"ar.payment_links","actions":["view","configure"],"constraints":{}},{"capability":"ar.recurring","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ar.statements","actions":["view","release"],"constraints":{}},{"capability":"ar.write_offs","actions":["view","create","approve","post"],"constraints":{}},{"capability":"bank.connections","actions":["view","create","delete","configure"],"constraints":{}},{"capability":"bank.reconciliations","actions":["view","create","edit","approve","export"],"constraints":{}},{"capability":"bank.rules","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"bank.statements","actions":["view","create"],"constraints":{}},{"capability":"bank.transactions","actions":["view","edit","approve","export"],"constraints":{}},{"capability":"bank.transfers","actions":["view","create","approve","release"],"constraints":{}},{"capability":"cards.cardholders","actions":["view","edit","configure"],"constraints":{}},{"capability":"cards.ramp_sync","actions":["view","configure"],"constraints":{}},{"capability":"cards.transactions","actions":["view","edit","approve","export"],"constraints":{}},{"capability":"cash.forecast","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.obligations","actions":["view","create","edit"],"constraints":{}},{"capability":"cash.position","actions":["view"],"constraints":{}},{"capability":"close.checklist","actions":["view","edit","approve","configure"],"constraints":{}},{"capability":"close.package","actions":["view","release","export"],"constraints":{}},{"capability":"consol.eliminations","actions":["view","create","post"],"constraints":{}},{"capability":"consol.groups","actions":["view","create","edit","delete","configure"],"constraints":{}},{"capability":"consol.statements","actions":["view","export"],"constraints":{}},{"capability":"ctl.ai_decisions","actions":["view","export"],"constraints":{}},{"capability":"ctl.approval_workflows","actions":["view","configure"],"constraints":{}},{"capability":"ctl.audit_trail","actions":["view","export"],"constraints":{}},{"capability":"ctl.compliance","actions":["view","edit","approve"],"constraints":{}},{"capability":"ctl.exceptions","actions":["view","edit","approve"],"constraints":{}},{"capability":"ctl.pbc","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["view","edit","approve"],"constraints":{}},{"capability":"debt.borrowing_base","actions":["view","create","approve","release"],"constraints":{}},{"capability":"debt.certificates","actions":["view","create","approve","release"],"constraints":{}},{"capability":"debt.covenants","actions":["view","edit","configure"],"constraints":{}},{"capability":"debt.lender_obligations","actions":["view","create","edit","configure"],"constraints":{}},{"capability":"debt.loans","actions":["view","create","edit","post"],"constraints":{}},{"capability":"docs.documents","actions":["view","create","delete","export"],"constraints":{}},{"capability":"exp.chase_policy","actions":["view","configure"],"constraints":{}},{"capability":"exp.policy","actions":["view","configure"],"constraints":{}},{"capability":"exp.receipts","actions":["view","create","edit","delete","approve"],"constraints":{}},{"capability":"exp.reimbursements","actions":["view","create","approve","release"],"constraints":{}},{"capability":"exp.reports","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"fa.assets","actions":["view","create","edit","delete","post"],"constraints":{}},{"capability":"fa.leases","actions":["view","create","edit","post"],"constraints":{}},{"capability":"fa.prepaids","actions":["view","create","edit","post"],"constraints":{}},{"capability":"fpa.budgets","actions":["view","create","edit","approve","export"],"constraints":{}},{"capability":"fpa.profitability","actions":["view","export"],"constraints":{}},{"capability":"fpa.scenarios","actions":["view","create","edit"],"constraints":{}},{"capability":"gl.accounts","actions":["view","create","edit","delete","approve","export","configure"],"constraints":{}},{"capability":"gl.dimensions","actions":["view","create","edit","delete","configure"],"constraints":{}},{"capability":"gl.intercompany","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["view","create","edit","approve","post","release"],"constraints":{}},{"capability":"gl.journal_entries","actions":["view","create","edit","delete","approve","post","export"],"constraints":{}},{"capability":"gl.periods","actions":["view","edit","approve","configure"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["view","create","edit","delete","approve","post"],"constraints":{}},{"capability":"gl.reporting_basis","actions":["view","create","edit","post"],"constraints":{}},{"capability":"gl.year_end","actions":["view","post"],"constraints":{}},{"capability":"home.client","actions":["view"],"constraints":{}},{"capability":"home.portal","actions":["view"],"constraints":{}},{"capability":"home.workspace","actions":["view"],"constraints":{}},{"capability":"int.mappings","actions":["view","edit"],"constraints":{}},{"capability":"int.sync_runs","actions":["view","edit"],"constraints":{}},{"capability":"inv.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"inv.movements","actions":["view","create","approve","post"],"constraints":{}},{"capability":"inv.valuation","actions":["view","post","configure"],"constraints":{}},{"capability":"jobs.change_orders","actions":["view","create","approve"],"constraints":{}},{"capability":"jobs.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"jobs.wip","actions":["view","edit","post","export"],"constraints":{}},{"capability":"mdm.customers","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.items","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"mdm.vendors","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.clients","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"onb.conversion","actions":["view","approve","post"],"constraints":{}},{"capability":"onb.imports","actions":["view","create","post"],"constraints":{}},{"capability":"onb.wizard","actions":["view","edit"],"constraints":{}},{"capability":"pay.batches","actions":["view","create","edit","approve","release","export"],"constraints":{}},{"capability":"pay.checks","actions":["view","create","edit","post"],"constraints":{}},{"capability":"pay.customer_payments","actions":["view","create","edit","post"],"constraints":{}},{"capability":"pay.refunds","actions":["view","create","approve","release"],"constraints":{}},{"capability":"payroll.employees","actions":["view","create","edit"],"constraints":{}},{"capability":"payroll.register","actions":["view","create","post"],"constraints":{}},{"capability":"payroll.remittances","actions":["view","create","release"],"constraints":{}},{"capability":"payroll.runs","actions":["view","create","edit","approve","release"],"constraints":{}},{"capability":"payroll.settings","actions":["view","configure"],"constraints":{}},{"capability":"portal.client","actions":["view","configure"],"constraints":{}},{"capability":"portal.customer","actions":["view","release","configure"],"constraints":{}},{"capability":"portal.vendor","actions":["view","release","configure"],"constraints":{}},{"capability":"reports.board_package","actions":["view","create","approve","release"],"constraints":{}},{"capability":"reports.financial","actions":["view","export"],"constraints":{}},{"capability":"reports.packs","actions":["view","create","edit","release"],"constraints":{}},{"capability":"reports.saved_views","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"req.client_requests","actions":["view","create","edit","release"],"constraints":{}},{"capability":"revrec.methods","actions":["view","edit","configure"],"constraints":{}},{"capability":"revrec.runs","actions":["view","create","post"],"constraints":{}},{"capability":"revrec.schedules","actions":["view","export"],"constraints":{}},{"capability":"tax.1099","actions":["view","create","edit","export"],"constraints":{}},{"capability":"tax.filings","actions":["view","create","approve","release"],"constraints":{}},{"capability":"tax.provision","actions":["view","create","edit","post"],"constraints":{}},{"capability":"tax.sales_tax","actions":["view","edit","post","configure"],"constraints":{}},{"capability":"ws.assignments","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"ws.client_health","actions":["view"],"constraints":{}}]},
  {"key":"legacy_full_books","name":"Legacy full books (company_admin)","description":"Everything the old company admin role could do in the books, beyond Tenant admin. Flagged for the first access review.","audience":"internal_staff","field_policy":{"comp":"visible"},"max_assignment_days":null,"is_envelope":false,"is_sealed":false,"grants":[{"capability":"ap.bills","actions":["create","edit","delete","approve"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["create","edit","delete","approve"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["create","approve"],"constraints":{}},{"capability":"ar.collections","actions":["edit","release"],"constraints":{}},{"capability":"ar.credit_memos","actions":["create","approve","post"],"constraints":{}},{"capability":"ar.deposits","actions":["create","post"],"constraints":{}},{"capability":"ar.estimates","actions":["create","edit","delete","release"],"constraints":{}},{"capability":"ar.invoices","actions":["create","edit","approve","post","release"],"constraints":{}},{"capability":"ar.recurring","actions":["create","edit","delete"],"constraints":{}},{"capability":"ar.statements","actions":["release"],"constraints":{}},{"capability":"ar.write_offs","actions":["create","approve","post"],"constraints":{}},{"capability":"bank.reconciliations","actions":["create","edit","approve"],"constraints":{}},{"capability":"bank.rules","actions":["create","edit","delete"],"constraints":{}},{"capability":"bank.statements","actions":["create"],"constraints":{}},{"capability":"bank.transactions","actions":["edit","approve"],"constraints":{}},{"capability":"cards.transactions","actions":["edit","approve"],"constraints":{}},{"capability":"cash.forecast","actions":["create","edit"],"constraints":{}},{"capability":"cash.obligations","actions":["create","edit"],"constraints":{}},{"capability":"close.checklist","actions":["edit","approve"],"constraints":{}},{"capability":"ctl.compliance","actions":["edit","approve"],"constraints":{}},{"capability":"ctl.exceptions","actions":["edit"],"constraints":{}},{"capability":"ctl.pbc","actions":["create","edit","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["edit","approve"],"constraints":{}},{"capability":"exp.receipts","actions":["create","edit","approve"],"constraints":{}},{"capability":"fa.assets","actions":["create","edit","post"],"constraints":{}},{"capability":"fa.leases","actions":["create","edit","post"],"constraints":{}},{"capability":"fa.prepaids","actions":["create","edit","post"],"constraints":{}},{"capability":"fpa.budgets","actions":["export"],"constraints":{}},{"capability":"fpa.profitability","actions":["export"],"constraints":{}},{"capability":"gl.accounts","actions":["create","approve"],"constraints":{}},{"capability":"gl.intercompany","actions":["create","edit","post"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["create","edit","release"],"constraints":{}},{"capability":"gl.journal_entries","actions":["create","edit","delete","post"],"constraints":{}},{"capability":"gl.periods","actions":["edit","approve"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["create","edit","post"],"constraints":{}},{"capability":"jobs.change_orders","actions":["create"],"constraints":{}},{"capability":"jobs.jobs","actions":["create","edit"],"constraints":{}},{"capability":"jobs.wip","actions":["edit"],"constraints":{}},{"capability":"mdm.customers","actions":["create","edit"],"constraints":{}},{"capability":"mdm.vendors","actions":["create","edit"],"constraints":{}},{"capability":"onb.conversion","actions":["approve","post"],"constraints":{}},{"capability":"onb.imports","actions":["create","post"],"constraints":{}},{"capability":"pay.batches","actions":["create","edit","approve","release"],"constraints":{}},{"capability":"pay.checks","actions":["create","edit"],"constraints":{}},{"capability":"pay.customer_payments","actions":["create","edit","post"],"constraints":{}},{"capability":"pay.provider_connections","actions":["view","configure"],"constraints":{}},{"capability":"pay.vendor_bank_details","actions":["edit"],"constraints":{}},{"capability":"payroll.employees","actions":["edit"],"constraints":{}},{"capability":"payroll.register","actions":["create","post"],"constraints":{}},{"capability":"payroll.runs","actions":["create","edit","approve","release"],"constraints":{}},{"capability":"reports.saved_views","actions":["create","edit","delete"],"constraints":{}},{"capability":"revrec.methods","actions":["edit"],"constraints":{}},{"capability":"revrec.runs","actions":["create","post"],"constraints":{}}]},
  {"key":"legacy_controller_release","name":"Legacy controller release","description":"Money release the old controller role held. Flagged for the first access review.","audience":"internal_staff","field_policy":{},"max_assignment_days":null,"is_envelope":false,"is_sealed":false,"grants":[{"capability":"pay.batches","actions":["release"],"constraints":{}},{"capability":"payroll.runs","actions":["release"],"constraints":{}}]},
  {"key":"payroll_comp_visibility","name":"Payroll comp visibility","description":"See individual pay.","audience":"internal_staff","field_policy":{"comp":"visible"},"max_assignment_days":null,"is_envelope":false,"is_sealed":false,"grants":[{"capability":"payroll.employees","actions":["view"],"constraints":{}},{"capability":"payroll.register","actions":["view"],"constraints":{}},{"capability":"payroll.runs","actions":["view"],"constraints":{}}]},
  {"key":"consolidation_manage","name":"Consolidation manage","description":"Manage consolidation groups, eliminations and statements.","audience":"internal_staff","field_policy":{},"max_assignment_days":null,"is_envelope":false,"is_sealed":false,"grants":[{"capability":"consol.eliminations","actions":["view","create","post"],"constraints":{}},{"capability":"consol.groups","actions":["view","create","edit","delete","configure"],"constraints":{}},{"capability":"consol.statements","actions":["view","export"],"constraints":{}}]},
  {"key":"emergency_finance_access","name":"Emergency finance access (template)","description":"Sealed: activated by a named person plus a second person; expires after 4 hours.","audience":"internal_staff","field_policy":{},"max_assignment_days":1,"is_envelope":false,"is_sealed":true,"grants":[{"capability":"ap.bills","actions":["view","approve"],"constraints":{}},{"capability":"pay.batches","actions":["view","approve","release"],"constraints":{}},{"capability":"payroll.runs","actions":["view","approve","release"],"constraints":{}}]}
]$seed$::jsonb);
-- END GENERATED permission_sets

do $$
declare o record;
begin
  for o in select id from core.organizations loop
    perform core.rbac_import_tenant_permission_sets(o.id);
  end loop;
end $$;
