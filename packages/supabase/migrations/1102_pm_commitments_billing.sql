-- ============================================================================
-- 1102 · Merit Projects v2 — money spine, part 1: estimates, commitments, billing
--
-- Binding inputs: docs/projects/MERIT-PROJECTS-V2-BLUEPRINT.md (D7, D8, D12, §5, §6, §7),
-- review 03 (money seam: §1, §2, §3.2, §3.6, §4, §5.3), review 05 (§4.4, §4.6).
-- Builds on 1100_pm_foundation + 1101_pm_onboarding_followups. Same conventions:
-- org guard first in every definer function, search_path = pm, core, public, no
-- PUBLIC/anon EXECUTE, composite FKs (org_id, job_id) -> core.jobs(org_id, id)
-- (deferrable, so pm.remove_sample_data discovers and clears them), RLS USING + WITH
-- CHECK, money/approval state moves only through definer functions.
--
-- Objects
--   additive on 1100: budget_lines.source_estimate_id; tasks/wbs_nodes.billing_amount_cents,
--                     billing_pct (milestone billing values)
--   tables : estimates, estimate_lines, commitments, commitment_lines, commitment_changes,
--            receipts, compliance_docs, sov_versions, sov_lines, billing_requests,
--            billing_request_lines, retainage_ledger, allowances, billing_links,
--            deposit_requests
--   member functions:
--     estimates   send_estimate, accept_estimate, decline_estimate, revise_estimate
--     commitments approve_commitment, approve_commitment_change, reject_commitment_change,
--                 execute_commitment, close_commitment, void_commitment, set_commitment_hold,
--                 record_receipt, verify_compliance_doc, commitment_payment_eligible
--     SOV         activate_sov_version, revise_sov
--     billing     generate_progress_billing, generate_sov_billing, generate_milestone_billing,
--                 generate_tm_billing, request_retainage_release, close_allowance,
--                 bill_allowance_overage, billing_preconditions, approve_and_emit_billing,
--                 void_billing_request, reconcile_my_billing
--     deposits    request_deposit, reemit_deposit_request
--     guards      guard_estimate_accepted, guard_deposit_requested, guard_final_billed,
--                 guard_compliance_current (replace the 1100 placeholders)
--   service_role only: reconcile_billing_requests(org), sync_commitment_holds(org)
--   internal: books_seam_version, emit_suppression, primary_contract_id, cost_code_usable,
--             enforce_approval_policy, commitment_snapshot, finalize_billing_retainage,
--             draw_preconditions_met (placeholder TRUE until 1105), reconcile_billing_internal
--   views  : v_job_current_budget_lines, v_job_retainage, v_commitment_status, v_sov_status,
--            v_pay_application (AIA G702 per application), v_billing_queue
--            (v_job_financials / v_cost_code_status need the 1103 cost projection: see 1103)
--
-- Events emitted (core.events, source_module 'PROJECTS', status 'pending'):
--   JOB_COMMITMENT (new, non-posting, schema_version 1, source_ref pm:commit:{id}:v{version})
--   JOB_BILLING    (frozen v3 key set + additive keys, schema_version 2, source_ref pm:bill:{id})
--   JOB_DEPOSIT_REQUEST (new, schema_version 1, source_ref pm:deposit:{id})
--   None is emitted for a sample job or when Books is not entitled (standalone): the row
--   records suppressed_reason SAMPLE | STANDALONE and billing lands in status UNISSUED.
--
-- Wire mapping for billing (frozen v3 billing_type stays MILESTONE|PROGRESS|TIME_MATERIALS|DRAW):
--   progress %        -> PROGRESS        subtype null
--   SOV pay app       -> PROGRESS        subtype SOV
--   retainage release -> PROGRESS        subtype RETAINAGE_RELEASE  (Books v2: DR AR / CR RETAINAGE_RECEIVABLE, no revenue)
--   allowance overage -> PROGRESS        subtype ALLOWANCE
--   milestone         -> MILESTONE       subtype null
--   fixed / recurring -> MILESTONE       subtype FIXED | RECURRING (manual requests)
--   T&M               -> TIME_MATERIALS  subtype null
--   lender draw       -> DRAW            (1105)
-- Retainage on the wire: lines sum to the NET amount due (a negative line_type RETAINAGE line
-- carries the withheld amount, exactly as the live consumer expects), and the additive keys
-- gross_earned_cents (= Σ STANDARD lines) and retainage_cents (= withheld this application)
-- let a schema_version-2 consumer post DR AR net + DR RETAINAGE_RECEIVABLE / CR revenue gross.
-- A RETAINAGE_RELEASE request is NOT emitted until Books advertises seam v2
-- (core.organizations.entitlements.books_seam_version >= 2): the live consumer would credit
-- revenue a second time (review 03 §1.4-3).
--
-- Idempotent: safe to run twice. Never alters pgrst.db_schemas. Never writes Books-owned
-- core.jobs columns; contract value and budget reach Books only through JOB_PROGRESS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Additive columns on 1100 tables
-- ----------------------------------------------------------------------------
alter table pm.budget_lines add column if not exists source_estimate_id uuid;   -- set by accept_estimate
alter table pm.tasks        add column if not exists billing_amount_cents bigint;
alter table pm.tasks        add column if not exists billing_pct numeric(7,6);
alter table pm.wbs_nodes    add column if not exists billing_amount_cents bigint;
alter table pm.wbs_nodes    add column if not exists billing_pct numeric(7,6);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_billing_value_check') then
    alter table pm.tasks add constraint tasks_billing_value_check
      check ((billing_amount_cents is null or billing_amount_cents >= 0) and (billing_pct is null or (billing_pct >= 0 and billing_pct <= 1)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wbs_nodes_billing_value_check') then
    alter table pm.wbs_nodes add constraint wbs_nodes_billing_value_check
      check ((billing_amount_cents is null or billing_amount_cents >= 0) and (billing_pct is null or (billing_pct >= 0 and billing_pct <= 1)));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Internal helpers (owner/service_role only; never granted to authenticated)
-- ----------------------------------------------------------------------------

-- Books seam capability. 1 = the live FROZEN v3 consumer (ignores additive keys);
-- >= 2 = Books honours schema_version 2 (billing_subtype, retainage gross-up, release = reclass).
-- Read-only on a Books/Core-owned column; Projects never writes it.
create or replace function pm.books_seam_version(p_org uuid) returns int
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select case when (o.entitlements ->> 'books_seam_version') ~ '^\d{1,3}$'
                               then (o.entitlements ->> 'books_seam_version')::int end
                   from core.organizations o where o.id = p_org), 1)
$$;

-- Why an event must not be emitted for this job: 'SAMPLE' | 'STANDALONE' | null (emit).
create or replace function pm.emit_suppression(p_org uuid, p_job uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select case
    when exists (select 1 from pm.projects p where p.org_id = p_org and p.job_id = p_job and p.is_sample) then 'SAMPLE'
    when not pm.books_present(p_org) then 'STANDALONE'
  end
$$;

-- The contract a billing applies to: earliest ACTIVE PRIME, else earliest ACTIVE (same rule
-- as emit_job_progress' progress basis).
create or replace function pm.primary_contract_id(p_org uuid, p_job uuid) returns uuid
language sql stable
set search_path = pm, core, public
as $$
  select k.id from pm.contracts k
  where k.org_id = p_org and k.job_id = p_job and k.status = 'ACTIVE'
  order by (k.kind = 'PRIME') desc, k.created_at, k.id limit 1
$$;

-- A cost code is usable on a job when it is the job's own code or the job company's library code.
-- SECURITY INVOKER: a member sees only their org (RLS); definer callers run it with owner rights.
create or replace function pm.cost_code_usable(p_org uuid, p_job uuid, p_cc uuid) returns boolean
language sql stable
set search_path = pm, core, public
as $$
  select p_cc is null or exists (
    select 1 from pm.cost_codes c
    join core.jobs j on j.org_id = c.org_id and j.id = p_job
    where c.org_id = p_org and c.id = p_cc and c.location_id = j.location_id
      and (c.job_id is null or c.job_id = p_job))
$$;

-- Suite role → the pack approval roles it satisfies (pack roles: pm, superintendent,
-- service_manager, ops_manager, principal, controller, owner). core.employees.role carries the
-- Books/Core vocabulary (company_admin, cfo, accounting_manager, …) plus Projects roles where
-- assigned. Unknown roles satisfy nothing (fail closed).
create or replace function pm.approver_roles(p_role text) returns text[]
language sql immutable set search_path = pm, core, public as $$
  select case lower(coalesce(regexp_replace(p_role, '^org:', ''), ''))
    when 'owner'           then array['owner','principal','ops_manager','controller','pm','superintendent','service_manager']
    when 'admin'           then array['owner','principal','ops_manager','controller','pm','superintendent','service_manager']
    when 'org_admin'       then array['owner','principal','ops_manager','controller','pm','superintendent','service_manager']
    when 'company_admin'   then array['owner','principal','ops_manager','controller','pm','superintendent','service_manager']
    when 'principal'       then array['principal','ops_manager','pm','superintendent','service_manager']
    when 'cfo'             then array['controller']
    when 'assistant_cfo'   then array['controller']
    when 'merit_controller' then array['controller']
    when 'controller'      then array['controller']
    when 'accounting_manager' then array['controller']
    when 'general_admin'   then array['ops_manager','pm']
    when 'ops_manager'     then array['ops_manager','pm','superintendent','service_manager']
    when 'operations_manager' then array['ops_manager','pm','superintendent','service_manager']
    when 'project_manager' then array['pm']
    when 'pm'              then array['pm']
    when 'superintendent'  then array['superintendent']
    when 'service_manager' then array['service_manager']
    else array[]::text[] end
$$;

-- Approval policy tiers ({max_cents, roles, count}) from pm.approval_policies (pack data).
-- No active policy with this key -> any member other than the preparer may approve.
-- Multi-approver tiers fail closed until the approvals engine exists.
create or replace function pm.enforce_approval_policy(
  p_org uuid, p_location uuid, p_key text, p_amount bigint, p_user text
) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare pol pm.approval_policies%rowtype; t jsonb; v_tier jsonb; v_role text; i int := 0; v_idx int;
begin
  select * into pol from pm.approval_policies a
  where a.org_id = p_org and a.location_id = p_location and a.key = p_key and a.is_active;
  if not found then return jsonb_build_object('policy', null); end if;

  for t in select value from jsonb_array_elements(pol.tiers) loop
    i := i + 1;
    if (t ->> 'max_cents') is null or p_amount <= (t ->> 'max_cents')::bigint then
      v_tier := t; v_idx := i; exit;
    end if;
  end loop;
  if v_tier is null then
    raise exception 'PM_APPROVAL_NO_TIER: % cents exceeds every tier of approval policy %', p_amount, p_key using errcode = '42501';
  end if;
  if coalesce((v_tier ->> 'count')::int, 1) > 1 then
    raise exception 'PM_APPROVAL_MULTI_UNSUPPORTED: tier % of policy % needs % approvers (multi-approver tiers arrive with the approvals engine)',
      v_idx, p_key, v_tier ->> 'count' using errcode = '0A000';
  end if;
  select lower(e.role) into v_role from core.employees e
  where e.org_id = p_org and e.clerk_user_id = p_user and e.is_active
  order by e.role limit 1;
  if jsonb_typeof(v_tier -> 'roles') = 'array' and jsonb_array_length(v_tier -> 'roles') > 0
     and not exists (select 1 from jsonb_array_elements_text(v_tier -> 'roles') r where lower(r) = any (pm.approver_roles(v_role))) then
    raise exception 'PM_APPROVAL_ROLE: approving % cents under policy % needs role %; approver has %',
      p_amount, p_key, v_tier -> 'roles', coalesce(v_role, '(none)') using errcode = '42501';
  end if;
  return jsonb_build_object('policy', p_key, 'tier', v_idx, 'roles', v_tier -> 'roles', 'approver_role', v_role);
end $$;

-- ----------------------------------------------------------------------------
-- 2. Estimates (Projects owns estimates for jobs; Books' public.estimates stays for
--    non-job quotes). Versioned: versions share a number; one ACCEPTED version per number.
-- ----------------------------------------------------------------------------
create table if not exists pm.estimates (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),       -- = the job's company (trigger)
  job_id            uuid not null,
  customer_id       uuid references core.customers(id),                 -- null = the job's customer
  number            text not null,                                      -- minted EST-{short}-{YYYY}-{NNNN}
  version           int not null default 1 check (version >= 1),
  title             text not null default 'Estimate' check (char_length(title) between 1 and 200),
  status            text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACCEPTED','DECLINED','SUPERSEDED')),
  retainage_pct     numeric(5,4) check (retainage_pct is null or (retainage_pct >= 0 and retainage_pct <= 1)),
  valid_until       date,
  notes             text,
  total_cents       bigint not null default 0,                          -- Σ lines.amount (maintained)
  cost_total_cents  bigint not null default 0,                          -- Σ lines.cost   (maintained)
  supersedes_id     uuid,
  budget_id         uuid,                                               -- budget written at acceptance
  sent_at           timestamptz,
  accepted_at       timestamptz,
  accepted_by       text,
  declined_at       timestamptz,
  decline_reason    text,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, number, version),
  unique (org_id, id),
  check ((status = 'ACCEPTED') = (accepted_at is not null) or status = 'SUPERSEDED'),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, supersedes_id) references pm.estimates (org_id, id) deferrable initially immediate
);
create index if not exists pm_estimates_job_idx on pm.estimates (org_id, job_id, status);
create unique index if not exists pm_estimates_one_accepted_uidx on pm.estimates (org_id, number) where status = 'ACCEPTED';

create table if not exists pm.estimate_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  estimate_id         uuid not null,
  line_no             int not null default 0,
  cost_code_id        uuid,
  wbs_id              uuid,
  price_book_item_id  uuid references pm.price_book_items(id) on delete set null,
  description         text not null default '',
  qty                 numeric(14,4),
  uom                 text,
  unit_cost_cents     bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  unit_price_cents    bigint check (unit_price_cents is null or unit_price_cents >= 0),
  cost_cents          bigint check (cost_cents is null or cost_cents >= 0),   -- extended cost -> budget
  amount_cents        bigint not null,                                         -- extended sell price -> contract
  is_allowance        boolean not null default false,
  sort                int not null default 0,
  ext                 jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, estimate_id) references pm.estimates (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_estimate_lines_est_idx on pm.estimate_lines (org_id, estimate_id, sort);

create or replace function pm.tg_estimate_defaults() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; v_short text; v_cust uuid; n bigint; v_year text := to_char(current_date, 'YYYY');
begin
  select j.location_id, l.short_code, j.customer_id into v_loc, v_short, v_cust
  from core.jobs j join core.locations l on l.id = j.location_id
  where j.org_id = new.org_id and j.id = new.job_id;
  if v_loc is null then raise exception 'PM_UNKNOWN_JOB: job % not in org', new.job_id using errcode = '23503'; end if;
  new.location_id := v_loc;
  if tg_op = 'INSERT' then
    if new.customer_id is null then new.customer_id := v_cust; end if;
    if new.number is null or btrim(new.number) = '' then
      n := pm.next_doc_number(new.org_id, v_loc::text, 'EST', v_year);
      new.number := 'EST-' || v_short || '-' || v_year || '-' || lpad(n::text, 4, '0');
    end if;
  end if;
  if new.customer_id is not null and not exists (
       select 1 from core.customers c where c.id = new.customer_id and c.org_id = new.org_id) then
    raise exception 'PM_UNKNOWN_CUSTOMER: %', new.customer_id using errcode = '23503';
  end if;
  return new;
end $$;

-- Lines of a non-DRAFT estimate are frozen for members; defaults extend qty × unit.
-- The *_line_guard triggers are SECURITY INVOKER on purpose: current_user is then the
-- caller (authenticated) for client writes and the owner inside definer functions.
create or replace function pm.tg_estimate_line_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text; v_job uuid; v_row pm.estimate_lines%rowtype;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  select e.status, e.job_id into v_status, v_job from pm.estimates e where e.org_id = v_row.org_id and e.id = v_row.estimate_id;
  if current_user in ('authenticated', 'anon') and v_status is distinct from 'DRAFT' then
    raise exception 'PM_ESTIMATE_LOCKED: estimate lines can change only while the estimate is DRAFT (is %)', v_status using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.cost_cents is null and new.qty is not null and new.unit_cost_cents is not null then
    new.cost_cents := round(new.qty * new.unit_cost_cents)::bigint;
  end if;
  if new.amount_cents is null and new.qty is not null and new.unit_price_cents is not null then
    new.amount_cents := round(new.qty * new.unit_price_cents)::bigint;
  end if;
  if not pm.cost_code_usable(new.org_id, v_job, new.cost_code_id) then
    raise exception 'PM_COST_CODE_SCOPE: cost code % is not usable on job %', new.cost_code_id, v_job using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function pm.tg_estimate_totals() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_est uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_est := old.estimate_id; else v_org := new.org_id; v_est := new.estimate_id; end if;
  update pm.estimates e
     set total_cents      = coalesce((select sum(l.amount_cents) from pm.estimate_lines l where l.org_id = v_org and l.estimate_id = v_est), 0),
         cost_total_cents = coalesce((select sum(coalesce(l.cost_cents, 0)) from pm.estimate_lines l where l.org_id = v_org and l.estimate_id = v_est), 0)
   where e.org_id = v_org and e.id = v_est;
  return null;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Commitments (PO / subcontract, Projects-owned job commitments; review 03 §2, §3.2)
-- ----------------------------------------------------------------------------
create table if not exists pm.commitments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),        -- = the job's company (trigger)
  job_id             uuid not null,
  vendor_id          uuid references core.vendors(id),                    -- required to approve
  commitment_type    text not null default 'PO' check (commitment_type in ('PO','SUBCONTRACT')),
  number             text not null,                                       -- minted PO-/SC-{short}-{YYYY}-{NNNN}
  title              text,
  description        text,
  status             text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','EXECUTED','CLOSED','VOID')),
  retainage_pct      numeric(5,4) not null check (retainage_pct >= 0 and retainage_pct <= 1),   -- null on insert = vendor default, else 0
  payment_hold       boolean not null default false,                      -- manual hold (compliance hold is derived)
  hold_reason        text,
  version            int not null default 0 check (version >= 0),         -- 0 = never approved; bumps per emitted snapshot
  executed_on        date,
  approved_by        text,
  approved_at        timestamptz,
  approval           jsonb,                                               -- policy tier that authorized it
  event_id           uuid,                                                -- last JOB_COMMITMENT event
  last_emitted_hold  boolean,
  suppressed_reason  text check (suppressed_reason is null or suppressed_reason in ('STANDALONE','SAMPLE')),
  void_reason        text,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check (status in ('DRAFT','VOID') or approved_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_commitments_job_idx on pm.commitments (org_id, job_id, status);
create index if not exists pm_commitments_vendor_idx on pm.commitments (org_id, vendor_id);

create table if not exists pm.commitment_lines (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  commitment_id          uuid not null,
  line_no                int not null default 0,
  cost_code_id           uuid,                                            -- required to approve
  cost_type              text check (cost_type is null or cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  description            text not null default '',
  item_id                uuid,                                            -- core.items identity (optional)
  qty                    numeric(14,4),
  uom                    text,
  unit_cost_cents        bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  amount_cents           bigint not null check (amount_cents >= 0),       -- revised (incl. approved CCOs)
  original_amount_cents  bigint,                                          -- pinned at approval
  received_qty           numeric(14,4) not null default 0,                -- record_receipt
  received_cents         bigint not null default 0,                       -- record_receipt
  billed_cents           bigint not null default 0,                       -- drain (1103): Σ PENDING+CLEARED JOB_COST on this line
  tax_code               text,
  account_hint           text,                                            -- account ROLE hint, never a number
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_commitment_lines_cmt_idx on pm.commitment_lines (org_id, commitment_id, line_no);
create index if not exists pm_commitment_lines_cc_idx on pm.commitment_lines (org_id, cost_code_id);

-- Commitment change orders (CCO): one line delta each (an existing line, or a new line for
-- a cost code). Optionally tied to an owner CO. Approval bumps the commitment version.
create table if not exists pm.commitment_changes (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,                                      -- = commitment's job (trigger)
  commitment_id       uuid not null,
  number              text not null,                                      -- minted {commitment#}-CCO{nn}
  commitment_line_id  uuid,                                               -- null = adds a new line
  cost_code_id        uuid,                                               -- required when adding a line
  description         text not null default 'Commitment change',
  reason              text,
  amount_cents        bigint not null check (amount_cents <> 0),
  owner_co_id         uuid,
  status              text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','REJECTED','VOID')),
  applied_line_id     uuid,
  approved_by         text,
  approved_at         timestamptz,
  approval            jsonb,
  reject_reason       text,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check ((status = 'APPROVED') = (approved_at is not null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_line_id) references pm.commitment_lines (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, owner_co_id) references pm.change_orders (org_id, id) deferrable initially immediate
);
create index if not exists pm_commitment_changes_cmt_idx on pm.commitment_changes (org_id, commitment_id, status);

create table if not exists pm.receipts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  commitment_id       uuid not null,
  commitment_line_id  uuid not null,
  qty                 numeric(14,4),
  amount_cents        bigint not null check (amount_cents > 0),
  received_on         date not null default current_date,
  over_receipt        boolean not null default false,
  packing_slip        text,
  memo                text,
  document_id         uuid references public.documents(id) on delete set null,
  status              text not null default 'RECEIVED' check (status in ('RECEIVED','VOID')),
  event_id            uuid,
  created_by          text,
  created_at          timestamptz not null default now(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_line_id) references pm.commitment_lines (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_receipts_line_idx on pm.receipts (org_id, commitment_line_id);

-- Compliance (commitment-level COI / lien waivers; job-level docs allowed). VERIFIED is set
-- only by pm.verify_compliance_doc (verified_by = the caller).
create table if not exists pm.compliance_docs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  commitment_id   uuid,
  vendor_id       uuid references core.vendors(id),
  doc_type        text not null check (doc_type in ('COI','LIEN_WAIVER_CONDITIONAL','LIEN_WAIVER_UNCONDITIONAL',
                                                    'LIEN_WAIVER_FINAL','W9','CERTIFIED_PAYROLL','OTHER')),
  status          text not null default 'MISSING' check (status in ('MISSING','RECEIVED','VERIFIED','EXPIRED','REJECTED')),
  required        boolean not null default true,
  expires_on      date,
  covers_through  date,
  amount_cents    bigint check (amount_cents is null or amount_cents >= 0),
  document_id     uuid references public.documents(id) on delete set null,
  notes           text,
  verified_by     text,
  verified_at     timestamptz,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  check ((status = 'VERIFIED') = (verified_at is not null) or status in ('EXPIRED')),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_compliance_docs_job_idx on pm.compliance_docs (org_id, job_id);
create index if not exists pm_compliance_docs_cmt_idx on pm.compliance_docs (org_id, commitment_id);

create or replace function pm.tg_commitment_defaults() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; v_short text; n bigint; v_year text := to_char(current_date, 'YYYY'); v_ret numeric;
begin
  select j.location_id, l.short_code into v_loc, v_short
  from core.jobs j join core.locations l on l.id = j.location_id
  where j.org_id = new.org_id and j.id = new.job_id;
  if v_loc is null then raise exception 'PM_UNKNOWN_JOB: job % not in org', new.job_id using errcode = '23503'; end if;
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then
    raise exception 'PM_COMMITMENT_JOB_FIXED: a commitment cannot move between jobs' using errcode = '42501';
  end if;
  new.location_id := v_loc;
  if new.vendor_id is not null then
    select v.default_retainage_pct into v_ret from core.vendors v where v.id = new.vendor_id and v.org_id = new.org_id;
    if not found then raise exception 'PM_UNKNOWN_VENDOR: %', new.vendor_id using errcode = '23503'; end if;
  end if;
  if tg_op = 'INSERT' then
    if new.number is null or btrim(new.number) = '' then
      n := pm.next_doc_number(new.org_id, v_loc::text, new.commitment_type, v_year);
      new.number := case new.commitment_type when 'SUBCONTRACT' then 'SC-' else 'PO-' end
                    || v_short || '-' || v_year || '-' || lpad(n::text, 4, '0');
    end if;
    -- default AP retainage % from the vendor (Books-owned default) when the client sent none
    if new.retainage_pct is null then
      -- core.vendors.default_retainage_pct is a PERCENT (0–100, mig 036); pm stores fractions
      new.retainage_pct := least(greatest(coalesce(v_ret, 0) / 100.0, 0), 1);
    end if;
  end if;
  return new;
end $$;

create or replace function pm.tg_commitment_line_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text; v_job uuid; v_row pm.commitment_lines%rowtype; v_ct text;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  select c.status, c.job_id into v_status, v_job from pm.commitments c where c.org_id = v_row.org_id and c.id = v_row.commitment_id;
  if current_user in ('authenticated', 'anon') and v_status is distinct from 'DRAFT' then
    raise exception 'PM_COMMITMENT_LOCKED: lines change only while DRAFT (is %); use a commitment change order', v_status using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if not pm.cost_code_usable(new.org_id, v_job, new.cost_code_id) then
    raise exception 'PM_COST_CODE_SCOPE: cost code % is not usable on job %', new.cost_code_id, v_job using errcode = '23514';
  end if;
  if new.cost_type is null and new.cost_code_id is not null then
    select c.cost_type into v_ct from pm.cost_codes c where c.org_id = new.org_id and c.id = new.cost_code_id;
    new.cost_type := v_ct;
  end if;
  if new.amount_cents is null and new.qty is not null and new.unit_cost_cents is not null then
    new.amount_cents := round(new.qty * new.unit_cost_cents)::bigint;
  end if;
  return new;
end $$;

create or replace function pm.tg_commitment_change_defaults() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; n bigint;
begin
  select * into c from pm.commitments x where x.org_id = new.org_id and x.id = new.commitment_id;
  if not found then raise exception 'PM_UNKNOWN_COMMITMENT: %', new.commitment_id using errcode = '23503'; end if;
  new.job_id := c.job_id;
  if tg_op = 'INSERT' and (new.number is null or btrim(new.number) = '') then
    n := pm.next_doc_number(new.org_id, c.id::text, 'CCO', 'all');
    new.number := c.number || '-CCO' || lpad(n::text, 2, '0');
  end if;
  if new.commitment_line_id is not null and not exists (
       select 1 from pm.commitment_lines l where l.org_id = new.org_id and l.id = new.commitment_line_id and l.commitment_id = c.id) then
    raise exception 'PM_CCO_LINE: line % is not on commitment %', new.commitment_line_id, c.number using errcode = '23514';
  end if;
  if not pm.cost_code_usable(new.org_id, c.job_id, new.cost_code_id) then
    raise exception 'PM_COST_CODE_SCOPE: cost code % is not usable on job %', new.cost_code_id, c.job_id using errcode = '23514';
  end if;
  if new.owner_co_id is not null and not exists (
       select 1 from pm.change_orders o where o.org_id = new.org_id and o.id = new.owner_co_id and o.job_id = c.job_id) then
    raise exception 'PM_CCO_OWNER_CO: owner change order % is not on this job', new.owner_co_id using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function pm.tg_compliance_defaults() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_job uuid; v_vendor uuid;
begin
  if new.commitment_id is not null then
    select c.job_id, c.vendor_id into v_job, v_vendor from pm.commitments c where c.org_id = new.org_id and c.id = new.commitment_id;
    if v_job is null then raise exception 'PM_UNKNOWN_COMMITMENT: %', new.commitment_id using errcode = '23503'; end if;
    if new.job_id is null then new.job_id := v_job; end if;
    if new.job_id <> v_job then raise exception 'PM_COMPLIANCE_JOB: commitment is on another job' using errcode = '23514'; end if;
    if new.vendor_id is null then new.vendor_id := v_vendor; end if;
  end if;
  if new.vendor_id is not null and not exists (select 1 from core.vendors v where v.id = new.vendor_id and v.org_id = new.org_id) then
    raise exception 'PM_UNKNOWN_VENDOR: %', new.vendor_id using errcode = '23503';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Schedule of values (port of 1004) — versioned; lineage_id is stable across versions
--    so "work completed from previous applications" survives a CO re-version (1004 keyed
--    previous billing on the line id and reset to zero on a new version).
-- ----------------------------------------------------------------------------
create table if not exists pm.sov_versions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  contract_id    uuid,
  version        int not null check (version >= 1),
  status         text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','SUPERSEDED')),
  retainage_pct  numeric(5,4) check (retainage_pct is null or (retainage_pct >= 0 and retainage_pct <= 1)),  -- overrides the contract rate
  memo           text,
  activated_at   timestamptz,
  activated_by   text,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, job_id, version),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, contract_id) references pm.contracts (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_sov_one_active_uidx on pm.sov_versions (org_id, job_id) where status = 'ACTIVE';

create table if not exists pm.sov_lines (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  sov_version_id         uuid not null,
  lineage_id             uuid not null default gen_random_uuid(),
  line_no                int not null,
  cost_code_id           uuid,
  description            text not null,
  scheduled_value_cents  bigint not null default 0 check (scheduled_value_cents >= 0),
  retainage_pct          numeric(5,4) check (retainage_pct is null or (retainage_pct >= 0 and retainage_pct <= 1)),
  change_order_id        uuid,
  sort                   int not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, sov_version_id, line_no),
  unique (org_id, sov_version_id, lineage_id),
  foreign key (org_id, sov_version_id) references pm.sov_versions (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, change_order_id) references pm.change_orders (org_id, id) deferrable initially immediate
);

create or replace function pm.tg_sov_version_defaults() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if tg_op = 'INSERT' and new.version is null then
    perform pg_advisory_xact_lock(hashtextextended('pm.sov:' || new.job_id::text, 0));
    select coalesce(max(v.version), 0) + 1 into new.version from pm.sov_versions v where v.org_id = new.org_id and v.job_id = new.job_id;
  end if;
  if new.contract_id is not null and not exists (
       select 1 from pm.contracts k where k.org_id = new.org_id and k.id = new.contract_id and k.job_id = new.job_id) then
    raise exception 'PM_SOV_CONTRACT: contract is not on this job' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function pm.tg_sov_line_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text; v_job uuid; v_row pm.sov_lines%rowtype;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  select v.status, v.job_id into v_status, v_job from pm.sov_versions v where v.org_id = v_row.org_id and v.id = v_row.sov_version_id;
  if current_user in ('authenticated', 'anon') and v_status is distinct from 'DRAFT' then
    raise exception 'PM_SOV_LOCKED: SOV lines change only while the version is DRAFT (is %); revise the SOV', v_status using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if not pm.cost_code_usable(new.org_id, v_job, new.cost_code_id) then
    raise exception 'PM_COST_CODE_SCOPE: cost code % is not usable on job %', new.cost_code_id, v_job using errcode = '23514';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Billing requests (Projects drafts; Books issues the invoice and owns its number)
--   status: DRAFT -> EMITTED (event pending in Books) -> ISSUED | REJECTED
--           DRAFT -> UNISSUED (standalone or sample: approved, no event)
--           DRAFT | REJECTED -> VOID
--   REJECTED can be re-approved (new event_id, same source_ref).
-- ----------------------------------------------------------------------------
create table if not exists pm.billing_requests (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id),      -- = the job's company (trigger)
  job_id                    uuid not null,
  contract_id               uuid,
  billing_type              text not null check (billing_type in ('MILESTONE','PROGRESS','TIME_MATERIALS','DRAW')),   -- frozen v3 on the wire
  billing_subtype           text check (billing_subtype is null or billing_subtype in ('SOV','RETAINAGE_RELEASE','ALLOWANCE','RECURRING','FIXED')),
  status                    text not null default 'DRAFT' check (status in ('DRAFT','EMITTED','ISSUED','REJECTED','UNISSUED','VOID')),
  generated_by              text check (generated_by is null or generated_by in ('progress','sov','milestone','tm','retainage_release','allowance')),
  application_no            int check (application_no is null or application_no >= 1),   -- SOV pay application #
  sov_version_id            uuid,
  period_start              date,
  period_end                date,
  occurred_on               date not null default current_date,                 -- invoice date requested
  memo                      text,
  source_ref                text not null,                                      -- pm:bill:{id}
  gross_earned_cents        bigint not null default 0,      -- Σ STANDARD lines (work + stored this period)
  retainage_cents           bigint not null default 0,      -- withheld this request (= −Σ RETAINAGE lines)
  retainage_released_cents  bigint not null default 0,      -- Σ RETAINAGE_RELEASE lines
  net_cents                 bigint not null default 0,      -- Σ all lines = amount due on the invoice
  suppressed_reason         text check (suppressed_reason is null or suppressed_reason in ('STANDALONE','SAMPLE')),
  event_id                  uuid,
  invoice_id                uuid,                           -- Books (ack-in-place on core.events)
  invoice_number            text,                           -- Books
  gl_entry_id               uuid,                           -- Books
  error_text                text,
  created_by                text default pm.current_user_id(),
  approved_by               text,
  approved_at               timestamptz,
  emitted_at                timestamptz,
  issued_at                 timestamptz,
  void_reason               text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, id),
  check (billing_subtype is distinct from 'SOV' or (sov_version_id is not null and application_no is not null)),
  check (status not in ('EMITTED','ISSUED') or event_id is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, contract_id) references pm.contracts (org_id, id) deferrable initially immediate,
  foreign key (org_id, sov_version_id) references pm.sov_versions (org_id, id) deferrable initially immediate
);
create index if not exists pm_billing_requests_job_idx on pm.billing_requests (org_id, job_id, status);
create unique index if not exists pm_billing_requests_event_uidx on pm.billing_requests (org_id, event_id) where event_id is not null;

create table if not exists pm.billing_request_lines (
  id                              uuid primary key default gen_random_uuid(),
  org_id                          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  billing_request_id              uuid not null,
  line_no                         int not null default 0,
  sort                            int not null default 0,
  line_type                       text not null default 'STANDARD' check (line_type in ('STANDARD','RETAINAGE','RETAINAGE_RELEASE')),
  description                     text not null,
  amount_cents                    bigint not null,           -- this request (wire amount)
  item_id                         uuid,
  cost_code_id                    uuid,
  sov_line_id                     uuid,
  sov_lineage_id                  uuid,
  task_id                         uuid,                      -- milestone billed
  wbs_id                          uuid,                      -- milestone billed
  allowance_id                    uuid,
  -- AIA G703 continuation-sheet columns (SOV); progress lines fill the earned/to-date subset
  scheduled_value_cents           bigint,                    -- C
  previous_work_cents             bigint,                    -- D  work completed from previous applications
  this_period_work_cents          bigint,                    -- E  work completed this period
  stored_materials_cents          bigint,                    -- F  materials presently stored (balance)
  previous_stored_cents           bigint,                    --    F on the previous application
  total_completed_cents           bigint,                    -- G = D + E + F
  pct_complete                    numeric(9,6),              -- G / C
  balance_to_finish_cents         bigint,                    -- H = C − G
  retainage_rate                  numeric(5,4),
  retainage_work_to_date_cents    bigint,                    -- round(rate × (D+E))
  retainage_stored_to_date_cents  bigint,                    -- round(rate × F)
  retainage_this_period_cents     bigint not null default 0, -- held by this request on this line (after any cap)
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (org_id, id),
  check (line_type <> 'RETAINAGE' or retainage_this_period_cents = 0),
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, sov_line_id) references pm.sov_lines (org_id, id) deferrable initially immediate,
  foreign key (org_id, task_id) references pm.tasks (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_brl_request_idx on pm.billing_request_lines (org_id, billing_request_id, sort);
create index if not exists pm_brl_lineage_idx on pm.billing_request_lines (org_id, sov_lineage_id) where sov_lineage_id is not null;
create index if not exists pm_brl_task_idx on pm.billing_request_lines (org_id, task_id) where task_id is not null;
create index if not exists pm_brl_wbs_idx on pm.billing_request_lines (org_id, wbs_id) where wbs_id is not null;

-- Retainage receivable shadow (Books GL RETAINAGE_RECEIVABLE is the book; this must tie, G3).
-- HELD rows (signed; a negative HELD is a retainage adjustment) and RELEASED rows (positive)
-- are written at approve_and_emit_billing, per billing line and SOV lineage.
create table if not exists pm.retainage_ledger (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  job_id                   uuid not null,
  billing_request_id       uuid not null,
  billing_request_line_id  uuid,
  sov_line_id              uuid,
  sov_lineage_id           uuid,
  entry_type               text not null check (entry_type in ('HELD','RELEASED')),
  amount_cents             bigint not null check (entry_type = 'HELD' or amount_cents > 0),
  memo                     text,
  created_at               timestamptz not null default now(),
  constraint retainage_ledger_entry_key unique nulls not distinct
    (org_id, billing_request_id, entry_type, billing_request_line_id, sov_lineage_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, billing_request_line_id) references pm.billing_request_lines (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_retainage_ledger_job_idx on pm.retainage_ledger (org_id, job_id);

-- Owner allowances (port of 1004). Reconciliation goes through a change order (contract truth);
-- the overage is then billed as subtype ALLOWANCE.
create table if not exists pm.allowances (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  cost_code_id     uuid,
  description      text not null,
  allowance_cents  bigint not null default 0 check (allowance_cents >= 0),
  actual_cents     bigint check (actual_cents is null or actual_cents >= 0),
  status           text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  estimate_line_id uuid,
  variance_co_id   uuid,
  closed_at        timestamptz,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  check ((status = 'CLOSED') = (actual_cents is not null and closed_at is not null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, variance_co_id) references pm.change_orders (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_allowances_estimate_line_uidx on pm.allowances (org_id, estimate_line_id) where estimate_line_id is not null;

-- No source billed twice (T&M time today; job_costs for cost-plus later). The PK is the guarantee.
create table if not exists pm.billing_links (
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  source_table             text not null check (source_table in ('time_entries','job_costs')),
  source_id                uuid not null,
  job_id                   uuid not null,
  billing_request_id       uuid not null,
  billing_request_line_id  uuid not null,
  amount_cents             bigint not null,
  created_at               timestamptz not null default now(),
  primary key (org_id, source_table, source_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, billing_request_line_id) references pm.billing_request_lines (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_billing_links_request_idx on pm.billing_links (org_id, billing_request_id);

-- Customer deposit invoice requests (Books owns deposits / 2420; JOB_DEPOSIT_REQUEST).
create table if not exists pm.deposit_requests (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  job_id             uuid not null,
  customer_id        uuid references core.customers(id),
  amount_cents       bigint not null check (amount_cents > 0),
  memo               text,
  occurred_on        date not null default current_date,
  status             text not null default 'DRAFT' check (status in ('DRAFT','EMITTED','ISSUED','REJECTED','UNISSUED','VOID')),
  suppressed_reason  text check (suppressed_reason is null or suppressed_reason in ('STANDALONE','SAMPLE')),
  source_ref         text not null,                     -- pm:deposit:{id}
  event_id           uuid,
  invoice_id         uuid,
  invoice_number     text,
  gl_entry_id        uuid,
  error_text         text,
  emitted_at         timestamptz,
  issued_at          timestamptz,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_deposit_requests_job_idx on pm.deposit_requests (org_id, job_id, status);
create unique index if not exists pm_deposit_requests_event_uidx on pm.deposit_requests (org_id, event_id) where event_id is not null;

create or replace function pm.tg_billing_request_defaults() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid;
begin
  select j.location_id into v_loc from core.jobs j where j.org_id = new.org_id and j.id = new.job_id;
  if v_loc is null then raise exception 'PM_UNKNOWN_JOB: job % not in org', new.job_id using errcode = '23503'; end if;
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then
    raise exception 'PM_BILLING_JOB_FIXED: a billing request cannot move between jobs' using errcode = '42501';
  end if;
  new.location_id := v_loc;
  if tg_op = 'INSERT' then
    new.source_ref := 'pm:bill:' || new.id::text;
    if new.contract_id is null then new.contract_id := pm.primary_contract_id(new.org_id, new.job_id); end if;
  end if;
  if new.contract_id is not null and not exists (
       select 1 from pm.contracts k where k.org_id = new.org_id and k.id = new.contract_id and k.job_id = new.job_id) then
    raise exception 'PM_BILLING_CONTRACT: contract is not on this job' using errcode = '23514';
  end if;
  return new;
end $$;

-- Members may hand-write STANDARD lines on their own manual DRAFT requests only; generated
-- requests (SOV/progress/...) keep their math intact.
create or replace function pm.tg_billing_line_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare r pm.billing_requests%rowtype; v_row pm.billing_request_lines%rowtype;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  select * into r from pm.billing_requests b where b.org_id = v_row.org_id and b.id = v_row.billing_request_id;
  if current_user in ('authenticated', 'anon') then
    if r.status is distinct from 'DRAFT' or r.generated_by is not null then
      raise exception 'PM_BILLING_LOCKED: lines can be edited only on a manual DRAFT request' using errcode = '42501';
    end if;
    if tg_op <> 'DELETE' and (new.line_type <> 'STANDARD' or new.retainage_this_period_cents <> 0
        or new.sov_line_id is not null or new.task_id is not null or new.wbs_id is not null) then
      raise exception 'PM_BILLING_LINE_TYPE: members write STANDARD lines only' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if not pm.cost_code_usable(new.org_id, r.job_id, new.cost_code_id) then
    raise exception 'PM_COST_CODE_SCOPE: cost code % is not usable on job %', new.cost_code_id, r.job_id using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function pm.tg_billing_totals() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_req uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_req := old.billing_request_id; else v_org := new.org_id; v_req := new.billing_request_id; end if;
  update pm.billing_requests b
     set gross_earned_cents       = t.gross,
         retainage_cents          = t.ret,
         retainage_released_cents = t.rel,
         net_cents                = t.net
    from (select coalesce(sum(l.amount_cents) filter (where l.line_type = 'STANDARD'), 0)::bigint           as gross,
                 coalesce(-sum(l.amount_cents) filter (where l.line_type = 'RETAINAGE'), 0)::bigint         as ret,
                 coalesce(sum(l.amount_cents) filter (where l.line_type = 'RETAINAGE_RELEASE'), 0)::bigint  as rel,
                 coalesce(sum(l.amount_cents), 0)::bigint                                                   as net
          from pm.billing_request_lines l where l.org_id = v_org and l.billing_request_id = v_req) t
   where b.org_id = v_org and b.id = v_req
     and (b.gross_earned_cents, b.retainage_cents, b.retainage_released_cents, b.net_cents)
         is distinct from (t.gross, t.ret, t.rel, t.net);
  return null;
end $$;

create or replace function pm.tg_allowance_guard() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not pm.cost_code_usable(new.org_id, new.job_id, new.cost_code_id) then
    raise exception 'PM_COST_CODE_SCOPE: cost code % is not usable on job %', new.cost_code_id, new.job_id using errcode = '23514';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Triggers
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['estimates','estimate_lines','commitments','commitment_lines','commitment_changes',
    'compliance_docs','sov_versions','sov_lines','billing_requests','billing_request_lines','allowances','deposit_requests'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['estimates','commitments','commitment_changes','compliance_docs','sov_versions',
    'billing_requests','allowances'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
end $$;

create or replace trigger trg_estimate_defaults before insert or update of job_id, customer_id on pm.estimates
  for each row execute function pm.tg_estimate_defaults();
create or replace trigger trg_estimate_line_guard before insert or update or delete on pm.estimate_lines
  for each row execute function pm.tg_estimate_line_guard();
create or replace trigger trg_estimate_totals after insert or update of amount_cents, cost_cents or delete on pm.estimate_lines
  for each row execute function pm.tg_estimate_totals();
create or replace trigger trg_commitment_defaults before insert or update of job_id, vendor_id on pm.commitments
  for each row execute function pm.tg_commitment_defaults();
create or replace trigger trg_commitment_line_guard before insert or update or delete on pm.commitment_lines
  for each row execute function pm.tg_commitment_line_guard();
create or replace trigger trg_commitment_change_defaults before insert or update of commitment_id, commitment_line_id, cost_code_id, owner_co_id on pm.commitment_changes
  for each row execute function pm.tg_commitment_change_defaults();
create or replace trigger trg_compliance_defaults before insert or update of commitment_id, job_id, vendor_id on pm.compliance_docs
  for each row execute function pm.tg_compliance_defaults();
create or replace trigger trg_sov_version_defaults before insert or update of contract_id on pm.sov_versions
  for each row execute function pm.tg_sov_version_defaults();
create or replace trigger trg_sov_line_guard before insert or update or delete on pm.sov_lines
  for each row execute function pm.tg_sov_line_guard();
create or replace trigger trg_billing_request_defaults before insert or update of job_id, contract_id on pm.billing_requests
  for each row execute function pm.tg_billing_request_defaults();
create or replace trigger trg_billing_line_guard before insert or update or delete on pm.billing_request_lines
  for each row execute function pm.tg_billing_line_guard();
create or replace trigger trg_billing_totals after insert or update of amount_cents, line_type or delete on pm.billing_request_lines
  for each row execute function pm.tg_billing_totals();
create or replace trigger trg_allowance_guard before insert or update of cost_code_id, job_id on pm.allowances
  for each row execute function pm.tg_allowance_guard();


-- ----------------------------------------------------------------------------
-- 7. Read models used by functions and views
-- ----------------------------------------------------------------------------

-- The current budget by cost code: latest APPROVED REVISED budget, else the latest
-- non-superseded ORIGINAL (same rule as pm.v_job_money).
create or replace view pm.v_job_current_budget_lines with (security_invoker = on) as
select b.org_id, b.job_id, b.id as budget_id, b.kind as budget_kind, b.version as budget_version,
       l.id as budget_line_id, l.cost_code_id, l.amount_cents
from pm.budgets b
join pm.budget_lines l on l.org_id = b.org_id and l.budget_id = b.id
where b.id = coalesce(
  (select r.id from pm.budgets r where r.org_id = b.org_id and r.job_id = b.job_id
     and r.kind = 'REVISED' and r.status = 'APPROVED' order by r.version desc limit 1),
  (select o.id from pm.budgets o where o.org_id = b.org_id and o.job_id = b.job_id
     and o.kind = 'ORIGINAL' and o.status <> 'SUPERSEDED' order by o.version desc limit 1));

-- Retainage per job. Counts only rows of requests that reached Books or were approved
-- standalone (EMITTED | ISSUED | UNISSUED); a REJECTED or VOID request held nothing.
create or replace view pm.v_job_retainage with (security_invoker = on) as
select l.org_id, l.job_id,
       coalesce(sum(l.amount_cents) filter (where l.entry_type = 'HELD'), 0)::bigint      as held_cents,
       coalesce(sum(l.amount_cents) filter (where l.entry_type = 'RELEASED'), 0)::bigint  as released_cents,
       (coalesce(sum(l.amount_cents) filter (where l.entry_type = 'HELD'), 0)
        - coalesce(sum(l.amount_cents) filter (where l.entry_type = 'RELEASED'), 0))::bigint as outstanding_cents
from pm.retainage_ledger l
join pm.billing_requests r on r.org_id = l.org_id and r.id = l.billing_request_id
where r.status in ('EMITTED','ISSUED','UNISSUED')
group by l.org_id, l.job_id;

-- ----------------------------------------------------------------------------
-- 8. Guards (replace the 1100 placeholders). SECURITY INVOKER like 1100: owner rights
--    inside transition_stage, caller RLS when called directly.
-- ----------------------------------------------------------------------------
create or replace function pm.guard_estimate_accepted(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select exists (select 1 from pm.estimates e where e.job_id = p_job and e.status = 'ACCEPTED')
$$;

create or replace function pm.guard_deposit_requested(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select exists (select 1 from pm.deposit_requests d where d.job_id = p_job and d.status in ('EMITTED','ISSUED','UNISSUED'))
$$;

-- final billed: gross billed (excluding retainage releases) ≥ revised contract AND no
-- retainage left outstanding.
create or replace function pm.guard_final_billed(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select coalesce((select sum(r.gross_earned_cents) from pm.billing_requests r
                   where r.job_id = p_job and r.status in ('EMITTED','ISSUED','UNISSUED')
                     and r.billing_subtype is distinct from 'RETAINAGE_RELEASE'), 0)
         >= coalesce((select m.revised_contract_cents from pm.v_job_money m where m.job_id = p_job), 0)
     and coalesce((select v.outstanding_cents from pm.v_job_retainage v where v.job_id = p_job), 0) <= 0
$$;

-- compliance current: every REQUIRED doc on the job (job-level or on a non-void commitment)
-- is VERIFIED and unexpired.
create or replace function pm.guard_compliance_current(p_job uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select not exists (
    select 1 from pm.compliance_docs d
    left join pm.commitments c on c.org_id = d.org_id and c.id = d.commitment_id
    where d.job_id = p_job and d.required and (c.id is null or c.status <> 'VOID')
      and not (d.status = 'VERIFIED' and (d.expires_on is null or d.expires_on >= current_date)))
$$;

-- Commitment payment eligibility (port of 1005 payment_eligible): no REQUIRED doc on the
-- commitment is missing, unverified or expired.
create or replace function pm.commitment_payment_eligible(p_commitment uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select not exists (
    select 1 from pm.compliance_docs d
    where d.commitment_id = p_commitment and d.required
      and not (d.status = 'VERIFIED' and (d.expires_on is null or d.expires_on >= current_date)))
$$;

-- Draw preconditions (lender inspection / title) arrive with 1105 lender draws: TRUE until then.
create or replace function pm.draw_preconditions_met(p_request uuid) returns boolean
language sql stable set search_path = pm, core, public as $$
  select true
$$;

-- ----------------------------------------------------------------------------
-- 9. Estimates: send / accept / decline / revise
-- ----------------------------------------------------------------------------
create or replace function pm.send_estimate(p_estimate uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.estimates%rowtype;
begin
  select * into e from pm.estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: estimate % not found in the caller''s organization', p_estimate using errcode = '42501';
  end if;
  if e.status <> 'DRAFT' then raise exception 'PM_ESTIMATE_NOT_DRAFT: % v% is %', e.number, e.version, e.status using errcode = '22023'; end if;
  if not exists (select 1 from pm.estimate_lines l where l.org_id = e.org_id and l.estimate_id = e.id) then
    raise exception 'PM_ESTIMATE_EMPTY: % has no lines', e.number using errcode = '22023';
  end if;
  update pm.estimates set status = 'SENT', sent_at = now() where id = e.id;
  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'estimate.sent', 'estimates', e.id,
    format('Sent %s v%s (%s cents)', e.number, e.version, e.total_cents), jsonb_build_object('total_cents', e.total_cents));
  return e.id;
end $$;

create or replace function pm.decline_estimate(p_estimate uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.estimates%rowtype;
begin
  select * into e from pm.estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: estimate % not found in the caller''s organization', p_estimate using errcode = '42501';
  end if;
  if e.status not in ('DRAFT','SENT') then raise exception 'PM_ESTIMATE_NOT_OPEN: % v% is %', e.number, e.version, e.status using errcode = '22023'; end if;
  update pm.estimates set status = 'DECLINED', declined_at = now(), decline_reason = p_reason where id = e.id;
  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'estimate.declined', 'estimates', e.id,
    format('%s v%s declined', e.number, e.version), jsonb_build_object('reason', p_reason));
  return e.id;
end $$;

-- New DRAFT version with the same number and copied lines. Open (DRAFT/SENT) versions are
-- superseded now; an ACCEPTED version stays ACCEPTED until the new one is accepted.
create or replace function pm.revise_estimate(p_estimate uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.estimates%rowtype; v_new uuid := gen_random_uuid(); v_ver int;
begin
  select * into e from pm.estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: estimate % not found in the caller''s organization', p_estimate using errcode = '42501';
  end if;
  if e.status = 'SUPERSEDED' then raise exception 'PM_ESTIMATE_SUPERSEDED: revise the latest version of %', e.number using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.estimate:' || e.org_id::text || ':' || e.number, 0));
  select max(x.version) + 1 into v_ver from pm.estimates x where x.org_id = e.org_id and x.number = e.number;
  if exists (select 1 from pm.estimates x where x.org_id = e.org_id and x.number = e.number and x.status = 'DRAFT' and x.id <> e.id) then
    raise exception 'PM_ESTIMATE_DRAFT_EXISTS: % already has an open DRAFT version', e.number using errcode = '22023';
  end if;
  update pm.estimates set status = 'SUPERSEDED' where org_id = e.org_id and number = e.number and status in ('DRAFT','SENT');
  insert into pm.estimates (id, org_id, location_id, job_id, customer_id, number, version, title, status,
                            retainage_pct, valid_until, notes, supersedes_id, created_by)
  values (v_new, e.org_id, e.location_id, e.job_id, e.customer_id, e.number, v_ver, e.title, 'DRAFT',
          e.retainage_pct, e.valid_until, e.notes, e.id, pm.current_user_id());
  insert into pm.estimate_lines (org_id, estimate_id, line_no, cost_code_id, wbs_id, price_book_item_id, description,
                                 qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, is_allowance, sort, ext)
  select l.org_id, v_new, l.line_no, l.cost_code_id, l.wbs_id, l.price_book_item_id, l.description,
         l.qty, l.uom, l.unit_cost_cents, l.unit_price_cents, l.cost_cents, l.amount_cents, l.is_allowance, l.sort, l.ext
  from pm.estimate_lines l where l.org_id = e.org_id and l.estimate_id = e.id;
  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'estimate.revised', 'estimates', v_new,
    format('%s revised to v%s', e.number, v_ver), jsonb_build_object('from_version', e.version, 'to_version', v_ver));
  return v_new;
end $$;

-- Accept: ACCEPTED; ORIGINAL budget by cost code from the lines' cost (created, or a new
-- version replacing the lines this estimate number produced earlier, keeping hand-entered
-- lines); allowance lines become pm.allowances; set_contract(total) when the job has no
-- contract (that emits JOB_PROGRESS CONTRACT_SET), else BUDGET_REVISED progress when the
-- budget changed under an active contract.
create or replace function pm.accept_estimate(p_estimate uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  e          pm.estimates%rowtype;
  b          pm.budgets%rowtype;
  v_me       text := pm.current_user_id();
  v_budget   uuid;
  v_ver      int;
  v_uncoded  int;
  v_contract uuid;
  v_created  boolean := false;
  v_event    uuid;
  v_siblings uuid[];
begin
  select * into e from pm.estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: estimate % not found in the caller''s organization', p_estimate using errcode = '42501';
  end if;
  if e.status not in ('DRAFT','SENT') then
    raise exception 'PM_ESTIMATE_NOT_OPEN: % v% is %', e.number, e.version, e.status using errcode = '22023';
  end if;
  if not exists (select 1 from pm.estimate_lines l where l.org_id = e.org_id and l.estimate_id = e.id) then
    raise exception 'PM_ESTIMATE_EMPTY: % has no lines', e.number using errcode = '22023';
  end if;
  if e.total_cents <= 0 then raise exception 'PM_ESTIMATE_NONPOSITIVE: total must be > 0' using errcode = '22023'; end if;
  select count(*) into v_uncoded from pm.estimate_lines l
  where l.org_id = e.org_id and l.estimate_id = e.id and coalesce(l.cost_cents, 0) <> 0 and l.cost_code_id is null;
  if v_uncoded > 0 then
    raise exception 'PM_ESTIMATE_UNCODED: % costed line(s) have no cost code; the budget is by cost code', v_uncoded using errcode = '22023';
  end if;
  if not exists (select 1 from pm.projects p where p.org_id = e.org_id and p.job_id = e.job_id) then
    raise exception 'PM_NOT_A_PROJECT: job % has no pm.projects row', e.job_id using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pm.budget:' || e.job_id::text, 0));

  select coalesce(array_agg(x.id), '{}') into v_siblings from pm.estimates x where x.org_id = e.org_id and x.number = e.number;
  update pm.estimates set status = 'SUPERSEDED' where org_id = e.org_id and number = e.number and id <> e.id and status in ('ACCEPTED','DRAFT','SENT');
  update pm.estimates set status = 'ACCEPTED', accepted_at = now(), accepted_by = v_me where id = e.id;

  -- ---- ORIGINAL budget ----
  select * into b from pm.budgets x
  where x.org_id = e.org_id and x.job_id = e.job_id and x.kind = 'ORIGINAL' and x.status <> 'SUPERSEDED'
  order by x.version desc limit 1 for update;
  if not found then
    insert into pm.budgets (org_id, job_id, kind, version, status, label, created_by)
    values (e.org_id, e.job_id, 'ORIGINAL',
            coalesce((select max(x.version) from pm.budgets x where x.org_id = e.org_id and x.job_id = e.job_id and x.kind = 'ORIGINAL'), 0) + 1,
            'APPROVED', format('Original budget (%s v%s)', e.number, e.version), v_me)
    returning id into v_budget;
  elsif b.status = 'DRAFT' then
    v_budget := b.id;
    delete from pm.budget_lines l where l.org_id = e.org_id and l.budget_id = b.id and l.source_estimate_id = any (v_siblings);
    update pm.budgets set status = 'APPROVED', label = coalesce(label, format('Original budget (%s v%s)', e.number, e.version)) where id = b.id;
  else
    select max(x.version) + 1 into v_ver from pm.budgets x where x.org_id = e.org_id and x.job_id = e.job_id and x.kind = 'ORIGINAL';
    update pm.budgets set status = 'SUPERSEDED' where id = b.id;
    insert into pm.budgets (org_id, job_id, kind, version, status, label, created_by)
    values (e.org_id, e.job_id, 'ORIGINAL', v_ver, 'APPROVED', format('Original budget (%s v%s)', e.number, e.version), v_me)
    returning id into v_budget;
    insert into pm.budget_lines (org_id, budget_id, cost_code_id, description, qty, uom, unit_cost_cents, amount_cents, sort, source_estimate_id)
    select l.org_id, v_budget, l.cost_code_id, l.description, l.qty, l.uom, l.unit_cost_cents, l.amount_cents, l.sort, l.source_estimate_id
    from pm.budget_lines l
    where l.org_id = e.org_id and l.budget_id = b.id
      and (l.source_estimate_id is null or not (l.source_estimate_id = any (v_siblings)));
  end if;
  insert into pm.budget_lines (org_id, budget_id, cost_code_id, description, amount_cents, sort, source_estimate_id)
  select e.org_id, v_budget, l.cost_code_id, format('%s v%s', e.number, e.version), sum(l.cost_cents)::bigint,
         1000 + min(l.sort), e.id
  from pm.estimate_lines l
  where l.org_id = e.org_id and l.estimate_id = e.id and coalesce(l.cost_cents, 0) <> 0
  group by l.cost_code_id;
  update pm.estimates set budget_id = v_budget where id = e.id;

  -- ---- allowances from allowance lines (price allowance carried in the contract) ----
  insert into pm.allowances (org_id, job_id, cost_code_id, description, allowance_cents, estimate_line_id, created_by)
  select e.org_id, e.job_id, l.cost_code_id, coalesce(nullif(l.description, ''), 'Allowance'), l.amount_cents, l.id, v_me
  from pm.estimate_lines l
  where l.org_id = e.org_id and l.estimate_id = e.id and l.is_allowance
  on conflict (org_id, estimate_line_id) where estimate_line_id is not null do nothing;

  -- ---- contract ----
  if not exists (select 1 from pm.contracts k where k.org_id = e.org_id and k.job_id = e.job_id and k.status in ('DRAFT','ACTIVE')) then
    v_contract := pm.set_contract(e.job_id, e.total_cents, 'PRIME', e.retainage_pct, null, null, null);
    v_created := true;
  elsif exists (select 1 from pm.contracts k where k.org_id = e.org_id and k.job_id = e.job_id and k.status = 'ACTIVE') then
    v_event := pm.emit_job_progress(e.job_id, 'BUDGET_REVISED', null);
  end if;

  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'estimate.accepted', 'estimates', e.id,
    format('Accepted %s v%s (%s cents)', e.number, e.version, e.total_cents),
    jsonb_build_object('total_cents', e.total_cents, 'cost_total_cents', e.cost_total_cents,
                       'budget_id', v_budget, 'contract_id', v_contract, 'contract_created', v_created));
  return jsonb_build_object('estimate_id', e.id, 'budget_id', v_budget, 'contract_id', v_contract,
                            'contract_created', v_created, 'progress_event_id', v_event);
end $$;

-- ----------------------------------------------------------------------------
-- 10. Commitments: snapshot emitter + approvals + receipts + holds
-- ----------------------------------------------------------------------------

-- Bump the commitment version and emit a JOB_COMMITMENT snapshot (non-posting; Books
-- upserts an AP match-target projection; a higher version replaces a lower one).
-- Internal: callers have org-guarded and locked the commitment.
create or replace function pm.commitment_snapshot(p_commitment uuid, p_trigger text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  c         pm.commitments%rowtype;
  v_hold    boolean;
  v_reason  text;
  v_supp    text;
  v_event   uuid;
  v_lines   jsonb;
  v_total   bigint;
  v_payload jsonb;
  v_docs    text;
begin
  update pm.commitments set version = version + 1 where id = p_commitment returning * into c;
  if not found then raise exception 'PM_UNKNOWN_COMMITMENT: %', p_commitment using errcode = 'P0002'; end if;

  select string_agg(format('%s %s', d.doc_type,
           case when d.status = 'VERIFIED' and d.expires_on < current_date then 'expired ' || d.expires_on::text else lower(d.status) end),
           ', ' order by d.doc_type)
    into v_docs
  from pm.compliance_docs d
  where d.org_id = c.org_id and d.commitment_id = c.id and d.required
    and not (d.status = 'VERIFIED' and (d.expires_on is null or d.expires_on >= current_date));
  v_hold := c.payment_hold or v_docs is not null;
  v_reason := nullif(concat_ws('; ', case when c.payment_hold then coalesce(c.hold_reason, 'Manual hold') end,
                                     case when v_docs is not null then 'COMPLIANCE: ' || v_docs end), '');

  select jsonb_agg(jsonb_build_object(
           'commitment_line_id',     l.id,
           'line_no',                l.line_no,
           'cost_code_id',           l.cost_code_id,
           'cost_code',              cc.code,
           'cost_type',              coalesce(l.cost_type, cc.cost_type),
           'account_hint',           coalesce(l.account_hint, cc.role_hint),
           'item_id',                l.item_id,
           'description',            l.description,
           'qty',                    l.qty,
           'uom',                    l.uom,
           'unit_cost_cents',        l.unit_cost_cents,
           'amount_cents',           l.amount_cents,
           'received_to_date_cents', l.received_cents,
           'tax_code',               l.tax_code) order by l.line_no, l.id),
         coalesce(sum(l.amount_cents), 0)
    into v_lines, v_total
  from pm.commitment_lines l
  left join pm.cost_codes cc on cc.org_id = l.org_id and cc.id = l.cost_code_id
  where l.org_id = c.org_id and l.commitment_id = c.id;

  v_supp := pm.emit_suppression(c.org_id, c.job_id);
  if v_supp is null then
    v_event := gen_random_uuid();
    v_payload := jsonb_build_object(
      'event_id',           v_event,
      'event_type',         'JOB_COMMITMENT',
      'source_module',      'PROJECTS',
      'schema_version',     1,
      'org_id',             c.org_id,
      'location_id',        c.location_id,
      'job_id',             c.job_id,
      'occurred_on',        to_char(current_date, 'YYYY-MM-DD'),
      'source_ref',         'pm:commit:' || c.id::text || ':v' || c.version,
      'trigger',            p_trigger,
      'commitment_id',      c.id,
      'version',            c.version,
      'commitment_type',    c.commitment_type,
      'vendor_id',          c.vendor_id,
      'number',             c.number,
      'status',             c.status,
      'retainage_pct',      c.retainage_pct,
      'payment_hold',       v_hold,
      'hold_reason',        v_reason,
      'executed_on',        to_char(c.executed_on, 'YYYY-MM-DD'),
      'total_amount_cents', v_total,
      'memo',               coalesce(c.title, c.number),
      'lines',              coalesce(v_lines, '[]'::jsonb));
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (c.org_id, v_event, 'JOB_COMMITMENT', 'PROJECTS', v_payload, current_date, 'pending');
  end if;
  update pm.commitments set event_id = coalesce(v_event, event_id), last_emitted_hold = v_hold, suppressed_reason = v_supp
   where id = c.id;
  return v_event;
end $$;

create or replace function pm.approve_commitment(p_commitment uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_me text := pm.current_user_id(); v_n int; v_total bigint; v_uncoded int; v_pol jsonb; v_event uuid;
begin
  select * into c from pm.commitments x where x.id = p_commitment for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  if c.status <> 'DRAFT' then raise exception 'PM_COMMITMENT_NOT_DRAFT: % is %', c.number, c.status using errcode = '22023'; end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  if c.created_by is not null and c.created_by = v_me then
    raise exception 'PM_SOD_VIOLATION: the preparer of % cannot approve it', c.number using errcode = '42501';
  end if;
  if c.vendor_id is null then raise exception 'PM_COMMITMENT_NO_VENDOR: % has no vendor', c.number using errcode = '22023'; end if;
  select count(*), coalesce(sum(l.amount_cents), 0), count(*) filter (where l.cost_code_id is null)
    into v_n, v_total, v_uncoded
  from pm.commitment_lines l where l.org_id = c.org_id and l.commitment_id = c.id;
  if v_n = 0 or v_total <= 0 then raise exception 'PM_COMMITMENT_EMPTY: % needs lines totalling > 0', c.number using errcode = '22023'; end if;
  if v_uncoded > 0 then raise exception 'PM_COMMITMENT_UNCODED: % line(s) on % have no cost code', v_uncoded, c.number using errcode = '22023'; end if;
  v_pol := pm.enforce_approval_policy(c.org_id, c.location_id, 'commitment', v_total, v_me);

  update pm.commitment_lines set original_amount_cents = amount_cents where org_id = c.org_id and commitment_id = c.id;
  update pm.commitments set status = 'APPROVED', approved_by = v_me, approved_at = now(), approval = v_pol where id = c.id;
  v_event := pm.commitment_snapshot(c.id, 'APPROVED');
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'commitment.approved', 'commitments', c.id,
    format('Approved %s (%s cents)', c.number, v_total), jsonb_build_object('total_cents', v_total, 'event_id', v_event, 'approval', v_pol));
  return v_event;
end $$;

create or replace function pm.approve_commitment_change(p_change uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare x pm.commitment_changes%rowtype; c pm.commitments%rowtype; v_me text := pm.current_user_id();
        v_pol jsonb; v_line uuid; v_amt bigint; v_event uuid;
begin
  select * into x from pm.commitment_changes y where y.id = p_change for update;
  if x.org_id is null or x.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment change % not found in the caller''s organization', p_change using errcode = '42501';
  end if;
  select * into c from pm.commitments y where y.org_id = x.org_id and y.id = x.commitment_id for update;
  if x.status <> 'DRAFT' then raise exception 'PM_CCO_NOT_DRAFT: % is %', x.number, x.status using errcode = '22023'; end if;
  if c.status not in ('APPROVED','EXECUTED') then
    raise exception 'PM_CCO_COMMITMENT_STATE: % is % (edit DRAFT commitments directly)', c.number, c.status using errcode = '22023';
  end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  if x.created_by is not null and x.created_by = v_me then
    raise exception 'PM_SOD_VIOLATION: the preparer of % cannot approve it', x.number using errcode = '42501';
  end if;
  v_pol := pm.enforce_approval_policy(c.org_id, c.location_id, 'commitment', abs(x.amount_cents), v_me);

  if x.commitment_line_id is not null then
    select l.amount_cents + x.amount_cents into v_amt from pm.commitment_lines l where l.org_id = x.org_id and l.id = x.commitment_line_id for update;
    if v_amt < 0 then raise exception 'PM_CCO_NEGATIVE_LINE: change would take the line below zero' using errcode = '22023'; end if;
    update pm.commitment_lines set amount_cents = v_amt where org_id = x.org_id and id = x.commitment_line_id;
    v_line := x.commitment_line_id;
  else
    if x.cost_code_id is null or x.amount_cents <= 0 then
      raise exception 'PM_CCO_NEW_LINE: a change that adds a line needs a cost code and a positive amount' using errcode = '22023';
    end if;
    insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, description, amount_cents, original_amount_cents)
    values (x.org_id, c.id, coalesce((select max(l.line_no) from pm.commitment_lines l where l.org_id = c.org_id and l.commitment_id = c.id), 0) + 1,
            x.cost_code_id, x.description, x.amount_cents, 0)
    returning id into v_line;
  end if;
  update pm.commitment_changes set status = 'APPROVED', approved_by = v_me, approved_at = now(), approval = v_pol, applied_line_id = v_line
   where id = x.id;
  v_event := pm.commitment_snapshot(c.id, 'CHANGE_ORDER');
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'commitment.change_approved', 'commitment_changes', x.id,
    format('Approved %s (%s cents) on %s', x.number, x.amount_cents, c.number),
    jsonb_build_object('amount_cents', x.amount_cents, 'commitment_id', c.id, 'event_id', v_event, 'owner_co_id', x.owner_co_id));
  return v_event;
end $$;

create or replace function pm.reject_commitment_change(p_change uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare x pm.commitment_changes%rowtype; v_loc uuid;
begin
  select * into x from pm.commitment_changes y where y.id = p_change for update;
  if x.org_id is null or x.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment change % not found in the caller''s organization', p_change using errcode = '42501';
  end if;
  if x.status <> 'DRAFT' then raise exception 'PM_CCO_NOT_DRAFT: % is %', x.number, x.status using errcode = '22023'; end if;
  update pm.commitment_changes set status = 'REJECTED', reject_reason = p_reason where id = x.id;
  select j.location_id into v_loc from core.jobs j where j.id = x.job_id;
  perform pm.log_activity(x.org_id, v_loc, x.job_id, 'commitment.change_rejected', 'commitment_changes', x.id,
    format('Rejected %s', x.number), jsonb_build_object('reason', p_reason));
  return x.id;
end $$;

-- APPROVED -> EXECUTED (signed). Re-emits.
create or replace function pm.execute_commitment(p_commitment uuid, p_executed_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_event uuid;
begin
  select * into c from pm.commitments x where x.id = p_commitment for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  if c.status <> 'APPROVED' then raise exception 'PM_COMMITMENT_NOT_APPROVED: % is %', c.number, c.status using errcode = '22023'; end if;
  update pm.commitments set status = 'EXECUTED', executed_on = coalesce(p_executed_on, current_date) where id = c.id;
  v_event := pm.commitment_snapshot(c.id, 'EXECUTED');
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'commitment.executed', 'commitments', c.id,
    format('%s executed', c.number), jsonb_build_object('event_id', v_event));
  return v_event;
end $$;

-- APPROVED | EXECUTED -> CLOSED (no further billing expected; committed open drops to 0).
create or replace function pm.close_commitment(p_commitment uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_event uuid;
begin
  select * into c from pm.commitments x where x.id = p_commitment for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  if c.status not in ('APPROVED','EXECUTED') then raise exception 'PM_COMMITMENT_NOT_OPEN: % is %', c.number, c.status using errcode = '22023'; end if;
  update pm.commitments set status = 'CLOSED' where id = c.id;
  v_event := pm.commitment_snapshot(c.id, 'CLOSED');
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'commitment.closed', 'commitments', c.id,
    format('%s closed', c.number), jsonb_build_object('event_id', v_event));
  return v_event;
end $$;

-- DRAFT -> VOID (no event); APPROVED | EXECUTED -> VOID only while nothing is billed against it.
create or replace function pm.void_commitment(p_commitment uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_event uuid; v_billed bigint;
begin
  select * into c from pm.commitments x where x.id = p_commitment for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  if c.status not in ('DRAFT','APPROVED','EXECUTED') then raise exception 'PM_COMMITMENT_NOT_VOIDABLE: % is %', c.number, c.status using errcode = '22023'; end if;
  select coalesce(sum(l.billed_cents), 0) into v_billed from pm.commitment_lines l where l.org_id = c.org_id and l.commitment_id = c.id;
  if v_billed <> 0 then raise exception 'PM_COMMITMENT_BILLED: % has % cents billed; close it instead', c.number, v_billed using errcode = '22023'; end if;
  update pm.commitments set status = 'VOID', void_reason = p_reason where id = c.id;
  if c.status <> 'DRAFT' then v_event := pm.commitment_snapshot(c.id, 'VOID'); end if;
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'commitment.voided', 'commitments', c.id,
    format('%s voided', c.number), jsonb_build_object('reason', p_reason, 'event_id', v_event));
  return v_event;
end $$;

-- Manual payment hold (Books payment runs honour JOB_COMMITMENT payment_hold like ON_HOLD).
create or replace function pm.set_commitment_hold(p_commitment uuid, p_hold boolean, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_event uuid;
begin
  select * into c from pm.commitments x where x.id = p_commitment for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  if c.status in ('VOID') then raise exception 'PM_COMMITMENT_VOID: %', c.number using errcode = '22023'; end if;
  if p_hold and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'PM_HOLD_REASON: a payment hold needs a reason' using errcode = '22023';
  end if;
  update pm.commitments set payment_hold = coalesce(p_hold, false), hold_reason = case when p_hold then p_reason end where id = c.id;
  if c.status in ('APPROVED','EXECUTED','CLOSED') then v_event := pm.commitment_snapshot(c.id, 'HOLD'); end if;
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, case when p_hold then 'commitment.hold_set' else 'commitment.hold_released' end,
    'commitments', c.id, format('%s payment hold %s', c.number, case when p_hold then 'set' else 'released' end),
    jsonb_build_object('reason', p_reason, 'event_id', v_event));
  return v_event;
end $$;

-- Goods/work receipt against a commitment line; updates received qty/value and re-emits so
-- Books' match target carries received_to_date (GRNI input).
create or replace function pm.record_receipt(
  p_commitment_line uuid,
  p_qty             numeric,
  p_received_on     date    default null,
  p_memo            text    default null,
  p_document        uuid    default null,
  p_amount_cents    bigint  default null,
  p_packing_slip    text    default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.commitment_lines%rowtype; c pm.commitments%rowtype; v_amt bigint; v_id uuid; v_over boolean; v_event uuid;
begin
  select * into l from pm.commitment_lines x where x.id = p_commitment_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment line % not found in the caller''s organization', p_commitment_line using errcode = '42501';
  end if;
  select * into c from pm.commitments x where x.org_id = l.org_id and x.id = l.commitment_id for update;
  if c.status not in ('APPROVED','EXECUTED') then
    raise exception 'PM_RECEIPT_COMMITMENT_STATE: % is %', c.number, c.status using errcode = '22023';
  end if;
  if p_qty is not null and p_qty <= 0 then raise exception 'PM_INVALID: receipt qty must be > 0' using errcode = '22023'; end if;
  v_amt := coalesce(p_amount_cents, case when p_qty is not null and l.unit_cost_cents is not null then round(p_qty * l.unit_cost_cents)::bigint end);
  if v_amt is null or v_amt <= 0 then
    raise exception 'PM_RECEIPT_AMOUNT: give an amount (line has no unit cost) and it must be > 0' using errcode = '22023';
  end if;
  if p_document is not null and not exists (select 1 from public.documents d where d.id = p_document and d.org_id = l.org_id) then
    raise exception 'PM_DOCUMENT_ORG_MISMATCH: %', p_document using errcode = '23503';
  end if;
  v_over := (l.qty is not null and l.received_qty + coalesce(p_qty, 0) > l.qty) or (l.received_cents + v_amt > l.amount_cents);
  insert into pm.receipts (org_id, job_id, commitment_id, commitment_line_id, qty, amount_cents, received_on, over_receipt,
                           packing_slip, memo, document_id, created_by)
  values (l.org_id, c.job_id, c.id, l.id, p_qty, v_amt, coalesce(p_received_on, current_date), v_over,
          p_packing_slip, p_memo, p_document, pm.current_user_id())
  returning id into v_id;
  update pm.commitment_lines set received_qty = received_qty + coalesce(p_qty, 0), received_cents = received_cents + v_amt
   where org_id = l.org_id and id = l.id;
  v_event := pm.commitment_snapshot(c.id, 'RECEIPT');
  update pm.receipts set event_id = v_event where id = v_id;
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'commitment.received', 'receipts', v_id,
    format('Received %s cents on %s', v_amt, c.number),
    jsonb_build_object('qty', p_qty, 'amount_cents', v_amt, 'over_receipt', v_over, 'event_id', v_event));
  return v_id;
end $$;

-- Mark a compliance doc VERIFIED (verified_by = caller); re-emits the commitment when its
-- effective payment hold flips.
create or replace function pm.verify_compliance_doc(p_doc uuid, p_expires_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.compliance_docs%rowtype; v_me text := pm.current_user_id(); c pm.commitments%rowtype; v_event uuid; v_loc uuid;
begin
  select * into d from pm.compliance_docs x where x.id = p_doc for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: compliance doc % not found in the caller''s organization', p_doc using errcode = '42501';
  end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: verification requires an identified user' using errcode = '42501'; end if;
  update pm.compliance_docs set status = 'VERIFIED', verified_by = v_me, verified_at = now(),
         expires_on = coalesce(p_expires_on, expires_on)
   where id = d.id;
  if d.commitment_id is not null then
    select * into c from pm.commitments x where x.org_id = d.org_id and x.id = d.commitment_id for update;
    if c.status in ('APPROVED','EXECUTED')
       and (c.payment_hold or not pm.commitment_payment_eligible(c.id)) is distinct from c.last_emitted_hold then
      v_event := pm.commitment_snapshot(c.id, 'COMPLIANCE');
    end if;
  end if;
  select j.location_id into v_loc from core.jobs j where j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'compliance.verified', 'compliance_docs', d.id,
    format('%s verified', d.doc_type), jsonb_build_object('commitment_id', d.commitment_id, 'event_id', v_event));
  return d.id;
end $$;

-- Service: re-emit commitments whose effective hold changed without a write (a COI expiring
-- overnight). Run from the scheduler. p_org null = every org.
create or replace function pm.sync_commitment_holds(p_org uuid default null)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r record; n int := 0;
begin
  for r in select c.id from pm.commitments c
           where (p_org is null or c.org_id = p_org) and c.status in ('APPROVED','EXECUTED')
             and (c.payment_hold or not pm.commitment_payment_eligible(c.id)) is distinct from c.last_emitted_hold
           for update skip locked loop
    perform pm.commitment_snapshot(r.id, 'COMPLIANCE');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- 11. SOV versions
-- ----------------------------------------------------------------------------
create or replace function pm.activate_sov_version(p_version uuid, p_force boolean default false)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v pm.sov_versions%rowtype; v_total bigint; v_contract bigint; v_bad text; v_old uuid; v_loc uuid;
begin
  select * into v from pm.sov_versions x where x.id = p_version for update;
  if v.org_id is null or v.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: SOV version % not found in the caller''s organization', p_version using errcode = '42501';
  end if;
  if v.status <> 'DRAFT' then raise exception 'PM_SOV_NOT_DRAFT: version % is %', v.version, v.status using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.sov:' || v.job_id::text, 0));
  select coalesce(sum(l.scheduled_value_cents), 0) into v_total from pm.sov_lines l where l.org_id = v.org_id and l.sov_version_id = v.id;
  if v_total <= 0 then raise exception 'PM_SOV_EMPTY: SOV version % has no scheduled value', v.version using errcode = '22023'; end if;
  select m.revised_contract_cents into v_contract from pm.v_job_money m where m.org_id = v.org_id and m.job_id = v.job_id;
  if v_total is distinct from coalesce(v_contract, 0) and not coalesce(p_force, false) then
    raise exception 'PM_SOV_CONTRACT_MISMATCH: SOV total % ≠ revised contract %; pass p_force to activate anyway', v_total, coalesce(v_contract, 0)
      using errcode = '22023';
  end if;
  if exists (select 1 from pm.billing_requests r where r.org_id = v.org_id and r.job_id = v.job_id and r.billing_subtype = 'SOV' and r.status = 'DRAFT') then
    raise exception 'PM_SOV_DRAFT_APPLICATION: approve or void the DRAFT pay application first' using errcode = '22023';
  end if;
  -- billed lineages must survive, at a scheduled value ≥ what has been billed on them
  select string_agg(format('%s (billed %s)', b.lineage, b.billed), ', ') into v_bad
  from (select bl.sov_lineage_id as lineage,
               sum(bl.this_period_work_cents) + coalesce((array_agg(bl.stored_materials_cents order by r.application_no desc))[1], 0) as billed
        from pm.billing_request_lines bl
        join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
        where bl.org_id = v.org_id and r.job_id = v.job_id and bl.sov_lineage_id is not null and bl.line_type = 'STANDARD'
          and r.status in ('EMITTED','ISSUED','UNISSUED','REJECTED')
        group by bl.sov_lineage_id) b
  left join pm.sov_lines l on l.org_id = v.org_id and l.sov_version_id = v.id and l.lineage_id = b.lineage
  where l.id is null or l.scheduled_value_cents < b.billed;
  if v_bad is not null then
    raise exception 'PM_SOV_BELOW_BILLED: billed SOV lines missing or scheduled below billed: %', v_bad using errcode = '22023';
  end if;
  update pm.sov_versions set status = 'SUPERSEDED' where org_id = v.org_id and job_id = v.job_id and status = 'ACTIVE' returning id into v_old;
  update pm.sov_versions set status = 'ACTIVE', activated_at = now(), activated_by = pm.current_user_id() where id = v.id;
  select j.location_id into v_loc from core.jobs j where j.id = v.job_id;
  perform pm.log_activity(v.org_id, v_loc, v.job_id, 'sov.activated', 'sov_versions', v.id,
    format('SOV v%s activated (%s cents)', v.version, v_total),
    jsonb_build_object('total_cents', v_total, 'contract_cents', v_contract, 'superseded', v_old, 'forced', coalesce(p_force, false) and v_total is distinct from v_contract));
  return v.id;
end $$;

-- New DRAFT version copying lines (same lineage) — add CO lines, then activate.
create or replace function pm.revise_sov(p_version uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v pm.sov_versions%rowtype; v_new uuid := gen_random_uuid(); v_ver int; v_loc uuid;
begin
  select * into v from pm.sov_versions x where x.id = p_version;
  if v.org_id is null or v.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: SOV version % not found in the caller''s organization', p_version using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.sov:' || v.job_id::text, 0));
  if exists (select 1 from pm.sov_versions x where x.org_id = v.org_id and x.job_id = v.job_id and x.status = 'DRAFT') then
    raise exception 'PM_SOV_DRAFT_EXISTS: the job already has a DRAFT SOV version' using errcode = '22023';
  end if;
  select max(x.version) + 1 into v_ver from pm.sov_versions x where x.org_id = v.org_id and x.job_id = v.job_id;
  insert into pm.sov_versions (id, org_id, job_id, contract_id, version, status, retainage_pct, memo, created_by)
  values (v_new, v.org_id, v.job_id, v.contract_id, v_ver, 'DRAFT', v.retainage_pct, v.memo, pm.current_user_id());
  insert into pm.sov_lines (org_id, sov_version_id, lineage_id, line_no, cost_code_id, description, scheduled_value_cents,
                            retainage_pct, change_order_id, sort)
  select l.org_id, v_new, l.lineage_id, l.line_no, l.cost_code_id, l.description, l.scheduled_value_cents,
         l.retainage_pct, l.change_order_id, l.sort
  from pm.sov_lines l where l.org_id = v.org_id and l.sov_version_id = v.id;
  select j.location_id into v_loc from core.jobs j where j.id = v.job_id;
  perform pm.log_activity(v.org_id, v_loc, v.job_id, 'sov.revised', 'sov_versions', v_new,
    format('SOV v%s drafted from v%s', v_ver, v.version), jsonb_build_object('from_version', v.version));
  return v_new;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Billing generators. All produce DRAFT requests (created_by = caller, so the
--     approver of approve_and_emit_billing must be someone else).
--   "Counted" requests for billed-to-date math = EMITTED | ISSUED | UNISSUED | REJECTED
--   (a REJECTED request is waiting to be re-emitted; void it to free its amounts).
-- ----------------------------------------------------------------------------

-- Apply the contract retention cap, then write the single RETAINAGE line (negative).
create or replace function pm.finalize_billing_retainage(p_request uuid)
returns bigint
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.billing_requests%rowtype; v_cap bigint; v_out bigint; v_sum bigint; v_cut bigint; l record; d bigint; v_rate numeric;
begin
  select * into r from pm.billing_requests x where x.id = p_request;
  select k.retention_cap_cents into v_cap from pm.contracts k where k.org_id = r.org_id and k.id = r.contract_id;
  select coalesce(sum(x.retainage_this_period_cents), 0) into v_sum
  from pm.billing_request_lines x where x.org_id = r.org_id and x.billing_request_id = r.id and x.line_type = 'STANDARD';
  if v_cap is not null and v_sum > 0 then
    select coalesce(sum(case g.entry_type when 'HELD' then g.amount_cents else -g.amount_cents end), 0) into v_out
    from pm.retainage_ledger g join pm.billing_requests b on b.org_id = g.org_id and b.id = g.billing_request_id
    where g.org_id = r.org_id and g.job_id = r.job_id and b.status in ('EMITTED','ISSUED','UNISSUED','REJECTED');
    v_cut := v_sum - greatest(v_cap - v_out, 0);
    if v_cut > 0 then
      for l in select x.id, x.retainage_this_period_cents as ret from pm.billing_request_lines x
               where x.org_id = r.org_id and x.billing_request_id = r.id and x.line_type = 'STANDARD' and x.retainage_this_period_cents > 0
               order by x.sort desc, x.line_no desc loop
        exit when v_cut <= 0;
        d := least(l.ret, v_cut);
        update pm.billing_request_lines set retainage_this_period_cents = retainage_this_period_cents - d where id = l.id;
        v_cut := v_cut - d;
      end loop;
      select coalesce(sum(x.retainage_this_period_cents), 0) into v_sum
      from pm.billing_request_lines x where x.org_id = r.org_id and x.billing_request_id = r.id and x.line_type = 'STANDARD';
    end if;
  end if;
  delete from pm.billing_request_lines x where x.org_id = r.org_id and x.billing_request_id = r.id and x.line_type = 'RETAINAGE';
  if v_sum <> 0 then
    select case when count(distinct x.retainage_rate) = 1 then max(x.retainage_rate) end into v_rate
    from pm.billing_request_lines x where x.org_id = r.org_id and x.billing_request_id = r.id and x.line_type = 'STANDARD' and x.retainage_rate is not null;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents)
    values (r.org_id, r.id, 9999, 1000000, 'RETAINAGE',
            case when v_sum > 0 then 'Retainage withheld' else 'Retainage adjustment' end
              || case when v_rate is not null then format(' (%s%%)', rtrim(to_char(v_rate * 100, 'FM990.99'), '.')) else '' end,
            -v_sum);
  end if;
  return v_sum;
end $$;

-- AIA G702/G703 pay application from the ACTIVE schedule of values.
--   p_lines: [{sov_line_id, pct_complete? | work_to_date_cents? | this_period_cents?, stored_materials_cents?}]
--   Per line (C scheduled, D previous work, E this period work, F stored now, F' stored before):
--     E from pct: round(C × pct) − D   (pct = work completed to date, excluding stored)
--     F defaults to F' (stored carries forward until installed)
--     G = D + E + F ≤ C;  H = C − G;  billed this period = E + F − F'
--     retainage to date = round(rate × (D+E)) + round(rate × F)   (5a work + 5b stored, contract rate
--     unless the SOV line / version overrides); retainage this period = to date − previously held
--   Lines omitted from p_lines carry forward (E = 0). The request nets to the current payment due.
create or replace function pm.generate_sov_billing(
  p_job          uuid,
  p_sov_version  uuid,
  p_period_end   date,
  p_lines        jsonb default '[]'
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org      uuid;
  v          pm.sov_versions%rowtype;
  v_contract uuid;
  v_k        pm.contracts%rowtype;
  v_req      uuid := gen_random_uuid();
  v_app      int;
  v_bad      text;
  l          record;
  inp        jsonb;
  c_         bigint; d_ bigint; e_ bigint; f_ bigint; fp bigint; g_ bigint; retp bigint;
  v_rate     numeric;
  rw bigint; rs bigint;
  v_gross    bigint;
  v_sort     int := 0;
begin
  select j.org_id into v_org from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_period_end is null then raise exception 'PM_INVALID: period_end is required' using errcode = '22023'; end if;
  select * into v from pm.sov_versions x where x.org_id = v_org and x.id = p_sov_version and x.job_id = p_job;
  if not found then raise exception 'PM_UNKNOWN_SOV: version % is not on job %', p_sov_version, p_job using errcode = 'P0002'; end if;
  if v.status <> 'ACTIVE' then raise exception 'PRECONDITION_SOV_NOT_ACTIVE: SOV v% is %', v.version, v.status using errcode = 'P0001'; end if;
  v_contract := coalesce(v.contract_id, pm.primary_contract_id(v_org, p_job));
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract', p_job using errcode = 'P0001'; end if;
  select * into v_k from pm.contracts k where k.org_id = v_org and k.id = v_contract;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: p_lines must be an array' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));
  if exists (select 1 from pm.billing_requests r where r.org_id = v_org and r.job_id = p_job and r.billing_subtype = 'SOV' and r.status = 'DRAFT') then
    raise exception 'PM_DRAFT_PAY_APP_EXISTS: approve or void the DRAFT pay application on this job first' using errcode = '22023';
  end if;
  select string_agg(coalesce(x ->> 'sov_line_id', '(missing)'), ', ') into v_bad
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
  where not exists (select 1 from pm.sov_lines s where s.org_id = v_org and s.sov_version_id = v.id
                      and s.id::text = x ->> 'sov_line_id');
  if v_bad is not null then raise exception 'PM_SOV_UNKNOWN_LINE: %', v_bad using errcode = '22023'; end if;
  select string_agg(k, ', ') into v_bad from (
    select x ->> 'sov_line_id' k from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x group by 1 having count(*) > 1) d;
  if v_bad is not null then raise exception 'PM_SOV_DUPLICATE_LINE: %', v_bad using errcode = '22023'; end if;

  select coalesce(max(r.application_no), 0) + 1 into v_app
  from pm.billing_requests r where r.org_id = v_org and r.job_id = p_job and r.billing_subtype = 'SOV' and r.status <> 'VOID';

  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, billing_subtype, status, generated_by,
                                   application_no, sov_version_id, period_end, occurred_on, memo, created_by)
  values (v_req, v_org, p_job, v_contract, 'PROGRESS', 'SOV', 'DRAFT', 'sov', v_app, v.id, p_period_end, p_period_end,
          format('Application #%s for the period ending %s', v_app, to_char(p_period_end, 'YYYY-MM-DD')), pm.current_user_id());

  for l in select s.* from pm.sov_lines s where s.org_id = v_org and s.sov_version_id = v.id order by s.sort, s.line_no loop
    inp := null;
    select x into inp from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x where x ->> 'sov_line_id' = l.id::text;
    c_ := l.scheduled_value_cents;
    select coalesce(sum(bl.this_period_work_cents), 0), coalesce(sum(bl.retainage_this_period_cents), 0)
      into d_, retp
    from pm.billing_request_lines bl join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
    where bl.org_id = v_org and r.job_id = p_job and bl.sov_lineage_id = l.lineage_id and bl.line_type = 'STANDARD'
      and r.status in ('EMITTED','ISSUED','UNISSUED','REJECTED');
    select coalesce((select bl.stored_materials_cents
                     from pm.billing_request_lines bl join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
                     where bl.org_id = v_org and r.job_id = p_job and bl.sov_lineage_id = l.lineage_id and bl.line_type = 'STANDARD'
                       and r.status in ('EMITTED','ISSUED','UNISSUED','REJECTED')
                     order by r.application_no desc nulls last, r.created_at desc limit 1), 0)
      into fp;
    if inp is null then
      e_ := 0;
    elsif inp ? 'pct_complete' then
      if (inp ->> 'pct_complete')::numeric < 0 or (inp ->> 'pct_complete')::numeric > 1 then
        raise exception 'PM_SOV_PCT: line % pct_complete must be 0..1', l.line_no using errcode = '22023';
      end if;
      e_ := round(c_ * (inp ->> 'pct_complete')::numeric)::bigint - d_;
    elsif inp ? 'work_to_date_cents' then
      e_ := (inp ->> 'work_to_date_cents')::bigint - d_;
    else
      e_ := coalesce((inp ->> 'this_period_cents')::bigint, 0);
    end if;
    f_ := coalesce((inp ->> 'stored_materials_cents')::bigint, fp);
    if d_ + e_ < 0 or f_ < 0 then raise exception 'PM_SOV_NEGATIVE: line % would go below zero', l.line_no using errcode = '22023'; end if;
    g_ := d_ + e_ + f_;
    if g_ > c_ then
      raise exception 'PM_SOV_OVER_SCHEDULED: line % completed+stored % exceeds scheduled value %', l.line_no, g_, c_ using errcode = '22023';
    end if;
    v_rate := coalesce(l.retainage_pct, v.retainage_pct, v_k.retention_pct, 0);
    rw := round((d_ + e_) * v_rate)::bigint;
    rs := round(f_ * v_rate)::bigint;
    insert into pm.billing_request_lines
      (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, cost_code_id, sov_line_id, sov_lineage_id,
       scheduled_value_cents, previous_work_cents, this_period_work_cents, stored_materials_cents, previous_stored_cents,
       total_completed_cents, pct_complete, balance_to_finish_cents, retainage_rate,
       retainage_work_to_date_cents, retainage_stored_to_date_cents, retainage_this_period_cents)
    values
      (v_org, v_req, l.line_no, v_sort, 'STANDARD', l.description, e_ + f_ - fp, l.cost_code_id, l.id, l.lineage_id,
       c_, d_, e_, f_, fp, g_, case when c_ > 0 then round(g_::numeric / c_, 6) end, c_ - g_, v_rate,
       rw, rs, rw + rs - retp);
    v_sort := v_sort + 1;
  end loop;

  select r.gross_earned_cents into v_gross from pm.billing_requests r where r.id = v_req;
  if coalesce(v_gross, 0) <= 0 then
    raise exception 'PRECONDITION_NOTHING_TO_BILL: no work or stored materials to bill on job % this period', p_job using errcode = 'P0001';
  end if;
  perform pm.finalize_billing_retainage(v_req);
  perform pm.log_activity(v_org, (select location_id from core.jobs where id = p_job), p_job, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted pay application #%s', v_app), jsonb_build_object('mode', 'SOV', 'application_no', v_app, 'gross_cents', v_gross));
  return v_req;
end $$;

-- Progress %: earned to date = revised contract × pct; this bill = earned − billed to date.
-- pct defaults to the ACTIVE contracts' physical pct_complete (pm.set_progress).
create or replace function pm.generate_progress_billing(p_job uuid, p_as_of date default null, p_pct numeric default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid; v_loc uuid; v_contract uuid; v_k pm.contracts%rowtype; m pm.v_job_money%rowtype;
  v_pct numeric; v_earned bigint; v_billed bigint; v_this bigint; v_rate numeric; v_held bigint;
  v_req uuid := gen_random_uuid(); v_asof date := coalesce(p_as_of, current_date);
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  v_contract := pm.primary_contract_id(v_org, p_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract', p_job using errcode = 'P0001'; end if;
  select * into v_k from pm.contracts k where k.org_id = v_org and k.id = v_contract;
  v_pct := coalesce(p_pct,
    (select case when sum(k.original_cents) filter (where k.pct_complete is not null) > 0
                 then sum(k.original_cents * k.pct_complete) filter (where k.pct_complete is not null)
                      / sum(k.original_cents) filter (where k.pct_complete is not null)
                 else max(k.pct_complete) end
     from pm.contracts k where k.org_id = v_org and k.job_id = p_job and k.status = 'ACTIVE'));
  if v_pct is null then raise exception 'PM_NO_PROGRESS_PCT: pass p_pct or set progress first' using errcode = '22023'; end if;
  if v_pct < 0 or v_pct > 1 then raise exception 'PM_INVALID: pct must be 0..1' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));
  if exists (select 1 from pm.billing_requests r where r.org_id = v_org and r.job_id = p_job and r.generated_by = 'progress' and r.status = 'DRAFT') then
    raise exception 'PM_DRAFT_EXISTS: approve or void the DRAFT progress billing first' using errcode = '22023';
  end if;
  select * into m from pm.v_job_money x where x.org_id = v_org and x.job_id = p_job;
  v_earned := round(m.revised_contract_cents * v_pct)::bigint;
  select coalesce(sum(r.gross_earned_cents), 0) into v_billed from pm.billing_requests r
  where r.org_id = v_org and r.job_id = p_job and r.status in ('EMITTED','ISSUED','UNISSUED','REJECTED')
    and r.billing_subtype is distinct from 'RETAINAGE_RELEASE';
  v_this := v_earned - v_billed;
  if v_this <= 0 then
    raise exception 'PRECONDITION_NOTHING_TO_BILL: earned % ≤ billed to date %', v_earned, v_billed using errcode = 'P0001';
  end if;
  v_rate := coalesce(v_k.retention_pct, 0);
  select coalesce(sum(bl.retainage_this_period_cents), 0) into v_held
  from pm.billing_request_lines bl join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
  where bl.org_id = v_org and r.job_id = p_job and bl.line_type = 'STANDARD' and r.status in ('EMITTED','ISSUED','UNISSUED','REJECTED');

  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, period_end, occurred_on, memo, created_by)
  values (v_req, v_org, p_job, v_contract, 'PROGRESS', 'DRAFT', 'progress', v_asof, v_asof,
          format('Progress billing through %s (%s%% complete)', to_char(v_asof, 'YYYY-MM-DD'), trim(to_char(v_pct * 100, 'FM990.0'))),
          pm.current_user_id());
  insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents,
                                        scheduled_value_cents, previous_work_cents, this_period_work_cents, total_completed_cents,
                                        pct_complete, balance_to_finish_cents, retainage_rate, retainage_work_to_date_cents,
                                        retainage_this_period_cents)
  values (v_org, v_req, 1, 0, 'STANDARD',
          format('Progress to %s%% of contract', trim(to_char(v_pct * 100, 'FM990.0'))), v_this,
          m.revised_contract_cents, v_billed, v_this, v_earned, round(v_pct, 6), m.revised_contract_cents - v_earned, v_rate,
          round(v_earned * v_rate)::bigint, round(v_earned * v_rate)::bigint - v_held);
  perform pm.finalize_billing_retainage(v_req);
  perform pm.log_activity(v_org, v_loc, p_job, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted progress billing (%s cents)', v_this), jsonb_build_object('mode', 'PROGRESS', 'pct', v_pct, 'earned', v_earned, 'billed_before', v_billed));
  return v_req;
end $$;

-- Milestones: completed milestone tasks (is_milestone, DONE) and/or MILESTONE WBS nodes
-- (pct_complete = 1), each billed once, valued at billing_amount_cents or billing_pct × contract.
create or replace function pm.generate_milestone_billing(p_job uuid, p_ids uuid[], p_occurred_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid; v_loc uuid; v_contract uuid; v_k pm.contracts%rowtype; m pm.v_job_money%rowtype;
  v_req uuid := gen_random_uuid(); x uuid; t pm.tasks%rowtype; w pm.wbs_nodes%rowtype; v_amt bigint; v_rate numeric;
  v_sort int := 0; v_desc text; v_task uuid; v_wbs uuid;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then raise exception 'PM_INVALID: pass at least one milestone id' using errcode = '22023'; end if;
  v_contract := pm.primary_contract_id(v_org, p_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract', p_job using errcode = 'P0001'; end if;
  select * into v_k from pm.contracts k where k.org_id = v_org and k.id = v_contract;
  select * into m from pm.v_job_money y where y.org_id = v_org and y.job_id = p_job;
  v_rate := coalesce(v_k.retention_pct, 0);
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));

  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, occurred_on, memo, created_by)
  values (v_req, v_org, p_job, v_contract, 'MILESTONE', 'DRAFT', 'milestone', coalesce(p_occurred_on, current_date),
          'Milestone billing', pm.current_user_id());

  foreach x in array p_ids loop
    v_task := null; v_wbs := null;
    select * into t from pm.tasks y where y.org_id = v_org and y.id = x and y.job_id = p_job;
    if found then
      if not t.is_milestone then raise exception 'PM_NOT_A_MILESTONE: task % is not a milestone', t.title using errcode = '22023'; end if;
      if t.status <> 'DONE' then raise exception 'PM_MILESTONE_NOT_COMPLETE: % is %', t.title, t.status using errcode = '22023'; end if;
      v_amt := coalesce(t.billing_amount_cents, round(m.revised_contract_cents * t.billing_pct)::bigint);
      v_desc := t.title; v_task := t.id;
    else
      select * into w from pm.wbs_nodes y where y.org_id = v_org and y.id = x and y.job_id = p_job;
      if not found then raise exception 'PM_UNKNOWN_MILESTONE: % is not a task or WBS node on this job', x using errcode = 'P0002'; end if;
      if w.kind <> 'MILESTONE' then raise exception 'PM_NOT_A_MILESTONE: WBS % is %', w.name, w.kind using errcode = '22023'; end if;
      if coalesce(w.pct_complete, 0) < 1 then raise exception 'PM_MILESTONE_NOT_COMPLETE: % is % complete', w.name, coalesce(w.pct_complete, 0) using errcode = '22023'; end if;
      v_amt := coalesce(w.billing_amount_cents, round(m.revised_contract_cents * w.billing_pct)::bigint);
      v_desc := w.name; v_wbs := w.id;
    end if;
    if v_amt is null or v_amt <= 0 then raise exception 'PM_MILESTONE_NO_AMOUNT: % has no billing amount or pct', v_desc using errcode = '22023'; end if;
    if exists (select 1 from pm.billing_request_lines bl join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
               where bl.org_id = v_org and r.status <> 'VOID' and r.id <> v_req
                 and ((v_task is not null and bl.task_id = v_task) or (v_wbs is not null and bl.wbs_id = v_wbs))) then
      raise exception 'PM_MILESTONE_ALREADY_BILLED: %', v_desc using errcode = '22023';
    end if;
    if exists (select 1 from pm.billing_request_lines bl where bl.org_id = v_org and bl.billing_request_id = v_req
                 and ((v_task is not null and bl.task_id = v_task) or (v_wbs is not null and bl.wbs_id = v_wbs))) then
      raise exception 'PM_MILESTONE_DUPLICATE: % listed twice', v_desc using errcode = '22023';
    end if;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, task_id, wbs_id,
                                          this_period_work_cents, retainage_rate, retainage_this_period_cents)
    values (v_org, v_req, v_sort + 1, v_sort, 'STANDARD', v_desc, v_amt, v_task, v_wbs, v_amt, v_rate, round(v_amt * v_rate)::bigint);
    v_sort := v_sort + 1;
  end loop;
  perform pm.finalize_billing_retainage(v_req);
  perform pm.log_activity(v_org, v_loc, p_job, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted milestone billing (%s milestones)', v_sort), jsonb_build_object('mode', 'MILESTONE', 'ids', to_jsonb(p_ids)));
  return v_req;
end $$;

-- Time & materials: APPROVED billable time with a pinned bill rate, not yet billed
-- (pm.billing_links PK = billed once). Grouped by cost code / pay type / rate.
-- Billable job costs (cost-plus) join this generator once the 1103 projection carries markup rules.
create or replace function pm.generate_tm_billing(p_job uuid, p_from date, p_to date, p_occurred_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid; v_loc uuid; v_contract uuid; v_rate numeric := 0; v_req uuid := gen_random_uuid();
  g record; v_line uuid; v_sort int := 0; v_n int;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'PM_INVALID: from/to dates' using errcode = '22023'; end if;
  v_contract := pm.primary_contract_id(v_org, p_job);
  if v_contract is not null then
    select coalesce(k.retention_pct, 0) into v_rate from pm.contracts k where k.org_id = v_org and k.id = v_contract;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));
  select count(*) into v_n from (
    select te.id from pm.time_entries te
    where te.org_id = v_org and te.job_id = p_job and te.approval_state = 'APPROVED' and te.billable
      and te.bill_rate_cents is not null and te.work_date between p_from and p_to
      and not exists (select 1 from pm.billing_links bk where bk.org_id = te.org_id and bk.source_table = 'time_entries' and bk.source_id = te.id)
    for update of te) s;
  if v_n = 0 then raise exception 'PRECONDITION_NOTHING_TO_BILL: no approved unbilled billable time between % and %', p_from, p_to using errcode = 'P0001'; end if;

  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, period_start, period_end,
                                   occurred_on, memo, created_by)
  values (v_req, v_org, p_job, v_contract, 'TIME_MATERIALS', 'DRAFT', 'tm', p_from, p_to, coalesce(p_occurred_on, p_to),
          format('Time & materials %s – %s', to_char(p_from, 'YYYY-MM-DD'), to_char(p_to, 'YYYY-MM-DD')), pm.current_user_id());

  for g in
    select te.cost_code_id, te.pay_type, te.bill_rate_cents, sum(te.hours) as hours,
           sum(round(te.hours * te.bill_rate_cents)::bigint) as amount, array_agg(te.id order by te.work_date, te.id) as ids,
           max(cc.code) as code, max(cc.name) as cc_name
    from pm.time_entries te
    left join pm.cost_codes cc on cc.org_id = te.org_id and cc.id = te.cost_code_id
    where te.org_id = v_org and te.job_id = p_job and te.approval_state = 'APPROVED' and te.billable
      and te.bill_rate_cents is not null and te.work_date between p_from and p_to
      and not exists (select 1 from pm.billing_links bk where bk.org_id = te.org_id and bk.source_table = 'time_entries' and bk.source_id = te.id)
    group by te.cost_code_id, te.pay_type, te.bill_rate_cents
    order by max(cc.code) nulls last, te.pay_type, te.bill_rate_cents
  loop
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, cost_code_id,
                                          this_period_work_cents, retainage_rate, retainage_this_period_cents)
    values (v_org, v_req, v_sort + 1, v_sort, 'STANDARD',
            format('Labor%s — %s h %s @ %s', coalesce(' ' || g.code || ' ' || g.cc_name, ''), trim(to_char(g.hours, 'FM999990.00')),
                   g.pay_type, trim(to_char(g.bill_rate_cents / 100.0, 'FM9999990.00'))),
            g.amount, g.cost_code_id, g.amount, v_rate, round(g.amount * v_rate)::bigint)
    returning id into v_line;
    insert into pm.billing_links (org_id, source_table, source_id, job_id, billing_request_id, billing_request_line_id, amount_cents)
    select v_org, 'time_entries', te.id, p_job, v_req, v_line, round(te.hours * te.bill_rate_cents)::bigint
    from pm.time_entries te where te.org_id = v_org and te.id = any (g.ids);
    v_sort := v_sort + 1;
  end loop;
  perform pm.finalize_billing_retainage(v_req);
  perform pm.log_activity(v_org, v_loc, p_job, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted T&M billing (%s time entries)', v_n), jsonb_build_object('mode', 'TIME_MATERIALS', 'from', p_from, 'to', p_to, 'entries', v_n));
  return v_req;
end $$;

-- Retainage release (closeout or partial). Amount defaults to all outstanding retainage that
-- reached Books. One release in flight at a time.
create or replace function pm.request_retainage_release(p_job uuid, p_amount_cents bigint default null, p_occurred_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v_out bigint; v_amt bigint; v_req uuid := gen_random_uuid(); v_contract uuid;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));
  if exists (select 1 from pm.billing_requests r where r.org_id = v_org and r.job_id = p_job
               and r.billing_subtype = 'RETAINAGE_RELEASE' and r.status in ('DRAFT','REJECTED')) then
    raise exception 'PM_RELEASE_IN_FLIGHT: a DRAFT or REJECTED retainage release exists; approve or void it first' using errcode = '22023';
  end if;
  select coalesce(v.outstanding_cents, 0) into v_out from pm.v_job_retainage v where v.org_id = v_org and v.job_id = p_job;
  v_out := coalesce(v_out, 0);
  if v_out <= 0 then raise exception 'PRECONDITION_NO_RETAINAGE: job % has no outstanding retainage', p_job using errcode = 'P0001'; end if;
  v_amt := coalesce(p_amount_cents, v_out);
  if v_amt <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: release must be > 0' using errcode = 'P0001'; end if;
  if v_amt > v_out then
    raise exception 'PRECONDITION_RETAINAGE_EXCEEDS_HELD: release % exceeds outstanding retainage %', v_amt, v_out using errcode = 'P0001';
  end if;
  v_contract := pm.primary_contract_id(v_org, p_job);
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, billing_subtype, status, generated_by, occurred_on, memo, created_by)
  values (v_req, v_org, p_job, v_contract, 'PROGRESS', 'RETAINAGE_RELEASE', 'DRAFT', 'retainage_release', coalesce(p_occurred_on, current_date),
          case when v_amt = v_out then 'Release of retainage (final)' else 'Partial release of retainage' end, pm.current_user_id());
  insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents)
  values (v_org, v_req, 1, 0, 'RETAINAGE_RELEASE', 'Retainage release', v_amt);
  perform pm.log_activity(v_org, v_loc, p_job, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted retainage release (%s cents)', v_amt), jsonb_build_object('mode', 'RETAINAGE_RELEASE', 'outstanding', v_out));
  return v_req;
end $$;

-- Allowance reconciliation: record actual, close, and raise a PCO for the variance (the
-- contract moves only by change order, so recognition sees the new contract value).
create or replace function pm.close_allowance(p_allowance uuid, p_actual_cents bigint)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.allowances%rowtype; v_co uuid; v_var bigint; v_loc uuid;
begin
  select * into a from pm.allowances x where x.id = p_allowance for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: allowance % not found in the caller''s organization', p_allowance using errcode = '42501';
  end if;
  if a.status <> 'OPEN' then raise exception 'PM_ALLOWANCE_CLOSED: %', a.description using errcode = '22023'; end if;
  if p_actual_cents is null or p_actual_cents < 0 then raise exception 'PM_INVALID: actual must be ≥ 0' using errcode = '22023'; end if;
  v_var := p_actual_cents - a.allowance_cents;
  if v_var <> 0 then
    insert into pm.change_orders (org_id, job_id, title, description, reason, stage, amount_cents, cost_impact_cents, created_by)
    values (a.org_id, a.job_id, left('Allowance reconciliation: ' || a.description, 200),
            format('Allowance %s cents, actual %s cents', a.allowance_cents, p_actual_cents), 'ALLOWANCE', 'PCO', v_var, v_var,
            pm.current_user_id())
    returning id into v_co;
  end if;
  update pm.allowances set actual_cents = p_actual_cents, status = 'CLOSED', closed_at = now(), variance_co_id = v_co where id = a.id;
  select j.location_id into v_loc from core.jobs j where j.id = a.job_id;
  perform pm.log_activity(a.org_id, v_loc, a.job_id, 'allowance.closed', 'allowances', a.id,
    format('Allowance %s closed (variance %s cents)', a.description, v_var), jsonb_build_object('variance_cents', v_var, 'change_order_id', v_co));
  return v_co;
end $$;

-- Bill an allowance overage once its variance CO is APPROVED (subtype ALLOWANCE).
create or replace function pm.bill_allowance_overage(p_allowance uuid, p_occurred_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.allowances%rowtype; v_var bigint; v_req uuid := gen_random_uuid(); v_contract uuid; v_rate numeric; v_loc uuid;
begin
  select * into a from pm.allowances x where x.id = p_allowance for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: allowance % not found in the caller''s organization', p_allowance using errcode = '42501';
  end if;
  v_var := coalesce(a.actual_cents, 0) - a.allowance_cents;
  if a.status <> 'CLOSED' or v_var <= 0 then raise exception 'PM_ALLOWANCE_NO_OVERAGE: close the allowance with an overage first' using errcode = '22023'; end if;
  if not exists (select 1 from pm.change_orders c where c.org_id = a.org_id and c.id = a.variance_co_id and c.stage = 'APPROVED') then
    raise exception 'PRECONDITION_ALLOWANCE_CO: the allowance change order must be APPROVED before billing the overage' using errcode = 'P0001';
  end if;
  if exists (select 1 from pm.billing_request_lines bl join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
             where bl.org_id = a.org_id and bl.allowance_id = a.id and r.status <> 'VOID') then
    raise exception 'PM_ALLOWANCE_ALREADY_BILLED: %', a.description using errcode = '22023';
  end if;
  v_contract := pm.primary_contract_id(a.org_id, a.job_id);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract', a.job_id using errcode = 'P0001'; end if;
  select coalesce(k.retention_pct, 0) into v_rate from pm.contracts k where k.org_id = a.org_id and k.id = v_contract;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, billing_subtype, status, generated_by, occurred_on, memo, created_by)
  values (v_req, a.org_id, a.job_id, v_contract, 'PROGRESS', 'ALLOWANCE', 'DRAFT', 'allowance', coalesce(p_occurred_on, current_date),
          left('Allowance overage: ' || a.description, 500), pm.current_user_id());
  insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, cost_code_id, allowance_id,
                                        this_period_work_cents, retainage_rate, retainage_this_period_cents)
  values (a.org_id, v_req, 1, 0, 'STANDARD', left('Allowance overage: ' || a.description, 500), v_var, a.cost_code_id, a.id,
          v_var, v_rate, round(v_var * v_rate)::bigint);
  perform pm.finalize_billing_retainage(v_req);
  select j.location_id into v_loc from core.jobs j where j.id = a.job_id;
  perform pm.log_activity(a.org_id, v_loc, a.job_id, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted allowance overage (%s cents)', v_var), jsonb_build_object('mode', 'ALLOWANCE', 'allowance_id', a.id));
  return v_req;
end $$;

-- ----------------------------------------------------------------------------
-- 13. Preconditions + approve_and_emit_billing (THE money route) + void
-- ----------------------------------------------------------------------------

-- Named precondition codes that fail for a request ('{}' = ready). Invoker: a member sees
-- only their org; inside approve_and_emit_billing it runs with owner rights on one id.
create or replace function pm.billing_preconditions(p_request uuid)
returns text[]
language plpgsql stable
set search_path = pm, core, public
as $$
declare r pm.billing_requests%rowtype; f text[] := '{}'; v_cust uuid; v_n int; v_ret_lines bigint; v_ret_std bigint;
        v_contract bigint; v_billed bigint; v_out bigint;
begin
  select * into r from pm.billing_requests x where x.id = p_request;
  if not found then return array['PRECONDITION_NOT_FOUND']; end if;
  if r.status not in ('DRAFT','REJECTED') then f := array_append(f, 'PRECONDITION_NOT_DRAFT'); end if;
  select j.customer_id into v_cust from core.jobs j where j.org_id = r.org_id and j.id = r.job_id;
  if v_cust is null then f := array_append(f, 'PRECONDITION_NO_CUSTOMER'); end if;
  if r.billing_type <> 'TIME_MATERIALS' and pm.primary_contract_id(r.org_id, r.job_id) is null then
    f := array_append(f, 'PRECONDITION_NO_CONTRACT');
  end if;
  select count(*), coalesce(-sum(l.amount_cents) filter (where l.line_type = 'RETAINAGE'), 0),
         coalesce(sum(l.retainage_this_period_cents) filter (where l.line_type = 'STANDARD'), 0)
    into v_n, v_ret_lines, v_ret_std
  from pm.billing_request_lines l where l.org_id = r.org_id and l.billing_request_id = r.id;
  if v_n = 0 then f := array_append(f, 'PRECONDITION_NO_LINES'); end if;
  if r.net_cents <= 0 then f := array_append(f, 'PRECONDITION_NONPOSITIVE'); end if;
  if v_ret_lines <> v_ret_std then f := array_append(f, 'PRECONDITION_RETAINAGE_TIE'); end if;
  if r.billing_type <> 'TIME_MATERIALS' and r.billing_subtype is distinct from 'RETAINAGE_RELEASE' then
    select m.revised_contract_cents into v_contract from pm.v_job_money m where m.org_id = r.org_id and m.job_id = r.job_id;
    select coalesce(sum(x.gross_earned_cents), 0) into v_billed from pm.billing_requests x
    where x.org_id = r.org_id and x.job_id = r.job_id and x.id <> r.id
      and x.status in ('EMITTED','ISSUED','UNISSUED','REJECTED') and x.billing_subtype is distinct from 'RETAINAGE_RELEASE';
    if v_billed + r.gross_earned_cents > coalesce(v_contract, 0) then f := array_append(f, 'PRECONDITION_OVER_CONTRACT'); end if;
  end if;
  if r.billing_subtype = 'RETAINAGE_RELEASE' then
    select coalesce(sum(case g.entry_type when 'HELD' then g.amount_cents else -g.amount_cents end), 0) into v_out
    from pm.retainage_ledger g join pm.billing_requests b on b.org_id = g.org_id and b.id = g.billing_request_id
    where g.org_id = r.org_id and g.job_id = r.job_id and b.id <> r.id and b.status in ('EMITTED','ISSUED','UNISSUED');
    if r.retainage_released_cents > v_out then f := array_append(f, 'PRECONDITION_RETAINAGE_EXCEEDS_HELD'); end if;
    if not pm.guard_compliance_current(r.job_id) then f := array_append(f, 'PRECONDITION_COMPLIANCE'); end if;
  end if;
  if r.billing_type = 'DRAW' and not pm.draw_preconditions_met(r.id) then f := array_append(f, 'PRECONDITION_DRAW'); end if;
  return f;
end $$;

create or replace function pm.approve_and_emit_billing(p_request uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  r         pm.billing_requests%rowtype;
  v_me      text := pm.current_user_id();
  v_fail    text[];
  v_supp    text;
  v_event   uuid;
  v_lines   jsonb;
  v_payload jsonb;
  v_left    bigint;
  v_total   bigint;
  v_alloc   bigint;
  v_i       int;
  v_n       int;
  b         record;
  v_rel     uuid;
begin
  select * into r from pm.billing_requests x where x.id = p_request for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: billing request % not found in the caller''s organization', p_request using errcode = '42501';
  end if;
  if r.status not in ('DRAFT','REJECTED') then
    raise exception 'PM_BILLING_NOT_APPROVABLE: billing request is %; only DRAFT or REJECTED can be approved', r.status using errcode = '22023';
  end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  if r.created_by is not null and r.created_by = v_me then
    raise exception 'PM_SOD_VIOLATION: the preparer of a billing request cannot approve it' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || r.job_id::text, 0));
  v_fail := pm.billing_preconditions(r.id);
  if cardinality(v_fail) > 0 then
    raise exception 'PRECONDITION_FAILED: %', array_to_string(v_fail, ',') using errcode = 'P0001';
  end if;
  v_supp := pm.emit_suppression(r.org_id, r.job_id);
  if v_supp is null and r.billing_subtype = 'RETAINAGE_RELEASE' and pm.books_seam_version(r.org_id) < 2 then
    raise exception 'PRECONDITION_BOOKS_SEAM_V2: Books does not yet book retainage releases as a reclass (needs books_seam_version >= 2)'
      using errcode = 'P0001';
  end if;

  -- retainage shadow ledger (idempotent on re-approval after a rejection)
  insert into pm.retainage_ledger (org_id, job_id, billing_request_id, billing_request_line_id, sov_line_id, sov_lineage_id,
                                   entry_type, amount_cents, memo)
  select r.org_id, r.job_id, r.id, l.id, l.sov_line_id, l.sov_lineage_id, 'HELD', l.retainage_this_period_cents, l.description
  from pm.billing_request_lines l
  where l.org_id = r.org_id and l.billing_request_id = r.id and l.line_type = 'STANDARD' and l.retainage_this_period_cents <> 0
  on conflict on constraint retainage_ledger_entry_key do nothing;

  if r.billing_subtype = 'RETAINAGE_RELEASE'
     and not exists (select 1 from pm.retainage_ledger g where g.org_id = r.org_id and g.billing_request_id = r.id and g.entry_type = 'RELEASED') then
    -- allocate the release pro rata over outstanding buckets (SOV lineage, or job level)
    select l.id into v_rel from pm.billing_request_lines l where l.org_id = r.org_id and l.billing_request_id = r.id and l.line_type = 'RETAINAGE_RELEASE' limit 1;
    select coalesce(sum(o.out_cents), 0), count(*) into v_total, v_n from (
      select g.sov_lineage_id, sum(case g.entry_type when 'HELD' then g.amount_cents else -g.amount_cents end) as out_cents
      from pm.retainage_ledger g join pm.billing_requests x on x.org_id = g.org_id and x.id = g.billing_request_id
      where g.org_id = r.org_id and g.job_id = r.job_id and x.status in ('EMITTED','ISSUED','UNISSUED')
      group by g.sov_lineage_id having sum(case g.entry_type when 'HELD' then g.amount_cents else -g.amount_cents end) > 0) o;
    v_left := r.retainage_released_cents; v_i := 0;
    for b in
      select g.sov_lineage_id as lineage, max(g.sov_line_id::text)::uuid as sov_line_id,
             sum(case g.entry_type when 'HELD' then g.amount_cents else -g.amount_cents end) as out_cents
      from pm.retainage_ledger g join pm.billing_requests x on x.org_id = g.org_id and x.id = g.billing_request_id
      where g.org_id = r.org_id and g.job_id = r.job_id and x.status in ('EMITTED','ISSUED','UNISSUED')
      group by g.sov_lineage_id having sum(case g.entry_type when 'HELD' then g.amount_cents else -g.amount_cents end) > 0
      order by 3 asc, 1 nulls first
    loop
      v_i := v_i + 1;
      v_alloc := case when v_i = v_n then v_left
                      else least(v_left, floor(r.retainage_released_cents::numeric * b.out_cents / v_total)::bigint) end;
      if v_alloc > 0 then
        insert into pm.retainage_ledger (org_id, job_id, billing_request_id, billing_request_line_id, sov_line_id, sov_lineage_id,
                                         entry_type, amount_cents, memo)
        values (r.org_id, r.job_id, r.id, v_rel, b.sov_line_id, b.lineage, 'RELEASED', v_alloc, 'Retainage release')
        on conflict on constraint retainage_ledger_entry_key do nothing;
      end if;
      v_left := v_left - v_alloc;
    end loop;
  end if;

  if v_supp is not null then
    update pm.billing_requests set status = 'UNISSUED', suppressed_reason = v_supp, approved_by = v_me, approved_at = now(), error_text = null
     where id = r.id;
    perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'billing.approved', 'billing_requests', r.id,
      format('Approved billing (%s cents) — not sent to Books (%s)', r.net_cents, lower(v_supp)),
      jsonb_build_object('net_cents', r.net_cents, 'suppressed_reason', v_supp));
    return null;
  end if;

  -- frozen v3 lines {description, amount_cents, item_id} + additive {line_type, cost_code_id}
  select jsonb_agg(jsonb_build_object(
           'description',  l.description,
           'amount_cents', l.amount_cents,
           'item_id',      l.item_id,
           'line_type',    l.line_type,
           'cost_code_id', l.cost_code_id) order by l.sort, l.line_no, l.id)
    into v_lines
  from pm.billing_request_lines l
  where l.org_id = r.org_id and l.billing_request_id = r.id and l.amount_cents <> 0;

  v_event := gen_random_uuid();
  v_payload := jsonb_build_object(
    -- FROZEN v3 (exact key set of proj.approve_and_emit_billing)
    'event_id',                 v_event,
    'event_type',               'JOB_BILLING',
    'source_module',            'PROJECTS',
    'org_id',                   r.org_id,
    'location_id',              r.location_id,
    'job_id',                   r.job_id,
    'billing_type',             r.billing_type,
    'occurred_on',              to_char(r.occurred_on, 'YYYY-MM-DD'),
    'source_ref',               r.source_ref,
    'memo',                     r.memo,
    'lines',                    v_lines,
    -- additive (schema_version 2)
    'schema_version',           2,
    'billing_subtype',          r.billing_subtype,
    'gross_earned_cents',       r.gross_earned_cents,
    'retainage_cents',          r.retainage_cents,
    'retainage_released_cents', r.retainage_released_cents,
    'application_no',           r.application_no,
    'period_end',               to_char(r.period_end, 'YYYY-MM-DD'));
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (r.org_id, v_event, 'JOB_BILLING', 'PROJECTS', v_payload, r.occurred_on, 'pending');

  update pm.billing_requests
     set status = 'EMITTED', event_id = v_event, approved_by = v_me, approved_at = now(), emitted_at = now(),
         suppressed_reason = null, error_text = null
   where id = r.id;
  perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'billing.emitted', 'billing_requests', r.id,
    format('Approved and sent billing (%s cents) to Books', r.net_cents),
    jsonb_build_object('event_id', v_event, 'billing_type', r.billing_type, 'billing_subtype', r.billing_subtype,
                       'net_cents', r.net_cents, 'retainage_cents', r.retainage_cents, 'reemit', r.status = 'REJECTED'));
  return v_event;
end $$;

create or replace function pm.void_billing_request(p_request uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.billing_requests%rowtype;
begin
  select * into r from pm.billing_requests x where x.id = p_request for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: billing request % not found in the caller''s organization', p_request using errcode = '42501';
  end if;
  if r.status not in ('DRAFT','REJECTED') then
    raise exception 'PM_BILLING_NOT_VOIDABLE: billing request is % (Books owns issued invoices: credit memo there)', r.status using errcode = '22023';
  end if;
  delete from pm.billing_links k where k.org_id = r.org_id and k.billing_request_id = r.id;
  update pm.billing_requests set status = 'VOID', void_reason = p_reason where id = r.id;
  perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'billing.voided', 'billing_requests', r.id,
    'Voided billing request', jsonb_build_object('reason', p_reason, 'from', r.status));
  return r.id;
end $$;

-- ----------------------------------------------------------------------------
-- 14. Deposits (JOB_DEPOSIT_REQUEST; Books: DR AR / CR CUSTOMER_DEPOSITS 2420)
-- ----------------------------------------------------------------------------
create or replace function pm.emit_deposit_request(p_deposit uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.deposit_requests%rowtype; v_supp text; v_event uuid;
begin
  select * into d from pm.deposit_requests x where x.id = p_deposit for update;
  v_supp := pm.emit_suppression(d.org_id, d.job_id);
  if v_supp is not null then
    update pm.deposit_requests set status = 'UNISSUED', suppressed_reason = v_supp, error_text = null where id = d.id;
    return null;
  end if;
  v_event := gen_random_uuid();
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (d.org_id, v_event, 'JOB_DEPOSIT_REQUEST', 'PROJECTS', jsonb_build_object(
    'event_id',       v_event,
    'event_type',     'JOB_DEPOSIT_REQUEST',
    'source_module',  'PROJECTS',
    'org_id',         d.org_id,
    'location_id',    d.location_id,
    'job_id',         d.job_id,
    'customer_id',    d.customer_id,
    'amount_cents',   d.amount_cents,
    'memo',           d.memo,
    'occurred_on',    to_char(d.occurred_on, 'YYYY-MM-DD'),
    'source_ref',     d.source_ref,
    'schema_version', 1), d.occurred_on, 'pending');
  update pm.deposit_requests set status = 'EMITTED', event_id = v_event, emitted_at = now(), suppressed_reason = null, error_text = null
   where id = d.id;
  return v_event;
end $$;

create or replace function pm.request_deposit(p_job uuid, p_amount_cents bigint, p_memo text default null, p_occurred_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v_cust uuid; v_id uuid := gen_random_uuid(); v_contract bigint; v_prior bigint; v_event uuid;
begin
  select j.org_id, j.location_id, j.customer_id into v_org, v_loc, v_cust from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: deposit must be > 0' using errcode = 'P0001'; end if;
  if v_cust is null then raise exception 'PRECONDITION_NO_CUSTOMER: job % has no customer to invoice', p_job using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));
  if pm.primary_contract_id(v_org, p_job) is not null then
    select m.revised_contract_cents into v_contract from pm.v_job_money m where m.org_id = v_org and m.job_id = p_job;
    select coalesce(sum(d.amount_cents), 0) into v_prior from pm.deposit_requests d
    where d.org_id = v_org and d.job_id = p_job and d.status in ('EMITTED','ISSUED','UNISSUED','REJECTED');
    if v_prior + p_amount_cents > v_contract then
      raise exception 'PRECONDITION_DEPOSIT_EXCEEDS_CONTRACT: deposits % + % exceed contract %', v_prior, p_amount_cents, v_contract
        using errcode = 'P0001';
    end if;
  end if;
  insert into pm.deposit_requests (id, org_id, location_id, job_id, customer_id, amount_cents, memo, occurred_on, status, source_ref, created_by)
  values (v_id, v_org, v_loc, p_job, v_cust, p_amount_cents, coalesce(p_memo, 'Deposit'), coalesce(p_occurred_on, current_date), 'DRAFT',
          'pm:deposit:' || v_id::text, pm.current_user_id());
  v_event := pm.emit_deposit_request(v_id);
  perform pm.log_activity(v_org, v_loc, p_job, 'deposit.requested', 'deposit_requests', v_id,
    format('Requested a %s cent deposit invoice%s', p_amount_cents, case when v_event is null then ' (not sent to Books)' else '' end),
    jsonb_build_object('amount_cents', p_amount_cents, 'event_id', v_event));
  return v_id;
end $$;

create or replace function pm.reemit_deposit_request(p_deposit uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.deposit_requests%rowtype; v_event uuid;
begin
  select * into d from pm.deposit_requests x where x.id = p_deposit for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deposit request % not found in the caller''s organization', p_deposit using errcode = '42501';
  end if;
  if d.status <> 'REJECTED' then raise exception 'PM_DEPOSIT_NOT_REJECTED: deposit request is %', d.status using errcode = '22023'; end if;
  v_event := pm.emit_deposit_request(d.id);
  perform pm.log_activity(d.org_id, d.location_id, d.job_id, 'deposit.reemitted', 'deposit_requests', d.id,
    'Re-sent deposit request to Books', jsonb_build_object('event_id', v_event));
  return v_event;
end $$;

-- ----------------------------------------------------------------------------
-- 15. Reconcile (Books ack-in-place on core.events -> pm). Reads core.events only; never
--     writes Books-owned rows. Run after every Books processing pass.
-- ----------------------------------------------------------------------------
create or replace function pm.reconcile_billing_internal(p_org uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r record; n_issued int := 0; n_rej int := 0; n_dep_issued int := 0; n_dep_rej int := 0; n_fill int := 0;
begin
  for r in
    select b.id, b.org_id, b.location_id, b.job_id, b.status as cur, e.status as ev, e.invoice_id, e.invoice_number, e.gl_entry_id,
           e.error, e.processed_at
    from pm.billing_requests b
    join core.events e on e.org_id = b.org_id and e.event_id = b.event_id and e.event_type = 'JOB_BILLING'
    where (p_org is null or b.org_id = p_org)
      and ((b.status = 'EMITTED' and e.status in ('processed','rejected'))
        or (b.status = 'ISSUED' and e.status = 'processed'
            and (b.invoice_number is distinct from e.invoice_number or b.invoice_id is distinct from e.invoice_id)))
    for update of b skip locked
  loop
    if r.ev = 'processed' then
      update pm.billing_requests set status = 'ISSUED', invoice_id = r.invoice_id, invoice_number = r.invoice_number,
             gl_entry_id = r.gl_entry_id, issued_at = coalesce(issued_at, r.processed_at, now()), error_text = null
       where id = r.id;
      if r.cur = 'EMITTED' then
        n_issued := n_issued + 1;
        perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'billing.issued', 'billing_requests', r.id,
          format('Books issued invoice %s', coalesce(r.invoice_number, '(number pending)')),
          jsonb_build_object('invoice_id', r.invoice_id, 'invoice_number', r.invoice_number), 'SYSTEM');
      else
        n_fill := n_fill + 1;
      end if;
    else
      update pm.billing_requests set status = 'REJECTED', error_text = coalesce(r.error, 'Rejected by Books (no reason given)')
       where id = r.id;
      n_rej := n_rej + 1;
      perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'billing.rejected', 'billing_requests', r.id,
        format('Books rejected the billing: %s', coalesce(r.error, 'no reason given')), jsonb_build_object('error', r.error), 'SYSTEM');
    end if;
  end loop;

  for r in
    select d.id, d.org_id, d.location_id, d.job_id, d.status as cur, e.status as ev, e.invoice_id, e.invoice_number, e.gl_entry_id,
           e.error, e.processed_at
    from pm.deposit_requests d
    join core.events e on e.org_id = d.org_id and e.event_id = d.event_id and e.event_type = 'JOB_DEPOSIT_REQUEST'
    where (p_org is null or d.org_id = p_org)
      and ((d.status = 'EMITTED' and e.status in ('processed','rejected'))
        or (d.status = 'ISSUED' and e.status = 'processed'
            and (d.invoice_number is distinct from e.invoice_number or d.invoice_id is distinct from e.invoice_id)))
    for update of d skip locked
  loop
    if r.ev = 'processed' then
      update pm.deposit_requests set status = 'ISSUED', invoice_id = r.invoice_id, invoice_number = r.invoice_number,
             gl_entry_id = r.gl_entry_id, issued_at = coalesce(issued_at, r.processed_at, now()), error_text = null
       where id = r.id;
      if r.cur = 'EMITTED' then
        n_dep_issued := n_dep_issued + 1;
        perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'deposit.issued', 'deposit_requests', r.id,
          format('Books issued deposit invoice %s', coalesce(r.invoice_number, '(number pending)')),
          jsonb_build_object('invoice_id', r.invoice_id, 'invoice_number', r.invoice_number), 'SYSTEM');
      else
        n_fill := n_fill + 1;
      end if;
    else
      update pm.deposit_requests set status = 'REJECTED', error_text = coalesce(r.error, 'Rejected by Books (no reason given)') where id = r.id;
      n_dep_rej := n_dep_rej + 1;
      perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'deposit.rejected', 'deposit_requests', r.id,
        format('Books rejected the deposit request: %s', coalesce(r.error, 'no reason given')), jsonb_build_object('error', r.error), 'SYSTEM');
    end if;
  end loop;

  return jsonb_build_object('billing_issued', n_issued, 'billing_rejected', n_rej, 'deposits_issued', n_dep_issued,
                            'deposits_rejected', n_dep_rej, 'invoice_numbers_filled', n_fill);
end $$;

-- service_role (scheduler): p_org null = every org.
create or replace function pm.reconcile_billing_requests(p_org uuid default null)
returns jsonb
language sql security definer
set search_path = pm, core, public
as $$
  select pm.reconcile_billing_internal(p_org)
$$;

-- Member wrapper: reconciles the caller's org only.
create or replace function pm.reconcile_my_billing()
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
begin
  if v_org is null then raise exception 'PM_FORBIDDEN: no organization in the caller''s session' using errcode = '42501'; end if;
  return pm.reconcile_billing_internal(v_org);
end $$;

-- ----------------------------------------------------------------------------
-- 16. Views (security_invoker)
-- ----------------------------------------------------------------------------
create or replace view pm.v_commitment_status with (security_invoker = on) as
select
  c.org_id, c.job_id, c.location_id, c.id as commitment_id, c.number, c.commitment_type, c.vendor_id,
  coalesce(v.display_name, v.name) as vendor_name, c.status, c.version, c.retainage_pct,
  c.payment_hold as manual_hold, c.hold_reason,
  pm.commitment_payment_eligible(c.id) as compliance_ok,
  (c.payment_hold or not pm.commitment_payment_eligible(c.id)) as payment_hold_effective,
  l.id as commitment_line_id, l.line_no, l.cost_code_id, cc.code as cost_code, l.cost_type, l.description,
  coalesce(l.original_amount_cents, l.amount_cents)::bigint as original_amount_cents,
  coalesce((select sum(x.amount_cents) from pm.commitment_changes x
            where x.org_id = l.org_id and x.applied_line_id = l.id and x.status = 'APPROVED'), 0)::bigint as approved_change_cents,
  l.amount_cents as revised_amount_cents,
  l.billed_cents,
  case when c.status in ('APPROVED','EXECUTED') then greatest(l.amount_cents - l.billed_cents, 0) else 0 end::bigint as open_cents,
  greatest(l.billed_cents - l.amount_cents, 0)::bigint as over_billed_cents,
  l.qty, l.uom, l.unit_cost_cents, l.received_qty, l.received_cents,
  greatest(l.received_cents - l.billed_cents, 0)::bigint as received_not_billed_cents,
  case when l.amount_cents > 0 then round(l.billed_cents::numeric / l.amount_cents, 4) end as pct_billed
from pm.commitments c
join pm.commitment_lines l on l.org_id = c.org_id and l.commitment_id = c.id
left join pm.cost_codes cc on cc.org_id = l.org_id and cc.id = l.cost_code_id
left join core.vendors v on v.org_id = c.org_id and v.id = c.vendor_id;

-- Per SOV line (every version): scheduled, billed to date by lineage (counts EMITTED |
-- ISSUED | UNISSUED applications), stored balance, % complete, balance, retainage.
create or replace view pm.v_sov_status with (security_invoker = on) as
select
  v.org_id, v.job_id, v.id as sov_version_id, v.version as sov_version, v.status as sov_status,
  s.id as sov_line_id, s.lineage_id, s.line_no, s.description, s.cost_code_id,
  s.scheduled_value_cents,
  coalesce(b.work_cents, 0)::bigint                                   as work_completed_cents,
  coalesce(b.stored_cents, 0)::bigint                                 as stored_materials_cents,
  (coalesce(b.work_cents, 0) + coalesce(b.stored_cents, 0))::bigint   as completed_and_stored_cents,
  case when s.scheduled_value_cents > 0
       then round((coalesce(b.work_cents, 0) + coalesce(b.stored_cents, 0))::numeric / s.scheduled_value_cents, 4) end as pct_complete,
  (s.scheduled_value_cents - coalesce(b.work_cents, 0) - coalesce(b.stored_cents, 0))::bigint as balance_to_finish_cents,
  coalesce(g.held, 0)::bigint                                         as retainage_held_cents,
  coalesce(g.released, 0)::bigint                                     as retainage_released_cents,
  (coalesce(g.held, 0) - coalesce(g.released, 0))::bigint             as retainage_outstanding_cents,
  b.last_application_no
from pm.sov_versions v
join pm.sov_lines s on s.org_id = v.org_id and s.sov_version_id = v.id
left join lateral (
  select sum(bl.this_period_work_cents) as work_cents,
         (array_agg(bl.stored_materials_cents order by r.application_no desc nulls last, r.created_at desc))[1] as stored_cents,
         max(r.application_no) as last_application_no
  from pm.billing_request_lines bl
  join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
  where bl.org_id = s.org_id and r.job_id = v.job_id and bl.sov_lineage_id = s.lineage_id and bl.line_type = 'STANDARD'
    and r.status in ('EMITTED','ISSUED','UNISSUED')
) b on true
left join lateral (
  select sum(gl.amount_cents) filter (where gl.entry_type = 'HELD') as held,
         sum(gl.amount_cents) filter (where gl.entry_type = 'RELEASED') as released
  from pm.retainage_ledger gl
  join pm.billing_requests r on r.org_id = gl.org_id and r.id = gl.billing_request_id
  where gl.org_id = s.org_id and gl.job_id = v.job_id and gl.sov_lineage_id = s.lineage_id
    and r.status in ('EMITTED','ISSUED','UNISSUED')
) g on true;

-- AIA G702 application summary per SOV request (any status except VOID).
--   1 original contract sum · 2 net change by change orders · 3 contract sum to date (Σ C of the
--   SOV version) · 4 total completed & stored to date (Σ G) · 5 retainage (5a work, 5b stored;
--   line 5 = retainage actually held to date) · 6 total earned less retainage (4 − 5) ·
--   7 less previous certificates (Σ net of earlier counted applications) · 8 current payment
--   due (6 − 7 = this request's net) · 9 balance to finish incl. retainage (3 − 6)
create or replace view pm.v_pay_application with (security_invoker = on) as
select
  r.org_id, r.job_id, r.id as billing_request_id, r.application_no, r.period_end, r.status, r.sov_version_id,
  coalesce(k.original_cents, 0)::bigint                                           as original_contract_cents,
  (t.scheduled - coalesce(k.original_cents, 0))::bigint                          as net_change_by_co_cents,
  t.scheduled::bigint                                                             as contract_sum_to_date_cents,
  t.completed::bigint                                                             as total_completed_stored_cents,
  t.ret_work::bigint                                                              as retainage_work_cents,
  t.ret_stored::bigint                                                            as retainage_stored_cents,
  (prev.ret_held + t.ret_this)::bigint                                            as retainage_total_cents,
  (t.completed - prev.ret_held - t.ret_this)::bigint                              as total_earned_less_retainage_cents,
  prev.net::bigint                                                                as previous_certificates_cents,
  (t.completed - prev.ret_held - t.ret_this - prev.net)::bigint                   as current_payment_due_cents,
  (t.scheduled - (t.completed - prev.ret_held - t.ret_this))::bigint              as balance_to_finish_incl_retainage_cents,
  r.net_cents                                                                     as request_net_cents
from pm.billing_requests r
left join pm.contracts k on k.org_id = r.org_id and k.id = r.contract_id
cross join lateral (
  select coalesce(sum(l.scheduled_value_cents), 0) as scheduled,
         coalesce(sum(l.total_completed_cents), 0) as completed,
         coalesce(sum(l.retainage_work_to_date_cents), 0) as ret_work,
         coalesce(sum(l.retainage_stored_to_date_cents), 0) as ret_stored,
         coalesce(sum(l.retainage_this_period_cents), 0) as ret_this
  from pm.billing_request_lines l where l.org_id = r.org_id and l.billing_request_id = r.id and l.line_type = 'STANDARD'
) t
cross join lateral (
  select coalesce(sum(p.net_cents), 0) as net,
         coalesce(sum(p.retainage_cents), 0) as ret_held
  from pm.billing_requests p
  where p.org_id = r.org_id and p.job_id = r.job_id and p.billing_subtype = 'SOV' and p.application_no < r.application_no
    and p.status in ('EMITTED','ISSUED','UNISSUED','REJECTED')
) prev
where r.billing_subtype = 'SOV' and r.status <> 'VOID';

-- What needs a person or is waiting on Books: DRAFT (approve), REJECTED (fix / re-send),
-- EMITTED (pending in Books), plus deposit requests EMITTED / REJECTED.
create or replace view pm.v_billing_queue with (security_invoker = on) as
select
  'BILLING'::text as kind, r.id, r.org_id, r.location_id, r.job_id, j.job_number, j.name as job_name,
  coalesce(cu.display_name, cu.name, j.customer_name) as customer_name,
  r.billing_type, r.billing_subtype, r.status, r.application_no, r.occurred_on, r.period_end,
  r.gross_earned_cents, r.retainage_cents, r.retainage_released_cents, r.net_cents,
  r.created_by, r.created_at, r.approved_by, r.emitted_at, r.error_text,
  (current_date - coalesce(r.emitted_at, r.created_at)::date) as age_days,
  case when r.status in ('DRAFT','REJECTED') then pm.billing_preconditions(r.id) else '{}'::text[] end as failing_preconditions,
  case r.status when 'DRAFT' then 'APPROVE' when 'REJECTED' then 'FIX_AND_RESEND' else 'AWAITING_BOOKS' end as next_action
from pm.billing_requests r
join core.jobs j on j.org_id = r.org_id and j.id = r.job_id
left join core.customers cu on cu.org_id = j.org_id and cu.id = j.customer_id
where r.status in ('DRAFT','REJECTED','EMITTED')
union all
select
  'DEPOSIT', d.id, d.org_id, d.location_id, d.job_id, j.job_number, j.name,
  coalesce(cu.display_name, cu.name, j.customer_name),
  null, null, d.status, null, d.occurred_on, null,
  d.amount_cents, 0, 0, d.amount_cents,
  d.created_by, d.created_at, null, d.emitted_at, d.error_text,
  (current_date - coalesce(d.emitted_at, d.created_at)::date),
  '{}'::text[],
  case d.status when 'REJECTED' then 'FIX_AND_RESEND' else 'AWAITING_BOOKS' end
from pm.deposit_requests d
join core.jobs j on j.org_id = d.org_id and j.id = d.job_id
left join core.customers cu on cu.org_id = j.org_id and cu.id = j.customer_id
where d.status in ('REJECTED','EMITTED');

-- ----------------------------------------------------------------------------
-- 17. RLS (D12)
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['estimates','estimate_lines','commitments','commitment_lines','commitment_changes','receipts',
    'compliance_docs','sov_versions','sov_lines','billing_requests','billing_request_lines','retainage_ledger','allowances',
    'billing_links','deposit_requests'] loop
    execute format('alter table pm.%I enable row level security', t);
  end loop;
  -- uniform isolation: member writes on these are limited by grants + parent-state triggers
  foreach t in array array['estimate_lines','commitment_lines','receipts','sov_lines','billing_request_lines',
    'retainage_ledger','billing_links','deposit_requests'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
  -- state-bearing headers: members create/edit/delete only in the open state
  foreach t in array array['estimates','commitments','commitment_changes','sov_versions'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_select') then
      execute format('create policy org_select on pm.%I for select using (org_id = public.get_org_id())', t);
      execute format('create policy draft_insert on pm.%I for insert with check (org_id = public.get_org_id() and status = ''DRAFT'')', t);
      execute format('create policy draft_update on pm.%I for update using (org_id = public.get_org_id() and status = ''DRAFT'') with check (org_id = public.get_org_id() and status = ''DRAFT'')', t);
      execute format('create policy draft_delete on pm.%I for delete using (org_id = public.get_org_id() and status = ''DRAFT'')', t);
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'billing_requests' and policyname = 'org_select') then
    create policy org_select on pm.billing_requests for select using (org_id = public.get_org_id());
    create policy draft_insert on pm.billing_requests for insert
      with check (org_id = public.get_org_id() and status = 'DRAFT' and generated_by is null
                  and (billing_subtype is null or billing_subtype in ('FIXED','RECURRING')) and event_id is null);
    create policy open_update on pm.billing_requests for update
      using (org_id = public.get_org_id() and status in ('DRAFT','REJECTED'))
      with check (org_id = public.get_org_id() and status in ('DRAFT','REJECTED'));
    create policy draft_delete on pm.billing_requests for delete using (org_id = public.get_org_id() and status = 'DRAFT');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'compliance_docs' and policyname = 'org_select') then
    create policy org_select on pm.compliance_docs for select using (org_id = public.get_org_id());
    create policy open_insert on pm.compliance_docs for insert
      with check (org_id = public.get_org_id() and status <> 'VERIFIED' and verified_by is null and verified_at is null);
    create policy open_update on pm.compliance_docs for update using (org_id = public.get_org_id() and status <> 'VERIFIED')
      with check (org_id = public.get_org_id() and status <> 'VERIFIED');
    create policy open_delete on pm.compliance_docs for delete using (org_id = public.get_org_id() and status <> 'VERIFIED');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'allowances' and policyname = 'org_select') then
    create policy org_select on pm.allowances for select using (org_id = public.get_org_id());
    create policy open_insert on pm.allowances for insert with check (org_id = public.get_org_id() and status = 'OPEN');
    create policy open_update on pm.allowances for update using (org_id = public.get_org_id() and status = 'OPEN')
      with check (org_id = public.get_org_id() and status = 'OPEN');
    create policy open_delete on pm.allowances for delete using (org_id = public.get_org_id() and status = 'OPEN');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 18. Table grants: nothing for anon/PUBLIC; service_role everything; authenticated by
--     column so state, totals, Books acks and drain-maintained values move only via functions.
-- ----------------------------------------------------------------------------
revoke all on pm.estimates, pm.estimate_lines, pm.commitments, pm.commitment_lines, pm.commitment_changes, pm.receipts,
              pm.compliance_docs, pm.sov_versions, pm.sov_lines, pm.billing_requests, pm.billing_request_lines,
              pm.retainage_ledger, pm.allowances, pm.billing_links, pm.deposit_requests
  from public, anon, authenticated;
grant select, insert, update, delete on pm.estimates, pm.estimate_lines, pm.commitments, pm.commitment_lines,
              pm.commitment_changes, pm.receipts, pm.compliance_docs, pm.sov_versions, pm.sov_lines, pm.billing_requests,
              pm.billing_request_lines, pm.retainage_ledger, pm.allowances, pm.billing_links, pm.deposit_requests
  to service_role;

grant select, delete on pm.estimates to authenticated;
grant insert (job_id, customer_id, title, retainage_pct, valid_until, notes) on pm.estimates to authenticated;
grant update (customer_id, title, retainage_pct, valid_until, notes) on pm.estimates to authenticated;

grant select, delete on pm.estimate_lines to authenticated;
grant insert (estimate_id, line_no, cost_code_id, wbs_id, price_book_item_id, description, qty, uom, unit_cost_cents,
              unit_price_cents, cost_cents, amount_cents, is_allowance, sort, ext) on pm.estimate_lines to authenticated;
grant update (line_no, cost_code_id, wbs_id, price_book_item_id, description, qty, uom, unit_cost_cents,
              unit_price_cents, cost_cents, amount_cents, is_allowance, sort, ext) on pm.estimate_lines to authenticated;

grant select, delete on pm.commitments to authenticated;
grant insert (job_id, vendor_id, commitment_type, title, description, retainage_pct) on pm.commitments to authenticated;
grant update (vendor_id, commitment_type, title, description, retainage_pct) on pm.commitments to authenticated;

grant select, delete on pm.commitment_lines to authenticated;
grant insert (commitment_id, line_no, cost_code_id, cost_type, description, item_id, qty, uom, unit_cost_cents, amount_cents,
              tax_code, account_hint) on pm.commitment_lines to authenticated;
grant update (line_no, cost_code_id, cost_type, description, item_id, qty, uom, unit_cost_cents, amount_cents,
              tax_code, account_hint) on pm.commitment_lines to authenticated;

grant select, delete on pm.commitment_changes to authenticated;
grant insert (commitment_id, commitment_line_id, cost_code_id, description, reason, amount_cents, owner_co_id) on pm.commitment_changes to authenticated;
grant update (commitment_line_id, cost_code_id, description, reason, amount_cents, owner_co_id) on pm.commitment_changes to authenticated;

grant select on pm.receipts to authenticated;

grant select, delete on pm.compliance_docs to authenticated;
grant insert (job_id, commitment_id, vendor_id, doc_type, status, required, expires_on, covers_through, amount_cents, document_id, notes)
  on pm.compliance_docs to authenticated;
grant update (status, required, expires_on, covers_through, amount_cents, document_id, notes) on pm.compliance_docs to authenticated;

grant select, delete on pm.sov_versions to authenticated;
grant insert (job_id, contract_id, retainage_pct, memo) on pm.sov_versions to authenticated;
grant update (contract_id, retainage_pct, memo) on pm.sov_versions to authenticated;

grant select, delete on pm.sov_lines to authenticated;
grant insert (sov_version_id, line_no, cost_code_id, description, scheduled_value_cents, retainage_pct, change_order_id, sort)
  on pm.sov_lines to authenticated;
grant update (line_no, cost_code_id, description, scheduled_value_cents, retainage_pct, change_order_id, sort) on pm.sov_lines to authenticated;

grant select, delete on pm.billing_requests to authenticated;
grant insert (job_id, contract_id, billing_type, billing_subtype, occurred_on, period_start, period_end, memo) on pm.billing_requests to authenticated;
grant update (occurred_on, period_start, period_end, memo) on pm.billing_requests to authenticated;

grant select, delete on pm.billing_request_lines to authenticated;
grant insert (billing_request_id, line_no, sort, description, amount_cents, item_id, cost_code_id) on pm.billing_request_lines to authenticated;
grant update (line_no, sort, description, amount_cents, item_id, cost_code_id) on pm.billing_request_lines to authenticated;

grant select on pm.retainage_ledger, pm.billing_links, pm.deposit_requests to authenticated;

grant select, delete on pm.allowances to authenticated;
grant insert (job_id, cost_code_id, description, allowance_cents) on pm.allowances to authenticated;
grant update (cost_code_id, description, allowance_cents) on pm.allowances to authenticated;

grant select on pm.v_job_current_budget_lines, pm.v_job_retainage, pm.v_commitment_status, pm.v_sov_status,
                pm.v_pay_application, pm.v_billing_queue
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 19. Function grants (1100/1007 pattern) for the functions this migration owns
-- ----------------------------------------------------------------------------
do $$
declare r record;
  v_member text[] := array['send_estimate','accept_estimate','decline_estimate','revise_estimate',
    'approve_commitment','approve_commitment_change','reject_commitment_change','execute_commitment','close_commitment',
    'void_commitment','set_commitment_hold','record_receipt','verify_compliance_doc','commitment_payment_eligible',
    'activate_sov_version','revise_sov','generate_progress_billing','generate_sov_billing','generate_milestone_billing',
    'generate_tm_billing','request_retainage_release','close_allowance','bill_allowance_overage','billing_preconditions',
    'approve_and_emit_billing','void_billing_request','request_deposit','reemit_deposit_request','reconcile_my_billing',
    'guard_estimate_accepted','guard_deposit_requested','guard_final_billed','guard_compliance_current','draw_preconditions_met',
    'primary_contract_id','cost_code_usable'];
  v_internal text[] := array['books_seam_version','emit_suppression',
    'enforce_approval_policy','commitment_snapshot','finalize_billing_retainage','emit_deposit_request',
    'reconcile_billing_internal','reconcile_billing_requests','sync_commitment_holds',
    'tg_estimate_defaults','tg_estimate_line_guard','tg_estimate_totals','tg_commitment_defaults','tg_commitment_line_guard',
    'tg_commitment_change_defaults','tg_compliance_defaults','tg_sov_version_defaults','tg_sov_line_guard',
    'tg_billing_request_defaults','tg_billing_line_guard','tg_billing_totals','tg_allowance_guard'];
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
-- end 1102_pm_commitments_billing
-- ============================================================================
