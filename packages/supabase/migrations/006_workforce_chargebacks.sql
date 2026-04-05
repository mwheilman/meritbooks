-- Migration 006: Workforce & Chargebacks
-- Employee tracking, time entries, OH rate calculation, chargeback invoicing.

-- =============================================================
-- EMPLOYEES
-- =============================================================

create table employees (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  clerk_user_id text, -- link to Clerk auth

  -- Identity
  first_name text not null,
  last_name text not null,
  email text,
  phone text,

  -- Employment
  labor_type labor_type_enum not null,
  department_id uuid references departments(id),
  title text,
  hire_date date,
  termination_date date,
  is_active boolean not null default true,

  -- Compensation
  hourly_rate_cents int, -- for production workers
  annual_salary_cents bigint, -- for salaried workers
  fica_rate numeric(6,4) not null default 0.0765,
  wc_rate numeric(6,4) not null default 0.0350,
  benefits_monthly_cents int not null default 68000, -- $680/mo

  -- Direct Assigned allocation
  direct_assigned_allocation_pct numeric(5,2), -- e.g., 100.00 for fully allocated
  direct_assigned_target_location_id uuid references locations(id),

  -- Owner Group
  owner_pool_retention_pct numeric(5,2) default 10.00, -- 10% stays in pool

  -- Production targets
  weekly_target_hours numeric(5,2) default 37.50,
  utilization_flag_threshold numeric(5,2) default 70.00, -- flag if below
  consecutive_low_periods int not null default 0,

  -- Assigned companies (which locations this employee can clock to)
  assigned_location_ids uuid[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- TIME ENTRIES
-- =============================================================

create table time_entries (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  location_id uuid not null references locations(id),

  -- Time
  clock_in timestamptz not null,
  clock_out timestamptz,
  break_minutes int not null default 0,
  total_hours numeric(6,2),

  -- Classification
  department_id uuid references departments(id),
  class_id uuid references classes(id), -- phase
  job_id uuid, -- FK added after jobs table

  -- GPS
  clock_in_lat numeric(10,7),
  clock_in_lng numeric(10,7),
  clock_out_lat numeric(10,7),
  clock_out_lng numeric(10,7),

  -- Content
  notes text,
  is_billable boolean not null default true,

  -- Supervisor approval (for Merit/All company selection)
  requires_supervisor_approval boolean not null default false,
  supervisor_approved boolean,
  supervisor_id uuid references employees(id),
  supervisor_approved_at timestamptz,

  -- Correction
  is_corrected boolean not null default false,
  corrected_by uuid,
  correction_reason text,
  original_location_id uuid references locations(id),
  original_job_id uuid,

  -- GL classification (set by chargeback engine)
  gl_classification text check (gl_classification in ('COGS', 'OPEX', 'CAPITALIZE')),
  chargeback_invoice_id uuid, -- FK added after chargeback table

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- OVERHEAD RATE PERIODS (monthly recalculation)
-- =============================================================

create table overhead_rate_periods (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),

  -- Pool calculation
  total_opex_cents bigint not null, -- total 6000-series
  owner_excluded_cents bigint not null, -- 10% × owner burdened
  deal_team_excluded_cents bigint not null, -- 100% × deal team burdened
  direct_assigned_excluded_cents bigint not null, -- 100% × DA burdened
  shared_pool_cents bigint not null, -- = total - owner - deal - DA

  -- Capacity
  production_employee_count int not null,
  hours_per_employee int not null default 150,
  total_capacity_hours int not null,

  -- Rate
  oh_rate_cents int not null, -- cents per hour
  effective_date date not null,
  calculated_at timestamptz not null default now(),
  calculated_by uuid,

  unique(org_id, period_year, period_month)
);

-- =============================================================
-- SHARED COST ALLOCATION RULES
-- =============================================================

create table shared_cost_rules (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null, -- e.g., "HQ Rent", "Shop Lease"
  description text,
  gl_account_id uuid references accounts(id),
  monthly_amount_cents bigint not null,
  allocation_method allocation_method_enum not null,
  applicable_location_ids uuid[] not null default '{}', -- empty = all locations
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Custom allocation percentages (for CUSTOM_PCT method)
create table shared_cost_allocations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  rule_id uuid not null references shared_cost_rules(id) on delete cascade,
  location_id uuid not null references locations(id),
  allocation_pct numeric(7,4) not null,
  unique(rule_id, location_id)
);

-- =============================================================
-- CHARGEBACK INVOICES
-- =============================================================

create table chargeback_periods (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  oh_rate_period_id uuid references overhead_rate_periods(id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'GENERATED', 'APPROVED', 'POSTED')),
  generated_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  unique(org_id, period_year, period_month)
);

create table chargeback_invoices (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  chargeback_period_id uuid not null references chargeback_periods(id) on delete cascade,
  location_id uuid not null references locations(id), -- receiving company

  -- Invoice identity
  invoice_number text not null, -- CB-2026-0215-SC
  invoice_date date not null,

  -- Totals (6 sections)
  cogs_labor_cents bigint not null default 0,
  opex_labor_cents bigint not null default 0,
  cogs_expenses_cents bigint not null default 0,
  opex_expenses_cents bigint not null default 0,
  shared_costs_cents bigint not null default 0,
  direct_assigned_cents bigint not null default 0,
  total_cents bigint not null default 0,

  -- GL posting
  merit_ar_gl_entry_id uuid references gl_entries(id), -- revenue + AR on Merit
  receiver_ap_gl_entry_id uuid references gl_entries(id), -- expense + bill on receiver

  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'POSTED', 'VOIDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, invoice_number)
);

-- Chargeback line items (detail behind each section)
create table chargeback_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null references chargeback_invoices(id) on delete cascade,
  section text not null check (section in ('COGS_LABOR', 'OPEX_LABOR', 'COGS_EXPENSES', 'OPEX_EXPENSES', 'SHARED_COSTS', 'DIRECT_ASSIGNED')),
  description text not null,
  employee_id uuid references employees(id),
  time_entry_id uuid references time_entries(id),
  receipt_id uuid references receipts(id),
  shared_cost_rule_id uuid references shared_cost_rules(id),
  hours numeric(6,2),
  hourly_rate_cents int,
  oh_rate_cents int,
  amount_cents bigint not null,
  gl_classification text check (gl_classification in ('COGS', 'OPEX')),
  source_notes text, -- verbatim from time entry or receipt
  created_at timestamptz not null default now()
);

-- Add FK from time_entries
alter table time_entries
  add constraint fk_chargeback_invoice foreign key (chargeback_invoice_id)
  references chargeback_invoices(id);

-- =============================================================
-- INDEXES
-- =============================================================

create index idx_employees_org on employees(org_id);
create index idx_employees_labor on employees(org_id, labor_type);
create index idx_employees_dept on employees(department_id);

create index idx_time_entries_org on time_entries(org_id);
create index idx_time_entries_employee on time_entries(employee_id);
create index idx_time_entries_location on time_entries(org_id, location_id);
create index idx_time_entries_date on time_entries(org_id, clock_in);

create index idx_oh_periods_org on overhead_rate_periods(org_id);
create index idx_shared_rules_org on shared_cost_rules(org_id);

create index idx_cb_periods_org on chargeback_periods(org_id);
create index idx_cb_invoices_period on chargeback_invoices(chargeback_period_id);
create index idx_cb_invoices_location on chargeback_invoices(location_id);
create index idx_cb_lines_invoice on chargeback_lines(invoice_id);

-- =============================================================
-- RLS
-- =============================================================

alter table employees enable row level security;
alter table time_entries enable row level security;
alter table overhead_rate_periods enable row level security;
alter table shared_cost_rules enable row level security;
alter table shared_cost_allocations enable row level security;
alter table chargeback_periods enable row level security;
alter table chargeback_invoices enable row level security;
alter table chargeback_lines enable row level security;

create policy "org_isolation" on employees for all using (org_id = public.get_org_id());
create policy "org_isolation" on time_entries for all using (org_id = public.get_org_id());
create policy "org_isolation" on overhead_rate_periods for all using (org_id = public.get_org_id());
create policy "org_isolation" on shared_cost_rules for all using (org_id = public.get_org_id());
create policy "org_isolation" on shared_cost_allocations for all using (org_id = public.get_org_id());
create policy "org_isolation" on chargeback_periods for all using (org_id = public.get_org_id());
create policy "org_isolation" on chargeback_invoices for all using (org_id = public.get_org_id());
create policy "org_isolation" on chargeback_lines for all using (org_id = public.get_org_id());

-- =============================================================
-- TRIGGERS
-- =============================================================

create trigger trg_employees_updated_at
  before update on employees for each row execute function set_updated_at();
create trigger trg_time_entries_updated_at
  before update on time_entries for each row execute function set_updated_at();
create trigger trg_cb_invoices_updated_at
  before update on chargeback_invoices for each row execute function set_updated_at();
