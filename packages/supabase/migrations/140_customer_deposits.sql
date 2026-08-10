-- =============================================================================
-- Migration 140: customer deposits / retainers (unapplied cash held as a
--                liability, drawn down against invoices).
-- =============================================================================
-- Lets a receipt be taken BEFORE (or without) an invoice and carried as a
-- liability — Customer Deposits (account role CUSTOMER_DEPOSITS, 2420) — then
-- drawn down against invoices later. Common for construction/HVAC progress
-- deposits and retainers.
--
-- POSTING (through the existing gl-posting path, gated create<>approve):
--   • Take deposit : DR Cash/Undeposited Funds  / CR Customer Deposits (2420)
--   • Apply to inv : DR Customer Deposits (2420)  / CR Accounts Receivable
--   • Refund       : DR Customer Deposits (2420)  / CR Cash
-- The tables here are the SUBLEDGER (who holds what, how much is left); the GL
-- remains the book of record. journal_entry_id links each movement to its
-- balanced JE. applied_cents can never exceed amount_cents (CHECK).
--
-- SAFETY / CANON §3: additive + idempotent; no live money movement; every GL
-- effect flows through the existing balanced-JE posting gate. RLS org_isolation
-- via public.get_org_id(); money is bigint cents. customer/invoice/payment/JE ids
-- are uuid columns stitched in JS (no cross-schema FK), per the mig-137 convention.
-- =============================================================================

create table if not exists public.customer_deposits (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null,                 -- core.locations (stitched in JS)
  customer_id       uuid not null,                 -- core.customers (stitched in JS)
  job_id            uuid,                          -- optional core.jobs link
  deposit_date      date not null default current_date,
  amount_cents      bigint not null check (amount_cents > 0),
  applied_cents     bigint not null default 0 check (applied_cents >= 0 and applied_cents <= amount_cents),
  refunded_cents    bigint not null default 0 check (refunded_cents >= 0),
  status            text not null default 'HELD'
                      check (status in ('HELD','PARTIALLY_APPLIED','APPLIED','REFUNDED')),
  currency          text not null default 'USD',
  source_payment_id uuid,                          -- the receipt this deposit came from (stitched in JS)
  journal_entry_id  uuid,                          -- the balanced JE that booked DR Cash / CR 2420
  memo              text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.customer_deposits is
  'Customer deposits / retainers — unapplied cash held as a liability (role CUSTOMER_DEPOSITS 2420) and drawn down against invoices. Subledger; the GL is the book of record. applied_cents <= amount_cents enforced by CHECK.';

create index if not exists ix_customer_deposits_org_customer on public.customer_deposits (org_id, customer_id);
create index if not exists ix_customer_deposits_org_status   on public.customer_deposits (org_id, status);

create table if not exists public.customer_deposit_applications (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  deposit_id        uuid not null references public.customer_deposits(id) on delete cascade,
  invoice_id        uuid not null,                 -- core/public invoice (stitched in JS)
  amount_cents      bigint not null check (amount_cents > 0),
  journal_entry_id  uuid,                          -- the balanced JE that booked DR 2420 / CR A/R
  applied_by        text,
  applied_at        timestamptz not null default now()
);

comment on table public.customer_deposit_applications is
  'Each draw-down of a customer deposit against an invoice (DR Customer Deposits 2420 / CR A/R). Sum of amount_cents per deposit ties to customer_deposits.applied_cents.';

create index if not exists ix_deposit_apps_deposit on public.customer_deposit_applications (deposit_id);
create index if not exists ix_deposit_apps_invoice on public.customer_deposit_applications (org_id, invoice_id);

-- ---- RLS ----
alter table public.customer_deposits             enable row level security;
alter table public.customer_deposit_applications enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_deposits' and policyname='org_isolation')
    then create policy "org_isolation" on public.customer_deposits for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_deposits' and policyname='service_write')
    then create policy "service_write" on public.customer_deposits for all to service_role using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_deposit_applications' and policyname='org_isolation')
    then create policy "org_isolation" on public.customer_deposit_applications for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_deposit_applications' and policyname='service_write')
    then create policy "service_write" on public.customer_deposit_applications for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.customer_deposits             to anon, authenticated, service_role;
grant select, insert, update, delete on public.customer_deposit_applications to anon, authenticated, service_role;
