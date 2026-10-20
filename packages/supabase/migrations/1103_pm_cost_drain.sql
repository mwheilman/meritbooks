-- ============================================================================
-- 1103 · Merit Projects v2 — money spine, part 2: JOB_COST in (Books -> Projects)
--
-- Binding inputs: blueprint D8 (Books is the SOLE JOB_COST originator), §6, §7; review 03
-- §1.3 (drain as built), §3.6 (additive JOB_COST keys), §4 G4/G15; review 05 §3.1, §4.6.
-- Port of the legacy proj.drain_job_costs semantics (066 → 1003 → 1005), rebuilt:
--   * keyed on (org_id, source_ref): one projection row per underlying cost; each lifecycle
--     event (PENDING -> CLEARED -> VOIDED) REPLACES the row's state — transitions are never summed
--   * event_id dedupe ledger (pm.job_cost_applied_events): an event applies at most once
--   * monotonic guard on (core.events.created_at, lifecycle rank): an older / out-of-order
--     event is recorded as STALE and never regresses the projection
--   * FOR UPDATE SKIP LOCKED over core.events + a per-org advisory lock, so two drains (or a
--     drain and a rebuild) never split one org's events between them
--   * a malformed event is REJECTED in its own subtransaction (it cannot abort the batch)
--   * enrichment from additive payload keys: cost_code_id | cost_code, commitment_line_id,
--     vendor_id, description (unresolvable values are kept verbatim in *_ref columns and the
--     cost lands unassigned); commitment drawdown = pm.commitment_lines.billed_cents
--   * replayable: pm.rebuild_job_costs(org) re-derives the projection from every JOB_COST row
--
-- core.events.status is shared with Books. This migration writes status ONLY on JOB_COST
-- rows (Projects is their sole consumer — the legacy convention) and never on any other type.
-- The advisory lock key 'pm.job_cost_drain:{org}' is the cutover contract: the legacy
-- proj.drain_job_costs must be revoked, or take the same lock, before pm's drain is scheduled.
--
-- Objects
--   tables : job_costs, job_cost_applied_events, event_cursor
--   service_role only: drain_job_costs(org|null), rebuild_job_costs(org), run_seam_cycle(org|null)
--   member : refresh_job_costs()  (caller's org only; advisory try-lock = rate limit)
--   internal: job_cost_drain_key, apply_job_cost_event, drain_job_costs_locked,
--             refresh_commitment_line_billed
--   views  : v_cost_code_status, v_job_financials, v_seam_health
-- Idempotent: safe to run twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Projection + ledgers
-- ----------------------------------------------------------------------------
create table if not exists pm.job_costs (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  location_id          uuid,
  department_id        uuid,
  source_ref           text not null,                 -- the cost identity (bill line / bank txn / timesheet ...)
  cost_type            text check (cost_type is null or cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  amount_cents         bigint not null default 0,
  lifecycle            text not null check (lifecycle in ('PENDING','CLEARED','VOIDED')),
  gate                 text,                          -- PAYABLE_APPROVAL | BANKFEED_CATEGORIZATION | TIMESHEET_PAYROLL
  occurred_on          date,
  gl_entry_id          uuid,                          -- Books posting ref (traceability only)
  cost_code_id         uuid,                          -- null = unassigned
  cost_code_ref        text,                          -- payload cost_code / cost_code_id that did not resolve
  commitment_line_id   uuid,
  commitment_line_ref  text,                          -- payload commitment_line_id that did not resolve
  vendor_id            uuid,
  description          text,
  memo                 text,
  last_event_id        uuid not null,
  last_event_at        timestamptz not null,          -- monotonic guard (core.events.created_at of the newest applied event)
  last_lifecycle_rank  smallint not null,             -- tie-break: PENDING 1 < CLEARED 2 < VOIDED 3
  first_event_at       timestamptz not null,
  applied_events       int not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_line_id) references pm.commitment_lines (org_id, id) deferrable initially immediate
);
create index if not exists pm_job_costs_job_idx on pm.job_costs (org_id, job_id, lifecycle);
create index if not exists pm_job_costs_cc_idx on pm.job_costs (org_id, job_id, cost_code_id);
create index if not exists pm_job_costs_cl_idx on pm.job_costs (org_id, commitment_line_id) where commitment_line_id is not null;

-- An event_id is applied at most once, ever (APPLIED or STALE). REJECTED rows are kept for
-- audit and re-evaluated if the event is ever re-queued.
create table if not exists pm.job_cost_applied_events (
  org_id            uuid not null references core.organizations(id) on delete cascade,
  event_id          uuid not null,
  source_ref        text,
  lifecycle         text,
  outcome           text not null check (outcome in ('APPLIED','STALE','REJECTED')),
  error             text,
  event_created_at  timestamptz,
  applied_at        timestamptz not null default now(),
  primary key (org_id, event_id)
);
create index if not exists pm_jcae_source_idx on pm.job_cost_applied_events (org_id, source_ref);

-- Consumer high-water mark + last run stats (feeds v_seam_health; the drain itself is
-- status-driven so it also picks up late-inserted rows behind the mark).
create table if not exists pm.event_cursor (
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  consumer               text not null check (consumer in ('JOB_COST')),
  last_event_created_at  timestamptz,
  last_event_id          uuid,
  last_run_at            timestamptz,
  last_run_kind          text check (last_run_kind is null or last_run_kind in ('SERVICE','MEMBER','REBUILD')),
  last_run               jsonb,
  runs                   bigint not null default 0,
  primary key (org_id, consumer)
);

create or replace trigger trg_touch_updated_at before update on pm.job_costs
  for each row execute function pm.tg_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Internal helpers
-- ----------------------------------------------------------------------------
create or replace function pm.job_cost_drain_key(p_org uuid) returns bigint
language sql immutable
as $$ select hashtextextended('pm.job_cost_drain:' || p_org::text, 0) $$;

-- billed_cents = Σ landed cost (PENDING or CLEARED) on the line. Recomputed, never incremented.
create or replace function pm.refresh_commitment_line_billed(p_org uuid, p_line uuid) returns void
language sql security definer
set search_path = pm, core, public
as $$
  update pm.commitment_lines cl
     set billed_cents = s.billed
    from (select coalesce(sum(j.amount_cents), 0)::bigint as billed from pm.job_costs j
          where j.org_id = p_org and j.commitment_line_id = p_line and j.lifecycle in ('PENDING','CLEARED')) s
   where cl.org_id = p_org and cl.id = p_line and cl.billed_cents is distinct from s.billed
$$;

-- Apply one JOB_COST event to the projection. Returns 'APPLIED' | 'STALE' | 'REJECTED:<reason>'.
-- Never touches core.events (the caller does) and never raises for a bad payload.
create or replace function pm.apply_job_cost_event(p_row core.events) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  p        jsonb := p_row.payload;
  c_uuid   constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_src    text; v_life text; v_rank smallint; v_amtn numeric; v_amt bigint; v_job uuid; v_jloc uuid;
  v_loc    uuid; v_dept uuid; v_ct text; v_gate text; v_occ date; v_gl uuid; v_memo text; v_desc text;
  v_cc     uuid; v_cc_ref text; v_cl uuid; v_cl_ref text; v_vendor uuid;
  v_prev_cl uuid; v_new_cl uuid; v_n int;
begin
  -- ---- validate (any failure = REJECTED with the reason) ----
  begin
    if p_row.event_type <> 'JOB_COST' then raise exception 'not a JOB_COST event'; end if;
    v_src := nullif(btrim(p ->> 'source_ref'), '');
    if v_src is null then raise exception 'JOB_COST_INVALID: source_ref missing'; end if;
    v_life := p ->> 'lifecycle';
    if v_life is null or v_life not in ('PENDING','CLEARED','VOIDED') then
      raise exception 'JOB_COST_INVALID: lifecycle % not PENDING|CLEARED|VOIDED', coalesce(v_life, '(null)');
    end if;
    v_rank := case v_life when 'PENDING' then 1 when 'CLEARED' then 2 else 3 end;
    v_amtn := (p ->> 'amount_cents')::numeric;
    if v_amtn is null or v_amtn % 1 <> 0 then raise exception 'JOB_COST_INVALID: amount_cents must be an integer'; end if;
    v_amt := v_amtn::bigint;
    if coalesce(p ->> 'job_id', '') !~ c_uuid then raise exception 'JOB_COST_INVALID: job_id missing or not a uuid'; end if;
    v_job := (p ->> 'job_id')::uuid;
    if (p ? 'org_id') and (p ->> 'org_id') is distinct from p_row.org_id::text then
      raise exception 'JOB_COST_ORG_MISMATCH: payload org_id differs from the event row';
    end if;
    select j.location_id into v_jloc from core.jobs j where j.org_id = p_row.org_id and j.id = v_job;
    if not found then raise exception 'JOB_COST_UNKNOWN_JOB: job % is not in this org', v_job; end if;
    v_loc  := case when coalesce(p ->> 'location_id', '') ~ c_uuid then (p ->> 'location_id')::uuid else v_jloc end;
    v_dept := case when coalesce(p ->> 'department_id', '') ~ c_uuid then (p ->> 'department_id')::uuid end;
    v_ct   := nullif(p ->> 'cost_type', '');
    if v_ct is not null and v_ct not in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER') then
      raise exception 'JOB_COST_INVALID: cost_type %', v_ct;
    end if;
    v_gate := nullif(p ->> 'gate', '');
    v_occ  := nullif(p ->> 'occurred_on', '')::date;
    v_gl   := case when coalesce(p ->> 'gl_entry_id', '') ~ c_uuid then (p ->> 'gl_entry_id')::uuid end;
    v_memo := p ->> 'memo';
    v_desc := coalesce(nullif(p ->> 'description', ''), v_memo);
  exception when others then
    return 'REJECTED:' || sqlerrm;
  end;

  -- ---- enrich (additive keys; unresolvable values never reject the cost) ----
  v_cl_ref := nullif(p ->> 'commitment_line_id', '');
  if v_cl_ref ~ c_uuid then
    select l.id, c.vendor_id into v_cl, v_vendor
    from pm.commitment_lines l join pm.commitments c on c.org_id = l.org_id and c.id = l.commitment_id
    where l.org_id = p_row.org_id and l.id = v_cl_ref::uuid and c.job_id = v_job;
  end if;
  if v_cl is not null then v_cl_ref := null; end if;

  v_cc_ref := coalesce(nullif(p ->> 'cost_code_id', ''), nullif(p ->> 'cost_code', ''));
  if coalesce(p ->> 'cost_code_id', '') ~ c_uuid and pm.cost_code_usable(p_row.org_id, v_job, (p ->> 'cost_code_id')::uuid) then
    v_cc := (p ->> 'cost_code_id')::uuid;
  end if;
  if v_cc is null and nullif(p ->> 'cost_code', '') is not null then
    select c.id into v_cc from pm.cost_codes c
    where c.org_id = p_row.org_id and c.location_id = v_jloc and c.code = p ->> 'cost_code'
      and (c.job_id is null or c.job_id = v_job)
    order by (c.job_id is not null) desc, c.is_active desc limit 1;
  end if;
  if v_cc is null and v_cl is not null then
    select l.cost_code_id into v_cc from pm.commitment_lines l where l.org_id = p_row.org_id and l.id = v_cl;
  end if;
  if v_cc is not null then v_cc_ref := null; end if;
  if v_ct is null and v_cc is not null then
    select c.cost_type into v_ct from pm.cost_codes c where c.org_id = p_row.org_id and c.id = v_cc;
  end if;
  if coalesce(p ->> 'vendor_id', '') ~ c_uuid then
    select coalesce((select v.id from core.vendors v where v.org_id = p_row.org_id and v.id = (p ->> 'vendor_id')::uuid), v_vendor)
      into v_vendor;
  end if;

  select j.commitment_line_id into v_prev_cl from pm.job_costs j where j.org_id = p_row.org_id and j.source_ref = v_src;

  -- ---- state change on the ONE cost row (replace, never sum) ----
  insert into pm.job_costs as jc
    (org_id, job_id, location_id, department_id, source_ref, cost_type, amount_cents, lifecycle, gate, occurred_on,
     gl_entry_id, cost_code_id, cost_code_ref, commitment_line_id, commitment_line_ref, vendor_id, description, memo,
     last_event_id, last_event_at, last_lifecycle_rank, first_event_at)
  values
    (p_row.org_id, v_job, v_loc, v_dept, v_src, v_ct, v_amt, v_life, v_gate, v_occ,
     v_gl, v_cc, v_cc_ref, v_cl, v_cl_ref, v_vendor, v_desc, v_memo,
     p_row.event_id, p_row.created_at, v_rank, p_row.created_at)
  on conflict (org_id, source_ref) do update
    set job_id              = excluded.job_id,
        location_id         = excluded.location_id,
        department_id       = coalesce(excluded.department_id, jc.department_id),
        cost_type           = coalesce(excluded.cost_type, jc.cost_type),
        amount_cents        = excluded.amount_cents,
        lifecycle           = excluded.lifecycle,
        gate                = coalesce(excluded.gate, jc.gate),
        occurred_on         = coalesce(excluded.occurred_on, jc.occurred_on),
        gl_entry_id         = coalesce(excluded.gl_entry_id, jc.gl_entry_id),
        cost_code_id        = coalesce(excluded.cost_code_id, jc.cost_code_id),
        cost_code_ref       = case when coalesce(excluded.cost_code_id, jc.cost_code_id) is null
                                   then coalesce(excluded.cost_code_ref, jc.cost_code_ref) end,
        commitment_line_id  = coalesce(excluded.commitment_line_id, jc.commitment_line_id),
        commitment_line_ref = case when coalesce(excluded.commitment_line_id, jc.commitment_line_id) is null
                                   then coalesce(excluded.commitment_line_ref, jc.commitment_line_ref) end,
        vendor_id           = coalesce(excluded.vendor_id, jc.vendor_id),
        description         = coalesce(excluded.description, jc.description),
        memo                = excluded.memo,
        last_event_id       = excluded.last_event_id,
        last_event_at       = excluded.last_event_at,
        last_lifecycle_rank = excluded.last_lifecycle_rank,
        first_event_at      = least(jc.first_event_at, excluded.first_event_at),
        applied_events      = jc.applied_events + 1
    where (excluded.last_event_at, excluded.last_lifecycle_rank) >= (jc.last_event_at, jc.last_lifecycle_rank);
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- older than what is applied: keep the audit trail, do not regress the figure
    update pm.job_costs set first_event_at = least(first_event_at, p_row.created_at)
     where org_id = p_row.org_id and source_ref = v_src;
    return 'STALE';
  end if;

  select j.commitment_line_id into v_new_cl from pm.job_costs j where j.org_id = p_row.org_id and j.source_ref = v_src;
  if v_prev_cl is not null and v_prev_cl is distinct from v_new_cl then
    perform pm.refresh_commitment_line_billed(p_row.org_id, v_prev_cl);
  end if;
  if v_new_cl is not null then
    perform pm.refresh_commitment_line_billed(p_row.org_id, v_new_cl);
  end if;
  return 'APPLIED';
end $$;

-- Drain one org's pending JOB_COST events. Caller holds the org's advisory lock.
create or replace function pm.drain_job_costs_locked(p_org uuid, p_kind text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  r core.events%rowtype; v_out text;
  c_seen int := 0; c_app int := 0; c_stale int := 0; c_dup int := 0; c_rej int := 0;
  v_last_at timestamptz; v_last_id uuid; v_res jsonb;
begin
  for r in
    select * from core.events e
    where e.org_id = p_org and e.event_type = 'JOB_COST' and e.status = 'pending'
    order by e.created_at, e.id
    for update skip locked
  loop
    c_seen := c_seen + 1;
    if exists (select 1 from pm.job_cost_applied_events a
               where a.org_id = r.org_id and a.event_id = r.event_id and a.outcome in ('APPLIED','STALE')) then
      update core.events set status = 'processed', processed_at = now(), error = null where id = r.id;   -- duplicate delivery
      c_dup := c_dup + 1;
      continue;
    end if;
    v_out := pm.apply_job_cost_event(r);
    if v_out like 'REJECTED:%' then
      update core.events set status = 'rejected', error = left(substr(v_out, 10), 500), processed_at = now() where id = r.id;
      insert into pm.job_cost_applied_events (org_id, event_id, source_ref, lifecycle, outcome, error, event_created_at)
      values (r.org_id, r.event_id, r.payload ->> 'source_ref', r.payload ->> 'lifecycle', 'REJECTED', left(substr(v_out, 10), 500), r.created_at)
      on conflict (org_id, event_id) do update set outcome = 'REJECTED', error = excluded.error, applied_at = now();
      c_rej := c_rej + 1;
    else
      insert into pm.job_cost_applied_events (org_id, event_id, source_ref, lifecycle, outcome, event_created_at)
      values (r.org_id, r.event_id, r.payload ->> 'source_ref', r.payload ->> 'lifecycle', v_out, r.created_at)
      on conflict (org_id, event_id) do update set outcome = excluded.outcome, error = null, applied_at = now();
      update core.events set status = 'processed', processed_at = now(), error = null where id = r.id;
      if v_out = 'APPLIED' then c_app := c_app + 1; else c_stale := c_stale + 1; end if;
    end if;
    if v_last_at is null or r.created_at >= v_last_at then v_last_at := r.created_at; v_last_id := r.event_id; end if;
  end loop;

  v_res := jsonb_build_object('org_id', p_org, 'kind', p_kind, 'seen', c_seen, 'applied', c_app, 'stale', c_stale,
                              'duplicate', c_dup, 'rejected', c_rej);
  insert into pm.event_cursor as ec (org_id, consumer, last_event_created_at, last_event_id, last_run_at, last_run_kind, last_run, runs)
  values (p_org, 'JOB_COST', v_last_at, v_last_id, now(), p_kind, v_res, 1)
  on conflict (org_id, consumer) do update
    set last_event_created_at = case when excluded.last_event_created_at is not null
                                      and (ec.last_event_created_at is null or excluded.last_event_created_at >= ec.last_event_created_at)
                                     then excluded.last_event_created_at else ec.last_event_created_at end,
        last_event_id         = case when excluded.last_event_created_at is not null
                                      and (ec.last_event_created_at is null or excluded.last_event_created_at >= ec.last_event_created_at)
                                     then excluded.last_event_id else ec.last_event_id end,
        last_run_at = now(), last_run_kind = excluded.last_run_kind, last_run = excluded.last_run, runs = ec.runs + 1;
  return v_res;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Entry points
-- ----------------------------------------------------------------------------

-- service_role (scheduler / EVENT_WORKER_SECRET route). p_org null = every org with pending
-- JOB_COST rows; each org is drained under its own advisory lock.
create or replace function pm.drain_job_costs(p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_o uuid; v_all jsonb := '[]'; v_one jsonb;
begin
  if p_org is not null then
    perform pg_advisory_xact_lock(pm.job_cost_drain_key(p_org));
    return pm.drain_job_costs_locked(p_org, 'SERVICE');
  end if;
  for v_o in select distinct e.org_id from core.events e where e.event_type = 'JOB_COST' and e.status = 'pending' order by 1 loop
    perform pg_advisory_xact_lock(pm.job_cost_drain_key(v_o));
    v_one := pm.drain_job_costs_locked(v_o, 'SERVICE');
    v_all := v_all || jsonb_build_array(v_one);
  end loop;
  return jsonb_build_object('orgs', jsonb_array_length(v_all), 'by_org', v_all,
    'applied',   coalesce((select sum((x ->> 'applied')::int) from jsonb_array_elements(v_all) x), 0),
    'stale',     coalesce((select sum((x ->> 'stale')::int) from jsonb_array_elements(v_all) x), 0),
    'duplicate', coalesce((select sum((x ->> 'duplicate')::int) from jsonb_array_elements(v_all) x), 0),
    'rejected',  coalesce((select sum((x ->> 'rejected')::int) from jsonb_array_elements(v_all) x), 0));
end $$;

-- service_role: rebuild one org's projection by replaying EVERY JOB_COST row (any status) in
-- (created_at, id) order. The result equals what the incremental drain produces; each row's
-- status is set to its replay outcome (processed | rejected).
create or replace function pm.rebuild_job_costs(p_org uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r core.events%rowtype; v_out text; c_app int := 0; c_stale int := 0; c_rej int := 0; v_res jsonb;
        v_last_at timestamptz; v_last_id uuid;
begin
  if p_org is null then raise exception 'PM_INVALID: rebuild needs an org' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(pm.job_cost_drain_key(p_org));
  delete from pm.job_costs where org_id = p_org;
  delete from pm.job_cost_applied_events where org_id = p_org;
  update pm.commitment_lines set billed_cents = 0 where org_id = p_org and billed_cents <> 0;
  for r in select * from core.events e where e.org_id = p_org and e.event_type = 'JOB_COST' order by e.created_at, e.id for update loop
    v_out := pm.apply_job_cost_event(r);
    if v_out like 'REJECTED:%' then
      insert into pm.job_cost_applied_events (org_id, event_id, source_ref, lifecycle, outcome, error, event_created_at)
      values (r.org_id, r.event_id, r.payload ->> 'source_ref', r.payload ->> 'lifecycle', 'REJECTED', left(substr(v_out, 10), 500), r.created_at)
      on conflict (org_id, event_id) do nothing;
      update core.events set status = 'rejected', error = left(substr(v_out, 10), 500), processed_at = coalesce(processed_at, now())
       where id = r.id and status <> 'rejected';
      c_rej := c_rej + 1;
    else
      insert into pm.job_cost_applied_events (org_id, event_id, source_ref, lifecycle, outcome, event_created_at)
      values (r.org_id, r.event_id, r.payload ->> 'source_ref', r.payload ->> 'lifecycle', v_out, r.created_at)
      on conflict (org_id, event_id) do nothing;
      update core.events set status = 'processed', error = null, processed_at = coalesce(processed_at, now())
       where id = r.id and status <> 'processed';
      if v_out = 'APPLIED' then c_app := c_app + 1; else c_stale := c_stale + 1; end if;
    end if;
    v_last_at := r.created_at; v_last_id := r.event_id;
  end loop;
  v_res := jsonb_build_object('org_id', p_org, 'kind', 'REBUILD', 'applied', c_app, 'stale', c_stale, 'rejected', c_rej,
                              'cost_rows', (select count(*) from pm.job_costs where org_id = p_org));
  insert into pm.event_cursor as ec (org_id, consumer, last_event_created_at, last_event_id, last_run_at, last_run_kind, last_run, runs)
  values (p_org, 'JOB_COST', v_last_at, v_last_id, now(), 'REBUILD', v_res, 1)
  on conflict (org_id, consumer) do update
    set last_event_created_at = excluded.last_event_created_at, last_event_id = excluded.last_event_id,
        last_run_at = now(), last_run_kind = 'REBUILD', last_run = excluded.last_run, runs = ec.runs + 1;
  return v_res;
end $$;

-- Member: drain the caller's org now ("refresh job cost"). Never blocks: if a drain for the
-- org is already running it returns {"status":"busy"} (advisory try-lock = rate limit).
create or replace function pm.refresh_job_costs()
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
begin
  if v_org is null then raise exception 'PM_FORBIDDEN: no organization in the caller''s session' using errcode = '42501'; end if;
  if not pg_try_advisory_xact_lock(pm.job_cost_drain_key(v_org)) then
    return jsonb_build_object('status', 'busy', 'org_id', v_org);
  end if;
  return jsonb_build_object('status', 'ok') || pm.drain_job_costs_locked(v_org, 'MEMBER');
end $$;

-- service_role: one scheduler tick — drain JOB_COST, reconcile Books acks, re-sync
-- commitment payment holds (COI expiry).
create or replace function pm.run_seam_cycle(p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  return jsonb_build_object('job_cost', pm.drain_job_costs(p_org),
                            'reconcile', pm.reconcile_billing_requests(p_org),
                            'commitment_holds_resent', pm.sync_commitment_holds(p_org));
end $$;

-- ----------------------------------------------------------------------------
-- 4. Views (security_invoker)
-- ----------------------------------------------------------------------------

-- Budget vs committed vs actual per job and cost code (cost_code_id null = unassigned cost).
--   budget            current budget lines (APPROVED REVISED, else ORIGINAL)
--   committed         APPROVED/EXECUTED commitment lines at revised amount; CLOSED at billed
--   committed_open    APPROVED/EXECUTED: max(amount − billed, 0)
--   actual / pending  CLEARED / PENDING job cost (VOIDED excluded)
--   uncommitted_cost  PENDING + CLEARED cost not tied to a commitment line
--   forecast (EAC)    max(budget, committed exposure + uncommitted cost, actual + pending)
--                     where committed exposure = Σ per line max(amount, billed) (CLOSED: billed)
--   variance          budget − forecast (negative = projected overrun)
create or replace view pm.v_cost_code_status with (security_invoker = on) as
with bud as (
  select b.org_id, b.job_id, b.cost_code_id, sum(b.amount_cents)::bigint as budget_cents
  from pm.v_job_current_budget_lines b group by 1, 2, 3
), com as (
  select c.org_id, c.job_id, l.cost_code_id,
         sum(case when c.status = 'CLOSED' then l.billed_cents else l.amount_cents end)::bigint                     as committed_cents,
         sum(case when c.status = 'CLOSED' then 0 else greatest(l.amount_cents - l.billed_cents, 0) end)::bigint  as committed_open_cents,
         sum(case when c.status = 'CLOSED' then l.billed_cents else greatest(l.amount_cents, l.billed_cents) end)::bigint as exposure_cents
  from pm.commitments c join pm.commitment_lines l on l.org_id = c.org_id and l.commitment_id = c.id
  where c.status in ('APPROVED','EXECUTED','CLOSED')
  group by 1, 2, 3
), cst as (
  select j.org_id, j.job_id, j.cost_code_id,
         coalesce(sum(j.amount_cents) filter (where j.lifecycle = 'CLEARED'), 0)::bigint as actual_cents,
         coalesce(sum(j.amount_cents) filter (where j.lifecycle = 'PENDING'), 0)::bigint as pending_cents,
         coalesce(sum(j.amount_cents) filter (where j.lifecycle in ('PENDING','CLEARED') and j.commitment_line_id is null), 0)::bigint
                                                                                         as uncommitted_cost_cents
  from pm.job_costs j group by 1, 2, 3
), k as (
  select org_id, job_id, cost_code_id from bud
  union select org_id, job_id, cost_code_id from com
  union select org_id, job_id, cost_code_id from cst
)
select
  k.org_id, k.job_id, k.cost_code_id, cc.code as cost_code, cc.name as cost_code_name, cc.cost_type,
  coalesce(b.budget_cents, 0)              as budget_cents,
  coalesce(m.committed_cents, 0)           as committed_cents,
  coalesce(m.committed_open_cents, 0)      as committed_open_cents,
  coalesce(s.actual_cents, 0)              as actual_cents,
  coalesce(s.pending_cents, 0)             as pending_cents,
  coalesce(s.uncommitted_cost_cents, 0)    as uncommitted_cost_cents,
  greatest(coalesce(b.budget_cents, 0),
           coalesce(m.exposure_cents, 0) + coalesce(s.uncommitted_cost_cents, 0),
           coalesce(s.actual_cents, 0) + coalesce(s.pending_cents, 0))::bigint as forecast_cents,
  (coalesce(b.budget_cents, 0)
   - greatest(coalesce(b.budget_cents, 0),
              coalesce(m.exposure_cents, 0) + coalesce(s.uncommitted_cost_cents, 0),
              coalesce(s.actual_cents, 0) + coalesce(s.pending_cents, 0)))::bigint as variance_cents,
  case when coalesce(b.budget_cents, 0) > 0 then round(coalesce(s.actual_cents, 0)::numeric / b.budget_cents, 4) end as pct_spent
from k
left join bud b on b.org_id = k.org_id and b.job_id = k.job_id and b.cost_code_id is not distinct from k.cost_code_id
left join com m on m.org_id = k.org_id and m.job_id = k.job_id and m.cost_code_id is not distinct from k.cost_code_id
left join cst s on s.org_id = k.org_id and s.job_id = k.job_id and s.cost_code_id is not distinct from k.cost_code_id
left join pm.cost_codes cc on cc.org_id = k.org_id and cc.id = k.cost_code_id;

-- The four numbers per job (contract · committed · actual · projected) and their derivations.
--   revised contract    = original + approved COs (pm.v_job_money)
--   revised budget      = pm.v_job_money.cost_estimate_cents (approved REVISED budget, else
--                         ORIGINAL + approved CO cost impact)
--   committed           = Σ v_cost_code_status.committed; committed_open likewise
--   actual cost         = Σ CLEARED job cost (ties to GL job-dimensioned cost, G4); pending shown apart
--   billed to date      = Σ gross_earned_cents of EMITTED|ISSUED|UNISSUED requests excluding
--                         retainage releases (gross of retainage — AIA "total completed and stored")
--   projected final cost = greatest(revised budget,
--                                   Σ per cost code max(budget_c, committed exposure_c + uncommitted cost_c),
--                                   actual + pending)
--                         i.e. max(revised budget, committed + uncommitted remaining budget, actual)
--   projected margin    = revised contract − projected final cost
--   over/under billing  = billed to date − revised contract × (actual / projected final cost)
--                         (cost-to-cost estimate; positive = billings in excess of earnings.
--                          Books' WIP from the GL is authoritative.)
create or replace view pm.v_job_financials with (security_invoker = on) as
select
  p.org_id, p.job_id, p.location_id, j.job_number, j.name as job_name,
  m.original_contract_cents, m.approved_co_cents, m.revised_contract_cents, m.pending_co_cents,
  m.budget_original_cents, m.cost_estimate_cents                         as revised_budget_cents,
  coalesce(cs.committed, 0)::bigint                                       as committed_cents,
  coalesce(cs.committed_open, 0)::bigint                                  as committed_open_cents,
  coalesce(cs.actual, 0)::bigint                                          as actual_cost_cents,
  coalesce(cs.pending, 0)::bigint                                         as pending_cost_cents,
  coalesce(cs.forecast, 0)::bigint                                        as forecast_by_cost_code_cents,
  pf.projected                                                            as projected_final_cost_cents,
  (pf.projected - coalesce(cs.actual, 0))::bigint                         as cost_to_complete_cents,
  (m.revised_contract_cents - pf.projected)::bigint                       as projected_margin_cents,
  case when m.revised_contract_cents > 0
       then round((m.revised_contract_cents - pf.projected)::numeric / m.revised_contract_cents, 4) end as projected_margin_pct,
  coalesce(bl.billed, 0)::bigint                                          as billed_to_date_cents,
  coalesce(bl.billed_net, 0)::bigint                                      as billed_net_to_date_cents,
  coalesce(rt.held_cents, 0)::bigint                                      as retainage_held_cents,
  coalesce(rt.released_cents, 0)::bigint                                  as retainage_released_cents,
  coalesce(rt.outstanding_cents, 0)::bigint                               as retainage_outstanding_cents,
  coalesce(dp.requested, 0)::bigint                                       as deposits_requested_cents,
  case when pf.projected > 0 then round(least(coalesce(cs.actual, 0)::numeric / pf.projected, 1), 6) end as pct_complete_cost,
  case when pf.projected > 0
       then round(m.revised_contract_cents * least(coalesce(cs.actual, 0)::numeric / pf.projected, 1))::bigint end as earned_revenue_cents,
  case when pf.projected > 0
       then (coalesce(bl.billed, 0) - round(m.revised_contract_cents * least(coalesce(cs.actual, 0)::numeric / pf.projected, 1)))::bigint
  end                                                                     as over_under_billing_cents
from pm.projects p
join core.jobs j on j.org_id = p.org_id and j.id = p.job_id
join pm.v_job_money m on m.org_id = p.org_id and m.job_id = p.job_id
left join lateral (
  select sum(s.committed_cents) as committed, sum(s.committed_open_cents) as committed_open,
         sum(s.actual_cents) as actual, sum(s.pending_cents) as pending, sum(s.forecast_cents) as forecast
  from pm.v_cost_code_status s where s.org_id = p.org_id and s.job_id = p.job_id
) cs on true
cross join lateral (
  select greatest(m.cost_estimate_cents, coalesce(cs.forecast, 0), coalesce(cs.actual, 0) + coalesce(cs.pending, 0))::bigint as projected
) pf
left join lateral (
  select sum(r.gross_earned_cents) as billed, sum(r.net_cents) as billed_net
  from pm.billing_requests r
  where r.org_id = p.org_id and r.job_id = p.job_id and r.status in ('EMITTED','ISSUED','UNISSUED')
    and r.billing_subtype is distinct from 'RETAINAGE_RELEASE'
) bl on true
left join pm.v_job_retainage rt on rt.org_id = p.org_id and rt.job_id = p.job_id
left join lateral (
  select sum(d.amount_cents) as requested from pm.deposit_requests d
  where d.org_id = p.org_id and d.job_id = p.job_id and d.status in ('EMITTED','ISSUED','UNISSUED')
) dp on true;

-- Pending-age alarm (G15): per event type for the caller's org — counts by status, oldest
-- pending, its age and an alarm level (WARN > 1 h, ALARM > 24 h), plus the last drain run.
create or replace view pm.v_seam_health with (security_invoker = on) as
select
  e.org_id, e.event_type,
  count(*) filter (where e.status = 'pending')::int    as pending_count,
  count(*) filter (where e.status = 'processed')::int  as processed_count,
  count(*) filter (where e.status = 'rejected')::int   as rejected_count,
  min(e.created_at) filter (where e.status = 'pending') as oldest_pending_at,
  floor(extract(epoch from (now() - min(e.created_at) filter (where e.status = 'pending'))) / 60)::bigint as oldest_pending_age_minutes,
  max(e.processed_at)                                   as last_processed_at,
  case when min(e.created_at) filter (where e.status = 'pending') is null then 'OK'
       when now() - min(e.created_at) filter (where e.status = 'pending') > interval '24 hours' then 'ALARM'
       when now() - min(e.created_at) filter (where e.status = 'pending') > interval '1 hour' then 'WARN'
       else 'OK' end                                    as alarm,
  (select c.last_run_at from pm.event_cursor c where c.org_id = e.org_id and c.consumer = e.event_type) as last_drain_at
from core.events e
where e.event_type in ('JOB_COST','JOB_BILLING','JOB_PROGRESS','JOB_COMMITMENT','JOB_DEPOSIT_REQUEST',
                       'JOB_TIME','JOB_MATERIAL','JOB_PAYABLE_REQUEST')
  and (e.org_id = public.get_org_id() or current_user = 'service_role')
group by e.org_id, e.event_type;

-- ----------------------------------------------------------------------------
-- 5. RLS + grants. The projection is Books-originated: members read, never write.
-- ----------------------------------------------------------------------------
alter table pm.job_costs enable row level security;
alter table pm.job_cost_applied_events enable row level security;
alter table pm.event_cursor enable row level security;
do $$
declare t text;
begin
  foreach t in array array['job_costs','job_cost_applied_events','event_cursor'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
end $$;

revoke all on pm.job_costs, pm.job_cost_applied_events, pm.event_cursor from public, anon, authenticated;
grant select, insert, update, delete on pm.job_costs, pm.job_cost_applied_events, pm.event_cursor to service_role;
grant select on pm.job_costs, pm.job_cost_applied_events, pm.event_cursor to authenticated;
grant select on pm.v_cost_code_status, pm.v_job_financials, pm.v_seam_health to authenticated, service_role;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'pm' and p.proname in ('job_cost_drain_key','refresh_commitment_line_billed','apply_job_cost_event',
             'drain_job_costs_locked','drain_job_costs','rebuild_job_costs','refresh_job_costs','run_seam_cycle') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = 'refresh_job_costs' then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1103_pm_cost_drain
-- ============================================================================
