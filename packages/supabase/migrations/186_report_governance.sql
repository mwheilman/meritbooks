-- =============================================================================
-- Migration 186: number governance — report releases, restatement snapshots, coverage
-- (Wave 3D). Audit rows FP-15, RP-17 (docs/audit-2026-10/FEATURE-GAP-AUDIT.md §4.9);
-- FPB-tenant-model-consolidation-analytics §18; partner-portal parity M11 / X6.
-- =============================================================================
-- §1  public.report_governance_settings  the release rule per tenant (location_id NULL) or
--                                        per company (a company row overrides the tenant row):
--                                        auto-release on/off, N days after month end, the
--                                        minimum period status (SOFT_CLOSE | HARD_CLOSE), and
--                                        reporting-deadline tiles (jsonb array).
-- §2  public.report_company_coverage     per company: in group from / until (acquisition /
--                                        disposal) so consolidated trends never mix
--                                        pre-acquisition months, plus an admin freshness note.
-- §3  public.report_releases             one row per (company, month): RELEASED (MANUAL | AUTO)
--                                        or WITHDRAWN (reason required). The baseline snapshot
--                                        the restatement check compares against.
-- §4  public.report_release_snapshots    key statement totals + per-account period activity +
--                                        a SHA-256 statement hash, captured at release and on
--                                        every detected change.
-- §5  public.report_restatements         the restatement log: what changed by how much, the
--                                        journal entries that caused it, the reopen reason,
--                                        who / when, finance acknowledgement.
-- §6  RLS + grants: members SELECT their org only; every write is the service role (the app,
--     after its close_mgmt:manage check, org pinned + client scope asserted — the 171/179
--     pattern, lib/db/scoped-writer.ts). M1 lesson: no new functions.
-- §7  core.apply_client_scope_rls() re-run (every new table carries location_id).
-- §8  DB release enforcement: RESTRICTIVE governance_release_gate on period_balances, snapshots,
--     restatements (finance OR released in order); public.report_released_months().
-- §9  release-order trigger (RELEASE_ORDER). §10 append-only restatement log, location FK RESTRICT.
-- §11 Projects-only seat deny on every table (1110 contract).
--
-- No GL effect. Idempotent. PGlite-compatible (no subqueries in CHECKs). Apply to Supabase
-- FIRST, then commit the code that depends on it.
-- =============================================================================

-- ── §1 settings ──────────────────────────────────────────────────────────────
create table if not exists public.report_governance_settings (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid references core.locations(id) on delete cascade,
  auto_release_enabled  boolean not null default false,
  auto_release_days     integer not null default 20,
  auto_release_min_status text not null default 'HARD_CLOSE',
  -- [{ key, label, cadence: monthly|quarterly|annual, days_after_period_end, recipient? }]
  deadlines             jsonb not null default '[]'::jsonb,
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'report_governance_settings_chk') then
    alter table public.report_governance_settings add constraint report_governance_settings_chk
      check (auto_release_days between 0 and 120
             and auto_release_min_status in ('SOFT_CLOSE', 'HARD_CLOSE')
             and jsonb_typeof(deadlines) = 'array');
  end if;
end $$;
create unique index if not exists uq_report_gov_settings_tenant
  on public.report_governance_settings (org_id) where location_id is null;
create unique index if not exists uq_report_gov_settings_company
  on public.report_governance_settings (org_id, location_id) where location_id is not null;
comment on table public.report_governance_settings is
  'Mig 186: report release rule (auto-release N days after month end once the period reaches the minimum status) and reporting-deadline tiles. location_id NULL = tenant default; a company row overrides it.';

-- ── §2 coverage (in group from / until) ─────────────────────────────────────
create table if not exists public.report_company_coverage (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id) on delete cascade,
  in_group_from   date,
  in_group_until  date,
  note            text,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint report_company_coverage_dates_chk
    check (in_group_until is null or in_group_from is null or in_group_until >= in_group_from)
);
create unique index if not exists uq_report_company_coverage
  on public.report_company_coverage (org_id, location_id);
comment on table public.report_company_coverage is
  'Mig 186: the month a company joined (and left) the group. Months outside it are excluded from multi-company views (and from non-finance single-company views); finance may request pro forma.';

-- ── §3 releases ──────────────────────────────────────────────────────────────
create table if not exists public.report_releases (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id) on delete cascade,
  fiscal_period_id      uuid references public.fiscal_periods(id) on delete set null,
  period_year           integer not null,
  period_month          integer not null,
  status                text not null default 'RELEASED',
  release_mode          text not null default 'MANUAL',
  released_at           timestamptz,
  released_by           text,
  release_note          text,
  withdrawn_at          timestamptz,
  withdrawn_by          text,
  withdraw_reason       text,
  baseline_snapshot_id  uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'report_releases_chk') then
    alter table public.report_releases add constraint report_releases_chk
      check (period_month between 1 and 12
             and period_year between 1900 and 9999
             and status in ('RELEASED', 'WITHDRAWN')
             and release_mode in ('MANUAL', 'AUTO')
             and (status <> 'RELEASED' or released_at is not null)
             and (status <> 'WITHDRAWN' or (withdrawn_at is not null
                                            and withdraw_reason is not null
                                            and length(btrim(withdraw_reason)) >= 4)));
  end if;
end $$;
create unique index if not exists uq_report_releases_period
  on public.report_releases (org_id, location_id, period_year, period_month);
create index if not exists idx_report_releases_org on public.report_releases (org_id, status);
comment on table public.report_releases is
  'Mig 186: release of a company-month to non-finance audiences (owner / partner / lender / department head). RELEASED (MANUAL or AUTO-materialized) or WITHDRAWN (reason ≥ 4 chars). Absent row = the auto rule decides at read time.';

-- ── §4 snapshots ─────────────────────────────────────────────────────────────
create table if not exists public.report_release_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id) on delete cascade,
  release_id          uuid references public.report_releases(id) on delete cascade,
  period_year         integer not null,
  period_month        integer not null,
  reason              text not null default 'RELEASE',
  captured_at         timestamptz not null default now(),
  captured_by         text,
  revenue_cents       bigint not null default 0,
  cogs_cents          bigint not null default 0,
  opex_cents          bigint not null default 0,
  other_net_cents     bigint not null default 0,
  net_income_cents    bigint not null default 0,
  assets_cents        bigint,
  liabilities_cents   bigint,
  equity_cents        bigint,
  posted_entry_count  integer not null default 0,
  line_count          integer not null default 0,
  last_posted_at      timestamptz,
  statement_hash      text not null,
  -- { account_id: net debit-minus-credit cents of the month's posted activity }
  account_balances    jsonb not null default '{}'::jsonb
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'report_release_snapshots_chk') then
    alter table public.report_release_snapshots add constraint report_release_snapshots_chk
      check (period_month between 1 and 12
             and reason in ('RELEASE', 'AUTO_RELEASE', 'RESTATEMENT', 'REBASELINE')
             and length(statement_hash) >= 16
             and jsonb_typeof(account_balances) = 'object');
  end if;
end $$;
create index if not exists idx_report_snapshots_period
  on public.report_release_snapshots (org_id, location_id, period_year, period_month, captured_at desc);
comment on table public.report_release_snapshots is
  'Mig 186: key statement totals (bigint cents) + per-account period activity + SHA-256 statement hash, captured at release and whenever a change is detected.';

-- ── §5 restatement log ───────────────────────────────────────────────────────
create table if not exists public.report_restatements (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id) on delete restrict,
  release_id                uuid references public.report_releases(id) on delete set null,
  period_year               integer not null,
  period_month              integer not null,
  prior_snapshot_id         uuid references public.report_release_snapshots(id) on delete set null,
  new_snapshot_id           uuid references public.report_release_snapshots(id) on delete set null,
  detected_at               timestamptz not null default now(),
  detected_by               text,
  detection                 text not null default 'ON_READ',
  revenue_delta_cents       bigint not null default 0,
  cogs_delta_cents          bigint not null default 0,
  opex_delta_cents          bigint not null default 0,
  other_net_delta_cents     bigint not null default 0,
  net_income_delta_cents    bigint not null default 0,
  assets_delta_cents        bigint,
  liabilities_delta_cents   bigint,
  equity_delta_cents        bigint,
  -- [{ account_id, account_number, name, prior_cents, new_cents, delta_cents }]
  changed_accounts          jsonb not null default '[]'::jsonb,
  -- [{ gl_entry_id, entry_number, entry_date, posted_at, voided_at, memo, source_module }]
  cause_entries             jsonb not null default '[]'::jsonb,
  reopen_reason             text,
  acknowledged_at           timestamptz,
  acknowledged_by           text,
  acknowledgement           text,
  created_at                timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'report_restatements_chk') then
    alter table public.report_restatements add constraint report_restatements_chk
      check (period_month between 1 and 12
             and detection in ('ON_READ', 'ON_RELEASE', 'SCHEDULED', 'MANUAL')
             and jsonb_typeof(changed_accounts) = 'array'
             and jsonb_typeof(cause_entries) = 'array'
             and (acknowledged_at is null or (acknowledgement is not null and length(btrim(acknowledgement)) >= 4)));
  end if;
end $$;
-- One restatement per new snapshot: a retried check can never double-log a change.
create unique index if not exists uq_report_restatements_snapshot
  on public.report_restatements (org_id, new_snapshot_id) where new_snapshot_id is not null;
create index if not exists idx_report_restatements_period
  on public.report_restatements (org_id, location_id, period_year, period_month, detected_at desc);
comment on table public.report_restatements is
  'Mig 186: restatement log — a released month whose posted activity changed: deltas (bigint cents), changed accounts, causing journal entries, reopen reason, acknowledgement.';

-- ── §6 RLS + grants (members read their org; service role writes) ─────────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['report_governance_settings', 'report_company_coverage', 'report_releases',
                           'report_release_snapshots', 'report_restatements'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and policyname not in ('client_scope_rls', 'projects_only_seat_deny', 'governance_release_gate', 'budget_department_scope') loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy member_read on public.%I for select to authenticated using (org_id = public.get_org_id())', t);
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- ── §8 DB-level release enforcement (security review H2) ──────────────────────
-- The app governs every figure it returns (lib/reports/governance). The database backs that up
-- for the stores that hold statement figures by month: period_balances (185), the release
-- snapshots and the restatement log. A member who is not finance (core.is_finance_member(),
-- 185) reads only rows of RELEASED (company, month) — released IN ORDER exactly like
-- lib/reports/governance/policy.ts releaseTimeline():
--   own state  = explicit RELEASED row → released; WITHDRAWN row → not; else the auto rule:
--                enabled (company settings row overrides the tenant row), month ended
--                (today > end_date), status not OPEN, not SOFT_CLOSE when the minimum is
--                HARD_CLOSE, today ≥ end_date + auto_release_days (needs a fiscal period);
--   in order   = a month counts only if every EARLIER month with a fiscal period is released
--                on its own state (the first unreleased period holds every later month).
-- "today" is the UTC date, like the app (todayISO()).
-- KNOWN GAP (FPB): raw gl_entry_lines / gl_entries remain org-readable by members (pre-existing),
-- so DB-level release enforcement covers these stores + the service-only report RPCs; the
-- classic report routes enforce in code.

-- One company-month's OWN release state (no in-order rule). Definer: reads releases, settings,
-- periods regardless of the caller. Internal helper — service role / the functions below only.
create or replace function public.report_month_own_released(p_org uuid, p_loc uuid, p_month date)
  returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_y int := extract(year from p_month)::int;
  v_m int := extract(month from p_month)::int;
  v_rel text;
  v_enabled boolean; v_days int; v_min text;
  v_status text; v_end date;
begin
  if p_org is null or p_loc is null or p_month is null then return false; end if;
  select r.status into v_rel from public.report_releases r
   where r.org_id = p_org and r.location_id = p_loc and r.period_year = v_y and r.period_month = v_m;
  if v_rel = 'RELEASED' then return true; end if;
  if v_rel = 'WITHDRAWN' then return false; end if;
  select s.auto_release_enabled, s.auto_release_days, s.auto_release_min_status
    into v_enabled, v_days, v_min
    from public.report_governance_settings s
   where s.org_id = p_org and (s.location_id = p_loc or s.location_id is null)
   order by (s.location_id is null) asc
   limit 1;
  if not coalesce(v_enabled, false) then return false; end if;
  select fp.status::text, fp.end_date into v_status, v_end
    from public.fiscal_periods fp
   where fp.org_id = p_org and fp.location_id = p_loc and fp.period_year = v_y and fp.period_month = v_m;
  if v_status is null then return false; end if;                 -- no period: the auto rule can't apply
  if v_today <= v_end then return false; end if;                 -- not ended
  if v_status = 'OPEN' then return false; end if;
  if v_status = 'SOFT_CLOSE' and coalesce(v_min, 'HARD_CLOSE') = 'HARD_CLOSE' then return false; end if;
  return v_today >= v_end + coalesce(v_days, 20);
end
$$;

-- Is (company, month) released IN ORDER? Own state AND every earlier month with a fiscal
-- period released on its own state.
create or replace function public.report_month_is_released(p_org uuid, p_loc uuid, p_month date)
  returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare p record; v_month date := date_trunc('month', p_month)::date;
begin
  if not public.report_month_own_released(p_org, p_loc, v_month) then return false; end if;
  for p in select make_date(fp.period_year, fp.period_month, 1) as m
             from public.fiscal_periods fp
            where fp.org_id = p_org and fp.location_id = p_loc
              and make_date(fp.period_year, fp.period_month, 1) < v_month
            order by fp.period_year, fp.period_month loop
    if not public.report_month_own_released(p_org, p_loc, p.m) then return false; end if;
  end loop;
  return true;
end
$$;

-- Every released (company, month) of the CALLER's org, in order — evaluated ONCE per query by
-- the policies below (uncorrelated sub-select), not per row.
create or replace function public.report_released_months()
  returns table (location_id uuid, period_start date)
  language plpgsql stable security definer set search_path = public, core, pg_temp as
$$
declare
  v_org uuid := public.get_org_id();
  l record; p record; r record;
  v_held date;
begin
  if v_org is null then return; end if;
  for l in select loc.id from core.locations loc where loc.org_id = v_org loop
    v_held := null;
    for p in select make_date(fp.period_year, fp.period_month, 1) as m
               from public.fiscal_periods fp
              where fp.org_id = v_org and fp.location_id = l.id
              order by fp.period_year, fp.period_month loop
      if not public.report_month_own_released(v_org, l.id, p.m) then
        v_held := p.m;
        exit;
      end if;
      location_id := l.id; period_start := p.m;
      return next;
    end loop;
    -- explicit releases of months without a fiscal period, before the first held month
    for r in select make_date(x.period_year, x.period_month, 1) as m
               from public.report_releases x
              where x.org_id = v_org and x.location_id = l.id and x.status = 'RELEASED'
                and not exists (select 1 from public.fiscal_periods fp
                                 where fp.org_id = v_org and fp.location_id = l.id
                                   and fp.period_year = x.period_year and fp.period_month = x.period_month) loop
      if v_held is null or r.m < v_held then
        location_id := l.id; period_start := r.m;
        return next;
      end if;
    end loop;
  end loop;
  return;
end
$$;

revoke all on function public.report_month_own_released(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.report_month_is_released(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.report_released_months() from public, anon, authenticated;
grant execute on function public.report_month_own_released(uuid, uuid, date) to service_role;
grant execute on function public.report_month_is_released(uuid, uuid, date) to service_role;
-- the policies evaluate it as the caller; it only ever answers for the caller's own org
grant execute on function public.report_released_months() to authenticated, service_role;

-- RESTRICTIVE gate: finance, or a released (company, month).
do $$ begin
  drop policy if exists governance_release_gate on public.period_balances;
  create policy governance_release_gate on public.period_balances as restrictive for select to authenticated
    using ((select core.is_finance_member())
           or (location_id, period_start) in (select r.location_id, r.period_start from public.report_released_months() r));
  drop policy if exists governance_release_gate on public.report_release_snapshots;
  create policy governance_release_gate on public.report_release_snapshots as restrictive for select to authenticated
    using ((select core.is_finance_member())
           or (location_id, make_date(period_year, period_month, 1)) in (select r.location_id, r.period_start from public.report_released_months() r));
  drop policy if exists governance_release_gate on public.report_restatements;
  create policy governance_release_gate on public.report_restatements as restrictive for select to authenticated
    using ((select core.is_finance_member())
           or (location_id, make_date(period_year, period_month, 1)) in (select r.location_id, r.period_start from public.report_released_months() r));
end $$;

-- ── §9 releases go IN ORDER (security review H3) ──────────────────────────────
-- RELEASED (insert, or a status flip to RELEASED) needs the company's previous month — when it
-- has a fiscal period — released (explicit or auto, in order). WITHDRAWN is refused while the
-- next month has an explicit RELEASED row (withdraw the later month first). Otherwise a hidden
-- month could be derived by subtracting two released balance sheets. Purge GUCs bypass.
create or replace function public.report_releases_order_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare
  v_month date;
  v_prev  date;
  v_next  date;
begin
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then return new; end if;
  -- an impossible month is the CHECK's to refuse (report_releases_chk), not this guard's
  if new.period_month not between 1 and 12 or new.period_year not between 1900 and 9999 then return new; end if;
  v_month := make_date(new.period_year, new.period_month, 1);
  if new.status = 'RELEASED' and (tg_op = 'INSERT' or old.status is distinct from 'RELEASED') then
    v_prev := (v_month - interval '1 month')::date;
    if exists (select 1 from public.fiscal_periods fp
                where fp.org_id = new.org_id and fp.location_id = new.location_id
                  and fp.period_year = extract(year from v_prev)::int and fp.period_month = extract(month from v_prev)::int)
       and not public.report_month_is_released(new.org_id, new.location_id, v_prev) then
      raise exception 'RELEASE_ORDER: release %-% first — months are released in order', extract(year from v_prev)::int,
        lpad(extract(month from v_prev)::int::text, 2, '0') using errcode = '23514';
    end if;
  elsif new.status = 'WITHDRAWN' and (tg_op = 'INSERT' or old.status is distinct from 'WITHDRAWN') then
    v_next := (v_month + interval '1 month')::date;
    if exists (select 1 from public.report_releases r
                where r.org_id = new.org_id and r.location_id = new.location_id and r.status = 'RELEASED'
                  and r.period_year = extract(year from v_next)::int and r.period_month = extract(month from v_next)::int) then
      raise exception 'RELEASE_ORDER: withdraw %-% first — a month can''t be withdrawn while the next month is released',
        extract(year from v_next)::int, lpad(extract(month from v_next)::int::text, 2, '0') using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists trg_report_releases_order on public.report_releases;
create trigger trg_report_releases_order before insert or update on public.report_releases
  for each row execute function public.report_releases_order_guard();

-- ── §10 the restatement log is append-only (security review LOW) ─────────────
-- UPDATE may change only the acknowledgement (acknowledged_at / _by / acknowledgement) — and the
-- FK columns release_id / prior_snapshot_id / new_snapshot_id only to NULL (ON DELETE SET NULL).
-- DELETE: cascade (org removal) or a server-side purge (153 GUCs) only.
create or replace function public.report_restatements_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare
  c_mutable constant text[] := array['acknowledged_at', 'acknowledged_by', 'acknowledgement',
                                     'release_id', 'prior_snapshot_id', 'new_snapshot_id'];
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1
       or coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on'
       or coalesce(current_setting('meritbooks.allow_audit_purge', true), '') = 'on' then
      return old;
    end if;
    raise exception 'RESTATEMENT_APPEND_ONLY: the restatement log can''t be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - c_mutable) is distinct from (to_jsonb(old) - c_mutable)
     or (new.release_id is distinct from old.release_id and new.release_id is not null)
     or (new.prior_snapshot_id is distinct from old.prior_snapshot_id and new.prior_snapshot_id is not null)
     or (new.new_snapshot_id is distinct from old.new_snapshot_id and new.new_snapshot_id is not null) then
    raise exception 'RESTATEMENT_APPEND_ONLY: only the acknowledgement of a restatement can change' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists trg_report_restatements_append_only on public.report_restatements;
create trigger trg_report_restatements_append_only before update or delete on public.report_restatements
  for each row execute function public.report_restatements_append_only();

-- the location FK is ON DELETE RESTRICT: a company with a restatement history can't vanish
-- (re-point an existing cascade FK idempotently).
do $$
declare c record;
begin
  for c in select con.conname, con.confdeltype from pg_constraint con
            where con.conrelid = 'public.report_restatements'::regclass and con.contype = 'f'
              and con.confrelid = 'core.locations'::regclass loop
    if c.confdeltype <> 'r' then
      execute format('alter table public.report_restatements drop constraint %I', c.conname);
      alter table public.report_restatements add constraint report_restatements_location_id_fkey
        foreign key (location_id) references core.locations(id) on delete restrict;
    end if;
  end loop;
end $$;

revoke all on function public.report_releases_order_guard() from public, anon, authenticated;
revoke all on function public.report_restatements_append_only() from public, anon, authenticated;
grant execute on function public.report_releases_order_guard() to service_role;
grant execute on function public.report_restatements_append_only() to service_role;

-- End migration 186.

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- ── Projects-only seat deny (1110 contract; guarded: absent in the PGlite replay) ──
-- Every RLS table this migration creates gets the RESTRICTIVE projects_only_seat_deny policy.
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['report_governance_settings', 'report_company_coverage', 'report_releases', 'report_release_snapshots', 'report_restatements'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;
