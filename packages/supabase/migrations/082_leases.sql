-- Migration 082: Lease Management (ASC 842) — ROU asset + lease liability + schedule
-- =============================================================
-- Drop-and-parse leases: a lessee's lease agreement is dropped, the AI proposes the
-- terms (lessor, dates, payment, frequency, rate, suggested classification), and after
-- a human confirms, MeritBooks sets up the right-of-use (ROU) asset + lease liability at
-- present value and the full ASC 842 amortization schedule. A monthly "record lease
-- period" then posts the balanced entry through the deterministic posting engine
-- (postJournalEntry) by account ROLE — never a hard-coded number.
--
--   OPERATING lease (single straight-line lease expense):
--     DR Lease Expense            (straight-line average of payments)
--     DR Lease Liability          (payment − interest = principal reduction)
--     CR Right-of-Use Asset       (ROU amortization plug = lease expense − interest)
--     CR Cash / Operating Bank    (the cash payment)
--
--   FINANCE lease (interest + amortization, front-loaded):
--     DR Interest Expense         (rate × opening liability)
--     DR Lease Liability          (payment − interest = principal reduction)
--     DR Amortization Expense     (straight-line ROU amortization)
--     CR Cash / Operating Bank    (the cash payment)
--     CR Right-of-Use Asset       (ROU amortization)
--
-- Degrade-safe: no leases defined => nothing posts, nothing else breaks. Both tables
-- are additive and isolated; no existing table is altered. Schedule lines carry the
-- posted gl_entry_id so a re-run of "record period" is idempotent (double-post guard).
--
-- Additive + idempotent. Requires 019 (core carve) + 003 (chart of accounts).
-- RLS org_isolation via get_org_id(). Books band. Next migration number: 083.
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 before 082.';
  end if;
end $$;

-- ── Leases ────────────────────────────────────────────────────────────────────
create table if not exists public.leases (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Which company/location the ROU asset + liability live on (required for GL posting).
  location_id uuid not null references core.locations(id) on delete restrict,
  lessor text not null,                              -- e.g. "Prologis" / landlord
  description text,                                  -- e.g. "Warehouse — 1200 Industrial Pkwy"
  classification text not null default 'OPERATING'
    check (classification in ('OPERATING', 'FINANCE')),
  commencement_date date not null,
  end_date date not null,
  -- Payment terms. Amounts in bigint CENTS.
  payment_cents bigint not null check (payment_cents > 0),
  payment_frequency text not null default 'MONTHLY'
    check (payment_frequency in ('MONTHLY', 'QUARTERLY', 'ANNUAL')),
  payment_timing text not null default 'ARREARS'
    check (payment_timing in ('ARREARS', 'ADVANCE')),
  -- Term in whole months (must be a multiple of the payment period length).
  term_months integer not null check (term_months > 0),
  -- Incremental borrowing / discount rate as a decimal (e.g. 0.0600 = 6%).
  discount_rate numeric(9,6) not null default 0 check (discount_rate >= 0),
  -- Computed at inception (present value of payments). CENTS.
  rou_asset_cents bigint not null default 0,
  liability_cents bigint not null default 0,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'ENDED', 'TERMINATED')),
  periods_posted integer not null default 0,
  -- Provenance: the drop-and-parse decision this lease was confirmed from (nullable).
  ai_decision_id uuid,
  notes text,
  created_by_user text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_leases_org
  on public.leases(org_id, status, created_at desc);
create index if not exists idx_leases_location
  on public.leases(org_id, location_id);

alter table public.leases enable row level security;
do $$ begin
  create policy "org_isolation" on public.leases
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.leases
  to anon, authenticated, service_role;

-- ── Amortization schedule lines (one row per payment period) ───────────────────
create table if not exists public.lease_schedule_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  lease_id uuid not null references public.leases(id) on delete cascade,
  period integer not null,                           -- 1-based payment period
  period_date date not null,                         -- date the period's entry posts (period-end)
  payment_cents bigint not null,
  interest_cents bigint not null,                    -- interest accreted on the liability
  principal_reduction_cents bigint not null,         -- payment − interest
  liability_balance_cents bigint not null,           -- closing liability balance
  rou_amortization_cents bigint not null,            -- ROU asset reduction this period
  rou_balance_cents bigint not null,                 -- closing ROU balance
  lease_expense_cents bigint not null,               -- OPERATING single-line expense; FINANCE = interest+amort
  -- Posting bookkeeping (double-post guard: only post lines where gl_entry_id is null).
  gl_entry_id uuid references public.gl_entries(id) on delete set null,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lease_id, period)
);

create index if not exists idx_lease_schedule_lines_lease
  on public.lease_schedule_lines(org_id, lease_id, period);
create index if not exists idx_lease_schedule_lines_unposted
  on public.lease_schedule_lines(org_id, lease_id, period)
  where gl_entry_id is null;

alter table public.lease_schedule_lines enable row level security;
do $$ begin
  create policy "org_isolation" on public.lease_schedule_lines
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.lease_schedule_lines
  to anon, authenticated, service_role;

-- =============================================================
-- Account-role vocabulary for leases (so the posting engine resolves by ROLE).
-- Additive registration in core.account_role_keys; the mapping table
-- public.account_roles can then point each role at the tenant's real account.
--   ROU_ASSET / LEASE_LIABILITY are NEW families — seeded below into each org's COA.
--   LEASE_EXPENSE (Rent 6100), LEASE_INTEREST_EXPENSE (Interest Expense 8000),
--   ROU_AMORTIZATION_EXPENSE (Amortization Expense 6810) reuse standard accounts.
-- =============================================================
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('ROU_ASSET',                'Right-of-use asset (ASC 842)',        'ORG', '1580'),
  ('LEASE_LIABILITY',          'Lease liability (ASC 842)',           'ORG', '2550'),
  ('LEASE_EXPENSE',            'Operating lease expense',             'ORG', '6100'),
  ('LEASE_INTEREST_EXPENSE',   'Finance lease interest expense',      'ORG', '8000'),
  ('ROU_AMORTIZATION_EXPENSE', 'Finance lease ROU amortization',      'ORG', '6810')
on conflict (role_key) do update
  set label = excluded.label,
      scope = excluded.scope,
      default_account_number = excluded.default_account_number;

-- Right-of-Use Asset account (non-current), per org, if missing.
-- Created in the same account group as an existing Property & Equipment account (1500).
insert into accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '1580', 'Right-of-Use Asset (Lease)', 'ASSET', 'FIXED_ASSET', true, 'APPROVED', 8
from accounts a
where a.account_number = '1500'
  and not exists (select 1 from accounts x where x.org_id = a.org_id and x.account_number = '1580');

-- Lease Liability account (long-term), per org, if missing.
-- Created in the same account group as an existing Long-Term Debt account (2540).
insert into accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '2550', 'Lease Liability (ASC 842)', 'LIABILITY', 'LONG_TERM_LIABILITY', true, 'APPROVED', 6
from accounts a
where a.account_number = '2540'
  and not exists (select 1 from accounts x where x.org_id = a.org_id and x.account_number = '2550');

-- =============================================================
-- DONE. Leases + schedule lines defined per tenant; each period posts a balanced
-- ROU/liability entry through the posting engine. No leases => empty, nothing else
-- is affected.
-- =============================================================
