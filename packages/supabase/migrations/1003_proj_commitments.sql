-- ============================================================================
-- MeritProjects — G5 :: Commitment Accounting + the Third Operational Number
-- Migration 1003 :: schema `proj` (EXTENDS the seam — never rebuilds it)
--
-- Reserved band 1001+ (see MIGRATION_REGISTRY.md). Content = Foundational Model
-- Design §4: signed PO/subcontract creates a COMMITTED bucket that actual
-- (Books-originated) JOB_COST invoices draw down, cost-code dimensioned, with
-- over-commit visibility. This is the third number: actual (cleared) +
-- committed-open + projected-final, per job and per cost code.
--
-- Boundaries: a signed commitment emits NO GL (Projects-internal state); only
-- the sub's Books-originated JOB_COST hits the ledger. Books remains the sole
-- cost originator; the commitment is the Projects-side pre-actual the event
-- draws down. Drain keying (org_id, source_ref), lifecycle, monotonic guard,
-- and idempotency are UNCHANGED — commitment resolution is Projects-side
-- enrichment via an additive nullable JOB_COST payload key. Money integer cents.
-- Every statement idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §4.1  proj.commitments — PO / subcontract header
-- ----------------------------------------------------------------------------
create table if not exists proj.commitments (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null references core.jobs(id),
  vendor_id              uuid references core.vendors(id),          -- may be provisional (Rule C) until trusted
  commitment_type        text not null check (commitment_type in ('PURCHASE_ORDER','SUBCONTRACT')),
  number                 text,                                       -- PO#/subcontract# (Projects series)
  status                 text not null default 'DRAFT'
                           check (status in ('DRAFT','APPROVED','PARTIAL','CLOSED','VOID')),
  original_amount_cents  bigint not null default 0,
  revised_amount_cents   bigint not null default 0,                  -- original + approved commitment-COs
  retainage_pct          numeric(5,4) not null default 0,            -- AP-side retention held from the sub
  executed_at            timestamptz,
  approved_by            text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_proj_commitments_job on proj.commitments(org_id, job_id);

-- ----------------------------------------------------------------------------
-- §4.2  proj.commitment_lines — cost-code-dimensioned committed cost
-- ----------------------------------------------------------------------------
create table if not exists proj.commitment_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  commitment_id     uuid not null references proj.commitments(id) on delete cascade,
  job_id            uuid not null references core.jobs(id),
  cost_code_id      uuid references proj.cost_codes(id),             -- THE dimension
  description       text not null,
  amount_cents      bigint not null default 0,
  source_ref_prefix text,                                            -- links future JOB_COST source_refs to this line
  invoiced_cents    bigint not null default 0,                       -- denormalized cache, recomputed by drain
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_proj_commitment_lines_cmt    on proj.commitment_lines(org_id, commitment_id);
create index if not exists idx_proj_commitment_lines_prefix on proj.commitment_lines(org_id, source_ref_prefix);

-- ----------------------------------------------------------------------------
-- §4.3  thread commitment_line_id through the cost spine (additive, nullable)
-- ----------------------------------------------------------------------------
alter table proj.job_costs      add column if not exists commitment_line_id uuid references proj.commitment_lines(id);
alter table proj.captured_costs add column if not exists commitment_line_id uuid references proj.commitment_lines(id);
create index if not exists idx_proj_job_costs_cmtline on proj.job_costs(org_id, commitment_line_id);

-- ----------------------------------------------------------------------------
-- RLS + grants (org-isolation pattern; idempotent)
-- ----------------------------------------------------------------------------
alter table proj.commitments      enable row level security;
alter table proj.commitment_lines enable row level security;
do $$
begin
  execute 'create policy org_isolation on proj.commitments      for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.commitment_lines for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
exception when duplicate_object then null;
end $$;
grant select, insert, update, delete on all tables in schema proj to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- §4.4  proj.approve_commitment — DRAFT -> APPROVED (Projects-internal; NO GL)
-- ----------------------------------------------------------------------------
create or replace function proj.approve_commitment(p_commitment_id uuid, p_approver text default null::text)
returns void language plpgsql security definer set search_path to 'proj','core','public'
as $function$
declare c proj.commitments%rowtype;
begin
  select * into c from proj.commitments where id = p_commitment_id for update;
  if not found then raise exception 'Commitment % not found', p_commitment_id; end if;
  if c.status not in ('DRAFT','APPROVED','PARTIAL') then
    raise exception 'Commitment % is %; cannot approve', p_commitment_id, c.status;
  end if;
  update proj.commitments
    set status = 'APPROVED',
        revised_amount_cents = greatest(revised_amount_cents, original_amount_cents),
        executed_at = coalesce(executed_at, now()),
        approved_by = coalesce(p_approver, approved_by),
        updated_at = now()
  where id = p_commitment_id;
end $function$;

-- ----------------------------------------------------------------------------
-- §4.5  proj.v_commitment_status — per line: amount | invoiced(consumed) | open.
--   Only APPROVED/PARTIAL commitments are "open". Consumed = linked cost that
--   has landed (PENDING or CLEARED), sourced from the active cost table per
--   books_present. Derived from cost rows (not the cache) for correctness.
-- ----------------------------------------------------------------------------
create or replace view proj.v_commitment_status
with (security_invoker = on) as
select
  cl.org_id, cl.job_id, cl.commitment_id, cl.id as commitment_line_id, cl.cost_code_id,
  cl.amount_cents,
  coalesce(consumed.consumed_cents, 0)::bigint                                  as invoiced_cents,
  greatest(cl.amount_cents - coalesce(consumed.consumed_cents, 0), 0)::bigint   as open_cents
from proj.commitment_lines cl
join proj.commitments c on c.id = cl.commitment_id and c.status in ('APPROVED','PARTIAL')
left join lateral (
  select sum(amount_cents) as consumed_cents from (
    select jc.amount_cents from proj.job_costs jc
      where jc.commitment_line_id = cl.id and jc.lifecycle in ('PENDING','CLEARED') and proj.books_present(cl.org_id)
    union all
    select cc.amount_cents from proj.captured_costs cc
      where cc.commitment_line_id = cl.id and cc.lifecycle in ('PENDING','CLEARED') and not proj.books_present(cl.org_id)
  ) x
) consumed on true;
grant select on proj.v_commitment_status to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- §4.6  extend drain_job_costs — resolve commitment_line_id (additive payload
--   key OR source_ref_prefix match), inherit cost_code from the line when the
--   payload didn't carry one, and recompute the line's invoiced_cents cache.
--   Keying/lifecycle/monotonic-guard/idempotency UNCHANGED.
-- ----------------------------------------------------------------------------
create or replace function proj.drain_job_costs(p_org_id uuid default null::uuid)
returns table(processed integer, applied integer, skipped integer, rejected integer)
language plpgsql security definer set search_path to 'proj','core','public'
as $function$
declare
  r        record;
  p        jsonb;
  v_src    text;  v_life text;  v_amt bigint;
  v_job    uuid;  v_loc uuid;   v_dept uuid;
  v_ct     text;  v_gate text;  v_occ date;  v_gl uuid;  v_memo text;
  v_code   text;  v_cc_id uuid;
  v_cmt    uuid;                                          -- NEW: commitment line linkage
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
    v_code := nullif(p->>'cost_code','');
    v_cmt  := nullif(p->>'commitment_line_id','')::uuid;   -- NEW: additive nullable key

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

    -- NEW: resolve commitment line by explicit key, else by source_ref_prefix
    -- (longest prefix wins). Then inherit cost_code from the line if absent.
    if v_cmt is null and v_src is not null then
      select cl.id into v_cmt
      from proj.commitment_lines cl
      where cl.org_id = r.org_id
        and cl.source_ref_prefix is not null and cl.source_ref_prefix <> ''
        and v_src like cl.source_ref_prefix || '%'
      order by length(cl.source_ref_prefix) desc
      limit 1;
    end if;

    v_cc_id := null;
    if v_code is not null then
      select cc.id into v_cc_id
      from proj.cost_codes cc
      where cc.org_id = r.org_id and cc.code = v_code and (cc.job_id = v_job or cc.job_id is null)
      order by (cc.job_id = v_job) desc nulls last
      limit 1;
    end if;
    if v_cc_id is null and v_cmt is not null then
      select cost_code_id into v_cc_id from proj.commitment_lines where id = v_cmt;
    end if;

    insert into proj.job_costs as jc
      (org_id, job_id, location_id, department_id, source_ref, cost_type,
       amount_cents, lifecycle, gate, occurred_on, gl_entry_id, memo,
       cost_code_id, commitment_line_id, last_event_id, last_event_at)
    values
      (r.org_id, v_job, v_loc, v_dept, v_src, v_ct,
       v_amt, v_life, v_gate, v_occ, v_gl, v_memo,
       v_cc_id, v_cmt, r.event_id, r.created_at)
    on conflict (org_id, source_ref) do update
      set lifecycle          = excluded.lifecycle,
          amount_cents       = excluded.amount_cents,
          cost_type          = coalesce(excluded.cost_type, jc.cost_type),
          gate               = coalesce(excluded.gate, jc.gate),
          occurred_on        = coalesce(excluded.occurred_on, jc.occurred_on),
          gl_entry_id        = coalesce(excluded.gl_entry_id, jc.gl_entry_id),
          memo               = excluded.memo,
          department_id      = coalesce(excluded.department_id, jc.department_id),
          location_id        = coalesce(excluded.location_id, jc.location_id),
          cost_code_id       = coalesce(excluded.cost_code_id, jc.cost_code_id),
          commitment_line_id = coalesce(excluded.commitment_line_id, jc.commitment_line_id),  -- NEW
          last_event_id      = excluded.last_event_id,
          last_event_at      = excluded.last_event_at,
          updated_at         = now()
      where excluded.last_event_at >= jc.last_event_at;

    insert into proj.job_cost_applied_events (org_id, event_id, source_ref, lifecycle)
    values (r.org_id, r.event_id, v_src, v_life)
    on conflict do nothing;

    -- NEW: recompute the commitment line cache (idempotent; never increments).
    -- Uses the resolved link OR the row's existing link (handles prefix match on
    -- a prior apply). Consumed = landed cost (PENDING or CLEARED).
    if v_cmt is not null then
      update proj.commitment_lines cl
        set invoiced_cents = (
              select coalesce(sum(amount_cents), 0)
              from proj.job_costs j2
              where j2.commitment_line_id = cl.id and j2.lifecycle in ('PENDING','CLEARED')
            ),
            updated_at = now()
      where cl.id = v_cmt;
    end if;

    update core.events set status = 'processed', processed_at = now() where id = r.id;
    c_app := c_app + 1;
  end loop;

  return query select c_proc, c_app, c_skip, c_rej;
end $function$;

-- ----------------------------------------------------------------------------
-- §4.7  extend the operational figure with the THIRD number (committed-open).
--   CREATE OR REPLACE VIEW appends columns only (first columns unchanged).
-- ----------------------------------------------------------------------------
create or replace view proj.v_job_operational_cost
with (security_invoker = on) as
select
  base.org_id,
  base.job_id,
  base.operational_actual_cents,
  base.pending_cents,
  coalesce(co.committed_open_cents, 0)::bigint as committed_open_cents
from (
  select org_id, job_id,
    coalesce(sum(amount_cents) filter (where lifecycle = 'CLEARED'), 0)::bigint as operational_actual_cents,
    coalesce(sum(amount_cents) filter (where lifecycle = 'PENDING'), 0)::bigint as pending_cents
  from (
    select jc.org_id, jc.job_id, jc.amount_cents, jc.lifecycle
      from proj.job_costs jc where proj.books_present(jc.org_id)
    union all
    select cc.org_id, cc.job_id, cc.amount_cents, cc.lifecycle
      from proj.captured_costs cc where not proj.books_present(cc.org_id)
  ) s
  group by org_id, job_id
) base
left join (
  select org_id, job_id, sum(open_cents)::bigint as committed_open_cents
  from proj.v_commitment_status
  group by org_id, job_id
) co on co.org_id = base.org_id and co.job_id = base.job_id;

-- ----------------------------------------------------------------------------
-- §4.8  extend v_job_margin with committed_open_cents + projected_final_cents.
--   projected_final = actual(cleared) + pending + committed_open.
-- ----------------------------------------------------------------------------
create or replace view proj.v_job_margin
with (security_invoker = on) as
with bud as (
  select org_id, job_id,
    coalesce(sum(budgeted_cents), 0)::bigint  as budget_cents,
    coalesce(sum(committed_cents), 0)::bigint as committed_cents
  from proj.job_budget_lines
  group by org_id, job_id
)
select
  j.org_id,
  j.id as job_id,
  j.job_number,
  j.name,
  coalesce(vc.contract_value_cents, j.contract_amount_cents, 0::bigint) as revenue_contract_cents,
  coalesce(vc.cost_estimate_cents, 0::bigint) as cost_estimate_cents,
  coalesce(oc.operational_actual_cents, 0::bigint) as operational_actual_cents,
  coalesce(oc.pending_cents, 0::bigint) as operational_pending_cents,
  coalesce(b.budget_cents, 0::bigint) as budget_cents,
  coalesce(b.committed_cents, 0::bigint) as committed_cents,
  coalesce(vc.contract_value_cents, j.contract_amount_cents, 0::bigint) - coalesce(oc.operational_actual_cents, 0::bigint) as operational_margin_cents,
  case
    when coalesce(vc.contract_value_cents, j.contract_amount_cents, 0::bigint) > 0
    then round((coalesce(vc.contract_value_cents, j.contract_amount_cents, 0::bigint) - coalesce(oc.operational_actual_cents, 0::bigint))::numeric
               / coalesce(vc.contract_value_cents, j.contract_amount_cents)::numeric * 100::numeric, 2)
    else null::numeric
  end as operational_margin_pct,
  coalesce(b.budget_cents, 0::bigint) - coalesce(oc.operational_actual_cents, 0::bigint) - coalesce(b.committed_cents, 0::bigint) - coalesce(oc.pending_cents, 0::bigint) as budget_remaining_cents,
  -- NEW appended columns (the third number):
  coalesce(oc.committed_open_cents, 0::bigint) as committed_open_cents,
  (coalesce(oc.operational_actual_cents, 0::bigint) + coalesce(oc.pending_cents, 0::bigint) + coalesce(oc.committed_open_cents, 0::bigint)) as projected_final_cents
from core.jobs j
  left join proj.v_contract_current vc on vc.org_id = j.org_id and vc.job_id = j.id
  left join proj.v_job_operational_cost oc on oc.org_id = j.org_id and oc.job_id = j.id
  left join bud b on b.org_id = j.org_id and b.job_id = j.id;
