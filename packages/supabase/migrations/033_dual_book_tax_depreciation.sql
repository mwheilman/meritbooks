-- Migration 033: Dual-book depreciation — tax track (GATE 2 — Session 21, step 5)
-- =============================================================
-- The financial GL carries BOOK depreciation (straight-line, posted). TAX
-- depreciation (Section 179 / bonus / MACRS) is tracked in PARALLEL and is NOT
-- posted to the financial GL — it drives the tax return and the book-vs-tax
-- timing difference (deferred tax). This adds the tax columns to fixed_assets and
-- a parallel run-log table mirroring depreciation_runs.
--
-- Annual IRS limits (179 cap/phaseout, bonus %) are NOT hardcoded — they change
-- yearly, so they are supplied per asset and the engine applies the mechanics.
--
-- ADDITIVE + idempotent. Requires 008 (fixed_assets), 031 (depreciation_runs).
-- Next migration number after this: 034.
-- =============================================================

-- =============================================================
-- 1. Tax-depreciation columns on fixed_assets (parallel to the book fields)
-- =============================================================
alter table public.fixed_assets
  -- Tax method for this asset. NONE = no separate tax track (tax = book).
  add column if not exists tax_method text not null default 'NONE'
    check (tax_method in ('NONE', 'SL', 'MACRS', 'SECTION_179', 'BONUS')),
  -- MACRS GDS recovery period in years (3,5,7,10,15,20) when tax_method='MACRS'.
  add column if not exists tax_recovery_years int,
  -- Convention. Half-year is the default; mid-quarter is flagged but not yet computed.
  add column if not exists tax_convention text not null default 'HALF_YEAR'
    check (tax_convention in ('HALF_YEAR', 'MID_QUARTER', 'MID_MONTH')),
  -- Straight-line tax life (months) when tax_method='SL'.
  add column if not exists tax_life_months int,
  -- Year-1 immediate expensing inputs (caller supplies the allowed amounts).
  add column if not exists section_179_cents bigint not null default 0,
  add column if not exists bonus_pct numeric(5,2) not null default 0,  -- 0..100
  -- Running tax-basis tracking (parallel to accumulated_depreciation_cents).
  add column if not exists tax_accumulated_depreciation_cents bigint not null default 0,
  add column if not exists tax_last_depreciation_date date;

-- =============================================================
-- 2. Parallel tax-depreciation run log (mirror of depreciation_runs)
-- =============================================================
create table if not exists public.tax_depreciation_runs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  fixed_asset_id uuid not null references public.fixed_assets(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  amount_cents bigint not null,
  method text not null,         -- the tax method applied for this run
  memo text,
  created_at timestamptz not null default now(),
  unique (fixed_asset_id, period_year, period_month)
);

create index if not exists idx_tax_depr_runs_asset on public.tax_depreciation_runs(fixed_asset_id);

alter table public.tax_depreciation_runs enable row level security;
do $$ begin
  create policy "org_isolation" on public.tax_depreciation_runs for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

-- =============================================================
-- DONE. fixed_assets now carries a parallel tax track; tax_depreciation_runs logs
-- tax depreciation without touching the financial GL. The book-tax difference is
-- accumulated_depreciation_cents (book) − tax_accumulated_depreciation_cents (tax).
-- =============================================================
