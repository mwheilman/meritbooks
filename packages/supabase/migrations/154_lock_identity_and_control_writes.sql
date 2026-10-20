-- =============================================================================
-- Migration 154: lock identity / RBAC / approval-control tables to SELECT-only for
--                members (CRITICAL privilege escalation fix).
-- =============================================================================
-- THE HOLE. PostgREST exposes the public, core and proj schemas. The anon key is
-- public and users' Clerk session tokens are accepted (role=authenticated,
-- org_id=<tenant>). The tables below carried member policies of the form
--     FOR ALL USING (org_id = get_org_id())
-- (or INSERT/UPDATE equivalents), so ANY signed-in member of a tenant could write
-- them directly over PostgREST, bypassing every route-level gate. Concretely:
--   * core.employees            UPDATE own row SET role='company_admin' -> full admin
--                               (requirePermission / requireManageUsers read this).
--   * core.custom_roles,
--     core.role_permission_overrides,
--     public.role_permission_overrides (legacy)
--                               grant any role any permission cell.
--   * public.employee_locations grant yourself access to any company.
--   * core.practice_assignments reassign close/AR/AP/review/onboarding ownership.
--   * public.approvals          UPDATE status='APPROVED' -> skip canApprove + SoD.
--   * public.approval_steps     forge / erase the immutable approval audit trail.
--   * public.approval_workflows, approval_workflow_steps, approval_requests,
--     approval_request_actions  rewrite approval chains / forge approve actions.
--   * public.autonomy_settings, autonomy_kill_switch
--                               turn AI autonomy to AUTO / disengage the kill switch.
--   * public.ap_approval_policies, cost_approval_rules
--                               rewrite who must approve bills / costs.
--   * core.organizations        UPDATE entitlements, billing, clerk binding, AI
--                               auto-approve thresholds for the tenant.
--   * core.users                self_update let a user SET is_platform_staff = true
--                               on their own row -> PLATFORM-WIDE escalation
--                               (operator console, cross-tenant).
--
-- THE FIX. For every table above:
--   1. RLS stays ENABLED.
--   2. Every existing policy is dropped and replaced by exactly two:
--        member_read  FOR SELECT  — the SAME read predicate members had before
--                                   (org_id = get_org_id(); id = get_org_id() for
--                                   organizations; own row by JWT sub for users),
--        service_all  FOR ALL TO service_role.
--   3. INSERT / UPDATE / DELETE / TRUNCATE are REVOKED from anon and authenticated,
--      so even a future permissive policy cannot re-open writes without an explicit
--      GRANT (src/test/identity-write-lock.test.ts fails the build if one appears).
-- All application writes to these tables now go through the service-role client
-- AFTER a server-side authorization check (requireManageUsers / requirePermission /
-- requireMoneyMovement / the approval engines' own SoD + role-at-step gates /
-- self-provisioning rules), always pinned to the session-resolved org.
--
-- Grant-only hardening (policies already service-only, grants were still broad):
--   core.memberships, core.membership_locations, core.platform_admin_sessions,
--   core.membership_invitations.
--
-- SAFETY: no data change, no GL effect. Idempotent: re-running drops and recreates
-- the same two policies and re-applies the same revokes. Tables absent in an
-- environment are skipped (to_regclass guard).
-- =============================================================================

do $$
declare
  t record;
  p record;
begin
  for t in
    select * from (values
      -- identity / RBAC
      ('core',   'employees',                 'org_id = public.get_org_id()'),
      ('core',   'custom_roles',              'org_id = public.get_org_id()'),
      ('core',   'role_permission_overrides', 'org_id = public.get_org_id()'),
      ('public', 'role_permission_overrides', 'org_id = public.get_org_id()'),
      ('public', 'employee_locations',        'org_id = public.get_org_id()'),
      ('core',   'practice_assignments',      'org_id = public.get_org_id()'),
      -- tenant record
      ('core',   'organizations',             'id = public.get_org_id()'),
      -- identity profile (own row only)
      ('core',   'users',
         $q$clerk_user_id = ((current_setting('request.jwt.claims', true))::json ->> 'sub')$q$),
      -- money-movement approval record + immutable audit trail
      ('public', 'approvals',                 'org_id = public.get_org_id()'),
      ('public', 'approval_steps',            'org_id = public.get_org_id()'),
      -- configurable approval workflows
      ('public', 'approval_workflows',        'org_id = public.get_org_id()'),
      ('public', 'approval_workflow_steps',   'org_id = public.get_org_id()'),
      ('public', 'approval_requests',         'org_id = public.get_org_id()'),
      ('public', 'approval_request_actions',  'org_id = public.get_org_id()'),
      -- AI autonomy control plane
      ('public', 'autonomy_settings',         'org_id = public.get_org_id()'),
      ('public', 'autonomy_kill_switch',      'org_id = public.get_org_id()'),
      -- approval policies
      ('public', 'ap_approval_policies',      'org_id = public.get_org_id()'),
      ('public', 'cost_approval_rules',       'org_id = public.get_org_id()')
    ) as v(sch, tbl, read_qual)
  loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      raise notice 'migration 154: %.% not present, skipped', t.sch, t.tbl;
      continue;
    end if;

    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);

    -- Drop EVERY existing policy (named or drifted) so no member write path survives.
    for p in
      select policyname from pg_policies where schemaname = t.sch and tablename = t.tbl
    loop
      execute format('drop policy if exists %I on %I.%I', p.policyname, t.sch, t.tbl);
    end loop;

    execute format(
      'create policy member_read on %I.%I for select using (%s)',
      t.sch, t.tbl, t.read_qual);
    execute format(
      'create policy service_all on %I.%I for all to service_role using (true) with check (true)',
      t.sch, t.tbl);

    execute format(
      'revoke insert, update, delete, truncate on table %I.%I from anon, authenticated',
      t.sch, t.tbl);
    execute format(
      'grant select, insert, update, delete on table %I.%I to service_role',
      t.sch, t.tbl);
  end loop;

  -- Grant-only hardening for tables whose policies are already service-only.
  for t in
    select * from (values
      ('core', 'memberships'),
      ('core', 'membership_locations'),
      ('core', 'platform_admin_sessions'),
      ('core', 'membership_invitations')
    ) as v(sch, tbl)
  loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      continue;
    end if;
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);
    execute format(
      'revoke insert, update, delete, truncate on table %I.%I from anon, authenticated',
      t.sch, t.tbl);
  end loop;
end $$;
