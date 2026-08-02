-- ============================================================================
-- MeritProjects — G7 billing engines :: Schedule of Values, retainage, allowances
-- Migration 1004 :: schema `proj`
--
-- Adds the AIA-style progress-billing spine on top of the G4 billing_requests /
-- G5 commitments seam. Everything here produces ordinary proj.billing_requests
-- (DRAFT) that the EXISTING, already-hardened money route
-- (proj.approve_and_emit_billing → JOB_BILLING) emits. The frozen v3 seam event
-- is UNCHANGED: SOV / retainage bills are just normal billing_requests whose
-- lines sum to the net payable. One additive-nullable payload key
-- (`retainage_cents`) is written for downstream reporting only.
--
-- Model:
--   * A job's contract carries a retention_pct (retainage rate) + payer/financing.
--   * A Schedule of Values (SOV) is versioned per job (revised by change orders).
--     The ACTIVE version's lines carry scheduled_value + pct_complete.
--   * generate_sov_billing() turns "% complete this period" into a DRAFT billing
--     request: one positive line per SOV line for the incremental earned amount
--     (scheduled*pct − previously billed on that line), plus one negative
--     "retainage withheld" line, and records the withheld amount in the retainage
--     ledger. Net of lines = amount actually invoiced this application.
--   * release_retainage() bills accumulated retainage back at closeout.
--   * Allowances track owner allowances and their drawdown.
--
-- All SECURITY DEFINER functions are org-scoped from the first fetch
-- (`and org_id = public.get_org_id()`) per the session-43 hotfix (migration 1006):
-- a definer function bypasses RLS, so every by-id/by-job read is org-filtered so a
-- cross-org id resolves to "not found".
--
-- Idempotent: create-if-not-exists / create-or-replace / guarded constraint swaps.
-- ============================================================================

-- ── 1. Contract: retainage rate + payer / financing ─────────────────────────
alter table proj.contracts add column if not exists retention_pct numeric(5,4) not null default 0;
alter table proj.contracts add column if not exists retention_cap_cents bigint;      -- optional ceiling on cumulative retainage
alter table proj.contracts add column if not exists payer_type text;                  -- OWNER | LENDER | INSURANCE | TENANT | SELF
alter table proj.contracts add column if not exists lender_name text;
alter table proj.contracts add column if not exists financing_notes text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='contracts_retention_pct_range') then
    alter table proj.contracts add constraint contracts_retention_pct_range
      check (retention_pct >= 0 and retention_pct <= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname='contracts_payer_type_check') then
    alter table proj.contracts add constraint contracts_payer_type_check
      check (payer_type is null or payer_type in ('OWNER','LENDER','INSURANCE','TENANT','SELF'));
  end if;
end $$;

-- ── 2. billing_requests: extend billing_type + carry the retainage withheld ──
alter table proj.billing_requests add column if not exists retainage_cents bigint not null default 0;

-- widen the billing_type domain: add SOV (progress from schedule of values) and
-- RETAINAGE_RELEASE (closeout retainage bill). Guarded swap keeps it idempotent.
do $$ begin
  if exists (select 1 from pg_constraint where conname='billing_requests_billing_type_check') then
    alter table proj.billing_requests drop constraint billing_requests_billing_type_check;
  end if;
  alter table proj.billing_requests add constraint billing_requests_billing_type_check
    check (billing_type in ('MILESTONE','PROGRESS','TIME_MATERIALS','DRAW','SOV','RETAINAGE_RELEASE','ALLOWANCE'));
end $$;

-- ── 3. billing_request_lines: link a line back to its SOV line + tag its role ─
alter table proj.billing_request_lines add column if not exists sov_line_id uuid;
alter table proj.billing_request_lines add column if not exists line_type text not null default 'STANDARD';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='billing_request_lines_line_type_check') then
    alter table proj.billing_request_lines add constraint billing_request_lines_line_type_check
      check (line_type in ('STANDARD','RETAINAGE','ALLOWANCE'));
  end if;
end $$;
create index if not exists idx_brl_sov_line on proj.billing_request_lines(sov_line_id) where sov_line_id is not null;

-- ── 4. Schedule of Values — versions + lines ────────────────────────────────
create table if not exists proj.sov_versions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  job_id            uuid not null,
  contract_id       uuid,
  version           integer not null,
  status            text not null default 'DRAFT',        -- DRAFT | ACTIVE | SUPERSEDED
  memo              text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint sov_versions_status_check check (status in ('DRAFT','ACTIVE','SUPERSEDED')),
  constraint sov_versions_job_version_uniq unique (org_id, job_id, version)
);
-- at most one ACTIVE version per job
create unique index if not exists uq_sov_active_per_job
  on proj.sov_versions(org_id, job_id) where status = 'ACTIVE';

create table if not exists proj.sov_lines (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null,
  sov_version_id        uuid not null references proj.sov_versions(id) on delete cascade,
  line_no               integer not null,
  cost_code_id          uuid,
  description           text not null,
  scheduled_value_cents bigint not null default 0,
  pct_complete          numeric(5,4) not null default 0,   -- 0..1, work-in-place this-date
  retainage_pct         numeric(5,4),                       -- per-line override of contract retention_pct
  sort_order            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint sov_lines_pct_range check (pct_complete >= 0 and pct_complete <= 1),
  constraint sov_lines_retainage_range check (retainage_pct is null or (retainage_pct >= 0 and retainage_pct <= 1)),
  constraint sov_lines_line_no_uniq unique (sov_version_id, line_no)
);
create index if not exists idx_sov_lines_version on proj.sov_lines(sov_version_id);

-- ── 5. Retainage ledger ─────────────────────────────────────────────────────
create table if not exists proj.retainage_ledger (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  job_id              uuid not null,
  billing_request_id  uuid,
  entry_type          text not null,                        -- HELD | RELEASED
  amount_cents        bigint not null,                      -- positive magnitude
  memo                text,
  created_at          timestamptz not null default now(),
  constraint retainage_entry_type_check check (entry_type in ('HELD','RELEASED')),
  constraint retainage_amount_positive check (amount_cents >= 0)
);
create index if not exists idx_retainage_job on proj.retainage_ledger(org_id, job_id);

-- ── 6. Allowances ───────────────────────────────────────────────────────────
create table if not exists proj.allowances (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  job_id           uuid not null,
  cost_code_id     uuid,
  description      text not null,
  allowance_cents  bigint not null default 0,
  consumed_cents   bigint not null default 0,
  status           text not null default 'OPEN',            -- OPEN | CLOSED
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint allowances_status_check check (status in ('OPEN','CLOSED')),
  constraint allowances_amounts_nonneg check (allowance_cents >= 0 and consumed_cents >= 0)
);
create index if not exists idx_allowances_job on proj.allowances(org_id, job_id);

-- ── 7. RLS (org isolation, mirrors the rest of proj) ────────────────────────
alter table proj.sov_versions     enable row level security;
alter table proj.sov_lines        enable row level security;
alter table proj.retainage_ledger enable row level security;
alter table proj.allowances       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sov_versions','sov_lines','retainage_ledger','allowances'] loop
    if not exists (select 1 from pg_policies where schemaname='proj' and tablename=t and policyname='org_isolation') then
      execute format(
        'create policy org_isolation on proj.%I using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
end $$;

-- ── 8. Reporting views (security_invoker: run as caller, honor RLS) ──────────
create or replace view proj.v_sov_status
  with (security_invoker = true) as
select
  v.id                     as sov_version_id,
  v.org_id, v.job_id, v.contract_id, v.version, v.status,
  count(l.id)              as line_count,
  coalesce(sum(l.scheduled_value_cents), 0)                                   as scheduled_total_cents,
  coalesce(sum(round(l.scheduled_value_cents * l.pct_complete)), 0)::bigint   as earned_to_date_cents,
  coalesce(sum(round(l.scheduled_value_cents * (1 - l.pct_complete))), 0)::bigint as remaining_cents,
  case when coalesce(sum(l.scheduled_value_cents),0) > 0
    then round(sum(round(l.scheduled_value_cents * l.pct_complete))::numeric
             / sum(l.scheduled_value_cents)::numeric, 4)
    else 0 end             as pct_complete_weighted
from proj.sov_versions v
left join proj.sov_lines l on l.sov_version_id = v.id
group by v.id, v.org_id, v.job_id, v.contract_id, v.version, v.status;

create or replace view proj.v_job_retainage
  with (security_invoker = true) as
select
  org_id, job_id,
  coalesce(sum(amount_cents) filter (where entry_type='HELD'), 0)     as held_cents,
  coalesce(sum(amount_cents) filter (where entry_type='RELEASED'), 0) as released_cents,
  coalesce(sum(amount_cents) filter (where entry_type='HELD'), 0)
    - coalesce(sum(amount_cents) filter (where entry_type='RELEASED'), 0) as outstanding_cents
from proj.retainage_ledger
group by org_id, job_id;

create or replace view proj.v_allowance_status
  with (security_invoker = true) as
select
  id, org_id, job_id, cost_code_id, description, status,
  allowance_cents, consumed_cents,
  (allowance_cents - consumed_cents) as remaining_cents,
  case when allowance_cents > 0
    then round(consumed_cents::numeric / allowance_cents::numeric, 4) else 0 end as pct_consumed
from proj.allowances;

-- ── 9. activate_sov_version — flip one version ACTIVE, supersede the rest ────
create or replace function proj.activate_sov_version(p_version_id uuid, p_actor text default null)
returns proj.sov_versions
language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare v proj.sov_versions%rowtype;
begin
  select * into v from proj.sov_versions where id = p_version_id and org_id = public.get_org_id() for update;
  if not found then raise exception 'SOV version % not found', p_version_id; end if;
  -- supersede any currently-active version on the same job
  update proj.sov_versions
     set status = 'SUPERSEDED', updated_at = now()
   where org_id = v.org_id and job_id = v.job_id and status = 'ACTIVE' and id <> v.id;
  update proj.sov_versions
     set status = 'ACTIVE', updated_at = now()
   where id = v.id
  returning * into v;
  return v;
end $fn$;

-- ── 10. generate_sov_billing — the progress-billing engine ──────────────────
-- Builds a DRAFT proj.billing_requests (type SOV) from the job's ACTIVE SOV:
--   per SOV line: this_app = max(0, round(scheduled*pct) − billed-to-date-on-line)
--   plus one negative "Retainage withheld" line at the effective retention pct,
--   and a HELD entry in the retainage ledger. Net of lines = invoiced this app.
-- Returns the new billing_request id (raises if there is nothing to bill).
create or replace function proj.generate_sov_billing(
  p_job_id uuid, p_occurred_on date default current_date, p_created_by text default null)
returns uuid
language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare
  v_org uuid; v_loc uuid; v_contract_ret numeric(5,4); v_ver uuid;
  v_req uuid := gen_random_uuid(); v_srcref text;
  v_gross bigint := 0; v_retain bigint := 0; v_sort int := 0;
  r record;
begin
  -- org-scoped from the job (definer bypasses RLS)
  select j.org_id, j.location_id into v_org, v_loc
  from core.jobs j where j.id = p_job_id and j.org_id = public.get_org_id();
  if v_org is null then raise exception 'Job % not found', p_job_id; end if;

  select coalesce(c.retention_pct, 0) into v_contract_ret
  from proj.contracts c where c.job_id = p_job_id and c.org_id = v_org;

  select id into v_ver from proj.sov_versions
   where job_id = p_job_id and org_id = v_org and status = 'ACTIVE';
  if v_ver is null then raise exception 'PRECONDITION_NO_ACTIVE_SOV: job % has no ACTIVE schedule of values', p_job_id; end if;

  v_srcref := 'SOV:' || p_job_id::text || ':' || p_occurred_on::text || ':' || substr(gen_random_uuid()::text,1,8);

  insert into proj.billing_requests
    (id, org_id, job_id, location_id, billing_type, status, source_ref, occurred_on, memo, created_by, created_at, updated_at)
  values
    (v_req, v_org, p_job_id, v_loc, 'SOV', 'DRAFT', v_srcref, p_occurred_on,
     'Progress billing from schedule of values', p_created_by, now(), now());

  -- positive earned line per SOV line with a positive incremental amount
  for r in
    select l.id, l.line_no, l.description, l.cost_code_id, l.scheduled_value_cents, l.pct_complete,
           coalesce(l.retainage_pct, v_contract_ret) as eff_ret,
           greatest(0,
             round(l.scheduled_value_cents * l.pct_complete)::bigint
             - coalesce((
                 select sum(bl.amount_cents)
                 from proj.billing_request_lines bl
                 join proj.billing_requests br on br.id = bl.billing_request_id
                 where bl.sov_line_id = l.id
                   and br.status in ('DRAFT','EMITTED','PROCESSED','UNISSUED')  -- count open DRAFTs too: prevents a second overlapping draft double-billing the same progress (security LOW-1)
               ), 0)
           ) as this_app
    from proj.sov_lines l
    where l.sov_version_id = v_ver
    order by l.sort_order, l.line_no
  loop
    if r.this_app > 0 then
      insert into proj.billing_request_lines
        (id, org_id, billing_request_id, description, amount_cents, item_id, sov_line_id, line_type, sort_order, created_at)
      values
        (gen_random_uuid(), v_org, v_req,
         r.description || ' (' || to_char(r.pct_complete*100,'FM990.0') || '%)',
         r.this_app, null, r.id, 'STANDARD', v_sort, now());
      v_gross  := v_gross + r.this_app;
      v_retain := v_retain + round(r.this_app * r.eff_ret)::bigint;
      v_sort := v_sort + 1;
    end if;
  end loop;

  if v_gross <= 0 then
    -- nothing earned since last application: roll back the empty request
    delete from proj.billing_requests where id = v_req;
    raise exception 'PRECONDITION_NOTHING_TO_BILL: no incremental progress to bill on job %', p_job_id;
  end if;

  if v_retain > 0 then
    insert into proj.billing_request_lines
      (id, org_id, billing_request_id, description, amount_cents, item_id, sov_line_id, line_type, sort_order, created_at)
    values
      (gen_random_uuid(), v_org, v_req,
       'Retainage withheld', -v_retain, null, null, 'RETAINAGE', v_sort, now());
    insert into proj.retainage_ledger (id, org_id, job_id, billing_request_id, entry_type, amount_cents, memo, created_at)
    values (gen_random_uuid(), v_org, p_job_id, v_req, 'HELD', v_retain, 'SOV progress application', now());
  end if;

  update proj.billing_requests set retainage_cents = v_retain, updated_at = now() where id = v_req;
  return v_req;
end $fn$;

-- ── 11. release_retainage — bill accumulated retainage at closeout ──────────
create or replace function proj.release_retainage(
  p_job_id uuid, p_amount_cents bigint default null,
  p_occurred_on date default current_date, p_created_by text default null)
returns uuid
language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare
  v_org uuid; v_loc uuid; v_out bigint; v_amt bigint; v_req uuid := gen_random_uuid(); v_srcref text;
begin
  select j.org_id, j.location_id into v_org, v_loc
  from core.jobs j where j.id = p_job_id and j.org_id = public.get_org_id();
  if v_org is null then raise exception 'Job % not found', p_job_id; end if;

  select coalesce(sum(amount_cents) filter (where entry_type='HELD'),0)
       - coalesce(sum(amount_cents) filter (where entry_type='RELEASED'),0)
    into v_out from proj.retainage_ledger where job_id = p_job_id and org_id = v_org;
  v_out := coalesce(v_out, 0);
  if v_out <= 0 then raise exception 'PRECONDITION_NO_RETAINAGE: job % has no outstanding retainage', p_job_id; end if;

  v_amt := coalesce(p_amount_cents, v_out);
  if v_amt <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: release amount must be > 0'; end if;
  if v_amt > v_out then raise exception 'PRECONDITION_OVER_RELEASE: release % exceeds outstanding retainage %', v_amt, v_out; end if;

  v_srcref := 'RETREL:' || p_job_id::text || ':' || p_occurred_on::text || ':' || substr(gen_random_uuid()::text,1,8);

  insert into proj.billing_requests
    (id, org_id, job_id, location_id, billing_type, status, source_ref, occurred_on, memo, created_by, created_at, updated_at)
  values
    (v_req, v_org, p_job_id, v_loc, 'RETAINAGE_RELEASE', 'DRAFT', v_srcref, p_occurred_on,
     'Retainage release', p_created_by, now(), now());
  insert into proj.billing_request_lines
    (id, org_id, billing_request_id, description, amount_cents, item_id, sov_line_id, line_type, sort_order, created_at)
  values
    (gen_random_uuid(), v_org, v_req, 'Retainage release', v_amt, null, null, 'RETAINAGE', 0, now());
  insert into proj.retainage_ledger (id, org_id, job_id, billing_request_id, entry_type, amount_cents, memo, created_at)
  values (gen_random_uuid(), v_org, p_job_id, v_req, 'RELEASED', v_amt, 'Retainage release', now());

  return v_req;
end $fn$;

-- ── 12. Additive seam key: carry retainage_cents on the JOB_BILLING payload ──
-- The frozen event shape is unchanged; this only adds ONE nullable key so Books
-- can (optionally) split the withheld portion. Wire/direction/lifecycle intact.
create or replace function proj.approve_and_emit_billing(p_request_id uuid, p_approver text default null::text)
returns uuid language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare
  br proj.billing_requests%rowtype; v_cust uuid; v_lines jsonb; v_total bigint;
  v_event uuid := gen_random_uuid(); v_payload jsonb; v_precond text;
begin
  select * into br from proj.billing_requests where id = p_request_id and org_id = public.get_org_id() for update;
  if not found then raise exception 'Billing request % not found', p_request_id; end if;
  if br.status not in ('DRAFT','REJECTED') then raise exception 'Billing request % is %; only DRAFT/REJECTED can be emitted', p_request_id, br.status; end if;
  select customer_id into v_cust from core.jobs where id = br.job_id;
  if v_cust is null then raise exception 'PRECONDITION_NO_CUSTOMER: job % has no customer_id; set one before billing', br.job_id; end if;
  select jsonb_agg(jsonb_build_object('description', l.description, 'amount_cents', l.amount_cents, 'item_id', l.item_id) order by l.sort_order), coalesce(sum(l.amount_cents), 0)
  into v_lines, v_total from proj.billing_request_lines l where l.billing_request_id = br.id;
  if v_lines is null then raise exception 'PRECONDITION_NO_LINES: billing request % has no lines', br.id; end if;
  if v_total <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: total must be > 0 (got %)', v_total; end if;
  v_precond := proj.draw_precondition_met(br.id);
  if v_precond is not null then raise exception '%: billing request % blocked by external gate / compliance', v_precond, br.id; end if;
  if not proj.books_present(br.org_id) then
    update proj.billing_requests set status='UNISSUED', approved_by=p_approver, approved_at=now(), rejection_reason=null, updated_at=now() where id=br.id;
    return null;
  end if;
  v_payload := jsonb_build_object('event_id', v_event, 'event_type','JOB_BILLING', 'source_module','PROJECTS',
    'org_id', br.org_id, 'location_id', br.location_id, 'job_id', br.job_id, 'billing_type', br.billing_type,
    'occurred_on', to_char(br.occurred_on,'YYYY-MM-DD'), 'source_ref', br.source_ref, 'memo', br.memo,
    'retainage_cents', br.retainage_cents, 'lines', v_lines);
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (br.org_id, v_event, 'JOB_BILLING', 'PROJECTS', v_payload, br.occurred_on, 'pending');
  update proj.billing_requests set status='EMITTED', event_id=v_event, approved_by=p_approver, approved_at=now(), rejection_reason=null, updated_at=now() where id=br.id;
  return v_event;
end $fn$;
