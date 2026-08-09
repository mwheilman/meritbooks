-- =============================================================================
-- Migration 132: Insurance premium amortization (prepaid insurance -> expense)
-- =============================================================================
-- Turns the insurance REGISTER (migration 084, `insurance_policies`) into a real
-- book-of-record capability: a policy's up-front premium is carried as a prepaid
-- ASSET and amortized straight-line into insurance EXPENSE over the coverage term.
--
-- Mirrors the prepaid amortization rail (migration 031 posting_schedules /
-- posting_schedule_runs) but as DEDICATED, insurance-owned tables so the schedule
-- can (a) link to its policy, and (b) carry a nullable-location policy while still
-- resolving a concrete posting location. Each period posts a balanced JE:
--     DR Insurance Expense (INSURANCE_EXPENSE role, default 6700)
--     CR Prepaid Insurance  (PREPAID_INSURANCE role, default 1300)
-- through the deterministic posting engine. The run ledger's UNIQUE
-- (schedule_id, period_year, period_month) is the double-post guarantor.
--
-- Additive + idempotent. Requires 001 (core), 004 (GL), 029 (core.account_role_keys),
-- 084 (insurance_policies). Next migration number after this: 133.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'insurance_policies') then
    raise exception 'public.insurance_policies not found — expected from migration 084.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'account_role_keys') then
    raise exception 'core.account_role_keys not found — expected from migration 029.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Account-role registry: the two legs of an insurance amortization
-- -----------------------------------------------------------------------------
-- Both default to accounts that already exist in the standard COA (1300 "Prepaid
-- Insurance" asset, 6700 "General Liability Insurance" expense) — no new accounts.
-- A tenant may remap either on the Account Roles screen.
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('PREPAID_INSURANCE', 'Prepaid Insurance (asset)',  'ORG', '1300'),
  ('INSURANCE_EXPENSE', 'Insurance Expense',          'ORG', '6700')
on conflict (role_key) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Amortization schedules (one per policy premium being amortized)
-- -----------------------------------------------------------------------------
create table if not exists public.insurance_amortization_schedules (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  policy_id uuid not null references public.insurance_policies(id) on delete cascade,
  -- concrete posting location (resolved from the policy or the org's first location;
  -- the policy itself may be null-location / consolidated).
  location_id uuid not null references core.locations(id),

  -- explicit legs: each period posts DR expense / CR prepaid asset.
  expense_account_id uuid not null references public.accounts(id),
  prepaid_account_id uuid not null references public.accounts(id),

  total_cents bigint not null check (total_cents > 0),
  months int not null check (months > 0),
  start_date date not null,
  amount_per_period_cents bigint not null check (amount_per_period_cents > 0),

  periods_posted int not null default 0,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'CANCELLED')),

  department_id uuid references core.departments(id),
  memo text,
  created_by_user text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one live (non-cancelled) amortization schedule per policy; re-creation after
-- a cancel is allowed.
create unique index if not exists uq_insurance_amort_policy_live
  on public.insurance_amortization_schedules(policy_id)
  where status <> 'CANCELLED';

create index if not exists idx_insurance_amort_org
  on public.insurance_amortization_schedules(org_id, created_at desc);
create index if not exists idx_insurance_amort_active
  on public.insurance_amortization_schedules(org_id, status) where status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- 3. Run ledger (idempotency + audit — one row per posted period)
-- -----------------------------------------------------------------------------
create table if not exists public.insurance_amortization_runs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  schedule_id uuid not null references public.insurance_amortization_schedules(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  amount_cents bigint not null,
  gl_entry_id uuid references public.gl_entries(id),
  posted_at timestamptz not null default now(),
  unique (schedule_id, period_year, period_month)
);

create index if not exists idx_insurance_amort_runs_schedule
  on public.insurance_amortization_runs(schedule_id);

-- -----------------------------------------------------------------------------
-- 4. RLS (org isolation) + grants + updated_at
-- -----------------------------------------------------------------------------
alter table public.insurance_amortization_schedules enable row level security;
alter table public.insurance_amortization_runs enable row level security;

do $$ begin
  create policy "org_isolation" on public.insurance_amortization_schedules
    for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "org_isolation" on public.insurance_amortization_runs
    for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.insurance_amortization_schedules
  to anon, authenticated, service_role;
grant select, insert, update, delete on public.insurance_amortization_runs
  to anon, authenticated, service_role;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_insurance_amort_updated before update on public.insurance_amortization_schedules
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;

-- =============================================================================
-- DONE. The insurance register can now amortize a prepaid premium to expense as a
-- balanced JE each period (DR INSURANCE_EXPENSE / CR PREPAID_INSURANCE), idempotent
-- per (schedule, period). Renewal/register tracking (migration 084) is untouched.
-- =============================================================================
