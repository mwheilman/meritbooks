-- =============================================================================
-- Migration 103: Sales-tax rates (GATE 11d) — tax at invoice creation
-- =============================================================================
-- Effective-dated combined sales-tax rates per jurisdiction (state/county/city;
-- null = wildcard) that drive tax computed AT invoice creation. Resolution is
-- most-specific-wins (city > county > state), latest effective date breaks ties.
-- Computed tax accrues as a SEPARATE CR to SALES_TAX_PAYABLE (by role) in the
-- balanced invoice entry — never mixed into revenue. Additive + idempotent, RLS
-- org_isolation via get_org_id(). App degrades SAFE (tax = 0, no regression) if the
-- table/columns are absent or no rate is configured. Books band; next number: 104.
-- SALES_TAX_PAYABLE role already exists (default acct 2300) — no COA seed needed.
-- =============================================================================

create table if not exists public.sales_tax_rates (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  state              text not null,
  county             text,
  city               text,
  jurisdiction_label text not null,
  combined_rate_pct  numeric(7,4) not null check (combined_rate_pct >= 0 and combined_rate_pct <= 30),
  effective_date     date not null,
  end_date           date,
  is_active          boolean not null default true,
  notes              text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (end_date is null or end_date >= effective_date)
);
create index if not exists idx_sales_tax_rates_lookup
  on public.sales_tax_rates(org_id, state, effective_date desc) where is_active;

alter table public.sales_tax_rates enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sales_tax_rates' and policyname='org_isolation')
    then create policy "org_isolation" on public.sales_tax_rates for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sales_tax_rates' and policyname='service_write')
    then create policy "service_write" on public.sales_tax_rates for all to service_role using (true) with check (true); end if;
end $$;
grant select, insert, update, delete on public.sales_tax_rates to anon, authenticated, service_role;

alter table public.invoices add column if not exists tax_rate_pct     numeric(7,4);
alter table public.invoices add column if not exists tax_jurisdiction text;
