-- Migration 008: Sub-Ledgers
-- Jobs/projects, AR, fixed assets, intercompany, debt & equity.

-- =============================================================
-- JOBS / PROJECTS (for job costing)
-- =============================================================

create table jobs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),

  -- Identity
  job_number text not null,
  name text not null,
  description text,
  customer_name text,
  customer_id uuid, -- FK to AR customers below

  -- Classification
  job_type text check (job_type in ('CONSTRUCTION', 'HVAC', 'CABINETRY', 'SERVICE', 'MAINTENANCE', 'OTHER')),
  status text not null default 'ACTIVE' check (status in ('BID', 'ACTIVE', 'COMPLETE', 'CLOSED', 'ON_HOLD', 'CANCELLED')),

  -- Budget
  contract_amount_cents bigint,
  estimated_cost_cents bigint,
  budget_labor_cents bigint not null default 0,
  budget_materials_cents bigint not null default 0,
  budget_subcontractor_cents bigint not null default 0,
  budget_other_cents bigint not null default 0,

  -- Actuals (maintained by triggers/functions)
  actual_cost_cents bigint not null default 0,
  actual_labor_cents bigint not null default 0,
  actual_materials_cents bigint not null default 0,
  actual_subcontractor_cents bigint not null default 0,
  actual_other_cents bigint not null default 0,
  billed_to_date_cents bigint not null default 0,
  retainage_held_cents bigint not null default 0,

  -- Rev rec
  rev_rec_method rev_rec_method_enum,
  pct_complete numeric(5,2),
  revenue_recognized_cents bigint not null default 0,

  -- Dates
  start_date date,
  estimated_completion_date date,
  actual_completion_date date,

  -- PM tool integration
  external_project_id text,
  external_source text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, location_id, job_number)
);

-- Job phases (sub-divisions of a job)
create table job_phases (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  phase_code text not null,
  name text not null,
  budget_cents bigint not null default 0,
  actual_cents bigint not null default 0,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  unique(job_id, phase_code)
);

-- Job cost codes
create table job_cost_codes (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  name text not null, -- 'Labor', 'Materials', 'Subcontractor', 'Equipment', 'Other'
  cost_type text not null check (cost_type in ('LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER')),
  created_at timestamptz not null default now(),
  unique(org_id, code)
);

-- Job cost entries (every cost posted to a job)
create table job_cost_entries (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  job_phase_id uuid references job_phases(id),
  cost_code_id uuid references job_cost_codes(id),
  gl_entry_line_id uuid references gl_entry_lines(id),
  time_entry_id uuid references time_entries(id),
  bill_line_id uuid references bill_lines(id),
  amount_cents bigint not null,
  description text,
  entry_date date not null,
  created_at timestamptz not null default now()
);

-- Change orders
create table change_orders (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  change_order_number text not null,
  description text not null,
  amount_cents bigint not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'VOIDED')),
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique(job_id, change_order_number)
);

-- Add FK from bill_lines and time_entries
alter table bill_lines add constraint fk_bill_line_job foreign key (job_id) references jobs(id);
alter table time_entries add constraint fk_time_entry_job foreign key (job_id) references jobs(id);

-- =============================================================
-- CUSTOMERS (AR)
-- =============================================================

create table customers (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  payment_terms_days int not null default 30,
  credit_limit_cents bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add FK from jobs
alter table jobs add constraint fk_job_customer foreign key (customer_id) references customers(id);

-- =============================================================
-- INVOICES (AR)
-- =============================================================

create table invoices (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),
  customer_id uuid not null references customers(id),
  job_id uuid references jobs(id),

  -- Identity
  invoice_number text not null,
  invoice_date date not null,
  due_date date not null,

  -- Amounts
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  retainage_cents bigint not null default 0,
  total_cents bigint not null default 0,
  amount_paid_cents bigint not null default 0,
  balance_cents bigint generated always as (total_cents - amount_paid_cents) stored,

  -- Status
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOIDED', 'WRITTEN_OFF')),

  -- GL posting
  gl_entry_id uuid references gl_entries(id),

  -- Progress billing
  is_progress_bill boolean not null default false,
  application_number int, -- AIA G702/G703

  memo text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, invoice_number)
);

create table invoice_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  line_number int not null,
  description text not null,
  account_id uuid not null references accounts(id),
  quantity numeric(15,4) not null default 1,
  unit_price_cents bigint not null,
  amount_cents bigint not null,
  job_phase_id uuid references job_phases(id),
  cost_code_id uuid references job_cost_codes(id),
  created_at timestamptz not null default now()
);

-- Customer payments
create table customer_payments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  payment_date date not null,
  amount_cents bigint not null,
  payment_method text check (payment_method in ('CHECK', 'ACH', 'WIRE', 'CREDIT_CARD', 'CASH', 'OTHER')),
  reference_number text,
  bank_account_id uuid references bank_accounts(id),
  gl_entry_id uuid references gl_entries(id),
  created_at timestamptz not null default now()
);

-- Payment applications (which invoices a payment covers)
create table payment_applications (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  payment_id uuid not null references customer_payments(id) on delete cascade,
  invoice_id uuid not null references invoices(id),
  amount_cents bigint not null,
  created_at timestamptz not null default now()
);

-- =============================================================
-- FIXED ASSETS
-- =============================================================

create table fixed_assets (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),

  -- Identity
  asset_tag text,
  name text not null,
  description text,
  serial_number text,
  category text, -- 'VEHICLE', 'EQUIPMENT', 'FURNITURE', 'COMPUTER', 'BUILDING', 'LEASEHOLD'

  -- Financial
  acquisition_date date not null,
  acquisition_cost_cents bigint not null,
  salvage_value_cents bigint not null default 0,
  useful_life_months int not null,
  depreciation_method depreciation_method_enum not null default 'STRAIGHT_LINE',

  -- GL accounts
  asset_account_id uuid not null references accounts(id),
  depreciation_expense_account_id uuid not null references accounts(id),
  accumulated_depreciation_account_id uuid not null references accounts(id),

  -- Tracking
  accumulated_depreciation_cents bigint not null default 0,
  net_book_value_cents bigint generated always as (acquisition_cost_cents - accumulated_depreciation_cents) stored,
  last_depreciation_date date,

  -- Status
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED', 'IMPAIRED')),
  disposal_date date,
  disposal_proceeds_cents bigint,
  disposal_gl_entry_id uuid references gl_entries(id),

  -- Physical (Asset Panda replacement)
  physical_location text,
  assigned_to uuid references employees(id),
  condition text check (condition in ('NEW', 'GOOD', 'FAIR', 'POOR')),
  last_inspection_date date,
  barcode text,
  photo_urls text[],

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- INTERCOMPANY
-- =============================================================

create table intercompany_balances (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  from_location_id uuid not null references locations(id),
  to_location_id uuid not null references locations(id),
  balance_cents bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique(org_id, from_location_id, to_location_id)
);

create table intercompany_loans (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  lender_location_id uuid not null references locations(id),
  borrower_location_id uuid not null references locations(id),
  amount_cents bigint not null,
  interest_rate numeric(6,4),
  term_months int,
  status text not null default 'PENDING' check (status in ('PENDING', 'MANAGER_APPROVED', 'CFO_APPROVED', 'ACTIVE', 'PAID_OFF', 'DEFAULTED', 'REJECTED')),
  approved_by_manager uuid,
  approved_by_cfo uuid,
  approved_by_owner uuid,
  gl_entry_id uuid references gl_entries(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- DEBT & EQUITY SCHEDULES
-- =============================================================

create table debt_instruments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),
  name text not null,
  lender text not null,
  instrument_type text not null check (instrument_type in ('TERM_LOAN', 'SBA_LOAN', 'LINE_OF_CREDIT', 'EQUIPMENT_LOAN', 'MORTGAGE', 'OTHER')),
  original_amount_cents bigint not null,
  current_balance_cents bigint not null,
  interest_rate numeric(6,4) not null,
  maturity_date date,
  monthly_payment_cents bigint,
  payment_type text check (payment_type in ('P_AND_I', 'INTEREST_ONLY', 'CUSTOM')),
  gl_liability_account_id uuid references accounts(id),
  gl_interest_account_id uuid references accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table equity_holders (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),
  holder_name text not null,
  share_class text check (share_class in ('CLASS_A', 'CLASS_B', 'COMMON', 'PREFERRED')),
  ownership_pct numeric(7,4) not null,
  invested_cents bigint not null default 0,
  distributions_ytd_cents bigint not null default 0,
  gl_equity_account_id uuid references accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- INDEXES
-- =============================================================

create index idx_jobs_org on jobs(org_id);
create index idx_jobs_location on jobs(org_id, location_id);
create index idx_jobs_status on jobs(org_id, status);
create index idx_job_phases_job on job_phases(job_id);
create index idx_job_cost_entries_job on job_cost_entries(job_id);

create index idx_customers_org on customers(org_id);
create index idx_invoices_org on invoices(org_id);
create index idx_invoices_customer on invoices(customer_id);
create index idx_invoices_status on invoices(org_id, status);
create index idx_invoices_due on invoices(org_id, due_date) where status not in ('PAID', 'VOIDED');
create index idx_invoice_lines on invoice_lines(invoice_id);
create index idx_payments_customer on customer_payments(customer_id);
create index idx_payment_apps on payment_applications(payment_id);

create index idx_fixed_assets_org on fixed_assets(org_id);
create index idx_fixed_assets_location on fixed_assets(org_id, location_id);

create index idx_ic_balances_org on intercompany_balances(org_id);
create index idx_debt_org on debt_instruments(org_id);
create index idx_equity_org on equity_holders(org_id);

-- =============================================================
-- RLS
-- =============================================================

alter table jobs enable row level security;
alter table job_phases enable row level security;
alter table job_cost_codes enable row level security;
alter table job_cost_entries enable row level security;
alter table change_orders enable row level security;
alter table customers enable row level security;
alter table invoices enable row level security;
alter table invoice_lines enable row level security;
alter table customer_payments enable row level security;
alter table payment_applications enable row level security;
alter table fixed_assets enable row level security;
alter table intercompany_balances enable row level security;
alter table intercompany_loans enable row level security;
alter table debt_instruments enable row level security;
alter table equity_holders enable row level security;

create policy "org_isolation" on jobs for all using (org_id = public.get_org_id());
create policy "org_isolation" on job_phases for all using (org_id = public.get_org_id());
create policy "org_isolation" on job_cost_codes for all using (org_id = public.get_org_id());
create policy "org_isolation" on job_cost_entries for all using (org_id = public.get_org_id());
create policy "org_isolation" on change_orders for all using (org_id = public.get_org_id());
create policy "org_isolation" on customers for all using (org_id = public.get_org_id());
create policy "org_isolation" on invoices for all using (org_id = public.get_org_id());
create policy "org_isolation" on invoice_lines for all using (org_id = public.get_org_id());
create policy "org_isolation" on customer_payments for all using (org_id = public.get_org_id());
create policy "org_isolation" on payment_applications for all using (org_id = public.get_org_id());
create policy "org_isolation" on fixed_assets for all using (org_id = public.get_org_id());
create policy "org_isolation" on intercompany_balances for all using (org_id = public.get_org_id());
create policy "org_isolation" on intercompany_loans for all using (org_id = public.get_org_id());
create policy "org_isolation" on debt_instruments for all using (org_id = public.get_org_id());
create policy "org_isolation" on equity_holders for all using (org_id = public.get_org_id());

-- =============================================================
-- TRIGGERS
-- =============================================================

create trigger trg_jobs_updated_at before update on jobs for each row execute function set_updated_at();
create trigger trg_customers_updated_at before update on customers for each row execute function set_updated_at();
create trigger trg_invoices_updated_at before update on invoices for each row execute function set_updated_at();
create trigger trg_fixed_assets_updated_at before update on fixed_assets for each row execute function set_updated_at();
create trigger trg_ic_loans_updated_at before update on intercompany_loans for each row execute function set_updated_at();
create trigger trg_debt_updated_at before update on debt_instruments for each row execute function set_updated_at();
create trigger trg_equity_updated_at before update on equity_holders for each row execute function set_updated_at();
