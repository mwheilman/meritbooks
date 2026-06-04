-- Migration 032: Rev-rec method by REVENUE TYPE (GATE 2 — Session 21, step 4)
-- =============================================================
-- Billing is decoupled from revenue recognition. WHICH method applies is chosen
-- per REVENUE TYPE (revenue account) at company setup — e.g. Service Revenue =
-- POINT_OF_SALE (recognize as billed) while Construction Revenue = PCT_COMPLETE
-- (defer at billing; the rev-rec engine earns it out). Certain jobs can override
-- the method within their revenue type.
--
-- New resolution order (supersedes the old job_type-keyed map as the primary):
--   1. per-job override        core.jobs.rev_rec_method_override
--   2. per-revenue-type method revenue_type_methods[revenue_account_id]   ← NEW primary
--   3. (legacy) job_type map   rev_rec_method_map                          (kept as fallback)
--   4. company default         core.locations.rev_rec_method
--
-- This adds:
--   - revenue_type_methods: per-company method per revenue account.
--   - core.jobs.revenue_account_id: the revenue type a job earns under, so the
--     rev-rec engine can resolve a job's method by its revenue type.
--
-- SUITE NOTE (cross-reference merit-suite-shared-object-ownership-matrix.md):
--   core.jobs.revenue_account_id is a Books-owned GL/rev-rec mapping column
--   co-located on the shared core.jobs object — same ownership category as the
--   recognized/WIP/deferred rev-rec columns, items.income_account_id, and
--   locations.rev_rec_method. MeritBooks owns it; Projects reads it. Per the
--   matrix's "write only fields you own" rule, MeritProjects must NOT write this
--   column when it provisions a job — it is set in Books (or the shared job-setup
--   action). The JOB_BILLING seam is unchanged: Books resolves defer-vs-recognize
--   at posting time from the job + revenue account.
--
-- ADDITIVE + idempotent. Requires 003 (accounts), 019 (core carve), 023 (rev-rec).
-- Next migration number after this: 033.
-- =============================================================

-- =============================================================
-- 1. Per-revenue-type method selection (per company)
-- =============================================================
create table if not exists public.revenue_type_methods (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  revenue_account_id uuid not null references public.accounts(id) on delete cascade,
  method rev_rec_method_enum not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, location_id, revenue_account_id)
);

create index if not exists idx_revenue_type_methods_lookup
  on public.revenue_type_methods(org_id, location_id, revenue_account_id);

alter table public.revenue_type_methods enable row level security;
do $$ begin
  create policy "org_isolation" on public.revenue_type_methods for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_revenue_type_methods_updated before update on public.revenue_type_methods
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;

-- =============================================================
-- 2. Link a job to the revenue type it earns under
-- =============================================================
-- Nullable: jobs without an explicit revenue type fall back to the job_type map
-- / company default, exactly as before, so existing jobs are unaffected.
alter table core.jobs
  add column if not exists revenue_account_id uuid references public.accounts(id);

create index if not exists idx_jobs_revenue_account on core.jobs(revenue_account_id)
  where revenue_account_id is not null;

-- =============================================================
-- DONE. Rev-rec method is now selectable per revenue type, overridable per job.
-- The resolver and the billing defer-vs-recognize decision both read this.
-- =============================================================
