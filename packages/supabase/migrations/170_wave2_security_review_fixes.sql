-- =============================================================================
-- Migration 170: wave-2 security review fixes (wave 2G)
-- =============================================================================
--
-- §1  HIGH  public.payroll_runs / public.payroll_run_employees were member-WRITABLE
--           over PostgREST (069: org_isolation FOR ALL). A preparer could PATCH a run
--           to status APPROVED with any approved_by, edit per-person net_cents, and
--           release alone (releaseRun trusted those columns). Fix (167 §1 pattern,
--           order-independent): every PERMISSIVE member write policy becomes a SELECT
--           policy with the SAME predicate (RESTRICTIVE client-scope policies from 163
--           are left alone), service_all is added, INSERT / UPDATE / DELETE / TRUNCATE
--           are revoked from anon + authenticated. Every app write now goes through the
--           service-role client after the route's permission check, pinned to the
--           session org (apps/web: api/payroll/runs, runs/[id]/{preview,approve,
--           release,post}). releaseRun now CAS-claims the money approval BEFORE the
--           provider call and enforces preparer ≠ releaser ≠ approver (app side).
--
-- §2  R-6   Per-person payroll amounts become a DB-level comp mask: the comp columns of
--           payroll_run_employees switch from 'serializer' to 'column_revoke'
--           (core.field_class_columns, 167 §5) and core.apply_field_column_masks()
--           re-applies the column grants, so anon / authenticated can no longer SELECT
--           gross / net / tax / deduction / benefit / earnings per person. The run
--           totals on payroll_runs stay member-readable (the `grouped` level). The app
--           reads per-person rows with the service role and serializes through
--           lib/rbac/field-masks.ts.
--
-- §3  MEDIUM public.approvals transition guard. 164 only refused two transitions in v2
--           mode. core.approvals_transition_guard() now refuses EVERY illegal status
--           change, in every mode, for every writer (service role included):
--             DRAFT            → PENDING_APPROVAL | REJECTED
--             PENDING_APPROVAL → APPROVED | REJECTED
--             APPROVED         → RELEASED | REJECTED
--             RELEASED         → SETTLED | RETURNED
--                              → APPROVED  only as the un-finalized claim revert
--                                          (no provider_correlation_id, released_by → null)
--             SETTLED / REJECTED / RETURNED are terminal.
--           Inserts start at DRAFT / PENDING_APPROVAL (or APPROVED with an approver —
--           capability-checked in v2); never RELEASED / SETTLED / RETURNED.
--           The parties and the amount are pinned too: org / kind / subject / prepared_by
--           never change; approved_by changes only on → APPROVED; released_by only on
--           APPROVED → RELEASED (and back to null on the revert); amount_cents is frozen
--           once approved; a stamped provider_correlation_id is never rewritten.
--           core.rbac_approvals_capability_guard() (164) is rewritten so the v2 capability
--           check runs on ANY change into APPROVED or RELEASED (insert included), not just
--           the two named transitions. The claim revert is exempt (it undoes, it does not
--           grant).
--
-- §4  MEDIUM Event-drain finalize. A drain whose 15-minute lease lapsed could be overtaken
--           by a second drain and both would book the same event. The app now renews the
--           claim per event and finalizes only `WHERE claimed_by = token AND status =
--           'pending'`. The DB guarantor: one AR invoice / one internal invoice per source
--           event (new nullable source_event_id + partial UNIQUE). The JOB_BILLING GL
--           post also carries source_ref 'core.events:<id>' so 064's
--           uq_gl_entries_org_source_type rejects a second entry; JOB_PROGRESS already
--           posts under a per-job+period source_ref (rev-rec, 064).
--
-- §5  MEDIUM Security policy changes. core.replace_security_policy() writes the policy and
--           replaces the IP allowlists in ONE transaction (delete + insert, no window with
--           an empty allowlist) and records the change in core.access_change_log
--           ('security_policy.change', before / after, loosening flag, reason, ip).
--           service_role only. The app refuses a LOOSENING change unless the session meets
--           the CURRENT policy (assertSessionMeetsPolicy).
--
-- §6  LOW   Enforcement-mode changes. Every change of access_enforcement_mode or
--           client_scope_rls_mode is logged to core.access_change_log by an AFTER trigger
--           (any writer). core.request_access_mode_change() is the app's entry point: a
--           DOWNGRADE (v2 → dual / legacy, enforce → shadow / off) needs a SECOND tenant
--           admin to confirm (core.confirm_access_mode_change, H1: never the requester);
--           when the tenant has only one admin it is applied with the logged reason.
--           core.access_mode_change_requests holds the pending confirmations (24 h).
--
-- §7  LOW   Append-only ledgers vs cascades: core.field_reveals and core.sod_exceptions
--           refused the FK cascade (org delete, membership delete / set-null), so deleting
--           a tenant or a seat raised. Both guards now let nested (pg_trigger_depth() > 1)
--           cascade writes through; direct UPDATE / DELETE is still refused.
--
-- §8  LOW   RLS performance: the per-row caller helpers on access_change_log,
--           access_requests, access_reviews, access_review_items (and template_updates)
--           are wrapped as (select core.access_caller_*(public.get_org_id())) so they are
--           evaluated once per statement (initPlan) instead of once per row. Equivalent:
--           every policy already requires org_id = get_org_id().
--
-- M1 lesson: every function is EXECUTE-revoked from public / anon / authenticated, then
-- granted explicitly (service_role always). Idempotent. PGlite-compatible (no subqueries
-- in CHECK). No GL effect, no data change beyond nullable columns.
-- =============================================================================

-- ── §1 payroll write lock ─────────────────────────────────────────────────────
do $$
declare
  t record;
  p record;
  v_roles text;
begin
  for t in select * from (values ('public', 'payroll_runs'), ('public', 'payroll_run_employees')) as v(sch, tbl) loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      raise notice 'migration 170: %.% not present, skipped', t.sch, t.tbl;
      continue;
    end if;
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);

    for p in
      select policyname, cmd, roles, qual
        from pg_policies
       where schemaname = t.sch and tablename = t.tbl
         and permissive = 'PERMISSIVE'
         and cmd <> 'SELECT'
         and roles::text <> '{service_role}'
    loop
      execute format('drop policy if exists %I on %I.%I', p.policyname, t.sch, t.tbl);
      if p.cmd = 'ALL' and p.qual is not null then
        v_roles := array_to_string(p.roles, ', ');
        execute format('create policy %I on %I.%I for select to %s using (%s)',
                       p.policyname, t.sch, t.tbl, v_roles, p.qual);
      end if;
    end loop;

    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and cmd in ('SELECT', 'ALL')
                      and permissive = 'PERMISSIVE' and roles::text <> '{service_role}') then
      execute format('create policy member_read on %I.%I for select using (org_id = public.get_org_id())', t.sch, t.tbl);
    end if;

    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and policyname = 'service_all') then
      execute format(
        'create policy service_all on %I.%I for all to service_role using (true) with check (true)',
        t.sch, t.tbl);
    end if;

    execute format('revoke insert, update, delete, truncate on table %I.%I from anon, authenticated', t.sch, t.tbl);
    execute format('grant select, insert, update, delete on table %I.%I to service_role', t.sch, t.tbl);
  end loop;
end $$;

-- ── §2 per-person payroll amounts: DB-level comp mask ────────────────────────
do $$ begin
  if to_regclass('core.field_class_columns') is null then
    raise notice 'migration 170: core.field_class_columns (167) not present — comp mask skipped; re-run 170 after 167';
    return;
  end if;
  update core.field_class_columns
     set enforcement = 'column_revoke',
         note = 'Per-person payroll (column-revoked for members; server reads + serializer mask, mig 170)'
   where schema_name = 'public' and table_name = 'payroll_run_employees'
     and column_name in ('gross_cents', 'net_cents', 'employee_tax_cents', 'employer_tax_cents',
                         'deductions_cents', 'benefits_cents', 'earnings');
end $$;

-- ── §3 approvals: full transition guard + capability check on every grant ─────
create or replace function public.approvals_transition_guard() returns trigger
  language plpgsql security definer set search_path = public, core, pg_temp as
$$
declare
  v_revert boolean;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED') then
      raise exception 'An approval cannot be created as %', new.status using errcode = 'check_violation';
    end if;
    if new.status = 'APPROVED' and new.approved_by is null then
      raise exception 'An approved approval needs its approver' using errcode = 'check_violation';
    end if;
    if new.released_by is not null or new.provider_correlation_id is not null then
      raise exception 'An approval cannot be created already released' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Identity of the item is fixed.
  if (new.org_id, new.kind, new.subject_table, new.subject_id, new.prepared_by)
     is distinct from (old.org_id, old.kind, old.subject_table, old.subject_id, old.prepared_by) then
    raise exception 'The organization, kind, subject and preparer of an approval never change' using errcode = 'check_violation';
  end if;

  v_revert := old.status = 'RELEASED' and new.status = 'APPROVED'
              and old.provider_correlation_id is null and new.provider_correlation_id is null
              and new.released_by is null;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'DRAFT'            and new.status in ('PENDING_APPROVAL', 'REJECTED'))
      or (old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED', 'REJECTED'))
      or (old.status = 'APPROVED'         and new.status in ('RELEASED', 'REJECTED'))
      or (old.status = 'RELEASED'         and new.status in ('SETTLED', 'RETURNED'))
      or v_revert
    ) then
      raise exception 'Invalid approval transition % -> %', old.status, new.status using errcode = 'check_violation';
    end if;
  end if;

  if new.approved_by is distinct from old.approved_by
     and not (old.status = 'PENDING_APPROVAL' and new.status = 'APPROVED') then
    raise exception 'The approver is recorded only when the item is approved' using errcode = 'check_violation';
  end if;
  if new.status = 'APPROVED' and new.approved_by is null then
    raise exception 'An approved approval needs its approver' using errcode = 'check_violation';
  end if;

  if new.released_by is distinct from old.released_by
     and not (old.status = 'APPROVED' and new.status = 'RELEASED')
     and not v_revert then
    raise exception 'The releaser is recorded only when the item is released' using errcode = 'check_violation';
  end if;
  if new.status = 'RELEASED' and new.released_by is null then
    raise exception 'A released approval needs its releaser' using errcode = 'check_violation';
  end if;

  if new.amount_cents is distinct from old.amount_cents
     and old.status in ('APPROVED', 'RELEASED', 'SETTLED', 'RETURNED') then
    raise exception 'The amount of an approved item cannot change' using errcode = 'check_violation';
  end if;

  if old.provider_correlation_id is not null
     and new.provider_correlation_id is distinct from old.provider_correlation_id then
    raise exception 'A recorded provider reference cannot be rewritten' using errcode = 'check_violation';
  end if;

  return new;
end
$$;

do $$ begin
  if to_regclass('public.approvals') is not null then
    drop trigger if exists trg_approvals_a_transition_guard on public.approvals;
    create trigger trg_approvals_a_transition_guard
      before insert or update on public.approvals
      for each row execute function public.approvals_transition_guard();
  end if;
end $$;

-- 164's v2 capability guard, now on ANY change into APPROVED / RELEASED (insert included).
create or replace function core.rbac_approvals_capability_guard() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_action text; v_actor text; v_cap text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if new.status = 'APPROVED' then
    -- The un-finalized claim revert (RELEASED → APPROVED) undoes a release; it grants nothing.
    if tg_op = 'UPDATE' and old.status = 'RELEASED' then return new; end if;
    v_action := 'approve'; v_actor := new.approved_by;
  elsif new.status = 'RELEASED' then
    v_action := 'release'; v_actor := new.released_by;
  else
    return new; -- reject / settle / return / submit are not authority-bearing here
  end if;
  if core.access_enforcement_mode_of(new.org_id) <> 'v2' then return new; end if;

  v_cap := core.rbac_money_kind_capability(new.kind);
  if v_cap is null or v_actor is null
     or not core.actor_has_capability(new.org_id, v_actor, v_cap, v_action, null) then
    raise exception 'R-11: % lacks %:% for this % (access enforcement v2)',
      coalesce(v_actor, '(no actor)'), coalesce(v_cap, '?'), v_action, new.kind
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.approvals_transition_guard() from public, anon, authenticated;
grant execute on function public.approvals_transition_guard() to service_role;
revoke all on function core.rbac_approvals_capability_guard() from public, anon, authenticated;
grant execute on function core.rbac_approvals_capability_guard() to service_role;

-- ── §4 one document per source event ─────────────────────────────────────────
do $$ begin
  if to_regclass('public.invoices') is not null then
    alter table public.invoices add column if not exists source_event_id uuid;
    create unique index if not exists uq_invoices_org_source_event
      on public.invoices (org_id, source_event_id) where source_event_id is not null;
    comment on column public.invoices.source_event_id is
      'core.events.id of the JOB_BILLING event that issued this invoice (null = manual). Unique per org: one invoice per event (mig 170).';
  end if;
  if to_regclass('public.internal_invoices') is not null then
    alter table public.internal_invoices add column if not exists source_event_id uuid;
    create unique index if not exists uq_internal_invoices_org_source_event
      on public.internal_invoices (org_id, source_event_id) where source_event_id is not null;
    comment on column public.internal_invoices.source_event_id is
      'core.events.id of the DEPT_INVOICE_ISSUE event that booked this internal invoice (null = direct create). Unique per org (mig 170).';
  end if;
end $$;

-- ── access log: subject type for tenant-wide settings ────────────────────────
alter table core.access_change_log drop constraint if exists access_change_log_subject_chk;
alter table core.access_change_log add constraint access_change_log_subject_chk check (subject_type in
  ('assignment', 'role', 'permission_set', 'client_policy', 'access_review', 'access_review_item',
   'access_request', 'template_update', 'export', 'session', 'field', 'tenant_setting'));

-- ── §5 security policy: atomic replace + access log ──────────────────────────
-- p_policy     the normalized policy object (the app validates bounds; the DB the shape)
-- p_allowlists [{"name": text, "cidrs": [cidr text, …]}, …]
-- p_actor      core.users.id of the admin (attribution; may be null for ops)
-- p_loosening  the app's verdict that this change relaxes the current policy (logged)
create or replace function core.replace_security_policy(
  p_org uuid, p_policy jsonb, p_allowlists jsonb, p_actor uuid, p_actor_clerk text,
  p_loosening boolean, p_reason text default null, p_ip text default null)
returns jsonb
language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  v_before_policy jsonb;
  v_before_lists jsonb;
  v_after_lists jsonb;
  v_n int;
begin
  if p_org is null then raise exception 'organization required' using errcode = 'check_violation'; end if;
  if p_policy is null or jsonb_typeof(p_policy) <> 'object' then
    raise exception 'security policy must be an object' using errcode = 'check_violation';
  end if;
  if p_allowlists is null or jsonb_typeof(p_allowlists) <> 'array' then
    raise exception 'allowlists must be an array' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(p_allowlists) x
              where jsonb_typeof(x) <> 'object' or nullif(btrim(coalesce(x ->> 'name', '')), '') is null
                 or jsonb_typeof(coalesce(x -> 'cidrs', '[]'::jsonb)) <> 'array') then
    raise exception 'each allowlist needs a name and a list of networks' using errcode = 'check_violation';
  end if;
  if coalesce((p_policy ->> 'ip_allowlist_enforced')::boolean, false)
     and not exists (select 1 from jsonb_array_elements(p_allowlists) x, jsonb_array_elements_text(coalesce(x -> 'cidrs', '[]'::jsonb)) c) then
    raise exception 'add at least one network before enforcing the IP allowlist' using errcode = 'check_violation';
  end if;

  select o.security_policy into v_before_policy from core.organizations o where o.id = p_org for update;
  if not found then raise exception 'organization % not found', p_org using errcode = 'no_data_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', l.name, 'cidrs', to_jsonb(l.cidrs::text[])) order by lower(l.name)), '[]'::jsonb)
    into v_before_lists from core.ip_allowlists l where l.org_id = p_org;

  update core.organizations set security_policy = p_policy where id = p_org;
  delete from core.ip_allowlists where org_id = p_org;
  insert into core.ip_allowlists (org_id, name, cidrs, created_by)
  select p_org, btrim(x ->> 'name'),
         coalesce(array(select distinct c::cidr from jsonb_array_elements_text(coalesce(x -> 'cidrs', '[]'::jsonb)) c), '{}'::cidr[]),
         p_actor_clerk
    from jsonb_array_elements(p_allowlists) x;
  get diagnostics v_n = row_count;

  select coalesce(jsonb_agg(jsonb_build_object('name', l.name, 'cidrs', to_jsonb(l.cidrs::text[])) order by lower(l.name)), '[]'::jsonb)
    into v_after_lists from core.ip_allowlists l where l.org_id = p_org;

  perform core.access_set_context(p_actor, 'ui', p_reason, p_ip, null);
  perform core.access_log_write(
    p_org, 'security_policy.change', 'tenant_setting', p_org, '{}'::uuid[], '{}'::uuid[], true,
    jsonb_build_object('policy', coalesce(v_before_policy, '{}'::jsonb), 'allowlists', v_before_lists),
    jsonb_build_object('policy', p_policy, 'allowlists', v_after_lists,
                       'loosening', coalesce(p_loosening, false), 'changed_by', p_actor_clerk),
    p_actor, p_reason, 'ui');

  return jsonb_build_object('policy', p_policy, 'allowlists', v_n, 'loosening', coalesce(p_loosening, false));
end
$$;
revoke all on function core.replace_security_policy(uuid, jsonb, jsonb, uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function core.replace_security_policy(uuid, jsonb, jsonb, uuid, text, boolean, text, text) to service_role;

-- ── §6 enforcement-mode changes: log every change + two-admin downgrade ───────
create or replace function core.access_log_org_mode_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
begin
  if new.access_enforcement_mode is distinct from old.access_enforcement_mode then
    perform core.access_log_write(
      new.id, 'enforcement_mode.change', 'tenant_setting', new.id, '{}'::uuid[], '{}'::uuid[], true,
      jsonb_build_object('access_enforcement_mode', old.access_enforcement_mode),
      jsonb_build_object('access_enforcement_mode', new.access_enforcement_mode,
                         'changed_by', new.access_mode_changed_by),
      null, null, 'system');
  end if;
  if new.client_scope_rls_mode is distinct from old.client_scope_rls_mode then
    perform core.access_log_write(
      new.id, 'client_scope_mode.change', 'tenant_setting', new.id, '{}'::uuid[], '{}'::uuid[], true,
      jsonb_build_object('client_scope_rls_mode', old.client_scope_rls_mode),
      jsonb_build_object('client_scope_rls_mode', new.client_scope_rls_mode),
      null, null, 'system');
  end if;
  return null;
end
$$;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'organizations'
              and column_name = 'access_enforcement_mode')
     and exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'organizations'
              and column_name = 'client_scope_rls_mode') then
    drop trigger if exists trg_organizations_access_mode_log on core.organizations;
    create trigger trg_organizations_access_mode_log
      after update of access_enforcement_mode, client_scope_rls_mode on core.organizations
      for each row execute function core.access_log_org_mode_trg();
  end if;
end $$;

create table if not exists core.access_mode_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  setting            text not null,
  from_mode          text not null,
  to_mode            text not null,
  requested_by       uuid references core.users(id) on delete set null,
  requested_by_clerk text,
  reason             text not null,
  status             text not null default 'pending',
  decided_by         uuid references core.users(id) on delete set null,
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '24 hours'),
  constraint access_mode_change_requests_setting_chk check (setting in ('access_enforcement_mode', 'client_scope_rls_mode')),
  constraint access_mode_change_requests_status_chk check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'superseded')),
  constraint access_mode_change_requests_reason_chk check (length(btrim(reason)) >= 3)
);
create index if not exists idx_access_mode_change_requests_org
  on core.access_mode_change_requests (org_id, setting, status, created_at desc);
comment on table core.access_mode_change_requests is
  'Wave 2G: a DOWNGRADE of access enforcement (v2 → dual/legacy) or client scope (enforce → shadow/off) waits here for a second tenant admin. service_role writes only.';

do $$
declare p record;
begin
  alter table core.access_mode_change_requests enable row level security;
  for p in select policyname from pg_policies where schemaname = 'core' and tablename = 'access_mode_change_requests' loop
    execute format('drop policy if exists %I on core.access_mode_change_requests', p.policyname);
  end loop;
  create policy member_read on core.access_mode_change_requests for select to authenticated
    using (org_id = (select public.get_org_id()));
  create policy service_all on core.access_mode_change_requests for all to service_role using (true) with check (true);
  revoke all on table core.access_mode_change_requests from public, anon, authenticated;
  grant select on table core.access_mode_change_requests to authenticated;
  grant select, insert, update, delete on table core.access_mode_change_requests to service_role;
end $$;

-- A tenant admin for mode purposes: the v2 Tenant admin role, or (compat until R-14) the
-- legacy company admin on the membership / employee row.
create or replace function core.access_mode_is_admin(p_membership uuid) returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select exists (
    select 1
      from core.memberships ms
      left join core.users u on u.id = ms.user_id
     where ms.id = p_membership
       and coalesce(ms.status, 'active') = 'active'
       and (core.access_is_tenant_admin(ms.id)
            or lower(coalesce(ms.role, '')) in ('company_admin', 'owner', 'org_admin', 'admin')
            or exists (select 1 from core.employees e
                        where e.org_id = ms.org_id and e.clerk_user_id = u.clerk_user_id
                          and e.is_active and e.role = 'company_admin')))
$$;

create or replace function core.access_mode_admin_count(p_org uuid) returns integer
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select count(*)::int from core.memberships ms
   where ms.org_id = p_org and coalesce(ms.status, 'active') = 'active' and core.access_mode_is_admin(ms.id)
$$;

create or replace function core.access_mode_current(p_org uuid, p_setting text) returns text
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v text;
begin
  if p_setting = 'access_enforcement_mode' then
    select o.access_enforcement_mode into v from core.organizations o where o.id = p_org;
  elsif p_setting = 'client_scope_rls_mode' then
    select o.client_scope_rls_mode into v from core.organizations o where o.id = p_org;
  else
    raise exception 'unknown access setting %', p_setting using errcode = 'check_violation';
  end if;
  return v;
end
$$;

create or replace function core.access_mode_is_downgrade(p_setting text, p_from text, p_to text) returns boolean
  language sql immutable as
$$
  select p_from is distinct from p_to
     and ((p_setting = 'access_enforcement_mode' and p_from = 'v2')
       or (p_setting = 'client_scope_rls_mode' and p_from = 'enforce'))
$$;

-- Apply a mode (internal). Attribution flows to the AFTER trigger through the context.
create or replace function core.access_mode_apply(
  p_org uuid, p_setting text, p_mode text, p_actor uuid, p_actor_clerk text,
  p_reason text, p_ip text, p_approval_ref text)
returns text
language plpgsql security definer set search_path = core, public, pg_temp as
$$
begin
  perform core.access_set_context(p_actor, 'ui', p_reason, p_ip, p_approval_ref);
  if p_setting = 'access_enforcement_mode' then
    -- the 7-day / 0-disagreement gate for v2 stays in set_access_enforcement_mode
    perform core.set_access_enforcement_mode(p_org, p_mode, coalesce(p_actor_clerk, p_actor::text), false);
  else
    if p_mode not in ('off', 'shadow', 'enforce') then
      raise exception 'unknown client scope mode %', p_mode using errcode = 'check_violation';
    end if;
    update core.organizations set client_scope_rls_mode = p_mode where id = p_org;
  end if;
  return core.access_mode_current(p_org, p_setting);
end
$$;

-- The app's entry point for every mode change.
--   upgrade / lateral         → applied now
--   downgrade, ≥ 2 admins     → pending until a SECOND admin confirms
--   downgrade, 1 admin        → applied now, with the reason logged (single_admin)
create or replace function core.request_access_mode_change(
  p_org uuid, p_setting text, p_mode text, p_actor uuid, p_reason text, p_ip text default null)
returns jsonb
language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  v_clerk text;
  v_m uuid;
  v_cur text;
  v_down boolean;
  v_req uuid;
  v_new text;
begin
  if p_setting not in ('access_enforcement_mode', 'client_scope_rls_mode') then
    raise exception 'unknown access setting %', p_setting using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required' using errcode = 'check_violation';
  end if;
  select u.clerk_user_id into v_clerk from core.users u where u.id = p_actor;
  select ms.id into v_m from core.memberships ms
   where ms.org_id = p_org and ms.user_id = p_actor and coalesce(ms.status, 'active') = 'active';
  if v_m is null or not core.access_mode_is_admin(v_m) then
    raise exception 'Only a tenant admin can change access enforcement' using errcode = '42501';
  end if;

  perform 1 from core.organizations where id = p_org for update;
  v_cur := core.access_mode_current(p_org, p_setting);
  if v_cur is not distinct from p_mode then
    return jsonb_build_object('status', 'unchanged', 'setting', p_setting, 'mode', v_cur);
  end if;
  v_down := core.access_mode_is_downgrade(p_setting, v_cur, p_mode);

  if v_down and core.access_mode_admin_count(p_org) > 1 then
    update core.access_mode_change_requests set status = 'superseded'
     where org_id = p_org and setting = p_setting and status = 'pending';
    insert into core.access_mode_change_requests (org_id, setting, from_mode, to_mode, requested_by, requested_by_clerk, reason)
    values (p_org, p_setting, v_cur, p_mode, p_actor, v_clerk, btrim(p_reason))
    returning id into v_req;
    perform core.access_set_context(p_actor, 'ui', p_reason, p_ip, 'mode_change_request:' || v_req::text);
    perform core.access_log_write(
      p_org, 'mode_change.request', 'tenant_setting', p_org, array[v_m], '{}'::uuid[], true,
      jsonb_build_object(p_setting, v_cur),
      jsonb_build_object(p_setting, p_mode, 'request_id', v_req, 'needs', 'second_admin'),
      p_actor, p_reason, 'ui');
    return jsonb_build_object('status', 'pending', 'setting', p_setting, 'mode', v_cur,
                              'requested_mode', p_mode, 'request_id', v_req);
  end if;

  v_new := core.access_mode_apply(p_org, p_setting, p_mode, p_actor, v_clerk,
                                  case when v_down then 'Single tenant admin: ' || btrim(p_reason) else btrim(p_reason) end,
                                  p_ip, case when v_down then 'single_admin' else null end);
  return jsonb_build_object('status', 'applied', 'setting', p_setting, 'mode', v_new,
                            'previous_mode', v_cur, 'single_admin', v_down);
end
$$;

create or replace function core.confirm_access_mode_change(p_request uuid, p_actor uuid, p_ip text default null)
returns jsonb
language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  r core.access_mode_change_requests%rowtype;
  v_clerk text;
  v_m uuid;
  v_cur text;
  v_new text;
begin
  select * into r from core.access_mode_change_requests where id = p_request for update;
  if r.id is null then raise exception 'mode change request not found' using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then
    raise exception 'this request is no longer pending (%)', r.status using errcode = 'check_violation';
  end if;
  if r.expires_at <= now() then
    raise exception 'this request expired; ask again' using errcode = 'check_violation';
  end if;
  select u.clerk_user_id into v_clerk from core.users u where u.id = p_actor;
  select ms.id into v_m from core.memberships ms
   where ms.org_id = r.org_id and ms.user_id = p_actor and coalesce(ms.status, 'active') = 'active';
  if v_m is null or not core.access_mode_is_admin(v_m) then
    raise exception 'Only a tenant admin can confirm an access enforcement change' using errcode = '42501';
  end if;
  if r.requested_by is not distinct from p_actor then
    raise exception 'H1: a second tenant admin must confirm this change' using errcode = '42501';
  end if;

  perform 1 from core.organizations where id = r.org_id for update;
  v_cur := core.access_mode_current(r.org_id, r.setting);
  if v_cur is distinct from r.from_mode then
    raise exception 'the setting changed since this was requested (now %); ask again', v_cur using errcode = 'check_violation';
  end if;

  v_new := core.access_mode_apply(r.org_id, r.setting, r.to_mode, p_actor, v_clerk,
                                  r.reason, p_ip, 'mode_change_request:' || r.id::text);
  update core.access_mode_change_requests
     set status = 'confirmed', decided_by = p_actor, decided_at = now()
   where id = r.id;
  perform core.access_log_write(
    r.org_id, 'mode_change.confirm', 'tenant_setting', r.org_id, array[v_m], '{}'::uuid[], true,
    jsonb_build_object(r.setting, r.from_mode),
    jsonb_build_object(r.setting, v_new, 'request_id', r.id, 'requested_by', r.requested_by),
    p_actor, r.reason, 'ui');
  return jsonb_build_object('status', 'applied', 'setting', r.setting, 'mode', v_new,
                            'previous_mode', r.from_mode, 'request_id', r.id);
end
$$;

create or replace function core.cancel_access_mode_change(p_request uuid, p_actor uuid)
returns void
language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare r core.access_mode_change_requests%rowtype; v_m uuid;
begin
  select * into r from core.access_mode_change_requests where id = p_request for update;
  if r.id is null then raise exception 'mode change request not found' using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then return; end if;
  select ms.id into v_m from core.memberships ms
   where ms.org_id = r.org_id and ms.user_id = p_actor and coalesce(ms.status, 'active') = 'active';
  if v_m is null or not core.access_mode_is_admin(v_m) then
    raise exception 'Only a tenant admin can cancel this request' using errcode = '42501';
  end if;
  update core.access_mode_change_requests set status = 'cancelled', decided_by = p_actor, decided_at = now()
   where id = r.id;
  perform core.access_log_write(
    r.org_id, 'mode_change.cancel', 'tenant_setting', r.org_id, array[v_m], '{}'::uuid[], true,
    null, jsonb_build_object('request_id', r.id), p_actor, null, 'ui');
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'core.access_log_org_mode_trg()',
    'core.access_mode_is_admin(uuid)',
    'core.access_mode_admin_count(uuid)',
    'core.access_mode_current(uuid, text)',
    'core.access_mode_is_downgrade(text, text, text)',
    'core.access_mode_apply(uuid, text, text, uuid, text, text, text, text)',
    'core.request_access_mode_change(uuid, text, text, uuid, text, text)',
    'core.confirm_access_mode_change(uuid, uuid, text)',
    'core.cancel_access_mode_change(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ── §7 append-only ledgers let FK cascades through ───────────────────────────
create or replace function core.m167_field_reveals_immutable() returns trigger
  language plpgsql as
$$
begin
  -- An FK cascade (tenant deleted → rows deleted; seat deleted → membership_id set null)
  -- runs nested inside the RI trigger. Only direct UPDATE / DELETE is refused.
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'core.field_reveals is append-only' using errcode = 'check_violation';
end
$$;
revoke all on function core.m167_field_reveals_immutable() from public, anon, authenticated;

create or replace function core.sod_exceptions_guard() returns trigger
  language plpgsql as
$$
declare m record; r core.sod_rules%rowtype; v_enf text;
begin
  -- FK cascades (tenant / seat / client deleted; grantor / revoker user deleted → set null)
  -- run nested inside the RI trigger and must not be blocked.
  if tg_op in ('UPDATE', 'DELETE') and pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'allowed conflicts are never deleted — revoke instead' using errcode = 'check_violation';
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
revoke all on function core.sod_exceptions_guard() from public, anon, authenticated;

-- ── §8 RLS: caller helpers evaluated once per statement ──────────────────────
drop policy if exists member_read on core.access_change_log;
create policy member_read on core.access_change_log for select to authenticated
  using (org_id = (select public.get_org_id())
         and (select core.access_caller_may_read_log(public.get_org_id())));

drop policy if exists member_read on core.access_requests;
create policy member_read on core.access_requests for select to authenticated
  using (org_id = (select public.get_org_id())
         and (requester_membership_id = (select core.access_caller_membership(public.get_org_id()))
              or (select core.access_caller_membership(public.get_org_id())) = any (routed_to_membership_ids)
              or (select core.access_caller_is_access_admin(public.get_org_id(), 'core.access.assignments'))));

drop policy if exists member_read on core.access_reviews;
create policy member_read on core.access_reviews for select to authenticated
  using (org_id = (select public.get_org_id())
         and ((select core.access_caller_is_access_admin(public.get_org_id(), 'core.access.reviews'))
              or exists (select 1 from core.access_review_items i
                          where i.review_id = access_reviews.id
                            and i.reviewer_membership_id = (select core.access_caller_membership(public.get_org_id())))));

drop policy if exists member_read on core.access_review_items;
create policy member_read on core.access_review_items for select to authenticated
  using (org_id = (select public.get_org_id())
         and (reviewer_membership_id = (select core.access_caller_membership(public.get_org_id()))
              or (select core.access_caller_is_access_admin(public.get_org_id(), 'core.access.reviews'))));

drop policy if exists member_read on core.template_updates;
create policy member_read on core.template_updates for select to authenticated
  using (org_id = (select public.get_org_id())
         and (select core.access_caller_is_access_admin(public.get_org_id(), 'core.access.roles')));

-- ── re-apply the column masks (§2) and client-scope RLS (163) ────────────────
do $$ begin
  if to_regprocedure('core.apply_field_column_masks()') is not null then
    perform core.apply_field_column_masks();
  end if;
end $$;

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- End migration 170.
