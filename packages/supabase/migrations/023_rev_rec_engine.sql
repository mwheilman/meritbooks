-- Migration 023: Revenue-recognition engine (Books side) + v3 contract support
-- =============================================================
-- Implements:
--  (1) per-job rev-rec method resolution config (company default lives on
--      core.locations.rev_rec_method; this adds the job_type -> method map; the
--      optional per-job override lives on core.jobs.rev_rec_method).
--  (2) recognition run ledger (audit + prevents double-recognition).
--  (3) JOB_PROGRESS consumer support — no new event DDL (core.events exists);
--      pinned inputs land on existing core.jobs columns
--      (contract_amount_cents, estimated_cost_cents, pct_complete).
--  (4) entitlements on core.organizations (standalone vs Projects-present).
--  (5) invoice_number column on core.events (JOB_BILLING write-back, contract §4/§6).
--  (6) an Unbilled Receivable (contract asset) account per org for POC postings.
--
-- Idempotent. Requires 019 (core carve), 021 (seam), and the base COA.
-- =============================================================

-- ---- Guards ----
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='core' and table_name='events') then
    raise exception 'core.events not found — deploy migration 021 before 023.';
  end if;
end $$;

-- =============================================================
-- 1. Open-ended method set — add CASH (others already exist:
--    PCT_COSTS_INCURRED, PCT_COMPLETE, COMPLETED_CONTRACT, POINT_OF_SALE,
--    MILESTONE, AS_BILLED, RATABLY, SUBSCRIPTION). Not used in DML this migration.
-- =============================================================
alter type rev_rec_method_enum add value if not exists 'CASH';

-- =============================================================
-- 2. Per-company job_type -> method mapping (resolution step 2)
-- =============================================================
create table if not exists rev_rec_method_map (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  job_type text not null,                       -- matches core.jobs.job_type / archetype
  method rev_rec_method_enum not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, location_id, job_type)
);
alter table rev_rec_method_map enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='rev_rec_method_map' and policyname='org_isolation') then
    create policy "org_isolation" on rev_rec_method_map for all using (org_id = public.get_org_id());
  end if;
end $$;
create index if not exists idx_revrec_map_lookup on rev_rec_method_map(org_id, location_id, job_type);

-- =============================================================
-- 3. Recognition run ledger (one row per job per recognition posting)
-- =============================================================
create table if not exists revenue_recognition_runs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  job_id uuid not null references core.jobs(id),
  as_of_date date not null,
  method rev_rec_method_enum not null,
  contract_value_cents bigint not null default 0,
  cost_estimate_cents bigint not null default 0,
  actual_cost_cents bigint not null default 0,
  pct_recognized numeric(7,4),                  -- 0..1 fraction earned
  earned_to_date_cents bigint not null default 0,
  prior_recognized_cents bigint not null default 0,
  recognized_delta_cents bigint not null default 0,
  gl_entry_id uuid references gl_entries(id),
  run_by text,
  created_at timestamptz not null default now()
);
alter table revenue_recognition_runs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='revenue_recognition_runs' and policyname='org_isolation') then
    create policy "org_isolation" on revenue_recognition_runs for all using (org_id = public.get_org_id());
  end if;
end $$;
create index if not exists idx_revrec_runs_job on revenue_recognition_runs(org_id, job_id, as_of_date);

-- track the last recognition date on the job (revenue_recognized_cents already exists)
alter table core.jobs add column if not exists rev_rec_last_run_on date;

-- explicit per-job method override (resolution step 1). NULL = fall through to the
-- job_type map, then the company default. Distinct from the existing rev_rec_method
-- column (which the engine syncs to the *resolved* method for display).
alter table core.jobs add column if not exists rev_rec_method_override rev_rec_method_enum;

-- =============================================================
-- 4. Entitlements on the tenant (which sibling modules are present)
--    Default {} = standalone (no Projects) -> Books exposes direct entry.
-- =============================================================
alter table core.organizations add column if not exists entitlements jsonb not null default '{}'::jsonb;

-- =============================================================
-- 5. invoice_number write-back on the event row (contract §4/§6 carryover)
-- =============================================================
alter table core.events add column if not exists invoice_number text;

-- =============================================================
-- 6. Unbilled Receivable (contract asset) account, per org, if missing.
--    Used by POC recognition when earned revenue exceeds amounts billed.
--    Created in the same account group as Accounts Receivable (1100).
-- =============================================================
insert into accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '1180', 'Unbilled Receivable (Contract Asset)', 'ASSET', 'CURRENT_ASSET', true, 'APPROVED', 6
from accounts a
where a.account_number = '1100'
  and not exists (select 1 from accounts x where x.org_id = a.org_id and x.account_number = '1180');
