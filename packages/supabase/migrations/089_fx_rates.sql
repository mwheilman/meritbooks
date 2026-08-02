-- =============================================================================
-- Migration 089: multi-currency FX rate table (GATE 11a — consolidation FX)
-- =============================================================================
-- The reference data the consolidation engine needs to TRANSLATE a foreign entity's
-- trial balance (kept in its functional currency) into the group's reporting
-- currency before it consolidates: P&L at the AVERAGE rate, balance-sheet monetary
-- items at the CLOSING (period-end) rate, and equity at a HISTORICAL rate, with the
-- residual booked to a Cumulative Translation Adjustment (CTA) so the translated
-- balance sheet still ties (current-rate method).
--
-- Generic + tenant-owned: NEVER hardcodes a currency or entity. `from_currency` is
-- an entity's functional currency, `to_currency` the group's reporting currency
-- (`core.organizations.home_currency`, added in migration 029). The engine DEGRADES
-- SAFE — with no rows here every entity is treated as already in the reporting
-- currency (rate 1.0, zero CTA), so a single-currency tenant is entirely unaffected.
--
-- Additive + idempotent (create-if-not-exists). RLS org_isolation via get_org_id()
-- (Clerk org claim; never auth.uid()). Requires 019 (core carve) + 029 (home
-- currency seam). Books band; next number: 090.
-- =============================================================================

-- ---- Guard: the org table this FKs to must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 (core carve) before 089.';
  end if;
end $$;

-- =============================================================================
-- 1. FX RATES
-- =============================================================================
-- One row = "1 unit of from_currency = `rate` units of to_currency, on rate_date,
-- for rate_type (SPOT / AVERAGE / CLOSING)."
--   • CLOSING  → period-end spot; used to translate ASSET / LIABILITY balances.
--   • AVERAGE  → period-average; used to translate REVENUE / expense (P&L) flows.
--   • SPOT     → point-in-time; a historical proxy for translating contributed EQUITY.
create table if not exists public.fx_rates (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- ISO-4217-style codes; kept as free text so the tenant defines its own set.
  from_currency text not null,
  to_currency   text not null,
  rate_date date not null default current_date,
  -- Units of to_currency per 1 unit of from_currency. High precision; NEVER money.
  rate numeric(18,8) not null check (rate > 0),
  rate_type text not null default 'CLOSING'
    check (rate_type in ('SPOT', 'AVERAGE', 'CLOSING')),
  notes text,
  created_by uuid,                           -- nullable; never a Clerk id (see 018)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fx_rates_distinct check (from_currency <> to_currency)
);

-- At most ONE rate per (currency pair, date, type): re-entering the same rate
-- upserts rather than duplicating; different dates/types keep the history.
create unique index if not exists uq_fx_rates_pair_date_type
  on public.fx_rates(org_id, from_currency, to_currency, rate_date, rate_type);

create index if not exists idx_fx_rates_lookup
  on public.fx_rates(org_id, from_currency, to_currency, rate_type, rate_date desc);

-- =============================================================================
-- 2. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================================
alter table public.fx_rates enable row level security;
do $$ begin
  create policy "org_isolation" on public.fx_rates
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.fx_rates
  to anon, authenticated, service_role;

-- Keep updated_at fresh if the shared trigger fn exists (it does post-001).
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_fx_rates_updated
        before update on public.fx_rates
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- =============================================================================
-- DONE. The tenant can now record FX rates per currency pair/date/type. The
-- consolidation engine reads these to translate foreign entities into the reporting
-- currency (P&L at AVERAGE, BS at CLOSING, equity at HISTORICAL/SPOT) with a CTA
-- plug so the translated statements tie. Absent any row, every entity is treated as
-- already in the reporting currency (rate 1.0) — single-currency safe.
--
-- FOLLOW-UP (reserved spine — REPORTED, not applied here): to know each entity's
-- functional currency, core.locations needs a `functional_currency text` column
-- (default = org home_currency). Until it exists, the loader treats every entity's
-- functional currency AS the reporting currency (identity translation).
-- =============================================================================
