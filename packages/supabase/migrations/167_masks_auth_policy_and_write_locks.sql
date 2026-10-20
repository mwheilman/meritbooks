-- =============================================================================
-- Migration 167: field masks (05 R-6), tenant auth policy (05 R-7), and the open
-- wave-1 security findings M4 (client/customer write lock + cross-tenant refs),
-- M5 (event-drain claim race) and L9 (ai_* SECURITY DEFINER exposure).
-- =============================================================================
--
-- §1  M4  core.locations / core.customers were member-WRITABLE over PostgREST
--         (policy org_isolation FOR ALL). Any signed-in member could rewrite a
--         client's tags / own-books flag (which now drive rule-based client sets and
--         therefore ACCESS — 05 R-4), its rev-rec method, currency, onboarding owner,
--         or create/merge customers — bypassing every route permission check.
--         Fix (154 pattern, ORDER-INDEPENDENT): every member-facing write policy on
--         these tables is converted to a SELECT policy with the SAME read predicate
--         (so a client-scope predicate a sibling migration installs — 05 M-4 — is
--         preserved verbatim), a service_all policy is added, and INSERT / UPDATE /
--         DELETE / TRUNCATE are revoked from anon + authenticated. Every app write now
--         goes through the service-role client after an explicit permission check,
--         pinned to the session org (see apps/web: customers, settings/entities,
--         rev-rec/config, consolidation/entity-currency, entity-invoice-settings,
--         import, onboarding/import/ar, portfolio/onboarding, companies/create-company).
--
-- §2  M4  Same-tenant guards for every reference column that can point at another
--         row and was not already guarded:
--           core.locations.primary_contact_membership_id  -> core.memberships (mig 156)
--           core.customers.related_location_id            -> core.locations   (mig 156)
--           core.customers.location_id                    -> core.locations   (legacy)
--           core.role_definitions.home_template_id        -> role_definitions (mig 158)
--           core.client_set_members.(set_id, location_id) -> client_sets/locations (160)
--         (access_assignments, permission_sets, client_access_policies and the
--         role_definitions location/upstream refs were already guarded in 158–161.)
--
-- §3  M5  Event-drain claim. The drains read "pending" core.events and processed them
--         with no claim, and the scheduled drain gated on the pending total and then
--         re-read the queue. Two concurrent drains (cron + the manual "Process" route)
--         could both process one event (double invoice / double GL post), and the run
--         could post more than the autonomy cap it was gated on. core.events gains
--         claimed_at / claimed_by and core.claim_pending_events() claims a batch
--         atomically (UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) with a
--         lease), so a row is processed by exactly one claimer; the scheduled drain
--         gates on the CLAIMED set and processes only that set (released if the gate
--         says no). service_role only.
--
-- §4  L9  core.ai_bump_rate / ai_increment_counter / ai_concurrency_acquire /
--         ai_concurrency_release are SECURITY DEFINER and were EXECUTABLE BY anon and
--         by any authenticated member FOR ANY p_org (inflate another tenant's AI
--         budget / rate buckets, steal or release its concurrency slots). Fix: revoke
--         from PUBLIC + anon; keep authenticated (the AI gateway runs on the caller's
--         RLS client — mig 110) but pin p_org to get_org_id() for every non-service
--         caller; service_role unrestricted. The metering tables those functions
--         maintain (ai_usage_counters, ai_rate_buckets, ai_inflight) were also
--         directly member-writable (a member could DELETE their counters and reset
--         the tenant AI budget): writes now service_role / definer-only;
--         ai_usage_log becomes append-only for members (INSERT own org, no
--         UPDATE / DELETE).
--
-- §5  R-6 Field sensitivity registry: core.field_classes, core.field_class_columns,
--         core.field_reveals (the logged-reveal ledger). Columns registered with
--         enforcement 'column_revoke' are NOT selectable by anon / authenticated:
--         core.vendors.tin_encrypted, core.employees.hourly_rate_cents,
--         core.employees.annual_salary_cents. Every other column stays selectable
--         (column-level grants). core.apply_field_column_masks() re-applies the
--         grants and MUST be re-run by any later migration that adds a column to a
--         masked table (else the new column is unreadable by members; the guard test
--         src/test/field-masks-auth-policy.test.ts fails on that drift).
--
-- §6  R-7 Tenant security policy: core.organizations.security_policy jsonb
--         (mfa_all_staff, default_step_up_minutes, session_max_hours,
--         idle_timeout_minutes, ip_allowlist_enforced) + core.ip_allowlists.
--         organizations stays write-locked (mig 154): the Security settings route
--         writes it with the service role after core.tenant.settings / settings_system
--         authorization.
--
-- IDEMPOTENT. PGlite-compatible (no subqueries in CHECK). No GL effect, no data change
-- beyond adding defaulted columns.
-- =============================================================================

-- ── §1 M4: write locks on core.locations / core.customers ────────────────────
do $$
declare
  t record;
  p record;
  v_roles text;
begin
  for t in select * from (values ('core', 'locations'), ('core', 'customers')) as v(sch, tbl) loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      raise notice 'migration 167: %.% not present, skipped', t.sch, t.tbl;
      continue;
    end if;
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);

    -- Convert PERMISSIVE member write policies into SELECT policies with the SAME
    -- predicate. RESTRICTIVE policies (e.g. a client-scope policy from 05 M-4) never
    -- grant anything and are left exactly as they are.
    for p in
      select policyname, cmd, roles, qual
        from pg_policies
       where schemaname = t.sch and tablename = t.tbl
         and permissive = 'PERMISSIVE'
         and cmd <> 'SELECT'
         and roles::text <> '{service_role}'
    loop
      execute format('drop policy if exists %I on %I.%I', p.policyname, t.sch, t.tbl);
      if p.cmd = 'ALL' and p.qual is not null
         and not exists (select 1 from pg_policies x
                          where x.schemaname = t.sch and x.tablename = t.tbl
                            and x.policyname = p.policyname) then
        v_roles := array_to_string(p.roles, ', ');
        execute format('create policy %I on %I.%I for select to %s using (%s)',
                       p.policyname, t.sch, t.tbl, v_roles, p.qual);
      end if;
    end loop;

    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and policyname = 'service_all') then
      execute format(
        'create policy service_all on %I.%I for all to service_role using (true) with check (true)',
        t.sch, t.tbl);
    end if;

    execute format('revoke insert, update, delete, truncate on table %I.%I from anon, authenticated', t.sch, t.tbl);
    execute format('grant select, insert, update, delete on table %I.%I to service_role', t.sch, t.tbl);
  end loop;
end $$;

-- ── §2 M4: same-tenant guards on reference columns ───────────────────────────
create or replace function core.m167_locations_same_org_guard() returns trigger
  language plpgsql
  set search_path = core, public
as $$
begin
  if new.primary_contact_membership_id is not null and not exists (
       select 1 from core.memberships m
        where m.id = new.primary_contact_membership_id and m.org_id = new.org_id) then
    raise exception 'primary contact membership % is not a seat in tenant %',
      new.primary_contact_membership_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;

do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'core' and table_name = 'locations'
                and column_name = 'primary_contact_membership_id') then
    drop trigger if exists trg_m167_locations_same_org on core.locations;
    create trigger trg_m167_locations_same_org
      before insert or update of primary_contact_membership_id, org_id on core.locations
      for each row execute function core.m167_locations_same_org_guard();
  end if;
end $$;

create or replace function core.m167_customers_same_org_guard() returns trigger
  language plpgsql
  set search_path = core, public
as $$
declare
  v_loc uuid;
  v_rel uuid;
begin
  v_loc := (to_jsonb(new) ->> 'location_id')::uuid;
  v_rel := (to_jsonb(new) ->> 'related_location_id')::uuid;
  if v_loc is not null and not exists (
       select 1 from core.locations l where l.id = v_loc and l.org_id = new.org_id) then
    raise exception 'customer location % is not a client of tenant %', v_loc, new.org_id
      using errcode = 'check_violation';
  end if;
  if v_rel is not null and not exists (
       select 1 from core.locations l where l.id = v_rel and l.org_id = new.org_id) then
    raise exception 'related client % is not a client of tenant %', v_rel, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

do $$ begin
  if to_regclass('core.customers') is not null then
    drop trigger if exists trg_m167_customers_same_org on core.customers;
    create trigger trg_m167_customers_same_org
      before insert or update on core.customers
      for each row execute function core.m167_customers_same_org_guard();
  end if;
end $$;

create or replace function core.m167_role_home_template_guard() returns trigger
  language plpgsql
  set search_path = core, public
as $$
begin
  if new.home_template_id is not null and not exists (
       select 1 from core.role_definitions h
        where h.id = new.home_template_id
          and (h.owner_level = 'platform' or h.org_id is not distinct from new.org_id)) then
    raise exception 'home template must be a platform template or a role of the same tenant'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

do $$ begin
  if to_regclass('core.role_definitions') is not null then
    drop trigger if exists trg_m167_role_home_template on core.role_definitions;
    create trigger trg_m167_role_home_template
      before insert or update of home_template_id, org_id on core.role_definitions
      for each row execute function core.m167_role_home_template_guard();
  end if;
end $$;

create or replace function core.m167_client_set_members_guard() returns trigger
  language plpgsql
  set search_path = core, public
as $$
begin
  if not exists (select 1 from core.client_sets s where s.id = new.set_id and s.org_id = new.org_id) then
    raise exception 'client set % is not in tenant %', new.set_id, new.org_id using errcode = 'check_violation';
  end if;
  if not exists (select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'location % is not a client of tenant %', new.location_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;

do $$ begin
  if to_regclass('core.client_set_members') is not null then
    drop trigger if exists trg_m167_client_set_members on core.client_set_members;
    create trigger trg_m167_client_set_members
      before insert or update on core.client_set_members
      for each row execute function core.m167_client_set_members_guard();
  end if;
end $$;

-- Trigger functions are never called directly.
revoke all on function core.m167_locations_same_org_guard() from public, anon, authenticated;
revoke all on function core.m167_customers_same_org_guard() from public, anon, authenticated;
revoke all on function core.m167_role_home_template_guard() from public, anon, authenticated;
revoke all on function core.m167_client_set_members_guard() from public, anon, authenticated;

-- ── §3 M5: atomic event-drain claim ──────────────────────────────────────────
alter table core.events add column if not exists claimed_at timestamptz;
alter table core.events add column if not exists claimed_by text;
create index if not exists idx_core_events_claimable
  on core.events (event_type, org_id, created_at) where status = 'pending';

-- Claim up to p_limit pending events of one type (optionally one org / source module)
-- for p_token. A row is claimable when unclaimed or its lease expired (a crashed
-- drain). Concurrent claimers never receive the same row: the candidate CTE locks
-- the rows FOR UPDATE SKIP LOCKED and the UPDATE re-checks the claim predicate.
create or replace function core.claim_pending_events(
  p_event_type    text,
  p_org           uuid,
  p_source_module text,
  p_limit         integer,
  p_token         text,
  p_lease_seconds integer
) returns setof core.events
language plpgsql
volatile
set search_path = core, public
as $$
declare
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 900), 30));
begin
  if p_token is null or btrim(p_token) = '' then
    raise exception 'claim_pending_events: token required';
  end if;
  -- The candidate set is MATERIALIZED once (a bare `WHERE id IN (SELECT … LIMIT …
  -- FOR UPDATE)` may be re-scanned per outer row, overshooting the limit).
  return query
  with picked as materialized (
    select x.id
      from core.events x
     where x.status = 'pending'
       and x.event_type = p_event_type
       and (p_org is null or x.org_id = p_org)
       and (p_source_module is null or x.source_module = p_source_module)
       and (x.claimed_at is null or x.claimed_at < now() - v_lease)
     order by x.created_at, x.id
     limit greatest(coalesce(p_limit, 500), 1)
       for update skip locked
  ), claimed as (
    update core.events e
       set claimed_at = now(),
           claimed_by = p_token
      from picked
     where e.id = picked.id
       and e.status = 'pending'
       and (e.claimed_at is null or e.claimed_at < now() - v_lease)
    returning e.*
  )
  select * from claimed;
end
$$;

-- Give back a claim that was not processed (gate said no / drain aborted).
create or replace function core.release_event_claims(p_token text, p_ids uuid[] default null)
returns integer
language plpgsql
volatile
set search_path = core, public
as $$
declare
  n integer;
begin
  update core.events
     set claimed_at = null, claimed_by = null
   where claimed_by = p_token
     and status = 'pending'
     and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end
$$;

revoke all on function core.claim_pending_events(text, uuid, text, integer, text, integer) from public, anon, authenticated;
grant execute on function core.claim_pending_events(text, uuid, text, integer, text, integer) to service_role;
revoke all on function core.release_event_claims(text, uuid[]) from public, anon, authenticated;
grant execute on function core.release_event_claims(text, uuid[]) to service_role;

-- ── §4 L9: ai_* SECURITY DEFINER functions + metering tables ─────────────────
-- Non-service callers may only touch their OWN tenant's metering rows.
create or replace function core.ai_caller_org_guard(p_org uuid) returns void
  language plpgsql stable security definer
  set search_path = core, public
as $$
declare
  v_role text;
begin
  v_role := nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role';
  if v_role = 'service_role' or (v_role is null and session_user <> 'authenticator') then
    return;  -- the app server (service key) or a direct DB session (migrations / ops)
  end if;
  if p_org is null or p_org is distinct from public.get_org_id() then
    raise exception 'ai metering: org % is not the caller''s tenant', p_org using errcode = '42501';
  end if;
end
$$;

create or replace function core.ai_increment_counter(
  p_org uuid, p_month date, p_scope text, p_key text, p_cost bigint
) returns void
language plpgsql security definer set search_path = core, public as $$
begin
  perform core.ai_caller_org_guard(p_org);
  insert into core.ai_usage_counters (org_id, period_month, scope, scope_key, cost_cents, call_count, updated_at)
  values (p_org, p_month, p_scope, coalesce(p_key,''), greatest(p_cost,0), 1, now())
  on conflict (org_id, period_month, scope, scope_key)
  do update set cost_cents = core.ai_usage_counters.cost_cents + greatest(p_cost,0),
                call_count = core.ai_usage_counters.call_count + 1,
                updated_at = now();
end;
$$;

create or replace function core.ai_bump_rate(
  p_org uuid, p_scope text, p_key text
) returns int
language plpgsql security definer set search_path = core, public as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_count int;
begin
  perform core.ai_caller_org_guard(p_org);
  insert into core.ai_rate_buckets (org_id, scope, scope_key, minute_bucket, count)
  values (p_org, p_scope, coalesce(p_key,''), v_bucket, 1)
  on conflict (org_id, scope, scope_key, minute_bucket)
  do update set count = core.ai_rate_buckets.count + 1
  returning count into v_count;
  delete from core.ai_rate_buckets
   where org_id = p_org and scope = p_scope and scope_key = coalesce(p_key,'')
     and minute_bucket < v_bucket - interval '5 minutes';
  return v_count;
end;
$$;

create or replace function core.ai_concurrency_acquire(
  p_org uuid, p_limit int, p_ttl_seconds int, p_corr uuid
) returns boolean
language plpgsql security definer set search_path = core, public as $$
declare v_active int;
begin
  perform core.ai_caller_org_guard(p_org);
  delete from core.ai_inflight
   where org_id = p_org and started_at < now() - make_interval(secs => greatest(p_ttl_seconds,1));
  if p_limit is null then
    return true;
  end if;
  select count(*) into v_active from core.ai_inflight where org_id = p_org;
  if v_active >= p_limit then
    return false;
  end if;
  insert into core.ai_inflight (correlation_id, org_id) values (p_corr, p_org)
  on conflict (correlation_id) do nothing;
  return true;
end;
$$;

create or replace function core.ai_concurrency_release(p_corr uuid)
returns void language plpgsql security definer set search_path = core, public as $$
declare
  v_role text;
begin
  v_role := nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role';
  if v_role = 'service_role' or (v_role is null and session_user <> 'authenticator') then
    delete from core.ai_inflight where correlation_id = p_corr;
  else
    delete from core.ai_inflight where correlation_id = p_corr and org_id = public.get_org_id();
  end if;
end;
$$;

revoke all on function core.ai_caller_org_guard(uuid) from public, anon, authenticated;
grant execute on function core.ai_caller_org_guard(uuid) to service_role;

revoke all on function
  core.ai_bump_rate(uuid, text, text),
  core.ai_increment_counter(uuid, date, text, text, bigint),
  core.ai_concurrency_acquire(uuid, int, int, uuid),
  core.ai_concurrency_release(uuid)
from public, anon, authenticated;
grant execute on function
  core.ai_bump_rate(uuid, text, text),
  core.ai_increment_counter(uuid, date, text, text, bigint),
  core.ai_concurrency_acquire(uuid, int, int, uuid),
  core.ai_concurrency_release(uuid)
to authenticated, service_role;

-- Metering tables: members read their tenant's rows; writes only through the
-- definer functions above (or the service role). ai_usage_log: append-only.
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['ai_usage_counters', 'ai_rate_buckets', 'ai_inflight', 'ai_usage_log'] loop
    if to_regclass(format('core.%I', t)) is null then continue; end if;
    execute format('alter table core.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'core' and tablename = t loop
      execute format('drop policy if exists %I on core.%I', p.policyname, t);
    end loop;
    execute format('create policy member_read on core.%I for select using (org_id = public.get_org_id())', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
  if to_regclass('core.ai_usage_log') is not null then
    -- The gateway writes the metering ledger on the caller's client (store.ts logUsage).
    execute 'create policy member_append on core.ai_usage_log for insert to authenticated with check (org_id = public.get_org_id())';
    execute 'grant insert on table core.ai_usage_log to authenticated';
  end if;
end $$;

-- ── §5 R-6: field sensitivity registry + column masks ────────────────────────
create table if not exists core.field_classes (
  key        text primary key,
  label      text not null,
  levels     text[] not null,
  created_at timestamptz not null default now(),
  constraint field_classes_key_chk check (key in ('comp', 'tin', 'bank', 'personal', 'secrets')),
  constraint field_classes_levels_chk check (
    cardinality(levels) > 0 and levels <@ array['hidden','grouped','masked','reveal_logged','visible']::text[])
);

create table if not exists core.field_class_columns (
  field_class  text not null references core.field_classes(key),
  schema_name  text not null,
  table_name   text not null,
  column_name  text not null,
  enforcement  text not null default 'serializer',
  note         text,
  primary key (schema_name, table_name, column_name),
  constraint field_class_columns_enforcement_chk check (enforcement in ('column_revoke', 'serializer'))
);

create table if not exists core.field_reveals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  membership_id uuid references core.memberships(id) on delete set null,
  clerk_user_id text not null,
  field_class   text not null references core.field_classes(key),
  subject_table text not null,
  subject_id    text not null,
  reason        text not null,
  at            timestamptz not null default now(),
  constraint field_reveals_reason_chk check (length(btrim(reason)) >= 3)
);
create index if not exists idx_field_reveals_org_at on core.field_reveals (org_id, at desc);
comment on table core.field_reveals is
  '05 R-6: every reveal of a reveal_logged field (tin / bank) with its reason. Append-only.';

insert into core.field_classes (key, label, levels) values
  ('comp',     'Compensation',          array['hidden','grouped','visible']),
  ('tin',      'Taxpayer ID',           array['hidden','masked','reveal_logged','visible']),
  ('bank',     'Bank account details',  array['hidden','masked','reveal_logged','visible']),
  ('personal', 'Personal details',      array['hidden','visible']),
  ('secrets',  'Secrets',               array['hidden'])
on conflict (key) do update set label = excluded.label, levels = excluded.levels;

insert into core.field_class_columns (field_class, schema_name, table_name, column_name, enforcement, note) values
  ('tin',      'core',   'vendors',                 'tin_encrypted',       'column_revoke', 'Vendor TIN; read only by the server (1099 / duplicate detection)'),
  ('comp',     'core',   'employees',               'hourly_rate_cents',   'column_revoke', 'Pay rate'),
  ('comp',     'core',   'employees',               'annual_salary_cents', 'column_revoke', 'Salary'),
  ('comp',     'public', 'payroll_run_employees',   'gross_cents',         'serializer',    'Per-person payroll'),
  ('comp',     'public', 'payroll_run_employees',   'net_cents',           'serializer',    'Per-person payroll'),
  ('comp',     'public', 'payroll_run_employees',   'employee_tax_cents',  'serializer',    'Per-person payroll'),
  ('comp',     'public', 'payroll_run_employees',   'employer_tax_cents',  'serializer',    'Per-person payroll'),
  ('comp',     'public', 'payroll_run_employees',   'deductions_cents',    'serializer',    'Per-person payroll'),
  ('comp',     'public', 'payroll_run_employees',   'benefits_cents',      'serializer',    'Per-person payroll'),
  ('comp',     'public', 'payroll_run_employees',   'earnings',            'serializer',    'Per-person payroll'),
  ('bank',     'public', 'vendor_payment_profiles', 'account_mask',        'serializer',    'Stored as last 4 only'),
  ('bank',     'public', 'vendor_payment_profiles', 'routing_mask',        'serializer',    'Stored as last 4 only'),
  ('bank',     'public', 'bank_accounts',           'account_mask',        'serializer',    'Stored as last 4 only'),
  ('bank',     'public', 'ach_authorizations',      'account_mask',        'serializer',    'Stored as last 4 only'),
  ('bank',     'public', 'ach_authorizations',      'routing_mask',        'serializer',    'Stored as last 4 only')
on conflict (schema_name, table_name, column_name) do update
  set field_class = excluded.field_class, enforcement = excluded.enforcement, note = excluded.note;

-- Re-apply column-level SELECT masks for every table that has a 'column_revoke'
-- column: table-level SELECT is revoked from anon / authenticated and SELECT is
-- re-granted on every OTHER column (to each role that held table SELECT before).
-- Re-run this after adding a column to a masked table.
create or replace function core.apply_field_column_masks() returns integer
  language plpgsql
  set search_path = core, public
as $$
declare
  t record;
  r text;
  v_cols text;
  v_masked text;
  v_had boolean;
  n integer := 0;
begin
  for t in
    select distinct schema_name, table_name
      from core.field_class_columns
     where enforcement = 'column_revoke'
  loop
    if to_regclass(format('%I.%I', t.schema_name, t.table_name)) is null then continue; end if;
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position)
      into v_cols
      from information_schema.columns c
     where c.table_schema = t.schema_name and c.table_name = t.table_name
       and not exists (select 1 from core.field_class_columns f
                        where f.schema_name = c.table_schema and f.table_name = c.table_name
                          and f.column_name = c.column_name and f.enforcement = 'column_revoke');
    select string_agg(format('%I', f.column_name), ', ')
      into v_masked
      from core.field_class_columns f
      join information_schema.columns c
        on c.table_schema = f.schema_name and c.table_name = f.table_name and c.column_name = f.column_name
     where f.schema_name = t.schema_name and f.table_name = t.table_name and f.enforcement = 'column_revoke';
    foreach r in array array['authenticated', 'anon'] loop
      if not exists (select 1 from pg_roles where rolname = r) then continue; end if;
      -- held table SELECT, or already holds the column grants from a previous run
      v_had := has_table_privilege(r, format('%I.%I', t.schema_name, t.table_name), 'SELECT')
            or exists (select 1 from information_schema.column_privileges cp
                        where cp.table_schema = t.schema_name and cp.table_name = t.table_name
                          and cp.grantee = r and cp.privilege_type = 'SELECT');
      execute format('revoke select on table %I.%I from %I', t.schema_name, t.table_name, r);
      if v_masked is not null then
        execute format('revoke select (%s) on table %I.%I from %I', v_masked, t.schema_name, t.table_name, r);
      end if;
      if v_had and v_cols is not null then
        execute format('grant select (%s) on table %I.%I to %I', v_cols, t.schema_name, t.table_name, r);
      end if;
    end loop;
    execute format('grant select on table %I.%I to service_role', t.schema_name, t.table_name);
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function core.apply_field_column_masks() from public, anon, authenticated;
grant execute on function core.apply_field_column_masks() to service_role;

select core.apply_field_column_masks();

-- RLS: the catalogs are readable by members; reveals are tenant-scoped; writes are
-- service_role only (the reveal is logged by the server after the capability check).
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['field_classes', 'field_class_columns', 'field_reveals'] loop
    execute format('alter table core.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'core' and tablename = t loop
      execute format('drop policy if exists %I on core.%I', p.policyname, t);
    end loop;
    if t = 'field_reveals' then
      execute 'create policy member_read on core.field_reveals for select using (org_id = public.get_org_id())';
    else
      execute format('create policy member_read on core.%I for select using (true)', t);
    end if;
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select on table core.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

-- Reveals are append-only (05 H7 spirit): no UPDATE / DELETE, even for the server.
create or replace function core.m167_field_reveals_immutable() returns trigger
  language plpgsql as
$$
begin
  raise exception 'core.field_reveals is append-only' using errcode = 'check_violation';
end
$$;
drop trigger if exists trg_field_reveals_immutable on core.field_reveals;
create trigger trg_field_reveals_immutable before update or delete on core.field_reveals
  for each row execute function core.m167_field_reveals_immutable();
revoke all on function core.m167_field_reveals_immutable() from public, anon, authenticated;

-- ── §6 R-7: tenant security policy + IP allowlists ───────────────────────────
alter table core.organizations add column if not exists security_policy jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_security_policy_obj_chk') then
    alter table core.organizations add constraint organizations_security_policy_obj_chk
      check (jsonb_typeof(security_policy) = 'object');
  end if;
end $$;
comment on column core.organizations.security_policy is
  '05 R-7: {mfa_all_staff bool, default_step_up_minutes int (0 = off), session_max_hours int, idle_timeout_minutes int, ip_allowlist_enforced bool}. Empty = every policy off. Written only by the server (mig 154 lock).';

create table if not exists core.ip_allowlists (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references core.organizations(id) on delete cascade,
  name       text not null,
  cidrs      cidr[] not null default '{}',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ip_allowlists_name_chk check (length(btrim(name)) > 0)
);
create unique index if not exists uq_ip_allowlists_org_name on core.ip_allowlists (org_id, lower(name));

do $$
declare p record;
begin
  alter table core.ip_allowlists enable row level security;
  for p in select policyname from pg_policies where schemaname = 'core' and tablename = 'ip_allowlists' loop
    execute format('drop policy if exists %I on core.ip_allowlists', p.policyname);
  end loop;
  create policy member_read on core.ip_allowlists for select using (org_id = public.get_org_id());
  create policy service_all on core.ip_allowlists for all to service_role using (true) with check (true);
  revoke insert, update, delete, truncate on table core.ip_allowlists from anon, authenticated;
  grant select on table core.ip_allowlists to authenticated;
  grant select, insert, update, delete on table core.ip_allowlists to service_role;
end $$;

-- End migration 167.

-- Wave-2 integration: re-apply client-scope RLS (163) so any client-owned table or
-- location_id column created above gets its restrictive policy.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
