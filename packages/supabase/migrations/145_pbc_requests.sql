-- =============================================================================
-- Migration 145: PBC ("prepared by client") request list for external auditors.
-- =============================================================================
-- An external auditor/accountant (a view-only member via the existing custom-role
-- system) can request supporting documents/items from the client and track each to
-- fulfillment. A PBC item links to a fulfillment document in the existing 'documents'
-- bucket when provided. No money movement, no GL post.
--
-- SAFETY / CANON §3: additive + idempotent; workflow/reference data only. RLS
-- org_isolation via public.get_org_id(). Money n/a.
-- =============================================================================

create table if not exists public.pbc_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid,
  title         text not null,
  description   text,
  category      text,                          -- BANK_REC / INVOICE_SUPPORT / CONTRACT / PAYROLL / OTHER
  period_label  text,                          -- e.g. 'FY2026' or '2026-06'
  status        text not null default 'REQUESTED'
                  check (status in ('REQUESTED','IN_PROGRESS','PROVIDED','ACCEPTED','WAIVED')),
  requested_by  text,                          -- auditor/admin who raised it
  assigned_to   text,                          -- client user responsible
  due_date      date,
  document_id   uuid,                          -- fulfillment doc (documents bucket), stitched in JS
  fulfilled_at  timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.pbc_requests is
  'Prepared-by-client request list for external auditors: request -> assign -> fulfill (link a document) -> accept. Workflow only; no GL/money effect.';

create index if not exists ix_pbc_requests_org_status on public.pbc_requests (org_id, status);

alter table public.pbc_requests enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='pbc_requests' and policyname='org_isolation')
    then create policy "org_isolation" on public.pbc_requests for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='pbc_requests' and policyname='service_write')
    then create policy "service_write" on public.pbc_requests for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.pbc_requests to anon, authenticated, service_role;
