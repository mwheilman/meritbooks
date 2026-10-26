-- =============================================================================
-- Migration 192: cash workspace — forecast scenarios, adjustments, manual items,
-- per-company cash settings, liquidity lines, weekly forecast snapshots (accuracy)
-- and an append-only cash-forecast audit log (Wave 4C).
-- =============================================================================
-- Audit rows FP-09…FP-12, R17, R18 — docs/audit-2026-10/FEATURE-GAP-AUDIT.md §6.3 Wave 4C;
-- docs/FPB-reports-fpna.md §4.12 (AC-CF1…AC-CF11).
--
-- §1  public.cash_forecast_scenarios    named scenarios (BASE / DOWNSIDE / UPSIDE / CUSTOM),
--                                       per company (location_id) or all companies (NULL).
-- §2  public.cash_forecast_adjustments  a scenario's levers: delay / haircut receipts, delay
--                                       disbursements, remove an item, payroll growth,
--                                       line draw / paydown. Per-kind required fields (CHECK).
-- §3  public.cash_forecast_items        manual line items (one-off or weekly / monthly recurring)
--                                       with a note; scenario_id NULL = every scenario.
-- §4  public.cash_settings              per company: minimum cash, alerts, employer-tax bps,
--                                       estimated tax, opex run-rate basis.
-- §5  public.cash_liquidity_lines       revolver / line availability: commitment, borrowing base,
--                                       drawn override (else derived from bank / debt rows).
-- §6  public.cash_forecast_snapshots    the weekly forecast as it stood (append-only) — the basis of
--                                       forecast-vs-actual accuracy. location_id NULL = combined.
-- §7  public.cash_forecast_events       append-only audit of scenario / item / setting changes.
-- §8  triggers: updated_at, append-only snapshots + events (purge GUC honoured).
-- §9  RLS + grants: members SELECT their org only; every write is the service role (the app,
--     after its permission + client-scope check — the 171 / 189 pattern). M1: functions
--     EXECUTE-revoked from public / anon / authenticated.
-- §10 core.apply_client_scope_rls() + core.apply_projects_only_seat_deny() (guarded).
--
-- No GL effect: nothing here writes gl_entries / gl_entry_lines / bank rows. Recommendations
-- (transfers, line draws) are advice only — nothing moves money.
-- Purge: snapshot / event deletes are allowed inside a server-side purge that sets
--   set local meritbooks.allow_ledger_purge = 'on';   (events also honour meritbooks.allow_audit_purge)
-- Idempotent. PGlite-compatible (no subqueries in CHECKs). Apply to Supabase FIRST, then
-- commit the code that depends on it.
-- =============================================================================

-- ── §1 scenarios ─────────────────────────────────────────────────────────────
create table if not exists public.cash_forecast_scenarios (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  location_id   uuid references core.locations(id) on delete cascade,
  name          text not null,
  kind          text not null default 'CUSTOM',
  description   text,
  is_archived   boolean not null default false,
  created_by    text,
  updated_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_forecast_scenarios_chk') then
    alter table public.cash_forecast_scenarios add constraint cash_forecast_scenarios_chk
      check (kind in ('BASE', 'DOWNSIDE', 'UPSIDE', 'CUSTOM')
             and length(btrim(name)) between 1 and 80
             and (description is null or length(description) <= 1000));
  end if;
end $$;
create unique index if not exists uq_cash_forecast_scenarios_name
  on public.cash_forecast_scenarios (org_id, location_id, lower(name)) nulls not distinct;
create index if not exists ix_cash_forecast_scenarios_scope on public.cash_forecast_scenarios (org_id, location_id);
comment on table public.cash_forecast_scenarios is
  'Mig 192: named cash-forecast scenarios. location_id NULL = applies to every company. The implicit base forecast needs no row; a BASE row only carries base-level adjustments. Service-role writes only.';

-- ── §2 adjustments ───────────────────────────────────────────────────────────
create table if not exists public.cash_forecast_adjustments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  scenario_id    uuid not null references public.cash_forecast_scenarios(id) on delete cascade,
  location_id    uuid references core.locations(id) on delete cascade,
  kind           text not null,
  customer_id    uuid,
  vendor_id      uuid,
  instrument_id  uuid references public.debt_instruments(id) on delete set null,
  item_key       text,
  days           integer,
  bps            integer,
  amount_cents   bigint,
  effective_date date,
  label          text,
  note           text,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_forecast_adjustments_chk') then
    alter table public.cash_forecast_adjustments add constraint cash_forecast_adjustments_chk
      check (kind in ('DELAY_RECEIPTS', 'RECEIPT_HAIRCUT', 'DELAY_DISBURSEMENTS', 'REMOVE_ITEM', 'PAYROLL_GROWTH', 'LINE_DRAW', 'LINE_PAYDOWN')
             and (kind not in ('DELAY_RECEIPTS', 'DELAY_DISBURSEMENTS') or (days is not null and days between -90 and 180 and days <> 0))
             and (kind <> 'RECEIPT_HAIRCUT' or (bps is not null and bps between 1 and 10000))
             and (kind <> 'PAYROLL_GROWTH' or (bps is not null and bps between -5000 and 10000 and bps <> 0))
             and (kind <> 'REMOVE_ITEM' or (item_key is not null and length(item_key) between 1 and 200))
             and (kind not in ('LINE_DRAW', 'LINE_PAYDOWN') or (amount_cents is not null and amount_cents > 0 and effective_date is not null and location_id is not null))
             and (amount_cents is null or amount_cents between 0 and 100000000000000)
             and (label is null or length(label) <= 120)
             and (note is null or length(note) <= 1000));
  end if;
end $$;
create index if not exists ix_cash_forecast_adjustments_scenario on public.cash_forecast_adjustments (scenario_id);
comment on table public.cash_forecast_adjustments is
  'Mig 192: a scenario''s levers. DELAY_* = ± days (customer / vendor or all); RECEIPT_HAIRCUT = bps cut to receipts; PAYROLL_GROWTH = bps on projected (never committed) payroll; REMOVE_ITEM = drop one forecast item by key; LINE_DRAW / LINE_PAYDOWN = dated draw / repayment on a line (moves liquidity headroom).';

-- ── §3 manual items ──────────────────────────────────────────────────────────
create table if not exists public.cash_forecast_items (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id) on delete cascade,
  scenario_id           uuid references public.cash_forecast_scenarios(id) on delete cascade,
  direction             text not null,
  category              text not null,
  label                 text not null,
  expected_date         date not null,
  amount_cents          bigint not null,
  probability_bps       integer not null default 10000,
  recurrence            text not null default 'NONE',
  recurrence_end        date,
  counterparty_location_id uuid references core.locations(id) on delete set null,
  account_id            uuid references public.accounts(id) on delete set null,
  note                  text,
  is_active             boolean not null default true,
  created_by            text,
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_forecast_items_chk') then
    alter table public.cash_forecast_items add constraint cash_forecast_items_chk
      check (direction in ('IN', 'OUT')
             and category in ('DEPOSIT', 'OTHER_IN', 'TRANSFER_IN', 'LINE_DRAW',
                              'CAPEX', 'OPEX', 'TAX', 'DISTRIBUTION', 'TRANSFER_OUT', 'LINE_PAYDOWN', 'OTHER_OUT')
             and ((direction = 'IN' and category in ('DEPOSIT', 'OTHER_IN', 'TRANSFER_IN', 'LINE_DRAW'))
                  or (direction = 'OUT' and category in ('CAPEX', 'OPEX', 'TAX', 'DISTRIBUTION', 'TRANSFER_OUT', 'LINE_PAYDOWN', 'OTHER_OUT')))
             and length(btrim(label)) between 1 and 120
             and amount_cents > 0 and amount_cents <= 100000000000000
             and probability_bps between 1 and 10000
             and recurrence in ('NONE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY')
             and (recurrence_end is null or (recurrence <> 'NONE' and recurrence_end >= expected_date))
             and (counterparty_location_id is null or counterparty_location_id <> location_id)
             and (category not in ('TRANSFER_IN', 'TRANSFER_OUT') or counterparty_location_id is not null)
             and (note is null or length(note) <= 2000));
  end if;
end $$;
create index if not exists ix_cash_forecast_items_scope on public.cash_forecast_items (org_id, location_id, expected_date);
comment on table public.cash_forecast_items is
  'Mig 192: manual cash-forecast lines (deposits, capex, distributions, transfers, line draws …) with a note. scenario_id NULL = in every scenario; set = only that scenario. TRANSFER_* names the other company (excluded from the combined view).';

-- ── §4 settings ──────────────────────────────────────────────────────────────
create table if not exists public.cash_settings (
  id                         uuid primary key default gen_random_uuid(),
  org_id                     uuid not null references core.organizations(id) on delete cascade,
  location_id                uuid not null references core.locations(id) on delete cascade,
  minimum_cash_cents         bigint,
  alerts_enabled             boolean not null default true,
  employer_tax_bps           integer,
  estimated_tax_quarterly_cents bigint,
  runrate_basis              text not null default 'BUDGET',
  include_unapproved_bills   boolean not null default true,
  updated_by                 text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_settings_chk') then
    alter table public.cash_settings add constraint cash_settings_chk
      check ((minimum_cash_cents is null or minimum_cash_cents between 0 and 100000000000000)
             and (employer_tax_bps is null or employer_tax_bps between 0 and 3000)
             and (estimated_tax_quarterly_cents is null or estimated_tax_quarterly_cents between 0 and 100000000000000)
             and runrate_basis in ('BUDGET', 'TRAILING_3M', 'OFF'));
  end if;
end $$;
create unique index if not exists uq_cash_settings_company on public.cash_settings (org_id, location_id);
comment on table public.cash_settings is
  'Mig 192: per-company cash assumptions. minimum_cash_cents NULL = fall back to core.locations.minimum_cash_cents. runrate_basis: BUDGET (published budget) | TRAILING_3M (posted actuals) | OFF.';

-- ── §5 liquidity lines ───────────────────────────────────────────────────────
create table if not exists public.cash_liquidity_lines (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id) on delete cascade,
  instrument_id         uuid references public.debt_instruments(id) on delete set null,
  name                  text not null,
  commitment_cents      bigint not null,
  borrowing_base_cents  bigint,
  drawn_cents           bigint,
  as_of_date            date,
  is_active             boolean not null default true,
  note                  text,
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_liquidity_lines_chk') then
    alter table public.cash_liquidity_lines add constraint cash_liquidity_lines_chk
      check (length(btrim(name)) between 1 and 120
             and commitment_cents between 0 and 100000000000000
             and (borrowing_base_cents is null or borrowing_base_cents between 0 and 100000000000000)
             and (drawn_cents is null or drawn_cents between 0 and 100000000000000)
             and (note is null or length(note) <= 1000));
  end if;
end $$;
create index if not exists ix_cash_liquidity_lines_scope on public.cash_liquidity_lines (org_id, location_id);
comment on table public.cash_liquidity_lines is
  'Mig 192: available credit for liquidity headroom. available = min(commitment, borrowing base) − drawn (floored at 0). drawn NULL = take the linked instrument / bank balance.';

-- ── §6 snapshots (append-only) ───────────────────────────────────────────────
create table if not exists public.cash_forecast_snapshots (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid references core.locations(id) on delete cascade,
  anchor_date     date not null,
  horizon_weeks   integer not null default 13,
  opening_cents   bigint not null,
  closing_cents   bigint not null,
  weeks           jsonb not null,
  engine_version  text not null,
  source          text not null default 'SCHEDULED',
  created_by      text,
  created_at      timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_forecast_snapshots_chk') then
    alter table public.cash_forecast_snapshots add constraint cash_forecast_snapshots_chk
      check (horizon_weeks between 1 and 26
             and jsonb_typeof(weeks) = 'array'
             and source in ('SCHEDULED', 'MANUAL')
             and extract(isodow from anchor_date) = 1);
  end if;
end $$;
create unique index if not exists uq_cash_forecast_snapshots_week
  on public.cash_forecast_snapshots (org_id, location_id, anchor_date) nulls not distinct;
create index if not exists ix_cash_forecast_snapshots_scope on public.cash_forecast_snapshots (org_id, location_id, anchor_date desc);
comment on table public.cash_forecast_snapshots is
  'Mig 192: the base 13-week forecast as it stood on a Monday (location_id NULL = combined). weeks = [{start, inflows:{cat:cents}, outflows:{cat:cents}, closing}]. One per company × week. Append-only (UPDATE / DELETE refused except the purge GUC / cascade).';

-- ── §7 events (append-only) ──────────────────────────────────────────────────
create table if not exists public.cash_forecast_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  location_id   uuid references core.locations(id) on delete cascade,
  event_kind    text not null,
  subject_id    uuid,
  actor_user_id text,
  note          text,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_forecast_events_chk') then
    alter table public.cash_forecast_events add constraint cash_forecast_events_chk
      check (event_kind in ('SCENARIO_CREATED', 'SCENARIO_UPDATED', 'SCENARIO_ARCHIVED', 'ADJUSTMENT_ADDED', 'ADJUSTMENT_REMOVED',
                            'ITEM_CREATED', 'ITEM_UPDATED', 'ITEM_REMOVED', 'SETTINGS_SAVED', 'LINE_SAVED', 'LINE_REMOVED',
                            'SNAPSHOT_TAKEN', 'MIN_CASH_ALERT')
             and (note is null or length(note) <= 1000)
             and jsonb_typeof(meta) = 'object');
  end if;
end $$;
create index if not exists ix_cash_forecast_events_scope on public.cash_forecast_events (org_id, created_at desc);
comment on table public.cash_forecast_events is
  'Mig 192: append-only audit of cash-forecast scenario / item / setting / line changes, snapshots and minimum-cash alerts.';

-- ── §8 triggers ──────────────────────────────────────────────────────────────
create or replace function public.cash_forecast_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if tg_op = 'DELETE' and (pg_trigger_depth() > 1
                           or coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on'
                           or (tg_table_name = 'cash_forecast_events' and coalesce(current_setting('meritbooks.allow_audit_purge', true), '') = 'on')) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['cash_forecast_scenarios', 'cash_forecast_adjustments', 'cash_forecast_items', 'cash_settings', 'cash_liquidity_lines'] loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format('create trigger trg_%s_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
  foreach t in array array['cash_forecast_snapshots', 'cash_forecast_events'] loop
    execute format('drop trigger if exists trg_%s_append_only on public.%I', t, t);
    execute format('create trigger trg_%s_append_only before update or delete on public.%I for each row execute function public.cash_forecast_append_only()', t, t);
  end loop;
end $$;

-- ── §9 RLS + grants (members read their org; the service role writes) ────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['cash_forecast_scenarios', 'cash_forecast_adjustments', 'cash_forecast_items', 'cash_settings',
                           'cash_liquidity_lines', 'cash_forecast_snapshots', 'cash_forecast_events'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t
                and policyname not in ('client_scope_rls', 'projects_only_seat_deny', 'combined_rows_scope') loop
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

-- Functions (M1): trigger-only; never callable by members.
revoke all on function public.cash_forecast_append_only() from public, anon, authenticated;
grant execute on function public.cash_forecast_append_only() to service_role;

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
    foreach t in array array['cash_forecast_scenarios', 'cash_forecast_adjustments', 'cash_forecast_items', 'cash_settings',
                             'cash_liquidity_lines', 'cash_forecast_snapshots', 'cash_forecast_events'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;

-- ── §11 security review H4: org-wide (combined) rows need all-clients scope ───
-- 163's client_scope_rls passes `location_id is null` rows to everyone (org-level rows). A NULL
-- location here is not an org-level setting but the WHOLE org's figures (the combined forecast
-- snapshot; audit events whose meta can carry amounts), so a client-scoped member must not read
-- them. This RESTRICTIVE policy (its own name — 163's re-runnable apply_client_scope_rls() never
-- touches it) adds: a NULL-location row is visible only when core.client_scope_bypass()
-- (service role · scope not enforced · all-clients assignment). The app writes the combined row
-- only for the same callers (lib/cash/forecast/service.ts takeSnapshots `combined`).
do $$
declare t text;
begin
  if to_regprocedure('core.client_scope_bypass()') is null then
    raise notice 'migration 192: core.client_scope_bypass() (163) not present — combined_rows_scope skipped; re-run 192 after 163';
    return;
  end if;
  foreach t in array array['cash_forecast_snapshots', 'cash_forecast_events'] loop
    execute format('drop policy if exists combined_rows_scope on public.%I', t);
    execute format('create policy combined_rows_scope on public.%I as restrictive for all to public '
                   'using (location_id is not null or (select core.client_scope_bypass())) '
                   'with check (location_id is not null or (select core.client_scope_bypass()))', t);
  end loop;
end $$;

-- End migration 192.
