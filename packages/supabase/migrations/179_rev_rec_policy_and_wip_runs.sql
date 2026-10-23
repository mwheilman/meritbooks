-- =============================================================================
-- Migration 179: revenue-recognition policy (the visible election) + the monthly
--                WIP run ledger (Wave 1E — FPB-rev-rec-wip).
-- =============================================================================
-- Owner: "Elect to accrue revenue / accrue AR for underbillings." The method choice
-- already existed (core.locations.rev_rec_method, rev_rec_method_map, the job
-- override); this adds the switches and the month-end run the close consumes.
--
-- §1  public.rev_rec_policies         one row per company (org_id, location_id):
--       accrue_underbillings, defer_overbillings, loss_provision, run_cadence,
--       posting_mode, materiality_cents, retainage_presentation.
-- §2  rev_rec_method_map + two nullable switch columns (job-type override) and
--     public.rev_rec_job_overrides (per-job override + exclude_from_wip).
-- §3  public.rev_rec_wip_runs + public.rev_rec_wip_run_lines — one proposal per
--     company + period + revision, its per-job drill-down, and the three GL entries
--     it posted (WIP adjustment, its reversal, the billings reclass). Status
--     PROPOSED → POSTING (approver's claim) → POSTED | FAILED; PROPOSED → DISMISSED
--     (reason required) | SUPERSEDED; NO_CHANGE.
--     At most one PROPOSED run per company + period (partial unique index).
-- §4  Account roles CONTRACT_LOSS_PROVISION (2450, liability) and
--     CONTRACT_LOSS_EXPENSE (5250, COGS) — created for EVERY org where missing (next
--     to their siblings, else in a same-type group, else in the standard template's
--     group), then the role map is re-seeded (overrides preserved).
-- §5  Write locks (171/172 pattern): RLS on, members SELECT their org only,
--     service_role writes (lib/db/scoped-writer.ts after the route's permission
--     check, org pinned, client scope asserted). No member write grants at all.
-- §6  core.apply_client_scope_rls() re-run (every new table carries location_id).
--
-- No GL effect. Idempotent. PGlite-compatible (no subqueries in CHECKs). Apply to
-- Supabase FIRST, then the code that depends on it.
-- =============================================================================

-- ── §1 company policy ────────────────────────────────────────────────────────
create table if not exists public.rev_rec_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  accrue_underbillings boolean not null default true,
  defer_overbillings boolean not null default true,
  loss_provision boolean not null default true,
  run_cadence text not null default 'MONTHLY_AT_CLOSE',
  posting_mode text not null default 'PROPOSE',
  materiality_cents bigint not null default 0,
  retainage_presentation text not null default 'SEPARATE',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rev_rec_policies_cadence_chk check (run_cadence in ('MONTHLY_AT_CLOSE', 'ON_DEMAND')),
  constraint rev_rec_policies_posting_chk check (posting_mode in ('PROPOSE', 'AUTO_POST')),
  constraint rev_rec_policies_materiality_chk check (materiality_cents >= 0),
  constraint rev_rec_policies_retainage_chk check (retainage_presentation in ('SEPARATE', 'INCLUDED_IN_AR'))
);
create unique index if not exists uq_rev_rec_policies_org_loc on public.rev_rec_policies (org_id, location_id);

comment on table public.rev_rec_policies is
  'Mig 179: the company''s revenue-recognition election (accrue underbillings to 1180, defer overbillings to 2410, loss provision, cadence, posting mode, materiality). The method itself stays on core.locations.rev_rec_method.';

-- ── §2 job-type and job overrides ────────────────────────────────────────────
do $$ begin
  if to_regclass('public.rev_rec_method_map') is not null then
    alter table public.rev_rec_method_map add column if not exists accrue_underbillings boolean;
    alter table public.rev_rec_method_map add column if not exists defer_overbillings boolean;
  end if;
end $$;

create table if not exists public.rev_rec_job_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  job_id uuid not null references core.jobs(id) on delete cascade,
  accrue_underbillings boolean,
  defer_overbillings boolean,
  exclude_from_wip boolean not null default false,
  note text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_rev_rec_job_overrides_org_job on public.rev_rec_job_overrides (org_id, job_id);

-- ── §3 the WIP run ledger ────────────────────────────────────────────────────
create table if not exists public.rev_rec_wip_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  period_key text not null,                 -- 'YYYY-MM'
  as_of_date date not null,                 -- last day of the period
  revision int not null default 1,
  status text not null default 'PROPOSED',
  source text not null default 'MANUAL',
  job_count int not null default 0,
  underbilled_cents bigint not null default 0,
  overbilled_cents bigint not null default 0,
  loss_provision_cents bigint not null default 0,
  net_revenue_adjustment_cents bigint not null default 0,
  reclass_cents bigint not null default 0,
  gross_adjustment_cents bigint not null default 0,
  gl_unbilled_cents bigint,
  gl_deferred_cents bigint,
  policy_snapshot jsonb not null default '{}'::jsonb,
  requested_by text,
  proposed_at timestamptz not null default now(),
  approved_by text,
  posted_at timestamptz,
  wip_entry_id uuid references public.gl_entries(id),
  reversal_entry_id uuid references public.gl_entries(id),
  reclass_entry_id uuid references public.gl_entries(id),
  reversal_pending boolean not null default false,
  dismissed_by text,
  dismissed_at timestamptz,
  dismiss_reason text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rev_rec_wip_runs_period_chk check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint rev_rec_wip_runs_status_chk check (status in ('PROPOSED', 'POSTING', 'POSTED', 'DISMISSED', 'SUPERSEDED', 'NO_CHANGE', 'FAILED')),
  constraint rev_rec_wip_runs_source_chk check (source in ('MANUAL', 'SCHEDULER')),
  constraint rev_rec_wip_runs_revision_chk check (revision >= 1),
  constraint rev_rec_wip_runs_dismiss_reason_chk check (
    status <> 'DISMISSED' or (dismiss_reason is not null and length(btrim(dismiss_reason)) >= 4))
);
-- POSTING = an approver has claimed the run and is posting it (PROPOSED → POSTING → POSTED |
-- FAILED, or back to PROPOSED when refused before anything posted). Re-asserted so a database
-- that already has the table picks up the widened check.
do $$ begin
  alter table public.rev_rec_wip_runs drop constraint if exists rev_rec_wip_runs_status_chk;
  alter table public.rev_rec_wip_runs add constraint rev_rec_wip_runs_status_chk
    check (status in ('PROPOSED', 'POSTING', 'POSTED', 'DISMISSED', 'SUPERSEDED', 'NO_CHANGE', 'FAILED'));
end $$;
create unique index if not exists uq_rev_rec_wip_runs_rev on public.rev_rec_wip_runs (org_id, location_id, period_key, revision);
create unique index if not exists uq_rev_rec_wip_runs_one_proposed
  on public.rev_rec_wip_runs (org_id, location_id, period_key) where status = 'PROPOSED';
create index if not exists ix_rev_rec_wip_runs_org_period on public.rev_rec_wip_runs (org_id, period_key);

comment on table public.rev_rec_wip_runs is
  'Mig 179: one month-end WIP proposal per company + period + revision. Approving posts the self-reversing WIP adjustment (+ reversal dated the 1st of next month) and the permanent billings reclass. Dismissal requires a reason. Consumed by the close task wip_accrual_reviewed.';

create table if not exists public.rev_rec_wip_run_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  run_id uuid not null references public.rev_rec_wip_runs(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  job_id uuid not null references core.jobs(id) on delete cascade,
  job_number text,
  job_name text,
  method text not null,
  contract_cents bigint not null default 0,
  eac_cents bigint not null default 0,
  cost_to_date_cents bigint not null default 0,
  pct_complete numeric(9,6) not null default 0,
  earned_cents bigint not null default 0,
  billed_cents bigint not null default 0,
  retainage_cents bigint not null default 0,
  under_cents bigint not null default 0,
  over_cents bigint not null default 0,
  loss_provision_cents bigint not null default 0,
  est_gross_profit_cents bigint not null default 0,
  prior_est_gross_profit_cents bigint,
  fade_gain_cents bigint,
  perm_unbilled_cents bigint not null default 0,
  perm_deferred_cents bigint not null default 0,
  adj_unbilled_cents bigint not null default 0,
  adj_deferred_cents bigint not null default 0,
  adj_loss_cents bigint not null default 0,
  adj_revenue_cents bigint not null default 0,
  reclass_revenue_cents bigint not null default 0,
  below_materiality boolean not null default false,
  accrue_underbillings boolean not null default true,
  defer_overbillings boolean not null default true,
  policy_source jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ix_rev_rec_wip_run_lines_run on public.rev_rec_wip_run_lines (run_id);
create index if not exists ix_rev_rec_wip_run_lines_job on public.rev_rec_wip_run_lines (org_id, job_id);

-- ── §4 account roles for the loss provision ──────────────────────────────────
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('CONTRACT_LOSS_PROVISION', 'Provision for anticipated contract losses', 'ORG', '2450'),
  ('CONTRACT_LOSS_EXPENSE',   'Anticipated contract losses (COGS)',        'ORG', '5250')
on conflict (role_key) do update
  set label = excluded.label, scope = excluded.scope,
      default_account_number = excluded.default_account_number;

-- EVERY tenant gets both accounts (security review LOW-16: a tenant without the 2410 /
-- 5240 anchors used to get none, so its loss provision could never post). Placement, in
-- order of preference, per org:
--   1. the org-wide group of the anchor (2410 Deferred Revenue / 5240 WIP);
--   2. else the org-wide group of any CURRENT_LIABILITY / COST_OF_GOODS_SOLD account
--      (lowest account number — deterministic);
--   3. else (no chart at all yet) the standard template's own type / sub-type / group
--      ('Liabilities' › 'Current Liabilities' › 'Other Current Liabilities', and
--      'Cost of Goods Sold' › 'Cost of Goods Sold' › 'Other COGS'), created with the same
--      natural keys lib/services/coa-seed.ts upserts on — so a later chart seed merges
--      into them instead of duplicating.
-- A tenant that already has 2450 / 5250 (any type) is left alone.
do $$
declare
  o record;
  spec record;
  v_group uuid;
  v_type uuid;
  v_sub uuid;
begin
  for o in select id from core.organizations loop
    for spec in
      select * from (values
        ('2450', 'Provision for Anticipated Contract Losses', 'LIABILITY', 'Liabilities', 'CREDIT', 2,
         'CURRENT_LIABILITY', 'Current Liabilities', 'Other Current Liabilities', 5, '2410', false),
        ('5250', 'Anticipated Contract Losses', 'COGS', 'Cost of Goods Sold', 'DEBIT', 5,
         'COST_OF_GOODS_SOLD', 'Cost of Goods Sold', 'Other COGS', 3, '5240', true)
      ) as t(num, acct_name, a_type, type_name, normal_bal, type_order, a_sub, sub_name, group_name, group_order, anchor, closes_re)
    loop
      if exists (select 1 from public.accounts x where x.org_id = o.id and x.account_number = spec.num) then
        continue;
      end if;

      select a.account_group_id into v_group
        from public.accounts a
       where a.org_id = o.id and a.account_number = spec.anchor and coalesce(a.is_company_specific, false) = false
       limit 1;

      if v_group is null then
        select a.account_group_id into v_group
          from public.accounts a
         where a.org_id = o.id and coalesce(a.is_company_specific, false) = false
           and a.account_type::text = spec.a_type and a.account_sub_type::text = spec.a_sub
         order by a.account_number
         limit 1;
      end if;

      if v_group is null then
        insert into public.account_types (org_id, name, code, display_order, normal_balance, closes_to_retained_earnings)
        values (o.id, spec.type_name, spec.a_type::account_type_enum, spec.type_order, spec.normal_bal, spec.closes_re)
        on conflict (org_id, code) do nothing;
        select id into v_type from public.account_types where org_id = o.id and code = spec.a_type::account_type_enum;

        insert into public.account_sub_types (org_id, account_type_id, name, code, display_order)
        values (o.id, v_type, spec.sub_name, spec.a_sub::account_sub_type_enum, 1)
        on conflict (org_id, code) do nothing;
        select id into v_sub from public.account_sub_types where org_id = o.id and code = spec.a_sub::account_sub_type_enum;

        insert into public.account_groups (org_id, account_sub_type_id, name, display_order)
        values (o.id, v_sub, spec.group_name, spec.group_order)
        on conflict (org_id, name) do nothing;
        select id into v_group from public.account_groups where org_id = o.id and name = spec.group_name;
      end if;

      if v_group is not null then
        insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type,
                                     is_active, approval_status, display_order)
        values (o.id, v_group, spec.num, spec.acct_name, spec.a_type::account_type_enum, spec.a_sub::account_sub_type_enum,
                true, 'APPROVED', 10)
        on conflict do nothing;
      end if;
      v_group := null;
    end loop;
  end loop;
end $$;

do $$ declare o record; begin
  if to_regprocedure('public.seed_account_roles(uuid)') is not null then
    for o in select id from core.organizations loop perform public.seed_account_roles(o.id); end loop;
  end if;
end $$;

-- ── §5 write locks: members read their org, the service role writes ─────────
do $$
declare t text;
begin
  foreach t in array array['rev_rec_policies', 'rev_rec_job_overrides', 'rev_rec_wip_runs', 'rev_rec_wip_run_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'member_read') then
      execute format('create policy member_read on public.%I for select using (org_id = public.get_org_id())', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'service_all') then
      execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    end if;
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- updated_at maintenance (when the shared trigger function exists).
do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    foreach t in array array['rev_rec_policies', 'rev_rec_job_overrides', 'rev_rec_wip_runs'] loop
      if not exists (select 1 from pg_trigger where tgname = 'trg_' || t || '_updated') then
        execute format('create trigger %I before update on public.%I for each row execute function set_updated_at()',
                       'trg_' || t || '_updated', t);
      end if;
    end loop;
  end if;
end $$;

-- End migration 179.

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
