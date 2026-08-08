-- =============================================================================
-- Migration 105: sales_tax_filings — filing calendar status + remittance records
-- =============================================================================
-- Backs the sales-tax filing calendar + liability-owed dashboard: one row per
-- (org, jurisdiction, period) a tenant has filed/remitted. Net owed = collected
-- (from the accrual/return worksheet) − remitted (this record). The calendar + due
-- dates + collected are computed live from sales_tax_rates + invoice tax accrual;
-- this table only records filed/remitted status. Additive + idempotent. RLS
-- org_isolation via get_org_id(). App degrades SAFE if absent (all periods show
-- unfiled; owed = full collected). Books band; next number: 106.
-- =============================================================================

create table if not exists public.sales_tax_filings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  jurisdiction        text not null,
  period_key          text not null,
  frequency           text not null default 'quarterly' check (frequency in ('monthly','quarterly','annual')),
  period_start        date not null,
  period_end          date not null,
  due_date            date not null,
  status              text not null default 'FILED' check (status in ('FILED','REMITTED')),
  filed_at            timestamptz,
  remitted_cents      bigint not null default 0 check (remitted_cents >= 0),
  collected_cents     bigint,
  confirmation_number text,
  notes               text,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, jurisdiction, period_key)
);
create index if not exists idx_sales_tax_filings_lookup
  on public.sales_tax_filings(org_id, jurisdiction, due_date);
alter table public.sales_tax_filings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sales_tax_filings' and policyname='org_isolation')
    then create policy "org_isolation" on public.sales_tax_filings for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sales_tax_filings' and policyname='service_write')
    then create policy "service_write" on public.sales_tax_filings for all to service_role using (true) with check (true); end if;
end $$;
grant select, insert, update, delete on public.sales_tax_filings to anon, authenticated, service_role;
