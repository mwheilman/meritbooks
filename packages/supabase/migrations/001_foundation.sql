-- Migration 001: Foundation — enums, extensions, core lookup tables
-- MeritBooks Book of Record
-- These tables are referenced by everything else. Deploy first.

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm"; -- fuzzy text matching for vendor patterns

-- =============================================================
-- ENUM TYPES
-- =============================================================

create type account_type_enum as enum (
  'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER'
);

create type account_sub_type_enum as enum (
  'CURRENT_ASSET', 'FIXED_ASSET', 'OTHER_ASSET',
  'CURRENT_LIABILITY', 'LONG_TERM_LIABILITY',
  'EQUITY',
  'REVENUE',
  'COST_OF_GOODS_SOLD',
  'OPERATING_EXPENSE',
  'OTHER_INCOME', 'OTHER_EXPENSE'
);

create type approval_status_enum as enum (
  'DRAFT', 'PENDING', 'APPROVED', 'REJECTED'
);

create type transaction_status_enum as enum (
  'PENDING', 'CATEGORIZED', 'APPROVED', 'POSTED', 'FLAGGED', 'POST_ERROR', 'VOIDED'
);

create type entry_type_enum as enum (
  'STANDARD', 'ADJUSTING', 'CLOSING', 'REVERSING', 'RECURRING', 'SYSTEM'
);

create type period_status_enum as enum (
  'OPEN', 'SOFT_CLOSE', 'HARD_CLOSE'
);

create type labor_type_enum as enum (
  'PRODUCTION', 'DIRECT_ASSIGNED', 'OVERHEAD', 'OWNER_GROUP', 'DEAL_TEAM'
);

create type dept_gl_classification_enum as enum (
  'ALWAYS_OPEX', 'BY_JOB_MATCH'
);

create type rev_rec_method_enum as enum (
  'PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT', 'POINT_OF_SALE'
);

create type chase_channel_enum as enum (
  'PUSH_SMS', 'PUSH_ONLY', 'SMS_ONLY', 'PUSH_SMS_EMAIL'
);

create type vendor_doc_type_enum as enum (
  'W9', 'GL_COI', 'WC_COI', 'WC_EXEMPTION'
);

create type payment_hold_type_enum as enum (
  'ONE_TIME', 'TEMPORARY', 'PERMANENT'
);

create type allocation_method_enum as enum (
  'EVEN_SPLIT', 'BY_REVENUE_PCT', 'BY_HEADCOUNT', 'CUSTOM_PCT'
);

create type close_phase_enum as enum (
  'INITIAL', 'MID_CLOSE', 'FINAL'
);

create type depreciation_method_enum as enum (
  'STRAIGHT_LINE', 'DOUBLE_DECLINING', 'MACRS_3', 'MACRS_5', 'MACRS_7',
  'MACRS_10', 'MACRS_15', 'MACRS_20'
);

-- =============================================================
-- ORGANIZATIONS (top-level tenant)
-- =============================================================

create table organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,
  primary_contact_name text,
  primary_contact_email text,
  timezone text not null default 'America/Chicago',
  fiscal_year_start_month int not null default 1 check (fiscal_year_start_month between 1 and 12),
  setup_complete boolean not null default false,
  chase_first_reminder_minutes int not null default 30,
  chase_followup_minutes int not null default 120,
  chase_escalation_threshold int not null default 3,
  chase_quiet_start time not null default '21:00',
  chase_quiet_end time not null default '06:00',
  chase_channel chase_channel_enum not null default 'PUSH_SMS',
  chase_auto_approve_cents int not null default 2500, -- $25.00
  ai_auto_approve_threshold numeric(5,4) not null default 0.8500,
  ai_auto_approve_max_cents int not null default 1000000, -- $10,000
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- ACCOUNT TYPE HIERARCHY (lookup tables — rarely change)
-- =============================================================

create table account_types (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  code account_type_enum not null,
  display_order int not null,
  normal_balance text not null check (normal_balance in ('DEBIT', 'CREDIT')),
  closes_to_retained_earnings boolean not null default false,
  created_at timestamptz not null default now(),
  unique(org_id, code)
);

create table account_sub_types (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  account_type_id uuid not null references account_types(id) on delete cascade,
  name text not null,
  code account_sub_type_enum not null,
  display_order int not null,
  created_at timestamptz not null default now(),
  unique(org_id, code)
);

create table account_groups (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  account_sub_type_id uuid not null references account_sub_types(id) on delete cascade,
  name text not null,
  display_order int not null,
  created_at timestamptz not null default now(),
  unique(org_id, name)
);

-- =============================================================
-- RLS POLICIES
-- =============================================================

alter table organizations enable row level security;
alter table account_types enable row level security;
alter table account_sub_types enable row level security;
alter table account_groups enable row level security;

-- RLS policies will reference a helper function that extracts org_id
-- from the JWT claims set by Clerk
create or replace function public.get_org_id() returns uuid as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::json->>'org_id')::uuid,
    null
  );
$$ language sql stable;

create policy "org_isolation" on organizations
  for all using (id = public.get_org_id());

create policy "org_isolation" on account_types
  for all using (org_id = public.get_org_id());

create policy "org_isolation" on account_sub_types
  for all using (org_id = public.get_org_id());

create policy "org_isolation" on account_groups
  for all using (org_id = public.get_org_id());

-- =============================================================
-- UPDATED_AT TRIGGER (reusable)
-- =============================================================

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_organizations_updated_at
  before update on organizations
  for each row execute function set_updated_at();
