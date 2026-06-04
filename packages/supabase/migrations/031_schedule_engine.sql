-- Migration 031: Schedule / exception engine (GATE 2 — Session 21, step 3)
-- =============================================================
-- The recognition layer that turns one-time set-ups into recurring period posts:
--   - posting_schedules: generic straight-line schedules (prepaid amortization,
--     deferred-revenue recognition, or any straight-line allocation). Each row
--     carries an explicit debit + credit account, so direction is unambiguous and
--     contra accounts are never mis-signed. A run ledger prevents double-posting.
--   - depreciation_runs: one row per fixed asset per period, the idempotency +
--     audit ledger for the depreciation engine (which reads the schedule straight
--     off fixed_assets — cost, salvage, useful life, method, and the three GL
--     accounts are already on that table).
--
-- Recurring journal entries reuse the existing recurring_templates table
-- (migration 007); this migration adds no table for them — only the engine code.
--
-- ADDITIVE + idempotent. Requires 004 (GL), 008 (fixed_assets), 019 (core carve).
-- Next migration number after this: 032.
-- =============================================================

-- =============================================================
-- 1. POSTING SCHEDULES (prepaid amortization / deferred revenue / straight-line)
-- =============================================================
create table if not exists public.posting_schedules (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),

  schedule_type text not null
    check (schedule_type in ('PREPAID_AMORTIZATION', 'DEFERRED_REVENUE', 'STRAIGHT_LINE')),

  -- explicit legs: each period posts DR debit_account / CR credit_account
  debit_account_id uuid not null references public.accounts(id),
  credit_account_id uuid not null references public.accounts(id),

  total_cents bigint not null check (total_cents > 0),
  months int not null check (months > 0),
  start_date date not null,
  amount_per_period_cents bigint not null check (amount_per_period_cents > 0),

  periods_posted int not null default 0,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'CANCELLED')),

  -- dimensions + provenance
  department_id uuid references core.departments(id),
  source_type text,        -- e.g. 'BILL', 'INVOICE', 'MANUAL'
  source_id uuid,
  memo text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_posting_schedules_org on public.posting_schedules(org_id);
create index if not exists idx_posting_schedules_active
  on public.posting_schedules(org_id, status) where status = 'ACTIVE';

create table if not exists public.posting_schedule_runs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  schedule_id uuid not null references public.posting_schedules(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  amount_cents bigint not null,
  gl_entry_id uuid references public.gl_entries(id),
  posted_at timestamptz not null default now(),
  unique (schedule_id, period_year, period_month)
);

create index if not exists idx_posting_schedule_runs_schedule on public.posting_schedule_runs(schedule_id);

-- =============================================================
-- 2. DEPRECIATION RUNS (idempotency + audit for the depreciation engine)
-- =============================================================
create table if not exists public.depreciation_runs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  fixed_asset_id uuid not null references public.fixed_assets(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  amount_cents bigint not null,
  gl_entry_id uuid references public.gl_entries(id),
  posted_at timestamptz not null default now(),
  unique (fixed_asset_id, period_year, period_month)
);

create index if not exists idx_depreciation_runs_asset on public.depreciation_runs(fixed_asset_id);
create index if not exists idx_depreciation_runs_org on public.depreciation_runs(org_id);

-- =============================================================
-- 3. RLS + updated_at
-- =============================================================
alter table public.posting_schedules enable row level security;
alter table public.posting_schedule_runs enable row level security;
alter table public.depreciation_runs enable row level security;

do $$ begin
  create policy "org_isolation" on public.posting_schedules for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "org_isolation" on public.posting_schedule_runs for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "org_isolation" on public.depreciation_runs for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_posting_schedules_updated before update on public.posting_schedules
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;

-- =============================================================
-- DONE. Schedule + depreciation run ledgers in place. The engines post the
-- periodic entries and record a run row per (schedule|asset, period) so a re-run
-- is idempotent.
-- =============================================================
