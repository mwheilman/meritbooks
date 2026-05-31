-- Migration 021: Cost/Billing seam (Books side) — FROZEN v2 contract §8 + routing
-- =============================================================
-- Applies the frozen Event & Cost/Billing Contract (v2) §8 DDL and the Books-side
-- tables for cost attribution + configurable approval routing, and converts
-- core.jobs.customer_id to an enforced FK.
--
-- REQUIRES migration 019 (the core carve) to be deployed first — this migration
-- references core.jobs / core.departments / core.organizations. It hard-fails
-- with a clear message if core is absent, so it cannot run before 019.
-- Idempotent.
-- =============================================================

-- ---- Guard: confirm 019 (core carve) is deployed ----
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'core' and table_name = 'jobs') then
    raise exception 'core.jobs not found — deploy migration 019 (Suite Core carve) before running 021.';
  end if;
end $$;

-- =============================================================
-- 1. Contract §8(a) — job_id dimension on GL lines
-- =============================================================
alter table public.gl_entry_lines
  add column if not exists job_id uuid references core.jobs(id);
create index if not exists idx_gl_entry_lines_job on public.gl_entry_lines(job_id);

-- =============================================================
-- 2. Contract §8(b) — suite event log (append-only; async drain; idempotency)
-- =============================================================
create table if not exists core.events (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  event_id uuid not null,                 -- emitter-supplied; idempotency key
  event_type text not null,               -- JOB_COST | JOB_BILLING | ...
  source_module text not null,            -- BOOKS | PROJECTS | ...
  payload jsonb not null,                 -- the §3/§4 event body
  occurred_on date not null,
  status text not null default 'pending'
    check (status in ('pending','processed','rejected')),
  gl_entry_id uuid,
  invoice_id uuid,
  error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, event_id)
);
alter table core.events enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='events' and policyname='org_isolation') then
    create policy "org_isolation" on core.events for all using (org_id = public.get_org_id());
  end if;
end $$;
create index if not exists idx_core_events_drain on core.events(org_id, event_type, status);
grant select, insert, update, delete on core.events to anon, authenticated, service_role;

-- =============================================================
-- 3. Cleanup — enforce core.jobs.customer_id FK -> core.customers(id)
-- =============================================================
-- Null any orphaned references first (safe on the tabula-rasa / wiped DB), then
-- add the constraint if not already present.
do $$ begin
  update core.jobs j
    set customer_id = null
    where customer_id is not null
      and not exists (select 1 from core.customers c where c.id = j.customer_id);

  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'core' and table_name = 'jobs' and constraint_name = 'jobs_customer_id_fkey'
  ) then
    alter table core.jobs
      add constraint jobs_customer_id_fkey foreign key (customer_id) references core.customers(id);
  end if;
end $$;

-- =============================================================
-- 4. Books-side cost attribution + configurable approval routing
-- =============================================================

-- Routing rules: accounting approves directly, or routes by vendor / GL code /
-- transaction source to a responsible party (incl. the PM/leader). Overridable.
create table if not exists cost_approval_rules (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  match_type text not null check (match_type in ('VENDOR','GL_CODE','TRANSACTION_SOURCE','DEFAULT')),
  match_value text,                       -- vendor_id | account_number | source type | null(DEFAULT)
  approver_type text not null check (approver_type in ('ACCOUNTING','RESPONSIBLE_PARTY','PM_LEADER')),
  approver_ref text,                      -- employee/clerk id when routed to a person
  priority int not null default 100,      -- lower = evaluated first
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cost_approval_rules enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='cost_approval_rules' and policyname='org_isolation') then
    create policy "org_isolation" on cost_approval_rules for all using (org_id = public.get_org_id());
  end if;
end $$;
create index if not exists idx_cost_rules_lookup on cost_approval_rules(org_id, match_type, is_active);

-- Attribution of a cost to a job + its lifecycle. Drives the JOB_COST emitter.
create table if not exists job_cost_attributions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  job_id uuid not null references core.jobs(id),
  department_id uuid references core.departments(id),
  cost_type text not null check (cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  amount_cents bigint not null check (amount_cents > 0),
  occurred_on date not null,
  gate text not null check (gate in ('PAYABLE_APPROVAL','BANKFEED_CATEGORIZATION','TIMESHEET_PAYROLL')),
  lifecycle text not null default 'PENDING' check (lifecycle in ('PENDING','CLEARED','VOIDED')),
  source_type text not null check (source_type in ('BILL','BANK_TXN','TIMESHEET','MANUAL')),
  source_ref text,
  gl_entry_id uuid references gl_entries(id),
  gl_entry_line_id uuid references gl_entry_lines(id),
  approver_type text check (approver_type in ('ACCOUNTING','RESPONSIBLE_PARTY','PM_LEADER')),
  approver_ref text,
  approved_by text,
  approved_at timestamptz,
  void_reason text,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table job_cost_attributions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='job_cost_attributions' and policyname='org_isolation') then
    create policy "org_isolation" on job_cost_attributions for all using (org_id = public.get_org_id());
  end if;
end $$;
create index if not exists idx_attr_queue on job_cost_attributions(org_id, lifecycle);
create index if not exists idx_attr_job on job_cost_attributions(job_id);
