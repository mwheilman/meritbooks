-- ============================================================================
-- 1104 · Merit Projects v2 — field service, dispatch, agreements, assets,
--        price-book usage on work orders, truck stock / material moves,
--        dealer repair orders + warranty claims
--
-- Binding inputs: docs/projects/MERIT-PROJECTS-V2-BLUEPRINT.md (D7, D10, D11, D12, §2, §5, §6),
-- review 05 §4.5, research 03 §A–§E (ServiceTitan depth / Jobber simplicity), research 06 §1.3–1.4
-- (dealer RO), pack manifests field_service / equipment_dealer / flooring.
--
-- Object model
--   job (core.jobs + pm.projects)  ── the unit of work and the billing/GL dimension (Books invoices per job)
--    └─ work_orders               ── visits / appointments / ROs / install tickets / production orders (1105)
--        ├─ dispatch_assignments  ── tech or crew × time slot; gist exclusion = no double booking
--        ├─ work_order_lines      ── price-book usage (flat-rate tasks, parts, labor, GBB options), price pinned
--        └─ warranty_claims       ── dealer RO lines billed to the OEM (payer = an AR customer in Books)
--   service_agreements (+ agreement_assets) ── memberships; generate_agreement_visits() makes visit WOs
--   assets (+ asset_service_history) ── customer equipment and dealer units, keyed by serial
--   skills, employee_skills, crews, crew_members ── dispatch capacity and qualification
--   stock_locations, stock_targets, material_moves ── truck stock as OPERATIONAL quantities only
--
-- A dealer RO is a work_order of kind REPAIR_ORDER: asset required (CHECK), payer_type OEM with an
-- AR payer (core.customers) for warranty work, check-in / meter / complaint-cause-correction columns,
-- and one or more pm.warranty_claims (research 06: "1 per warranty line or grouped").
--
-- Boundaries (D7 / §5): no money posting. Line prices are operational (what was sold on site);
-- Books owns invoice #, AR, tax, inventory valuation and cash. material_moves are operational facts
-- (event_id reserved for a future JOB_MATERIAL emitter; nothing is emitted here). Warranty claim
-- PAID is an operational status; the OEM credit memo is a Books document.
--
-- Replaces the 1100 placeholder guard pm.guard_work_orders_closed (create or replace).
-- Adds pm.time_entries.work_order_id (additive, nullable, composite FK to the WO on the same job).
-- Requires btree_gist (created in schema `extensions` when missing). Idempotent: safe to run twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Extension for the dispatch exclusion constraint (uuid equality in a gist index)
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'btree_gist') then
    if not exists (select 1 from pg_namespace where nspname = 'extensions') then
      create schema extensions;
    end if;
    create extension btree_gist with schema extensions;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Shared helpers for the industry modules (1104–1107)
-- ----------------------------------------------------------------------------

-- Validates that referenced core rows belong to the row's org. Args: 'column:table' pairs.
-- Definer: reads core tables regardless of the caller's RLS. Allow-listed tables only.
create or replace function pm.tg_refs_in_org() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a text; v_col text; v_tbl text; v_id uuid; ok boolean; j jsonb := to_jsonb(new);
begin
  foreach a in array tg_argv loop
    v_col := split_part(a, ':', 1);
    v_tbl := split_part(a, ':', 2);
    if v_tbl not in ('core.employees','core.customers','core.vendors','core.items','public.documents') then
      raise exception 'PM_REF_TABLE_NOT_ALLOWED: %', v_tbl using errcode = '22023';
    end if;
    v_id := nullif(j ->> v_col, '')::uuid;
    continue when v_id is null or to_regclass(v_tbl) is null;
    if tg_op = 'UPDATE' and (to_jsonb(old) ->> v_col) is not distinct from (j ->> v_col) then continue; end if;
    execute format('select exists (select 1 from %s x where x.id = $1 and x.org_id = $2)', v_tbl) into ok using v_id, new.org_id;
    if not ok then
      raise exception 'PM_REF_ORG_MISMATCH: % % is not in org %', v_col, v_id, new.org_id using errcode = '23503';
    end if;
  end loop;
  return new;
end $$;

-- location_id of a job-scoped row = the job's company (filled when null, rejected when different).
create or replace function pm.tg_job_location() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid;
begin
  select j.location_id into v_loc from core.jobs j where j.org_id = new.org_id and j.id = new.job_id;
  if v_loc is null then
    raise exception 'PM_JOB_NOT_FOUND: job % is not in org %', new.job_id, new.org_id using errcode = '23503';
  end if;
  if new.location_id is null then
    new.location_id := v_loc;
  elsif new.location_id <> v_loc then
    raise exception 'PM_JOB_LOCATION_MISMATCH: location must equal the job''s company' using errcode = '23514';
  end if;
  return new;
end $$;

-- Gapless document number formatting that never truncates (lpad truncates past the width).
create or replace function pm.fmt_doc_number(p_prefix text, p_period text, p_n bigint) returns text
language sql immutable
as $$
  select p_prefix || '-' || p_period || '-' || lpad(p_n::text, greatest(5, length(p_n::text)), '0')
$$;

-- ----------------------------------------------------------------------------
-- 2. Skills, crews
-- ----------------------------------------------------------------------------
create table if not exists pm.skills (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  code        text not null check (code ~ '^[a-z][a-z0-9_]{1,47}$'),
  name        text not null check (char_length(name) between 1 and 80),
  kind        text not null default 'SKILL' check (kind in ('SKILL','LICENSE','CERTIFICATION','BRAND')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, id)
);

create table if not exists pm.employee_skills (
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  employee_id   uuid not null references core.employees(id) on delete cascade,
  skill_id      uuid not null,
  level         smallint check (level is null or level between 1 and 5),
  cert_number   text,
  certified_on  date,
  expires_on    date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (employee_id, skill_id),
  foreign key (org_id, skill_id) references pm.skills (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_employee_skills_skill_idx on pm.employee_skills (org_id, skill_id);

create table if not exists pm.crews (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id),
  name                      text not null check (char_length(name) between 1 and 80),
  kind                      text not null default 'TECH' check (kind in ('TECH','INSTALL','SHOP','SUBCONTRACT')),
  lead_employee_id          uuid references core.employees(id),
  vendor_id                 uuid references core.vendors(id),       -- subcontracted installer crew
  capacity_minutes_per_day  int not null default 480 check (capacity_minutes_per_day between 0 and 1440),
  home_stock_location_id    uuid,                                   -- the crew's truck (FK below)
  color                     text,
  is_active                 boolean not null default true,
  created_by                text default pm.current_user_id(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, location_id, name),
  unique (org_id, id),
  check (kind <> 'SUBCONTRACT' or vendor_id is not null)
);

create table if not exists pm.crew_members (
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  crew_id      uuid not null,
  employee_id  uuid not null references core.employees(id) on delete cascade,
  role         text not null default 'MEMBER' check (role in ('LEAD','MEMBER','APPRENTICE')),
  is_primary   boolean not null default true,
  created_at   timestamptz not null default now(),
  primary key (crew_id, employee_id),
  foreign key (org_id, crew_id) references pm.crews (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_crew_members_primary_uidx on pm.crew_members (org_id, employee_id) where is_primary;

-- ----------------------------------------------------------------------------
-- 3. Stock locations (warehouse, truck, shop, site, receiver …) and min/max targets
-- ----------------------------------------------------------------------------
create table if not exists pm.stock_locations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  code           text not null check (char_length(code) between 1 and 24),
  name           text not null check (char_length(name) between 1 and 80),
  kind           text not null check (kind in ('WAREHOUSE','TRUCK','SHOP','SITE','STAGING','REMNANT','RECEIVER')),
  crew_id        uuid,
  employee_id    uuid references core.employees(id),
  job_id         uuid,
  address_line1  text,
  city           text,
  state          text,
  zip            text,
  is_active      boolean not null default true,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id),
  check (kind <> 'SITE' or job_id is not null),
  foreign key (org_id, crew_id) references pm.crews (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crews_home_stock_location_fk' and conrelid = 'pm.crews'::regclass) then
    alter table pm.crews add constraint crews_home_stock_location_fk
      foreign key (org_id, home_stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate;
  end if;
end $$;

create table if not exists pm.stock_targets (
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  stock_location_id  uuid not null,
  item_id            uuid not null,
  min_qty            numeric(14,4) not null default 0 check (min_qty >= 0),
  max_qty            numeric(14,4) check (max_qty is null or max_qty >= min_qty),
  uom                text,
  bin                text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (stock_location_id, item_id),
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) on delete cascade deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- 4. Assets (customer equipment, dealer units) + service history
--    Identity columns are authoritative (dedupe, KPI, warranty); pack ext keys
--    serial_number / brand / model / model_number / install_date / warranty_expires /
--    hour_meter are copied into the columns when the column is empty.
--    No FK to jobs: an asset outlives any job (and must survive sample-data removal).
-- ----------------------------------------------------------------------------
create table if not exists pm.assets (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  kind                  text not null default 'CUSTOMER_EQUIPMENT'
                          check (kind in ('CUSTOMER_EQUIPMENT','DEALER_UNIT','RENTAL_UNIT','COMPANY_EQUIPMENT')),
  customer_id           uuid references core.customers(id),
  item_id               uuid,                                  -- core.items identity (model) when known
  serial_number         text check (serial_number is null or char_length(serial_number) between 1 and 80),
  make                  text,
  model                 text,
  model_year            int check (model_year is null or model_year between 1900 and 2200),
  description           text,
  site_label            text,
  site_address_line1    text,
  site_city             text,
  site_state            text,
  site_zip              text,
  installed_on          date,
  warranty_expires_on   date,
  registered_on         date,
  meter_reading         numeric(12,2) check (meter_reading is null or meter_reading >= 0),
  meter_read_on         date,
  last_service_on       date,
  status                text not null default 'ACTIVE' check (status in ('ACTIVE','REPLACED','RETIRED','SOLD')),
  replaced_by_asset_id  uuid,
  retired_on            date,
  ext                   jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  check (replaced_by_asset_id is null or replaced_by_asset_id <> id),
  foreign key (org_id, replaced_by_asset_id) references pm.assets (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_assets_serial_uidx
  on pm.assets (org_id, lower(coalesce(make, '')), lower(serial_number)) where serial_number is not null;
create index if not exists pm_assets_customer_idx on pm.assets (org_id, customer_id);
create index if not exists pm_assets_loc_idx on pm.assets (org_id, location_id, status);

create or replace function pm.tg_asset_identity() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  new.serial_number := coalesce(nullif(btrim(new.serial_number), ''), nullif(btrim(new.ext ->> 'serial_number'), ''));
  new.make  := coalesce(nullif(btrim(new.make), ''), nullif(btrim(new.ext ->> 'brand'), ''));
  new.model := coalesce(nullif(btrim(new.model), ''), nullif(btrim(new.ext ->> 'model'), ''), nullif(btrim(new.ext ->> 'model_number'), ''));
  if new.installed_on is null and coalesce(new.ext ->> 'install_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    new.installed_on := (new.ext ->> 'install_date')::date;
  end if;
  if new.warranty_expires_on is null and coalesce(new.ext ->> 'warranty_expires', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    new.warranty_expires_on := (new.ext ->> 'warranty_expires')::date;
  end if;
  if new.meter_reading is null and jsonb_typeof(new.ext -> 'hour_meter') = 'number' then
    new.meter_reading := (new.ext ->> 'hour_meter')::numeric;
  end if;
  return new;
end $$;

-- Assets are not job-scoped: validate ext against the company's 'asset' field defs (job type = null).
create or replace function pm.tg_validate_asset_ext() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if tg_op = 'UPDATE' and new.ext is not distinct from old.ext and new.location_id is not distinct from old.location_id then
    return new;
  end if;
  perform pm.validate_ext(new.org_id, new.location_id, 'asset', null, new.ext);
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Service agreements (memberships)
-- ----------------------------------------------------------------------------
create table if not exists pm.service_agreements (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid not null,               -- the recurring_service job that carries contract + billing
  customer_id          uuid not null references core.customers(id),
  number               text,                        -- minted 'AGR-YYYY-NNNNN' when null
  plan_name            text not null check (char_length(plan_name) between 1 and 120),
  tier                 text,
  status               text not null default 'DRAFT'
                         check (status in ('DRAFT','ACTIVE','SUSPENDED','EXPIRED','CANCELLED','RENEWED')),
  starts_on            date not null,
  ends_on              date not null,
  cadence              text not null default 'SEMIANNUAL'
                         check (cadence in ('MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL','CUSTOM')),
  interval_months      int check (interval_months is null or interval_months between 1 and 60),
  first_visit_on       date,
  visits_per_term      int check (visits_per_term is null or visits_per_term >= 0),
  visit_window_days    int not null default 30 check (visit_window_days between 1 and 366),
  visit_minutes        int not null default 60 check (visit_minutes > 0),
  required_skills      text[] not null default '{}',
  price_cents          bigint not null default 0 check (price_cents >= 0),     -- per billing period (Books bills)
  billing_frequency    text not null default 'ANNUAL' check (billing_frequency in ('UPFRONT','MONTHLY','QUARTERLY','ANNUAL')),
  member_discount_pct  numeric(5,4) check (member_discount_pct is null or (member_discount_pct >= 0 and member_discount_pct <= 1)),
  auto_renew           boolean not null default true,
  renewed_from_id      uuid,
  activated_at         timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check (ends_on > starts_on),
  check (cadence <> 'CUSTOM' or interval_months is not null),
  check (first_visit_on is null or (first_visit_on >= starts_on and first_visit_on < ends_on)),
  check (status <> 'CANCELLED' or cancelled_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, renewed_from_id) references pm.service_agreements (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_service_agreements_renewal_uidx
  on pm.service_agreements (org_id, renewed_from_id) where renewed_from_id is not null;
create index if not exists pm_service_agreements_loc_idx on pm.service_agreements (org_id, location_id, status, ends_on);
create index if not exists pm_service_agreements_job_idx on pm.service_agreements (org_id, job_id);

create table if not exists pm.agreement_assets (
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  agreement_id  uuid not null,
  asset_id      uuid not null,
  created_at    timestamptz not null default now(),
  primary key (agreement_id, asset_id),
  foreign key (org_id, agreement_id) references pm.service_agreements (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, asset_id) references pm.assets (org_id, id) on delete cascade deferrable initially immediate
);

-- After activation the commercial terms (price, billing, term dates, discount) change only through
-- pm.renew_agreement (a new term); operational fields (window, minutes, skills, plan name) stay editable.
create or replace function pm.tg_agreement_lock() returns trigger
language plpgsql   -- invoker: current_user must be the caller for the client lock
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated','anon') and old.status <> 'DRAFT'
     and (new.price_cents is distinct from old.price_cents or new.billing_frequency is distinct from old.billing_frequency
          or new.starts_on is distinct from old.starts_on or new.ends_on is distinct from old.ends_on
          or new.member_discount_pct is distinct from old.member_discount_pct or new.cadence is distinct from old.cadence
          or new.interval_months is distinct from old.interval_months or new.first_visit_on is distinct from old.first_visit_on
          or new.visits_per_term is distinct from old.visits_per_term) then
    raise exception 'PM_AGREEMENT_LOCKED: % is %; change terms by renewing', old.number, old.status using errcode = '55000';
  end if;
  return new;
end $$;

create or replace function pm.tg_agreement_number() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_period text := to_char(current_date, 'YYYY');
begin
  if new.number is null or btrim(new.number) = '' then
    new.number := pm.fmt_doc_number('AGR', v_period, pm.next_doc_number(new.org_id, 'org', 'AGR', v_period));
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Work orders (visits, ROs, install tickets, measures, production orders in 1105)
--    Client-created only through pm.create_work_order / generate_agreement_visits;
--    status and lifecycle stamps move only through definer functions.
-- ----------------------------------------------------------------------------
create table if not exists pm.work_orders (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid not null,
  number               text,                         -- 'WO-' / 'RO-' / 'PRD-' YYYY-NNNNN, minted when null
  kind                 text not null default 'SERVICE' check (kind in
                         ('SERVICE','MAINTENANCE_VISIT','INSTALL','MEASURE','DELIVERY','REPAIR_ORDER','PDI',
                          'PRODUCTION','INSPECTION')),
  status               text not null default 'NEW' check (status in
                         ('NEW','SCHEDULED','DISPATCHED','IN_PROGRESS','ON_HOLD','RELEASED','COMPLETE','CLOSED','CANCELLED')),
  priority             smallint not null default 3 check (priority between 1 and 5),   -- 1 = emergency
  summary              text not null check (char_length(summary) between 1 and 200),
  description          text,
  complaint            text,                         -- RO "3 Cs": complaint / cause / correction(resolution)
  cause                text,
  resolution           text,
  outcome              text check (outcome is null or outcome in
                         ('FIXED','COMPLETED','PARTIAL','NOT_FIXED','NEEDS_PARTS','NEEDS_QUOTE','NO_PROBLEM_FOUND',
                          'DECLINED','NO_ACCESS')),
  asset_id             uuid,
  agreement_id         uuid,
  visit_seq            int check (visit_seq is null or visit_seq >= 1),
  due_on               date,
  due_by               date,
  wbs_id               uuid,
  requested_start      timestamptz,                  -- customer's arrival window
  requested_end        timestamptz,
  scheduled_start      timestamptz,                  -- rollup of active dispatch assignments
  scheduled_end        timestamptz,
  estimated_minutes    int check (estimated_minutes is null or estimated_minutes >= 0),
  required_skills      text[] not null default '{}',
  promised_on          date,
  checked_in_at        timestamptz,                  -- RO intake (days-in-shop clock)
  meter_in             numeric(12,2) check (meter_in is null or meter_in >= 0),
  meter_out            numeric(12,2) check (meter_out is null or meter_out >= 0),
  payer_type           text not null default 'CUSTOMER' check (payer_type in ('CUSTOMER','OEM','INTERNAL','THIRD_PARTY')),
  payer_customer_id    uuid references core.customers(id),       -- OEM / third-party AR party (Books)
  is_callback          boolean not null default false,
  callback_of_id       uuid,
  follow_up_required   boolean not null default false,
  hold_reason          text,
  started_at           timestamptz,
  completed_at         timestamptz,
  completed_by         text,
  closed_at            timestamptz,
  closed_by            text,
  cancelled_at         timestamptz,
  cancel_reason        text,
  ext                  jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  unique (org_id, job_id, id),
  check (callback_of_id is null or (is_callback and callback_of_id <> id)),
  check (kind <> 'REPAIR_ORDER' or asset_id is not null),
  check (payer_type not in ('OEM','THIRD_PARTY') or payer_customer_id is not null),
  check (agreement_id is null or kind = 'MAINTENANCE_VISIT'),
  check (status not in ('COMPLETE','CLOSED') or completed_at is not null),
  check (status <> 'CLOSED' or closed_at is not null),
  check (status <> 'CANCELLED' or cancelled_at is not null),
  check (requested_end is null or requested_start is null or requested_end > requested_start),
  check (due_by is null or due_on is null or due_by >= due_on),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate,
  foreign key (org_id, agreement_id) references pm.service_agreements (org_id, id) deferrable initially immediate,
  foreign key (org_id, callback_of_id) references pm.work_orders (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_work_orders_visit_uidx
  on pm.work_orders (org_id, agreement_id, visit_seq) where agreement_id is not null and visit_seq is not null;
create index if not exists pm_work_orders_job_idx on pm.work_orders (org_id, job_id, status);
create index if not exists pm_work_orders_loc_status_idx on pm.work_orders (org_id, location_id, status, priority);
create index if not exists pm_work_orders_asset_idx on pm.work_orders (org_id, asset_id) where asset_id is not null;
create index if not exists pm_work_orders_due_idx on pm.work_orders (org_id, agreement_id, due_on) where agreement_id is not null;
create index if not exists pm_work_orders_done_idx on pm.work_orders (org_id, location_id, completed_at) where completed_at is not null;

create or replace function pm.tg_work_order_number() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_period text := to_char(current_date, 'YYYY'); v_kind text;
begin
  if new.number is null or btrim(new.number) = '' then
    v_kind := case new.kind when 'REPAIR_ORDER' then 'RO' when 'PRODUCTION' then 'PRD' else 'WO' end;
    new.number := pm.fmt_doc_number(v_kind, v_period, pm.next_doc_number(new.org_id, 'org', v_kind, v_period));
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Dispatch assignments: one row per technician (or per subcontract crew) per slot.
--    Exclusion constraints make a double booking impossible even under concurrency.
-- ----------------------------------------------------------------------------
create table if not exists pm.dispatch_assignments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  work_order_id  uuid not null,
  employee_id    uuid references core.employees(id),
  crew_id        uuid,
  slot           tstzrange not null check (not isempty(slot) and not lower_inf(slot) and not upper_inf(slot)),
  status         text not null default 'ASSIGNED' check (status in ('ASSIGNED','DISPATCHED','EN_ROUTE','ON_SITE','DONE','CANCELLED')),
  is_lead        boolean not null default false,
  assigned_by    text,
  dispatched_at  timestamptz,
  en_route_at    timestamptz,
  arrived_at     timestamptz,
  done_at        timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  check (employee_id is not null or crew_id is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, crew_id) references pm.crews (org_id, id) deferrable initially immediate,
  constraint dispatch_no_employee_overlap exclude using gist (org_id with =, employee_id with =, slot with &&)
    where (status <> 'CANCELLED' and employee_id is not null),
  constraint dispatch_no_crew_overlap exclude using gist (org_id with =, crew_id with =, slot with &&)
    where (status <> 'CANCELLED' and employee_id is null)
);
create index if not exists pm_dispatch_wo_idx on pm.dispatch_assignments (org_id, work_order_id);
create index if not exists pm_dispatch_emp_idx on pm.dispatch_assignments (org_id, employee_id, lower(slot));

-- ----------------------------------------------------------------------------
-- 8. Work-order lines: price-book usage. Price/cost/labor are PINNED from the price book on
--    insert (operational number; Books prices the invoice). GBB options are PROPOSED lines
--    decided by pm.decide_work_order_options. Locked once the WO is CLOSED or CANCELLED.
-- ----------------------------------------------------------------------------
create table if not exists pm.work_order_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  work_order_id       uuid not null,
  sort                int not null default 0,
  kind                text not null default 'SERVICE' check (kind in
                        ('SERVICE','PART','LABOR','EQUIPMENT','FEE','DISCOUNT','SUBLET','FREIGHT')),
  price_book_item_id  uuid references pm.price_book_items(id),
  item_id             uuid,
  cost_code_id        uuid,
  description         text not null check (char_length(description) between 1 and 300),
  qty                 numeric(14,4) not null default 1 check (qty > 0),
  uom                 text not null default 'EA',
  unit_price_cents    bigint,
  unit_cost_cents     bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  discount_pct        numeric(5,4) not null default 0 check (discount_pct >= 0 and discount_pct <= 1),
  labor_minutes       int check (labor_minutes is null or labor_minutes >= 0),
  flag_hours          numeric(8,2) check (flag_hours is null or flag_hours >= 0),   -- dealer flat-rate hours
  pay_type            text not null default 'CUSTOMER' check (pay_type in ('CUSTOMER','WARRANTY','INTERNAL')),
  option_group        text,
  status              text not null default 'APPROVED' check (status in ('PROPOSED','APPROVED','DECLINED')),
  price_overridden    boolean not null default false,
  decided_at          timestamptz,
  decided_by_name     text,
  amount_cents        bigint generated always as
                        ((round(qty * coalesce(unit_price_cents, 0) * (1 - discount_pct)))::bigint) stored,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  check (kind = 'DISCOUNT' or unit_price_cents is null or unit_price_cents >= 0),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_wo_lines_wo_idx on pm.work_order_lines (org_id, work_order_id, sort);

create or replace function pm.tg_wo_line() returns trigger
language plpgsql   -- invoker: current_user must be the caller for the client lock
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; pb pm.price_book_items%rowtype; v_client boolean := current_user in ('authenticated','anon');
begin
  if tg_op = 'DELETE' then
    select * into w from pm.work_orders x where x.org_id = old.org_id and x.id = old.work_order_id;
    if v_client and w.status in ('CLOSED','CANCELLED') then
      raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000';
    end if;
    return old;
  end if;
  select * into w from pm.work_orders x where x.org_id = new.org_id and x.id = new.work_order_id;
  if not found then raise exception 'PM_UNKNOWN_WORK_ORDER: %', new.work_order_id using errcode = '23503'; end if;
  if v_client and w.status in ('CLOSED','CANCELLED') then
    raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000';
  end if;
  new.job_id := coalesce(new.job_id, w.job_id);
  if new.price_book_item_id is not null and (tg_op = 'INSERT' or new.price_book_item_id is distinct from old.price_book_item_id
                                            or new.unit_price_cents is distinct from old.unit_price_cents) then
    select * into pb from pm.price_book_items p where p.id = new.price_book_item_id;
    if pb.org_id is distinct from new.org_id or pb.location_id is distinct from w.location_id then
      raise exception 'PM_PRICE_BOOK_SCOPE: price book item is not on this company' using errcode = '23514';
    end if;
    if tg_op = 'INSERT' or new.price_book_item_id is distinct from old.price_book_item_id then
      new.description      := coalesce(new.description, pb.name);
      new.uom              := coalesce(nullif(new.uom, 'EA'), pb.unit, 'EA');
      new.unit_price_cents := coalesce(new.unit_price_cents, pb.price_cents);
      new.unit_cost_cents  := coalesce(new.unit_cost_cents, pb.cost_cents);
      new.labor_minutes    := coalesce(new.labor_minutes, pb.labor_minutes);
      new.cost_code_id     := coalesce(new.cost_code_id, pb.cost_code_id);
      new.item_id          := coalesce(new.item_id, pb.item_id);
    end if;
    new.price_overridden := new.unit_price_cents is distinct from pb.price_cents;
  elsif new.price_book_item_id is null then
    new.price_overridden := false;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Material moves: operational quantities only (valuation = Books; D7 §5).
--    Immutable facts; corrections are reversing moves. Written by pm.record_material_move.
-- ----------------------------------------------------------------------------
create table if not exists pm.material_moves (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  kind                    text not null check (kind in ('RECEIPT','ISSUE','RETURN','TRANSFER','SCRAP','REMNANT','ADJUST')),
  item_id                 uuid not null,
  description             text,
  qty                     numeric(14,4) not null check (qty > 0),
  uom                     text not null default 'EA',
  from_stock_location_id  uuid,
  to_stock_location_id    uuid,
  job_id                  uuid,
  work_order_id           uuid,
  lot_ref                 text,                       -- dye lot / roll # / serial
  moved_at                timestamptz not null default now(),
  moved_by                text,
  source_ref              text not null,              -- 'pm:material:{id}' or caller-supplied (idempotency)
  event_id                uuid,                       -- reserved: JOB_MATERIAL (not emitted in 1104)
  notes                   text,
  created_at              timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, id),
  check (from_stock_location_id is null or from_stock_location_id is distinct from to_stock_location_id),
  check (case kind
           when 'RECEIPT'  then from_stock_location_id is null and to_stock_location_id is not null
           when 'ISSUE'    then from_stock_location_id is not null and to_stock_location_id is null and job_id is not null
           when 'RETURN'   then from_stock_location_id is null and to_stock_location_id is not null and job_id is not null
           when 'TRANSFER' then from_stock_location_id is not null and to_stock_location_id is not null
           when 'SCRAP'    then to_stock_location_id is null and (from_stock_location_id is not null or job_id is not null)
           when 'REMNANT'  then to_stock_location_id is not null and (from_stock_location_id is not null or job_id is not null)
           when 'ADJUST'   then (from_stock_location_id is null) <> (to_stock_location_id is null)
         end),
  check (work_order_id is null or job_id is not null),
  foreign key (org_id, from_stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, to_stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate
);
create index if not exists pm_material_moves_job_idx on pm.material_moves (org_id, job_id) where job_id is not null;
create index if not exists pm_material_moves_from_idx on pm.material_moves (org_id, from_stock_location_id, item_id);
create index if not exists pm_material_moves_to_idx on pm.material_moves (org_id, to_stock_location_id, item_id);

-- ----------------------------------------------------------------------------
-- 10. Asset service history (append-only; written by pm.record_asset_service)
-- ----------------------------------------------------------------------------
create table if not exists pm.asset_service_history (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  asset_id       uuid not null,
  job_id         uuid,
  work_order_id  uuid,
  kind           text not null check (kind in ('INSTALL','REPAIR','MAINTENANCE','INSPECTION','WARRANTY','RECALL',
                                               'CALLBACK','PDI','REPLACEMENT','METER_READING','NOTE')),
  performed_on   date not null default current_date,
  employee_id    uuid references core.employees(id),
  summary        text,
  meter_reading  numeric(12,2) check (meter_reading is null or meter_reading >= 0),
  parts          jsonb not null default '[]' check (jsonb_typeof(parts) = 'array'),
  source         text not null default 'MANUAL' check (source in ('WORK_ORDER','MANUAL','IMPORT')),
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  check (work_order_id is null or job_id is not null),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_asset_history_asset_idx on pm.asset_service_history (org_id, asset_id, performed_on desc);
create unique index if not exists pm_asset_history_wo_uidx on pm.asset_service_history (org_id, work_order_id, kind)
  where work_order_id is not null;

-- ----------------------------------------------------------------------------
-- 11. Warranty claims (dealer RO → OEM). Money is operational (claimed / approved / paid);
--     Books owns the OEM receivable and the credit memo.
-- ----------------------------------------------------------------------------
create table if not exists pm.warranty_claims (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  work_order_id        uuid not null,
  asset_id             uuid,
  payer_customer_id    uuid not null references core.customers(id),       -- the OEM as an AR party
  claim_number         text,
  status               text not null default 'DRAFT' check (status in
                         ('DRAFT','SUBMITTED','RETURNED','APPROVED','PAID','REJECTED','WRITTEN_OFF')),
  failure_code         text,
  labor_op             text,
  claimed_labor_cents  bigint not null default 0 check (claimed_labor_cents >= 0),
  claimed_parts_cents  bigint not null default 0 check (claimed_parts_cents >= 0),
  claimed_other_cents  bigint not null default 0 check (claimed_other_cents >= 0),
  claimed_cents        bigint generated always as (claimed_labor_cents + claimed_parts_cents + claimed_other_cents) stored,
  approved_cents       bigint check (approved_cents is null or approved_cents >= 0),
  paid_cents           bigint not null default 0 check (paid_cents >= 0),
  filing_deadline      date,
  submitted_at         timestamptz,
  decided_at           timestamptz,
  paid_at              timestamptz,
  decision_reason      text,
  notes                text,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  check (status not in ('APPROVED','PAID') or approved_cents is not null),
  check (status = 'DRAFT' or submitted_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate
);
create index if not exists pm_warranty_claims_wo_idx on pm.warranty_claims (org_id, work_order_id);
create index if not exists pm_warranty_claims_status_idx on pm.warranty_claims (org_id, status);

create or replace function pm.tg_warranty_claim_lock() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated','anon') and old.status <> 'DRAFT' then
    raise exception 'PM_CLAIM_LOCKED: claim is % (edit through pm.advance_warranty_claim)', old.status using errcode = '55000';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Time capture links (additive on 1100's pm.time_entries)
-- ----------------------------------------------------------------------------
alter table pm.time_entries add column if not exists work_order_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'time_entries_work_order_fk' and conrelid = 'pm.time_entries'::regclass) then
    alter table pm.time_entries add constraint time_entries_work_order_fk
      foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate;
  end if;
end $$;
create index if not exists pm_time_entries_wo_idx on pm.time_entries (org_id, work_order_id) where work_order_id is not null;

-- ----------------------------------------------------------------------------
-- 13. Triggers
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['skills','employee_skills','crews','stock_locations','stock_targets','assets',
    'service_agreements','work_orders','dispatch_assignments','work_order_lines','warranty_claims'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['crews','stock_locations','assets','service_agreements','work_orders','work_order_lines',
    'asset_service_history','warranty_claims'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
  foreach t in array array['crews','stock_locations','assets','material_moves'] loop
    execute format('create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
  foreach t in array array['work_orders','service_agreements'] loop
    execute format('create or replace trigger trg_job_location before insert or update of job_id, location_id, org_id on pm.%I for each row execute function pm.tg_job_location()', t);
  end loop;
end $$;

create or replace trigger trg_refs_in_org before insert or update on pm.employee_skills
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.crews
  for each row execute function pm.tg_refs_in_org('lead_employee_id:core.employees', 'vendor_id:core.vendors');
create or replace trigger trg_refs_in_org before insert or update on pm.crew_members
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.stock_locations
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.stock_targets
  for each row execute function pm.tg_refs_in_org('item_id:core.items');
create or replace trigger trg_refs_in_org before insert or update on pm.assets
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers', 'item_id:core.items');
create or replace trigger trg_refs_in_org before insert or update on pm.service_agreements
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers');
create or replace trigger trg_refs_in_org before insert or update on pm.work_orders
  for each row execute function pm.tg_refs_in_org('payer_customer_id:core.customers');
create or replace trigger trg_refs_in_org before insert or update on pm.dispatch_assignments
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.work_order_lines
  for each row execute function pm.tg_refs_in_org('item_id:core.items');
create or replace trigger trg_refs_in_org before insert or update on pm.material_moves
  for each row execute function pm.tg_refs_in_org('item_id:core.items');
create or replace trigger trg_refs_in_org before insert or update on pm.asset_service_history
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.warranty_claims
  for each row execute function pm.tg_refs_in_org('payer_customer_id:core.customers');

create or replace trigger trg_asset_identity before insert or update on pm.assets
  for each row execute function pm.tg_asset_identity();
create or replace trigger trg_validate_ext before insert or update of ext, location_id on pm.assets
  for each row execute function pm.tg_validate_asset_ext();
create or replace trigger trg_validate_ext before insert or update of ext on pm.work_orders
  for each row execute function pm.tg_validate_ext('work_order');
create or replace trigger trg_work_order_number before insert on pm.work_orders
  for each row execute function pm.tg_work_order_number();
create or replace trigger trg_agreement_number before insert on pm.service_agreements
  for each row execute function pm.tg_agreement_number();
create or replace trigger trg_wo_line before insert or update or delete on pm.work_order_lines
  for each row execute function pm.tg_wo_line();
create or replace trigger trg_agreement_lock before update on pm.service_agreements
  for each row execute function pm.tg_agreement_lock();
create or replace trigger trg_claim_lock before update on pm.warranty_claims
  for each row execute function pm.tg_warranty_claim_lock();

-- ----------------------------------------------------------------------------
-- 14. Guard (replaces the 1100 placeholder): no open work orders on the job
-- ----------------------------------------------------------------------------
create or replace function pm.guard_work_orders_closed(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select not exists (select 1 from pm.work_orders w
                     where w.job_id = p_job and w.status not in ('COMPLETE','CLOSED','CANCELLED'))
$$;

-- ----------------------------------------------------------------------------
-- 15. Work-order lifecycle (definer; org guard first)
-- ----------------------------------------------------------------------------
create or replace function pm.create_work_order(
  p_job              uuid,
  p_kind             text,
  p_summary          text,
  p_priority         int         default 3,
  p_asset            uuid        default null,
  p_requested_start  timestamptz default null,
  p_requested_end    timestamptz default null,
  p_estimated_minutes int        default null,
  p_required_skills  text[]      default '{}',
  p_payer_type       text        default 'CUSTOMER',
  p_payer_customer   uuid        default null,
  p_is_callback      boolean     default false,
  p_callback_of      uuid        default null,
  p_complaint        text        default null,
  p_ext              jsonb       default '{}',
  p_promised_on      date        default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v_id uuid; v_num text;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if not exists (select 1 from pm.projects p where p.org_id = v_org and p.job_id = p_job) then
    raise exception 'PM_NOT_A_PROJECT: job %', p_job using errcode = 'P0002';
  end if;
  if p_summary is null or btrim(p_summary) = '' then raise exception 'PM_INVALID: summary is required' using errcode = '22023'; end if;
  if p_asset is not null and not exists (select 1 from pm.assets a where a.org_id = v_org and a.id = p_asset) then
    raise exception 'PM_UNKNOWN_ASSET: %', p_asset using errcode = 'P0002';
  end if;
  if p_callback_of is not null and not exists (select 1 from pm.work_orders w where w.org_id = v_org and w.id = p_callback_of) then
    raise exception 'PM_UNKNOWN_WORK_ORDER: %', p_callback_of using errcode = 'P0002';
  end if;

  insert into pm.work_orders (org_id, location_id, job_id, kind, summary, priority, asset_id, requested_start, requested_end,
                              estimated_minutes, required_skills, payer_type, payer_customer_id, is_callback, callback_of_id,
                              complaint, ext, promised_on, checked_in_at, created_by)
  values (v_org, v_loc, p_job, p_kind, btrim(p_summary), coalesce(p_priority, 3), p_asset, p_requested_start, p_requested_end,
          p_estimated_minutes, coalesce(p_required_skills, '{}'), coalesce(p_payer_type, 'CUSTOMER'), p_payer_customer,
          coalesce(p_is_callback, false) or p_callback_of is not null, p_callback_of, p_complaint, coalesce(p_ext, '{}'),
          p_promised_on, case when p_kind = 'REPAIR_ORDER' then now() end, pm.current_user_id())
  returning id, number into v_id, v_num;

  perform pm.log_activity(v_org, v_loc, p_job, 'work_order.created', 'work_orders', v_id,
    format('Created %s %s', v_num, btrim(p_summary)),
    jsonb_build_object('kind', p_kind, 'priority', coalesce(p_priority, 3), 'asset_id', p_asset,
                       'is_callback', coalesce(p_is_callback, false) or p_callback_of is not null));
  return v_id;
end $$;

-- Assign technicians (or a crew) to a slot. Returns {"assignment_ids": [...], "work_order_status": ...}.
-- Overlap with any non-cancelled assignment of the same tech raises PM_DISPATCH_OVERLAP (23P01);
-- the exclusion constraints are the concurrency backstop. Required skills must be covered by the
-- union of the assigned people unless p_ignore_skills.
create or replace function pm.schedule_work_order(
  p_wo             uuid,
  p_start          timestamptz,
  p_end            timestamptz,
  p_employees      uuid[]  default null,
  p_crew           uuid    default null,
  p_replace        boolean default true,
  p_ignore_skills  boolean default false
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  w          pm.work_orders%rowtype;
  c          pm.crews%rowtype;
  v_emps     uuid[] := '{}';
  v_lead     uuid;
  v_missing  text[];
  v_ids      uuid[] := '{}';
  v_id       uuid;
  v_conflict text;
  v_slot     tstzrange;
  e          uuid;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status in ('COMPLETE','CLOSED','CANCELLED') then
    raise exception 'PM_WO_NOT_SCHEDULABLE: % is %', w.number, w.status using errcode = '22023';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'PM_INVALID: the slot must have a start before its end' using errcode = '22023';
  end if;
  v_slot := tstzrange(p_start, p_end, '[)');

  if p_crew is not null then
    select * into c from pm.crews k where k.org_id = w.org_id and k.id = p_crew and k.is_active;
    if not found then raise exception 'PM_UNKNOWN_CREW: %', p_crew using errcode = 'P0002'; end if;
    select coalesce(array_agg(m.employee_id), '{}') into v_emps
    from pm.crew_members m join core.employees ce on ce.id = m.employee_id and ce.is_active
    where m.org_id = w.org_id and m.crew_id = p_crew;
    v_lead := c.lead_employee_id;
    if cardinality(v_emps) = 0 and c.vendor_id is null then
      raise exception 'PM_EMPTY_CREW: crew % has no active members', c.name using errcode = '22023';
    end if;
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_emps from unnest(v_emps || coalesce(p_employees, '{}')) x where x is not null;
  if cardinality(v_emps) = 0 and (p_crew is null or c.vendor_id is null) then
    raise exception 'PM_INVALID: assign at least one technician or a crew' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_emps) x
             where not exists (select 1 from core.employees ce where ce.id = x and ce.org_id = w.org_id and ce.is_active)) then
    raise exception 'PM_UNKNOWN_EMPLOYEE: every technician must be an active employee of this organization' using errcode = 'P0002';
  end if;

  if not coalesce(p_ignore_skills, false) and cardinality(w.required_skills) > 0 and cardinality(v_emps) > 0 then
    select array_agg(r) into v_missing from unnest(w.required_skills) r
    where not exists (select 1 from pm.employee_skills es join pm.skills s on s.org_id = es.org_id and s.id = es.skill_id
                      where es.org_id = w.org_id and es.employee_id = any (v_emps) and s.code = r and s.is_active
                        and (es.expires_on is null or es.expires_on >= p_start::date));
    if v_missing is not null then
      raise exception 'PM_SKILL_MISMATCH: assigned technicians lack %', array_to_string(v_missing, ', ') using errcode = '22023';
    end if;
  end if;

  if coalesce(p_replace, true) then
    update pm.dispatch_assignments set status = 'CANCELLED', cancelled_at = now()
     where org_id = w.org_id and work_order_id = p_wo and status in ('ASSIGNED','DISPATCHED','EN_ROUTE');
  end if;

  -- one row per technician; a subcontract crew with no employees books as the crew
  if cardinality(v_emps) = 0 then
    select x.number into v_conflict from pm.dispatch_assignments d join pm.work_orders x on x.org_id = d.org_id and x.id = d.work_order_id
     where d.org_id = w.org_id and d.crew_id = p_crew and d.employee_id is null and d.status <> 'CANCELLED' and d.slot && v_slot limit 1;
    if v_conflict is not null then
      raise exception 'PM_DISPATCH_OVERLAP: crew % is already booked on % in that window', c.name, v_conflict using errcode = '23P01';
    end if;
    begin
      insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, crew_id, slot, is_lead, assigned_by)
      values (w.org_id, w.job_id, p_wo, null, p_crew, v_slot, true, pm.current_user_id())
      returning id into v_id;
    exception when exclusion_violation then
      raise exception 'PM_DISPATCH_OVERLAP: crew % already has an overlapping assignment', c.name using errcode = '23P01';
    end;
    v_ids := v_ids || v_id;
  end if;
  foreach e in array v_emps loop
    select x.number into v_conflict from pm.dispatch_assignments d join pm.work_orders x on x.org_id = d.org_id and x.id = d.work_order_id
     where d.org_id = w.org_id and d.employee_id = e and d.status <> 'CANCELLED' and d.slot && v_slot limit 1;
    if v_conflict is not null then
      raise exception 'PM_DISPATCH_OVERLAP: technician % is already booked on % in that window', e, v_conflict using errcode = '23P01';
    end if;
    begin
      insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, crew_id, slot, is_lead, assigned_by)
      values (w.org_id, w.job_id, p_wo, e, p_crew, v_slot, e = coalesce(v_lead, v_emps[1]), pm.current_user_id())
      returning id into v_id;
    exception when exclusion_violation then
      raise exception 'PM_DISPATCH_OVERLAP: technician % already has an overlapping assignment', e using errcode = '23P01';
    end;
    v_ids := v_ids || v_id;
  end loop;

  update pm.work_orders x
     set scheduled_start = (select min(lower(d.slot)) from pm.dispatch_assignments d where d.org_id = x.org_id and d.work_order_id = x.id and d.status <> 'CANCELLED'),
         scheduled_end   = (select max(upper(d.slot)) from pm.dispatch_assignments d where d.org_id = x.org_id and d.work_order_id = x.id and d.status <> 'CANCELLED'),
         status          = case when x.status in ('NEW','ON_HOLD') then 'SCHEDULED' else x.status end,
         hold_reason     = case when x.status = 'ON_HOLD' then null else x.hold_reason end
   where x.id = p_wo
  returning x.status into w.status;

  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.scheduled', 'work_orders', p_wo,
    format('Scheduled %s %s–%s', w.number, to_char(p_start, 'YYYY-MM-DD HH24:MI'), to_char(p_end, 'HH24:MI')),
    jsonb_build_object('employees', to_jsonb(v_emps), 'crew_id', p_crew, 'start', p_start, 'end', p_end,
                       'replaced', coalesce(p_replace, true)));
  return jsonb_build_object('assignment_ids', to_jsonb(v_ids), 'work_order_status', w.status);
end $$;

-- Tech clock states on one assignment (dispatched → en route → on site → done | cancelled).
create or replace function pm.set_assignment_status(p_assignment uuid, p_status text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dispatch_assignments%rowtype; w pm.work_orders%rowtype; ok boolean;
begin
  select * into d from pm.dispatch_assignments x where x.id = p_assignment for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: assignment % not found in the caller''s organization', p_assignment using errcode = '42501';
  end if;
  ok := case d.status
          when 'ASSIGNED'   then p_status in ('DISPATCHED','EN_ROUTE','ON_SITE','CANCELLED')
          when 'DISPATCHED' then p_status in ('EN_ROUTE','ON_SITE','CANCELLED')
          when 'EN_ROUTE'   then p_status in ('ON_SITE','CANCELLED')
          when 'ON_SITE'    then p_status = 'DONE'
          else false end;
  if not ok then raise exception 'PM_ASSIGNMENT_TRANSITION_INVALID: % -> %', d.status, p_status using errcode = '22023'; end if;
  select * into w from pm.work_orders x where x.org_id = d.org_id and x.id = d.work_order_id for update;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;

  update pm.dispatch_assignments
     set status = p_status,
         dispatched_at = case when p_status = 'DISPATCHED' then now() else dispatched_at end,
         en_route_at   = case when p_status = 'EN_ROUTE' then now() else en_route_at end,
         arrived_at    = case when p_status = 'ON_SITE' then now() else arrived_at end,
         done_at       = case when p_status = 'DONE' then now() else done_at end,
         cancelled_at  = case when p_status = 'CANCELLED' then now() else cancelled_at end
   where id = p_assignment;

  if p_status in ('DISPATCHED','EN_ROUTE') and w.status = 'SCHEDULED' then
    update pm.work_orders set status = 'DISPATCHED' where id = w.id;
  elsif p_status = 'ON_SITE' and w.status in ('NEW','SCHEDULED','DISPATCHED','ON_HOLD') then
    update pm.work_orders set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), hold_reason = null where id = w.id;
  end if;

  perform pm.log_activity(d.org_id, w.location_id, w.job_id, 'dispatch.' || lower(p_status), 'dispatch_assignments', p_assignment,
    format('%s: technician %s', w.number, lower(replace(p_status, '_', ' '))),
    jsonb_build_object('work_order_id', w.id, 'employee_id', d.employee_id, 'from', d.status, 'to', p_status));
  return p_assignment;
end $$;

create or replace function pm.start_work_order(p_wo uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.kind = 'PRODUCTION' and w.status not in ('RELEASED','ON_HOLD') then
    raise exception 'PM_NOT_RELEASED: production order % must be released to the shop first', w.number using errcode = '22023';
  end if;
  if w.status not in ('NEW','SCHEDULED','DISPATCHED','ON_HOLD','RELEASED') then
    raise exception 'PM_WO_TRANSITION_INVALID: % is %', w.number, w.status using errcode = '22023';
  end if;
  update pm.work_orders set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), hold_reason = null where id = p_wo;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.started', 'work_orders', p_wo,
    format('Started %s', w.number), jsonb_build_object('from', w.status));
  return p_wo;
end $$;

create or replace function pm.hold_work_order(p_wo uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status not in ('SCHEDULED','DISPATCHED','IN_PROGRESS','RELEASED') then
    raise exception 'PM_WO_TRANSITION_INVALID: % is %', w.number, w.status using errcode = '22023';
  end if;
  update pm.work_orders set status = 'ON_HOLD', hold_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_wo;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.on_hold', 'work_orders', p_wo,
    format('%s on hold%s', w.number, coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), '')),
    jsonb_build_object('from', w.status, 'reason', p_reason));
  return p_wo;
end $$;

-- Asset history (append; idempotent per work order + kind). Internal callers and members.
create or replace function pm.record_asset_service(
  p_asset         uuid,
  p_kind          text,
  p_summary       text    default null,
  p_performed_on  date    default null,
  p_work_order    uuid    default null,
  p_meter         numeric default null,
  p_employee      uuid    default null,
  p_parts         jsonb   default '[]'
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; w pm.work_orders%rowtype; v_id uuid; v_on date := coalesce(p_performed_on, current_date);
begin
  select * into a from pm.assets x where x.id = p_asset for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: asset % not found in the caller''s organization', p_asset using errcode = '42501';
  end if;
  if p_meter is not null and p_meter < 0 then raise exception 'PM_INVALID: meter must be ≥ 0' using errcode = '22023'; end if;
  if p_work_order is not null then
    select * into w from pm.work_orders x where x.org_id = a.org_id and x.id = p_work_order;
    if not found then raise exception 'PM_UNKNOWN_WORK_ORDER: %', p_work_order using errcode = 'P0002'; end if;
    select h.id into v_id from pm.asset_service_history h
    where h.org_id = a.org_id and h.work_order_id = p_work_order and h.kind = p_kind;
    if v_id is not null then return v_id; end if;           -- idempotent
  end if;

  insert into pm.asset_service_history (org_id, asset_id, job_id, work_order_id, kind, performed_on, employee_id, summary,
                                        meter_reading, parts, source, created_by)
  values (a.org_id, p_asset, w.job_id, p_work_order, p_kind, v_on, p_employee, p_summary, p_meter,
          coalesce(p_parts, '[]'), case when p_work_order is not null then 'WORK_ORDER' else 'MANUAL' end, pm.current_user_id())
  returning id into v_id;

  update pm.assets
     set last_service_on = greatest(coalesce(last_service_on, v_on), v_on),
         meter_reading   = case when p_meter is not null and (meter_read_on is null or v_on >= meter_read_on) then p_meter else meter_reading end,
         meter_read_on   = case when p_meter is not null and (meter_read_on is null or v_on >= meter_read_on) then v_on else meter_read_on end,
         installed_on    = case when p_kind = 'INSTALL' then coalesce(installed_on, v_on) else installed_on end
   where id = p_asset;

  perform pm.log_activity(a.org_id, a.location_id, w.job_id, 'asset.serviced', 'assets', p_asset,
    format('%s: %s', coalesce(a.make || ' ', '') || coalesce(a.serial_number, 'asset'), lower(p_kind)),
    jsonb_build_object('kind', p_kind, 'work_order_id', p_work_order, 'meter', p_meter, 'history_id', v_id));
  return v_id;
end $$;

-- Complete a visit/RO/install. Callback (recall) attribution: when flagged without an explicit
-- origin, links a completed work order from the 30 days before this one was opened, preferring
-- the same asset (serial), then the same job, then the same site address; most recent first.
create or replace function pm.complete_work_order(
  p_wo                 uuid,
  p_outcome            text,
  p_resolution         text    default null,
  p_is_callback        boolean default null,
  p_callback_of        uuid    default null,
  p_follow_up_required boolean default false,
  p_meter_out          numeric default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_cb boolean; v_of uuid; v_open int := 0; v_lead uuid; v_hist text;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status not in ('NEW','SCHEDULED','DISPATCHED','IN_PROGRESS','ON_HOLD','RELEASED') then
    raise exception 'PM_WO_TRANSITION_INVALID: % is %', w.number, w.status using errcode = '22023';
  end if;
  if p_outcome is null then raise exception 'PM_INVALID: outcome is required' using errcode = '22023'; end if;
  if w.kind = 'PRODUCTION' and to_regclass('pm.wo_operations') is not null then
    execute 'select count(*)::int from pm.wo_operations o where o.org_id = $1 and o.work_order_id = $2 and o.status not in (''COMPLETE'',''SKIPPED'')'
      into v_open using w.org_id, p_wo;
    if v_open > 0 then
      raise exception 'PM_OPERATIONS_OPEN: % has % open operation(s)', w.number, v_open using errcode = '22023';
    end if;
  end if;

  v_cb := coalesce(p_is_callback, w.is_callback) or p_callback_of is not null;
  v_of := coalesce(p_callback_of, w.callback_of_id);
  if p_callback_of is not null and not exists (select 1 from pm.work_orders x where x.org_id = w.org_id and x.id = p_callback_of and x.id <> w.id) then
    raise exception 'PM_UNKNOWN_WORK_ORDER: %', p_callback_of using errcode = 'P0002';
  end if;
  if v_cb and v_of is null then
    select x.id into v_of
    from pm.work_orders x
    left join pm.projects px on px.org_id = x.org_id and px.job_id = x.job_id
    left join pm.projects pw on pw.org_id = w.org_id and pw.job_id = w.job_id
    where x.org_id = w.org_id and x.id <> w.id and x.status in ('COMPLETE','CLOSED')
      and x.completed_at between w.created_at - interval '30 days' and w.created_at + interval '1 minute'
      and ((w.asset_id is not null and x.asset_id = w.asset_id)
           or x.job_id = w.job_id
           or (pw.site_address_line1 is not null and lower(px.site_address_line1) = lower(pw.site_address_line1)
               and px.site_zip is not distinct from pw.site_zip))
    order by coalesce(x.asset_id = w.asset_id, false) desc, (x.job_id = w.job_id) desc, x.completed_at desc
    limit 1;
  end if;

  update pm.work_orders
     set status = 'COMPLETE', outcome = p_outcome, resolution = coalesce(p_resolution, resolution),
         is_callback = v_cb, callback_of_id = v_of, follow_up_required = coalesce(p_follow_up_required, false),
         meter_out = coalesce(p_meter_out, meter_out), started_at = coalesce(started_at, now()),
         completed_at = now(), completed_by = pm.current_user_id(), hold_reason = null
   where id = p_wo;

  select d.employee_id into v_lead from pm.dispatch_assignments d
  where d.org_id = w.org_id and d.work_order_id = p_wo and d.status <> 'CANCELLED' order by d.is_lead desc, d.created_at limit 1;
  update pm.dispatch_assignments set status = 'DONE', done_at = now(),
         arrived_at = coalesce(arrived_at, now())
   where org_id = w.org_id and work_order_id = p_wo and status in ('ASSIGNED','DISPATCHED','EN_ROUTE','ON_SITE');

  if w.asset_id is not null then
    v_hist := case
      when v_cb then 'CALLBACK'
      when w.kind = 'MAINTENANCE_VISIT' then 'MAINTENANCE'
      when w.kind = 'INSTALL' then 'INSTALL'
      when w.kind = 'PDI' then 'PDI'
      when w.kind = 'INSPECTION' then 'INSPECTION'
      when w.payer_type = 'OEM' then 'WARRANTY'
      else 'REPAIR' end;
    perform pm.record_asset_service(w.asset_id, v_hist, coalesce(p_resolution, w.summary), current_date, p_wo,
                                    coalesce(p_meter_out, w.meter_in), v_lead, '[]'::jsonb);
  end if;

  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.completed', 'work_orders', p_wo,
    format('Completed %s (%s)', w.number, lower(p_outcome)),
    jsonb_build_object('outcome', p_outcome, 'is_callback', v_cb, 'callback_of_id', v_of,
                       'follow_up_required', coalesce(p_follow_up_required, false)));
  return p_wo;
end $$;

create or replace function pm.close_work_order(p_wo uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; n int;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status <> 'COMPLETE' then
    raise exception 'PM_WO_TRANSITION_INVALID: % is % (complete it first)', w.number, w.status using errcode = '22023';
  end if;
  select count(*) into n from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = p_wo and l.status = 'PROPOSED';
  if n > 0 then
    raise exception 'PM_WO_UNDECIDED_OPTIONS: % has % proposed option line(s); decide them first', w.number, n using errcode = '22023';
  end if;
  update pm.work_orders set status = 'CLOSED', closed_at = now(), closed_by = pm.current_user_id() where id = p_wo;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.closed', 'work_orders', p_wo,
    format('Closed %s', w.number), '{}'::jsonb);
  return p_wo;
end $$;

create or replace function pm.cancel_work_order(p_wo uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status in ('COMPLETE','CLOSED','CANCELLED') then
    raise exception 'PM_WO_TRANSITION_INVALID: % is %', w.number, w.status using errcode = '22023';
  end if;
  update pm.work_orders set status = 'CANCELLED', cancelled_at = now(), cancel_reason = p_reason where id = p_wo;
  update pm.dispatch_assignments set status = 'CANCELLED', cancelled_at = now()
   where org_id = w.org_id and work_order_id = p_wo and status not in ('DONE','CANCELLED');
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.cancelled', 'work_orders', p_wo,
    format('Cancelled %s', w.number), jsonb_build_object('from', w.status, 'reason', p_reason));
  return p_wo;
end $$;

-- Good/better/best: the customer approves some proposed lines and declines others.
create or replace function pm.decide_work_order_options(
  p_wo uuid, p_approve uuid[] default '{}', p_decline uuid[] default '{}', p_customer_name text default null
) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; n_a int; n_d int;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if coalesce(p_approve, '{}') && coalesce(p_decline, '{}') then
    raise exception 'PM_INVALID: a line cannot be both approved and declined' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_approve, '{}') || coalesce(p_decline, '{}')) x
             where not exists (select 1 from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = p_wo
                                 and l.id = x and l.status = 'PROPOSED')) then
    raise exception 'PM_INVALID: every line must be a PROPOSED line on %', w.number using errcode = '22023';
  end if;
  update pm.work_order_lines set status = 'APPROVED', decided_at = now(), decided_by_name = p_customer_name
   where org_id = w.org_id and work_order_id = p_wo and id = any (coalesce(p_approve, '{}'));
  get diagnostics n_a = row_count;
  update pm.work_order_lines set status = 'DECLINED', decided_at = now(), decided_by_name = p_customer_name
   where org_id = w.org_id and work_order_id = p_wo and id = any (coalesce(p_decline, '{}'));
  get diagnostics n_d = row_count;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.options_decided', 'work_orders', p_wo,
    format('%s: %s option line(s) approved, %s declined', w.number, n_a, n_d),
    jsonb_build_object('approved', to_jsonb(coalesce(p_approve, '{}')), 'declined', to_jsonb(coalesce(p_decline, '{}')),
                       'customer_name', p_customer_name));
  return n_a + n_d;
end $$;

-- ----------------------------------------------------------------------------
-- 16. Agreements
-- ----------------------------------------------------------------------------
create or replace function pm.activate_agreement(p_agreement uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.service_agreements%rowtype;
begin
  select * into a from pm.service_agreements x where x.id = p_agreement for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: agreement % not found in the caller''s organization', p_agreement using errcode = '42501';
  end if;
  if a.status not in ('DRAFT','SUSPENDED') then
    raise exception 'PM_AGREEMENT_TRANSITION_INVALID: % is %', a.number, a.status using errcode = '22023';
  end if;
  update pm.service_agreements set status = 'ACTIVE', activated_at = coalesce(activated_at, now()) where id = p_agreement;
  perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'agreement.activated', 'service_agreements', p_agreement,
    format('Activated %s %s', a.number, a.plan_name), jsonb_build_object('from', a.status));
  return p_agreement;
end $$;

create or replace function pm.cancel_agreement(p_agreement uuid, p_reason text default null, p_cancel_open_visits boolean default true)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.service_agreements%rowtype; n int := 0;
begin
  select * into a from pm.service_agreements x where x.id = p_agreement for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: agreement % not found in the caller''s organization', p_agreement using errcode = '42501';
  end if;
  if a.status not in ('DRAFT','ACTIVE','SUSPENDED') then
    raise exception 'PM_AGREEMENT_TRANSITION_INVALID: % is %', a.number, a.status using errcode = '22023';
  end if;
  update pm.service_agreements set status = 'CANCELLED', cancelled_at = now(), cancel_reason = p_reason where id = p_agreement;
  if coalesce(p_cancel_open_visits, true) then
    update pm.work_orders set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'agreement cancelled'
     where org_id = a.org_id and agreement_id = p_agreement and status = 'NEW';
    get diagnostics n = row_count;
  end if;
  perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'agreement.cancelled', 'service_agreements', p_agreement,
    format('Cancelled %s (%s open visit(s) cancelled)', a.number, n), jsonb_build_object('reason', p_reason, 'visits_cancelled', n));
  return p_agreement;
end $$;

-- Next term: same plan, starts the day the old one ends, same length; the old one becomes RENEWED.
create or replace function pm.renew_agreement(p_agreement uuid, p_price_cents bigint default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.service_agreements%rowtype; v_id uuid;
begin
  select * into a from pm.service_agreements x where x.id = p_agreement for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: agreement % not found in the caller''s organization', p_agreement using errcode = '42501';
  end if;
  if a.status not in ('ACTIVE','EXPIRED','SUSPENDED') then
    raise exception 'PM_AGREEMENT_TRANSITION_INVALID: % is %', a.number, a.status using errcode = '22023';
  end if;
  if p_price_cents is not null and p_price_cents < 0 then raise exception 'PM_INVALID: price must be ≥ 0' using errcode = '22023'; end if;
  insert into pm.service_agreements (org_id, location_id, job_id, customer_id, plan_name, tier, status, starts_on, ends_on,
      cadence, interval_months, visits_per_term, visit_window_days, visit_minutes, required_skills, price_cents,
      billing_frequency, member_discount_pct, auto_renew, renewed_from_id, activated_at, created_by)
  values (a.org_id, a.location_id, a.job_id, a.customer_id, a.plan_name, a.tier, 'ACTIVE', a.ends_on,
      a.ends_on + (a.ends_on - a.starts_on), a.cadence, a.interval_months, a.visits_per_term, a.visit_window_days,
      a.visit_minutes, a.required_skills, coalesce(p_price_cents, a.price_cents), a.billing_frequency,
      a.member_discount_pct, a.auto_renew, a.id, now(), pm.current_user_id())
  returning id into v_id;
  insert into pm.agreement_assets (org_id, agreement_id, asset_id)
  select a.org_id, v_id, x.asset_id from pm.agreement_assets x where x.org_id = a.org_id and x.agreement_id = a.id;
  update pm.service_agreements set status = 'RENEWED' where id = p_agreement;
  perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'agreement.renewed', 'service_agreements', v_id,
    format('Renewed %s', a.number), jsonb_build_object('renewed_from_id', a.id, 'price_cents', coalesce(p_price_cents, a.price_cents)));
  return v_id;
end $$;

-- Idempotent: visit k (1-based) is due on anchor + (k-1) × interval months; at most visits_per_term;
-- only visits due before the term ends and within the horizon are created. Re-running creates nothing
-- that exists (keyed by agreement + visit_seq), so it is safe from a nightly scheduler.
create or replace function pm.generate_agreement_visits(p_agreement uuid, p_horizon_days int default 365)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  a        pm.service_agreements%rowtype;
  v_int    int;
  v_anchor date;
  v_limit  date;
  v_due    date;
  v_asset  uuid;
  k        int := 0;
  n        int;
  v_count  int := 0;
begin
  select * into a from pm.service_agreements x where x.id = p_agreement for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: agreement % not found in the caller''s organization', p_agreement using errcode = '42501';
  end if;
  if a.status <> 'ACTIVE' then
    raise exception 'PM_AGREEMENT_NOT_ACTIVE: % is %', a.number, a.status using errcode = '22023';
  end if;
  if p_horizon_days is null or p_horizon_days < 0 or p_horizon_days > 1830 then
    raise exception 'PM_INVALID: horizon must be 0..1830 days' using errcode = '22023';
  end if;

  v_int := coalesce(a.interval_months, case a.cadence when 'MONTHLY' then 1 when 'QUARTERLY' then 3
                                                       when 'SEMIANNUAL' then 6 when 'ANNUAL' then 12 end);
  v_anchor := coalesce(a.first_visit_on, a.starts_on);
  v_limit := least(a.ends_on - 1, current_date + p_horizon_days);
  select case when count(*) = 1 then (array_agg(x.asset_id))[1] end into v_asset
  from pm.agreement_assets x where x.org_id = a.org_id and x.agreement_id = a.id;

  loop
    v_due := (v_anchor + make_interval(months => k * v_int))::date;
    exit when v_due > v_limit;
    exit when a.visits_per_term is not null and k >= a.visits_per_term;
    exit when k >= 600;
    if not exists (select 1 from pm.work_orders w where w.org_id = a.org_id and w.agreement_id = a.id and w.visit_seq = k + 1) then
      insert into pm.work_orders (org_id, location_id, job_id, kind, summary, priority, asset_id, agreement_id, visit_seq,
                                  due_on, due_by, estimated_minutes, required_skills, payer_type, created_by)
      values (a.org_id, a.location_id, a.job_id, 'MAINTENANCE_VISIT', format('%s visit %s', a.plan_name, k + 1), 4, v_asset,
              a.id, k + 1, v_due, least(v_due + a.visit_window_days - 1, a.ends_on - 1), a.visit_minutes,
              a.required_skills, 'CUSTOMER', pm.current_user_id())
      on conflict do nothing;
      get diagnostics n = row_count;
      v_count := v_count + n;
    end if;
    k := k + 1;
  end loop;

  if v_count > 0 then
    perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'agreement.visits_generated', 'service_agreements', a.id,
      format('%s: %s visit(s) generated', a.number, v_count),
      jsonb_build_object('created', v_count, 'horizon_days', p_horizon_days, 'interval_months', v_int));
  end if;
  return v_count;
end $$;

create or replace function pm.retire_asset(p_asset uuid, p_status text, p_replaced_by uuid default null, p_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype;
begin
  select * into a from pm.assets x where x.id = p_asset for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: asset % not found in the caller''s organization', p_asset using errcode = '42501';
  end if;
  if p_status not in ('ACTIVE','REPLACED','RETIRED','SOLD') then raise exception 'PM_INVALID: status %', p_status using errcode = '22023'; end if;
  if p_status = 'REPLACED' and p_replaced_by is null then
    raise exception 'PM_INVALID: a replaced asset needs the replacing asset' using errcode = '22023';
  end if;
  update pm.assets set status = p_status, replaced_by_asset_id = p_replaced_by,
         retired_on = case when p_status = 'ACTIVE' then null else coalesce(p_on, current_date) end
   where id = p_asset;
  if p_status = 'REPLACED' then
    perform pm.record_asset_service(p_asset, 'REPLACEMENT', 'Replaced', coalesce(p_on, current_date), null, null, null, '[]'::jsonb);
  end if;
  perform pm.log_activity(a.org_id, a.location_id, null, 'asset.status', 'assets', p_asset,
    format('Asset %s → %s', coalesce(a.serial_number, a.id::text), p_status), jsonb_build_object('from', a.status, 'to', p_status));
  return p_asset;
end $$;

-- ----------------------------------------------------------------------------
-- 17. Material moves (no valuation; Books owns cost). Every reference must be in the caller's
--     org and on one company. Idempotent on source_ref.
-- ----------------------------------------------------------------------------
create or replace function pm.record_material_move(
  p_kind         text,
  p_item         uuid,
  p_qty          numeric,
  p_from         uuid        default null,
  p_to           uuid        default null,
  p_job          uuid        default null,
  p_work_order   uuid        default null,
  p_uom          text        default 'EA',
  p_lot_ref      text        default null,
  p_source_ref   text        default null,
  p_moved_at     timestamptz default null,
  p_notes        text        default null,
  p_description  text        default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org   uuid := public.get_org_id();
  v_locs  uuid[] := '{}';
  v_loc   uuid;
  v_job   uuid := p_job;
  v_id    uuid := gen_random_uuid();
  v_prev  pm.material_moves%rowtype;
  r_loc   uuid;
begin
  if v_org is null then raise exception 'PM_FORBIDDEN: no organization in the caller''s session' using errcode = '42501'; end if;
  if p_from is not null then
    select s.location_id into r_loc from pm.stock_locations s where s.id = p_from and s.org_id = v_org;
    if r_loc is null then raise exception 'PM_FORBIDDEN: stock location % not found in the caller''s organization', p_from using errcode = '42501'; end if;
    v_locs := v_locs || r_loc;
  end if;
  if p_to is not null then
    select s.location_id into r_loc from pm.stock_locations s where s.id = p_to and s.org_id = v_org;
    if r_loc is null then raise exception 'PM_FORBIDDEN: stock location % not found in the caller''s organization', p_to using errcode = '42501'; end if;
    v_locs := v_locs || r_loc;
  end if;
  if p_work_order is not null then
    select w.job_id into r_loc from pm.work_orders w where w.id = p_work_order and w.org_id = v_org;
    if r_loc is null then raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_work_order using errcode = '42501'; end if;
    if v_job is not null and v_job <> r_loc then
      raise exception 'PM_INVALID: work order % is not on job %', p_work_order, v_job using errcode = '22023';
    end if;
    v_job := r_loc;
  end if;
  if v_job is not null then
    select j.location_id into r_loc from core.jobs j where j.id = v_job and j.org_id = v_org;
    if r_loc is null then raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', v_job using errcode = '42501'; end if;
    v_locs := v_locs || r_loc;
  end if;
  if cardinality(v_locs) = 0 then raise exception 'PM_INVALID: a move needs a stock location or a job' using errcode = '22023'; end if;
  select min(x::text)::uuid into v_loc from unnest(v_locs) x;
  if exists (select 1 from unnest(v_locs) x where x <> v_loc) then
    raise exception 'PM_INVALID: all references must be on one company (inter-company moves belong to Books)' using errcode = '22023';
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'PM_INVALID: quantity must be > 0' using errcode = '22023'; end if;

  if p_source_ref is not null then
    select * into v_prev from pm.material_moves m where m.org_id = v_org and m.source_ref = p_source_ref;
    if found then
      if v_prev.kind <> p_kind or v_prev.item_id <> p_item or v_prev.qty <> p_qty then
        raise exception 'PM_SOURCE_REF_CONFLICT: % already records a different move', p_source_ref using errcode = '23505';
      end if;
      return v_prev.id;                                  -- idempotent replay
    end if;
  end if;

  insert into pm.material_moves (id, org_id, location_id, kind, item_id, description, qty, uom, from_stock_location_id,
                                 to_stock_location_id, job_id, work_order_id, lot_ref, moved_at, moved_by, source_ref, notes)
  values (v_id, v_org, v_loc, p_kind, p_item, p_description, p_qty, coalesce(p_uom, 'EA'), p_from, p_to, v_job, p_work_order,
          p_lot_ref, coalesce(p_moved_at, now()), pm.current_user_id(), coalesce(p_source_ref, 'pm:material:' || v_id::text),
          p_notes);

  perform pm.log_activity(v_org, v_loc, v_job, 'material.' || lower(p_kind), 'material_moves', v_id,
    format('%s %s %s', initcap(lower(p_kind)), p_qty, coalesce(p_uom, 'EA')),
    jsonb_build_object('item_id', p_item, 'qty', p_qty, 'from', p_from, 'to', p_to, 'work_order_id', p_work_order));
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 18. Warranty claim flow (dealer)
-- ----------------------------------------------------------------------------
create or replace function pm.advance_warranty_claim(
  p_claim uuid, p_to text, p_amount_cents bigint default null, p_claim_number text default null, p_reason text default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype; ok boolean; v_loc uuid;
begin
  select * into c from pm.warranty_claims x where x.id = p_claim for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: claim % not found in the caller''s organization', p_claim using errcode = '42501';
  end if;
  ok := case c.status
          when 'DRAFT'     then p_to = 'SUBMITTED'
          when 'SUBMITTED' then p_to in ('RETURNED','APPROVED','REJECTED')
          when 'RETURNED'  then p_to in ('SUBMITTED','WRITTEN_OFF')
          when 'APPROVED'  then p_to in ('PAID','WRITTEN_OFF')
          when 'REJECTED'  then p_to in ('SUBMITTED','WRITTEN_OFF')
          else false end;
  if not ok then raise exception 'PM_CLAIM_TRANSITION_INVALID: % -> %', c.status, p_to using errcode = '22023'; end if;
  if p_amount_cents is not null and p_amount_cents < 0 then raise exception 'PM_INVALID: amount must be ≥ 0' using errcode = '22023'; end if;
  if p_to = 'SUBMITTED' and c.claimed_cents <= 0 then
    raise exception 'PM_INVALID: a claim needs a claimed amount before it is submitted' using errcode = '22023';
  end if;
  if p_to = 'APPROVED' and coalesce(p_amount_cents, c.claimed_cents) > c.claimed_cents then
    raise exception 'PM_INVALID: approved exceeds claimed' using errcode = '22023';
  end if;

  update pm.warranty_claims
     set status          = p_to,
         claim_number    = coalesce(p_claim_number, claim_number),
         submitted_at    = case when p_to = 'SUBMITTED' then now() else submitted_at end,
         decided_at      = case when p_to in ('APPROVED','REJECTED','WRITTEN_OFF') then now() else decided_at end,
         approved_cents  = case when p_to = 'APPROVED' then coalesce(p_amount_cents, claimed_cents)
                                when p_to = 'SUBMITTED' then null else approved_cents end,
         paid_cents      = case when p_to = 'PAID' then coalesce(p_amount_cents, approved_cents) else paid_cents end,
         paid_at         = case when p_to = 'PAID' then now() else paid_at end,
         decision_reason = coalesce(p_reason, decision_reason)
   where id = p_claim;

  select w.location_id into v_loc from pm.work_orders w where w.org_id = c.org_id and w.id = c.work_order_id;
  perform pm.log_activity(c.org_id, v_loc, c.job_id, 'warranty_claim.' || lower(p_to), 'warranty_claims', p_claim,
    format('Warranty claim %s → %s', coalesce(p_claim_number, c.claim_number, ''), p_to),
    jsonb_build_object('from', c.status, 'to', p_to, 'amount_cents', p_amount_cents));
  return p_claim;
end $$;

-- ----------------------------------------------------------------------------
-- 19. Views (security_invoker)
-- ----------------------------------------------------------------------------
-- Dispatch board: booked vs capacity per technician (or subcontract crew) per day.
-- Day = lower(slot)::date in the session time zone (UTC on Supabase).
create or replace view pm.v_dispatch_board with (security_invoker = on) as
select
  d.org_id,
  w.location_id,
  (lower(d.slot))::date                                                  as day,
  d.employee_id,
  coalesce(d.crew_id, pc.crew_id)                                        as crew_id,
  count(*)::int                                                          as assignments,
  (sum(extract(epoch from (upper(d.slot) - lower(d.slot)))) / 60)::int   as booked_minutes,
  coalesce(max(pc.capacity), max(c.capacity_minutes_per_day), 480)::int  as capacity_minutes,
  (coalesce(max(pc.capacity), max(c.capacity_minutes_per_day), 480)
     - (sum(extract(epoch from (upper(d.slot) - lower(d.slot)))) / 60))::int as available_minutes
from pm.dispatch_assignments d
join pm.work_orders w on w.org_id = d.org_id and w.id = d.work_order_id
left join pm.crews c on c.org_id = d.org_id and c.id = d.crew_id
left join lateral (
  select m.crew_id, k.capacity_minutes_per_day as capacity
  from pm.crew_members m join pm.crews k on k.org_id = m.org_id and k.id = m.crew_id
  where m.org_id = d.org_id and m.employee_id = d.employee_id and m.is_primary
  limit 1
) pc on true
where d.status <> 'CANCELLED'
group by d.org_id, w.location_id, (lower(d.slot))::date, d.employee_id, coalesce(d.crew_id, pc.crew_id);

-- Unassigned queue (dispatchable work not yet on the board).
create or replace view pm.v_dispatch_queue with (security_invoker = on) as
select w.org_id, w.location_id, w.id as work_order_id, w.job_id, w.number, w.kind, w.priority, w.summary,
       w.requested_start, w.requested_end, w.due_on, w.due_by, w.estimated_minutes, w.required_skills,
       (coalesce(w.due_by, w.due_on) < current_date) as is_overdue, w.created_at
from pm.work_orders w
where w.status in ('NEW','ON_HOLD') and w.kind <> 'PRODUCTION';

-- Operational on-hand by stock location and item (NOT valuation).
create or replace view pm.v_stock_on_hand with (security_invoker = on) as
select x.org_id, s.location_id, x.stock_location_id, s.code as stock_location_code, s.kind as stock_location_kind,
       x.item_id, x.uom, sum(x.qty)::numeric(14,4) as qty_on_hand,
       t.min_qty, t.max_qty,
       (t.min_qty is not null and sum(x.qty) < t.min_qty) as below_min
from (
  select m.org_id, m.to_stock_location_id as stock_location_id, m.item_id, m.uom, m.qty
  from pm.material_moves m where m.to_stock_location_id is not null
  union all
  select m.org_id, m.from_stock_location_id, m.item_id, m.uom, -m.qty
  from pm.material_moves m where m.from_stock_location_id is not null
) x
join pm.stock_locations s on s.org_id = x.org_id and s.id = x.stock_location_id
left join pm.stock_targets t on t.org_id = x.org_id and t.stock_location_id = x.stock_location_id and t.item_id = x.item_id
group by x.org_id, s.location_id, x.stock_location_id, s.code, s.kind, x.item_id, x.uom, t.min_qty, t.max_qty;

-- Equipment history (one row per service event; newest first per asset in the UI).
create or replace view pm.v_asset_history with (security_invoker = on) as
select h.org_id, a.location_id, h.asset_id, a.serial_number, a.make, a.model, a.customer_id,
       h.id as history_id, h.kind, h.performed_on, h.summary, h.meter_reading, h.employee_id,
       h.work_order_id, w.number as work_order_number, h.job_id
from pm.asset_service_history h
join pm.assets a on a.org_id = h.org_id and a.id = h.asset_id
left join pm.work_orders w on w.org_id = h.org_id and w.id = h.work_order_id;

-- ---------------------------------------------------------------------------
-- KPIs (long form; the union pm.v_kpis lives in 1107). Window: trailing 90 days unless noted.
--   first_time_fix_pct        service/RO jobs whose visits are all done (last completion in 90d):
--                             jobs with exactly one non-callback visit, outcome FIXED/COMPLETED, no follow-up,
--                             no callback on the job and no later recall of its visit ÷ such jobs
--   callback_rate_pct         completed SERVICE/MAINTENANCE/INSTALL/RO visits flagged callback (column or ext.is_recall) ÷ completed
--   agreement_visits_overdue_count  agreement visits in NEW/ON_HOLD whose window end (due_by, else due_on) < today (point in time)
--   agreement_renewal_pct     agreements whose end date fell in the trailing 365d and were renewed ÷ those (cancelled before end excluded)
--   avg_ticket_cents          mean of APPROVED CUSTOMER-pay line totals per completed non-callback visit with a charge
--                             (basis: work_order_lines — sold on site, not Books-billed revenue)
--   revenue_per_tech_day_cents  same line totals ÷ distinct (technician, day) with a DONE assignment on those visits
--   billable_utilization_pct  billable ÷ total hours on SUBMITTED/APPROVED time entries (work_date in 90d)
--   ro_days_in_shop           mean days from checked_in_at to completed_at (ready) on ROs completed in 90d
--   warranty_claims_outstanding_cents  Σ (approved, else claimed) − paid on SUBMITTED/RETURNED/APPROVED claims (point in time)
--   warranty_rejection_rate_pct  REJECTED + WRITTEN_OFF ÷ claims decided in 90d
--   tech_efficiency_pct       flagged hours (LABOR line flag_hours, else WO ext.flagged_hours) ÷ clocked hours
--                             (time_entries.work_order_id) on ROs completed in 90d
--   effective_labor_rate_cents  LABOR line amounts (customer + warranty pay) ÷ clocked hours on the same ROs
-- ---------------------------------------------------------------------------
create or replace view pm.v_kpis_field_service with (security_invoker = on) as
with done as (
  select w.*, (w.is_callback or coalesce((w.ext ->> 'is_recall') = 'true', false)) as cb
  from pm.work_orders w
  where w.status in ('COMPLETE','CLOSED') and w.completed_at >= now() - interval '90 days'
),
tickets as (
  select d.org_id, d.location_id, d.id,
         coalesce((select sum(l.amount_cents) from pm.work_order_lines l
                   where l.org_id = d.org_id and l.work_order_id = d.id and l.status = 'APPROVED'
                     and l.pay_type = 'CUSTOMER'), 0)::numeric as ticket_cents
  from done d
  where not d.cb and d.kind in ('SERVICE','MAINTENANCE_VISIT','REPAIR_ORDER','INSTALL')
),
svc_jobs as (
  select w.org_id, w.location_id, w.job_id,
         count(*) filter (where w.status <> 'CANCELLED' and not w.is_callback)                           as visits,
         count(*) filter (where w.is_callback or coalesce((w.ext ->> 'is_recall') = 'true', false))      as callbacks,
         bool_and(w.status in ('COMPLETE','CLOSED','CANCELLED'))                                         as all_done,
         max(w.completed_at)                                                                            as last_done,
         bool_or(w.status in ('COMPLETE','CLOSED') and not w.is_callback and w.outcome in ('FIXED','COMPLETED')
                 and not w.follow_up_required)                                                          as fixed,
         bool_or(exists (select 1 from pm.work_orders c where c.org_id = w.org_id and c.callback_of_id = w.id)) as recalled
  from pm.work_orders w
  where w.kind in ('SERVICE','REPAIR_ORDER')
  group by w.org_id, w.location_id, w.job_id
),
ro as (
  select d.org_id, d.location_id, d.id, d.checked_in_at, d.created_at, d.completed_at,
         coalesce(nullif((select sum(coalesce(l.flag_hours, 0)) from pm.work_order_lines l
                          where l.org_id = d.org_id and l.work_order_id = d.id and l.kind = 'LABOR' and l.status = 'APPROVED'), 0),
                  case when jsonb_typeof(d.ext -> 'flagged_hours') = 'number' then (d.ext ->> 'flagged_hours')::numeric end,
                  0) as flagged_hours,
         coalesce((select sum(l.amount_cents) from pm.work_order_lines l
                   where l.org_id = d.org_id and l.work_order_id = d.id and l.kind = 'LABOR' and l.status = 'APPROVED'
                     and l.pay_type in ('CUSTOMER','WARRANTY')), 0)::numeric as labor_cents,
         coalesce((select sum(t.hours) from pm.time_entries t
                   where t.org_id = d.org_id and t.work_order_id = d.id and t.approval_state <> 'VOID'), 0)::numeric as clocked_hours
  from done d where d.kind = 'REPAIR_ORDER'
)
select org_id, location_id, null::uuid as job_id, 'first_time_fix_pct'::text as metric,
       round(count(*) filter (where visits = 1 and fixed and callbacks = 0 and not recalled)::numeric / count(*), 4) as value,
       current_date as as_of, 'work_orders: service/RO jobs fully done, last visit in 90d'::text as basis, count(*)::int as sample_n
from svc_jobs where all_done and visits >= 1 and last_done >= now() - interval '90 days'
group by org_id, location_id
union all
select org_id, location_id, null, 'callback_rate_pct',
       round(count(*) filter (where cb)::numeric / count(*), 4), current_date,
       'work_orders: completed visits in 90d', count(*)::int
from done where kind in ('SERVICE','MAINTENANCE_VISIT','INSTALL','REPAIR_ORDER')
group by org_id, location_id
union all
select a.org_id, a.location_id, null, 'agreement_visits_overdue_count',
       count(w.id)::numeric, current_date, 'work_orders: agreement visits unscheduled past their window', count(distinct a.id)::int
from pm.service_agreements a
left join pm.work_orders w on w.org_id = a.org_id and w.agreement_id = a.id and w.status in ('NEW','ON_HOLD')
                          and coalesce(w.due_by, w.due_on) < current_date
where a.status not in ('DRAFT','CANCELLED')
group by a.org_id, a.location_id
union all
select a.org_id, a.location_id, null, 'agreement_renewal_pct',
       round(count(*) filter (where a.status = 'RENEWED'
                                 or exists (select 1 from pm.service_agreements n where n.org_id = a.org_id and n.renewed_from_id = a.id))::numeric
             / count(*), 4),
       current_date, 'service_agreements: term ended in trailing 365d', count(*)::int
from pm.service_agreements a
where a.ends_on <= current_date and a.ends_on > current_date - 365 and a.status <> 'DRAFT'
  and not (a.status = 'CANCELLED' and a.cancelled_at::date < a.ends_on)
group by a.org_id, a.location_id
union all
select org_id, location_id, null, 'avg_ticket_cents', round(avg(ticket_cents)), current_date,
       'work_order_lines: approved customer-pay lines (sold, not billed)', count(*)::int
from tickets where ticket_cents > 0
group by org_id, location_id
union all
select t.org_id, t.location_id, null, 'revenue_per_tech_day_cents',
       round(t.ticket_cents / nullif(td.tech_days, 0)), current_date,
       'work_order_lines ÷ distinct (tech, day) with a DONE assignment', td.tech_days::int
from (select org_id, location_id, sum(ticket_cents) as ticket_cents from tickets group by org_id, location_id) t
join lateral (
  select count(distinct (coalesce(d.employee_id, d.crew_id), (lower(d.slot))::date)) as tech_days
  from pm.dispatch_assignments d join tickets k on k.org_id = d.org_id and k.id = d.work_order_id
  where d.org_id = t.org_id and k.location_id = t.location_id and d.status = 'DONE'
) td on true
where td.tech_days > 0 and t.ticket_cents > 0
union all
select j.org_id, j.location_id, null, 'billable_utilization_pct',
       round(sum(t.hours) filter (where t.billable) / nullif(sum(t.hours), 0), 4), current_date,
       'time_entries: submitted/approved, work_date in 90d', count(*)::int
from pm.time_entries t join core.jobs j on j.org_id = t.org_id and j.id = t.job_id
where t.approval_state in ('SUBMITTED','APPROVED') and t.work_date >= current_date - 90
group by j.org_id, j.location_id
union all
select org_id, location_id, null, 'ro_days_in_shop',
       round(avg(extract(epoch from (completed_at - coalesce(checked_in_at, created_at))) / 86400)::numeric, 2), current_date,
       'work_orders: repair orders ready in 90d', count(*)::int
from ro group by org_id, location_id
union all
select c.org_id, w.location_id, null, 'warranty_claims_outstanding_cents',
       sum(greatest(coalesce(c.approved_cents, c.claimed_cents) - c.paid_cents, 0))::numeric, current_date,
       'warranty_claims: submitted/returned/approved, not paid', count(*)::int
from pm.warranty_claims c join pm.work_orders w on w.org_id = c.org_id and w.id = c.work_order_id
where c.status in ('SUBMITTED','RETURNED','APPROVED')
group by c.org_id, w.location_id
union all
select c.org_id, w.location_id, null, 'warranty_rejection_rate_pct',
       round(count(*) filter (where c.status in ('REJECTED','WRITTEN_OFF'))::numeric / count(*), 4), current_date,
       'warranty_claims: decided in 90d', count(*)::int
from pm.warranty_claims c join pm.work_orders w on w.org_id = c.org_id and w.id = c.work_order_id
where c.status in ('APPROVED','PAID','REJECTED','WRITTEN_OFF') and c.decided_at >= now() - interval '90 days'
group by c.org_id, w.location_id
union all
select org_id, location_id, null, 'tech_efficiency_pct',
       round(sum(flagged_hours) / sum(clocked_hours), 4), current_date,
       'repair orders ready in 90d with clocked time', count(*)::int
from ro where clocked_hours > 0 group by org_id, location_id
union all
select org_id, location_id, null, 'effective_labor_rate_cents',
       round(sum(labor_cents) / sum(clocked_hours)), current_date,
       'repair orders ready in 90d with clocked time', count(*)::int
from ro where clocked_hours > 0 group by org_id, location_id;

-- ----------------------------------------------------------------------------
-- 20. RLS (D12)
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['skills','employee_skills','crews','crew_members','stock_locations','stock_targets','assets',
    'service_agreements','agreement_assets','work_orders','dispatch_assignments','work_order_lines','material_moves',
    'asset_service_history','warranty_claims'] loop
    execute format('alter table pm.%I enable row level security', t);
  end loop;
  -- uniform isolation (writes further narrowed by grants / definer functions)
  foreach t in array array['skills','employee_skills','crews','crew_members','stock_locations','stock_targets',
    'agreement_assets','work_orders','dispatch_assignments','material_moves','asset_service_history'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='assets' and policyname='org_select') then
    create policy org_select on pm.assets for select using (org_id = public.get_org_id());
    create policy active_insert on pm.assets for insert
      with check (org_id = public.get_org_id() and status = 'ACTIVE' and replaced_by_asset_id is null and retired_on is null);
    create policy org_update on pm.assets for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy org_delete on pm.assets for delete using (org_id = public.get_org_id());
  end if;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='service_agreements' and policyname='org_select') then
    create policy org_select on pm.service_agreements for select using (org_id = public.get_org_id());
    create policy draft_insert on pm.service_agreements for insert
      with check (org_id = public.get_org_id() and status = 'DRAFT' and renewed_from_id is null
                  and activated_at is null and cancelled_at is null);
    create policy org_update on pm.service_agreements for update
      using (org_id = public.get_org_id() and status in ('DRAFT','ACTIVE','SUSPENDED'))
      with check (org_id = public.get_org_id());
    create policy draft_delete on pm.service_agreements for delete using (org_id = public.get_org_id() and status = 'DRAFT');
  end if;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='work_order_lines' and policyname='org_select') then
    create policy org_select on pm.work_order_lines for select using (org_id = public.get_org_id());
    create policy open_insert on pm.work_order_lines for insert
      with check (org_id = public.get_org_id() and status in ('PROPOSED','APPROVED') and decided_at is null);
    create policy org_update on pm.work_order_lines for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy org_delete on pm.work_order_lines for delete using (org_id = public.get_org_id());
  end if;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='warranty_claims' and policyname='org_select') then
    create policy org_select on pm.warranty_claims for select using (org_id = public.get_org_id());
    create policy draft_insert on pm.warranty_claims for insert
      with check (org_id = public.get_org_id() and status = 'DRAFT' and approved_cents is null and paid_cents = 0
                  and submitted_at is null and decided_at is null and paid_at is null);
    create policy draft_update on pm.warranty_claims for update using (org_id = public.get_org_id() and status = 'DRAFT')
      with check (org_id = public.get_org_id() and status = 'DRAFT');
    create policy draft_delete on pm.warranty_claims for delete using (org_id = public.get_org_id() and status = 'DRAFT');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 21. Table grants: nothing for anon/PUBLIC; state columns move only via functions
-- ----------------------------------------------------------------------------
revoke all on pm.skills, pm.employee_skills, pm.crews, pm.crew_members, pm.stock_locations, pm.stock_targets, pm.assets,
              pm.service_agreements, pm.agreement_assets, pm.work_orders, pm.dispatch_assignments, pm.work_order_lines,
              pm.material_moves, pm.asset_service_history, pm.warranty_claims
  from public, anon, authenticated;
grant select, insert, update, delete on pm.skills, pm.employee_skills, pm.crews, pm.crew_members, pm.stock_locations,
              pm.stock_targets, pm.assets, pm.service_agreements, pm.agreement_assets, pm.work_orders, pm.dispatch_assignments,
              pm.work_order_lines, pm.material_moves, pm.asset_service_history, pm.warranty_claims
  to service_role;

grant select, insert, update, delete on pm.skills, pm.employee_skills, pm.crews, pm.crew_members, pm.stock_locations,
              pm.stock_targets, pm.agreement_assets
  to authenticated;

-- assets: status / replacement / service rollups only via retire_asset / record_asset_service
grant select, insert, delete on pm.assets to authenticated;
grant update (kind, customer_id, item_id, serial_number, make, model, model_year, description, site_label,
              site_address_line1, site_city, site_state, site_zip, installed_on, warranty_expires_on, registered_on, ext)
  on pm.assets to authenticated;

-- agreements: status / activation / renewal only via functions
grant select, insert, delete on pm.service_agreements to authenticated;
grant update (plan_name, tier, starts_on, ends_on, cadence, interval_months, first_visit_on, visits_per_term,
              visit_window_days, visit_minutes, required_skills, price_cents, billing_frequency, member_discount_pct, auto_renew)
  on pm.service_agreements to authenticated;

-- work orders: created and moved only by functions; descriptive columns editable
grant select on pm.work_orders to authenticated;
grant update (priority, summary, description, complaint, cause, resolution, wbs_id, requested_start, requested_end,
              estimated_minutes, required_skills, promised_on, meter_in, ext)
  on pm.work_orders to authenticated;

grant select on pm.dispatch_assignments, pm.material_moves, pm.asset_service_history to authenticated;

grant select, insert, delete on pm.work_order_lines to authenticated;
grant update (sort, kind, price_book_item_id, item_id, cost_code_id, description, qty, uom, unit_price_cents,
              unit_cost_cents, discount_pct, labor_minutes, flag_hours, pay_type, option_group)
  on pm.work_order_lines to authenticated;

grant select, insert, delete on pm.warranty_claims to authenticated;
grant update (claim_number, failure_code, labor_op, claimed_labor_cents, claimed_parts_cents, claimed_other_cents,
              filing_deadline, notes, asset_id)
  on pm.warranty_claims to authenticated;

grant update (work_order_id) on pm.time_entries to authenticated;

grant select on pm.v_dispatch_board, pm.v_dispatch_queue, pm.v_stock_on_hand, pm.v_asset_history, pm.v_kpis_field_service
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 22. Function grants: revoke everything this file defines, then grant the member RPC surface
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm' and p.proname in (
             'tg_refs_in_org','tg_job_location','fmt_doc_number','tg_asset_identity','tg_validate_asset_ext',
             'tg_agreement_number','tg_agreement_lock','tg_work_order_number','tg_wo_line','tg_warranty_claim_lock',
             'guard_work_orders_closed','create_work_order','schedule_work_order','set_assignment_status',
             'start_work_order','hold_work_order','record_asset_service','complete_work_order','close_work_order',
             'cancel_work_order','decide_work_order_options','activate_agreement','cancel_agreement','renew_agreement',
             'generate_agreement_visits','retire_asset','record_material_move','advance_warranty_claim') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('guard_work_orders_closed','create_work_order','schedule_work_order','set_assignment_status',
                     'start_work_order','hold_work_order','record_asset_service','complete_work_order','close_work_order',
                     'cancel_work_order','decide_work_order_options','activate_agreement','cancel_agreement','renew_agreement',
                     'generate_agreement_visits','retire_asset','record_material_move','advance_warranty_claim') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1104_pm_field_service
-- ============================================================================
