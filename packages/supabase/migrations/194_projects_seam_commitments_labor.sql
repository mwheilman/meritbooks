-- =============================================================================
-- Migration 194: Projects seam — Books side, part 2.
--   JOB_COMMITMENT → AP match targets · JOB_TIME → labor cost from actual payroll ·
--   JOB_PROGRESS v2 pinned snapshots · re-tag lock after hard close · job-PO block ·
--   Books tie-out views for Projects' "Ties to Books".
-- =============================================================================
-- Contract: docs/projects/BOOKS-SEAM-CHANGES-FOR-PROJECTS-V2.md (A4–A8, B rows) and
-- docs/projects/BOOKS-PROJECTS-INTERACTION.md §1–§2 + "Status — part 2" (testable criteria
-- S2-1 … S2-24). Owner decisions (2026-10-21): job labor = ACTUAL payroll cost (gross +
-- employer taxes + employer benefits) allocated to jobs by hours worked, with an optional
-- standard-rate accrual trued up when payroll posts; when a client uses Projects, Projects
-- owns job purchase orders (commitments) and Books matches bills to them.
--
-- INDEPENDENCE. Every table here is populated only for orgs with
-- core.organizations.entitlements.projects = true (the consumers gate on it). A Books-only
-- tenant gets empty tables and unchanged behaviour; the job-PO block (§7) fires only for
-- Projects orgs.
--
-- §1  role JOB_LABOR_COST (ORG, 5000 Direct Labor) — the job-cost side of the labor reclass.
-- §2  public.ap_commitments / ap_commitment_versions / ap_commitment_lines — the Books AP match
--     target projected from JOB_COMMITMENT (non-posting; one row per Projects commitment, the
--     highest version wins; CLOSED / VOID retire it). Never creates purchase_orders rows.
--     public.bill_commitment_matches — bill line ↔ commitment line (3-way status, hold memory).
-- §3  public.job_labor_hours (JOB_TIME projection) · job_labor_settings · job_labor_allocations
--     (+ _lines) one per payroll run · job_labor_accruals (standard-rate accrual runs).
-- §4  public.job_progress_snapshots + pin / unpin RPCs (A6: pinned by (job, snapshot_version),
--     atomic, never overwritten by an older version, undone when the event is rejected).
-- §5  additive columns: job_cost_attributions (JOB_COST enrichment keys),
--     payroll_run_employees.employer_benefits_cents.
-- §6  A7: job_id / cost_code_id immutable on lines whose period is HARD_CLOSE.
-- §7  G14: no job-tagged Books purchase-order line for a Projects org.
-- §8  public.v_books_commitment_tieout / v_books_labor_tieout (security_invoker) — what Books
--     records, for Projects' "Ties to Books" commitments + time checks.
-- §9  RLS + grants (members read their org; service role writes; M1 function lockdown).
-- §10 core.apply_client_scope_rls() + core.apply_projects_only_seat_deny() (guarded).
--
-- Idempotent and PGlite-compatible (no extensions beyond the harness set). Money is bigint
-- cents; hours are numeric(8,2).
-- =============================================================================

-- ── §1 role key ──────────────────────────────────────────────────────────────
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('JOB_LABOR_COST', 'Direct job labor (payroll cost reclassed to jobs)', 'ORG', '5000')
on conflict (role_key) do update
  set label = excluded.label, scope = excluded.scope, default_account_number = excluded.default_account_number;

do $$ declare o record; begin
  if to_regprocedure('public.seed_account_roles(uuid)') is not null then
    for o in select id from core.organizations loop perform public.seed_account_roles(o.id); end loop;
  end if;
end $$;

-- ── §2 commitments (AP match targets) ────────────────────────────────────────
create table if not exists public.ap_commitments (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid not null references core.jobs(id),
  vendor_id            uuid references core.vendors(id),
  pm_commitment_id     uuid not null,                 -- Projects' pm.commitments.id (payload commitment_id)
  version              int not null check (version >= 1),
  number               text not null,
  commitment_type      text not null default 'PO' check (commitment_type in ('PO','SUBCONTRACT')),
  status               text not null check (status in ('APPROVED','EXECUTED','CLOSED','VOID')),
  active               boolean not null default true,  -- false once CLOSED / VOID (retired)
  retainage_pct        numeric(5,4) not null default 0 check (retainage_pct >= 0 and retainage_pct <= 1),
  payment_hold         boolean not null default false,
  hold_reason          text,
  total_amount_cents   bigint not null default 0,
  executed_on          date,
  memo                 text,
  source_ref           text not null,                 -- pm:commit:{id}:v{version} of the applied version
  source_event_id      uuid,                          -- core.events.id of the applied version
  retired_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, pm_commitment_id),
  check (active = (status in ('APPROVED','EXECUTED')))
);
create index if not exists ix_ap_commitments_match on public.ap_commitments (org_id, vendor_id, job_id) where active;
create index if not exists ix_ap_commitments_job on public.ap_commitments (org_id, job_id);

create table if not exists public.ap_commitment_versions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  commitment_id        uuid not null references public.ap_commitments(id) on delete cascade,
  version              int not null,
  status               text not null,
  payment_hold         boolean not null default false,
  total_amount_cents   bigint not null default 0,
  trigger_name         text,
  source_event_id      uuid,
  payload              jsonb not null,
  created_at           timestamptz not null default now(),
  unique (org_id, commitment_id, version)
);

create table if not exists public.ap_commitment_lines (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  commitment_id            uuid not null references public.ap_commitments(id) on delete cascade,
  pm_commitment_line_id    uuid not null,             -- Projects' pm.commitment_lines.id
  line_no                  int not null default 0,
  cost_code_id             uuid,                      -- Projects' pm.cost_codes.id (kept verbatim)
  cost_code                text,
  cost_type                text check (cost_type is null or cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  account_hint             text,
  description              text not null default '',
  amount_cents             bigint not null default 0 check (amount_cents >= 0),
  received_to_date_cents   bigint not null default 0 check (received_to_date_cents >= 0),
  removed                  boolean not null default false,  -- absent from the latest version
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, pm_commitment_line_id)
);
create index if not exists ix_ap_commitment_lines_cmt on public.ap_commitment_lines (commitment_id, line_no);

create table if not exists public.bill_commitment_matches (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  bill_id               uuid not null references public.bills(id) on delete cascade,
  bill_line_id          uuid not null references public.bill_lines(id) on delete cascade,
  commitment_id         uuid not null references public.ap_commitments(id),
  commitment_line_id    uuid not null references public.ap_commitment_lines(id),
  amount_cents          bigint not null,
  match_source          text not null default 'USER' check (match_source in ('USER','AUTO','INTAKE')),
  three_way_status      text not null default 'OK'
                          check (three_way_status in ('OK','BILLED_OVER_RECEIVED','NO_RECEIPT','OVER_COMMITTED')),
  variance_cents        bigint not null default 0,
  held_by_commitment    boolean not null default false,
  status_before_hold    text,
  matched_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, bill_line_id)
);
create index if not exists ix_bill_commitment_matches_cl on public.bill_commitment_matches (commitment_line_id);
create index if not exists ix_bill_commitment_matches_cmt on public.bill_commitment_matches (commitment_id);
create index if not exists ix_bill_commitment_matches_bill on public.bill_commitment_matches (bill_id);

-- ── §3 labor ─────────────────────────────────────────────────────────────────
create table if not exists public.job_labor_settings (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  accrue_standard_rate   boolean not null default false,  -- mid-period standard-rate accrual (trued up at payroll)
  updated_by             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, location_id)
);

create table if not exists public.job_labor_accruals (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  as_of_date       date not null,
  amount_cents     bigint not null default 0 check (amount_cents >= 0),
  trued_up_cents   bigint not null default 0 check (trued_up_cents >= 0),
  hours            numeric(10,2) not null default 0,
  gl_entry_id      uuid references public.gl_entries(id),
  status           text not null default 'POSTED' check (status in ('POSTED','PARTIAL','TRUED_UP')),
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, location_id, as_of_date)
);

create table if not exists public.job_labor_allocations (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id),
  payroll_run_id            uuid not null references public.payroll_runs(id),
  period_start              date not null,
  period_end                date not null,
  pay_date                  date not null,
  status                    text not null default 'PENDING' check (status in ('PENDING','POSTED','NOTHING','FAILED')),
  payroll_cost_cents        bigint not null default 0,   -- Σ gross + employer tax + employer benefits
  allocated_cents           bigint not null default 0,   -- moved to jobs (actual)
  unallocated_cost_cents    bigint not null default 0,   -- stays in payroll expense (paid, not on a job)
  allocated_hours           numeric(10,2) not null default 0,
  unallocated_hours         numeric(10,2) not null default 0,  -- approved job hours with no paid employee in this run
  accrual_reversed_cents    bigint not null default 0,   -- standard-rate accrual trued up by this run
  gl_entry_id               uuid references public.gl_entries(id),
  error                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, payroll_run_id)
);

create table if not exists public.job_labor_allocation_lines (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  allocation_id           uuid not null references public.job_labor_allocations(id) on delete cascade,
  job_id                  uuid not null references core.jobs(id),
  employee_id             uuid,
  labor_hours_id          uuid,
  cost_code_id            uuid,
  cost_code               text,
  department_id           uuid,
  hours                   numeric(8,2) not null default 0,
  wages_cents             bigint not null default 0,
  employer_tax_cents      bigint not null default 0,
  benefits_cents          bigint not null default 0,
  amount_cents            bigint not null default 0,
  accrual_reversed_cents  bigint not null default 0,
  created_at              timestamptz not null default now()
);
create index if not exists ix_job_labor_allocation_lines_alloc on public.job_labor_allocation_lines (allocation_id);
create index if not exists ix_job_labor_allocation_lines_job on public.job_labor_allocation_lines (org_id, job_id);

create table if not exists public.job_labor_hours (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  job_id                uuid not null references core.jobs(id),
  department_id         uuid,
  employee_id           uuid,
  time_entry_id         uuid,
  work_date             date not null,
  hours                 numeric(8,2) not null check (hours > 0),
  pay_type              text,
  cost_code_id          uuid,
  cost_code             text,
  standard_rate_cents   bigint,                       -- payload cost_rate_cents (information only)
  source_ref            text not null,                -- pm:time:{time_entry_id}
  revision              int not null default 1 check (revision >= 1),
  status                text not null default 'APPROVED' check (status in ('APPROVED','WITHDRAWN')),
  source_event_id       uuid,
  withdrawn_event_id    uuid,
  withdrawn_at          timestamptz,
  allocation_id         uuid references public.job_labor_allocations(id),
  allocated_cents       bigint not null default 0,
  accrual_id            uuid references public.job_labor_accruals(id),
  accrued_cents         bigint not null default 0 check (accrued_cents >= 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, source_ref, revision)
);
create index if not exists ix_job_labor_hours_open on public.job_labor_hours (org_id, employee_id, work_date)
  where status = 'APPROVED' and allocation_id is null;
create index if not exists ix_job_labor_hours_job on public.job_labor_hours (org_id, job_id);

-- ── §4 JOB_PROGRESS v2 pinned snapshots ──────────────────────────────────────
create table if not exists public.job_progress_snapshots (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  job_id                   uuid not null references core.jobs(id),
  snapshot_version         int not null check (snapshot_version >= 1),
  as_of_date               date not null,
  contract_value_cents     bigint,
  cost_estimate_cents      bigint,
  pct_complete             numeric(7,6),               -- 0..1 fraction as Projects sends it
  pending_co_value_cents   bigint,                     -- disclosure only; never recognized
  status                   text not null default 'PENDING' check (status in ('PENDING','APPLIED','HISTORICAL')),
  applied_to_job           boolean not null default false,
  prev_contract_cents      bigint,
  prev_estimate_cents      bigint,
  prev_pct_complete        numeric,
  source_event_id          uuid,
  source_ref               text,
  payload                  jsonb,
  created_at               timestamptz not null default now(),
  unique (org_id, job_id, snapshot_version)
);
create index if not exists ix_job_progress_snapshots_asof on public.job_progress_snapshots (org_id, job_id, as_of_date desc, snapshot_version desc);

-- Pin one snapshot atomically: insert (idempotent on (job, version)); when it is the newest
-- version for the job, copy it onto the job's rev-rec inputs (pct 0..1 → 0..100) remembering
-- the previous values so a rejected event can be undone. An older, out-of-order version is
-- kept as history (as-of reads) and never overwrites the job.
create or replace function public.pin_job_progress_snapshot(
  p_org uuid, p_job uuid, p_version int, p_as_of date,
  p_contract bigint, p_estimate bigint, p_pct numeric, p_pending_co bigint,
  p_event uuid, p_source_ref text, p_payload jsonb)
returns table (snapshot_id uuid, applied boolean, duplicate boolean)
language plpgsql security definer
set search_path = public, core, pg_temp
as $$
declare j record; v_max int; v_id uuid; v_status text; v_applied boolean;
begin
  select id, org_id, location_id, contract_amount_cents, estimated_cost_cents, pct_complete
    into j from core.jobs where id = p_job and org_id = p_org for update;
  if j.id is null then raise exception 'JOB_NOT_FOUND: job % is not in org %', p_job, p_org using errcode = 'P0002'; end if;

  select s.id, s.status, s.applied_to_job into v_id, v_status, v_applied from public.job_progress_snapshots s
   where s.org_id = p_org and s.job_id = p_job and s.snapshot_version = p_version;
  if v_id is not null then
    -- A PENDING pin is an interrupted run (pinned, not yet confirmed): hand it back to resume.
    if v_status = 'PENDING' then return query select v_id, v_applied, false; return; end if;
    return query select v_id, false, true;
    return;
  end if;

  select max(s.snapshot_version) into v_max from public.job_progress_snapshots s where s.org_id = p_org and s.job_id = p_job;
  if v_max is not null and p_version < v_max then
    insert into public.job_progress_snapshots (org_id, location_id, job_id, snapshot_version, as_of_date, contract_value_cents,
      cost_estimate_cents, pct_complete, pending_co_value_cents, status, applied_to_job, source_event_id, source_ref, payload)
    values (p_org, j.location_id, p_job, p_version, p_as_of, p_contract, p_estimate, p_pct, p_pending_co, 'HISTORICAL', false,
            p_event, p_source_ref, p_payload)
    returning id into v_id;
    return query select v_id, false, false;
    return;
  end if;

  insert into public.job_progress_snapshots (org_id, location_id, job_id, snapshot_version, as_of_date, contract_value_cents,
    cost_estimate_cents, pct_complete, pending_co_value_cents, status, applied_to_job, prev_contract_cents, prev_estimate_cents,
    prev_pct_complete, source_event_id, source_ref, payload)
  values (p_org, j.location_id, p_job, p_version, p_as_of, p_contract, p_estimate, p_pct, p_pending_co, 'PENDING', true,
          j.contract_amount_cents, j.estimated_cost_cents, j.pct_complete, p_event, p_source_ref, p_payload)
  returning id into v_id;

  update core.jobs
     set contract_amount_cents = coalesce(p_contract, contract_amount_cents),
         estimated_cost_cents  = coalesce(p_estimate, estimated_cost_cents),
         pct_complete          = coalesce(round(p_pct * 10000) / 100, pct_complete),
         updated_at            = now()
   where id = p_job and org_id = p_org;
  return query select v_id, true, false;
end $$;

-- Mark a pinned snapshot applied (the event was processed).
create or replace function public.confirm_job_progress_snapshot(p_org uuid, p_snapshot uuid)
returns void
language sql security definer
set search_path = public, core, pg_temp
as $$
  update public.job_progress_snapshots set status = 'APPLIED'
   where org_id = p_org and id = p_snapshot and status = 'PENDING';
$$;

-- Undo a PENDING pin (the event was rejected after pinning): restore the job's previous
-- inputs when this snapshot is still the newest one that touched the job, then delete it.
create or replace function public.unpin_job_progress_snapshot(p_org uuid, p_snapshot uuid)
returns boolean
language plpgsql security definer
set search_path = public, core, pg_temp
as $$
declare s public.job_progress_snapshots%rowtype; v_newer int;
begin
  select * into s from public.job_progress_snapshots where org_id = p_org and id = p_snapshot for update;
  if s.id is null or s.status <> 'PENDING' then return false; end if;
  perform 1 from core.jobs where id = s.job_id and org_id = p_org for update;
  select count(*) into v_newer from public.job_progress_snapshots x
   where x.org_id = p_org and x.job_id = s.job_id and x.snapshot_version > s.snapshot_version and x.applied_to_job;
  if s.applied_to_job and v_newer = 0 then
    update core.jobs
       set contract_amount_cents = s.prev_contract_cents,
           estimated_cost_cents  = s.prev_estimate_cents,
           pct_complete          = s.prev_pct_complete,
           updated_at            = now()
     where id = s.job_id and org_id = p_org;
  end if;
  delete from public.job_progress_snapshots where id = s.id;
  return true;
end $$;

-- A4: rev-rec inputs AS OF a date, from the books — never the stale job columns alone.
--   actual cost  = opening (core.jobs.actual_cost_cents: the pre-Books balance an onboarding WIP
--                  import recorded; nothing maintains it afterwards) + Σ POSTED job-tagged COGS / OPEX
--                  GL lines dated ≤ as-of, excluding the WIP / rev-rec entries themselves
--                  (REV_REC_WIP, REV_REC_WIP_RECLASS, REV_REC — so the loss provision is not "cost");
--   billed       = opening (core.jobs.billed_to_date_cents) + Σ subtotal (gross of retainage, pre-tax)
--                  of the job's posted invoices dated ≤ as-of, excluding deposits and retainage releases
--                  (a release is not new billing);
--   contract / estimate / % complete = the newest pinned JOB_PROGRESS snapshot with as_of_date ≤ as-of (a PENDING pin
--                  is the one being recognized right now; a rejected event deletes its pin)
--                  (else the job columns) — so a closed month re-prints identically (G8).
-- SECURITY INVOKER: the caller's RLS applies (members read their org only).
create or replace function public.job_inputs_as_of(p_org uuid, p_job_ids uuid[], p_as_of date)
returns table (job_id uuid, opening_cost_cents bigint, gl_cost_cents bigint, actual_cost_cents bigint,
               opening_billed_cents bigint, invoiced_cents bigint, billed_to_date_cents bigint,
               contract_value_cents bigint, cost_estimate_cents bigint, pct_complete numeric, snapshot_version int)
language sql stable security invoker
set search_path = public, core, pg_temp
as $$
  select j.id,
         coalesce(j.actual_cost_cents, 0)::bigint,
         coalesce(c.v, 0)::bigint,
         (coalesce(j.actual_cost_cents, 0) + coalesce(c.v, 0))::bigint,
         coalesce(j.billed_to_date_cents, 0)::bigint,
         coalesce(b.v, 0)::bigint,
         (coalesce(j.billed_to_date_cents, 0) + coalesce(b.v, 0))::bigint,
         coalesce(s.contract_value_cents, j.contract_amount_cents)::bigint,
         coalesce(s.cost_estimate_cents, j.estimated_cost_cents)::bigint,
         case when s.id is not null and s.pct_complete is not null then round(s.pct_complete * 10000) / 100 else j.pct_complete end,
         s.snapshot_version
    from core.jobs j
    left join lateral (
      select sum(l.debit_cents - l.credit_cents) as v
        from public.gl_entry_lines l
        join public.gl_entries e on e.id = l.gl_entry_id
        join public.accounts a on a.id = l.account_id
       where l.org_id = p_org and l.job_id = j.id
         and e.status = 'POSTED' and e.entry_date <= p_as_of
         and coalesce(e.source_module, '') not in ('REV_REC_WIP', 'REV_REC_WIP_RECLASS', 'REV_REC')
         and a.account_type::text in ('COGS', 'OPEX')) c on true
    left join lateral (
      select sum(i.subtotal_cents) as v
        from public.invoices i
       where i.org_id = p_org and i.job_id = j.id
         and i.status not in ('DRAFT', 'VOIDED') and i.gl_entry_id is not null
         and i.invoice_date <= p_as_of
         and coalesce(i.billing_subtype, '') not in ('DEPOSIT', 'RETAINAGE_RELEASE')
         and coalesce(i.invoice_type, '') <> 'Deposit') b on true
    left join lateral (
      select x.* from public.job_progress_snapshots x
       where x.org_id = p_org and x.job_id = j.id and x.as_of_date <= p_as_of and x.status in ('PENDING', 'APPLIED', 'HISTORICAL')
       order by x.as_of_date desc, x.snapshot_version desc limit 1) s on true
   where j.org_id = p_org and j.id = any (p_job_ids);
$$;

-- ── §5 additive columns ──────────────────────────────────────────────────────
alter table public.job_cost_attributions add column if not exists commitment_line_ref uuid;   -- Projects pm.commitment_lines.id
alter table public.job_cost_attributions add column if not exists cost_code_ref text;         -- Projects cost code id / code
alter table public.job_cost_attributions add column if not exists vendor_id uuid;
alter table public.payroll_run_employees add column if not exists employer_benefits_cents bigint not null default 0;
comment on column public.payroll_run_employees.employer_benefits_cents is
  '194: employer-paid benefits for the employee in this run (part of the labor cost allocated to jobs; booked by the provider / register to the benefit expense roles).';

-- ── §6 A7: no job re-tag once the period is HARD_CLOSE ───────────────────────
create or replace function public.guard_job_tag_hard_close()
returns trigger
language plpgsql security definer
set search_path = public, core, pg_temp
as $$
declare v_closed boolean := false;
begin
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then return new; end if;
  if tg_table_name = 'gl_entry_lines' then
    if new.job_id is not distinct from old.job_id then return new; end if;
    select exists (
      select 1 from public.gl_entries e
        join public.fiscal_periods fp on fp.org_id = e.org_id and fp.location_id = e.location_id
                                     and e.entry_date between fp.start_date and fp.end_date
       where e.id = new.gl_entry_id and fp.status::text = 'HARD_CLOSE') into v_closed;
  elsif tg_table_name = 'bill_lines' then
    if new.job_id is not distinct from old.job_id then return new; end if;
    select exists (
      select 1 from public.bills b
        join public.fiscal_periods fp on fp.org_id = b.org_id and fp.location_id = b.location_id
                                     and b.bill_date between fp.start_date and fp.end_date
       where b.id = new.bill_id and fp.status::text = 'HARD_CLOSE') into v_closed;
  elsif tg_table_name = 'job_cost_entries' then
    if new.job_id is not distinct from old.job_id and new.cost_code_id is not distinct from old.cost_code_id then return new; end if;
    select exists (
      select 1 from core.jobs j
        join public.fiscal_periods fp on fp.org_id = j.org_id and fp.location_id = j.location_id
                                     and old.entry_date between fp.start_date and fp.end_date
       where j.id = old.job_id and fp.status::text = 'HARD_CLOSE') into v_closed;
  end if;
  if v_closed then
    raise exception 'JOB_TAG_LOCKED: the job / cost code on this line cannot change — its period is hard-closed. Post a reclass in an open period instead.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_job_tag_hard_close on public.gl_entry_lines;
create trigger trg_guard_job_tag_hard_close before update of job_id on public.gl_entry_lines
  for each row execute function public.guard_job_tag_hard_close();
drop trigger if exists trg_guard_job_tag_hard_close on public.bill_lines;
create trigger trg_guard_job_tag_hard_close before update of job_id on public.bill_lines
  for each row execute function public.guard_job_tag_hard_close();
drop trigger if exists trg_guard_job_tag_hard_close on public.job_cost_entries;
create trigger trg_guard_job_tag_hard_close before update of job_id, cost_code_id on public.job_cost_entries
  for each row execute function public.guard_job_tag_hard_close();

-- ── §7 G14: Projects owns job purchase orders ────────────────────────────────
create or replace function public.guard_job_po_projects()
returns trigger
language plpgsql security definer
set search_path = public, core, pg_temp
as $$
begin
  if new.job_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.job_id is not distinct from old.job_id then return new; end if;
  if exists (select 1 from core.organizations o where o.id = new.org_id and coalesce((o.entitlements ->> 'projects')::boolean, false)) then
    raise exception 'JOB_PO_OWNED_BY_PROJECTS: this organization uses Merit Projects — job purchase orders are created in Projects (Commitments); Books matches the bills to them.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_job_po_projects on public.purchase_order_lines;
create trigger trg_guard_job_po_projects before insert or update of job_id on public.purchase_order_lines
  for each row execute function public.guard_job_po_projects();

-- ── §8 Books tie-out views (Projects' "Ties to Books" commitments + time) ─────
create or replace view public.v_books_commitment_tieout with (security_invoker = on) as
with cm as (
  select c.org_id, c.location_id, c.job_id, count(*)::int as commitments, max(c.version) as latest_version
    from public.ap_commitments c group by c.org_id, c.location_id, c.job_id
), cv as (
  select c.org_id, c.job_id, coalesce(sum(l.amount_cents), 0)::bigint as committed_cents
    from public.ap_commitments c join public.ap_commitment_lines l on l.commitment_id = c.id and not l.removed
   group by c.org_id, c.job_id
), mt as (
  select c.org_id, c.job_id,
         coalesce(sum(m.amount_cents), 0)::bigint as matched_bill_cents,
         count(distinct m.bill_id)::int as matched_bills,
         count(distinct m.bill_id) filter (where b.status = 'ON_HOLD' and m.held_by_commitment)::int as bills_on_commitment_hold
    from public.bill_commitment_matches m
    join public.ap_commitments c on c.id = m.commitment_id
    join public.bills b on b.id = m.bill_id and b.status <> 'VOIDED'
   group by c.org_id, c.job_id
)
select cm.org_id, cm.location_id, cm.job_id, cm.commitments,
       coalesce(cv.committed_cents, 0)::bigint as committed_cents,
       coalesce(mt.matched_bill_cents, 0)::bigint as matched_bill_cents,
       coalesce(mt.matched_bills, 0)::int as matched_bills,
       coalesce(mt.bills_on_commitment_hold, 0)::int as bills_on_commitment_hold,
       cm.latest_version
  from cm
  left join cv on cv.org_id = cm.org_id and cv.job_id = cm.job_id
  left join mt on mt.org_id = cm.org_id and mt.job_id = cm.job_id;
comment on view public.v_books_commitment_tieout is
  '194: per job — commitments Books holds (from JOB_COMMITMENT), committed cents, bills matched to them (not voided). For pm.v_job_tieout ''commitments''.';

create or replace view public.v_books_labor_tieout with (security_invoker = on) as
select h.org_id, h.location_id, h.job_id,
       round(coalesce(sum(h.hours) filter (where h.status = 'APPROVED'), 0) * 100)::bigint                        as approved_hours_x100,
       round(coalesce(sum(h.hours) filter (where h.status = 'APPROVED' and h.allocation_id is not null), 0) * 100)::bigint
                                                                                                                  as payroll_hours_x100,
       coalesce(sum(h.allocated_cents) filter (where h.allocation_id is not null), 0)::bigint                     as labor_cost_cents,
       coalesce(sum(h.accrued_cents) filter (where h.status = 'APPROVED' and h.allocation_id is null), 0)::bigint  as accrued_open_cents,
       count(*) filter (where h.status = 'APPROVED' and h.allocation_id is null)::int                            as entries_awaiting_payroll,
       count(*) filter (where h.status = 'WITHDRAWN' and h.allocation_id is not null)::int                       as withdrawn_after_payroll
  from public.job_labor_hours h
 group by h.org_id, h.location_id, h.job_id;
comment on view public.v_books_labor_tieout is
  '194: per job — approved hours Books received (JOB_TIME), hours costed by a posted payroll run (× 100, Projects'' unit), labor cost allocated, open accrual. For pm.v_job_tieout ''time''.';

-- ── §9 RLS + grants ──────────────────────────────────────────────────────────
do $$
declare t text; p record;
begin
  foreach t in array array['ap_commitments','ap_commitment_versions','ap_commitment_lines','bill_commitment_matches',
                           'job_labor_settings','job_labor_accruals','job_labor_allocations','job_labor_allocation_lines',
                           'job_labor_hours','job_progress_snapshots'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t
                and policyname not in ('member_read', 'service_all', 'client_scope_rls', 'projects_only_seat_deny') loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'member_read') then
      execute format('create policy member_read on public.%I for select to authenticated using (org_id = public.get_org_id())', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'service_all') then
      execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    end if;
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

revoke all on public.v_books_commitment_tieout, public.v_books_labor_tieout from public, anon;
grant select on public.v_books_commitment_tieout, public.v_books_labor_tieout to authenticated, service_role;

-- updated_at maintenance (when the shared trigger function exists).
do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    foreach t in array array['ap_commitments','ap_commitment_lines','bill_commitment_matches','job_labor_settings',
                             'job_labor_accruals','job_labor_allocations','job_labor_hours'] loop
      if not exists (select 1 from pg_trigger where tgname = 'trg_' || t || '_updated') then
        execute format('create trigger %I before update on public.%I for each row execute function set_updated_at()',
                       'trg_' || t || '_updated', t);
      end if;
    end loop;
  end if;
end $$;

-- M1: functions are never member-callable (the pin RPCs are service-role; the guards are triggers).
revoke all on function public.pin_job_progress_snapshot(uuid, uuid, int, date, bigint, bigint, numeric, bigint, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.confirm_job_progress_snapshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.unpin_job_progress_snapshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.guard_job_tag_hard_close() from public, anon, authenticated;
revoke all on function public.guard_job_po_projects() from public, anon, authenticated;
grant execute on function public.pin_job_progress_snapshot(uuid, uuid, int, date, bigint, bigint, numeric, bigint, uuid, text, jsonb) to service_role;
grant execute on function public.confirm_job_progress_snapshot(uuid, uuid) to service_role;
grant execute on function public.unpin_job_progress_snapshot(uuid, uuid) to service_role;
grant execute on function public.guard_job_tag_hard_close() to service_role;
grant execute on function public.guard_job_po_projects() to service_role;
-- job_inputs_as_of is SECURITY INVOKER (RLS applies): members may call it.
revoke all on function public.job_inputs_as_of(uuid, uuid[], date) from public, anon;
grant execute on function public.job_inputs_as_of(uuid, uuid[], date) to authenticated, service_role;

-- ── §10 client scope + Projects-only seat deny (guarded: absent in the replay) ─
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['ap_commitments','ap_commitment_versions','ap_commitment_lines','bill_commitment_matches',
                             'job_labor_settings','job_labor_accruals','job_labor_allocations','job_labor_allocation_lines',
                             'job_labor_hours','job_progress_snapshots'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;

-- End migration 194.

-- ── §99 field masks: per-person employer benefits is compensation (lead, integration) ──
-- payroll_run_employees is column-revoked for members (170 §2); the new column joins the
-- comp class so members can't select it, then the mask function re-grants every other column.
do $$ begin
  if to_regclass('core.field_class_columns') is not null then
    -- Security review H1: per-employee labor cost on the job-labor tables is compensation too
    -- (wages / tax / benefits / standard rate per person per job). Members read hours and status;
    -- the per-person amounts and the employee link are server-only (lib/projects-seam/status.ts
    -- reads per-job aggregates through the service role; v_books_labor_tieout aggregates per job).
    insert into core.field_class_columns (field_class, schema_name, table_name, column_name, enforcement, note) values
      ('comp', 'public', 'payroll_run_employees', 'employer_benefits_cents', 'column_revoke',
       'Per-person employer benefits (column-revoked for members; server reads only, mig 194)'),
      ('comp', 'public', 'job_labor_allocation_lines', 'employee_id', 'column_revoke', 'Per-person job labor (mig 194 H1)'),
      ('comp', 'public', 'job_labor_allocation_lines', 'wages_cents', 'column_revoke', 'Per-person job labor wages (mig 194 H1)'),
      ('comp', 'public', 'job_labor_allocation_lines', 'employer_tax_cents', 'column_revoke', 'Per-person job labor employer tax (mig 194 H1)'),
      ('comp', 'public', 'job_labor_allocation_lines', 'benefits_cents', 'column_revoke', 'Per-person job labor benefits (mig 194 H1)'),
      ('comp', 'public', 'job_labor_allocation_lines', 'amount_cents', 'column_revoke', 'Per-person job labor cost (mig 194 H1)'),
      ('comp', 'public', 'job_labor_allocation_lines', 'accrual_reversed_cents', 'column_revoke', 'Per-person accrual true-up (mig 194 H1)'),
      ('comp', 'public', 'job_labor_hours', 'employee_id', 'column_revoke', 'Per-person job hours link (mig 194 H1)'),
      ('comp', 'public', 'job_labor_hours', 'standard_rate_cents', 'column_revoke', 'Per-person standard rate (mig 194 H1)'),
      ('comp', 'public', 'job_labor_hours', 'allocated_cents', 'column_revoke', 'Per-person allocated labor cost (mig 194 H1)'),
      ('comp', 'public', 'job_labor_hours', 'accrued_cents', 'column_revoke', 'Per-person accrued labor cost (mig 194 H1)')
    on conflict (schema_name, table_name, column_name) do update
      set field_class = excluded.field_class, enforcement = excluded.enforcement, note = excluded.note;
  end if;
  if to_regprocedure('core.apply_field_column_masks()') is not null then
    perform core.apply_field_column_masks();
  end if;
end $$;

-- ── §100 H1: v_books_labor_tieout reads masked columns → definer view, pinned ──
-- The per-job aggregate is safe to show (it is the job's labor cost, already in the GL by job);
-- the per-person columns it sums are column-revoked above, so a security_invoker view would
-- fail for members. It runs as its owner instead, pinned in the WHERE to exactly what the
-- invoker's RLS would have allowed: the caller's org (get_org_id), their client scope
-- (client_scope_bypass / accessible_location_ids, 163), and — when Projects' 1110 seat
-- function exists — never a Projects-only seat. The service role sees every row (crons /
-- Projects' own definer views read it with the end user's JWT, so the pin still applies).
-- security_barrier keeps a caller's predicate from being pushed below the pin.
do $$
declare v_seat text := '';
begin
  if to_regprocedure('core.is_projects_only_seat()') is not null then
    v_seat := ' and not coalesce(core.is_projects_only_seat(), false)';
  end if;
  execute format($v$
    create or replace view public.v_books_labor_tieout with (security_barrier = true) as
    select h.org_id, h.location_id, h.job_id,
           round(coalesce(sum(h.hours) filter (where h.status = 'APPROVED'), 0) * 100)::bigint                        as approved_hours_x100,
           round(coalesce(sum(h.hours) filter (where h.status = 'APPROVED' and h.allocation_id is not null), 0) * 100)::bigint
                                                                                                                      as payroll_hours_x100,
           coalesce(sum(h.allocated_cents) filter (where h.allocation_id is not null), 0)::bigint                     as labor_cost_cents,
           coalesce(sum(h.accrued_cents) filter (where h.status = 'APPROVED' and h.allocation_id is null), 0)::bigint  as accrued_open_cents,
           count(*) filter (where h.status = 'APPROVED' and h.allocation_id is null)::int                            as entries_awaiting_payroll,
           count(*) filter (where h.status = 'WITHDRAWN' and h.allocation_id is not null)::int                       as withdrawn_after_payroll
      from public.job_labor_hours h
     where core.client_scope_is_service()
        or (h.org_id = public.get_org_id()
            and ((select core.client_scope_bypass()) or h.location_id in (select core.accessible_location_ids()))%s)
     group by h.org_id, h.location_id, h.job_id
  $v$, v_seat);
end $$;
-- create or replace keeps the old reloptions: set them explicitly (idempotent).
alter view public.v_books_labor_tieout set (security_invoker = false, security_barrier = true);
comment on view public.v_books_labor_tieout is
  '194: per job — approved hours Books received (JOB_TIME), hours costed by a posted payroll run (× 100, Projects'' unit), labor cost allocated, open accrual. For pm.v_job_tieout ''time''. Definer view (H1): per-person columns are column-revoked; rows pinned to get_org_id() + client scope (+ no Projects-only seat).';
revoke all on public.v_books_labor_tieout from public, anon;
grant select on public.v_books_labor_tieout to authenticated, service_role;
