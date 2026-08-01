-- ============================================================================
-- MeritProjects — G6 :: Operational Spine (scheduling · field · procurement · gates)
-- Migration 1005 :: schema `proj` (EXTENDS the seam — never rebuilds it)
--
-- Reserved band 1001+ (MIGRATION_REGISTRY.md). Integrated from the G6 parallel
-- builder wave (dispatch / field / procurement / gates+compliance), lead-merged.
-- Idempotent throughout. Money bigint cents. FK-only to core. RLS org_isolation.
-- Rates pinned (*_pinned_at). Projects writes NO GL, mints NO invoice numbers.
--
-- Key integration decisions (lead):
--  * Procurement REUSES proj.commitments/commitment_lines (a PO *is* a commitment
--    of type PURCHASE_ORDER). Net-new = goods receipts + PO/subcontract number mint.
--  * The billing precondition (external gate / lien waiver) is PRESENCE-BASED: it
--    blocks only when an unsatisfied REQUIRED row actually exists, so every current
--    draw path (no gate/compliance rows) is unaffected.
--  * drain cache refresh hardened (auditor note): recompute invoiced_cents off the
--    cost row's persisted commitment_line_id, not just the current event's resolve.
-- ============================================================================

-- ####################  SLICE A — SCHEDULING / DISPATCH  ######################
create table if not exists proj.crews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  name text not null,
  lead_employee_id uuid references core.employees(id),
  zone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create table if not exists proj.crew_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  crew_id uuid not null references proj.crews(id) on delete cascade,
  employee_id uuid not null references core.employees(id),
  role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, crew_id, employee_id)
);
create table if not exists proj.resource_skills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  employee_id uuid not null references core.employees(id),
  capability text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, employee_id, capability)
);
create table if not exists proj.work_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid not null references core.jobs(id),
  cost_code_id uuid references proj.cost_codes(id),
  title text not null,
  description text,
  status text not null default 'DRAFT'
    check (status in ('DRAFT','SCHEDULED','DISPATCHED','IN_PROGRESS','ON_HOLD','COMPLETED','CANCELED')),
  assigned_employee_id uuid references core.employees(id),
  assigned_crew_id uuid references proj.crews(id),
  scheduled_window tstzrange,
  estimated_minutes int,
  required_capability text,
  zone text,
  priority int not null default 0,
  sequence_no int,
  service_address text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_work_orders_job         on proj.work_orders(org_id, job_id);
create index if not exists idx_work_orders_emp         on proj.work_orders(org_id, assigned_employee_id);
create index if not exists idx_work_orders_crew        on proj.work_orders(org_id, assigned_crew_id);
create index if not exists idx_work_orders_window      on proj.work_orders using gist (scheduled_window);
create index if not exists idx_work_orders_status      on proj.work_orders(org_id, status);

-- ####################  SLICE B — FIELD CAPTURE  #############################
create table if not exists proj.daily_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid not null references core.jobs(id),
  log_date date not null default current_date,
  weather text, temp_f int, notes text, delays text, manpower_count int,
  author_employee_id uuid references core.employees(id),
  author_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_daily_logs_job on proj.daily_logs(org_id, job_id, log_date desc);
create table if not exists proj.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid references core.jobs(id),
  cost_code_id uuid references proj.cost_codes(id),
  name text not null, description text,
  status text not null default 'TODO' check (status in ('TODO','DOING','DONE','BLOCKED')),
  assignee_employee_id uuid references core.employees(id),
  assignee_user_id text, due_date date,
  depends_on_task_id uuid references proj.tasks(id),
  sort_order int not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tasks_job on proj.tasks(org_id, job_id, status);
create table if not exists proj.time_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid not null references core.jobs(id),
  employee_id uuid not null references core.employees(id),
  task_id uuid references proj.tasks(id),
  cost_code_id uuid references proj.cost_codes(id),
  work_date date not null default current_date,
  hours numeric(6,2) not null check (hours >= 0),
  cost_rate_cents bigint not null,
  cost_rate_pinned_at timestamptz not null default now(),
  bill_rate_cents bigint,
  bill_rate_pinned_at timestamptz,
  billable boolean not null default false,
  narrative text,
  approval_state text not null default 'DRAFT' check (approval_state in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  approved_by text, approved_at timestamptz,
  cost_source_ref text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, cost_source_ref)
);
create index if not exists idx_time_entries_job  on proj.time_entries(org_id, job_id, work_date);
create index if not exists idx_time_entries_appr on proj.time_entries(org_id, approval_state);
create table if not exists proj.field_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid references core.jobs(id),
  parent_type text not null check (parent_type in ('DAILY_LOG','TASK','TIME_ENTRY','JOB')),
  parent_id uuid not null,
  storage_bucket text not null default 'field',
  storage_path text not null,
  content_type text, byte_size bigint, caption text, taken_at timestamptz,
  geo_lat numeric, geo_lng numeric, uploaded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_field_attach_parent on proj.field_attachments(org_id, parent_type, parent_id);

-- Standalone-only: approved time -> captured_costs (LABOR, CLEARED). Guarded on
-- NOT books_present so Books-present orgs never double-count (Books TIMESHEET_PAYROLL owns those).
create or replace function proj.materialize_time_cost(p_org_id uuid default null)
returns integer language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare n int := 0;
begin
  insert into proj.captured_costs
    (org_id, job_id, source_ref, cost_type, amount_cents, lifecycle, occurred_on, cost_code_id, memo)
  select te.org_id, te.job_id, te.cost_source_ref, 'LABOR',
         round(te.hours * te.cost_rate_cents)::bigint, 'CLEARED', te.work_date, te.cost_code_id, 'field time '||te.id
  from proj.time_entries te
  where te.approval_state = 'APPROVED'
    and (p_org_id is null or te.org_id = p_org_id)
    and not proj.books_present(te.org_id)
  on conflict (org_id, source_ref) do update
    set amount_cents = excluded.amount_cents, lifecycle = excluded.lifecycle, updated_at = now();
  get diagnostics n = row_count; return n;
end $fn$;

-- ####################  SLICE C — PROCUREMENT (reuse commitments)  ###########
-- Fix latent 1001 gap: job_settings lacked the uses_external_gates override
-- column that job_cap()'s allowlist permits — so job_cap(_, 'uses_external_gates')
-- errored. Additive backfill so the gate capability resolves per-job.
alter table proj.job_settings add column if not exists uses_external_gates boolean;

alter table proj.commitment_lines add column if not exists ordered_qty numeric;
alter table proj.commitment_lines add column if not exists uom text;

create table if not exists proj.doc_number_counters (
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  doc_type text not null,
  last_value bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (org_id, doc_type)
);
create or replace function proj.next_doc_number(p_org_id uuid, p_doc_type text)
returns text language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare v bigint; v_prefix text;
begin
  insert into proj.doc_number_counters (org_id, doc_type, last_value) values (p_org_id, p_doc_type, 1)
  on conflict (org_id, doc_type) do update set last_value = proj.doc_number_counters.last_value + 1, updated_at = now()
  returning last_value into v;
  v_prefix := case p_doc_type when 'SUBCONTRACT' then 'SUB' else 'PO' end;
  return v_prefix || '-' || lpad(v::text, 6, '0');
end $fn$;

create table if not exists proj.po_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  commitment_id uuid not null references proj.commitments(id) on delete cascade,
  job_id uuid not null references core.jobs(id),
  vendor_id uuid references core.vendors(id),
  received_on date not null default current_date,
  received_by text, packing_slip text,
  status text not null default 'RECEIVED' check (status in ('RECEIVED','PARTIAL','REJECTED','VOID')),
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists proj.po_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  receipt_id uuid not null references proj.po_receipts(id) on delete cascade,
  commitment_line_id uuid not null references proj.commitment_lines(id),
  qty_received numeric,
  amount_cents bigint not null default 0,
  over_receipt boolean not null default false,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_po_receipts_commitment on proj.po_receipts(org_id, commitment_id);
create index if not exists ix_po_receipt_lines_cl    on proj.po_receipt_lines(org_id, commitment_line_id);

-- extend approve_commitment to mint the PO/subcontract number on first approval (additive)
create or replace function proj.approve_commitment(p_commitment_id uuid, p_approver text default null::text)
returns void language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare c proj.commitments%rowtype;
begin
  select * into c from proj.commitments where id = p_commitment_id for update;
  if not found then raise exception 'Commitment % not found', p_commitment_id; end if;
  if c.status not in ('DRAFT','APPROVED','PARTIAL') then
    raise exception 'Commitment % is %; cannot approve', p_commitment_id, c.status;
  end if;
  update proj.commitments
    set status = 'APPROVED',
        number = coalesce(number, proj.next_doc_number(org_id, commitment_type)),
        revised_amount_cents = greatest(revised_amount_cents, original_amount_cents),
        executed_at = coalesce(executed_at, now()),
        approved_by = coalesce(p_approver, approved_by),
        updated_at = now()
  where id = p_commitment_id;
end $fn$;

-- ####################  SLICE D — GATES / COMPLIANCE / SUBMITTALS / RFIS  ####
create table if not exists proj.external_gates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid not null references core.jobs(id),
  gate_type text not null check (gate_type in ('PERMIT','PTO','INSPECTION','CERTIFICATE_OF_OCCUPANCY','UTILITY_INTERCONNECT','FINAL_ACCEPTANCE','OTHER')),
  name text not null, authority text, external_ref text,
  status text not null default 'PENDING' check (status in ('PENDING','SUBMITTED','APPROVED','CLEARED','REJECTED','EXPIRED','WAIVED')),
  required boolean not null default true,
  blocks_billing boolean not null default true,
  blocks_close boolean not null default true,
  submitted_on date, approved_on date, expires_on date, cleared_by text, cleared_at timestamptz, notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_external_gates_job on proj.external_gates(org_id, job_id);
create table if not exists proj.compliance_docs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid references core.jobs(id),
  commitment_id uuid references proj.commitments(id),
  counterparty_id uuid,
  doc_type text not null check (doc_type in ('LIEN_WAIVER_CONDITIONAL','LIEN_WAIVER_UNCONDITIONAL','COI','W9','CERTIFIED_PAYROLL')),
  covers_period daterange, covers_amount_cents bigint,
  status text not null default 'MISSING' check (status in ('MISSING','RECEIVED','VERIFIED','EXPIRED','REJECTED')),
  required boolean not null default true,
  storage_path text,
  provider_connection_id uuid references core.provider_connections(id),
  provider_ref text, expires_on date, verified_by text, verified_at timestamptz, rejected_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_compliance_docs_job on proj.compliance_docs(org_id, job_id);
create index if not exists ix_compliance_docs_commitment on proj.compliance_docs(org_id, commitment_id);
create table if not exists proj.submittals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid not null references core.jobs(id),
  commitment_id uuid references proj.commitments(id),
  cost_code_id uuid references proj.cost_codes(id),
  number text not null, revision int not null default 0, spec_section text,
  title text not null,
  submittal_type text not null default 'PRODUCT_DATA' check (submittal_type in ('PRODUCT_DATA','SHOP_DRAWING','SAMPLE','MOCKUP','OM_MANUAL','WARRANTY','OTHER')),
  status text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','APPROVED_AS_NOTED','REVISE_RESUBMIT','REJECTED')),
  ball_in_court text, assigned_to text, due_date date, submitted_on date, returned_on date, notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, job_id, number, revision)
);
create index if not exists ix_submittals_job on proj.submittals(org_id, job_id);
create table if not exists proj.rfis (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id uuid not null references core.jobs(id),
  cost_code_id uuid references proj.cost_codes(id),
  commitment_id uuid references proj.commitments(id),
  change_order_id uuid references proj.change_orders(id),
  number text not null, subject text not null, question text, answer text,
  status text not null default 'DRAFT' check (status in ('DRAFT','OPEN','ANSWERED','CLOSED','VOID')),
  priority text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  discipline text, spec_section text, ball_in_court text, assigned_to text,
  cost_impact boolean not null default false, schedule_impact boolean not null default false,
  cost_impact_cents bigint, due_date date, submitted_on date, answered_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, job_id, number)
);
create index if not exists ix_rfis_job on proj.rfis(org_id, job_id);

-- ####################  RLS + GRANTS (all new tables)  #######################
do $$
declare t text;
begin
  foreach t in array array[
    'crews','crew_members','resource_skills','work_orders',
    'daily_logs','tasks','time_entries','field_attachments',
    'doc_number_counters','po_receipts','po_receipt_lines',
    'external_gates','compliance_docs','submittals','rfis'
  ] loop
    execute format('alter table proj.%I enable row level security', t);
    begin
      execute format('create policy org_isolation on proj.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on proj.%I to authenticated, service_role', t);
  end loop;
end $$;

-- ####################  GATE FUNCTIONS + VIEWS  ##############################
create or replace function proj.advance_external_gate(p_gate_id uuid, p_new_status text, p_actor text default null)
returns proj.external_gates language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare g proj.external_gates%rowtype; ok boolean;
begin
  select * into g from proj.external_gates where id = p_gate_id for update;
  if not found then raise exception 'external_gate % not found', p_gate_id; end if;
  ok := case g.status
    when 'PENDING'   then p_new_status in ('SUBMITTED','WAIVED')
    when 'SUBMITTED' then p_new_status in ('APPROVED','REJECTED','WAIVED')
    when 'APPROVED'  then p_new_status in ('CLEARED','EXPIRED','REJECTED')
    when 'REJECTED'  then p_new_status in ('SUBMITTED')
    when 'EXPIRED'   then p_new_status in ('SUBMITTED')
    else false end;
  if not ok then raise exception 'GATE_TRANSITION_INVALID: % -> %', g.status, p_new_status; end if;
  update proj.external_gates
     set status = p_new_status,
         approved_on = case when p_new_status='APPROVED' then coalesce(approved_on, current_date) else approved_on end,
         cleared_by  = case when p_new_status in ('CLEARED','WAIVED') then coalesce(p_actor, cleared_by) else cleared_by end,
         cleared_at  = case when p_new_status in ('CLEARED','WAIVED') then now() else cleared_at end,
         updated_at  = now()
   where id = p_gate_id returning * into g;
  return g;
end $fn$;

-- payment_eligible: false iff any REQUIRED compliance doc for the commitment is not effectively VERIFIED.
create or replace function proj.payment_eligible(p_commitment_id uuid)
returns boolean language plpgsql stable security definer set search_path to 'proj','core','public' as $fn$
declare v_org uuid;
begin
  select org_id into v_org from proj.commitments where id = p_commitment_id;
  if v_org is null then return false; end if;
  return not exists (
    select 1 from proj.compliance_docs d
    where d.org_id = v_org and d.commitment_id = p_commitment_id and d.required
      and not (d.status = 'VERIFIED' and (d.expires_on is null or d.expires_on >= current_date)));
end $fn$;

-- draw_precondition_met: NULL if all met, else a violation code. PRESENCE-BASED:
-- blocks only when an unsatisfied REQUIRED row actually exists, so draws on jobs
-- with no gate/compliance requirements (every current job) are unaffected.
create or replace function proj.draw_precondition_met(p_billing_request_id uuid)
returns text language plpgsql stable security definer set search_path to 'proj','core','public' as $fn$
declare br proj.billing_requests%rowtype;
begin
  select * into br from proj.billing_requests where id = p_billing_request_id;
  if not found then return null; end if;

  -- (i) external gate: block terminal draws when a required blocking gate is open
  if proj.job_cap(br.job_id,'uses_external_gates') and br.billing_type in ('RETENTION_RELEASE') then
    if exists (select 1 from proj.external_gates g
               where g.org_id = br.org_id and g.job_id = br.job_id
                 and g.required and g.blocks_billing and g.status not in ('CLEARED','WAIVED')) then
      return 'PRECONDITION_EXTERNAL_GATE';
    end if;
  end if;

  -- (ii) lien waiver: block ONLY if a required conditional-waiver row exists for this
  -- job that is not satisfied/covering. Absence of any requirement => not blocked.
  if exists (
       select 1 from proj.compliance_docs d
       where d.org_id = br.org_id and d.job_id = br.job_id
         and d.doc_type = 'LIEN_WAIVER_CONDITIONAL' and d.required
         and not ( d.status = 'VERIFIED'
                   and (d.expires_on is null or d.expires_on >= current_date)
                   and (d.covers_period is null or d.covers_period @> br.occurred_on) )
     ) then
    return 'PRECONDITION_LIEN_WAIVER';
  end if;

  return null;
end $fn$;

create or replace function proj.close_eligible(p_job_id uuid)
returns boolean language sql stable security definer set search_path to 'proj','core','public' as $fn$
  select not exists (
    select 1 from proj.external_gates g
    where g.org_id = public.get_org_id() and g.job_id = p_job_id
      and g.required and g.blocks_close and g.status not in ('CLEARED','WAIVED'));
$fn$;

create or replace view proj.v_commitment_payment_eligibility with (security_invoker = on) as
select c.id as commitment_id, c.org_id, c.job_id, c.vendor_id, c.status,
       proj.payment_eligible(c.id) as payment_eligible
from proj.commitments c;
grant select on proj.v_commitment_payment_eligibility to authenticated, service_role;

create or replace view proj.v_job_gate_status with (security_invoker = on) as
select job_id, org_id,
       count(*) filter (where required and status not in ('CLEARED','WAIVED')) as open_required_gates,
       count(*) filter (where required and blocks_billing and status not in ('CLEARED','WAIVED')) as open_billing_blockers,
       count(*) filter (where required and blocks_close   and status not in ('CLEARED','WAIVED')) as open_close_blockers
from proj.external_gates group by job_id, org_id;
grant select on proj.v_job_gate_status to authenticated, service_role;

-- ####################  SEAM EDIT — additive billing precondition  ###########
-- Slots in after PRECONDITION_NONPOSITIVE, before the books_present branch, so a
-- gate blocks the standalone UNISSUED path too. draw_precondition_met is NULL for
-- every job without an actual unsatisfied requirement => existing draws unaffected.
create or replace function proj.approve_and_emit_billing(p_request_id uuid, p_approver text default null::text)
returns uuid language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare
  br proj.billing_requests%rowtype; v_cust uuid; v_lines jsonb; v_total bigint;
  v_event uuid := gen_random_uuid(); v_payload jsonb; v_precond text;
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
  from proj.billing_request_lines l where l.billing_request_id = br.id;
  if v_lines is null then raise exception 'PRECONDITION_NO_LINES: billing request % has no lines', br.id; end if;
  if v_total <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: total must be > 0 (got %)', v_total; end if;

  -- [G6 additive precondition] external gate / lien-waiver (presence-based; NULL => all met)
  v_precond := proj.draw_precondition_met(br.id);
  if v_precond is not null then
    raise exception '%: billing request % blocked by external gate / compliance', v_precond, br.id;
  end if;

  if not proj.books_present(br.org_id) then
    update proj.billing_requests
      set status = 'UNISSUED', approved_by = p_approver, approved_at = now(), rejection_reason = null, updated_at = now()
    where id = br.id;
    return null;
  end if;
  v_payload := jsonb_build_object(
    'event_id', v_event, 'event_type','JOB_BILLING', 'source_module','PROJECTS',
    'org_id', br.org_id, 'location_id', br.location_id, 'job_id', br.job_id,
    'billing_type', br.billing_type, 'occurred_on', to_char(br.occurred_on,'YYYY-MM-DD'),
    'source_ref', br.source_ref, 'memo', br.memo, 'lines', v_lines);
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (br.org_id, v_event, 'JOB_BILLING', 'PROJECTS', v_payload, br.occurred_on, 'pending');
  update proj.billing_requests
    set status='EMITTED', event_id=v_event, approved_by=p_approver, approved_at=now(), rejection_reason=null, updated_at=now()
  where id = br.id;
  return v_event;
end $fn$;

-- ####################  DRAIN CACHE HARDENING (auditor note)  ################
-- Recompute invoiced_cents off the cost row's PERSISTED commitment_line_id (not
-- only the current event's resolve) so a link-less VOID/CLEARED transition still
-- refreshes the cache. Views were already correct (they recompute live); this
-- keeps the denormalized cache honest too.
create or replace function proj.drain_job_costs(p_org_id uuid default null::uuid)
returns table(processed integer, applied integer, skipped integer, rejected integer)
language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare
  r record; p jsonb;
  v_src text; v_life text; v_amt bigint; v_job uuid; v_loc uuid; v_dept uuid;
  v_ct text; v_gate text; v_occ date; v_gl uuid; v_memo text; v_code text; v_cc_id uuid; v_cmt uuid;
  c_proc int := 0; c_app int := 0; c_skip int := 0; c_rej int := 0;
begin
  for r in
    select * from core.events
    where event_type = 'JOB_COST' and status = 'pending' and (p_org_id is null or org_id = p_org_id)
    order by created_at asc, event_id for update skip locked
  loop
    c_proc := c_proc + 1;
    if exists (select 1 from proj.job_cost_applied_events a where a.org_id = r.org_id and a.event_id = r.event_id) then
      update core.events set status = 'processed', processed_at = now() where id = r.id;
      c_skip := c_skip + 1; continue;
    end if;
    p := r.payload;
    v_src := p->>'source_ref'; v_life := p->>'lifecycle'; v_amt := coalesce((p->>'amount_cents')::bigint, 0);
    v_job := nullif(p->>'job_id','')::uuid; v_loc := nullif(p->>'location_id','')::uuid; v_dept := nullif(p->>'department_id','')::uuid;
    v_ct := p->>'cost_type'; v_gate := p->>'gate'; v_occ := nullif(p->>'occurred_on','')::date;
    v_gl := nullif(p->>'gl_entry_id','')::uuid; v_memo := p->>'memo';
    v_code := nullif(p->>'cost_code',''); v_cmt := nullif(p->>'commitment_line_id','')::uuid;
    if v_src is null or v_job is null or v_life not in ('PENDING','CLEARED','VOIDED') then
      update core.events set status='rejected', error='JOB_COST payload missing source_ref/job_id or bad lifecycle', processed_at=now() where id=r.id;
      c_rej := c_rej + 1; continue;
    end if;
    if v_cmt is null and v_src is not null then
      select cl.id into v_cmt from proj.commitment_lines cl
      where cl.org_id = r.org_id and cl.source_ref_prefix is not null and cl.source_ref_prefix <> ''
        and v_src like cl.source_ref_prefix || '%'
      order by length(cl.source_ref_prefix) desc limit 1;
    end if;
    v_cc_id := null;
    if v_code is not null then
      select cc.id into v_cc_id from proj.cost_codes cc
      where cc.org_id = r.org_id and cc.code = v_code and (cc.job_id = v_job or cc.job_id is null)
      order by (cc.job_id = v_job) desc nulls last limit 1;
    end if;
    if v_cc_id is null and v_cmt is not null then
      select cost_code_id into v_cc_id from proj.commitment_lines where id = v_cmt;
    end if;
    insert into proj.job_costs as jc
      (org_id, job_id, location_id, department_id, source_ref, cost_type, amount_cents, lifecycle, gate,
       occurred_on, gl_entry_id, memo, cost_code_id, commitment_line_id, last_event_id, last_event_at)
    values
      (r.org_id, v_job, v_loc, v_dept, v_src, v_ct, v_amt, v_life, v_gate,
       v_occ, v_gl, v_memo, v_cc_id, v_cmt, r.event_id, r.created_at)
    on conflict (org_id, source_ref) do update
      set lifecycle=excluded.lifecycle, amount_cents=excluded.amount_cents,
          cost_type=coalesce(excluded.cost_type, jc.cost_type), gate=coalesce(excluded.gate, jc.gate),
          occurred_on=coalesce(excluded.occurred_on, jc.occurred_on), gl_entry_id=coalesce(excluded.gl_entry_id, jc.gl_entry_id),
          memo=excluded.memo, department_id=coalesce(excluded.department_id, jc.department_id),
          location_id=coalesce(excluded.location_id, jc.location_id),
          cost_code_id=coalesce(excluded.cost_code_id, jc.cost_code_id),
          commitment_line_id=coalesce(excluded.commitment_line_id, jc.commitment_line_id),
          last_event_id=excluded.last_event_id, last_event_at=excluded.last_event_at, updated_at=now()
      where excluded.last_event_at >= jc.last_event_at;
    insert into proj.job_cost_applied_events (org_id, event_id, source_ref, lifecycle)
    values (r.org_id, r.event_id, v_src, v_life) on conflict do nothing;
    -- refresh cache off the persisted link (hardened)
    v_cmt := coalesce(v_cmt, (select commitment_line_id from proj.job_costs where org_id=r.org_id and source_ref=v_src));
    if v_cmt is not null then
      update proj.commitment_lines cl
        set invoiced_cents = (select coalesce(sum(amount_cents),0) from proj.job_costs j2
                              where j2.commitment_line_id = cl.id and j2.lifecycle in ('PENDING','CLEARED')),
            updated_at = now()
      where cl.id = v_cmt;
    end if;
    update core.events set status='processed', processed_at=now() where id=r.id;
    c_app := c_app + 1;
  end loop;
  return query select c_proc, c_app, c_skip, c_rej;
end $fn$;
