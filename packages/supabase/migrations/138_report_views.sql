-- =============================================================================
-- Migration 138: report_views — saved report-viewer configurations
-- =============================================================================
-- Persists a named, re-runnable snapshot of the INTERACTIVE report viewer's
-- configuration (report type + period preset/custom range + company/industry scope
-- + basis + summary/detail + comparative mode). Distinct from report_packs (104),
-- which stores multi-report NL-compiler SPECS for PDF/Excel + scheduled delivery;
-- a report_view is a one-click "run this exact report the way I like it" saved on
-- the /reports screen. Additive + idempotent. RLS org_isolation via get_org_id();
-- a service_write policy mirrors report_packs. The app DEGRADES SAFE if absent
-- (save/list unavailable; ad-hoc reporting unaffected). Books band; next: 139.
-- =============================================================================

create table if not exists public.report_views (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  name        text not null,
  report_key  text not null,
  config      jsonb not null default '{}'::jsonb,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_report_views_org on public.report_views(org_id, created_at desc);
alter table public.report_views enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='report_views' and policyname='org_isolation')
    then create policy "org_isolation" on public.report_views for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='report_views' and policyname='service_write')
    then create policy "service_write" on public.report_views for all to service_role using (true) with check (true); end if;
end $$;
grant select, insert, update, delete on public.report_views to anon, authenticated, service_role;
