-- =============================================================================
-- Migration 102: practice_assignments — portfolio ownership grid (F5)
-- =============================================================================
-- Who owns which function (close / ar / ap / review) for each entity (company =
-- core.locations), for the multi-client Portfolio plane. One owner per (org, entity,
-- function). Assignee is a core.employees row (the org-RLS-readable roster; core.users
-- is self-read only). Additive + idempotent. RLS org_isolation via get_org_id().
-- The Portfolio board degrades SAFE (shows "Unassigned") if this is absent. core band.
-- =============================================================================

create table if not exists core.practice_assignments (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id) on delete cascade,
  function             text not null check (function in ('close','ar','ap','review')),
  assignee_employee_id uuid references core.employees(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, location_id, function)
);
create index if not exists idx_practice_assignments_org on core.practice_assignments (org_id);
create index if not exists idx_practice_assignments_loc on core.practice_assignments (location_id);

alter table core.practice_assignments enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='practice_assignments' and policyname='org_all') then
    create policy "org_all" on core.practice_assignments for all
      using (org_id = public.get_org_id())
      with check (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='practice_assignments' and policyname='service_all') then
    create policy "service_all" on core.practice_assignments for all to service_role using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on core.practice_assignments to anon, authenticated, service_role;
