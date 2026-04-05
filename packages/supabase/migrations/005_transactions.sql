-- Migration 005: Transaction Processing
-- Vendors, bills, bank transactions, receipts, and the AI categorization pipeline.

-- =============================================================
-- VENDORS
-- =============================================================

create table vendors (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  display_name text,

  -- AI-learned defaults
  default_account_id uuid references accounts(id),
  default_department_id uuid references departments(id),
  default_class_id uuid references classes(id),
  ai_confidence numeric(5,4) not null default 0,
  auto_approve boolean not null default false,
  transaction_count int not null default 0,
  ytd_spend_cents bigint not null default 0,

  -- Tax
  is_1099_eligible boolean not null default false,
  tin_encrypted text, -- encrypted TIN/EIN
  w9_status text default 'MISSING' check (w9_status in ('MISSING', 'RECEIVED', 'VERIFIED')),

  -- Contact
  email text,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  payment_terms_days int not null default 30,

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- VENDOR PATTERN CACHE (AI learning memory)
-- =============================================================

create table vendor_patterns (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  raw_description text not null, -- exact bank description text
  normalized_description text not null, -- lowercased, stripped
  account_id uuid not null references accounts(id),
  department_id uuid references departments(id),
  class_id uuid references classes(id),
  location_id uuid references locations(id),
  match_count int not null default 1,
  last_matched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- =============================================================
-- VENDOR COMPLIANCE DOCUMENTS
-- =============================================================

create table vendor_compliance_docs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  doc_type vendor_doc_type_enum not null,
  status text not null default 'MISSING' check (status in ('MISSING', 'PENDING', 'VALID', 'EXPIRED')),
  file_url text,
  issued_date date,
  expiration_date date, -- null for W-9
  coverage_amount_cents bigint,
  verified_by uuid,
  verified_at timestamptz,
  chase_reminder_count int not null default 0,
  last_chase_at timestamptz,
  next_chase_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- VENDOR PAYMENT HOLD OVERRIDES
-- =============================================================

create table vendor_payment_holds (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  hold_type payment_hold_type_enum not null,
  reason text not null,
  start_date date,
  end_date date, -- null for permanent
  created_by uuid not null,
  created_at timestamptz not null default now()
);

-- =============================================================
-- BANK ACCOUNTS
-- =============================================================

create table bank_accounts (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  account_id uuid not null references accounts(id), -- GL cash account
  plaid_account_id text,
  institution_name text not null,
  account_name text not null,
  account_mask text, -- last 4 digits
  account_type text not null check (account_type in ('CHECKING', 'SAVINGS', 'CREDIT_CARD', 'LINE_OF_CREDIT')),
  current_balance_cents bigint,
  available_balance_cents bigint,
  balance_updated_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- BANK TRANSACTIONS (from Plaid feed)
-- =============================================================

create table bank_transactions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id) on delete cascade,
  location_id uuid not null references locations(id),

  -- Plaid data
  plaid_transaction_id text,
  transaction_date date not null,
  posted_date date,
  description text not null,
  amount_cents bigint not null, -- negative = debit (money out), positive = credit (money in)
  category text, -- Plaid category

  -- AI categorization
  status transaction_status_enum not null default 'PENDING',
  ai_account_id uuid references accounts(id),
  ai_department_id uuid references departments(id),
  ai_class_id uuid references classes(id),
  ai_vendor_id uuid references vendors(id),
  ai_confidence numeric(5,4),
  ai_reasoning text,
  ai_model_version text,

  -- Human overrides
  final_account_id uuid references accounts(id),
  final_department_id uuid references departments(id),
  final_class_id uuid references classes(id),
  final_vendor_id uuid references vendors(id),
  approved_by uuid,
  approved_at timestamptz,

  -- Matching
  matched_bill_id uuid, -- FK added after bills table
  matched_receipt_id uuid, -- FK added after receipts table
  match_type text check (match_type in ('VENDOR_PATTERN', 'BILL_PAYMENT', 'RECEIPT', 'NONE')),
  match_confidence numeric(5,4),

  -- GL posting
  gl_entry_id uuid references gl_entries(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- BILLS (AP invoices from vendors)
-- =============================================================

create table bills (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),
  vendor_id uuid not null references vendors(id),

  -- Identity
  bill_number text,
  bill_date date not null,
  due_date date not null,
  received_date date not null default current_date,

  -- Amounts
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  amount_paid_cents bigint not null default 0,
  balance_cents bigint generated always as (total_cents - amount_paid_cents) stored,

  -- Status
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOIDED', 'ON_HOLD')),
  payment_hold_reason text,

  -- AI extraction
  ai_extracted boolean not null default false,
  ai_confidence numeric(5,4),
  source_file_url text,
  source_email_id text,

  -- GL posting
  gl_entry_id uuid references gl_entries(id),

  -- Approval
  approved_by uuid,
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- BILL LINES
-- =============================================================

create table bill_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  bill_id uuid not null references bills(id) on delete cascade,
  line_number int not null,
  description text,
  account_id uuid not null references accounts(id),
  department_id uuid references departments(id),
  class_id uuid references classes(id),
  item_id uuid references items(id),
  quantity numeric(15,4) not null default 1,
  unit_cost_cents bigint not null default 0,
  amount_cents bigint not null,
  job_id uuid, -- FK added after jobs table
  created_at timestamptz not null default now()
);

-- =============================================================
-- RECEIPTS
-- =============================================================

create table receipts (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),

  -- Source
  source text not null check (source in ('MOBILE_CAPTURE', 'EMAIL', 'MANUAL_UPLOAD')),
  image_url text,
  submitted_by uuid,
  submitted_at timestamptz not null default now(),

  -- AI extraction
  vendor_name text,
  vendor_id uuid references vendors(id),
  amount_cents bigint,
  receipt_date date,
  account_id uuid references accounts(id),
  department_id uuid references departments(id),
  class_id uuid references classes(id),
  ai_confidence numeric(5,4),
  ai_extracted_data jsonb, -- full extraction result

  -- Status
  status transaction_status_enum not null default 'PENDING',
  approved_by uuid,
  approved_at timestamptz,

  -- Matching
  bank_transaction_id uuid references bank_transactions(id),

  -- GL posting
  gl_entry_id uuid references gl_entries(id),

  -- Chase tracking
  chase_reminder_count int not null default 0,
  last_chase_at timestamptz,
  escalated_to uuid,
  escalated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add FK from bank_transactions now that receipts/bills exist
alter table bank_transactions
  add constraint fk_matched_bill foreign key (matched_bill_id) references bills(id),
  add constraint fk_matched_receipt foreign key (matched_receipt_id) references receipts(id);

-- =============================================================
-- INDEXES
-- =============================================================

create index idx_vendors_org on vendors(org_id);
create index idx_vendors_name on vendors using gin (name gin_trgm_ops);
create index idx_vendor_patterns_org on vendor_patterns(org_id);
create index idx_vendor_patterns_desc on vendor_patterns using gin (normalized_description gin_trgm_ops);
create index idx_vendor_compliance_vendor on vendor_compliance_docs(vendor_id);
create index idx_vendor_compliance_expiry on vendor_compliance_docs(expiration_date) where status = 'VALID';

create index idx_bank_accounts_org on bank_accounts(org_id);
create index idx_bank_accounts_location on bank_accounts(location_id);

create index idx_bank_txns_org on bank_transactions(org_id);
create index idx_bank_txns_account on bank_transactions(bank_account_id);
create index idx_bank_txns_date on bank_transactions(org_id, transaction_date);
create index idx_bank_txns_status on bank_transactions(org_id, status);
create index idx_bank_txns_plaid on bank_transactions(plaid_transaction_id);

create index idx_bills_org on bills(org_id);
create index idx_bills_vendor on bills(vendor_id);
create index idx_bills_status on bills(org_id, status);
create index idx_bills_due on bills(org_id, due_date) where status not in ('PAID', 'VOIDED');

create index idx_bill_lines_bill on bill_lines(bill_id);

create index idx_receipts_org on receipts(org_id);
create index idx_receipts_status on receipts(org_id, status);
create index idx_receipts_bank_txn on receipts(bank_transaction_id);

-- =============================================================
-- RLS
-- =============================================================

alter table vendors enable row level security;
alter table vendor_patterns enable row level security;
alter table vendor_compliance_docs enable row level security;
alter table vendor_payment_holds enable row level security;
alter table bank_accounts enable row level security;
alter table bank_transactions enable row level security;
alter table bills enable row level security;
alter table bill_lines enable row level security;
alter table receipts enable row level security;

create policy "org_isolation" on vendors for all using (org_id = public.get_org_id());
create policy "org_isolation" on vendor_patterns for all using (org_id = public.get_org_id());
create policy "org_isolation" on vendor_compliance_docs for all using (org_id = public.get_org_id());
create policy "org_isolation" on vendor_payment_holds for all using (org_id = public.get_org_id());
create policy "org_isolation" on bank_accounts for all using (org_id = public.get_org_id());
create policy "org_isolation" on bank_transactions for all using (org_id = public.get_org_id());
create policy "org_isolation" on bills for all using (org_id = public.get_org_id());
create policy "org_isolation" on bill_lines for all using (org_id = public.get_org_id());
create policy "org_isolation" on receipts for all using (org_id = public.get_org_id());

-- =============================================================
-- TRIGGERS
-- =============================================================

create trigger trg_vendors_updated_at
  before update on vendors for each row execute function set_updated_at();
create trigger trg_bank_accounts_updated_at
  before update on bank_accounts for each row execute function set_updated_at();
create trigger trg_bank_txns_updated_at
  before update on bank_transactions for each row execute function set_updated_at();
create trigger trg_bills_updated_at
  before update on bills for each row execute function set_updated_at();
create trigger trg_receipts_updated_at
  before update on receipts for each row execute function set_updated_at();
