-- Migration 083: Debt Register + Amortization (GATE 8 / FP&A — debt instruments)
-- =============================================================
-- A machine-readable register of every credit facility a tenant carries (term loan,
-- SBA loan, mortgage, equipment loan, line of credit) with the terms needed to build
-- a deterministic amortization schedule and to post the monthly interest accrual /
-- payment through the owned ledger. Pairs with the covenant monitor (078): an
-- instrument may LINK to a `loan_covenant` so a facility's covenants and its
-- amortization live side by side.
--
-- `debt_instruments` holds the terms (principal, rate, rate_type, dates, payment +
-- frequency, compounding, amortization method, status) plus OPTIONAL account
-- overrides so posting resolves the notes-payable / interest-expense / interest-
-- payable / cash accounts deterministically (else the poster resolves by ROLE and
-- refuses to guess). `debt_schedule_lines` is the generated amortization schedule —
-- one row per period with interest / principal / remaining balance (bigint cents).
--
-- Degrade-safe: no instruments => empty register, nothing else breaks. Both tables
-- are additive and isolated; no existing table is touched. All money is bigint cents.
--
-- Additive + idempotent. Requires 019 (core carve) and 078 (loan_covenants). RLS
-- org_isolation via get_org_id(). Books band. Next migration number: 084.
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 before 083.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'loan_covenants') then
    raise exception 'public.loan_covenants not found — deploy migration 078 before 083.';
  end if;
end $$;

-- ── Debt instruments (the register) ───────────────────────────────────────────
create table if not exists public.debt_instruments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Consolidated (null) or scoped to a single company/location. Also the location
  -- whose fiscal period + dimensions the posting engine uses.
  location_id uuid references core.locations(id) on delete set null,
  loan_name text not null,                         -- e.g. "Term Loan A"
  lender text,                                     -- e.g. "Northwest Bank"
  facility text,                                   -- e.g. "$5M Senior Secured Term Loan"
  principal_cents bigint not null check (principal_cents >= 0),
  -- Annual interest rate as a PERCENT (e.g. 7.5 = 7.5%). numeric so 5 decimals hold.
  interest_rate numeric(9,5) not null check (interest_rate >= 0),
  rate_type text not null default 'FIXED'
    check (rate_type in ('FIXED', 'VARIABLE')),
  amortization_method text not null default 'AMORTIZING'
    check (amortization_method in ('AMORTIZING', 'INTEREST_ONLY')),
  -- Payment frequency == the amortization period. Compounding is informational.
  payment_frequency text not null default 'MONTHLY'
    check (payment_frequency in ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL')),
  compounding text not null default 'MONTHLY'
    check (compounding in ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL')),
  -- Number of amortization periods (term). Nullable when a fixed payment is supplied
  -- instead and the term is derived. At least one of term_periods / payment_cents.
  term_periods int check (term_periods is null or term_periods > 0),
  -- Scheduled level payment (cents). Nullable when derived from term.
  payment_cents bigint check (payment_cents is null or payment_cents >= 0),
  origination_date date,
  maturity_date date,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'PAID_OFF', 'CLOSED', 'INACTIVE')),
  -- Optional link to this facility's covenants (078). Read-only pairing.
  loan_covenant_id uuid references public.loan_covenants(id) on delete set null,
  -- OPTIONAL posting-account overrides. When null, the poster resolves by ROLE and
  -- refuses to guess (degrade-safe). Kept nullable so create never fails on a
  -- mis-seeded chart of accounts.
  liability_account_id uuid references public.accounts(id) on delete set null,        -- notes payable / LT debt
  interest_expense_account_id uuid references public.accounts(id) on delete set null,
  interest_payable_account_id uuid references public.accounts(id) on delete set null,
  cash_account_id uuid references public.accounts(id) on delete set null,
  notes text,
  created_by_user text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_debt_instruments_org
  on public.debt_instruments(org_id, status, created_at desc);
create index if not exists idx_debt_instruments_covenant
  on public.debt_instruments(org_id, loan_covenant_id);

alter table public.debt_instruments enable row level security;
do $$ begin
  create policy "org_isolation" on public.debt_instruments
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.debt_instruments
  to anon, authenticated, service_role;

-- ── Amortization schedule (generated; one row per period) ─────────────────────
create table if not exists public.debt_schedule_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  instrument_id uuid not null references public.debt_instruments(id) on delete cascade,
  period int not null check (period > 0),          -- 1-based period index
  period_date date,                                -- scheduled date (from origination + frequency)
  payment_cents bigint not null,
  interest_cents bigint not null,
  principal_cents bigint not null,
  -- Remaining principal AFTER this period's payment (0 at maturity for AMORTIZING).
  principal_balance_cents bigint not null,
  created_at timestamptz not null default now(),
  unique (instrument_id, period)
);

create index if not exists idx_debt_schedule_lines_instrument
  on public.debt_schedule_lines(org_id, instrument_id, period);

alter table public.debt_schedule_lines enable row level security;
do $$ begin
  create policy "org_isolation" on public.debt_schedule_lines
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.debt_schedule_lines
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. Debt instruments + their amortization schedules. Interest accrual and
-- payment post through the owned ledger by ROLE (source_ref-guarded, no double post).
-- No instruments => empty register; nothing else is affected.
-- =============================================================
