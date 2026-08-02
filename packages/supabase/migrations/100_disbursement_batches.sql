-- =============================================================================
-- Migration 100: AP money-out — disbursement_batches + disbursement_batch_items
-- =============================================================================
-- Persists the identity + lifecycle of an AP disbursement batch (assemble approved
-- bills -> export a NACHA/CSV file the human submits to their bank -> post on human
-- RELEASE through the existing recordBillPayment gate). NO live ACH/bank API is ever
-- contacted; the only external output is a file. Money is bigint cents. Preparer !=
-- approver != releaser is enforced in code + the migration-042 approvals CHECK; the
-- release path also re-runs the vendor-compliance gate. SECURITY-reviewed (GO).
-- Additive + idempotent. RLS org_isolation via get_org_id(). The app degrades SAFE
-- (batch derived from approvals + audit log) if these tables are absent. Books band.
-- FOLLOW-UP (task #110): add a per-approval release idempotency lock/unique key to
-- close the concurrent-release double-post race the security audit flagged.
-- =============================================================================

create table if not exists public.disbursement_batches (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  status         text not null default 'DRAFT'
                   check (status in ('DRAFT','EXPORTED','RELEASED','CANCELLED')),
  total_cents    bigint not null default 0,
  item_count     int not null default 0,
  method_summary jsonb not null default '{}'::jsonb,
  exported_at    timestamptz,
  exported_by    text,
  released_at    timestamptz,
  released_by    text,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.disbursement_batch_items (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  batch_id       uuid not null references public.disbursement_batches(id) on delete cascade,
  approval_id    uuid not null references public.approvals(id),
  bill_id        uuid not null,
  vendor_id      uuid not null,
  amount_cents   bigint not null check (amount_cents > 0),
  method         text not null check (method in ('ACH','CHECK')),
  bill_payment_id uuid,
  created_at     timestamptz not null default now(),
  unique (batch_id, approval_id)
);

alter table public.disbursement_batches      enable row level security;
alter table public.disbursement_batch_items  enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='disbursement_batches' and policyname='org_isolation')
    then create policy "org_isolation" on public.disbursement_batches for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='disbursement_batches' and policyname='service_write')
    then create policy "service_write" on public.disbursement_batches for all to service_role using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='disbursement_batch_items' and policyname='org_isolation')
    then create policy "org_isolation" on public.disbursement_batch_items for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='disbursement_batch_items' and policyname='service_write')
    then create policy "service_write" on public.disbursement_batch_items for all to service_role using (true) with check (true); end if;
end $$;
grant select, insert, update, delete on public.disbursement_batches to anon, authenticated, service_role;
grant select, insert, update, delete on public.disbursement_batch_items to anon, authenticated, service_role;
