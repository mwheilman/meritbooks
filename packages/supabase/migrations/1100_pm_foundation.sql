-- ============================================================================
-- 1100 · Merit Projects v2 — `pm` foundation
--
-- Binding inputs: docs/projects/MERIT-PROJECTS-V2-BLUEPRINT.md (D1–D12, §5, §6),
-- review 05 (schema teardown §4), review 03 (money seam), and the plan contract in
-- packages/industry-packs/src/types.ts (WorkspacePlan, GUARDS, CORE_JOB_STATUSES).
--
-- What this migration creates
--   * schema `pm` with a clean grant baseline (no PUBLIC/anon EXECUTE, no anon USAGE)
--   * shared-spine additive on core: unique index core.jobs(org_id, id) for composite FKs
--   * pack layer: pack_registry, pack_installs, pack_overrides
--   * materialized pack config: job_types, stage_defs, stage_transitions,
--     approval_policies, field_defs, cost_codes, price_book_items, kpi_defs
--     (vocabulary stays in pack_installs.resolved, exposed as pm.v_vocabulary)
--   * onboarding_runs, doc_counters
--   * job spine: projects, wbs_nodes, tasks, task_deps, budgets, budget_lines, contracts,
--     change_orders, progress_snapshots, field_logs, punch_items, time_entries,
--     document_links, activity
--   * guard predicates pm.guard_<name>(uuid) for every GUARDS entry + pm.check_guards
--   * definer functions: apply_pack_plan, create_project, transition_stage,
--     emit_job_progress, books_present, set_contract, set_progress,
--     approve_change_order, advance_change_order, load_sample_job, remove_sample_data
--   * views: v_job_money, v_project_list, v_job_overview, v_vocabulary
--
-- Boundaries (D7 / §5):
--   * Never writes core.organizations (Books/Core own it; 154 locks it).
--   * Writes core.jobs ONLY for identity on create (org, location, job_number, name,
--     customer_id, customer_name, archetype, description/external_* for samples) and
--     `status` via stage transitions. Never the Books-owned money/rev-rec columns —
--     those move through JOB_PROGRESS.
--   * core.jobs.job_type is left NULL: its CHECK is the legacy construction/HVAC list
--     that keys Books' legacy rev-rec map; packs never widen or pick it (review 05 risk 8).
--   * Inserts JOB_PROGRESS into core.events (source_module 'PROJECTS', uppercase).
--
-- Does NOT alter pgrst.db_schemas (lead adds `pm`). Idempotent: safe to run twice.
-- 1101+ replace the placeholder guards (create or replace) when their tables land.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Schema + grant baseline
-- ----------------------------------------------------------------------------
create schema if not exists pm;
comment on schema pm is 'Merit Projects v2 (Projects-owned; blueprint D1). Legacy proj stays read-only until cutover.';

revoke all on schema pm from public;
revoke all on schema pm from anon;
grant usage on schema pm to authenticated, service_role;

alter default privileges in schema pm revoke execute on functions from public;
alter default privileges in schema pm revoke execute on functions from anon;

-- ----------------------------------------------------------------------------
-- 1. Shared spine (Projects-authored, additive; 120 is the precedent for a
--    Projects-authored file touching core). Needed so every pm table can carry a
--    composite FK (org_id, job_id) -> core.jobs(org_id, id), which makes a
--    cross-org job_id un-insertable even for a trusted client (review 05 §4.1.4).
-- ----------------------------------------------------------------------------
create unique index if not exists core_jobs_org_id_id_uidx on core.jobs (org_id, id);
comment on index core.core_jobs_org_id_id_uidx is
  'Shared spine (authored by Merit Projects, migration 1100): target of composite FKs (org_id, job_id) from schema pm.';

-- ----------------------------------------------------------------------------
-- 2. Small helpers
-- ----------------------------------------------------------------------------

-- Caller's Clerk user id (JWT `sub`), or null. Invoker; used in defaults/policies.
create or replace function pm.current_user_id() returns text
language sql stable
set search_path = pm, public
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')
$$;

-- The closed guard vocabulary (mirror of GUARDS in packages/industry-packs/src/types.ts).
create or replace function pm.guard_names() returns text[]
language sql immutable
as $$
  select array['has_customer','has_contract_value','has_budget','estimate_accepted',
               'deposit_requested','selections_approved','no_open_change_orders',
               'punch_complete','final_billed','compliance_current','work_orders_closed',
               'production_complete']::text[]
$$;

create or replace function pm.tg_touch_updated_at() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Client-originated rows: created_by is always the caller (never spoofable; the
-- preparer != approver rule depends on it). Definer-originated rows keep the value
-- the function set.
create or replace function pm.tg_stamp_created_by() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.created_by := pm.current_user_id();
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end $$;

-- location_id (when present) must belong to the row's org. Definer: reads core.locations
-- regardless of the caller's RLS.
create or replace function pm.tg_location_in_org() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.location_id is not null and not exists (
       select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'PM_LOCATION_ORG_MISMATCH: location % is not in org %', new.location_id, new.org_id
      using errcode = '23503';
  end if;
  return new;
end $$;

-- Gapless-per-scope document counter (job numbers, CO numbers). Internal only.
create table if not exists pm.doc_counters (
  org_id      uuid not null references core.organizations(id) on delete cascade,
  scope       text not null,          -- location uuid text, or 'org'
  kind        text not null,          -- 'JOB' | 'CO' | ...
  period      text not null,          -- e.g. '2026'
  last_value  bigint not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (org_id, scope, kind, period)
);

create or replace function pm.next_doc_number(p_org uuid, p_scope text, p_kind text, p_period text)
returns bigint
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v bigint;
begin
  insert into pm.doc_counters (org_id, scope, kind, period, last_value)
  values (p_org, p_scope, p_kind, p_period, 0)
  on conflict do nothing;

  select c.last_value + 1 into v
  from pm.doc_counters c
  where c.org_id = p_org and c.scope = p_scope and c.kind = p_kind and c.period = p_period
  for update;

  update pm.doc_counters set last_value = v, updated_at = now()
  where org_id = p_org and scope = p_scope and kind = p_kind and period = p_period;
  return v;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Pack layer
-- ----------------------------------------------------------------------------

-- Global catalog of published manifests (no org_id: Merit-published, D3).
-- Service-role writes only; members read. No FK from installs: the TS compiler is the
-- authority for manifests and the registry is filled by the publishing pipeline.
create table if not exists pm.pack_registry (
  pack_key         text not null check (pack_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  version          text not null check (version ~ '^\d+\.\d+\.\d+$'),
  extends_key      text,
  extends_version  text,
  name             text not null,
  manifest         jsonb not null,
  manifest_sha256  text not null,
  status           text not null default 'PUBLISHED' check (status in ('DRAFT','PUBLISHED','DEPRECATED')),
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  primary key (pack_key, version)
);

create table if not exists pm.pack_installs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  pack_key        text not null check (pack_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  pack_version    text not null check (pack_version ~ '^\d+\.\d+\.\d+$'),
  role            text not null check (role in ('primary','addon')),
  resolved        jsonb not null,               -- the applied WorkspacePlan (vocabulary, modules, sample_job, ...)
  plan_hash       text not null,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE','UPGRADING','RETIRED')),
  ai_decision_id  uuid,                         -- core ai_decisions row that proposed it (if any)
  installed_by    text,
  installed_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, location_id, pack_key),
  unique (org_id, id)
);
create unique index if not exists pm_pack_installs_one_primary_uidx
  on pm.pack_installs (org_id, location_id) where role = 'primary' and status = 'ACTIVE';

-- Tenant override deltas (RFC 6901 pointers), consumed by the TS compiler on re-plan.
create table if not exists pm.pack_overrides (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  install_id    uuid not null,
  json_pointer  text not null check (json_pointer ~ '^(/([^~/]|~[01])*)+$'),
  op            text not null check (op in ('add','replace','remove')),
  value         jsonb,
  reason        text,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) on delete cascade deferrable initially immediate,
  check (op = 'remove' or value is not null)
);
create index if not exists pm_pack_overrides_install_idx on pm.pack_overrides (org_id, install_id);

-- ----------------------------------------------------------------------------
-- 4. Materialized pack config (written only by pm.apply_pack_plan)
-- ----------------------------------------------------------------------------
create table if not exists pm.job_types (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  install_id            uuid not null,
  key                   text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label                 text not null,
  archetype             text not null check (archetype in
                          ('project','field_service','eto','retail_order','engagement',
                           'recurring_service','development','dealer_service')),
  billing_modes         text[] not null check (cardinality(billing_modes) >= 1 and billing_modes <@
                          array['FIXED','PROGRESS_PCT','SOV','MILESTONE','TIME_MATERIALS','DRAW','DEPOSIT','RECURRING']::text[]),
  default_billing_mode  text not null check (default_billing_mode in
                          ('FIXED','PROGRESS_PCT','SOV','MILESTONE','TIME_MATERIALS','DRAW','DEPOSIT','RECURRING')),
  progress_basis        text not null default 'NONE' check (progress_basis in
                          ('NONE','COST_TO_COST','PHYSICAL_PCT','UNITS','MILESTONES')),
  stage_machine_key     text not null,
  rev_rec_hint          text check (rev_rec_hint is null or rev_rec_hint in
                          ('PCT_COSTS_INCURRED','PCT_COMPLETE','COMPLETED_CONTRACT','MILESTONE',
                           'AS_BILLED','RATABLY','SUBSCRIPTION','POINT_IN_TIME')),  -- HINT only; Books owns the method
  modules               jsonb not null default '{}' check (jsonb_typeof(modules) = 'object'),
  default_retainage_pct numeric(5,4) check (default_retainage_pct is null or (default_retainage_pct >= 0 and default_retainage_pct <= 0.2)),
  sort                  int not null default 0,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (default_billing_mode = any (billing_modes)),
  unique (org_id, location_id, key),
  unique (org_id, id),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);

create table if not exists pm.stage_defs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  install_id   uuid not null,
  machine_key  text not null,
  stage_key    text not null check (stage_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label        text not null,
  sort         int not null default 0,
  core_status  text not null check (core_status in ('BID','ACTIVE','ON_HOLD','COMPLETE','CLOSED','CANCELLED')),
  is_terminal  boolean not null default false,
  is_initial   boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, machine_key, stage_key),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_stage_defs_one_initial_uidx
  on pm.stage_defs (org_id, location_id, machine_key) where is_initial and is_active;

create table if not exists pm.stage_transitions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  install_id           uuid not null,
  machine_key          text not null,
  from_stage           text not null,
  to_stage             text not null,
  -- closed vocabulary (D10): packs select and order guards, never inject expressions
  guards               text[] not null default '{}' check (guards <@ array[
                         'has_customer','has_contract_value','has_budget','estimate_accepted',
                         'deposit_requested','selections_approved','no_open_change_orders',
                         'punch_complete','final_billed','compliance_current','work_orders_closed',
                         'production_complete']::text[]),
  approval_policy_key  text,
  sort                 int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (from_stage <> to_stage),
  unique (org_id, location_id, machine_key, from_stage, to_stage),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate,
  foreign key (org_id, location_id, machine_key, from_stage)
    references pm.stage_defs (org_id, location_id, machine_key, stage_key) deferrable initially immediate,
  foreign key (org_id, location_id, machine_key, to_stage)
    references pm.stage_defs (org_id, location_id, machine_key, stage_key) deferrable initially immediate
);

create table if not exists pm.approval_policies (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  install_id   uuid not null,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label        text not null,
  tiers        jsonb not null check (jsonb_typeof(tiers) = 'array' and jsonb_array_length(tiers) >= 1),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, key),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);

create table if not exists pm.field_defs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  install_id    uuid,                         -- null = tenant-defined field
  object_type   text not null check (object_type in
                  ('project','task','work_order','asset','selection','field_log','commitment')),
  job_type_key  text,                         -- null = all job types
  field_key     text not null check (field_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label         text not null,
  data_type     text not null check (data_type in ('text','number','integer','date','bool','enum','money_cents')),
  options       jsonb check (options is null or jsonb_typeof(options) = 'array'),
  required      boolean not null default false,
  promote       boolean not null default false,
  source        text not null default 'TENANT' check (source in ('PACK','TENANT')),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (data_type <> 'enum' or (options is not null and jsonb_array_length(options) >= 1)),
  check ((source = 'PACK') = (install_id is not null)),
  constraint field_defs_scope_key unique nulls not distinct (org_id, location_id, object_type, job_type_key, field_key),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);

-- Cost codes: job_id null = company library (seeded from the pack); job_id set = job-specific.
create table if not exists pm.cost_codes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  job_id        uuid,
  parent_id     uuid,
  code          text not null check (char_length(code) between 1 and 24),
  name          text not null check (char_length(name) between 1 and 80),
  cost_type     text not null check (cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  role_hint     text check (role_hint is null or role_hint in
                  ('DIRECT_LABOR_COST','MATERIALS_COST','SUBCONTRACT_COST','EQUIPMENT_COST','OTHER_JOB_COST',
                   'PERMITS_FEES_COST','FREIGHT_COST','DESIGN_FEE_REVENUE','SERVICE_REVENUE','CONTRACT_REVENUE',
                   'PRODUCT_REVENUE','WARRANTY_COST','LAND_COST','SOFT_COST')),   -- account ROLE, never a number
  install_id    uuid,                         -- set when the pack owns it
  source_pack   text,
  sort          int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint cost_codes_scope_code_key unique nulls not distinct (org_id, location_id, job_id, code),
  unique (org_id, id),
  check (parent_id is null or parent_id <> id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, parent_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);
create index if not exists pm_cost_codes_job_idx on pm.cost_codes (org_id, job_id) where job_id is not null;

create table if not exists pm.price_book_items (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  install_id     uuid,
  item_id        uuid,                        -- optional link to core.items (identity only; price lives here)
  code           text not null check (char_length(code) between 1 and 24),
  name           text not null,
  unit           text not null default 'EA',
  price_cents    bigint not null default 0 check (price_cents >= 0),
  cost_cents     bigint check (cost_cents is null or cost_cents >= 0),
  labor_minutes  int check (labor_minutes is null or labor_minutes >= 0),
  cost_code_id   uuid,
  ext            jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, location_id, code),
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);

create table if not exists pm.kpi_defs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  install_id      uuid not null,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label           text not null,
  metric          text not null,
  good_direction  text not null check (good_direction in ('up','down')),
  sort            int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, location_id, key),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- 5. Onboarding runs (per company; resumable)
-- ----------------------------------------------------------------------------
create table if not exists pm.onboarding_runs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid references core.locations(id),
  status          text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS','APPLIED','COMPLETE','ABANDONED')),
  step            text not null default 'describe' check (step in ('describe','preview','bring_work','team','done')),
  inputs          jsonb not null default '{}' check (jsonb_typeof(inputs) = 'object'),
  classification  jsonb,
  plan            jsonb,
  install_id      uuid,
  ai_decision_id  uuid,
  created_by      text default pm.current_user_id(),
  applied_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (org_id, install_id) references pm.pack_installs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_onboarding_runs_open_uidx
  on pm.onboarding_runs (org_id, location_id) nulls not distinct where status = 'IN_PROGRESS';

-- ----------------------------------------------------------------------------
-- 6. Job spine
-- ----------------------------------------------------------------------------

-- 1:1 extension of core.jobs (D2).
create table if not exists pm.projects (
  job_id             uuid primary key,
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  job_type_id        uuid not null,
  stage_key          text not null,
  stage_entered_at   timestamptz not null default now(),
  pm_user_id         text,                     -- Clerk user id
  super_user_id      text,                     -- Clerk user id
  site_address_line1 text,                     -- until core.sites exists
  site_address_line2 text,
  site_city          text,
  site_state         text,
  site_zip           text,
  site_lat           numeric(9,6),
  site_lng           numeric(9,6),
  planned_start      date,
  planned_finish     date,
  actual_start       date,
  actual_finish      date,
  is_sample          boolean not null default false,
  source_ref         text,                     -- import provenance
  ext                jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, job_id),
  check (planned_finish is null or planned_start is null or planned_finish >= planned_start),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_type_id) references pm.job_types (org_id, id) deferrable initially immediate
);
create index if not exists pm_projects_loc_stage_idx on pm.projects (org_id, location_id, stage_key);
create index if not exists pm_projects_sample_idx on pm.projects (org_id, location_id) where is_sample;
create unique index if not exists pm_projects_source_ref_uidx on pm.projects (org_id, source_ref) where source_ref is not null;

create table if not exists pm.wbs_nodes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  parent_id       uuid,
  kind            text not null check (kind in ('PHASE','MILESTONE','AREA','ROOM','LOT','RELEASE')),
  code            text,
  name            text not null,
  sort            int not null default 0,
  planned_start   date,
  planned_finish  date,
  pct_complete    numeric(5,4) check (pct_complete is null or (pct_complete >= 0 and pct_complete <= 1)),
  ext             jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  check (parent_id is null or parent_id <> id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, parent_id) references pm.wbs_nodes (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_wbs_nodes_job_idx on pm.wbs_nodes (org_id, job_id, sort);

create table if not exists pm.tasks (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                uuid not null,
  wbs_id                uuid,
  parent_task_id        uuid,
  title                 text not null check (char_length(title) between 1 and 200),
  description           text,
  status                text not null default 'TODO' check (status in ('TODO','IN_PROGRESS','BLOCKED','DONE','CANCELLED')),
  is_milestone          boolean not null default false,
  assignee_user_id      text,                  -- Clerk user id
  assignee_employee_id  uuid references core.employees(id),
  start_on              date,
  due_on                date,
  duration_days         int check (duration_days is null or duration_days >= 0),
  pct_complete          numeric(5,4) check (pct_complete is null or (pct_complete >= 0 and pct_complete <= 1)),
  cost_code_id          uuid,
  sort                  int not null default 0,
  completed_at          timestamptz,
  ext                   jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  check (due_on is null or start_on is null or due_on >= start_on),
  check (parent_task_id is null or parent_task_id <> id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate,
  foreign key (org_id, parent_task_id) references pm.tasks (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_tasks_job_idx on pm.tasks (org_id, job_id, sort);
create index if not exists pm_tasks_open_due_idx on pm.tasks (org_id, due_on) where status not in ('DONE','CANCELLED');
create index if not exists pm_tasks_assignee_idx on pm.tasks (org_id, assignee_user_id) where assignee_user_id is not null;

create table if not exists pm.task_deps (
  org_id    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  pred_id   uuid not null,
  succ_id   uuid not null,
  dep_type  text not null default 'FS' check (dep_type in ('FS','SS','FF','SF')),
  lag_days  int not null default 0,
  created_at timestamptz not null default now(),
  primary key (pred_id, succ_id),
  check (pred_id <> succ_id),
  foreign key (org_id, pred_id) references pm.tasks (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, succ_id) references pm.tasks (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_task_deps_succ_idx on pm.task_deps (org_id, succ_id);

create table if not exists pm.budgets (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id       uuid not null,
  kind         text not null check (kind in ('ORIGINAL','REVISED','FORECAST')),
  version      int not null default 1 check (version >= 1),
  status       text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','SUPERSEDED')),
  label        text,
  as_of        date,
  notes        text,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, job_id, kind, version),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.budget_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  budget_id        uuid not null,
  cost_code_id     uuid not null,
  description      text,
  qty              numeric(14,4),
  uom              text,
  unit_cost_cents  bigint,
  amount_cents     bigint not null,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (org_id, budget_id) references pm.budgets (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_budget_lines_budget_idx on pm.budget_lines (org_id, budget_id);
create index if not exists pm_budget_lines_cc_idx on pm.budget_lines (org_id, cost_code_id);

-- A budget line's cost code must be the job's own code or the job company's library code.
create or replace function pm.tg_budget_line_cost_code() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_job uuid; v_loc uuid; v_cc_job uuid; v_cc_loc uuid;
begin
  select b.job_id into v_job from pm.budgets b where b.org_id = new.org_id and b.id = new.budget_id;
  select j.location_id into v_loc from core.jobs j where j.org_id = new.org_id and j.id = v_job;
  select c.job_id, c.location_id into v_cc_job, v_cc_loc
  from pm.cost_codes c where c.org_id = new.org_id and c.id = new.cost_code_id;
  if v_cc_loc is distinct from v_loc or (v_cc_job is not null and v_cc_job is distinct from v_job) then
    raise exception 'PM_COST_CODE_SCOPE: cost code % is not usable on job %', new.cost_code_id, v_job
      using errcode = '23514';
  end if;
  return new;
end $$;

-- Contracts: many per job (PRIME, MASTER, RELEASE, SERVICE_AGREEMENT) — no unique per job.
-- Written only through pm.set_contract / pm.create_project (rev-rec inputs, D12).
create table if not exists pm.contracts (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  kind                 text not null default 'PRIME' check (kind in ('PRIME','MASTER','RELEASE','SERVICE_AGREEMENT')),
  number               text,
  title                text,
  payer_type           text not null default 'CUSTOMER' check (payer_type in ('CUSTOMER','LENDER','OEM','UTILITY','INTERNAL','AFFILIATE')),
  customer_id          uuid references core.customers(id),   -- null = the job's customer
  original_cents       bigint not null default 0 check (original_cents >= 0),
  retention_pct        numeric(5,4) check (retention_pct is null or (retention_pct >= 0 and retention_pct <= 1)),
  retention_cap_cents  bigint check (retention_cap_cents is null or retention_cap_cents >= 0),
  progress_basis       text not null default 'NONE' check (progress_basis in ('NONE','COST_TO_COST','PHYSICAL_PCT','UNITS','MILESTONES')),
  pct_complete         numeric(5,4) check (pct_complete is null or (pct_complete >= 0 and pct_complete <= 1)),
  billing_mode         text check (billing_mode is null or billing_mode in
                         ('FIXED','PROGRESS_PCT','SOV','MILESTONE','TIME_MATERIALS','DRAW','DEPOSIT','RECURRING')),
  status               text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','CLOSED','VOID')),
  executed_on          date,
  source_ref           text,
  created_by           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_contracts_job_idx on pm.contracts (org_id, job_id);

-- Change orders: the ONLY CO table going forward (review 03 §5.4).
-- Clients may create/edit PCO/COR rows; stage moves only through definer functions.
create table if not exists pm.change_orders (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  contract_id        uuid,
  number             text,                     -- minted 'CO-YYYY-NNNN' when null; unique per org
  title              text not null default 'Change order',
  description        text,
  reason             text,
  stage              text not null default 'PCO' check (stage in ('PCO','COR','APPROVED','REJECTED','VOID')),
  amount_cents       bigint not null default 0,            -- contract delta (may be negative)
  cost_impact_cents  bigint,                               -- EAC delta
  schedule_days      int,
  ext                jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by         text default pm.current_user_id(),
  approved_by        text,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check ((stage = 'APPROVED') = (approved_at is not null) or stage = 'VOID'),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, contract_id) references pm.contracts (org_id, id) deferrable initially immediate
);
create index if not exists pm_change_orders_job_idx on pm.change_orders (org_id, job_id, stage);

create or replace function pm.tg_change_order_number() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare n bigint; v_period text := to_char(current_date, 'YYYY');
begin
  if new.number is null or btrim(new.number) = '' then
    n := pm.next_doc_number(new.org_id, 'org', 'CO', v_period);
    new.number := 'CO-' || v_period || '-' || lpad(n::text, 4, '0');
  end if;
  return new;
end $$;

-- Versioned JOB_PROGRESS source (one row per emit; Books pins per period).
create table if not exists pm.progress_snapshots (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  job_id                   uuid not null,
  snapshot_version         int not null check (snapshot_version >= 1),
  as_of_date               date not null,
  trigger_name             text not null,
  progress_basis           text not null,
  original_contract_cents  bigint not null,
  approved_co_cents        bigint not null,
  contract_value_cents     bigint not null,
  cost_estimate_cents      bigint not null,
  pct_complete             numeric(5,4),
  pending_co_value_cents   bigint not null,
  emitted                  boolean not null,
  suppressed_reason        text check (suppressed_reason is null or suppressed_reason in ('STANDALONE','SAMPLE')),
  event_id                 uuid,
  payload                  jsonb,
  created_by               text,
  created_at               timestamptz not null default now(),
  unique (org_id, job_id, snapshot_version),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.field_logs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  kind            text not null default 'DAILY' check (kind in ('DAILY','INSPECTION','SAFETY','DELIVERY','VISIT')),
  log_date        date not null default current_date,
  body            text,
  weather         jsonb,
  crew_count      int check (crew_count is null or crew_count >= 0),
  hours           numeric(8,2) check (hours is null or hours >= 0),
  ext             jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_field_logs_job_idx on pm.field_logs (org_id, job_id, log_date desc);

create table if not exists pm.punch_items (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  kind                   text not null default 'PUNCH' check (kind in ('PUNCH','WARRANTY','CALLBACK')),
  title                  text not null,
  description            text,
  status                 text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','READY_FOR_REVIEW','CLOSED','VOID')),
  wbs_id                 uuid,
  area                   text,
  responsible_vendor_id  uuid references core.vendors(id),
  assignee_user_id       text,
  due_on                 date,
  closed_at              timestamptz,
  billable               boolean not null default false,
  ext                    jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_punch_items_job_idx on pm.punch_items (org_id, job_id, status);

-- Time capture (Projects owns capture + approval; Books owns labor cost, D9).
-- Rates are PINNED at approval by a definer fn (1101+, JOB_TIME); clients cannot write them.
create table if not exists pm.time_entries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  employee_id      uuid references core.employees(id),
  user_id          text,                       -- Clerk user id of the worker (when no employee row)
  work_date        date not null,
  hours            numeric(6,2) not null check (hours > 0 and hours <= 24),
  pay_type         text not null default 'REG' check (pay_type in ('REG','OT','DT','PIECE','FLAG')),
  units            numeric(12,4),
  cost_code_id     uuid,
  task_id          uuid,
  wbs_id           uuid,
  billable         boolean not null default true,
  notes            text,
  approval_state   text not null default 'DRAFT' check (approval_state in ('DRAFT','SUBMITTED','APPROVED','REJECTED','VOID')),
  cost_rate_cents  bigint check (cost_rate_cents is null or cost_rate_cents >= 0),   -- pinned operational cost rate
  bill_rate_cents  bigint check (bill_rate_cents is null or bill_rate_cents >= 0),   -- pinned bill rate
  approved_by      text,
  approved_at      timestamptz,
  source_ref       text,                       -- 'pm:time:{id}' at emit; or import ref
  event_id         uuid,                       -- JOB_TIME event (1101+)
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (employee_id is not null or user_id is not null),
  check (approval_state <> 'APPROVED' or (approved_at is not null and cost_rate_cents is not null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, task_id) references pm.tasks (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_time_entries_job_idx on pm.time_entries (org_id, job_id, work_date);
create index if not exists pm_time_entries_state_idx on pm.time_entries (org_id, approval_state, work_date);
create unique index if not exists pm_time_entries_source_ref_uidx on pm.time_entries (org_id, source_ref) where source_ref is not null;

-- Links to the shared document store (public.documents today; core.documents later).
create table if not exists pm.document_links (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  document_id    uuid not null references public.documents(id) on delete cascade,
  job_id         uuid not null,
  subject_table  text not null check (subject_table in
                   ('projects','tasks','wbs_nodes','change_orders','contracts','budgets','field_logs','punch_items','time_entries')),
  subject_id     uuid not null,
  role           text,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (document_id, subject_table, subject_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_document_links_job_idx on pm.document_links (org_id, job_id);
create index if not exists pm_document_links_subject_idx on pm.document_links (org_id, subject_table, subject_id);

create or replace function pm.tg_document_in_org() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from public.documents d where d.id = new.document_id and d.org_id = new.org_id) then
    raise exception 'PM_DOCUMENT_ORG_MISMATCH: document % is not in org %', new.document_id, new.org_id
      using errcode = '23503';
  end if;
  return new;
end $$;

-- Append-only activity feed. Clients may append HUMAN rows as themselves; no update/delete.
create table if not exists pm.activity (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid references core.locations(id),
  job_id         uuid,
  actor_type     text not null default 'HUMAN' check (actor_type in ('HUMAN','AI','SYSTEM')),
  actor_id       text default pm.current_user_id(),
  verb           text not null check (verb ~ '^[a-z][a-z0-9_.]{1,63}$'),
  subject_table  text,
  subject_id     uuid,
  summary        text,
  meta           jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  created_at     timestamptz not null default now(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_activity_job_idx on pm.activity (org_id, job_id, created_at desc);
create index if not exists pm_activity_org_idx on pm.activity (org_id, created_at desc);

-- Internal: definer callers record activity (not granted to authenticated).
create or replace function pm.log_activity(
  p_org uuid, p_location uuid, p_job uuid, p_verb text,
  p_subject_table text default null, p_subject_id uuid default null,
  p_summary text default null, p_meta jsonb default '{}', p_actor_type text default 'HUMAN'
) returns void
language sql
set search_path = pm, public
as $$
  insert into pm.activity (org_id, location_id, job_id, actor_type, actor_id, verb, subject_table, subject_id, summary, meta)
  values (p_org, p_location, p_job, p_actor_type, pm.current_user_id(), p_verb, p_subject_table, p_subject_id,
          p_summary, coalesce(p_meta, '{}'::jsonb));
$$;

-- ----------------------------------------------------------------------------
-- 7. ext jsonb validation against pm.field_defs (D11)
--    Keys must be defined (active) for the object + job type; leading '_' keys are
--    reserved for system/import provenance and pass through. Types are enforced;
--    `required` is enforced by the app (a DB rule would break partial saves/imports).
-- ----------------------------------------------------------------------------
create or replace function pm.validate_ext(
  p_org uuid, p_location uuid, p_object text, p_job_type_key text, p_ext jsonb
) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r record; d pm.field_defs%rowtype; t text;
begin
  if p_ext is null or p_ext = '{}'::jsonb then return; end if;
  for r in select key, value from jsonb_each(p_ext) loop
    continue when left(r.key, 1) = '_';
    select * into d from pm.field_defs f
    where f.org_id = p_org and f.location_id = p_location and f.object_type = p_object
      and f.field_key = r.key and f.is_active
      and (f.job_type_key is null or f.job_type_key = p_job_type_key)
    order by (f.job_type_key is null)        -- job-type specific wins
    limit 1;
    if not found then
      raise exception 'PM_EXT_UNKNOWN_FIELD: % is not a defined % field', r.key, p_object using errcode = '22023';
    end if;
    t := jsonb_typeof(r.value);
    continue when t = 'null';
    if (d.data_type in ('text') and t <> 'string')
       or (d.data_type = 'number' and t <> 'number')
       or (d.data_type in ('integer','money_cents') and (t <> 'number' or (r.value #>> '{}')::numeric % 1 <> 0))
       or (d.data_type = 'bool' and t <> 'boolean')
       or (d.data_type = 'date' and (t <> 'string' or (r.value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$'))
       or (d.data_type = 'enum' and (t <> 'string' or not (d.options ? (r.value #>> '{}'))))
    then
      raise exception 'PM_EXT_TYPE: field % expects %', r.key, d.data_type using errcode = '22023';
    end if;
    if d.data_type = 'date' then perform (r.value #>> '{}')::date; end if;
  end loop;
end $$;

create or replace function pm.tg_validate_ext() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; v_jt text; v_obj text := tg_argv[0];
begin
  if tg_op = 'UPDATE' and new.ext is not distinct from old.ext then return new; end if;
  if v_obj = 'project' then
    v_loc := new.location_id;
    select jt.key into v_jt from pm.job_types jt where jt.org_id = new.org_id and jt.id = new.job_type_id;
  else
    select p.location_id, jt.key into v_loc, v_jt
    from pm.projects p join pm.job_types jt on jt.org_id = p.org_id and jt.id = p.job_type_id
    where p.org_id = new.org_id and p.job_id = new.job_id;
  end if;
  perform pm.validate_ext(new.org_id, v_loc, v_obj, v_jt, new.ext);
  return new;
end $$;

-- Project integrity: location matches the job's company; job type belongs to it.
create or replace function pm.tg_project_integrity() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from core.jobs j where j.org_id = new.org_id and j.id = new.job_id and j.location_id = new.location_id) then
    raise exception 'PM_PROJECT_LOCATION: project location must equal core.jobs.location_id' using errcode = '23514';
  end if;
  if not exists (select 1 from pm.job_types jt where jt.org_id = new.org_id and jt.id = new.job_type_id and jt.location_id = new.location_id) then
    raise exception 'PM_PROJECT_JOB_TYPE: job type is not installed on this company' using errcode = '23514';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Triggers
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  -- updated_at
  foreach t in array array['pack_installs','job_types','stage_defs','stage_transitions','approval_policies',
    'field_defs','cost_codes','price_book_items','kpi_defs','onboarding_runs','projects','wbs_nodes','tasks',
    'budgets','budget_lines','contracts','change_orders','field_logs','punch_items','time_entries'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  -- created_by stamping
  foreach t in array array['pack_overrides','onboarding_runs','tasks','budgets','change_orders','field_logs',
    'punch_items','time_entries','document_links'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
  -- location in org
  foreach t in array array['pack_installs','job_types','stage_defs','stage_transitions','approval_policies',
    'field_defs','cost_codes','price_book_items','kpi_defs','onboarding_runs','projects','activity'] loop
    execute format('create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
end $$;

create or replace trigger trg_project_integrity before insert or update of location_id, job_type_id, job_id on pm.projects
  for each row execute function pm.tg_project_integrity();

create or replace trigger trg_validate_ext before insert or update of ext on pm.projects
  for each row execute function pm.tg_validate_ext('project');
create or replace trigger trg_validate_ext before insert or update of ext on pm.tasks
  for each row execute function pm.tg_validate_ext('task');
create or replace trigger trg_validate_ext before insert or update of ext on pm.field_logs
  for each row execute function pm.tg_validate_ext('field_log');

create or replace trigger trg_budget_line_cost_code before insert or update of cost_code_id, budget_id on pm.budget_lines
  for each row execute function pm.tg_budget_line_cost_code();

create or replace trigger trg_change_order_number before insert on pm.change_orders
  for each row execute function pm.tg_change_order_number();

create or replace trigger trg_document_in_org before insert or update of document_id, org_id on pm.document_links
  for each row execute function pm.tg_document_in_org();

-- ----------------------------------------------------------------------------
-- 9. Books presence (entitlements form; fixes the key-presence bug: `? 'books'`
--    was true for {"books": false}). Definer: reads core.organizations for the
--    given org only; internal (not granted to authenticated).
-- ----------------------------------------------------------------------------
create or replace function pm.books_present(p_org uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select (o.entitlements ->> 'books')::boolean is true
                   from core.organizations o where o.id = p_org), false)
$$;

-- ----------------------------------------------------------------------------
-- 10. Money read model (shared by views and emit_job_progress — one computation)
--   contract value  = Σ ACTIVE contracts.original + Σ APPROVED COs (not on VOID contracts)
--   cost estimate   = latest APPROVED REVISED budget total, else latest non-superseded
--                     ORIGINAL budget total + Σ APPROVED CO cost impact
--   pending COs     = Σ PCO/COR amounts (disclosure only; never recognized)
-- ----------------------------------------------------------------------------
create or replace view pm.v_job_money with (security_invoker = on) as
select
  p.org_id,
  p.job_id,
  coalesce(c.original_cents, 0)::bigint                                  as original_contract_cents,
  coalesce(co.approved_cents, 0)::bigint                                 as approved_co_cents,
  (coalesce(c.original_cents, 0) + coalesce(co.approved_cents, 0))::bigint as revised_contract_cents,
  coalesce(co.approved_cost_cents, 0)::bigint                            as approved_co_cost_cents,
  coalesce(co.pending_cents, 0)::bigint                                  as pending_co_cents,
  coalesce(co.pending_count, 0)::int                                     as pending_co_count,
  bo.total_cents                                                         as budget_original_cents,
  br.total_cents                                                         as budget_revised_cents,
  coalesce(br.total_cents, coalesce(bo.total_cents, 0) + coalesce(co.approved_cost_cents, 0))::bigint
                                                                         as cost_estimate_cents,
  coalesce(c.active_count, 0)::int                                       as active_contract_count
from pm.projects p
left join lateral (
  select sum(k.original_cents) as original_cents, count(*) as active_count
  from pm.contracts k
  where k.org_id = p.org_id and k.job_id = p.job_id and k.status = 'ACTIVE'
) c on true
left join lateral (
  select sum(x.amount_cents) filter (where x.stage = 'APPROVED')                      as approved_cents,
         sum(coalesce(x.cost_impact_cents, 0)) filter (where x.stage = 'APPROVED')     as approved_cost_cents,
         sum(x.amount_cents) filter (where x.stage in ('PCO','COR'))                  as pending_cents,
         count(*) filter (where x.stage in ('PCO','COR'))                             as pending_count
  from pm.change_orders x
  left join pm.contracts k on k.org_id = x.org_id and k.id = x.contract_id
  where x.org_id = p.org_id and x.job_id = p.job_id
    and (x.contract_id is null or k.status <> 'VOID')
) co on true
left join lateral (
  select (select coalesce(sum(l.amount_cents), 0) from pm.budget_lines l where l.org_id = b.org_id and l.budget_id = b.id) as total_cents
  from pm.budgets b
  where b.org_id = p.org_id and b.job_id = p.job_id and b.kind = 'ORIGINAL' and b.status <> 'SUPERSEDED'
  order by b.version desc limit 1
) bo on true
left join lateral (
  select (select coalesce(sum(l.amount_cents), 0) from pm.budget_lines l where l.org_id = b.org_id and l.budget_id = b.id) as total_cents
  from pm.budgets b
  where b.org_id = p.org_id and b.job_id = p.job_id and b.kind = 'REVISED' and b.status = 'APPROVED'
  order by b.version desc limit 1
) br on true;

-- ----------------------------------------------------------------------------
-- 11. Guard predicates (closed vocabulary, D10). SECURITY INVOKER: called from the
--     definer transition_stage they run with owner rights; called directly by a member
--     they see only their org (RLS), so they cannot leak another tenant's state.
--     Placeholders for modules whose tables arrive in 1101+ return TRUE while the table
--     is absent; 1101+ replaces them with `create or replace`.
-- ----------------------------------------------------------------------------
create or replace function pm.guard_has_customer(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select exists (select 1 from core.jobs j where j.id = p_job and j.customer_id is not null)
$$;

create or replace function pm.guard_has_contract_value(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select exists (select 1 from pm.contracts k where k.job_id = p_job and k.status = 'ACTIVE' and k.original_cents > 0)
$$;

create or replace function pm.guard_has_budget(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select exists (select 1 from pm.budgets b
                 where b.job_id = p_job and b.kind = 'ORIGINAL' and b.status <> 'SUPERSEDED'
                   and exists (select 1 from pm.budget_lines l where l.org_id = b.org_id and l.budget_id = b.id))
$$;

create or replace function pm.guard_no_open_change_orders(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select not exists (select 1 from pm.change_orders x where x.job_id = p_job and x.stage in ('PCO','COR'))
$$;

create or replace function pm.guard_punch_complete(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select not exists (select 1 from pm.punch_items i
                     where i.job_id = p_job and i.kind = 'PUNCH' and i.status not in ('CLOSED','VOID'))
$$;

-- placeholder: pm.estimates arrives with the estimating module (1101+)
create or replace function pm.guard_estimate_accepted(p_job uuid) returns boolean
language plpgsql stable set search_path = pm, core, public as $$
declare ok boolean;
begin
  if to_regclass('pm.estimates') is null then return true; end if;  -- module not installed yet
  execute 'select exists (select 1 from pm.estimates e where e.job_id = $1 and e.status = ''ACCEPTED'')' into ok using p_job;
  return ok;
end $$;

-- placeholder: pm.billing_requests arrives in 1101
create or replace function pm.guard_deposit_requested(p_job uuid) returns boolean
language plpgsql stable set search_path = pm, core, public as $$
declare ok boolean;
begin
  if to_regclass('pm.billing_requests') is null then return true; end if;
  execute 'select exists (select 1 from pm.billing_requests r where r.job_id = $1 and r.billing_subtype = ''DEPOSIT'' and r.status <> ''DRAFT'')' into ok using p_job;
  return ok;
end $$;

-- placeholder: pm.selections arrives in 1101
create or replace function pm.guard_selections_approved(p_job uuid) returns boolean
language plpgsql stable set search_path = pm, core, public as $$
declare ok boolean;
begin
  if to_regclass('pm.selections') is null then return true; end if;
  execute 'select not exists (select 1 from pm.selections s where s.job_id = $1 and s.status <> ''APPROVED'')' into ok using p_job;
  return ok;
end $$;

-- placeholder: billing (1101) — billed ≥ revised contract
create or replace function pm.guard_final_billed(p_job uuid) returns boolean
language plpgsql stable set search_path = pm, core, public as $$
declare ok boolean;
begin
  if to_regclass('pm.billing_requests') is null then return true; end if;
  execute $q$
    select coalesce((select sum(r.gross_earned_cents) from pm.billing_requests r
                     where r.job_id = $1 and r.status in ('EMITTED','PROCESSED','UNISSUED')), 0)
           >= coalesce((select m.revised_contract_cents from pm.v_job_money m where m.job_id = $1), 0)
  $q$ into ok using p_job;
  return ok;
end $$;

-- placeholder: compliance (1101+ checklists / compliance docs on commitments)
create or replace function pm.guard_compliance_current(p_job uuid) returns boolean
language plpgsql stable set search_path = pm, core, public as $$
declare ok boolean;
begin
  if to_regclass('pm.compliance_docs') is null then return true; end if;
  execute 'select not exists (select 1 from pm.compliance_docs d where d.job_id = $1 and d.required and d.expires_on < current_date)' into ok using p_job;
  return ok;
end $$;

-- placeholder: field service (1103)
create or replace function pm.guard_work_orders_closed(p_job uuid) returns boolean
language plpgsql stable set search_path = pm, core, public as $$
declare ok boolean;
begin
  if to_regclass('pm.work_orders') is null then return true; end if;
  execute 'select not exists (select 1 from pm.work_orders w where w.job_id = $1 and w.status not in (''COMPLETE'',''CLOSED'',''CANCELLED''))' into ok using p_job;
  return ok;
end $$;

-- placeholder: production (1104)
create or replace function pm.guard_production_complete(p_job uuid) returns boolean
language plpgsql stable set search_path = pm, core, public as $$
declare ok boolean;
begin
  if to_regclass('pm.wo_operations') is null then return true; end if;
  execute 'select not exists (select 1 from pm.wo_operations o where o.job_id = $1 and o.status <> ''COMPLETE'')' into ok using p_job;
  return ok;
end $$;

-- Returns the failing guard names (in the order given). Unknown names raise.
create or replace function pm.check_guards(p_job uuid, p_guards text[]) returns text[]
language plpgsql stable set search_path = pm, core, public as $$
declare g text; ok boolean; failing text[] := '{}';
begin
  foreach g in array coalesce(p_guards, '{}') loop
    if not (g = any (pm.guard_names())) then
      raise exception 'PM_UNKNOWN_GUARD: %', g using errcode = '22023';
    end if;
    execute format('select pm.%I($1)', 'guard_' || g) into ok using p_job;
    if ok is not true then failing := failing || g; end if;
  end loop;
  return failing;
end $$;

-- ----------------------------------------------------------------------------
-- 12. pm.apply_pack_plan — idempotent materialization of a compiled WorkspacePlan
-- ----------------------------------------------------------------------------
create or replace function pm.apply_pack_plan(p_plan jsonb, p_role text default 'primary')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_loc       uuid;
  v_org       uuid;
  v_install   uuid;
  v_existing  pm.pack_installs%rowtype;
  v_pack_key  text;
  v_pack_ver  text;
  v_hash      text;
  v_ai        uuid;
  v_bad       text;
  v_jts       jsonb := coalesce(p_plan -> 'job_types', '[]');
  v_stages    jsonb := coalesce(p_plan -> 'stages', '[]');
  v_trans     jsonb := coalesce(p_plan -> 'transitions', '[]');
  v_pols      jsonb := coalesce(p_plan -> 'approval_policies', '[]');
  v_codes     jsonb := coalesce(p_plan -> 'cost_codes', '[]');
  v_fields    jsonb := coalesce(p_plan -> 'field_defs', '[]');
  v_prices    jsonb := coalesce(p_plan -> 'price_book', '[]');
  v_kpis      jsonb := coalesce(p_plan -> 'kpis', '[]');
  v_retired   uuid[] := '{}';
  v_primary   boolean := (p_role = 'primary');
  a           jsonb;
begin
  -- location (and therefore org) comes from the plan; validate it is a uuid first
  begin
    v_loc := (p_plan ->> 'location_id')::uuid;
  exception when others then
    raise exception 'PLAN_INVALID: location_id is not a uuid' using errcode = '22023';
  end;
  select l.org_id into v_org from core.locations l where l.id = v_loc;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', v_loc using errcode = '42501';
  end if;

  if jsonb_typeof(p_plan) <> 'object' then raise exception 'PLAN_INVALID: plan must be an object' using errcode = '22023'; end if;
  if (p_plan ->> 'schema_version') is distinct from '1' then
    raise exception 'PLAN_INVALID: unsupported schema_version % (expected 1)', p_plan ->> 'schema_version' using errcode = '22023';
  end if;
  if p_role not in ('primary','addon') then raise exception 'PLAN_INVALID: role must be primary|addon' using errcode = '22023'; end if;
  v_pack_key := p_plan #>> '{primary_pack,key}';
  v_pack_ver := p_plan #>> '{primary_pack,version}';
  v_hash     := nullif(p_plan ->> 'plan_hash', '');
  if v_pack_key is null or v_pack_ver is null or v_hash is null then
    raise exception 'PLAN_INVALID: primary_pack.key, primary_pack.version and plan_hash are required' using errcode = '22023';
  end if;
  begin
    v_ai := nullif(p_plan ->> 'ai_decision_id', '')::uuid;    -- optional additive key set by the app route
  exception when others then v_ai := null;
  end;

  perform pg_advisory_xact_lock(hashtextextended('pm.apply_pack_plan:' || v_loc::text, 0));

  -- ---- idempotency: same plan_hash on an ACTIVE install of the same role = no-op ----
  select * into v_existing from pm.pack_installs i
  where i.org_id = v_org and i.location_id = v_loc and i.pack_key = v_pack_key;
  if found and v_existing.plan_hash = v_hash and v_existing.status = 'ACTIVE' and v_existing.role = p_role then
    -- answers/sample_job are outside the hash by contract; keep the stored copy current
    if v_existing.resolved is distinct from p_plan then
      update pm.pack_installs set resolved = p_plan where id = v_existing.id;
    end if;
    return v_existing.id;
  end if;

  -- ---- referential validation of the plan (Zod validated shape; this checks joins) ----
  if jsonb_typeof(v_jts) <> 'array' or jsonb_array_length(v_jts) = 0 then
    raise exception 'PLAN_INVALID: job_types must be a non-empty array' using errcode = '22023';
  end if;
  select string_agg(k, ',') into v_bad from (
    select e ->> 'key' k from jsonb_array_elements(v_jts) e group by 1 having count(*) > 1
    union all select e ->> 'code' from jsonb_array_elements(v_codes) e group by 1 having count(*) > 1
    union all select (e ->> 'machine_key') || '/' || (e ->> 'stage_key') from jsonb_array_elements(v_stages) e group by 1 having count(*) > 1
  ) d;
  if v_bad is not null then raise exception 'PLAN_INVALID: duplicate keys: %', v_bad using errcode = '22023'; end if;

  select string_agg(jt ->> 'key', ',') into v_bad
  from jsonb_array_elements(v_jts) jt
  where (select count(*) from jsonb_array_elements(v_stages) s
         where s ->> 'machine_key' = jt ->> 'stage_machine_key' and (s ->> 'is_initial')::boolean) <> 1;
  if v_bad is not null then
    raise exception 'PLAN_INVALID: job types without exactly one initial stage in their machine: %', v_bad using errcode = '22023';
  end if;

  select string_agg((t ->> 'from_stage') || '->' || (t ->> 'to_stage'), ',') into v_bad
  from jsonb_array_elements(v_trans) t
  where not exists (select 1 from jsonb_array_elements(v_stages) s where s ->> 'machine_key' = t ->> 'machine_key' and s ->> 'stage_key' = t ->> 'from_stage')
     or not exists (select 1 from jsonb_array_elements(v_stages) s where s ->> 'machine_key' = t ->> 'machine_key' and s ->> 'stage_key' = t ->> 'to_stage')
     or (t ->> 'approval_policy_key' is not null
         and not exists (select 1 from jsonb_array_elements(v_pols) p where p ->> 'key' = t ->> 'approval_policy_key'));
  if v_bad is not null then
    raise exception 'PLAN_INVALID: transitions reference unknown stages/policies: %', v_bad using errcode = '22023';
  end if;

  select string_agg(distinct g, ',') into v_bad
  from jsonb_array_elements(v_trans) t, jsonb_array_elements_text(coalesce(t -> 'guards', '[]')) g
  where not (g = any (pm.guard_names()));
  if v_bad is not null then raise exception 'PLAN_INVALID: unknown guards: %', v_bad using errcode = '22023'; end if;

  select string_agg(c ->> 'code', ',') into v_bad
  from jsonb_array_elements(v_codes) c
  where c ->> 'parent_code' is not null
    and not exists (select 1 from jsonb_array_elements(v_codes) c2 where c2 ->> 'code' = c ->> 'parent_code');
  if v_bad is not null then raise exception 'PLAN_INVALID: cost codes with unknown parent: %', v_bad using errcode = '22023'; end if;

  select string_agg(p ->> 'code', ',') into v_bad
  from jsonb_array_elements(v_prices) p
  where p ->> 'cost_code' is not null
    and not exists (select 1 from jsonb_array_elements(v_codes) c where c ->> 'code' = p ->> 'cost_code');
  if v_bad is not null then raise exception 'PLAN_INVALID: price book items with unknown cost_code: %', v_bad using errcode = '22023'; end if;

  select string_agg(f ->> 'field_key', ',') into v_bad
  from jsonb_array_elements(v_fields) f
  where f ->> 'job_type_key' is not null
    and not exists (select 1 from jsonb_array_elements(v_jts) jt where jt ->> 'key' = f ->> 'job_type_key');
  if v_bad is not null then raise exception 'PLAN_INVALID: field defs with unknown job_type_key: %', v_bad using errcode = '22023'; end if;

  if not v_primary and not exists (
       select 1 from pm.pack_installs i where i.org_id = v_org and i.location_id = v_loc
         and i.role = 'primary' and i.status = 'ACTIVE' and i.pack_key <> v_pack_key) then
    raise exception 'PLAN_INVALID: an add-on pack needs an active primary pack on this company' using errcode = '22023';
  end if;

  -- ---- install row ----
  if v_primary then
    -- switching the primary pack retires the old primary (its rows are deactivated below unless taken over)
    update pm.pack_installs set status = 'RETIRED'
    where org_id = v_org and location_id = v_loc and role = 'primary' and status = 'ACTIVE' and pack_key <> v_pack_key;
    select coalesce(array_agg(id), '{}') into v_retired from pm.pack_installs
    where org_id = v_org and location_id = v_loc and status = 'RETIRED';
  end if;

  insert into pm.pack_installs as i
    (org_id, location_id, pack_key, pack_version, role, resolved, plan_hash, status, ai_decision_id, installed_by)
  values (v_org, v_loc, v_pack_key, v_pack_ver, p_role, p_plan, v_hash, 'ACTIVE', v_ai, pm.current_user_id())
  on conflict (org_id, location_id, pack_key) do update
    set pack_version = excluded.pack_version, role = excluded.role, resolved = excluded.resolved,
        plan_hash = excluded.plan_hash, status = 'ACTIVE',
        ai_decision_id = coalesce(excluded.ai_decision_id, i.ai_decision_id),
        installed_by = excluded.installed_by
  returning id into v_install;

  -- add-ons merged into this primary plan by the compiler are recorded for listing only
  if v_primary then
    for a in select * from jsonb_array_elements(coalesce(p_plan -> 'addon_packs', '[]')) loop
      insert into pm.pack_installs as i (org_id, location_id, pack_key, pack_version, role, resolved, plan_hash, status, installed_by)
      values (v_org, v_loc, a ->> 'key', a ->> 'version', 'addon',
              jsonb_build_object('merged_into_install_id', v_install), v_hash, 'ACTIVE', pm.current_user_id())
      on conflict (org_id, location_id, pack_key) do update
        set pack_version = excluded.pack_version, resolved = excluded.resolved, plan_hash = excluded.plan_hash, status = 'ACTIVE'
      where i.role = 'addon';
    end loop;
  end if;

  -- ---- job types ----
  insert into pm.job_types as t
    (org_id, location_id, install_id, key, label, archetype, billing_modes, default_billing_mode,
     progress_basis, stage_machine_key, rev_rec_hint, modules, default_retainage_pct, sort, is_active)
  select v_org, v_loc, v_install, r.key, r.label, r.archetype, r.billing_modes, r.default_billing_mode,
         coalesce(r.progress_basis, 'NONE'), r.stage_machine_key, r.rev_rec_hint, coalesce(r.modules, '{}'),
         r.default_retainage_pct, (r.ord - 1)::int, true
  from rows from (jsonb_to_recordset(v_jts) as (key text, label text, archetype text, billing_modes text[],
         default_billing_mode text, progress_basis text, stage_machine_key text, rev_rec_hint text,
         modules jsonb, default_retainage_pct numeric))
       with ordinality as r(key, label, archetype, billing_modes, default_billing_mode, progress_basis,
         stage_machine_key, rev_rec_hint, modules, default_retainage_pct, ord)
  on conflict (org_id, location_id, key) do update
    set install_id = excluded.install_id, label = excluded.label, archetype = excluded.archetype,
        billing_modes = excluded.billing_modes, default_billing_mode = excluded.default_billing_mode,
        progress_basis = excluded.progress_basis, stage_machine_key = excluded.stage_machine_key,
        rev_rec_hint = excluded.rev_rec_hint, modules = excluded.modules,
        default_retainage_pct = excluded.default_retainage_pct, sort = excluded.sort, is_active = true
    where v_primary or t.install_id = v_install or not t.is_active;

  -- ---- stages ----
  -- clear initial flags first so a plan that moves the initial stage never trips the
  -- one-initial-per-machine index mid-upsert
  update pm.stage_defs s set is_initial = false
  where s.org_id = v_org and s.location_id = v_loc and s.is_initial
    and (v_primary or s.install_id = v_install)
    and s.machine_key in (select e ->> 'machine_key' from jsonb_array_elements(v_stages) e);
  insert into pm.stage_defs as s
    (org_id, location_id, install_id, machine_key, stage_key, label, sort, core_status, is_terminal, is_initial, is_active)
  select v_org, v_loc, v_install, r.machine_key, r.stage_key, r.label, coalesce(r.sort, 0), r.core_status,
         coalesce(r.is_terminal, false), coalesce(r.is_initial, false), true
  from jsonb_to_recordset(v_stages) as r(machine_key text, stage_key text, label text, sort int,
         core_status text, is_terminal boolean, is_initial boolean)
  on conflict (org_id, location_id, machine_key, stage_key) do update
    set install_id = excluded.install_id, label = excluded.label, sort = excluded.sort,
        core_status = excluded.core_status, is_terminal = excluded.is_terminal,
        is_initial = excluded.is_initial, is_active = true
    where v_primary or s.install_id = v_install or not s.is_active;

  -- ---- approval policies ----
  insert into pm.approval_policies as ap (org_id, location_id, install_id, key, label, tiers, is_active)
  select v_org, v_loc, v_install, r.key, r.label, r.tiers, true
  from jsonb_to_recordset(v_pols) as r(key text, label text, tiers jsonb)
  on conflict (org_id, location_id, key) do update
    set install_id = excluded.install_id, label = excluded.label, tiers = excluded.tiers, is_active = true
    where v_primary or ap.install_id = v_install or not ap.is_active;

  -- ---- transitions: replace this install's set ----
  delete from pm.stage_transitions st
  where st.org_id = v_org and st.location_id = v_loc
    and (st.install_id = any (v_retired)
         or (st.install_id = v_install and not exists (
               select 1 from jsonb_to_recordset(v_trans) as r(machine_key text, from_stage text, to_stage text)
               where r.machine_key = st.machine_key and r.from_stage = st.from_stage and r.to_stage = st.to_stage)));
  insert into pm.stage_transitions as st
    (org_id, location_id, install_id, machine_key, from_stage, to_stage, guards, approval_policy_key, sort)
  select v_org, v_loc, v_install, r.machine_key, r.from_stage, r.to_stage, coalesce(r.guards, '{}'),
         r.approval_policy_key, (r.ord - 1)::int
  from rows from (jsonb_to_recordset(v_trans) as (machine_key text, from_stage text, to_stage text,
         guards text[], approval_policy_key text))
       with ordinality as r(machine_key, from_stage, to_stage, guards, approval_policy_key, ord)
  on conflict (org_id, location_id, machine_key, from_stage, to_stage) do update
    set install_id = excluded.install_id, guards = excluded.guards,
        approval_policy_key = excluded.approval_policy_key, sort = excluded.sort
    where v_primary or st.install_id = v_install;

  -- ---- field defs (PACK source) ----
  insert into pm.field_defs as f
    (org_id, location_id, install_id, object_type, job_type_key, field_key, label, data_type, options,
     required, promote, source, is_active)
  select v_org, v_loc, v_install, r.object_type, r.job_type_key, r.field_key, r.label, r.data_type,
         case when jsonb_typeof(r.options) = 'array' then r.options end,
         coalesce(r.required, false), coalesce(r.promote, false), 'PACK', true
  from jsonb_to_recordset(v_fields) as r(object_type text, job_type_key text, field_key text, label text,
         data_type text, options jsonb, required boolean, promote boolean)
  on conflict on constraint field_defs_scope_key do update
    set install_id = excluded.install_id, label = excluded.label, data_type = excluded.data_type,
        options = excluded.options, required = excluded.required, promote = excluded.promote,
        source = 'PACK', is_active = true
    where v_primary or f.install_id = v_install or f.install_id is null or not f.is_active;

  -- ---- company-library cost codes: upsert by code; never delete (deactivate) ----
  insert into pm.cost_codes as c
    (org_id, location_id, job_id, code, name, cost_type, role_hint, install_id, source_pack, sort, is_active)
  select v_org, v_loc, null, r.code, r.name, r.cost_type, r.role_hint, v_install, v_pack_key, (r.ord - 1)::int, true
  from rows from (jsonb_to_recordset(v_codes) as (code text, name text, cost_type text, role_hint text))
       with ordinality as r(code, name, cost_type, role_hint, ord)
  on conflict on constraint cost_codes_scope_code_key do update
    set name = excluded.name, cost_type = excluded.cost_type, role_hint = excluded.role_hint,
        install_id = excluded.install_id, source_pack = excluded.source_pack, sort = excluded.sort, is_active = true
    where v_primary or c.install_id = v_install or c.install_id is null or not c.is_active;
  update pm.cost_codes c
     set parent_id = p.id
    from jsonb_to_recordset(v_codes) as r(code text, parent_code text)
    left join pm.cost_codes p on p.org_id = v_org and p.location_id = v_loc and p.job_id is null and p.code = r.parent_code
   where c.org_id = v_org and c.location_id = v_loc and c.job_id is null and c.code = r.code
     and c.install_id = v_install and c.parent_id is distinct from p.id;

  -- ---- price book ----
  insert into pm.price_book_items as pb
    (org_id, location_id, install_id, code, name, unit, price_cents, cost_cents, labor_minutes, cost_code_id, is_active)
  select v_org, v_loc, v_install, r.code, r.name, coalesce(r.unit, 'EA'), coalesce(r.price_cents, 0), r.cost_cents,
         r.labor_minutes, cc.id, true
  from jsonb_to_recordset(v_prices) as r(code text, name text, unit text, price_cents bigint, cost_cents bigint,
         labor_minutes int, cost_code text)
  left join pm.cost_codes cc on cc.org_id = v_org and cc.location_id = v_loc and cc.job_id is null and cc.code = r.cost_code
  on conflict (org_id, location_id, code) do update
    set install_id = excluded.install_id, name = excluded.name, unit = excluded.unit,
        price_cents = excluded.price_cents, cost_cents = excluded.cost_cents,
        labor_minutes = excluded.labor_minutes, cost_code_id = excluded.cost_code_id, is_active = true
    where v_primary or pb.install_id = v_install or pb.install_id is null or not pb.is_active;

  -- ---- KPIs ----
  insert into pm.kpi_defs as k (org_id, location_id, install_id, key, label, metric, good_direction, sort, is_active)
  select v_org, v_loc, v_install, r.key, r.label, r.metric, r.good_direction, (r.ord - 1)::int, true
  from rows from (jsonb_to_recordset(v_kpis) as (key text, label text, metric text, good_direction text))
       with ordinality as r(key, label, metric, good_direction, ord)
  on conflict (org_id, location_id, key) do update
    set install_id = excluded.install_id, label = excluded.label, metric = excluded.metric,
        good_direction = excluded.good_direction, sort = excluded.sort, is_active = true
    where v_primary or k.install_id = v_install or not k.is_active;

  -- ---- deactivate rows this install (or a retired one) owns that the plan dropped ----
  update pm.job_types t set is_active = false
  where t.org_id = v_org and t.location_id = v_loc and t.is_active
    and (t.install_id = any (v_retired)
         or (t.install_id = v_install and not exists (select 1 from jsonb_array_elements(v_jts) e where e ->> 'key' = t.key)));
  update pm.stage_defs s set is_active = false, is_initial = false
  where s.org_id = v_org and s.location_id = v_loc and s.is_active
    and (s.install_id = any (v_retired)
         or (s.install_id = v_install and not exists (select 1 from jsonb_array_elements(v_stages) e
               where e ->> 'machine_key' = s.machine_key and e ->> 'stage_key' = s.stage_key)));
  update pm.approval_policies ap set is_active = false
  where ap.org_id = v_org and ap.location_id = v_loc and ap.is_active
    and (ap.install_id = any (v_retired)
         or (ap.install_id = v_install and not exists (select 1 from jsonb_array_elements(v_pols) e where e ->> 'key' = ap.key)));
  update pm.field_defs f set is_active = false
  where f.org_id = v_org and f.location_id = v_loc and f.is_active and f.source = 'PACK'
    and (f.install_id = any (v_retired)
         or (f.install_id = v_install and not exists (select 1 from jsonb_array_elements(v_fields) e
               where e ->> 'object_type' = f.object_type and e ->> 'field_key' = f.field_key
                 and (e ->> 'job_type_key') is not distinct from f.job_type_key)));
  update pm.cost_codes c set is_active = false     -- deactivate, never delete (budgets/time may reference)
  where c.org_id = v_org and c.location_id = v_loc and c.job_id is null and c.is_active
    and (c.install_id = any (v_retired)
         or (c.install_id = v_install and not exists (select 1 from jsonb_array_elements(v_codes) e where e ->> 'code' = c.code)));
  update pm.price_book_items pb set is_active = false
  where pb.org_id = v_org and pb.location_id = v_loc and pb.is_active
    and (pb.install_id = any (v_retired)
         or (pb.install_id = v_install and not exists (select 1 from jsonb_array_elements(v_prices) e where e ->> 'code' = pb.code)));
  update pm.kpi_defs k set is_active = false
  where k.org_id = v_org and k.location_id = v_loc and k.is_active
    and (k.install_id = any (v_retired)
         or (k.install_id = v_install and not exists (select 1 from jsonb_array_elements(v_kpis) e where e ->> 'key' = k.key)));

  -- ---- onboarding completion lives in pm (never core.organizations) ----
  update pm.onboarding_runs r
     set status = 'APPLIED', step = case when r.step in ('describe','preview') then 'bring_work' else r.step end,
         plan = p_plan, install_id = v_install, ai_decision_id = coalesce(v_ai, r.ai_decision_id), applied_at = now()
   where r.org_id = v_org and r.location_id = v_loc and r.status = 'IN_PROGRESS';
  if not found and v_primary and not exists (
       select 1 from pm.onboarding_runs r where r.org_id = v_org and r.location_id = v_loc and r.status in ('APPLIED','COMPLETE')) then
    insert into pm.onboarding_runs (org_id, location_id, status, step, plan, install_id, ai_decision_id, created_by, applied_at)
    values (v_org, v_loc, 'APPLIED', 'bring_work', p_plan, v_install, v_ai, pm.current_user_id(), now());
  end if;

  perform pm.log_activity(v_org, v_loc, null, 'pack.applied', 'pack_installs', v_install,
    format('Installed %s %s (%s)', v_pack_key, v_pack_ver, p_role),
    jsonb_build_object('pack_key', v_pack_key, 'version', v_pack_ver, 'role', p_role, 'plan_hash', v_hash,
      'previous_plan_hash', v_existing.plan_hash,
      'counts', jsonb_build_object('job_types', jsonb_array_length(v_jts), 'stages', jsonb_array_length(v_stages),
        'transitions', jsonb_array_length(v_trans), 'cost_codes', jsonb_array_length(v_codes),
        'field_defs', jsonb_array_length(v_fields), 'price_book', jsonb_array_length(v_prices),
        'kpis', jsonb_array_length(v_kpis))));
  return v_install;
end $$;

-- ----------------------------------------------------------------------------
-- 13. pm.emit_job_progress — versioned JOB_PROGRESS snapshot (frozen v3 + additive keys)
--   v3 keys (unchanged): event_id, event_type, source_module, org_id, location_id, job_id,
--     trigger, contract_value_cents, cost_estimate_cents, pct_complete, occurred_on,
--     source_ref, memo
--   additive: as_of_date, snapshot_version, pending_co_value_cents, schema_version
--   pct_complete: carried only for physical bases (PHYSICAL_PCT, UNITS, MILESTONES);
--     NULL for NONE / COST_TO_COST (the 067 rule: Books derives cost-to-cost from the GL).
--   Not emitted (snapshot only) when Books is not entitled or the job is a sample.
-- ----------------------------------------------------------------------------
create or replace function pm.emit_job_progress(p_job uuid, p_trigger text, p_as_of date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org     uuid;
  v_loc     uuid;
  v_proj    pm.projects%rowtype;
  m         pm.v_job_money%rowtype;
  v_basis   text;
  v_pct     numeric(5,4);
  v_ver     int;
  v_asof    date := coalesce(p_as_of, current_date);
  v_event   uuid;
  v_books   boolean;
  v_reason  text;
  v_srcref  text;
  v_payload jsonb;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_trigger is null or p_trigger not in ('CONTRACT_SET','CHANGE_ORDER','PROGRESS_UPDATE','BUDGET_REVISED') then
    raise exception 'Invalid JOB_PROGRESS trigger: %', p_trigger using errcode = '22023';
  end if;

  select * into v_proj from pm.projects p where p.org_id = v_org and p.job_id = p_job for update;  -- serializes versions
  if not found then raise exception 'PM_NOT_A_PROJECT: job % has no pm.projects row', p_job using errcode = 'P0002'; end if;

  select * into m from pm.v_job_money x where x.org_id = v_org and x.job_id = p_job;
  if coalesce(m.active_contract_count, 0) = 0 then
    raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract; set the contract before emitting progress', p_job
      using errcode = 'P0001';
  end if;

  -- progress basis: the earliest ACTIVE PRIME contract, else the earliest ACTIVE contract
  select k.progress_basis into v_basis from pm.contracts k
  where k.org_id = v_org and k.job_id = p_job and k.status = 'ACTIVE'
  order by (k.kind = 'PRIME') desc, k.created_at, k.id limit 1;

  v_pct := case
    when v_basis in ('PHYSICAL_PCT','UNITS') then
      (select case when sum(k.original_cents) filter (where k.pct_complete is not null) > 0
                   then round(sum(k.original_cents * k.pct_complete) filter (where k.pct_complete is not null)
                              / sum(k.original_cents) filter (where k.pct_complete is not null), 4)
                   else max(k.pct_complete) end
       from pm.contracts k where k.org_id = v_org and k.job_id = p_job and k.status = 'ACTIVE')
    when v_basis = 'MILESTONES' then
      (select case when count(*) > 0 then round(count(*) filter (where t.status = 'DONE')::numeric / count(*), 4) end
       from pm.tasks t where t.org_id = v_org and t.job_id = p_job and t.is_milestone and t.status <> 'CANCELLED')
    else null end;

  select coalesce(max(s.snapshot_version), 0) + 1 into v_ver
  from pm.progress_snapshots s where s.org_id = v_org and s.job_id = p_job;

  v_books := pm.books_present(v_org);
  v_reason := case when v_proj.is_sample then 'SAMPLE' when not v_books then 'STANDALONE' end;
  v_srcref := 'pm:progress:' || p_job::text || ':v' || v_ver;

  if v_reason is null then
    v_event := gen_random_uuid();
    v_payload := jsonb_build_object(
      'event_id',               v_event,
      'event_type',             'JOB_PROGRESS',
      'source_module',          'PROJECTS',
      'org_id',                 v_org,
      'location_id',            v_loc,
      'job_id',                 p_job,
      'trigger',                p_trigger,
      'contract_value_cents',   m.revised_contract_cents,
      'cost_estimate_cents',    m.cost_estimate_cents,
      'pct_complete',           v_pct,
      'occurred_on',            to_char(v_asof, 'YYYY-MM-DD'),
      'source_ref',             v_srcref,
      'memo',                   format('Merit Projects snapshot v%s (%s)', v_ver, p_trigger),
      -- additive (Books ignores unknown keys; occurred_on already carries the as-of date)
      'as_of_date',             to_char(v_asof, 'YYYY-MM-DD'),
      'snapshot_version',       v_ver,
      'pending_co_value_cents', m.pending_co_cents,
      'schema_version',         2
    );
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (v_org, v_event, 'JOB_PROGRESS', 'PROJECTS', v_payload, v_asof, 'pending');
  end if;

  insert into pm.progress_snapshots
    (org_id, job_id, snapshot_version, as_of_date, trigger_name, progress_basis, original_contract_cents,
     approved_co_cents, contract_value_cents, cost_estimate_cents, pct_complete, pending_co_value_cents,
     emitted, suppressed_reason, event_id, payload, created_by)
  values (v_org, p_job, v_ver, v_asof, p_trigger, coalesce(v_basis, 'NONE'), m.original_contract_cents,
     m.approved_co_cents, m.revised_contract_cents, m.cost_estimate_cents, v_pct, m.pending_co_cents,
     v_reason is null, v_reason, v_event, v_payload, pm.current_user_id());

  perform pm.log_activity(v_org, v_loc, p_job, 'progress.snapshot', 'progress_snapshots', null,
    format('Progress snapshot v%s (%s)%s', v_ver, p_trigger,
           case when v_reason is null then ' sent to Books' else ' recorded (' || lower(v_reason) || ')' end),
    jsonb_build_object('snapshot_version', v_ver, 'event_id', v_event, 'as_of_date', v_asof,
                       'contract_value_cents', m.revised_contract_cents, 'cost_estimate_cents', m.cost_estimate_cents));
  return v_event;
end $$;

-- ----------------------------------------------------------------------------
-- 14. pm.create_project — core.jobs + pm.projects atomically; mints the job number
-- ----------------------------------------------------------------------------
create or replace function pm.create_project(
  p_location      uuid,
  p_job_type_key  text,
  p_name          text,
  p_customer_id   uuid    default null,
  p_contract_cents bigint default null,
  p_is_sample     boolean default false,
  p_ext           jsonb   default '{}'
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org     uuid;
  v_short   text;
  jt        pm.job_types%rowtype;
  v_stage   pm.stage_defs%rowtype;
  v_cust    text;
  v_job     uuid := gen_random_uuid();
  v_year    text := to_char(current_date, 'YYYY');
  v_number  text;
  n         bigint;
  v_contract uuid;
begin
  select l.org_id, l.short_code into v_org, v_short from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'PM_INVALID: name is required' using errcode = '22023'; end if;
  if p_contract_cents is not null and p_contract_cents < 0 then
    raise exception 'PM_INVALID: contract must be ≥ 0' using errcode = '22023';
  end if;

  select * into jt from pm.job_types t
  where t.org_id = v_org and t.location_id = p_location and t.key = p_job_type_key and t.is_active;
  if not found then
    raise exception 'PM_UNKNOWN_JOB_TYPE: % is not an active job type on this company (apply a pack first)', p_job_type_key
      using errcode = 'P0002';
  end if;
  select * into v_stage from pm.stage_defs s
  where s.org_id = v_org and s.location_id = p_location and s.machine_key = jt.stage_machine_key
    and s.is_initial and s.is_active;
  if not found then raise exception 'PM_NO_INITIAL_STAGE: machine %', jt.stage_machine_key using errcode = 'P0002'; end if;

  if p_customer_id is not null then
    select c.name into v_cust from core.customers c
    where c.id = p_customer_id and c.org_id = v_org and c.deleted_at is null;
    if v_cust is null then raise exception 'PM_UNKNOWN_CUSTOMER: %', p_customer_id using errcode = 'P0002'; end if;
  end if;

  -- job number {short_code}-{YYYY}-{seq}; skip numbers already taken (imports, legacy jobs)
  loop
    n := pm.next_doc_number(v_org, p_location::text, 'JOB', v_year);
    v_number := v_short || '-' || v_year || '-' || lpad(n::text, 4, '0');
    exit when not exists (select 1 from core.jobs j where j.org_id = v_org and j.location_id = p_location and j.job_number = v_number);
  end loop;

  -- identity columns only; Books-owned money/rev-rec columns keep their defaults.
  -- archetype = pack archetype (free text live; no CHECK). job_type stays NULL (legacy CHECK + rev-rec map).
  insert into core.jobs (id, org_id, location_id, job_number, name, customer_id, customer_name, archetype, status,
                         description, external_source, external_project_id)
  values (v_job, v_org, p_location, v_number, btrim(p_name), p_customer_id, v_cust, jt.archetype, v_stage.core_status,
          case when p_is_sample then 'Sample job created by Merit Projects onboarding — remove it from Projects settings.' end,
          case when p_is_sample then 'merit_projects_sample' end,
          case when p_is_sample then jt.key end);

  insert into pm.projects (job_id, org_id, location_id, job_type_id, stage_key, is_sample, ext, created_by)
  values (v_job, v_org, p_location, jt.id, v_stage.stage_key, coalesce(p_is_sample, false),
          coalesce(p_ext, '{}'), pm.current_user_id());

  if coalesce(p_contract_cents, 0) > 0 then
    insert into pm.contracts (org_id, job_id, kind, payer_type, original_cents, retention_pct, progress_basis,
                              billing_mode, status, created_by)
    values (v_org, v_job, 'PRIME', 'CUSTOMER', p_contract_cents, jt.default_retainage_pct, jt.progress_basis,
            jt.default_billing_mode, 'ACTIVE', pm.current_user_id())
    returning id into v_contract;
  end if;

  perform pm.log_activity(v_org, p_location, v_job, 'project.created', 'projects', v_job,
    format('Created %s %s', v_number, btrim(p_name)),
    jsonb_build_object('job_type', jt.key, 'stage', v_stage.stage_key, 'is_sample', coalesce(p_is_sample, false),
                       'contract_cents', p_contract_cents));

  if v_contract is not null then
    perform pm.emit_job_progress(v_job, 'CONTRACT_SET', null);
  end if;
  return v_job;
end $$;

-- ----------------------------------------------------------------------------
-- 15. pm.transition_stage — guarded stage change; maps stage → core.jobs.status
--   Returns failing guard names (nothing changes) or '{}' on success.
--   NOTE: stage_transitions.approval_policy_key is recorded but NOT enforced in 1100
--   (no approvals engine yet); 1101+ adds the approval request gate.
-- ----------------------------------------------------------------------------
create or replace function pm.transition_stage(p_job uuid, p_to text)
returns text[]
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org     uuid;
  v_proj    pm.projects%rowtype;
  v_machine text;
  v_tr      pm.stage_transitions%rowtype;
  v_to      pm.stage_defs%rowtype;
  v_failing text[];
begin
  select j.org_id into v_org from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;

  select * into v_proj from pm.projects p where p.org_id = v_org and p.job_id = p_job for update;
  if not found then raise exception 'PM_NOT_A_PROJECT: job %', p_job using errcode = 'P0002'; end if;
  select jt.stage_machine_key into v_machine from pm.job_types jt where jt.org_id = v_org and jt.id = v_proj.job_type_id;

  if p_to = v_proj.stage_key then raise exception 'PM_ALREADY_IN_STAGE: %', p_to using errcode = '22023'; end if;

  select * into v_tr from pm.stage_transitions t
  where t.org_id = v_org and t.location_id = v_proj.location_id and t.machine_key = v_machine
    and t.from_stage = v_proj.stage_key and t.to_stage = p_to;
  if not found then
    raise exception 'PM_TRANSITION_NOT_ALLOWED: % -> % (machine %)', v_proj.stage_key, p_to, v_machine using errcode = '22023';
  end if;
  select * into v_to from pm.stage_defs s
  where s.org_id = v_org and s.location_id = v_proj.location_id and s.machine_key = v_machine and s.stage_key = p_to and s.is_active;
  if not found then raise exception 'PM_STAGE_INACTIVE: %', p_to using errcode = '22023'; end if;

  v_failing := pm.check_guards(p_job, v_tr.guards);
  if cardinality(v_failing) > 0 then
    return v_failing;               -- nothing changed
  end if;

  update pm.projects
     set stage_key = p_to, stage_entered_at = now(),
         actual_start  = case when v_to.core_status = 'ACTIVE' and actual_start is null then current_date else actual_start end,
         actual_finish = case when v_to.core_status in ('COMPLETE','CLOSED') and actual_finish is null then current_date else actual_finish end
   where org_id = v_org and job_id = p_job;

  -- Projects is the job-status author (D10, §5): UPDATE only the status column.
  update core.jobs set status = v_to.core_status
   where org_id = v_org and id = p_job and status is distinct from v_to.core_status;

  perform pm.log_activity(v_org, v_proj.location_id, p_job, 'stage.changed', 'projects', p_job,
    format('Moved to %s', v_to.label),
    jsonb_build_object('from', v_proj.stage_key, 'to', p_to, 'core_status', v_to.core_status,
                       'guards', to_jsonb(v_tr.guards), 'approval_policy_key', v_tr.approval_policy_key,
                       'approval_enforced', false));
  return '{}'::text[];
end $$;

-- ----------------------------------------------------------------------------
-- 16. Contract + progress mutators (rev-rec inputs move only through these, D12)
-- ----------------------------------------------------------------------------
create or replace function pm.set_contract(
  p_job            uuid,
  p_original_cents bigint,
  p_kind           text    default 'PRIME',
  p_retention_pct  numeric default null,
  p_progress_basis text    default null,
  p_contract_id    uuid    default null,
  p_as_of          date    default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v_id uuid; jt pm.job_types%rowtype;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_original_cents is null or p_original_cents < 0 then raise exception 'PM_INVALID: contract must be ≥ 0' using errcode = '22023'; end if;
  select jt2.* into jt from pm.projects p join pm.job_types jt2 on jt2.org_id = p.org_id and jt2.id = p.job_type_id
  where p.org_id = v_org and p.job_id = p_job;
  if not found then raise exception 'PM_NOT_A_PROJECT: job %', p_job using errcode = 'P0002'; end if;

  if p_contract_id is null then
    insert into pm.contracts (org_id, job_id, kind, original_cents, retention_pct, progress_basis, billing_mode, status, created_by)
    values (v_org, p_job, coalesce(p_kind, 'PRIME'), p_original_cents, coalesce(p_retention_pct, jt.default_retainage_pct),
            coalesce(p_progress_basis, jt.progress_basis), jt.default_billing_mode, 'ACTIVE', pm.current_user_id())
    returning id into v_id;
  else
    update pm.contracts
       set original_cents = p_original_cents,
           kind = coalesce(p_kind, kind),
           retention_pct = coalesce(p_retention_pct, retention_pct),
           progress_basis = coalesce(p_progress_basis, progress_basis),
           status = 'ACTIVE'
     where org_id = v_org and job_id = p_job and id = p_contract_id and status in ('DRAFT','ACTIVE')
    returning id into v_id;
    if v_id is null then raise exception 'PM_CONTRACT_NOT_EDITABLE: %', p_contract_id using errcode = 'P0002'; end if;
  end if;

  perform pm.log_activity(v_org, v_loc, p_job, 'contract.set', 'contracts', v_id,
    format('Contract set to %s cents', p_original_cents), jsonb_build_object('original_cents', p_original_cents));
  perform pm.emit_job_progress(p_job, 'CONTRACT_SET', p_as_of);
  return v_id;
end $$;

create or replace function pm.set_progress(p_job uuid, p_pct numeric, p_as_of date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; n int;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_pct is null or p_pct < 0 or p_pct > 1 then raise exception 'PM_INVALID: pct must be 0..1' using errcode = '22023'; end if;
  update pm.contracts set pct_complete = p_pct
   where org_id = v_org and job_id = p_job and status = 'ACTIVE' and progress_basis in ('PHYSICAL_PCT','UNITS');
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'PM_NO_PHYSICAL_CONTRACT: no ACTIVE contract on job % tracks physical progress', p_job using errcode = 'P0002';
  end if;
  perform pm.log_activity(v_org, v_loc, p_job, 'progress.updated', 'contracts', null,
    format('Progress set to %s%%', round(p_pct * 100, 1)), jsonb_build_object('pct_complete', p_pct, 'as_of', p_as_of));
  return pm.emit_job_progress(p_job, 'PROGRESS_UPDATE', p_as_of);
end $$;

-- ----------------------------------------------------------------------------
-- 17. Change-order stage moves (preparer ≠ approver)
-- ----------------------------------------------------------------------------
create or replace function pm.approve_change_order(p_co uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare co pm.change_orders%rowtype; v_loc uuid; v_me text := pm.current_user_id();
begin
  select * into co from pm.change_orders x where x.id = p_co for update;
  if co.org_id is null or co.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: change order % not found in the caller''s organization', p_co using errcode = '42501';
  end if;
  if co.stage not in ('PCO','COR') then
    raise exception 'PM_CO_NOT_APPROVABLE: change order % is %', co.number, co.stage using errcode = '22023';
  end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  if co.created_by is not null and co.created_by = v_me then
    raise exception 'PM_SOD_VIOLATION: the preparer of % cannot approve it', co.number using errcode = '42501';
  end if;

  update pm.change_orders set stage = 'APPROVED', approved_by = v_me, approved_at = now() where id = p_co;
  select j.location_id into v_loc from core.jobs j where j.id = co.job_id;
  perform pm.log_activity(co.org_id, v_loc, co.job_id, 'change_order.approved', 'change_orders', p_co,
    format('Approved %s (%s cents)', co.number, co.amount_cents),
    jsonb_build_object('amount_cents', co.amount_cents, 'cost_impact_cents', co.cost_impact_cents, 'from', co.stage));
  return pm.emit_job_progress(co.job_id, 'CHANGE_ORDER', null);
end $$;

create or replace function pm.advance_change_order(p_co uuid, p_to text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare co pm.change_orders%rowtype; v_loc uuid; ok boolean;
begin
  select * into co from pm.change_orders x where x.id = p_co for update;
  if co.org_id is null or co.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: change order % not found in the caller''s organization', p_co using errcode = '42501';
  end if;
  ok := case co.stage
          when 'PCO' then p_to in ('COR','REJECTED','VOID')
          when 'COR' then p_to in ('PCO','REJECTED','VOID')
          when 'REJECTED' then p_to in ('PCO','VOID')
          when 'APPROVED' then p_to = 'VOID'
          else false end;
  if not ok then raise exception 'PM_CO_TRANSITION_INVALID: % -> %', co.stage, p_to using errcode = '22023'; end if;
  update pm.change_orders set stage = p_to where id = p_co;
  select j.location_id into v_loc from core.jobs j where j.id = co.job_id;
  perform pm.log_activity(co.org_id, v_loc, co.job_id, 'change_order.' || lower(p_to), 'change_orders', p_co,
    format('%s moved %s → %s', co.number, co.stage, p_to), jsonb_build_object('from', co.stage, 'to', p_to));
  if co.stage = 'APPROVED' then        -- voiding an approved CO changes the contract value
    return pm.emit_job_progress(co.job_id, 'CHANGE_ORDER', null);
  end if;
  return null;
end $$;

-- ----------------------------------------------------------------------------
-- 18. Sample job (onboarding "aha") — one per company; removable
-- ----------------------------------------------------------------------------
create or replace function pm.load_sample_job(p_location uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org     uuid;
  v_plan    jsonb;
  s         jsonb;
  v_job     uuid;
  v_budget  uuid;
  v_machine text;
  v_stage   pm.stage_defs%rowtype;
  v_missing text;
  t         record;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.sample:' || p_location::text, 0));

  select p.job_id into v_job from pm.projects p where p.org_id = v_org and p.location_id = p_location and p.is_sample limit 1;
  if v_job is not null then return v_job; end if;     -- idempotent: one sample per company

  select i.resolved into v_plan from pm.pack_installs i
  where i.org_id = v_org and i.location_id = p_location and i.role = 'primary' and i.status = 'ACTIVE';
  if v_plan is null then raise exception 'PM_NO_PACK: install a pack on this company first' using errcode = 'P0002'; end if;
  s := v_plan -> 'sample_job';
  if s is null or jsonb_typeof(s) <> 'object' then
    raise exception 'PM_NO_SAMPLE_JOB: the installed plan carries no sample_job' using errcode = 'P0002';
  end if;

  -- every budget code must exist in the company library
  select string_agg(b ->> 'code', ',') into v_missing
  from jsonb_array_elements(coalesce(s -> 'budget', '[]')) b
  where not exists (select 1 from pm.cost_codes c where c.org_id = v_org and c.location_id = p_location
                      and c.job_id is null and c.code = b ->> 'code' and c.is_active);
  if v_missing is not null then raise exception 'PM_SAMPLE_UNKNOWN_CODES: %', v_missing using errcode = 'P0002'; end if;

  v_job := pm.create_project(p_location, s ->> 'jobType', s ->> 'name', null,
                             nullif((s ->> 'contractCents')::bigint, 0), true, '{}'::jsonb);

  -- sample customer is display text only: no core.customers row is created for fake data
  update core.jobs set customer_name = nullif(s ->> 'customerName', '') where org_id = v_org and id = v_job;

  -- place the sample at its stage (seeded data; guards do not apply)
  select jt.stage_machine_key into v_machine from pm.projects p join pm.job_types jt on jt.org_id = p.org_id and jt.id = p.job_type_id
  where p.org_id = v_org and p.job_id = v_job;
  if s ->> 'stage' is not null then
    select * into v_stage from pm.stage_defs sd where sd.org_id = v_org and sd.location_id = p_location
      and sd.machine_key = v_machine and sd.stage_key = s ->> 'stage' and sd.is_active;
    if not found then raise exception 'PM_SAMPLE_UNKNOWN_STAGE: %', s ->> 'stage' using errcode = 'P0002'; end if;
    update pm.projects set stage_key = v_stage.stage_key,
           actual_start = case when v_stage.core_status <> 'BID' then current_date end
     where org_id = v_org and job_id = v_job;
    update core.jobs set status = v_stage.core_status where org_id = v_org and id = v_job and status <> v_stage.core_status;
  end if;

  insert into pm.budgets (org_id, job_id, kind, version, status, label, created_by)
  values (v_org, v_job, 'ORIGINAL', 1, 'APPROVED', 'Original budget (sample)', pm.current_user_id())
  returning id into v_budget;
  insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents, sort)
  select v_org, v_budget, c.id, (b.value ->> 'amountCents')::bigint, (b.ordinality - 1)::int
  from jsonb_array_elements(coalesce(s -> 'budget', '[]')) with ordinality b
  join pm.cost_codes c on c.org_id = v_org and c.location_id = p_location and c.job_id is null and c.code = b.value ->> 'code';

  for t in select value, ordinality from jsonb_array_elements(coalesce(s -> 'tasks', '[]')) with ordinality loop
    insert into pm.tasks (org_id, job_id, title, status, start_on, due_on, duration_days, sort, created_by, completed_at)
    select v_org, v_job, t.value ->> 'title',
           case when d.due < current_date then 'DONE' when d.st <= current_date then 'IN_PROGRESS' else 'TODO' end,
           d.st, d.due, (t.value ->> 'durationDays')::int, (t.ordinality - 1)::int, pm.current_user_id(),
           case when d.due < current_date then now() end
    from (select current_date + (t.value ->> 'offsetDays')::int as st,
                 current_date + (t.value ->> 'offsetDays')::int + (t.value ->> 'durationDays')::int as due) d;
  end loop;

  perform pm.log_activity(v_org, p_location, v_job, 'sample.loaded', 'projects', v_job,
    'Loaded the sample job', jsonb_build_object('pack_key', v_plan #>> '{primary_pack,key}'));
  return v_job;
end $$;

-- Deletes only is_sample projects (and the core.jobs rows they created). A sample job that
-- anything outside `pm` references (GL lines, invoices, bills, core.events, ...) is CANCELLED
-- instead. Returns {"removed": n, "cancelled": n}.
-- Convention for 1101+: every job-scoped pm table either carries an FK (org_id, job_id) ->
-- core.jobs (it is found and cleared automatically here) or cascades from a parent that does.
create or replace function pm.remove_sample_data(p_location uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org       uuid;
  v_job       uuid;
  fk          record;
  v_ref       boolean;
  v_removed   int := 0;
  v_cancelled int := 0;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.sample:' || p_location::text, 0));

  for v_job in select p.job_id from pm.projects p
               where p.org_id = v_org and p.location_id = p_location and p.is_sample for update loop
    -- any reference to the job from outside pm (Books GL/invoices/bills/rev-rec, legacy proj, ...)?
    v_ref := exists (select 1 from core.events e where e.org_id = v_org and e.payload ->> 'job_id' = v_job::text);
    if not v_ref then
      for fk in
        select c.conrelid::regclass as tbl, a.attname as col
        from pg_constraint c
        join pg_namespace n on n.oid = (select relnamespace from pg_class where oid = c.conrelid)
        cross join lateral unnest(c.conkey, c.confkey) as k(src, dst)
        join pg_attribute ad on ad.attrelid = c.confrelid and ad.attnum = k.dst and ad.attname = 'id'
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.src
        where c.contype = 'f' and c.confrelid = 'core.jobs'::regclass and n.nspname <> 'pm'
      loop
        execute format('select exists (select 1 from %s where %I = $1)', fk.tbl, fk.col) into v_ref using v_job;
        exit when v_ref;
      end loop;
    end if;

    if v_ref then
      update core.jobs set status = 'CANCELLED' where org_id = v_org and id = v_job and status <> 'CANCELLED';
      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    set constraints all deferred;
    for fk in
      select c.conrelid::regclass as tbl, a.attname as col
      from pg_constraint c
      join pg_namespace n on n.oid = (select relnamespace from pg_class where oid = c.conrelid)
      cross join lateral unnest(c.conkey, c.confkey) as k(src, dst)
      join pg_attribute ad on ad.attrelid = c.confrelid and ad.attnum = k.dst and ad.attname = 'id'
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.src
      where c.contype = 'f' and c.confrelid = 'core.jobs'::regclass and n.nspname = 'pm'
    loop
      execute format('delete from %s where org_id = $1 and %I = $2', fk.tbl, fk.col) using v_org, v_job;
    end loop;
    delete from core.jobs where org_id = v_org and id = v_job;
    set constraints all immediate;
    v_removed := v_removed + 1;
  end loop;

  perform pm.log_activity(v_org, p_location, null, 'sample.removed', null, null,
    format('Removed %s sample job(s); cancelled %s still referenced', v_removed, v_cancelled),
    jsonb_build_object('removed', v_removed, 'cancelled', v_cancelled));
  return jsonb_build_object('removed', v_removed, 'cancelled', v_cancelled);
end $$;

-- ----------------------------------------------------------------------------
-- 19. Views (security_invoker: RLS of the caller applies)
-- ----------------------------------------------------------------------------
create or replace view pm.v_project_list with (security_invoker = on) as
select
  p.org_id,
  p.location_id,
  p.job_id,
  j.job_number,
  j.name,
  j.status                         as core_status,
  j.customer_id,
  coalesce(cu.display_name, cu.name, j.customer_name) as customer_name,
  p.stage_key,
  sd.label                         as stage_label,
  sd.sort                          as stage_sort,
  sd.is_terminal                   as stage_is_terminal,
  p.stage_entered_at,
  jt.key                           as job_type_key,
  jt.label                         as job_type_label,
  jt.archetype,
  p.pm_user_id,
  p.super_user_id,
  p.planned_start,
  p.planned_finish,
  p.is_sample,
  m.original_contract_cents,
  m.approved_co_cents,
  m.revised_contract_cents         as contract_revised_cents,
  m.pending_co_cents,
  coalesce(m.budget_revised_cents, m.budget_original_cents) as budget_total_cents,
  m.cost_estimate_cents,
  p.created_at,
  p.updated_at
from pm.projects p
join core.jobs j        on j.org_id = p.org_id and j.id = p.job_id
join pm.job_types jt    on jt.org_id = p.org_id and jt.id = p.job_type_id
left join pm.stage_defs sd on sd.org_id = p.org_id and sd.location_id = p.location_id
                          and sd.machine_key = jt.stage_machine_key and sd.stage_key = p.stage_key
left join core.customers cu on cu.org_id = j.org_id and cu.id = j.customer_id
left join pm.v_job_money m  on m.org_id = p.org_id and m.job_id = p.job_id;

create or replace view pm.v_job_overview with (security_invoker = on) as
select
  m.org_id,
  m.job_id,
  m.original_contract_cents,
  m.approved_co_cents,
  m.revised_contract_cents,
  m.pending_co_cents,
  m.pending_co_count,
  m.budget_original_cents,
  m.budget_revised_cents,
  m.cost_estimate_cents,
  (m.revised_contract_cents - m.cost_estimate_cents)::bigint as projected_margin_cents,
  coalesce(t.open_count, 0)::int    as tasks_open,
  coalesce(t.overdue_count, 0)::int as tasks_overdue,
  coalesce(t.total_count, 0)::int   as tasks_total,
  coalesce(pi.open_count, 0)::int   as punch_open,
  fl.last_log_date,
  a.last_activity_at,
  ps.last_snapshot_version,
  ps.last_snapshot_as_of
from pm.v_job_money m
left join lateral (
  select count(*) filter (where x.status not in ('DONE','CANCELLED'))                              as open_count,
         count(*) filter (where x.status not in ('DONE','CANCELLED') and x.due_on < current_date)  as overdue_count,
         count(*) filter (where x.status <> 'CANCELLED')                                           as total_count
  from pm.tasks x where x.org_id = m.org_id and x.job_id = m.job_id
) t on true
left join lateral (
  select count(*) as open_count from pm.punch_items x
  where x.org_id = m.org_id and x.job_id = m.job_id and x.status not in ('CLOSED','VOID')
) pi on true
left join lateral (
  select max(x.log_date) as last_log_date from pm.field_logs x where x.org_id = m.org_id and x.job_id = m.job_id
) fl on true
left join lateral (
  select max(x.created_at) as last_activity_at from pm.activity x where x.org_id = m.org_id and x.job_id = m.job_id
) a on true
left join lateral (
  select max(x.snapshot_version) as last_snapshot_version, max(x.as_of_date) as last_snapshot_as_of
  from pm.progress_snapshots x where x.org_id = m.org_id and x.job_id = m.job_id
) ps on true;

-- Vocabulary stays in the resolved plan (display-only; not an FK target, guard input or
-- KPI — review 05 §4.1.2). The compiler merges add-on vocabulary into the primary plan.
create or replace view pm.v_vocabulary with (security_invoker = on) as
select i.org_id, i.location_id, i.pack_key, v.key as vocab_key, v.value as label
from pm.pack_installs i
cross join lateral jsonb_each_text(coalesce(i.resolved -> 'vocabulary', '{}'::jsonb)) v
where i.role = 'primary' and i.status = 'ACTIVE';

-- ----------------------------------------------------------------------------
-- 20. RLS (D12): every org-scoped table USING + WITH CHECK (org_id = get_org_id()).
--     State-bearing tables get per-command policies that pin the client-writable states.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pack_installs','pack_overrides','job_types','stage_defs','stage_transitions',
    'approval_policies','field_defs','cost_codes','price_book_items','kpi_defs','onboarding_runs','doc_counters',
    'projects','wbs_nodes','tasks','task_deps','budgets','budget_lines','contracts','change_orders',
    'progress_snapshots','field_logs','punch_items','time_entries','document_links','activity','pack_registry'] loop
    execute format('alter table pm.%I enable row level security', t);
  end loop;

  -- uniform org isolation
  foreach t in array array['pack_installs','pack_overrides','job_types','stage_defs','stage_transitions',
    'approval_policies','cost_codes','price_book_items','kpi_defs','doc_counters','projects','wbs_nodes',
    'tasks','task_deps','budgets','budget_lines','contracts','progress_snapshots','field_logs','punch_items',
    'document_links'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
end $$;

do $$
begin
  -- registry: global catalog, readable by members
  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='pack_registry' and policyname='registry_read') then
    create policy registry_read on pm.pack_registry for select using (status <> 'DRAFT');
  end if;

  -- field defs: members manage TENANT fields only; PACK rows come from apply_pack_plan
  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='field_defs' and policyname='org_select') then
    create policy org_select on pm.field_defs for select using (org_id = public.get_org_id());
    create policy tenant_insert on pm.field_defs for insert with check (org_id = public.get_org_id() and source = 'TENANT' and install_id is null);
    create policy tenant_update on pm.field_defs for update using (org_id = public.get_org_id() and source = 'TENANT')
      with check (org_id = public.get_org_id() and source = 'TENANT' and install_id is null);
    create policy tenant_delete on pm.field_defs for delete using (org_id = public.get_org_id() and source = 'TENANT');
  end if;

  -- onboarding runs: members drive steps; APPLIED/COMPLETE are set by functions (COMPLETE also by the app at the end)
  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='onboarding_runs' and policyname='org_select') then
    create policy org_select on pm.onboarding_runs for select using (org_id = public.get_org_id());
    create policy org_insert on pm.onboarding_runs for insert with check (org_id = public.get_org_id() and status = 'IN_PROGRESS' and install_id is null);
    create policy org_update on pm.onboarding_runs for update using (org_id = public.get_org_id())
      with check (org_id = public.get_org_id() and status in ('IN_PROGRESS','ABANDONED','COMPLETE'));
  end if;

  -- change orders: clients create/edit/delete open COs only; stage moves via definer fns
  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='change_orders' and policyname='org_select') then
    create policy org_select on pm.change_orders for select using (org_id = public.get_org_id());
    create policy open_insert on pm.change_orders for insert
      with check (org_id = public.get_org_id() and stage in ('PCO','COR') and approved_by is null and approved_at is null);
    create policy open_update on pm.change_orders for update using (org_id = public.get_org_id() and stage in ('PCO','COR'))
      with check (org_id = public.get_org_id() and stage in ('PCO','COR'));
    create policy open_delete on pm.change_orders for delete using (org_id = public.get_org_id() and stage = 'PCO');
  end if;

  -- time entries: clients write unapproved entries without rates; approval pins rates (1101+)
  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='time_entries' and policyname='org_select') then
    create policy org_select on pm.time_entries for select using (org_id = public.get_org_id());
    create policy draft_insert on pm.time_entries for insert
      with check (org_id = public.get_org_id() and approval_state in ('DRAFT','SUBMITTED')
                  and cost_rate_cents is null and bill_rate_cents is null and approved_by is null and approved_at is null);
    create policy draft_update on pm.time_entries for update
      using (org_id = public.get_org_id() and approval_state in ('DRAFT','SUBMITTED','REJECTED'))
      with check (org_id = public.get_org_id() and approval_state in ('DRAFT','SUBMITTED'));
    create policy draft_delete on pm.time_entries for delete
      using (org_id = public.get_org_id() and approval_state in ('DRAFT','SUBMITTED','REJECTED'));
  end if;

  -- activity: append-only; clients append HUMAN rows as themselves
  if not exists (select 1 from pg_policies where schemaname='pm' and tablename='activity' and policyname='org_select') then
    create policy org_select on pm.activity for select using (org_id = public.get_org_id());
    create policy self_append on pm.activity for insert
      with check (org_id = public.get_org_id() and actor_type = 'HUMAN' and actor_id is not distinct from pm.current_user_id());
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 21. Table grants. Baseline: nothing for anon/PUBLIC. service_role gets everything.
--     authenticated: config + money-state tables read-only (writes via definer fns);
--     column-level UPDATE where a state column must only move through functions.
-- ----------------------------------------------------------------------------
revoke all on all tables in schema pm from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema pm to service_role;

grant select on pm.pack_registry, pm.pack_installs, pm.job_types, pm.stage_defs, pm.stage_transitions,
               pm.approval_policies, pm.kpi_defs, pm.progress_snapshots, pm.contracts
  to authenticated;

grant select, insert, delete on pm.pack_overrides to authenticated;

grant select, insert, update, delete on pm.field_defs, pm.cost_codes, pm.price_book_items, pm.wbs_nodes,
               pm.tasks, pm.task_deps, pm.budgets, pm.budget_lines, pm.field_logs, pm.punch_items
  to authenticated;

grant select, insert on pm.onboarding_runs to authenticated;
grant update (step, status, inputs, classification, plan, ai_decision_id, completed_at) on pm.onboarding_runs to authenticated;

-- pm.projects: created by pm.create_project; stage_key / is_sample / job_type_id move only via functions
grant select on pm.projects to authenticated;
grant update (pm_user_id, super_user_id, site_address_line1, site_address_line2, site_city, site_state, site_zip,
              site_lat, site_lng, planned_start, planned_finish, actual_start, actual_finish, ext)
  on pm.projects to authenticated;

-- pm.change_orders: stage / approved_* only via approve_change_order / advance_change_order
grant select, insert, delete on pm.change_orders to authenticated;
grant update (contract_id, title, description, reason, amount_cents, cost_impact_cents, schedule_days, ext)
  on pm.change_orders to authenticated;

-- pm.time_entries: rates / approval only via definer fns (1101+)
grant select, insert, delete on pm.time_entries to authenticated;
grant update (employee_id, user_id, work_date, hours, pay_type, units, cost_code_id, task_id, wbs_id, billable,
              notes, approval_state)
  on pm.time_entries to authenticated;

grant select, insert, delete on pm.document_links to authenticated;
grant select, insert on pm.activity to authenticated;
-- pm.doc_counters: no member access (internal)

grant select on pm.v_job_money, pm.v_project_list, pm.v_job_overview, pm.v_vocabulary to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 22. Function grants (1007 pattern): revoke everything, then grant the member RPC
--     surface. Internal helpers (next_doc_number, log_activity, books_present,
--     validate_ext, trigger fns) stay owner/service_role only.
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm' loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm'
             and (p.proname in ('apply_pack_plan','create_project','transition_stage','emit_job_progress',
                                'set_contract','set_progress','approve_change_order','advance_change_order',
                                'load_sample_job','remove_sample_data','check_guards','guard_names','current_user_id')
                  or p.proname like 'guard\_%') loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

-- ============================================================================
-- end 1100_pm_foundation
-- ============================================================================
