-- Migration 034: Tax-year statutory params (GATE 2 — Session 21, step 6)
-- =============================================================
-- The tax-depreciation engine should KNOW the current-year IRS limits rather than
-- make a user hand-key them. This table carries, per tax year, the Section 179
-- deduction cap + phase-out threshold and the bonus-depreciation %. The engine
-- reads these as DEFAULTS; a per-asset value overrides.
--
-- Governance: statutory values must not silently auto-apply. Each row carries a
-- `confirmed` flag — the AI's annual job is to PROPOSE the new tax year's values
-- (confirmed=false, with a source) and a human confirms before they drive tax
-- numbers. Confirmed history is never overwritten silently.
--
-- Seeded values (sources cited; confirm against the IRS revenue procedure):
--   2024: $1,220,000 cap / $3,050,000 phase-out, 60% bonus   (TCJA, inflation-adj.) — confirmed
--   2025: $2,500,000 cap / $4,000,000 phase-out, 100% bonus  (OBBBA; PIS after 1/19/2025) — confirmed
--   2026: $2,560,000 cap / $4,090,000 phase-out, 100% bonus  (industry-reported, IRS authoritative pending) — UNCONFIRMED
--
-- ADDITIVE + idempotent. Requires 029 (organizations), 033 (fixed_assets tax cols).
-- Next migration number after this: 035.
-- =============================================================

-- =============================================================
-- 1. Per-tax-year params (per org; federal values seeded, tenant may adjust)
-- =============================================================
create table if not exists public.tax_year_params (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  tax_year int not null,
  section_179_max_cents bigint not null,
  section_179_phaseout_threshold_cents bigint not null,
  bonus_pct numeric(5,2) not null,           -- 0..100
  source text,                               -- where the values came from
  confirmed boolean not null default false,  -- human-confirmed vs AI-proposed
  confirmed_by text,                         -- Clerk user id (text)
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, tax_year)
);

create index if not exists idx_tax_year_params_lookup on public.tax_year_params(org_id, tax_year);

alter table public.tax_year_params enable row level security;
do $$ begin
  create policy "org_isolation" on public.tax_year_params for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_tax_year_params_updated before update on public.tax_year_params
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;

-- =============================================================
-- 2. Per-asset bonus is now an OPTIONAL override (null ⇒ use the tax-year default)
-- =============================================================
-- Existing rows keep their 0 (= elected out / no bonus). New assets that should
-- use the year default are inserted with null.
alter table public.fixed_assets alter column bonus_pct drop not null;
alter table public.fixed_assets alter column bonus_pct drop default;

-- =============================================================
-- 3. Seeder — federal values per org. Confirmed history is never overwritten.
-- =============================================================
create or replace function public.seed_tax_year_params(p_org uuid) returns void as $$
begin
  insert into public.tax_year_params (org_id, tax_year, section_179_max_cents, section_179_phaseout_threshold_cents, bonus_pct, source, confirmed, confirmed_at)
  values
    (p_org, 2024, 122000000, 305000000, 60.00,  'TCJA inflation-adjusted (IRS Rev. Proc.)', true, now()),
    (p_org, 2025, 250000000, 400000000, 100.00, 'OBBBA 2025 — 100% bonus for property PIS after 1/19/2025', true, now()),
    (p_org, 2026, 256000000, 409000000, 100.00, 'Industry-reported inflation estimate; IRS authoritative pending', false, null)
  on conflict (org_id, tax_year) do nothing;  -- never clobber confirmed rows
end;
$$ language plpgsql;

do $$
declare r record;
begin
  for r in select id from core.organizations loop
    perform public.seed_tax_year_params(r.id);
  end loop;
end $$;

-- =============================================================
-- DONE. The tax-depreciation engine reads tax_year_params for the asset's
-- placed-in-service year (bonus default + 179 cap/phase-out); per-asset values
-- override. 2026 is seeded UNCONFIRMED pending the IRS figure.
-- =============================================================
