-- ============================================================================
-- 1109 · Merit Projects v2 — dealership operations (replaces c-Systems for dealer clients)
--
-- Binding inputs: docs/projects/BOOKS-PROJECTS-INTERACTION.md §0, §3, §4 (owner-approved split:
-- Projects = operations master, Books = money master); Books' dealer side (docs/FPB-dealer-pack.md,
-- docs/dealer-pack-api.md, migration 169 — its vocabulary is reused on the wire: cost types,
-- conditions, warranty outcomes); packages/industry-packs/src/packs/equipment_dealer.ts;
-- research 06 part 1 (lifecycles, object model, KPIs).
-- Conventions as 1100–1108: org guard first in every definer function, search_path =
-- pm, core, public, no PUBLIC/anon EXECUTE, composite FKs where a row is job-scoped (deferrable,
-- so pm.remove_sample_data clears them), RLS USING + WITH CHECK, state moves only through
-- definer functions, pm.log_activity, pm.next_doc_number, bigint cents, fractions for percents.
-- NO GL anywhere: every cost / price / gross here is an OPERATIONAL figure; Books owns the
-- ledger basis, AR, tax, inventory value, floor plan and warranty receivable.
--
-- ONE UNIT MASTER = pm.assets (extended, not duplicated). Why: a serial is one physical machine
-- for its whole life — received on floor plan, sold on a deal, serviced on ROs for years, traded
-- back, sold used, moved to the rental fleet. pm.assets already carries the serial identity
-- (unique per make), the customer, the meter and the service history, and ROs / warranty claims
-- already FK it. A second "inventory unit" table would split the serial timeline that dealers
-- buy a DMS for. Dealer state rides on additive columns (unit_status, condition, stock number,
-- operational cost, floor read model); `unit_life` counts inventory lives (each receipt or trade-in)
-- so a unit's cost build-up is scoped to the current life. Customer-equipment status
-- (assets.status) and dealer inventory status (assets.unit_status) are separate columns
-- (ownership matrix rule A: never one shared enum).
--
-- Objects
--   additive on 1100/1103/1104 tables
--     pm.assets            dealer unit columns + floor read model + lock trigger
--     pm.work_order_lines  kind MISC, pay_type POLICY, labor_op, part_id, stock_location_id, issued_move_id
--     pm.warranty_claims   oem_vendor_id, labor_hours, short_paid_cents, books_* outcome, emit_revision
--     pm.material_moves    parts_ticket_id / parts_order_id / parts_count_id / special_order_id;
--                          ISSUE may carry a counter ticket instead of a job
--     pm.document_links    unit / deal / trade / rental / part photos (job_id optional for those)
--     pm.event_cursor      consumer DEALER_INBOUND
--   tables   dealer_settings, dealer_outbox, dealer_inbound_events, dealer_floor_status,
--            dealer_sot_alerts, dealer_warranty_payments, dealer_unit_costs,
--            dealer_deals, dealer_deal_lines, dealer_quotes, dealer_trades, dealer_fi_products,
--            dealer_deposits, parts, parts_tickets, parts_ticket_lines, parts_special_orders,
--            parts_orders, parts_order_lines, parts_counts, parts_count_lines,
--            rental_rates, rental_contracts, rental_billings
--   member functions
--     settings  set_dealer_settings
--     units     receive_unit, order_unit, add_unit_cost, set_dealer_unit_status, transfer_unit,
--               open_unit_pdi, register_unit_warranty
--     deals     create_deal, issue_dealer_quote, accept_dealer_quote, decline_dealer_quote,
--               write_deal, approve_deal, reopen_deal, mark_deal_funded, check_deal_delivery_item,
--               deliver_deal, unwind_deal, cancel_deal, request_deal_deposit, dealer_deal_totals
--     parts     upsert_part, supersede_part, resolve_part, set_part_stocking, open_parts_ticket,
--               close_parts_ticket, void_parts_ticket, request_special_order, advance_special_order,
--               create_parts_order, submit_parts_order, receive_parts_order, suggest_parts_order,
--               start_parts_count, post_parts_count
--     service   create_warranty_claim_from_ro (RO close is hooked by trigger on pm.work_orders)
--     rentals   reserve_rental, check_out_rental, check_in_rental, bill_rental, cancel_rental, rental_charge
--     seam      resend_dealer_event
--   service_role only: release_dealer_outbox(org), apply_dealer_inbound(org), apply_warranty_payment(event),
--                      run_seam_cycle(org) (create or replace; keeps 1103's keys)
--   views    v_dealer_unit_inventory, v_dealer_deals_pipeline, v_parts_on_hand, v_warranty_outstanding,
--            v_rental_utilization, v_dealer_outbox_queue, v_kpis_dealer; v_kpis and v_seam_health
--            re-created with every prior metric / column
--
-- Seam. Every outbound dealer event goes through pm.dealer_emit into pm.dealer_outbox:
--   SUPPRESSED (SAMPLE | STANDALONE)  record is a sample, or Books is not entitled
--   HELD        Books entitled but entitlements.books_dealer_seam is not true (Books has not shipped
--               its consumers): the workflow runs, the event waits here, v_seam_health stays quiet
--   RELEASED    in core.events (status pending); emitted directly once the flag is on, or by
--               pm.release_dealer_outbox(org) (service_role, run by pm.run_seam_cycle) in seq order
--   PROCESSED | REJECTED  Books' ack in place on core.events (status, gl_entry_id, invoice_id, error)
-- Payload base (every event): event_id, event_type, source_module 'PROJECTS', schema_version 1,
-- org_id, location_id, occurred_on, source_ref (business key, unique per org; Books dedupes on it).
-- Outbound: DEALER_UNIT_RECEIVED, DEALER_UNIT_COST, DEALER_UNIT_STATUS, DEALER_DEAL_FINALIZED,
--   DEALER_DEAL_UNWOUND, DEALER_TRADE_RECEIVED, DEALER_PARTS_SALE, DEALER_RO_CLOSED,
--   DEALER_WARRANTY_CLAIM, DEALER_WARRANTY_REGISTRATION, DEALER_RENTAL_BILLED, and
--   DEALER_DEPOSIT_REQUEST (new: deal deposits through Books' customer-deposits feature, the
--   JOB_DEPOSIT_REQUEST pattern without a job — to be agreed in the dealer blueprint).
-- Inbound (Books -> Projects; Projects is the sole consumer and writes their status, the JOB_COST
--   convention): DEALER_FLOOR_STATUS, DEALER_SOT_ALERT, DEALER_WARRANTY_PAID; schema_version must be 1.
--
-- Idempotent: safe to run twice. Never alters pgrst.db_schemas. Never writes core.jobs money
-- columns. Writes core.items IDENTITY only (id, org_id, sku, name, item_type) for a new part —
-- ownership matrix: "core.items — Create: Books or Projects"; no cost, price or GL mapping.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Additive changes to 1100 / 1103 / 1104 tables
-- ----------------------------------------------------------------------------

-- 0.1 pm.assets: the dealer unit master
alter table pm.assets add column if not exists stock_number          text;
alter table pm.assets add column if not exists vin                   text;          -- VIN / PIN (serial_number is the serial)
alter table pm.assets add column if not exists category              text;          -- e.g. COMPACT_TRACTOR, ZTR, HANDHELD, UTV
alter table pm.assets add column if not exists condition             text;          -- NEW | USED | DEMO | RENTAL (dealer units only)
alter table pm.assets add column if not exists unit_status           text;          -- dealer inventory status (null = not a dealer unit)
alter table pm.assets add column if not exists unit_hold_prior_status text;         -- status before a deal held the unit
alter table pm.assets add column if not exists unit_status_rev       int not null default 0;
alter table pm.assets add column if not exists unit_life             int not null default 0;   -- inventory lives (receipts / trade-ins)
alter table pm.assets add column if not exists stock_location_id     uuid;
alter table pm.assets add column if not exists received_on           date;
alter table pm.assets add column if not exists mfr_invoice_ref       text;
alter table pm.assets add column if not exists mfr_vendor_id         uuid references core.vendors(id);
alter table pm.assets add column if not exists dealer_cost_cents     bigint not null default 0;  -- OPERATIONAL (Σ current-life cost rows)
alter table pm.assets add column if not exists books_cost_cents      bigint;        -- Books' GL basis when Books reports it
alter table pm.assets add column if not exists books_cost_as_of      timestamptz;
alter table pm.assets add column if not exists retail_price_cents    bigint;
alter table pm.assets add column if not exists advertised_price_cents bigint;
alter table pm.assets add column if not exists attachments           jsonb not null default '[]';
alter table pm.assets add column if not exists unit_sold_on          date;
alter table pm.assets add column if not exists unit_delivered_on     date;
alter table pm.assets add column if not exists registration_count    int not null default 0;
alter table pm.assets add column if not exists deal_id               uuid;          -- deal holding / that sold the unit
alter table pm.assets add column if not exists is_sample             boolean not null default false;
-- floor read model (fed by pm.dealer_floor_status from DEALER_FLOOR_STATUS; never member-written)
alter table pm.assets add column if not exists floored               boolean not null default false;
alter table pm.assets add column if not exists floor_status          text;
alter table pm.assets add column if not exists floor_lender_vendor_id uuid;
alter table pm.assets add column if not exists floor_note_ref        text;
alter table pm.assets add column if not exists payoff_due_on         date;
alter table pm.assets add column if not exists payoff_cents          bigint;
alter table pm.assets add column if not exists payoff_scheduled      boolean not null default false;
alter table pm.assets add column if not exists floor_status_at       timestamptz;
alter table pm.assets add column if not exists sot_alert_at          timestamptz;
alter table pm.assets add column if not exists sot_alert             jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assets_dealer_condition_check' and conrelid = 'pm.assets'::regclass) then
    alter table pm.assets add constraint assets_dealer_condition_check
      check (condition is null or condition in ('NEW','USED','DEMO','RENTAL'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assets_unit_status_check' and conrelid = 'pm.assets'::regclass) then
    alter table pm.assets add constraint assets_unit_status_check
      check (unit_status is null or unit_status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','RENTAL','ON_HOLD',
                                                    'SOLD','DELIVERED','RETURNED_TO_MFR','TRANSFERRED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assets_dealer_state_check' and conrelid = 'pm.assets'::regclass) then
    alter table pm.assets add constraint assets_dealer_state_check
      check ((unit_status is null or condition is not null)
         and dealer_cost_cents >= 0 and (books_cost_cents is null or books_cost_cents >= 0)
         and (retail_price_cents is null or retail_price_cents >= 0)
         and (advertised_price_cents is null or advertised_price_cents >= 0)
         and (payoff_cents is null or payoff_cents >= 0)
         and jsonb_typeof(attachments) = 'array'
         and (floor_status is null or floor_status in ('FLOORED','SOLD_UNPAID','PAID_OFF','NOT_FLOORED','IN_DEFAULT','RETURNED')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assets_stock_location_fk' and conrelid = 'pm.assets'::regclass) then
    alter table pm.assets add constraint assets_stock_location_fk
      foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate;
  end if;
end $$;
create unique index if not exists pm_assets_stock_number_uidx on pm.assets (org_id, upper(stock_number)) where stock_number is not null;
create index if not exists pm_assets_unit_status_idx on pm.assets (org_id, location_id, unit_status) where unit_status is not null;

-- Dealer state on a unit moves only through the definer functions below. Members keep every
-- 1104 asset path (customer equipment, ext fields, meter) and may edit the descriptive dealer
-- columns (stock #, VIN, category, prices, attachments, make vendor).
create or replace function pm.tg_asset_dealer_lock() returns trigger
language plpgsql   -- invoker: current_user must be the caller
set search_path = pm, core, public
as $$
begin
  if current_user not in ('authenticated','anon') then return new; end if;
  if tg_op = 'INSERT' then
    if new.unit_status is not null or new.condition is not null or new.stock_location_id is not null or new.received_on is not null
       or new.mfr_invoice_ref is not null or new.dealer_cost_cents <> 0 or new.books_cost_cents is not null or new.floored
       or new.floor_status is not null or new.payoff_cents is not null or new.payoff_due_on is not null or new.payoff_scheduled
       or new.sot_alert_at is not null or new.deal_id is not null or new.unit_sold_on is not null or new.unit_delivered_on is not null
       or new.is_sample or new.unit_life <> 0 or new.unit_status_rev <> 0 or new.registration_count <> 0
       or new.floor_lender_vendor_id is not null or new.floor_note_ref is not null then
      raise exception 'PM_UNIT_FIELDS_LOCKED: dealer unit state is set by pm.receive_unit and the dealer functions' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.unit_status, new.condition, new.stock_location_id, new.received_on, new.mfr_invoice_ref, new.dealer_cost_cents,
      new.books_cost_cents, new.books_cost_as_of, new.floored, new.floor_status, new.floor_lender_vendor_id, new.floor_note_ref,
      new.payoff_cents, new.payoff_due_on, new.payoff_scheduled, new.floor_status_at, new.sot_alert_at, new.sot_alert,
      new.deal_id, new.unit_sold_on, new.unit_delivered_on, new.is_sample, new.unit_life, new.unit_status_rev,
      new.unit_hold_prior_status, new.registration_count)
     is distinct from
     (old.unit_status, old.condition, old.stock_location_id, old.received_on, old.mfr_invoice_ref, old.dealer_cost_cents,
      old.books_cost_cents, old.books_cost_as_of, old.floored, old.floor_status, old.floor_lender_vendor_id, old.floor_note_ref,
      old.payoff_cents, old.payoff_due_on, old.payoff_scheduled, old.floor_status_at, old.sot_alert_at, old.sot_alert,
      old.deal_id, old.unit_sold_on, old.unit_delivered_on, old.is_sample, old.unit_life, old.unit_status_rev,
      old.unit_hold_prior_status, old.registration_count)
     or (old.unit_status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','RENTAL','ON_HOLD','SOLD')
         and (new.kind is distinct from old.kind or new.customer_id is distinct from old.customer_id)) then
    raise exception 'PM_UNIT_FIELDS_LOCKED: dealer unit state changes only through the dealer functions' using errcode = '42501';
  end if;
  return new;
end $$;

-- 0.2 pm.work_order_lines: RO lines by type and pay type
alter table pm.work_order_lines add column if not exists labor_op          text;
alter table pm.work_order_lines add column if not exists part_id           uuid;
alter table pm.work_order_lines add column if not exists stock_location_id uuid;
alter table pm.work_order_lines add column if not exists issued_move_id    uuid;
do $$
begin
  alter table pm.work_order_lines drop constraint if exists work_order_lines_kind_check;
  alter table pm.work_order_lines add constraint work_order_lines_kind_check
    check (kind in ('SERVICE','PART','LABOR','EQUIPMENT','FEE','DISCOUNT','SUBLET','FREIGHT','MISC'));
  alter table pm.work_order_lines drop constraint if exists work_order_lines_pay_type_check;
  alter table pm.work_order_lines add constraint work_order_lines_pay_type_check
    check (pay_type in ('CUSTOMER','WARRANTY','INTERNAL','POLICY'));
  if not exists (select 1 from pg_constraint where conname = 'wo_lines_stock_location_fk' and conrelid = 'pm.work_order_lines'::regclass) then
    alter table pm.work_order_lines add constraint wo_lines_stock_location_fk
      foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate;
  end if;
end $$;

-- 0.3 pm.warranty_claims: OEM vendor (Books books OEM credits against the vendor), outcome from Books
alter table pm.warranty_claims add column if not exists oem_vendor_id     uuid references core.vendors(id);
alter table pm.warranty_claims add column if not exists labor_hours       numeric(8,2);
alter table pm.warranty_claims add column if not exists short_paid_cents  bigint not null default 0;
alter table pm.warranty_claims add column if not exists books_outcome     text;
alter table pm.warranty_claims add column if not exists books_credit_ref  text;
alter table pm.warranty_claims add column if not exists books_paid_on     date;
alter table pm.warranty_claims add column if not exists emit_revision     int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'warranty_claims_dealer_check' and conrelid = 'pm.warranty_claims'::regclass) then
    alter table pm.warranty_claims add constraint warranty_claims_dealer_check
      check (short_paid_cents >= 0 and (labor_hours is null or labor_hours >= 0)
             and (books_outcome is null or books_outcome in ('CREDITED','SHORT_PAID','REJECTED')));
  end if;
end $$;

-- 0.4 pm.material_moves: counter / order / count provenance; a counter ticket may stand in for the job on ISSUE
alter table pm.material_moves add column if not exists parts_ticket_id  uuid;
alter table pm.material_moves add column if not exists parts_order_id   uuid;
alter table pm.material_moves add column if not exists parts_count_id   uuid;
alter table pm.material_moves add column if not exists special_order_id uuid;
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'pm.material_moves'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%CASE%' and conname <> 'material_moves_flow_check' loop
    execute format('alter table pm.material_moves drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'material_moves_flow_check' and conrelid = 'pm.material_moves'::regclass) then
    alter table pm.material_moves add constraint material_moves_flow_check check (case kind
      when 'RECEIPT'  then from_stock_location_id is null and to_stock_location_id is not null
      when 'ISSUE'    then from_stock_location_id is not null and to_stock_location_id is null
                           and (job_id is not null or parts_ticket_id is not null)
      when 'RETURN'   then from_stock_location_id is null and to_stock_location_id is not null
                           and (job_id is not null or parts_ticket_id is not null)
      when 'TRANSFER' then from_stock_location_id is not null and to_stock_location_id is not null
      when 'SCRAP'    then to_stock_location_id is null and (from_stock_location_id is not null or job_id is not null)
      when 'REMNANT'  then to_stock_location_id is not null and (from_stock_location_id is not null or job_id is not null)
      when 'ADJUST'   then (from_stock_location_id is null) <> (to_stock_location_id is null)
    end);
  end if;
end $$;
create index if not exists pm_material_moves_ticket_idx on pm.material_moves (org_id, parts_ticket_id) where parts_ticket_id is not null;

-- 0.5 pm.document_links: photos of units, deals, trades, rentals, parts (not job-scoped)
alter table pm.document_links alter column job_id drop not null;
do $$
begin
  alter table pm.document_links drop constraint if exists document_links_subject_table_check;
  alter table pm.document_links add constraint document_links_subject_table_check check (subject_table in
    ('projects','tasks','wbs_nodes','change_orders','contracts','budgets','field_logs','punch_items','time_entries',
     'assets','dealer_deals','dealer_trades','rental_contracts','parts','parts_tickets'));
  if not exists (select 1 from pg_constraint where conname = 'document_links_job_scope_check' and conrelid = 'pm.document_links'::regclass) then
    alter table pm.document_links add constraint document_links_job_scope_check
      check (job_id is not null or subject_table in ('assets','dealer_deals','dealer_trades','rental_contracts','parts','parts_tickets'));
  end if;
end $$;

-- 0.6 pm.event_cursor: the dealer inbound consumer
do $$
begin
  alter table pm.event_cursor drop constraint if exists event_cursor_consumer_check;
  alter table pm.event_cursor add constraint event_cursor_consumer_check check (consumer in ('JOB_COST','DEALER_INBOUND'));
end $$;

-- ----------------------------------------------------------------------------
-- 1. Settings, outbox, inbound read models
-- ----------------------------------------------------------------------------
create table if not exists pm.dealer_settings (
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  margin_floor_pct         numeric(5,4) not null default 0.08 check (margin_floor_pct >= 0 and margin_floor_pct <= 1),
  min_front_gross_cents    bigint not null default 0 check (min_front_gross_cents >= 0),
  desk_roles               text[] not null default array['pm']::text[],          -- manager desk approval
  floor_override_roles     text[] not null default array['ops_manager']::text[], -- below the margin floor
  payoff_guard             text not null default 'WARN' check (payoff_guard in ('OFF','WARN','BLOCK')),
  payoff_ack_roles         text[] not null default array['pm']::text[],          -- acknowledge a payoff-due warning
  unwind_roles             text[] not null default array['ops_manager']::text[],
  trade_reduces_taxable    boolean not null default true,                          -- estimate only; Books computes tax
  default_tax_rate         numeric(7,6) check (default_tax_rate is null or (default_tax_rate >= 0 and default_tax_rate <= 0.25)),
  unit_stock_location_id   uuid,
  parts_stock_location_id  uuid,
  allow_negative_parts     boolean not null default false,
  delivery_checklist       jsonb not null default '[
     {"key":"pdi_complete","label":"PDI and setup complete","required":true},
     {"key":"walkaround","label":"Operator walk-around and safety review","required":true},
     {"key":"operator_manual","label":"Operator''s manual, keys and accessories handed over","required":true},
     {"key":"buyers_order_signed","label":"Buyer''s order signed","required":true},
     {"key":"warranty_registration","label":"Warranty registration submitted","required":false}]'::jsonb
                           check (jsonb_typeof(delivery_checklist) = 'array'),
  updated_by               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (org_id, location_id),
  foreign key (org_id, unit_stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, parts_stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate
);

create table if not exists pm.dealer_outbox (
  id                 uuid primary key default gen_random_uuid(),
  seq                bigint generated always as identity,
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  event_id           uuid not null,
  event_type         text not null check (event_type in ('DEALER_UNIT_RECEIVED','DEALER_UNIT_COST','DEALER_UNIT_STATUS',
                       'DEALER_DEAL_FINALIZED','DEALER_DEAL_UNWOUND','DEALER_TRADE_RECEIVED','DEALER_PARTS_SALE',
                       'DEALER_RO_CLOSED','DEALER_WARRANTY_CLAIM','DEALER_WARRANTY_REGISTRATION','DEALER_RENTAL_BILLED',
                       'DEALER_DEPOSIT_REQUEST')),
  source_ref         text not null,
  schema_version     int not null default 1,
  occurred_on        date not null,
  payload            jsonb not null check (jsonb_typeof(payload) = 'object'),
  status             text not null default 'HELD' check (status in ('HELD','RELEASED','PROCESSED','REJECTED','SUPPRESSED')),
  suppressed_reason  text check (suppressed_reason is null or suppressed_reason in ('STANDALONE','SAMPLE')),
  subject_table      text,
  subject_id         uuid,
  job_id             uuid,
  released_at        timestamptz,
  acked_at           timestamptz,
  resent_count       int not null default 0,
  gl_entry_id        uuid,
  invoice_id         uuid,
  invoice_number     text,
  error_text         text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, event_id),
  unique (org_id, id),
  check ((status = 'SUPPRESSED') = (suppressed_reason is not null)),
  check (status in ('HELD','SUPPRESSED') or released_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_dealer_outbox_status_idx on pm.dealer_outbox (org_id, status, seq);
create index if not exists pm_dealer_outbox_subject_idx on pm.dealer_outbox (org_id, subject_table, subject_id);

-- Inbound dedupe ledger (an event applies at most once; REJECTED kept for audit)
create table if not exists pm.dealer_inbound_events (
  org_id       uuid not null references core.organizations(id) on delete cascade,
  event_id     uuid not null,
  event_type   text not null,
  outcome      text not null check (outcome in ('APPLIED','STALE','REJECTED')),
  error        text,
  applied_at   timestamptz not null default now(),
  primary key (org_id, event_id)
);

-- Latest Books floor-plan status per unit (the ack table behind the assets read model)
create table if not exists pm.dealer_floor_status (
  org_id              uuid not null references core.organizations(id) on delete cascade,
  asset_id            uuid not null,
  location_id         uuid references core.locations(id),
  floored             boolean not null,
  floor_status        text not null check (floor_status in ('FLOORED','SOLD_UNPAID','PAID_OFF','NOT_FLOORED','IN_DEFAULT','RETURNED')),
  lender_vendor_id    uuid,
  note_ref            text,
  principal_cents     bigint,
  payoff_cents        bigint,
  payoff_due_on       date,
  payoff_scheduled    boolean not null default false,
  curtailment_due_on  date,
  curtailment_cents   bigint,
  books_cost_cents    bigint,
  as_of               timestamptz not null,
  event_id            uuid not null,
  event_created_at    timestamptz not null,
  updated_at          timestamptz not null default now(),
  primary key (org_id, asset_id),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dealer_sot_alerts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid references core.locations(id),
  asset_id           uuid not null,
  deal_id            uuid,
  sold_on            date,
  payoff_due_on      date,
  days_out_of_trust  int,
  amount_cents       bigint,
  lender_vendor_id   uuid,
  message            text,
  event_id           uuid not null,
  raised_at          timestamptz not null default now(),
  cleared_at         timestamptz,
  unique (org_id, event_id),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dealer_warranty_payments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  claim_id       uuid not null,
  outcome        text not null check (outcome in ('CREDITED','SHORT_PAID','REJECTED')),
  credited_cents bigint not null default 0 check (credited_cents >= 0),
  short_cents    bigint not null default 0 check (short_cents >= 0),
  reason         text,
  credit_ref     text,
  paid_on        date,
  event_id       uuid not null,
  created_at     timestamptz not null default now(),
  unique (org_id, event_id),
  foreign key (org_id, claim_id) references pm.warranty_claims (org_id, id) on delete cascade deferrable initially immediate
);

-- Operational unit cost build-up (Books owns the basis; the same cost types as public.dealer_unit_costs)
create table if not exists pm.dealer_unit_costs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  asset_id           uuid not null,
  unit_life          int not null,
  cost_type          text not null check (cost_type in ('BASE_INVOICE','FREIGHT','SETUP_PDI','ACCESSORY','RECON','OTHER')),
  amount_cents       bigint not null check (amount_cents > 0),
  labor_cents        bigint not null default 0 check (labor_cents >= 0),
  parts_cents        bigint not null default 0 check (parts_cents >= 0),
  labor_hours        numeric(8,2) check (labor_hours is null or labor_hours >= 0),
  source             text not null check (source in ('RECEIPT','MANUAL','INTERNAL_RO','TRADE_IN')),
  job_id             uuid,
  work_order_id      uuid,
  vendor_id          uuid references core.vendors(id),
  vendor_invoice_ref text,
  memo               text,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE','VOID')),
  outbox_id          uuid,
  source_ref         text not null,
  created_by         text,
  created_at         timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, id),
  check (labor_cents + parts_cents <= amount_cents),
  check (work_order_id is null or job_id is not null),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate
);
create index if not exists pm_dealer_unit_costs_asset_idx on pm.dealer_unit_costs (org_id, asset_id, unit_life);

-- ----------------------------------------------------------------------------
-- 2. Sales desk
-- ----------------------------------------------------------------------------
create table if not exists pm.dealer_deals (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  number                 text not null,
  customer_id            uuid references core.customers(id),
  salesperson_user_id    text,
  stage                  text not null default 'QUOTE'
                           check (stage in ('QUOTE','WRITTEN','APPROVED','FUNDED','DELIVERED','UNWOUND','LOST')),
  stage_entered_at       timestamptz not null default now(),
  tax_rate_estimate      numeric(7,6) check (tax_rate_estimate is null or (tax_rate_estimate >= 0 and tax_rate_estimate <= 0.25)),
  tax_exempt             boolean not null default false,
  tax_exempt_ref         text,                                   -- ag / resale certificate (Books validates)
  finance_type           text not null default 'CASH' check (finance_type in ('CASH','RETAIL_FINANCE','LEASE','OPEN_ACCOUNT')),
  finance_vendor_id      uuid references core.vendors(id),       -- retail finance company (Books' AR party)
  amount_financed_cents  bigint check (amount_financed_cents is null or amount_financed_cents >= 0),
  finance_reserve_cents  bigint not null default 0 check (finance_reserve_cents >= 0),   -- dealer participation
  subvention_cents       bigint not null default 0 check (subvention_cents >= 0),        -- promo-rate buy-down fee
  finance_ref            text,
  delivery_checklist     jsonb not null default '[]' check (jsonb_typeof(delivery_checklist) = 'array'),
  approved_by            text,
  approved_at            timestamptz,
  approval               jsonb,
  approved_totals        jsonb,
  funded_at              timestamptz,
  funded_by              text,
  delivered_on           date,
  delivered_at           timestamptz,
  delivered_by           text,
  final_totals           jsonb,
  payoff_ack             jsonb,
  finalized_outbox_id    uuid,
  unwound_at             timestamptz,
  unwound_by             text,
  unwind_reason          text,
  lost_at                timestamptz,
  lost_reason            text,
  sot_alert_at           timestamptz,
  sot_alert              jsonb,
  is_sample              boolean not null default false,
  notes                  text,
  created_by             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check (stage in ('QUOTE','WRITTEN','LOST') or approved_at is not null),
  check (stage not in ('DELIVERED','UNWOUND') or delivered_at is not null),
  check (stage <> 'UNWOUND' or unwound_at is not null),
  check (stage <> 'LOST' or lost_at is not null)
);
create index if not exists pm_dealer_deals_stage_idx on pm.dealer_deals (org_id, location_id, stage);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assets_deal_fk' and conrelid = 'pm.assets'::regclass) then
    alter table pm.assets add constraint assets_deal_fk
      foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) deferrable initially immediate;
  end if;
end $$;

create table if not exists pm.parts (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  item_id                uuid not null,                               -- core.items identity (Books values it)
  part_number            text not null check (char_length(btrim(part_number)) between 1 and 40),
  manufacturer           text,                                        -- OEM line code, e.g. KUBOTA, EXMARK
  mfr_vendor_id          uuid references core.vendors(id),
  description            text not null check (char_length(description) between 1 and 200),
  uom                    text not null default 'EA',
  category               text,
  cost_cents             bigint check (cost_cents is null or cost_cents >= 0),          -- operational (last receipt)
  list_price_cents       bigint check (list_price_cents is null or list_price_cents >= 0),
  price_cents            bigint check (price_cents is null or price_cents >= 0),        -- counter sell price
  core_charge_cents      bigint not null default 0 check (core_charge_cents >= 0),
  superseded_by_part_id  uuid,
  status                 text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED','OBSOLETE')),
  is_active              boolean not null default true,
  created_by             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  check (superseded_by_part_id is null or superseded_by_part_id <> id),
  check ((status = 'SUPERSEDED') = (superseded_by_part_id is not null)),
  foreign key (org_id, superseded_by_part_id) references pm.parts (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_parts_number_uidx on pm.parts (org_id, location_id, upper(coalesce(manufacturer, '')), upper(btrim(part_number)));
create unique index if not exists pm_parts_item_uidx on pm.parts (org_id, location_id, item_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wo_lines_part_fk' and conrelid = 'pm.work_order_lines'::regclass) then
    alter table pm.work_order_lines add constraint wo_lines_part_fk
      foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate;
  end if;
end $$;

create table if not exists pm.dealer_deal_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  deal_id           uuid not null,
  line_no           int not null default 0,
  line_type         text not null check (line_type in ('UNIT','ATTACHMENT','FEE','DISCOUNT','REBATE','INCENTIVE')),
  asset_id          uuid,
  part_id           uuid,
  description       text not null default '',
  qty               numeric(12,4) not null default 1 check (qty > 0),
  unit_price_cents  bigint not null check (unit_price_cents >= 0),       -- filled from the unit / part when omitted
  amount_cents      bigint generated always as ((round(qty * unit_price_cents))::bigint) stored,
  cost_cents        bigint not null default 0 check (cost_cents >= 0),  -- extended operational cost, pinned
  taxable           boolean not null default true,
  program_ref       text,                                               -- OEM program / rebate code
  oem_vendor_id     uuid references core.vendors(id),
  rebate_treatment  text check (rebate_treatment is null or rebate_treatment in ('TRANSACTION_PRICE','COST_REDUCTION','PASS_THROUGH')),
  sort              int not null default 0,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  check ((line_type = 'UNIT') = (asset_id is not null)),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate,
  foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate
);
create index if not exists pm_dealer_deal_lines_deal_idx on pm.dealer_deal_lines (org_id, deal_id, sort, line_no);
create unique index if not exists pm_dealer_deal_lines_unit_uidx on pm.dealer_deal_lines (org_id, deal_id, asset_id) where asset_id is not null;

create table if not exists pm.dealer_quotes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  deal_id         uuid not null,
  number          text not null,
  version         int not null check (version >= 1),
  status          text not null default 'ISSUED' check (status in ('ISSUED','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED')),
  customer_id     uuid references core.customers(id),
  valid_until     date,
  snapshot        jsonb not null,
  totals          jsonb not null,
  issued_by       text,
  issued_at       timestamptz not null default now(),
  decided_by      text,
  decided_at      timestamptz,
  decline_reason  text,
  unique (org_id, number),
  unique (org_id, deal_id, version),
  unique (org_id, id),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dealer_trades (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  deal_id               uuid not null,
  asset_id              uuid,                          -- existing customer equipment (same serial master)
  serial_number         text,
  make                  text,
  model                 text,
  model_year            int check (model_year is null or model_year between 1900 and 2200),
  meter_reading         numeric(12,2) check (meter_reading is null or meter_reading >= 0),
  description           text,
  condition_notes       text,
  acv_cents             bigint check (acv_cents is null or acv_cents >= 0),     -- appraisal (actual cash value)
  allowance_cents       bigint not null default 0 check (allowance_cents >= 0), -- credit given on the deal
  over_allowance_cents  bigint generated always as
                          (case when acv_cents is null then 0 else greatest(allowance_cents - acv_cents, 0) end) stored,
  payoff_cents          bigint not null default 0 check (payoff_cents >= 0),    -- lien on the trade
  lienholder_vendor_id  uuid references core.vendors(id),
  lien_account_ref      text,
  status                text not null default 'APPRAISED' check (status in ('APPRAISED','RECEIVED','UNWOUND','VOID')),
  appraised_by          text,
  appraised_at          timestamptz,
  received_at           timestamptz,
  received_asset_id     uuid,
  outbox_id             uuid,
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  check (payoff_cents = 0 or lienholder_vendor_id is not null),
  check (serial_number is not null or asset_id is not null),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate,
  foreign key (org_id, received_asset_id) references pm.assets (org_id, id) deferrable initially immediate
);
create index if not exists pm_dealer_trades_deal_idx on pm.dealer_trades (org_id, deal_id);

create table if not exists pm.dealer_fi_products (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  deal_id             uuid not null,
  product_type        text not null check (product_type in ('EXTENDED_WARRANTY','SERVICE_CONTRACT','MAINTENANCE_PLAN','GAP',
                        'CREDIT_LIFE','TIRE_WHEEL','THEFT','OTHER')),
  provider_vendor_id  uuid references core.vendors(id),
  description         text,
  price_cents         bigint not null default 0 check (price_cents >= 0),
  cost_cents          bigint not null default 0 check (cost_cents >= 0),
  term_months         int check (term_months is null or term_months between 1 and 240),
  contract_number     text,
  sort                int not null default 0,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dealer_deposits (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  deal_id         uuid not null,
  customer_id     uuid references core.customers(id),
  amount_cents    bigint not null check (amount_cents > 0),
  memo            text,
  status          text not null default 'REQUESTED' check (status in ('REQUESTED','ISSUED','REJECTED','SUPPRESSED','VOID')),
  source_ref      text not null,
  outbox_id       uuid,
  invoice_id      uuid,
  invoice_number  text,
  error_text      text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, id),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- 3. Parts
-- ----------------------------------------------------------------------------
create table if not exists pm.parts_tickets (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  number             text not null,
  customer_id        uuid references core.customers(id),              -- null = cash sale
  stock_location_id  uuid not null,
  status             text not null default 'OPEN' check (status in ('OPEN','CLOSED','VOID')),
  tax_rate_estimate  numeric(7,6) check (tax_rate_estimate is null or (tax_rate_estimate >= 0 and tax_rate_estimate <= 0.25)),
  tax_exempt         boolean not null default false,
  tax_exempt_ref     text,
  po_number          text,
  payment_method     text check (payment_method is null or payment_method in ('CASH','CARD','CHARGE','CHECK','OTHER')),
  totals             jsonb,
  notes              text,
  closed_at          timestamptz,
  closed_by          text,
  voided_at          timestamptz,
  void_reason        text,
  outbox_id          uuid,
  is_sample          boolean not null default false,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check (status <> 'CLOSED' or closed_at is not null),
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate
);
create index if not exists pm_parts_tickets_status_idx on pm.parts_tickets (org_id, location_id, status, closed_at);

create table if not exists pm.parts_ticket_lines (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  ticket_id          uuid not null,
  line_no            int not null default 0,
  part_id            uuid not null,
  requested_part_id  uuid,                                     -- the number keyed in (superseded) when substituted
  description        text,
  qty_requested      numeric(12,4) not null check (qty_requested > 0),
  qty_filled         numeric(12,4) not null default 0 check (qty_filled >= 0),        -- from stock
  qty_special_order  numeric(12,4) not null default 0 check (qty_special_order >= 0),
  unit_price_cents   bigint not null check (unit_price_cents >= 0),
  unit_cost_cents    bigint check (unit_cost_cents is null or unit_cost_cents >= 0),  -- pinned from the part
  core_charge_cents  bigint not null default 0 check (core_charge_cents >= 0),
  taxable            boolean not null default true,
  amount_cents       bigint generated always as ((round(qty_filled * unit_price_cents))::bigint) stored,
  special_order_id   uuid,
  move_id            uuid,
  sort               int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  check (qty_filled + qty_special_order <= qty_requested),
  foreign key (org_id, ticket_id) references pm.parts_tickets (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate,
  foreign key (org_id, requested_part_id) references pm.parts (org_id, id) deferrable initially immediate
);
create index if not exists pm_parts_ticket_lines_ticket_idx on pm.parts_ticket_lines (org_id, ticket_id, sort, line_no);

create table if not exists pm.parts_orders (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  number             text not null,
  vendor_id          uuid not null references core.vendors(id),        -- OEM / distributor
  stock_location_id  uuid not null,
  kind               text not null default 'STOCK' check (kind in ('STOCK','EMERGENCY','SPECIAL')),
  status             text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','PARTIAL','RECEIVED','CANCELLED')),
  vendor_ref         text,
  submitted_at       timestamptz,
  submitted_by       text,
  received_at        timestamptz,
  notes              text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate
);

create table if not exists pm.parts_special_orders (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  number                text not null,
  part_id               uuid not null,
  qty                   numeric(12,4) not null check (qty > 0),
  customer_id           uuid references core.customers(id),
  job_id                uuid,
  work_order_id         uuid,
  deal_id               uuid,
  parts_ticket_line_id  uuid,
  commitment_id         uuid,                       -- RO special order as a job PO (pm.commitments), optional
  parts_order_line_id   uuid,
  vendor_id             uuid references core.vendors(id),
  status                text not null default 'REQUESTED'
                          check (status in ('REQUESTED','ORDERED','RECEIVED','NOTIFIED','PICKED_UP','CANCELLED')),
  needed_by             date,
  ordered_at            timestamptz,
  received_at           timestamptz,
  notified_at           timestamptz,
  picked_up_at          timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  receipt_move_id       uuid,
  notes                 text,
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check (customer_id is not null or work_order_id is not null or deal_id is not null),
  check (work_order_id is null or job_id is not null),
  foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate,
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
create index if not exists pm_parts_special_orders_status_idx on pm.parts_special_orders (org_id, location_id, status);

create table if not exists pm.parts_order_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  order_id          uuid not null,
  line_no           int not null default 0,
  part_id           uuid not null,
  qty_ordered       numeric(12,4) not null check (qty_ordered > 0),
  qty_received      numeric(12,4) not null default 0 check (qty_received >= 0),
  unit_cost_cents   bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  special_order_id  uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  check (qty_received <= qty_ordered),
  foreign key (org_id, order_id) references pm.parts_orders (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate,
  foreign key (org_id, special_order_id) references pm.parts_special_orders (org_id, id) deferrable initially immediate
);

create table if not exists pm.parts_counts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  number             text not null,
  stock_location_id  uuid not null,
  status             text not null default 'OPEN' check (status in ('OPEN','POSTED','CANCELLED')),
  started_by         text,
  started_at         timestamptz not null default now(),
  posted_by          text,
  posted_at          timestamptz,
  variance_summary   jsonb,
  notes              text,
  unique (org_id, number),
  unique (org_id, id),
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate
);

create table if not exists pm.parts_count_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  count_id      uuid not null,
  part_id       uuid not null,
  expected_qty  numeric(14,4) not null,                 -- on-hand snapshot when the count started
  counted_qty   numeric(14,4) check (counted_qty is null or counted_qty >= 0),
  variance_qty  numeric(14,4) generated always as (counted_qty - expected_qty) stored,
  move_id       uuid,
  notes         text,
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, count_id, part_id),
  foreign key (org_id, count_id) references pm.parts_counts (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'material_moves_ticket_fk' and conrelid = 'pm.material_moves'::regclass) then
    alter table pm.material_moves add constraint material_moves_ticket_fk
      foreign key (org_id, parts_ticket_id) references pm.parts_tickets (org_id, id) deferrable initially immediate;
    alter table pm.material_moves add constraint material_moves_parts_order_fk
      foreign key (org_id, parts_order_id) references pm.parts_orders (org_id, id) deferrable initially immediate;
    alter table pm.material_moves add constraint material_moves_count_fk
      foreign key (org_id, parts_count_id) references pm.parts_counts (org_id, id) deferrable initially immediate;
    alter table pm.material_moves add constraint material_moves_special_order_fk
      foreign key (org_id, special_order_id) references pm.parts_special_orders (org_id, id) deferrable initially immediate;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Rentals
-- ----------------------------------------------------------------------------
create table if not exists pm.rental_rates (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  asset_id           uuid,                       -- most specific
  model              text,
  category           text,                       -- least specific (all null = company default)
  label              text,
  day_cents          bigint check (day_cents is null or day_cents >= 0),
  week_cents         bigint check (week_cents is null or week_cents >= 0),
  month_cents        bigint check (month_cents is null or month_cents >= 0),    -- 4-week month (28 days)
  damage_waiver_pct  numeric(5,4) check (damage_waiver_pct is null or (damage_waiver_pct >= 0 and damage_waiver_pct <= 1)),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  check (coalesce(day_cents, 0) + coalesce(week_cents, 0) + coalesce(month_cents, 0) > 0),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_rental_rates_scope_uidx on pm.rental_rates (org_id, location_id, asset_id, lower(model), category) nulls not distinct
  where is_active;

create table if not exists pm.rental_contracts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  number             text not null,
  asset_id           uuid not null,
  customer_id        uuid not null references core.customers(id),
  status             text not null default 'RESERVED' check (status in ('RESERVED','OUT','RETURNED','CLOSED','CANCELLED')),
  reserved           tstzrange not null check (not isempty(reserved) and not lower_inf(reserved) and not upper_inf(reserved)),
  rate_day_cents     bigint,
  rate_week_cents    bigint,
  rate_month_cents   bigint,
  damage_waiver      boolean not null default false,
  damage_waiver_pct  numeric(5,4) check (damage_waiver_pct is null or (damage_waiver_pct >= 0 and damage_waiver_pct <= 1)),
  checked_out_at     timestamptz,
  checked_out_by     text,
  meter_out          numeric(12,2) check (meter_out is null or meter_out >= 0),
  condition_out      text,
  checked_in_at      timestamptz,
  checked_in_by      text,
  meter_in           numeric(12,2) check (meter_in is null or meter_in >= 0),
  condition_in       text,
  damage_notes       text,
  damage_cents       bigint not null default 0 check (damage_cents >= 0),
  fuel_cents         bigint not null default 0 check (fuel_cents >= 0),
  cleaning_cents     bigint not null default 0 check (cleaning_cents >= 0),
  delivery_cents     bigint not null default 0 check (delivery_cents >= 0),
  billed_through     timestamptz,
  closed_at          timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,
  is_sample          boolean not null default false,
  notes              text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check (meter_in is null or meter_out is null or meter_in >= meter_out),
  check (status not in ('OUT','RETURNED','CLOSED') or checked_out_at is not null),
  check (status not in ('RETURNED','CLOSED') or checked_in_at is not null),
  check (checked_in_at is null or checked_in_at >= checked_out_at),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate,
  constraint rental_no_double_booking exclude using gist (org_id with =, asset_id with =, reserved with &&)
    where (status in ('RESERVED','OUT'))
);
create index if not exists pm_rental_contracts_asset_idx on pm.rental_contracts (org_id, asset_id, status);

create table if not exists pm.rental_billings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  contract_id         uuid not null,
  period_start        timestamptz not null,
  period_end          timestamptz not null,
  breakdown           jsonb not null,
  rental_cents        bigint not null check (rental_cents >= 0),
  damage_waiver_cents bigint not null default 0 check (damage_waiver_cents >= 0),
  fees_cents          bigint not null default 0 check (fees_cents >= 0),
  total_cents         bigint not null check (total_cents >= 0),
  is_final            boolean not null default false,
  outbox_id           uuid,
  created_by          text,
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  check (period_end >= period_start),
  foreign key (org_id, contract_id) references pm.rental_contracts (org_id, id) on delete cascade deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- 5. Internal helpers (owner / service_role only)
-- ----------------------------------------------------------------------------

-- entitlements.books_dealer_seam: Books has shipped its dealer consumers. Read-only on a Core column.
create or replace function pm.dealer_seam_on(p_org uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select case when lower(o.entitlements ->> 'books_dealer_seam') in ('true','t','1','yes','on') then true else false end
                   from core.organizations o where o.id = p_org), false)
$$;

-- Release every HELD row of one org into core.events in seq order. Caller holds the org lock.
create or replace function pm.dealer_release_locked(p_org uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r record; n int := 0;
begin
  for r in select o.* from pm.dealer_outbox o where o.org_id = p_org and o.status = 'HELD' order by o.seq for update loop
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (r.org_id, r.event_id, r.event_type, 'PROJECTS', r.payload, r.occurred_on, 'pending')
    on conflict (org_id, event_id) do nothing;
    update pm.dealer_outbox set status = 'RELEASED', released_at = now(), updated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- THE dealer emitter. Idempotent on (org, source_ref). Returns the outbox row id.
create or replace function pm.dealer_emit(
  p_org uuid, p_location uuid, p_type text, p_source_ref text, p_payload jsonb,
  p_occurred_on date default null, p_is_sample boolean default false,
  p_subject_table text default null, p_subject_id uuid default null, p_job uuid default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_id uuid; v_event uuid := gen_random_uuid(); v_on date := coalesce(p_occurred_on, current_date);
        v_supp text; v_status text; v_payload jsonb;
begin
  select o.id into v_id from pm.dealer_outbox o where o.org_id = p_org and o.source_ref = p_source_ref;
  if v_id is not null then return v_id; end if;
  v_supp := case when coalesce(p_is_sample, false) then 'SAMPLE' when not pm.books_present(p_org) then 'STANDALONE' end;
  v_status := case when v_supp is not null then 'SUPPRESSED' when pm.dealer_seam_on(p_org) then 'RELEASED' else 'HELD' end;
  v_payload := coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
    'event_id',       v_event,
    'event_type',     p_type,
    'source_module',  'PROJECTS',
    'schema_version', 1,
    'org_id',         p_org,
    'location_id',    p_location,
    'occurred_on',    to_char(v_on, 'YYYY-MM-DD'),
    'source_ref',     p_source_ref);
  if v_status = 'RELEASED' then
    perform pg_advisory_xact_lock(hashtextextended('pm.dealer_outbox:' || p_org::text, 0));
    perform pm.dealer_release_locked(p_org);            -- anything still held goes first (order is the contract)
  end if;
  insert into pm.dealer_outbox (org_id, location_id, event_id, event_type, source_ref, occurred_on, payload, status,
                                suppressed_reason, subject_table, subject_id, job_id, released_at, created_by)
  values (p_org, p_location, v_event, p_type, p_source_ref, v_on, v_payload, v_status, v_supp, p_subject_table, p_subject_id,
          p_job, case when v_status = 'RELEASED' then now() end, pm.current_user_id())
  returning id into v_id;
  if v_status = 'RELEASED' then
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (p_org, v_event, p_type, 'PROJECTS', v_payload, v_on, 'pending');
  end if;
  return v_id;
end $$;

-- Settings row for a company (created with defaults on first use).
create or replace function pm.dealer_settings_row(p_org uuid, p_location uuid) returns pm.dealer_settings
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dealer_settings%rowtype;
begin
  insert into pm.dealer_settings (org_id, location_id) values (p_org, p_location) on conflict do nothing;
  select * into s from pm.dealer_settings x where x.org_id = p_org and x.location_id = p_location;
  return s;
end $$;

-- Does the user's suite role satisfy any of the pack approval roles (1102 approver_roles map)?
create or replace function pm.dealer_actor_satisfies(p_org uuid, p_user text, p_roles text[]) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select p_user is not null and exists (
    select 1 from core.employees e
    where e.org_id = p_org and e.clerk_user_id = p_user and e.is_active
      and pm.approver_roles(e.role) && (select coalesce(array_agg(lower(r)), '{}'::text[]) from unnest(coalesce(p_roles, '{}'::text[])) r))
$$;

create or replace function pm.dealer_actor_role(p_org uuid, p_user text) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select lower(e.role) from core.employees e where e.org_id = p_org and e.clerk_user_id = p_user and e.is_active order by e.role limit 1
$$;

-- Stock numbers: {N|U|D|R}{YY}-{nnnn}, gapless per org, skipping numbers already used.
create or replace function pm.dealer_mint_stock_number(p_org uuid, p_condition text) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_prefix text := case p_condition when 'USED' then 'U' when 'DEMO' then 'D' when 'RENTAL' then 'R' else 'N' end;
        v_yy text := to_char(current_date, 'YY'); n bigint; v text;
begin
  loop
    n := pm.next_doc_number(p_org, 'org', 'STK', v_yy);
    v := v_prefix || v_yy || '-' || lpad(n::text, greatest(4, length(n::text)), '0');
    exit when not exists (select 1 from pm.assets a where a.org_id = p_org and upper(a.stock_number) = upper(v));
  end loop;
  return v;
end $$;

create or replace function pm.dealer_doc_number(p_org uuid, p_prefix text) returns text
language sql security definer
set search_path = pm, core, public
as $$
  select pm.fmt_doc_number(p_prefix, to_char(current_date, 'YYYY'), pm.next_doc_number(p_org, 'org', p_prefix, to_char(current_date, 'YYYY')))
$$;

create or replace function pm.dealer_refresh_unit_cost(p_asset uuid) returns bigint
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v bigint;
begin
  update pm.assets a
     set dealer_cost_cents = coalesce((select sum(c.amount_cents) from pm.dealer_unit_costs c
                                       where c.org_id = a.org_id and c.asset_id = a.id and c.unit_life = a.unit_life
                                         and c.status = 'ACTIVE'), 0)
   where a.id = p_asset
  returning a.dealer_cost_cents into v;
  return v;
end $$;

create or replace function pm.dealer_unit_json(p_asset uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object('unit_id', a.id, 'stock_number', a.stock_number, 'serial_number', a.serial_number, 'vin', a.vin,
           'make', a.make, 'mfr_vendor_id', a.mfr_vendor_id, 'model', a.model, 'model_year', a.model_year,
           'category', a.category, 'condition', a.condition, 'item_id', a.item_id, 'unit_life', a.unit_life)
  from pm.assets a where a.id = p_asset
$$;

-- One cost row + DEALER_UNIT_COST (source_ref pm:unitcost:{id}). Caller has org-guarded and locked the unit.
create or replace function pm.dealer_record_unit_cost(
  p_asset uuid, p_type text, p_amount bigint, p_labor bigint, p_parts bigint, p_hours numeric, p_source text,
  p_job uuid, p_wo uuid, p_vendor uuid, p_vendor_ref text, p_memo text
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_id uuid := gen_random_uuid(); v_out uuid; v_ro text;
begin
  select * into a from pm.assets x where x.id = p_asset;
  insert into pm.dealer_unit_costs (id, org_id, location_id, asset_id, unit_life, cost_type, amount_cents, labor_cents, parts_cents,
                                    labor_hours, source, job_id, work_order_id, vendor_id, vendor_invoice_ref, memo, source_ref, created_by)
  values (v_id, a.org_id, a.location_id, a.id, a.unit_life, p_type, p_amount, coalesce(p_labor, 0), coalesce(p_parts, 0), p_hours,
          p_source, p_job, p_wo, p_vendor, p_vendor_ref, p_memo, 'pm:unitcost:' || v_id::text, pm.current_user_id());
  perform pm.dealer_refresh_unit_cost(a.id);
  select w.number into v_ro from pm.work_orders w where w.org_id = a.org_id and w.id = p_wo;
  v_out := pm.dealer_emit(a.org_id, a.location_id, 'DEALER_UNIT_COST', 'pm:unitcost:' || v_id::text,
    pm.dealer_unit_json(a.id) || jsonb_build_object(
      'cost_id', v_id, 'cost_type', p_type, 'amount_cents', p_amount, 'labor_cents', coalesce(p_labor, 0),
      'parts_cents', coalesce(p_parts, 0), 'labor_hours', p_hours, 'source_type', p_source,
      'job_id', p_job, 'work_order_id', p_wo, 'ro_number', v_ro, 'vendor_id', p_vendor, 'vendor_invoice_ref', p_vendor_ref,
      'memo', p_memo, 'labor_cost_basis', case when coalesce(p_labor, 0) > 0 then 'OPERATIONAL_ESTIMATE' end),
    current_date, a.is_sample, 'dealer_unit_costs', v_id, p_job);
  update pm.dealer_unit_costs set outbox_id = v_out where id = v_id;
  perform pm.log_activity(a.org_id, a.location_id, p_job, 'dealer_unit.cost_added', 'assets', a.id,
    format('%s: %s %s cents', coalesce(a.stock_number, a.serial_number), lower(p_type), p_amount),
    jsonb_build_object('cost_id', v_id, 'cost_type', p_type, 'amount_cents', p_amount, 'source', p_source, 'outbox_id', v_out));
  return v_id;
end $$;

-- core.items identity for a part (sku = part number, prefixed by the OEM line code). Identity only:
-- no default cost, price or GL accounts (Books-owned). Dynamic so the file loads where core.items is absent.
create or replace function pm.ensure_part_item(p_org uuid, p_sku text, p_name text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_id uuid;
begin
  if to_regclass('core.items') is null then
    raise exception 'PM_NO_ITEM_MASTER: core.items is not available' using errcode = '55000';
  end if;
  execute 'select i.id from core.items i where i.org_id = $1 and upper(i.sku) = upper($2) limit 1' into v_id using p_org, p_sku;
  if v_id is null then
    v_id := gen_random_uuid();
    execute 'insert into core.items (id, org_id, name, sku, item_type) values ($1, $2, $3, $4, ''INVENTORY'')'
      using v_id, p_org, left(p_name, 200), p_sku;
  end if;
  return v_id;
end $$;

-- Operational on-hand (quantity only) of one item at one stock location.
create or replace function pm.part_on_hand(p_org uuid, p_stock_location uuid, p_item uuid) returns numeric
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(sum(case when m.to_stock_location_id = p_stock_location then m.qty else 0 end), 0)
       - coalesce(sum(case when m.from_stock_location_id = p_stock_location then m.qty else 0 end), 0)
  from pm.material_moves m
  where m.org_id = p_org and m.item_id = p_item
    and (m.to_stock_location_id = p_stock_location or m.from_stock_location_id = p_stock_location)
$$;

-- ----------------------------------------------------------------------------
-- 6. Triggers on the new tables (line locks, pinning, org refs)
-- ----------------------------------------------------------------------------

-- Deal lines: editable while the deal is QUOTE / WRITTEN; unit and part costs are pinned here.
create or replace function pm.tg_dealer_deal_line() returns trigger
language plpgsql   -- invoker: current_user must be the caller for the client lock
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; a pm.assets%rowtype; p pm.parts%rowtype; v_client boolean := current_user in ('authenticated','anon');
begin
  if tg_op = 'DELETE' then
    select * into d from pm.dealer_deals x where x.org_id = old.org_id and x.id = old.deal_id;
    if v_client and d.stage not in ('QUOTE','WRITTEN') then
      raise exception 'PM_DEAL_LOCKED: deal % is %; reopen it to change lines', d.number, d.stage using errcode = '55000';
    end if;
    return old;
  end if;
  select * into d from pm.dealer_deals x where x.org_id = new.org_id and x.id = new.deal_id;
  if not found then raise exception 'PM_UNKNOWN_DEAL: %', new.deal_id using errcode = '23503'; end if;
  if v_client and d.stage not in ('QUOTE','WRITTEN') then
    raise exception 'PM_DEAL_LOCKED: deal % is %; reopen it to change lines', d.number, d.stage using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.deal_id is distinct from old.deal_id then
    raise exception 'PM_DEAL_LINE_FIXED: a line cannot move between deals' using errcode = '42501';
  end if;
  if new.line_type = 'UNIT' then
    select * into a from pm.assets x where x.org_id = new.org_id and x.id = new.asset_id;
    if not found or a.location_id is distinct from d.location_id then
      raise exception 'PM_UNIT_SCOPE: unit % is not on this company', new.asset_id using errcode = '23514';
    end if;
    if a.unit_status is null or a.unit_status not in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','ON_HOLD','SOLD') then
      raise exception 'PM_UNIT_NOT_AVAILABLE: unit % is %', coalesce(a.stock_number, a.serial_number), coalesce(a.unit_status, 'not dealer inventory')
        using errcode = '22023';
    end if;
    if a.deal_id is not null and a.deal_id <> new.deal_id then
      raise exception 'PM_UNIT_ON_ANOTHER_DEAL: unit % is on another deal', coalesce(a.stock_number, a.serial_number) using errcode = '22023';
    end if;
    new.qty := 1;
    new.part_id := null;
    if v_client or tg_op = 'INSERT' or new.asset_id is distinct from old.asset_id then
      new.cost_cents := a.dealer_cost_cents;
    end if;
    new.unit_price_cents := coalesce(new.unit_price_cents, a.advertised_price_cents, a.retail_price_cents, 0);
    if btrim(coalesce(new.description, '')) = '' then
      new.description := concat_ws(' ', a.model_year::text, a.make, a.model, 'S/N ' || a.serial_number);
    end if;
  elsif new.part_id is not null then
    select * into p from pm.parts x where x.org_id = new.org_id and x.id = new.part_id;
    if not found or p.location_id is distinct from d.location_id then
      raise exception 'PM_PART_SCOPE: part % is not on this company', new.part_id using errcode = '23514';
    end if;
    new.unit_price_cents := coalesce(new.unit_price_cents, p.price_cents, p.list_price_cents, 0);
    if v_client or tg_op = 'INSERT' or new.part_id is distinct from old.part_id or new.qty is distinct from old.qty then
      new.cost_cents := round(new.qty * coalesce(p.cost_cents, 0))::bigint;
    end if;
    if btrim(coalesce(new.description, '')) = '' then new.description := p.description; end if;
  else
    new.unit_price_cents := coalesce(new.unit_price_cents, 0);
    if v_client and tg_op = 'INSERT' then new.cost_cents := 0; end if;
  end if;
  return new;
end $$;

-- Trades: editable while the deal is QUOTE / WRITTEN; the appraiser is stamped when ACV changes.
create or replace function pm.tg_dealer_trade() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_client boolean := current_user in ('authenticated','anon');
begin
  if tg_op = 'DELETE' then
    select * into d from pm.dealer_deals x where x.org_id = old.org_id and x.id = old.deal_id;
    if v_client and (d.stage not in ('QUOTE','WRITTEN') or old.status <> 'APPRAISED') then
      raise exception 'PM_DEAL_LOCKED: deal % is %', d.number, d.stage using errcode = '55000';
    end if;
    return old;
  end if;
  select * into d from pm.dealer_deals x where x.org_id = new.org_id and x.id = new.deal_id;
  if not found then raise exception 'PM_UNKNOWN_DEAL: %', new.deal_id using errcode = '23503'; end if;
  if v_client and (d.stage not in ('QUOTE','WRITTEN') or (tg_op = 'UPDATE' and old.status <> 'APPRAISED')) then
    raise exception 'PM_DEAL_LOCKED: deal % is %; reopen it to change trades', d.number, d.stage using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.deal_id is distinct from old.deal_id then
    raise exception 'PM_DEAL_LINE_FIXED: a trade cannot move between deals' using errcode = '42501';
  end if;
  if new.asset_id is not null then
    if not exists (select 1 from pm.assets a where a.org_id = new.org_id and a.id = new.asset_id) then
      raise exception 'PM_UNKNOWN_ASSET: %', new.asset_id using errcode = '23503';
    end if;
    select coalesce(new.serial_number, a.serial_number), coalesce(new.make, a.make), coalesce(new.model, a.model),
           coalesce(new.model_year, a.model_year)
      into new.serial_number, new.make, new.model, new.model_year
    from pm.assets a where a.org_id = new.org_id and a.id = new.asset_id;
  end if;
  if new.acv_cents is not null and (tg_op = 'INSERT' or new.acv_cents is distinct from old.acv_cents) then
    new.appraised_by := pm.current_user_id();
    new.appraised_at := now();
  end if;
  return new;
end $$;

create or replace function pm.tg_dealer_fi_product() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_deal uuid := case when tg_op = 'DELETE' then old.deal_id else new.deal_id end;
        v_org uuid := case when tg_op = 'DELETE' then old.org_id else new.org_id end;
begin
  select * into d from pm.dealer_deals x where x.org_id = v_org and x.id = v_deal;
  if not found then raise exception 'PM_UNKNOWN_DEAL: %', v_deal using errcode = '23503'; end if;
  if current_user in ('authenticated','anon') and d.stage not in ('QUOTE','WRITTEN') then
    raise exception 'PM_DEAL_LOCKED: deal % is %; reopen it to change F&I', d.number, d.stage using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.deal_id is distinct from old.deal_id then
    raise exception 'PM_DEAL_LINE_FIXED: a product cannot move between deals' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Counter ticket lines: editable while the ticket is OPEN; a superseded number becomes the current
-- part; price / cost / core charge are pinned from the part.
create or replace function pm.tg_parts_ticket_line() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare t pm.parts_tickets%rowtype; p pm.parts%rowtype; v_cur uuid; v_client boolean := current_user in ('authenticated','anon');
begin
  if tg_op = 'DELETE' then
    select * into t from pm.parts_tickets x where x.org_id = old.org_id and x.id = old.ticket_id;
    if v_client and t.status <> 'OPEN' then raise exception 'PM_TICKET_LOCKED: % is %', t.number, t.status using errcode = '55000'; end if;
    return old;
  end if;
  select * into t from pm.parts_tickets x where x.org_id = new.org_id and x.id = new.ticket_id;
  if not found then raise exception 'PM_UNKNOWN_TICKET: %', new.ticket_id using errcode = '23503'; end if;
  if v_client and t.status <> 'OPEN' then raise exception 'PM_TICKET_LOCKED: % is %', t.number, t.status using errcode = '55000'; end if;
  if tg_op = 'UPDATE' and new.ticket_id is distinct from old.ticket_id then
    raise exception 'PM_TICKET_LINE_FIXED: a line cannot move between tickets' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' or new.part_id is distinct from old.part_id then
    v_cur := pm.resolve_part(new.part_id);
    if v_cur is distinct from new.part_id then
      new.requested_part_id := new.part_id;
      new.part_id := v_cur;
    end if;
    select * into p from pm.parts x where x.org_id = new.org_id and x.id = new.part_id;
    if not found or p.location_id is distinct from t.location_id then
      raise exception 'PM_PART_SCOPE: part % is not on this company', new.part_id using errcode = '23514';
    end if;
    new.unit_cost_cents := p.cost_cents;
    new.core_charge_cents := p.core_charge_cents;
    new.unit_price_cents := coalesce(new.unit_price_cents, p.price_cents, p.list_price_cents, 0);
    new.description := coalesce(nullif(btrim(coalesce(new.description, '')), ''), p.description);
  elsif v_client then
    new.unit_cost_cents := old.unit_cost_cents;
    new.core_charge_cents := old.core_charge_cents;
  end if;
  return new;
end $$;

create or replace function pm.tg_parts_order_line() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare o pm.parts_orders%rowtype; p pm.parts%rowtype; v_client boolean := current_user in ('authenticated','anon');
begin
  if tg_op = 'DELETE' then
    select * into o from pm.parts_orders x where x.org_id = old.org_id and x.id = old.order_id;
    if v_client and o.status <> 'DRAFT' then raise exception 'PM_ORDER_LOCKED: % is %', o.number, o.status using errcode = '55000'; end if;
    return old;
  end if;
  select * into o from pm.parts_orders x where x.org_id = new.org_id and x.id = new.order_id;
  if not found then raise exception 'PM_UNKNOWN_ORDER: %', new.order_id using errcode = '23503'; end if;
  if v_client and o.status <> 'DRAFT' then raise exception 'PM_ORDER_LOCKED: % is %', o.number, o.status using errcode = '55000'; end if;
  select * into p from pm.parts x where x.org_id = new.org_id and x.id = new.part_id;
  if not found or p.location_id is distinct from o.location_id then
    raise exception 'PM_PART_SCOPE: part % is not on this company', new.part_id using errcode = '23514';
  end if;
  new.unit_cost_cents := coalesce(new.unit_cost_cents, p.cost_cents);
  if v_client and tg_op = 'UPDATE' then new.qty_received := old.qty_received; end if;
  return new;
end $$;

create or replace function pm.tg_parts_count_line() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare c pm.parts_counts%rowtype;
begin
  select * into c from pm.parts_counts x where x.org_id = new.org_id and x.id = new.count_id;
  if current_user in ('authenticated','anon') and c.status <> 'OPEN' then
    raise exception 'PM_COUNT_LOCKED: % is %', c.number, c.status using errcode = '55000';
  end if;
  return new;
end $$;

-- RO line with a part: description, price, cost and item come from the part when omitted.
create or replace function pm.tg_wo_line_part() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.parts%rowtype; v_loc uuid;
begin
  if new.part_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.part_id is not distinct from old.part_id then return new; end if;
  select * into p from pm.parts x where x.org_id = new.org_id and x.id = new.part_id;
  select w.location_id into v_loc from pm.work_orders w where w.org_id = new.org_id and w.id = new.work_order_id;
  if not found or p.id is null or p.location_id is distinct from v_loc then
    raise exception 'PM_PART_SCOPE: part % is not on this company', new.part_id using errcode = '23514';
  end if;
  new.item_id := coalesce(new.item_id, p.item_id);
  new.unit_price_cents := coalesce(new.unit_price_cents, p.price_cents, p.list_price_cents);
  new.unit_cost_cents := coalesce(new.unit_cost_cents, p.cost_cents);
  new.description := coalesce(nullif(btrim(coalesce(new.description, '')), ''), p.part_number || ' ' || p.description);
  return new;
end $$;

-- Document links on non-job subjects: the subject must be in the row's org.
create or replace function pm.tg_document_subject_in_org() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare ok boolean := true;
begin
  if new.subject_table in ('assets','dealer_deals','dealer_trades','rental_contracts','parts','parts_tickets') then
    execute format('select exists (select 1 from pm.%I x where x.id = $1 and x.org_id = $2)', new.subject_table)
      into ok using new.subject_id, new.org_id;
    if not ok then
      raise exception 'PM_DOCUMENT_SUBJECT_ORG_MISMATCH: % % is not in org %', new.subject_table, new.subject_id, new.org_id using errcode = '23503';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Settings
-- ----------------------------------------------------------------------------
create or replace function pm.set_dealer_settings(p_location uuid, p_settings jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; s pm.dealer_settings%rowtype; v jsonb := coalesce(p_settings, '{}'); k text;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if not pm.dealer_actor_satisfies(v_org, pm.current_user_id(), array['ops_manager']) then
    raise exception 'PM_APPROVAL_ROLE: dealer settings need the ops_manager role (or owner / admin)' using errcode = '42501';
  end if;
  for k in select jsonb_object_keys(v) loop
    if k not in ('margin_floor_pct','min_front_gross_cents','desk_roles','floor_override_roles','payoff_guard','payoff_ack_roles',
                 'unwind_roles','trade_reduces_taxable','default_tax_rate','unit_stock_location_id','parts_stock_location_id',
                 'allow_negative_parts','delivery_checklist') then
      raise exception 'PM_INVALID: unknown dealer setting %', k using errcode = '22023';
    end if;
  end loop;
  s := pm.dealer_settings_row(v_org, p_location);
  update pm.dealer_settings set
    margin_floor_pct        = coalesce((v ->> 'margin_floor_pct')::numeric, margin_floor_pct),
    min_front_gross_cents   = coalesce((v ->> 'min_front_gross_cents')::bigint, min_front_gross_cents),
    desk_roles              = coalesce(case when v ? 'desk_roles' then array(select jsonb_array_elements_text(v -> 'desk_roles')) end, desk_roles),
    floor_override_roles    = coalesce(case when v ? 'floor_override_roles' then array(select jsonb_array_elements_text(v -> 'floor_override_roles')) end, floor_override_roles),
    payoff_guard            = coalesce(upper(v ->> 'payoff_guard'), payoff_guard),
    payoff_ack_roles        = coalesce(case when v ? 'payoff_ack_roles' then array(select jsonb_array_elements_text(v -> 'payoff_ack_roles')) end, payoff_ack_roles),
    unwind_roles            = coalesce(case when v ? 'unwind_roles' then array(select jsonb_array_elements_text(v -> 'unwind_roles')) end, unwind_roles),
    trade_reduces_taxable   = coalesce((v ->> 'trade_reduces_taxable')::boolean, trade_reduces_taxable),
    default_tax_rate        = case when v ? 'default_tax_rate' then (v ->> 'default_tax_rate')::numeric else default_tax_rate end,
    unit_stock_location_id  = case when v ? 'unit_stock_location_id' then (v ->> 'unit_stock_location_id')::uuid else unit_stock_location_id end,
    parts_stock_location_id = case when v ? 'parts_stock_location_id' then (v ->> 'parts_stock_location_id')::uuid else parts_stock_location_id end,
    allow_negative_parts    = coalesce((v ->> 'allow_negative_parts')::boolean, allow_negative_parts),
    delivery_checklist      = coalesce(v -> 'delivery_checklist', delivery_checklist),
    updated_by = pm.current_user_id(), updated_at = now()
  where org_id = v_org and location_id = p_location
  returning * into s;
  if exists (select 1 from pm.stock_locations x where x.org_id = v_org and x.id in (s.unit_stock_location_id, s.parts_stock_location_id)
             and x.location_id <> p_location) then
    raise exception 'PM_INVALID: default stock locations must be on this company' using errcode = '22023';
  end if;
  perform pm.log_activity(v_org, p_location, null, 'dealer.settings_changed', 'dealer_settings', null,
    'Dealer settings updated', jsonb_build_object('changes', v));
  return to_jsonb(s);
end $$;

-- ----------------------------------------------------------------------------
-- 8. Units (whole goods)
-- ----------------------------------------------------------------------------

-- Receive a unit into stock (new from the manufacturer, or an ON_ORDER / IN_TRANSIT unit arriving).
-- p_attrs: condition (NEW|USED|DEMO|RENTAL, default NEW), model_year, vin, category, stock_number,
--   stock_location_id, received_on, mfr_invoice_ref, mfr_vendor_id, item_id, retail_price_cents,
--   advertised_price_cents, meter_reading, attachments [], description, floor_plan {lender_vendor_id,
--   program_ref} (a hint for Books' flooring proposal), is_sample.
create or replace function pm.receive_unit(
  p_location uuid, p_serial text, p_make text, p_model text, p_cost_cents bigint default 0,
  p_attrs jsonb default '{}', p_unit uuid default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org     uuid;
  a         pm.assets%rowtype;
  s         pm.dealer_settings%rowtype;
  v_attrs   jsonb := coalesce(p_attrs, '{}');
  v_cond    text := upper(coalesce(nullif(v_attrs ->> 'condition', ''), 'NEW'));
  v_serial  text := nullif(btrim(coalesce(p_serial, '')), '');
  v_make    text := nullif(btrim(coalesce(p_make, '')), '');
  v_sl      uuid;
  v_on      date;
  v_mfr     uuid := nullif(v_attrs ->> 'mfr_vendor_id', '')::uuid;
  v_status  text;
  v_cost    uuid;
  v_out     uuid;
  v_stock   text;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_cond not in ('NEW','USED','DEMO','RENTAL') then raise exception 'PM_INVALID: condition %', v_cond using errcode = '22023'; end if;
  if p_cost_cents is null or p_cost_cents < 0 then raise exception 'PM_INVALID: cost must be ≥ 0' using errcode = '22023'; end if;
  if v_mfr is not null and not exists (select 1 from core.vendors v where v.id = v_mfr and v.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: vendor % is not in the caller''s organization', v_mfr using errcode = '42501';
  end if;
  s := pm.dealer_settings_row(v_org, p_location);
  v_sl := coalesce(nullif(v_attrs ->> 'stock_location_id', '')::uuid, s.unit_stock_location_id);
  if v_sl is not null and not exists (select 1 from pm.stock_locations x where x.org_id = v_org and x.id = v_sl and x.location_id = p_location) then
    raise exception 'PM_INVALID: stock location % is not on this company', v_sl using errcode = '22023';
  end if;
  v_on := coalesce(nullif(v_attrs ->> 'received_on', '')::date, current_date);

  if p_unit is not null then
    select * into a from pm.assets x where x.id = p_unit for update;
    if a.org_id is null or a.org_id is distinct from v_org then
      raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
    end if;
    if a.location_id <> p_location then raise exception 'PM_INVALID: unit % is on another company', p_unit using errcode = '22023'; end if;
    if a.unit_status is distinct from 'ON_ORDER' and a.unit_status is distinct from 'IN_TRANSIT' then
      raise exception 'PM_UNIT_TRANSITION_INVALID: unit % is %; only ON_ORDER / IN_TRANSIT units are received', p_unit, a.unit_status
        using errcode = '22023';
    end if;
    v_serial := coalesce(v_serial, a.serial_number);
    v_make := coalesce(v_make, a.make);
  end if;
  if v_serial is null then raise exception 'PM_INVALID: a received unit needs a serial number' using errcode = '22023'; end if;
  if p_unit is null then
    select * into a from pm.assets x
    where x.org_id = v_org and lower(x.serial_number) = lower(v_serial) and lower(coalesce(x.make, '')) = lower(coalesce(v_make, ''))
    for update;
    if found then
      if a.unit_status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','RENTAL','ON_HOLD','SOLD') then
        raise exception 'PM_UNIT_SERIAL_EXISTS: % % is already dealer inventory (%)', coalesce(v_make, ''), v_serial, a.unit_status
          using errcode = '23505';
      end if;
      if a.customer_id is not null then
        raise exception 'PM_UNIT_CUSTOMER_OWNED: % % belongs to a customer; take it in as a trade on a deal', coalesce(v_make, ''), v_serial
          using errcode = '22023';
      end if;
      if a.location_id <> p_location then
        raise exception 'PM_INVALID: serial % is recorded on another company', v_serial using errcode = '22023';
      end if;
    end if;
  end if;

  v_status := case v_cond when 'DEMO' then 'DEMO' when 'RENTAL' then 'RENTAL' else 'IN_STOCK' end;
  v_stock := coalesce(nullif(btrim(coalesce(v_attrs ->> 'stock_number', '')), ''), a.stock_number);
  if v_stock is null or a.unit_status is not null and a.unit_status not in ('ON_ORDER','IN_TRANSIT') then
    v_stock := coalesce(nullif(btrim(coalesce(v_attrs ->> 'stock_number', '')), ''), pm.dealer_mint_stock_number(v_org, v_cond));
  end if;
  if exists (select 1 from pm.assets x where x.org_id = v_org and upper(x.stock_number) = upper(v_stock) and x.id is distinct from a.id) then
    raise exception 'PM_STOCK_NUMBER_TAKEN: %', v_stock using errcode = '23505';
  end if;

  if a.id is null then
    insert into pm.assets (org_id, location_id, kind, serial_number, make, model, ext, created_by)
    values (v_org, p_location, case v_cond when 'RENTAL' then 'RENTAL_UNIT' else 'DEALER_UNIT' end, v_serial, v_make,
            nullif(btrim(coalesce(p_model, '')), ''), '{}'::jsonb, pm.current_user_id())
    returning * into a;
  end if;
  update pm.assets x set
    kind = case v_cond when 'RENTAL' then 'RENTAL_UNIT' else 'DEALER_UNIT' end,
    customer_id = null, status = 'ACTIVE', retired_on = null,
    serial_number = v_serial, make = v_make, model = coalesce(nullif(btrim(coalesce(p_model, '')), ''), x.model),
    model_year = coalesce(nullif(v_attrs ->> 'model_year', '')::int, x.model_year),
    vin = coalesce(nullif(v_attrs ->> 'vin', ''), x.vin),
    category = coalesce(nullif(v_attrs ->> 'category', ''), x.category),
    description = coalesce(nullif(v_attrs ->> 'description', ''), x.description),
    item_id = coalesce(nullif(v_attrs ->> 'item_id', '')::uuid, x.item_id),
    mfr_vendor_id = coalesce(v_mfr, x.mfr_vendor_id),
    condition = v_cond, unit_status = v_status, unit_hold_prior_status = null,
    unit_life = x.unit_life + 1, stock_number = v_stock, stock_location_id = v_sl, received_on = v_on,
    mfr_invoice_ref = nullif(v_attrs ->> 'mfr_invoice_ref', ''),
    retail_price_cents = coalesce(nullif(v_attrs ->> 'retail_price_cents', '')::bigint, x.retail_price_cents),
    advertised_price_cents = coalesce(nullif(v_attrs ->> 'advertised_price_cents', '')::bigint, x.advertised_price_cents),
    attachments = coalesce(case when jsonb_typeof(v_attrs -> 'attachments') = 'array' then v_attrs -> 'attachments' end, x.attachments),
    meter_reading = coalesce(nullif(v_attrs ->> 'meter_reading', '')::numeric, x.meter_reading),
    meter_read_on = case when nullif(v_attrs ->> 'meter_reading', '') is not null then v_on else x.meter_read_on end,
    deal_id = null, unit_sold_on = null, unit_delivered_on = null,
    is_sample = coalesce((v_attrs ->> 'is_sample')::boolean, false)
  where x.id = a.id
  returning * into a;

  if p_cost_cents > 0 then
    v_cost := gen_random_uuid();
    insert into pm.dealer_unit_costs (id, org_id, location_id, asset_id, unit_life, cost_type, amount_cents, source,
                                      vendor_id, vendor_invoice_ref, memo, source_ref, created_by)
    values (v_cost, v_org, p_location, a.id, a.unit_life, 'BASE_INVOICE', p_cost_cents, 'RECEIPT', v_mfr,
            a.mfr_invoice_ref, 'Manufacturer invoice', 'pm:unitcost:' || v_cost::text, pm.current_user_id());
  end if;
  perform pm.dealer_refresh_unit_cost(a.id);

  v_out := pm.dealer_emit(v_org, p_location, 'DEALER_UNIT_RECEIVED', 'pm:unit:' || a.id::text || ':received:' || a.unit_life,
    pm.dealer_unit_json(a.id) || jsonb_build_object(
      'unit_status', v_status, 'received_on', to_char(v_on, 'YYYY-MM-DD'), 'stock_location_id', v_sl,
      'mfr_invoice_ref', a.mfr_invoice_ref, 'cost_cents', p_cost_cents,
      'cost_lines', case when v_cost is null then '[]'::jsonb
                         else jsonb_build_array(jsonb_build_object('cost_id', v_cost, 'cost_type', 'BASE_INVOICE', 'amount_cents', p_cost_cents)) end,
      'retail_price_cents', a.retail_price_cents, 'advertised_price_cents', a.advertised_price_cents,
      'attachments', a.attachments, 'meter_reading', a.meter_reading, 'floor_plan_hint', v_attrs -> 'floor_plan',
      'is_trade_in', false),
    v_on, a.is_sample, 'assets', a.id, null);
  if v_cost is not null then update pm.dealer_unit_costs set outbox_id = v_out where id = v_cost; end if;

  perform pm.log_activity(v_org, p_location, null, 'dealer_unit.received', 'assets', a.id,
    format('Received %s %s %s (S/N %s) as %s', v_stock, coalesce(v_make, ''), coalesce(a.model, ''), v_serial, lower(v_status)),
    jsonb_build_object('stock_number', v_stock, 'condition', v_cond, 'cost_cents', p_cost_cents, 'outbox_id', v_out, 'unit_life', a.unit_life));
  return a.id;
end $$;

-- A unit on order from the manufacturer (no serial needed yet; nothing reaches Books until receipt).
create or replace function pm.order_unit(p_location uuid, p_make text, p_model text, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_id uuid; v_attrs jsonb := coalesce(p_attrs, '{}');
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_model, '')), '') is null then raise exception 'PM_INVALID: model is required' using errcode = '22023'; end if;
  insert into pm.assets (org_id, location_id, kind, serial_number, make, model, model_year, category, description, condition,
                         unit_status, stock_number, retail_price_cents, mfr_vendor_id, created_by)
  values (v_org, p_location, 'DEALER_UNIT', nullif(btrim(coalesce(v_attrs ->> 'serial_number', '')), ''), nullif(btrim(coalesce(p_make, '')), ''),
          btrim(p_model), nullif(v_attrs ->> 'model_year', '')::int, nullif(v_attrs ->> 'category', ''), nullif(v_attrs ->> 'description', ''),
          'NEW', 'ON_ORDER', pm.dealer_mint_stock_number(v_org, 'NEW'), nullif(v_attrs ->> 'retail_price_cents', '')::bigint,
          nullif(v_attrs ->> 'mfr_vendor_id', '')::uuid, pm.current_user_id())
  returning id into v_id;
  perform pm.log_activity(v_org, p_location, null, 'dealer_unit.ordered', 'assets', v_id,
    format('Ordered %s %s', coalesce(p_make, ''), p_model), jsonb_build_object('model', p_model));
  return v_id;
end $$;

-- Freight, setup, accessories, reconditioning, other (BASE_INVOICE comes with the receipt; write-downs
-- and rebate cost reductions are Books' entries).
create or replace function pm.add_unit_cost(
  p_unit uuid, p_cost_type text, p_amount_cents bigint, p_memo text default null, p_attrs jsonb default '{}'
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_type text := upper(coalesce(p_cost_type, '')); v_attrs jsonb := coalesce(p_attrs, '{}');
        v_labor bigint := coalesce(nullif(v_attrs ->> 'labor_cents', '')::bigint, 0);
        v_parts bigint := coalesce(nullif(v_attrs ->> 'parts_cents', '')::bigint, 0);
        v_vendor uuid := nullif(v_attrs ->> 'vendor_id', '')::uuid;
begin
  select * into a from pm.assets x where x.id = p_unit for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  if a.unit_status is null or a.unit_status not in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','ON_HOLD','SOLD','RENTAL') then
    raise exception 'PM_UNIT_NOT_IN_INVENTORY: unit % is %', coalesce(a.stock_number, a.serial_number), coalesce(a.unit_status, 'not dealer inventory')
      using errcode = '22023';
  end if;
  if v_type not in ('FREIGHT','SETUP_PDI','ACCESSORY','RECON','OTHER') then
    raise exception 'PM_INVALID: cost type % (FREIGHT, SETUP_PDI, ACCESSORY, RECON, OTHER)', p_cost_type using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'PM_INVALID: amount must be > 0' using errcode = '22023'; end if;
  if v_labor < 0 or v_parts < 0 or v_labor + v_parts > p_amount_cents then
    raise exception 'PM_INVALID: labor + parts must be within the amount' using errcode = '22023';
  end if;
  if v_vendor is not null and not exists (select 1 from core.vendors v where v.id = v_vendor and v.org_id = a.org_id) then
    raise exception 'PM_FORBIDDEN: vendor % is not in the caller''s organization', v_vendor using errcode = '42501';
  end if;
  return pm.dealer_record_unit_cost(a.id, v_type, p_amount_cents, v_labor, v_parts, nullif(v_attrs ->> 'labor_hours', '')::numeric,
                                    'MANUAL', null, null, v_vendor, nullif(v_attrs ->> 'vendor_invoice_ref', ''), p_memo);
end $$;

-- Dealer status moves (sales statuses ON_HOLD/SOLD/DELIVERED belong to the deal functions;
-- TRANSFERRED here = dealer-to-dealer trade out; an in-org store move is pm.transfer_unit).
-- Emits DEALER_UNIT_STATUS when the move touches DEMO, RENTAL, RETURNED_TO_MFR or TRANSFERRED.
-- (pm.set_unit_status is 1107's development-unit function; overloading it would be ambiguous.)
create or replace function pm.set_dealer_unit_status(p_unit uuid, p_status text, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_to text := upper(coalesce(p_status, '')); ok boolean; v_cond text; v_kind text; v_out uuid;
        v_from text; v_from_cond text;
begin
  select * into a from pm.assets x where x.id = p_unit for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  ok := case a.unit_status
          when 'ON_ORDER'   then v_to in ('IN_TRANSIT')
          when 'IN_TRANSIT' then v_to in ('ON_ORDER')
          when 'IN_STOCK'   then v_to in ('PDI','DEMO','RENTAL','ON_HOLD','RETURNED_TO_MFR','TRANSFERRED')
          when 'PDI'        then v_to in ('IN_STOCK','DEMO')
          when 'DEMO'       then v_to in ('IN_STOCK','RENTAL','RETURNED_TO_MFR','TRANSFERRED')
          when 'RENTAL'     then v_to in ('IN_STOCK','RETURNED_TO_MFR','TRANSFERRED')
          when 'ON_HOLD'    then v_to in ('IN_STOCK') and a.deal_id is null
          else false end;
  if not ok then
    raise exception 'PM_UNIT_TRANSITION_INVALID: % -> % for unit % %', coalesce(a.unit_status, '(none)'), v_to,
      coalesce(a.stock_number, a.serial_number), case when a.deal_id is not null then ' (held by a deal; use the deal)' else '' end
      using errcode = '22023';
  end if;
  if a.unit_status = 'RENTAL' and exists (select 1 from pm.rental_contracts r where r.org_id = a.org_id and r.asset_id = a.id
                                            and r.status in ('RESERVED','OUT')) then
    raise exception 'PM_UNIT_ON_RENT: unit % has an open rental contract', coalesce(a.stock_number, a.serial_number) using errcode = '22023';
  end if;
  v_cond := case when v_to = 'DEMO' then 'DEMO'
                 when v_to = 'RENTAL' then 'RENTAL'
                 when a.unit_status = 'RENTAL' and v_to = 'IN_STOCK' then 'USED'
                 else a.condition end;
  v_kind := case when v_to = 'RENTAL' then 'RENTAL_UNIT' when a.unit_status = 'RENTAL' then 'DEALER_UNIT' else a.kind end;
  v_from := a.unit_status; v_from_cond := a.condition;
  update pm.assets set unit_status = v_to, condition = v_cond, kind = v_kind, unit_status_rev = unit_status_rev + 1
   where id = a.id returning * into a;
  if v_to in ('DEMO','RENTAL','RETURNED_TO_MFR','TRANSFERRED') or v_from in ('DEMO','RENTAL') then
    v_out := pm.dealer_emit(a.org_id, a.location_id, 'DEALER_UNIT_STATUS', 'pm:unit:' || a.id::text || ':status:' || a.unit_status_rev,
      pm.dealer_unit_json(a.id) || jsonb_build_object(
        'from_status', v_from, 'to_status', v_to, 'resulting_status', v_to,
        'transfer_kind', case when v_to = 'TRANSFERRED' then 'DEALER_TRADE_OUT' end,
        'from_location_id', a.location_id, 'to_location_id', a.location_id,
        'from_condition', v_from_cond, 'to_condition', v_cond, 'cost_cents', a.dealer_cost_cents,
        'reason', p_reason, 'effective_on', to_char(current_date, 'YYYY-MM-DD')),
      current_date, a.is_sample, 'assets', a.id, null);
  end if;
  perform pm.log_activity(a.org_id, a.location_id, null, 'dealer_unit.status', 'assets', a.id,
    format('%s: %s -> %s', coalesce(a.stock_number, a.serial_number), v_from, v_to),
    jsonb_build_object('from', v_from, 'to', v_to, 'from_condition', v_from_cond, 'to_condition', v_cond, 'reason', p_reason, 'outbox_id', v_out));
  return a.id;
end $$;

-- In-org move: another stock location on the same company (no event) or on another company of the
-- same org (inter-company transfer: DEALER_UNIT_STATUS to_status TRANSFERRED, the unit stays in stock
-- at the receiving store).
create or replace function pm.transfer_unit(p_unit uuid, p_to_stock_location uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_to_loc uuid; v_from_loc uuid; v_from_sl uuid; v_out uuid;
begin
  select * into a from pm.assets x where x.id = p_unit for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  select s.location_id into v_to_loc from pm.stock_locations s where s.id = p_to_stock_location and s.org_id = a.org_id and s.is_active;
  if v_to_loc is null then
    raise exception 'PM_FORBIDDEN: stock location % not found in the caller''s organization', p_to_stock_location using errcode = '42501';
  end if;
  if a.unit_status is null or a.unit_status not in ('IN_STOCK','DEMO','RENTAL') or a.deal_id is not null then
    raise exception 'PM_UNIT_TRANSITION_INVALID: unit % is %; only unheld IN_STOCK / DEMO / RENTAL units transfer',
      coalesce(a.stock_number, a.serial_number), coalesce(a.unit_status, '(none)') using errcode = '22023';
  end if;
  if a.stock_location_id is not distinct from p_to_stock_location then
    raise exception 'PM_INVALID: unit is already at that stock location' using errcode = '22023';
  end if;
  if a.unit_status = 'RENTAL' and exists (select 1 from pm.rental_contracts r where r.org_id = a.org_id and r.asset_id = a.id and r.status = 'OUT') then
    raise exception 'PM_UNIT_ON_RENT: unit % is out on rent', coalesce(a.stock_number, a.serial_number) using errcode = '22023';
  end if;
  v_from_loc := a.location_id; v_from_sl := a.stock_location_id;
  update pm.assets set stock_location_id = p_to_stock_location, location_id = v_to_loc,
         unit_status_rev = unit_status_rev + case when v_to_loc <> v_from_loc then 1 else 0 end
   where id = a.id returning * into a;
  if v_to_loc <> v_from_loc then
    update pm.dealer_unit_costs set location_id = v_to_loc where org_id = a.org_id and asset_id = a.id and unit_life = a.unit_life;
    v_out := pm.dealer_emit(a.org_id, v_from_loc, 'DEALER_UNIT_STATUS', 'pm:unit:' || a.id::text || ':status:' || a.unit_status_rev,
      pm.dealer_unit_json(a.id) || jsonb_build_object(
        'from_status', a.unit_status, 'to_status', 'TRANSFERRED', 'resulting_status', a.unit_status,
        'transfer_kind', 'INTER_COMPANY', 'from_location_id', v_from_loc, 'to_location_id', v_to_loc,
        'from_stock_location_id', v_from_sl, 'to_stock_location_id', p_to_stock_location,
        'from_condition', a.condition, 'to_condition', a.condition, 'cost_cents', a.dealer_cost_cents,
        'reason', p_reason, 'effective_on', to_char(current_date, 'YYYY-MM-DD')),
      current_date, a.is_sample, 'assets', a.id, null);
  end if;
  perform pm.log_activity(a.org_id, v_to_loc, null, 'dealer_unit.transferred', 'assets', a.id,
    format('%s moved to stock location %s%s', coalesce(a.stock_number, a.serial_number), p_to_stock_location,
           case when v_to_loc <> v_from_loc then ' (inter-company)' else '' end),
    jsonb_build_object('from_location_id', v_from_loc, 'to_location_id', v_to_loc, 'from_stock_location_id', v_from_sl,
                       'to_stock_location_id', p_to_stock_location, 'outbox_id', v_out, 'reason', p_reason));
  return a.id;
end $$;

-- PDI / setup: an internal repair order (job type pdi_setup, work order kind PDI) on the unit.
create or replace function pm.open_unit_pdi(p_unit uuid, p_summary text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_job uuid; v_wo uuid;
begin
  select * into a from pm.assets x where x.id = p_unit for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  if a.unit_status is null or a.unit_status not in ('IN_STOCK','ON_HOLD','SOLD','DEMO') then
    raise exception 'PM_UNIT_TRANSITION_INVALID: unit % is %; PDI needs a unit in stock', coalesce(a.stock_number, a.serial_number),
      coalesce(a.unit_status, '(none)') using errcode = '22023';
  end if;
  if exists (select 1 from pm.work_orders w where w.org_id = a.org_id and w.asset_id = a.id and w.kind = 'PDI'
               and w.status not in ('COMPLETE','CLOSED','CANCELLED')) then
    raise exception 'PM_PDI_OPEN: unit % already has an open PDI', coalesce(a.stock_number, a.serial_number) using errcode = '22023';
  end if;
  v_job := pm.create_project(a.location_id, 'pdi_setup', format('PDI %s %s %s', coalesce(a.stock_number, ''), coalesce(a.make, ''), coalesce(a.model, '')),
                             null, null, a.is_sample, '{}'::jsonb);
  v_wo := pm.create_work_order(v_job, 'PDI', coalesce(nullif(btrim(coalesce(p_summary, '')), ''), 'Pre-delivery inspection and setup'),
                               3, a.id, null, null, null, '{}', 'INTERNAL');
  if a.unit_status = 'IN_STOCK' then
    update pm.assets set unit_status = 'PDI' where id = a.id;
  end if;
  perform pm.log_activity(a.org_id, a.location_id, v_job, 'dealer_unit.pdi_opened', 'assets', a.id,
    format('PDI opened on %s', coalesce(a.stock_number, a.serial_number)), jsonb_build_object('work_order_id', v_wo));
  return v_wo;
end $$;

create or replace function pm.register_unit_warranty(
  p_unit uuid, p_registered_on date default null, p_warranty_expires_on date default null, p_oem_ref text default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_on date := coalesce(p_registered_on, current_date); v_out uuid;
begin
  select * into a from pm.assets x where x.id = p_unit for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  if a.unit_status is null or a.unit_status not in ('SOLD','DELIVERED','DEMO') then
    raise exception 'PM_UNIT_TRANSITION_INVALID: unit % is %; register a sold, delivered or demo unit', coalesce(a.stock_number, a.serial_number),
      coalesce(a.unit_status, '(none)') using errcode = '22023';
  end if;
  if p_warranty_expires_on is not null and p_warranty_expires_on < v_on then
    raise exception 'PM_INVALID: warranty expires before it starts' using errcode = '22023';
  end if;
  update pm.assets set registered_on = v_on, warranty_expires_on = coalesce(p_warranty_expires_on, warranty_expires_on),
         registration_count = registration_count + 1
   where id = a.id returning * into a;
  v_out := pm.dealer_emit(a.org_id, a.location_id, 'DEALER_WARRANTY_REGISTRATION',
    'pm:unit:' || a.id::text || ':registration:' || a.registration_count,
    pm.dealer_unit_json(a.id) || jsonb_build_object('customer_id', a.customer_id, 'registered_on', to_char(v_on, 'YYYY-MM-DD'),
      'warranty_expires_on', to_char(a.warranty_expires_on, 'YYYY-MM-DD'), 'oem_registration_ref', p_oem_ref,
      'deal_id', a.deal_id, 'unit_status', a.unit_status, 'delivered_on', to_char(a.unit_delivered_on, 'YYYY-MM-DD')),
    v_on, a.is_sample, 'assets', a.id, null);
  if a.deal_id is not null then
    update pm.dealer_deals d
       set delivery_checklist = (select coalesce(jsonb_agg(case when e ->> 'key' = 'warranty_registration'
                                                               then e || jsonb_build_object('done', true, 'done_by', pm.current_user_id(), 'done_at', now())
                                                               else e end), '[]'::jsonb)
                                 from jsonb_array_elements(d.delivery_checklist) e)
     where d.org_id = a.org_id and d.id = a.deal_id;
  end if;
  perform pm.log_activity(a.org_id, a.location_id, null, 'dealer_unit.registered', 'assets', a.id,
    format('Warranty registration for %s', coalesce(a.stock_number, a.serial_number)),
    jsonb_build_object('registered_on', v_on, 'oem_ref', p_oem_ref, 'outbox_id', v_out));
  return v_out;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Sales desk: deals, quotes, trades, F&I, deposits
--   Stage machine: QUOTE → WRITTEN → APPROVED (manager desk, margin floor) → FUNDED (ready:
--   cash in or financing approved) → DELIVERED (DEALER_DEAL_FINALIZED + DEALER_TRADE_RECEIVED)
--   → UNWOUND (DEALER_DEAL_UNWOUND). QUOTE / WRITTEN / APPROVED / FUNDED → LOST.
--   Gross (operational):
--     sale price   = Σ UNIT + ATTACHMENT lines − Σ DISCOUNT lines
--     front gross  = sale price − pinned unit / attachment cost − trade over-allowance
--                    + fees − fee cost + dealer incentives            (retail rebates are gross-neutral:
--                                                                      the customer's credit is the OEM's receivable)
--     back gross   = Σ F&I price − Σ F&I cost + finance reserve − subvention
--     sales tax    = an ESTIMATE (rate × taxable lines − trade allowance when the state allows); Books computes it
-- ----------------------------------------------------------------------------
create or replace function pm.dealer_deal_totals(p_deal uuid) returns jsonb
language plpgsql stable
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_reduce boolean; l record; t record; f record; v_dep bigint;
        v_sale bigint; v_front bigint; v_back bigint; v_taxable bigint; v_tax bigint; v_cash bigint; v_bal bigint;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if not found then return null; end if;
  select s.trade_reduces_taxable into v_reduce from pm.dealer_settings s where s.org_id = d.org_id and s.location_id = d.location_id;
  v_reduce := coalesce(v_reduce, true);
  select coalesce(sum(x.amount_cents) filter (where x.line_type in ('UNIT','ATTACHMENT')), 0)::bigint                     as merch,
         coalesce(sum(x.amount_cents) filter (where x.line_type = 'DISCOUNT'), 0)::bigint                                 as disc,
         coalesce(sum(x.cost_cents)   filter (where x.line_type in ('UNIT','ATTACHMENT')), 0)::bigint                     as cost,
         coalesce(sum(x.amount_cents) filter (where x.line_type = 'FEE'), 0)::bigint                                      as fees,
         coalesce(sum(x.cost_cents)   filter (where x.line_type = 'FEE'), 0)::bigint                                      as fee_cost,
         coalesce(sum(x.amount_cents) filter (where x.line_type = 'REBATE'), 0)::bigint                                   as reb,
         coalesce(sum(x.amount_cents) filter (where x.line_type = 'INCENTIVE'), 0)::bigint                                as inc,
         coalesce(sum(x.amount_cents) filter (where x.taxable and x.line_type in ('UNIT','ATTACHMENT','FEE')), 0)::bigint as tax_gross,
         coalesce(sum(x.amount_cents) filter (where x.taxable and x.line_type = 'DISCOUNT'), 0)::bigint                   as tax_disc,
         count(*) filter (where x.line_type = 'UNIT')::int                                                                as units
    into l from pm.dealer_deal_lines x where x.org_id = d.org_id and x.deal_id = d.id;
  select coalesce(sum(x.allowance_cents), 0)::bigint as allow, coalesce(sum(x.acv_cents), 0)::bigint as acv,
         coalesce(sum(x.over_allowance_cents), 0)::bigint as over, coalesce(sum(x.payoff_cents), 0)::bigint as payoff, count(*)::int as n
    into t from pm.dealer_trades x
   where x.org_id = d.org_id and x.deal_id = d.id and x.status in ('APPRAISED','RECEIVED');
  select coalesce(sum(x.price_cents), 0)::bigint as price, coalesce(sum(x.cost_cents), 0)::bigint as cost, count(*)::int as n
    into f from pm.dealer_fi_products x where x.org_id = d.org_id and x.deal_id = d.id;
  select coalesce(sum(x.amount_cents), 0)::bigint into v_dep from pm.dealer_deposits x
   where x.org_id = d.org_id and x.deal_id = d.id and x.status in ('REQUESTED','ISSUED','SUPPRESSED');
  v_sale    := l.merch - l.disc;
  v_front   := v_sale - l.cost - t.over + l.fees - l.fee_cost + l.inc;
  v_back    := f.price - f.cost + d.finance_reserve_cents - d.subvention_cents;
  v_taxable := greatest(l.tax_gross - l.tax_disc - case when v_reduce then t.allow else 0 end, 0);
  v_tax     := case when d.tax_exempt then 0 else round(v_taxable * coalesce(d.tax_rate_estimate, 0))::bigint end;
  v_cash    := v_sale + l.fees + f.price + v_tax - l.reb;
  v_bal     := v_cash - t.allow + t.payoff - v_dep;
  return jsonb_build_object(
    'unit_count',                  l.units,
    'merchandise_cents',           l.merch,
    'discount_cents',              l.disc,
    'sale_price_cents',            v_sale,
    'unit_cost_cents',             l.cost,
    'fees_cents',                  l.fees,
    'fee_cost_cents',              l.fee_cost,
    'rebates_cents',               l.reb,
    'incentives_cents',            l.inc,
    'trade_count',                 t.n,
    'trade_allowance_cents',       t.allow,
    'trade_acv_cents',             t.acv,
    'over_allowance_cents',        t.over,
    'trade_payoff_cents',          t.payoff,
    'fi_count',                    f.n,
    'fi_price_cents',              f.price,
    'fi_cost_cents',               f.cost,
    'finance_reserve_cents',       d.finance_reserve_cents,
    'subvention_cents',            d.subvention_cents,
    'front_gross_cents',           v_front,
    'back_gross_cents',            v_back,
    'total_gross_cents',           v_front + v_back,
    'front_gross_pct',             case when v_sale > 0 then round(v_front::numeric / v_sale, 4) end,
    'taxable_estimate_cents',      v_taxable,
    'tax_rate_estimate',           d.tax_rate_estimate,
    'tax_estimate_cents',          v_tax,
    'tax_exempt',                  d.tax_exempt,
    'deposits_cents',              v_dep,
    'cash_price_cents',            v_cash,
    'balance_due_estimate_cents',  v_bal);
end $$;

-- What the customer agreed to (quote acceptance compares these; cost changes do not stale a quote).
create or replace function pm.dealer_deal_terms(p_deal uuid) returns jsonb
language sql stable
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_type', x.line_type, 'unit_id', x.asset_id, 'part_id', x.part_id,
                         'qty', x.qty, 'unit_price_cents', x.unit_price_cents, 'description', x.description)
                       order by x.line_type, x.asset_id, x.part_id, x.description, x.qty, x.unit_price_cents)
                       from pm.dealer_deal_lines x where x.org_id = d.org_id and x.deal_id = d.id), '[]'::jsonb),
    'trades', coalesce((select jsonb_agg(jsonb_build_object('serial_number', x.serial_number, 'allowance_cents', x.allowance_cents,
                          'payoff_cents', x.payoff_cents) order by x.serial_number, x.allowance_cents)
                        from pm.dealer_trades x where x.org_id = d.org_id and x.deal_id = d.id and x.status = 'APPRAISED'), '[]'::jsonb),
    'fi_products', coalesce((select jsonb_agg(jsonb_build_object('product_type', x.product_type, 'price_cents', x.price_cents,
                               'term_months', x.term_months) order by x.product_type, x.price_cents)
                             from pm.dealer_fi_products x where x.org_id = d.org_id and x.deal_id = d.id), '[]'::jsonb),
    'tax_exempt', d.tax_exempt, 'tax_rate_estimate', d.tax_rate_estimate, 'customer_id', d.customer_id)
  from pm.dealer_deals d where d.id = p_deal
$$;

-- Full deal breakdown (DEALER_DEAL_FINALIZED payload body; quote snapshot).
create or replace function pm.dealer_deal_snapshot(p_deal uuid) returns jsonb
language sql stable
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_id', x.id, 'line_no', x.line_no, 'line_type', x.line_type,
                         'unit_id', x.asset_id, 'part_id', x.part_id, 'item_id', coalesce(p.item_id, a.item_id),
                         'description', x.description, 'qty', x.qty, 'unit_price_cents', x.unit_price_cents,
                         'amount_cents', x.amount_cents, 'cost_cents', x.cost_cents, 'taxable', x.taxable,
                         'program_ref', x.program_ref, 'oem_vendor_id', x.oem_vendor_id, 'rebate_treatment', x.rebate_treatment)
                       order by x.sort, x.line_no, x.id)
                       from pm.dealer_deal_lines x
                       left join pm.parts p on p.org_id = x.org_id and p.id = x.part_id
                       left join pm.assets a on a.org_id = x.org_id and a.id = x.asset_id
                       where x.org_id = d.org_id and x.deal_id = d.id), '[]'::jsonb),
    'trades', coalesce((select jsonb_agg(jsonb_build_object('trade_id', x.id, 'status', x.status, 'unit_id', coalesce(x.received_asset_id, x.asset_id),
                          'serial_number', x.serial_number, 'make', x.make, 'model', x.model, 'model_year', x.model_year,
                          'meter_reading', x.meter_reading, 'acv_cents', x.acv_cents, 'allowance_cents', x.allowance_cents,
                          'over_allowance_cents', x.over_allowance_cents, 'payoff_cents', x.payoff_cents,
                          'lienholder_vendor_id', x.lienholder_vendor_id, 'lien_account_ref', x.lien_account_ref,
                          'source_ref', 'pm:trade:' || x.id::text || ':received') order by x.created_at, x.id)
                        from pm.dealer_trades x where x.org_id = d.org_id and x.deal_id = d.id and x.status <> 'VOID'), '[]'::jsonb),
    'fi_products', coalesce((select jsonb_agg(jsonb_build_object('fi_id', x.id, 'product_type', x.product_type,
                               'provider_vendor_id', x.provider_vendor_id, 'description', x.description, 'price_cents', x.price_cents,
                               'cost_cents', x.cost_cents, 'term_months', x.term_months, 'contract_number', x.contract_number)
                             order by x.sort, x.created_at, x.id)
                             from pm.dealer_fi_products x where x.org_id = d.org_id and x.deal_id = d.id), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(jsonb_build_object('deposit_id', x.id, 'source_ref', x.source_ref, 'amount_cents', x.amount_cents,
                            'status', x.status, 'invoice_id', x.invoice_id) order by x.created_at, x.id)
                          from pm.dealer_deposits x where x.org_id = d.org_id and x.deal_id = d.id and x.status <> 'VOID'), '[]'::jsonb),
    'totals', pm.dealer_deal_totals(d.id))
  from pm.dealer_deals d where d.id = p_deal
$$;

-- Put units held by a deal back to their prior status (cancel / reopen paths).
create or replace function pm.dealer_release_deal_units(p_org uuid, p_deal uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare n int;
begin
  update pm.assets a
     set unit_status = case when a.unit_status in ('ON_HOLD','SOLD') then
                              case when a.unit_hold_prior_status = 'PDI'
                                        and not exists (select 1 from pm.work_orders w where w.org_id = a.org_id and w.asset_id = a.id
                                                          and w.kind = 'PDI' and w.status not in ('COMPLETE','CLOSED','CANCELLED'))
                                   then 'IN_STOCK' else coalesce(a.unit_hold_prior_status, 'IN_STOCK') end
                            else a.unit_status end,
         deal_id = null, unit_hold_prior_status = null, unit_sold_on = null
   where a.org_id = p_org and a.deal_id = p_deal and a.unit_status in ('ON_ORDER','IN_TRANSIT','PDI','DEMO','ON_HOLD','SOLD');
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function pm.create_deal(p_location uuid, p_customer uuid default null, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; s pm.dealer_settings%rowtype; v_id uuid := gen_random_uuid(); v_num text; v_attrs jsonb := coalesce(p_attrs, '{}');
        v_fin text := upper(coalesce(nullif(v_attrs ->> 'finance_type', ''), 'CASH'));
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_customer is not null and not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = v_org and c.deleted_at is null) then
    raise exception 'PM_UNKNOWN_CUSTOMER: %', p_customer using errcode = 'P0002';
  end if;
  s := pm.dealer_settings_row(v_org, p_location);
  v_num := pm.dealer_doc_number(v_org, 'DL');
  insert into pm.dealer_deals (id, org_id, location_id, number, customer_id, salesperson_user_id, tax_rate_estimate, tax_exempt,
                               tax_exempt_ref, finance_type, finance_vendor_id, delivery_checklist, is_sample, notes, created_by)
  values (v_id, v_org, p_location, v_num, p_customer, coalesce(nullif(v_attrs ->> 'salesperson_user_id', ''), pm.current_user_id()),
          coalesce(nullif(v_attrs ->> 'tax_rate_estimate', '')::numeric, s.default_tax_rate),
          coalesce((v_attrs ->> 'tax_exempt')::boolean, false), nullif(v_attrs ->> 'tax_exempt_ref', ''), v_fin,
          nullif(v_attrs ->> 'finance_vendor_id', '')::uuid,
          (select coalesce(jsonb_agg(e || jsonb_build_object('done', false)), '[]'::jsonb) from jsonb_array_elements(s.delivery_checklist) e),
          coalesce((v_attrs ->> 'is_sample')::boolean, false), nullif(v_attrs ->> 'notes', ''), pm.current_user_id());
  perform pm.log_activity(v_org, p_location, null, 'deal.created', 'dealer_deals', v_id, format('Started deal %s', v_num),
    jsonb_build_object('customer_id', p_customer));
  return v_id;
end $$;

create or replace function pm.issue_dealer_quote(p_deal uuid, p_valid_until date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_id uuid := gen_random_uuid(); v_ver int; v_num text; v_snap jsonb;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage <> 'QUOTE' then raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is % (quotes are issued in QUOTE)', d.number, d.stage using errcode = '22023'; end if;
  if d.customer_id is null then raise exception 'PRECONDITION_NO_CUSTOMER: a quote is issued to a customer' using errcode = 'P0001'; end if;
  if not exists (select 1 from pm.dealer_deal_lines l where l.org_id = d.org_id and l.deal_id = d.id) then
    raise exception 'PRECONDITION_NO_LINES: deal % has no lines', d.number using errcode = 'P0001';
  end if;
  if p_valid_until is not null and p_valid_until < current_date then raise exception 'PM_INVALID: valid_until is in the past' using errcode = '22023'; end if;
  select coalesce(max(q.version), 0) + 1 into v_ver from pm.dealer_quotes q where q.org_id = d.org_id and q.deal_id = d.id;
  update pm.dealer_quotes set status = 'SUPERSEDED' where org_id = d.org_id and deal_id = d.id and status = 'ISSUED';
  v_num := pm.dealer_doc_number(d.org_id, 'DQ');
  v_snap := pm.dealer_deal_snapshot(d.id) || jsonb_build_object('terms', pm.dealer_deal_terms(d.id));
  insert into pm.dealer_quotes (id, org_id, location_id, deal_id, number, version, customer_id, valid_until, snapshot, totals, issued_by)
  values (v_id, d.org_id, d.location_id, d.id, v_num, v_ver, d.customer_id, coalesce(p_valid_until, current_date + 30), v_snap,
          v_snap -> 'totals', pm.current_user_id());
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.quoted', 'dealer_quotes', v_id,
    format('Quote %s v%s on deal %s', v_num, v_ver, d.number), jsonb_build_object('deal_id', d.id, 'totals', v_snap -> 'totals'));
  return v_id;
end $$;

create or replace function pm.write_deal(p_deal uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; r record; n int;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage <> 'QUOTE' then raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is %', d.number, d.stage using errcode = '22023'; end if;
  if d.customer_id is null then raise exception 'PRECONDITION_NO_CUSTOMER: write the deal to a customer' using errcode = 'P0001'; end if;
  select count(*) into n from pm.dealer_deal_lines l where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT';
  if n = 0 then raise exception 'PRECONDITION_NO_UNIT: deal % has no unit line', d.number using errcode = 'P0001'; end if;
  for r in select a.id, a.unit_status, a.deal_id, a.stock_number, a.serial_number
           from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
           where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT'
           order by a.id for update of a loop
    if r.deal_id is not null and r.deal_id <> d.id then
      raise exception 'PM_UNIT_ON_ANOTHER_DEAL: unit % is on another deal', coalesce(r.stock_number, r.serial_number) using errcode = '22023';
    end if;
    if r.unit_status not in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO') and not (r.unit_status = 'ON_HOLD' and r.deal_id = d.id) then
      raise exception 'PM_UNIT_NOT_AVAILABLE: unit % is %', coalesce(r.stock_number, r.serial_number), r.unit_status using errcode = '22023';
    end if;
    update pm.assets
       set deal_id = d.id,
           unit_hold_prior_status = case when r.deal_id = d.id then unit_hold_prior_status else r.unit_status end,
           unit_status = case when r.unit_status in ('IN_STOCK','DEMO') then 'ON_HOLD' else r.unit_status end
     where id = r.id;
  end loop;
  update pm.dealer_deals set stage = 'WRITTEN', stage_entered_at = now() where id = d.id;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.written', 'dealer_deals', d.id,
    format('Deal %s written (buyer''s order)', d.number), jsonb_build_object('units', n));
  return d.id;
end $$;

create or replace function pm.accept_dealer_quote(p_quote uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare q pm.dealer_quotes%rowtype; d pm.dealer_deals%rowtype;
begin
  select * into q from pm.dealer_quotes x where x.id = p_quote for update;
  if q.org_id is null or q.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: quote % not found in the caller''s organization', p_quote using errcode = '42501';
  end if;
  if q.status <> 'ISSUED' then raise exception 'PM_QUOTE_NOT_OPEN: quote % is %', q.number, q.status using errcode = '22023'; end if;
  if q.valid_until < current_date then raise exception 'PM_QUOTE_EXPIRED: quote % expired %', q.number, q.valid_until using errcode = '22023'; end if;
  select * into d from pm.dealer_deals x where x.org_id = q.org_id and x.id = q.deal_id for update;
  if pm.dealer_deal_terms(d.id) is distinct from q.snapshot -> 'terms' then
    raise exception 'PM_QUOTE_STALE: the deal changed after quote % was issued; issue a new quote', q.number using errcode = '22023';
  end if;
  update pm.dealer_quotes set status = 'ACCEPTED', decided_by = pm.current_user_id(), decided_at = now() where id = q.id;
  perform pm.write_deal(d.id);
  perform pm.log_activity(q.org_id, q.location_id, null, 'deal.quote_accepted', 'dealer_quotes', q.id,
    format('Quote %s accepted', q.number), jsonb_build_object('deal_id', d.id));
  return d.id;
end $$;

create or replace function pm.decline_dealer_quote(p_quote uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare q pm.dealer_quotes%rowtype;
begin
  select * into q from pm.dealer_quotes x where x.id = p_quote for update;
  if q.org_id is null or q.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: quote % not found in the caller''s organization', p_quote using errcode = '42501';
  end if;
  if q.status <> 'ISSUED' then raise exception 'PM_QUOTE_NOT_OPEN: quote % is %', q.number, q.status using errcode = '22023'; end if;
  update pm.dealer_quotes set status = 'DECLINED', decided_by = pm.current_user_id(), decided_at = now(), decline_reason = p_reason where id = q.id;
  perform pm.log_activity(q.org_id, q.location_id, null, 'deal.quote_declined', 'dealer_quotes', q.id,
    format('Quote %s declined', q.number), jsonb_build_object('reason', p_reason));
  return q.id;
end $$;

-- Manager desk approval. SoD: never the preparer or the salesperson. Desk roles approve at or above
-- the margin floor; below it the floor-override roles must approve AND give a reason.
create or replace function pm.approve_deal(p_deal uuid, p_override_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; s pm.dealer_settings%rowtype; v_me text := pm.current_user_id(); t jsonb; v_pct numeric;
        v_front bigint; v_below boolean; v_appr jsonb; v_unappraised int;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage <> 'WRITTEN' then raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is % (approve a WRITTEN deal)', d.number, d.stage using errcode = '22023'; end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  if v_me = d.created_by or v_me = d.salesperson_user_id then
    raise exception 'PM_SOD_VIOLATION: the salesperson or preparer of deal % cannot desk it', d.number using errcode = '42501';
  end if;
  s := pm.dealer_settings_row(d.org_id, d.location_id);
  if not pm.dealer_actor_satisfies(d.org_id, v_me, s.desk_roles) then
    raise exception 'PM_APPROVAL_ROLE: desking a deal needs role %; approver has %', s.desk_roles,
      coalesce(pm.dealer_actor_role(d.org_id, v_me), '(none)') using errcode = '42501';
  end if;
  select count(*) into v_unappraised from pm.dealer_trades x where x.org_id = d.org_id and x.deal_id = d.id and x.status = 'APPRAISED' and x.acv_cents is null;
  if v_unappraised > 0 then raise exception 'PRECONDITION_TRADE_NOT_APPRAISED: % trade(s) on % have no ACV', v_unappraised, d.number using errcode = 'P0001'; end if;
  -- re-pin unit costs (PDI and freight may have landed since the line was written)
  update pm.dealer_deal_lines l set cost_cents = a.dealer_cost_cents
    from pm.assets a where a.org_id = l.org_id and a.id = l.asset_id and l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT'
      and l.cost_cents is distinct from a.dealer_cost_cents;
  t := pm.dealer_deal_totals(d.id);
  v_pct := (t ->> 'front_gross_pct')::numeric;
  v_front := (t ->> 'front_gross_cents')::bigint;
  v_below := (v_pct is not null and v_pct < s.margin_floor_pct) or v_front < s.min_front_gross_cents;
  if v_below then
    if not pm.dealer_actor_satisfies(d.org_id, v_me, s.floor_override_roles) then
      raise exception 'PM_DEAL_MARGIN_FLOOR: front gross % cents (% of sale) is below the floor (% / % cents); needs role %, approver has %',
        v_front, coalesce(round(v_pct * 100, 2)::text || '%', 'n/a'), round(s.margin_floor_pct * 100, 2)::text || '%', s.min_front_gross_cents,
        s.floor_override_roles, coalesce(pm.dealer_actor_role(d.org_id, v_me), '(none)') using errcode = '42501';
    end if;
    if nullif(btrim(coalesce(p_override_reason, '')), '') is null then
      raise exception 'PM_DEAL_MARGIN_FLOOR_REASON: approving deal % below the margin floor needs a reason', d.number using errcode = '22023';
    end if;
  end if;
  v_appr := jsonb_build_object('rule', case when v_below then 'FLOOR_OVERRIDE' else 'DESK' end,
    'front_gross_cents', v_front, 'front_gross_pct', v_pct, 'margin_floor_pct', s.margin_floor_pct,
    'min_front_gross_cents', s.min_front_gross_cents, 'roles', to_jsonb(case when v_below then s.floor_override_roles else s.desk_roles end),
    'approver_role', pm.dealer_actor_role(d.org_id, v_me), 'override_reason', case when v_below then btrim(p_override_reason) end);
  update pm.dealer_deals set stage = 'APPROVED', stage_entered_at = now(), approved_by = v_me, approved_at = now(), approval = v_appr,
         approved_totals = t
   where id = d.id;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.approved', 'dealer_deals', d.id,
    format('Deal %s approved (%s gross, %s)', d.number, v_front + (t ->> 'back_gross_cents')::bigint, lower(v_appr ->> 'rule')), v_appr);
  return v_appr || jsonb_build_object('totals', t);
end $$;

create or replace function pm.reopen_deal(p_deal uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage not in ('APPROVED','FUNDED') then raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is %', d.number, d.stage using errcode = '22023'; end if;
  update pm.assets set unit_status = 'ON_HOLD', unit_sold_on = null
   where org_id = d.org_id and deal_id = d.id and unit_status = 'SOLD';
  update pm.dealer_deals set stage = 'WRITTEN', stage_entered_at = now(), approved_by = null, approved_at = null, approval = null,
         approved_totals = null, funded_at = null, funded_by = null
   where id = d.id;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.reopened', 'dealer_deals', d.id,
    format('Deal %s reopened (approval cleared)', d.number), jsonb_build_object('from', d.stage, 'reason', p_reason));
  return d.id;
end $$;

-- FUNDED / READY: cash received or financing approved. Units become SOLD (sold, not yet delivered).
create or replace function pm.mark_deal_funded(p_deal uuid, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_attrs jsonb := coalesce(p_attrs, '{}'); v_on date := coalesce(nullif(v_attrs ->> 'funded_on', '')::date, current_date);
        v_bad text;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage <> 'APPROVED' then raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is % (fund an APPROVED deal)', d.number, d.stage using errcode = '22023'; end if;
  select string_agg(coalesce(a.stock_number, a.serial_number) || ' ' || a.unit_status, ', ') into v_bad
  from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
  where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT' and (a.deal_id is distinct from d.id or a.unit_status not in ('ON_HOLD','PDI'));
  if v_bad is not null then raise exception 'PM_UNIT_NOT_RECEIVED: units not in stock for this deal: %', v_bad using errcode = '22023'; end if;
  update pm.assets set unit_status = 'SOLD', unit_sold_on = v_on where org_id = d.org_id and deal_id = d.id and unit_status in ('ON_HOLD','PDI');
  update pm.dealer_deals set stage = 'FUNDED', stage_entered_at = now(), funded_at = now(), funded_by = pm.current_user_id(),
         finance_ref = coalesce(nullif(v_attrs ->> 'finance_ref', ''), finance_ref),
         amount_financed_cents = coalesce(nullif(v_attrs ->> 'amount_financed_cents', '')::bigint, amount_financed_cents)
   where id = d.id;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.funded', 'dealer_deals', d.id,
    format('Deal %s funded / ready for delivery', d.number), jsonb_build_object('funded_on', v_on, 'finance_ref', v_attrs ->> 'finance_ref'));
  return d.id;
end $$;

create or replace function pm.check_deal_delivery_item(p_deal uuid, p_key text, p_done boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v jsonb;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage in ('DELIVERED','UNWOUND','LOST') then raise exception 'PM_DEAL_LOCKED: deal % is %', d.number, d.stage using errcode = '55000'; end if;
  if not exists (select 1 from jsonb_array_elements(d.delivery_checklist) e where e ->> 'key' = p_key) then
    raise exception 'PM_INVALID: % is not on the delivery checklist', p_key using errcode = '22023';
  end if;
  select jsonb_agg(case when e ->> 'key' = p_key
                        then e || jsonb_build_object('done', coalesce(p_done, true),
                                                     'done_by', case when coalesce(p_done, true) then pm.current_user_id() end,
                                                     'done_at', case when coalesce(p_done, true) then now() end)
                        else e end)
    into v from jsonb_array_elements(d.delivery_checklist) e;
  update pm.dealer_deals set delivery_checklist = v where id = d.id;
  return v;
end $$;

-- Trade-in becomes a used unit in stock (same serial master). Internal; caller holds the deal lock.
create or replace function pm.dealer_receive_trade(p_trade uuid, p_on date) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.dealer_trades%rowtype; d pm.dealer_deals%rowtype; a pm.assets%rowtype; s pm.dealer_settings%rowtype;
        v_value bigint; v_cost uuid;
begin
  select * into t from pm.dealer_trades x where x.id = p_trade for update;
  select * into d from pm.dealer_deals x where x.org_id = t.org_id and x.id = t.deal_id;
  s := pm.dealer_settings_row(d.org_id, d.location_id);
  if t.asset_id is not null then
    select * into a from pm.assets x where x.org_id = t.org_id and x.id = t.asset_id for update;
  else
    select * into a from pm.assets x
    where x.org_id = t.org_id and lower(x.serial_number) = lower(t.serial_number)
      and (t.make is null or lower(coalesce(x.make, '')) = lower(t.make))
    order by (x.customer_id is not distinct from d.customer_id) desc, x.created_at limit 1
    for update;
  end if;
  if a.id is not null and a.unit_status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','RENTAL','ON_HOLD','SOLD') then
    raise exception 'PM_TRADE_UNIT_IN_STOCK: trade serial % is already dealer inventory', coalesce(t.serial_number, a.serial_number) using errcode = '22023';
  end if;
  if a.id is null then
    insert into pm.assets (org_id, location_id, kind, serial_number, make, model, model_year, description, ext, created_by)
    values (t.org_id, d.location_id, 'DEALER_UNIT', t.serial_number, t.make, t.model, t.model_year, t.description, '{}'::jsonb, pm.current_user_id())
    returning * into a;
  end if;
  update pm.assets x set
    kind = 'DEALER_UNIT', customer_id = null, status = 'ACTIVE', retired_on = null, location_id = d.location_id,
    model = coalesce(x.model, t.model), model_year = coalesce(x.model_year, t.model_year),
    condition = 'USED', unit_status = 'IN_STOCK', unit_hold_prior_status = null, unit_life = x.unit_life + 1,
    stock_number = pm.dealer_mint_stock_number(t.org_id, 'USED'), stock_location_id = s.unit_stock_location_id,
    received_on = p_on, mfr_invoice_ref = null, deal_id = null, unit_sold_on = null, unit_delivered_on = null,
    meter_reading = coalesce(t.meter_reading, x.meter_reading), meter_read_on = case when t.meter_reading is not null then p_on else x.meter_read_on end,
    floored = false, floor_status = null, payoff_cents = null, payoff_due_on = null, payoff_scheduled = false, sot_alert_at = null, sot_alert = null,
    is_sample = d.is_sample
  where x.id = a.id
  returning * into a;
  -- operational value: the default Books policy (lower of ACV and allowance); Books books the basis
  v_value := least(coalesce(t.acv_cents, 0), t.allowance_cents);
  if v_value > 0 then
    v_cost := gen_random_uuid();
    insert into pm.dealer_unit_costs (id, org_id, location_id, asset_id, unit_life, cost_type, amount_cents, source, memo, source_ref, created_by)
    values (v_cost, a.org_id, a.location_id, a.id, a.unit_life, 'BASE_INVOICE', v_value, 'TRADE_IN',
            format('Trade-in on deal %s (lower of ACV and allowance)', d.number), 'pm:unitcost:' || v_cost::text, pm.current_user_id());
  end if;
  perform pm.dealer_refresh_unit_cost(a.id);
  update pm.dealer_trades set status = 'RECEIVED', received_at = now(), received_asset_id = a.id where id = t.id;
  return a.id;
end $$;

-- Delivery: the checklist, the floor-plan payoff guard, then units → DELIVERED (customer equipment
-- from here on), trades → used units, DEALER_DEAL_FINALIZED, one DEALER_TRADE_RECEIVED per trade.
create or replace function pm.deliver_deal(p_deal uuid, p_acknowledge_payoff boolean default false, p_delivered_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; s pm.dealer_settings%rowtype; v_me text := pm.current_user_id(); v_on date := coalesce(p_delivered_on, current_date);
        v_missing text; v_bad text; v_due jsonb; v_ack jsonb; t jsonb; v_snap jsonb; v_out uuid; v_units jsonb; r record; v_tout uuid;
        v_pdi_ok boolean;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage <> 'FUNDED' then raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is % (deliver a FUNDED deal)', d.number, d.stage using errcode = '22023'; end if;
  s := pm.dealer_settings_row(d.org_id, d.location_id);

  -- PDI auto-ticks when every NEW unit has a finished PDI order
  select bool_and(exists (select 1 from pm.work_orders w where w.org_id = a.org_id and w.asset_id = a.id and w.kind = 'PDI'
                            and w.status in ('COMPLETE','CLOSED')))
    into v_pdi_ok
  from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
  where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT' and a.condition = 'NEW';
  if coalesce(v_pdi_ok, false) then
    update pm.dealer_deals x set delivery_checklist = (select jsonb_agg(case when e ->> 'key' = 'pdi_complete' and not coalesce((e ->> 'done')::boolean, false)
                                                                         then e || jsonb_build_object('done', true, 'done_by', 'system:pdi_closed', 'done_at', now())
                                                                         else e end)
                                                       from jsonb_array_elements(x.delivery_checklist) e)
     where x.id = d.id returning * into d;
  end if;
  select string_agg(e ->> 'key', ', ') into v_missing from jsonb_array_elements(d.delivery_checklist) e
  where coalesce((e ->> 'required')::boolean, false) and not coalesce((e ->> 'done')::boolean, false);
  if v_missing is not null then
    raise exception 'PM_DELIVERY_CHECKLIST_INCOMPLETE: deal % still needs: %', d.number, v_missing using errcode = 'P0001';
  end if;
  select string_agg(coalesce(a.stock_number, a.serial_number) || ' ' || a.unit_status, ', ') into v_bad
  from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
  where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT' and (a.deal_id is distinct from d.id or a.unit_status <> 'SOLD');
  if v_bad is not null then raise exception 'PM_UNIT_NOT_SOLD: units not sold on this deal: %', v_bad using errcode = '22023'; end if;

  -- floor-plan payoff guard (read model fed by Books' DEALER_FLOOR_STATUS)
  select jsonb_agg(jsonb_build_object('unit_id', a.id, 'stock_number', a.stock_number, 'serial_number', a.serial_number,
           'payoff_cents', a.payoff_cents, 'payoff_due_on', a.payoff_due_on, 'note_ref', a.floor_note_ref,
           'lender_vendor_id', a.floor_lender_vendor_id, 'floor_status', a.floor_status) order by a.stock_number)
    into v_due
  from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
  where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT'
    and a.floored and coalesce(a.payoff_cents, 0) > 0 and not a.payoff_scheduled;
  if v_due is not null and s.payoff_guard <> 'OFF' then
    if s.payoff_guard = 'BLOCK' then
      raise exception 'PM_DELIVERY_PAYOFF_BLOCKED: floored unit(s) need a scheduled payoff before delivery: %', v_due using errcode = 'P0001';
    end if;
    if not coalesce(p_acknowledge_payoff, false) then
      raise exception 'PM_DELIVERY_PAYOFF_DUE: floor-plan payoff due on delivery (sold out of trust if not paid): %; acknowledge to deliver', v_due
        using errcode = 'P0001';
    end if;
    if not pm.dealer_actor_satisfies(d.org_id, v_me, s.payoff_ack_roles) then
      raise exception 'PM_APPROVAL_ROLE: acknowledging a floor-plan payoff needs role %; you have %', s.payoff_ack_roles,
        coalesce(pm.dealer_actor_role(d.org_id, v_me), '(none)') using errcode = '42501';
    end if;
    v_ack := jsonb_build_object('acknowledged_by', v_me, 'acknowledged_at', now(), 'units', v_due);
  end if;

  update pm.dealer_deal_lines l set cost_cents = a.dealer_cost_cents
    from pm.assets a where a.org_id = l.org_id and a.id = l.asset_id and l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT'
      and l.cost_cents is distinct from a.dealer_cost_cents;

  select jsonb_agg(pm.dealer_unit_json(a.id) || jsonb_build_object('sale_price_cents', l.amount_cents, 'cost_cents', l.cost_cents,
           'floor', jsonb_build_object('floored', a.floored, 'floor_status', a.floor_status, 'payoff_cents', a.payoff_cents,
                                       'payoff_due_on', a.payoff_due_on, 'note_ref', a.floor_note_ref, 'lender_vendor_id', a.floor_lender_vendor_id,
                                       'payoff_scheduled', a.payoff_scheduled)) order by l.sort, l.line_no, l.id)
    into v_units
  from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
  where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT';

  update pm.assets set unit_status = 'DELIVERED', kind = 'CUSTOMER_EQUIPMENT', customer_id = d.customer_id,
         unit_delivered_on = v_on, unit_sold_on = coalesce(unit_sold_on, v_on), unit_hold_prior_status = null
   where org_id = d.org_id and deal_id = d.id and unit_status = 'SOLD';

  for r in select x.id from pm.dealer_trades x where x.org_id = d.org_id and x.deal_id = d.id and x.status = 'APPRAISED' order by x.created_at, x.id loop
    perform pm.dealer_receive_trade(r.id, v_on);
  end loop;

  t := pm.dealer_deal_totals(d.id);
  v_snap := pm.dealer_deal_snapshot(d.id);
  update pm.dealer_deals set stage = 'DELIVERED', stage_entered_at = now(), delivered_on = v_on, delivered_at = now(), delivered_by = v_me,
         final_totals = t, payoff_ack = v_ack
   where id = d.id;

  v_out := pm.dealer_emit(d.org_id, d.location_id, 'DEALER_DEAL_FINALIZED', 'pm:deal:' || d.id::text || ':finalized',
    jsonb_build_object(
      'deal_id', d.id, 'deal_number', d.number, 'customer_id', d.customer_id, 'salesperson_user_id', d.salesperson_user_id,
      'delivered_on', to_char(v_on, 'YYYY-MM-DD'), 'approved_by', d.approved_by, 'approved_at', d.approved_at, 'approval', d.approval,
      'units', coalesce(v_units, '[]'::jsonb), 'lines', v_snap -> 'lines', 'trades', v_snap -> 'trades',
      'fi_products', v_snap -> 'fi_products', 'deposits', v_snap -> 'deposits',
      'fees', coalesce((select jsonb_agg(x) from jsonb_array_elements(v_snap -> 'lines') x where x ->> 'line_type' = 'FEE'), '[]'::jsonb),
      'rebates', coalesce((select jsonb_agg(x) from jsonb_array_elements(v_snap -> 'lines') x where x ->> 'line_type' in ('REBATE','INCENTIVE')), '[]'::jsonb),
      'finance', jsonb_build_object('type', d.finance_type, 'vendor_id', d.finance_vendor_id,
                                    'amount_financed_cents', coalesce(d.amount_financed_cents, case when d.finance_type <> 'CASH' then (t ->> 'balance_due_estimate_cents')::bigint end),
                                    'reserve_cents', d.finance_reserve_cents, 'subvention_cents', d.subvention_cents, 'finance_ref', d.finance_ref),
      'tax', jsonb_build_object('estimate_cents', t -> 'tax_estimate_cents', 'rate_estimate', d.tax_rate_estimate,
                                'taxable_estimate_cents', t -> 'taxable_estimate_cents', 'exempt', d.tax_exempt, 'exempt_ref', d.tax_exempt_ref,
                                'computed_by', 'BOOKS'),
      'totals', t,
      'floor_payoffs', coalesce(v_ack -> 'units', '[]'::jsonb), 'floor_payoff_ack', v_ack),
    v_on, d.is_sample, 'dealer_deals', d.id, null);
  update pm.dealer_deals set finalized_outbox_id = v_out where id = d.id;

  for r in select x.* from pm.dealer_trades x where x.org_id = d.org_id and x.deal_id = d.id and x.status = 'RECEIVED' and x.outbox_id is null
           order by x.created_at, x.id loop
    v_tout := pm.dealer_emit(d.org_id, d.location_id, 'DEALER_TRADE_RECEIVED', 'pm:trade:' || r.id::text || ':received',
      pm.dealer_unit_json(r.received_asset_id) || jsonb_build_object(
        'trade_id', r.id, 'deal_id', d.id, 'deal_number', d.number, 'deal_source_ref', 'pm:deal:' || d.id::text || ':finalized',
        'customer_id', d.customer_id, 'received_on', to_char(v_on, 'YYYY-MM-DD'), 'meter_reading', r.meter_reading,
        'acv_cents', r.acv_cents, 'allowance_cents', r.allowance_cents, 'over_allowance_cents', r.over_allowance_cents,
        'payoff_cents', r.payoff_cents, 'lienholder_vendor_id', r.lienholder_vendor_id, 'lien_account_ref', r.lien_account_ref,
        'appraised_by', r.appraised_by, 'operational_value_cents', least(coalesce(r.acv_cents, 0), r.allowance_cents),
        'valuation', 'BOOKS_POLICY', 'is_trade_in', true),
      v_on, d.is_sample, 'dealer_trades', r.id, null);
    update pm.dealer_trades set outbox_id = v_tout where id = r.id;
    update pm.dealer_unit_costs set outbox_id = v_tout
     where org_id = d.org_id and asset_id = r.received_asset_id and source = 'TRADE_IN' and outbox_id is null;
  end loop;

  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.delivered', 'dealer_deals', d.id,
    format('Deal %s delivered (%s total gross)', d.number, t ->> 'total_gross_cents'),
    jsonb_build_object('outbox_id', v_out, 'totals', t, 'payoff_ack', v_ack));
  return v_out;
end $$;

create or replace function pm.unwind_deal(p_deal uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; s pm.dealer_settings%rowtype; v_me text := pm.current_user_id(); v_bad text; v_out uuid; v_fin uuid;
        v_units jsonb; v_trades jsonb;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage <> 'DELIVERED' then raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is % (unwind a DELIVERED deal; cancel an open one)', d.number, d.stage using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: an unwind needs a reason' using errcode = '22023'; end if;
  s := pm.dealer_settings_row(d.org_id, d.location_id);
  if not pm.dealer_actor_satisfies(d.org_id, v_me, s.unwind_roles) then
    raise exception 'PM_APPROVAL_ROLE: unwinding a delivered deal needs role %; you have %', s.unwind_roles,
      coalesce(pm.dealer_actor_role(d.org_id, v_me), '(none)') using errcode = '42501';
  end if;
  select string_agg(coalesce(a.stock_number, a.serial_number) || ' ' || coalesce(a.unit_status, '?'), ', ') into v_bad
  from pm.dealer_trades t join pm.assets a on a.org_id = t.org_id and a.id = t.received_asset_id
  where t.org_id = d.org_id and t.deal_id = d.id and t.status = 'RECEIVED' and (a.unit_status <> 'IN_STOCK' or a.deal_id is not null);
  if v_bad is not null then
    raise exception 'PM_UNWIND_TRADE_RESOLD: trade unit(s) are no longer free in stock: %', v_bad using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', a.id, 'stock_number', a.stock_number, 'serial_number', a.serial_number,
                                               'resulting_status', 'IN_STOCK')), '[]'::jsonb)
    into v_units from pm.assets a where a.org_id = d.org_id and a.deal_id = d.id and a.unit_status = 'DELIVERED';
  update pm.assets set unit_status = 'IN_STOCK', kind = case when condition = 'RENTAL' then 'RENTAL_UNIT' else 'DEALER_UNIT' end,
         customer_id = null, deal_id = null, unit_sold_on = null, unit_delivered_on = null, unit_hold_prior_status = null
   where org_id = d.org_id and deal_id = d.id and unit_status = 'DELIVERED';
  select coalesce(jsonb_agg(jsonb_build_object('trade_id', t.id, 'unit_id', t.received_asset_id, 'serial_number', t.serial_number,
                                               'reverses_source_ref', 'pm:trade:' || t.id::text || ':received', 'disposition', 'RETURNED_TO_CUSTOMER')), '[]'::jsonb)
    into v_trades from pm.dealer_trades t where t.org_id = d.org_id and t.deal_id = d.id and t.status = 'RECEIVED';
  update pm.dealer_unit_costs c set status = 'VOID'
    from pm.dealer_trades t, pm.assets a
   where t.org_id = d.org_id and t.deal_id = d.id and t.status = 'RECEIVED' and a.org_id = t.org_id and a.id = t.received_asset_id
     and c.org_id = a.org_id and c.asset_id = a.id and c.unit_life = a.unit_life and c.status = 'ACTIVE';
  update pm.assets a set kind = 'CUSTOMER_EQUIPMENT', customer_id = d.customer_id, unit_status = null, condition = null,
         stock_location_id = null, received_on = null, dealer_cost_cents = 0
    from pm.dealer_trades t
   where t.org_id = d.org_id and t.deal_id = d.id and t.status = 'RECEIVED' and a.org_id = t.org_id and a.id = t.received_asset_id;
  update pm.dealer_trades set status = 'UNWOUND' where org_id = d.org_id and deal_id = d.id and status = 'RECEIVED';
  update pm.dealer_deals set stage = 'UNWOUND', stage_entered_at = now(), unwound_at = now(), unwound_by = v_me, unwind_reason = btrim(p_reason)
   where id = d.id;
  select o.event_id into v_fin from pm.dealer_outbox o where o.org_id = d.org_id and o.id = d.finalized_outbox_id;
  v_out := pm.dealer_emit(d.org_id, d.location_id, 'DEALER_DEAL_UNWOUND', 'pm:deal:' || d.id::text || ':unwound',
    jsonb_build_object('deal_id', d.id, 'deal_number', d.number, 'customer_id', d.customer_id,
      'reverses_source_ref', 'pm:deal:' || d.id::text || ':finalized', 'reverses_event_id', v_fin,
      'unwound_on', to_char(current_date, 'YYYY-MM-DD'), 'reason', btrim(p_reason), 'units', v_units, 'trades', v_trades,
      'deposits', coalesce((select jsonb_agg(jsonb_build_object('deposit_id', x.id, 'source_ref', x.source_ref, 'amount_cents', x.amount_cents))
                            from pm.dealer_deposits x where x.org_id = d.org_id and x.deal_id = d.id and x.status <> 'VOID'), '[]'::jsonb),
      'final_totals', d.final_totals),
    current_date, d.is_sample, 'dealer_deals', d.id, null);
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.unwound', 'dealer_deals', d.id,
    format('Deal %s unwound: %s', d.number, btrim(p_reason)), jsonb_build_object('outbox_id', v_out, 'units', v_units, 'trades', v_trades));
  return v_out;
end $$;

create or replace function pm.cancel_deal(p_deal uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; n int;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage not in ('QUOTE','WRITTEN','APPROVED','FUNDED') then
    raise exception 'PM_DEAL_TRANSITION_INVALID: deal % is % (unwind a delivered deal)', d.number, d.stage using errcode = '22023';
  end if;
  n := pm.dealer_release_deal_units(d.org_id, d.id);
  update pm.dealer_trades set status = 'VOID' where org_id = d.org_id and deal_id = d.id and status = 'APPRAISED';
  update pm.dealer_quotes set status = 'EXPIRED' where org_id = d.org_id and deal_id = d.id and status = 'ISSUED';
  update pm.dealer_deals set stage = 'LOST', stage_entered_at = now(), lost_at = now(), lost_reason = p_reason where id = d.id;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.lost', 'dealer_deals', d.id,
    format('Deal %s lost / cancelled (%s unit(s) released)', d.number, n),
    jsonb_build_object('from', d.stage, 'reason', p_reason, 'units_released', n,
      'deposits_open', (select coalesce(sum(x.amount_cents), 0) from pm.dealer_deposits x where x.org_id = d.org_id and x.deal_id = d.id
                        and x.status in ('REQUESTED','ISSUED'))));
  return d.id;
end $$;

-- Customer deposit on a deal: Books' customer-deposits feature holds and applies it (one way to hold
-- deposits); DEALER_DEPOSIT_REQUEST is deduped on source_ref pm:dealdeposit:{id}.
create or replace function pm.request_deal_deposit(p_deal uuid, p_amount_cents bigint, p_memo text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_id uuid := gen_random_uuid(); v_out uuid; v_status text;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage not in ('WRITTEN','APPROVED','FUNDED') then
    raise exception 'PM_DEAL_TRANSITION_INVALID: deposits are taken on a written deal (deal % is %)', d.number, d.stage using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: deposit must be > 0' using errcode = 'P0001'; end if;
  if d.customer_id is null then raise exception 'PRECONDITION_NO_CUSTOMER: deal % has no customer', d.number using errcode = 'P0001'; end if;
  insert into pm.dealer_deposits (id, org_id, location_id, deal_id, customer_id, amount_cents, memo, source_ref, created_by)
  values (v_id, d.org_id, d.location_id, d.id, d.customer_id, p_amount_cents, coalesce(p_memo, 'Deposit on deal ' || d.number),
          'pm:dealdeposit:' || v_id::text, pm.current_user_id());
  v_out := pm.dealer_emit(d.org_id, d.location_id, 'DEALER_DEPOSIT_REQUEST', 'pm:dealdeposit:' || v_id::text,
    jsonb_build_object('deposit_id', v_id, 'deal_id', d.id, 'deal_number', d.number, 'customer_id', d.customer_id,
                       'amount_cents', p_amount_cents, 'memo', coalesce(p_memo, 'Deposit on deal ' || d.number)),
    current_date, d.is_sample, 'dealer_deposits', v_id, null);
  select case o.status when 'SUPPRESSED' then 'SUPPRESSED' else 'REQUESTED' end into v_status from pm.dealer_outbox o where o.id = v_out;
  update pm.dealer_deposits set outbox_id = v_out, status = v_status where id = v_id;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.deposit_requested', 'dealer_deposits', v_id,
    format('Deposit of %s cents requested on deal %s', p_amount_cents, d.number), jsonb_build_object('outbox_id', v_out));
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 10. Parts: catalog, counter, special orders, OEM stock orders, physical counts.
--     On-hand is a QUANTITY projection of pm.material_moves (by core.items id); bins and min/max
--     are pm.stock_targets (1104) per stock location. Books values parts inventory and COGS.
--     OEM stock orders are NOT pm.commitments: those are job-scoped and emit JOB_COMMITMENT (a
--     job-cost AP match target); stock parts are inventory. A special order for an RO may link a
--     job commitment (pm.commitments PO on the RO's job) when the shop wants the job PO.
-- ----------------------------------------------------------------------------
create or replace function pm.resolve_part(p_part uuid) returns uuid
language plpgsql stable
set search_path = pm, core, public
as $$
declare v uuid := p_part; v_next uuid; i int := 0;
begin
  loop
    select p.superseded_by_part_id into v_next from pm.parts p where p.id = v;
    exit when v_next is null or i >= 25;
    v := v_next; i := i + 1;
  end loop;
  return v;
end $$;

-- p_attrs: manufacturer, mfr_vendor_id, uom, category, cost_cents, list_price_cents, price_cents,
--          core_charge_cents, item_id (link an existing core.items row)
create or replace function pm.upsert_part(p_location uuid, p_part_number text, p_description text, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_attrs jsonb := coalesce(p_attrs, '{}'); v_pn text := upper(btrim(coalesce(p_part_number, '')));
        v_mfr text := nullif(upper(btrim(coalesce(v_attrs ->> 'manufacturer', ''))), ''); v_id uuid; v_item uuid; v_sku text;
        v_desc text := nullif(btrim(coalesce(p_description, '')), '');
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_pn = '' then raise exception 'PM_INVALID: part number is required' using errcode = '22023'; end if;
  select p.id into v_id from pm.parts p
  where p.org_id = v_org and p.location_id = p_location and upper(coalesce(p.manufacturer, '')) = coalesce(v_mfr, '')
    and upper(btrim(p.part_number)) = v_pn
  for update;
  if v_id is not null then
    update pm.parts set
      description       = coalesce(v_desc, description),
      uom               = coalesce(nullif(v_attrs ->> 'uom', ''), uom),
      category          = coalesce(nullif(v_attrs ->> 'category', ''), category),
      cost_cents        = coalesce(nullif(v_attrs ->> 'cost_cents', '')::bigint, cost_cents),
      list_price_cents  = coalesce(nullif(v_attrs ->> 'list_price_cents', '')::bigint, list_price_cents),
      price_cents       = coalesce(nullif(v_attrs ->> 'price_cents', '')::bigint, price_cents),
      core_charge_cents = coalesce(nullif(v_attrs ->> 'core_charge_cents', '')::bigint, core_charge_cents),
      mfr_vendor_id     = coalesce(nullif(v_attrs ->> 'mfr_vendor_id', '')::uuid, mfr_vendor_id)
    where id = v_id;
    return v_id;
  end if;
  if v_desc is null then raise exception 'PM_INVALID: a new part needs a description' using errcode = '22023'; end if;
  v_item := nullif(v_attrs ->> 'item_id', '')::uuid;
  if v_item is null then
    v_sku := case when v_mfr is not null then v_mfr || '-' || v_pn else v_pn end;
    v_item := pm.ensure_part_item(v_org, v_sku, v_desc);
  end if;
  insert into pm.parts (org_id, location_id, item_id, part_number, manufacturer, mfr_vendor_id, description, uom, category, cost_cents,
                        list_price_cents, price_cents, core_charge_cents, created_by)
  values (v_org, p_location, v_item, v_pn, v_mfr, nullif(v_attrs ->> 'mfr_vendor_id', '')::uuid, v_desc, coalesce(nullif(v_attrs ->> 'uom', ''), 'EA'),
          nullif(v_attrs ->> 'category', ''), nullif(v_attrs ->> 'cost_cents', '')::bigint, nullif(v_attrs ->> 'list_price_cents', '')::bigint,
          coalesce(nullif(v_attrs ->> 'price_cents', '')::bigint, nullif(v_attrs ->> 'list_price_cents', '')::bigint),
          coalesce(nullif(v_attrs ->> 'core_charge_cents', '')::bigint, 0), pm.current_user_id())
  returning id into v_id;
  perform pm.log_activity(v_org, p_location, null, 'part.created', 'parts', v_id, format('Added part %s %s', coalesce(v_mfr || ' ', ''), v_pn),
    jsonb_build_object('item_id', v_item, 'part_number', v_pn, 'manufacturer', v_mfr));
  return v_id;
end $$;

create or replace function pm.supersede_part(p_old uuid, p_new uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.parts%rowtype; n pm.parts%rowtype;
begin
  select * into o from pm.parts x where x.id = p_old for update;
  select * into n from pm.parts x where x.id = p_new;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() or n.org_id is distinct from o.org_id then
    raise exception 'PM_FORBIDDEN: part not found in the caller''s organization' using errcode = '42501';
  end if;
  if n.location_id <> o.location_id then raise exception 'PM_INVALID: supersession stays on one company' using errcode = '22023'; end if;
  if pm.resolve_part(p_new) = p_old then raise exception 'PM_INVALID: supersession cycle' using errcode = '22023'; end if;
  update pm.parts set superseded_by_part_id = p_new, status = 'SUPERSEDED' where id = p_old;
  perform pm.log_activity(o.org_id, o.location_id, null, 'part.superseded', 'parts', p_old,
    format('%s superseded by %s', o.part_number, n.part_number), jsonb_build_object('new_part_id', p_new));
  return p_new;
end $$;

create or replace function pm.set_part_stocking(p_part uuid, p_stock_location uuid, p_bin text, p_min numeric, p_max numeric default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.parts%rowtype; v_loc uuid;
begin
  select * into p from pm.parts x where x.id = p_part;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: part % not found in the caller''s organization', p_part using errcode = '42501';
  end if;
  select s.location_id into v_loc from pm.stock_locations s where s.id = p_stock_location and s.org_id = p.org_id;
  if v_loc is distinct from p.location_id then raise exception 'PM_INVALID: stock location is not on the part''s company' using errcode = '22023'; end if;
  if p_min is null or p_min < 0 or (p_max is not null and p_max < p_min) then raise exception 'PM_INVALID: 0 ≤ min ≤ max' using errcode = '22023'; end if;
  insert into pm.stock_targets (org_id, stock_location_id, item_id, min_qty, max_qty, uom, bin)
  values (p.org_id, p_stock_location, p.item_id, p_min, p_max, p.uom, nullif(btrim(coalesce(p_bin, '')), ''))
  on conflict (stock_location_id, item_id) do update set min_qty = excluded.min_qty, max_qty = excluded.max_qty, bin = excluded.bin,
    uom = excluded.uom;
  return p_part;
end $$;

create or replace function pm.open_parts_ticket(p_location uuid, p_customer uuid default null, p_stock_location uuid default null,
                                                p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; s pm.dealer_settings%rowtype; v_sl uuid; v_id uuid := gen_random_uuid(); v_num text; v_attrs jsonb := coalesce(p_attrs, '{}');
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_customer is not null and not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = v_org and c.deleted_at is null) then
    raise exception 'PM_UNKNOWN_CUSTOMER: %', p_customer using errcode = 'P0002';
  end if;
  s := pm.dealer_settings_row(v_org, p_location);
  v_sl := coalesce(p_stock_location, s.parts_stock_location_id);
  if v_sl is null or not exists (select 1 from pm.stock_locations x where x.id = v_sl and x.org_id = v_org and x.location_id = p_location) then
    raise exception 'PM_INVALID: a counter ticket needs a stock location on this company' using errcode = '22023';
  end if;
  v_num := pm.dealer_doc_number(v_org, 'PT');
  insert into pm.parts_tickets (id, org_id, location_id, number, customer_id, stock_location_id, tax_rate_estimate, tax_exempt, tax_exempt_ref,
                                po_number, notes, is_sample, created_by)
  values (v_id, v_org, p_location, v_num, p_customer, v_sl, coalesce(nullif(v_attrs ->> 'tax_rate_estimate', '')::numeric, s.default_tax_rate),
          coalesce((v_attrs ->> 'tax_exempt')::boolean, false), nullif(v_attrs ->> 'tax_exempt_ref', ''), nullif(v_attrs ->> 'po_number', ''),
          nullif(v_attrs ->> 'notes', ''), coalesce((v_attrs ->> 'is_sample')::boolean, false), pm.current_user_id());
  return v_id;
end $$;

-- Close a counter ticket: stock issues (material_moves ISSUE on the ticket), special orders for
-- the unfilled quantity the customer wants, DEALER_PARTS_SALE when anything left the shelf.
create or replace function pm.close_parts_ticket(p_ticket uuid, p_payment_method text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.parts_tickets%rowtype; s pm.dealer_settings%rowtype; r record; v_short text; v_out uuid; v_lines jsonb; v_tot jsonb;
        v_move uuid; v_so uuid; v_pay text := nullif(upper(btrim(coalesce(p_payment_method, ''))), '');
begin
  select * into t from pm.parts_tickets x where x.id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status <> 'OPEN' then raise exception 'PM_TICKET_TRANSITION_INVALID: % is %', t.number, t.status using errcode = '22023'; end if;
  if not exists (select 1 from pm.parts_ticket_lines l where l.org_id = t.org_id and l.ticket_id = t.id) then
    raise exception 'PRECONDITION_NO_LINES: ticket % has no lines', t.number using errcode = 'P0001';
  end if;
  if v_pay = 'CHARGE' and t.customer_id is null then
    raise exception 'PRECONDITION_NO_CUSTOMER: a charge sale needs a customer account' using errcode = 'P0001';
  end if;
  s := pm.dealer_settings_row(t.org_id, t.location_id);
  if not s.allow_negative_parts then
    select string_agg(format('%s needs %s, on hand %s', x.part_number, x.need, x.oh), '; ') into v_short from (
      select p.part_number, sum(l.qty_filled) as need, pm.part_on_hand(t.org_id, t.stock_location_id, p.item_id) as oh
      from pm.parts_ticket_lines l join pm.parts p on p.org_id = l.org_id and p.id = l.part_id
      where l.org_id = t.org_id and l.ticket_id = t.id and l.qty_filled > 0
      group by p.part_number, p.item_id) x
    where x.need > x.oh;
    if v_short is not null then raise exception 'PM_PARTS_INSUFFICIENT: %', v_short using errcode = 'P0001'; end if;
  end if;
  if t.customer_id is null and exists (select 1 from pm.parts_ticket_lines l where l.org_id = t.org_id and l.ticket_id = t.id and l.qty_special_order > 0) then
    raise exception 'PRECONDITION_NO_CUSTOMER: special orders need a customer on the ticket' using errcode = 'P0001';
  end if;
  for r in select l.*, p.item_id, p.uom from pm.parts_ticket_lines l join pm.parts p on p.org_id = l.org_id and p.id = l.part_id
           where l.org_id = t.org_id and l.ticket_id = t.id order by l.sort, l.line_no, l.id for update of l loop
    v_move := null; v_so := r.special_order_id;
    if r.qty_filled > 0 then
      v_move := gen_random_uuid();
      insert into pm.material_moves (id, org_id, location_id, kind, item_id, description, qty, uom, from_stock_location_id,
                                     parts_ticket_id, moved_by, source_ref, notes)
      values (v_move, t.org_id, t.location_id, 'ISSUE', r.item_id, r.description, r.qty_filled, r.uom, t.stock_location_id,
              t.id, pm.current_user_id(), 'pm:ptline:' || r.id::text || ':issue', 'Counter ticket ' || t.number);
    end if;
    if r.qty_special_order > 0 and v_so is null then
      v_so := gen_random_uuid();
      insert into pm.parts_special_orders (id, org_id, location_id, number, part_id, qty, customer_id, parts_ticket_line_id, created_by)
      values (v_so, t.org_id, t.location_id, pm.dealer_doc_number(t.org_id, 'SO'), r.part_id, r.qty_special_order, t.customer_id, r.id,
              pm.current_user_id());
    end if;
    update pm.parts_ticket_lines set move_id = coalesce(v_move, move_id), special_order_id = v_so where id = r.id;
  end loop;
  select jsonb_agg(jsonb_build_object('line_id', l.id, 'part_id', l.part_id, 'item_id', p.item_id, 'part_number', p.part_number,
           'manufacturer', p.manufacturer, 'requested_part_id', l.requested_part_id, 'description', l.description, 'qty', l.qty_filled,
           'uom', p.uom, 'unit_price_cents', l.unit_price_cents, 'amount_cents', l.amount_cents, 'unit_cost_cents', l.unit_cost_cents,
           'cost_cents', round(l.qty_filled * coalesce(l.unit_cost_cents, 0))::bigint,
           'core_charge_cents', round(l.qty_filled * l.core_charge_cents)::bigint, 'taxable', l.taxable) order by l.sort, l.line_no, l.id),
         jsonb_build_object(
           'parts_cents', coalesce(sum(l.amount_cents), 0)::bigint,
           'core_charges_cents', coalesce(sum(round(l.qty_filled * l.core_charge_cents)), 0)::bigint,
           'cost_cents', coalesce(sum(round(l.qty_filled * coalesce(l.unit_cost_cents, 0))), 0)::bigint,
           'taxable_estimate_cents', coalesce(sum(l.amount_cents) filter (where l.taxable), 0)::bigint,
           'tax_estimate_cents', case when t.tax_exempt then 0
                                      else round(coalesce(sum(l.amount_cents) filter (where l.taxable), 0) * coalesce(t.tax_rate_estimate, 0))::bigint end,
           'lines_requested', count(*), 'lines_filled', count(*) filter (where l.qty_filled >= l.qty_requested),
           'qty_lost', coalesce(sum(l.qty_requested - l.qty_filled - l.qty_special_order), 0))
    into v_lines, v_tot
  from pm.parts_ticket_lines l join pm.parts p on p.org_id = l.org_id and p.id = l.part_id
  where l.org_id = t.org_id and l.ticket_id = t.id and l.qty_filled > 0;
  -- the KPI counts every line (filled or not); the totals above are sold lines only
  v_tot := coalesce(v_tot, '{}'::jsonb) || (select jsonb_build_object('lines_requested', count(*), 'lines_filled', count(*) filter (where l.qty_filled >= l.qty_requested),
                                                                     'qty_special_order', coalesce(sum(l.qty_special_order), 0),
                                                                     'qty_lost', coalesce(sum(l.qty_requested - l.qty_filled - l.qty_special_order), 0))
                                            from pm.parts_ticket_lines l where l.org_id = t.org_id and l.ticket_id = t.id);
  update pm.parts_tickets set status = 'CLOSED', closed_at = now(), closed_by = pm.current_user_id(), payment_method = v_pay, totals = v_tot
   where id = t.id;
  if v_lines is not null then
    v_out := pm.dealer_emit(t.org_id, t.location_id, 'DEALER_PARTS_SALE', 'pm:partsale:' || t.id::text,
      jsonb_build_object('ticket_id', t.id, 'ticket_number', t.number, 'customer_id', t.customer_id, 'sold_on', to_char(current_date, 'YYYY-MM-DD'),
        'stock_location_id', t.stock_location_id, 'payment_method', v_pay, 'po_number', t.po_number, 'lines', v_lines,
        'totals', v_tot, 'tax', jsonb_build_object('exempt', t.tax_exempt, 'exempt_ref', t.tax_exempt_ref, 'rate_estimate', t.tax_rate_estimate,
                                                   'estimate_cents', v_tot -> 'tax_estimate_cents', 'computed_by', 'BOOKS')),
      current_date, t.is_sample, 'parts_tickets', t.id, null);
    update pm.parts_tickets set outbox_id = v_out where id = t.id;
  end if;
  perform pm.log_activity(t.org_id, t.location_id, null, 'parts_ticket.closed', 'parts_tickets', t.id,
    format('Closed counter ticket %s (%s cents)', t.number, coalesce(v_tot ->> 'parts_cents', '0')), jsonb_build_object('totals', v_tot, 'outbox_id', v_out));
  return v_out;
end $$;

create or replace function pm.void_parts_ticket(p_ticket uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.parts_tickets%rowtype;
begin
  select * into t from pm.parts_tickets x where x.id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status <> 'OPEN' then raise exception 'PM_TICKET_TRANSITION_INVALID: % is % (Books owns a closed sale: return or credit there)', t.number, t.status using errcode = '22023'; end if;
  update pm.parts_tickets set status = 'VOID', voided_at = now(), void_reason = p_reason where id = t.id;
  perform pm.log_activity(t.org_id, t.location_id, null, 'parts_ticket.voided', 'parts_tickets', t.id, format('Voided %s', t.number),
    jsonb_build_object('reason', p_reason));
  return t.id;
end $$;

-- p_attrs: customer_id, work_order_id, deal_id, needed_by, notes, commitment_id, vendor_id
create or replace function pm.request_special_order(p_part uuid, p_qty numeric, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.parts%rowtype; v_attrs jsonb := coalesce(p_attrs, '{}'); v_id uuid := gen_random_uuid(); v_cust uuid := nullif(v_attrs ->> 'customer_id', '')::uuid;
        v_wo uuid := nullif(v_attrs ->> 'work_order_id', '')::uuid; v_deal uuid := nullif(v_attrs ->> 'deal_id', '')::uuid;
        v_cmt uuid := nullif(v_attrs ->> 'commitment_id', '')::uuid; v_job uuid; v_wloc uuid;
begin
  select * into p from pm.parts x where x.id = p_part;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: part % not found in the caller''s organization', p_part using errcode = '42501';
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'PM_INVALID: quantity must be > 0' using errcode = '22023'; end if;
  if v_cust is not null and not exists (select 1 from core.customers c where c.id = v_cust and c.org_id = p.org_id) then
    raise exception 'PM_FORBIDDEN: customer % is not in the caller''s organization', v_cust using errcode = '42501';
  end if;
  if v_wo is not null then
    select w.job_id, w.location_id into v_job, v_wloc from pm.work_orders w where w.id = v_wo and w.org_id = p.org_id;
    if v_job is null then raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', v_wo using errcode = '42501'; end if;
    if v_wloc <> p.location_id then raise exception 'PM_INVALID: the RO is on another company' using errcode = '22023'; end if;
    v_cust := coalesce(v_cust, (select j.customer_id from core.jobs j where j.id = v_job));
  end if;
  if v_deal is not null and not exists (select 1 from pm.dealer_deals d where d.id = v_deal and d.org_id = p.org_id and d.location_id = p.location_id) then
    raise exception 'PM_FORBIDDEN: deal % not found on this company', v_deal using errcode = '42501';
  end if;
  if v_cmt is not null and not exists (select 1 from pm.commitments c where c.id = v_cmt and c.org_id = p.org_id and c.job_id is not distinct from v_job) then
    raise exception 'PM_INVALID: commitment % is not a PO on this RO''s job', v_cmt using errcode = '22023';
  end if;
  if v_cust is null and v_wo is null and v_deal is null then
    raise exception 'PM_INVALID: a special order is for a customer, an RO or a deal' using errcode = '22023';
  end if;
  insert into pm.parts_special_orders (id, org_id, location_id, number, part_id, qty, customer_id, job_id, work_order_id, deal_id, commitment_id,
                                       vendor_id, needed_by, notes, created_by)
  values (v_id, p.org_id, p.location_id, pm.dealer_doc_number(p.org_id, 'SO'), p.id, p_qty, v_cust, v_job, v_wo, v_deal, v_cmt,
          nullif(v_attrs ->> 'vendor_id', '')::uuid, nullif(v_attrs ->> 'needed_by', '')::date, nullif(v_attrs ->> 'notes', ''), pm.current_user_id());
  perform pm.log_activity(p.org_id, p.location_id, v_job, 'special_order.requested', 'parts_special_orders', v_id,
    format('Special order %s × %s', p.part_number, p_qty), jsonb_build_object('customer_id', v_cust, 'work_order_id', v_wo, 'deal_id', v_deal));
  return v_id;
end $$;

-- REQUESTED → ORDERED → RECEIVED (a RECEIPT move into stock) → NOTIFIED → PICKED_UP; open → CANCELLED.
create or replace function pm.advance_special_order(p_so uuid, p_to text, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.parts_special_orders%rowtype; p pm.parts%rowtype; v_to text := upper(coalesce(p_to, '')); ok boolean; v_attrs jsonb := coalesce(p_attrs, '{}');
        v_sl uuid; v_move uuid; s pm.dealer_settings%rowtype;
begin
  select * into o from pm.parts_special_orders x where x.id = p_so for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: special order % not found in the caller''s organization', p_so using errcode = '42501';
  end if;
  ok := case o.status
          when 'REQUESTED' then v_to in ('ORDERED','CANCELLED')
          when 'ORDERED'   then v_to in ('RECEIVED','CANCELLED')
          when 'RECEIVED'  then v_to in ('NOTIFIED','PICKED_UP')
          when 'NOTIFIED'  then v_to = 'PICKED_UP'
          else false end;
  if not ok then raise exception 'PM_SPECIAL_ORDER_TRANSITION_INVALID: % -> %', o.status, v_to using errcode = '22023'; end if;
  if v_to = 'RECEIVED' and o.receipt_move_id is null then
    select * into p from pm.parts x where x.id = o.part_id;
    s := pm.dealer_settings_row(o.org_id, o.location_id);
    v_sl := coalesce(nullif(v_attrs ->> 'stock_location_id', '')::uuid, s.parts_stock_location_id);
    if v_sl is null or not exists (select 1 from pm.stock_locations x where x.id = v_sl and x.org_id = o.org_id and x.location_id = o.location_id) then
      raise exception 'PM_INVALID: receiving a special order needs a stock location on this company' using errcode = '22023';
    end if;
    v_move := gen_random_uuid();
    insert into pm.material_moves (id, org_id, location_id, kind, item_id, qty, uom, to_stock_location_id, special_order_id, moved_by, source_ref, notes)
    values (v_move, o.org_id, o.location_id, 'RECEIPT', p.item_id, o.qty, p.uom, v_sl, o.id, pm.current_user_id(),
            'pm:so:' || o.id::text || ':receipt', 'Special order ' || o.number);
  end if;
  update pm.parts_special_orders set status = v_to,
         ordered_at = case when v_to = 'ORDERED' then now() else ordered_at end,
         vendor_id = coalesce(nullif(v_attrs ->> 'vendor_id', '')::uuid, vendor_id),
         received_at = case when v_to = 'RECEIVED' then now() else received_at end,
         receipt_move_id = coalesce(v_move, receipt_move_id),
         notified_at = case when v_to = 'NOTIFIED' then now() else notified_at end,
         picked_up_at = case when v_to = 'PICKED_UP' then now() else picked_up_at end,
         cancelled_at = case when v_to = 'CANCELLED' then now() else cancelled_at end,
         cancel_reason = case when v_to = 'CANCELLED' then v_attrs ->> 'reason' else cancel_reason end
   where id = o.id;
  perform pm.log_activity(o.org_id, o.location_id, o.job_id, 'special_order.' || lower(v_to), 'parts_special_orders', o.id,
    format('Special order %s → %s', o.number, v_to), jsonb_build_object('from', o.status, 'to', v_to));
  return o.id;
end $$;

create or replace function pm.create_parts_order(p_location uuid, p_vendor uuid, p_stock_location uuid default null, p_kind text default 'STOCK',
                                                 p_vendor_ref text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; s pm.dealer_settings%rowtype; v_sl uuid; v_id uuid := gen_random_uuid();
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: vendor % is not in the caller''s organization', p_vendor using errcode = '42501';
  end if;
  s := pm.dealer_settings_row(v_org, p_location);
  v_sl := coalesce(p_stock_location, s.parts_stock_location_id);
  if v_sl is null or not exists (select 1 from pm.stock_locations x where x.id = v_sl and x.org_id = v_org and x.location_id = p_location) then
    raise exception 'PM_INVALID: a parts order needs a stock location on this company' using errcode = '22023';
  end if;
  insert into pm.parts_orders (id, org_id, location_id, number, vendor_id, stock_location_id, kind, vendor_ref, created_by)
  values (v_id, v_org, p_location, pm.dealer_doc_number(v_org, 'PPO'), p_vendor, v_sl, upper(coalesce(p_kind, 'STOCK')), p_vendor_ref, pm.current_user_id());
  return v_id;
end $$;

create or replace function pm.submit_parts_order(p_order uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.parts_orders%rowtype;
begin
  select * into o from pm.parts_orders x where x.id = p_order for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: parts order % not found in the caller''s organization', p_order using errcode = '42501';
  end if;
  if o.status <> 'DRAFT' then raise exception 'PM_ORDER_TRANSITION_INVALID: % is %', o.number, o.status using errcode = '22023'; end if;
  if not exists (select 1 from pm.parts_order_lines l where l.org_id = o.org_id and l.order_id = o.id) then
    raise exception 'PRECONDITION_NO_LINES: parts order % has no lines', o.number using errcode = 'P0001';
  end if;
  update pm.parts_orders set status = 'SUBMITTED', submitted_at = now(), submitted_by = pm.current_user_id() where id = o.id;
  update pm.parts_special_orders s set status = 'ORDERED', ordered_at = now(), vendor_id = coalesce(s.vendor_id, o.vendor_id), parts_order_line_id = l.id
    from pm.parts_order_lines l
   where l.org_id = o.org_id and l.order_id = o.id and l.special_order_id = s.id and s.status = 'REQUESTED';
  perform pm.log_activity(o.org_id, o.location_id, null, 'parts_order.submitted', 'parts_orders', o.id, format('Submitted %s', o.number), '{}'::jsonb);
  return o.id;
end $$;

-- p_lines: [{"line_id": uuid, "qty": n}] (null = everything still open). Last receipt cost becomes the
-- part's operational cost.
create or replace function pm.receive_parts_order(p_order uuid, p_lines jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.parts_orders%rowtype; r record; v_qty numeric; v_move uuid; n int := 0; v_open numeric;
begin
  select * into o from pm.parts_orders x where x.id = p_order for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: parts order % not found in the caller''s organization', p_order using errcode = '42501';
  end if;
  if o.status not in ('SUBMITTED','PARTIAL') then raise exception 'PM_ORDER_TRANSITION_INVALID: % is %', o.number, o.status using errcode = '22023'; end if;
  for r in select l.*, p.item_id, p.uom from pm.parts_order_lines l join pm.parts p on p.org_id = l.org_id and p.id = l.part_id
           where l.org_id = o.org_id and l.order_id = o.id order by l.line_no, l.id for update of l loop
    v_qty := case when p_lines is null then r.qty_ordered - r.qty_received
                  else (select sum((e ->> 'qty')::numeric) from jsonb_array_elements(p_lines) e where (e ->> 'line_id')::uuid = r.id) end;
    continue when v_qty is null or v_qty = 0;
    if v_qty < 0 or r.qty_received + v_qty > r.qty_ordered then
      raise exception 'PM_INVALID: line % receives % of % open', r.line_no, v_qty, r.qty_ordered - r.qty_received using errcode = '22023';
    end if;
    v_move := gen_random_uuid();
    insert into pm.material_moves (id, org_id, location_id, kind, item_id, qty, uom, to_stock_location_id, parts_order_id, special_order_id,
                                   moved_by, source_ref, notes)
    values (v_move, o.org_id, o.location_id, 'RECEIPT', r.item_id, v_qty, r.uom, o.stock_location_id, o.id, r.special_order_id,
            pm.current_user_id(), 'pm:material:' || v_move::text, 'Parts order ' || o.number);
    update pm.parts_order_lines set qty_received = qty_received + v_qty where id = r.id;
    if coalesce(r.unit_cost_cents, 0) > 0 then update pm.parts set cost_cents = r.unit_cost_cents where id = r.part_id; end if;
    if r.special_order_id is not null and r.qty_received + v_qty >= r.qty_ordered then
      update pm.parts_special_orders set status = 'RECEIVED', received_at = now(), receipt_move_id = v_move
       where id = r.special_order_id and status in ('REQUESTED','ORDERED');
    end if;
    n := n + 1;
  end loop;
  select coalesce(sum(l.qty_ordered - l.qty_received), 0) into v_open from pm.parts_order_lines l where l.org_id = o.org_id and l.order_id = o.id;
  update pm.parts_orders set status = case when v_open = 0 then 'RECEIVED' else 'PARTIAL' end,
         received_at = case when v_open = 0 then now() else received_at end
   where id = o.id;
  perform pm.log_activity(o.org_id, o.location_id, null, 'parts_order.received', 'parts_orders', o.id,
    format('Received %s line(s) on %s', n, o.number), jsonb_build_object('lines', n, 'open_qty', v_open));
  return jsonb_build_object('lines_received', n, 'open_qty', v_open, 'status', case when v_open = 0 then 'RECEIVED' else 'PARTIAL' end);
end $$;

-- Suggested stock order: parts at a stock location whose on-hand + on-order is below min, ordered up to max.
create or replace function pm.suggest_parts_order(p_stock_location uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v jsonb;
begin
  select s.org_id, s.location_id into v_org, v_loc from pm.stock_locations s where s.id = p_stock_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: stock location % not found in the caller''s organization', p_stock_location using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('part_id', x.part_id, 'part_number', x.part_number, 'on_hand', x.oh, 'on_order', x.oo,
           'min_qty', x.min_qty, 'max_qty', x.max_qty, 'suggested_qty', greatest(coalesce(x.max_qty, x.min_qty) - x.oh - x.oo, 0))
         order by x.part_number), '[]'::jsonb)
    into v
  from (
    select p.id as part_id, p.part_number, t.min_qty, t.max_qty, pm.part_on_hand(v_org, p_stock_location, p.item_id) as oh,
           coalesce((select sum(l.qty_ordered - l.qty_received) from pm.parts_order_lines l join pm.parts_orders o on o.org_id = l.org_id and o.id = l.order_id
                     where l.org_id = v_org and l.part_id = p.id and o.stock_location_id = p_stock_location and o.status in ('SUBMITTED','PARTIAL')), 0) as oo
    from pm.stock_targets t join pm.parts p on p.org_id = t.org_id and p.item_id = t.item_id and p.location_id = v_loc and p.status = 'ACTIVE'
    where t.org_id = v_org and t.stock_location_id = p_stock_location
  ) x
  where x.oh + x.oo < x.min_qty;
  return v;
end $$;

create or replace function pm.start_parts_count(p_stock_location uuid, p_parts uuid[] default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v_id uuid := gen_random_uuid(); n int;
begin
  select s.org_id, s.location_id into v_org, v_loc from pm.stock_locations s where s.id = p_stock_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: stock location % not found in the caller''s organization', p_stock_location using errcode = '42501';
  end if;
  if exists (select 1 from pm.parts_counts c where c.org_id = v_org and c.stock_location_id = p_stock_location and c.status = 'OPEN') then
    raise exception 'PM_COUNT_OPEN: this stock location already has an open count' using errcode = '22023';
  end if;
  insert into pm.parts_counts (id, org_id, location_id, number, stock_location_id, started_by)
  values (v_id, v_org, v_loc, pm.dealer_doc_number(v_org, 'CNT'), p_stock_location, pm.current_user_id());
  insert into pm.parts_count_lines (org_id, count_id, part_id, expected_qty)
  select v_org, v_id, p.id, pm.part_on_hand(v_org, p_stock_location, p.item_id)
  from pm.parts p
  where p.org_id = v_org and p.location_id = v_loc
    and (case when p_parts is not null then p.id = any (p_parts)
              else exists (select 1 from pm.stock_targets t where t.org_id = v_org and t.stock_location_id = p_stock_location and t.item_id = p.item_id)
                   or pm.part_on_hand(v_org, p_stock_location, p.item_id) <> 0 end);
  get diagnostics n = row_count;
  if n = 0 then raise exception 'PM_INVALID: nothing to count at this stock location' using errcode = '22023'; end if;
  perform pm.log_activity(v_org, v_loc, null, 'parts_count.started', 'parts_counts', v_id, format('Physical count started (%s parts)', n), '{}'::jsonb);
  return v_id;
end $$;

-- Variance (counted − on-hand snapshot) posts as ADJUST moves. Books revalues parts inventory.
create or replace function pm.post_parts_count(p_count uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.parts_counts%rowtype; r record; v_move uuid; n int := 0; v_net numeric := 0; v_open int; v_sum jsonb;
begin
  select * into c from pm.parts_counts x where x.id = p_count for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: count % not found in the caller''s organization', p_count using errcode = '42501';
  end if;
  if c.status <> 'OPEN' then raise exception 'PM_COUNT_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  select count(*) into v_open from pm.parts_count_lines l where l.org_id = c.org_id and l.count_id = c.id and l.counted_qty is null;
  if v_open > 0 then raise exception 'PM_COUNT_INCOMPLETE: % line(s) on % are not counted', v_open, c.number using errcode = 'P0001'; end if;
  for r in select l.*, p.item_id, p.uom, p.part_number from pm.parts_count_lines l join pm.parts p on p.org_id = l.org_id and p.id = l.part_id
           where l.org_id = c.org_id and l.count_id = c.id and l.variance_qty <> 0 for update of l loop
    v_move := gen_random_uuid();
    insert into pm.material_moves (id, org_id, location_id, kind, item_id, qty, uom, from_stock_location_id, to_stock_location_id,
                                   parts_count_id, moved_by, source_ref, notes)
    values (v_move, c.org_id, c.location_id, 'ADJUST', r.item_id, abs(r.variance_qty), r.uom,
            case when r.variance_qty < 0 then c.stock_location_id end, case when r.variance_qty > 0 then c.stock_location_id end,
            c.id, pm.current_user_id(), 'pm:countline:' || r.id::text, 'Physical count ' || c.number);
    update pm.parts_count_lines set move_id = v_move where id = r.id;
    n := n + 1; v_net := v_net + r.variance_qty;
  end loop;
  v_sum := jsonb_build_object('lines', (select count(*) from pm.parts_count_lines l where l.org_id = c.org_id and l.count_id = c.id),
                              'variance_lines', n, 'net_variance_qty', v_net,
                              'variance_cost_cents', (select coalesce(sum(round(l.variance_qty * coalesce(p.cost_cents, 0))), 0)::bigint
                                                      from pm.parts_count_lines l join pm.parts p on p.org_id = l.org_id and p.id = l.part_id
                                                      where l.org_id = c.org_id and l.count_id = c.id));
  update pm.parts_counts set status = 'POSTED', posted_by = pm.current_user_id(), posted_at = now(), variance_summary = v_sum where id = c.id;
  perform pm.log_activity(c.org_id, c.location_id, null, 'parts_count.posted', 'parts_counts', c.id,
    format('Count %s posted (%s variance line(s))', c.number, n), v_sum);
  return v_sum;
end $$;

-- ----------------------------------------------------------------------------
-- 11. Service: RO close (hooked on pm.work_orders; 1104's complete / close functions are unchanged)
--   A dealer RO = a REPAIR_ORDER or PDI work order on a job whose type has archetype dealer_service.
--   On CLOSED: part lines with a part issue from stock (job ISSUE moves); internal lines on a unit
--   in dealer stock become a unit cost row (DEALER_UNIT_COST, cost basis = pinned time cost when the
--   tech time is approved, else the line cost); DEALER_RO_CLOSED carries the pay-type split.
--   Any other work order (field service, production, …) is untouched.
-- ----------------------------------------------------------------------------
create or replace function pm.dealer_on_ro_closed(p_wo uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  w pm.work_orders%rowtype; a pm.assets%rowtype; s pm.dealer_settings%rowtype; j core.jobs%rowtype; r record;
  v_sample boolean; v_split jsonb; v_zero jsonb; v_lines jsonb; v_claims jsonb; v_out uuid; v_cost_id uuid; v_cost_ref text;
  v_time_cost numeric; v_int_flag numeric; v_all_flag numeric; v_labor bigint := 0; v_parts bigint := 0; v_other bigint := 0;
  v_hours numeric; v_type text; v_dest text; v_sl uuid; v_move uuid; v_clocked numeric; v_in_stock boolean := false;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  select * into j from core.jobs x where x.org_id = w.org_id and x.id = w.job_id;
  select p.is_sample into v_sample from pm.projects p where p.org_id = w.org_id and p.job_id = w.job_id;
  s := pm.dealer_settings_row(w.org_id, w.location_id);
  if w.asset_id is not null then select * into a from pm.assets x where x.id = w.asset_id for update; end if;

  -- parts off the shelf (job-scoped ISSUE)
  for r in select l.*, p.item_id as p_item, p.uom as p_uom from pm.work_order_lines l join pm.parts p on p.org_id = l.org_id and p.id = l.part_id
           where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind = 'PART' and l.issued_move_id is null
           order by l.sort, l.id for update of l loop
    v_sl := coalesce(r.stock_location_id, s.parts_stock_location_id);
    continue when v_sl is null;
    v_move := gen_random_uuid();
    insert into pm.material_moves (id, org_id, location_id, kind, item_id, description, qty, uom, from_stock_location_id, job_id, work_order_id,
                                   moved_by, source_ref, notes)
    values (v_move, w.org_id, w.location_id, 'ISSUE', r.p_item, r.description, r.qty, r.p_uom, v_sl, w.job_id, w.id,
            pm.current_user_id(), 'pm:roline:' || r.id::text || ':issue', 'RO ' || w.number);
    update pm.work_order_lines set issued_move_id = v_move where id = r.id;
  end loop;

  v_zero := jsonb_build_object('labor_cents', 0, 'parts_cents', 0, 'sublet_cents', 0, 'misc_cents', 0, 'total_cents', 0,
                               'parts_cost_cents', 0, 'sublet_cost_cents', 0, 'flag_hours', 0, 'line_count', 0);
  select coalesce(jsonb_object_agg(x.pay_type, x.obj), '{}'::jsonb) into v_split from (
    select l.pay_type, jsonb_build_object(
      'labor_cents',       coalesce(sum(l.amount_cents) filter (where l.kind in ('LABOR','SERVICE')), 0)::bigint,
      'parts_cents',       coalesce(sum(l.amount_cents) filter (where l.kind = 'PART'), 0)::bigint,
      'sublet_cents',      coalesce(sum(l.amount_cents) filter (where l.kind = 'SUBLET'), 0)::bigint,
      'misc_cents',        coalesce(sum(l.amount_cents) filter (where l.kind not in ('LABOR','SERVICE','PART','SUBLET')), 0)::bigint,
      'total_cents',       coalesce(sum(l.amount_cents), 0)::bigint,
      'parts_cost_cents',  coalesce(sum(round(l.qty * coalesce(l.unit_cost_cents, 0))) filter (where l.kind = 'PART'), 0)::bigint,
      'sublet_cost_cents', coalesce(sum(round(l.qty * coalesce(l.unit_cost_cents, 0))) filter (where l.kind = 'SUBLET'), 0)::bigint,
      'flag_hours',        coalesce(sum(l.flag_hours) filter (where l.kind in ('LABOR','SERVICE')), 0),
      'line_count',        count(*)) as obj
    from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED'
    group by l.pay_type) x;
  v_split := jsonb_build_object('CUSTOMER', v_zero, 'WARRANTY', v_zero, 'INTERNAL', v_zero, 'POLICY', v_zero) || v_split;

  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'kind', l.kind, 'pay_type', l.pay_type, 'labor_op', l.labor_op,
           'part_id', l.part_id, 'item_id', l.item_id, 'description', l.description, 'qty', l.qty, 'unit_price_cents', l.unit_price_cents,
           'amount_cents', l.amount_cents, 'unit_cost_cents', l.unit_cost_cents, 'flag_hours', l.flag_hours, 'cost_code_id', l.cost_code_id,
           'issued_move_id', l.issued_move_id) order by l.sort, l.id), '[]'::jsonb)
    into v_lines from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED';
  select coalesce(jsonb_agg(jsonb_build_object('claim_id', c.id, 'claim_number', c.claim_number, 'status', c.status,
           'claimed_cents', c.claimed_cents, 'payer_customer_id', c.payer_customer_id, 'oem_vendor_id', c.oem_vendor_id)), '[]'::jsonb)
    into v_claims from pm.warranty_claims c where c.org_id = w.org_id and c.work_order_id = w.id;
  select coalesce(sum(t.hours), 0) into v_clocked from pm.time_entries t where t.org_id = w.org_id and t.work_order_id = w.id and t.approval_state <> 'VOID';

  -- internal work on a unit in dealer stock → unit cost (the PDI / recon capitalization; Books posts it)
  v_in_stock := coalesce(a.id is not null and a.unit_status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','ON_HOLD','SOLD'), false);
  if (v_split -> 'INTERNAL' ->> 'line_count')::int > 0 then
    if v_in_stock then
      select coalesce(sum(t.hours * t.cost_rate_cents), 0) into v_time_cost from pm.time_entries t
      where t.org_id = w.org_id and t.work_order_id = w.id and t.approval_state = 'APPROVED' and t.cost_rate_cents is not null;
      v_int_flag := coalesce((select sum(coalesce(l.flag_hours, l.qty)) from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id
                               and l.status = 'APPROVED' and l.kind in ('LABOR','SERVICE') and l.pay_type = 'INTERNAL'), 0);
      v_all_flag := coalesce((select sum(coalesce(l.flag_hours, l.qty)) from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id
                               and l.status = 'APPROVED' and l.kind in ('LABOR','SERVICE')), 0);
      if v_time_cost > 0 and v_all_flag > 0 then
        v_labor := round(v_time_cost * v_int_flag / v_all_flag)::bigint;
      else
        v_labor := coalesce((select sum(round(l.qty * coalesce(l.unit_cost_cents, 0))) from pm.work_order_lines l where l.org_id = w.org_id
                              and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind in ('LABOR','SERVICE') and l.pay_type = 'INTERNAL'), 0)::bigint;
      end if;
      v_parts := coalesce((select sum(round(l.qty * coalesce(l.unit_cost_cents, 0))) from pm.work_order_lines l where l.org_id = w.org_id
                            and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind = 'PART' and l.pay_type = 'INTERNAL'), 0)::bigint;
      v_other := coalesce((select sum(round(l.qty * coalesce(l.unit_cost_cents, 0))) from pm.work_order_lines l where l.org_id = w.org_id
                            and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind not in ('LABOR','SERVICE','PART') and l.pay_type = 'INTERNAL'), 0)::bigint;
      v_hours := v_int_flag;
      v_type := case when w.kind = 'PDI' then 'SETUP_PDI' when a.condition = 'USED' then 'RECON' else 'OTHER' end;
      if v_labor + v_parts + v_other > 0 then
        v_cost_id := pm.dealer_record_unit_cost(a.id, v_type, v_labor + v_parts + v_other, v_labor, v_parts, v_hours, 'INTERNAL_RO',
                                                w.job_id, w.id, null, null, format('Internal RO %s', w.number));
        v_cost_ref := 'pm:unitcost:' || v_cost_id::text;
      end if;
      v_dest := 'UNIT_COST';
    else
      v_dest := case when a.id is not null and a.unit_status = 'RENTAL' then 'RENTAL_EXPENSE' else 'DEPARTMENT_EXPENSE' end;
    end if;
  end if;
  if a.id is not null and a.unit_status = 'PDI' then
    update pm.assets set unit_status = 'IN_STOCK' where id = a.id;
    a.unit_status := 'IN_STOCK';
  end if;

  v_out := pm.dealer_emit(w.org_id, w.location_id, 'DEALER_RO_CLOSED', 'pm:ro:' || w.id::text || ':closed',
    jsonb_build_object(
      'work_order_id', w.id, 'ro_number', w.number, 'ro_kind', w.kind, 'job_id', w.job_id, 'job_number', j.job_number,
      'customer_id', j.customer_id, 'payer_type', w.payer_type, 'payer_customer_id', w.payer_customer_id,
      'unit', case when a.id is not null then pm.dealer_unit_json(a.id) || jsonb_build_object('unit_status', a.unit_status) end,
      'unit_in_dealer_stock', v_in_stock,
      'checked_in_at', w.checked_in_at, 'completed_at', w.completed_at, 'closed_on', to_char(coalesce(w.closed_at, now()), 'YYYY-MM-DD'),
      'meter_in', w.meter_in, 'meter_out', w.meter_out, 'complaint', w.complaint, 'cause', w.cause, 'correction', w.resolution,
      'split', v_split, 'lines', v_lines, 'warranty_claims', v_claims,
      'hours', jsonb_build_object('flagged', (select coalesce(sum(l.flag_hours), 0) from pm.work_order_lines l where l.org_id = w.org_id
                                              and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind in ('LABOR','SERVICE')),
                                  'clocked', v_clocked),
      'internal', jsonb_build_object('destination', v_dest, 'unit_cost_source_ref', v_cost_ref,
                                     'labor_cents', v_labor, 'parts_cents', v_parts, 'other_cents', v_other)),
    coalesce(w.closed_at, now())::date, coalesce(v_sample, false) or coalesce(a.is_sample, false), 'work_orders', w.id, w.job_id);
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'dealer_ro.closed', 'work_orders', w.id,
    format('RO %s closed: customer %s, warranty %s, internal %s, policy %s cents', w.number, v_split -> 'CUSTOMER' ->> 'total_cents',
           v_split -> 'WARRANTY' ->> 'total_cents', v_split -> 'INTERNAL' ->> 'total_cents', v_split -> 'POLICY' ->> 'total_cents'),
    jsonb_build_object('outbox_id', v_out, 'unit_cost_id', v_cost_id));
  return v_out;
end $$;

create or replace function pm.tg_dealer_ro_closed() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.kind in ('REPAIR_ORDER','PDI') and exists (
       select 1 from pm.projects p join pm.job_types jt on jt.org_id = p.org_id and jt.id = p.job_type_id
       where p.org_id = new.org_id and p.job_id = new.job_id and jt.archetype = 'dealer_service') then
    perform pm.dealer_on_ro_closed(new.id);
  end if;
  return null;
end $$;

-- Draft a warranty claim from the RO's WARRANTY lines (labor / parts / other at the lines' amounts).
create or replace function pm.create_warranty_claim_from_ro(p_wo uuid, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_attrs jsonb := coalesce(p_attrs, '{}'); v_payer uuid; v_oem uuid; v_id uuid; v_lab bigint; v_par bigint;
        v_oth bigint; v_hrs numeric; v_deadline date; v_ext jsonb;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  v_payer := coalesce(nullif(v_attrs ->> 'payer_customer_id', '')::uuid, w.payer_customer_id);
  if v_payer is null then raise exception 'PRECONDITION_NO_OEM_PAYER: the RO has no OEM payer (an AR customer in Books)' using errcode = 'P0001'; end if;
  v_oem := coalesce(nullif(v_attrs ->> 'oem_vendor_id', '')::uuid, (select a.mfr_vendor_id from pm.assets a where a.id = w.asset_id));
  if v_oem is not null and not exists (select 1 from core.vendors v where v.id = v_oem and v.org_id = w.org_id) then
    raise exception 'PM_FORBIDDEN: vendor % is not in the caller''s organization', v_oem using errcode = '42501';
  end if;
  select coalesce(sum(l.amount_cents) filter (where l.kind in ('LABOR','SERVICE')), 0), coalesce(sum(l.amount_cents) filter (where l.kind = 'PART'), 0),
         coalesce(sum(l.amount_cents) filter (where l.kind not in ('LABOR','SERVICE','PART')), 0),
         coalesce(sum(l.flag_hours) filter (where l.kind in ('LABOR','SERVICE')), 0)
    into v_lab, v_par, v_oth, v_hrs
  from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'WARRANTY';
  if v_lab + v_par + v_oth <= 0 then raise exception 'PRECONDITION_NO_WARRANTY_LINES: RO % has no warranty lines', w.number using errcode = 'P0001'; end if;
  select p.ext into v_ext from pm.projects p where p.org_id = w.org_id and p.job_id = w.job_id;
  v_deadline := coalesce(nullif(v_attrs ->> 'filing_deadline', '')::date,
                         case when coalesce(v_ext ->> 'claim_deadline', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_ext ->> 'claim_deadline')::date end);
  insert into pm.warranty_claims (org_id, job_id, work_order_id, asset_id, payer_customer_id, oem_vendor_id, claim_number, failure_code, labor_op,
                                  claimed_labor_cents, claimed_parts_cents, claimed_other_cents, labor_hours, filing_deadline, created_by)
  values (w.org_id, w.job_id, w.id, w.asset_id, v_payer, v_oem, coalesce(nullif(v_attrs ->> 'claim_number', ''), v_ext ->> 'oem_claim_number'),
          nullif(v_attrs ->> 'failure_code', ''),
          coalesce(nullif(v_attrs ->> 'labor_op', ''), (select l.labor_op from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id
                                                         and l.pay_type = 'WARRANTY' and l.labor_op is not null order by l.sort limit 1)),
          v_lab, v_par, v_oth, nullif(v_hrs, 0), v_deadline, pm.current_user_id())
  returning id into v_id;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'warranty_claim.drafted', 'warranty_claims', v_id,
    format('Warranty claim drafted from %s (%s cents)', w.number, v_lab + v_par + v_oth), jsonb_build_object('labor', v_lab, 'parts', v_par, 'other', v_oth));
  return v_id;
end $$;

-- DEALER_WARRANTY_CLAIM on every member-driven status change (submit, return, approve, …). A change
-- applied from Books' DEALER_WARRANTY_PAID is not echoed back (session flag pm.dealer_inbound).
create or replace function pm.dealer_emit_warranty_claim(p_claim uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype; w pm.work_orders%rowtype; v_sample boolean; v_out uuid;
begin
  update pm.warranty_claims set emit_revision = emit_revision + 1 where id = p_claim returning * into c;
  select * into w from pm.work_orders x where x.org_id = c.org_id and x.id = c.work_order_id;
  select p.is_sample into v_sample from pm.projects p where p.org_id = c.org_id and p.job_id = c.job_id;
  v_out := pm.dealer_emit(c.org_id, w.location_id, 'DEALER_WARRANTY_CLAIM', 'pm:wclaim:' || c.id::text || ':r' || c.emit_revision,
    jsonb_build_object('claim_id', c.id, 'claim_number', c.claim_number, 'revision', c.emit_revision, 'status', c.status,
      'job_id', c.job_id, 'work_order_id', c.work_order_id, 'ro_number', w.number,
      'unit', case when c.asset_id is not null then pm.dealer_unit_json(c.asset_id) end,
      'payer_customer_id', c.payer_customer_id, 'oem_vendor_id', c.oem_vendor_id, 'failure_code', c.failure_code, 'labor_op', c.labor_op,
      'labor_hours', c.labor_hours, 'claimed_labor_cents', c.claimed_labor_cents, 'claimed_parts_cents', c.claimed_parts_cents,
      'claimed_other_cents', c.claimed_other_cents, 'claimed_cents', c.claimed_cents, 'approved_cents', c.approved_cents,
      'paid_cents', c.paid_cents, 'filing_deadline', to_char(c.filing_deadline, 'YYYY-MM-DD'),
      'submitted_on', to_char(c.submitted_at, 'YYYY-MM-DD'), 'decision_reason', c.decision_reason),
    coalesce(c.submitted_at, now())::date, coalesce(v_sample, false), 'warranty_claims', c.id, c.job_id);
  return v_out;
end $$;

create or replace function pm.tg_dealer_warranty_claim_status() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status <> 'DRAFT' and coalesce(current_setting('pm.dealer_inbound', true), '') <> 'on' then
    perform pm.dealer_emit_warranty_claim(new.id);
  end if;
  return null;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Rentals
-- ----------------------------------------------------------------------------
-- Charge for a period: 28-day months, 7-day weeks, then days; each tier capped by the next
-- (days never cost more than a week, weeks + days never more than a month). Missing rates derive
-- from the others (week = 7 × day, month = 4 × week). Days are whole 24-hour periods, minimum 1, with a
-- 59-minute return grace (a 9-day rental returned 30 minutes late is 9 days).
create or replace function pm.rental_charge(p_day bigint, p_week bigint, p_month bigint, p_start timestamptz, p_end timestamptz)
returns jsonb
language plpgsql immutable
set search_path = pm, core, public
as $$
declare v_days int; v_m int; v_w int; v_d int; d numeric; wk numeric; mo numeric; v_dpart numeric; v_rest numeric; v_total bigint;
begin
  if p_end <= p_start then
    return jsonb_build_object('days', 0, 'months', 0, 'weeks', 0, 'extra_days', 0, 'rental_cents', 0);
  end if;
  d  := nullif(p_day, 0);
  wk := coalesce(nullif(p_week, 0), d * 7);
  mo := coalesce(nullif(p_month, 0), wk * 4);
  d  := coalesce(d, ceil(wk / 7), ceil(mo / 28));
  wk := coalesce(wk, mo / 4);
  if d is null then raise exception 'PM_INVALID: a rental needs at least one rate' using errcode = '22023'; end if;
  v_days := greatest(1, ceil((extract(epoch from (p_end - p_start)) - 3540) / 86400.0)::int);   -- 59-minute return grace
  v_m := v_days / 28; v_w := (v_days % 28) / 7; v_d := v_days % 7;
  v_dpart := least(v_d * d, wk);
  v_rest  := least(v_w * wk + v_dpart, mo);
  v_total := round(v_m * mo + v_rest)::bigint;
  return jsonb_build_object('days', v_days, 'months', v_m, 'weeks', v_w, 'extra_days', v_d,
                            'rate_day_cents', round(d)::bigint, 'rate_week_cents', round(wk)::bigint, 'rate_month_cents', round(mo)::bigint,
                            'rental_cents', v_total);
end $$;

create or replace function pm.dealer_rental_rate(p_asset uuid) returns pm.rental_rates
language sql stable security definer
set search_path = pm, core, public
as $$
  select r.* from pm.rental_rates r join pm.assets a on a.id = p_asset
  where r.org_id = a.org_id and r.location_id = a.location_id and r.is_active
    and (r.asset_id is null or r.asset_id = a.id)
    and (r.model is null or lower(r.model) = lower(coalesce(a.model, '')))
    and (r.category is null or r.category = a.category)
  order by (r.asset_id is not null) desc, (r.model is not null) desc, (r.category is not null) desc, r.created_at desc
  limit 1
$$;

-- p_attrs: damage_waiver (bool), delivery_cents, notes, is_sample
create or replace function pm.reserve_rental(p_unit uuid, p_customer uuid, p_start timestamptz, p_end timestamptz, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; rt pm.rental_rates%rowtype; v_id uuid := gen_random_uuid(); v_attrs jsonb := coalesce(p_attrs, '{}');
begin
  select * into a from pm.assets x where x.id = p_unit for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  if a.unit_status is distinct from 'RENTAL' then
    raise exception 'PM_UNIT_NOT_RENTAL: unit % is not in the rental fleet', coalesce(a.stock_number, a.serial_number) using errcode = '22023';
  end if;
  if not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = a.org_id and c.deleted_at is null) then
    raise exception 'PM_UNKNOWN_CUSTOMER: %', p_customer using errcode = 'P0002';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then raise exception 'PM_INVALID: the rental needs a start before its end' using errcode = '22023'; end if;
  rt := pm.dealer_rental_rate(a.id);
  if rt.id is null then raise exception 'PM_NO_RENTAL_RATE: no active rental rate covers unit %', coalesce(a.stock_number, a.serial_number) using errcode = 'P0002'; end if;
  begin
    insert into pm.rental_contracts (id, org_id, location_id, number, asset_id, customer_id, reserved, rate_day_cents, rate_week_cents,
                                     rate_month_cents, damage_waiver, damage_waiver_pct, delivery_cents, is_sample, notes, created_by)
    values (v_id, a.org_id, a.location_id, pm.dealer_doc_number(a.org_id, 'RC'), a.id, p_customer, tstzrange(p_start, p_end, '[)'),
            rt.day_cents, rt.week_cents, rt.month_cents, coalesce((v_attrs ->> 'damage_waiver')::boolean, false), rt.damage_waiver_pct,
            coalesce(nullif(v_attrs ->> 'delivery_cents', '')::bigint, 0), coalesce((v_attrs ->> 'is_sample')::boolean, a.is_sample),
            nullif(v_attrs ->> 'notes', ''), pm.current_user_id());
  exception when exclusion_violation then
    raise exception 'PM_RENTAL_OVERLAP: unit % is already reserved or out in that window', coalesce(a.stock_number, a.serial_number) using errcode = '23P01';
  end;
  perform pm.log_activity(a.org_id, a.location_id, null, 'rental.reserved', 'rental_contracts', v_id,
    format('Reserved %s %s – %s', coalesce(a.stock_number, a.serial_number), to_char(p_start, 'YYYY-MM-DD'), to_char(p_end, 'YYYY-MM-DD')),
    jsonb_build_object('rate_id', rt.id, 'customer_id', p_customer));
  return v_id;
end $$;

create or replace function pm.check_out_rental(p_contract uuid, p_meter_out numeric, p_condition_out text default null, p_out_at timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; a pm.assets%rowtype; v_at timestamptz := coalesce(p_out_at, now());
begin
  select * into c from pm.rental_contracts x where x.id = p_contract for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rental contract % not found in the caller''s organization', p_contract using errcode = '42501';
  end if;
  if c.status <> 'RESERVED' then raise exception 'PM_RENTAL_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  select * into a from pm.assets x where x.id = c.asset_id for update;
  if a.unit_status is distinct from 'RENTAL' then raise exception 'PM_UNIT_NOT_RENTAL: unit left the rental fleet' using errcode = '22023'; end if;
  if exists (select 1 from pm.rental_contracts x where x.org_id = c.org_id and x.asset_id = c.asset_id and x.status = 'OUT' and x.id <> c.id) then
    raise exception 'PM_RENTAL_OVERLAP: unit is already out on another contract' using errcode = '23P01';
  end if;
  if p_meter_out is null or p_meter_out < 0 then raise exception 'PM_INVALID: meter out is required' using errcode = '22023'; end if;
  if a.meter_reading is not null and p_meter_out < a.meter_reading then
    raise exception 'PM_INVALID: meter out % is below the unit''s last reading %', p_meter_out, a.meter_reading using errcode = '22023';
  end if;
  update pm.rental_contracts set status = 'OUT', checked_out_at = v_at, checked_out_by = pm.current_user_id(), meter_out = p_meter_out,
         condition_out = p_condition_out, reserved = tstzrange(least(lower(reserved), v_at), greatest(upper(reserved), v_at + interval '1 hour'), '[)')
   where id = c.id;
  update pm.assets set meter_reading = p_meter_out, meter_read_on = v_at::date where id = a.id;
  perform pm.log_activity(c.org_id, c.location_id, null, 'rental.checked_out', 'rental_contracts', c.id,
    format('%s out at %s hours', c.number, p_meter_out), jsonb_build_object('meter_out', p_meter_out, 'condition_out', p_condition_out));
  return c.id;
end $$;

-- p_attrs: fuel_cents, cleaning_cents, damage_notes
create or replace function pm.check_in_rental(p_contract uuid, p_meter_in numeric, p_condition_in text default null, p_damage_cents bigint default 0,
                                              p_attrs jsonb default '{}', p_in_at timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; v_at timestamptz := coalesce(p_in_at, now()); v_attrs jsonb := coalesce(p_attrs, '{}');
begin
  select * into c from pm.rental_contracts x where x.id = p_contract for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rental contract % not found in the caller''s organization', p_contract using errcode = '42501';
  end if;
  if c.status <> 'OUT' then raise exception 'PM_RENTAL_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  if p_meter_in is null or p_meter_in < c.meter_out then
    raise exception 'PM_INVALID: meter in must be ≥ meter out (%)', c.meter_out using errcode = '22023';
  end if;
  if v_at < c.checked_out_at then raise exception 'PM_INVALID: checked in before it went out' using errcode = '22023'; end if;
  if coalesce(p_damage_cents, 0) < 0 then raise exception 'PM_INVALID: damage must be ≥ 0' using errcode = '22023'; end if;
  update pm.rental_contracts set status = 'RETURNED', checked_in_at = v_at, checked_in_by = pm.current_user_id(), meter_in = p_meter_in,
         condition_in = p_condition_in, damage_cents = coalesce(p_damage_cents, 0), damage_notes = nullif(v_attrs ->> 'damage_notes', ''),
         fuel_cents = coalesce(nullif(v_attrs ->> 'fuel_cents', '')::bigint, 0), cleaning_cents = coalesce(nullif(v_attrs ->> 'cleaning_cents', '')::bigint, 0),
         reserved = tstzrange(lower(reserved), greatest(v_at, lower(reserved) + interval '1 minute'), '[)')
   where id = c.id;
  update pm.assets set meter_reading = p_meter_in, meter_read_on = v_at::date where id = c.asset_id;
  perform pm.log_activity(c.org_id, c.location_id, null, 'rental.checked_in', 'rental_contracts', c.id,
    format('%s back at %s hours (%s used)', c.number, p_meter_in, p_meter_in - c.meter_out),
    jsonb_build_object('meter_in', p_meter_in, 'hours_used', p_meter_in - c.meter_out, 'damage_cents', p_damage_cents));
  return c.id;
end $$;

-- OUT: cycle bill from the last billed point to p_through (default now). RETURNED: final bill to check-in
-- with fees and damage; the contract closes. Emits DEALER_RENTAL_BILLED.
create or replace function pm.bill_rental(p_contract uuid, p_through timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; v_start timestamptz; v_end timestamptz; v_final boolean; v_ch jsonb; v_rent bigint; v_dw bigint; v_fees bigint;
        v_id uuid := gen_random_uuid(); v_out uuid;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rental contract % not found in the caller''s organization', p_contract using errcode = '42501';
  end if;
  if c.status not in ('OUT','RETURNED') then raise exception 'PM_RENTAL_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  v_final := c.status = 'RETURNED';
  v_start := coalesce(c.billed_through, c.checked_out_at);
  v_end := case when v_final then c.checked_in_at else coalesce(p_through, now()) end;
  if not v_final and v_end <= v_start then raise exception 'PM_NOTHING_TO_BILL: % is billed through %', c.number, v_start using errcode = '22023'; end if;
  v_ch := pm.rental_charge(c.rate_day_cents, c.rate_week_cents, c.rate_month_cents, v_start, greatest(v_end, v_start));
  v_rent := (v_ch ->> 'rental_cents')::bigint;
  v_dw := case when c.damage_waiver then round(v_rent * coalesce(c.damage_waiver_pct, 0))::bigint else 0 end;
  v_fees := case when v_final then c.fuel_cents + c.cleaning_cents + c.damage_cents else 0 end
            + case when c.billed_through is null then c.delivery_cents else 0 end;
  insert into pm.rental_billings (id, org_id, location_id, contract_id, period_start, period_end, breakdown, rental_cents, damage_waiver_cents,
                                  fees_cents, total_cents, is_final, created_by)
  values (v_id, c.org_id, c.location_id, c.id, v_start, greatest(v_end, v_start),
          v_ch || jsonb_build_object('fuel_cents', case when v_final then c.fuel_cents else 0 end,
                                     'cleaning_cents', case when v_final then c.cleaning_cents else 0 end,
                                     'damage_cents', case when v_final then c.damage_cents else 0 end,
                                     'delivery_cents', case when c.billed_through is null then c.delivery_cents else 0 end),
          v_rent, v_dw, v_fees, v_rent + v_dw + v_fees, v_final, pm.current_user_id());
  update pm.rental_contracts set billed_through = greatest(v_end, v_start),
         status = case when v_final then 'CLOSED' else status end, closed_at = case when v_final then now() else closed_at end
   where id = c.id;
  v_out := pm.dealer_emit(c.org_id, c.location_id, 'DEALER_RENTAL_BILLED', 'pm:rentalbill:' || v_id::text,
    jsonb_build_object('billing_id', v_id, 'contract_id', c.id, 'contract_number', c.number, 'customer_id', c.customer_id,
      'unit', pm.dealer_unit_json(c.asset_id), 'period_start', v_start, 'period_end', greatest(v_end, v_start), 'is_final', v_final,
      'rates', jsonb_build_object('day_cents', c.rate_day_cents, 'week_cents', c.rate_week_cents, 'month_cents', c.rate_month_cents),
      'charge', v_ch, 'rental_cents', v_rent, 'damage_waiver_cents', v_dw,
      'fees', jsonb_build_object('fuel_cents', case when v_final then c.fuel_cents else 0 end, 'cleaning_cents', case when v_final then c.cleaning_cents else 0 end,
                                 'damage_cents', case when v_final then c.damage_cents else 0 end,
                                 'delivery_cents', case when c.billed_through is null then c.delivery_cents else 0 end),
      'total_cents', v_rent + v_dw + v_fees, 'meter_out', c.meter_out, 'meter_in', c.meter_in,
      'hours_used', case when c.meter_in is not null then c.meter_in - c.meter_out end),
    greatest(v_end, v_start)::date, c.is_sample, 'rental_contracts', c.id, null);
  update pm.rental_billings set outbox_id = v_out where id = v_id;
  perform pm.log_activity(c.org_id, c.location_id, null, 'rental.billed', 'rental_contracts', c.id,
    format('%s billed %s cents%s', c.number, v_rent + v_dw + v_fees, case when v_final then ' (final)' else '' end),
    jsonb_build_object('billing_id', v_id, 'outbox_id', v_out));
  return v_id;
end $$;

create or replace function pm.cancel_rental(p_contract uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rental contract % not found in the caller''s organization', p_contract using errcode = '42501';
  end if;
  if c.status <> 'RESERVED' then raise exception 'PM_RENTAL_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  update pm.rental_contracts set status = 'CANCELLED', cancelled_at = now(), cancel_reason = p_reason where id = c.id;
  perform pm.log_activity(c.org_id, c.location_id, null, 'rental.cancelled', 'rental_contracts', c.id, format('%s cancelled', c.number),
    jsonb_build_object('reason', p_reason));
  return c.id;
end $$;

-- ----------------------------------------------------------------------------
-- 13. Seam: release, inbound from Books, acks
-- ----------------------------------------------------------------------------
create or replace function pm.dealer_inbound_check(p_row core.events) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if coalesce(p_row.payload ->> 'schema_version', '') <> '1' then
    raise exception 'DEALER_SCHEMA_UNSUPPORTED: % schema_version % (Projects consumes 1)', p_row.event_type,
      coalesce(p_row.payload ->> 'schema_version', '(missing)');
  end if;
  if (p_row.payload ? 'org_id') and (p_row.payload ->> 'org_id') is distinct from p_row.org_id::text then
    raise exception 'DEALER_ORG_MISMATCH: payload org_id differs from the event row';
  end if;
end $$;

-- Unit by Projects unit id (payload.unit_id) or by serial (+ make).
create or replace function pm.dealer_resolve_unit(p_org uuid, p jsonb) returns uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  if coalesce(p ->> 'unit_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select a.id into v from pm.assets a where a.org_id = p_org and a.id = (p ->> 'unit_id')::uuid;
    if v is not null then return v; end if;
  end if;
  if nullif(p ->> 'serial_number', '') is not null then
    select a.id into v from pm.assets a
    where a.org_id = p_org and lower(a.serial_number) = lower(p ->> 'serial_number')
      and (nullif(p ->> 'make', '') is null or lower(coalesce(a.make, '')) = lower(p ->> 'make'))
    order by (a.unit_status is not null) desc, a.updated_at desc limit 1;
  end if;
  return v;
end $$;

-- DEALER_FLOOR_STATUS: {unit_id | serial_number[, make], floor_status FLOORED|SOLD_UNPAID|PAID_OFF|NOT_FLOORED|IN_DEFAULT|RETURNED
--   (or floored bool), lender_vendor_id, note_ref, principal_cents, payoff_cents, payoff_due_on, payoff_scheduled,
--   curtailment_due_on, curtailment_cents, books_cost_cents, as_of}. Newest (as_of, event created_at) wins.
create or replace function pm.dealer_apply_floor_status(p_row core.events) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p jsonb := p_row.payload; v_asset uuid; a pm.assets%rowtype; f pm.dealer_floor_status%rowtype; v_status text; v_floored boolean;
        v_asof timestamptz; v_payoff bigint; v_books bigint;
begin
  perform pm.dealer_inbound_check(p_row);
  v_asset := pm.dealer_resolve_unit(p_row.org_id, p);
  if v_asset is null then
    raise exception 'DEALER_UNKNOWN_UNIT: no unit % / serial % in this org', coalesce(p ->> 'unit_id', '-'), coalesce(p ->> 'serial_number', '-');
  end if;
  select * into a from pm.assets x where x.id = v_asset for update;
  v_status := upper(coalesce(nullif(p ->> 'floor_status', ''),
                             case when (p ->> 'floored')::boolean then 'FLOORED' else 'NOT_FLOORED' end));
  if v_status not in ('FLOORED','SOLD_UNPAID','PAID_OFF','NOT_FLOORED','IN_DEFAULT','RETURNED') then
    raise exception 'DEALER_INVALID: floor_status %', v_status;
  end if;
  v_floored := v_status in ('FLOORED','SOLD_UNPAID','IN_DEFAULT');
  v_asof := coalesce(nullif(p ->> 'as_of', '')::timestamptz, p_row.occurred_on::timestamptz);
  v_payoff := case when v_floored then coalesce(nullif(p ->> 'payoff_cents', '')::bigint, nullif(p ->> 'principal_cents', '')::bigint, 0) else 0 end;
  v_books := nullif(p ->> 'books_cost_cents', '')::bigint;
  if v_payoff < 0 or coalesce(v_books, 0) < 0 then raise exception 'DEALER_INVALID: negative amount'; end if;
  select * into f from pm.dealer_floor_status x where x.org_id = p_row.org_id and x.asset_id = v_asset;
  if found and (v_asof, p_row.created_at) < (f.as_of, f.event_created_at) then
    return 'STALE';
  end if;
  insert into pm.dealer_floor_status as fs (org_id, asset_id, location_id, floored, floor_status, lender_vendor_id, note_ref, principal_cents,
                                            payoff_cents, payoff_due_on, payoff_scheduled, curtailment_due_on, curtailment_cents,
                                            books_cost_cents, as_of, event_id, event_created_at, updated_at)
  values (p_row.org_id, v_asset, a.location_id, v_floored, v_status, nullif(p ->> 'lender_vendor_id', '')::uuid, nullif(p ->> 'note_ref', ''),
          nullif(p ->> 'principal_cents', '')::bigint, v_payoff, nullif(p ->> 'payoff_due_on', '')::date,
          coalesce((p ->> 'payoff_scheduled')::boolean, false), nullif(p ->> 'curtailment_due_on', '')::date,
          nullif(p ->> 'curtailment_cents', '')::bigint, v_books, v_asof, p_row.event_id, p_row.created_at, now())
  on conflict (org_id, asset_id) do update set
    location_id = excluded.location_id, floored = excluded.floored, floor_status = excluded.floor_status,
    lender_vendor_id = coalesce(excluded.lender_vendor_id, fs.lender_vendor_id), note_ref = coalesce(excluded.note_ref, fs.note_ref),
    principal_cents = excluded.principal_cents, payoff_cents = excluded.payoff_cents, payoff_due_on = excluded.payoff_due_on,
    payoff_scheduled = excluded.payoff_scheduled, curtailment_due_on = excluded.curtailment_due_on,
    curtailment_cents = excluded.curtailment_cents, books_cost_cents = coalesce(excluded.books_cost_cents, fs.books_cost_cents),
    as_of = excluded.as_of, event_id = excluded.event_id, event_created_at = excluded.event_created_at, updated_at = now();
  update pm.assets set floored = v_floored, floor_status = v_status,
         floor_lender_vendor_id = coalesce(nullif(p ->> 'lender_vendor_id', '')::uuid, floor_lender_vendor_id),
         floor_note_ref = coalesce(nullif(p ->> 'note_ref', ''), floor_note_ref),
         payoff_cents = v_payoff, payoff_due_on = nullif(p ->> 'payoff_due_on', '')::date,
         payoff_scheduled = coalesce((p ->> 'payoff_scheduled')::boolean, false), floor_status_at = now(),
         books_cost_cents = coalesce(v_books, books_cost_cents), books_cost_as_of = case when v_books is not null then v_asof else books_cost_as_of end,
         sot_alert_at = case when v_status = 'PAID_OFF' then null else sot_alert_at end,
         sot_alert = case when v_status = 'PAID_OFF' then null else sot_alert end
   where id = v_asset;
  if v_status = 'PAID_OFF' then
    update pm.dealer_sot_alerts set cleared_at = now() where org_id = p_row.org_id and asset_id = v_asset and cleared_at is null;
    update pm.dealer_deals set sot_alert_at = null, sot_alert = null where org_id = p_row.org_id and id = a.deal_id and sot_alert_at is not null;
  end if;
  perform pm.log_activity(p_row.org_id, a.location_id, null, 'dealer_unit.floor_status', 'assets', v_asset,
    format('%s floor plan: %s (payoff %s cents)', coalesce(a.stock_number, a.serial_number), v_status, v_payoff),
    jsonb_build_object('event_id', p_row.event_id, 'floor_status', v_status, 'payoff_cents', v_payoff,
                       'payoff_due_on', p ->> 'payoff_due_on', 'payoff_scheduled', p -> 'payoff_scheduled'), 'SYSTEM');
  return 'APPLIED';
end $$;

-- DEALER_SOT_ALERT: {unit_id | serial_number, deal_id?, sold_on, payoff_due_on, days_out_of_trust, amount_cents,
--   lender_vendor_id, message}. Surfaces on the unit and its deal; the activity feed is the manager notification.
create or replace function pm.dealer_apply_sot_alert(p_row core.events) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p jsonb := p_row.payload; v_asset uuid; a pm.assets%rowtype; v_deal uuid; v_alert jsonb;
begin
  perform pm.dealer_inbound_check(p_row);
  v_asset := pm.dealer_resolve_unit(p_row.org_id, p);
  if v_asset is null then raise exception 'DEALER_UNKNOWN_UNIT: no unit % / serial %', coalesce(p ->> 'unit_id', '-'), coalesce(p ->> 'serial_number', '-'); end if;
  select * into a from pm.assets x where x.id = v_asset for update;
  v_deal := coalesce(case when coalesce(p ->> 'deal_id', '') ~ '^[0-9a-fA-F-]{36}$'
                          then (select d.id from pm.dealer_deals d where d.org_id = p_row.org_id and d.id = (p ->> 'deal_id')::uuid) end, a.deal_id);
  v_alert := jsonb_build_object('event_id', p_row.event_id, 'sold_on', p ->> 'sold_on', 'payoff_due_on', p ->> 'payoff_due_on',
               'days_out_of_trust', p -> 'days_out_of_trust', 'amount_cents', p -> 'amount_cents', 'lender_vendor_id', p ->> 'lender_vendor_id',
               'message', p ->> 'message');
  insert into pm.dealer_sot_alerts (org_id, location_id, asset_id, deal_id, sold_on, payoff_due_on, days_out_of_trust, amount_cents,
                                    lender_vendor_id, message, event_id)
  values (p_row.org_id, a.location_id, v_asset, v_deal, nullif(p ->> 'sold_on', '')::date, nullif(p ->> 'payoff_due_on', '')::date,
          nullif(p ->> 'days_out_of_trust', '')::int, nullif(p ->> 'amount_cents', '')::bigint, nullif(p ->> 'lender_vendor_id', '')::uuid,
          p ->> 'message', p_row.event_id)
  on conflict (org_id, event_id) do nothing;
  update pm.assets set sot_alert_at = now(), sot_alert = v_alert where id = v_asset;
  if v_deal is not null then
    update pm.dealer_deals set sot_alert_at = now(), sot_alert = v_alert where org_id = p_row.org_id and id = v_deal;
  end if;
  perform pm.log_activity(p_row.org_id, a.location_id, null, 'dealer.sot_alert', 'assets', v_asset,
    format('SOLD OUT OF TRUST: %s — payoff %s cents due %s (%s days)', coalesce(a.stock_number, a.serial_number),
           coalesce(p ->> 'amount_cents', '?'), coalesce(p ->> 'payoff_due_on', '?'), coalesce(p ->> 'days_out_of_trust', '?')),
    v_alert || jsonb_build_object('deal_id', v_deal, 'notify', 'sales_manager'), 'SYSTEM');
  return 'APPLIED';
end $$;

-- DEALER_WARRANTY_PAID: {claim_id | claim_source_ref, outcome CREDITED | SHORT_PAID | REJECTED, credited_cents,
--   short_cents?, reason, credit_ref, paid_on}. service_role: the only path that sets a claim PAID / REJECTED from Books.
create or replace function pm.apply_warranty_payment(p_row core.events) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p jsonb := p_row.payload; c pm.warranty_claims%rowtype; v_claim uuid; v_out text := upper(coalesce(p ->> 'outcome', '')); v_cred bigint;
        v_short bigint; v_loc uuid;
begin
  perform pm.dealer_inbound_check(p_row);
  if coalesce(p ->> 'claim_id', '') ~ '^[0-9a-fA-F-]{36}$' then
    v_claim := (p ->> 'claim_id')::uuid;
  elsif coalesce(p ->> 'claim_source_ref', '') ~ '^pm:wclaim:[0-9a-fA-F-]{36}' then
    v_claim := substring(p ->> 'claim_source_ref' from 11 for 36)::uuid;
  end if;
  select * into c from pm.warranty_claims x where x.org_id = p_row.org_id and x.id = v_claim for update;
  if not found then raise exception 'DEALER_UNKNOWN_CLAIM: % is not a claim in this org', coalesce(p ->> 'claim_id', p ->> 'claim_source_ref', '-'); end if;
  if v_out not in ('CREDITED','SHORT_PAID','REJECTED') then raise exception 'DEALER_INVALID: outcome %', v_out; end if;
  if c.status in ('PAID','REJECTED','WRITTEN_OFF') and c.books_outcome is not null then
    return 'STALE';                                 -- already settled from an earlier Books event
  end if;
  if c.status not in ('SUBMITTED','RETURNED','APPROVED') then
    raise exception 'DEALER_CLAIM_NOT_OPEN: claim % is %', c.id, c.status;
  end if;
  v_cred := coalesce(nullif(p ->> 'credited_cents', '')::bigint, case when v_out = 'CREDITED' then coalesce(c.approved_cents, c.claimed_cents) else 0 end);
  if v_cred < 0 or v_cred > c.claimed_cents then raise exception 'DEALER_INVALID: credited % outside 0..claimed %', v_cred, c.claimed_cents; end if;
  v_short := case when v_out = 'REJECTED' then c.claimed_cents
                  else coalesce(nullif(p ->> 'short_cents', '')::bigint, c.claimed_cents - v_cred) end;
  perform set_config('pm.dealer_inbound', 'on', true);
  update pm.warranty_claims set
    status = case when v_out = 'REJECTED' then 'REJECTED' else 'PAID' end,
    approved_cents = case when v_out = 'REJECTED' then approved_cents else v_cred end,
    paid_cents = case when v_out = 'REJECTED' then paid_cents else v_cred end,
    paid_at = case when v_out = 'REJECTED' then paid_at else coalesce(nullif(p ->> 'paid_on', '')::timestamptz, now()) end,
    decided_at = coalesce(decided_at, now()),
    short_paid_cents = case when v_out = 'SHORT_PAID' then v_short else 0 end,
    decision_reason = coalesce(nullif(p ->> 'reason', ''), decision_reason),
    books_outcome = v_out, books_credit_ref = nullif(p ->> 'credit_ref', ''), books_paid_on = nullif(p ->> 'paid_on', '')::date
  where id = c.id;
  perform set_config('pm.dealer_inbound', '', true);
  insert into pm.dealer_warranty_payments (org_id, claim_id, outcome, credited_cents, short_cents, reason, credit_ref, paid_on, event_id)
  values (c.org_id, c.id, v_out, case when v_out = 'REJECTED' then 0 else v_cred end, greatest(v_short, 0), nullif(p ->> 'reason', ''),
          nullif(p ->> 'credit_ref', ''), nullif(p ->> 'paid_on', '')::date, p_row.event_id)
  on conflict (org_id, event_id) do nothing;
  select w.location_id into v_loc from pm.work_orders w where w.org_id = c.org_id and w.id = c.work_order_id;
  perform pm.log_activity(c.org_id, v_loc, c.job_id, 'warranty_claim.' || lower(v_out), 'warranty_claims', c.id,
    format('Merit Books: warranty claim %s %s (%s credited, %s short)', coalesce(c.claim_number, ''), lower(replace(v_out, '_', '-')), v_cred, v_short),
    jsonb_build_object('event_id', p_row.event_id, 'outcome', v_out, 'credited_cents', v_cred, 'short_cents', v_short, 'reason', p ->> 'reason'), 'SYSTEM');
  return 'APPLIED';
end $$;

-- service_role (scheduler). p_org null = every org. 1) acks on RELEASED rows; 2) inbound Books events
-- (Projects is the sole consumer: it writes their status, like JOB_COST); a bad event is REJECTED in its
-- own subtransaction and cannot abort the batch.
create or replace function pm.apply_dealer_inbound(p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a record; r core.events%rowtype; v_out text; n_ack int := 0; n_app int := 0; n_stale int := 0; n_rej int := 0; n_dup int := 0;
        v_orgs uuid[] := '{}'; v_last_at timestamptz; v_last_id uuid; v_res jsonb; o uuid;
begin
  for a in
    select x.id, x.org_id, x.location_id, x.event_type, x.subject_table, x.subject_id, e.status as ev, e.gl_entry_id, e.invoice_id,
           e.invoice_number, e.error
    from pm.dealer_outbox x join core.events e on e.org_id = x.org_id and e.event_id = x.event_id
    where x.status = 'RELEASED' and e.status in ('processed','rejected') and (p_org is null or x.org_id = p_org)
    order by x.seq
    for update of x skip locked
  loop
    update pm.dealer_outbox set status = case when a.ev = 'processed' then 'PROCESSED' else 'REJECTED' end, acked_at = now(), updated_at = now(),
           gl_entry_id = a.gl_entry_id, invoice_id = a.invoice_id, invoice_number = a.invoice_number,
           error_text = case when a.ev = 'rejected' then coalesce(a.error, 'Rejected by Merit Books (no reason given)') end
     where id = a.id;
    if a.event_type = 'DEALER_DEPOSIT_REQUEST' then
      update pm.dealer_deposits set status = case when a.ev = 'processed' then 'ISSUED' else 'REJECTED' end, invoice_id = a.invoice_id,
             invoice_number = a.invoice_number, error_text = case when a.ev = 'rejected' then coalesce(a.error, 'Rejected by Merit Books') end
       where org_id = a.org_id and outbox_id = a.id;
    end if;
    if a.ev = 'rejected' then
      perform pm.log_activity(a.org_id, a.location_id, null, 'dealer.event_rejected', a.subject_table, a.subject_id,
        format('Merit Books rejected %s: %s', a.event_type, coalesce(a.error, 'no reason given')),
        jsonb_build_object('outbox_id', a.id, 'error', a.error), 'SYSTEM');
    end if;
    n_ack := n_ack + 1;
  end loop;

  for r in
    select * from core.events e
    where (p_org is null or e.org_id = p_org) and e.status = 'pending' and e.source_module <> 'PROJECTS'
      and e.event_type in ('DEALER_FLOOR_STATUS','DEALER_SOT_ALERT','DEALER_WARRANTY_PAID')
    order by e.created_at, e.id
    for update skip locked
  loop
    if not (r.org_id = any (v_orgs)) then v_orgs := v_orgs || r.org_id; end if;
    if exists (select 1 from pm.dealer_inbound_events x where x.org_id = r.org_id and x.event_id = r.event_id and x.outcome in ('APPLIED','STALE')) then
      update core.events set status = 'processed', processed_at = now(), error = null where id = r.id;
      n_dup := n_dup + 1;
      continue;
    end if;
    begin
      v_out := case r.event_type
                 when 'DEALER_FLOOR_STATUS' then pm.dealer_apply_floor_status(r)
                 when 'DEALER_SOT_ALERT'    then pm.dealer_apply_sot_alert(r)
                 else pm.apply_warranty_payment(r) end;
    exception when others then
      v_out := 'REJECTED:' || sqlerrm;
    end;
    if v_out like 'REJECTED:%' then
      update core.events set status = 'rejected', error = left(substr(v_out, 10), 500), processed_at = now() where id = r.id;
      insert into pm.dealer_inbound_events (org_id, event_id, event_type, outcome, error)
      values (r.org_id, r.event_id, r.event_type, 'REJECTED', left(substr(v_out, 10), 500))
      on conflict (org_id, event_id) do update set outcome = 'REJECTED', error = excluded.error, applied_at = now();
      n_rej := n_rej + 1;
    else
      update core.events set status = 'processed', processed_at = now(), error = null where id = r.id;
      insert into pm.dealer_inbound_events (org_id, event_id, event_type, outcome)
      values (r.org_id, r.event_id, r.event_type, v_out)
      on conflict (org_id, event_id) do update set outcome = excluded.outcome, error = null, applied_at = now();
      if v_out = 'APPLIED' then n_app := n_app + 1; else n_stale := n_stale + 1; end if;
    end if;
    if v_last_at is null or r.created_at >= v_last_at then v_last_at := r.created_at; v_last_id := r.event_id; end if;
  end loop;

  v_res := jsonb_build_object('acks', n_ack, 'applied', n_app, 'stale', n_stale, 'rejected', n_rej, 'duplicate', n_dup);
  if p_org is not null and not (p_org = any (v_orgs)) then v_orgs := v_orgs || p_org; end if;
  foreach o in array v_orgs loop
    insert into pm.event_cursor as ec (org_id, consumer, last_event_created_at, last_event_id, last_run_at, last_run_kind, last_run, runs)
    values (o, 'DEALER_INBOUND', v_last_at, v_last_id, now(), 'SERVICE', v_res, 1)
    on conflict (org_id, consumer) do update
      set last_event_created_at = coalesce(greatest(ec.last_event_created_at, excluded.last_event_created_at), ec.last_event_created_at, excluded.last_event_created_at),
          last_event_id = case when excluded.last_event_created_at is not null
                                    and (ec.last_event_created_at is null or excluded.last_event_created_at >= ec.last_event_created_at)
                               then excluded.last_event_id else ec.last_event_id end,
          last_run_at = now(), last_run_kind = 'SERVICE', last_run = excluded.last_run, runs = ec.runs + 1;
  end loop;
  return v_res;
end $$;

-- service_role: release HELD dealer events for orgs whose flag is on (p_org null = every org).
create or replace function pm.release_dealer_outbox(p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_o uuid; n int; v_tot int := 0; v_wait int := 0; v_by jsonb := '[]';
begin
  for v_o in select distinct x.org_id from pm.dealer_outbox x where x.status = 'HELD' and (p_org is null or x.org_id = p_org) order by 1 loop
    if pm.books_present(v_o) and pm.dealer_seam_on(v_o) then
      perform pg_advisory_xact_lock(hashtextextended('pm.dealer_outbox:' || v_o::text, 0));
      n := pm.dealer_release_locked(v_o);
      v_tot := v_tot + n;
      v_by := v_by || jsonb_build_array(jsonb_build_object('org_id', v_o, 'released', n));
    else
      select count(*) into n from pm.dealer_outbox x where x.org_id = v_o and x.status = 'HELD';
      v_wait := v_wait + n;
    end if;
  end loop;
  return jsonb_build_object('released', v_tot, 'held_waiting', v_wait, 'by_org', v_by);
end $$;

-- Member: re-send an event Books rejected (after the cause is fixed in Books' setup). Same source_ref
-- (Books dedupes on it), a new event_id.
create or replace function pm.resend_dealer_event(p_outbox uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare x pm.dealer_outbox%rowtype; v_event uuid := gen_random_uuid(); v_payload jsonb;
begin
  select * into x from pm.dealer_outbox o where o.id = p_outbox for update;
  if x.org_id is null or x.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: dealer event % not found in the caller''s organization', p_outbox using errcode = '42501';
  end if;
  if x.status <> 'REJECTED' then raise exception 'PM_DEALER_EVENT_NOT_REJECTED: % is %', x.source_ref, x.status using errcode = '22023'; end if;
  if not (pm.books_present(x.org_id) and pm.dealer_seam_on(x.org_id)) then
    raise exception 'PM_DEALER_SEAM_OFF: Merit Books is not taking dealer events for this organization' using errcode = '55000';
  end if;
  v_payload := x.payload || jsonb_build_object('event_id', v_event, 'resend_of_event_id', x.event_id, 'resent_count', x.resent_count + 1);
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (x.org_id, v_event, x.event_type, 'PROJECTS', v_payload, x.occurred_on, 'pending');
  update pm.dealer_outbox set event_id = v_event, payload = v_payload, status = 'RELEASED', released_at = now(), acked_at = null,
         error_text = null, resent_count = resent_count + 1, updated_at = now()
   where id = x.id;
  if x.event_type = 'DEALER_DEPOSIT_REQUEST' then
    update pm.dealer_deposits set status = 'REQUESTED', error_text = null where org_id = x.org_id and outbox_id = x.id;
  end if;
  perform pm.log_activity(x.org_id, x.location_id, null, 'dealer.event_resent', x.subject_table, x.subject_id,
    format('Re-sent %s to Merit Books', x.event_type), jsonb_build_object('outbox_id', x.id, 'event_id', v_event));
  return v_event;
end $$;

-- service_role: one scheduler tick (1103's keys kept) + the dealer outbox and inbound.
create or replace function pm.run_seam_cycle(p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  return jsonb_build_object('job_cost', pm.drain_job_costs(p_org),
                            'reconcile', pm.reconcile_billing_requests(p_org),
                            'commitment_holds_resent', pm.sync_commitment_holds(p_org),
                            'dealer_outbox', pm.release_dealer_outbox(p_org),
                            'dealer_inbound', pm.apply_dealer_inbound(p_org));
end $$;

-- ----------------------------------------------------------------------------
-- 14. Triggers
-- ----------------------------------------------------------------------------
create or replace trigger trg_asset_dealer_lock before insert or update on pm.assets
  for each row execute function pm.tg_asset_dealer_lock();
create or replace trigger trg_refs_in_org_dealer before insert or update of mfr_vendor_id on pm.assets
  for each row execute function pm.tg_refs_in_org('mfr_vendor_id:core.vendors');
create or replace trigger trg_wo_line_part before insert or update of part_id on pm.work_order_lines
  for each row execute function pm.tg_wo_line_part();
create or replace trigger trg_dealer_ro_closed after update of status on pm.work_orders
  for each row when (new.status = 'CLOSED' and old.status is distinct from 'CLOSED')
  execute function pm.tg_dealer_ro_closed();
create or replace trigger trg_dealer_warranty_claim_status after update of status on pm.warranty_claims
  for each row when (new.status is distinct from old.status)
  execute function pm.tg_dealer_warranty_claim_status();
create or replace trigger trg_document_subject_in_org before insert or update of subject_table, subject_id, org_id on pm.document_links
  for each row execute function pm.tg_document_subject_in_org();

create or replace trigger trg_dealer_deal_line before insert or update or delete on pm.dealer_deal_lines
  for each row execute function pm.tg_dealer_deal_line();
create or replace trigger trg_dealer_trade before insert or update or delete on pm.dealer_trades
  for each row execute function pm.tg_dealer_trade();
create or replace trigger trg_dealer_fi_product before insert or update or delete on pm.dealer_fi_products
  for each row execute function pm.tg_dealer_fi_product();
create or replace trigger trg_parts_ticket_line before insert or update or delete on pm.parts_ticket_lines
  for each row execute function pm.tg_parts_ticket_line();
create or replace trigger trg_parts_order_line before insert or update or delete on pm.parts_order_lines
  for each row execute function pm.tg_parts_order_line();
create or replace trigger trg_parts_count_line before update on pm.parts_count_lines
  for each row execute function pm.tg_parts_count_line();

do $$
declare t text;
begin
  foreach t in array array['dealer_settings','dealer_outbox','dealer_deals','dealer_deal_lines','dealer_trades','dealer_fi_products',
    'dealer_deposits','parts','parts_tickets','parts_ticket_lines','parts_special_orders','parts_orders','parts_order_lines',
    'parts_count_lines','rental_rates','rental_contracts'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['dealer_deal_lines','dealer_trades','dealer_fi_products'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
  foreach t in array array['dealer_settings','dealer_outbox','dealer_deals','dealer_quotes','dealer_deposits','dealer_unit_costs','parts',
    'parts_tickets','parts_special_orders','parts_orders','parts_counts','rental_rates','rental_contracts','rental_billings'] loop
    execute format('create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
end $$;

create or replace trigger trg_refs_in_org before insert or update on pm.dealer_deals
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers', 'finance_vendor_id:core.vendors');
create or replace trigger trg_refs_in_org before insert or update on pm.dealer_deal_lines
  for each row execute function pm.tg_refs_in_org('oem_vendor_id:core.vendors');
create or replace trigger trg_refs_in_org before insert or update on pm.dealer_trades
  for each row execute function pm.tg_refs_in_org('lienholder_vendor_id:core.vendors');
create or replace trigger trg_refs_in_org before insert or update on pm.dealer_fi_products
  for each row execute function pm.tg_refs_in_org('provider_vendor_id:core.vendors');
create or replace trigger trg_refs_in_org before insert or update on pm.parts
  for each row execute function pm.tg_refs_in_org('mfr_vendor_id:core.vendors', 'item_id:core.items');
create or replace trigger trg_refs_in_org before insert or update on pm.parts_tickets
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers');
create or replace trigger trg_refs_in_org before insert or update on pm.parts_special_orders
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers', 'vendor_id:core.vendors');
create or replace trigger trg_refs_in_org before insert or update on pm.parts_orders
  for each row execute function pm.tg_refs_in_org('vendor_id:core.vendors');
create or replace trigger trg_refs_in_org before insert or update on pm.rental_contracts
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers');
create or replace trigger trg_refs_in_org before insert or update on pm.dealer_unit_costs
  for each row execute function pm.tg_refs_in_org('vendor_id:core.vendors');
create or replace trigger trg_refs_in_org_dealer before insert or update of oem_vendor_id on pm.warranty_claims
  for each row execute function pm.tg_refs_in_org('oem_vendor_id:core.vendors');

-- ----------------------------------------------------------------------------
-- 15. Views (security_invoker)
-- ----------------------------------------------------------------------------

-- Whole-goods inventory with aging buckets, operational vs Books cost, floor-plan status.
create or replace view pm.v_dealer_unit_inventory with (security_invoker = on) as
select
  a.org_id, a.location_id, a.id as unit_id, a.stock_number, a.serial_number, a.vin, a.make, a.mfr_vendor_id, a.model, a.model_year,
  a.category, a.condition, a.unit_status, a.kind, a.stock_location_id, sl.code as stock_location_code, a.received_on,
  (current_date - a.received_on) as days_in_stock,
  case when a.received_on is null then null
       when current_date - a.received_on <= 90 then '0-90'
       when current_date - a.received_on <= 180 then '91-180'
       when current_date - a.received_on <= 365 then '181-365'
       else '365+' end as aging_bucket,
  a.dealer_cost_cents as cost_cents, coalesce(ca.acked, 0)::bigint as cost_acked_by_books_cents,
  a.books_cost_cents, a.books_cost_as_of, a.retail_price_cents, a.advertised_price_cents, a.meter_reading, a.attachments,
  a.floored, a.floor_status, a.floor_lender_vendor_id, a.floor_note_ref, a.payoff_cents, a.payoff_due_on, a.payoff_scheduled, a.floor_status_at,
  (a.sot_alert_at is not null) as sold_out_of_trust, a.sot_alert_at,
  a.deal_id, d.number as deal_number, d.stage as deal_stage, a.unit_life, a.is_sample
from pm.assets a
left join pm.stock_locations sl on sl.org_id = a.org_id and sl.id = a.stock_location_id
left join pm.dealer_deals d on d.org_id = a.org_id and d.id = a.deal_id
left join lateral (
  select sum(c.amount_cents) as acked
  from pm.dealer_unit_costs c join pm.dealer_outbox o on o.org_id = c.org_id and o.id = c.outbox_id
  where c.org_id = a.org_id and c.asset_id = a.id and c.unit_life = a.unit_life and c.status = 'ACTIVE' and o.status = 'PROCESSED'
) ca on true
where a.unit_status in ('ON_ORDER','IN_TRANSIT','IN_STOCK','PDI','DEMO','RENTAL','ON_HOLD','SOLD');

-- Deals pipeline with gross (live totals until delivered; pinned final totals after).
create or replace view pm.v_dealer_deals_pipeline with (security_invoker = on) as
select
  d.org_id, d.location_id, d.id as deal_id, d.number, d.stage, d.stage_entered_at, (current_date - d.created_at::date) as age_days,
  d.customer_id, coalesce(cu.display_name, cu.name) as customer_name, d.salesperson_user_id, d.finance_type,
  (t.v ->> 'unit_count')::int as unit_count,
  (t.v ->> 'sale_price_cents')::bigint as sale_price_cents,
  (t.v ->> 'unit_cost_cents')::bigint as unit_cost_cents,
  (t.v ->> 'over_allowance_cents')::bigint as over_allowance_cents,
  (t.v ->> 'front_gross_cents')::bigint as front_gross_cents,
  (t.v ->> 'back_gross_cents')::bigint as back_gross_cents,
  (t.v ->> 'total_gross_cents')::bigint as total_gross_cents,
  (t.v ->> 'front_gross_pct')::numeric as front_gross_pct,
  (t.v ->> 'balance_due_estimate_cents')::bigint as balance_due_estimate_cents,
  d.approved_by, d.approved_at, d.approval ->> 'rule' as approval_rule, d.delivered_on,
  (d.sot_alert_at is not null) as sold_out_of_trust, d.is_sample,
  case d.stage when 'QUOTE' then 'QUOTE_OR_WRITE' when 'WRITTEN' then 'DESK_APPROVAL' when 'APPROVED' then 'FUND'
               when 'FUNDED' then 'DELIVER' else null end as next_action
from pm.dealer_deals d
left join core.customers cu on cu.org_id = d.org_id and cu.id = d.customer_id
cross join lateral (select coalesce(d.final_totals, pm.dealer_deal_totals(d.id)) as v) t;

-- Parts on hand (quantity projection) by stock location, with bins, min/max, on order, special orders.
create or replace view pm.v_parts_on_hand with (security_invoker = on) as
with oh as (
  select x.org_id, x.stock_location_id, x.item_id, sum(x.qty) as qty
  from (select m.org_id, m.to_stock_location_id as stock_location_id, m.item_id, m.qty from pm.material_moves m where m.to_stock_location_id is not null
        union all
        select m.org_id, m.from_stock_location_id, m.item_id, -m.qty from pm.material_moves m where m.from_stock_location_id is not null) x
  group by x.org_id, x.stock_location_id, x.item_id
), keys as (
  select oh.org_id, oh.stock_location_id, oh.item_id from oh
  union select t.org_id, t.stock_location_id, t.item_id from pm.stock_targets t
)
select
  p.org_id, p.location_id, p.id as part_id, p.part_number, p.manufacturer, p.description, p.status as part_status,
  p.superseded_by_part_id, k.stock_location_id, s.code as stock_location_code, t.bin,
  coalesce(oh.qty, 0)::numeric(14,4) as qty_on_hand, t.min_qty, t.max_qty,
  (t.min_qty is not null and coalesce(oh.qty, 0) < t.min_qty) as below_min,
  coalesce(oo.qty, 0)::numeric(14,4) as qty_on_order,
  coalesce(so.qty, 0)::numeric(14,4) as qty_special_order_open,
  p.cost_cents, p.price_cents, p.core_charge_cents,
  round(coalesce(oh.qty, 0) * coalesce(p.cost_cents, 0))::bigint as extended_cost_cents
from keys k
join pm.parts p on p.org_id = k.org_id and p.item_id = k.item_id
join pm.stock_locations s on s.org_id = k.org_id and s.id = k.stock_location_id and s.location_id = p.location_id
left join oh on oh.org_id = k.org_id and oh.stock_location_id = k.stock_location_id and oh.item_id = k.item_id
left join pm.stock_targets t on t.org_id = k.org_id and t.stock_location_id = k.stock_location_id and t.item_id = k.item_id
left join lateral (
  select sum(l.qty_ordered - l.qty_received) as qty from pm.parts_order_lines l join pm.parts_orders o on o.org_id = l.org_id and o.id = l.order_id
  where l.org_id = p.org_id and l.part_id = p.id and o.stock_location_id = k.stock_location_id and o.status in ('SUBMITTED','PARTIAL')
) oo on true
left join lateral (
  select sum(x.qty) as qty from pm.parts_special_orders x
  where x.org_id = p.org_id and x.part_id = p.id and x.status in ('REQUESTED','ORDERED','RECEIVED','NOTIFIED')
) so on true;

-- Warranty claims still owed by the manufacturer (and the last word from Books).
create or replace view pm.v_warranty_outstanding with (security_invoker = on) as
select
  c.org_id, w.location_id, c.id as claim_id, c.claim_number, c.status, c.job_id, c.work_order_id, w.number as ro_number, c.asset_id,
  a.serial_number, c.payer_customer_id, c.oem_vendor_id, c.claimed_cents, c.approved_cents, c.paid_cents, c.short_paid_cents,
  greatest(coalesce(c.approved_cents, c.claimed_cents) - c.paid_cents, 0)::bigint as outstanding_cents,
  c.submitted_at, (current_date - c.submitted_at::date) as days_outstanding, c.filing_deadline,
  (c.status = 'DRAFT' and c.filing_deadline is not null and c.filing_deadline <= current_date + 5) as deadline_at_risk,
  c.books_outcome, c.books_paid_on,
  (select o.status from pm.dealer_outbox o where o.org_id = c.org_id and o.subject_table = 'warranty_claims' and o.subject_id = c.id
   order by o.seq desc limit 1) as last_event_status
from pm.warranty_claims c
join pm.work_orders w on w.org_id = c.org_id and w.id = c.work_order_id
left join pm.assets a on a.org_id = c.org_id and a.id = c.asset_id
where c.status in ('DRAFT','SUBMITTED','RETURNED','APPROVED');

-- Rental fleet time utilization, trailing 90 days (days on rent ÷ days available in the fleet).
create or replace view pm.v_rental_utilization with (security_invoker = on) as
select
  a.org_id, a.location_id, a.id as unit_id, a.stock_number, a.serial_number, a.make, a.model, a.unit_status,
  round((extract(epoch from (now() - greatest(coalesce(a.received_on::timestamptz, now() - interval '90 days'), now() - interval '90 days'))) / 86400)::numeric, 2)
    as available_days,
  round(coalesce((select sum(extract(epoch from (least(coalesce(r.checked_in_at, now()), now())
                                                 - greatest(r.checked_out_at, now() - interval '90 days'))) / 86400)
                  from pm.rental_contracts r
                  where r.org_id = a.org_id and r.asset_id = a.id and r.checked_out_at is not null
                    and coalesce(r.checked_in_at, now()) > now() - interval '90 days' and r.status <> 'CANCELLED'), 0)::numeric, 2)
    as on_rent_days,
  (select count(*) from pm.rental_contracts r where r.org_id = a.org_id and r.asset_id = a.id and r.status = 'OUT')::int as contracts_out,
  coalesce((select sum(b.total_cents) from pm.rental_billings b join pm.rental_contracts r on r.org_id = b.org_id and r.id = b.contract_id
            where r.org_id = a.org_id and r.asset_id = a.id and b.created_at >= now() - interval '90 days'), 0)::bigint as billed_90d_cents
from pm.assets a
where a.unit_status = 'RENTAL';

-- "Waiting on Merit Books": dealer events by state (HELD = Books has not switched its dealer consumers on).
create or replace view pm.v_dealer_outbox_queue with (security_invoker = on) as
select o.org_id, o.location_id, o.id as outbox_id, o.seq, o.event_type, o.source_ref, o.status, o.suppressed_reason, o.occurred_on,
       o.subject_table, o.subject_id, o.created_at, o.released_at, o.acked_at, o.error_text, o.resent_count,
       (current_date - o.created_at::date) as age_days,
       case o.status when 'HELD' then 'WAITING_ON_BOOKS_DEALER_SEAM' when 'RELEASED' then 'AWAITING_BOOKS'
                     when 'REJECTED' then 'FIX_AND_RESEND' end as next_action
from pm.dealer_outbox o
where o.status in ('HELD','RELEASED','REJECTED');

-- ---------------------------------------------------------------------------
-- Dealer KPIs (long form; added to the pm.v_kpis union).
--   unit_turn_days                  mean (delivered − received) days, units delivered in the trailing 365 d
--   aged_inventory_count_over_180   units IN_STOCK / PDI / DEMO / ON_HOLD received more than 180 days ago (point in time;
--                                   sample_n = units in stock)
--   deal_gross_avg_cents            mean total gross (front + back, operational, pinned at delivery) of deals delivered in
--                                   the trailing 90 d and not unwound
--   parts_fill_rate_pct             counter-ticket lines filled in full from stock ÷ all lines, tickets closed in 90 d
--   rental_utilization_pct          Σ days on rent ÷ Σ days available, current rental fleet, trailing 90 d
-- ---------------------------------------------------------------------------
create or replace view pm.v_kpis_dealer with (security_invoker = on) as
select a.org_id, a.location_id, null::uuid as job_id, 'unit_turn_days'::text as metric,
       round(avg(a.unit_delivered_on - a.received_on)::numeric, 2) as value, current_date as as_of,
       'dealer units delivered in trailing 365d: delivered − received'::text as basis, count(*)::int as sample_n
from pm.assets a
where a.unit_status = 'DELIVERED' and a.unit_delivered_on >= current_date - 365 and a.received_on is not null
group by a.org_id, a.location_id
union all
select a.org_id, a.location_id, null, 'aged_inventory_count_over_180',
       (count(*) filter (where current_date - a.received_on > 180))::numeric, current_date,
       'dealer units in stock (IN_STOCK/PDI/DEMO/ON_HOLD) received > 180 days ago', count(*)::int
from pm.assets a
where a.unit_status in ('IN_STOCK','PDI','DEMO','ON_HOLD') and a.received_on is not null
group by a.org_id, a.location_id
union all
select d.org_id, d.location_id, null, 'deal_gross_avg_cents',
       round(avg((d.final_totals ->> 'total_gross_cents')::numeric)), current_date,
       'deals delivered in trailing 90d: front + back gross (operational)', count(*)::int
from pm.dealer_deals d
where d.stage = 'DELIVERED' and d.delivered_at >= now() - interval '90 days'
group by d.org_id, d.location_id
union all
select t.org_id, t.location_id, null, 'parts_fill_rate_pct',
       round((count(*) filter (where l.qty_filled >= l.qty_requested))::numeric / count(*), 4), current_date,
       'counter ticket lines closed in trailing 90d filled in full from stock', count(*)::int
from pm.parts_tickets t join pm.parts_ticket_lines l on l.org_id = t.org_id and l.ticket_id = t.id
where t.status = 'CLOSED' and t.closed_at >= now() - interval '90 days'
group by t.org_id, t.location_id
union all
select u.org_id, u.location_id, null, 'rental_utilization_pct',
       round(sum(u.on_rent_days) / sum(u.available_days), 4), current_date,
       'rental fleet: days on rent ÷ days available, trailing 90d', count(*)::int
from pm.v_rental_utilization u
group by u.org_id, u.location_id
having sum(u.available_days) > 0;

-- One long KPI table across the industry modules (1104–1107 + dealer). Metric keys = packages/industry-packs/src/metrics.ts.
create or replace view pm.v_kpis with (security_invoker = on) as
select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_field_service
union all select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_production
union all select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_selections
union all select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_development
union all select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_dealer;

-- Pending-age alarm (1103) + the dealer types. HELD dealer events never reach core.events, so they
-- cannot alarm; RELEASED ones alarm like any other pending event.
create or replace view pm.v_seam_health with (security_invoker = on) as
select
  e.org_id, e.event_type,
  count(*) filter (where e.status = 'pending')::int    as pending_count,
  count(*) filter (where e.status = 'processed')::int  as processed_count,
  count(*) filter (where e.status = 'rejected')::int   as rejected_count,
  min(e.created_at) filter (where e.status = 'pending') as oldest_pending_at,
  floor(extract(epoch from (now() - min(e.created_at) filter (where e.status = 'pending'))) / 60)::bigint as oldest_pending_age_minutes,
  max(e.processed_at)                                   as last_processed_at,
  case when min(e.created_at) filter (where e.status = 'pending') is null then 'OK'
       when now() - min(e.created_at) filter (where e.status = 'pending') > interval '24 hours' then 'ALARM'
       when now() - min(e.created_at) filter (where e.status = 'pending') > interval '1 hour' then 'WARN'
       else 'OK' end                                    as alarm,
  (select c.last_run_at from pm.event_cursor c
    where c.org_id = e.org_id
      and c.consumer = case when e.event_type in ('DEALER_FLOOR_STATUS','DEALER_SOT_ALERT','DEALER_WARRANTY_PAID') then 'DEALER_INBOUND'
                            else e.event_type end) as last_drain_at
from core.events e
where e.event_type in ('JOB_COST','JOB_BILLING','JOB_PROGRESS','JOB_COMMITMENT','JOB_DEPOSIT_REQUEST',
                       'JOB_TIME','JOB_MATERIAL','JOB_PAYABLE_REQUEST',
                       'DEALER_UNIT_RECEIVED','DEALER_UNIT_COST','DEALER_UNIT_STATUS','DEALER_DEAL_FINALIZED','DEALER_DEAL_UNWOUND',
                       'DEALER_TRADE_RECEIVED','DEALER_PARTS_SALE','DEALER_RO_CLOSED','DEALER_WARRANTY_CLAIM','DEALER_WARRANTY_REGISTRATION',
                       'DEALER_RENTAL_BILLED','DEALER_DEPOSIT_REQUEST',
                       'DEALER_FLOOR_STATUS','DEALER_SOT_ALERT','DEALER_WARRANTY_PAID')
  and (e.org_id = public.get_org_id() or current_user = 'service_role')
group by e.org_id, e.event_type;

-- ----------------------------------------------------------------------------
-- 16. RLS (D12)
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['dealer_settings','dealer_outbox','dealer_inbound_events','dealer_floor_status','dealer_sot_alerts',
    'dealer_warranty_payments','dealer_unit_costs','dealer_deals','dealer_deal_lines','dealer_quotes','dealer_trades','dealer_fi_products',
    'dealer_deposits','parts','parts_tickets','parts_ticket_lines','parts_special_orders','parts_orders','parts_order_lines','parts_counts',
    'parts_count_lines','rental_rates','rental_contracts','rental_billings'] loop
    execute format('alter table pm.%I enable row level security', t);
  end loop;
  -- uniform isolation; member writes are narrowed by grants (most are read-only) + the line triggers
  foreach t in array array['dealer_settings','dealer_outbox','dealer_inbound_events','dealer_floor_status','dealer_sot_alerts',
    'dealer_warranty_payments','dealer_unit_costs','dealer_deal_lines','dealer_quotes','dealer_trades','dealer_fi_products',
    'dealer_deposits','parts','parts_ticket_lines','parts_special_orders','parts_order_lines','parts_count_lines','rental_rates',
    'rental_billings'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'dealer_deals' and policyname = 'org_select') then
    create policy org_select on pm.dealer_deals for select using (org_id = public.get_org_id());
    create policy open_update on pm.dealer_deals for update using (org_id = public.get_org_id() and stage in ('QUOTE','WRITTEN'))
      with check (org_id = public.get_org_id() and stage in ('QUOTE','WRITTEN'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'parts_tickets' and policyname = 'org_select') then
    create policy org_select on pm.parts_tickets for select using (org_id = public.get_org_id());
    create policy open_update on pm.parts_tickets for update using (org_id = public.get_org_id() and status = 'OPEN')
      with check (org_id = public.get_org_id() and status = 'OPEN');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'parts_orders' and policyname = 'org_select') then
    create policy org_select on pm.parts_orders for select using (org_id = public.get_org_id());
    create policy draft_update on pm.parts_orders for update using (org_id = public.get_org_id() and status = 'DRAFT')
      with check (org_id = public.get_org_id() and status = 'DRAFT');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'parts_counts' and policyname = 'org_select') then
    create policy org_select on pm.parts_counts for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'rental_contracts' and policyname = 'org_select') then
    create policy org_select on pm.rental_contracts for select using (org_id = public.get_org_id());
    create policy open_update on pm.rental_contracts for update using (org_id = public.get_org_id() and status in ('RESERVED','OUT'))
      with check (org_id = public.get_org_id() and status in ('RESERVED','OUT'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 17. Table grants: nothing for anon/PUBLIC; service_role everything; members read everything
--     and write only drafts / descriptive columns. State, money and Books acks move via functions.
-- ----------------------------------------------------------------------------
revoke all on pm.dealer_settings, pm.dealer_outbox, pm.dealer_inbound_events, pm.dealer_floor_status, pm.dealer_sot_alerts,
              pm.dealer_warranty_payments, pm.dealer_unit_costs, pm.dealer_deals, pm.dealer_deal_lines, pm.dealer_quotes, pm.dealer_trades,
              pm.dealer_fi_products, pm.dealer_deposits, pm.parts, pm.parts_tickets, pm.parts_ticket_lines, pm.parts_special_orders,
              pm.parts_orders, pm.parts_order_lines, pm.parts_counts, pm.parts_count_lines, pm.rental_rates, pm.rental_contracts,
              pm.rental_billings
  from public, anon, authenticated;
grant select, insert, update, delete on pm.dealer_settings, pm.dealer_outbox, pm.dealer_inbound_events, pm.dealer_floor_status,
              pm.dealer_sot_alerts, pm.dealer_warranty_payments, pm.dealer_unit_costs, pm.dealer_deals, pm.dealer_deal_lines, pm.dealer_quotes,
              pm.dealer_trades, pm.dealer_fi_products, pm.dealer_deposits, pm.parts, pm.parts_tickets, pm.parts_ticket_lines,
              pm.parts_special_orders, pm.parts_orders, pm.parts_order_lines, pm.parts_counts, pm.parts_count_lines, pm.rental_rates,
              pm.rental_contracts, pm.rental_billings
  to service_role;

grant select on pm.dealer_settings, pm.dealer_outbox, pm.dealer_inbound_events, pm.dealer_floor_status, pm.dealer_sot_alerts,
                pm.dealer_warranty_payments, pm.dealer_unit_costs, pm.dealer_deals, pm.dealer_quotes, pm.dealer_deposits, pm.parts,
                pm.parts_tickets, pm.parts_special_orders, pm.parts_orders, pm.parts_counts, pm.rental_contracts, pm.rental_billings
  to authenticated;

grant update (customer_id, salesperson_user_id, tax_rate_estimate, tax_exempt, tax_exempt_ref, finance_type, finance_vendor_id,
              amount_financed_cents, finance_reserve_cents, subvention_cents, finance_ref, notes)
  on pm.dealer_deals to authenticated;
grant select, delete on pm.dealer_deal_lines to authenticated;
grant insert (deal_id, line_no, line_type, asset_id, part_id, description, qty, unit_price_cents, taxable, program_ref, oem_vendor_id,
              rebate_treatment, sort) on pm.dealer_deal_lines to authenticated;
grant update (line_no, line_type, asset_id, part_id, description, qty, unit_price_cents, taxable, program_ref, oem_vendor_id,
              rebate_treatment, sort) on pm.dealer_deal_lines to authenticated;
grant select, delete on pm.dealer_trades to authenticated;
grant insert (deal_id, asset_id, serial_number, make, model, model_year, meter_reading, description, condition_notes, acv_cents,
              allowance_cents, payoff_cents, lienholder_vendor_id, lien_account_ref) on pm.dealer_trades to authenticated;
grant update (asset_id, serial_number, make, model, model_year, meter_reading, description, condition_notes, acv_cents,
              allowance_cents, payoff_cents, lienholder_vendor_id, lien_account_ref) on pm.dealer_trades to authenticated;
grant select, insert, update, delete on pm.dealer_fi_products to authenticated;

grant update (description, uom, category, cost_cents, list_price_cents, price_cents, core_charge_cents, mfr_vendor_id, is_active)
  on pm.parts to authenticated;
grant update (customer_id, tax_rate_estimate, tax_exempt, tax_exempt_ref, po_number, notes) on pm.parts_tickets to authenticated;
grant select, delete on pm.parts_ticket_lines to authenticated;
grant insert (ticket_id, line_no, part_id, description, qty_requested, qty_filled, qty_special_order, unit_price_cents, taxable, sort)
  on pm.parts_ticket_lines to authenticated;
grant update (line_no, part_id, description, qty_requested, qty_filled, qty_special_order, unit_price_cents, taxable, sort)
  on pm.parts_ticket_lines to authenticated;
grant update (vendor_ref, notes) on pm.parts_orders to authenticated;
grant select, delete on pm.parts_order_lines to authenticated;
grant insert (order_id, line_no, part_id, qty_ordered, unit_cost_cents, special_order_id) on pm.parts_order_lines to authenticated;
grant update (line_no, part_id, qty_ordered, unit_cost_cents, special_order_id) on pm.parts_order_lines to authenticated;
grant select on pm.parts_count_lines to authenticated;
grant update (counted_qty, notes) on pm.parts_count_lines to authenticated;
grant select, insert, update, delete on pm.rental_rates to authenticated;
grant update (notes, damage_waiver) on pm.rental_contracts to authenticated;

-- additive columns on 1104 tables (1104 re-grants its own columns when it re-runs)
grant update (stock_number, vin, category, retail_price_cents, advertised_price_cents, attachments, mfr_vendor_id) on pm.assets to authenticated;
grant update (labor_op, part_id, stock_location_id) on pm.work_order_lines to authenticated;

grant select on pm.v_dealer_unit_inventory, pm.v_dealer_deals_pipeline, pm.v_parts_on_hand, pm.v_warranty_outstanding,
                pm.v_rental_utilization, pm.v_dealer_outbox_queue, pm.v_kpis_dealer, pm.v_kpis, pm.v_seam_health
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 18. Function grants (1100/1007 pattern) for the functions this migration owns
-- ----------------------------------------------------------------------------
do $$
declare r record;
  v_member text[] := array['set_dealer_settings','receive_unit','order_unit','add_unit_cost','set_dealer_unit_status','transfer_unit',
    'open_unit_pdi','register_unit_warranty','create_deal','issue_dealer_quote','accept_dealer_quote','decline_dealer_quote','write_deal',
    'approve_deal','reopen_deal','mark_deal_funded','check_deal_delivery_item','deliver_deal','unwind_deal','cancel_deal',
    'request_deal_deposit','dealer_deal_totals','upsert_part','supersede_part','resolve_part','set_part_stocking','open_parts_ticket',
    'close_parts_ticket','void_parts_ticket','request_special_order','advance_special_order','create_parts_order','submit_parts_order',
    'receive_parts_order','suggest_parts_order','start_parts_count','post_parts_count','create_warranty_claim_from_ro',
    'reserve_rental','check_out_rental','check_in_rental','bill_rental','cancel_rental','rental_charge','resend_dealer_event'];
  v_internal text[] := array['dealer_seam_on','dealer_release_locked','dealer_emit','dealer_settings_row','dealer_actor_satisfies',
    'dealer_actor_role','dealer_mint_stock_number','dealer_doc_number','dealer_refresh_unit_cost','dealer_unit_json','dealer_record_unit_cost',
    'ensure_part_item','part_on_hand','dealer_deal_terms','dealer_deal_snapshot','dealer_release_deal_units','dealer_receive_trade',
    'dealer_on_ro_closed','dealer_emit_warranty_claim','dealer_rental_rate','dealer_inbound_check','dealer_resolve_unit',
    'dealer_apply_floor_status','dealer_apply_sot_alert','apply_warranty_payment','apply_dealer_inbound','release_dealer_outbox',
    'run_seam_cycle',
    'tg_asset_dealer_lock','tg_dealer_deal_line','tg_dealer_trade','tg_dealer_fi_product','tg_parts_ticket_line','tg_parts_order_line',
    'tg_parts_count_line','tg_wo_line_part','tg_document_subject_in_org','tg_dealer_ro_closed','tg_dealer_warranty_claim_status'];
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm' and (p.proname = any (v_member) or p.proname = any (v_internal)) loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = any (v_member) then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1109_pm_dealer
-- ============================================================================
