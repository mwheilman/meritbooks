-- =============================================================================
-- Migration 166: access governance — access log, access reviews, access requests,
--                template-update suggestions, time-box sweeper
--                (05-RBAC-SPEC §1.7, §3.7, §4.2, §5.5, §5.7 R-9 / R-10, §6.8, §6.9, §6.11) — wave 2D
-- =============================================================================
-- core.access_change_log   APPEND-ONLY record of every access change (05 §5.5, hard rule H7).
--   id, seq (stable order), org_id, at, actor_user_id, actor_context (tenant |
--   system:sweeper | system:backfill | …), source (ui | api | backfill | template_update |
--   review | request | sweeper | system), event ('assignment.grant', 'role.publish', …),
--   subject_type, subject_id, affected_membership_ids[], location_ids[], all_clients,
--   before jsonb, after jsonb, reason, approval_ref, sod_exception_id, request_ip.
--   * Rows are written ONLY by SECURITY DEFINER triggers/functions in this file. Nobody —
--     anon, authenticated or service_role — holds INSERT / UPDATE / DELETE / TRUNCATE; an
--     immutability trigger refuses UPDATE / DELETE / TRUNCATE even for the table owner.
--   * org_id / actor_user_id carry NO foreign key on purpose: history must survive a deleted
--     user or tenant, and a cascade must never be blocked by (or erase) the log.
--   * Triggers on core.access_assignments, core.role_definitions, core.role_versions,
--     core.permission_sets, core.permission_set_versions and core.client_access_policies:
--     no access-changing write escapes the log. Draft-grant edits are not access changes
--     (published grants are immutable, mig 158/159); a publish logs the full adds/removes.
--   * Attribution: definer RPCs set transaction-local context (core.access_set_context —
--     actor / source / reason / ip / approval ref). Writers that don't go through an RPC are
--     attributed from the row: new columns access_assignments.changed_by / change_reason,
--     else granted_by / approved_by / published_by.
--   * Readable by tenant admins and holders of ctl.audit_trail:view (RLS, via
--     core.access_caller_may_read_log). App-originated events (CSV export, view-as, field
--     reveal) go through core.access_log_append (allow-listed events, service_role only).
--
-- core.access_reviews / core.access_review_items   recertification campaigns (05 §6.8)
--   campaign: name, scope (all | client | role), reviewer default, due date, status
--   (draft | open | closed), auto_revoke_unreviewed, summary on close.
--   item: assignment snapshot + evidence, reviewer, decision (keep | reduce | revoke |
--   delegate), decided_by / at. A REVOKE ends the assignment immediately (effective_to =
--   now, status revoked) inside core.access_review_decide (definer). Nobody reviews their
--   own access (H1).
--
-- core.access_requests   request access / JIT (05 §1.5, §6.11)
--   kind capability | role | permission_set | client; status pending | approved | denied |
--   expired | cancelled. Approval runs THE DELEGATION CEILING (05 §4.2, as far as wave-1 data
--   allows — core.access_ceiling_violation): the approver holds core.access.assignments:create
--   on the scope, holds every requested capability/action there with limits ≥ the grant's,
--   the role's assignable band admits them, the grant cannot outlast their own time box, and
--   they are not the requester (H1). Tenant admins are the root of trust (§4.2). High-risk
--   grants (release, core.access.*, vendor bank details edit, AI autonomy configure, limit
--   > $100k or unlimited money approval) are created PENDING and need a second grantor.
--   A capability request is fulfilled through a reusable tenant permission set
--   "Requested access: <capability>" (time-boxed assignment).
--
-- core.template_updates   R-10: when a platform template publishes a new version, every
--   derived tenant STANDARD role gets one row of suggested changes (add | remove | constraint)
--   — only changes that would actually alter that role. Nothing applies until a tenant admin
--   acts: each change is Added (into the role's Proposed changes = its single draft version,
--   created on demand) or Skipped; Keep current = skip all (no version is created). The
--   draft is published normally (optionally right away). UI words: Current / Proposed only.
--
-- core.expire_access(org)  time-boxed grants (05 §3.7): assignments past effective_to →
--   'expired' (logged as source sweeper), stale pending requests → 'expired'. Called by the
--   scheduler job access.expiry_sweep (lib/scheduler/jobs/access-jobs.ts).
--
-- RLS on every new table: members SELECT their tenant's rows (scoped further to admins /
-- reviewers / requesters); writes service_role only (154 pattern); every function
-- EXECUTE-revoked from public/anon/authenticated and granted to service_role (M1 lesson),
-- except the read-only caller helpers RLS needs. Idempotent. PGlite-compatible.
-- =============================================================================

-- ── 0. Attribution columns on assignments ────────────────────────────────────
alter table core.access_assignments add column if not exists changed_by uuid;
alter table core.access_assignments add column if not exists change_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'access_assignments_changed_by_fkey') then
    alter table core.access_assignments add constraint access_assignments_changed_by_fkey
      foreign key (changed_by) references core.users(id) on delete set null;
  end if;
end $$;
comment on column core.access_assignments.changed_by is
  '05 §5.5: who made the latest change (writers set it on every update; the access log records it).';

-- ── 1. The access log ────────────────────────────────────────────────────────
create table if not exists core.access_change_log (
  id                      uuid primary key default gen_random_uuid(),
  seq                     bigint generated always as identity,
  org_id                  uuid not null,
  at                      timestamptz not null default clock_timestamp(),
  actor_user_id           uuid,
  actor_context           text not null default 'tenant',
  source                  text not null default 'api',
  event                   text not null,
  subject_type            text not null,
  subject_id              uuid,
  affected_membership_ids uuid[] not null default '{}',
  location_ids            uuid[] not null default '{}',
  all_clients             boolean not null default false,
  before                  jsonb,
  after                   jsonb,
  reason                  text,
  approval_ref            text,
  sod_exception_id        uuid,
  request_ip              text,
  constraint access_change_log_source_chk check (source in
    ('ui', 'api', 'backfill', 'template_update', 'review', 'request', 'sweeper', 'system')),
  constraint access_change_log_event_chk check (event ~ '^[a-z_]+\.[a-z_]+$'),
  constraint access_change_log_subject_chk check (subject_type in
    ('assignment', 'role', 'permission_set', 'client_policy', 'access_review', 'access_review_item',
     'access_request', 'template_update', 'export', 'session', 'field'))
);
create unique index if not exists uq_access_change_log_seq on core.access_change_log (seq);
create index if not exists idx_access_change_log_org_at on core.access_change_log (org_id, at desc);
create index if not exists idx_access_change_log_subject on core.access_change_log (subject_id);
create index if not exists idx_access_change_log_members on core.access_change_log using gin (affected_membership_ids);
create index if not exists idx_access_change_log_locations on core.access_change_log using gin (location_ids);
comment on table core.access_change_log is
  '05 §5.5 / H7: append-only access history. Written only by definer triggers/functions; nobody may update, delete or truncate it.';

create or replace function core.access_change_log_immutable() returns trigger
  language plpgsql as
$$
begin
  raise exception 'H7: the access log is append-only (% refused)', tg_op using errcode = 'insufficient_privilege';
end
$$;
drop trigger if exists trg_access_change_log_immutable on core.access_change_log;
create trigger trg_access_change_log_immutable before update or delete on core.access_change_log
  for each row execute function core.access_change_log_immutable();
drop trigger if exists trg_access_change_log_no_truncate on core.access_change_log;
create trigger trg_access_change_log_no_truncate before truncate on core.access_change_log
  for each statement execute function core.access_change_log_immutable();

-- ── 2. Transaction-local attribution context ─────────────────────────────────
create or replace function core.access_ctx(p_key text) returns text
  language sql stable as
$$ select nullif(current_setting('meritbooks.access_' || p_key, true), '') $$;

create or replace function core.access_set_context(
  p_actor uuid, p_source text, p_reason text, p_ip text default null, p_approval_ref text default null)
returns void language plpgsql as
$$
begin
  perform set_config('meritbooks.access_actor', coalesce(p_actor::text, ''), true);
  perform set_config('meritbooks.access_source', coalesce(p_source, ''), true);
  perform set_config('meritbooks.access_reason', coalesce(p_reason, ''), true);
  perform set_config('meritbooks.access_ip', coalesce(p_ip, ''), true);
  perform set_config('meritbooks.access_approval_ref', coalesce(p_approval_ref, ''), true);
end
$$;

-- The one writer. Context (set by a definer RPC in this transaction) wins over row hints.
create or replace function core.access_log_write(
  p_org uuid, p_event text, p_subject_type text, p_subject_id uuid,
  p_affected uuid[], p_locations uuid[], p_all_clients boolean,
  p_before jsonb, p_after jsonb,
  p_actor uuid default null, p_reason text default null, p_source text default null,
  p_actor_context text default null)
returns uuid language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_id uuid; v_source text; v_actor uuid;
begin
  if p_org is null then return null; end if; -- platform-level rows (templates) are not tenant history
  v_source := coalesce(core.access_ctx('source'), p_source, 'api');
  v_actor := coalesce(core.access_ctx('actor')::uuid, p_actor);
  insert into core.access_change_log
    (org_id, actor_user_id, actor_context, source, event, subject_type, subject_id,
     affected_membership_ids, location_ids, all_clients, before, after, reason, approval_ref, request_ip)
  values (p_org, v_actor,
          coalesce(p_actor_context, case v_source when 'sweeper' then 'system:sweeper'
                                                  when 'backfill' then 'system:backfill'
                                                  when 'system' then 'system' else 'tenant' end),
          v_source, p_event, p_subject_type, p_subject_id,
          coalesce(array(select distinct x from unnest(p_affected) x where x is not null), '{}'),
          coalesce(array(select distinct x from unnest(p_locations) x where x is not null), '{}'),
          coalesce(p_all_clients, false), p_before, p_after,
          coalesce(core.access_ctx('reason'), p_reason), core.access_ctx('approval_ref'), core.access_ctx('ip'))
  returning id into v_id;
  return v_id;
end
$$;

-- App-originated events (exports, view-as, field reveals). Allow-listed; service_role only.
create or replace function core.access_log_append(
  p_org uuid, p_actor uuid, p_event text, p_subject_type text, p_subject_id uuid,
  p_affected uuid[], p_locations uuid[], p_after jsonb, p_reason text, p_ip text default null)
returns uuid language plpgsql security definer set search_path = core, public, pg_temp as
$$
begin
  if p_event not in ('log.export', 'review.export', 'view_as.start', 'view_as.end', 'field.reveal',
                     'emergency.activate', 'emergency.end', 'break_glass.start', 'break_glass.end') then
    raise exception 'event % cannot be appended by the app', p_event using errcode = 'check_violation';
  end if;
  perform core.access_set_context(p_actor, 'ui', p_reason, p_ip, null);
  return core.access_log_write(p_org, p_event, p_subject_type, p_subject_id, p_affected, p_locations,
                               false, null, p_after, p_actor, p_reason, 'ui');
end
$$;

-- ── 3. Readable snapshots ────────────────────────────────────────────────────
create or replace function core.access_assignment_snapshot(a core.access_assignments) returns jsonb
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select jsonb_build_object(
    'membership_id', a.membership_id, 'grant_type', a.grant_type,
    'role_id', a.role_id, 'permission_set_id', a.permission_set_id,
    'source_key', coalesce(rd.key, ps.key), 'source_name', coalesce(rd.name, ps.name),
    'scope_type', a.scope_type, 'location_id', a.location_id, 'location_name', l.name,
    'client_set_id', a.client_set_id, 'client_set_name', cs.name, 'group_id', a.group_id,
    'read_only', a.read_only, 'muted', a.muted, 'constraint_overrides', a.constraint_overrides,
    'effective_from', a.effective_from, 'effective_to', a.effective_to, 'status', a.status,
    'source', a.source, 'reason', a.reason, 'granted_by', a.granted_by, 'approved_by', a.approved_by)
  from (select 1) one
  left join core.role_definitions rd on rd.id = a.role_id
  left join core.permission_sets ps on ps.id = a.permission_set_id
  left join core.locations l on l.id = a.location_id
  left join core.client_sets cs on cs.id = a.client_set_id
$$;

create or replace function core.access_assignment_locations(a core.access_assignments) returns uuid[]
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select case a.scope_type
           when 'client' then array[a.location_id]
           when 'client_set' then coalesce((select array_agg(m.location_id) from core.client_set_members m where m.set_id = a.client_set_id), '{}')
           else '{}'::uuid[] end
$$;

-- ── 4. Log triggers ──────────────────────────────────────────────────────────
create or replace function core.access_log_assignment_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_event text; v_actor uuid; v_reason text; v_source text; r core.access_assignments%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if tg_op = 'INSERT' then
    v_event := case when new.status = 'pending_approval' then 'assignment.grant_pending' else 'assignment.grant' end;
    v_actor := coalesce(new.changed_by, new.granted_by);
    v_reason := coalesce(new.change_reason, new.reason);
    v_source := case new.source when 'backfill' then 'backfill' when 'jit_request' then 'request' end;
  elsif tg_op = 'DELETE' then
    v_event := 'assignment.delete';
  else
    if new.status is distinct from old.status then
      v_event := case new.status
                   when 'revoked' then 'assignment.revoke'
                   when 'expired' then 'assignment.expire'
                   when 'suspended' then 'assignment.suspend'
                   when 'active' then case when old.status = 'pending_approval' then 'assignment.approve' else 'assignment.reinstate' end
                   else 'assignment.status' end;
    elsif new.effective_to is distinct from old.effective_to then
      v_event := case when new.effective_to is not null and new.effective_to <= now() then 'assignment.end'
                      when old.effective_to is null then 'assignment.time_box'
                      when new.effective_to is null or new.effective_to > old.effective_to then 'assignment.extend'
                      else 'assignment.shorten' end;
    elsif new.muted is distinct from old.muted then
      v_event := 'assignment.mute';
    elsif new.read_only is distinct from old.read_only then
      v_event := 'assignment.read_only';
    elsif new.constraint_overrides is distinct from old.constraint_overrides then
      v_event := 'assignment.limit_change';
    elsif (new.role_id, new.permission_set_id, new.scope_type, new.location_id, new.client_set_id, new.group_id,
           new.effective_from, new.approved_by, new.sod_exception_ids, new.grant_type)
          is distinct from
          (old.role_id, old.permission_set_id, old.scope_type, old.location_id, old.client_set_id, old.group_id,
           old.effective_from, old.approved_by, old.sod_exception_ids, old.grant_type) then
      v_event := 'assignment.update';
    else
      return null; -- attribution / timestamp only: not an access change
    end if;
    v_actor := case when new.changed_by is distinct from old.changed_by then new.changed_by
                    when v_event = 'assignment.approve' then new.approved_by end;
    v_reason := case when new.change_reason is distinct from old.change_reason then new.change_reason end;
  end if;

  perform core.access_log_write(
    r.org_id, v_event, 'assignment', r.id,
    array[r.membership_id], core.access_assignment_locations(r), r.scope_type = 'all_clients',
    case when tg_op = 'INSERT' then null else core.access_assignment_snapshot(old) end,
    case when tg_op = 'DELETE' then null else core.access_assignment_snapshot(new) end,
    v_actor, v_reason, v_source);
  return null;
end
$$;
drop trigger if exists trg_access_assignments_log on core.access_assignments;
create trigger trg_access_assignments_log after insert or update or delete on core.access_assignments
  for each row execute function core.access_log_assignment_trg();

-- Role definitions + permission sets (metadata, lifecycle).
create or replace function core.access_log_source_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  v_new jsonb; v_old jsonb; v_kind text; v_event text; v_id uuid; v_org uuid; v_affected uuid[];
  v_ignore text[] := array['updated_at', 'current_version', 'upstream_version', 'created_at', 'home_template_id'];
begin
  v_new := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_kind := case tg_table_name when 'role_definitions' then 'role' else 'permission_set' end;
  v_id := coalesce(v_new->>'id', v_old->>'id')::uuid;
  v_org := coalesce(v_new->>'org_id', v_old->>'org_id')::uuid;
  if v_org is null then return null; end if; -- platform templates: see core.template_updates
  if tg_op = 'INSERT' then
    v_event := v_kind || '.create';
  elsif tg_op = 'DELETE' then
    v_event := v_kind || '.delete';
  elsif (v_new->>'status') is distinct from (v_old->>'status') then
    v_event := v_kind || '.' || case v_new->>'status' when 'archived' then 'archive' when 'deprecated' then 'deprecate'
                                                    when 'active' then 'activate' else 'status' end;
  elsif (v_new - v_ignore) is distinct from (v_old - v_ignore) then
    v_event := v_kind || '.update';
  else
    return null;
  end if;
  select coalesce(array_agg(distinct a.membership_id), '{}') into v_affected
    from core.access_assignments a
   where (a.role_id = v_id or a.permission_set_id = v_id) and a.status in ('active', 'pending_approval', 'suspended');
  perform core.access_log_write(v_org, v_event, v_kind, v_id, v_affected,
    case when coalesce(v_new->>'location_id', v_old->>'location_id') is not null
         then array[coalesce(v_new->>'location_id', v_old->>'location_id')::uuid] else '{}'::uuid[] end,
    false, v_old - v_ignore, v_new - v_ignore,
    case when tg_op = 'INSERT' then (v_new->>'created_by')::uuid end, null, null);
  return null;
end
$$;
drop trigger if exists trg_role_definitions_log on core.role_definitions;
create trigger trg_role_definitions_log after insert or update or delete on core.role_definitions
  for each row execute function core.access_log_source_trg();
drop trigger if exists trg_permission_sets_log on core.permission_sets;
create trigger trg_permission_sets_log after insert or update or delete on core.permission_sets
  for each row execute function core.access_log_source_trg();

-- Grants of one specific version (any state) as JSON.
create or replace function core.access_version_grants(p_kind text, p_version_id uuid) returns jsonb
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select coalesce(jsonb_agg(jsonb_build_object('capability', x.capability, 'actions', to_jsonb(x.actions), 'constraints', x.constraints)
                            order by x.capability), '[]'::jsonb)
    from (select g.capability, g.actions, g.constraints from core.role_grants g
           where p_kind = 'role' and g.role_version_id = p_version_id
          union all
          select g.capability, g.actions, g.constraints from core.permission_set_grants g
           where p_kind = 'permission_set' and g.permission_set_version_id = p_version_id) x
$$;

-- (capability, action) pairs in a but not in b.
create or replace function core.access_grants_minus_pairs(a jsonb, b jsonb) returns jsonb
  language sql immutable as
$$
  select coalesce(jsonb_agg(jsonb_build_object('capability', p.cap, 'action', p.act) order by p.cap, p.act), '[]'::jsonb)
    from (select e->>'capability' cap, jsonb_array_elements_text(e->'actions') act
            from jsonb_array_elements(coalesce(a, '[]'::jsonb)) e) p
   where not exists (select 1 from jsonb_array_elements(coalesce(b, '[]'::jsonb)) f
                      where f->>'capability' = p.cap and (f->'actions') ? p.act)
$$;

-- Version publishes (roles + permission sets): the access change itself.
create or replace function core.access_log_version_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  v_kind text; v_parent uuid; v_org uuid; v_loc uuid; v_prev uuid; v_prev_version int;
  v_new_grants jsonb; v_prev_grants jsonb; v_affected uuid[];
begin
  if not ((tg_op = 'INSERT' and new.state = 'published') or (tg_op = 'UPDATE' and old.state = 'draft' and new.state = 'published')) then
    return null;
  end if;
  if tg_table_name = 'role_versions' then
    v_kind := 'role';
    v_parent := (to_jsonb(new)->>'role_id')::uuid;
    select org_id, location_id into v_org, v_loc from core.role_definitions where id = v_parent;
    select id, version into v_prev, v_prev_version from core.role_versions
     where role_id = v_parent and id <> new.id and version < new.version and state in ('published', 'superseded')
     order by version desc limit 1;
  else
    v_kind := 'permission_set';
    v_parent := (to_jsonb(new)->>'permission_set_id')::uuid;
    select org_id, location_id into v_org, v_loc from core.permission_sets where id = v_parent;
    select id, version into v_prev, v_prev_version from core.permission_set_versions
     where permission_set_id = v_parent and id <> new.id and version < new.version and state in ('published', 'superseded')
     order by version desc limit 1;
  end if;
  if v_org is null then return null; end if;
  v_new_grants := core.access_version_grants(v_kind, new.id);
  v_prev_grants := case when v_prev is null then '[]'::jsonb else core.access_version_grants(v_kind, v_prev) end;
  select coalesce(array_agg(distinct a.membership_id), '{}') into v_affected
    from core.access_assignments a
   where (a.role_id = v_parent or a.permission_set_id = v_parent) and a.status in ('active', 'pending_approval', 'suspended');
  perform core.access_log_write(v_org, v_kind || '.publish', v_kind, v_parent, v_affected,
    case when v_loc is null then '{}'::uuid[] else array[v_loc] end, false,
    jsonb_build_object('version', v_prev_version),
    jsonb_build_object('version', new.version,
                       'adds', core.access_grants_minus_pairs(v_new_grants, v_prev_grants),
                       'removes', core.access_grants_minus_pairs(v_prev_grants, v_new_grants)),
    new.published_by, new.reason, null);
  return null;
end
$$;
drop trigger if exists trg_role_versions_log on core.role_versions;
create trigger trg_role_versions_log after insert or update on core.role_versions
  for each row execute function core.access_log_version_trg();
drop trigger if exists trg_permission_set_versions_log on core.permission_set_versions;
create trigger trg_permission_set_versions_log after insert or update on core.permission_set_versions
  for each row execute function core.access_log_version_trg();

-- Client envelopes / client-role enablement.
create or replace function core.access_log_policy_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_new jsonb; v_old jsonb; v_ignore text[] := array['updated_at', 'created_at', 'updated_by'];
begin
  v_new := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  if tg_op = 'UPDATE' and (v_new - v_ignore) is not distinct from (v_old - v_ignore) then return null; end if;
  perform core.access_log_write(
    coalesce(v_new->>'org_id', v_old->>'org_id')::uuid,
    case tg_op when 'INSERT' then 'envelope.create' when 'DELETE' then 'envelope.delete' else 'envelope.change' end,
    'client_policy', coalesce(v_new->>'location_id', v_old->>'location_id')::uuid, '{}',
    array[coalesce(v_new->>'location_id', v_old->>'location_id')::uuid], false,
    v_old - v_ignore, v_new - v_ignore, (v_new->>'updated_by')::uuid, null, null);
  return null;
end
$$;
drop trigger if exists trg_client_access_policies_log on core.client_access_policies;
create trigger trg_client_access_policies_log after insert or update or delete on core.client_access_policies
  for each row execute function core.access_log_policy_trg();

-- ── 5. Who holds what (governance-local resolver; mirrors lib/rbac/effective-access.ts) ──
-- Tenant context = p_location null (only all_clients / tenant assignments count).
-- Returns {allowed, unlimited, limit_cents, ends_at (null = open-ended), trace[]}.
create or replace function core.access_holds(p_membership uuid, p_location uuid, p_capability text, p_action text)
returns jsonb language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare
  m record; a record; g record;
  v_allowed boolean := false; v_unlimited boolean := false; v_limit numeric := null;
  v_open boolean := false; v_ends timestamptz := null; v_trace jsonb := '[]'::jsonb;
  v_applies text[]; v_lim numeric; v_ov numeric; v_al jsonb; v_oal jsonb;
begin
  select ms.id, ms.org_id, ms.status, ms.audience into m from core.memberships ms where ms.id = p_membership;
  if m.id is null or coalesce(m.status, 'active') <> 'active' then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'reason', 'membership_inactive');
  end if;
  if not core.capability_has_action(p_capability, p_action) then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'reason', 'unknown_capability');
  end if;
  for a in
    select x.id, x.grant_type, x.read_only, x.muted, x.constraint_overrides, x.effective_to,
           coalesce(rd.audience, ps.audience) as src_audience, coalesce(rd.owner_level, ps.owner_level) as src_owner,
           coalesce(rd.location_id, ps.location_id) as src_location, coalesce(rd.name, ps.name) as src_name,
           coalesce(rv.id, sv.id) as version_id
      from core.access_assignments x
      left join core.role_definitions rd on rd.id = x.role_id
      left join core.permission_sets ps on ps.id = x.permission_set_id
      left join core.role_versions rv on rv.role_id = x.role_id and rv.state = 'published'
      left join core.permission_set_versions sv on sv.permission_set_id = x.permission_set_id and sv.state = 'published'
     where x.membership_id = p_membership and x.status = 'active'
       and x.effective_from <= now() and (x.effective_to is null or x.effective_to > now())
       and (case when p_location is null then x.scope_type in ('all_clients', 'tenant')
                 else x.scope_type = 'all_clients'
                   or (x.scope_type = 'client' and x.location_id = p_location)
                   or (x.scope_type = 'client_set' and exists (
                         select 1 from core.client_set_members csm
                          where csm.set_id = x.client_set_id and csm.location_id = p_location))
            end)
  loop
    continue when a.version_id is null;
    for g in
      select rg.actions, rg.constraints from core.role_grants rg
       where a.grant_type = 'role' and rg.role_version_id = a.version_id and rg.capability = p_capability
      union all
      select sg.actions, sg.constraints from core.permission_set_grants sg
       where a.grant_type = 'permission_set' and sg.permission_set_version_id = a.version_id and sg.capability = p_capability
    loop
      continue when not (p_action = any (g.actions) or (p_action = 'view' and cardinality(g.actions) > 0));
      continue when a.read_only and p_action not in ('view', 'export');
      continue when coalesce(a.muted -> p_capability, '[]'::jsonb) ? p_action;
      continue when core.rbac_grant_violation(a.src_audience, p_capability, array[p_action]) is not null;
      continue when m.audience = 'external' and core.rbac_grant_violation('external', p_capability, array[p_action]) is not null;
      continue when a.src_owner = 'client' and not core.rbac_within_envelope(m.org_id, a.src_location, p_capability, array[p_action]);
      -- amount limit (tighten-only override, 05 §3.4)
      v_al := g.constraints -> 'amount_limit';
      v_oal := a.constraint_overrides -> 'amount_limit';
      v_applies := case when coalesce(v_oal, v_al) ? 'applies_to'
                        then array(select jsonb_array_elements_text(coalesce(v_oal, v_al) -> 'applies_to'))
                        else array['approve', 'post', 'release'] end;
      v_lim := (v_al ->> 'max_per_item_cents')::numeric;
      v_ov := (v_oal ->> 'max_per_item_cents')::numeric;
      v_lim := case when v_lim is null then v_ov when v_ov is null then v_lim else least(v_lim, v_ov) end;
      v_allowed := true;
      if v_lim is null or not (p_action = any (v_applies)) then
        v_unlimited := true;
      else
        v_limit := greatest(coalesce(v_limit, v_lim), v_lim);
      end if;
      if a.effective_to is null then v_open := true; else v_ends := greatest(coalesce(v_ends, a.effective_to), a.effective_to); end if;
      v_trace := v_trace || jsonb_build_object('assignment_id', a.id, 'source', a.src_name);
    end loop;
  end loop;
  return jsonb_build_object(
    'allowed', v_allowed, 'unlimited', v_allowed and v_unlimited,
    'limit_cents', case when v_allowed and not v_unlimited then v_limit end,
    'ends_at', case when v_allowed and not v_open then v_ends end,
    'trace', v_trace);
end
$$;

-- Holder of the standard Tenant admin role across the tenant (05 §4.2 root of trust).
create or replace function core.access_is_tenant_admin(p_membership uuid) returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select exists (
    select 1 from core.memberships ms
      join core.access_assignments x on x.membership_id = ms.id
      join core.role_definitions rd on rd.id = x.role_id
     where ms.id = p_membership and coalesce(ms.status, 'active') = 'active'
       and x.status = 'active' and x.effective_from <= now() and (x.effective_to is null or x.effective_to > now())
       and x.scope_type in ('all_clients', 'tenant')
       and rd.owner_level = 'tenant' and rd.org_id = ms.org_id and rd.key = 'tenant_admin' and rd.status <> 'archived')
$$;

create or replace function core.access_member_holds(p_membership uuid, p_capability text, p_action text) returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as
$$ select coalesce((core.access_holds(p_membership, null, p_capability, p_action) ->> 'allowed')::boolean, false) $$;

-- The caller's (JWT sub) active membership in a tenant — for RLS.
create or replace function core.access_caller_membership(p_org uuid) returns uuid
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select m.id from core.memberships m join core.users u on u.id = m.user_id
   where m.org_id = p_org and coalesce(m.status, 'active') = 'active'
     and u.clerk_user_id = (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
   limit 1
$$;

create or replace function core.access_caller_may_read_log(p_org uuid) returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_m uuid;
begin
  v_m := core.access_caller_membership(p_org);
  if v_m is null then return false; end if;
  return core.access_is_tenant_admin(v_m)
      or core.access_member_holds(v_m, 'ctl.audit_trail', 'view')
      or core.access_member_holds(v_m, 'core.access.reviews', 'view');
end
$$;

create or replace function core.access_caller_is_access_admin(p_org uuid, p_capability text) returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_m uuid;
begin
  v_m := core.access_caller_membership(p_org);
  if v_m is null then return false; end if;
  return core.access_is_tenant_admin(v_m) or core.access_member_holds(v_m, p_capability, 'view');
end
$$;

-- Current grants of a role / permission set.
create or replace function core.access_source_grants(p_grant_type text, p_source uuid) returns jsonb
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select case when p_grant_type = 'role' then core.rbac_role_current_grants(p_source)
              else core.rbac_set_current_grants(p_source) end
$$;

-- ── 6. The delegation ceiling (05 §4.2) ──────────────────────────────────────
-- null = the grantor may create this assignment; else a plain-English reason.
create or replace function core.access_ceiling_violation(
  p_grantor_membership uuid, p_grantee_membership uuid, p_grants jsonb, p_band text,
  p_scope_type text, p_location uuid, p_effective_to timestamptz)
returns text language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare
  gm record; ge record; e jsonb; act text; h jsonb; v_ctx uuid; v_req numeric; v_applies text[]; v_where text;
begin
  select ms.id, ms.org_id, ms.user_id, ms.status into gm from core.memberships ms where ms.id = p_grantor_membership;
  select ms.id, ms.org_id, ms.user_id into ge from core.memberships ms where ms.id = p_grantee_membership;
  if gm.id is null or coalesce(gm.status, 'active') <> 'active' then return 'You have no active seat in this workspace.'; end if;
  if ge.id is null or ge.org_id <> gm.org_id then return 'That person is not in this workspace.'; end if;
  if gm.user_id = ge.user_id then return 'Nobody may grant access to themselves.'; end if;
  if p_scope_type not in ('all_clients', 'client', 'tenant') then return 'This kind of scope cannot be granted here.'; end if;
  v_ctx := case when p_scope_type = 'client' then p_location end;
  v_where := case when v_ctx is null then 'across all clients' else 'on this client' end;

  if core.access_is_tenant_admin(p_grantor_membership) then
    return null; -- root of trust; high-risk second approval is applied by the caller
  end if;
  if p_band = 'tenant_admin_only' then return 'Only a tenant admin can grant this role.'; end if;

  h := core.access_holds(p_grantor_membership, v_ctx, 'core.access.assignments', 'create');
  if not coalesce((h ->> 'allowed')::boolean, false) then
    return format('You cannot grant access %s.', v_where);
  end if;
  if h ->> 'ends_at' is not null and (p_effective_to is null or p_effective_to > (h ->> 'ends_at')::timestamptz) then
    return format('Your own access to grant ends %s; this grant cannot outlast it.', to_char((h ->> 'ends_at')::timestamptz, 'Mon DD, YYYY'));
  end if;

  for e in select * from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) loop
    for act in select jsonb_array_elements_text(e -> 'actions') loop
      h := core.access_holds(p_grantor_membership, v_ctx, e ->> 'capability', act);
      if not coalesce((h ->> 'allowed')::boolean, false) then
        return format('You do not hold %s (%s) %s, so you cannot grant it.', e ->> 'capability', act, v_where);
      end if;
      v_applies := case when (e -> 'constraints' -> 'amount_limit') ? 'applies_to'
                        then array(select jsonb_array_elements_text(e -> 'constraints' -> 'amount_limit' -> 'applies_to'))
                        else array['approve', 'post', 'release'] end;
      if act = any (v_applies) and not coalesce((h ->> 'unlimited')::boolean, false) then
        v_req := (e -> 'constraints' -> 'amount_limit' ->> 'max_per_item_cents')::numeric;
        if v_req is null or v_req > (h ->> 'limit_cents')::numeric then
          return format('This grant allows %s on %s above your own limit.', act, e ->> 'capability');
        end if;
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- 05 §4.2 item 6: grants that need a second grantor.
create or replace function core.access_is_high_risk(p_grants jsonb) returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select exists (
    select 1 from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) e
      left join core.capabilities c on c.key = e ->> 'capability'
     where (e -> 'actions') ? 'release'
        or (e ->> 'capability') like 'core.access.%'
        or ((e ->> 'capability') = 'pay.vendor_bank_details' and (e -> 'actions') ? 'edit')
        or ((e ->> 'capability') = 'ai.autonomy' and (e -> 'actions') ? 'configure')
        or coalesce((e -> 'constraints' -> 'amount_limit' ->> 'max_per_item_cents')::numeric, 0) > 10000000
        or ((e -> 'actions') ? 'approve' and 'money' = any (coalesce(c.tags, '{}'))
            and not ((e -> 'constraints') ? 'amount_limit')))
$$;

-- ── 7. Access requests ───────────────────────────────────────────────────────
create table if not exists core.access_requests (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  requester_membership_id  uuid not null references core.memberships(id) on delete cascade,
  kind                     text not null,
  capability               text references core.capabilities(key),
  actions                  text[] not null default '{}',
  role_id                  uuid references core.role_definitions(id) on delete cascade,
  permission_set_id        uuid references core.permission_sets(id) on delete cascade,
  location_id              uuid references core.locations(id) on delete cascade,
  duration_days            int,
  reason                   text not null,
  routed_to_membership_ids uuid[] not null default '{}',
  status                   text not null default 'pending',
  decided_by               uuid references core.users(id) on delete set null,
  decided_at               timestamptz,
  decision_note            text,
  assignment_id            uuid references core.access_assignments(id) on delete set null,
  needs_second_approval    boolean not null default false,
  second_approved_by       uuid references core.users(id) on delete set null,
  expires_at               timestamptz not null default (now() + interval '14 days'),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint access_requests_kind_chk check (kind in ('capability', 'role', 'permission_set', 'client')),
  constraint access_requests_shape_chk check (
       (kind = 'capability'     and capability is not null and cardinality(actions) > 0 and role_id is null and permission_set_id is null)
    or (kind = 'role'           and role_id is not null and capability is null and permission_set_id is null)
    or (kind = 'permission_set' and permission_set_id is not null and capability is null and role_id is null)
    or (kind = 'client'         and location_id is not null and capability is null and permission_set_id is null)),
  constraint access_requests_actions_chk check (actions <@ core.rbac_actions()),
  constraint access_requests_duration_chk check (duration_days is null or duration_days between 1 and 365),
  constraint access_requests_reason_chk check (length(btrim(reason)) between 3 and 2000),
  constraint access_requests_status_chk check (status in ('pending', 'approved', 'denied', 'expired', 'cancelled'))
);
create index if not exists idx_access_requests_org_status on core.access_requests (org_id, status, created_at desc);
create index if not exists idx_access_requests_requester on core.access_requests (requester_membership_id);
create index if not exists idx_access_requests_routed on core.access_requests using gin (routed_to_membership_ids);
comment on table core.access_requests is
  '05 R-9 / §6.11: request access (capability, role, permission set or client). Decided only through core.access_request_decide (delegation ceiling).';

-- What an approval would grant: vehicle + grants + band + forced max days.
create or replace function core.access_request_plan(p_request uuid, p_role_override uuid default null,
  out grant_type text, out source_id uuid, out grants jsonb, out band text, out max_days int, out problem text)
language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare r core.access_requests%rowtype; v_role uuid;
begin
  select * into r from core.access_requests where id = p_request;
  if not found then problem := 'Request not found.'; return; end if;
  if r.kind = 'capability' then
    grant_type := 'permission_set';
    grants := jsonb_build_array(jsonb_build_object('capability', r.capability, 'actions', to_jsonb(r.actions), 'constraints', '{}'::jsonb));
    band := 'managers';
    max_days := null;
    return;
  end if;
  if r.kind = 'permission_set' then
    grant_type := 'permission_set'; source_id := r.permission_set_id;
    select ps.assignable_band, ps.max_assignment_days into band, max_days from core.permission_sets ps where ps.id = r.permission_set_id;
  else
    v_role := coalesce(p_role_override, r.role_id);
    if v_role is null then
      select ms.role_definition_id into v_role from core.memberships ms where ms.id = r.requester_membership_id;
    end if;
    if v_role is null then problem := 'Choose a role to grant on this client.'; return; end if;
    if not exists (select 1 from core.role_definitions rd where rd.id = v_role and rd.org_id = r.org_id
                     and rd.owner_level in ('tenant', 'client') and rd.status in ('active', 'draft')) then
      problem := 'That role is not available in this workspace.'; return;
    end if;
    grant_type := 'role'; source_id := v_role;
    select rd.assignable_band, rd.max_assignment_days into band, max_days from core.role_definitions rd where rd.id = v_role;
  end if;
  grants := core.access_source_grants(grant_type, source_id);
end
$$;

-- Who could decide this request now (tenant admins + anyone the ceiling admits).
create or replace function core.access_request_route(p_request uuid) returns uuid[]
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare r core.access_requests%rowtype; p record; m record; v_out uuid[] := '{}'; v_to timestamptz;
begin
  select * into r from core.access_requests where id = p_request;
  if not found then return v_out; end if;
  select * into p from core.access_request_plan(p_request);
  v_to := case when r.duration_days is not null then now() + make_interval(days => r.duration_days) end;
  for m in select ms.id from core.memberships ms
            where ms.org_id = r.org_id and coalesce(ms.status, 'active') = 'active' and ms.id <> r.requester_membership_id loop
    if core.access_is_tenant_admin(m.id)
       or (p.problem is null and core.access_ceiling_violation(m.id, r.requester_membership_id, p.grants, p.band,
             case when r.location_id is null then 'all_clients' else 'client' end, r.location_id, v_to) is null) then
      v_out := v_out || m.id;
    end if;
  end loop;
  return v_out;
end
$$;

create or replace function core.access_request_create(
  p_org uuid, p_requester_user uuid, p_kind text, p_capability text, p_actions text[],
  p_role uuid, p_permission_set uuid, p_location uuid, p_duration_days int, p_reason text, p_ip text default null)
returns uuid language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_m uuid; v_id uuid; v_act text; v_all boolean := true;
begin
  select ms.id into v_m from core.memberships ms
   where ms.org_id = p_org and ms.user_id = p_requester_user and coalesce(ms.status, 'active') = 'active';
  if v_m is null then raise exception 'You have no active seat in this workspace.' using errcode = 'insufficient_privilege'; end if;
  if p_location is not null and not exists (select 1 from core.locations l where l.id = p_location and l.org_id = p_org) then
    raise exception 'That client is not in this workspace.' using errcode = 'check_violation';
  end if;
  if p_role is not null and not exists (select 1 from core.role_definitions rd where rd.id = p_role and rd.org_id = p_org and rd.status = 'active') then
    raise exception 'That role is not available in this workspace.' using errcode = 'check_violation';
  end if;
  if p_permission_set is not null and not exists (select 1 from core.permission_sets ps where ps.id = p_permission_set and ps.org_id = p_org
                                                    and ps.status = 'active' and not ps.is_envelope and not ps.is_sealed) then
    raise exception 'That permission set cannot be requested.' using errcode = 'check_violation';
  end if;
  if p_kind = 'capability' then
    if p_actions is null or cardinality(p_actions) = 0 then
      raise exception 'Say what you need to do.' using errcode = 'check_violation';
    end if;
    foreach v_act in array p_actions loop
      if not core.capability_has_action(p_capability, v_act) then
        raise exception 'Unknown capability or action: % %', p_capability, v_act using errcode = 'check_violation';
      end if;
      if not coalesce((core.access_holds(v_m, p_location, p_capability, v_act) ->> 'allowed')::boolean, false) then v_all := false; end if;
    end loop;
    if v_all then raise exception 'You already have this access.' using errcode = 'check_violation'; end if;
    if exists (select 1 from core.capabilities c where c.key = p_capability and c.platform_only) then
      raise exception 'Platform capabilities cannot be requested.' using errcode = 'check_violation';
    end if;
  end if;

  -- One open request per thing: return the existing one instead of a duplicate.
  select id into v_id from core.access_requests
   where requester_membership_id = v_m and status = 'pending' and kind = p_kind
     and capability is not distinct from p_capability and role_id is not distinct from p_role
     and permission_set_id is not distinct from p_permission_set and location_id is not distinct from p_location
     and expires_at > now();
  if v_id is not null then return v_id; end if;

  insert into core.access_requests (org_id, requester_membership_id, kind, capability, actions, role_id,
                                    permission_set_id, location_id, duration_days, reason)
  values (p_org, v_m, p_kind, p_capability,
          coalesce(array(select a from unnest(core.rbac_actions()) a where a = any (coalesce(p_actions, '{}'))), '{}'),
          p_role, p_permission_set, p_location, p_duration_days, btrim(p_reason))
  returning id into v_id;
  update core.access_requests set routed_to_membership_ids = core.access_request_route(v_id) where id = v_id;

  perform core.access_set_context(p_requester_user, 'request', p_reason, p_ip, 'request:' || v_id);
  perform core.access_log_write(p_org, 'request.create', 'access_request', v_id, array[v_m],
    case when p_location is null then '{}'::uuid[] else array[p_location] end, p_location is null, null,
    (select to_jsonb(r) - 'routed_to_membership_ids' from core.access_requests r where r.id = v_id),
    p_requester_user, p_reason, 'request');
  return v_id;
end
$$;

-- Reusable tenant permission set that carries one requested capability.
create or replace function core.access_ensure_capability_set(p_org uuid, p_capability text, p_actions text[]) returns uuid
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_key text; v_id uuid; v_label text; v_acts text[];
begin
  v_acts := array(select a from unnest(core.rbac_actions()) a where a = any (p_actions));
  v_key := 'req_' || replace(p_capability, '.', '_') || '_' || array_to_string(v_acts, '_');
  select id into v_id from core.permission_sets where owner_level = 'tenant' and org_id = p_org and key = v_key;
  if v_id is not null then return v_id; end if;
  select label into v_label from core.capabilities where key = p_capability;
  insert into core.permission_sets (owner_level, org_id, key, name, description, kind, audience, status)
  values ('tenant', p_org, v_key, 'Requested access: ' || coalesce(v_label, p_capability) || ' (' || array_to_string(v_acts, ', ') || ')',
          'Created to fulfil access requests for this capability. Granted time-boxed, one person at a time.',
          'custom', 'internal_staff', 'active')
  returning id into v_id;
  perform core.rbac_publish_set_grants(v_id,
    jsonb_build_array(jsonb_build_object('capability', p_capability, 'actions', to_jsonb(v_acts), 'constraints', '{}'::jsonb)),
    'Created for an access request');
  return v_id;
end
$$;

-- Approve or deny. Approval creates the assignment under the delegation ceiling.
create or replace function core.access_request_decide(
  p_request uuid, p_decider_user uuid, p_decision text, p_note text,
  p_role_override uuid default null, p_duration_days int default null, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  r core.access_requests%rowtype; p record; v_dm uuid; v_violation text; v_to timestamptz; v_days int;
  v_source uuid; v_asg uuid; v_high boolean; v_scope text;
begin
  select * into r from core.access_requests where id = p_request for update;
  if not found then raise exception 'Request not found.' using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then raise exception 'This request was already %.', r.status using errcode = 'check_violation'; end if;
  if r.expires_at <= now() then
    update core.access_requests set status = 'expired', updated_at = now() where id = r.id;
    raise exception 'This request expired.' using errcode = 'check_violation';
  end if;
  if p_decision not in ('approve', 'deny') then raise exception 'Decision must be approve or deny.' using errcode = 'check_violation'; end if;
  select ms.id into v_dm from core.memberships ms
   where ms.org_id = r.org_id and ms.user_id = p_decider_user and coalesce(ms.status, 'active') = 'active';
  if v_dm is null then raise exception 'You have no active seat in this workspace.' using errcode = 'insufficient_privilege'; end if;
  if v_dm = r.requester_membership_id then
    raise exception 'H1: nobody may decide their own access request.' using errcode = 'insufficient_privilege';
  end if;

  select * into p from core.access_request_plan(p_request, p_role_override);
  v_scope := case when r.location_id is null then 'all_clients' else 'client' end;
  v_days := coalesce(p_duration_days, r.duration_days);
  if p.max_days is not null then v_days := least(coalesce(v_days, p.max_days), p.max_days); end if;
  v_to := case when v_days is not null then now() + make_interval(days => v_days) end;

  if p.problem is not null then
    if p_decision = 'approve' or not core.access_is_tenant_admin(v_dm) then
      raise exception '%', p.problem using errcode = 'check_violation';
    end if;
  else
    v_violation := core.access_ceiling_violation(v_dm, r.requester_membership_id, p.grants, p.band, v_scope, r.location_id, v_to);
    if v_violation is not null then
      raise exception 'Delegation ceiling: %', v_violation using errcode = 'insufficient_privilege';
    end if;
  end if;

  perform core.access_set_context(p_decider_user, 'request', coalesce(nullif(btrim(p_note), ''), r.reason), p_ip, 'request:' || r.id);

  if p_decision = 'deny' then
    update core.access_requests
       set status = 'denied', decided_by = p_decider_user, decided_at = now(), decision_note = p_note, updated_at = now()
     where id = r.id;
    perform core.access_log_write(r.org_id, 'request.deny', 'access_request', r.id, array[r.requester_membership_id],
      case when r.location_id is null then '{}'::uuid[] else array[r.location_id] end, r.location_id is null,
      null, jsonb_build_object('status', 'denied', 'note', p_note), p_decider_user, p_note, 'request');
    return jsonb_build_object('status', 'denied');
  end if;

  v_source := coalesce(p.source_id, core.access_ensure_capability_set(r.org_id, r.capability, r.actions));
  v_high := core.access_is_high_risk(p.grants);
  insert into core.access_assignments (org_id, membership_id, grant_type, role_id, permission_set_id, scope_type,
                                       location_id, effective_to, status, granted_by, reason, source,
                                       changed_by, change_reason)
  values (r.org_id, r.requester_membership_id, p.grant_type,
          case when p.grant_type = 'role' then v_source end,
          case when p.grant_type = 'permission_set' then v_source end,
          v_scope, r.location_id, v_to,
          case when v_high then 'pending_approval' else 'active' end,
          p_decider_user, 'Access request: ' || r.reason, 'jit_request', p_decider_user, p_note)
  returning id into v_asg;

  update core.access_requests
     set status = 'approved', decided_by = p_decider_user, decided_at = now(), decision_note = p_note,
         assignment_id = v_asg, needs_second_approval = v_high, updated_at = now(),
         role_id = case when kind = 'client' and p.grant_type = 'role' then v_source else role_id end
   where id = r.id;
  perform core.access_log_write(r.org_id, 'request.approve', 'access_request', r.id, array[r.requester_membership_id],
    case when r.location_id is null then '{}'::uuid[] else array[r.location_id] end, r.location_id is null,
    null, jsonb_build_object('status', 'approved', 'assignment_id', v_asg, 'needs_second_approval', v_high,
                             'effective_to', v_to, 'note', p_note), p_decider_user, p_note, 'request');
  return jsonb_build_object('status', 'approved', 'assignment_id', v_asg, 'needs_second_approval', v_high, 'effective_to', v_to);
end
$$;

-- Second grantor for a high-risk approval (must differ from grantor and grantee; ceiling re-run).
create or replace function core.access_request_confirm(p_request uuid, p_user uuid, p_ip text default null) returns jsonb
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare r core.access_requests%rowtype; a core.access_assignments%rowtype; v_m uuid; p record; v_violation text;
begin
  select * into r from core.access_requests where id = p_request for update;
  if not found or r.status <> 'approved' or not r.needs_second_approval or r.assignment_id is null then
    raise exception 'Nothing is waiting for a second approval on this request.' using errcode = 'check_violation';
  end if;
  select * into a from core.access_assignments where id = r.assignment_id for update;
  if a.status <> 'pending_approval' then raise exception 'This access is already %.', a.status using errcode = 'check_violation'; end if;
  if a.granted_by = p_user then raise exception 'H1: the second approver must differ from the first.' using errcode = 'insufficient_privilege'; end if;
  select ms.id into v_m from core.memberships ms where ms.org_id = r.org_id and ms.user_id = p_user and coalesce(ms.status, 'active') = 'active';
  if v_m is null then raise exception 'You have no active seat in this workspace.' using errcode = 'insufficient_privilege'; end if;
  select * into p from core.access_request_plan(p_request, case when a.grant_type = 'role' then a.role_id end);
  v_violation := core.access_ceiling_violation(v_m, r.requester_membership_id,
    core.access_source_grants(a.grant_type, coalesce(a.role_id, a.permission_set_id)), coalesce(p.band, 'managers'),
    a.scope_type, a.location_id, a.effective_to);
  if v_violation is not null then raise exception 'Delegation ceiling: %', v_violation using errcode = 'insufficient_privilege'; end if;
  perform core.access_set_context(p_user, 'request', 'Second approval', p_ip, 'request:' || r.id);
  update core.access_assignments set status = 'active', approved_by = p_user, changed_by = p_user,
         change_reason = 'Second approval' where id = a.id;
  update core.access_requests set second_approved_by = p_user, updated_at = now() where id = r.id;
  perform core.access_log_write(r.org_id, 'request.confirm', 'access_request', r.id, array[r.requester_membership_id],
    case when r.location_id is null then '{}'::uuid[] else array[r.location_id] end, r.location_id is null,
    null, jsonb_build_object('assignment_id', a.id, 'status', 'active'), p_user, 'Second approval', 'request');
  return jsonb_build_object('status', 'active', 'assignment_id', a.id);
end
$$;

create or replace function core.access_request_cancel(p_request uuid, p_user uuid) returns void
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare r core.access_requests%rowtype;
begin
  select * into r from core.access_requests where id = p_request for update;
  if not found or r.status <> 'pending' then raise exception 'Only an open request can be withdrawn.' using errcode = 'check_violation'; end if;
  if not exists (select 1 from core.memberships ms where ms.id = r.requester_membership_id and ms.user_id = p_user) then
    raise exception 'Only the requester can withdraw a request.' using errcode = 'insufficient_privilege';
  end if;
  update core.access_requests set status = 'cancelled', decided_by = p_user, decided_at = now(), updated_at = now() where id = r.id;
  perform core.access_set_context(p_user, 'request', 'Withdrawn by the requester', null, 'request:' || r.id);
  perform core.access_log_write(r.org_id, 'request.cancel', 'access_request', r.id, array[r.requester_membership_id],
    '{}', false, null, jsonb_build_object('status', 'cancelled'), p_user, null, 'request');
end
$$;

-- ── 8. Access reviews ────────────────────────────────────────────────────────
create table if not exists core.access_reviews (
  id                         uuid primary key default gen_random_uuid(),
  org_id                     uuid not null references core.organizations(id) on delete cascade,
  name                       text not null,
  scope                      jsonb not null default '{"kind": "all"}'::jsonb,
  scope_kind                 text not null default 'all',
  location_id                uuid references core.locations(id) on delete set null,
  role_id                    uuid references core.role_definitions(id) on delete set null,
  period_start               date,
  period_end                 date,
  due_at                     timestamptz not null,
  status                     text not null default 'open',
  auto_revoke_unreviewed     boolean not null default false,
  default_reviewer_membership_id uuid references core.memberships(id) on delete set null,
  created_by                 uuid references core.users(id) on delete set null,
  created_at                 timestamptz not null default now(),
  closed_at                  timestamptz,
  closed_by                  uuid references core.users(id) on delete set null,
  summary                    jsonb,
  constraint access_reviews_name_chk check (length(btrim(name)) between 1 and 200),
  constraint access_reviews_scope_kind_chk check (scope_kind in ('all', 'client', 'role')),
  constraint access_reviews_scope_shape_chk check (
       (scope_kind = 'all') or (scope_kind = 'client' and location_id is not null) or (scope_kind = 'role' and role_id is not null)),
  constraint access_reviews_status_chk check (status in ('draft', 'open', 'closed'))
);
create index if not exists idx_access_reviews_org on core.access_reviews (org_id, created_at desc);

create table if not exists core.access_review_items (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  review_id               uuid not null references core.access_reviews(id) on delete cascade,
  reviewer_membership_id  uuid references core.memberships(id) on delete set null,
  subject_kind            text not null default 'assignment',
  subject_id              uuid not null,
  membership_id           uuid references core.memberships(id) on delete set null,
  snapshot                jsonb not null default '{}'::jsonb,
  evidence                jsonb not null default '{}'::jsonb,
  decision                text,
  decision_note           text,
  decided_by              uuid references core.users(id) on delete set null,
  decided_at              timestamptz,
  applied_at              timestamptz,
  created_at              timestamptz not null default now(),
  unique (review_id, subject_kind, subject_id),
  constraint access_review_items_kind_chk check (subject_kind in
    ('assignment', 'permission_set', 'sod_exception', 'dormant_access', 'unused_capability')),
  constraint access_review_items_decision_chk check (decision is null or decision in ('keep', 'reduce', 'revoke', 'delegate')),
  constraint access_review_items_decided_chk check ((decision is null) = (decided_at is null))
);
create index if not exists idx_access_review_items_review on core.access_review_items (review_id);
create index if not exists idx_access_review_items_reviewer on core.access_review_items (reviewer_membership_id);

create or replace function core.access_review_start(
  p_org uuid, p_actor_user uuid, p_name text, p_scope_kind text, p_location uuid, p_role uuid,
  p_due_at timestamptz, p_reviewer_membership uuid default null, p_auto_revoke boolean default false)
returns uuid language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_actor_m uuid; v_review uuid; a record; v_reviewer uuid; v_grantor_m uuid; v_n int := 0;
begin
  select ms.id into v_actor_m from core.memberships ms
   where ms.org_id = p_org and ms.user_id = p_actor_user and coalesce(ms.status, 'active') = 'active';
  if v_actor_m is null then raise exception 'You have no active seat in this workspace.' using errcode = 'insufficient_privilege'; end if;
  if not (core.access_is_tenant_admin(v_actor_m) or core.access_member_holds(v_actor_m, 'core.access.reviews', 'create')) then
    raise exception 'You cannot start access reviews.' using errcode = 'insufficient_privilege';
  end if;
  if p_due_at is null or p_due_at <= now() then raise exception 'Pick a due date in the future.' using errcode = 'check_violation'; end if;
  if p_location is not null and not exists (select 1 from core.locations l where l.id = p_location and l.org_id = p_org) then
    raise exception 'That client is not in this workspace.' using errcode = 'check_violation';
  end if;
  if p_role is not null and not exists (select 1 from core.role_definitions rd where rd.id = p_role and rd.org_id = p_org) then
    raise exception 'That role is not in this workspace.' using errcode = 'check_violation';
  end if;
  if p_reviewer_membership is not null and not exists (
       select 1 from core.memberships ms where ms.id = p_reviewer_membership and ms.org_id = p_org and coalesce(ms.status, 'active') = 'active') then
    raise exception 'The reviewer is not an active member of this workspace.' using errcode = 'check_violation';
  end if;

  perform core.access_set_context(p_actor_user, 'review', p_name, null, null);
  insert into core.access_reviews (org_id, name, scope, scope_kind, location_id, role_id, period_start, period_end,
                                   due_at, status, auto_revoke_unreviewed, default_reviewer_membership_id, created_by)
  values (p_org, btrim(p_name),
          jsonb_build_object('kind', p_scope_kind, 'location_id', p_location, 'role_id', p_role),
          p_scope_kind, case when p_scope_kind = 'client' then p_location end, case when p_scope_kind = 'role' then p_role end,
          (now() - interval '90 days')::date, now()::date, p_due_at, 'open', coalesce(p_auto_revoke, false),
          p_reviewer_membership, p_actor_user)
  returning id into v_review;

  for a in
    select x.*, u.first_name, u.last_name, u.email
      from core.access_assignments x
      join core.memberships ms on ms.id = x.membership_id
      join core.users u on u.id = ms.user_id
     where x.org_id = p_org and x.status in ('active', 'suspended')
       and (x.effective_to is null or x.effective_to > now())
       and (p_scope_kind = 'all'
         or (p_scope_kind = 'role' and x.role_id = p_role)
         or (p_scope_kind = 'client' and (x.scope_type = 'all_clients'
               or (x.scope_type = 'client' and x.location_id = p_location)
               or (x.scope_type = 'client_set' and exists (select 1 from core.client_set_members m
                                                            where m.set_id = x.client_set_id and m.location_id = p_location)))))
  loop
    -- Reviewer: chosen reviewer → the grantor → the campaign owner. Never the person under review (H1).
    select ms.id into v_grantor_m from core.memberships ms
     where ms.org_id = p_org and ms.user_id = a.granted_by and coalesce(ms.status, 'active') = 'active';
    v_reviewer := coalesce(p_reviewer_membership, v_grantor_m, v_actor_m);
    if v_reviewer = a.membership_id then
      v_reviewer := case when v_actor_m <> a.membership_id then v_actor_m end;
    end if;
    insert into core.access_review_items (org_id, review_id, reviewer_membership_id, subject_kind, subject_id, membership_id, snapshot, evidence)
    values (p_org, v_review, v_reviewer, 'assignment', a.id, a.membership_id,
            core.access_assignment_snapshot((select x2 from core.access_assignments x2 where x2.id = a.id))
              || jsonb_build_object('person_name', nullif(btrim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')), ''),
                                    'person_email', a.email),
            jsonb_build_object('granted_at', a.created_at, 'granted_by', a.granted_by, 'source', a.source,
                               'reason', a.reason, 'effective_to', a.effective_to,
                               'legacy', a.source = 'backfill',
                               'ends_within_30_days', a.effective_to is not null and a.effective_to < now() + interval '30 days'))
    on conflict (review_id, subject_kind, subject_id) do nothing;
    v_n := v_n + 1;
  end loop;

  perform core.access_log_write(p_org, 'review.start', 'access_review', v_review, '{}',
    case when p_location is null then '{}'::uuid[] else array[p_location] end, p_scope_kind = 'all', null,
    jsonb_build_object('name', p_name, 'scope_kind', p_scope_kind, 'location_id', p_location, 'role_id', p_role,
                       'due_at', p_due_at, 'items', v_n, 'auto_revoke_unreviewed', p_auto_revoke),
    p_actor_user, p_name, 'review');
  return v_review;
end
$$;

-- End an assignment now (shared by review revoke and close auto-revoke).
create or replace function core.access_end_assignment(p_assignment uuid, p_actor uuid, p_reason text) returns void
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare a core.access_assignments%rowtype;
begin
  select * into a from core.access_assignments where id = p_assignment for update;
  if not found or a.status in ('revoked', 'expired') then return; end if;
  update core.access_assignments
     set status = 'revoked',
         effective_to = case when a.effective_from < now() and (a.effective_to is null or a.effective_to > now()) then now() else a.effective_to end,
         changed_by = p_actor, change_reason = p_reason
   where id = p_assignment;
end
$$;

create or replace function core.access_review_decide(
  p_item uuid, p_user uuid, p_decision text, p_note text, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare i core.access_review_items%rowtype; rv core.access_reviews%rowtype; v_m uuid; v_applied boolean := false;
begin
  select * into i from core.access_review_items where id = p_item for update;
  if not found then raise exception 'Review item not found.' using errcode = 'no_data_found'; end if;
  select * into rv from core.access_reviews where id = i.review_id;
  if rv.status <> 'open' then raise exception 'This review is closed.' using errcode = 'check_violation'; end if;
  if p_decision not in ('keep', 'reduce', 'revoke', 'delegate') then
    raise exception 'Decision must be keep, reduce, revoke or delegate.' using errcode = 'check_violation';
  end if;
  if i.decision = 'revoke' then raise exception 'This access was already revoked.' using errcode = 'check_violation'; end if;
  select ms.id into v_m from core.memberships ms
   where ms.org_id = i.org_id and ms.user_id = p_user and coalesce(ms.status, 'active') = 'active';
  if v_m is null then raise exception 'You have no active seat in this workspace.' using errcode = 'insufficient_privilege'; end if;
  if v_m = i.membership_id then raise exception 'H1: nobody reviews their own access.' using errcode = 'insufficient_privilege'; end if;
  if not (i.reviewer_membership_id = v_m or core.access_is_tenant_admin(v_m)
          or core.access_member_holds(v_m, 'core.access.reviews', 'approve')) then
    raise exception 'This item is assigned to another reviewer.' using errcode = 'insufficient_privilege';
  end if;
  if p_decision in ('reduce', 'delegate') and coalesce(btrim(p_note), '') = '' then
    raise exception 'Say what should change.' using errcode = 'check_violation';
  end if;

  perform core.access_set_context(p_user, 'review', coalesce(nullif(btrim(p_note), ''), 'Access review: ' || p_decision),
                                  p_ip, 'review:' || rv.id);
  if p_decision = 'revoke' and i.subject_kind = 'assignment' then
    perform core.access_end_assignment(i.subject_id, p_user, coalesce(nullif(btrim(p_note), ''), 'Revoked in access review: ' || rv.name));
    v_applied := true;
  end if;
  update core.access_review_items
     set decision = p_decision, decision_note = nullif(btrim(p_note), ''), decided_by = p_user, decided_at = now(),
         applied_at = case when v_applied then now() end
   where id = i.id;
  perform core.access_log_write(i.org_id, 'review.decision', 'access_review_item', i.id, array[i.membership_id],
    core.access_assignment_locations((select x from core.access_assignments x where x.id = i.subject_id)),
    coalesce(i.snapshot ->> 'scope_type', '') = 'all_clients',
    jsonb_build_object('decision', i.decision),
    jsonb_build_object('decision', p_decision, 'note', p_note, 'review_id', rv.id, 'assignment_id', i.subject_id, 'applied', v_applied),
    p_user, p_note, 'review');
  return jsonb_build_object('decision', p_decision, 'applied', v_applied);
end
$$;

create or replace function core.access_review_close(p_review uuid, p_user uuid, p_ip text default null) returns jsonb
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare rv core.access_reviews%rowtype; v_m uuid; i record; v_summary jsonb; v_auto int := 0;
begin
  select * into rv from core.access_reviews where id = p_review for update;
  if not found then raise exception 'Review not found.' using errcode = 'no_data_found'; end if;
  if rv.status = 'closed' then raise exception 'This review is already closed.' using errcode = 'check_violation'; end if;
  select ms.id into v_m from core.memberships ms
   where ms.org_id = rv.org_id and ms.user_id = p_user and coalesce(ms.status, 'active') = 'active';
  if v_m is null or not (core.access_is_tenant_admin(v_m) or core.access_member_holds(v_m, 'core.access.reviews', 'create')) then
    raise exception 'You cannot close access reviews.' using errcode = 'insufficient_privilege';
  end if;
  perform core.access_set_context(p_user, 'review', 'Access review closed: ' || rv.name, p_ip, 'review:' || rv.id);
  if rv.auto_revoke_unreviewed then
    for i in select * from core.access_review_items where review_id = rv.id and decision is null and subject_kind = 'assignment' loop
      perform core.access_end_assignment(i.subject_id, p_user, 'Not reviewed by the due date: ' || rv.name);
      update core.access_review_items
         set decision = 'revoke', decision_note = 'Auto-revoked: not reviewed', decided_by = p_user, decided_at = now(), applied_at = now()
       where id = i.id;
      v_auto := v_auto + 1;
    end loop;
  end if;
  select jsonb_build_object(
           'items', count(*),
           'kept', count(*) filter (where decision = 'keep'),
           'reduced', count(*) filter (where decision = 'reduce'),
           'revoked', count(*) filter (where decision = 'revoke'),
           'delegated', count(*) filter (where decision = 'delegate'),
           'undecided', count(*) filter (where decision is null),
           'auto_revoked', v_auto,
           'reviewers', count(distinct decided_by),
           'closed_late', now() > rv.due_at)
    into v_summary
    from core.access_review_items where review_id = rv.id;
  update core.access_reviews set status = 'closed', closed_at = now(), closed_by = p_user, summary = v_summary where id = rv.id;
  perform core.access_log_write(rv.org_id, 'review.close', 'access_review', rv.id, '{}', '{}', false,
    null, v_summary, p_user, null, 'review');
  return v_summary;
end
$$;

-- ── 9. Template-update suggestions (R-10) ────────────────────────────────────
create table if not exists core.template_updates (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  template_id       uuid not null references core.role_definitions(id) on delete cascade,
  derived_role_id   uuid not null references core.role_definitions(id) on delete cascade,
  from_version      int,
  to_version        int not null,
  changes           jsonb not null default '[]'::jsonb,
  decisions         jsonb not null default '{}'::jsonb,
  status            text not null default 'available',
  adopted_changes   jsonb not null default '[]'::jsonb,
  draft_version     int,
  note_dismissed_at timestamptz,
  decided_by        uuid references core.users(id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (derived_role_id, to_version),
  constraint template_updates_status_chk check (status in ('available', 'adopted', 'partially_adopted', 'dismissed', 'superseded')),
  constraint template_updates_changes_chk check (jsonb_typeof(changes) = 'array' and jsonb_typeof(decisions) = 'object')
);
create index if not exists idx_template_updates_org on core.template_updates (org_id, status);
comment on table core.template_updates is
  '05 R-10: MeritBooks suggestions for tenant roles derived from a platform template. Optional; nothing applies until a tenant admin adds it.';

-- Grants of a specific version NUMBER of a role.
create or replace function core.template_version_grants(p_role uuid, p_version int) returns jsonb
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select coalesce((select core.access_version_grants('role', v.id) from core.role_versions v
                    where v.role_id = p_role and v.version = p_version), '[]'::jsonb)
$$;

-- Suggested changes = template old → new, limited to what would change the tenant role.
create or replace function core.template_diff(p_old jsonb, p_new jsonb, p_current jsonb) returns jsonb
  language plpgsql immutable as
$$
declare
  v_caps text[]; c text; o jsonb; n jsonb; cur jsonb; oa text[]; na text[]; ca text[];
  v_add text[]; v_rem text[]; v_out jsonb := '[]'::jsonb;
begin
  select array_agg(distinct k order by k) into v_caps
    from (select e ->> 'capability' k from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) e
          union select e ->> 'capability' from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) e) s;
  foreach c in array coalesce(v_caps, '{}'::text[]) loop
    select e into o from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) e where e ->> 'capability' = c limit 1;
    select e into n from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) e where e ->> 'capability' = c limit 1;
    select e into cur from jsonb_array_elements(coalesce(p_current, '[]'::jsonb)) e where e ->> 'capability' = c limit 1;
    oa := array(select jsonb_array_elements_text(coalesce(o -> 'actions', '[]'::jsonb)));
    na := array(select jsonb_array_elements_text(coalesce(n -> 'actions', '[]'::jsonb)));
    ca := array(select jsonb_array_elements_text(coalesce(cur -> 'actions', '[]'::jsonb)));
    v_add := array(select x from unnest(core.rbac_actions()) x where x = any (na) and not x = any (oa) and not x = any (ca));
    v_rem := array(select x from unnest(core.rbac_actions()) x where x = any (oa) and not x = any (na) and x = any (ca));
    if cardinality(v_add) > 0 then
      v_out := v_out || jsonb_build_object('id', c || ':add', 'kind', 'add', 'capability', c,
                                           'actions', to_jsonb(v_add), 'constraints', coalesce(n -> 'constraints', '{}'::jsonb));
    end if;
    if cardinality(v_rem) > 0 then
      v_out := v_out || jsonb_build_object('id', c || ':remove', 'kind', 'remove', 'capability', c, 'actions', to_jsonb(v_rem));
    end if;
    if o is not null and n is not null and cur is not null
       and coalesce(o -> 'constraints', '{}'::jsonb) is distinct from coalesce(n -> 'constraints', '{}'::jsonb)
       and coalesce(cur -> 'constraints', '{}'::jsonb) is distinct from coalesce(n -> 'constraints', '{}'::jsonb) then
      v_out := v_out || jsonb_build_object('id', c || ':constraint', 'kind', 'constraint', 'capability', c,
                                           'before', coalesce(cur -> 'constraints', '{}'::jsonb),
                                           'after', coalesce(n -> 'constraints', '{}'::jsonb));
    end if;
  end loop;
  return v_out;
end
$$;

create or replace function core.template_updates_generate(p_template uuid) returns integer
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare t core.role_definitions%rowtype; d record; v_changes jsonb; v_n int := 0; v_id uuid;
begin
  select * into t from core.role_definitions where id = p_template and owner_level = 'platform';
  if not found or t.current_version is null then return 0; end if;
  for d in
    select rd.* from core.role_definitions rd
     where rd.upstream_template_id = t.id and rd.owner_level = 'tenant' and rd.kind = 'standard'
       and rd.status <> 'archived' and rd.upstream_version is not null and rd.upstream_version < t.current_version
  loop
    if exists (select 1 from core.template_updates where derived_role_id = d.id and to_version = t.current_version) then
      continue;
    end if;
    v_changes := core.template_diff(core.template_version_grants(t.id, d.upstream_version),
                                    core.template_version_grants(t.id, t.current_version),
                                    core.rbac_role_current_grants(d.id));
    if jsonb_array_length(v_changes) = 0 then
      update core.role_definitions set upstream_version = t.current_version where id = d.id; -- nothing to suggest
      continue;
    end if;
    -- A newer batch replaces older, unanswered suggestions for the same role.
    update core.template_updates set status = 'superseded', updated_at = now()
     where derived_role_id = d.id and decided_at is null and status in ('available', 'partially_adopted');
    insert into core.template_updates (org_id, template_id, derived_role_id, from_version, to_version, changes)
    values (d.org_id, t.id, d.id, d.upstream_version, t.current_version, v_changes)
    returning id into v_id;
    perform core.access_log_write(d.org_id, 'template_update.suggest', 'template_update', v_id, '{}', '{}', false,
      null, jsonb_build_object('role_id', d.id, 'role_name', d.name, 'changes', v_changes), null, null, 'system');
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

create or replace function core.template_updates_on_publish_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
begin
  if new.owner_level = 'platform' and new.current_version is distinct from old.current_version then
    perform core.template_updates_generate(new.id);
  end if;
  return null;
end
$$;
drop trigger if exists trg_role_definitions_template_updates on core.role_definitions;
create trigger trg_role_definitions_template_updates after update of current_version on core.role_definitions
  for each row execute function core.template_updates_on_publish_trg();

-- Add / Skip suggestions. Added changes land in the role's Proposed changes (its single
-- draft, created on demand). Optionally publish right away.
create or replace function core.template_update_decide(
  p_update uuid, p_user uuid, p_add text[], p_skip text[], p_publish boolean default false,
  p_reason text default null, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  u core.template_updates%rowtype; v_m uuid; ch jsonb; v_id text; v_draft uuid; v_draft_version int;
  v_decisions jsonb; v_total int; v_decided int; v_added int; v_status text; v_published int; v_acts text[];
  v_existing text[];
begin
  select * into u from core.template_updates where id = p_update for update;
  if not found then raise exception 'Suggestion not found.' using errcode = 'no_data_found'; end if;
  if u.decided_at is not null or u.status not in ('available', 'partially_adopted') then
    raise exception 'These suggestions were already answered.' using errcode = 'check_violation';
  end if;
  select ms.id into v_m from core.memberships ms
   where ms.org_id = u.org_id and ms.user_id = p_user and coalesce(ms.status, 'active') = 'active';
  if v_m is null or not (core.access_is_tenant_admin(v_m) or core.access_member_holds(v_m, 'core.access.roles', 'configure')) then
    raise exception 'You cannot change roles.' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from unnest(coalesce(p_add, '{}') || coalesce(p_skip, '{}')) x
              where not exists (select 1 from jsonb_array_elements(u.changes) c where c ->> 'id' = x)) then
    raise exception 'Unknown suggestion.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(coalesce(p_add, '{}')) x where x = any (coalesce(p_skip, '{}'))) then
    raise exception 'A suggestion cannot be both added and skipped.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(coalesce(p_add, '{}') || coalesce(p_skip, '{}')) x where u.decisions ? x) then
    raise exception 'A suggestion was already answered.' using errcode = 'check_violation';
  end if;
  if p_publish and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Give a reason for publishing.' using errcode = 'check_violation';
  end if;

  perform core.access_set_context(p_user, 'template_update', coalesce(nullif(btrim(p_reason), ''), 'MeritBooks suggestion'), p_ip,
                                  'template_update:' || u.id);

  if cardinality(coalesce(p_add, '{}')) > 0 then
    select id, version into v_draft, v_draft_version from core.role_versions where role_id = u.derived_role_id and state = 'draft';
    if v_draft is null then
      select coalesce(max(version), 0) + 1 into v_draft_version from core.role_versions where role_id = u.derived_role_id;
      insert into core.role_versions (role_id, version, state, reason, created_by)
      values (u.derived_role_id, v_draft_version, 'draft', 'Proposed changes', p_user)
      returning id into v_draft;
      insert into core.role_grants (role_version_id, capability, actions, constraints)
      select v_draft, e ->> 'capability', array(select jsonb_array_elements_text(e -> 'actions')), coalesce(e -> 'constraints', '{}'::jsonb)
        from jsonb_array_elements(core.rbac_role_current_grants(u.derived_role_id)) e;
    end if;
    for ch in select c from jsonb_array_elements(u.changes) c where c ->> 'id' = any (p_add) loop
      v_acts := array(select jsonb_array_elements_text(coalesce(ch -> 'actions', '[]'::jsonb)));
      select actions into v_existing from core.role_grants where role_version_id = v_draft and capability = ch ->> 'capability';
      if ch ->> 'kind' = 'add' then
        if v_existing is null then
          insert into core.role_grants (role_version_id, capability, actions, constraints)
          values (v_draft, ch ->> 'capability', v_acts, coalesce(ch -> 'constraints', '{}'::jsonb));
        else
          update core.role_grants
             set actions = array(select x from unnest(core.rbac_actions()) x where x = any (v_existing || v_acts))
           where role_version_id = v_draft and capability = ch ->> 'capability';
        end if;
      elsif ch ->> 'kind' = 'remove' then
        if v_existing is not null then
          if cardinality(array(select x from unnest(v_existing) x where not x = any (v_acts))) = 0 then
            delete from core.role_grants where role_version_id = v_draft and capability = ch ->> 'capability';
          else
            update core.role_grants set actions = array(select x from unnest(v_existing) x where not x = any (v_acts))
             where role_version_id = v_draft and capability = ch ->> 'capability';
          end if;
        end if;
      elsif ch ->> 'kind' = 'constraint' then
        update core.role_grants set constraints = coalesce(ch -> 'after', '{}'::jsonb)
         where role_version_id = v_draft and capability = ch ->> 'capability';
      end if;
    end loop;
  end if;

  v_decisions := u.decisions
    || coalesce((select jsonb_object_agg(x, 'added'::text) from unnest(coalesce(p_add, '{}')) x), '{}'::jsonb)
    || coalesce((select jsonb_object_agg(x, 'skipped'::text) from unnest(coalesce(p_skip, '{}')) x), '{}'::jsonb);
  v_total := jsonb_array_length(u.changes);
  select count(*), count(*) filter (where value = '"added"') into v_decided, v_added from jsonb_each(v_decisions);
  v_status := case when v_decided < v_total then (case when v_added > 0 then 'partially_adopted' else 'available' end)
                   when v_added = v_total then 'adopted'
                   when v_added = 0 then 'dismissed'
                   else 'partially_adopted' end;

  update core.template_updates
     set decisions = v_decisions, status = v_status,
         adopted_changes = (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(u.changes) c
                             where v_decisions ->> (c ->> 'id') = 'added'),
         draft_version = coalesce(v_draft_version, draft_version),
         decided_by = case when v_decided >= v_total then p_user end,
         decided_at = case when v_decided >= v_total then now() end,
         updated_at = now()
   where id = u.id;
  if v_decided >= v_total then
    update core.role_definitions set upstream_version = u.to_version where id = u.derived_role_id;
  end if;

  if p_publish then
    select id, version into v_draft, v_draft_version from core.role_versions where role_id = u.derived_role_id and state = 'draft';
    if v_draft is not null then
      v_published := core.rbac_publish_role_version(v_draft, p_user, btrim(p_reason));
    end if;
  end if;

  perform core.access_log_write(u.org_id,
    case when coalesce(cardinality(p_add), 0) > 0 then 'template_update.adopt' else 'template_update.dismiss' end,
    'template_update', u.id,
    coalesce((select array_agg(distinct a.membership_id) from core.access_assignments a
               where a.role_id = u.derived_role_id and a.status = 'active'), '{}'),
    '{}', false, jsonb_build_object('status', u.status),
    jsonb_build_object('status', v_status, 'added', to_jsonb(coalesce(p_add, '{}')), 'skipped', to_jsonb(coalesce(p_skip, '{}')),
                       'role_id', u.derived_role_id, 'draft_version', v_draft_version, 'published_version', v_published),
    p_user, p_reason, 'template_update');
  return jsonb_build_object('status', v_status, 'draft_version', v_draft_version, 'published_version', v_published);
end
$$;

-- Hide the library note until the next batch (05 §6.10).
create or replace function core.template_updates_dismiss_note(p_org uuid, p_user uuid) returns integer
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_m uuid; v_n int;
begin
  select ms.id into v_m from core.memberships ms where ms.org_id = p_org and ms.user_id = p_user and coalesce(ms.status, 'active') = 'active';
  if v_m is null or not (core.access_is_tenant_admin(v_m) or core.access_member_holds(v_m, 'core.access.roles', 'view')) then
    raise exception 'You cannot see role suggestions.' using errcode = 'insufficient_privilege';
  end if;
  update core.template_updates set note_dismissed_at = now(), updated_at = now()
   where org_id = p_org and decided_at is null and status in ('available', 'partially_adopted') and note_dismissed_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ── 10. Time-box sweeper (05 §3.7) ───────────────────────────────────────────
create or replace function core.expire_access(p_org uuid default null) returns jsonb
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare a record; v_assign int := 0; v_failed int := 0; v_req int := 0; r record;
begin
  perform core.access_set_context(null, 'sweeper', 'Time box ended', null, null);
  for a in
    select id from core.access_assignments
     where status in ('active', 'pending_approval', 'suspended') and effective_to is not null and effective_to <= now()
       and (p_org is null or org_id = p_org)
  loop
    begin
      update core.access_assignments set status = 'expired', change_reason = 'Time box ended' where id = a.id;
      v_assign := v_assign + 1;
    exception when others then
      v_failed := v_failed + 1; -- one bad row never blocks the sweep; it is retried next run
    end;
  end loop;
  for r in
    update core.access_requests set status = 'expired', updated_at = now()
     where status = 'pending' and expires_at <= now() and (p_org is null or org_id = p_org)
    returning id, org_id, requester_membership_id
  loop
    perform core.access_log_write(r.org_id, 'request.expire', 'access_request', r.id, array[r.requester_membership_id],
      '{}', false, null, jsonb_build_object('status', 'expired'), null, 'Not decided within 14 days', 'sweeper');
    v_req := v_req + 1;
  end loop;
  return jsonb_build_object('expired_assignments', v_assign, 'failed_assignments', v_failed, 'expired_requests', v_req);
end
$$;

-- ── 11. Grants: functions (M1 lesson — revoke, then grant service_role) ──────
do $$
declare f text;
begin
  foreach f in array array[
    'core.access_ctx(text)',
    'core.access_change_log_immutable()',
    'core.access_grants_minus_pairs(jsonb, jsonb)',
    'core.template_diff(jsonb, jsonb, jsonb)',
    'core.access_set_context(uuid, text, text, text, text)',
    'core.access_log_write(uuid, text, text, uuid, uuid[], uuid[], boolean, jsonb, jsonb, uuid, text, text, text)',
    'core.access_log_append(uuid, uuid, text, text, uuid, uuid[], uuid[], jsonb, text, text)',
    'core.access_assignment_snapshot(core.access_assignments)',
    'core.access_assignment_locations(core.access_assignments)',
    'core.access_version_grants(text, uuid)',
    'core.access_holds(uuid, uuid, text, text)',
    'core.access_is_tenant_admin(uuid)',
    'core.access_member_holds(uuid, text, text)',
    'core.access_source_grants(text, uuid)',
    'core.access_ceiling_violation(uuid, uuid, jsonb, text, text, uuid, timestamptz)',
    'core.access_is_high_risk(jsonb)',
    'core.access_request_plan(uuid, uuid)',
    'core.access_request_route(uuid)',
    'core.access_request_create(uuid, uuid, text, text, text[], uuid, uuid, uuid, int, text, text)',
    'core.access_ensure_capability_set(uuid, text, text[])',
    'core.access_request_decide(uuid, uuid, text, text, uuid, int, text)',
    'core.access_request_confirm(uuid, uuid, text)',
    'core.access_request_cancel(uuid, uuid)',
    'core.access_review_start(uuid, uuid, text, text, uuid, uuid, timestamptz, uuid, boolean)',
    'core.access_end_assignment(uuid, uuid, text)',
    'core.access_review_decide(uuid, uuid, text, text, text)',
    'core.access_review_close(uuid, uuid, text)',
    'core.template_version_grants(uuid, int)',
    'core.template_updates_generate(uuid)',
    'core.template_update_decide(uuid, uuid, text[], text[], boolean, text, text)',
    'core.template_updates_dismiss_note(uuid, uuid)',
    'core.expire_access(uuid)',
    'core.access_log_assignment_trg()',
    'core.access_log_source_trg()',
    'core.access_log_version_trg()',
    'core.access_log_policy_trg()',
    'core.template_updates_on_publish_trg()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
-- Read-only caller helpers used inside RLS policies (they only answer about the caller).
do $$
declare f text;
begin
  foreach f in array array[
    'core.access_caller_membership(uuid)',
    'core.access_caller_may_read_log(uuid)',
    'core.access_caller_is_access_admin(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ── 12. RLS ──────────────────────────────────────────────────────────────────
alter table core.access_change_log enable row level security;
drop policy if exists member_read on core.access_change_log;
drop policy if exists service_read on core.access_change_log;
create policy member_read on core.access_change_log for select to authenticated
  using (org_id = public.get_org_id() and core.access_caller_may_read_log(org_id));
create policy service_read on core.access_change_log for select to service_role using (true);
revoke all on table core.access_change_log from public, anon, authenticated, service_role;
grant select on table core.access_change_log to authenticated, service_role;

alter table core.access_requests enable row level security;
drop policy if exists member_read on core.access_requests;
drop policy if exists service_all on core.access_requests;
create policy member_read on core.access_requests for select to authenticated
  using (org_id = public.get_org_id()
         and (requester_membership_id = core.access_caller_membership(org_id)
              or core.access_caller_membership(org_id) = any (routed_to_membership_ids)
              or core.access_caller_is_access_admin(org_id, 'core.access.assignments')));
create policy service_all on core.access_requests for all to service_role using (true) with check (true);

alter table core.access_reviews enable row level security;
drop policy if exists member_read on core.access_reviews;
drop policy if exists service_all on core.access_reviews;
create policy member_read on core.access_reviews for select to authenticated
  using (org_id = public.get_org_id()
         and (core.access_caller_is_access_admin(org_id, 'core.access.reviews')
              or exists (select 1 from core.access_review_items i
                          where i.review_id = access_reviews.id
                            and i.reviewer_membership_id = core.access_caller_membership(access_reviews.org_id))));
create policy service_all on core.access_reviews for all to service_role using (true) with check (true);

alter table core.access_review_items enable row level security;
drop policy if exists member_read on core.access_review_items;
drop policy if exists service_all on core.access_review_items;
create policy member_read on core.access_review_items for select to authenticated
  using (org_id = public.get_org_id()
         and (reviewer_membership_id = core.access_caller_membership(org_id)
              or core.access_caller_is_access_admin(org_id, 'core.access.reviews')));
create policy service_all on core.access_review_items for all to service_role using (true) with check (true);

alter table core.template_updates enable row level security;
drop policy if exists member_read on core.template_updates;
drop policy if exists service_all on core.template_updates;
create policy member_read on core.template_updates for select to authenticated
  using (org_id = public.get_org_id() and core.access_caller_is_access_admin(org_id, 'core.access.roles'));
create policy service_all on core.template_updates for all to service_role using (true) with check (true);

do $$
declare t text;
begin
  foreach t in array array['access_requests', 'access_reviews', 'access_review_items', 'template_updates'] loop
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select on table core.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

-- ── 13. Data step ────────────────────────────────────────────────────────────
-- (a) Baseline: one 'assignment.baseline' entry per access assignment that predates the
--     log, so "who had access on day one" is answerable. Idempotent.
do $$
declare a core.access_assignments%rowtype;
begin
  for a in select * from core.access_assignments x
            where not exists (select 1 from core.access_change_log l where l.subject_id = x.id) loop
    perform core.access_log_write(a.org_id, 'assignment.baseline', 'assignment', a.id, array[a.membership_id],
      core.access_assignment_locations(a), a.scope_type = 'all_clients', null, core.access_assignment_snapshot(a),
      a.granted_by, 'Access as it stood when the access log started', 'backfill', 'system:backfill');
  end loop;
end $$;
-- (b) Suggestions for roles whose template already moved on.
do $$
declare t record;
begin
  for t in select id from core.role_definitions where owner_level = 'platform' loop
    perform core.template_updates_generate(t.id);
  end loop;
end $$;

-- Wave-2 integration: re-apply client-scope RLS (163) so any client-owned table or
-- location_id column created above gets its restrictive policy.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
