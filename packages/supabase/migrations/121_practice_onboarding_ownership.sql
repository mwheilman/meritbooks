-- =============================================================================
-- Migration 121: practice onboarding ownership + per-company onboarding status
-- =============================================================================
-- Multi-client accounting-firm plane (F5, the white-label moat). Two additions:
--
--   1. A new practice_assignments FUNCTION, 'onboarding' — WHO owns bringing a
--      client company onto the books. It rides the SAME (org, location, function)
--      ownership grid as close / ar / ap / review, so the Entities board and the
--      Team & Access dialog write to one authoritative place.
--
--   2. Per-company onboarding LIFECYCLE on core.locations
--      (onboarding_status + onboarding_completed_at). A freshly-added client entity
--      starts 'not_started'; assigning an owner (or manual toggle) moves it through
--      'in_progress' -> 'complete'. This is the per-COMPANY analogue of the org-wide
--      organizations.setup_complete / onboarding_state (which stay tenant-level).
--
--   3. membership_invitations.onboarding_location_ids — the companies an INVITED
--      preparer will own onboarding for. The employee doesn't exist until first
--      login, so we stash the intent on the invite and materialize the
--      practice_assignments rows when the seat is claimed (claim-invitation.ts).
--
-- Additive + idempotent. core band. FAILS SAFE: every surface degrades to
-- "unassigned / not_started" if any piece is absent. next number: 122.
-- =============================================================================

-- 1. Allow 'onboarding' as a practice_assignments function. The original CHECK was
--    an inline constraint (migration 102); drop ANY check that constrains `function`
--    (name-agnostic) then recreate under a stable name with the extended set.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'core'
      and rel.relname = 'practice_assignments'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%function%'
  loop
    execute format('alter table core.practice_assignments drop constraint %I', c.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint where conname = 'practice_assignments_function_check'
  ) then
    alter table core.practice_assignments
      add constraint practice_assignments_function_check
      check (function in ('close', 'ar', 'ap', 'review', 'onboarding'));
  end if;
end $$;

-- 2. Per-company onboarding lifecycle.
alter table core.locations
  add column if not exists onboarding_status text not null default 'not_started';
alter table core.locations
  add column if not exists onboarding_completed_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'locations_onboarding_status_chk') then
    alter table core.locations
      add constraint locations_onboarding_status_chk
      check (onboarding_status in ('not_started', 'in_progress', 'complete'));
  end if;
end $$;

comment on column core.locations.onboarding_status is
  'Per-company onboarding lifecycle for the practice plane: not_started | in_progress | complete. Distinct from the tenant-wide organizations.setup_complete.';

-- 3. Invited preparer's onboarding companies (materialized on claim).
alter table core.membership_invitations
  add column if not exists onboarding_location_ids uuid[];
