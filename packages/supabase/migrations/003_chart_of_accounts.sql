-- Migration 003: Chart of Accounts
-- Single unified COA shared across all portfolio companies.
-- Company-specific accounts (cash, CC, debt) isolated via company_location_id.

create table accounts (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  account_group_id uuid not null references account_groups(id) on delete cascade,

  -- Identity
  account_number text not null,
  name text not null,
  description text,

  -- Classification
  account_type account_type_enum not null,
  account_sub_type account_sub_type_enum not null,

  -- Behavioral flags
  is_active boolean not null default true,
  is_control_account boolean not null default false,
  is_company_specific boolean not null default false,
  company_location_id uuid references locations(id),
  is_bank_account boolean not null default false,
  is_credit_card boolean not null default false,

  -- Dimension requirements (account-level override)
  require_department boolean not null default false,
  require_class boolean not null default false,
  require_item boolean not null default false,
  require_location boolean not null default true,

  -- Closing
  closing_type text not null default 'NONE' check (closing_type in ('NONE', 'CLOSE_TO_ACCOUNT', 'RETAINED_EARNINGS')),
  close_into_account_id uuid references accounts(id),

  -- Approval workflow
  approval_status approval_status_enum not null default 'APPROVED', -- seed accounts start approved
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,

  -- Display
  display_order int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Constraints
  unique(org_id, account_number),
  constraint chk_company_specific check (
    (is_company_specific = false and company_location_id is null) or
    (is_company_specific = true and company_location_id is not null)
  )
);

-- =============================================================
-- INDEXES
-- =============================================================

create index idx_accounts_org on accounts(org_id);
create index idx_accounts_group on accounts(account_group_id);
create index idx_accounts_type on accounts(org_id, account_type);
create index idx_accounts_number on accounts(org_id, account_number);
create index idx_accounts_approval on accounts(org_id, approval_status);
create index idx_accounts_company on accounts(company_location_id) where company_location_id is not null;

-- =============================================================
-- RLS
-- =============================================================

alter table accounts enable row level security;

create policy "org_isolation" on accounts
  for all using (org_id = public.get_org_id());

-- =============================================================
-- TRIGGERS
-- =============================================================

create trigger trg_accounts_updated_at
  before update on accounts for each row execute function set_updated_at();

-- New accounts from non-admin users default to PENDING
create or replace function enforce_coa_approval()
returns trigger as $$
begin
  if new.approval_status is null then
    new.approval_status := 'PENDING';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_coa_approval
  before insert on accounts
  for each row execute function enforce_coa_approval();
