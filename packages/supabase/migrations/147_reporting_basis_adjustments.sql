-- =============================================================================
-- Migration 147: reporting-basis adjustment layer (safe "multi-book" overlay).
-- =============================================================================
-- The GAAP/accrual general ledger stays the ONE book of record. This table holds
-- per-period, per-account ADJUSTMENTS that a report LAYERS on top of the GAAP trial
-- balance to PRESENT a different basis (TAX / CASH / CUSTOM) — without a parallel
-- ledger and without touching the posting engine (CANON GATE 2 invariant preserved).
-- It generalizes what book-to-tax M-1 already does for tax, into a report-time
-- overlay for cash/custom bases too.
--
-- SAFETY / CANON §3: additive + idempotent; these rows NEVER post to the GL and are
-- NOT journal entries — they are report-presentation adjustments only. amount_cents is
-- a SIGNED delta vs the GAAP balance. RLS org_isolation via public.get_org_id().
-- =============================================================================

create table if not exists public.reporting_basis_adjustments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid,
  basis           text not null check (basis in ('TAX','CASH','CUSTOM')),
  custom_label    text,                          -- names the CUSTOM basis (e.g. 'Bank covenant basis')
  period_year     int not null,
  period_month    int,                           -- null = whole-year adjustment
  account_id      uuid not null,                 -- the GAAP account being adjusted (stitched in JS)
  description     text,
  amount_cents    bigint not null,               -- SIGNED delta vs the GAAP balance
  adjustment_type text check (adjustment_type in ('TIMING','PERMANENT','RECLASS')),
  source          text not null default 'MANUAL' check (source in ('MANUAL','DERIVED','IMPORT')),
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.reporting_basis_adjustments is
  'Report-time basis adjustments layered on the GAAP trial balance to present TAX/CASH/CUSTOM basis. NOT journal entries, never posts to the GL — the accrual ledger stays the single book of record (CANON GATE 2). amount_cents is a signed delta.';

create index if not exists ix_basis_adj_lookup on public.reporting_basis_adjustments (org_id, basis, period_year, period_month);
create index if not exists ix_basis_adj_account on public.reporting_basis_adjustments (org_id, account_id);

alter table public.reporting_basis_adjustments enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='reporting_basis_adjustments' and policyname='org_isolation')
    then create policy "org_isolation" on public.reporting_basis_adjustments for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='reporting_basis_adjustments' and policyname='service_write')
    then create policy "service_write" on public.reporting_basis_adjustments for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.reporting_basis_adjustments to anon, authenticated, service_role;
