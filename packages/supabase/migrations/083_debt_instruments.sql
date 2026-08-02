-- Migration 083: Debt Register + Amortization (GATE 8 / FP&A — debt instruments)
-- =============================================================
-- RECONCILED (session 44): `public.debt_instruments` ALREADY EXISTS from migration
-- 008 (sub-ledgers) and is read live by two reports (reports/debt-schedule,
-- board-package/queries). This migration is therefore ADDITIVE against that table —
-- it does NOT recreate it. It (a) adds the columns the amortization/register feature
-- needs that migration 008 didn't have, all nullable/defaulted so every existing row
-- stays valid, (b) relaxes three NOT NULLs that the feature legitimately leaves blank
-- (lender, location_id for a consolidated loan) and defaults the columns the feature
-- doesn't collect (instrument_type, current_balance_cents) so the confirm-path insert
-- succeeds, and (c) creates the brand-new `debt_schedule_lines` table (no conflict).
--
-- Column reconciliation (feature field -> existing migration-008 column):
--   loan_name                 -> name
--   principal_cents           -> original_amount_cents
--   payment_cents             -> monthly_payment_cents
--   liability_account_id      -> gl_liability_account_id
--   interest_expense_account  -> gl_interest_account_id
--   lender / interest_rate / maturity_date / location_id  -> same-named columns
-- Added (all nullable/defaulted): facility, rate_type, amortization_method,
--   payment_frequency, compounding, term_periods, origination_date, status,
--   loan_covenant_id, interest_payable_account_id, cash_account_id, created_by_user,
--   notes.
--
-- Degrade-safe, additive, idempotent. All money is bigint cents. RLS org_isolation
-- already exists on debt_instruments (008); debt_schedule_lines gets its own.
-- Next migration number: 084.
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'debt_instruments') then
    raise exception 'public.debt_instruments not found — expected from migration 008.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'loan_covenants') then
    raise exception 'public.loan_covenants not found — deploy migration 078 before 083.';
  end if;
end $$;

-- ── Additive columns the amortization/register feature needs ───────────────────
alter table public.debt_instruments
  add column if not exists facility text,
  add column if not exists rate_type text not null default 'FIXED',
  add column if not exists amortization_method text not null default 'AMORTIZING',
  add column if not exists payment_frequency text not null default 'MONTHLY',
  add column if not exists compounding text not null default 'MONTHLY',
  add column if not exists term_periods int,
  add column if not exists origination_date date,
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists loan_covenant_id uuid references public.loan_covenants(id) on delete set null,
  add column if not exists interest_payable_account_id uuid references accounts(id) on delete set null,
  add column if not exists cash_account_id uuid references accounts(id) on delete set null,
  add column if not exists created_by_user text,
  add column if not exists notes text;

-- Constrain the added enums (idempotent — skip if the constraint already exists).
do $$ begin
  alter table public.debt_instruments
    add constraint debt_instruments_rate_type_chk check (rate_type in ('FIXED', 'VARIABLE'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.debt_instruments
    add constraint debt_instruments_amort_method_chk
    check (amortization_method in ('AMORTIZING', 'INTEREST_ONLY'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.debt_instruments
    add constraint debt_instruments_pay_freq_chk
    check (payment_frequency in ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.debt_instruments
    add constraint debt_instruments_compounding_chk
    check (compounding in ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.debt_instruments
    add constraint debt_instruments_status_chk
    check (status in ('ACTIVE', 'PAID_OFF', 'CLOSED', 'INACTIVE'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.debt_instruments
    add constraint debt_instruments_term_periods_chk
    check (term_periods is null or term_periods > 0);
exception when duplicate_object then null; end $$;

-- Relax constraints so the confirm-path insert (which omits instrument_type and
-- current_balance_cents, and may leave lender / location_id null for a consolidated
-- loan) succeeds. Safe for existing rows and for the two reports, which only SELECT.
alter table public.debt_instruments alter column lender drop not null;
alter table public.debt_instruments alter column location_id drop not null;
alter table public.debt_instruments alter column instrument_type set default 'OTHER';
alter table public.debt_instruments alter column instrument_type drop not null;
alter table public.debt_instruments alter column current_balance_cents set default 0;

create index if not exists idx_debt_instruments_status
  on public.debt_instruments(org_id, status, created_at desc);
create index if not exists idx_debt_instruments_covenant
  on public.debt_instruments(org_id, loan_covenant_id);

-- ── Amortization schedule (generated; one row per period) — NEW table ─────────
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
-- DONE. debt_instruments reconciled onto the existing migration-008 table (additive);
-- debt_schedule_lines created new. Interest accrual + payment post through the owned
-- ledger by ROLE (source_ref-guarded, no double post). No existing report is affected.
-- =============================================================
