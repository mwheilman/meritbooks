-- =============================================================================
-- Migration 139: estimates / quotes + estimate lines (AR front-of-funnel).
-- =============================================================================
-- Adds a real estimate/quote object that converts to an invoice on acceptance.
-- An estimate is a NON-POSTING sales document: it NEVER touches the GL. Only the
-- invoice generated on conversion posts (through the existing invoice-create /
-- gl-posting path, unchanged). Converting stamps estimates.status='CONVERTED' and
-- records the resulting invoice id so an estimate can never be double-converted.
--
-- SAFETY / CANON §3: additive + idempotent; no GL post, no money movement, no
-- posting triggers. RLS org_isolation via public.get_org_id(); money is bigint
-- cents. Customer/job/invoice ids are uuid columns stitched in JS (no cross-schema
-- FK), mirroring the vendor_id convention in migration 137.
-- =============================================================================

create table if not exists public.estimates (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null,                 -- core.locations (stitched in JS)
  customer_id           uuid not null,                 -- core.customers (stitched in JS)
  job_id                uuid,                          -- optional core.jobs link (stitched in JS)
  estimate_number       text not null,
  status                text not null default 'DRAFT'
                          check (status in ('DRAFT','SENT','ACCEPTED','DECLINED','EXPIRED','CONVERTED')),
  estimate_date         date not null default current_date,
  expiration_date       date,
  subtotal_cents        bigint not null default 0,
  tax_cents             bigint not null default 0,
  total_cents           bigint not null default 0,
  currency              text not null default 'USD',
  notes                 text,
  converted_invoice_id  uuid,                          -- set once, on conversion (idempotency guard)
  converted_at          timestamptz,
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, estimate_number)
);

comment on table public.estimates is
  'Estimates / quotes — a NON-POSTING sales document that converts to an invoice on acceptance. Never touches the GL; only the converted invoice posts. converted_invoice_id guards against double-conversion.';

create index if not exists ix_estimates_org_status   on public.estimates (org_id, status);
create index if not exists ix_estimates_org_customer on public.estimates (org_id, customer_id);
create index if not exists ix_estimates_org_location on public.estimates (org_id, location_id);

create table if not exists public.estimate_lines (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  estimate_id        uuid not null references public.estimates(id) on delete cascade,
  line_number        int  not null default 1,
  description        text not null,
  quantity           numeric not null default 1,
  unit_price_cents   bigint not null default 0,
  amount_cents       bigint not null default 0,
  revenue_account_id uuid,                             -- core account chosen for the eventual invoice line (stitched in JS)
  created_at         timestamptz not null default now()
);

comment on table public.estimate_lines is
  'Line items on an estimate. amount_cents is the extended (bigint cents) line total; carried onto the invoice line on conversion.';

create index if not exists ix_estimate_lines_estimate on public.estimate_lines (estimate_id);

-- ---- RLS ----
alter table public.estimates      enable row level security;
alter table public.estimate_lines enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='estimates' and policyname='org_isolation')
    then create policy "org_isolation" on public.estimates for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='estimates' and policyname='service_write')
    then create policy "service_write" on public.estimates for all to service_role using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='estimate_lines' and policyname='org_isolation')
    then create policy "org_isolation" on public.estimate_lines for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='estimate_lines' and policyname='service_write')
    then create policy "service_write" on public.estimate_lines for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.estimates      to anon, authenticated, service_role;
grant select, insert, update, delete on public.estimate_lines to anon, authenticated, service_role;
