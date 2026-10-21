-- ============================================================================
-- 1108 · Merit Projects v2 — shared parties (customers / vendors) and labor rates,
--        time approval + JOB_TIME
--
-- Binding inputs: owner rulings 2026-10-21 (Mike):
--   R1 Customers and vendors have ONE shared master: core.customers / core.vendors. Projects and
--      Books read the same row; nothing "syncs". Adding a customer or vendor in Projects creates
--      the real core row immediately. Books owns terms, credit, tax and compliance; Projects
--      writes identity and contact only.
--   R2 Labor. The retired Books overhead engine does not come back.
--        estimating labor rate = pay rate × (1 + payroll burden) × (1 + overhead allocation)
--                                (Projects only, for bids)
--        direct labor job cost = pay rate × (1 + payroll burden)        (no overhead, ever)
--      Overhead is recovered in gross margin, never charged to the job.
-- Review 03 §3.1 (JOB_TIME), §5.5 (labor cost when the overhead engine is retired).
-- Conventions as 1100–1107: org guard first in every definer function, search_path =
-- pm, core, public, no PUBLIC/anon EXECUTE, composite FKs (org_id, job_id) -> core.jobs
-- (deferrable, so pm.remove_sample_data clears them), RLS USING + WITH CHECK, money bigint
-- cents, percents in pm are FRACTIONS (0.25 = 25 %). core.vendors.default_retainage_pct is a
-- PERCENT (0–100); this migration never writes it.
--
-- Objects
--   parties   pm.create_customer(name, email, phone, location, contact_first, contact_last) -> uuid
--             pm.create_vendor(name, email, phone, kind, location) -> uuid
--             pm.vendor_profiles (kind SUBCONTRACTOR | SUPPLIER | OTHER per vendor; core.vendors
--             has no column for it)
--             Dedupe: an exact case-insensitive, trimmed name match within the org (not deleted)
--             returns the existing id. Definer: core.vendors writes are service_role-only once
--             168 is applied, core.customers once 167 is applied; the functions survive both.
--             Vendors are created provisional: w9_status 'MISSING' (the live CHECK is upper case),
--             so Books' W-9 / COI compliance chase picks them up. Never written: tax / 1099 /
--             TIN / terms / retainage / GL defaults (NOT NULL columns keep their defaults).
--   labor     pm.labor_settings (one row per company: default_burden_pct, default_overhead_pct)
--             pm.labor_rate_cards (one row per trade/role per company)
--             pm.employee_rate_cards (employee -> card, per company)
--             pm.v_labor_rates (security_invoker): cost_rate_cents vs estimating_rate_cents
--             pm.set_labor_settings, pm.save_labor_rate_card, pm.set_employee_rate_card,
--             pm.price_labor_line (member RPCs); pm.labor_rate_for, pm.pay_type_factor (internal)
--             estimate_lines + labor_rate_card_id, labor_hours (trigger prices the line)
--   time      pm.approve_time_entries(ids) -> int, pm.unapprove_time_entry(id, reason) -> uuid
--             pm.time_entry_events (one row per approval / unapproval; what reached Books)
--
-- Rate math (one rule, SQL and apps/projects/src/lib/pm/labor-math.ts agree to the cent):
--   cost_rate_cents       = round(base × (1 + burden))                 -- job cost basis
--   estimating_rate_cents = round(base × (1 + burden) × (1 + overhead)) -- bids only
--   ONLY the estimating rate includes overhead. Each rate is rounded once from the exact
--   product (numeric, no intermediate rounding), half away from zero — for the non-negative
--   amounts here that is half-up on the cent: $30.00 × 1.25 × 1.15 = 4312.5 -> 4313 ($43.13).
--   Percents carry at most 4 decimals (numeric(6,4)), so the products are exact decimals.
--   Line amounts are hours × the CENT rate, rounded once (what the user sees: 10 h × $43.13 =
--   $431.30), so overhead_cents = estimating_cents − cost_cents ties to the cent.
--   Approval pins cost_rate_cents = round(base × (1 + burden) × pay-type factor)
--   (REG 1, OT 1.5, DT 2, PIECE 1, FLAG 1); base = the card's base_rate_cents, else
--   core.employees.hourly_rate_cents; burden = card burden_pct, else the company default, else 0.
--   An estimate labor line: unit_cost_cents = estimating rate (what the bid must recover);
--   cost_cents = round(hours × cost rate) — the BUDGET basis, which reaches Books as
--   JOB_PROGRESS cost_estimate_cents (the cost-to-cost EAC). Putting overhead there would
--   understate % complete against actual labor cost (pay + burden), so it stays out; the overhead
--   component rides in ext._labor.overhead_cents and in the estimate margin.
--
-- Events emitted (core.events, source_module 'PROJECTS', status 'pending'):
--   JOB_TIME (new, schema_version 1, source_ref pm:time:{time_entry_id}) per approved entry,
--   action APPROVED; pm.unapprove_time_entry emits action UNAPPROVED (same source_ref,
--   reverses_event_id) when the approval was emitted. Additive key `revision` counts approvals
--   of the entry (1, 2, … after an unapprove / re-approve) — Books must key its labor JE on
--   source_ref + revision + action (see the 1108 hand-off note).
--   Emitted only when pm.books_present(org) AND pm.books_seam_version(org) >= 2 AND the job is
--   not a sample; otherwise the time_entry_events row records STANDALONE | SAMPLE | SEAM_V1.
--   cost_rate_cents travels as INFORMATION only; Books re-derives labor cost from payroll + burden.
--
-- Idempotent: safe to run twice. Never alters pgrst.db_schemas. Never writes core.jobs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Small internal helpers
-- ----------------------------------------------------------------------------

-- Pay-type multiplier on the base pay rate (FLSA overtime 1.5, double time 2).
-- PIECE / FLAG are costed per hour at the base rate until a piece-rate table exists.
create or replace function pm.pay_type_factor(p_pay_type text) returns numeric
language sql immutable
set search_path = pm, core, public
as $$
  select case upper(coalesce(p_pay_type, 'REG')) when 'OT' then 1.5 when 'DT' then 2.0 else 1.0 end::numeric
$$;

-- Normalized party name for the dedupe rule (trim, collapse inner whitespace, lower case).
create or replace function pm.party_name_key(p_name text) returns text
language sql immutable
set search_path = pm, core, public
as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
$$;

-- ----------------------------------------------------------------------------
-- 1. Parties: customers and vendors on the shared master (R1)
-- ----------------------------------------------------------------------------

-- What kind of vendor Projects added (core.vendors has no column for it).
create table if not exists pm.vendor_profiles (
  org_id       uuid not null references core.organizations(id) on delete cascade,
  vendor_id    uuid not null references core.vendors(id) on delete cascade,
  kind         text not null default 'SUBCONTRACTOR' check (kind in ('SUBCONTRACTOR','SUPPLIER','OTHER')),
  location_id  uuid references core.locations(id),
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (org_id, vendor_id)
);

create or replace function pm.create_customer(
  p_name          text,
  p_email         text default null,
  p_phone         text default null,
  p_location      uuid default null,
  p_contact_first text default null,
  p_contact_last  text default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org   uuid := public.get_org_id();
  v_name  text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_first text := nullif(btrim(coalesce(p_contact_first, '')), '');
  v_last  text := nullif(btrim(coalesce(p_contact_last, '')), '');
  v_id    uuid;
  v_active boolean;
begin
  if v_org is null then
    raise exception 'PM_FORBIDDEN: no organization for the caller' using errcode = '42501';
  end if;
  if p_location is not null and not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_name = '' then raise exception 'PM_INVALID: customer name is required' using errcode = '22023'; end if;
  if length(v_name) > 200 then raise exception 'PM_INVALID: customer name too long (200 max)' using errcode = '22023'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'PM_INVALID: % is not an email address', v_email using errcode = '22023';
  end if;
  if v_phone is not null and length(v_phone) > 40 then raise exception 'PM_INVALID: phone too long' using errcode = '22023'; end if;
  if (v_first is not null and length(v_first) > 100) or (v_last is not null and length(v_last) > 100) then
    raise exception 'PM_INVALID: contact name too long' using errcode = '22023';
  end if;

  -- one creator per (org, name) at a time: two people adding "Harbor Holdings" get one row
  perform pg_advisory_xact_lock(hashtextextended('pm.party:customer:' || v_org::text || ':' || pm.party_name_key(v_name), 0));

  select c.id, c.is_active into v_id, v_active from core.customers c
  where c.org_id = v_org and c.deleted_at is null and pm.party_name_key(c.name) = pm.party_name_key(v_name)
  order by c.is_active desc, c.created_at, c.id
  limit 1;
  if v_id is not null then
    perform pm.log_activity(v_org, p_location, null, 'customer.matched', 'customers', v_id,
      format('Used existing customer %s', v_name), jsonb_build_object('name', v_name, 'is_active', v_active));
    return v_id;
  end if;

  -- identity + contact only; terms, credit, tax, retainage and portal flags keep Books' defaults
  v_id := gen_random_uuid();
  insert into core.customers (id, org_id, name, email, phone, location_id, contact_first_name, contact_last_name, created_by)
  values (v_id, v_org, v_name, v_email, v_phone, p_location, v_first, v_last, pm.current_user_id());

  perform pm.log_activity(v_org, p_location, null, 'customer.created', 'customers', v_id,
    format('Added customer %s', v_name),
    jsonb_build_object('name', v_name, 'email', v_email, 'phone', v_phone, 'source', 'merit_projects'));
  return v_id;
end $$;

create or replace function pm.create_vendor(
  p_name     text,
  p_email    text default null,
  p_phone    text default null,
  p_kind     text default 'SUBCONTRACTOR',
  p_location uuid default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org   uuid := public.get_org_id();
  v_name  text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_kind  text := upper(coalesce(nullif(btrim(p_kind), ''), 'SUBCONTRACTOR'));
  v_id    uuid;
begin
  if v_org is null then
    raise exception 'PM_FORBIDDEN: no organization for the caller' using errcode = '42501';
  end if;
  if p_location is not null and not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_kind not in ('SUBCONTRACTOR','SUPPLIER','OTHER') then
    raise exception 'PM_INVALID: vendor kind must be SUBCONTRACTOR, SUPPLIER or OTHER' using errcode = '22023';
  end if;
  if v_name = '' then raise exception 'PM_INVALID: vendor name is required' using errcode = '22023'; end if;
  if length(v_name) > 200 then raise exception 'PM_INVALID: vendor name too long (200 max)' using errcode = '22023'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'PM_INVALID: % is not an email address', v_email using errcode = '22023';
  end if;
  if v_phone is not null and length(v_phone) > 40 then raise exception 'PM_INVALID: phone too long' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('pm.party:vendor:' || v_org::text || ':' || pm.party_name_key(v_name), 0));

  select v.id into v_id from core.vendors v
  where v.org_id = v_org and v.deleted_at is null and pm.party_name_key(v.name) = pm.party_name_key(v_name)
  order by v.is_active desc, v.created_at, v.id
  limit 1;
  if v_id is not null then
    insert into pm.vendor_profiles (org_id, vendor_id, kind, location_id, created_by)
    values (v_org, v_id, v_kind, p_location, pm.current_user_id())
    on conflict (org_id, vendor_id) do nothing;
    perform pm.log_activity(v_org, p_location, null, 'vendor.matched', 'vendors', v_id,
      format('Used existing vendor %s', v_name), jsonb_build_object('name', v_name, 'kind', v_kind));
    return v_id;
  end if;

  -- Provisional vendor: identity + contact; W-9 MISSING so Books' compliance chase requests the
  -- W-9 and COI. Books owns 1099 eligibility, TIN, terms, retainage default and GL defaults.
  v_id := gen_random_uuid();
  insert into core.vendors (id, org_id, name, email, phone, w9_status, created_by)
  values (v_id, v_org, v_name, v_email, v_phone, 'MISSING', pm.current_user_id());
  insert into pm.vendor_profiles (org_id, vendor_id, kind, location_id, created_by)
  values (v_org, v_id, v_kind, p_location, pm.current_user_id());

  perform pm.log_activity(v_org, p_location, null, 'vendor.created', 'vendors', v_id,
    format('Added %s %s (Merit Books will request the W-9 and COI)', lower(v_kind), v_name),
    jsonb_build_object('name', v_name, 'kind', v_kind, 'email', v_email, 'phone', v_phone, 'w9_status', 'MISSING',
                       'source', 'merit_projects'));
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Labor rates (R2). Fractions; ≥ 0; a ceiling of 5 (500 %) catches a percent typed as a
--    whole number (25 instead of 0.25).
-- ----------------------------------------------------------------------------
create table if not exists pm.labor_settings (
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  default_burden_pct    numeric(6,4) not null default 0,    -- payroll burden: employer taxes, workers' comp, benefits
  default_overhead_pct  numeric(6,4) not null default 0,    -- ESTIMATING ONLY: never in job cost
  notes                 text,
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (org_id, location_id),
  constraint labor_settings_pcts_check check (default_burden_pct >= 0 and default_overhead_pct >= 0
                                              and default_burden_pct <= 5 and default_overhead_pct <= 5)
);
comment on table pm.labor_settings is
  'Company labor defaults (fractions). Job cost = pay × (1 + burden). Estimating rate = pay × (1 + burden) × (1 + overhead); overhead is recovered in gross margin, never charged to the job (owner ruling 2026-10-21).';

create table if not exists pm.labor_rate_cards (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  key              text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label            text not null check (char_length(label) between 1 and 80),
  base_rate_cents  bigint check (base_rate_cents is null or base_rate_cents >= 0),   -- null = each employee's hourly_rate_cents
  burden_pct       numeric(6,4) check (burden_pct is null or (burden_pct >= 0 and burden_pct <= 5)),     -- null = company default
  overhead_pct     numeric(6,4) check (overhead_pct is null or (overhead_pct >= 0 and overhead_pct <= 5)), -- null = company default; estimating only
  bill_rate_cents  bigint check (bill_rate_cents is null or bill_rate_cents >= 0),   -- optional T&M bill rate
  effective_from   date not null default current_date,
  is_active        boolean not null default true,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, location_id, key),
  unique (org_id, id)
);
comment on table pm.labor_rate_cards is
  'One row per trade/role per company. effective_from records when the current rates took effect; approved time pins its own rate, so history lives on the time entries.';

create table if not exists pm.employee_rate_cards (
  org_id        uuid not null references core.organizations(id) on delete cascade,
  employee_id   uuid not null references core.employees(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  rate_card_id  uuid not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (org_id, employee_id, location_id),
  foreign key (org_id, rate_card_id) references pm.labor_rate_cards (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_employee_rate_cards_card_idx on pm.employee_rate_cards (org_id, rate_card_id);

-- A card mapped to an employee must be on the same company as the mapping; the employee in the org.
create or replace function pm.tg_employee_rate_card_guard() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from pm.labor_rate_cards c where c.org_id = new.org_id and c.id = new.rate_card_id and c.location_id = new.location_id) then
    raise exception 'PM_RATE_CARD_SCOPE: rate card % is not on company %', new.rate_card_id, new.location_id using errcode = '23514';
  end if;
  if not exists (select 1 from core.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'PM_UNKNOWN_EMPLOYEE: %', new.employee_id using errcode = '23503';
  end if;
  return new;
end $$;

-- The one rate computation (internal; definer callers pass the org they already guarded).
create or replace function pm.labor_rate_for(p_org uuid, p_rate_card uuid) returns jsonb
language sql stable
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'rate_card_id',          c.id,
    'key',                   c.key,
    'label',                 c.label,
    'base_rate_cents',       c.base_rate_cents,
    'burden_pct',            r.burden,
    'overhead_pct',          r.overhead,
    'bill_rate_cents',       c.bill_rate_cents,
    'cost_rate_cents',       round(c.base_rate_cents * (1 + r.burden))::bigint,
    'estimating_rate_cents', round(c.base_rate_cents * (1 + r.burden) * (1 + r.overhead))::bigint,
    'overhead_rate_cents',   (round(c.base_rate_cents * (1 + r.burden) * (1 + r.overhead)) - round(c.base_rate_cents * (1 + r.burden)))::bigint)
  from pm.labor_rate_cards c
  left join pm.labor_settings s on s.org_id = c.org_id and s.location_id = c.location_id
  cross join lateral (select coalesce(c.burden_pct, s.default_burden_pct, 0)::numeric as burden,
                             coalesce(c.overhead_pct, s.default_overhead_pct, 0)::numeric as overhead) r
  where c.org_id = p_org and c.id = p_rate_card
$$;

-- Cost rate vs estimating rate per card. ONLY estimating_rate_cents includes overhead;
-- cost_rate_cents (pay + burden) is the job-cost basis. A card without a base rate prices each
-- employee at their own pay rate (core.employees.hourly_rate_cents is masked from members, 167),
-- so its rates are null here and are pinned per entry at approval.
create or replace view pm.v_labor_rates with (security_invoker = on) as
select
  c.org_id,
  c.location_id,
  c.id                                                                    as rate_card_id,
  c.key,
  c.label,
  c.base_rate_cents,
  c.burden_pct                                                            as card_burden_pct,
  c.overhead_pct                                                          as card_overhead_pct,
  r.burden::numeric(6,4)                                                  as burden_pct,
  r.overhead::numeric(6,4)                                                as overhead_pct,
  (c.burden_pct is null)                                                  as burden_inherited,
  (c.overhead_pct is null)                                                as overhead_inherited,
  round(c.base_rate_cents * (1 + r.burden))::bigint                       as cost_rate_cents,
  round(c.base_rate_cents * (1 + r.burden) * (1 + r.overhead))::bigint    as estimating_rate_cents,
  (round(c.base_rate_cents * (1 + r.burden) * (1 + r.overhead))
   - round(c.base_rate_cents * (1 + r.burden)))::bigint                   as overhead_rate_cents,
  c.bill_rate_cents,
  c.effective_from,
  c.is_active,
  (select count(*) from pm.employee_rate_cards e where e.org_id = c.org_id and e.rate_card_id = c.id)::int as employee_count,
  c.updated_at
from pm.labor_rate_cards c
left join pm.labor_settings s on s.org_id = c.org_id and s.location_id = c.location_id
cross join lateral (select coalesce(c.burden_pct, s.default_burden_pct, 0)::numeric as burden,
                           coalesce(c.overhead_pct, s.default_overhead_pct, 0)::numeric as overhead) r;

create or replace function pm.set_labor_settings(p_location uuid, p_burden_pct numeric, p_overhead_pct numeric, p_notes text default null)
returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; old pm.labor_settings%rowtype;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_burden_pct is null or p_overhead_pct is null or p_burden_pct < 0 or p_overhead_pct < 0 or p_burden_pct > 5 or p_overhead_pct > 5 then
    raise exception 'PM_INVALID: burden and overhead are fractions from 0 to 5 (0.25 = 25%%)' using errcode = '22023';
  end if;
  if p_burden_pct <> round(p_burden_pct, 4) or p_overhead_pct <> round(p_overhead_pct, 4) then
    raise exception 'PM_INVALID: burden and overhead carry at most 4 decimals (0.2525 = 25.25%%)' using errcode = '22023';
  end if;
  select * into old from pm.labor_settings s where s.org_id = v_org and s.location_id = p_location;
  insert into pm.labor_settings as s (org_id, location_id, default_burden_pct, default_overhead_pct, notes, updated_by)
  values (v_org, p_location, p_burden_pct, p_overhead_pct, nullif(btrim(coalesce(p_notes, '')), ''), pm.current_user_id())
  on conflict (org_id, location_id) do update
    set default_burden_pct = excluded.default_burden_pct, default_overhead_pct = excluded.default_overhead_pct,
        notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now();
  perform pm.log_activity(v_org, p_location, null, 'labor.settings_updated', 'labor_settings', null,
    format('Labor defaults: burden %s%%, overhead %s%% (estimating only)', round(p_burden_pct * 100, 2), round(p_overhead_pct * 100, 2)),
    jsonb_build_object('burden_pct', p_burden_pct, 'overhead_pct', p_overhead_pct,
                       'previous_burden_pct', old.default_burden_pct, 'previous_overhead_pct', old.default_overhead_pct));
end $$;

-- Create (p_id null) or update a card. burden/overhead null = inherit the company default.
create or replace function pm.save_labor_rate_card(
  p_location        uuid,
  p_key             text,
  p_label           text,
  p_base_rate_cents bigint,
  p_burden_pct      numeric,
  p_overhead_pct    numeric,
  p_bill_rate_cents bigint,
  p_effective_from  date default null,
  p_id              uuid default null,
  p_is_active       boolean default true
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_id uuid; old pm.labor_rate_cards%rowtype; v_key text := lower(btrim(coalesce(p_key, '')));
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_key !~ '^[a-z][a-z0-9_]{1,47}$' then raise exception 'PM_INVALID: key is lower-case letters, digits and _ (2–48)' using errcode = '22023'; end if;
  if p_label is null or btrim(p_label) = '' or length(btrim(p_label)) > 80 then raise exception 'PM_INVALID: label is required (80 max)' using errcode = '22023'; end if;
  if (p_base_rate_cents is not null and p_base_rate_cents < 0) or (p_bill_rate_cents is not null and p_bill_rate_cents < 0) then
    raise exception 'PM_INVALID: rates must be ≥ 0' using errcode = '22023';
  end if;
  if (p_burden_pct is not null and (p_burden_pct < 0 or p_burden_pct > 5 or p_burden_pct <> round(p_burden_pct, 4)))
     or (p_overhead_pct is not null and (p_overhead_pct < 0 or p_overhead_pct > 5 or p_overhead_pct <> round(p_overhead_pct, 4))) then
    raise exception 'PM_INVALID: burden and overhead are fractions from 0 to 5 with at most 4 decimals' using errcode = '22023';
  end if;

  if p_id is null then
    insert into pm.labor_rate_cards (org_id, location_id, key, label, base_rate_cents, burden_pct, overhead_pct, bill_rate_cents,
                                     effective_from, is_active, created_by)
    values (v_org, p_location, v_key, btrim(p_label), p_base_rate_cents, p_burden_pct, p_overhead_pct, p_bill_rate_cents,
            coalesce(p_effective_from, current_date), coalesce(p_is_active, true), pm.current_user_id())
    returning id into v_id;
  else
    select * into old from pm.labor_rate_cards c where c.id = p_id and c.org_id = v_org and c.location_id = p_location for update;
    if not found then raise exception 'PM_UNKNOWN_RATE_CARD: %', p_id using errcode = 'P0002'; end if;
    update pm.labor_rate_cards
       set key = v_key, label = btrim(p_label), base_rate_cents = p_base_rate_cents, burden_pct = p_burden_pct,
           overhead_pct = p_overhead_pct, bill_rate_cents = p_bill_rate_cents,
           effective_from = case when (p_base_rate_cents, p_burden_pct, p_overhead_pct, p_bill_rate_cents)
                                      is distinct from (old.base_rate_cents, old.burden_pct, old.overhead_pct, old.bill_rate_cents)
                                 then coalesce(p_effective_from, current_date) else coalesce(p_effective_from, old.effective_from) end,
           is_active = coalesce(p_is_active, true)
     where id = p_id
    returning id into v_id;
  end if;
  perform pm.log_activity(v_org, p_location, null, case when p_id is null then 'labor.rate_card_created' else 'labor.rate_card_updated' end,
    'labor_rate_cards', v_id, format('%s rate card %s', case when p_id is null then 'Added' else 'Updated' end, btrim(p_label)),
    jsonb_build_object('key', v_key, 'base_rate_cents', p_base_rate_cents, 'burden_pct', p_burden_pct, 'overhead_pct', p_overhead_pct,
                       'bill_rate_cents', p_bill_rate_cents,
                       'previous', case when p_id is null then null else jsonb_build_object('base_rate_cents', old.base_rate_cents,
                         'burden_pct', old.burden_pct, 'overhead_pct', old.overhead_pct, 'bill_rate_cents', old.bill_rate_cents) end));
  return v_id;
end $$;

-- Map an employee to a card on a company; p_rate_card null removes the mapping.
create or replace function pm.set_employee_rate_card(p_employee uuid, p_location uuid, p_rate_card uuid)
returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: location % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if not exists (select 1 from core.employees e where e.id = p_employee and e.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: employee % is not in the caller''s organization', p_employee using errcode = '42501';
  end if;
  if p_rate_card is null then
    delete from pm.employee_rate_cards where org_id = v_org and employee_id = p_employee and location_id = p_location;
  else
    insert into pm.employee_rate_cards as e (org_id, employee_id, location_id, rate_card_id, created_by)
    values (v_org, p_employee, p_location, p_rate_card, pm.current_user_id())
    on conflict (org_id, employee_id, location_id) do update set rate_card_id = excluded.rate_card_id, updated_at = now();
  end if;
  perform pm.log_activity(v_org, p_location, null, 'labor.employee_card_set', 'employee_rate_cards', p_employee,
    case when p_rate_card is null then 'Removed an employee''s rate card' else 'Set an employee''s rate card' end,
    jsonb_build_object('employee_id', p_employee, 'rate_card_id', p_rate_card));
end $$;

-- Price an estimate labor line: hours × rates, with overhead as its own component.
-- estimating_cents = cost_cents + overhead_cents (the components tie to the cent).
create or replace function pm.price_labor_line(p_rate_card uuid, p_hours numeric)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid; r jsonb; v_cost bigint; v_est bigint;
begin
  select c.org_id into v_org from pm.labor_rate_cards c where c.id = p_rate_card;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rate card % not found in the caller''s organization', p_rate_card using errcode = '42501';
  end if;
  if p_hours is null or p_hours < 0 or p_hours > 1e9 then raise exception 'PM_INVALID: hours must be ≥ 0' using errcode = '22023'; end if;
  r := pm.labor_rate_for(v_org, p_rate_card);
  if (r ->> 'estimating_rate_cents') is null then
    raise exception 'PM_RATE_CARD_NO_BASE: % uses each employee''s pay rate; give the card a base rate to price estimates with it', r ->> 'label'
      using errcode = '22023';
  end if;
  v_cost := round(p_hours * (r ->> 'cost_rate_cents')::numeric)::bigint;
  v_est  := round(p_hours * (r ->> 'estimating_rate_cents')::numeric)::bigint;
  return r || jsonb_build_object('hours', p_hours, 'cost_cents', v_cost, 'estimating_cents', v_est, 'overhead_cents', v_est - v_cost);
end $$;

-- ----------------------------------------------------------------------------
-- 3. Estimate labor lines (additive on 1102)
-- ----------------------------------------------------------------------------
alter table pm.estimate_lines add column if not exists labor_rate_card_id uuid;
alter table pm.estimate_lines add column if not exists labor_hours numeric(14,4);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'estimate_lines_labor_rate_card_fk' and conrelid = 'pm.estimate_lines'::regclass) then
    alter table pm.estimate_lines add constraint estimate_lines_labor_rate_card_fk
      foreign key (org_id, labor_rate_card_id) references pm.labor_rate_cards (org_id, id) deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estimate_lines_labor_hours_check' and conrelid = 'pm.estimate_lines'::regclass) then
    alter table pm.estimate_lines add constraint estimate_lines_labor_hours_check check (labor_hours is null or labor_hours >= 0);
  end if;
end $$;

-- Prices a labor-card line (fires before trg_estimate_line_guard, which still enforces the
-- DRAFT lock and the cost-code scope). qty = hours; unit cost = estimating rate; cost_cents =
-- hours × cost rate (budget/EAC basis, no overhead); unit price defaults to the card's bill rate,
-- else the estimating rate; amount = hours × unit price. ext._labor carries the breakdown.
create or replace function pm.tg_estimate_labor_line() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_hours numeric; r jsonb; v_cost bigint; v_est bigint; v_card uuid;
begin
  -- pm.revise_estimate (1102) copies lines by an explicit column list that predates 1108: the
  -- card survives in ext._labor, so a copied line stays a labor line (re-priced at today's rates)
  if tg_op = 'INSERT' and new.labor_rate_card_id is null and (new.ext -> '_labor' ->> 'rate_card_id') is not null then
    begin
      v_card := (new.ext -> '_labor' ->> 'rate_card_id')::uuid;
    exception when others then v_card := null;
    end;
    if v_card is not null and exists (select 1 from pm.labor_rate_cards c where c.org_id = new.org_id and c.id = v_card) then
      new.labor_rate_card_id := v_card;
      new.labor_hours := coalesce(new.labor_hours, new.qty);
    else
      new.ext := new.ext - '_labor';
    end if;
  end if;
  if new.labor_rate_card_id is null then
    if tg_op = 'UPDATE' and old.labor_rate_card_id is not null then
      new.labor_hours := null;
      new.ext := coalesce(new.ext, '{}'::jsonb) - '_labor';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.labor_hours is not distinct from old.labor_hours and new.qty is distinct from old.qty then
    v_hours := new.qty;
  else
    v_hours := coalesce(new.labor_hours, new.qty, 0);
  end if;
  r := pm.labor_rate_for(new.org_id, new.labor_rate_card_id);
  if r is null then raise exception 'PM_UNKNOWN_RATE_CARD: %', new.labor_rate_card_id using errcode = '23503'; end if;
  if (r ->> 'estimating_rate_cents') is null then
    raise exception 'PM_RATE_CARD_NO_BASE: % uses each employee''s pay rate; give the card a base rate to price estimates with it', r ->> 'label'
      using errcode = '22023';
  end if;
  v_cost := round(v_hours * (r ->> 'cost_rate_cents')::numeric)::bigint;
  v_est  := round(v_hours * (r ->> 'estimating_rate_cents')::numeric)::bigint;
  new.labor_hours     := v_hours;
  new.qty             := v_hours;
  new.uom             := coalesce(nullif(new.uom, ''), 'HR');
  new.unit_cost_cents := (r ->> 'estimating_rate_cents')::bigint;
  new.cost_cents      := v_cost;
  if new.unit_price_cents is null or (tg_op = 'UPDATE' and new.labor_rate_card_id is distinct from old.labor_rate_card_id
                                      and new.unit_price_cents is not distinct from old.unit_price_cents) then
    new.unit_price_cents := coalesce((r ->> 'bill_rate_cents')::bigint, (r ->> 'estimating_rate_cents')::bigint);
  end if;
  new.amount_cents    := round(v_hours * new.unit_price_cents)::bigint;
  if coalesce(new.description, '') = '' then new.description := r ->> 'label'; end if;
  new.ext := coalesce(new.ext, '{}'::jsonb) || jsonb_build_object('_labor', jsonb_build_object(
    'rate_card_id', new.labor_rate_card_id, 'label', r ->> 'label', 'hours', v_hours,
    'base_rate_cents', (r ->> 'base_rate_cents')::bigint, 'burden_pct', (r ->> 'burden_pct')::numeric, 'overhead_pct', (r ->> 'overhead_pct')::numeric,
    'cost_rate_cents', (r ->> 'cost_rate_cents')::bigint, 'estimating_rate_cents', (r ->> 'estimating_rate_cents')::bigint,
    'overhead_rate_cents', (r ->> 'overhead_rate_cents')::bigint,
    'cost_cents', v_cost, 'overhead_cents', v_est - v_cost, 'estimating_cents', v_est));
  return new;
end $$;

create or replace trigger trg_estimate_labor_line before insert or update of labor_rate_card_id, labor_hours, qty, unit_price_cents on pm.estimate_lines
  for each row execute function pm.tg_estimate_labor_line();

-- ----------------------------------------------------------------------------
-- 4. Time approval + JOB_TIME (review 03 §3.1)
-- ----------------------------------------------------------------------------

-- One row per approval / unapproval of a time entry: what was pinned and what reached Books.
create table if not exists pm.time_entry_events (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  time_entry_id      uuid not null,
  action             text not null check (action in ('APPROVED','UNAPPROVED')),
  revision           int not null check (revision >= 1),
  event_id           uuid,
  reverses_event_id  uuid,
  suppressed_reason  text check (suppressed_reason is null or suppressed_reason in ('STANDALONE','SAMPLE','SEAM_V1','NOT_EMITTED')),
  cost_rate_cents    bigint,
  bill_rate_cents    bigint,
  hours              numeric(6,2),
  reason             text,
  payload            jsonb,
  created_by         text,
  created_at         timestamptz not null default now(),
  check ((event_id is null) = (suppressed_reason is not null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_time_entry_events_entry_idx on pm.time_entry_events (org_id, time_entry_id, created_at);
create index if not exists pm_time_entry_events_job_idx on pm.time_entry_events (org_id, job_id, created_at desc);

create or replace function pm.approve_time_entries(p_ids uuid[])
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org     uuid := public.get_org_id();
  v_me      text := pm.current_user_id();
  v_ids     uuid[];
  v_n       int;
  v_bad     int;
  v_seam    int;
  te        pm.time_entries%rowtype;
  v_job     record;
  v_emp     uuid;
  v_hourly  bigint;
  card      pm.labor_rate_cards%rowtype;
  v_def_b   numeric;
  v_base    bigint;
  v_burden  numeric;
  v_cost    bigint;
  v_bill    bigint;
  v_supp    text;
  v_event   uuid;
  v_rev     int;
  v_ref     text;
  v_cc      text;
  v_payload jsonb;
  v_done    int := 0;
  g         record;
begin
  if v_org is null then
    raise exception 'PM_FORBIDDEN: no organization for the caller' using errcode = '42501';
  end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_ids, '{}'::uuid[])) x where x is not null;
  if cardinality(v_ids) = 0 then return 0; end if;
  if cardinality(v_ids) > 500 then raise exception 'PM_INVALID: approve at most 500 time entries at a time' using errcode = '22023'; end if;

  -- org guard + lock: every id must be the caller's
  select count(*) into v_n from (
    select t.id from pm.time_entries t where t.org_id = v_org and t.id = any (v_ids) order by t.id for update of t) s;
  if v_n <> cardinality(v_ids) then
    raise exception 'PM_FORBIDDEN: % of % time entries were not found in the caller''s organization', cardinality(v_ids) - v_n, cardinality(v_ids)
      using errcode = '42501';
  end if;
  select count(*) into v_bad from pm.time_entries t where t.org_id = v_org and t.id = any (v_ids) and t.approval_state <> 'SUBMITTED';
  if v_bad > 0 then
    raise exception 'PM_TIME_NOT_SUBMITTED: % time entr% not SUBMITTED; only submitted time can be approved', v_bad,
      case when v_bad = 1 then 'y is' else 'ies are' end using errcode = '22023';
  end if;
  -- preparer ≠ approver; the worker cannot approve their own hours either
  select count(*) into v_bad from pm.time_entries t
  left join core.employees e on e.id = t.employee_id
  where t.org_id = v_org and t.id = any (v_ids)
    and (t.created_by = v_me or t.user_id = v_me or e.clerk_user_id = v_me);
  if v_bad > 0 then
    raise exception 'PM_SOD_VIOLATION: % time entr% entered by you or for you; someone else must approve %', v_bad,
      case when v_bad = 1 then 'y was' else 'ies were' end, case when v_bad = 1 then 'it' else 'them' end using errcode = '42501';
  end if;

  v_seam := pm.books_seam_version(v_org);

  for te in select * from pm.time_entries t where t.org_id = v_org and t.id = any (v_ids) order by t.work_date, t.created_at, t.id loop
    select j.location_id, j.department_id, l.name as company into v_job
    from core.jobs j join core.locations l on l.id = j.location_id where j.org_id = v_org and j.id = te.job_id;

    -- the worker: the entry's employee, else the active employee row of its Clerk user
    v_emp := te.employee_id;
    if v_emp is null then
      select e.id into v_emp from core.employees e
      where e.org_id = v_org and e.clerk_user_id = te.user_id and e.is_active order by e.created_at, e.id limit 1;
    end if;
    v_hourly := null;
    if v_emp is not null then select e.hourly_rate_cents into v_hourly from core.employees e where e.id = v_emp and e.org_id = v_org; end if;

    card := null;
    if v_emp is not null then
      select c.* into card from pm.employee_rate_cards m
      join pm.labor_rate_cards c on c.org_id = m.org_id and c.id = m.rate_card_id and c.is_active
      where m.org_id = v_org and m.employee_id = v_emp and m.location_id = v_job.location_id;
    end if;
    select s.default_burden_pct into v_def_b from pm.labor_settings s where s.org_id = v_org and s.location_id = v_job.location_id;

    v_base := coalesce(card.base_rate_cents, v_hourly);
    if v_base is null then
      raise exception 'PM_NO_LABOR_RATE: the % hours on % have no pay rate (no employee hourly rate in Merit Books and no rate card base rate)',
        te.hours, te.work_date using errcode = '22023';
    end if;
    v_burden := coalesce(card.burden_pct, v_def_b, 0);
    -- job cost basis: pay × (1 + burden) × pay-type factor. NEVER overhead.
    v_cost := round(v_base * (1 + v_burden) * pm.pay_type_factor(te.pay_type))::bigint;
    v_bill := coalesce(te.bill_rate_cents, card.bill_rate_cents);
    v_ref  := 'pm:time:' || te.id::text;

    update pm.time_entries
       set approval_state = 'APPROVED', cost_rate_cents = v_cost, bill_rate_cents = v_bill,
           approved_by = v_me, approved_at = now(), employee_id = coalesce(employee_id, v_emp),
           source_ref = coalesce(source_ref, v_ref)
     where org_id = v_org and id = te.id;

    select coalesce(max(x.revision), 0) + 1 into v_rev from pm.time_entry_events x
    where x.org_id = v_org and x.time_entry_id = te.id and x.action = 'APPROVED';

    v_supp := pm.emit_suppression(v_org, te.job_id);
    if v_supp is null and v_seam < 2 then v_supp := 'SEAM_V1'; end if;
    v_event := null; v_payload := null;
    if v_supp is null then
      select c.code into v_cc from pm.cost_codes c where c.org_id = v_org and c.id = te.cost_code_id;
      v_event := gen_random_uuid();
      v_payload := jsonb_build_object(
        'event_id',        v_event,
        'event_type',      'JOB_TIME',
        'source_module',   'PROJECTS',
        'schema_version',  1,
        'org_id',          v_org,
        'location_id',     v_job.location_id,
        'job_id',          te.job_id,
        'department_id',   v_job.department_id,
        'occurred_on',     to_char(te.work_date, 'YYYY-MM-DD'),
        'source_ref',      v_ref,
        'action',          'APPROVED',
        'revision',        v_rev,
        'time_entry_id',   te.id,
        'employee_id',     v_emp,
        'hours',           te.hours,
        'pay_type',        te.pay_type,
        'units',           te.units,
        'cost_code_id',    te.cost_code_id,
        'cost_code',       v_cc,
        'task_id',         te.task_id,
        'work_order_id',   te.work_order_id,
        'operation_id',    te.operation_id,
        'billable',        te.billable,
        'bill_rate_cents', v_bill,
        -- information only: Books re-derives labor cost from payroll + burden
        'cost_rate_cents', v_cost,
        'cost_rate_basis', 'PAY_PLUS_BURDEN',
        'approved_by',     v_me,
        'memo',            format('Time %s h %s on %s', te.hours, te.pay_type, to_char(te.work_date, 'YYYY-MM-DD')));
      v_payload := jsonb_strip_nulls(v_payload) || jsonb_build_object('employee_id', v_emp, 'billable', te.billable);
      insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
      values (v_org, v_event, 'JOB_TIME', 'PROJECTS', v_payload, te.work_date, 'pending');
      update pm.time_entries set event_id = v_event where org_id = v_org and id = te.id;
    end if;

    insert into pm.time_entry_events (org_id, job_id, time_entry_id, action, revision, event_id, suppressed_reason,
                                      cost_rate_cents, bill_rate_cents, hours, payload, created_by)
    values (v_org, te.job_id, te.id, 'APPROVED', v_rev, v_event, v_supp, v_cost, v_bill, te.hours, v_payload, v_me);
    v_done := v_done + 1;
  end loop;

  for g in
    select t.job_id, j.location_id, count(*)::int as n, sum(t.hours) as hours, sum(round(t.hours * t.cost_rate_cents))::bigint as cost_cents,
           count(t.event_id)::int as sent
    from pm.time_entries t join core.jobs j on j.org_id = t.org_id and j.id = t.job_id
    where t.org_id = v_org and t.id = any (v_ids)
    group by t.job_id, j.location_id
  loop
    perform pm.log_activity(v_org, g.location_id, g.job_id, 'time.approved', 'time_entries', null,
      format('Approved %s time entr%s (%s h)%s', g.n, case when g.n = 1 then 'y' else 'ies' end, trim(to_char(g.hours, 'FM999990.00')),
             case when g.sent > 0 then ' and sent labor to Merit Books' else '' end),
      jsonb_build_object('entries', g.n, 'hours', g.hours, 'cost_cents_at_pinned_rate', g.cost_cents, 'events', g.sent,
                         'cost_rate_basis', 'PAY_PLUS_BURDEN'));
  end loop;
  return v_done;
end $$;

-- Back to SUBMITTED (rates unpinned; bill rate kept). Refused while the hours are on a
-- billing request (void that first). Emits UNAPPROVED when the approval reached Books.
create or replace function pm.unapprove_time_entry(p_id uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  te        pm.time_entries%rowtype;
  v_me      text := pm.current_user_id();
  v_loc     uuid;
  v_dept    uuid;
  last_ap   pm.time_entry_events%rowtype;
  v_event   uuid;
  v_supp    text;
  v_payload jsonb;
begin
  select * into te from pm.time_entries t where t.id = p_id for update;
  if te.org_id is null or te.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: time entry % not found in the caller''s organization', p_id using errcode = '42501';
  end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: unapproving requires an identified user' using errcode = '42501'; end if;
  if te.approval_state <> 'APPROVED' then
    raise exception 'PM_TIME_NOT_APPROVED: the entry is %', te.approval_state using errcode = '22023';
  end if;
  if exists (select 1 from pm.billing_links k where k.org_id = te.org_id and k.source_table = 'time_entries' and k.source_id = te.id) then
    raise exception 'PM_TIME_BILLED: these hours are on a billing request; void the billing first' using errcode = '22023';
  end if;
  select j.location_id, j.department_id into v_loc, v_dept from core.jobs j where j.org_id = te.org_id and j.id = te.job_id;
  select * into last_ap from pm.time_entry_events x
  where x.org_id = te.org_id and x.time_entry_id = te.id and x.action = 'APPROVED'
  order by x.revision desc, x.created_at desc limit 1;

  if te.event_id is not null then
    v_event := gen_random_uuid();
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'event_id',          v_event,
      'event_type',        'JOB_TIME',
      'source_module',     'PROJECTS',
      'schema_version',    1,
      'org_id',            te.org_id,
      'location_id',       v_loc,
      'job_id',            te.job_id,
      'department_id',     v_dept,
      'occurred_on',       to_char(te.work_date, 'YYYY-MM-DD'),
      'source_ref',        'pm:time:' || te.id::text,
      'action',            'UNAPPROVED',
      'revision',          coalesce(last_ap.revision, 1),
      'reverses_event_id', te.event_id,
      'time_entry_id',     te.id,
      'employee_id',       te.employee_id,
      'hours',             te.hours,
      'pay_type',          te.pay_type,
      'cost_code_id',      te.cost_code_id,
      'work_order_id',     te.work_order_id,
      'operation_id',      te.operation_id,
      'billable',          te.billable,
      'reason',            nullif(btrim(coalesce(p_reason, '')), ''),
      'memo',              'Time approval withdrawn'));
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (te.org_id, v_event, 'JOB_TIME', 'PROJECTS', v_payload, te.work_date, 'pending');
  else
    v_supp := 'NOT_EMITTED';
  end if;

  update pm.time_entries
     set approval_state = 'SUBMITTED', cost_rate_cents = null, approved_by = null, approved_at = null, event_id = null
   where id = te.id;

  insert into pm.time_entry_events (org_id, job_id, time_entry_id, action, revision, event_id, reverses_event_id, suppressed_reason,
                                    cost_rate_cents, bill_rate_cents, hours, reason, payload, created_by)
  values (te.org_id, te.job_id, te.id, 'UNAPPROVED', coalesce(last_ap.revision, 1), v_event, te.event_id, v_supp,
          te.cost_rate_cents, te.bill_rate_cents, te.hours, nullif(btrim(coalesce(p_reason, '')), ''), v_payload, v_me);

  perform pm.log_activity(te.org_id, v_loc, te.job_id, 'time.unapproved', 'time_entries', te.id,
    format('Unapproved %s h on %s%s', trim(to_char(te.hours, 'FM999990.00')), to_char(te.work_date, 'YYYY-MM-DD'),
           case when v_event is not null then ' (Merit Books reverses the labor cost)' else '' end),
    jsonb_build_object('event_id', v_event, 'reverses_event_id', te.event_id, 'reason', p_reason));
  return v_event;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Triggers
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['vendor_profiles','labor_settings','labor_rate_cards','employee_rate_cards'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['vendor_profiles','labor_settings','labor_rate_cards','employee_rate_cards'] loop
    execute format('create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
end $$;

create or replace trigger trg_employee_rate_card_guard before insert or update on pm.employee_rate_cards
  for each row execute function pm.tg_employee_rate_card_guard();

-- ----------------------------------------------------------------------------
-- 6. RLS (D12): org isolation; members read, writes only through the definer functions
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['vendor_profiles','labor_settings','labor_rate_cards','employee_rate_cards','time_entry_events'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Table grants: nothing for anon/PUBLIC; service_role everything; authenticated read-only
--    (labor rates pin job cost, so they move only through logged definer functions).
-- ----------------------------------------------------------------------------
revoke all on pm.vendor_profiles, pm.labor_settings, pm.labor_rate_cards, pm.employee_rate_cards, pm.time_entry_events
  from public, anon, authenticated;
grant select, insert, update, delete on pm.vendor_profiles, pm.labor_settings, pm.labor_rate_cards, pm.employee_rate_cards,
  pm.time_entry_events to service_role;
grant select on pm.vendor_profiles, pm.labor_settings, pm.labor_rate_cards, pm.employee_rate_cards, pm.time_entry_events to authenticated;

-- estimate_lines: members may pick a rate card and hours (the trigger prices the line)
grant insert (labor_rate_card_id, labor_hours) on pm.estimate_lines to authenticated;
grant update (labor_rate_card_id, labor_hours) on pm.estimate_lines to authenticated;

revoke all on pm.v_labor_rates from public, anon;
grant select on pm.v_labor_rates to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. Function grants (1100/1007 pattern) for the functions this migration owns
-- ----------------------------------------------------------------------------
do $$
declare r record;
  v_member text[] := array['create_customer','create_vendor','set_labor_settings','save_labor_rate_card','set_employee_rate_card',
    'price_labor_line','approve_time_entries','unapprove_time_entry','pay_type_factor'];
  v_internal text[] := array['party_name_key','labor_rate_for','tg_employee_rate_card_guard','tg_estimate_labor_line'];
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
-- end 1108_pm_parties_and_labor
-- ============================================================================
