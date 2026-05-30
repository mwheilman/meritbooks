-- Migration 015: Department model + inter-department internal invoices (Session 12)
-- ADDITIVE ONLY. Safe to run against the live app: adds enums, columns, and tables.
-- Aligned to the real schema where `locations` is the company/entity.
-- Destructive retirement of obsolete chargeback/labor objects is handled in a later
-- migration AFTER the referencing code is removed.

-- =============================================================
-- ENUMS
-- =============================================================

do $$ begin
  create type internal_charge_method_enum as enum ('inherit', 'revenue', 'cost_transfer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type internal_invoice_status_enum as enum ('draft', 'sent', 'approved', 'rejected', 'booked', 'void');
exception when duplicate_object then null; end $$;

-- =============================================================
-- COMPANY (locations) — default internal-charge method
-- =============================================================

alter table locations
  add column if not exists default_internal_charge_method internal_charge_method_enum
    not null default 'revenue';

-- company default may only be revenue or cost_transfer (never inherit)
do $$ begin
  alter table locations
    add constraint chk_company_charge_method
    check (default_internal_charge_method in ('revenue', 'cost_transfer'));
exception when duplicate_object then null; end $$;

-- =============================================================
-- DEPARTMENTS — owning company + charge method + Session 12 fields
-- =============================================================
-- Company -> Department spine. location_id is the owning company.
-- Nullable for now (tabula rasa: no departments exist yet); Phase 1 department
-- CRUD + wizard step will populate and enforce it per company.

alter table departments
  add column if not exists location_id uuid references locations(id) on delete cascade;

alter table departments
  add column if not exists internal_charge_method internal_charge_method_enum
    not null default 'inherit';

create index if not exists idx_departments_location on departments(location_id);

-- =============================================================
-- JOBS — attach to a department (required at app level when company has >1 dept)
-- =============================================================

alter table jobs
  add column if not exists department_id uuid references departments(id);

create index if not exists idx_jobs_department on jobs(department_id);

-- =============================================================
-- ACCOUNTS — eliminating flag (Interdepartmental Services Revenue/Cost)
-- =============================================================

alter table accounts
  add column if not exists is_eliminating boolean not null default false;

create index if not exists idx_accounts_eliminating on accounts(org_id) where is_eliminating;

-- =============================================================
-- GL ENTRY LINES — counterparty department for internal/elimination tagging
-- =============================================================

alter table gl_entry_lines
  add column if not exists counterparty_department_id uuid references departments(id);

-- =============================================================
-- INTERNAL INVOICES (inter-department) — replaces the chargeback engine
-- =============================================================

create table if not exists internal_invoices (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,

  invoice_number text not null,
  invoice_date date not null default current_date,
  memo text,

  provider_department_id uuid not null references departments(id),
  receiver_department_id uuid not null references departments(id),
  job_id uuid references jobs(id),

  -- effective charge method captured at send time (provider governs)
  charge_method internal_charge_method_enum not null default 'revenue',

  status internal_invoice_status_enum not null default 'draft',
  total_cents bigint not null default 0 check (total_cents >= 0),

  -- lifecycle metadata
  created_by uuid,
  sent_at timestamptz,
  sent_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  rejected_at timestamptz,
  rejected_by uuid,
  rejection_reason text,
  booked_at timestamptz,
  booked_gl_entry_id uuid references gl_entries(id),
  voided_at timestamptz,
  voided_by uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(org_id, invoice_number),
  constraint chk_provider_ne_receiver check (provider_department_id <> receiver_department_id)
);

create index if not exists idx_internal_invoices_org on internal_invoices(org_id);
create index if not exists idx_internal_invoices_location on internal_invoices(location_id);
create index if not exists idx_internal_invoices_provider on internal_invoices(provider_department_id);
create index if not exists idx_internal_invoices_receiver on internal_invoices(receiver_department_id);
create index if not exists idx_internal_invoices_status on internal_invoices(org_id, status);

create table if not exists internal_invoice_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  internal_invoice_id uuid not null references internal_invoices(id) on delete cascade,
  line_number int not null,
  description text not null,
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  unique(internal_invoice_id, line_number)
);

create index if not exists idx_internal_invoice_lines_invoice on internal_invoice_lines(internal_invoice_id);

-- ============================================================
-- COMPANY POLICIES (per location) — drives predictor / JE engine / close
-- =============================================================

create table if not exists company_policies (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,

  -- predictor thresholds
  capitalization_threshold_cents bigint not null default 250000,   -- $2,500
  amortization_default_months int not null default 12,
  deferred_revenue_handling text not null default 'LIABILITY'
    check (deferred_revenue_handling in ('LIABILITY', 'MANUAL')),

  -- AI auto-post (OFF by default — non-negotiable guardrail)
  auto_post_enabled boolean not null default false,
  auto_post_min_confidence numeric(4,3) not null default 0.900
    check (auto_post_min_confidence between 0 and 1),

  -- revenue recognition
  rev_rec_method rev_rec_method_enum not null default 'POINT_OF_SALE',
  rev_rec_correction_approach text not null default 'TRUE_UP_FORWARD'
    check (rev_rec_correction_approach in ('TRUE_UP_FORWARD', 'RETROACTIVE')),

  -- close calendar
  close_initial_day int not null default 3 check (close_initial_day between 1 and 28),
  close_mid_day int not null default 7 check (close_mid_day between 1 and 28),
  close_final_day int not null default 10 check (close_final_day between 1 and 28),

  -- receipt chase
  receipt_chase_interval_minutes int not null default 60
    check (receipt_chase_interval_minutes between 15 and 240),
  receipt_quiet_hours_start int not null default 21 check (receipt_quiet_hours_start between 0 and 23),
  receipt_quiet_hours_end int not null default 6 check (receipt_quiet_hours_end between 0 and 23),

  -- bank-match routing
  bank_match_auto_threshold numeric(4,3) not null default 0.900
    check (bank_match_auto_threshold between 0 and 1),
  bank_match_review_threshold numeric(4,3) not null default 0.700
    check (bank_match_review_threshold between 0 and 1),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(org_id, location_id)
);

create index if not exists idx_company_policies_location on company_policies(location_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- =============================================================

alter table internal_invoices enable row level security;
alter table internal_invoice_lines enable row level security;
alter table company_policies enable row level security;

do $$ begin
  create policy "org_isolation" on internal_invoices for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "org_isolation" on internal_invoice_lines for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "org_isolation" on company_policies for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

-- =============================================================
-- updated_at triggers (reuse existing helper if present)
-- =============================================================

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_internal_invoices_updated before update on internal_invoices
      for each row execute function set_updated_at();
    create trigger trg_company_policies_updated before update on company_policies
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;
