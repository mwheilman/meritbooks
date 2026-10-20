-- =============================================================================
-- Migration 164: capability enforcement + 7-day dual-run — wave 2A
--                (05-RBAC-SPEC §1.8, §5.1, §5.2, §5.4, §5.7 R-11 · IA-SPEC §10 wave 2)
-- =============================================================================
-- WHY. Wave 1 (157–161) built the v2 access model (capabilities, versioned roles,
-- permission sets, access assignments, client envelopes) but NOTHING enforces it:
-- authority still comes from permissions.ts + core.employees.role + mig-130 overrides.
-- R-11 flips enforcement to the v2 model, behind a per-tenant switch, after a 7-day
-- dual-run in which both models decide every request and every disagreement is logged.
--
-- WHAT THIS ADDS (additive, idempotent, PGlite-safe — no subqueries in CHECKs):
--   1. core.organizations
--        access_enforcement_mode text  legacy | dual | v2   (default 'dual')
--        dual_run_started_at     timestamptz                 (default now())
--        access_mode_changed_at / access_mode_changed_by     (audit of the last flip)
--      legacy → only the legacy guards decide (v2 not even computed).
--      dual   → the LEGACY decision is returned; v2 is computed alongside and every
--               disagreement is written to core.access_dualrun_log. Nothing a user can
--               do changes.
--      v2     → the v2 decision is returned (app PDP), the DB re-checks post/approve/
--               release (core.assert_actor_capability) and the approvals guard trigger
--               below refuses money approve/release transitions the actor can't make.
--      Mode changes go ONLY through core.set_access_enforcement_mode() (service role),
--      which refuses v2 until 7 days of dual-run with 0 unexplained disagreements.
--   2. core.access_dualrun_log — one row per (deduped) disagreement. service_role only
--      (read through GET /api/settings/access/dual-run, tenant-admin gated).
--   3. Decision functions (05 §1.8 steps 1–5, computed on the fly — see NOTE below):
--        core.membership_has_capability(membership, cap, action, location)  service_role
--        core.has_capability(cap, action, location default null)  caller (JWT) — for
--            RLS / definer RPCs; ANDs 2B's core.can_access_location() (mig 163) when a
--            location is given
--        core.actor_has_capability(org, clerk_user_id, cap, action, location) service_role
--            — the "signed actor" path (05 §5.2.2): the app's service client names the actor
--        core.assert_actor_capability(...)  service_role — mode-aware: raises 42501 when
--            the org is in v2 and the actor lacks the capability; returns the boolean
--            otherwise. The app calls it for post / approve / release in v2 mode.
--   4. DB guard on the money state machine: BEFORE INSERT/UPDATE OF status on
--      public.approvals — in v2 mode, PENDING_APPROVAL→APPROVED requires the approver
--      (approved_by) to hold <kind capability>:approve and APPROVED→RELEASED requires the
--      releaser (released_by) to hold <kind capability>:release. Kind → capability:
--      AR_REFUND → pay.refunds · AP_DISBURSEMENT / AP_BATCH → pay.batches ·
--      PAYROLL_RUN → payroll.runs. legacy / dual: no-op (the app logs the comparison).
--   5. Dual-run admin functions: core.access_dualrun_summary(org, since),
--      core.explain_access_dualrun(...), core.set_access_enforcement_mode(...).
--
-- DEFINER-RPC DECISION (05 §5.2.2). Approve and release are status transitions on ONE
-- table (public.approvals) whose rows carry the acting Clerk id (approved_by /
-- released_by), so a BEFORE trigger is a complete DB-level guard for every writer
-- (service role included) without rewriting the app's approval engine. GL posting is
-- NOT wrapped: ~30 call sites INSERT the header (status POSTED) and its lines in two
-- PostgREST requests and gl_entries carries no actor (posted_by is a null uuid), so a
-- row trigger cannot know who posted and a books.post_journal_entry() RPC would mean
-- rewriting the posting engine. Posting is therefore guarded by the app PDP plus the
-- DB decision core.assert_actor_capability(...,'gl.journal_entries','post',…) that
-- authorize() calls in v2 mode. Follow-up (R-11b): give gl_entries an actor column (or
-- move posting into a definer RPC) and add the same trigger there.
--
-- NOTE — core.effective_access (05 §5.4) is NOT materialized here. Decisions are
-- computed on the fly from access_assignments + the published role / permission-set
-- versions (indexed lookups, one membership at a time). The app keeps an in-memory
-- snapshot cache keyed (membership_id, access_epoch) — mig 160 already bumps the epoch
-- on every assignment change and every publish — so revocation is effective on the
-- next request. Materialize when RLS starts calling has_capability per row.
--
-- PARITY. membership_has_capability mirrors lib/rbac/effective-access.ts
-- (resolveEffectiveAccess + can, no amount) exactly; src/test/capability-enforcement
-- .test.ts asserts SQL == TS for every capability × action × context. Dollar limits and
-- SoD (05 §3.4, §4.3) are wave 2C — constraints are NOT evaluated here.
-- =============================================================================

-- ── 1. per-tenant enforcement mode ───────────────────────────────────────────
alter table core.organizations add column if not exists access_enforcement_mode text not null default 'dual';
alter table core.organizations add column if not exists dual_run_started_at timestamptz default now();
alter table core.organizations add column if not exists access_mode_changed_at timestamptz;
alter table core.organizations add column if not exists access_mode_changed_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_access_enforcement_mode_chk') then
    alter table core.organizations add constraint organizations_access_enforcement_mode_chk
      check (access_enforcement_mode in ('legacy', 'dual', 'v2'));
  end if;
end $$;
update core.organizations set dual_run_started_at = now()
 where access_enforcement_mode = 'dual' and dual_run_started_at is null;
comment on column core.organizations.access_enforcement_mode is
  '05 R-11: legacy = legacy guards only; dual = legacy decides, v2 compared + disagreements logged; v2 = capability model decides. Change only via core.set_access_enforcement_mode().';
comment on column core.organizations.dual_run_started_at is
  '05 R-11: start of the current dual-run window (reset whenever the tenant re-enters dual).';

-- ── 2. dual-run disagreement log ─────────────────────────────────────────────
create table if not exists core.access_dualrun_log (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  membership_id   uuid references core.memberships(id) on delete set null,
  clerk_user_id   text,
  capability      text not null,
  action          text not null,
  location_id     uuid references core.locations(id) on delete set null,
  legacy_decision boolean,
  v2_decision     boolean,
  route           text not null default 'unknown',
  kind            text not null default 'disagree',
  explained       boolean not null default false,
  reason          text,
  detail          jsonb not null default '{}'::jsonb,
  explained_at    timestamptz,
  explained_by    text,
  explanation     text,
  created_at      timestamptz not null default now(),
  constraint access_dualrun_log_kind_chk check (kind in (
    'disagree', 'tighten', 'implied_view', 'unmapped_cell', 'same_capability_other_key',
    'scope', 'money_kind', 'v2_error')),
  constraint access_dualrun_log_detail_chk check (jsonb_typeof(detail) = 'object')
);
create index if not exists idx_access_dualrun_log_org_time on core.access_dualrun_log (org_id, created_at desc);
create index if not exists idx_access_dualrun_log_unexplained
  on core.access_dualrun_log (org_id, capability, action, route) where not explained and explained_at is null;
comment on table core.access_dualrun_log is
  '05 R-11 dual-run: one row per legacy-vs-v2 disagreement (deduped app-side). service_role only.';

alter table core.access_dualrun_log enable row level security;
drop policy if exists service_all on core.access_dualrun_log;
create policy service_all on core.access_dualrun_log for all to service_role using (true) with check (true);
revoke all on table core.access_dualrun_log from public, anon, authenticated;
grant select, insert, update, delete on table core.access_dualrun_log to service_role;

-- ── 3. decision functions ────────────────────────────────────────────────────
-- H3 / H5 audience ceilings for one (capability, action) — mirrors ceilingAllows().
create or replace function core.rbac_ceiling_allows(p_capability text, p_action text, p_audiences text[])
  returns boolean
  language sql stable set search_path = core, public, pg_temp as
$$
  select coalesce((
    select p_action = any (c.actions)
       and not (c.module = 'platform' and not ('platform' = any (p_audiences)))
       and not ('platform' = any (p_audiences) and c.module <> 'platform')
       and not ('external' = any (p_audiences) and (
                 p_action in ('post', 'release', 'configure')
              or (p_action = 'approve' and 'money' = any (c.tags))
              or 'locked' = any (c.tags)
              or p_capability like 'core.access.%'))
      from core.capabilities c
     where c.key = p_capability), false)
$$;

-- 05 §1.8 steps 1–5 for one membership. Deny is the default; roles and permission sets
-- only allow; mutes / read-only narrow only their own assignment; every held action
-- implies view. NULL location = "on at least one client" (the legacy org-wide check).
create or replace function core.membership_has_capability(
  p_membership_id uuid, p_capability text, p_action text, p_location_id uuid default null)
  returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare m record; c record;
begin
  if p_membership_id is null or p_capability is null or p_action is null then return false; end if;

  select ms.id, ms.org_id, ms.status, ms.audience into m from core.memberships ms where ms.id = p_membership_id;
  if m.id is null or m.status is distinct from 'active' then return false; end if;

  select cp.key, cp.actions into c from core.capabilities cp where cp.key = p_capability and cp.status = 'active';
  if c.key is null or not (p_action = any (c.actions)) then return false; end if;

  if p_location_id is not null then
    -- a client of ANOTHER tenant is never in scope, whatever the assignment says
    if not exists (select 1 from core.locations l where l.id = p_location_id and l.org_id = m.org_id) then
      return false;
    end if;
    -- consolidation grants are group-scoped, never client-scoped (05 §3.9)
    if p_capability like 'consol.%' then return false; end if;
  end if;

  return exists (
    with asg as (
      select a.id, a.grant_type, a.role_id, a.permission_set_id, a.read_only, a.muted,
             coalesce(rd.owner_level, ps.owner_level) as owner_level,
             coalesce(rd.location_id, ps.location_id) as source_location_id,
             coalesce(rd.audience, ps.audience)       as source_audience
        from core.access_assignments a
        left join core.role_definitions rd on a.grant_type = 'role' and rd.id = a.role_id
        left join core.permission_sets ps  on a.grant_type = 'permission_set' and ps.id = a.permission_set_id
       where a.membership_id = m.id
         and a.org_id = m.org_id
         and a.status = 'active'
         and a.effective_from <= now()
         and (a.effective_to is null or a.effective_to > now())
         and (p_location_id is null
              or a.scope_type = 'all_clients'
              or (a.scope_type = 'client' and a.location_id = p_location_id)
              or (a.scope_type = 'client_set' and exists (
                    select 1 from core.client_set_members csm
                     where csm.set_id = a.client_set_id and csm.location_id = p_location_id)))
    ), grants as (
      select asg.*, g.actions as grant_actions
        from asg
        join core.role_versions v on asg.grant_type = 'role' and v.role_id = asg.role_id and v.state = 'published'
        join core.role_grants g on g.role_version_id = v.id and g.capability = p_capability
      union all
      select asg.*, g.actions
        from asg
        join core.permission_set_versions v on asg.grant_type = 'permission_set'
                                           and v.permission_set_id = asg.permission_set_id and v.state = 'published'
        join core.permission_set_grants g on g.permission_set_version_id = v.id and g.capability = p_capability
    )
    select 1
      from grants gr
      cross join lateral unnest(gr.grant_actions) as held(act)
     where (held.act = p_action or p_action = 'view')                      -- every action implies view
       and gr.owner_level is not null
       and (gr.owner_level <> 'platform' or 'platform' in (m.audience, gr.source_audience))
       and not (gr.read_only and held.act not in ('view', 'export'))      -- read-only narrows its own grants
       and not (coalesce(gr.muted -> p_capability, '[]'::jsonb) ? held.act) -- mutes narrow its own grants
       and core.rbac_ceiling_allows(p_capability, held.act, array[m.audience, gr.source_audience])
       and (gr.owner_level <> 'client' or exists (                         -- client roles stay in the envelope
             select 1
               from core.client_access_policies p
               join core.permission_set_versions ev on ev.permission_set_id = p.envelope_permission_set_id
                                                   and ev.state = 'published'
               join core.permission_set_grants eg on eg.permission_set_version_id = ev.id
                                                 and eg.capability = p_capability
              where p.org_id = m.org_id and p.location_id = gr.source_location_id
                and held.act = any (eg.actions)))
  );
end
$$;
comment on function core.membership_has_capability(uuid, text, text, uuid) is
  '05 R-11: may this membership perform cap:action (on this client; NULL = on any client)? Mirrors lib/rbac/effective-access.ts. service_role only.';

-- The caller's membership in the request org (JWT sub → core.users → core.memberships).
-- Status is NOT filtered here; membership_has_capability() denies non-active seats.
create or replace function core.rbac_caller_membership_id() returns uuid
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select ms.id
    from core.memberships ms
    join core.users u on u.id = ms.user_id
   where u.clerk_user_id = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
     and ms.org_id = public.get_org_id()
   order by (ms.status = 'active') desc
   limit 1
$$;

-- Caller form, for RLS policies and definer RPCs that run as the user.
create or replace function core.has_capability(p_capability text, p_action text, p_location_id uuid default null)
  returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_m uuid;
begin
  v_m := core.rbac_caller_membership_id();
  if v_m is null then return false; end if;
  if not core.membership_has_capability(v_m, p_capability, p_action, p_location_id) then return false; end if;
  -- 2B's client-scope contract (migration 163). Already implied by the assignment check
  -- above; AND-ed so a future narrowing in can_access_location() is honoured here too.
  if p_location_id is not null and to_regprocedure('core.can_access_location(uuid)') is not null then
    return coalesce(core.can_access_location(p_location_id), false);
  end if;
  return true;
end
$$;
comment on function core.has_capability(text, text, uuid) is
  '05 R-11: may the CALLER (JWT) perform cap:action on this client (NULL = on any client)? For RLS / definer RPCs.';

-- Signed-actor form (05 §5.2.2): only the app's service path can name the actor.
create or replace function core.actor_has_capability(
  p_org_id uuid, p_clerk_user_id text, p_capability text, p_action text, p_location_id uuid default null)
  returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_m uuid;
begin
  if p_org_id is null or nullif(btrim(coalesce(p_clerk_user_id, '')), '') is null then return false; end if;
  select ms.id into v_m
    from core.memberships ms join core.users u on u.id = ms.user_id
   where u.clerk_user_id = p_clerk_user_id and ms.org_id = p_org_id
   order by (ms.status = 'active') desc
   limit 1;
  return core.membership_has_capability(v_m, p_capability, p_action, p_location_id);
end
$$;

create or replace function core.access_enforcement_mode_of(p_org_id uuid) returns text
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select coalesce((select o.access_enforcement_mode from core.organizations o where o.id = p_org_id), 'legacy')
$$;

-- Mode-aware DB decision for the money-critical acts (post / approve / release).
create or replace function core.assert_actor_capability(
  p_org_id uuid, p_clerk_user_id text, p_capability text, p_action text, p_location_id uuid default null)
  returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_ok boolean;
begin
  v_ok := core.actor_has_capability(p_org_id, p_clerk_user_id, p_capability, p_action, p_location_id);
  if not v_ok and core.access_enforcement_mode_of(p_org_id) = 'v2' then
    raise exception 'R-11: % may not %:% (access enforcement v2)', coalesce(p_clerk_user_id, '(no actor)'), p_capability, p_action
      using errcode = '42501';
  end if;
  return v_ok;
end
$$;

-- ── 4. DB guard on money approve / release ───────────────────────────────────
create or replace function core.rbac_money_kind_capability(p_kind text) returns text
  language sql immutable as
$$
  select case p_kind
           when 'AR_REFUND'       then 'pay.refunds'
           when 'AP_DISBURSEMENT' then 'pay.batches'
           when 'AP_BATCH'        then 'pay.batches'
           when 'PAYROLL_RUN'     then 'payroll.runs'
         end
$$;

create or replace function core.rbac_approvals_capability_guard() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_action text; v_actor text; v_cap text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if new.status = 'APPROVED' and (tg_op = 'INSERT' or old.status = 'PENDING_APPROVAL') then
    v_action := 'approve'; v_actor := new.approved_by;
  elsif new.status = 'RELEASED' and (tg_op = 'INSERT' or old.status = 'APPROVED') then
    v_action := 'release'; v_actor := new.released_by;
  else
    return new; -- reject / settle / return / revert-claim are not authority-bearing here
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
drop trigger if exists trg_approvals_capability_guard on public.approvals;
create trigger trg_approvals_capability_guard
  before insert or update of status on public.approvals
  for each row execute function core.rbac_approvals_capability_guard();

-- ── 5. dual-run admin ────────────────────────────────────────────────────────
create or replace function core.access_dualrun_summary(p_org_id uuid, p_since timestamptz)
  returns table (capability text, action text, route text, kind text, legacy_decision boolean,
                 explained boolean, explanation text, total bigint, members bigint, last_seen timestamptz)
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select l.capability, l.action, l.route, l.kind, l.legacy_decision,
         (l.explained or l.explained_at is not null) as explained,
         max(l.explanation),
         count(*)::bigint, count(distinct coalesce(l.membership_id::text, l.clerk_user_id))::bigint, max(l.created_at)
    from core.access_dualrun_log l
   where l.org_id = p_org_id and l.created_at >= p_since
   group by 1, 2, 3, 4, 5, 6
   order by 6, 8 desc
$$;

-- Mark every unexplained row of one (capability, action, route) group as explained.
create or replace function core.explain_access_dualrun(
  p_org_id uuid, p_capability text, p_action text, p_route text, p_note text, p_actor text)
  returns integer
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare v_n int;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'an explanation is required' using errcode = 'check_violation';
  end if;
  update core.access_dualrun_log l
     set explained_at = now(), explained_by = p_actor, explanation = btrim(p_note)
   where l.org_id = p_org_id and l.capability = p_capability and l.action = p_action and l.route = p_route
     and not l.explained and l.explained_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- The only sanctioned way to change the mode. v2 requires 7 full days of dual-run with
-- zero unexplained disagreements (unless p_force — reserved for platform staff tooling).
-- Re-entering dual restarts the window. Returns the new state.
create or replace function core.set_access_enforcement_mode(
  p_org_id uuid, p_mode text, p_actor text, p_force boolean default false)
  returns jsonb
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare o record; v_unexplained bigint;
begin
  if p_mode not in ('legacy', 'dual', 'v2') then
    raise exception 'unknown access enforcement mode %', p_mode using errcode = 'check_violation';
  end if;
  select id, access_enforcement_mode, dual_run_started_at into o from core.organizations where id = p_org_id for update;
  if o.id is null then raise exception 'organization % not found', p_org_id using errcode = 'no_data_found'; end if;

  if p_mode = 'v2' and o.access_enforcement_mode <> 'v2' and not p_force then
    if o.access_enforcement_mode <> 'dual' or o.dual_run_started_at is null
       or o.dual_run_started_at > now() - interval '7 days' then
      raise exception 'v2 requires 7 days of dual-run first' using errcode = 'check_violation';
    end if;
    select count(*) into v_unexplained from core.access_dualrun_log l
     where l.org_id = p_org_id and l.created_at >= o.dual_run_started_at
       and not l.explained and l.explained_at is null;
    if v_unexplained > 0 then
      raise exception 'v2 requires 0 unexplained dual-run disagreements (% open)', v_unexplained using errcode = 'check_violation';
    end if;
  end if;

  update core.organizations
     set access_enforcement_mode = p_mode,
         dual_run_started_at = case when p_mode = 'dual' and o.access_enforcement_mode <> 'dual' then now()
                                    else dual_run_started_at end,
         access_mode_changed_at = case when p_mode <> o.access_enforcement_mode then now() else access_mode_changed_at end,
         access_mode_changed_by = case when p_mode <> o.access_enforcement_mode then p_actor else access_mode_changed_by end
   where id = p_org_id;

  return (select jsonb_build_object('mode', access_enforcement_mode, 'previous_mode', o.access_enforcement_mode,
                                    'dual_run_started_at', dual_run_started_at, 'changed_at', access_mode_changed_at)
            from core.organizations where id = p_org_id);
end
$$;

-- ── privileges (M1 lesson: revoke, then grant explicitly) ────────────────────
revoke all on function core.rbac_ceiling_allows(text, text, text[]) from public, anon, authenticated;
grant execute on function core.rbac_ceiling_allows(text, text, text[]) to service_role;
revoke all on function core.membership_has_capability(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function core.membership_has_capability(uuid, text, text, uuid) to service_role;
revoke all on function core.rbac_caller_membership_id() from public, anon, authenticated;
grant execute on function core.rbac_caller_membership_id() to authenticated, service_role;
revoke all on function core.has_capability(text, text, uuid) from public, anon, authenticated;
grant execute on function core.has_capability(text, text, uuid) to authenticated, service_role;
revoke all on function core.actor_has_capability(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function core.actor_has_capability(uuid, text, text, text, uuid) to service_role;
revoke all on function core.access_enforcement_mode_of(uuid) from public, anon, authenticated;
grant execute on function core.access_enforcement_mode_of(uuid) to service_role;
revoke all on function core.assert_actor_capability(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function core.assert_actor_capability(uuid, text, text, text, uuid) to service_role;
revoke all on function core.rbac_money_kind_capability(text) from public, anon, authenticated;
grant execute on function core.rbac_money_kind_capability(text) to service_role;
revoke all on function core.rbac_approvals_capability_guard() from public, anon, authenticated;
grant execute on function core.rbac_approvals_capability_guard() to service_role;
revoke all on function core.access_dualrun_summary(uuid, timestamptz) from public, anon, authenticated;
grant execute on function core.access_dualrun_summary(uuid, timestamptz) to service_role;
revoke all on function core.explain_access_dualrun(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function core.explain_access_dualrun(uuid, text, text, text, text, text) to service_role;
revoke all on function core.set_access_enforcement_mode(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function core.set_access_enforcement_mode(uuid, text, text, boolean) to service_role;

-- 2B (mig 163) covers every core/public table with a uuid location_id by re-running its
-- generator; access_dualrun_log has one, so re-apply (idempotent) when 163 is present.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
