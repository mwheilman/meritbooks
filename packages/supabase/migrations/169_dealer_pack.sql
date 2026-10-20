-- =============================================================================
-- Migration 169: Dealer Pack — data model (FPB-dealer-pack.md, slice D1)
-- =============================================================================
-- WHAT. The Books-owned subledgers an equipment dealer needs on top of an ordinary
-- small business: per-client enablement + policies, department-role map, floor-plan
-- lenders / lines / programs / notes (per serialized unit or per open-account parts
-- invoice) with every money event, curtailment schedules, a serialized unit register
-- with cost build-up, unit sales (deals) + trade-ins, manufacturer warranty claims,
-- OEM incentive programs + receivables, OEM statements, lender statements / floor
-- checks + line-level reconciliation (preparer <> approver), import batches.
--
-- CANON. Books owns the ledger, not the business objects: lenders / manufacturers /
-- lienholders are core.vendors, buyers core.customers, models core.items, clients
-- core.locations, departments core.departments (all referenced by FK, never copied).
-- Accounts are referenced BY ROLE (core.account_role_keys → public.account_roles);
-- the 21 new dealer roles carry NO default account number — the tenant maps them per
-- client and the pack refuses to switch on until every required role resolves.
-- All money bigint cents; rates integer basis points. Every GL effect posts through
-- postJournalEntry (app). Nothing here posts GL.
--
-- SECURITY POSTURE (054/154/167 pattern, deliberately STRICTER than the plain
-- business-table norm). Every dealer table carries approval / posting state
-- (gl_entry_id, status POSTED, approved_by, released_by, enabled) that is CONTROL
-- data — a member writing it directly over PostgREST could mark a payoff released,
-- sign their own reconciliation or flip the pack on with an unmapped role map. So
-- for ALL tables below: RLS on; policies = member_read (SELECT, org_id =
-- get_org_id()) + service_all (service_role); INSERT/UPDATE/DELETE/TRUNCATE revoked
-- from anon + authenticated. Every app write goes through the service-role client
-- AFTER requirePermission + a client-access check, pinned to the session org
-- (apps/web/src/lib/dealer/**). Client-scope RLS (mig 163) attaches automatically:
-- every table has an owning location_id and the migration ends by re-running
-- core.apply_client_scope_rls().
--
-- PGlite-safe: no subqueries in CHECKs, idempotent (if not exists / drop-if-exists /
-- on conflict), every `revoke all on function` is followed by explicit grants.
-- =============================================================================

-- ── 1. Account-role vocabulary (no default numbers — mapped per client) ─────────
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('WHOLE_GOODS_INVENTORY',       'Whole goods inventory (new units)',            'LOCATION', null),
  ('USED_WHOLE_GOODS_INVENTORY',  'Used whole goods inventory',                   'LOCATION', null),
  ('RENTAL_INVENTORY',            'Rental-ready units at cost',                   'LOCATION', null),
  ('FLOOR_PLAN_PAYABLE',          'Floor plan payable',                           'LOCATION', null),
  ('FLOOR_PLAN_INTEREST_ACCRUED', 'Accrued floor plan interest',                  'LOCATION', null),
  ('FLOOR_PLAN_INTEREST',         'Floor plan interest expense',                  'ORG',      null),
  ('FLOOR_PLAN_FEES',             'Floor plan fees (late, audit)',                'ORG',      null),
  ('WHOLE_GOODS_SALES',           'Whole goods sales (new)',                      'ORG',      null),
  ('WHOLE_GOODS_COGS',            'Whole goods cost of sales (new)',              'ORG',      null),
  ('USED_GOODS_SALES',            'Used whole goods sales',                       'ORG',      null),
  ('USED_GOODS_COGS',             'Used whole goods cost of sales',               'ORG',      null),
  ('TRADE_IN_OVER_ALLOWANCE',     'Trade-in over-allowance (contra revenue)',     'ORG',      null),
  ('TRADE_LIEN_PAYOFF',           'Trade-in lien payoff payable',                 'LOCATION', null),
  ('SETUP_LABOR_CAPITALIZED',     'Setup/PDI labor capitalized to units',         'ORG',      null),
  ('INVENTORY_WRITEDOWN',         'Unit inventory write-down (NRV)',              'ORG',      null),
  ('WARRANTY_RECEIVABLE',         'Manufacturer warranty claims receivable',      'LOCATION', null),
  ('WARRANTY_LABOR_SALES',        'Warranty labor sales',                         'ORG',      null),
  ('WARRANTY_PARTS_SALES',        'Warranty parts sales',                         'ORG',      null),
  ('WARRANTY_POLICY_EXPENSE',     'Warranty short-pay / rejection / policy',      'ORG',      null),
  ('OEM_INCENTIVE_RECEIVABLE',    'Manufacturer incentives receivable',           'LOCATION', null),
  ('CO_OP_ADVERTISING_RECOVERY',  'Co-op advertising recovery (contra OPEX)',     'ORG',      null)
on conflict (role_key) do update set label = excluded.label, scope = excluded.scope;

-- ── 2. Journal entry types (mig 055 pattern; not used inside this migration) ────
alter type public.entry_type_enum add value if not exists 'FLOOR_PLAN';
alter type public.entry_type_enum add value if not exists 'FLOOR_PLAN_INTEREST';
alter type public.entry_type_enum add value if not exists 'UNIT_SALE';
alter type public.entry_type_enum add value if not exists 'TRADE_IN';
alter type public.entry_type_enum add value if not exists 'WARRANTY_CLAIM';
alter type public.entry_type_enum add value if not exists 'OEM_INCENTIVE';
alter type public.entry_type_enum add value if not exists 'UNIT_COST';

-- ── 3. Settings + department map ────────────────────────────────────────────────
create table if not exists public.dealer_pack_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  enabled boolean not null default false,
  enabled_at timestamptz, enabled_by text,
  disabled_at timestamptz, disabled_by text,
  dms_system text,
  -- Policies. Treatments the FPB marks [U] (unverified) are per-client settings here.
  trade_valuation_policy text not null default 'LOWER_OF_ACV_AND_ALLOWANCE'
    check (trade_valuation_policy in ('LOWER_OF_ACV_AND_ALLOWANCE','ACV','ALLOWANCE')),
  warranty_recognition text not null default 'ON_SUBMIT'
    check (warranty_recognition in ('ON_RO_CLOSE','ON_SUBMIT')),
  warranty_relieve_parts_inventory boolean not null default true,
  capitalize_setup_labor boolean not null default true,
  cost_reduction_in_stock text not null default 'REDUCE_UNIT_COST'
    check (cost_reduction_in_stock in ('REDUCE_UNIT_COST','REDUCE_COGS')),
  oem_settlement_default text not null default 'STATEMENT_CREDIT'
    check (oem_settlement_default in ('STATEMENT_CREDIT','CASH')),
  sot_grace_days int not null default 2 check (sot_grace_days between 0 and 30),
  aging_buckets int[] not null default '{90,180,270,365}',
  term_warning_days int not null default 60 check (term_warning_days >= 0),
  interest_tolerance_cents bigint not null default 2500 check (interest_tolerance_cents >= 0),
  interest_tolerance_bps int not null default 200 check (interest_tolerance_bps between 0 and 10000),
  statement_tolerance_cents bigint not null default 100 check (statement_tolerance_cents >= 0),
  auto_match_min_confidence_bps int not null default 9500 check (auto_match_min_confidence_bps between 0 and 10000),
  curtailment_warn_days int not null default 7 check (curtailment_warn_days >= 0),
  warranty_deadline_warn_days int not null default 5 check (warranty_deadline_warn_days >= 0),
  warranty_submitted_aging_days int not null default 45 check (warranty_submitted_aging_days >= 0),
  incentive_deadline_warn_days int not null default 10 check (incentive_deadline_warn_days >= 0),
  incentive_submitted_aging_days int not null default 60 check (incentive_submitted_aging_days >= 0),
  lien_unpaid_days int not null default 10 check (lien_unpaid_days >= 0),
  over_allowance_warn_bps int not null default 2000 check (over_allowance_warn_bps between 0 and 10000),
  line_utilization_warn_bps int not null default 9000 check (line_utilization_warn_bps between 0 and 10000),
  trade_acv_approval_threshold_cents bigint not null default 0 check (trade_acv_approval_threshold_cents >= 0),
  opening_tieout jsonb,
  opening_tieout_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (org_id, location_id)
);

create table if not exists public.dealer_department_map (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  dept_role text not null check (dept_role in ('WG_NEW','WG_USED','PARTS','SERVICE','RENTAL','ADMIN')),
  department_id uuid not null references core.departments(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, location_id, dept_role)
);

-- ── 4. Floor plan: lines, programs ──────────────────────────────────────────────
create table if not exists public.floor_plan_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  lender_vendor_id uuid not null references core.vendors(id),
  name text not null,
  credit_limit_cents bigint not null default 0 check (credit_limit_cents >= 0),
  liability_account_id uuid references public.accounts(id),
  interest_due_day int check (interest_due_day between 1 and 31),
  scheduled_payment_day int check (scheduled_payment_day between 1 and 31),
  statement_day int check (statement_day between 1 and 31),
  sau_codes text[] not null default '{}',
  debt_instrument_id uuid references public.debt_instruments(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','CREDIT_HOLD','CLOSED')),
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_fpl_org_loc on public.floor_plan_lines (org_id, location_id);

create table if not exists public.floor_plan_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  line_id uuid not null references public.floor_plan_lines(id),
  oem_vendor_id uuid references core.vendors(id),
  name text not null,
  free_floor_days int not null default 0 check (free_floor_days >= 0),
  rate_type text not null default 'FIXED' check (rate_type in ('FIXED','INDEX_PLUS')),
  rate_bps int not null default 0 check (rate_bps >= 0),
  index_name text,
  index_rate_bps int check (index_rate_bps is null or index_rate_bps >= 0),
  spread_bps int,
  sau_penalty_rate_bps int check (sau_penalty_rate_bps is null or sau_penalty_rate_bps >= 0),
  day_count text not null default 'ACT_365' check (day_count in ('ACT_365','ACT_360')),
  payoff_terms text not null default 'PAY_AS_SOLD' check (payoff_terms in ('PAY_AS_SOLD','DAYS_AFTER_SALE')),
  payoff_days int not null default 0 check (payoff_days >= 0),
  max_term_days int check (max_term_days is null or max_term_days > 0),
  curtail_demos boolean not null default false,
  curtailment_schedule jsonb not null default '[]' check (jsonb_typeof(curtailment_schedule) = 'array'),
  effective_from date not null default current_date,
  effective_to date,
  status text not null default 'ACTIVE' check (status in ('DRAFT','ACTIVE','RETIRED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (rate_type <> 'INDEX_PLUS' or (index_rate_bps is not null and spread_bps is not null))
);
create index if not exists ix_fpp_line on public.floor_plan_programs (line_id);

-- ── 5. Unit register + cost build-up ────────────────────────────────────────────
create table if not exists public.dealer_import_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  source_system text not null,
  file_kind text not null check (file_kind in ('UNITS','DEALS','WARRANTY','LENDER_STATEMENT','LENDER_AUDIT',
    'OEM_STATEMENT','PROGRAMS','OPENING')),
  file_name text,
  document_id uuid,
  row_count int not null default 0 check (row_count >= 0),
  accepted_count int not null default 0 check (accepted_count >= 0),
  rejected_count int not null default 0 check (rejected_count >= 0),
  errors jsonb not null default '[]',
  status text not null default 'UPLOADED' check (status in ('UPLOADED','VALIDATED','PROPOSED','POSTED','UNDONE','FAILED')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dealer_units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  serial_number text not null check (length(btrim(serial_number)) > 0),
  vin_hin text, stock_number text,
  make_vendor_id uuid references core.vendors(id),
  model text, model_year int check (model_year is null or model_year between 1900 and 2200),
  item_id uuid references core.items(id),
  description text,
  condition text not null default 'NEW' check (condition in ('NEW','USED','DEMO','RENTAL')),
  is_consignment boolean not null default false,
  consignor_vendor_id uuid references core.vendors(id),
  status text not null default 'IN_STOCK' check (status in
    ('ON_ORDER','IN_TRANSIT','IN_STOCK','SOLD','DELIVERED','RENTAL','RETURNED','WRITTEN_OFF','VOID')),
  inventory_role text not null default 'WHOLE_GOODS_INVENTORY'
    check (inventory_role in ('WHOLE_GOODS_INVENTORY','USED_WHOLE_GOODS_INVENTORY','RENTAL_INVENTORY')),
  department_role text not null default 'WG_NEW'
    check (department_role in ('WG_NEW','WG_USED','PARTS','SERVICE','RENTAL','ADMIN')),
  received_date date, sold_date date, warranty_registered_date date,
  cost_cents bigint not null default 0,
  list_price_cents bigint check (list_price_cents is null or list_price_cents >= 0),
  source text not null default 'MANUAL' check (source in ('DMS','LENDER','MANUAL','TRADE_IN','OPENING')),
  external_ref text,
  import_batch_id uuid references public.dealer_import_batches(id),
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('SOLD','DELIVERED') or sold_date is not null),
  check (not is_consignment or condition <> 'RENTAL')
);
create unique index if not exists ux_dealer_units_serial
  on public.dealer_units (org_id, location_id,
    coalesce(make_vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(btrim(serial_number)))
  where status <> 'VOID';
create index if not exists ix_dealer_units_loc_status on public.dealer_units (org_id, location_id, status);

create table if not exists public.dealer_unit_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  unit_id uuid not null references public.dealer_units(id),
  cost_type text not null check (cost_type in
    ('BASE_INVOICE','FREIGHT','SETUP_PDI','ACCESSORY','RECON','OTHER','REBATE_REDUCTION','WRITE_DOWN')),
  amount_cents bigint not null,
  labor_cents bigint not null default 0 check (labor_cents >= 0),
  parts_cents bigint not null default 0 check (parts_cents >= 0),
  source_type text not null check (source_type in
    ('FLOOR_PLAN_NOTE','BILL_LINE','INTERNAL_RO','INCENTIVE','JE','TRADE_IN','OPENING')),
  source_id uuid,
  source_ref text,
  offset_role text,
  memo text,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','POSTED','VOID')),
  gl_entry_id uuid references public.gl_entries(id),
  idempotency_key text not null,
  proposed_by text, posted_by text, posted_at timestamptz,
  created_at timestamptz not null default now(),
  check ((cost_type in ('REBATE_REDUCTION','WRITE_DOWN') and amount_cents < 0)
      or (cost_type not in ('REBATE_REDUCTION','WRITE_DOWN') and amount_cents > 0)),
  unique (org_id, idempotency_key)
);
create index if not exists ix_duc_unit on public.dealer_unit_costs (unit_id);

-- ── 6. Floor-plan notes, money events, curtailments ─────────────────────────────
create table if not exists public.floor_plan_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  line_id uuid not null references public.floor_plan_lines(id),
  program_id uuid references public.floor_plan_programs(id),
  unit_id uuid references public.dealer_units(id),
  collateral_type text not null default 'WHOLE_GOOD' check (collateral_type in ('WHOLE_GOOD','OPEN_ACCOUNT','OTHER')),
  lender_invoice_number text not null check (length(btrim(lender_invoice_number)) > 0),
  description text,
  floored_date date not null,
  original_principal_cents bigint not null check (original_principal_cents > 0),
  principal_balance_cents bigint not null,
  free_floor_end_date date,
  maturity_date date,
  scheduled_due_date date,
  interest_accrued_through date,
  status text not null default 'OPEN' check (status in ('OPEN','SOLD_UNPAID','PAID_OFF','IN_DEFAULT','RETURNED','VOID')),
  sold_date date,
  payoff_due_date date,
  paid_off_date date,
  sold_detected_by text check (sold_detected_by in ('BOOKS_SALE','DMS_DEAL','WARRANTY_REG','LENDER_AUDIT')),
  is_opening boolean not null default false,
  import_batch_id uuid references public.dealer_import_batches(id),
  idempotency_key text not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (principal_balance_cents between 0 and original_principal_cents),
  check (collateral_type <> 'WHOLE_GOOD' or unit_id is not null),
  check (status <> 'SOLD_UNPAID' or (sold_date is not null and payoff_due_date is not null)),
  check (status <> 'PAID_OFF' or principal_balance_cents = 0),
  unique (org_id, idempotency_key)
);
create unique index if not exists ux_fpn_invoice
  on public.floor_plan_notes (line_id, upper(btrim(lender_invoice_number)),
    coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'VOID';
create unique index if not exists ux_fpn_one_live_per_unit
  on public.floor_plan_notes (unit_id) where unit_id is not null and status in ('OPEN','SOLD_UNPAID','IN_DEFAULT');
create index if not exists ix_fpn_loc_status on public.floor_plan_notes (org_id, location_id, status);

create table if not exists public.floor_plan_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  line_id uuid not null references public.floor_plan_lines(id),
  note_id uuid references public.floor_plan_notes(id),
  txn_type text not null check (txn_type in ('FLOOR','OPENING','CURTAILMENT','PAYOFF','INTEREST_ACCRUAL',
    'INTEREST_BILLED','INTEREST_PAID','FEE','ADJUSTMENT','REVERSAL')),
  txn_date date not null,
  period_end date,
  principal_cents bigint not null default 0 check (principal_cents >= 0),
  interest_cents bigint not null default 0 check (interest_cents >= 0),
  accrual_cleared_cents bigint not null default 0 check (accrual_cleared_cents >= 0),
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  status text not null default 'PROPOSED' check (status in ('PROPOSED','POSTED','VOID')),
  gl_entry_id uuid references public.gl_entries(id),
  bank_transaction_id uuid, payment_id uuid,
  reverses_txn_id uuid references public.floor_plan_transactions(id),
  curtailment_id uuid,
  memo text,
  proposed_by text, approved_by text, released_by text,
  posted_at timestamptz,
  disposition text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  check (note_id is not null or txn_type in ('INTEREST_BILLED','INTEREST_PAID','FEE','ADJUSTMENT','REVERSAL')),
  -- A payoff is a money movement: the person who releases it is never the proposer.
  check (released_by is null or proposed_by is null or released_by <> proposed_by),
  unique (org_id, idempotency_key)
);
create index if not exists ix_fpt_note on public.floor_plan_transactions (note_id);
create index if not exists ix_fpt_line_type on public.floor_plan_transactions (line_id, txn_type, status);

create table if not exists public.floor_plan_curtailments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  note_id uuid not null references public.floor_plan_notes(id),
  sequence int not null default 1 check (sequence >= 1),
  due_date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'DUE' check (status in ('DUE','PAID','WAIVED','MISSED')),
  paid_txn_id uuid references public.floor_plan_transactions(id),
  waived_by text, waived_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, sequence)
);
create index if not exists ix_fpc_due on public.floor_plan_curtailments (org_id, location_id, status, due_date);

-- ── 7. Lender statements / floor checks ─────────────────────────────────────────
create table if not exists public.lender_statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  line_id uuid not null references public.floor_plan_lines(id),
  kind text not null check (kind in ('STATEMENT','AUDIT','PAYOFF_QUOTE')),
  statement_date date not null,
  document_id uuid,
  import_batch_id uuid references public.dealer_import_batches(id),
  footer_principal_cents bigint, footer_interest_cents bigint, footer_fees_cents bigint,
  footer_line_count int,
  status text not null default 'IMPORTED' check (status in ('IMPORTED','MATCHING','PREPARED','APPROVED')),
  prepared_by text, prepared_at timestamptz,
  approved_by text, approved_at timestamptz,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (approved_by is null or prepared_by is null or approved_by <> prepared_by),
  check (status <> 'APPROVED' or (approved_by is not null and prepared_by is not null))
);
create unique index if not exists ux_lender_statement_once
  on public.lender_statements (line_id, kind, statement_date);

create table if not exists public.lender_statement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  statement_id uuid not null references public.lender_statements(id) on delete cascade,
  line_number int,
  lender_invoice_number text, serial_number text, model text,
  original_cents bigint, current_cents bigint, interest_cents bigint, fees_cents bigint,
  lender_code text, disposition_date date, days int,
  matched_note_id uuid references public.floor_plan_notes(id),
  match_status text not null default 'UNMATCHED'
    check (match_status in ('UNMATCHED','MATCHED','VARIANCE','LENDER_ONLY','BOOKS_ONLY','RESOLVED')),
  match_method text check (match_method in ('INVOICE_NUMBER','SERIAL','MODEL_AMOUNT','BOOKS_ONLY')),
  variance_cents bigint not null default 0,
  sau_flag boolean not null default false,
  resolution text,
  resolved_by text, resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ix_lsl_statement on public.lender_statement_lines (statement_id);

-- ── 8. Trade-ins + unit sales ───────────────────────────────────────────────────
create table if not exists public.trade_ins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  sale_id uuid,
  customer_id uuid references core.customers(id),
  used_unit_id uuid references public.dealer_units(id),
  serial_number text, make_vendor_id uuid references core.vendors(id), model text, model_year int,
  allowance_cents bigint not null check (allowance_cents >= 0),
  acv_cents bigint not null check (acv_cents >= 0),
  valuation_policy text not null default 'LOWER_OF_ACV_AND_ALLOWANCE'
    check (valuation_policy in ('LOWER_OF_ACV_AND_ALLOWANCE','ACV','ALLOWANCE')),
  recorded_value_cents bigint not null check (recorded_value_cents >= 0),
  over_allowance_cents bigint generated always as (greatest(allowance_cents - recorded_value_cents, 0)) stored,
  under_allowance_cents bigint generated always as (greatest(recorded_value_cents - allowance_cents, 0)) stored,
  lien_payoff_cents bigint not null default 0 check (lien_payoff_cents >= 0),
  lienholder_vendor_id uuid references core.vendors(id),
  lien_status text not null default 'NONE' check (lien_status in ('NONE','OWED','PROPOSED','PAID')),
  lien_proposed_by text, lien_released_by text,
  lien_paid_date date,
  lien_gl_entry_id uuid references public.gl_entries(id),
  appraised_by text, appraised_at timestamptz,
  approved_by text, approved_at timestamptz,
  status text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','POSTED','VOID')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- recorded value follows the policy snapshot (no subquery: the policy is on the row)
  check (
       (valuation_policy = 'LOWER_OF_ACV_AND_ALLOWANCE' and recorded_value_cents = least(acv_cents, allowance_cents))
    or (valuation_policy = 'ACV' and recorded_value_cents = acv_cents)
    or (valuation_policy = 'ALLOWANCE' and recorded_value_cents = allowance_cents)),
  check (lien_payoff_cents = 0 or lienholder_vendor_id is not null),
  check (lien_released_by is null or lien_proposed_by is null or lien_released_by <> lien_proposed_by),
  check (status not in ('APPROVED','POSTED') or approved_by is not null)
);

create table if not exists public.dealer_unit_sales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  unit_id uuid not null references public.dealer_units(id),
  invoice_id uuid references public.invoices(id),
  posting_mode text not null default 'DEAL' check (posting_mode in ('DEAL','BOOKS_INVOICE')),
  customer_id uuid references core.customers(id),
  sale_date date not null,
  sale_price_cents bigint not null check (sale_price_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  deposit_id uuid references public.customer_deposits(id),
  deposit_applied_cents bigint not null default 0 check (deposit_applied_cents >= 0),
  retail_rebate_cents bigint not null default 0 check (retail_rebate_cents >= 0),
  retail_rebate_program_id uuid,
  trade_in_id uuid references public.trade_ins(id),
  cogs_cents bigint,
  salesperson text,
  retail_finance_vendor_id uuid references core.vendors(id),
  source text not null default 'BOOKS' check (source in ('BOOKS','DMS')),
  external_deal_ref text,
  import_batch_id uuid references public.dealer_import_batches(id),
  status text not null default 'PROPOSED' check (status in ('PROPOSED','POSTED','VOID')),
  gl_entry_id uuid references public.gl_entries(id),
  proposed_by text, posted_by text, posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (posting_mode <> 'BOOKS_INVOICE' or invoice_id is not null),
  check (deposit_applied_cents = 0 or deposit_id is not null)
);
create unique index if not exists ux_unit_sale_one_live on public.dealer_unit_sales (unit_id) where status <> 'VOID';
create unique index if not exists ux_unit_sale_external
  on public.dealer_unit_sales (org_id, location_id, external_deal_ref) where external_deal_ref is not null and status <> 'VOID';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'trade_ins_sale_id_fkey') then
    alter table public.trade_ins add constraint trade_ins_sale_id_fkey
      foreign key (sale_id) references public.dealer_unit_sales(id);
  end if;
end $$;

-- ── 9. Warranty, OEM programs + incentives, OEM statements ──────────────────────
create table if not exists public.warranty_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  oem_vendor_id uuid not null references core.vendors(id),
  oem_claim_number text, dealer_claim_ref text, repair_order_ref text,
  job_id uuid references core.jobs(id),
  unit_id uuid references public.dealer_units(id), serial_number text,
  customer_id uuid references core.customers(id),
  failure_date date, repair_date date, ro_closed_date date, submitted_date date, filing_deadline date,
  labor_hours numeric(8,2) not null default 0 check (labor_hours >= 0),
  labor_rate_cents bigint not null default 0 check (labor_rate_cents >= 0),
  labor_cents bigint not null default 0 check (labor_cents >= 0),
  parts_cost_cents bigint not null default 0 check (parts_cost_cents >= 0),
  parts_markup_bps int not null default 0 check (parts_markup_bps >= 0),
  parts_cents bigint not null default 0 check (parts_cents >= 0),
  sublet_cents bigint not null default 0 check (sublet_cents >= 0),
  freight_cents bigint not null default 0 check (freight_cents >= 0),
  other_cents bigint not null default 0 check (other_cents >= 0),
  claimed_cents bigint not null check (claimed_cents >= 0),
  approved_cents bigint,
  settled_cents bigint not null default 0 check (settled_cents >= 0),
  written_off_cents bigint not null default 0 check (written_off_cents >= 0),
  debited_cents bigint not null default 0 check (debited_cents >= 0),
  status text not null default 'DRAFT' check (status in
    ('DRAFT','SUBMITTED','PARTIAL','PAID','REJECTED','RESUBMITTED','WRITTEN_OFF','DEBITED','VOID')),
  rejection_reason text,
  recognized_gl_entry_id uuid references public.gl_entries(id),
  gl_entry_id uuid references public.gl_entries(id),
  import_batch_id uuid references public.dealer_import_batches(id),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (claimed_cents = labor_cents + parts_cents + sublet_cents + freight_cents + other_cents),
  check (settled_cents + written_off_cents <= claimed_cents)
);
create unique index if not exists ux_warranty_oem_claim
  on public.warranty_claims (org_id, oem_vendor_id, oem_claim_number) where oem_claim_number is not null and status <> 'VOID';
create index if not exists ix_wc_loc_status on public.warranty_claims (org_id, location_id, status);

create table if not exists public.oem_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  oem_vendor_id uuid not null references core.vendors(id),
  program_code text, name text not null,
  program_type text not null check (program_type in ('RETAIL_REBATE','DEALER_REBATE','VOLUME_BONUS','HOLDBACK',
    'CO_OP','SPIFF','INTEREST_SUBSIDY','FLOOR_PLAN_SUPPORT','DEMO_SUPPORT','OTHER')),
  treatment text not null check (treatment in ('TRANSACTION_PRICE','COST_REDUCTION','EXPENSE_REIMBURSEMENT','PASS_THROUGH')),
  paid_direct boolean not null default false,
  start_date date, end_date date, claim_deadline_days int check (claim_deadline_days is null or claim_deadline_days >= 0),
  rules jsonb not null default '{}',
  source_document_id uuid,
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','EXPIRED')),
  approved_by text, approved_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date),
  check (status <> 'ACTIVE' or approved_by is not null)
);

create table if not exists public.oem_incentive_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  program_id uuid not null references public.oem_programs(id),
  unit_id uuid references public.dealer_units(id),
  sale_id uuid references public.dealer_unit_sales(id),
  claim_reference text,
  earned_date date not null, claim_deadline date, submitted_date date,
  treatment text not null check (treatment in ('TRANSACTION_PRICE','COST_REDUCTION','EXPENSE_REIMBURSEMENT','PASS_THROUGH')),
  accrual_target_role text,
  accrued_cents bigint not null check (accrued_cents >= 0),
  claimed_cents bigint not null default 0 check (claimed_cents >= 0),
  settled_cents bigint not null default 0 check (settled_cents >= 0),
  written_off_cents bigint not null default 0 check (written_off_cents >= 0),
  status text not null default 'ACCRUED' check (status in ('ACCRUED','SUBMITTED','PARTIAL','PAID','REJECTED','WRITTEN_OFF','VOID')),
  gl_entry_id uuid references public.gl_entries(id),
  idempotency_key text not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (settled_cents + written_off_cents <= greatest(claimed_cents, accrued_cents)),
  unique (org_id, idempotency_key)
);

create table if not exists public.oem_statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  oem_vendor_id uuid not null references core.vendors(id),
  statement_date date not null,
  document_id uuid,
  import_batch_id uuid references public.dealer_import_batches(id),
  footer_total_cents bigint,
  status text not null default 'IMPORTED' check (status in ('IMPORTED','MATCHING','SETTLED')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_oem_statement_once on public.oem_statements (org_id, location_id, oem_vendor_id, statement_date);

create table if not exists public.oem_statement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  statement_id uuid not null references public.oem_statements(id) on delete cascade,
  line_number int,
  line_type text not null check (line_type in ('WARRANTY_CREDIT','INCENTIVE_CREDIT','DEBIT','PARTS_INVOICE','OTHER')),
  reference text, serial_number text, description text,
  amount_cents bigint not null,
  matched_warranty_claim_id uuid references public.warranty_claims(id),
  matched_incentive_claim_id uuid references public.oem_incentive_claims(id),
  match_status text not null default 'UNMATCHED' check (match_status in ('UNMATCHED','PROPOSED','MATCHED','SETTLED','IGNORED')),
  match_confidence_bps int check (match_confidence_bps is null or match_confidence_bps between 0 and 10000),
  ai_decision_id uuid,
  settlement_gl_entry_id uuid references public.gl_entries(id),
  created_at timestamptz not null default now(),
  check (num_nonnulls(matched_warranty_claim_id, matched_incentive_claim_id) <= 1)
);
create index if not exists ix_osl_statement on public.oem_statement_lines (statement_id);
-- A statement line settles at most one claim, and a claim is settled by a line once.
create unique index if not exists ux_osl_settles_warranty on public.oem_statement_lines (matched_warranty_claim_id, statement_id)
  where matched_warranty_claim_id is not null and match_status = 'SETTLED';

-- Every money event on a warranty or incentive claim (audit + idempotency).
create table if not exists public.dealer_claim_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  claim_kind text not null check (claim_kind in ('WARRANTY','INCENTIVE')),
  warranty_claim_id uuid references public.warranty_claims(id),
  incentive_claim_id uuid references public.oem_incentive_claims(id),
  event_type text not null check (event_type in ('RECOGNIZED','ACCRUED','SUBMITTED','RESUBMITTED','CREDIT_APPLIED',
    'CASH_RECEIVED','SHORT_PAY_ACCEPTED','REJECTED','WRITTEN_OFF','DEBITED')),
  event_date date not null,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  oem_statement_line_id uuid references public.oem_statement_lines(id),
  gl_entry_id uuid references public.gl_entries(id),
  actor text,
  note text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  check ((claim_kind = 'WARRANTY' and warranty_claim_id is not null and incentive_claim_id is null)
      or (claim_kind = 'INCENTIVE' and incentive_claim_id is not null and warranty_claim_id is null)),
  unique (org_id, idempotency_key)
);

-- ── 10. Triggers: unit cost maintained from POSTED cost rows; posted rows immutable ─
create or replace function public.dealer_unit_cost_recompute() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare v_unit uuid := coalesce(new.unit_id, old.unit_id);
begin
  update public.dealer_units u
     set cost_cents = coalesce((select sum(c.amount_cents) from public.dealer_unit_costs c
                                 where c.unit_id = v_unit and c.status = 'POSTED'), 0),
         updated_at = now()
   where u.id = v_unit;
  return null;
end
$$;
drop trigger if exists trg_dealer_unit_cost_recompute on public.dealer_unit_costs;
create trigger trg_dealer_unit_cost_recompute
  after insert or update or delete on public.dealer_unit_costs
  for each row execute function public.dealer_unit_cost_recompute();

-- POSTED floor-plan transactions and unit cost rows are immutable: correct by a
-- REVERSAL / offsetting row, never by editing or deleting (mig 153 posture).

create or replace function public.dealer_guard_posted_fpt() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if tg_op = 'DELETE' then
    if old.status = 'POSTED' then
      raise exception 'Posted floor-plan transactions are immutable — post a REVERSAL instead';
    end if;
    return old;
  end if;
  if old.status = 'POSTED' and (
       new.status is distinct from old.status
    or new.principal_cents is distinct from old.principal_cents
    or new.interest_cents is distinct from old.interest_cents
    or new.accrual_cleared_cents is distinct from old.accrual_cleared_cents
    or new.fee_cents is distinct from old.fee_cents
    or new.txn_type is distinct from old.txn_type
    or new.txn_date is distinct from old.txn_date
    or new.note_id is distinct from old.note_id
    or new.gl_entry_id is distinct from old.gl_entry_id) then
    raise exception 'Posted floor-plan transactions are immutable — post a REVERSAL instead';
  end if;
  return new;
end
$$;
drop trigger if exists trg_dealer_guard_posted_fpt on public.floor_plan_transactions;
create trigger trg_dealer_guard_posted_fpt
  before update or delete on public.floor_plan_transactions
  for each row execute function public.dealer_guard_posted_fpt();

create or replace function public.dealer_guard_posted_costs() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if tg_op = 'DELETE' then
    if old.status = 'POSTED' then
      raise exception 'Posted unit cost rows are immutable — add an offsetting cost row instead';
    end if;
    return old;
  end if;
  if old.status = 'POSTED' and (
       new.status is distinct from old.status
    or new.amount_cents is distinct from old.amount_cents
    or new.cost_type is distinct from old.cost_type
    or new.unit_id is distinct from old.unit_id
    or new.gl_entry_id is distinct from old.gl_entry_id) then
    raise exception 'Posted unit cost rows are immutable — add an offsetting cost row instead';
  end if;
  return new;
end
$$;
drop trigger if exists trg_dealer_guard_posted_costs on public.dealer_unit_costs;
create trigger trg_dealer_guard_posted_costs
  before update or delete on public.dealer_unit_costs
  for each row execute function public.dealer_guard_posted_costs();

-- updated_at maintenance (001's set_updated_at)
do $$ declare t text; begin
  foreach t in array array['dealer_pack_settings','dealer_department_map','floor_plan_lines','floor_plan_programs',
    'dealer_import_batches','dealer_units','floor_plan_notes','floor_plan_curtailments','lender_statements',
    'trade_ins','dealer_unit_sales','warranty_claims','oem_programs','oem_incentive_claims','oem_statements'] loop
    execute format('drop trigger if exists trg_%s_updated on public.%I', t, t);
    execute format('create trigger trg_%s_updated before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ── 11. Role resolution + enable gate (single source of truth for app + DB) ─────
-- Resolve a role to the client's account: explicit map (location row wins over the
-- org row) → the role's standard default number (pre-existing roles only; the dealer
-- roles have none) → the FPB §3.0 fallback role → … → null (refuse to guess).
create or replace function public.dealer_role_account(p_org uuid, p_location uuid, p_role text) returns uuid
  language plpgsql stable set search_path = public, core, pg_temp as
$$
declare v uuid; r text := p_role; i int := 0;
begin
  while r is not null and i < 6 loop
    select ar.account_id into v
      from public.account_roles ar
     where ar.org_id = p_org and ar.role_key = r
       and (ar.location_id = p_location or ar.location_id is null)
     order by (ar.location_id is null), ar.created_at
     limit 1;
    if v is not null then return v; end if;

    select a.id into v
      from core.account_role_keys k
      join public.accounts a
        on a.org_id = p_org and a.account_number = k.default_account_number and a.is_active
     where k.role_key = r and k.default_account_number is not null
       and (a.company_location_id = p_location or a.company_location_id is null)
     order by (a.company_location_id is null)
     limit 1;
    if v is not null then return v; end if;

    r := case r
      when 'USED_WHOLE_GOODS_INVENTORY'  then 'WHOLE_GOODS_INVENTORY'
      when 'RENTAL_INVENTORY'            then 'WHOLE_GOODS_INVENTORY'
      when 'FLOOR_PLAN_INTEREST_ACCRUED' then 'ACCRUED_EXPENSES'
      when 'FLOOR_PLAN_INTEREST'         then 'INTEREST_EXPENSE'
      when 'FLOOR_PLAN_FEES'             then 'FLOOR_PLAN_INTEREST'
      when 'USED_GOODS_SALES'            then 'WHOLE_GOODS_SALES'
      when 'USED_GOODS_COGS'             then 'WHOLE_GOODS_COGS'
      when 'INVENTORY_WRITEDOWN'         then 'WHOLE_GOODS_COGS'
      when 'WARRANTY_PARTS_SALES'        then 'WARRANTY_LABOR_SALES'
      else null end;
    i := i + 1;
  end loop;
  return null;
end
$$;

-- Every role the pack uses, resolved for one client in one call (the app posts with
-- this; mapped_directly = an explicit account_roles row for the role itself).
create or replace function public.dealer_role_map(p_org uuid, p_location uuid)
  returns table (role_key text, account_id uuid, mapped_directly boolean)
  language sql stable set search_path = public, core, pg_temp as
$$
  select r.role_key,
         public.dealer_role_account(p_org, p_location, r.role_key),
         exists (select 1 from public.account_roles ar
                  where ar.org_id = p_org and ar.role_key = r.role_key
                    and (ar.location_id = p_location or ar.location_id is null))
    from unnest(array['WHOLE_GOODS_INVENTORY','USED_WHOLE_GOODS_INVENTORY','RENTAL_INVENTORY','FLOOR_PLAN_PAYABLE',
      'FLOOR_PLAN_INTEREST_ACCRUED','FLOOR_PLAN_INTEREST','FLOOR_PLAN_FEES','WHOLE_GOODS_SALES','WHOLE_GOODS_COGS',
      'USED_GOODS_SALES','USED_GOODS_COGS','TRADE_IN_OVER_ALLOWANCE','TRADE_LIEN_PAYOFF','SETUP_LABOR_CAPITALIZED',
      'INVENTORY_WRITEDOWN','WARRANTY_RECEIVABLE','WARRANTY_LABOR_SALES','WARRANTY_PARTS_SALES',
      'WARRANTY_POLICY_EXPENSE','OEM_INCENTIVE_RECEIVABLE','CO_OP_ADVERTISING_RECOVERY',
      'AR_CONTROL','AP_CONTROL','OPERATING_BANK','CUSTOMER_DEPOSITS','INVENTORY_ASSET','INVENTORY_COGS',
      'INTEREST_EXPENSE','ACCRUED_EXPENSES','SALES_TAX_PAYABLE']) as r(role_key)
$$;

-- What still blocks enabling the pack for a client: 'ROLE:<key>' / 'DEPT:<role>'.
create or replace function public.dealer_pack_missing_requirements(p_org uuid, p_location uuid) returns text[]
  language plpgsql stable set search_path = public, core, pg_temp as
$$
declare missing text[] := '{}'; r text;
begin
  foreach r in array array['WHOLE_GOODS_INVENTORY','USED_WHOLE_GOODS_INVENTORY','FLOOR_PLAN_PAYABLE',
    'FLOOR_PLAN_INTEREST_ACCRUED','FLOOR_PLAN_INTEREST','WHOLE_GOODS_SALES','WHOLE_GOODS_COGS',
    'TRADE_IN_OVER_ALLOWANCE','TRADE_LIEN_PAYOFF','WARRANTY_RECEIVABLE','WARRANTY_LABOR_SALES',
    'WARRANTY_POLICY_EXPENSE','OEM_INCENTIVE_RECEIVABLE',
    'AR_CONTROL','AP_CONTROL','OPERATING_BANK','CUSTOMER_DEPOSITS','INVENTORY_ASSET','INVENTORY_COGS',
    'SALES_TAX_PAYABLE'] loop
    if public.dealer_role_account(p_org, p_location, r) is null then
      missing := missing || ('ROLE:' || r);
    end if;
  end loop;
  foreach r in array array['WG_NEW','WG_USED','PARTS','SERVICE','RENTAL','ADMIN'] loop
    if not exists (select 1 from public.dealer_department_map m
                    where m.org_id = p_org and m.location_id = p_location and m.dept_role = r) then
      missing := missing || ('DEPT:' || r);
    end if;
  end loop;
  return missing;
end
$$;

create or replace function public.dealer_pack_enable_gate() returns trigger
  language plpgsql set search_path = public, core, pg_temp as
$$
declare m text[];
begin
  if new.enabled and (tg_op = 'INSERT' or not coalesce(old.enabled, false)) then
    m := public.dealer_pack_missing_requirements(new.org_id, new.location_id);
    if coalesce(array_length(m, 1), 0) > 0 then
      raise exception 'Dealer pack cannot be enabled: unmapped %', array_to_string(m, ', ')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists trg_dealer_pack_enable_gate on public.dealer_pack_settings;
create trigger trg_dealer_pack_enable_gate
  before insert or update on public.dealer_pack_settings
  for each row execute function public.dealer_pack_enable_gate();

-- Same-tenant guards for the cross-row references a service-role write could mix up
-- (department, line, program, unit must belong to the row's org + client).
create or replace function public.dealer_same_tenant_guard() returns trigger
  language plpgsql set search_path = public, core, pg_temp as
$$
begin
  if tg_table_name = 'dealer_department_map' then
    if not exists (select 1 from core.departments d where d.id = new.department_id and d.org_id = new.org_id
                     and (d.location_id is null or d.location_id = new.location_id)) then
      raise exception 'Department % is not in this organization/client', new.department_id;
    end if;
  elsif tg_table_name = 'floor_plan_programs' then
    if not exists (select 1 from public.floor_plan_lines l where l.id = new.line_id
                     and l.org_id = new.org_id and l.location_id = new.location_id) then
      raise exception 'Floor-plan line % is not in this client', new.line_id;
    end if;
  elsif tg_table_name = 'floor_plan_notes' then
    if not exists (select 1 from public.floor_plan_lines l where l.id = new.line_id
                     and l.org_id = new.org_id and l.location_id = new.location_id) then
      raise exception 'Floor-plan line % is not in this client', new.line_id;
    end if;
    if new.program_id is not null and not exists (select 1 from public.floor_plan_programs p
         where p.id = new.program_id and p.line_id = new.line_id) then
      raise exception 'Program % does not belong to line %', new.program_id, new.line_id;
    end if;
    if new.unit_id is not null and not exists (select 1 from public.dealer_units u
         where u.id = new.unit_id and u.org_id = new.org_id and u.location_id = new.location_id) then
      raise exception 'Unit % is not in this client', new.unit_id;
    end if;
  end if;
  return new;
end
$$;
do $$ declare t text; begin
  foreach t in array array['dealer_department_map','floor_plan_programs','floor_plan_notes'] loop
    execute format('drop trigger if exists trg_%s_tenant on public.%I', t, t);
    execute format('create trigger trg_%s_tenant before insert or update on public.%I for each row execute function public.dealer_same_tenant_guard()', t, t);
  end loop;
end $$;

-- ── 12. RLS + grants (member read-only; service-role writes) ────────────────────
do $$
declare t text; p record;
begin
  foreach t in array array['dealer_pack_settings','dealer_department_map','floor_plan_lines','floor_plan_programs',
    'dealer_import_batches','dealer_units','dealer_unit_costs','floor_plan_notes','floor_plan_transactions',
    'floor_plan_curtailments','lender_statements','lender_statement_lines','trade_ins','dealer_unit_sales',
    'warranty_claims','oem_programs','oem_incentive_claims','oem_statements','oem_statement_lines',
    'dealer_claim_events'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t
               and policyname in ('org_isolation','service_write','member_read','service_all') loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "member_read" on public.%I for select using (org_id = public.get_org_id())', t);
    execute format('create policy "service_all" on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke select on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- ── 13. Reporting views (security_invoker — RLS of the caller applies; mig 066) ─
create or replace view public.v_floor_plan_position with (security_invoker = on) as
select l.org_id, l.location_id, l.id as line_id, l.name as line_name, l.lender_vendor_id, l.status as line_status,
       l.credit_limit_cents,
       coalesce(n.principal_cents, 0)::bigint as principal_cents,
       coalesce(n.open_count, 0)::bigint as open_note_count,
       coalesce(n.sold_unpaid_count, 0)::bigint as sold_unpaid_count,
       coalesce(n.sold_unpaid_cents, 0)::bigint as sold_unpaid_cents,
       coalesce(t.accrued_interest_cents, 0)::bigint as accrued_interest_cents,
       coalesce(c.curtailments_due_30d_cents, 0)::bigint as curtailments_due_30d_cents,
       case when l.credit_limit_cents > 0
            then (coalesce(n.principal_cents, 0) * 10000 / l.credit_limit_cents)::bigint end as utilization_bps,
       n.next_maturity_date
  from public.floor_plan_lines l
  left join lateral (
    select sum(x.principal_balance_cents) as principal_cents,
           count(*) as open_count,
           count(*) filter (where x.status = 'SOLD_UNPAID') as sold_unpaid_count,
           sum(x.principal_balance_cents) filter (where x.status = 'SOLD_UNPAID') as sold_unpaid_cents,
           min(x.maturity_date) as next_maturity_date
      from public.floor_plan_notes x
     where x.line_id = l.id and x.status in ('OPEN','SOLD_UNPAID','IN_DEFAULT')
  ) n on true
  left join lateral (
    select sum(y.interest_cents) filter (where y.txn_type = 'INTEREST_ACCRUAL')
         - coalesce(sum(y.accrual_cleared_cents) filter (where y.txn_type in ('INTEREST_BILLED','INTEREST_PAID')), 0)
           as accrued_interest_cents
      from public.floor_plan_transactions y
     where y.line_id = l.id and y.status = 'POSTED'
  ) t on true
  left join lateral (
    select sum(z.amount_cents) as curtailments_due_30d_cents
      from public.floor_plan_curtailments z
      join public.floor_plan_notes zn on zn.id = z.note_id
     where zn.line_id = l.id and z.status = 'DUE' and z.due_date <= current_date + 30
  ) c on true;

create or replace view public.v_unit_aging with (security_invoker = on) as
select u.org_id, u.location_id, u.id as unit_id, u.serial_number, u.stock_number, u.make_vendor_id, u.model,
       u.model_year, u.condition, u.status, u.inventory_role, u.is_consignment, u.cost_cents, u.received_date,
       (current_date - u.received_date) as days_in_stock,
       n.id as note_id, n.line_id, n.principal_balance_cents, n.maturity_date,
       (n.maturity_date - current_date) as days_to_maturity,
       (n.id is not null) as is_floored
  from public.dealer_units u
  left join public.floor_plan_notes n
    on n.unit_id = u.id and n.status in ('OPEN','SOLD_UNPAID','IN_DEFAULT')
 where u.status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','RENTAL');

create or replace view public.v_warranty_aging with (security_invoker = on) as
select w.org_id, w.location_id, w.id as claim_id, w.oem_vendor_id, w.oem_claim_number, w.dealer_claim_ref,
       w.status, w.claimed_cents, w.settled_cents, w.written_off_cents,
       (w.claimed_cents - w.settled_cents - w.written_off_cents) as open_cents,
       w.submitted_date, w.filing_deadline,
       (current_date - w.submitted_date) as days_outstanding
  from public.warranty_claims w
 where w.status in ('DRAFT','SUBMITTED','PARTIAL','RESUBMITTED','REJECTED');

create or replace view public.v_incentive_aging with (security_invoker = on) as
select c.org_id, c.location_id, c.id as claim_id, c.program_id, p.oem_vendor_id, p.program_type, c.treatment,
       c.status, c.accrued_cents, c.claimed_cents, c.settled_cents, c.written_off_cents,
       (greatest(c.claimed_cents, c.accrued_cents) - c.settled_cents - c.written_off_cents) as open_cents,
       c.earned_date, c.submitted_date, c.claim_deadline,
       (current_date - coalesce(c.submitted_date, c.earned_date)) as days_outstanding
  from public.oem_incentive_claims c
  join public.oem_programs p on p.id = c.program_id
 where c.status in ('ACCRUED','SUBMITTED','PARTIAL','REJECTED');

-- Subledger vs GL by role account, per client (FPB §4.3 / AC12). The GL figure is
-- the account's POSTED balance at that client in its normal direction.
create or replace view public.v_dealer_subledger_tieout with (security_invoker = on) as
with sub as (
  select n.org_id, n.location_id, 'FLOOR_PLAN_PAYABLE'::text as bucket,
         coalesce(l.liability_account_id, public.dealer_role_account(n.org_id, n.location_id, 'FLOOR_PLAN_PAYABLE')) as account_id,
         sum(n.principal_balance_cents)::bigint as subledger_cents
    from public.floor_plan_notes n join public.floor_plan_lines l on l.id = n.line_id
   where n.status in ('OPEN','SOLD_UNPAID','IN_DEFAULT')
   group by 1, 2, 3, 4
  union all
  select t.org_id, t.location_id, 'FLOOR_PLAN_INTEREST_ACCRUED',
         public.dealer_role_account(t.org_id, t.location_id, 'FLOOR_PLAN_INTEREST_ACCRUED'),
         (coalesce(sum(t.interest_cents) filter (where t.txn_type = 'INTEREST_ACCRUAL'), 0)
          - coalesce(sum(t.accrual_cleared_cents) filter (where t.txn_type in ('INTEREST_BILLED','INTEREST_PAID')), 0))::bigint
    from public.floor_plan_transactions t
   where t.status = 'POSTED'
   group by 1, 2, 3, 4
  union all
  select u.org_id, u.location_id, 'UNIT_INVENTORY',
         public.dealer_role_account(u.org_id, u.location_id, u.inventory_role),
         sum(u.cost_cents)::bigint
    from public.dealer_units u
   where u.status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','RENTAL') and not u.is_consignment
   group by 1, 2, 3, 4
  union all
  select w.org_id, w.location_id, 'WARRANTY_RECEIVABLE',
         public.dealer_role_account(w.org_id, w.location_id, 'WARRANTY_RECEIVABLE'),
         sum(w.claimed_cents - w.settled_cents - w.written_off_cents)::bigint
    from public.warranty_claims w
   where w.recognized_gl_entry_id is not null and w.status <> 'VOID'
   group by 1, 2, 3, 4
  union all
  select c.org_id, c.location_id, 'OEM_INCENTIVE_RECEIVABLE',
         public.dealer_role_account(c.org_id, c.location_id, 'OEM_INCENTIVE_RECEIVABLE'),
         sum(c.accrued_cents - c.settled_cents - c.written_off_cents)::bigint
    from public.oem_incentive_claims c
   where c.gl_entry_id is not null and c.status <> 'VOID'
   group by 1, 2, 3, 4
  union all
  select ti.org_id, ti.location_id, 'TRADE_LIEN_PAYOFF',
         public.dealer_role_account(ti.org_id, ti.location_id, 'TRADE_LIEN_PAYOFF'),
         sum(ti.lien_payoff_cents)::bigint
    from public.trade_ins ti
   where ti.status = 'POSTED' and ti.lien_status in ('OWED','PROPOSED')
   group by 1, 2, 3, 4
), agg as (
  select org_id, location_id, bucket, account_id, sum(subledger_cents)::bigint as subledger_cents
    from sub group by 1, 2, 3, 4
)
select a.org_id, a.location_id, a.bucket, a.account_id, acct.account_number, acct.name as account_name,
       a.subledger_cents,
       coalesce(g.gl_cents, 0)::bigint as gl_cents,
       (a.subledger_cents - coalesce(g.gl_cents, 0))::bigint as difference_cents
  from agg a
  left join public.accounts acct on acct.id = a.account_id
  left join lateral (
    select sum(case when acct.account_type in ('ASSET','COGS','OPEX')
                    then gl.debit_cents - gl.credit_cents
                    else gl.credit_cents - gl.debit_cents end) as gl_cents
      from public.gl_entry_lines gl
      join public.gl_entries e on e.id = gl.gl_entry_id and e.status = 'POSTED'
     where gl.account_id = a.account_id and gl.location_id = a.location_id and gl.org_id = a.org_id
  ) g on true;

do $$ declare v text; begin
  foreach v in array array['v_floor_plan_position','v_unit_aging','v_warranty_aging','v_incentive_aging',
    'v_dealer_subledger_tieout'] loop
    execute format('revoke all on public.%I from anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;

-- Function privileges (M1 lesson: revoke, then grant explicitly).
revoke all on function public.dealer_role_account(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.dealer_role_account(uuid, uuid, text) to authenticated, service_role;
revoke all on function public.dealer_role_map(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dealer_role_map(uuid, uuid) to authenticated, service_role;
revoke all on function public.dealer_pack_missing_requirements(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dealer_pack_missing_requirements(uuid, uuid) to authenticated, service_role;
revoke all on function public.dealer_pack_enable_gate() from public, anon, authenticated;
grant execute on function public.dealer_pack_enable_gate() to service_role;
revoke all on function public.dealer_same_tenant_guard() from public, anon, authenticated;
grant execute on function public.dealer_same_tenant_guard() to service_role;
revoke all on function public.dealer_unit_cost_recompute() from public, anon, authenticated;
grant execute on function public.dealer_unit_cost_recompute() to service_role;
revoke all on function public.dealer_guard_posted_fpt() from public, anon, authenticated;
grant execute on function public.dealer_guard_posted_fpt() to service_role;
revoke all on function public.dealer_guard_posted_costs() from public, anon, authenticated;
grant execute on function public.dealer_guard_posted_costs() to service_role;

comment on table public.dealer_units is
  'Dealer pack (FPB-dealer-pack §4.2): Books-owned FINANCIAL subledger of serialized units (cost build-up, collateral, lender tie-out). Not stock management — the DMS stays the operational master. cost_cents is maintained from POSTED dealer_unit_costs rows by trigger.';
comment on table public.floor_plan_transactions is
  'Dealer pack: every money event on a floor-plan note (or line-level billing/fees). POSTED rows are immutable; payoffs are PROPOSED and released by a different person (CHECK released_by <> proposed_by).';

-- ── 14. Client-scope RLS (mig 163) attaches to every new client-owned table ──────
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
