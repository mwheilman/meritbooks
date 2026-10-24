-- =============================================================================
-- Migration 185: report engine — maintained period balances, custom row layouts,
--                per-user report library state (Wave 3A, FPB-financial-reports §4 A-3A)
-- =============================================================================
-- WHY. Every statement was a bespoke renderer that re-scanned gl_entry_lines (paged,
-- 1,000 rows at a time) per request. The shared report engine reads ONE pre-aggregated
-- store instead: balances by org × company × account × month × dimension × entry kind.
--
-- DESIGN CHOICE — a trigger-MAINTAINED table, not a materialized view:
--   * A materialized view is only as fresh as its last REFRESH (a job / an event drain).
--     A book of record must never show a statement that disagrees with the ledger it
--     owns, even for a minute, and REFRESH ... CONCURRENTLY rewrites the whole org's
--     aggregate on every post. A maintained table is updated INSIDE the posting
--     transaction by delta triggers, so it is exactly as correct as the GL at commit.
--   * Correct under every ledger mutation the app (and the DB guards 152/153) allow:
--       - post: header inserted POSTED, lines inserted in a second statement/txn
--               → each line INSERT under a POSTED header adds its delta;
--       - post by status flip (→ POSTED with lines already present) → add all lines;
--       - void (POSTED → VOIDED) → subtract all lines;
--       - re-date / re-type a POSTED entry (allowed in open periods) → move the delta;
--       - line dimension re-tag (job / memo, allowed on posted lines) → move the delta;
--       - purge / failed-post rollback (header delete) → subtract (BEFORE DELETE), and
--         the cascaded line deletes find no header and add nothing (no double count);
--       - period locks are enforced by the GL triggers themselves: a rejected write
--         rolls back the balance delta with it (same transaction).
--   * Self-healing + provable: rebuild_period_balances(org) recomputes the store from the
--     GL; period_balances_tieout() lists every key where store ≠ GL (empty = tied). The
--     engine's admin tie-out endpoint and a guard test call it.
--
-- KEY. company = the LINE's location_id (same as v_trial_balance, 009) — an intercompany
-- entry's legs belong to the company each leg is booked to. period_start = first day of
-- the calendar month of gl_entries.entry_date (fiscal years are composed of calendar
-- months by the engine using fiscal_year_start_month). entry_kind separates ADJUSTING
-- (TB worksheet columns) and CLOSING (excluded from P&L activity, included in balances)
-- from everything else. Dimensions: department, class, job, item and the counterparty
-- company (intercompany elimination pairing, 035). Nullable dimensions are folded into
-- dim_key so the upsert key is a plain unique constraint (portable; no NULLS NOT DISTINCT).
--
-- BASIS. The store is ACCRUAL (the GL). TAX / CASH / CUSTOM are report-time overlays
-- (reporting_basis_adjustments, mig 147; the live cash conversion) applied by the engine
-- — never stored here, never posted.
--
-- SECURITY. Members SELECT their org (and, under client-scope enforce, only their clients:
-- the table carries location_id so 163's generated restrictive policy covers it); nobody
-- but the service role / the SECURITY DEFINER triggers writes it. M1 lesson: every
-- function is EXECUTE-revoked from public/anon/authenticated and re-granted explicitly.
-- PGlite-compatible (no subqueries in CHECK). Idempotent. Ends with the guarded
-- core.apply_client_scope_rls() call.
-- =============================================================================

-- ── 1. the balances store ────────────────────────────────────────────────────
create table if not exists public.period_balances (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references core.organizations(id) on delete cascade,
  location_id               uuid not null,               -- company (gl_entry_lines.location_id)
  account_id                uuid not null,
  period_start              date not null,               -- first day of the entry_date month
  entry_kind                text not null default 'STANDARD',
  department_id             uuid,
  class_id                  uuid,
  job_id                    uuid,
  item_id                   uuid,
  counterparty_location_id  uuid,
  dim_key                   text not null default '',
  debit_cents               bigint not null default 0,
  credit_cents              bigint not null default 0,
  line_count                integer not null default 0,
  updated_at                timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'period_balances_entry_kind_chk') then
    alter table public.period_balances add constraint period_balances_entry_kind_chk
      check (entry_kind in ('STANDARD', 'ADJUSTING', 'CLOSING'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'period_balances_period_start_chk') then
    alter table public.period_balances add constraint period_balances_period_start_chk
      check (extract(day from period_start) = 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'period_balances_key_uq') then
    alter table public.period_balances add constraint period_balances_key_uq
      unique (org_id, location_id, account_id, period_start, entry_kind, dim_key);
  end if;
end $$;

create index if not exists idx_period_balances_org_loc_period
  on public.period_balances (org_id, location_id, period_start);
create index if not exists idx_period_balances_org_period
  on public.period_balances (org_id, period_start);
create index if not exists idx_period_balances_org_account
  on public.period_balances (org_id, account_id, period_start);

comment on table public.period_balances is
  'Mig 185 (report engine): accrual GL balances by org × company × account × month × dimension × entry kind, maintained IN the posting transaction by triggers on gl_entries/gl_entry_lines (POSTED only). Rebuild: rebuild_period_balances(org). Proof: period_balances_tieout() returns no rows. Never written by members.';

-- Optional per-account cash-flow classification override (FPB D13 #1). NULL = the engine
-- derives it from type / sub-type / role / bank flag (never from number ranges).
alter table public.accounts add column if not exists cash_flow_category text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_cash_flow_category_chk') then
    alter table public.accounts add constraint accounts_cash_flow_category_chk
      check (cash_flow_category is null or cash_flow_category in ('CASH', 'OPERATING', 'INVESTING', 'FINANCING', 'NONCASH'));
  end if;
end $$;
comment on column public.accounts.cash_flow_category is
  'Mig 185: optional cash-flow statement override (CASH | OPERATING | INVESTING | FINANCING | NONCASH). NULL = derived by the report engine from type / sub-type / role / bank flag.';

-- ── 2. helpers ───────────────────────────────────────────────────────────────
create or replace function public.pb_entry_kind(p_entry_type text) returns text
  language sql immutable set search_path = public, pg_temp as
$$
  select case p_entry_type when 'ADJUSTING' then 'ADJUSTING' when 'CLOSING' then 'CLOSING' else 'STANDARD' end
$$;

create or replace function public.pb_dim_key(p_dept uuid, p_class uuid, p_job uuid, p_item uuid, p_cp uuid) returns text
  language sql immutable set search_path = public, pg_temp as
$$
  select coalesce(p_dept::text, '') || '|' || coalesce(p_class::text, '') || '|' || coalesce(p_job::text, '')
      || '|' || coalesce(p_item::text, '') || '|' || coalesce(p_cp::text, '')
$$;

-- Apply one signed delta to one bucket (upsert; drops a bucket that returns to empty).
create or replace function public.pb_apply(
  p_org uuid, p_loc uuid, p_account uuid, p_entry_date date, p_kind text,
  p_dept uuid, p_class uuid, p_job uuid, p_item uuid, p_cp uuid,
  p_debit bigint, p_credit bigint, p_lines integer
) returns void
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_key   text := public.pb_dim_key(p_dept, p_class, p_job, p_item, p_cp);
  v_start date := date_trunc('month', p_entry_date)::date;
begin
  insert into public.period_balances as pb
    (org_id, location_id, account_id, period_start, entry_kind,
     department_id, class_id, job_id, item_id, counterparty_location_id, dim_key,
     debit_cents, credit_cents, line_count, updated_at)
  values
    (p_org, p_loc, p_account, v_start, p_kind,
     p_dept, p_class, p_job, p_item, p_cp, v_key,
     p_debit, p_credit, p_lines, now())
  on conflict (org_id, location_id, account_id, period_start, entry_kind, dim_key) do update
    set debit_cents  = pb.debit_cents  + excluded.debit_cents,
        credit_cents = pb.credit_cents + excluded.credit_cents,
        line_count   = pb.line_count   + excluded.line_count,
        updated_at   = now();
  if p_lines < 0 then
    delete from public.period_balances
     where org_id = p_org and location_id = p_loc and account_id = p_account
       and period_start = v_start and entry_kind = p_kind and dim_key = v_key
       and line_count <= 0 and debit_cents = 0 and credit_cents = 0;
  end if;
end;
$$;

-- Add (p_sign = 1) or remove (p_sign = -1) every line of one entry.
create or replace function public.pb_apply_entry(p_entry_id uuid, p_entry_date date, p_kind text, p_sign integer)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare r record;
begin
  for r in
    select l.org_id, l.location_id, l.account_id, l.department_id, l.class_id, l.job_id, l.item_id,
           l.counterparty_location_id, sum(l.debit_cents)::bigint as dr, sum(l.credit_cents)::bigint as cr,
           count(*)::int as n
      from public.gl_entry_lines l
     where l.gl_entry_id = p_entry_id
     group by l.org_id, l.location_id, l.account_id, l.department_id, l.class_id, l.job_id, l.item_id,
              l.counterparty_location_id
  loop
    perform public.pb_apply(r.org_id, r.location_id, r.account_id, p_entry_date, p_kind,
                            r.department_id, r.class_id, r.job_id, r.item_id, r.counterparty_location_id,
                            p_sign * r.dr, p_sign * r.cr, p_sign * r.n);
  end loop;
end;
$$;

-- ── 3. maintenance triggers ──────────────────────────────────────────────────
-- Lines: a line contributes only while its header is POSTED.
create or replace function public.pb_on_line_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare h record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select e.status::text as status, e.entry_date, e.entry_type::text as entry_type
      into h from public.gl_entries e where e.id = old.gl_entry_id;
    -- Not found = the header is being deleted (cascade); its BEFORE DELETE trigger
    -- already removed the contribution.
    if found and h.status = 'POSTED' then
      perform public.pb_apply(old.org_id, old.location_id, old.account_id, h.entry_date,
                              public.pb_entry_kind(h.entry_type),
                              old.department_id, old.class_id, old.job_id, old.item_id,
                              old.counterparty_location_id,
                              -old.debit_cents, -old.credit_cents, -1);
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select e.status::text as status, e.entry_date, e.entry_type::text as entry_type
      into h from public.gl_entries e where e.id = new.gl_entry_id;
    if found and h.status = 'POSTED' then
      perform public.pb_apply(new.org_id, new.location_id, new.account_id, h.entry_date,
                              public.pb_entry_kind(h.entry_type),
                              new.department_id, new.class_id, new.job_id, new.item_id,
                              new.counterparty_location_id,
                              new.debit_cents, new.credit_cents, 1);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_pb_line_change on public.gl_entry_lines;
create trigger trg_pb_line_change
  after insert or update or delete on public.gl_entry_lines
  for each row execute function public.pb_on_line_change();

-- Headers: status flips, re-dating, re-typing.
create or replace function public.pb_on_header_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_was boolean := old.status::text = 'POSTED';
  v_is  boolean := new.status::text = 'POSTED';
  v_moved boolean := old.entry_date is distinct from new.entry_date
                  or old.entry_type is distinct from new.entry_type;
begin
  if v_was and (not v_is or v_moved) then
    perform public.pb_apply_entry(old.id, old.entry_date, public.pb_entry_kind(old.entry_type::text), -1);
  end if;
  if v_is and (not v_was or v_moved) then
    perform public.pb_apply_entry(new.id, new.entry_date, public.pb_entry_kind(new.entry_type::text), 1);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_pb_header_update on public.gl_entries;
create trigger trg_pb_header_update
  after update of status, entry_date, entry_type on public.gl_entries
  for each row execute function public.pb_on_header_update();

-- Header delete (purge path / failed-post rollback): remove before the lines cascade.
create or replace function public.pb_on_header_delete() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if old.status::text = 'POSTED' then
    perform public.pb_apply_entry(old.id, old.entry_date, public.pb_entry_kind(old.entry_type::text), -1);
  end if;
  return old;
end;
$$;

drop trigger if exists trg_pb_header_delete on public.gl_entries;
create trigger trg_pb_header_delete
  before delete on public.gl_entries
  for each row execute function public.pb_on_header_delete();

-- ── 4. rebuild + tie-out ─────────────────────────────────────────────────────
-- Recompute one org's store from the GL (service role only: repair / backfill).
create or replace function public.rebuild_period_balances(p_org uuid) returns integer
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_n integer;
begin
  if p_org is null then
    raise exception 'rebuild_period_balances: org required';
  end if;
  delete from public.period_balances where org_id = p_org;
  insert into public.period_balances
    (org_id, location_id, account_id, period_start, entry_kind,
     department_id, class_id, job_id, item_id, counterparty_location_id, dim_key,
     debit_cents, credit_cents, line_count, updated_at)
  select l.org_id, l.location_id, l.account_id, date_trunc('month', e.entry_date)::date,
         public.pb_entry_kind(e.entry_type::text),
         l.department_id, l.class_id, l.job_id, l.item_id, l.counterparty_location_id,
         public.pb_dim_key(l.department_id, l.class_id, l.job_id, l.item_id, l.counterparty_location_id),
         sum(l.debit_cents), sum(l.credit_cents), count(*), now()
    from public.gl_entry_lines l
    join public.gl_entries e on e.id = l.gl_entry_id
   where l.org_id = p_org and e.status::text = 'POSTED'
   group by l.org_id, l.location_id, l.account_id, date_trunc('month', e.entry_date)::date,
            public.pb_entry_kind(e.entry_type::text),
            l.department_id, l.class_id, l.job_id, l.item_id, l.counterparty_location_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Every key where the store disagrees with the GL. SECURITY INVOKER: a member sees the
-- comparison over exactly the rows RLS (org + client scope) lets them see on BOTH sides.
create or replace function public.period_balances_tieout(p_org uuid default null)
returns table (
  location_id uuid, account_id uuid, period_start date, entry_kind text, dim_key text,
  gl_debit_cents bigint, gl_credit_cents bigint, store_debit_cents bigint, store_credit_cents bigint
)
  language sql stable set search_path = public, pg_temp as
$$
  with gl as (
    select l.location_id, l.account_id, date_trunc('month', e.entry_date)::date as period_start,
           public.pb_entry_kind(e.entry_type::text) as entry_kind,
           public.pb_dim_key(l.department_id, l.class_id, l.job_id, l.item_id, l.counterparty_location_id) as dim_key,
           sum(l.debit_cents)::bigint as dr, sum(l.credit_cents)::bigint as cr
      from public.gl_entry_lines l
      join public.gl_entries e on e.id = l.gl_entry_id
     where e.status::text = 'POSTED'
       and l.org_id = coalesce(p_org, public.get_org_id())
     group by 1, 2, 3, 4, 5
  ), st as (
    select pb.location_id, pb.account_id, pb.period_start, pb.entry_kind, pb.dim_key,
           sum(pb.debit_cents)::bigint as dr, sum(pb.credit_cents)::bigint as cr
      from public.period_balances pb
     where pb.org_id = coalesce(p_org, public.get_org_id())
     group by 1, 2, 3, 4, 5
  )
  select coalesce(gl.location_id, st.location_id), coalesce(gl.account_id, st.account_id),
         coalesce(gl.period_start, st.period_start), coalesce(gl.entry_kind, st.entry_kind),
         coalesce(gl.dim_key, st.dim_key),
         coalesce(gl.dr, 0), coalesce(gl.cr, 0), coalesce(st.dr, 0), coalesce(st.cr, 0)
    from gl
    full outer join st
      on st.location_id = gl.location_id and st.account_id = gl.account_id
     and st.period_start = gl.period_start and st.entry_kind = gl.entry_kind and st.dim_key = gl.dim_key
   where coalesce(gl.dr, 0) <> coalesce(st.dr, 0) or coalesce(gl.cr, 0) <> coalesce(st.cr, 0)
$$;

-- ── 5. the engine's read path (one round-trip, not row-capped) ───────────────
-- Aggregates the store for a set of companies and a month range, grouped by company ×
-- account × month × entry kind × ONLY the requested dimensions (others folded away).
-- p_opening = true adds one bucket per key (period_start NULL) with everything BEFORE
-- p_from — the opening balance a balance sheet / retained-earnings roll needs.
-- p_org: the caller's org (a member asking for another org gets nothing — RLS); the
-- service role (pack compiler, tests) must name it.
-- Months the range cuts mid-month (MTD / custom day ranges) are read from the GL lines
-- themselves at exact dates; every whole month comes from the store.
-- Returns one jsonb document ({ "rows": [[...], ...] }) so PostgREST's max-rows cap can
-- never truncate a statement. SECURITY INVOKER: RLS (org + client scope) applies.
-- Row shape: [location_id, account_id, period_start|null, entry_kind, department_id,
--             class_id, job_id, item_id, counterparty_location_id, debit_cents, credit_cents]
create or replace function public.report_balances(
  p_location_ids jsonb default null,
  p_from date default null,
  p_to date default null,
  p_dims jsonb default '[]'::jsonb,
  p_opening boolean default false,
  p_org uuid default null
) returns jsonb
  language sql stable set search_path = public, pg_temp as
$$
  with prm as (
    select coalesce(p_org, public.get_org_id()) as org,
           date_trunc('month', p_from)::date as fm,
           (p_from is not null and p_from <> date_trunc('month', p_from)::date) as from_partial,
           date_trunc('month', p_to)::date as tm,
           (p_to is not null and p_to <> (date_trunc('month', p_to) + interval '1 month - 1 day')::date) as to_partial
  ), store as (
    -- whole months from the maintained store (edge months cut mid-month are excluded here)
    select pb.location_id, pb.account_id,
           case when p_opening and p_from is not null and pb.period_start < p_from then null else pb.period_start end as bucket,
           pb.entry_kind, pb.department_id, pb.class_id, pb.job_id, pb.item_id, pb.counterparty_location_id,
           pb.debit_cents, pb.credit_cents
      from public.period_balances pb, prm
     where pb.org_id = prm.org
       and (p_location_ids is null or jsonb_array_length(p_location_ids) = 0
            or pb.location_id::text in (select jsonb_array_elements_text(p_location_ids)))
       and (p_to is null or pb.period_start <= p_to)
       and (p_from is null or p_opening or pb.period_start >= p_from)
       and not (prm.from_partial and pb.period_start = prm.fm)
       and not (prm.to_partial and pb.period_start = prm.tm)
  ), edge as (
    -- a month cut mid-month (MTD / custom day ranges): exact dates from the ledger itself
    select l.location_id, l.account_id,
           case when p_opening and p_from is not null and e.entry_date < p_from then null
                else date_trunc('month', e.entry_date)::date end as bucket,
           public.pb_entry_kind(e.entry_type::text) as entry_kind,
           l.department_id, l.class_id, l.job_id, l.item_id, l.counterparty_location_id,
           l.debit_cents, l.credit_cents
      from public.gl_entry_lines l
      join public.gl_entries e on e.id = l.gl_entry_id, prm
     where (prm.from_partial or prm.to_partial)
       and e.status::text = 'POSTED'
       and l.org_id = prm.org
       and (p_location_ids is null or jsonb_array_length(p_location_ids) = 0
            or l.location_id::text in (select jsonb_array_elements_text(p_location_ids)))
       and ((prm.from_partial and date_trunc('month', e.entry_date)::date = prm.fm)
            or (prm.to_partial and date_trunc('month', e.entry_date)::date = prm.tm))
       and (p_to is null or e.entry_date <= p_to)
       and (p_from is null or p_opening or e.entry_date >= p_from)
  ), src as (
    select * from store union all select * from edge
  ), agg as (
    select location_id, account_id, bucket, entry_kind,
           case when p_dims ? 'department' then department_id end as department_id,
           case when p_dims ? 'class' then class_id end as class_id,
           case when p_dims ? 'job' then job_id end as job_id,
           case when p_dims ? 'item' then item_id end as item_id,
           case when p_dims ? 'counterparty' then counterparty_location_id end as cp_id,
           sum(debit_cents)::bigint as dr, sum(credit_cents)::bigint as cr
      from src
     group by 1, 2, 3, 4, 5, 6, 7, 8, 9
  )
  select jsonb_build_object(
           'rows', coalesce(jsonb_agg(jsonb_build_array(
             location_id, account_id, bucket, entry_kind, department_id, class_id, job_id, item_id,
             cp_id, dr, cr)), '[]'::jsonb),
           'count', count(*))
    from agg
$$;

-- The engine's DRILL path: the GL lines behind one statement cell, read from the LEDGER
-- itself (not the store) so a drill independently proves the figure. Returns one jsonb
-- document: totals over the WHOLE filtered set (so the panel can show "these N lines sum
-- to the cell") plus one page of lines with a running balance. SECURITY INVOKER (RLS).
--   p_dims: {"department": uuid|null, "class": …, "job": …, "item": …, "counterparty": …}
--           key absent = no filter · JSON null = IS NULL (the "Unassigned" column) · uuid = equals
--           "windows": {"<location uuid>": {"from": date|null, "to": date|null}} narrows a
--           company's lines to its in-group window (the engine's pre-acquisition exclusion)
--   p_kinds: entry kinds to include (default all three)
create or replace function public.report_drill_lines(
  p_account_ids jsonb default null,
  p_location_ids jsonb default null,
  p_from date default null,
  p_to date default null,
  p_dims jsonb default '{}'::jsonb,
  p_kinds jsonb default '["STANDARD","ADJUSTING","CLOSING"]'::jsonb,
  p_limit integer default 100,
  p_offset integer default 0,
  p_org uuid default null
) returns jsonb
  language sql stable set search_path = public, pg_temp as
$$
  with f as (
    select l.id as line_id, l.gl_entry_id, e.entry_number, e.entry_date, e.entry_type::text as entry_type,
           coalesce(nullif(l.memo, ''), e.memo) as memo, e.source_module, e.source_id,
           l.location_id, l.account_id, l.department_id, l.class_id, l.job_id, l.item_id,
           l.counterparty_location_id, l.line_number, l.debit_cents, l.credit_cents
      from public.gl_entry_lines l
      join public.gl_entries e on e.id = l.gl_entry_id
     where e.status::text = 'POSTED'
       and l.org_id = coalesce(p_org, public.get_org_id())
       and (p_account_ids is null or jsonb_array_length(p_account_ids) = 0
            or l.account_id::text in (select jsonb_array_elements_text(p_account_ids)))
       and (p_location_ids is null or jsonb_array_length(p_location_ids) = 0
            or l.location_id::text in (select jsonb_array_elements_text(p_location_ids)))
       and (p_from is null or e.entry_date >= p_from)
       and (p_to is null or e.entry_date <= p_to)
       and public.pb_entry_kind(e.entry_type::text) in (select jsonb_array_elements_text(coalesce(p_kinds, '["STANDARD","ADJUSTING","CLOSING"]'::jsonb)))
       and (not (p_dims ? 'department') or (p_dims->>'department' is null and l.department_id is null) or l.department_id::text = p_dims->>'department')
       and (not (p_dims ? 'class') or (p_dims->>'class' is null and l.class_id is null) or l.class_id::text = p_dims->>'class')
       and (not (p_dims ? 'job') or (p_dims->>'job' is null and l.job_id is null) or l.job_id::text = p_dims->>'job')
       and (not (p_dims ? 'item') or (p_dims->>'item' is null and l.item_id is null) or l.item_id::text = p_dims->>'item')
       and (not (p_dims ? 'counterparty') or (p_dims->>'counterparty' is null and l.counterparty_location_id is null) or l.counterparty_location_id::text = p_dims->>'counterparty')
       -- per-company in-group windows (pre-acquisition exclusion): {"windows": {"<location uuid>": {"from": date|null, "to": date|null}}}
       and (not (p_dims ? 'windows') or jsonb_typeof(p_dims->'windows') <> 'object'
            or not ((p_dims->'windows') ? l.location_id::text)
            or ((p_dims->'windows'->l.location_id::text->>'from' is null
                 or e.entry_date >= (p_dims->'windows'->l.location_id::text->>'from')::date)
                and (p_dims->'windows'->l.location_id::text->>'to' is null
                 or e.entry_date <= (p_dims->'windows'->l.location_id::text->>'to')::date)))
  ), w as (
    select f.*, sum(f.debit_cents - f.credit_cents) over (
             order by f.entry_date, f.entry_number, f.line_number, f.line_id rows unbounded preceding)::bigint as running_net
      from f
  ), pg as (
    select * from w order by entry_date, entry_number, line_number, line_id
     limit greatest(least(coalesce(p_limit, 100), 1000), 1) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total_count', (select count(*) from f),
    'debit_cents', (select coalesce(sum(debit_cents), 0)::bigint from f),
    'credit_cents', (select coalesce(sum(credit_cents), 0)::bigint from f),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'line_id', line_id, 'entry_id', gl_entry_id, 'entry_number', entry_number, 'entry_date', entry_date,
        'entry_type', entry_type, 'memo', memo, 'source_module', source_module, 'source_id', source_id,
        'location_id', location_id, 'account_id', account_id, 'department_id', department_id,
        'class_id', class_id, 'job_id', job_id, 'line_number', line_number,
        'debit_cents', debit_cents, 'credit_cents', credit_cents, 'running_net_cents', running_net)
        order by entry_date, entry_number, line_number, line_id) from pg), '[]'::jsonb))
$$;

-- ── 6. custom statement layouts (row designer, MVP) ──────────────────────────
create table if not exists public.report_layouts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  name         text not null,
  statement    text not null default 'PNL',
  description  text,
  rows         jsonb not null default '[]'::jsonb,
  is_archived  boolean not null default false,
  created_by   text,
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'report_layouts_statement_chk') then
    alter table public.report_layouts add constraint report_layouts_statement_chk
      check (statement in ('PNL', 'BS'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'report_layouts_rows_array_chk') then
    alter table public.report_layouts add constraint report_layouts_rows_array_chk
      check (jsonb_typeof(rows) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'report_layouts_name_len_chk') then
    alter table public.report_layouts add constraint report_layouts_name_len_chk
      check (char_length(name) between 1 and 120);
  end if;
end $$;
create unique index if not exists uq_report_layouts_org_name
  on public.report_layouts (org_id, lower(name)) where not is_archived;
comment on table public.report_layouts is
  'Mig 185: tenant statement layouts for the report engine row designer (headers, account ranges / groups / roles, subtotals, formula rows, spacers, sign). Validated by lib/reports/engine/layout.ts before save. Service-role writes only.';

-- ── 7. per-user report library state (favourites, recently run) ──────────────
create table if not exists public.report_user_prefs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  user_id       text not null,                -- Clerk user id (text, canon)
  report_key    text not null,
  is_favorite   boolean not null default false,
  run_count     integer not null default 0,
  last_run_at   timestamptz,
  last_config   jsonb,
  updated_at    timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'report_user_prefs_key_uq') then
    alter table public.report_user_prefs add constraint report_user_prefs_key_uq unique (org_id, user_id, report_key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'report_user_prefs_key_chk') then
    alter table public.report_user_prefs add constraint report_user_prefs_key_chk
      check (report_key ~ '^[a-z0-9_]{1,64}$');
  end if;
end $$;
create index if not exists idx_report_user_prefs_user on public.report_user_prefs (org_id, user_id, last_run_at desc);

-- ── 8. RLS + grants (members read; service role / definer triggers write) ────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['period_balances', 'report_layouts', 'report_user_prefs'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and policyname not in ('client_scope_rls', 'projects_only_seat_deny', 'governance_release_gate', 'budget_department_scope') loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    if t = 'report_user_prefs' then
      -- own rows only: a user's favourites / history are not their colleagues' business
      execute format($p$create policy member_read on public.%I for select to authenticated
        using (org_id = public.get_org_id()
               and user_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))$p$, t);
    else
      execute format('create policy member_read on public.%I for select to authenticated using (org_id = public.get_org_id())', t);
    end if;
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- function privileges (M1 lesson: revoke from everyone, then grant explicitly)
revoke all on function public.pb_entry_kind(text) from public, anon, authenticated;
revoke all on function public.pb_dim_key(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.pb_apply(uuid, uuid, uuid, date, text, uuid, uuid, uuid, uuid, uuid, bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.pb_apply_entry(uuid, date, text, integer) from public, anon, authenticated;
revoke all on function public.pb_on_line_change() from public, anon, authenticated;
revoke all on function public.pb_on_header_update() from public, anon, authenticated;
revoke all on function public.pb_on_header_delete() from public, anon, authenticated;
revoke all on function public.rebuild_period_balances(uuid) from public, anon, authenticated;
revoke all on function public.period_balances_tieout(uuid) from public, anon, authenticated;
revoke all on function public.report_balances(jsonb, date, date, jsonb, boolean, uuid) from public, anon, authenticated;
revoke all on function public.report_drill_lines(jsonb, jsonb, date, date, jsonb, jsonb, integer, integer, uuid) from public, anon, authenticated;

-- invoker-rights read helpers need the pure key helpers too
grant execute on function public.pb_entry_kind(text) to authenticated, service_role;
grant execute on function public.pb_dim_key(uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;
-- H2 (security review): the read RPCs are SERVICE ROLE ONLY. A member calling them straight
-- through PostgREST would get every month of their org's balances with no release (governance)
-- check. The app calls them with the service role, p_org pinned to the caller's org and an
-- explicit, scope-checked company list, AFTER permission + client scope + governance checks.
grant execute on function public.period_balances_tieout(uuid) to service_role;
grant execute on function public.report_balances(jsonb, date, date, jsonb, boolean, uuid) to service_role;
grant execute on function public.report_drill_lines(jsonb, jsonb, date, date, jsonb, jsonb, integer, integer, uuid) to service_role;
grant execute on function public.rebuild_period_balances(uuid) to service_role;
grant execute on function public.pb_apply(uuid, uuid, uuid, date, text, uuid, uuid, uuid, uuid, uuid, bigint, bigint, integer) to service_role;
grant execute on function public.pb_apply_entry(uuid, date, text, integer) to service_role;

-- ── 8b. core.is_finance_member() — the governance audience in the database ───
-- SAME definition as lib/reports/governance/audience.ts: "finance" = the caller holds
-- journal_entries:create OR close_mgmt:manage, following the tenant's enforcement mode:
--   v2              → the capability model: gl.journal_entries:create, or gl.periods edit+approve,
--                     or close.checklist edit+approve (the close_mgmt::manage legacy-map grants);
--   legacy / dual   → the legacy role matrix: the caller's active core.employees role (system or
--                     custom) with the tenant's mig-130 overrides (core.rbac_legacy_cells).
-- Identity from the JWT only (get_org_id() + sub); no JWT / no org → false (fail closed).
-- Used by RESTRICTIVE release-gate policies (186) and budget department scope (189).
create or replace function core.is_finance_member() returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare
  v_org  uuid;
  v_sub  text;
  v_role text;
begin
  v_org := public.get_org_id();
  v_sub := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
  if v_org is null or nullif(btrim(coalesce(v_sub, '')), '') is null then return false; end if;
  if core.access_enforcement_mode_of(v_org) = 'v2' then
    return coalesce(core.has_capability('gl.journal_entries', 'create'), false)
        or (coalesce(core.has_capability('gl.periods', 'edit'), false) and coalesce(core.has_capability('gl.periods', 'approve'), false))
        or (coalesce(core.has_capability('close.checklist', 'edit'), false) and coalesce(core.has_capability('close.checklist', 'approve'), false));
  end if;
  select e.role::text into v_role
    from core.employees e
   where e.clerk_user_id = v_sub and e.org_id = v_org and e.is_active
   limit 1;
  if v_role is null then return false; end if;
  return coalesce(core.rbac_legacy_cells(v_org, v_role, true) && array['journal_entries::create', 'close_mgmt::manage']::text[], false);
end
$$;
comment on function core.is_finance_member() is
  'Mig 185 (H2): is the CALLER (JWT) finance for number governance — journal_entries:create OR close_mgmt:manage, per the tenant enforcement mode (v2 capabilities, else the legacy role matrix + overrides). Mirrors lib/reports/governance/audience.ts.';
revoke all on function core.is_finance_member() from public, anon, authenticated;
grant execute on function core.is_finance_member() to authenticated, service_role;

-- ── 9. backfill from the existing GL (idempotent: a full recompute per org) ──
do $$
declare o record;
begin
  for o in select distinct org_id from public.gl_entry_lines loop
    perform public.rebuild_period_balances(o.org_id);
  end loop;
end $$;

-- End migration 185.

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
    foreach t in array array['period_balances', 'report_layouts', 'report_user_prefs'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;
