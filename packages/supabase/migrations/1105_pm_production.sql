-- ============================================================================
-- 1105 · Merit Projects v2 — engineer-to-order production
--
-- Binding inputs: blueprint D7/D10/D11/D12 + §6 (1104 production in the plan → this file),
-- review 05 §4.5 (work_centers, routings, routing_steps, wo_operations), research 04 §B
-- (Innergy / job-shop object model: WorkOrder ─< BOM ─< Routing ─< Operation @ WorkCenter),
-- pack manifest manufacturing_eto (eto_job / eto_order machines, production_complete guard,
-- KPIs on_time_delivery_pct, shop_backlog_weeks, labor_efficiency_pct, material_yield_pct, remake_rate_pct).
--
-- Decision: a production order IS a pm.work_orders row of kind PRODUCTION (number 'PRD-YYYY-NNNNN').
--   One object carries time links (time_entries.work_order_id/operation_id), material issues
--   (material_moves.work_order_id), the shared status vocabulary and the job guards. Production
--   columns are additive on pm.work_orders (routing_id, quantity, drawings approval, release stamps,
--   remake link). A job may hold several production orders (release per area/phase via wbs_id).
--
-- Lifecycle:  NEW (engineering; BOM + operations editable)
--               ── pm.release_to_shop (gated; returns failing gates, nothing changes on failure) ──▶
--             RELEASED (BOM + routing locked) ── start_operation ──▶ IN_PROGRESS
--               ── complete_operation × n (std vs actual minutes) ──▶ COMPLETE (auto when every op is done)
--             Release gates: drawings_approved · bom_present · operations_present ·
--                            selections_approved (job guard) · has_budget (job guard)
--
-- Boundaries: shop minutes are operational. Labor cost = time_entries → Books (JOB_TIME, D9);
-- material cost = Books (JOB_MATERIAL). Remake rate is therefore a shop-minutes proxy (documented).
-- Replaces the 1100 placeholder pm.guard_production_complete. Depends on 1104 only.
-- Idempotent: safe to run twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Work centers, routings, routing steps (company library)
-- ----------------------------------------------------------------------------
create table if not exists pm.work_centers (
  id                         uuid primary key default gen_random_uuid(),
  org_id                     uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id                uuid not null references core.locations(id),
  code                       text not null check (code ~ '^[a-z][a-z0-9_]{1,47}$'),
  name                       text not null check (char_length(name) between 1 and 80),
  kind                       text,                                 -- free label (cnc, edgebander, assembly, finishing …)
  capacity_minutes_per_week  int not null default 2400 check (capacity_minutes_per_week >= 0),
  rate_cents                 bigint check (rate_cents is null or rate_cents >= 0),  -- estimating rate per hour (operational)
  status                     text not null default 'ACTIVE' check (status in ('ACTIVE','DOWN','INACTIVE')),
  sort                       int not null default 0,
  created_by                 text default pm.current_user_id(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

create table if not exists pm.routings (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  code          text not null check (char_length(code) between 1 and 24),
  name          text not null check (char_length(name) between 1 and 120),
  job_type_key  text,                                   -- optional default for a job type
  description   text,
  version       int not null default 1 check (version >= 1),
  is_active     boolean not null default true,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, location_id, code, version),
  unique (org_id, id)
);

create table if not exists pm.routing_steps (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  routing_id            uuid not null,
  seq                   int not null check (seq >= 1),
  work_center_id        uuid not null,
  name                  text not null check (char_length(name) between 1 and 120),
  setup_minutes         int not null default 0 check (setup_minutes >= 0),
  run_minutes_per_unit  numeric(10,2) not null default 0 check (run_minutes_per_unit >= 0),
  instructions          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (routing_id, seq),
  unique (org_id, id),
  foreign key (org_id, routing_id) references pm.routings (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, work_center_id) references pm.work_centers (org_id, id) deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- 2. Production columns on pm.work_orders (additive)
-- ----------------------------------------------------------------------------
alter table pm.work_orders add column if not exists routing_id uuid;
alter table pm.work_orders add column if not exists quantity numeric(14,4) not null default 1 check (quantity > 0);
alter table pm.work_orders add column if not exists drawings_approved_at timestamptz;
alter table pm.work_orders add column if not exists drawings_approved_by text;
alter table pm.work_orders add column if not exists released_at timestamptz;
alter table pm.work_orders add column if not exists released_by text;
alter table pm.work_orders add column if not exists is_remake boolean not null default false;
alter table pm.work_orders add column if not exists remake_of_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'work_orders_routing_fk' and conrelid = 'pm.work_orders'::regclass) then
    alter table pm.work_orders add constraint work_orders_routing_fk
      foreign key (org_id, routing_id) references pm.routings (org_id, id) deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'work_orders_remake_of_fk' and conrelid = 'pm.work_orders'::regclass) then
    alter table pm.work_orders add constraint work_orders_remake_of_fk
      foreign key (org_id, remake_of_id) references pm.work_orders (org_id, id) deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'work_orders_remake_chk' and conrelid = 'pm.work_orders'::regclass) then
    alter table pm.work_orders add constraint work_orders_remake_chk
      check (remake_of_id is null or (is_remake and remake_of_id <> id));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'work_orders_released_chk' and conrelid = 'pm.work_orders'::regclass) then
    alter table pm.work_orders add constraint work_orders_released_chk
      check (kind <> 'PRODUCTION' or status in ('NEW','CANCELLED') or released_at is not null);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Operations (routing step instances) and BOM / cut-list lines
-- ----------------------------------------------------------------------------
create table if not exists pm.wo_operations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  work_order_id    uuid not null,
  routing_step_id  uuid,
  work_center_id   uuid not null,
  seq              int not null check (seq >= 1),
  name             text not null check (char_length(name) between 1 and 120),
  std_minutes      int not null default 0 check (std_minutes >= 0),
  actual_minutes   int not null default 0 check (actual_minutes >= 0),
  status           text not null default 'PENDING' check (status in ('PENDING','READY','IN_PROGRESS','COMPLETE','SKIPPED')),
  is_rework        boolean not null default false,
  qty_good         numeric(14,4) check (qty_good is null or qty_good >= 0),
  qty_scrap        numeric(14,4) not null default 0 check (qty_scrap >= 0),
  employee_id      uuid references core.employees(id),
  started_at       timestamptz,
  completed_at     timestamptz,
  completed_by     text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (work_order_id, seq),
  unique (org_id, id),
  check (status <> 'COMPLETE' or completed_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, routing_step_id) references pm.routing_steps (org_id, id) deferrable initially immediate,   -- routings are versioned; steps in use are not deleted
  foreign key (org_id, work_center_id) references pm.work_centers (org_id, id) deferrable initially immediate
);
create index if not exists pm_wo_operations_job_idx on pm.wo_operations (org_id, job_id, status);
create index if not exists pm_wo_operations_wc_idx on pm.wo_operations (org_id, work_center_id, status);

create table if not exists pm.bom_lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  work_order_id   uuid not null,
  parent_id       uuid,                                  -- assembly (cabinet box) → parts
  seq             int not null default 0,
  line_kind       text not null default 'PART' check (line_kind in
                    ('ASSEMBLY','PART','SHEET','LUMBER','EDGEBAND','HARDWARE','FINISH','BUYOUT','CONSUMABLE')),
  item_id         uuid,                                  -- core.items (material / hardware identity)
  part_code       text,
  description     text not null check (char_length(description) between 1 and 300),
  material        text,
  qty             numeric(14,4) not null check (qty > 0),
  uom             text not null default 'EA',
  length_mm       numeric(10,2) check (length_mm is null or length_mm > 0),
  width_mm        numeric(10,2) check (width_mm is null or width_mm > 0),
  thickness_mm    numeric(10,2) check (thickness_mm is null or thickness_mm > 0),
  grain           text check (grain is null or grain in ('NONE','LENGTH','WIDTH')),
  edgeband        text,
  assembly_ref    text,                                  -- e.g. cabinet label 'B24'
  wbs_id          uuid,                                  -- room / area
  source_ref      text,                                  -- CAD/CAM import reference (Cabinet Vision, Microvellum, Mozaik)
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  check (parent_id is null or parent_id <> id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, parent_id) references pm.bom_lines (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_bom_lines_wo_idx on pm.bom_lines (org_id, work_order_id, seq);
create unique index if not exists pm_bom_lines_source_uidx on pm.bom_lines (org_id, work_order_id, source_ref) where source_ref is not null;

-- Members edit BOM and operations only while the production order is NEW (engineering).
create or replace function pm.tg_production_lock() returns trigger
language plpgsql   -- invoker: current_user must be the caller for the client lock
set search_path = pm, core, public
as $$
declare v_org uuid; v_wo uuid; w pm.work_orders%rowtype;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_wo := old.work_order_id; else v_org := new.org_id; v_wo := new.work_order_id; end if;
  select * into w from pm.work_orders x where x.org_id = v_org and x.id = v_wo;
  if not found then raise exception 'PM_UNKNOWN_WORK_ORDER: %', v_wo using errcode = '23503'; end if;
  if w.kind <> 'PRODUCTION' then
    raise exception 'PM_NOT_PRODUCTION: % is a % work order', w.number, w.kind using errcode = '22023';
  end if;
  if current_user in ('authenticated','anon') and w.status <> 'NEW' then
    raise exception 'PM_PRODUCTION_LOCKED: % is % (BOM and routing lock at release)', w.number, w.status using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.job_id := coalesce(new.job_id, w.job_id);
  return new;
end $$;

-- Production quantity drives standard minutes: members change it only while the order is NEW.
create or replace function pm.tg_production_qty_lock() returns trigger
language plpgsql   -- invoker
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated','anon') and old.kind = 'PRODUCTION' and old.status <> 'NEW'
     and new.quantity is distinct from old.quantity then
    raise exception 'PM_PRODUCTION_LOCKED: % is % (quantity locks at release)', old.number, old.status using errcode = '55000';
  end if;
  return new;
end $$;
create or replace trigger trg_production_qty_lock before update of quantity on pm.work_orders
  for each row execute function pm.tg_production_qty_lock();

-- time entry ↔ operation ↔ work order consistency (operation implies its work order and job)
alter table pm.time_entries add column if not exists operation_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'time_entries_operation_fk' and conrelid = 'pm.time_entries'::regclass) then
    alter table pm.time_entries add constraint time_entries_operation_fk
      foreign key (org_id, operation_id) references pm.wo_operations (org_id, id) deferrable initially immediate;
  end if;
end $$;
create index if not exists pm_time_entries_op_idx on pm.time_entries (org_id, operation_id) where operation_id is not null;

create or replace function pm.tg_time_entry_operation() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o record;
begin
  if new.operation_id is null then return new; end if;
  select x.work_order_id, x.job_id into o from pm.wo_operations x where x.org_id = new.org_id and x.id = new.operation_id;
  if not found then raise exception 'PM_UNKNOWN_OPERATION: %', new.operation_id using errcode = '23503'; end if;
  if new.job_id is distinct from o.job_id then
    raise exception 'PM_TIME_SCOPE: operation % is not on job %', new.operation_id, new.job_id using errcode = '23514';
  end if;
  if new.work_order_id is null then
    new.work_order_id := o.work_order_id;
  elsif new.work_order_id <> o.work_order_id then
    raise exception 'PM_TIME_SCOPE: operation % is not on work order %', new.operation_id, new.work_order_id using errcode = '23514';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Triggers
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['work_centers','routings','routing_steps','wo_operations','bom_lines'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['work_centers','routings','bom_lines'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
  foreach t in array array['work_centers','routings'] loop
    execute format('create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
  foreach t in array array['wo_operations','bom_lines'] loop
    execute format('create or replace trigger trg_production_lock before insert or update or delete on pm.%I for each row execute function pm.tg_production_lock()', t);
  end loop;
end $$;

create or replace trigger trg_refs_in_org before insert or update on pm.wo_operations
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.bom_lines
  for each row execute function pm.tg_refs_in_org('item_id:core.items');
create or replace trigger trg_time_entry_operation before insert or update of operation_id, work_order_id, job_id on pm.time_entries
  for each row execute function pm.tg_time_entry_operation();

-- ----------------------------------------------------------------------------
-- 5. Guard (replaces the 1100 placeholder): the job has ≥1 live production order and every
--    production order is complete with no open operation.
-- ----------------------------------------------------------------------------
create or replace function pm.guard_production_complete(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select exists (select 1 from pm.work_orders w where w.job_id = p_job and w.kind = 'PRODUCTION' and w.status <> 'CANCELLED')
     and not exists (select 1 from pm.work_orders w
                     where w.job_id = p_job and w.kind = 'PRODUCTION' and w.status not in ('COMPLETE','CLOSED','CANCELLED'))
     and not exists (select 1 from pm.wo_operations o join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id
                     where o.job_id = p_job and w.status <> 'CANCELLED' and o.status not in ('COMPLETE','SKIPPED'))
$$;

-- ----------------------------------------------------------------------------
-- 6. Functions (definer; org guard first)
-- ----------------------------------------------------------------------------

-- Instantiate operations from a routing: std = setup + ceil(run × quantity). NEW orders only.
create or replace function pm.apply_routing(p_wo uuid, p_routing uuid, p_replace boolean default false)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; r pm.routings%rowtype; n int;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.kind <> 'PRODUCTION' then raise exception 'PM_NOT_PRODUCTION: %', w.number using errcode = '22023'; end if;
  if w.status <> 'NEW' then raise exception 'PM_PRODUCTION_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  select * into r from pm.routings x where x.org_id = w.org_id and x.id = p_routing and x.is_active;
  if not found or r.location_id <> w.location_id then
    raise exception 'PM_UNKNOWN_ROUTING: % is not an active routing on this company', p_routing using errcode = 'P0002';
  end if;
  if exists (select 1 from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = p_wo) then
    if not coalesce(p_replace, false) then
      raise exception 'PM_OPERATIONS_EXIST: % already has operations (pass p_replace)', w.number using errcode = '22023';
    end if;
    delete from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = p_wo;
  end if;
  insert into pm.wo_operations (org_id, job_id, work_order_id, routing_step_id, work_center_id, seq, name, std_minutes)
  select w.org_id, w.job_id, p_wo, s.id, s.work_center_id, s.seq, s.name,
         (s.setup_minutes + ceil(s.run_minutes_per_unit * w.quantity))::int
  from pm.routing_steps s where s.org_id = w.org_id and s.routing_id = p_routing order by s.seq;
  get diagnostics n = row_count;
  update pm.work_orders set routing_id = p_routing,
         estimated_minutes = (select coalesce(sum(o.std_minutes), 0) from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = p_wo)
   where id = p_wo;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'production.routing_applied', 'work_orders', p_wo,
    format('%s: routing %s applied (%s operations)', w.number, r.code, n), jsonb_build_object('routing_id', p_routing, 'operations', n));
  return n;
end $$;

create or replace function pm.create_production_order(
  p_job uuid, p_summary text, p_quantity numeric default 1, p_routing uuid default null,
  p_promised_on date default null, p_wbs uuid default null, p_remake_of uuid default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_id uuid;
begin
  select j.org_id into v_org from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'PM_INVALID: quantity must be > 0' using errcode = '22023'; end if;
  if p_remake_of is not null and not exists (select 1 from pm.work_orders w where w.org_id = v_org and w.id = p_remake_of and w.kind = 'PRODUCTION') then
    raise exception 'PM_UNKNOWN_WORK_ORDER: %', p_remake_of using errcode = 'P0002';
  end if;
  v_id := pm.create_work_order(p_job, 'PRODUCTION', p_summary, 3, null, null, null, null, '{}', 'CUSTOMER', null,
                               false, null, null, '{}'::jsonb, p_promised_on);
  update pm.work_orders set quantity = p_quantity, wbs_id = p_wbs, is_remake = p_remake_of is not null, remake_of_id = p_remake_of
   where id = v_id;
  if p_routing is not null then perform pm.apply_routing(v_id, p_routing, false); end if;
  return v_id;
end $$;

-- Engineering sign-off on shop drawings (a release gate). Revocable while NEW.
create or replace function pm.approve_drawings(p_wo uuid, p_revoke boolean default false)
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
  if w.kind <> 'PRODUCTION' then raise exception 'PM_NOT_PRODUCTION: %', w.number using errcode = '22023'; end if;
  if w.status <> 'NEW' then raise exception 'PM_PRODUCTION_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if pm.current_user_id() is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  update pm.work_orders
     set drawings_approved_at = case when coalesce(p_revoke, false) then null else now() end,
         drawings_approved_by = case when coalesce(p_revoke, false) then null else pm.current_user_id() end
   where id = p_wo;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id,
    case when coalesce(p_revoke, false) then 'production.drawings_revoked' else 'production.drawings_approved' end,
    'work_orders', p_wo, format('%s: shop drawings %s', w.number, case when coalesce(p_revoke, false) then 'revoked' else 'approved' end),
    '{}'::jsonb);
  return p_wo;
end $$;

-- Gated release. Returns the failing gate names in a fixed order (nothing changes), or '{}' on release.
create or replace function pm.release_to_shop(p_wo uuid)
returns text[]
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_fail text[] := '{}';
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.kind <> 'PRODUCTION' then raise exception 'PM_NOT_PRODUCTION: %', w.number using errcode = '22023'; end if;
  if w.status <> 'NEW' then raise exception 'PM_ALREADY_RELEASED: % is %', w.number, w.status using errcode = '22023'; end if;

  if w.drawings_approved_at is null then v_fail := v_fail || 'drawings_approved'::text; end if;
  if not exists (select 1 from pm.bom_lines b where b.org_id = w.org_id and b.work_order_id = p_wo) then
    v_fail := v_fail || 'bom_present'::text;
  end if;
  if not exists (select 1 from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = p_wo) then
    v_fail := v_fail || 'operations_present'::text;
  end if;
  if not pm.guard_selections_approved(w.job_id) then v_fail := v_fail || 'selections_approved'::text; end if;
  if not pm.guard_has_budget(w.job_id) then v_fail := v_fail || 'has_budget'::text; end if;
  if cardinality(v_fail) > 0 then return v_fail; end if;

  update pm.work_orders set status = 'RELEASED', released_at = now(), released_by = pm.current_user_id() where id = p_wo;
  update pm.wo_operations o set status = 'READY'
   where o.org_id = w.org_id and o.work_order_id = p_wo and o.status = 'PENDING'
     and o.seq = (select min(o2.seq) from pm.wo_operations o2 where o2.org_id = w.org_id and o2.work_order_id = p_wo and o2.status = 'PENDING');
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'production.released', 'work_orders', p_wo,
    format('Released %s to the shop', w.number),
    jsonb_build_object('operations', (select count(*) from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = p_wo),
                       'std_minutes', (select coalesce(sum(o.std_minutes), 0) from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = p_wo)));
  return '{}'::text[];
end $$;

create or replace function pm.start_operation(p_op uuid, p_employee uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.wo_operations%rowtype; w pm.work_orders%rowtype;
begin
  select * into o from pm.wo_operations x where x.id = p_op for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: operation % not found in the caller''s organization', p_op using errcode = '42501';
  end if;
  select * into w from pm.work_orders x where x.org_id = o.org_id and x.id = o.work_order_id for update;
  if w.status not in ('RELEASED','IN_PROGRESS','ON_HOLD') then
    raise exception 'PM_NOT_RELEASED: % is % (release it to the shop first)', w.number, w.status using errcode = '22023';
  end if;
  if o.status not in ('PENDING','READY') then
    raise exception 'PM_OP_TRANSITION_INVALID: operation % is %', o.seq, o.status using errcode = '22023';
  end if;
  if p_employee is not null and not exists (select 1 from core.employees e where e.id = p_employee and e.org_id = o.org_id) then
    raise exception 'PM_UNKNOWN_EMPLOYEE: %', p_employee using errcode = 'P0002';
  end if;
  update pm.wo_operations set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()),
         employee_id = coalesce(p_employee, employee_id)
   where id = p_op;
  if w.status in ('RELEASED','ON_HOLD') then
    update pm.work_orders set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), hold_reason = null where id = w.id;
  end if;
  perform pm.log_activity(o.org_id, w.location_id, o.job_id, 'production.op_started', 'wo_operations', p_op,
    format('%s op %s %s started', w.number, o.seq, o.name), jsonb_build_object('work_order_id', w.id, 'employee_id', p_employee));
  return p_op;
end $$;

-- Completes an operation. p_actual_minutes is ADDED to the minutes already reported on the
-- operation (pause/resume reporting). The next PENDING operation becomes READY; when no operation
-- is open the production order is COMPLETE (outcome COMPLETED).
create or replace function pm.complete_operation(
  p_op uuid, p_actual_minutes int, p_qty_good numeric default null, p_qty_scrap numeric default 0, p_notes text default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.wo_operations%rowtype; w pm.work_orders%rowtype; v_open int; v_status text;
begin
  select * into o from pm.wo_operations x where x.id = p_op for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: operation % not found in the caller''s organization', p_op using errcode = '42501';
  end if;
  select * into w from pm.work_orders x where x.org_id = o.org_id and x.id = o.work_order_id for update;
  if w.status not in ('RELEASED','IN_PROGRESS','ON_HOLD') then
    raise exception 'PM_NOT_RELEASED: % is %', w.number, w.status using errcode = '22023';
  end if;
  if o.status not in ('PENDING','READY','IN_PROGRESS') then
    raise exception 'PM_OP_TRANSITION_INVALID: operation % is %', o.seq, o.status using errcode = '22023';
  end if;
  if p_actual_minutes is null or p_actual_minutes < 0 then
    raise exception 'PM_INVALID: actual minutes must be ≥ 0' using errcode = '22023';
  end if;
  if coalesce(p_qty_scrap, 0) < 0 or (p_qty_good is not null and p_qty_good < 0) then
    raise exception 'PM_INVALID: quantities must be ≥ 0' using errcode = '22023';
  end if;

  update pm.wo_operations
     set status = 'COMPLETE', actual_minutes = actual_minutes + p_actual_minutes,
         started_at = coalesce(started_at, now()), completed_at = now(), completed_by = pm.current_user_id(),
         qty_good = coalesce(p_qty_good, w.quantity), qty_scrap = coalesce(p_qty_scrap, 0),
         notes = coalesce(p_notes, notes)
   where id = p_op;

  update pm.wo_operations x set status = 'READY'
   where x.org_id = o.org_id and x.work_order_id = w.id and x.status = 'PENDING'
     and x.seq = (select min(x2.seq) from pm.wo_operations x2 where x2.org_id = o.org_id and x2.work_order_id = w.id and x2.status = 'PENDING')
     and not exists (select 1 from pm.wo_operations x3 where x3.org_id = o.org_id and x3.work_order_id = w.id and x3.status = 'READY');

  select count(*) into v_open from pm.wo_operations x
  where x.org_id = o.org_id and x.work_order_id = w.id and x.status not in ('COMPLETE','SKIPPED');
  if v_open = 0 then
    update pm.work_orders set status = 'COMPLETE', outcome = 'COMPLETED', started_at = coalesce(started_at, now()),
           completed_at = now(), completed_by = pm.current_user_id(), hold_reason = null
     where id = w.id;
    v_status := 'COMPLETE';
  else
    update pm.work_orders set status = 'IN_PROGRESS', started_at = coalesce(started_at, now())
     where id = w.id and status in ('RELEASED','ON_HOLD');
    v_status := 'IN_PROGRESS';
  end if;

  perform pm.log_activity(o.org_id, w.location_id, o.job_id, 'production.op_completed', 'wo_operations', p_op,
    format('%s op %s %s complete (%s min, std %s)', w.number, o.seq, o.name, o.actual_minutes + p_actual_minutes, o.std_minutes),
    jsonb_build_object('work_order_id', w.id, 'actual_minutes', o.actual_minutes + p_actual_minutes, 'std_minutes', o.std_minutes,
                       'qty_scrap', coalesce(p_qty_scrap, 0), 'remaining_operations', v_open));
  if v_open = 0 then
    perform pm.log_activity(o.org_id, w.location_id, o.job_id, 'production.completed', 'work_orders', w.id,
      format('%s production complete', w.number), '{}'::jsonb);
  end if;
  return jsonb_build_object('operation_id', p_op, 'work_order_id', w.id, 'work_order_status', v_status, 'remaining_operations', v_open);
end $$;

create or replace function pm.skip_operation(p_op uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.wo_operations%rowtype; w pm.work_orders%rowtype;
begin
  select * into o from pm.wo_operations x where x.id = p_op for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: operation % not found in the caller''s organization', p_op using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'PM_INVALID: a reason is required' using errcode = '22023'; end if;
  select * into w from pm.work_orders x where x.org_id = o.org_id and x.id = o.work_order_id for update;
  if w.status in ('COMPLETE','CLOSED','CANCELLED') or o.status in ('COMPLETE','SKIPPED') then
    raise exception 'PM_OP_TRANSITION_INVALID: operation % is % on a % order', o.seq, o.status, w.status using errcode = '22023';
  end if;
  update pm.wo_operations set status = 'SKIPPED', notes = btrim(p_reason) where id = p_op;
  perform pm.log_activity(o.org_id, w.location_id, o.job_id, 'production.op_skipped', 'wo_operations', p_op,
    format('%s op %s skipped: %s', w.number, o.seq, btrim(p_reason)), '{}'::jsonb);
  return p_op;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Views (security_invoker)
-- ----------------------------------------------------------------------------
create or replace view pm.v_production_status with (security_invoker = on) as
select
  w.org_id, w.location_id, w.job_id, w.id as work_order_id, w.number, w.summary, w.status, w.quantity,
  w.promised_on, w.released_at, w.completed_at, w.is_remake, w.drawings_approved_at,
  coalesce(o.ops_total, 0)::int                                    as ops_total,
  coalesce(o.ops_done, 0)::int                                     as ops_done,
  coalesce(o.std_total, 0)::int                                    as std_minutes,
  coalesce(o.std_done, 0)::int                                     as std_minutes_done,
  coalesce(o.actual_total, 0)::int                                 as actual_minutes,
  (coalesce(o.std_total, 0) - coalesce(o.std_done, 0))::int        as remaining_std_minutes,
  case when coalesce(o.std_total, 0) > 0 then round(o.std_done::numeric / o.std_total, 4)
       when coalesce(o.ops_total, 0) > 0 then round(o.ops_done::numeric / o.ops_total, 4) end as pct_complete,
  cur.work_center_id                                               as current_work_center_id,
  cur.name                                                         as current_operation,
  (w.promised_on is not null and w.status not in ('COMPLETE','CLOSED','CANCELLED') and w.promised_on < current_date) as is_late
from pm.work_orders w
left join lateral (
  select count(*) as ops_total,
         count(*) filter (where x.status in ('COMPLETE','SKIPPED')) as ops_done,
         sum(x.std_minutes) as std_total,
         sum(x.std_minutes) filter (where x.status in ('COMPLETE','SKIPPED')) as std_done,
         sum(x.actual_minutes) as actual_total
  from pm.wo_operations x where x.org_id = w.org_id and x.work_order_id = w.id
) o on true
left join lateral (
  select x.work_center_id, x.name from pm.wo_operations x
  where x.org_id = w.org_id and x.work_order_id = w.id and x.status not in ('COMPLETE','SKIPPED')
  order by x.seq limit 1
) cur on true
where w.kind = 'PRODUCTION';

-- Job rollup (the "production" tab and the production_complete guard's explanation)
create or replace view pm.v_job_production with (security_invoker = on) as
select s.org_id, s.location_id, s.job_id,
       count(*) filter (where s.status <> 'CANCELLED')::int                              as orders,
       count(*) filter (where s.status = 'NEW')::int                                     as in_engineering,
       count(*) filter (where s.status in ('RELEASED','IN_PROGRESS','ON_HOLD'))::int     as in_shop,
       count(*) filter (where s.status in ('COMPLETE','CLOSED'))::int                    as complete,
       sum(s.std_minutes) filter (where s.status <> 'CANCELLED')::int                    as std_minutes,
       sum(s.actual_minutes) filter (where s.status <> 'CANCELLED')::int                 as actual_minutes,
       sum(s.remaining_std_minutes) filter (where s.status <> 'CANCELLED')::int          as remaining_std_minutes,
       case when sum(s.std_minutes) filter (where s.status <> 'CANCELLED') > 0
            then round(sum(s.std_minutes_done) filter (where s.status <> 'CANCELLED')::numeric
                       / sum(s.std_minutes) filter (where s.status <> 'CANCELLED'), 4) end as pct_complete,
       bool_or(s.is_late)                                                                as any_late
from pm.v_production_status s
group by s.org_id, s.location_id, s.job_id;

-- Work-center load: open standard minutes vs weekly capacity.
create or replace view pm.v_work_center_load with (security_invoker = on) as
select c.org_id, c.location_id, c.id as work_center_id, c.code, c.name, c.status, c.capacity_minutes_per_week,
       coalesce(sum(o.std_minutes) filter (where o.status in ('PENDING','READY','IN_PROGRESS') and w.status in ('NEW','RELEASED','IN_PROGRESS','ON_HOLD')), 0)::int as open_std_minutes,
       case when c.capacity_minutes_per_week > 0 then
         round(coalesce(sum(o.std_minutes) filter (where o.status in ('PENDING','READY','IN_PROGRESS') and w.status in ('NEW','RELEASED','IN_PROGRESS','ON_HOLD')), 0)::numeric
               / c.capacity_minutes_per_week, 2) end as backlog_weeks
from pm.work_centers c
left join pm.wo_operations o on o.org_id = c.org_id and o.work_center_id = c.id
left join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id
group by c.org_id, c.location_id, c.id, c.code, c.name, c.status, c.capacity_minutes_per_week;

-- ---------------------------------------------------------------------------
-- KPIs. Window: trailing 90 days unless noted.
--   shop_backlog_weeks     Σ std minutes of open operations on production orders in NEW (sold, in engineering),
--                          RELEASED, IN_PROGRESS, ON_HOLD ÷ Σ weekly capacity minutes of ACTIVE work centers (point in time)
--   labor_efficiency_pct   Σ std ÷ Σ actual minutes on operations completed in 90d with actual > 0
--   remake_rate_pct        actual minutes on rework operations or remake orders ÷ all actual minutes on operations
--                          completed in 90d (shop-minutes proxy for "cost of remakes ÷ production cost"; cost is Books)
--   on_time_delivery_pct   production orders completed in 90d with a promised date: completed_on ≤ promised_on ÷ those
--   material_yield_pct     Σ BOM qty ÷ Σ net issued qty (ISSUE − RETURN material moves on the order) by item, for
--                          production orders completed in 90d where something was issued
-- ---------------------------------------------------------------------------
create or replace view pm.v_kpis_production with (security_invoker = on) as
with cap as (
  select c.org_id, c.location_id, sum(c.capacity_minutes_per_week) as cap_min
  from pm.work_centers c where c.status = 'ACTIVE' group by c.org_id, c.location_id
),
open_std as (
  select w.org_id, w.location_id, sum(o.std_minutes) as std_min, count(distinct w.id) as orders
  from pm.work_orders w join pm.wo_operations o on o.org_id = w.org_id and o.work_order_id = w.id
  where w.kind = 'PRODUCTION' and w.status in ('NEW','RELEASED','IN_PROGRESS','ON_HOLD')
    and o.status in ('PENDING','READY','IN_PROGRESS')
  group by w.org_id, w.location_id
),
ops_done as (
  select o.org_id, w.location_id, o.std_minutes, o.actual_minutes, (o.is_rework or w.is_remake) as rework
  from pm.wo_operations o join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id
  where o.status = 'COMPLETE' and o.completed_at >= now() - interval '90 days'
),
yield as (
  select w.org_id, w.location_id, w.id, b.item_id, b.est_qty,
         coalesce((select sum(case m.kind when 'ISSUE' then m.qty when 'RETURN' then -m.qty else 0 end)
                   from pm.material_moves m
                   where m.org_id = w.org_id and m.work_order_id = w.id and m.item_id = b.item_id), 0) as issued_qty
  from pm.work_orders w
  join (select org_id, work_order_id, item_id, sum(qty) as est_qty from pm.bom_lines
        where item_id is not null group by org_id, work_order_id, item_id) b
    on b.org_id = w.org_id and b.work_order_id = w.id
  where w.kind = 'PRODUCTION' and w.status in ('COMPLETE','CLOSED') and w.completed_at >= now() - interval '90 days'
)
select cap.org_id, cap.location_id, null::uuid as job_id, 'shop_backlog_weeks'::text as metric,
       round(coalesce(os.std_min, 0)::numeric / cap.cap_min, 2) as value, current_date as as_of,
       'wo_operations: open std minutes ÷ active work-center weekly capacity'::text as basis, coalesce(os.orders, 0)::int as sample_n
from cap left join open_std os on os.org_id = cap.org_id and os.location_id = cap.location_id
where cap.cap_min > 0
union all
select org_id, location_id, null, 'labor_efficiency_pct', round(sum(std_minutes)::numeric / sum(actual_minutes), 4), current_date,
       'wo_operations: std ÷ actual minutes, completed in 90d', count(*)::int
from ops_done where actual_minutes > 0 group by org_id, location_id
union all
select org_id, location_id, null, 'remake_rate_pct',
       round(coalesce(sum(actual_minutes) filter (where rework), 0)::numeric / sum(actual_minutes), 4), current_date,
       'wo_operations: rework minutes ÷ all minutes, completed in 90d (cost proxy)', count(*)::int
from ops_done group by org_id, location_id having sum(actual_minutes) > 0
union all
select w.org_id, w.location_id, null, 'on_time_delivery_pct',
       round(count(*) filter (where w.completed_at::date <= w.promised_on)::numeric / count(*), 4), current_date,
       'work_orders: production completed in 90d vs promised date', count(*)::int
from pm.work_orders w
where w.kind = 'PRODUCTION' and w.status in ('COMPLETE','CLOSED') and w.promised_on is not null
  and w.completed_at >= now() - interval '90 days'
group by w.org_id, w.location_id
union all
select org_id, location_id, null, 'material_yield_pct', round(sum(est_qty) / sum(issued_qty), 4), current_date,
       'bom_lines ÷ net issued material moves, production completed in 90d', count(distinct id)::int
from yield where issued_qty > 0 group by org_id, location_id;

-- ----------------------------------------------------------------------------
-- 8. RLS
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['work_centers','routings','routing_steps','wo_operations','bom_lines'] loop
    execute format('alter table pm.%I enable row level security', t);
  end loop;
  foreach t in array array['work_centers','routings','routing_steps','bom_lines'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='wo_operations' and policyname='org_select') then
    create policy org_select on pm.wo_operations for select using (org_id = public.get_org_id());
    create policy pending_insert on pm.wo_operations for insert
      with check (org_id = public.get_org_id() and status = 'PENDING' and actual_minutes = 0
                  and started_at is null and completed_at is null);
    create policy org_update on pm.wo_operations for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy pending_delete on pm.wo_operations for delete using (org_id = public.get_org_id() and status = 'PENDING');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Grants
-- ----------------------------------------------------------------------------
revoke all on pm.work_centers, pm.routings, pm.routing_steps, pm.wo_operations, pm.bom_lines from public, anon, authenticated;
grant select, insert, update, delete on pm.work_centers, pm.routings, pm.routing_steps, pm.wo_operations, pm.bom_lines to service_role;
grant select, insert, update, delete on pm.work_centers, pm.routings, pm.routing_steps, pm.bom_lines to authenticated;
-- operations: status / minutes / stamps only via start/complete/skip; plan columns while NEW (trigger)
grant select, insert, delete on pm.wo_operations to authenticated;
grant update (work_center_id, seq, name, std_minutes, is_rework, notes) on pm.wo_operations to authenticated;
grant update (quantity, wbs_id, promised_on) on pm.work_orders to authenticated;
grant update (operation_id) on pm.time_entries to authenticated;

grant select on pm.v_production_status, pm.v_job_production, pm.v_work_center_load, pm.v_kpis_production
  to authenticated, service_role;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm' and p.proname in (
             'tg_production_lock','tg_production_qty_lock','tg_time_entry_operation','guard_production_complete','apply_routing',
             'create_production_order','approve_drawings','release_to_shop','start_operation','complete_operation',
             'skip_operation') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname not like 'tg\_%' then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1105_pm_production
-- ============================================================================
