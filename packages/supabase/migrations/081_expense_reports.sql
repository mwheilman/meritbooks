-- Migration 081: Employee Expense Reports + lines (Expense & Card Management)
-- =============================================================
-- Closes a matrix blind spot: today only single-receipt capture exists. This adds
-- the EMPLOYEE EXPENSE REPORT — a batch of expense lines an employee assembles
-- (from captured receipts or manually), submits, gets approved (SoD: submitter ≠
-- approver), and is either REIMBURSED (out-of-pocket → a reimbursement payable JE
-- through the normal posting engine) or reconciled against the corporate-card feed
-- (a card charge already books DR expense / CR Credit Card Payable via the card
-- feed — it is NEVER reimbursed a second time).
--
-- Reimbursement posts through the EXISTING posting path (postJournalEntry): DR the
-- expense accounts / CR Accounts Payable (the reimbursement payable). There is NO
-- parallel money path — settlement of that payable rides normal AP payment.
--
-- Money is bigint cents everywhere. RLS org_isolation via public.get_org_id()
-- (Clerk org_id claim; never auth.uid()). Master data (employee/location/dept/job)
-- is referenced by FK into `core`; the ledger stays in `public`. Category is a
-- public.accounts FK; receipts / card charges are public FKs.
--
-- ADDITIVE + idempotent (create-if-not-exists; safe to re-run). Books band; next
-- after 080. Requires 019 (core carve → core.employees/locations/departments/jobs),
-- 003 (public.accounts), 004 (public.gl_entries), 005 (public.receipts,
-- public.bank_transactions). Apply to Supabase FIRST, then ship the code that
-- depends on it. DEGRADES SAFE — absent these tables the feature is simply
-- unavailable; nothing else breaks.
-- =============================================================

-- ---- Guard: the FK targets we depend on must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'employees') then
    raise exception 'core.employees not found — deploy migration 019 (core carve) before 081.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'accounts') then
    raise exception 'public.accounts not found — deploy migration 003 before 081.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'receipts') then
    raise exception 'public.receipts not found — deploy migration 005 before 081.';
  end if;
end $$;

-- =============================================================
-- 1. EXPENSE REPORT (header)
-- =============================================================
-- Lifecycle: DRAFT → SUBMITTED → APPROVED → REIMBURSED  (or → REJECTED).
-- reimbursable_cents = Σ out-of-pocket lines (what the JE credits to the payable).
-- card_cents         = Σ corporate-card lines (booked via the card feed, not here).
-- total_cents        = reimbursable_cents + card_cents (convenience roll-up).
create table if not exists public.expense_reports (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,

  -- The submitter (HR record). The reimbursement payable is owed to this person.
  employee_id uuid references core.employees(id) on delete restrict,

  -- The legal entity / location the report is booked into (period lookup on post).
  location_id uuid references core.locations(id) on delete set null,

  title text,
  period_start date,
  period_end date,
  memo text,

  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REIMBURSED', 'REJECTED')),

  -- Roll-ups (bigint cents). Recomputed from lines by the app on every mutation.
  total_cents bigint not null default 0,
  reimbursable_cents bigint not null default 0,
  card_cents bigint not null default 0,
  policy_flag_count int not null default 0,

  -- Submit / approve attribution (Clerk actor ids are TEXT — SoD is enforced here).
  submitted_by text,
  submitted_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  reject_reason text,

  -- Reimbursement posting (the out-of-pocket JE). Null until REIMBURSED.
  gl_entry_id uuid references public.gl_entries(id) on delete set null,
  reimbursed_at timestamptz,

  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_expense_reports_org on public.expense_reports(org_id);
create index if not exists idx_expense_reports_employee on public.expense_reports(org_id, employee_id);
create index if not exists idx_expense_reports_status on public.expense_reports(org_id, status);

-- One reimbursement JE per report — the DB is the double-post guarantor.
create unique index if not exists uq_expense_reports_gl_entry
  on public.expense_reports(gl_entry_id) where gl_entry_id is not null;

-- =============================================================
-- 2. EXPENSE REPORT LINE
-- =============================================================
-- payment_source distinguishes the two settlement paths:
--   OUT_OF_POCKET  → the employee paid; reimbursed via the report's JE.
--   CORPORATE_CARD → already on the card feed (DR expense / CR Credit Card
--                    Payable); matched to a bank_transaction, NEVER reimbursed.
create table if not exists public.expense_report_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  report_id uuid not null references public.expense_reports(id) on delete cascade,

  line_number int not null default 1,
  expense_date date not null default current_date,
  merchant text,
  description text,

  -- GL coding (category) + dimensions.
  account_id uuid references public.accounts(id) on delete set null,
  department_id uuid references core.departments(id) on delete set null,
  class_id uuid references public.classes(id) on delete set null,
  location_id uuid references core.locations(id) on delete set null,

  amount_cents bigint not null default 0,

  payment_source text not null default 'OUT_OF_POCKET'
    check (payment_source in ('OUT_OF_POCKET', 'CORPORATE_CARD')),

  -- Source receipt (reuses the receipt parse) and the matched card charge.
  receipt_id uuid references public.receipts(id) on delete set null,
  bank_transaction_id uuid references public.bank_transactions(id) on delete set null,
  has_receipt boolean not null default false,

  -- Deterministic policy evaluation (see lib/expenses/policy.ts).
  policy_flag boolean not null default false,
  policy_reasons jsonb not null default '[]'::jsonb,

  -- Billable pass-through to a job (rebill to the customer downstream).
  billable boolean not null default false,
  job_id uuid references core.jobs(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_expense_report_lines_report on public.expense_report_lines(report_id);
create index if not exists idx_expense_report_lines_org on public.expense_report_lines(org_id);
create index if not exists idx_expense_report_lines_receipt on public.expense_report_lines(receipt_id) where receipt_id is not null;
create index if not exists idx_expense_report_lines_bank_txn on public.expense_report_lines(bank_transaction_id) where bank_transaction_id is not null;

-- =============================================================
-- 3. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================
do $$
declare
  t text;
begin
  foreach t in array array['expense_reports', 'expense_report_lines']
  loop
    execute format('alter table public.%I enable row level security;', t);
    begin
      execute format(
        'create policy "org_isolation" on public.%I for all using (org_id = public.get_org_id());',
        t
      );
    exception when duplicate_object then null;
    end;
    execute format(
      'grant select, insert, update, delete on public.%I to anon, authenticated, service_role;',
      t
    );
  end loop;
end $$;

-- Keep updated_at fresh if the shared trigger fn exists.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    foreach t in array array['expense_reports', 'expense_report_lines']
    loop
      begin
        execute format(
          'create trigger trg_%s_updated before update on public.%I for each row execute function public.set_updated_at();',
          t, t
        );
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;

-- =============================================================
-- DONE. Books now has employee expense reports (public.expense_reports + lines):
-- assemble from captured receipts, submit, approve (SoD), then REIMBURSE
-- out-of-pocket lines through the normal posting engine (DR expense / CR AP) while
-- corporate-card lines reconcile to the card feed (already DR expense / CR Credit
-- Card Payable) and are never double-paid. Org-isolated by RLS, money in cents,
-- master data referenced from core. The policy detector (lib/expenses/policy.ts)
-- flags out-of-policy lines for human review — it never blocks the ledger.
-- =============================================================
