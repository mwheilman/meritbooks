-- Migration 078: Loan Covenant Monitor (GATE 7 / FP&A — Covenant-Breach Monitor, matrix E1/G2)
-- =============================================================
-- The CFO's #1 career-risk catch. Machine-readable covenant definitions per credit
-- agreement (DSCR / FCCR / leverage / current ratio / min-liquidity / TNW / custom),
-- each with a threshold + direction (min/max), a test frequency, and a MEASUREMENT
-- definition (jsonb) that says which ledger roles/account families feed the
-- numerator/denominator so the deterministic engine can compute the ratio from the
-- owned ledger — never from a spreadsheet, never by the model. A companion append-only
-- `covenant_measurements` table records each computed test (actual or forecast) so the
-- dashboard has a real trend line and the projected-breach date is auditable.
--
-- Degrade-safe: no covenants defined => empty monitor, nothing else breaks. The two
-- tables are additive and isolated; no existing table is touched.
--
-- Additive + idempotent. Requires 019 (core carve). RLS org_isolation via get_org_id().
-- Books band. Next migration number: 079.
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 before 078.';
  end if;
end $$;

-- ── Covenant definitions ──────────────────────────────────────────────────────
create table if not exists public.loan_covenants (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Consolidated (null) or scoped to a single company/location.
  location_id uuid references core.locations(id) on delete set null,
  loan_name text not null,                       -- e.g. "Term Loan A"
  facility text,                                 -- e.g. "$25M Senior Secured"
  lender_name text,                              -- e.g. "Northwest Bank"
  covenant_type text not null
    check (covenant_type in
      ('DSCR', 'FCCR', 'LEVERAGE', 'CURRENT_RATIO', 'MIN_LIQUIDITY', 'TNW', 'CUSTOM')),
  -- Threshold the covenant is tested against (a ratio like 1.25 or a dollar amount).
  threshold numeric(18,4) not null,
  -- MIN: measured value must be >= threshold (DSCR/FCCR/current ratio/liquidity/TNW).
  -- MAX: measured value must be <= threshold (leverage / net-debt-to-EBITDA).
  direction text not null default 'MIN' check (direction in ('MIN', 'MAX')),
  test_frequency text not null default 'QUARTERLY'
    check (test_frequency in ('MONTHLY', 'QUARTERLY', 'ANNUAL')),
  -- Warn band: WARN when passing but headroom < warn_headroom_pct (fraction, e.g. 0.10).
  warn_headroom_pct numeric(6,4) not null default 0.10,
  -- Which ledger roles/families feed the ratio + config (trailing months, principal,
  -- fixed-charge add-ons, revolver availability, intangibles, manual overrides).
  measurement jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'WAIVED', 'CURED', 'INACTIVE')),
  effective_date date,
  maturity_date date,
  notes text,
  created_by_user text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_loan_covenants_org
  on public.loan_covenants(org_id, status, created_at desc);
create index if not exists idx_loan_covenants_location
  on public.loan_covenants(org_id, location_id);

alter table public.loan_covenants enable row level security;
do $$ begin
  create policy "org_isolation" on public.loan_covenants
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.loan_covenants
  to anon, authenticated, service_role;

-- ── Computed test results (append-only trend + audit of the breach projection) ─
create table if not exists public.covenant_measurements (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  covenant_id uuid not null references public.loan_covenants(id) on delete cascade,
  measured_at timestamptz not null default now(),
  period_end date,                               -- as-of date the test represents
  source text not null default 'ACTUAL' check (source in ('ACTUAL', 'FORECAST')),
  -- The computed value (a ratio, or a dollar amount for currency covenants) and its parts.
  value numeric(18,4),                           -- null when not computable (degrade)
  numerator_cents bigint,
  denominator_cents bigint,
  threshold numeric(18,4) not null,
  direction text not null,
  -- 'RATIO' | 'CURRENCY' — how `value`/`threshold` should be read.
  unit text not null default 'RATIO',
  headroom_pct numeric(10,4),                    -- signed: positive = cushion, negative = breach depth
  passed boolean,
  band text check (band in ('PASS', 'WARN', 'BREACH', 'UNKNOWN')),
  -- First forward period the projection crosses the threshold (null = no breach in horizon).
  projected_breach_date date,
  components jsonb not null default '{}'::jsonb,  -- transparency: EBITDA, debt service, etc.
  created_at timestamptz not null default now()
);

create index if not exists idx_covenant_measurements_cov
  on public.covenant_measurements(org_id, covenant_id, measured_at desc);

alter table public.covenant_measurements enable row level security;
do $$ begin
  create policy "org_isolation" on public.covenant_measurements
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.covenant_measurements
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. Covenants defined per credit agreement; each test snapshot recorded for
-- trend + audit. No covenants => empty monitor; nothing else is affected.
-- =============================================================
