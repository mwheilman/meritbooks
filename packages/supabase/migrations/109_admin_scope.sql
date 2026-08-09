-- =============================================================================
-- Migration 109: admin_scope — delegated-admin responsibility (MANAGEMENT / PREPARER)
-- =============================================================================
-- A company_admin can add another admin as MANAGEMENT (invites/manages users,
-- delegates the books) and/or PREPARER (runs onboarding + does the books). Modeled
-- as a capability SET (text[]) alongside the RBAC role — never replaces it. null /
-- empty / both = full admin (today's behavior); the capability layer FAILS OPEN so an
-- absent column never locks anyone out. Carried invitation -> employees -> memberships
-- on accept/first login. Additive + idempotent. core band; next number: 110.
-- =============================================================================

alter table core.membership_invitations add column if not exists admin_scope text[];
alter table core.employees              add column if not exists admin_scope text[];
alter table core.memberships            add column if not exists admin_scope text[];

do $$ begin
  if not exists (select 1 from pg_constraint where conname='membership_invitations_admin_scope_chk') then
    alter table core.membership_invitations
      add constraint membership_invitations_admin_scope_chk
      check (admin_scope is null or admin_scope <@ array['MANAGEMENT','PREPARER']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conname='employees_admin_scope_chk') then
    alter table core.employees
      add constraint employees_admin_scope_chk
      check (admin_scope is null or admin_scope <@ array['MANAGEMENT','PREPARER']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conname='memberships_admin_scope_chk') then
    alter table core.memberships
      add constraint memberships_admin_scope_chk
      check (admin_scope is null or admin_scope <@ array['MANAGEMENT','PREPARER']::text[]);
  end if;
end $$;
