-- Migration 069: payroll Phase A data model (GATE 12.3, provider-agnostic)
-- Tracks a payroll run through draft->preview->approve->release->post. PII (SSN/bank/
-- withholding) is NEVER stored here — it lives at the licensed provider (Check/Gusto) + the
-- Core vault; core.employees stays thin. These tables hold only the amounts the provider
-- returns (for GL posting) + the workflow state + provider references. Applied to Supabase
-- first (2026-08-01), then committed. RLS org_isolation on all three.

create table if not exists public.pay_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid,
  name text not null,
  frequency text not null check (frequency in ('WEEKLY','BIWEEKLY','SEMIMONTHLY','MONTHLY')),
  anchor_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid,
  pay_schedule_id uuid references public.pay_schedules(id) on delete set null,
  provider text,
  provider_run_id text,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'DRAFT'
    check (status in ('DRAFT','PREVIEWED','APPROVED','RELEASED','PROCESSING','PAID','FAILED','CANCELED')),
  gross_cents bigint not null default 0,
  net_cents bigint not null default 0,
  employer_tax_cents bigint not null default 0,
  employee_tax_cents bigint not null default 0,
  benefits_cents bigint not null default 0,
  deductions_cents bigint not null default 0,
  approval_id uuid references public.approvals(id) on delete set null,
  gl_entry_id uuid,
  prepared_by text,
  approved_by text,
  released_by text,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payroll_run_employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid references core.employees(id) on delete set null,
  gross_cents bigint not null default 0,
  net_cents bigint not null default 0,
  employee_tax_cents bigint not null default 0,
  employer_tax_cents bigint not null default 0,
  deductions_cents bigint not null default 0,
  benefits_cents bigint not null default 0,
  hours numeric,
  earnings jsonb not null default '[]'::jsonb,
  provider_ref text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pay_schedules_org on public.pay_schedules(org_id);
create index if not exists idx_payroll_runs_org on public.payroll_runs(org_id);
create index if not exists idx_payroll_runs_status on public.payroll_runs(org_id, status);
create index if not exists idx_payroll_run_employees_run on public.payroll_run_employees(payroll_run_id);
create index if not exists idx_payroll_run_employees_org on public.payroll_run_employees(org_id);

alter table public.pay_schedules enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_run_employees enable row level security;

create policy org_isolation on public.pay_schedules for all
  using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
create policy org_isolation on public.payroll_runs for all
  using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
create policy org_isolation on public.payroll_run_employees for all
  using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
