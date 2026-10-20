-- ============================================================================
-- 1106 · Merit Projects v2 — selections + allowances variance, client approvals,
--        interior-design procurement items, flooring measures
--
-- Binding inputs: blueprint D7/D10/D11/D12 + §2.2 (selections, allowances, procurement_markup,
-- client_approvals), research 02 (selections/allowances), research 05 F-B / D-B (flooring order
-- and takeoff; interior-design Item lifecycle), pack manifests residential_remodel, home_builder,
-- manufacturing_eto, flooring, interior_design (selection fieldDefs: room, finish, dye_lot,
-- allowance_cents, sidemark, markup_pct, item_status …; guard selections_approved; KPIs
-- selections_on_time_pct, proposal_approval_days, items_overdue_count, product_margin_pct,
-- installer_sqft_per_day, waste_variance_pct).
--
-- Objects
--   selections ─< selection_options      a decision the client owes (category, room, due date, allowance)
--                                        with priced options; approve_selection pins chosen total and
--                                        variance = chosen − allowance (positive = over allowance)
--   client_approvals                     append-only record of a client decision (name, method, time,
--                                        what was approved as a snapshot); shared by any subject
--   procurement_items                    designer/flooring item: cost, markup, sell, vendor, PO link
--                                        placeholder (commitment_id → 1102), receiving, storage, install
--   measures ─< measure_areas            flooring takeoff: rooms/areas with sqft, waste %, material qty
--
-- Allowance: the real column selections.allowance_cents is authoritative; when it is null the pack
-- ext key `allowance_cents` (residential_remodel fieldDef) is used. allowance_id is a soft link to
-- 1102's pm.allowances (no FK: 1102 is authored concurrently). Dye lot / finish / sidemark stay in ext.
-- Boundaries: no money posting. Allowance overage becomes a change order or an ALLOWANCE billing
-- request in 1102 — this file only computes and pins the variance. Vendor POs are 1102 commitments.
-- Replaces the 1100 placeholder pm.guard_selections_approved. Depends on 1104 (stock_locations,
-- work_orders, shared helper triggers). Idempotent: safe to run twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Selections and options
-- ----------------------------------------------------------------------------
create table if not exists pm.selections (
  id                         uuid primary key default gen_random_uuid(),
  org_id                     uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                     uuid not null,
  wbs_id                     uuid,                                    -- room / area node
  category                   text not null check (char_length(category) between 1 and 80),
  title                      text not null check (char_length(title) between 1 and 200),
  description                text,
  allowance_cents            bigint check (allowance_cents is null or allowance_cents >= 0),
  allowance_id               uuid,                                    -- soft link → 1102 pm.allowances
  due_on                     date,
  status                     text not null default 'OPEN' check (status in ('OPEN','PROPOSED','APPROVED','REJECTED','VOID')),
  chosen_option_id           uuid,
  chosen_price_book_item_id  uuid references pm.price_book_items(id),
  chosen_total_cents         bigint,                                  -- pinned at approval
  allowance_applied_cents    bigint,                                  -- pinned at approval
  variance_cents             bigint,                                  -- pinned: chosen − allowance
  proposed_at                timestamptz,
  proposed_by                text,
  approved_at                timestamptz,
  approved_by_name           text,
  client_approval_id         uuid,
  rejected_at                timestamptz,
  voided_at                  timestamptz,
  void_reason                text,
  sort                       int not null default 0,
  ext                        jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by                 text default pm.current_user_id(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, id),
  check (status <> 'APPROVED' or (approved_at is not null and chosen_total_cents is not null and approved_by_name is not null)),
  check (status <> 'VOID' or voided_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_selections_job_idx on pm.selections (org_id, job_id, status);
create index if not exists pm_selections_due_idx on pm.selections (org_id, due_on) where status not in ('APPROVED','VOID');

create table if not exists pm.selection_options (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  selection_id        uuid not null,
  sort                int not null default 0,
  label               text not null check (char_length(label) between 1 and 120),
  description         text,
  price_book_item_id  uuid references pm.price_book_items(id),
  item_id             uuid,
  vendor_id           uuid references core.vendors(id),
  vendor_sku          text,
  qty                 numeric(14,4) not null default 1 check (qty > 0),
  uom                 text not null default 'EA',
  unit_cost_cents     bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  markup_pct          numeric(7,4) check (markup_pct is null or markup_pct >= 0),
  unit_price_cents    bigint check (unit_price_cents is null or unit_price_cents >= 0),   -- sell
  freight_cents       bigint not null default 0 check (freight_cents >= 0),
  lead_time_days      int check (lead_time_days is null or lead_time_days >= 0),
  is_recommended      boolean not null default false,
  amount_cents        bigint generated always as ((round(qty * coalesce(unit_price_cents, 0)))::bigint) stored,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, selection_id, id),
  foreign key (org_id, selection_id) references pm.selections (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_selection_options_sel_idx on pm.selection_options (org_id, selection_id, sort);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'selections_chosen_option_fk' and conrelid = 'pm.selections'::regclass) then
    alter table pm.selections add constraint selections_chosen_option_fk
      foreign key (org_id, id, chosen_option_id) references pm.selection_options (org_id, selection_id, id) deferrable initially immediate;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Client approvals (append-only; written by definer functions)
-- ----------------------------------------------------------------------------
create table if not exists pm.client_approvals (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  subject_table          text not null check (subject_table in
                           ('selections','procurement_items','work_orders','change_orders','estimates','draws')),
  subject_id             uuid not null,
  decision               text not null check (decision in ('APPROVED','REJECTED')),
  approver_name          text not null check (char_length(btrim(approver_name)) between 1 and 200),
  approver_email         text,
  approver_customer_id   uuid references core.customers(id),
  method                 text not null default 'IN_PERSON' check (method in ('IN_PERSON','PORTAL','EMAIL','PHONE','E_SIGNATURE')),
  signature_document_id  uuid references public.documents(id),
  amount_cents           bigint,
  snapshot               jsonb not null default '{}' check (jsonb_typeof(snapshot) = 'object'),
  comment                text,
  decided_at             timestamptz not null default now(),
  recorded_by            text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_client_approvals_subject_idx on pm.client_approvals (org_id, subject_table, subject_id, decided_at desc);
create index if not exists pm_client_approvals_job_idx on pm.client_approvals (org_id, job_id, decided_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'selections_client_approval_fk' and conrelid = 'pm.selections'::regclass) then
    alter table pm.selections add constraint selections_client_approval_fk
      foreign key (org_id, client_approval_id) references pm.client_approvals (org_id, id) deferrable initially immediate;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Procurement items (interior design FF&E, flooring material orders)
-- ----------------------------------------------------------------------------
create table if not exists pm.procurement_items (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                uuid not null,
  selection_id          uuid,
  option_id             uuid,
  wbs_id                uuid,
  vendor_id             uuid references core.vendors(id),
  description           text not null check (char_length(description) between 1 and 300),
  vendor_sku            text,
  sidemark              text,
  qty                   numeric(14,4) not null default 1 check (qty > 0),
  uom                   text not null default 'EA',
  unit_cost_cents       bigint check (unit_cost_cents is null or unit_cost_cents >= 0),        -- net cost
  markup_pct            numeric(7,4) check (markup_pct is null or markup_pct >= 0),
  unit_sell_cents       bigint check (unit_sell_cents is null or unit_sell_cents >= 0),
  freight_cents         bigint not null default 0 check (freight_cents >= 0),                  -- freight + receiving estimate
  cost_total_cents      bigint generated always as ((round(qty * coalesce(unit_cost_cents, 0)))::bigint + freight_cents) stored,
  sell_total_cents      bigint generated always as ((round(qty * coalesce(unit_sell_cents, 0)))::bigint) stored,
  client_deposit_pct    numeric(5,4) check (client_deposit_pct is null or (client_deposit_pct >= 0 and client_deposit_pct <= 1)),
  commitment_id         uuid,                         -- placeholder → 1102 pm.commitments (vendor PO); no FK
  commitment_line_id    uuid,                         -- placeholder → 1102 pm.commitment_lines; no FK
  po_number             text,
  status                text not null default 'SPECIFIED' check (status in
                          ('SPECIFIED','PROPOSED','APPROVED','ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED','RECEIVED',
                           'DAMAGED','STORED','DELIVERED','INSTALLED','RETURNED','CANCELLED')),
  proposed_at           timestamptz,
  approved_at           timestamptz,
  approved_by_name      text,
  client_approval_id    uuid,
  ordered_on            date,
  acknowledged_on       date,
  expected_on           date,                          -- expected ship/delivery to the receiver
  shipped_on            date,
  tracking_ref          text,
  received_on           date,
  received_qty          numeric(14,4) check (received_qty is null or received_qty >= 0),
  received_condition    text check (received_condition is null or received_condition in ('GOOD','DAMAGED','PARTIAL','WRONG_ITEM')),
  storage_location_id   uuid,
  stored_since          date,
  install_on            date,
  delivered_on          date,
  installed_on          date,
  cancelled_at          timestamptz,
  notes                 text,
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  check (status not in ('APPROVED','ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED','RECEIVED','DAMAGED','STORED','DELIVERED','INSTALLED')
         or approved_at is not null),
  check (option_id is null or selection_id is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, selection_id) references pm.selections (org_id, job_id, id) deferrable initially immediate,
  foreign key (org_id, selection_id, option_id) references pm.selection_options (org_id, selection_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate,
  foreign key (org_id, storage_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, client_approval_id) references pm.client_approvals (org_id, id) deferrable initially immediate
);
create index if not exists pm_procurement_job_idx on pm.procurement_items (org_id, job_id, status);
create index if not exists pm_procurement_expected_idx on pm.procurement_items (org_id, expected_on)
  where status in ('ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED');
create unique index if not exists pm_procurement_option_uidx on pm.procurement_items (org_id, option_id)
  where option_id is not null and status <> 'CANCELLED';

-- ----------------------------------------------------------------------------
-- 4. Flooring measures (takeoff)
-- ----------------------------------------------------------------------------
create table if not exists pm.measures (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                   uuid not null,
  work_order_id            uuid,                         -- the MEASURE appointment
  version                  int not null default 1 check (version >= 1),
  measured_on              date not null default current_date,
  measured_by_employee_id  uuid references core.employees(id),
  source                   text not null default 'MANUAL' check (source in ('MANUAL','MEASURESQUARE','RFMS','QFLOORS','IMPORT')),
  source_ref               text,
  status                   text not null default 'DRAFT' check (status in ('DRAFT','FINAL','SUPERSEDED')),
  finalized_at             timestamptz,
  notes                    text,
  created_by               text default pm.current_user_id(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, id),
  unique (org_id, job_id, version),
  check (status = 'DRAFT' or finalized_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate
);
create unique index if not exists pm_measures_final_uidx on pm.measures (org_id, job_id) where status = 'FINAL';

create table if not exists pm.measure_areas (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  measure_id            uuid not null,
  job_id                uuid not null,
  wbs_id                uuid,
  selection_id          uuid,
  room_name             text not null check (char_length(room_name) between 1 and 120),
  area_kind             text not null default 'FLOOR' check (area_kind in ('FLOOR','STAIRS','WALL','BASE','TRANSITION','OTHER')),
  product_category      text check (product_category is null or product_category in
                          ('CARPET','LVP','HARDWOOD','LAMINATE','TILE','VINYL_SHEET','RUBBER','OTHER')),
  length_ft             numeric(10,2) check (length_ft is null or length_ft > 0),
  width_ft              numeric(10,2) check (width_ft is null or width_ft > 0),
  sqft                  numeric(12,2) check (sqft is null or sqft >= 0),
  linear_ft             numeric(12,2) check (linear_ft is null or linear_ft >= 0),
  each_count            numeric(10,2) check (each_count is null or each_count >= 0),
  waste_pct             numeric(5,4) not null default 0.10 check (waste_pct >= 0 and waste_pct <= 1),
  material_uom          text not null default 'SF' check (material_uom in ('SF','SY','LF','EA','BOX')),
  coverage_sf_per_unit  numeric(10,4) check (coverage_sf_per_unit is null or coverage_sf_per_unit > 0),
  material_qty          numeric(14,2) generated always as (
                          case material_uom
                            when 'SF'  then ceil(coalesce(sqft, 0) * (1 + waste_pct))
                            when 'SY'  then ceil(coalesce(sqft, 0) * (1 + waste_pct) / 9.0)
                            when 'BOX' then ceil(coalesce(sqft, 0) * (1 + waste_pct) / coverage_sf_per_unit)
                            when 'LF'  then ceil(coalesce(linear_ft, 0) * (1 + waste_pct))
                            when 'EA'  then ceil(coalesce(each_count, 0) * (1 + waste_pct))
                          end) stored,
  sort                  int not null default 0,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  check (material_uom <> 'BOX' or coverage_sf_per_unit is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, measure_id) references pm.measures (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, selection_id) references pm.selections (org_id, job_id, id) deferrable initially immediate
);
create index if not exists pm_measure_areas_measure_idx on pm.measure_areas (org_id, measure_id, sort);

-- ----------------------------------------------------------------------------
-- 5. Trigger functions (invoker: client locks need current_user = caller)
-- ----------------------------------------------------------------------------
create or replace function pm.tg_selection_lock() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated','anon') and old.status in ('APPROVED','VOID')
     and (new.allowance_cents is distinct from old.allowance_cents
          or new.chosen_price_book_item_id is distinct from old.chosen_price_book_item_id
          or new.category is distinct from old.category
          or new.job_id is distinct from old.job_id
          or new.allowance_id is distinct from old.allowance_id) then
    raise exception 'PM_SELECTION_LOCKED: an % selection keeps its allowance and choice (reopen through a change order)', lower(old.status)
      using errcode = '55000';
  end if;
  return new;
end $$;

-- Options: locked once the selection is decided; defaults from the price book; sell from cost × (1 + markup).
create or replace function pm.tg_selection_option() returns trigger
language plpgsql
set search_path = pm, public
as $$
declare v_status text; pb pm.price_book_items%rowtype; v_org uuid; v_sel uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_sel := old.selection_id; else v_org := new.org_id; v_sel := new.selection_id; end if;
  select s.status into v_status from pm.selections s where s.org_id = v_org and s.id = v_sel;
  if current_user in ('authenticated','anon') and v_status in ('APPROVED','VOID') then
    raise exception 'PM_SELECTION_LOCKED: options of an % selection cannot change', lower(v_status) using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.price_book_item_id is not null and (tg_op = 'INSERT' or new.price_book_item_id is distinct from old.price_book_item_id) then
    select * into pb from pm.price_book_items p where p.id = new.price_book_item_id and p.org_id = new.org_id;
    if not found then raise exception 'PM_PRICE_BOOK_SCOPE: price book item is not in this organization' using errcode = '23514'; end if;
    new.description      := coalesce(new.description, pb.name);
    new.uom              := coalesce(nullif(new.uom, 'EA'), pb.unit, 'EA');
    new.unit_price_cents := coalesce(new.unit_price_cents, pb.price_cents);
    new.unit_cost_cents  := coalesce(new.unit_cost_cents, pb.cost_cents);
    new.item_id          := coalesce(new.item_id, pb.item_id);
  end if;
  if new.unit_price_cents is null and new.unit_cost_cents is not null and new.markup_pct is not null then
    new.unit_price_cents := round(new.unit_cost_cents * (1 + new.markup_pct));
  end if;
  return new;
end $$;

create or replace function pm.tg_procurement_item() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if tg_op = 'UPDATE' and current_user in ('authenticated','anon') and old.status not in ('SPECIFIED','PROPOSED')
     and (new.qty is distinct from old.qty or new.unit_cost_cents is distinct from old.unit_cost_cents
          or new.markup_pct is distinct from old.markup_pct or new.unit_sell_cents is distinct from old.unit_sell_cents
          or new.freight_cents is distinct from old.freight_cents or new.selection_id is distinct from old.selection_id
          or new.option_id is distinct from old.option_id) then
    raise exception 'PM_ITEM_PRICE_LOCKED: pricing is pinned once the client approved the item' using errcode = '55000';
  end if;
  if new.unit_sell_cents is null and new.unit_cost_cents is not null and new.markup_pct is not null then
    new.unit_sell_cents := round(new.unit_cost_cents * (1 + new.markup_pct));
  end if;
  return new;
end $$;

create or replace function pm.tg_measure() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if tg_op = 'INSERT' then
    new.version := coalesce((select max(m.version) from pm.measures m where m.org_id = new.org_id and m.job_id = new.job_id), 0) + 1;
    return new;
  end if;
  if current_user in ('authenticated','anon') and old.status <> 'DRAFT'
     and (new.measured_on is distinct from old.measured_on or new.source is distinct from old.source
          or new.work_order_id is distinct from old.work_order_id) then
    raise exception 'PM_MEASURE_LOCKED: measure v% is %', old.version, old.status using errcode = '55000';
  end if;
  return new;
end $$;

create or replace function pm.tg_measure_area() returns trigger
language plpgsql
set search_path = pm, public
as $$
declare v_status text; v_org uuid; v_m uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_m := old.measure_id; else v_org := new.org_id; v_m := new.measure_id; end if;
  select m.status into v_status from pm.measures m where m.org_id = v_org and m.id = v_m;
  if current_user in ('authenticated','anon') and v_status in ('FINAL','SUPERSEDED') then
    raise exception 'PM_MEASURE_LOCKED: the measure is % (start a new version)', lower(v_status) using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.job_id is null then
    select m.job_id into new.job_id from pm.measures m where m.org_id = new.org_id and m.id = new.measure_id;
  end if;
  if new.sqft is null and new.length_ft is not null and new.width_ft is not null then
    new.sqft := round(new.length_ft * new.width_ft, 2);
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['selections','selection_options','procurement_items','measures','measure_areas'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['selections','selection_options','procurement_items','measures'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
end $$;
-- client_approvals: written only by definer functions (recorded_by = the caller); members cannot insert.

create or replace trigger trg_selection_lock before update on pm.selections
  for each row execute function pm.tg_selection_lock();
create or replace trigger trg_validate_ext before insert or update of ext on pm.selections
  for each row execute function pm.tg_validate_ext('selection');
create or replace trigger trg_selection_option before insert or update or delete on pm.selection_options
  for each row execute function pm.tg_selection_option();
create or replace trigger trg_refs_in_org before insert or update on pm.selection_options
  for each row execute function pm.tg_refs_in_org('vendor_id:core.vendors', 'item_id:core.items');
create or replace trigger trg_refs_in_org before insert or update on pm.client_approvals
  for each row execute function pm.tg_refs_in_org('approver_customer_id:core.customers', 'signature_document_id:public.documents');
create or replace trigger trg_procurement_item before insert or update on pm.procurement_items
  for each row execute function pm.tg_procurement_item();
create or replace trigger trg_refs_in_org before insert or update on pm.procurement_items
  for each row execute function pm.tg_refs_in_org('vendor_id:core.vendors');
create or replace trigger trg_measure before insert or update on pm.measures
  for each row execute function pm.tg_measure();
create or replace trigger trg_refs_in_org before insert or update on pm.measures
  for each row execute function pm.tg_refs_in_org('measured_by_employee_id:core.employees');
create or replace trigger trg_measure_area before insert or update or delete on pm.measure_areas
  for each row execute function pm.tg_measure_area();

-- ----------------------------------------------------------------------------
-- 6. Guard (replaces the 1100 placeholder): every non-void selection on the job is approved
-- ----------------------------------------------------------------------------
create or replace function pm.guard_selections_approved(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select not exists (select 1 from pm.selections s where s.job_id = p_job and s.status not in ('APPROVED','VOID'))
$$;

-- ----------------------------------------------------------------------------
-- 7. Functions (definer; org guard first)
-- ----------------------------------------------------------------------------
create or replace function pm.propose_selection(p_selection uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.selections%rowtype; v_loc uuid;
begin
  select * into s from pm.selections x where x.id = p_selection for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: selection % not found in the caller''s organization', p_selection using errcode = '42501';
  end if;
  if s.status not in ('OPEN','REJECTED','PROPOSED') then
    raise exception 'PM_SELECTION_TRANSITION_INVALID: selection is %', s.status using errcode = '22023';
  end if;
  if s.chosen_price_book_item_id is null
     and not exists (select 1 from pm.selection_options o where o.org_id = s.org_id and o.selection_id = s.id) then
    raise exception 'PM_SELECTION_NO_CHOICE: add at least one option before sending it to the client' using errcode = '22023';
  end if;
  update pm.selections set status = 'PROPOSED', proposed_at = now(), proposed_by = pm.current_user_id() where id = p_selection;
  select j.location_id into v_loc from core.jobs j where j.org_id = s.org_id and j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'selection.proposed', 'selections', p_selection,
    format('Sent %s: %s to the client', s.category, s.title), jsonb_build_object('from', s.status));
  return p_selection;
end $$;

-- Client approval: records who approved, how and when; pins chosen total and the allowance variance.
-- Returns the pm.client_approvals id.
create or replace function pm.approve_selection(
  p_selection           uuid,
  p_option              uuid    default null,
  p_approver_name       text    default null,
  p_method              text    default 'IN_PERSON',
  p_approver_email      text    default null,
  p_comment             text    default null,
  p_signature_document  uuid    default null,
  p_approver_customer   uuid    default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  s          pm.selections%rowtype;
  o          pm.selection_options%rowtype;
  pb         pm.price_book_items%rowtype;
  v_loc      uuid;
  v_total    bigint;
  v_allow    bigint;
  v_var      bigint;
  v_appr     uuid;
  v_snapshot jsonb;
  n          int;
begin
  select * into s from pm.selections x where x.id = p_selection for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: selection % not found in the caller''s organization', p_selection using errcode = '42501';
  end if;
  if s.status not in ('OPEN','PROPOSED','REJECTED') then
    raise exception 'PM_SELECTION_TRANSITION_INVALID: selection is %', s.status using errcode = '22023';
  end if;
  if p_approver_name is null or btrim(p_approver_name) = '' then
    raise exception 'PM_INVALID: the client approver''s name is required' using errcode = '22023';
  end if;

  if p_option is not null then
    select * into o from pm.selection_options x where x.org_id = s.org_id and x.selection_id = s.id and x.id = p_option;
    if not found then raise exception 'PM_INVALID: option % is not on this selection', p_option using errcode = '22023'; end if;
  else
    select count(*) into n from pm.selection_options x where x.org_id = s.org_id and x.selection_id = s.id;
    if n = 1 then
      select * into o from pm.selection_options x where x.org_id = s.org_id and x.selection_id = s.id;
    elsif n > 1 then
      raise exception 'PM_SELECTION_AMBIGUOUS: % options — say which one the client chose', n using errcode = '22023';
    end if;
  end if;

  if o.id is not null then
    v_total := o.amount_cents;
    v_snapshot := jsonb_build_object('option_id', o.id, 'label', o.label, 'qty', o.qty, 'uom', o.uom,
                                     'unit_price_cents', o.unit_price_cents, 'amount_cents', o.amount_cents,
                                     'vendor_id', o.vendor_id, 'vendor_sku', o.vendor_sku);
  elsif s.chosen_price_book_item_id is not null then
    select * into pb from pm.price_book_items x where x.org_id = s.org_id and x.id = s.chosen_price_book_item_id;
    if not found then raise exception 'PM_PRICE_BOOK_SCOPE: chosen price book item is not in this organization' using errcode = '23514'; end if;
    v_total := pb.price_cents;
    v_snapshot := jsonb_build_object('price_book_item_id', pb.id, 'code', pb.code, 'label', pb.name, 'amount_cents', pb.price_cents);
  else
    raise exception 'PM_SELECTION_NO_CHOICE: nothing to approve (add an option or choose a price book item)' using errcode = '22023';
  end if;

  v_allow := coalesce(s.allowance_cents,
                      case when jsonb_typeof(s.ext -> 'allowance_cents') = 'number' then (s.ext ->> 'allowance_cents')::bigint end);
  v_var := case when v_allow is not null then v_total - v_allow end;
  v_snapshot := v_snapshot || jsonb_build_object('category', s.category, 'title', s.title, 'allowance_cents', v_allow,
                                                 'variance_cents', v_var, 'due_on', s.due_on);

  insert into pm.client_approvals (org_id, job_id, subject_table, subject_id, decision, approver_name, approver_email,
                                   approver_customer_id, method, signature_document_id, amount_cents, snapshot, comment, recorded_by)
  values (s.org_id, s.job_id, 'selections', s.id, 'APPROVED', btrim(p_approver_name), p_approver_email, p_approver_customer,
          coalesce(p_method, 'IN_PERSON'), p_signature_document, v_total, v_snapshot, p_comment, pm.current_user_id())
  returning id into v_appr;

  update pm.selections
     set status = 'APPROVED', chosen_option_id = o.id, chosen_total_cents = v_total, allowance_applied_cents = v_allow,
         variance_cents = v_var, approved_at = now(), approved_by_name = btrim(p_approver_name), client_approval_id = v_appr,
         proposed_at = coalesce(proposed_at, now())
   where id = p_selection;

  select j.location_id into v_loc from core.jobs j where j.org_id = s.org_id and j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'selection.approved', 'selections', p_selection,
    format('%s approved %s: %s%s', btrim(p_approver_name), s.category, s.title,
           case when v_var is null then '' when v_var > 0 then format(' (%s cents over allowance)', v_var)
                when v_var < 0 then format(' (%s cents under allowance)', -v_var) else ' (at allowance)' end),
    jsonb_build_object('client_approval_id', v_appr, 'chosen_total_cents', v_total, 'allowance_cents', v_allow,
                       'variance_cents', v_var, 'option_id', o.id, 'on_time', s.due_on is null or current_date <= s.due_on));
  return v_appr;
end $$;

create or replace function pm.reject_selection(p_selection uuid, p_approver_name text, p_comment text default null,
                                               p_method text default 'IN_PERSON')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.selections%rowtype; v_appr uuid; v_loc uuid;
begin
  select * into s from pm.selections x where x.id = p_selection for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: selection % not found in the caller''s organization', p_selection using errcode = '42501';
  end if;
  if s.status <> 'PROPOSED' then raise exception 'PM_SELECTION_TRANSITION_INVALID: selection is %', s.status using errcode = '22023'; end if;
  if p_approver_name is null or btrim(p_approver_name) = '' then
    raise exception 'PM_INVALID: the client''s name is required' using errcode = '22023';
  end if;
  insert into pm.client_approvals (org_id, job_id, subject_table, subject_id, decision, approver_name, method, comment, snapshot, recorded_by)
  values (s.org_id, s.job_id, 'selections', s.id, 'REJECTED', btrim(p_approver_name), coalesce(p_method, 'IN_PERSON'), p_comment,
          jsonb_build_object('category', s.category, 'title', s.title), pm.current_user_id())
  returning id into v_appr;
  update pm.selections set status = 'REJECTED', rejected_at = now() where id = p_selection;
  select j.location_id into v_loc from core.jobs j where j.org_id = s.org_id and j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'selection.rejected', 'selections', p_selection,
    format('%s declined %s: %s', btrim(p_approver_name), s.category, s.title), jsonb_build_object('client_approval_id', v_appr));
  return v_appr;
end $$;

create or replace function pm.void_selection(p_selection uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.selections%rowtype; v_loc uuid;
begin
  select * into s from pm.selections x where x.id = p_selection for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: selection % not found in the caller''s organization', p_selection using errcode = '42501';
  end if;
  if s.status in ('APPROVED','VOID') then
    raise exception 'PM_SELECTION_TRANSITION_INVALID: selection is % (an approved selection changes through a change order)', s.status
      using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'PM_INVALID: a reason is required' using errcode = '22023'; end if;
  update pm.selections set status = 'VOID', voided_at = now(), void_reason = btrim(p_reason) where id = p_selection;
  select j.location_id into v_loc from core.jobs j where j.org_id = s.org_id and j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'selection.voided', 'selections', p_selection,
    format('Voided %s: %s', s.category, s.title), jsonb_build_object('reason', btrim(p_reason), 'from', s.status));
  return p_selection;
end $$;

-- Approved selection → procurement item(s) pinned to the chosen option (status APPROVED; the
-- client approval carries over). Idempotent per option.
create or replace function pm.create_procurement_from_selection(p_selection uuid, p_vendor uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.selections%rowtype; o pm.selection_options%rowtype; v_id uuid; v_loc uuid;
begin
  select * into s from pm.selections x where x.id = p_selection for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: selection % not found in the caller''s organization', p_selection using errcode = '42501';
  end if;
  if s.status <> 'APPROVED' or s.chosen_option_id is null then
    raise exception 'PM_SELECTION_NOT_APPROVED: approve an option first' using errcode = '22023';
  end if;
  select i.id into v_id from pm.procurement_items i
  where i.org_id = s.org_id and i.option_id = s.chosen_option_id and i.status <> 'CANCELLED';
  if v_id is not null then return v_id; end if;
  select * into o from pm.selection_options x where x.org_id = s.org_id and x.id = s.chosen_option_id;
  insert into pm.procurement_items (org_id, job_id, selection_id, option_id, wbs_id, vendor_id, description, vendor_sku,
         sidemark, qty, uom, unit_cost_cents, markup_pct, unit_sell_cents, freight_cents, status, proposed_at, approved_at,
         approved_by_name, client_approval_id, created_by)
  values (s.org_id, s.job_id, s.id, o.id, s.wbs_id, coalesce(p_vendor, o.vendor_id), coalesce(o.description, o.label),
          coalesce(o.vendor_sku, s.ext ->> 'vendor_sku'), s.ext ->> 'sidemark', o.qty, o.uom, o.unit_cost_cents, o.markup_pct,
          o.unit_price_cents, o.freight_cents, 'APPROVED', s.proposed_at, s.approved_at, s.approved_by_name,
          s.client_approval_id, pm.current_user_id())
  returning id into v_id;
  select j.location_id into v_loc from core.jobs j where j.org_id = s.org_id and j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'procurement.created', 'procurement_items', v_id,
    format('Procurement item for %s: %s', s.category, coalesce(o.description, o.label)), jsonb_build_object('selection_id', s.id));
  return v_id;
end $$;

-- Procurement lifecycle. p_attrs carries the facts of the step:
--   APPROVED: approver_name (required unless the linked selection is approved), method, email
--   ORDERED: po_number, commitment_id, commitment_line_id, expected_on
--   ACKNOWLEDGED / BACK_ORDERED: expected_on      SHIPPED: tracking_ref, expected_on
--   RECEIVED: received_qty, received_condition, storage_location_id    STORED: storage_location_id
--   DELIVERED / INSTALLED: (dates from p_on)       DAMAGED / RETURNED / CANCELLED: note
create or replace function pm.advance_procurement_item(p_item uuid, p_to text, p_on date default null, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  i      pm.procurement_items%rowtype;
  s      pm.selections%rowtype;
  ok     boolean;
  v_on   date := coalesce(p_on, current_date);
  a      jsonb := coalesce(p_attrs, '{}');
  v_appr uuid;
  v_name text;
  v_loc  uuid;
  v_stock uuid;
begin
  select * into i from pm.procurement_items x where x.id = p_item for update;
  if i.org_id is null or i.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: procurement item % not found in the caller''s organization', p_item using errcode = '42501';
  end if;
  ok := case i.status
          when 'SPECIFIED'    then p_to in ('PROPOSED','CANCELLED')
          when 'PROPOSED'     then p_to in ('APPROVED','SPECIFIED','CANCELLED')
          when 'APPROVED'     then p_to in ('ORDERED','CANCELLED')
          when 'ORDERED'      then p_to in ('ACKNOWLEDGED','BACK_ORDERED','SHIPPED','RECEIVED','CANCELLED')
          when 'ACKNOWLEDGED' then p_to in ('BACK_ORDERED','SHIPPED','RECEIVED','CANCELLED')
          when 'BACK_ORDERED' then p_to in ('ACKNOWLEDGED','SHIPPED','RECEIVED','CANCELLED')
          when 'SHIPPED'      then p_to in ('RECEIVED','DAMAGED')
          when 'RECEIVED'     then p_to in ('STORED','DELIVERED','INSTALLED','DAMAGED')
          when 'DAMAGED'      then p_to in ('ORDERED','RECEIVED','RETURNED','CANCELLED')
          when 'STORED'       then p_to in ('DELIVERED','INSTALLED')
          when 'DELIVERED'    then p_to in ('INSTALLED','RETURNED')
          when 'INSTALLED'    then p_to = 'RETURNED'
          else false end;
  if not ok then raise exception 'PM_ITEM_TRANSITION_INVALID: % -> %', i.status, p_to using errcode = '22023'; end if;

  if p_to = 'PROPOSED' and i.unit_sell_cents is null then
    raise exception 'PM_INVALID: price the item (sell or cost + markup) before proposing it' using errcode = '22023';
  end if;
  if p_to = 'APPROVED' then
    if i.selection_id is not null then
      select * into s from pm.selections x where x.org_id = i.org_id and x.id = i.selection_id;
    end if;
    if s.status = 'APPROVED' and (i.option_id is null or i.option_id = s.chosen_option_id) then
      v_appr := s.client_approval_id; v_name := s.approved_by_name;
    else
      v_name := nullif(btrim(coalesce(a ->> 'approver_name', '')), '');
      if v_name is null then raise exception 'PM_INVALID: the client approver''s name is required' using errcode = '22023'; end if;
      insert into pm.client_approvals (org_id, job_id, subject_table, subject_id, decision, approver_name, approver_email,
                                       method, amount_cents, snapshot, recorded_by)
      values (i.org_id, i.job_id, 'procurement_items', i.id, 'APPROVED', v_name, a ->> 'approver_email',
              coalesce(a ->> 'method', 'IN_PERSON'), i.sell_total_cents,
              jsonb_build_object('description', i.description, 'qty', i.qty, 'uom', i.uom, 'unit_sell_cents', i.unit_sell_cents,
                                 'sell_total_cents', i.sell_total_cents, 'vendor_id', i.vendor_id, 'sidemark', i.sidemark),
              pm.current_user_id())
      returning id into v_appr;
    end if;
  end if;
  if (a ? 'storage_location_id') then
    v_stock := nullif(a ->> 'storage_location_id', '')::uuid;
    if v_stock is not null and not exists (select 1 from pm.stock_locations x where x.org_id = i.org_id and x.id = v_stock) then
      raise exception 'PM_FORBIDDEN: stock location % not found in the caller''s organization', v_stock using errcode = '42501';
    end if;
  end if;

  update pm.procurement_items
     set status              = p_to,
         proposed_at         = case when p_to = 'PROPOSED' then now() else proposed_at end,
         approved_at         = case when p_to = 'APPROVED' then now() else approved_at end,
         approved_by_name    = case when p_to = 'APPROVED' then v_name else approved_by_name end,
         client_approval_id  = case when p_to = 'APPROVED' then v_appr else client_approval_id end,
         po_number           = coalesce(case when p_to = 'ORDERED' then a ->> 'po_number' end, po_number),
         commitment_id       = coalesce(case when p_to = 'ORDERED' then nullif(a ->> 'commitment_id', '')::uuid end, commitment_id),
         commitment_line_id  = coalesce(case when p_to = 'ORDERED' then nullif(a ->> 'commitment_line_id', '')::uuid end, commitment_line_id),
         ordered_on          = case when p_to = 'ORDERED' then v_on else ordered_on end,
         acknowledged_on     = case when p_to = 'ACKNOWLEDGED' then v_on else acknowledged_on end,
         expected_on         = coalesce(nullif(a ->> 'expected_on', '')::date, expected_on),
         shipped_on          = case when p_to = 'SHIPPED' then v_on else shipped_on end,
         tracking_ref        = coalesce(case when p_to = 'SHIPPED' then a ->> 'tracking_ref' end, tracking_ref),
         received_on         = case when p_to = 'RECEIVED' then v_on else received_on end,
         received_qty        = case when p_to = 'RECEIVED' then coalesce(nullif(a ->> 'received_qty', '')::numeric, qty) else received_qty end,
         received_condition  = case when p_to = 'RECEIVED' then coalesce(a ->> 'received_condition', 'GOOD')
                                    when p_to = 'DAMAGED' then 'DAMAGED' else received_condition end,
         storage_location_id = case when a ? 'storage_location_id' then v_stock else storage_location_id end,
         stored_since        = case when p_to = 'STORED' then v_on else stored_since end,
         delivered_on        = case when p_to = 'DELIVERED' then v_on else delivered_on end,
         installed_on        = case when p_to = 'INSTALLED' then v_on else installed_on end,
         cancelled_at        = case when p_to = 'CANCELLED' then now() else cancelled_at end,
         notes               = coalesce(a ->> 'note', notes)
   where id = p_item;

  select j.location_id into v_loc from core.jobs j where j.org_id = i.org_id and j.id = i.job_id;
  perform pm.log_activity(i.org_id, v_loc, i.job_id, 'procurement.' || lower(p_to), 'procurement_items', p_item,
    format('%s → %s', i.description, lower(replace(p_to, '_', ' '))), jsonb_build_object('from', i.status, 'to', p_to, 'on', v_on) || a);
  return p_item;
end $$;

-- Freeze a takeoff version; the previous FINAL version (if any) becomes SUPERSEDED.
create or replace function pm.finalize_measure(p_measure uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.measures%rowtype; v_loc uuid; v_sf numeric;
begin
  select * into m from pm.measures x where x.id = p_measure for update;
  if m.org_id is null or m.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: measure % not found in the caller''s organization', p_measure using errcode = '42501';
  end if;
  if m.status <> 'DRAFT' then raise exception 'PM_MEASURE_TRANSITION_INVALID: measure v% is %', m.version, m.status using errcode = '22023'; end if;
  if not exists (select 1 from pm.measure_areas a where a.org_id = m.org_id and a.measure_id = m.id) then
    raise exception 'PM_INVALID: a measure needs at least one area' using errcode = '22023';
  end if;
  update pm.measures set status = 'SUPERSEDED' where org_id = m.org_id and job_id = m.job_id and status = 'FINAL';
  update pm.measures set status = 'FINAL', finalized_at = now() where id = p_measure;
  select sum(a.sqft) into v_sf from pm.measure_areas a where a.org_id = m.org_id and a.measure_id = m.id;
  select j.location_id into v_loc from core.jobs j where j.org_id = m.org_id and j.id = m.job_id;
  perform pm.log_activity(m.org_id, v_loc, m.job_id, 'measure.finalized', 'measures', p_measure,
    format('Measure v%s final (%s sq ft)', m.version, coalesce(v_sf, 0)), jsonb_build_object('version', m.version, 'sqft', v_sf));
  return p_measure;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Views (security_invoker)
-- ----------------------------------------------------------------------------
create or replace view pm.v_selection_status with (security_invoker = on) as
select s.org_id, j.location_id, s.job_id, s.id as selection_id, s.category, s.title, s.wbs_id, s.status, s.due_on,
       coalesce(s.allowance_cents,
                case when jsonb_typeof(s.ext -> 'allowance_cents') = 'number' then (s.ext ->> 'allowance_cents')::bigint end) as allowance_cents,
       s.chosen_total_cents, s.variance_cents, s.approved_at, s.approved_by_name, s.proposed_at,
       coalesce(o.option_count, 0)::int as option_count, o.low_cents, o.high_cents,
       (s.status not in ('APPROVED','VOID') and s.due_on < current_date) as is_overdue,
       (s.status = 'APPROVED' and s.due_on is not null and s.approved_at::date > s.due_on) as approved_late
from pm.selections s
join core.jobs j on j.org_id = s.org_id and j.id = s.job_id
left join lateral (
  select count(*) as option_count, min(x.amount_cents) as low_cents, max(x.amount_cents) as high_cents
  from pm.selection_options x where x.org_id = s.org_id and x.selection_id = s.id
) o on true;

create or replace view pm.v_job_selections with (security_invoker = on) as
select org_id, location_id, job_id,
       count(*) filter (where status <> 'VOID')::int                       as selections,
       count(*) filter (where status = 'APPROVED')::int                    as approved,
       count(*) filter (where status in ('OPEN','PROPOSED','REJECTED'))::int as open,
       count(*) filter (where is_overdue)::int                             as overdue,
       coalesce(sum(allowance_cents) filter (where status <> 'VOID'), 0)::bigint as allowance_cents,
       coalesce(sum(variance_cents) filter (where status = 'APPROVED'), 0)::bigint as approved_variance_cents,
       min(due_on) filter (where status in ('OPEN','PROPOSED','REJECTED')) as next_due_on
from pm.v_selection_status
group by org_id, location_id, job_id;

create or replace view pm.v_procurement_status with (security_invoker = on) as
select i.org_id, j.location_id, i.job_id, i.id as item_id, i.description, i.vendor_id, i.sidemark, i.status,
       i.qty, i.uom, i.unit_cost_cents, i.markup_pct, i.unit_sell_cents, i.freight_cents, i.cost_total_cents, i.sell_total_cents,
       (i.sell_total_cents - i.cost_total_cents) as margin_cents,
       case when i.sell_total_cents > 0 then round((i.sell_total_cents - i.cost_total_cents)::numeric / i.sell_total_cents, 4) end as margin_pct,
       i.po_number, i.commitment_id, i.expected_on, i.received_on, i.storage_location_id, i.install_on, i.delivered_on, i.installed_on,
       (i.status in ('ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED') and i.expected_on < current_date) as is_overdue,
       case when i.status = 'STORED' then current_date - i.stored_since end as days_in_storage
from pm.procurement_items i
join core.jobs j on j.org_id = i.org_id and j.id = i.job_id;

-- Latest FINAL takeoff per job, by product category and unit.
create or replace view pm.v_measure_totals with (security_invoker = on) as
select m.org_id, j.location_id, m.job_id, m.id as measure_id, m.version, a.product_category, a.material_uom,
       count(*)::int as areas, sum(a.sqft)::numeric(14,2) as sqft, sum(a.linear_ft)::numeric(14,2) as linear_ft,
       sum(a.material_qty)::numeric(14,2) as material_qty
from pm.measures m
join core.jobs j on j.org_id = m.org_id and j.id = m.job_id
join pm.measure_areas a on a.org_id = m.org_id and a.measure_id = m.id
where m.status = 'FINAL'
group by m.org_id, j.location_id, m.job_id, m.id, m.version, a.product_category, a.material_uom;

-- ---------------------------------------------------------------------------
-- KPIs. Window: trailing 90 days unless noted.
--   selections_on_time_pct   selections (not VOID) due in the trailing 90d: approved on/before due date ÷ due
--   proposal_approval_days   median days proposed_at → approved_at over selections and procurement items approved in 90d
--   items_overdue_count      procurement items ORDERED/ACKNOWLEDGED/BACK_ORDERED/SHIPPED whose expected date passed (point in time)
--   product_margin_pct       (Σ sell − Σ cost incl. freight) ÷ Σ sell on items delivered or installed in 90d
--   installer_sqft_per_day   Σ FINAL-takeoff FLOOR/STAIRS sq ft of jobs whose INSTALL work orders all completed in 90d
--                            ÷ distinct (installer or sub crew, day) with a DONE assignment on those install WOs
--   waste_variance_pct       Σ net material issued to the job (ISSUE − RETURN − REMNANT from job, same unit as the takeoff)
--                            ÷ Σ takeoff material qty (incl. planned waste) − 1, same job set
-- ---------------------------------------------------------------------------
create or replace view pm.v_kpis_selections with (security_invoker = on) as
with installs as (
  select w.org_id, w.location_id, w.job_id
  from pm.work_orders w
  where w.kind = 'INSTALL'
  group by w.org_id, w.location_id, w.job_id
  having bool_and(w.status in ('COMPLETE','CLOSED','CANCELLED')) and max(w.completed_at) >= now() - interval '90 days'
),
takeoff as (
  select a.org_id, a.job_id, upper(a.material_uom) as uom,
         sum(a.sqft) filter (where a.area_kind in ('FLOOR','STAIRS')) as sqft, sum(a.material_qty) as est_qty
  from pm.measure_areas a join pm.measures m on m.org_id = a.org_id and m.id = a.measure_id and m.status = 'FINAL'
  group by a.org_id, a.job_id, upper(a.material_uom)
),
crew_days as (
  select i.org_id, i.location_id, count(distinct (i.job_id, coalesce(d.employee_id, d.crew_id), (lower(d.slot))::date)) as days
  from installs i
  join pm.work_orders w on w.org_id = i.org_id and w.job_id = i.job_id and w.kind = 'INSTALL'
  join pm.dispatch_assignments d on d.org_id = w.org_id and d.work_order_id = w.id and d.status = 'DONE'
  group by i.org_id, i.location_id
),
waste as (
  select i.org_id, i.location_id, i.job_id, t.uom, t.est_qty,
         coalesce((select sum(case m.kind when 'ISSUE' then m.qty when 'RETURN' then -m.qty
                                         when 'REMNANT' then case when m.from_stock_location_id is null then -m.qty else 0 end
                                         else 0 end)
                   from pm.material_moves m
                   where m.org_id = i.org_id and m.job_id = i.job_id and upper(m.uom) = t.uom), 0) as used_qty
  from installs i join takeoff t on t.org_id = i.org_id and t.job_id = i.job_id
),
approvals as (
  select s.org_id, j.location_id, extract(epoch from (s.approved_at - s.proposed_at)) / 86400 as days
  from pm.selections s join core.jobs j on j.org_id = s.org_id and j.id = s.job_id
  where s.status = 'APPROVED' and s.proposed_at is not null and s.approved_at >= now() - interval '90 days'
  union all
  select p.org_id, j.location_id, extract(epoch from (p.approved_at - p.proposed_at)) / 86400
  from pm.procurement_items p join core.jobs j on j.org_id = p.org_id and j.id = p.job_id
  where p.approved_at is not null and p.proposed_at is not null and p.approved_at >= now() - interval '90 days'
    and p.client_approval_id is not null and p.selection_id is null
)
select s.org_id, j.location_id, null::uuid as job_id, 'selections_on_time_pct'::text as metric,
       round(count(*) filter (where s.status = 'APPROVED' and s.approved_at::date <= s.due_on)::numeric / count(*), 4) as value,
       current_date as as_of, 'selections: due in trailing 90d (not void)'::text as basis, count(*)::int as sample_n
from pm.selections s join core.jobs j on j.org_id = s.org_id and j.id = s.job_id
where s.status <> 'VOID' and s.due_on between current_date - 90 and current_date
group by s.org_id, j.location_id
union all
select org_id, location_id, null, 'proposal_approval_days',
       round((percentile_cont(0.5) within group (order by days))::numeric, 2), current_date,
       'selections + procurement items approved in 90d', count(*)::int
from approvals group by org_id, location_id
union all
select p.org_id, j.location_id, null, 'items_overdue_count',
       count(*) filter (where p.status in ('ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED') and p.expected_on < current_date)::numeric,
       current_date, 'procurement_items: on order past expected date', count(*)::int
from pm.procurement_items p join core.jobs j on j.org_id = p.org_id and j.id = p.job_id
where p.status <> 'CANCELLED'
group by p.org_id, j.location_id
union all
select p.org_id, j.location_id, null, 'product_margin_pct',
       round((sum(p.sell_total_cents) - sum(p.cost_total_cents))::numeric / sum(p.sell_total_cents), 4), current_date,
       'procurement_items: delivered/installed in 90d (cost incl. freight estimate)', count(*)::int
from pm.procurement_items p join core.jobs j on j.org_id = p.org_id and j.id = p.job_id
where p.status in ('DELIVERED','INSTALLED') and coalesce(p.installed_on, p.delivered_on) >= current_date - 90
group by p.org_id, j.location_id
having sum(p.sell_total_cents) > 0
union all
select i.org_id, i.location_id, null, 'installer_sqft_per_day',
       round(sum(t.sqft) / cd.days, 1), current_date,
       'FINAL takeoff sq ft ÷ installer crew days on installs completed in 90d', cd.days::int
from installs i
join (select org_id, job_id, sum(sqft) as sqft from takeoff group by org_id, job_id) t on t.org_id = i.org_id and t.job_id = i.job_id
join crew_days cd on cd.org_id = i.org_id and cd.location_id = i.location_id
where cd.days > 0
group by i.org_id, i.location_id, cd.days
having sum(t.sqft) > 0
union all
select org_id, location_id, null, 'waste_variance_pct',
       round(sum(used_qty) / sum(est_qty) - 1, 4), current_date,
       'material_moves (net to job) ÷ FINAL takeoff qty incl. waste, installs completed in 90d', count(distinct job_id)::int
from waste where used_qty > 0 and est_qty > 0
group by org_id, location_id;

-- ----------------------------------------------------------------------------
-- 9. RLS
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['selections','selection_options','client_approvals','procurement_items','measures','measure_areas'] loop
    execute format('alter table pm.%I enable row level security', t);
  end loop;
  foreach t in array array['selection_options','client_approvals','measure_areas'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='selections' and policyname='org_select') then
    create policy org_select on pm.selections for select using (org_id = public.get_org_id());
    create policy open_insert on pm.selections for insert
      with check (org_id = public.get_org_id() and status = 'OPEN' and approved_at is null and chosen_option_id is null
                  and chosen_total_cents is null and variance_cents is null and client_approval_id is null and proposed_at is null);
    create policy org_update on pm.selections for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy open_delete on pm.selections for delete using (org_id = public.get_org_id() and status = 'OPEN');
  end if;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='procurement_items' and policyname='org_select') then
    create policy org_select on pm.procurement_items for select using (org_id = public.get_org_id());
    create policy specified_insert on pm.procurement_items for insert
      with check (org_id = public.get_org_id() and status = 'SPECIFIED' and approved_at is null and client_approval_id is null
                  and proposed_at is null and ordered_on is null and received_on is null);
    create policy org_update on pm.procurement_items for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy specified_delete on pm.procurement_items for delete using (org_id = public.get_org_id() and status = 'SPECIFIED');
  end if;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='measures' and policyname='org_select') then
    create policy org_select on pm.measures for select using (org_id = public.get_org_id());
    create policy draft_insert on pm.measures for insert
      with check (org_id = public.get_org_id() and status = 'DRAFT' and finalized_at is null);
    create policy org_update on pm.measures for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy draft_delete on pm.measures for delete using (org_id = public.get_org_id() and status = 'DRAFT');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 10. Grants
-- ----------------------------------------------------------------------------
revoke all on pm.selections, pm.selection_options, pm.client_approvals, pm.procurement_items, pm.measures, pm.measure_areas
  from public, anon, authenticated;
grant select, insert, update, delete on pm.selections, pm.selection_options, pm.client_approvals, pm.procurement_items,
  pm.measures, pm.measure_areas to service_role;

grant select, insert, delete on pm.selections to authenticated;
grant update (wbs_id, category, title, description, allowance_cents, allowance_id, due_on, chosen_price_book_item_id, sort, ext)
  on pm.selections to authenticated;
grant select, insert, update, delete on pm.selection_options, pm.measure_areas to authenticated;
grant select on pm.client_approvals to authenticated;
grant select, insert, delete on pm.procurement_items to authenticated;
grant update (wbs_id, vendor_id, description, vendor_sku, sidemark, qty, uom, unit_cost_cents, markup_pct, unit_sell_cents,
              freight_cents, client_deposit_pct, expected_on, tracking_ref, install_on, notes)
  on pm.procurement_items to authenticated;
grant select, insert, delete on pm.measures to authenticated;
grant update (work_order_id, measured_on, measured_by_employee_id, source, source_ref, notes) on pm.measures to authenticated;

grant select on pm.v_selection_status, pm.v_job_selections, pm.v_procurement_status, pm.v_measure_totals, pm.v_kpis_selections
  to authenticated, service_role;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm' and p.proname in (
             'tg_selection_lock','tg_selection_option','tg_procurement_item','tg_measure','tg_measure_area',
             'guard_selections_approved','propose_selection','approve_selection','reject_selection','void_selection',
             'create_procurement_from_selection','advance_procurement_item','finalize_measure') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname not like 'tg\_%' then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1106_pm_selections
-- ============================================================================
