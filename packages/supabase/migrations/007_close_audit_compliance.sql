-- Migration 007: Close Management, Audit, & Compliance
-- Month-end close workflow, audit trail, regulatory compliance, working papers.

-- =============================================================
-- CLOSE CHECKLISTS
-- =============================================================

create table close_checklists (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  fiscal_period_id uuid not null references fiscal_periods(id) on delete cascade,
  location_id uuid not null references locations(id),

  -- Phase tracking
  phase close_phase_enum not null,
  task_name text not null,
  task_order int not null,
  due_day int not null, -- day of month (3, 7, or 10)

  -- Status
  is_complete boolean not null default false,
  is_auto_verified boolean not null default false, -- ⚡ system confirmed
  completed_by uuid,
  completed_at timestamptz,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- WORKING PAPERS
-- =============================================================

create table working_papers (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  fiscal_period_id uuid not null references fiscal_periods(id),
  location_id uuid not null references locations(id),
  account_id uuid not null references accounts(id),

  -- Balance
  gl_balance_cents bigint not null default 0,
  supporting_balance_cents bigint,
  variance_cents bigint generated always as (gl_balance_cents - coalesce(supporting_balance_cents, gl_balance_cents)) stored,

  -- Documentation
  category text not null, -- 'CASH', 'AR', 'PREPAID', 'PPE', 'AP', 'PAYROLL', 'DEBT', 'ACCRUED', 'EQUITY'
  explanation text,
  supporting_doc_urls text[],

  -- Sign-off
  prepared_by uuid,
  prepared_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,

  -- Tickmarks
  tickmarks jsonb not null default '[]', -- [{symbol, meaning, applied_by, applied_at}]

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- BANK RECONCILIATIONS
-- =============================================================

create table bank_reconciliations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id),
  fiscal_period_id uuid not null references fiscal_periods(id),

  -- Balances
  statement_ending_balance_cents bigint not null,
  gl_balance_cents bigint not null,
  outstanding_deposits_cents bigint not null default 0,
  outstanding_checks_cents bigint not null default 0,
  adjusted_bank_balance_cents bigint generated always as (
    statement_ending_balance_cents + outstanding_deposits_cents - outstanding_checks_cents
  ) stored,
  difference_cents bigint generated always as (
    gl_balance_cents - (statement_ending_balance_cents + outstanding_deposits_cents - outstanding_checks_cents)
  ) stored,

  -- Status
  is_reconciled boolean not null default false,
  reconciled_by uuid,
  reconciled_at timestamptz,

  statement_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- AUDIT LOG (append-only, field-level)
-- =============================================================

create table audit_log (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  table_name text not null,
  record_id uuid not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  field_name text, -- specific column changed (UPDATE only)
  old_value text,
  new_value text,
  user_id text, -- Clerk user ID
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Partition audit log by month for performance
-- (In production, consider pg_partman for automatic partition management)
create index idx_audit_org on audit_log(org_id);
create index idx_audit_table on audit_log(table_name, record_id);
create index idx_audit_user on audit_log(user_id);
create index idx_audit_created on audit_log(created_at);

-- =============================================================
-- AI AUDIT LOG (every AI decision)
-- =============================================================

create table ai_audit_log (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  feature text not null, -- 'CATEGORIZATION', 'OCR', 'FORECASTING', 'CPA_DESK', etc.
  source_table text,
  source_id uuid,
  model_version text not null,
  prompt_hash text, -- hash of prompt for dedup
  input_summary text, -- truncated input for debugging
  output_summary text,
  confidence numeric(5,4),
  tokens_input int,
  tokens_output int,
  cost_cents int, -- estimated API cost
  cache_hit boolean not null default false,
  human_response text check (human_response in ('APPROVED', 'EDITED', 'REJECTED')),
  human_response_by uuid,
  human_response_at timestamptz,
  latency_ms int,
  created_at timestamptz not null default now()
);

create index idx_ai_audit_org on ai_audit_log(org_id);
create index idx_ai_audit_feature on ai_audit_log(org_id, feature);
create index idx_ai_audit_created on ai_audit_log(created_at);

-- =============================================================
-- REGULATORY COMPLIANCE
-- =============================================================

create table compliance_obligations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null, -- 'Sales Tax', 'Federal 940', 'State Withholding', etc.
  frequency text not null check (frequency in ('MONTHLY', 'QUARTERLY', 'ANNUALLY')),
  jurisdiction text,
  created_at timestamptz not null default now()
);

create table compliance_filings (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  obligation_id uuid not null references compliance_obligations(id) on delete cascade,
  location_id uuid not null references locations(id),
  period_year int not null,
  period_month int,
  period_quarter int,
  due_date date not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'IN_PROGRESS', 'FILED', 'AUTO_VERIFIED', 'OVERDUE')),
  filed_amount_cents bigint,
  expected_amount_cents bigint,
  filed_by uuid,
  filed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- RECURRING TRANSACTIONS
-- =============================================================

create table recurring_templates (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  frequency text not null check (frequency in ('MONTHLY', 'QUARTERLY', 'ANNUALLY')),
  start_date date not null,
  end_date date,
  next_run_date date,
  is_reversing boolean not null default false,
  is_active boolean not null default true,
  location_id uuid not null references locations(id),
  template_lines jsonb not null default '[]', -- [{account_id, debit_cents, credit_cents, department_id, ...}]
  last_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- RLS
-- =============================================================

alter table close_checklists enable row level security;
alter table working_papers enable row level security;
alter table bank_reconciliations enable row level security;
alter table audit_log enable row level security;
alter table ai_audit_log enable row level security;
alter table compliance_obligations enable row level security;
alter table compliance_filings enable row level security;
alter table recurring_templates enable row level security;

create policy "org_isolation" on close_checklists for all using (org_id = public.get_org_id());
create policy "org_isolation" on working_papers for all using (org_id = public.get_org_id());
create policy "org_isolation" on bank_reconciliations for all using (org_id = public.get_org_id());
create policy "org_isolation" on audit_log for all using (org_id = public.get_org_id());
create policy "org_isolation" on ai_audit_log for all using (org_id = public.get_org_id());
create policy "org_isolation" on compliance_obligations for all using (org_id = public.get_org_id());
create policy "org_isolation" on compliance_filings for all using (org_id = public.get_org_id());
create policy "org_isolation" on recurring_templates for all using (org_id = public.get_org_id());

-- =============================================================
-- TRIGGERS
-- =============================================================

create trigger trg_close_checklists_updated_at
  before update on close_checklists for each row execute function set_updated_at();
create trigger trg_working_papers_updated_at
  before update on working_papers for each row execute function set_updated_at();
create trigger trg_bank_recons_updated_at
  before update on bank_reconciliations for each row execute function set_updated_at();
create trigger trg_recurring_updated_at
  before update on recurring_templates for each row execute function set_updated_at();
