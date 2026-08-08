-- =============================================================================
-- Migration 104: report_packs — saved + scheduled NL report packs
-- =============================================================================
-- Persists a named report pack (the parsed report SPEC DESCRIPTORS, re-resolved to
-- current dates each run) built by the NL Report Compiler, plus an optional recurring
-- delivery schedule (monthly/quarterly) to chosen recipients via the existing email
-- path. Additive + idempotent. RLS org_isolation via get_org_id(); a service_write
-- policy lets the scheduled-delivery worker's per-org scoped client operate. The app
-- degrades SAFE if absent (save/schedule unavailable; ad-hoc compile unaffected).
-- Books band; next number: 105 (sales_tax_filings). Delivery cron is REPORTED to the
-- lead (secured POST /api/reports/packs/run-scheduled + REPORT_PACK_CRON_SECRET;
-- per-org isolation via a short-lived SUPABASE_JWT_SECRET-signed token — security review).
-- =============================================================================

create table if not exists public.report_packs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  name              text not null,
  entity_label      text,
  location_ids      jsonb not null default '[]'::jsonb,
  specs             jsonb not null,
  schedule_cadence  text not null default 'NONE' check (schedule_cadence in ('NONE','MONTHLY','QUARTERLY')),
  recipients        jsonb not null default '[]'::jsonb,
  schedule_active   boolean not null default false,
  next_run_date     date,
  last_run_at       timestamptz,
  last_run_status   text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_report_packs_org on public.report_packs(org_id, created_at desc);
create index if not exists idx_report_packs_due on public.report_packs(next_run_date) where schedule_active;
alter table public.report_packs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='report_packs' and policyname='org_isolation')
    then create policy "org_isolation" on public.report_packs for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='report_packs' and policyname='service_write')
    then create policy "service_write" on public.report_packs for all to service_role using (true) with check (true); end if;
end $$;
grant select, insert, update, delete on public.report_packs to anon, authenticated, service_role;
