-- ============================================================================
-- 1107 · Merit Projects v2 — real-estate development: units/lots, entitlement and
--        permit milestones, lender draw schedules, draws by budget line, inspection,
--        lender-held retainage, interest reserve, draw package flow; pm.v_kpis union
--
-- Binding inputs: blueprint D7/D10/D11/D12 + §2.2 (lots_units, lender_draws) + §6 (draws, lots),
-- review 05 §4.5 (draw_schedules) and §6 Q6 (child jobs vs WBS lots), research 06 §2.2–2.5 and §3B
-- (Rabbet draw package canon; draw lifecycle OPEN → … → SUBMITTED → INSPECTION → LENDER_APPROVED →
-- FUNDED, RETURNED_FOR_CORRECTION), pack manifests real_estate_development, home_builder
-- (KPIs draw_cycle_days, in_balance_gap_cents, interest_reserve_months, contingency_burn_ratio).
--
-- Decision — lots/units are a table (pm.units), not bare WBS LOT nodes:
--   a lot carries money and state that a WBS node cannot (list / contract / lender release price,
--   buyer, contract and closing dates, a sale status machine) and D11 says money/state/KPI data are
--   real columns. A unit OPTIONALLY points at a WBS LOT node (cost + schedule bucket inside the
--   project — the default, no extra GL dimension) and OPTIONALLY at a child core.jobs row (when the
--   home/lot must carry its own GL dimension, e.g. spec homes). Lead keeps the D-level choice of
--   child jobs per pack; nothing here forces it.
--
-- Draw money model (all operational; NO posting — Books owns cash, AR to the lender and CIP):
--   per line   approved (gross earned this draw) − retainage held (HARD lines × lender %) + retainage released
--   per draw   net = Σ approved − Σ held + Σ released;  equity applied first (equity_first) up to the
--              remaining equity requirement;  loan expected = net − equity applied;  funded = lender wire
--   in balance cost_to_complete = Σ max(revised − drawn gross, 0) + net retainage still held
--              gap = cost_to_complete − (loan commitment − loan funded) − (equity required − equity applied)
--   interest   reserve = Σ revised INTEREST_RESERVE lines (else schedule.interest_reserve_cents);
--              used = Σ drawn on those lines; months = remaining ÷ (projected monthly interest, else
--              funded balance × rate ÷ 12)
-- Funding a draw does not emit an event: the lead/1102 decide whether a funded draw creates a
-- JOB_BILLING (billing_type DRAW) request; draws.billing_request_id is the placeholder link.
-- Depends on 1104–1106 (for the pm.v_kpis union). Idempotent: safe to run twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Units / lots
-- ----------------------------------------------------------------------------
create table if not exists pm.units (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                      uuid not null,                     -- the development project
  wbs_id                      uuid,                              -- LOT node (cost / schedule bucket)
  child_job_id                uuid,                              -- optional own GL dimension (spec home, lot takedown)
  unit_number                 text not null check (char_length(unit_number) between 1 and 40),
  unit_kind                   text not null default 'LOT' check (unit_kind in
                                ('LOT','SINGLE_FAMILY','TOWNHOME','CONDO','APARTMENT','COMMERCIAL','PAD')),
  phase                       text,
  plan_name                   text,
  sqft                        numeric(12,2) check (sqft is null or sqft >= 0),
  status                      text not null default 'PLANNED' check (status in
                                ('PLANNED','ENTITLED','AVAILABLE','UNDER_CONSTRUCTION','COMPLETE','UNDER_CONTRACT',
                                 'CLOSED','LEASED','HELD')),
  list_price_cents            bigint check (list_price_cents is null or list_price_cents >= 0),
  contract_price_cents        bigint check (contract_price_cents is null or contract_price_cents >= 0),
  lender_release_price_cents  bigint check (lender_release_price_cents is null or lender_release_price_cents >= 0),
  buyer_customer_id           uuid references core.customers(id),
  contract_on                 date,
  est_close_on                date,
  closed_on                   date,
  notes                       text,
  sort                        int not null default 0,
  created_by                  text default pm.current_user_id(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (org_id, job_id, unit_number),
  unique (org_id, id),
  check (child_job_id is null or child_job_id <> job_id),
  check (status <> 'UNDER_CONTRACT' or (buyer_customer_id is not null and contract_price_cents is not null)),
  check (status <> 'CLOSED' or closed_on is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, child_job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_units_job_idx on pm.units (org_id, job_id, status);

-- ----------------------------------------------------------------------------
-- 2. Entitlement / permit milestones
-- ----------------------------------------------------------------------------
create table if not exists pm.entitlements (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  unit_id           uuid,
  kind              text not null check (kind in
                      ('LAND_ACQUISITION','ZONING','SITE_PLAN','PRELIMINARY_PLAT','FINAL_PLAT','ENVIRONMENTAL','UTILITY',
                       'GRADING_PERMIT','BUILDING_PERMIT','CERTIFICATE_OF_OCCUPANCY','OTHER')),
  name              text not null check (char_length(name) between 1 and 160),
  authority         text,
  reference_number  text,
  status            text not null default 'NOT_STARTED' check (status in
                      ('NOT_STARTED','IN_PREP','SUBMITTED','UNDER_REVIEW','HEARING_SCHEDULED','APPROVED',
                       'APPROVED_WITH_CONDITIONS','DENIED','EXPIRED','WITHDRAWN')),
  target_on         date,
  submitted_on      date,
  hearing_on        date,
  approved_on       date,
  expires_on        date,
  conditions        text,
  sort              int not null default 0,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  check (status not in ('APPROVED','APPROVED_WITH_CONDITIONS') or approved_on is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, unit_id) references pm.units (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_entitlements_job_idx on pm.entitlements (org_id, job_id, status);

-- ----------------------------------------------------------------------------
-- 3. Lender draw schedule (the loan budget) and its lines
-- ----------------------------------------------------------------------------
create table if not exists pm.draw_schedules (
  id                                uuid primary key default gen_random_uuid(),
  org_id                            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                            uuid not null,
  lender_name                       text not null check (char_length(lender_name) between 1 and 160),
  lender_customer_id                uuid references core.customers(id),      -- the AR party Books bills draws to
  loan_number                       text,
  loan_commitment_cents             bigint not null check (loan_commitment_cents >= 0),
  equity_required_cents             bigint not null default 0 check (equity_required_cents >= 0),
  interest_reserve_cents            bigint not null default 0 check (interest_reserve_cents >= 0),
  interest_rate                     numeric(7,5) check (interest_rate is null or (interest_rate >= 0 and interest_rate <= 1)),
  projected_monthly_interest_cents  bigint check (projected_monthly_interest_cents is null or projected_monthly_interest_cents >= 0),
  retainage_pct                     numeric(5,4) not null default 0.10 check (retainage_pct >= 0 and retainage_pct <= 0.25),
  requires_inspection               boolean not null default true,
  equity_first                      boolean not null default true,
  loan_closed_on                    date,
  maturity_on                       date,
  status                            text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','CLOSED')),
  activated_at                      timestamptz,
  closed_at                         timestamptz,
  notes                             text,
  created_by                        text default pm.current_user_id(),
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, id),
  check (status = 'DRAFT' or activated_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_draw_schedules_job_idx on pm.draw_schedules (org_id, job_id, status);

create table if not exists pm.draw_budget_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  draw_schedule_id  uuid not null,
  job_id            uuid not null,
  line_no           int not null check (line_no >= 1),
  description       text not null check (char_length(description) between 1 and 200),
  category          text not null check (category in
                      ('LAND','HARD','SOFT','FINANCING','INTEREST_RESERVE','CONTINGENCY','DEVELOPER_FEE','OTHER')),
  cost_code_id      uuid,
  budget_line_id    uuid references pm.budget_lines(id),
  original_cents    bigint not null default 0 check (original_cents >= 0),
  revised_cents     bigint check (revised_cents is null or revised_cents >= 0),     -- defaults to original
  retainage_applies boolean,                                                       -- defaults to category = HARD
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (draw_schedule_id, line_no),
  unique (org_id, id),
  unique (org_id, draw_schedule_id, id),
  foreign key (org_id, job_id, draw_schedule_id) references pm.draw_schedules (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);

-- Append-only audit of loan-budget reallocations after activation (lenders ask for it).
create table if not exists pm.draw_budget_revisions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  draw_budget_line_id  uuid not null,
  from_cents           bigint not null,
  to_cents             bigint not null,
  reason               text not null,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, draw_budget_line_id) references pm.draw_budget_lines (org_id, id) on delete cascade deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- 4. Draws and draw lines
-- ----------------------------------------------------------------------------
create table if not exists pm.draws (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                    uuid not null,
  draw_schedule_id          uuid not null,
  draw_number               int not null check (draw_number >= 1),
  period_end                date not null,
  status                    text not null default 'DRAFT' check (status in
                              ('DRAFT','SUBMITTED','INSPECTION','APPROVED','FUNDED','RETURNED','CANCELLED')),
  inspection_status         text not null default 'NOT_REQUESTED' check (inspection_status in
                              ('NOT_REQUESTED','NOT_REQUIRED','PENDING','PASSED','CONDITIONAL','FAILED')),
  inspected_on              date,
  inspector_name            text,
  inspector_pct_complete    numeric(5,4) check (inspector_pct_complete is null or (inspector_pct_complete >= 0 and inspector_pct_complete <= 1)),
  inspection_notes          text,
  requested_cents           bigint,                    -- pinned at submit
  approved_cents            bigint,                    -- pinned at approve (gross)
  retainage_held_cents      bigint,                    -- pinned at approve
  retainage_released_cents  bigint,                    -- pinned at approve
  equity_applied_cents      bigint,                    -- pinned at approve
  loan_expected_cents       bigint,                    -- pinned at approve
  funded_cents              bigint check (funded_cents is null or funded_cents >= 0),
  submitted_at              timestamptz,
  submitted_by              text,
  approved_at               timestamptz,
  approved_by               text,
  lender_approver_name      text,
  funded_at                 timestamptz,
  funded_on                 date,
  wire_ref                  text,
  returned_at               timestamptz,
  returned_reason           text,
  cancelled_at              timestamptz,
  package                   jsonb not null default '{}' check (jsonb_typeof(package) = 'object'),  -- draw-package checklist
  billing_request_id        uuid,                      -- placeholder → 1102 JOB_BILLING (DRAW) request; no FK
  notes                     text,
  created_by                text default pm.current_user_id(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (draw_schedule_id, draw_number),
  unique (org_id, id),
  unique (org_id, draw_schedule_id, id),
  check (status not in ('SUBMITTED','INSPECTION','APPROVED','FUNDED') or submitted_at is not null),
  check (status not in ('APPROVED','FUNDED') or (approved_at is not null and loan_expected_cents is not null)),
  check (status <> 'FUNDED' or (funded_at is not null and funded_cents is not null)),
  foreign key (org_id, job_id, draw_schedule_id) references pm.draw_schedules (org_id, job_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_draws_one_open_uidx on pm.draws (draw_schedule_id)
  where status in ('DRAFT','SUBMITTED','INSPECTION','APPROVED','RETURNED');
create index if not exists pm_draws_job_idx on pm.draws (org_id, job_id, status);

create table if not exists pm.draw_lines (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                    uuid not null,
  draw_schedule_id          uuid not null,
  draw_id                   uuid not null,
  draw_budget_line_id       uuid not null,
  requested_cents           bigint not null default 0 check (requested_cents >= 0),
  approved_cents            bigint check (approved_cents is null or approved_cents >= 0),
  retainage_held_cents      bigint not null default 0 check (retainage_held_cents >= 0),
  retainage_released_cents  bigint not null default 0 check (retainage_released_cents >= 0),
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (draw_id, draw_budget_line_id),
  unique (org_id, id),
  foreign key (org_id, draw_schedule_id, draw_id) references pm.draws (org_id, draw_schedule_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, draw_schedule_id, draw_budget_line_id) references pm.draw_budget_lines (org_id, draw_schedule_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_draw_lines_bl_idx on pm.draw_lines (org_id, draw_budget_line_id);

-- ----------------------------------------------------------------------------
-- 5. Trigger functions
-- ----------------------------------------------------------------------------
-- Budget lines: fill job + defaults; budget_line_id must be a budget line of the same job;
-- members edit only while the schedule is DRAFT (after activation: pm.revise_draw_budget_line).
create or replace function pm.tg_draw_budget_line() returns trigger
language plpgsql   -- invoker: the client lock needs current_user = caller
set search_path = pm, core, public
as $$
declare v_status text; v_job uuid; v_org uuid; v_sched uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_sched := old.draw_schedule_id; else v_org := new.org_id; v_sched := new.draw_schedule_id; end if;
  select s.status, s.job_id into v_status, v_job from pm.draw_schedules s where s.org_id = v_org and s.id = v_sched;
  if current_user in ('authenticated','anon') and v_status is not null and v_status <> 'DRAFT' then
    raise exception 'PM_DRAW_BUDGET_LOCKED: the loan budget is % (reallocate with pm.revise_draw_budget_line)', lower(v_status)
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.job_id := coalesce(new.job_id, v_job);
  new.revised_cents := coalesce(new.revised_cents, new.original_cents);
  new.retainage_applies := coalesce(new.retainage_applies, new.category = 'HARD');
  if new.budget_line_id is not null and not exists (
       select 1 from pm.budget_lines l join pm.budgets b on b.org_id = l.org_id and b.id = l.budget_id
       where l.id = new.budget_line_id and l.org_id = new.org_id and b.job_id = new.job_id) then
    raise exception 'PM_DRAW_SCOPE: budget line % is not on this job', new.budget_line_id using errcode = '23514';
  end if;
  return new;
end $$;

-- Draw lines: fill schedule + job from the draw; editable by members only while DRAFT/RETURNED.
create or replace function pm.tg_draw_line() returns trigger
language plpgsql   -- invoker
set search_path = pm, core, public
as $$
declare d record; v_org uuid; v_draw uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_draw := old.draw_id; else v_org := new.org_id; v_draw := new.draw_id; end if;
  select x.status, x.job_id, x.draw_schedule_id into d from pm.draws x where x.org_id = v_org and x.id = v_draw;
  if current_user in ('authenticated','anon') and d.status is not null and d.status not in ('DRAFT','RETURNED') then
    raise exception 'PM_DRAW_LOCKED: the draw is %', lower(d.status) using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.job_id := coalesce(new.job_id, d.job_id);
  new.draw_schedule_id := coalesce(new.draw_schedule_id, d.draw_schedule_id);
  return new;
end $$;

create or replace function pm.tg_draw_lock() returns trigger
language plpgsql   -- invoker
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated','anon') and old.status not in ('DRAFT','RETURNED') then
    raise exception 'PM_DRAW_LOCKED: the draw is %', lower(old.status) using errcode = '55000';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['units','entitlements','draw_schedules','draw_budget_lines','draws','draw_lines'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['units','entitlements','draw_schedules','draws','draw_budget_revisions'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
end $$;

create or replace trigger trg_refs_in_org before insert or update on pm.units
  for each row execute function pm.tg_refs_in_org('buyer_customer_id:core.customers');
create or replace trigger trg_refs_in_org before insert or update on pm.draw_schedules
  for each row execute function pm.tg_refs_in_org('lender_customer_id:core.customers');
create or replace trigger trg_draw_budget_line before insert or update or delete on pm.draw_budget_lines
  for each row execute function pm.tg_draw_budget_line();
create or replace trigger trg_draw_line before insert or update or delete on pm.draw_lines
  for each row execute function pm.tg_draw_line();
create or replace trigger trg_draw_lock before update on pm.draws
  for each row execute function pm.tg_draw_lock();

-- ----------------------------------------------------------------------------
-- 6. Functions (definer; org guard first)
-- ----------------------------------------------------------------------------
create or replace function pm.set_unit_status(
  p_unit uuid, p_status text, p_on date default null, p_buyer uuid default null, p_contract_price_cents bigint default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare u pm.units%rowtype; ok boolean; v_loc uuid; v_on date := coalesce(p_on, current_date);
begin
  select * into u from pm.units x where x.id = p_unit for update;
  if u.org_id is null or u.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  ok := case u.status
          when 'PLANNED'            then p_status in ('ENTITLED','AVAILABLE','UNDER_CONSTRUCTION','HELD')
          when 'ENTITLED'           then p_status in ('AVAILABLE','UNDER_CONSTRUCTION','HELD')
          when 'AVAILABLE'          then p_status in ('UNDER_CONSTRUCTION','UNDER_CONTRACT','LEASED','HELD')
          when 'UNDER_CONSTRUCTION' then p_status in ('COMPLETE','UNDER_CONTRACT','HELD')
          when 'COMPLETE'           then p_status in ('UNDER_CONTRACT','LEASED','HELD')
          when 'UNDER_CONTRACT'     then p_status in ('CLOSED','AVAILABLE','UNDER_CONSTRUCTION','COMPLETE')
          when 'HELD'               then p_status in ('PLANNED','ENTITLED','AVAILABLE','UNDER_CONSTRUCTION','COMPLETE')
          when 'LEASED'             then p_status = 'AVAILABLE'
          else false end;
  if not ok then raise exception 'PM_UNIT_TRANSITION_INVALID: % -> %', u.status, p_status using errcode = '22023'; end if;
  if p_buyer is not null and not exists (select 1 from core.customers c where c.id = p_buyer and c.org_id = u.org_id) then
    raise exception 'PM_UNKNOWN_CUSTOMER: %', p_buyer using errcode = 'P0002';
  end if;
  if p_contract_price_cents is not null and p_contract_price_cents < 0 then
    raise exception 'PM_INVALID: price must be ≥ 0' using errcode = '22023';
  end if;
  update pm.units
     set status = p_status,
         buyer_customer_id    = case when p_status = 'UNDER_CONTRACT' then coalesce(p_buyer, buyer_customer_id)
                                     when u.status = 'UNDER_CONTRACT' and p_status <> 'CLOSED' then null else buyer_customer_id end,
         contract_price_cents = case when p_status = 'UNDER_CONTRACT' then coalesce(p_contract_price_cents, contract_price_cents)
                                     when u.status = 'UNDER_CONTRACT' and p_status <> 'CLOSED' then null else contract_price_cents end,
         contract_on          = case when p_status = 'UNDER_CONTRACT' then v_on
                                     when u.status = 'UNDER_CONTRACT' and p_status <> 'CLOSED' then null else contract_on end,
         closed_on            = case when p_status = 'CLOSED' then v_on else closed_on end
   where id = p_unit;
  select j.location_id into v_loc from core.jobs j where j.org_id = u.org_id and j.id = u.job_id;
  perform pm.log_activity(u.org_id, v_loc, u.job_id, 'unit.status', 'units', p_unit,
    format('Unit %s → %s', u.unit_number, lower(replace(p_status, '_', ' '))),
    jsonb_build_object('from', u.status, 'to', p_status, 'buyer', p_buyer, 'contract_price_cents', p_contract_price_cents));
  return p_unit;
end $$;

create or replace function pm.record_entitlement_status(
  p_entitlement uuid, p_status text, p_on date default null, p_reference text default null,
  p_conditions text default null, p_expires_on date default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.entitlements%rowtype; ok boolean; v_loc uuid; v_on date := coalesce(p_on, current_date);
begin
  select * into e from pm.entitlements x where x.id = p_entitlement for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: entitlement % not found in the caller''s organization', p_entitlement using errcode = '42501';
  end if;
  ok := case e.status
          when 'NOT_STARTED'              then p_status in ('IN_PREP','SUBMITTED','WITHDRAWN')
          when 'IN_PREP'                  then p_status in ('SUBMITTED','WITHDRAWN')
          when 'SUBMITTED'                then p_status in ('UNDER_REVIEW','HEARING_SCHEDULED','APPROVED','APPROVED_WITH_CONDITIONS','DENIED','WITHDRAWN')
          when 'UNDER_REVIEW'             then p_status in ('SUBMITTED','HEARING_SCHEDULED','APPROVED','APPROVED_WITH_CONDITIONS','DENIED','WITHDRAWN')
          when 'HEARING_SCHEDULED'        then p_status in ('UNDER_REVIEW','APPROVED','APPROVED_WITH_CONDITIONS','DENIED','WITHDRAWN')
          when 'DENIED'                   then p_status in ('IN_PREP','SUBMITTED','WITHDRAWN')
          when 'APPROVED'                 then p_status = 'EXPIRED'
          when 'APPROVED_WITH_CONDITIONS' then p_status = 'EXPIRED'
          when 'EXPIRED'                  then p_status = 'IN_PREP'
          else false end;
  if not ok then raise exception 'PM_ENTITLEMENT_TRANSITION_INVALID: % -> %', e.status, p_status using errcode = '22023'; end if;
  if p_status = 'APPROVED_WITH_CONDITIONS' and coalesce(btrim(coalesce(p_conditions, e.conditions)), '') = '' then
    raise exception 'PM_INVALID: record the conditions of approval' using errcode = '22023';
  end if;
  update pm.entitlements
     set status = p_status,
         reference_number = coalesce(p_reference, reference_number),
         submitted_on = case when p_status = 'SUBMITTED' then v_on else submitted_on end,
         hearing_on   = case when p_status = 'HEARING_SCHEDULED' then v_on else hearing_on end,
         approved_on  = case when p_status in ('APPROVED','APPROVED_WITH_CONDITIONS') then v_on else approved_on end,
         expires_on   = coalesce(p_expires_on, expires_on),
         conditions   = coalesce(p_conditions, conditions)
   where id = p_entitlement;
  select j.location_id into v_loc from core.jobs j where j.org_id = e.org_id and j.id = e.job_id;
  perform pm.log_activity(e.org_id, v_loc, e.job_id, 'entitlement.status', 'entitlements', p_entitlement,
    format('%s → %s', e.name, lower(replace(p_status, '_', ' '))), jsonb_build_object('from', e.status, 'to', p_status, 'on', v_on));
  return p_entitlement;
end $$;

create or replace function pm.activate_draw_schedule(p_schedule uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.draw_schedules%rowtype; v_loc uuid; v_total bigint;
begin
  select * into s from pm.draw_schedules x where x.id = p_schedule for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw schedule % not found in the caller''s organization', p_schedule using errcode = '42501';
  end if;
  if s.status <> 'DRAFT' then raise exception 'PM_DRAW_SCHEDULE_TRANSITION_INVALID: schedule is %', s.status using errcode = '22023'; end if;
  select sum(l.revised_cents) into v_total from pm.draw_budget_lines l where l.org_id = s.org_id and l.draw_schedule_id = s.id;
  if v_total is null then raise exception 'PM_INVALID: a loan budget needs at least one line' using errcode = '22023'; end if;
  update pm.draw_schedules set status = 'ACTIVE', activated_at = now() where id = p_schedule;
  select j.location_id into v_loc from core.jobs j where j.org_id = s.org_id and j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'draw_schedule.activated', 'draw_schedules', p_schedule,
    format('Loan budget with %s activated (%s cents budget; %s loan + %s equity)', s.lender_name, v_total,
           s.loan_commitment_cents, s.equity_required_cents),
    jsonb_build_object('budget_cents', v_total, 'loan_commitment_cents', s.loan_commitment_cents,
                       'equity_required_cents', s.equity_required_cents));
  return p_schedule;
end $$;

-- Reallocation / revision of one loan-budget line after activation (audited).
create or replace function pm.revise_draw_budget_line(p_line uuid, p_revised_cents bigint, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.draw_budget_lines%rowtype; s pm.draw_schedules%rowtype; v_drawn bigint; v_loc uuid;
begin
  select * into l from pm.draw_budget_lines x where x.id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: budget line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  select * into s from pm.draw_schedules x where x.org_id = l.org_id and x.id = l.draw_schedule_id;
  if s.status <> 'ACTIVE' then raise exception 'PM_DRAW_SCHEDULE_NOT_ACTIVE: schedule is %', s.status using errcode = '22023'; end if;
  if p_revised_cents is null or p_revised_cents < 0 then raise exception 'PM_INVALID: amount must be ≥ 0' using errcode = '22023'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'PM_INVALID: a reason is required' using errcode = '22023'; end if;
  select coalesce(sum(coalesce(dl.approved_cents, dl.requested_cents)), 0) into v_drawn
  from pm.draw_lines dl join pm.draws d on d.org_id = dl.org_id and d.id = dl.draw_id
  where dl.org_id = l.org_id and dl.draw_budget_line_id = l.id and d.status in ('SUBMITTED','INSPECTION','APPROVED','FUNDED');
  if p_revised_cents < v_drawn then
    raise exception 'PM_INVALID: line % is already drawn to % cents', l.line_no, v_drawn using errcode = '22023';
  end if;
  insert into pm.draw_budget_revisions (org_id, job_id, draw_budget_line_id, from_cents, to_cents, reason, created_by)
  values (l.org_id, l.job_id, l.id, l.revised_cents, p_revised_cents, btrim(p_reason), pm.current_user_id());
  update pm.draw_budget_lines set revised_cents = p_revised_cents where id = p_line;
  select j.location_id into v_loc from core.jobs j where j.org_id = l.org_id and j.id = l.job_id;
  perform pm.log_activity(l.org_id, v_loc, l.job_id, 'draw_budget.revised', 'draw_budget_lines', p_line,
    format('Loan budget line %s %s: %s → %s cents', l.line_no, l.description, l.revised_cents, p_revised_cents),
    jsonb_build_object('from', l.revised_cents, 'to', p_revised_cents, 'reason', btrim(p_reason)));
  return p_line;
end $$;

create or replace function pm.create_draw(p_schedule uuid, p_period_end date)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.draw_schedules%rowtype; v_id uuid; v_no int; v_loc uuid;
begin
  select * into s from pm.draw_schedules x where x.id = p_schedule for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw schedule % not found in the caller''s organization', p_schedule using errcode = '42501';
  end if;
  if s.status <> 'ACTIVE' then raise exception 'PM_DRAW_SCHEDULE_NOT_ACTIVE: schedule is %', s.status using errcode = '22023'; end if;
  if p_period_end is null then raise exception 'PM_INVALID: period end is required' using errcode = '22023'; end if;
  if exists (select 1 from pm.draws d where d.org_id = s.org_id and d.draw_schedule_id = s.id
               and d.status in ('DRAFT','SUBMITTED','INSPECTION','APPROVED','RETURNED')) then
    raise exception 'PM_DRAW_OPEN: finish or cancel the open draw first' using errcode = '22023';
  end if;
  select coalesce(max(d.draw_number), 0) + 1 into v_no from pm.draws d where d.org_id = s.org_id and d.draw_schedule_id = s.id;
  insert into pm.draws (org_id, job_id, draw_schedule_id, draw_number, period_end, created_by)
  values (s.org_id, s.job_id, s.id, v_no, p_period_end, pm.current_user_id())
  returning id into v_id;
  select j.location_id into v_loc from core.jobs j where j.org_id = s.org_id and j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'draw.created', 'draws', v_id,
    format('Draw %s opened (period ending %s)', v_no, p_period_end), jsonb_build_object('draw_number', v_no));
  return v_id;
end $$;

-- DRAFT/RETURNED → SUBMITTED. Rejects any line whose cumulative request would exceed its revised
-- loan budget (reallocate first) and any retainage release above what the lender holds on the line.
create or replace function pm.submit_draw(p_draw uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; s pm.draw_schedules%rowtype; v_bad text; v_req bigint; v_loc uuid;
begin
  select * into d from pm.draws x where x.id = p_draw for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status not in ('DRAFT','RETURNED') then raise exception 'PM_DRAW_TRANSITION_INVALID: draw is %', d.status using errcode = '22023'; end if;
  select * into s from pm.draw_schedules x where x.org_id = d.org_id and x.id = d.draw_schedule_id;
  if s.status <> 'ACTIVE' then raise exception 'PM_DRAW_SCHEDULE_NOT_ACTIVE: schedule is %', s.status using errcode = '22023'; end if;
  if not exists (select 1 from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id
                   and (l.requested_cents > 0 or l.retainage_released_cents > 0)) then
    raise exception 'PM_INVALID: the draw has no amounts' using errcode = '22023';
  end if;

  select string_agg(format('line %s (%s requested, %s left)', bl.line_no, l.requested_cents, bl.revised_cents - coalesce(p.prior, 0)), '; ')
    into v_bad
  from pm.draw_lines l
  join pm.draw_budget_lines bl on bl.org_id = l.org_id and bl.id = l.draw_budget_line_id
  left join lateral (
    select sum(coalesce(pl.approved_cents, pl.requested_cents)) as prior
    from pm.draw_lines pl join pm.draws pd on pd.org_id = pl.org_id and pd.id = pl.draw_id
    where pl.org_id = l.org_id and pl.draw_budget_line_id = l.draw_budget_line_id and pd.id <> d.id
      and pd.status in ('SUBMITTED','INSPECTION','APPROVED','FUNDED')
  ) p on true
  where l.org_id = d.org_id and l.draw_id = d.id and coalesce(p.prior, 0) + l.requested_cents > bl.revised_cents;
  if v_bad is not null then
    raise exception 'PM_DRAW_OVER_BUDGET: %', v_bad using errcode = '22023';
  end if;

  select string_agg(format('line %s', bl.line_no), ', ') into v_bad
  from pm.draw_lines l
  join pm.draw_budget_lines bl on bl.org_id = l.org_id and bl.id = l.draw_budget_line_id
  left join lateral (
    select sum(pl.retainage_held_cents) - sum(pl.retainage_released_cents) as held
    from pm.draw_lines pl join pm.draws pd on pd.org_id = pl.org_id and pd.id = pl.draw_id
    where pl.org_id = l.org_id and pl.draw_budget_line_id = l.draw_budget_line_id and pd.id <> d.id and pd.status = 'FUNDED'
  ) h on true
  where l.org_id = d.org_id and l.draw_id = d.id and l.retainage_released_cents > coalesce(h.held, 0);
  if v_bad is not null then
    raise exception 'PM_RETAINAGE_RELEASE_EXCEEDS_HELD: %', v_bad using errcode = '22023';
  end if;

  select sum(l.requested_cents) into v_req from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id;
  update pm.draws
     set status = 'SUBMITTED', requested_cents = v_req, submitted_at = now(), submitted_by = pm.current_user_id(),
         inspection_status = case when s.requires_inspection then 'PENDING' else 'NOT_REQUIRED' end
   where id = p_draw;
  select j.location_id into v_loc from core.jobs j where j.org_id = d.org_id and j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'draw.submitted', 'draws', p_draw,
    format('Draw %s submitted to %s (%s cents)', d.draw_number, s.lender_name, v_req),
    jsonb_build_object('requested_cents', v_req, 'resubmitted', d.status = 'RETURNED'));
  return p_draw;
end $$;

create or replace function pm.record_draw_inspection(
  p_draw uuid, p_result text, p_pct_complete numeric default null, p_inspector text default null,
  p_inspected_on date default null, p_notes text default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v_loc uuid;
begin
  select * into d from pm.draws x where x.id = p_draw for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status not in ('SUBMITTED','INSPECTION') then
    raise exception 'PM_DRAW_TRANSITION_INVALID: draw is %', d.status using errcode = '22023';
  end if;
  if p_result not in ('PASSED','CONDITIONAL','FAILED') then
    raise exception 'PM_INVALID: inspection result must be PASSED, CONDITIONAL or FAILED' using errcode = '22023';
  end if;
  if p_pct_complete is not null and (p_pct_complete < 0 or p_pct_complete > 1) then
    raise exception 'PM_INVALID: percent complete must be 0..1' using errcode = '22023';
  end if;
  update pm.draws
     set status = 'INSPECTION', inspection_status = p_result, inspector_pct_complete = p_pct_complete,
         inspector_name = coalesce(p_inspector, inspector_name), inspected_on = coalesce(p_inspected_on, current_date),
         inspection_notes = coalesce(p_notes, inspection_notes)
   where id = p_draw;
  select j.location_id into v_loc from core.jobs j where j.org_id = d.org_id and j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'draw.inspected', 'draws', p_draw,
    format('Draw %s inspection %s%s', d.draw_number, lower(p_result),
           coalesce(format(' (%s%% complete)', round(p_pct_complete * 100, 1)), '')),
    jsonb_build_object('result', p_result, 'pct_complete', p_pct_complete, 'inspector', p_inspector));
  return p_draw;
end $$;

-- Lender approval. p_line_approvals: [{"line_id": uuid, "approved_cents": n}] for partial approvals;
-- lines not listed are approved as requested. Pins the draw's money (see header).
create or replace function pm.approve_draw(p_draw uuid, p_line_approvals jsonb default null, p_lender_approver text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  d          pm.draws%rowtype;
  s          pm.draw_schedules%rowtype;
  v_bad      text;
  v_appr     bigint;
  v_held     bigint;
  v_rel      bigint;
  v_net      bigint;
  v_eq_used  bigint;
  v_equity   bigint := 0;
  v_loan     bigint;
  v_funded   bigint;
  v_loc      uuid;
begin
  select * into d from pm.draws x where x.id = p_draw for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status not in ('SUBMITTED','INSPECTION') then
    raise exception 'PM_DRAW_TRANSITION_INVALID: draw is %', d.status using errcode = '22023';
  end if;
  select * into s from pm.draw_schedules x where x.org_id = d.org_id and x.id = d.draw_schedule_id for update;
  if s.requires_inspection and d.inspection_status not in ('PASSED','CONDITIONAL') then
    raise exception 'PM_DRAW_INSPECTION_REQUIRED: the lender inspection is %', lower(d.inspection_status) using errcode = '22023';
  end if;
  if p_line_approvals is not null and jsonb_typeof(p_line_approvals) <> 'array' then
    raise exception 'PM_INVALID: line approvals must be an array' using errcode = '22023';
  end if;

  select string_agg(coalesce(a ->> 'line_id', '?'), ', ') into v_bad
  from jsonb_array_elements(coalesce(p_line_approvals, '[]')) a
  left join pm.draw_lines l on l.org_id = d.org_id and l.draw_id = d.id and l.id::text = a ->> 'line_id'
  where l.id is null or jsonb_typeof(a -> 'approved_cents') <> 'number'
     or (a ->> 'approved_cents')::numeric < 0 or (a ->> 'approved_cents')::numeric > l.requested_cents
     or (a ->> 'approved_cents')::numeric % 1 <> 0;
  if v_bad is not null then
    raise exception 'PM_INVALID: line approvals must name lines of this draw with 0 ≤ approved ≤ requested (%)', v_bad using errcode = '22023';
  end if;

  update pm.draw_lines l
     set approved_cents = coalesce((select (a ->> 'approved_cents')::bigint from jsonb_array_elements(coalesce(p_line_approvals, '[]')) a
                                    where a ->> 'line_id' = l.id::text limit 1), l.requested_cents)
   where l.org_id = d.org_id and l.draw_id = d.id;
  update pm.draw_lines l
     set retainage_held_cents = case when bl.retainage_applies then round(l.approved_cents * s.retainage_pct)::bigint else 0 end
    from pm.draw_budget_lines bl
   where l.org_id = d.org_id and l.draw_id = d.id and bl.org_id = l.org_id and bl.id = l.draw_budget_line_id;

  select coalesce(sum(l.approved_cents), 0), coalesce(sum(l.retainage_held_cents), 0), coalesce(sum(l.retainage_released_cents), 0)
    into v_appr, v_held, v_rel
  from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id;
  v_net := v_appr - v_held + v_rel;

  if s.equity_first then
    select coalesce(sum(x.equity_applied_cents), 0) into v_eq_used from pm.draws x
    where x.org_id = d.org_id and x.draw_schedule_id = s.id and x.id <> d.id and x.status in ('APPROVED','FUNDED');
    v_equity := least(greatest(s.equity_required_cents - v_eq_used, 0), greatest(v_net, 0));
  end if;
  v_loan := v_net - v_equity;

  select coalesce(sum(coalesce(x.funded_cents, x.loan_expected_cents)), 0) into v_funded from pm.draws x
  where x.org_id = d.org_id and x.draw_schedule_id = s.id and x.id <> d.id and x.status in ('APPROVED','FUNDED');
  if v_funded + v_loan > s.loan_commitment_cents then
    raise exception 'PM_DRAW_EXCEEDS_LOAN: % cents requested from the loan, % cents undisbursed', v_loan, s.loan_commitment_cents - v_funded
      using errcode = '22023';
  end if;

  update pm.draws
     set status = 'APPROVED', approved_cents = v_appr, retainage_held_cents = v_held, retainage_released_cents = v_rel,
         equity_applied_cents = v_equity, loan_expected_cents = v_loan, approved_at = now(), approved_by = pm.current_user_id(),
         lender_approver_name = coalesce(p_lender_approver, lender_approver_name)
   where id = p_draw;
  select j.location_id into v_loc from core.jobs j where j.org_id = d.org_id and j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'draw.approved', 'draws', p_draw,
    format('Draw %s approved by %s: %s gross, %s retainage held, %s equity, %s loan', d.draw_number, s.lender_name,
           v_appr, v_held, v_equity, v_loan),
    jsonb_build_object('approved_cents', v_appr, 'retainage_held_cents', v_held, 'retainage_released_cents', v_rel,
                       'equity_applied_cents', v_equity, 'loan_expected_cents', v_loan, 'requested_cents', d.requested_cents));
  return p_draw;
end $$;

-- Records the lender's wire (operational). Books records the cash and the lender receivable.
create or replace function pm.fund_draw(p_draw uuid, p_funded_on date default null, p_wire_ref text default null,
                                        p_funded_cents bigint default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v_amt bigint; v_loc uuid;
begin
  select * into d from pm.draws x where x.id = p_draw for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status <> 'APPROVED' then raise exception 'PM_DRAW_TRANSITION_INVALID: draw is % (approve it first)', d.status using errcode = '22023'; end if;
  v_amt := coalesce(p_funded_cents, d.loan_expected_cents);
  if v_amt < 0 or v_amt > d.loan_expected_cents then
    raise exception 'PM_INVALID: funded amount must be 0..% cents (the approved loan amount)', d.loan_expected_cents using errcode = '22023';
  end if;
  update pm.draws set status = 'FUNDED', funded_cents = v_amt, funded_at = now(), funded_on = coalesce(p_funded_on, current_date),
         wire_ref = coalesce(p_wire_ref, wire_ref)
   where id = p_draw;
  select j.location_id into v_loc from core.jobs j where j.org_id = d.org_id and j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'draw.funded', 'draws', p_draw,
    format('Draw %s funded: %s cents', d.draw_number, v_amt),
    jsonb_build_object('funded_cents', v_amt, 'loan_expected_cents', d.loan_expected_cents, 'wire_ref', p_wire_ref,
                       'cycle_days', round((extract(epoch from (now() - d.submitted_at)) / 86400)::numeric, 2)));
  return p_draw;
end $$;

create or replace function pm.return_draw(p_draw uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v_loc uuid;
begin
  select * into d from pm.draws x where x.id = p_draw for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status not in ('SUBMITTED','INSPECTION') then raise exception 'PM_DRAW_TRANSITION_INVALID: draw is %', d.status using errcode = '22023'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'PM_INVALID: a reason is required' using errcode = '22023'; end if;
  update pm.draws set status = 'RETURNED', returned_at = now(), returned_reason = btrim(p_reason) where id = p_draw;
  select j.location_id into v_loc from core.jobs j where j.org_id = d.org_id and j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'draw.returned', 'draws', p_draw,
    format('Draw %s returned for correction: %s', d.draw_number, btrim(p_reason)), jsonb_build_object('reason', btrim(p_reason)));
  return p_draw;
end $$;

create or replace function pm.cancel_draw(p_draw uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v_loc uuid;
begin
  select * into d from pm.draws x where x.id = p_draw for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status not in ('DRAFT','RETURNED') then raise exception 'PM_DRAW_TRANSITION_INVALID: draw is %', d.status using errcode = '22023'; end if;
  update pm.draws set status = 'CANCELLED', cancelled_at = now(), notes = coalesce(p_reason, notes) where id = p_draw;
  select j.location_id into v_loc from core.jobs j where j.org_id = d.org_id and j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'draw.cancelled', 'draws', p_draw,
    format('Draw %s cancelled', d.draw_number), jsonb_build_object('reason', p_reason));
  return p_draw;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Views (security_invoker)
-- ----------------------------------------------------------------------------
-- Continuation sheet (G703-style) per loan-budget line. "Drawn" = approved gross on FUNDED draws.
create or replace view pm.v_draw_line_status with (security_invoker = on) as
select bl.org_id, j.location_id, bl.job_id, bl.draw_schedule_id, bl.id as draw_budget_line_id, bl.line_no, bl.description,
       bl.category, bl.cost_code_id, bl.original_cents, bl.revised_cents,
       coalesce(x.drawn_cents, 0)::bigint                                   as drawn_cents,
       coalesce(x.open_requested_cents, 0)::bigint                          as open_request_cents,
       (bl.revised_cents - coalesce(x.drawn_cents, 0) - coalesce(x.open_requested_cents, 0))::bigint as remaining_cents,
       case when bl.revised_cents > 0 then round(coalesce(x.drawn_cents, 0)::numeric / bl.revised_cents, 4) end as pct_drawn,
       coalesce(x.held_cents, 0)::bigint - coalesce(x.released_cents, 0)::bigint as retainage_held_cents
from pm.draw_budget_lines bl
join core.jobs j on j.org_id = bl.org_id and j.id = bl.job_id
left join lateral (
  select sum(dl.approved_cents) filter (where d.status = 'FUNDED')                               as drawn_cents,
         sum(coalesce(dl.approved_cents, dl.requested_cents)) filter (where d.status in ('DRAFT','SUBMITTED','INSPECTION','APPROVED','RETURNED')) as open_requested_cents,
         sum(dl.retainage_held_cents) filter (where d.status = 'FUNDED')                         as held_cents,
         sum(dl.retainage_released_cents) filter (where d.status = 'FUNDED')                     as released_cents
  from pm.draw_lines dl join pm.draws d on d.org_id = dl.org_id and d.id = dl.draw_id
  where dl.org_id = bl.org_id and dl.draw_budget_line_id = bl.id
) x on true;

-- Sources and uses / in-balance test per loan, plus interest reserve runway and contingency burn.
create or replace view pm.v_draw_schedule_status with (security_invoker = on) as
with lines as (
  select ls.org_id, ls.draw_schedule_id, ls.category, ls.original_cents, ls.revised_cents, ls.drawn_cents, ls.retainage_held_cents
  from pm.v_draw_line_status ls
),
agg as (
  select org_id, draw_schedule_id,
         sum(original_cents)                                                    as original_budget_cents,
         sum(revised_cents)                                                     as revised_budget_cents,
         sum(drawn_cents)                                                       as drawn_gross_cents,
         sum(retainage_held_cents)                                              as retainage_held_cents,
         sum(greatest(revised_cents - drawn_cents, 0))                          as remaining_budget_cents,
         sum(revised_cents) filter (where category = 'INTEREST_RESERVE')        as reserve_budget_cents,
         sum(drawn_cents) filter (where category = 'INTEREST_RESERVE')          as reserve_used_cents,
         sum(original_cents) filter (where category = 'CONTINGENCY')            as contingency_original_cents,
         sum(revised_cents) filter (where category = 'CONTINGENCY')             as contingency_revised_cents,
         sum(drawn_cents) filter (where category = 'CONTINGENCY')               as contingency_drawn_cents,
         sum(revised_cents) filter (where category = 'HARD')                    as hard_revised_cents,
         sum(drawn_cents) filter (where category = 'HARD')                      as hard_drawn_cents
  from lines group by org_id, draw_schedule_id
),
fund as (
  select d.org_id, d.draw_schedule_id,
         coalesce(sum(d.funded_cents) filter (where d.status = 'FUNDED'), 0)          as loan_funded_cents,
         coalesce(sum(d.equity_applied_cents) filter (where d.status = 'FUNDED'), 0)  as equity_applied_cents,
         count(*) filter (where d.status = 'FUNDED')                                  as funded_draws,
         max(d.funded_on)                                                             as last_funded_on
  from pm.draws d group by d.org_id, d.draw_schedule_id
),
base as (
  select s.org_id, j.location_id, s.job_id, s.id as draw_schedule_id, s.lender_name, s.loan_number, s.status,
         s.loan_commitment_cents, s.equity_required_cents, s.interest_rate, s.projected_monthly_interest_cents,
         coalesce(f.loan_funded_cents, 0)                                   as loan_funded_cents,
         coalesce(f.equity_applied_cents, 0)                                as equity_contributed_cents,
         coalesce(f.funded_draws, 0)                                        as funded_draws,
         f.last_funded_on,
         coalesce(a.original_budget_cents, 0)                               as original_budget_cents,
         coalesce(a.revised_budget_cents, 0)                                as revised_budget_cents,
         coalesce(a.drawn_gross_cents, 0)                                   as drawn_gross_cents,
         coalesce(a.retainage_held_cents, 0)                                as retainage_held_cents,
         coalesce(a.remaining_budget_cents, 0) + coalesce(a.retainage_held_cents, 0) as cost_to_complete_cents,
         coalesce(a.reserve_budget_cents, s.interest_reserve_cents)         as interest_reserve_cents,
         coalesce(a.reserve_used_cents, 0)                                  as interest_reserve_used_cents,
         a.contingency_original_cents, a.contingency_revised_cents, a.contingency_drawn_cents,
         a.hard_revised_cents, a.hard_drawn_cents
  from pm.draw_schedules s
  join core.jobs j on j.org_id = s.org_id and j.id = s.job_id
  left join agg a on a.org_id = s.org_id and a.draw_schedule_id = s.id
  left join fund f on f.org_id = s.org_id and f.draw_schedule_id = s.id
)
select b.*,
       (b.loan_commitment_cents - b.loan_funded_cents)::bigint                            as loan_remaining_cents,
       greatest(b.equity_required_cents - b.equity_contributed_cents, 0)::bigint          as equity_remaining_cents,
       (b.cost_to_complete_cents - (b.loan_commitment_cents - b.loan_funded_cents)
          - greatest(b.equity_required_cents - b.equity_contributed_cents, 0))::bigint    as in_balance_gap_cents,
       (b.interest_reserve_cents - b.interest_reserve_used_cents)::bigint                 as interest_reserve_remaining_cents,
       coalesce(b.projected_monthly_interest_cents, round(b.loan_funded_cents * coalesce(b.interest_rate, 0) / 12))::bigint
                                                                                          as monthly_interest_cents,
       case when coalesce(b.projected_monthly_interest_cents, round(b.loan_funded_cents * coalesce(b.interest_rate, 0) / 12)) > 0
            then round((b.interest_reserve_cents - b.interest_reserve_used_cents)::numeric
                       / coalesce(b.projected_monthly_interest_cents, round(b.loan_funded_cents * coalesce(b.interest_rate, 0) / 12)), 2)
       end                                                                                as interest_reserve_months,
       case when coalesce(b.contingency_original_cents, 0) > 0 and coalesce(b.hard_revised_cents, 0) > 0
                 and coalesce(b.hard_drawn_cents, 0) > 0
            then round(((b.contingency_original_cents - b.contingency_revised_cents + coalesce(b.contingency_drawn_cents, 0))::numeric
                        / b.contingency_original_cents)
                       / (b.hard_drawn_cents::numeric / b.hard_revised_cents), 4)
       end                                                                                as contingency_burn_ratio
from base b;

-- Draw register with the package checklist gaps (Rabbet canon keys; informational, not a gate).
create or replace view pm.v_draw_summary with (security_invoker = on) as
select d.org_id, j.location_id, d.job_id, d.draw_schedule_id, d.id as draw_id, d.draw_number, d.period_end, d.status,
       d.inspection_status, d.inspector_pct_complete,
       coalesce(t.requested_cents, 0)::bigint as lines_requested_cents, d.requested_cents, d.approved_cents,
       d.retainage_held_cents, d.retainage_released_cents, d.equity_applied_cents, d.loan_expected_cents, d.funded_cents,
       d.submitted_at, d.approved_at, d.funded_at, d.funded_on,
       case when d.funded_at is not null and d.submitted_at is not null
            then round((extract(epoch from (d.funded_at - d.submitted_at)) / 86400)::numeric, 2) end as cycle_days,
       array(select k from unnest(array['cover_letter','draw_summary','pay_applications','invoices','change_order_log',
                                        'lien_waivers_conditional','lien_waivers_unconditional_prior','insurance_certificates',
                                        'inspection_report','title_update','interest_reserve_statement']) k
             where (d.package ->> k) is distinct from 'true') as package_missing,
       d.billing_request_id
from pm.draws d
join core.jobs j on j.org_id = d.org_id and j.id = d.job_id
left join lateral (select sum(l.requested_cents) as requested_cents from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id) t on true;

create or replace view pm.v_entitlement_status with (security_invoker = on) as
select e.org_id, j.location_id, e.job_id, e.id as entitlement_id, e.unit_id, e.kind, e.name, e.authority, e.status,
       e.target_on, e.submitted_on, e.hearing_on, e.approved_on, e.expires_on,
       (e.status not in ('APPROVED','APPROVED_WITH_CONDITIONS','WITHDRAWN','EXPIRED') and e.target_on < current_date) as is_late,
       (e.status in ('APPROVED','APPROVED_WITH_CONDITIONS') and e.expires_on is not null and e.expires_on <= current_date + 60) as expiring_soon
from pm.entitlements e
join core.jobs j on j.org_id = e.org_id and j.id = e.job_id;

-- ---------------------------------------------------------------------------
-- KPIs (job_id set = per development project; null = company roll-up)
--   draw_cycle_days          median days submitted_at → funded_at, draws funded in the trailing 365d (company and job)
--   in_balance_gap_cents     Σ over ACTIVE loans of the job: cost to complete − remaining loan − remaining equity (> 0 = out of balance)
--   interest_reserve_months  Σ reserve remaining ÷ Σ monthly interest (projected, else funded × rate ÷ 12), ACTIVE loans
--   contingency_burn_ratio   (contingency reallocated + drawn ÷ original contingency) ÷ (hard drawn ÷ hard revised)
-- ---------------------------------------------------------------------------
create or replace view pm.v_kpis_development with (security_invoker = on) as
with cyc as (
  select d.org_id, j.location_id, d.job_id, extract(epoch from (d.funded_at - d.submitted_at)) / 86400 as days
  from pm.draws d join core.jobs j on j.org_id = d.org_id and j.id = d.job_id
  where d.status = 'FUNDED' and d.funded_at >= now() - interval '365 days' and d.submitted_at is not null
)
select org_id, location_id, null::uuid as job_id, 'draw_cycle_days'::text as metric,
       round((percentile_cont(0.5) within group (order by days))::numeric, 2) as value, current_date as as_of,
       'draws funded in trailing 365d'::text as basis, count(*)::int as sample_n
from cyc group by org_id, location_id
union all
select org_id, location_id, job_id, 'draw_cycle_days', round((percentile_cont(0.5) within group (order by days))::numeric, 2),
       current_date, 'draws funded in trailing 365d', count(*)::int
from cyc group by org_id, location_id, job_id
union all
select org_id, location_id, job_id, 'in_balance_gap_cents', sum(in_balance_gap_cents)::numeric, current_date,
       'draw schedules: cost to complete − undisbursed loan − remaining equity', count(*)::int
from pm.v_draw_schedule_status where status = 'ACTIVE' group by org_id, location_id, job_id
union all
select org_id, location_id, job_id, 'interest_reserve_months',
       round(sum(interest_reserve_remaining_cents)::numeric / sum(monthly_interest_cents), 2), current_date,
       'interest reserve remaining ÷ projected monthly interest', count(*)::int
from pm.v_draw_schedule_status where status = 'ACTIVE' and monthly_interest_cents > 0
group by org_id, location_id, job_id
union all
select org_id, location_id, job_id, 'contingency_burn_ratio', max(contingency_burn_ratio), current_date,
       'loan budget: contingency used share ÷ hard cost drawn share', count(*)::int
from pm.v_draw_schedule_status where status = 'ACTIVE' and contingency_burn_ratio is not null
group by org_id, location_id, job_id;

-- One long KPI table across the industry modules (1104–1107). Metric keys = packages/industry-packs/src/metrics.ts.
create or replace view pm.v_kpis with (security_invoker = on) as
select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_field_service
union all select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_production
union all select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_selections
union all select org_id, location_id, job_id, metric, value, as_of, basis, sample_n from pm.v_kpis_development;

-- ----------------------------------------------------------------------------
-- 8. RLS
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['units','entitlements','draw_schedules','draw_budget_lines','draw_budget_revisions','draws','draw_lines'] loop
    execute format('alter table pm.%I enable row level security', t);
  end loop;
  foreach t in array array['draw_budget_lines','draw_budget_revisions','draws','draw_lines'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='units' and policyname='org_select') then
    create policy org_select on pm.units for select using (org_id = public.get_org_id());
    create policy presale_insert on pm.units for insert
      with check (org_id = public.get_org_id() and status in ('PLANNED','ENTITLED','AVAILABLE','UNDER_CONSTRUCTION','COMPLETE','HELD')
                  and buyer_customer_id is null and contract_on is null and closed_on is null);
    create policy org_update on pm.units for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy planned_delete on pm.units for delete using (org_id = public.get_org_id() and status in ('PLANNED','ENTITLED'));
  end if;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='entitlements' and policyname='org_select') then
    create policy org_select on pm.entitlements for select using (org_id = public.get_org_id());
    create policy early_insert on pm.entitlements for insert
      with check (org_id = public.get_org_id() and status in ('NOT_STARTED','IN_PREP') and approved_on is null and submitted_on is null);
    create policy org_update on pm.entitlements for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
    create policy early_delete on pm.entitlements for delete using (org_id = public.get_org_id() and status in ('NOT_STARTED','IN_PREP','WITHDRAWN'));
  end if;

  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='draw_schedules' and policyname='org_select') then
    create policy org_select on pm.draw_schedules for select using (org_id = public.get_org_id());
    create policy draft_insert on pm.draw_schedules for insert
      with check (org_id = public.get_org_id() and status = 'DRAFT' and activated_at is null and closed_at is null);
    create policy draft_update on pm.draw_schedules for update using (org_id = public.get_org_id() and status = 'DRAFT')
      with check (org_id = public.get_org_id() and status = 'DRAFT');
    create policy draft_delete on pm.draw_schedules for delete using (org_id = public.get_org_id() and status = 'DRAFT');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Grants
-- ----------------------------------------------------------------------------
revoke all on pm.units, pm.entitlements, pm.draw_schedules, pm.draw_budget_lines, pm.draw_budget_revisions, pm.draws, pm.draw_lines
  from public, anon, authenticated;
grant select, insert, update, delete on pm.units, pm.entitlements, pm.draw_schedules, pm.draw_budget_lines,
  pm.draw_budget_revisions, pm.draws, pm.draw_lines to service_role;

grant select, insert, delete on pm.units to authenticated;
grant update (wbs_id, child_job_id, unit_number, unit_kind, phase, plan_name, sqft, list_price_cents, lender_release_price_cents,
              est_close_on, notes, sort)
  on pm.units to authenticated;
grant select, insert, delete on pm.entitlements to authenticated;
grant update (unit_id, kind, name, authority, reference_number, target_on, expires_on, conditions, sort)
  on pm.entitlements to authenticated;
grant select, insert, delete on pm.draw_schedules to authenticated;
grant update (lender_name, lender_customer_id, loan_number, loan_commitment_cents, equity_required_cents, interest_reserve_cents,
              interest_rate, projected_monthly_interest_cents, retainage_pct, requires_inspection, equity_first, loan_closed_on,
              maturity_on, notes)
  on pm.draw_schedules to authenticated;
-- loan terms are editable only while the schedule is DRAFT (RLS draft_update)
grant select, insert, update, delete on pm.draw_budget_lines to authenticated;
grant select on pm.draw_budget_revisions to authenticated;
grant select on pm.draws to authenticated;
grant update (period_end, package, notes) on pm.draws to authenticated;
grant select, insert, delete on pm.draw_lines to authenticated;
grant update (draw_budget_line_id, requested_cents, retainage_released_cents, notes) on pm.draw_lines to authenticated;

grant select on pm.v_draw_line_status, pm.v_draw_schedule_status, pm.v_draw_summary, pm.v_entitlement_status,
                pm.v_kpis_development, pm.v_kpis
  to authenticated, service_role;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm' and p.proname in (
             'tg_draw_budget_line','tg_draw_line','tg_draw_lock','set_unit_status','record_entitlement_status',
             'activate_draw_schedule','revise_draw_budget_line','create_draw','submit_draw','record_draw_inspection',
             'approve_draw','fund_draw','return_draw','cancel_draw') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname not like 'tg\_%' then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1107_pm_development
-- ============================================================================
