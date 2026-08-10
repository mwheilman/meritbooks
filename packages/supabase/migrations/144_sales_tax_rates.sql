-- =============================================================================
-- Migration 144: extend the existing sales-tax rate table for the live adapter.
-- =============================================================================
-- public.sales_tax_rates already exists (calc-at-invoice, GATE 11d) with:
--   state, county, city, jurisdiction_label, combined_rate_pct, effective_date,
--   end_date, is_active, notes, created_by. This migration ADDITIVELY adds the few
--   columns the provider-agnostic tax adapter wants — country (default US),
--   postal_code (for zip-level resolution), category (product/service tax class),
--   and source (MANUAL/IMPORT/PROVIDER) — so the internal-table provider can resolve
--   a rate by state->county->city->postal specificity with effective-dating. An
--   Avalara/TaxJar adapter is a later credential swap (code, not schema).
--
-- SAFETY / CANON §3: additive + idempotent; reference data only (no GL post, no
-- money movement). Existing rows get country='US', source='MANUAL' via defaults.
-- rate lives in combined_rate_pct (a percent); invoice tax stays bigint cents.
-- =============================================================================

alter table public.sales_tax_rates
  add column if not exists country     text not null default 'US',
  add column if not exists postal_code text,
  add column if not exists category    text,
  add column if not exists source      text not null default 'MANUAL';

do $$ begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where table_schema='public' and table_name='sales_tax_rates' and constraint_name='sales_tax_rates_source_check'
  ) then
    alter table public.sales_tax_rates
      add constraint sales_tax_rates_source_check check (source in ('MANUAL','IMPORT','PROVIDER'));
  end if;
end $$;

create index if not exists ix_sales_tax_rates_lookup
  on public.sales_tax_rates (org_id, country, state, county, city, postal_code, effective_date);
create index if not exists ix_sales_tax_rates_org_active
  on public.sales_tax_rates (org_id, is_active);
