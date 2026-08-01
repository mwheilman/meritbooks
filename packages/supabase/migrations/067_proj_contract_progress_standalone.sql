-- RENUMBERED for the shared meritbooks migration set (was 0003_proj_contract_progress_standalone.sql).
-- Applies proj objects onto the LIVE shared DB where core already exists (019-061).
-- Verified: creates only proj.* + FKs to existing core; no core stubs. --

-- ============================================================================
-- MeritProjects — Contract / Change-Order SoT + JOB_PROGRESS + Standalone
-- Migration 0003 :: builds on 0001 (schema `proj`)
--
-- Authorities (build to exactly; do not redefine):
--   * Event & Cost/Billing Contract (FROZEN v3) §5 (JOB_PROGRESS), §10 (standalone)
--   * Shared Object Ownership Matrix (rev-rec INPUTS authored by Projects, pinned by Books;
--     OUTPUTS Books-owned; operational figure Projects-owned)
--
-- Scope of this migration:
--   (1) proj.contracts + proj.change_orders  = Projects-owned SoT for
--       contract value (incl. approved COs), cost estimate at completion, % complete.
--   (2) proj.emit_job_progress = JOB_PROGRESS snapshot emitter (Projects -> Books).
--   (3) Contract-doc + AI-extract landing tables + auto-built billing schedule.
--   (4) Standalone operation: proj.tenant_runtime + proj.captured_costs;
--       operational-cost source switches on Books presence; draws surface UNISSUED.
--   (5) invoice_number back-fill once Books exposes it on core.events (dynamic).
--
-- Boundaries: never write Books-owned columns on core.jobs (recognized/WIP/OUTPUT
-- columns AND the rev-rec INPUT columns — those are written by Books on JOB_PROGRESS,
-- never by Projects). Never write GL/invoices. References core by FK only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. Standalone runtime flag — Projects' LOCAL copy of the entitlements decision.
--    The entitlements layer (Suite-Core-owned) is the authority; it "tells" the
--    module whether its sibling is present. Projects keeps this local flag for
--    source-switching and never owns/decides entitlements. Default = Books present
--    (the integrated-suite default); standalone tenants are provisioned with false.
-- ----------------------------------------------------------------------------
create table if not exists proj.tenant_runtime (
  org_id        uuid primary key references core.organizations(id) on delete cascade,
  books_present boolean not null default true,
  updated_at    timestamptz not null default now()
);

create or replace function proj.books_present(p_org_id uuid)
returns boolean
language sql stable
set search_path = proj, public
as $$
  select coalesce((select books_present from proj.tenant_runtime where org_id = p_org_id), true)
$$;

-- ----------------------------------------------------------------------------
-- B. Contract — Projects-owned system of record for the rev-rec INPUTS and the
--    billing cadence. One contract per job. `pct_complete` is Projects' own
--    physical/schedule measurement; it is NULL unless Projects is tracking
--    progress (progress_basis PHYSICAL/SCHEDULE). Projects does NOT resolve the
--    Books rev-rec method — it supplies inputs; Books decides whether/how to use
--    pct_complete per the resolved method.
-- ----------------------------------------------------------------------------
create table if not exists proj.contracts (
  id                       uuid primary key default uuid_generate_v4(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                   uuid not null references core.jobs(id),
  location_id              uuid not null,
  original_contract_cents  bigint not null default 0,   -- base contract value
  cost_estimate_cents      bigint not null default 0,   -- estimate at completion (base)
  pct_complete             numeric(5,4)                 -- 0..1 physical/schedule %; NULL when not tracked
                             check (pct_complete is null or (pct_complete >= 0 and pct_complete <= 1)),
  progress_basis           text not null default 'NONE'
                             check (progress_basis in ('NONE','PHYSICAL','SCHEDULE')),
  billing_cadence          text,                        -- structured/free note from extraction
  status                   text not null default 'DRAFT'
                             check (status in ('DRAFT','ACTIVE','CLOSED')),
  source_document_id       uuid,                        -- -> proj.contract_documents
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, job_id)
);
create index if not exists idx_proj_contracts_job on proj.contracts(org_id, job_id);

-- ----------------------------------------------------------------------------
-- C. Change orders — approved COs roll into the current contract value + EAC.
-- ----------------------------------------------------------------------------
create table if not exists proj.change_orders (
  id                        uuid primary key default uuid_generate_v4(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                    uuid not null references core.jobs(id),
  contract_id               uuid not null references proj.contracts(id) on delete cascade,
  co_number                 text,
  description               text,
  contract_delta_cents      bigint not null default 0,
  cost_estimate_delta_cents bigint not null default 0,
  status                    text not null default 'DRAFT'
                              check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  approved_by               text,
  approved_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists idx_proj_co_contract on proj.change_orders(org_id, contract_id);

-- Current truth = base + approved COs. This is what JOB_PROGRESS snapshots carry.
create or replace view proj.v_contract_current
  with (security_invoker = on) as
select
  c.org_id, c.job_id, c.location_id, c.id as contract_id, c.status, c.pct_complete, c.progress_basis,
  (c.original_contract_cents
     + coalesce((select sum(co.contract_delta_cents) from proj.change_orders co
                 where co.contract_id = c.id and co.status = 'APPROVED'), 0))::bigint
                                                          as contract_value_cents,
  (c.cost_estimate_cents
     + coalesce((select sum(co.cost_estimate_delta_cents) from proj.change_orders co
                 where co.contract_id = c.id and co.status = 'APPROVED'), 0))::bigint
                                                          as cost_estimate_cents
from proj.contracts c;

-- ----------------------------------------------------------------------------
-- D. Contract documents + AI extraction landing.
-- ----------------------------------------------------------------------------
create table if not exists proj.contract_documents (
  id                uuid primary key default uuid_generate_v4(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null references core.jobs(id),
  storage_path      text,                       -- Supabase storage object path
  filename          text,
  mime_type         text,
  extraction_status text not null default 'PENDING'
                      check (extraction_status in ('PENDING','EXTRACTED','FAILED','APPROVED')),
  extracted         jsonb,                       -- {contract_value_cents, cost_estimate_cents, billing_cadence:[...]}
  extraction_error  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_proj_contract_docs_job on proj.contract_documents(org_id, job_id);

-- ----------------------------------------------------------------------------
-- E. Billing schedule lines — auto-built from extraction, approved for billing.
--    An approved line is the source for a JOB_BILLING draw (the single capture
--    point feeds BOTH JOB_PROGRESS inputs and JOB_BILLING draws).
-- ----------------------------------------------------------------------------
create table if not exists proj.billing_schedule_lines (
  id                  uuid primary key default uuid_generate_v4(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null references core.jobs(id),
  contract_id         uuid references proj.contracts(id) on delete cascade,
  seq                 int not null default 0,
  description         text not null,
  billing_type        text not null
                        check (billing_type in ('MILESTONE','PROGRESS','TIME_MATERIALS','DRAW')),
  scheduled_amount_cents bigint not null default 0,
  scheduled_on        date,
  milestone_label     text,
  status              text not null default 'PENDING_APPROVAL'
                        check (status in ('PENDING_APPROVAL','APPROVED','REJECTED','BILLED')),
  billing_request_id  uuid references proj.billing_requests(id),  -- set when a draw is cut
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_proj_sched_job on proj.billing_schedule_lines(org_id, job_id);

-- ----------------------------------------------------------------------------
-- F. Standalone captured costs — Projects' OWN cost capture when Books is absent.
--    Same shape/lifecycle vocabulary as proj.job_costs, but Projects-authored.
-- ----------------------------------------------------------------------------
create table if not exists proj.captured_costs (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null references core.jobs(id),
  location_id   uuid,
  department_id uuid,
  source_ref    text not null,
  cost_type     text,
  amount_cents  bigint not null default 0,
  lifecycle     text not null default 'CLEARED'
                  check (lifecycle in ('PENDING','CLEARED','VOIDED')),
  occurred_on   date,
  memo          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, source_ref)
);
create index if not exists idx_proj_captured_job on proj.captured_costs(org_id, job_id);

-- ----------------------------------------------------------------------------
-- G. JOB_PROGRESS emission log (audit; records standalone log-only emissions too).
-- ----------------------------------------------------------------------------
create table if not exists proj.job_progress_log (
  id                   uuid primary key default uuid_generate_v4(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null references core.jobs(id),
  event_id             uuid,
  trigger              text not null,
  contract_value_cents bigint,
  cost_estimate_cents  bigint,
  pct_complete         numeric(5,4),
  emitted              boolean not null,        -- false in standalone (no Books consumer)
  created_at           timestamptz not null default now()
);
create index if not exists idx_proj_progress_job on proj.job_progress_log(org_id, job_id);

-- ----------------------------------------------------------------------------
-- H. RLS + grants on the new tables.
-- ----------------------------------------------------------------------------
alter table proj.tenant_runtime         enable row level security;
alter table proj.contracts              enable row level security;
alter table proj.change_orders          enable row level security;
alter table proj.contract_documents     enable row level security;
alter table proj.billing_schedule_lines enable row level security;
alter table proj.captured_costs         enable row level security;
alter table proj.job_progress_log       enable row level security;

do $$
begin
  execute 'create policy org_isolation on proj.tenant_runtime         for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.contracts              for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.change_orders          for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.contract_documents     for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.billing_schedule_lines for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.captured_costs         for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.job_progress_log       for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
exception when duplicate_object then null;
end $$;

grant select, insert, update, delete on all tables in schema proj to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- I. JOB_PROGRESS emitter — snapshot keyed by job_id, full current truth.
--    Emits on CONTRACT_SET | CHANGE_ORDER | PROGRESS_UPDATE.
--    Supplies inputs ONLY: never computes recognition, never picks the method.
--    In standalone (Books absent) there is no consumer -> log only, no event.
-- ----------------------------------------------------------------------------
create or replace function proj.emit_job_progress(
  p_job_id  uuid,
  p_trigger text,
  p_memo    text default null
) returns uuid
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare
  vc        proj.v_contract_current%rowtype;
  v_org     uuid;
  v_loc     uuid;
  v_pct     numeric(5,4);
  v_event   uuid;
  v_books   boolean;
  v_srcref  text;
  v_payload jsonb;
begin
  if p_trigger not in ('CONTRACT_SET','CHANGE_ORDER','PROGRESS_UPDATE') then
    raise exception 'Invalid JOB_PROGRESS trigger: %', p_trigger;
  end if;

  select * into vc from proj.v_contract_current where job_id = p_job_id;
  if not found then
    raise exception 'No contract for job % — set the contract before emitting progress', p_job_id;
  end if;

  v_org := vc.org_id;
  v_loc := vc.location_id;
  -- pct_complete carried ONLY when Projects is tracking physical/schedule progress;
  -- NULL otherwise. Books governs whether it is used (the resolved method, not the
  -- null-ness, decides). Projects never resolves the method.
  v_pct := case when vc.progress_basis in ('PHYSICAL','SCHEDULE') then vc.pct_complete else null end;
  v_books := proj.books_present(v_org);
  v_event := uuid_generate_v4();
  v_srcref := p_trigger || ':' || p_job_id::text;

  if v_books then
    v_payload := jsonb_build_object(
      'event_id',             v_event,
      'event_type',           'JOB_PROGRESS',
      'source_module',        'PROJECTS',
      'org_id',               v_org,
      'location_id',          v_loc,
      'job_id',               p_job_id,
      'trigger',              p_trigger,
      'contract_value_cents', vc.contract_value_cents,
      'cost_estimate_cents',  vc.cost_estimate_cents,
      'pct_complete',         v_pct,        -- jsonb null when not tracked
      'occurred_on',          to_char(current_date, 'YYYY-MM-DD'),
      'source_ref',           v_srcref,
      'memo',                 p_memo
    );
    insert into core.events
      (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values
      (v_org, v_event, 'JOB_PROGRESS', 'PROJECTS', v_payload, current_date, 'pending');
  else
    -- standalone: no Books consumer, no recognition. Values live in proj.contracts.
    v_event := null;
  end if;

  insert into proj.job_progress_log
    (org_id, job_id, event_id, trigger, contract_value_cents, cost_estimate_cents, pct_complete, emitted)
  values
    (v_org, p_job_id, v_event, p_trigger, vc.contract_value_cents, vc.cost_estimate_cents, v_pct, v_books);

  return v_event;
end $$;

-- ----------------------------------------------------------------------------
-- J. Contract set / change-order approve / progress update — each fires a snapshot.
--    set_contract enforces the rev-rec discriminator exists (job_type or archetype),
--    so Books can resolve a method. Projects authors values; it never writes the
--    Books-pinned INPUT columns on core.jobs.
-- ----------------------------------------------------------------------------
create or replace function proj.set_contract(
  p_job_id                  uuid,
  p_original_contract_cents bigint,
  p_cost_estimate_cents     bigint,
  p_billing_cadence         text default null,
  p_progress_basis          text default 'NONE'
) returns uuid
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare
  v_org uuid; v_loc uuid; v_type text; v_arch text; v_contract uuid;
begin
  select org_id, location_id, job_type, archetype into v_org, v_loc, v_type, v_arch
  from core.jobs where id = p_job_id;
  if v_org is null then raise exception 'Job % not found', p_job_id; end if;

  -- rev-rec method discriminator must exist at this point (set at job creation).
  if coalesce(v_type, v_arch) is null then
    raise exception 'PRECONDITION_NO_JOB_TYPE: job % has neither job_type nor archetype; set the type at job creation so Books can resolve the rev-rec method', p_job_id;
  end if;

  insert into proj.contracts as c
    (org_id, job_id, location_id, original_contract_cents, cost_estimate_cents,
     billing_cadence, progress_basis, status)
  values
    (v_org, p_job_id, v_loc, p_original_contract_cents, p_cost_estimate_cents,
     p_billing_cadence, coalesce(p_progress_basis,'NONE'), 'ACTIVE')
  on conflict (org_id, job_id) do update
    set original_contract_cents = excluded.original_contract_cents,
        cost_estimate_cents     = excluded.cost_estimate_cents,
        billing_cadence         = coalesce(excluded.billing_cadence, c.billing_cadence),
        progress_basis          = excluded.progress_basis,
        status                  = 'ACTIVE',
        updated_at              = now()
  returning id into v_contract;

  perform proj.emit_job_progress(p_job_id, 'CONTRACT_SET', 'contract set');
  return v_contract;
end $$;

create or replace function proj.approve_change_order(
  p_co_id    uuid,
  p_approver text default null
) returns uuid
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare v_job uuid; v_event uuid;
begin
  update proj.change_orders
    set status = 'APPROVED', approved_by = p_approver, approved_at = now(), updated_at = now()
  where id = p_co_id and status in ('DRAFT','SUBMITTED','REJECTED')
  returning job_id into v_job;
  if v_job is null then raise exception 'Change order % not found or not approvable', p_co_id; end if;

  v_event := proj.emit_job_progress(v_job, 'CHANGE_ORDER', 'change order approved');
  return v_event;
end $$;

create or replace function proj.update_progress(
  p_job_id uuid,
  p_pct    numeric,
  p_basis  text default 'PHYSICAL'
) returns uuid
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare v_event uuid;
begin
  if p_basis not in ('NONE','PHYSICAL','SCHEDULE') then
    raise exception 'Invalid progress_basis: %', p_basis;
  end if;
  if p_basis <> 'NONE' and (p_pct is null or p_pct < 0 or p_pct > 1) then
    raise exception 'pct_complete must be between 0 and 1 for a tracked basis (got %)', p_pct;
  end if;

  update proj.contracts
    set pct_complete = case when p_basis = 'NONE' then null else p_pct end,
        progress_basis = p_basis,
        updated_at = now()
  where job_id = p_job_id;
  if not found then raise exception 'No contract for job %', p_job_id; end if;

  v_event := proj.emit_job_progress(p_job_id, 'PROGRESS_UPDATE', 'progress update');
  return v_event;
end $$;

-- ----------------------------------------------------------------------------
-- K. Standalone-aware billing emit (replaces 0001's function).
--    Books present -> emit JOB_BILLING (unchanged behavior).
--    Books absent   -> no consumer: mark the draw UNISSUED for display, no event.
-- ----------------------------------------------------------------------------
alter table proj.billing_requests drop constraint if exists billing_requests_status_check;
alter table proj.billing_requests
  add constraint billing_requests_status_check
  check (status in ('DRAFT','EMITTED','PROCESSED','REJECTED','UNISSUED'));

create or replace function proj.approve_and_emit_billing(
  p_request_id uuid,
  p_approver   text default null
) returns uuid
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare
  br        proj.billing_requests%rowtype;
  v_cust    uuid;
  v_lines   jsonb;
  v_total   bigint;
  v_event   uuid := uuid_generate_v4();
  v_payload jsonb;
begin
  select * into br from proj.billing_requests where id = p_request_id for update;
  if not found then raise exception 'Billing request % not found', p_request_id; end if;
  if br.status not in ('DRAFT','REJECTED') then
    raise exception 'Billing request % is %; only DRAFT/REJECTED can be emitted', p_request_id, br.status;
  end if;

  select customer_id into v_cust from core.jobs where id = br.job_id;
  if v_cust is null then
    raise exception 'PRECONDITION_NO_CUSTOMER: job % has no customer_id; set one before billing', br.job_id;
  end if;

  select
    jsonb_agg(jsonb_build_object('description', l.description, 'amount_cents', l.amount_cents, 'item_id', l.item_id) order by l.sort_order),
    coalesce(sum(l.amount_cents), 0)
  into v_lines, v_total
  from proj.billing_request_lines l
  where l.billing_request_id = br.id;

  if v_lines is null then raise exception 'PRECONDITION_NO_LINES: billing request % has no lines', br.id; end if;
  if v_total <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: total must be > 0 (got %)', v_total; end if;

  -- Standalone: no ledger consumer. Surface as UNISSUED, do not emit an event.
  if not proj.books_present(br.org_id) then
    update proj.billing_requests
      set status = 'UNISSUED', approved_by = p_approver, approved_at = now(),
          rejection_reason = null, updated_at = now()
    where id = br.id;
    return null;
  end if;

  v_payload := jsonb_build_object(
    'event_id', v_event, 'event_type','JOB_BILLING', 'source_module','PROJECTS',
    'org_id', br.org_id, 'location_id', br.location_id, 'job_id', br.job_id,
    'billing_type', br.billing_type, 'occurred_on', to_char(br.occurred_on,'YYYY-MM-DD'),
    'source_ref', br.source_ref, 'memo', br.memo, 'lines', v_lines
  );
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (br.org_id, v_event, 'JOB_BILLING', 'PROJECTS', v_payload, br.occurred_on, 'pending');

  update proj.billing_requests
    set status='EMITTED', event_id=v_event, approved_by=p_approver, approved_at=now(),
        rejection_reason=null, updated_at=now()
  where id = br.id;

  return v_event;
end $$;

-- ----------------------------------------------------------------------------
-- L. Operational-cost source switch (replaces 0001's view).
--    Books present -> event-fed proj.job_costs ; standalone -> proj.captured_costs.
--    The per-org filter on proj.books_present prevents double counting.
-- ----------------------------------------------------------------------------
create or replace view proj.v_job_operational_cost
  with (security_invoker = on) as
select org_id, job_id,
  coalesce(sum(amount_cents) filter (where lifecycle = 'CLEARED'), 0)::bigint as operational_actual_cents,
  coalesce(sum(amount_cents) filter (where lifecycle = 'PENDING'), 0)::bigint as pending_cents
from (
  select org_id, job_id, amount_cents, lifecycle
  from proj.job_costs jc
  where proj.books_present(jc.org_id)            -- integrated: Books-emitted costs
  union all
  select org_id, job_id, amount_cents, lifecycle
  from proj.captured_costs cc
  where not proj.books_present(cc.org_id)         -- standalone: Projects-captured costs
) s
group by org_id, job_id;

-- ----------------------------------------------------------------------------
-- M. Margin view (replaces 0001's view): revenue from the Projects contract
--    current value when present (works in BOTH modes), else the Books-pinned
--    core.jobs.contract_amount_cents. Operational actual + budget tracking.
-- ----------------------------------------------------------------------------
drop view if exists proj.v_job_margin;
create view proj.v_job_margin
  with (security_invoker = on) as
with bud as (
  select org_id, job_id,
         coalesce(sum(budgeted_cents),0)::bigint  as budget_cents,
         coalesce(sum(committed_cents),0)::bigint as committed_cents
  from proj.job_budget_lines group by org_id, job_id
)
select
  j.org_id,
  j.id                                   as job_id,
  j.job_number,
  j.name,
  -- revenue: Projects contract (SoT) current value preferred; Books-pinned fallback.
  coalesce(vc.contract_value_cents, j.contract_amount_cents, 0)::bigint     as revenue_contract_cents,
  coalesce(vc.cost_estimate_cents, 0)::bigint                               as cost_estimate_cents,
  coalesce(oc.operational_actual_cents, 0)::bigint                          as operational_actual_cents,
  coalesce(oc.pending_cents, 0)::bigint                                     as operational_pending_cents,
  coalesce(b.budget_cents, 0)::bigint                                       as budget_cents,
  coalesce(b.committed_cents, 0)::bigint                                    as committed_cents,
  (coalesce(vc.contract_value_cents, j.contract_amount_cents, 0)
     - coalesce(oc.operational_actual_cents,0))::bigint                     as operational_margin_cents,
  case when coalesce(vc.contract_value_cents, j.contract_amount_cents, 0) > 0
    then round(((coalesce(vc.contract_value_cents, j.contract_amount_cents, 0) - coalesce(oc.operational_actual_cents,0))::numeric
                 / coalesce(vc.contract_value_cents, j.contract_amount_cents)) * 100, 2)
    else null end                                                          as operational_margin_pct,
  (coalesce(b.budget_cents,0)
     - coalesce(oc.operational_actual_cents,0)
     - coalesce(b.committed_cents,0)
     - coalesce(oc.pending_cents,0))::bigint                               as budget_remaining_cents
from core.jobs j
left join proj.v_contract_current vc on vc.org_id = j.org_id and vc.job_id = j.id
left join proj.v_job_operational_cost oc on oc.org_id = j.org_id and oc.job_id = j.id
left join bud b on b.org_id = j.org_id and b.job_id = j.id;

grant select on proj.v_contract_current, proj.v_job_operational_cost, proj.v_job_margin
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- N. invoice_number back-fill (replaces 0001's reconcile). Reads invoice_id as
--    before; ALSO populates proj.billing_requests.invoice_number IF and only if
--    Books has exposed an invoice_number column on core.events (detected
--    dynamically, so this is safe whether or not the column exists yet).
--    Never reads Books' invoices table.
-- ----------------------------------------------------------------------------
create or replace function proj.reconcile_billing_requests(p_org_id uuid default null)
returns int
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare
  has_num boolean;
  n int := 0;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'core' and table_name = 'events' and column_name = 'invoice_number'
  ) into has_num;

  if has_num then
    -- dynamic: include invoice_number when the column exists
    execute $dyn$
      update proj.billing_requests br set
        status = case e.status when 'processed' then 'PROCESSED' else 'REJECTED' end,
        invoice_id = case when e.status='processed' then e.invoice_id else br.invoice_id end,
        invoice_number = case when e.status='processed' then e.invoice_number else br.invoice_number end,
        rejection_reason = case when e.status='rejected' then coalesce(e.error,'Rejected by Books') else null end,
        updated_at = now()
      from core.events e
      where e.org_id = br.org_id and e.event_id = br.event_id and e.event_type='JOB_BILLING'
        and br.status='EMITTED' and e.status in ('processed','rejected')
        and ($1 is null or br.org_id = $1)
    $dyn$ using p_org_id;
    get diagnostics n = row_count;
  else
    update proj.billing_requests br set
      status = case e.status when 'processed' then 'PROCESSED' else 'REJECTED' end,
      invoice_id = case when e.status='processed' then e.invoice_id else br.invoice_id end,
      rejection_reason = case when e.status='rejected' then coalesce(e.error,'Rejected by Books') else null end,
      updated_at = now()
    from core.events e
    where e.org_id = br.org_id and e.event_id = br.event_id and e.event_type='JOB_BILLING'
      and br.status='EMITTED' and e.status in ('processed','rejected')
      and (p_org_id is null or br.org_id = p_org_id);
    get diagnostics n = row_count;
  end if;

  return n;
end $$;

grant execute on function
  proj.books_present(uuid),
  proj.emit_job_progress(uuid, text, text),
  proj.set_contract(uuid, bigint, bigint, text, text),
  proj.approve_change_order(uuid, text),
  proj.update_progress(uuid, numeric, text),
  proj.reconcile_billing_requests(uuid)
to authenticated, service_role;

-- ============================================================================
-- end migration 0003
-- ============================================================================
