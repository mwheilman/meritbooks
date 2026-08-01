-- ============================================================================
-- MeritProjects — G1 :: Polymorphic Core + Cost-Code Dimension
-- Migration 1001 :: schema `proj` (EXTENDS the 066/067 seam — never rebuilds it)
--
-- Numbering: MeritProjects owns the reserved band **1001+** in the shared
-- meritbooks migration sequence (owner decision, session 42). MeritBooks keeps
-- its organic low sequence; Projects never negotiates a number again. See
-- packages/supabase/migrations/MIGRATION_REGISTRY.md. Every Projects migration
-- is filename-tagged `NNN_proj_*` so a number race can never silently clobber.
-- Content = Foundational Model Design §0 (cost-code dimension) + §1 (archetype
-- switch). Companion 1002_proj_seam_uuid_hardening fixes a latent seam bug.
--
-- Builds:
--   §0  proj.cost_codes                  — org/job cost dimension (CSI/WBS)
--       + cost_code_id on job_costs / job_budget_lines / captured_costs
--       + drain_job_costs enrichment (resolve cost_code from additive payload key)
--       + proj.v_cost_code_slippage      — the panel's slippage report
--   §1  proj.archetype_profiles          — per-org capability defaults per archetype
--       proj.job_settings                — per-job effective capabilities (the switch)
--       proj.job_cap(job_id, capability) — coalesce job_settings -> profile -> false
--
-- Boundaries (unchanged from the seam): references core.* by UUID FK only;
-- writes only proj.*; JOB_COST keying (org_id, source_ref), lifecycle, and
-- idempotency are untouched — cost-code attribution is a Projects-side
-- enrichment, NOT a Books obligation. Money integer cents. RLS org_isolation.
-- Every statement idempotent (safe re-run).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §0.1  proj.cost_codes — the cost dimension everything hangs off
-- ----------------------------------------------------------------------------
create table if not exists proj.cost_codes (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id      uuid references core.jobs(id),                 -- null = org-level template; set = job-scoped instance
  parent_id   uuid references proj.cost_codes(id),           -- CSI/Uniformat/WBS hierarchy
  code        text not null,                                 -- '03 30 00', '15-Framing'
  name        text not null,
  cost_type   text,                                          -- LABOR|MATERIALS|SUBCONTRACTOR|EQUIPMENT|OTHER
  division    text,                                          -- CSI division label
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, job_id, code)
);
create index if not exists idx_proj_cost_codes_org_job on proj.cost_codes(org_id, job_id);
create index if not exists idx_proj_cost_codes_parent  on proj.cost_codes(parent_id);

-- ----------------------------------------------------------------------------
-- §0.2  thread cost_code_id through the cost/budget spine (additive, nullable)
-- ----------------------------------------------------------------------------
alter table proj.job_costs        add column if not exists cost_code_id uuid references proj.cost_codes(id);
alter table proj.job_budget_lines add column if not exists cost_code_id uuid references proj.cost_codes(id);
alter table proj.captured_costs   add column if not exists cost_code_id uuid references proj.cost_codes(id);
create index if not exists idx_proj_job_costs_costcode on proj.job_costs(org_id, cost_code_id);

-- ----------------------------------------------------------------------------
-- §1.1  proj.archetype_profiles — capability registry (org-seeded defaults)
-- ----------------------------------------------------------------------------
create table if not exists proj.archetype_profiles (
  id                     uuid primary key default uuid_generate_v4(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  archetype              text not null,
  uses_sov               boolean not null default false,
  uses_retainage         boolean not null default false,
  uses_commitments       boolean not null default false,
  uses_pricebook         boolean not null default false,
  uses_allowances        boolean not null default false,
  uses_external_gates    boolean not null default false,
  default_billing_mode   text not null default 'FIXED',      -- FIXED|COST_PLUS|GMP|TM|FLAT_RATE|RECURRING|UNIT_PRICE
  default_progress_basis text not null default 'NONE',       -- NONE|PHYSICAL|SCHEDULE|COST_TO_COST
  allows_null_contract   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, archetype)
);

-- ----------------------------------------------------------------------------
-- §1.2  proj.job_settings — per-job effective capabilities (the actual switch)
--   NULL toggle = inherit archetype_profiles; non-null = per-job override
--   (the millwork independence: SOV/retainage toggle independent of archetype).
-- ----------------------------------------------------------------------------
create table if not exists proj.job_settings (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null references core.jobs(id),
  archetype        text not null,                            -- cached from core.jobs (read-authoritative = core)
  parent_job_id    uuid references core.jobs(id),            -- composite-job stitching (later gates cache here)
  uses_sov         boolean,
  uses_retainage   boolean,
  uses_commitments boolean,
  uses_pricebook   boolean,
  uses_allowances  boolean,
  billing_mode     text,                                     -- FIXED|COST_PLUS|GMP|TM|FLAT_RATE|RECURRING|UNIT_PRICE
  progress_basis   text,                                     -- NONE|PHYSICAL|SCHEDULE|COST_TO_COST
  tax_character    text,                                     -- REPAIR|CAPITAL_IMPROVEMENT
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, job_id)
);
create index if not exists idx_proj_job_settings_job on proj.job_settings(org_id, job_id);

-- ----------------------------------------------------------------------------
-- RLS + grants (same org-isolation pattern as the seam; idempotent)
-- ----------------------------------------------------------------------------
alter table proj.cost_codes         enable row level security;
alter table proj.archetype_profiles enable row level security;
alter table proj.job_settings       enable row level security;

do $$
begin
  execute 'create policy org_isolation on proj.cost_codes         for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.archetype_profiles for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
  execute 'create policy org_isolation on proj.job_settings       for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())';
exception when duplicate_object then null;  -- idempotent re-run
end $$;

grant select, insert, update, delete on all tables in schema proj to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- §1.3  proj.job_cap(job_id, capability) — the polymorphic switch.
--   Resolution: per-job override (job_settings) -> archetype default
--   (archetype_profiles keyed on core.jobs.archetype) -> false.
--   Every downstream engine gates on THIS, never on the archetype string.
-- ----------------------------------------------------------------------------
create or replace function proj.job_cap(p_job_id uuid, p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'proj', 'core', 'public'
as $function$
declare
  v_org      uuid;
  v_arch     text;
  v_override boolean;
  v_default  boolean;
begin
  if p_capability not in
     ('uses_sov','uses_retainage','uses_commitments','uses_pricebook','uses_allowances','uses_external_gates') then
    raise exception 'job_cap: unknown capability %', p_capability;
  end if;

  -- Resolve org + archetype from the job itself (read-authoritative = core.jobs),
  -- NOT from get_org_id(): this keeps the switch correct in any definer context
  -- and testable, while in-app the job's org always equals the caller's org.
  select org_id, archetype into v_org, v_arch from core.jobs where id = p_job_id;
  if v_org is null then
    return false;                       -- unknown job -> no capability
  end if;

  -- per-job override (null = inherit archetype default)
  execute format('select %I from proj.job_settings where job_id = $1 and org_id = $2', p_capability)
    into v_override using p_job_id, v_org;
  if v_override is not null then
    return v_override;
  end if;

  -- archetype default
  if v_arch is null then
    return false;
  end if;
  execute format('select %I from proj.archetype_profiles where org_id = $1 and archetype = $2', p_capability)
    into v_default using v_org, v_arch;

  return coalesce(v_default, false);
end $function$;

-- ----------------------------------------------------------------------------
-- §0.3  extend drain_job_costs — resolve cost_code_id from the additive
--   nullable JOB_COST payload key `cost_code` on apply. Keying (org_id,
--   source_ref), lifecycle, monotonic guard, and idempotency are UNCHANGED;
--   this only enriches the row with the cost dimension. commitment_line_id
--   resolution (§4) lands with commitments in a later gate.
-- ----------------------------------------------------------------------------
create or replace function proj.drain_job_costs(p_org_id uuid default null::uuid)
returns table(processed integer, applied integer, skipped integer, rejected integer)
language plpgsql
security definer
set search_path to 'proj', 'core', 'public'
as $function$
declare
  r        record;
  p        jsonb;
  v_src    text;  v_life text;  v_amt bigint;
  v_job    uuid;  v_loc uuid;   v_dept uuid;
  v_ct     text;  v_gate text;  v_occ date;  v_gl uuid;  v_memo text;
  v_code   text;  v_cc_id uuid;                          -- NEW: cost-code enrichment
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
    v_code := nullif(p->>'cost_code','');                 -- NEW: additive nullable key

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

    -- NEW: resolve cost_code_id from the code, preferring a job-scoped code over
    -- the org-level template. Unmatched/absent -> null (job-level "unassigned").
    v_cc_id := null;
    if v_code is not null then
      select cc.id into v_cc_id
      from proj.cost_codes cc
      where cc.org_id = r.org_id
        and cc.code = v_code
        and (cc.job_id = v_job or cc.job_id is null)
      order by (cc.job_id = v_job) desc nulls last
      limit 1;
    end if;

    -- Apply the transition to the ONE cost (keyed on source_ref). Monotonic guard.
    insert into proj.job_costs as jc
      (org_id, job_id, location_id, department_id, source_ref, cost_type,
       amount_cents, lifecycle, gate, occurred_on, gl_entry_id, memo,
       cost_code_id, last_event_id, last_event_at)
    values
      (r.org_id, v_job, v_loc, v_dept, v_src, v_ct,
       v_amt, v_life, v_gate, v_occ, v_gl, v_memo,
       v_cc_id, r.event_id, r.created_at)
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
          cost_code_id  = coalesce(excluded.cost_code_id, jc.cost_code_id),  -- NEW: enrich, never clobber
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
end $function$;

-- ----------------------------------------------------------------------------
-- §0.4  proj.v_cost_code_slippage — per (job, cost_code): budget | committed(open)
--   | actual(cleared) | pending | projected_final | variance. security_invoker
--   so RLS applies. committed(open) is 0 until commitments land (§4/next gate);
--   sourced from job_budget_lines.committed_cents as the interim figure.
-- ----------------------------------------------------------------------------
create or replace view proj.v_cost_code_slippage
with (security_invoker = on) as
with actual as (
  select jc.org_id, jc.job_id, jc.cost_code_id,
         sum(jc.amount_cents) filter (where jc.lifecycle = 'CLEARED') as actual_cents,
         sum(jc.amount_cents) filter (where jc.lifecycle = 'PENDING') as pending_cents
  from proj.job_costs jc
  group by jc.org_id, jc.job_id, jc.cost_code_id
),
budget as (
  select bl.org_id, bl.job_id, bl.cost_code_id,
         sum(bl.budgeted_cents)  as budgeted_cents,
         sum(bl.committed_cents) as committed_cents
  from proj.job_budget_lines bl
  group by bl.org_id, bl.job_id, bl.cost_code_id
)
select
  coalesce(b.org_id, a.org_id)             as org_id,
  coalesce(b.job_id, a.job_id)             as job_id,
  coalesce(b.cost_code_id, a.cost_code_id) as cost_code_id,
  cc.code                                  as cost_code,
  cc.name                                  as cost_code_name,
  coalesce(b.budgeted_cents, 0)            as budgeted_cents,
  coalesce(b.committed_cents, 0)           as committed_open_cents,
  coalesce(a.actual_cents, 0)              as actual_cents,
  coalesce(a.pending_cents, 0)             as pending_cents,
  coalesce(a.actual_cents, 0) + coalesce(b.committed_cents, 0)                                as projected_final_cents,
  coalesce(b.budgeted_cents, 0) - (coalesce(a.actual_cents, 0) + coalesce(b.committed_cents, 0)) as variance_cents
from budget b
full outer join actual a
  on a.org_id = b.org_id and a.job_id = b.job_id and a.cost_code_id is not distinct from b.cost_code_id
left join proj.cost_codes cc
  on cc.id = coalesce(b.cost_code_id, a.cost_code_id);

grant select on proj.v_cost_code_slippage to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Seed archetype_profiles defaults for every existing org (idempotent).
-- Capability defaults reflect the panel model; per-org/per-job overrides layer
-- on top. Millwork insight: uses_sov/retainage are DEFAULTS here, switchable
-- independent of archetype via job_settings.
-- ----------------------------------------------------------------------------
insert into proj.archetype_profiles
  (org_id, archetype, uses_sov, uses_retainage, uses_commitments, uses_pricebook,
   uses_allowances, uses_external_gates, default_billing_mode, default_progress_basis, allows_null_contract)
select o.id, d.archetype, d.uses_sov, d.uses_retainage, d.uses_commitments, d.uses_pricebook,
       d.uses_allowances, d.uses_external_gates, d.default_billing_mode, d.default_progress_basis, d.allows_null_contract
from core.organizations o
cross join (values
  ('project',           true,  true,  true,  false, true,  true,  'FIXED',     'PHYSICAL', false),
  ('field_service',     false, false, false, true,  false, false, 'FLAT_RATE', 'NONE',     false),
  ('ETO',               true,  true,  true,  false, false, true,  'FIXED',     'PHYSICAL', false),
  ('retail_order',      false, false, true,  true,  true,  false, 'FIXED',     'NONE',     false),
  ('engagement',        false, false, false, false, false, false, 'TM',        'NONE',     false),
  ('recurring_service', false, false, false, true,  false, false, 'RECURRING', 'NONE',     false)
) as d(archetype, uses_sov, uses_retainage, uses_commitments, uses_pricebook,
       uses_allowances, uses_external_gates, default_billing_mode, default_progress_basis, allows_null_contract)
on conflict (org_id, archetype) do nothing;
