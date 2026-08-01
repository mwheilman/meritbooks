-- RENUMBERED for the shared meritbooks migration set (was 0001_proj_seam.sql).
-- Applies proj objects onto the LIVE shared DB where core already exists (019-061).
-- Verified: creates only proj.* + FKs to existing core; no core stubs. --

-- ============================================================================
-- MeritProjects — Cost/Billing Seam (Projects side)
-- Migration 0001 :: schema `proj`
--
-- Authorities (do not redefine here):
--   * Shared Object Ownership Matrix      (ownership)
--   * Event & Cost/Billing Contract v2    (wire shapes, FROZEN)
--   * core layer state & reference (S16)  (physical core state)
--   * SEAM-HANDOFF-to-projects.md         (Books side, deployed/verified)
--
-- Builds the Projects side ONLY:
--   (1) JOB_COST consumer  -> operational cost roll-up (proj-owned figure)
--   (2) operational margin + actual/committed/pending-to-budget tracking
--   (3) JOB_BILLING emitter (draft draw -> approve -> emit -> reconcile)
--
-- Boundaries enforced:
--   * references core.* by UUID FK; never copies core rows
--   * never writes a Books-owned column on core.jobs; never writes GL/invoices
--   * touches core.events only (owns JOB_COST row status; emits JOB_BILLING)
-- Money: integer cents (bigint). Tenancy: org_id + RLS public.get_org_id().
-- ============================================================================

create schema if not exists proj;
grant usage on schema proj to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 1. proj.job_costs — the operational cost, state-machined per underlying cost.
--    KEYED ON (org_id, source_ref), NOT on event_id. Each JOB_COST lifecycle
--    row (PENDING -> CLEARED -> VOIDED) carries its own event_id but the SAME
--    source_ref; we apply each as a state change to the one cost row. This is
--    what prevents the operational figure from double-counting transitions.
-- ----------------------------------------------------------------------------
create table if not exists proj.job_costs (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  job_id          uuid not null references core.jobs(id),
  location_id     uuid,
  department_id   uuid,
  source_ref      text not null,                 -- the cost identity (bill/txn/timesheet)
  cost_type       text,                           -- LABOR|MATERIALS|SUBCONTRACTOR|EQUIPMENT|OTHER
  amount_cents    bigint not null default 0,
  lifecycle       text not null                   -- PENDING|CLEARED|VOIDED
                    check (lifecycle in ('PENDING','CLEARED','VOIDED')),
  gate            text,                           -- PAYABLE_APPROVAL|BANKFEED_CATEGORIZATION|TIMESHEET_PAYROLL
  occurred_on     date,
  gl_entry_id     uuid,                           -- Books' posting ref (traceability only)
  memo            text,
  last_event_id   uuid not null,                  -- newest applied event for this cost
  last_event_at   timestamptz not null,           -- monotonic guard (created_at of newest event)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, source_ref)
);
create index if not exists idx_proj_job_costs_job  on proj.job_costs(org_id, job_id);
create index if not exists idx_proj_job_costs_life on proj.job_costs(org_id, lifecycle);

-- Idempotency ledger: an event_id is applied at most once, ever.
create table if not exists proj.job_cost_applied_events (
  org_id      uuid not null references core.organizations(id) on delete cascade,
  event_id    uuid not null,
  source_ref  text not null,
  lifecycle   text not null,
  applied_at  timestamptz not null default now(),
  primary key (org_id, event_id)
);

-- ----------------------------------------------------------------------------
-- 2. proj.job_budget_lines — Projects-owned budget/committed data for tracking.
--    "actual" comes from the cost roll-up; "pending" from the pending bucket;
--    "budget" and "committed" are Projects' own figures (committed = approved
--    POs/commitments, maintained by Projects until a procurement module lands).
-- ----------------------------------------------------------------------------
create table if not exists proj.job_budget_lines (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null references core.jobs(id),
  cost_type       text,                           -- optional bucket; null = job-level
  description     text,
  budgeted_cents  bigint not null default 0,
  committed_cents bigint not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_proj_budget_job on proj.job_budget_lines(org_id, job_id);

-- ----------------------------------------------------------------------------
-- 3. Billing request / draw — Projects-owned, freely editable while DRAFT.
--    Lifecycle here: DRAFT -> EMITTED -> PROCESSED | REJECTED.
--    On approval we emit a JOB_BILLING event; Books issues + owns the invoice.
-- ----------------------------------------------------------------------------
create table if not exists proj.billing_requests (
  id                uuid primary key default uuid_generate_v4(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null references core.jobs(id),
  location_id       uuid not null,
  billing_type      text not null
                      check (billing_type in ('MILESTONE','PROGRESS','TIME_MATERIALS','DRAW')),
  status            text not null default 'DRAFT'
                      check (status in ('DRAFT','EMITTED','PROCESSED','REJECTED')),
  source_ref        text not null default ('draw-' || replace(uuid_generate_v4()::text,'-','')),
  occurred_on       date not null,
  memo              text,
  event_id          uuid,                         -- the JOB_BILLING event we emitted
  invoice_id        uuid,                         -- read back from core.events (Books-issued)
  invoice_number    text,                         -- requires a Books-exposed read path (see Master doc)
  rejection_reason  text,
  created_by        text,                         -- clerk_user_id
  approved_by       text,                         -- clerk_user_id
  approved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_proj_billing_job    on proj.billing_requests(org_id, job_id);
create index if not exists idx_proj_billing_status on proj.billing_requests(org_id, status);
create unique index if not exists uq_proj_billing_event on proj.billing_requests(org_id, event_id)
  where event_id is not null;

create table if not exists proj.billing_request_lines (
  id                  uuid primary key default uuid_generate_v4(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  billing_request_id  uuid not null references proj.billing_requests(id) on delete cascade,
  description         text not null,
  amount_cents        bigint not null,
  item_id             uuid,                       -- optional -> core.items (thin)
  sort_order          int not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists idx_proj_billing_lines on proj.billing_request_lines(billing_request_id);

-- ----------------------------------------------------------------------------
-- 4. RLS — every proj table is org-isolated on public.get_org_id().
-- ----------------------------------------------------------------------------
alter table proj.job_costs               enable row level security;
alter table proj.job_cost_applied_events enable row level security;
alter table proj.job_budget_lines        enable row level security;
alter table proj.billing_requests        enable row level security;
alter table proj.billing_request_lines   enable row level security;

do $$
begin
  perform 1;
  -- one permissive org-isolation policy per table
  execute 'create policy org_isolation on proj.job_costs               for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.job_cost_applied_events for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.job_budget_lines        for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.billing_requests        for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.billing_request_lines   for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
exception when duplicate_object then null;  -- idempotent re-run
end $$;

grant select, insert, update, delete on all tables in schema proj to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. Views — operational figure + margin/budget. security_invoker so RLS applies.
-- ----------------------------------------------------------------------------
create or replace view proj.v_job_operational_cost
  with (security_invoker = on) as
select
  org_id,
  job_id,
  coalesce(sum(amount_cents) filter (where lifecycle = 'CLEARED'), 0)::bigint as operational_actual_cents,
  coalesce(sum(amount_cents) filter (where lifecycle = 'PENDING'), 0)::bigint as pending_cents
  -- VOIDED is intentionally excluded from both buckets
from proj.job_costs
group by org_id, job_id;

create or replace view proj.v_job_margin
  with (security_invoker = on) as
with bud as (
  select org_id, job_id,
         coalesce(sum(budgeted_cents),0)::bigint  as budget_cents,
         coalesce(sum(committed_cents),0)::bigint as committed_cents
  from proj.job_budget_lines
  group by org_id, job_id
)
select
  j.org_id,
  j.id                                   as job_id,
  j.job_number,
  j.name,
  -- revenue side: Books-owned column on core.jobs, READ ONLY
  coalesce(j.contract_amount_cents, 0)::bigint              as revenue_contract_cents,
  coalesce(oc.operational_actual_cents, 0)::bigint          as operational_actual_cents,
  coalesce(oc.pending_cents, 0)::bigint                     as operational_pending_cents,
  coalesce(b.budget_cents, 0)::bigint                       as budget_cents,
  coalesce(b.committed_cents, 0)::bigint                    as committed_cents,
  (coalesce(j.contract_amount_cents,0) - coalesce(oc.operational_actual_cents,0))::bigint
                                                            as operational_margin_cents,
  case when coalesce(j.contract_amount_cents,0) > 0
    then round(((coalesce(j.contract_amount_cents,0) - coalesce(oc.operational_actual_cents,0))::numeric
                 / j.contract_amount_cents) * 100, 2)
    else null end                                          as operational_margin_pct,
  -- budget tracking: budget - actual - committed - pending
  (coalesce(b.budget_cents,0)
     - coalesce(oc.operational_actual_cents,0)
     - coalesce(b.committed_cents,0)
     - coalesce(oc.pending_cents,0))::bigint               as budget_remaining_cents
from core.jobs j
left join proj.v_job_operational_cost oc on oc.org_id = j.org_id and oc.job_id = j.id
left join bud b                          on b.org_id  = j.org_id and b.job_id  = j.id;

grant select on proj.v_job_operational_cost, proj.v_job_margin to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. JOB_COST consumer — drain core.events (JOB_COST, pending), dedupe on
--    event_id, apply as a state change keyed on source_ref, mark processed.
--    Books never processes JOB_COST rows, so they are ours to drain.
-- ----------------------------------------------------------------------------
create or replace function proj.drain_job_costs(p_org_id uuid default null)
returns table(processed int, applied int, skipped int, rejected int)
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare
  r        record;
  p        jsonb;
  v_src    text;  v_life text;  v_amt bigint;
  v_job    uuid;  v_loc uuid;   v_dept uuid;
  v_ct     text;  v_gate text;  v_occ date;  v_gl uuid;  v_memo text;
  c_proc int := 0; c_app int := 0; c_skip int := 0; c_rej int := 0;
begin
  for r in
    select *
    from core.events
    where event_type = 'JOB_COST'
      and status = 'pending'
      and (p_org_id is null or org_id = p_org_id)
    order by created_at asc, event_id
    for update skip locked
  loop
    c_proc := c_proc + 1;

    -- idempotency: already applied this exact event_id? just close the row.
    if exists (select 1 from proj.job_cost_applied_events a
               where a.org_id = r.org_id and a.event_id = r.event_id) then
      update core.events set status = 'processed', processed_at = now() where id = r.id;
      c_skip := c_skip + 1;
      continue;
    end if;

    p      := r.payload;
    v_src  := p->>'source_ref';
    v_life := p->>'lifecycle';
    v_amt  := coalesce((p->>'amount_cents')::bigint, 0);
    v_job  := nullif(p->>'job_id','')::uuid;
    v_loc  := nullif(p->>'location_id','')::uuid;
    v_dept := nullif(p->>'department_id','')::uuid;
    v_ct   := p->>'cost_type';
    v_gate := p->>'gate';
    v_occ  := nullif(p->>'occurred_on','')::date;
    v_gl   := nullif(p->>'gl_entry_id','')::uuid;
    v_memo := p->>'memo';

    -- malformed payload -> reject the event (audit), do not poison the figure.
    if v_src is null or v_job is null
       or v_life not in ('PENDING','CLEARED','VOIDED') then
      update core.events
        set status = 'rejected',
            error  = 'JOB_COST payload missing source_ref/job_id or bad lifecycle',
            processed_at = now()
      where id = r.id;
      c_rej := c_rej + 1;
      continue;
    end if;

    -- Apply the transition to the ONE cost (keyed on source_ref).
    -- Monotonic guard: only advance state if this event is newer than the last
    -- one applied to the cost; older/out-of-order events are recorded but do not
    -- regress the figure.
    insert into proj.job_costs as jc
      (org_id, job_id, location_id, department_id, source_ref, cost_type,
       amount_cents, lifecycle, gate, occurred_on, gl_entry_id, memo,
       last_event_id, last_event_at)
    values
      (r.org_id, v_job, v_loc, v_dept, v_src, v_ct,
       v_amt, v_life, v_gate, v_occ, v_gl, v_memo,
       r.event_id, r.created_at)
    on conflict (org_id, source_ref) do update
      set lifecycle     = excluded.lifecycle,
          amount_cents  = excluded.amount_cents,
          cost_type     = coalesce(excluded.cost_type, jc.cost_type),
          gate          = coalesce(excluded.gate, jc.gate),
          occurred_on   = coalesce(excluded.occurred_on, jc.occurred_on),
          gl_entry_id   = coalesce(excluded.gl_entry_id, jc.gl_entry_id),
          memo          = excluded.memo,
          department_id = coalesce(excluded.department_id, jc.department_id),
          location_id   = coalesce(excluded.location_id, jc.location_id),
          last_event_id = excluded.last_event_id,
          last_event_at = excluded.last_event_at,
          updated_at    = now()
      where excluded.last_event_at >= jc.last_event_at;

    -- record idempotency + close the event
    insert into proj.job_cost_applied_events (org_id, event_id, source_ref, lifecycle)
    values (r.org_id, r.event_id, v_src, v_life)
    on conflict do nothing;

    update core.events set status = 'processed', processed_at = now() where id = r.id;
    c_app := c_app + 1;
  end loop;

  return query select c_proc, c_app, c_skip, c_rej;
end $$;

-- ----------------------------------------------------------------------------
-- 7. JOB_BILLING emitter — approve a draft draw and emit the event.
--    Pre-checks only what Projects may see without crossing the boundary:
--      * job.customer_id set      (Books rejects "no customer" otherwise)
--      * lines non-empty, positive total, integer cents
--      * occurred_on present
--    NOT pre-checked here (Books-owned, off-limits): fiscal_periods HARD_CLOSE
--    and COA accounts 1100/2410. Those surface as a Books rejection, handled by
--    proj.reconcile_billing_requests (never silently dropped).
-- ----------------------------------------------------------------------------
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
  if not found then
    raise exception 'Billing request % not found', p_request_id;
  end if;
  if br.status not in ('DRAFT','REJECTED') then
    raise exception 'Billing request % is %; only DRAFT/REJECTED can be emitted', p_request_id, br.status;
  end if;

  -- customer precondition (readable on core.jobs; Core-owned identity field)
  select customer_id into v_cust from core.jobs where id = br.job_id;
  if v_cust is null then
    raise exception 'PRECONDITION_NO_CUSTOMER: job % has no customer_id; set one before billing', br.job_id;
  end if;

  select
    jsonb_agg(jsonb_build_object(
      'description', l.description,
      'amount_cents', l.amount_cents,
      'item_id', l.item_id) order by l.sort_order),
    coalesce(sum(l.amount_cents), 0)
  into v_lines, v_total
  from proj.billing_request_lines l
  where l.billing_request_id = br.id;

  if v_lines is null then
    raise exception 'PRECONDITION_NO_LINES: billing request % has no lines', br.id;
  end if;
  if v_total <= 0 then
    raise exception 'PRECONDITION_NONPOSITIVE: billing request % total must be > 0 (got %)', br.id, v_total;
  end if;

  v_payload := jsonb_build_object(
    'event_id',     v_event,
    'event_type',   'JOB_BILLING',
    'source_module','PROJECTS',
    'org_id',       br.org_id,
    'location_id',  br.location_id,
    'job_id',       br.job_id,
    'billing_type', br.billing_type,
    'occurred_on',  to_char(br.occurred_on, 'YYYY-MM-DD'),
    'source_ref',   br.source_ref,
    'memo',         br.memo,
    'lines',        v_lines
  );

  insert into core.events
    (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values
    (br.org_id, v_event, 'JOB_BILLING', 'PROJECTS', v_payload, br.occurred_on, 'pending');

  update proj.billing_requests
    set status          = 'EMITTED',
        event_id        = v_event,
        approved_by     = p_approver,
        approved_at     = now(),
        rejection_reason= null,
        updated_at      = now()
  where id = br.id;

  return v_event;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Reconcile emitted billing requests against the Books result on core.events.
--    processed -> PROCESSED + invoice_id ; rejected -> REJECTED + reason.
--    (invoice_number is not on core.events; see Master doc dependency note.)
-- ----------------------------------------------------------------------------
create or replace function proj.reconcile_billing_requests(p_org_id uuid default null)
returns int
language plpgsql
security definer
set search_path = proj, core, public
as $$
declare r record; n int := 0;
begin
  for r in
    select br.id as req_id, e.status as ev_status, e.invoice_id, e.error
    from proj.billing_requests br
    join core.events e
      on e.org_id = br.org_id
     and e.event_id = br.event_id
     and e.event_type = 'JOB_BILLING'
    where br.status = 'EMITTED'
      and e.status in ('processed','rejected')
      and (p_org_id is null or br.org_id = p_org_id)
  loop
    if r.ev_status = 'processed' then
      update proj.billing_requests
        set status = 'PROCESSED', invoice_id = r.invoice_id,
            rejection_reason = null, updated_at = now()
      where id = r.req_id;
    else
      update proj.billing_requests
        set status = 'REJECTED',
            rejection_reason = coalesce(r.error, 'Rejected by Books (no reason supplied)'),
            updated_at = now()
      where id = r.req_id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function
  proj.drain_job_costs(uuid),
  proj.approve_and_emit_billing(uuid, text),
  proj.reconcile_billing_requests(uuid)
to authenticated, service_role;

-- ============================================================================
-- end migration 0001
-- ============================================================================
