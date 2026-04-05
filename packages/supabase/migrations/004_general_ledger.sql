-- Migration 004: General Ledger
-- Double-entry book of record. Database-enforced balance.

-- =============================================================
-- FISCAL PERIODS
-- =============================================================

create table fiscal_periods (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  start_date date not null,
  end_date date not null,
  status period_status_enum not null default 'OPEN',
  closed_by uuid,
  closed_at timestamptz,
  close_override_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, location_id, period_year, period_month)
);

-- =============================================================
-- JOURNAL ENTRIES (header)
-- =============================================================

create table gl_entries (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,

  -- Identity
  entry_number text not null,
  entry_date date not null,
  entry_type entry_type_enum not null default 'STANDARD',
  fiscal_period_id uuid not null references fiscal_periods(id),

  -- Content
  memo text,
  source_module text, -- 'BANK_FEED', 'BILL', 'RECEIPT', 'PAYROLL', 'MANUAL', 'REV_REC', 'DEPRECIATION', 'CHARGEBACK', 'INTERCOMPANY'
  source_id uuid, -- FK to the originating record

  -- Status
  status transaction_status_enum not null default 'PENDING',
  posted_at timestamptz,
  posted_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,

  -- Reversing
  is_reversing boolean not null default false,
  reversal_of_id uuid references gl_entries(id),
  reversed_by_id uuid references gl_entries(id),
  reversal_date date,

  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(org_id, entry_number)
);

-- =============================================================
-- JOURNAL ENTRY LINES (detail)
-- =============================================================

create table gl_entry_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  gl_entry_id uuid not null references gl_entries(id) on delete cascade,
  line_number int not null,

  -- Account
  account_id uuid not null references accounts(id),

  -- Amount (store as cents to avoid floating point)
  debit_cents bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),

  -- Dimensions
  location_id uuid not null references locations(id),
  department_id uuid references departments(id),
  class_id uuid references classes(id),
  item_id uuid references items(id),

  -- Detail
  memo text,
  quantity numeric(15,4),
  unit_cost_cents bigint,

  created_at timestamptz not null default now(),

  -- A line must have either a debit or credit, not both, not neither
  constraint chk_debit_or_credit check (
    (debit_cents > 0 and credit_cents = 0) or
    (debit_cents = 0 and credit_cents > 0)
  ),
  unique(gl_entry_id, line_number)
);

-- =============================================================
-- INDEXES
-- =============================================================

create index idx_fiscal_periods_org on fiscal_periods(org_id);
create index idx_fiscal_periods_location on fiscal_periods(org_id, location_id);
create index idx_fiscal_periods_date on fiscal_periods(org_id, start_date, end_date);

create index idx_gl_entries_org on gl_entries(org_id);
create index idx_gl_entries_location on gl_entries(org_id, location_id);
create index idx_gl_entries_date on gl_entries(org_id, entry_date);
create index idx_gl_entries_period on gl_entries(fiscal_period_id);
create index idx_gl_entries_status on gl_entries(org_id, status);
create index idx_gl_entries_source on gl_entries(source_module, source_id);

create index idx_gl_lines_entry on gl_entry_lines(gl_entry_id);
create index idx_gl_lines_account on gl_entry_lines(account_id);
create index idx_gl_lines_location on gl_entry_lines(location_id);
create index idx_gl_lines_org on gl_entry_lines(org_id);

-- =============================================================
-- RLS
-- =============================================================

alter table fiscal_periods enable row level security;
alter table gl_entries enable row level security;
alter table gl_entry_lines enable row level security;

create policy "org_isolation" on fiscal_periods for all using (org_id = public.get_org_id());
create policy "org_isolation" on gl_entries for all using (org_id = public.get_org_id());
create policy "org_isolation" on gl_entry_lines for all using (org_id = public.get_org_id());

-- =============================================================
-- TRIGGERS
-- =============================================================

create trigger trg_fiscal_periods_updated_at
  before update on fiscal_periods for each row execute function set_updated_at();

create trigger trg_gl_entries_updated_at
  before update on gl_entries for each row execute function set_updated_at();

-- Auto-generate entry numbers: JE-2026-000001
create or replace function generate_entry_number()
returns trigger as $$
declare
  year_str text;
  next_num bigint;
begin
  if new.entry_number is null or new.entry_number = '' then
    year_str := extract(year from new.entry_date)::text;
    select coalesce(max(
      nullif(regexp_replace(entry_number, '^JE-' || year_str || '-', ''), entry_number)::bigint
    ), 0) + 1
    into next_num
    from gl_entries
    where org_id = new.org_id
      and entry_number like 'JE-' || year_str || '-%';
    new.entry_number := 'JE-' || year_str || '-' || lpad(next_num::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_generate_entry_number
  before insert on gl_entries
  for each row execute function generate_entry_number();

-- =============================================================
-- DOUBLE-ENTRY ENFORCEMENT
-- This is the most critical trigger in the system.
-- Prevents posting any JE where debits ≠ credits.
-- =============================================================

create or replace function check_journal_balance()
returns trigger as $$
declare
  total_debits bigint;
  total_credits bigint;
  entry_status text;
begin
  -- Only enforce on POSTED entries
  select status into entry_status from gl_entries where id = new.gl_entry_id;
  if entry_status = 'POSTED' then
    select
      coalesce(sum(debit_cents), 0),
      coalesce(sum(credit_cents), 0)
    into total_debits, total_credits
    from gl_entry_lines
    where gl_entry_id = new.gl_entry_id;

    if total_debits != total_credits then
      raise exception 'Journal entry % is unbalanced: debits=% credits=%',
        new.gl_entry_id, total_debits, total_credits;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_check_journal_balance
  after insert or update on gl_entry_lines
  for each row execute function check_journal_balance();

-- =============================================================
-- PERIOD LOCK ENFORCEMENT
-- Prevents posting to closed periods.
-- =============================================================

create or replace function enforce_period_lock()
returns trigger as $$
declare
  p_status text;
begin
  if new.status = 'POSTED' and (old is null or old.status != 'POSTED') then
    select status into p_status from fiscal_periods where id = new.fiscal_period_id;
    if p_status = 'HARD_CLOSE' then
      raise exception 'Cannot post to hard-closed period %', new.fiscal_period_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_enforce_period_lock
  before update on gl_entries
  for each row execute function enforce_period_lock();

-- =============================================================
-- CONTROL ACCOUNT ENFORCEMENT
-- Prevents direct manual posting to control accounts.
-- =============================================================

create or replace function enforce_control_accounts()
returns trigger as $$
declare
  is_control boolean;
  source text;
begin
  select a.is_control_account into is_control
  from accounts a where a.id = new.account_id;

  if is_control then
    select e.source_module into source
    from gl_entries e where e.id = new.gl_entry_id;

    if source is null or source = 'MANUAL' then
      raise exception 'Cannot post directly to control account %. Use the appropriate sub-ledger.', new.account_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_enforce_control_accounts
  before insert on gl_entry_lines
  for each row execute function enforce_control_accounts();

-- =============================================================
-- APPROVED ACCOUNTS ONLY
-- Prevents posting to unapproved COA accounts.
-- =============================================================

create or replace function enforce_approved_accounts()
returns trigger as $$
declare
  acct_status text;
begin
  select approval_status into acct_status from accounts where id = new.account_id;
  if acct_status != 'APPROVED' then
    raise exception 'Cannot post to account % — status is %', new.account_id, acct_status;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_enforce_approved_accounts
  before insert on gl_entry_lines
  for each row execute function enforce_approved_accounts();

-- =============================================================
-- DIMENSION VALIDATION
-- Enforces required dimensions based on account + location flags.
-- =============================================================

create or replace function validate_dimensions()
returns trigger as $$
declare
  acct record;
  loc record;
begin
  select require_department, require_class, require_item
  into acct from accounts where id = new.account_id;

  select require_department, require_class, require_item
  into loc from locations where id = new.location_id;

  -- Use stricter of account vs location requirement
  if (acct.require_department or loc.require_department) and new.department_id is null then
    raise exception 'Department required for account % in location %', new.account_id, new.location_id;
  end if;

  if (acct.require_class or loc.require_class) and new.class_id is null then
    raise exception 'Class required for account % in location %', new.account_id, new.location_id;
  end if;

  if (acct.require_item or loc.require_item) and new.item_id is null then
    raise exception 'Item required for account % in location %', new.account_id, new.location_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger trg_validate_dimensions
  before insert or update on gl_entry_lines
  for each row execute function validate_dimensions();
