-- =============================================================================
-- Migration 163: client-scoped (location) RLS, STAGED — wave 2B
--                (IA-SPEC M-4 v2 · 05-RBAC-SPEC §1.4, §3.1, §5.2.1, R-11 DB part)
-- =============================================================================
-- WHY. Until now every business-table policy is `org_id = get_org_id()` only: any
-- member of a tenant can read every client's books, and "client restriction" lives in
-- the UI. Wave 1 (mig 160) created the authority — core.access_assignments
-- (membership × scope × role|permission set) and client sets. This migration makes the
-- DATABASE honour the assignment's client scope, behind a per-tenant switch.
--
-- THE CONTRACT (fixed — wave 2A / mig 164 calls these; do not rename or re-sign):
--   core.can_access_location(p_location_id uuid) returns boolean
--   core.accessible_location_ids()               returns setof uuid
-- Both report the TRUTH of the caller's assignments regardless of the staging mode
-- (the mode only decides whether RLS acts on it):
--   * caller = active core.memberships row in get_org_id() for the JWT `sub`
--     (core.users.clerk_user_id) — same identity path get_org_id()/canApprove use;
--   * union of ACTIVE, IN-EFFECT assignments (status 'active', effective_from <= now(),
--     effective_to null or > now()) of either grant type:
--       all_clients → every location of the org
--       client      → that location
--       client_set  → the set's members (core.client_set_members, materialised by mig 160)
--     consolidation_group grants consol.* only (05 §3.9 — the holder must already reach
--     every member) and tenant scope carries no client data → neither adds a location;
--   * service_role callers → every location / true;
--   * can_access_location(NULL) → true (org-level rows are not client-scoped).
--   read_only assignments DO confer visibility; whether a write is allowed is the
--   capability layer's call (2A), not RLS's.
--   core.client_access_policies (mig 161) carries no READ-scope semantics (envelope,
--   invite, seat cap, MFA floor — MFA is R-7 / wave 2C), so it is not consulted here.
--
-- STAGING. core.organizations.client_scope_rls_mode  off | shadow | enforce (default off)
--   off     → policies allow exactly what the org policy allows (no behaviour change)
--   shadow  → same as off at the DB; the APP records would-be denials
--             (lib/rbac/client-scope.ts → core.log_client_scope_denials → shadow log).
--             SQL can't log on SELECT cheaply, so shadow logging is app-side.
--   enforce → the RESTRICTIVE policies below filter rows to the caller's scope.
--
-- POLICY SHAPE. One RESTRICTIVE policy `client_scope_rls` per covered table, FOR ALL,
-- TO PUBLIC (not just `authenticated`: a token that reaches PostgREST without a `role`
-- claim runs as `anon` but still carries org claims — scoping must not depend on the
-- role claim), USING = WITH CHECK:
--     (select core.client_scope_bypass())                      -- initplan: once / stmt
--  or location_id is null                                      -- org-level row
--  or location_id in (select core.accessible_location_ids())  -- hashed subplan: once / stmt
-- client_scope_bypass() = not enforced (off/shadow, service_role) OR caller holds an
-- all_clients assignment (fast path for controllers + lets them INSERT a new client,
-- whose id cannot be in a snapshot taken before the row exists).
--
-- COVERAGE (generated, not hand-listed — a guard test fails if a future table skips it):
--   (1) every public/core base table with a uuid `location_id` column, except EXCLUDED;
--   (2) special owning columns: core.locations(id), public.accounts(company_location_id);
--   (3) two-party rows (intercompany_balances/_transactions: from/to;
--       intercompany_loans: lender/borrower) — visible when EITHER party is in scope
--       (it is both clients' books);
--   (4) public.report_packs(location_ids jsonb) — visible when EVERY listed client is in
--       scope (or the pack is org-wide: null / empty);
--   (5) stage-(a) child tables without location_id follow their parent via FK.
-- EXCLUDED (deliberately, see the guard test for the same list):
--   core.membership_locations    legacy one-way mirror, no org_id, retired in R-14;
--   core.client_scope_shadow_log the denial audit itself — tenant-admin read only.
-- NOT owning (never used as the scope column): gl_entry_lines.counterparty_location_id,
--   core.customers.related_location_id, core.membership_invitations.location_ids.
--
-- SECURITY. Helper functions are STABLE SECURITY DEFINER with a pinned search_path;
-- they read core.* as the owner, so a policy on core.locations that calls
-- accessible_location_ids() (which reads core.locations) cannot recurse. EXECUTE is
-- revoked from PUBLIC/anon/authenticated and then granted explicitly (M1 lesson) to the
-- roles whose queries evaluate the policies (anon, authenticated) and service_role.
-- PGlite-safe: no subqueries in CHECKs; idempotent (if not exists / drop policy if exists).
-- =============================================================================

-- ── staging switch ───────────────────────────────────────────────────────────
alter table core.organizations add column if not exists client_scope_rls_mode text not null default 'off';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_client_scope_rls_mode_chk') then
    alter table core.organizations add constraint organizations_client_scope_rls_mode_chk
      check (client_scope_rls_mode in ('off', 'shadow', 'enforce'));
  end if;
end $$;
comment on column core.organizations.client_scope_rls_mode is
  'Wave 2B (IA M-4): off = org-only RLS (unchanged) · shadow = app logs would-be client-scope denials · enforce = restrictive client-scope RLS. Service-role write only.';

-- ── policy-performance indexes ───────────────────────────────────────────────
create index if not exists idx_access_assignments_scope_active
  on core.access_assignments (membership_id, scope_type) where status = 'active';
create index if not exists idx_access_assignments_client_set
  on core.access_assignments (client_set_id) where client_set_id is not null;
create index if not exists idx_locations_org_id on core.locations (org_id);

-- ── caller identity ──────────────────────────────────────────────────────────
-- Is the caller the service role? Reads the `role` GUC (PostgREST's SET ROLE; NOT
-- changed by SECURITY DEFINER, unlike current_user) and the verified JWT role claim.
create or replace function core.client_scope_is_service() returns boolean
  language sql stable set search_path = core, public, pg_temp as
$$
  select coalesce(current_setting('role', true), '') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
$$;

-- The caller's ACTIVE membership in the request org (JWT sub → core.users → memberships).
create or replace function core.client_scope_caller_membership() returns uuid
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select ms.id
    from core.memberships ms
    join core.users u on u.id = ms.user_id
   where u.clerk_user_id = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
     and ms.org_id = public.get_org_id()
     and ms.status = 'active'
   limit 1
$$;

-- ── THE CONTRACT ─────────────────────────────────────────────────────────────
create or replace function core.accessible_location_ids() returns setof uuid
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_org uuid := public.get_org_id(); v_m uuid;
begin
  if core.client_scope_is_service() then
    return query select l.id from core.locations l where v_org is null or l.org_id = v_org;
    return;
  end if;
  if v_org is null then return; end if;
  v_m := core.client_scope_caller_membership();
  if v_m is null then return; end if;

  return query
    with a as (
      select x.scope_type, x.location_id, x.client_set_id
        from core.access_assignments x
       where x.membership_id = v_m
         and x.org_id = v_org
         and x.status = 'active'
         and x.effective_from <= now()
         and (x.effective_to is null or x.effective_to > now())
         and x.scope_type in ('all_clients', 'client', 'client_set')
    )
    select l.id from core.locations l
     where l.org_id = v_org and exists (select 1 from a where a.scope_type = 'all_clients')
    union
    select l.id from a join core.locations l on l.id = a.location_id and l.org_id = v_org
     where a.scope_type = 'client'
    union
    select l.id from a
      join core.client_set_members m on m.set_id = a.client_set_id
      join core.locations l on l.id = m.location_id and l.org_id = v_org
     where a.scope_type = 'client_set';
end
$$;
comment on function core.accessible_location_ids() is
  'Wave 2B contract: the caller''s client scope (locations) from active, in-effect access assignments. Mode-independent truth. service_role → every location.';

create or replace function core.can_access_location(p_location_id uuid) returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
begin
  if p_location_id is null or core.client_scope_is_service() then return true; end if;
  return exists (select 1 from core.accessible_location_ids() x where x = p_location_id);
end
$$;
comment on function core.can_access_location(uuid) is
  'Wave 2B contract: may the caller see this client? NULL (org-level) → true; service_role → true. Mode-independent truth.';

-- ── mode / gate helpers ──────────────────────────────────────────────────────
create or replace function core.client_scope_mode() returns text
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select coalesce((select o.client_scope_rls_mode from core.organizations o where o.id = public.get_org_id()), 'off')
$$;

create or replace function core.client_scope_has_all_clients() returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_m uuid;
begin
  if core.client_scope_is_service() then return true; end if;
  v_m := core.client_scope_caller_membership();
  if v_m is null then return false; end if;
  return exists (select 1 from core.access_assignments x
                  where x.membership_id = v_m and x.scope_type = 'all_clients' and x.status = 'active'
                    and x.effective_from <= now() and (x.effective_to is null or x.effective_to > now()));
end
$$;

-- RLS short-circuit: true → the restrictive policy passes every row the org policy passes.
create or replace function core.client_scope_bypass() returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
begin
  if core.client_scope_is_service() then return true; end if;
  if core.client_scope_mode() <> 'enforce' then return true; end if;
  return core.client_scope_has_all_clients();
end
$$;

-- Row-level convenience for callers that want the mode-aware answer for ONE client
-- (policies use the set-based form above; this is for definer RPCs / app checks).
create or replace function core.client_scope_ok(p_location_id uuid) returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select p_location_id is null or core.client_scope_bypass() or core.can_access_location(p_location_id)
$$;

-- One round-trip for the app (lib/rbac/client-scope.ts).
create or replace function core.client_scope_state() returns jsonb
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_all boolean := core.client_scope_has_all_clients();
begin
  return jsonb_build_object(
    'mode', core.client_scope_mode(),
    'membership_id', core.client_scope_caller_membership(),
    'all_clients', v_all,
    'location_ids', coalesce((select jsonb_agg(x) from core.accessible_location_ids() x), '[]'::jsonb));
end
$$;

-- Tenant admin = active membership whose role normalises to company_admin (mig 158).
create or replace function core.client_scope_caller_is_admin() returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select exists (select 1 from core.memberships ms
                  where ms.id = core.client_scope_caller_membership()
                    and core.rbac_normalize_legacy_role(ms.role) = 'company_admin')
$$;

-- ── shadow / denial log ──────────────────────────────────────────────────────
create table if not exists core.client_scope_shadow_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  membership_id uuid references core.memberships(id) on delete set null,
  clerk_user_id text,
  location_id   uuid not null references core.locations(id) on delete cascade,
  surface       text not null,
  mode          text not null,
  decision      text not null,
  log_day       date not null default current_date,
  hits          integer not null default 1,
  detail        jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint client_scope_shadow_log_surface_chk check (surface in ('company_list', 'active_company', 'company_switch', 'api')),
  constraint client_scope_shadow_log_mode_chk check (mode in ('shadow', 'enforce')),
  constraint client_scope_shadow_log_decision_chk check (decision in ('would_deny', 'denied')),
  constraint client_scope_shadow_log_hits_chk check (hits > 0)
);
create unique index if not exists uq_client_scope_shadow_log_day
  on core.client_scope_shadow_log (org_id, coalesce(clerk_user_id, ''), location_id, surface, decision, log_day);
create index if not exists idx_client_scope_shadow_log_org on core.client_scope_shadow_log (org_id, last_seen_at desc);
comment on table core.client_scope_shadow_log is
  'Wave 2B: client-scope denials seen by the app — would_deny (shadow) / denied (enforce). One row per (user, client, surface, decision, day); hits counts repeats. Written only by core.log_client_scope_denials.';

alter table core.client_scope_shadow_log enable row level security;
drop policy if exists admin_read on core.client_scope_shadow_log;
drop policy if exists service_all on core.client_scope_shadow_log;
create policy admin_read on core.client_scope_shadow_log for select
  using (org_id = public.get_org_id() and core.client_scope_caller_is_admin());
create policy service_all on core.client_scope_shadow_log for all to service_role using (true) with check (true);
revoke insert, update, delete, truncate on table core.client_scope_shadow_log from anon, authenticated;
grant select on table core.client_scope_shadow_log to authenticated;
grant select, insert, update, delete on table core.client_scope_shadow_log to service_role;

-- Record denials for the CALLER (identity, org and mode come from the JWT, never from
-- the app), only for real clients of the caller's org that are genuinely out of scope,
-- and only while the org is in shadow / enforce. Bounded: one row per
-- (user, client, surface, decision, day). Returns the number of clients recorded.
create or replace function core.log_client_scope_denials(p_location_ids uuid[], p_surface text, p_detail jsonb default null)
returns integer
  language plpgsql volatile security definer set search_path = core, public, pg_temp as
$$
declare
  v_org uuid := public.get_org_id(); v_mode text; v_m uuid; v_sub text; v_n int := 0;
begin
  if v_org is null or p_location_ids is null or cardinality(p_location_ids) = 0 then return 0; end if;
  if p_surface not in ('company_list', 'active_company', 'company_switch', 'api') then
    raise exception 'unknown client-scope surface %', p_surface using errcode = 'check_violation';
  end if;
  v_mode := core.client_scope_mode();
  if v_mode = 'off' or core.client_scope_has_all_clients() then return 0; end if;
  v_m := core.client_scope_caller_membership();
  v_sub := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';

  insert into core.client_scope_shadow_log as s
         (org_id, membership_id, clerk_user_id, location_id, surface, mode, decision, detail)
  select v_org, v_m, v_sub, l.id, p_surface, v_mode,
         case when v_mode = 'enforce' then 'denied' else 'would_deny' end, p_detail
    from core.locations l
   where l.org_id = v_org
     and l.id = any (p_location_ids)
     and not exists (select 1 from core.accessible_location_ids() x where x = l.id)
  on conflict (org_id, coalesce(clerk_user_id, ''), location_id, surface, decision, log_day)
  do update set hits = s.hits + 1, last_seen_at = now(), detail = coalesce(excluded.detail, s.detail);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ── grants (M1 lesson: revoke, then grant explicitly to every role that needs it) ──
do $$
declare f text;
begin
  -- evaluated inside policies (TO PUBLIC) or called by the app as the user
  foreach f in array array[
    'core.accessible_location_ids()',
    'core.can_access_location(uuid)',
    'core.client_scope_mode()',
    'core.client_scope_has_all_clients()',
    'core.client_scope_bypass()',
    'core.client_scope_ok(uuid)',
    'core.client_scope_state()',
    'core.client_scope_caller_is_admin()',
    'core.client_scope_is_service()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
  -- internal identity resolver: definer callers only
  revoke all on function core.client_scope_caller_membership() from public, anon, authenticated;
  grant execute on function core.client_scope_caller_membership() to service_role;
  -- the denial logger: the signed-in user (it derives identity itself) + service
  revoke all on function core.log_client_scope_denials(uuid[], text, jsonb) from public, anon, authenticated;
  grant execute on function core.log_client_scope_denials(uuid[], text, jsonb) to authenticated, service_role;
end $$;

-- ── the restrictive policies ─────────────────────────────────────────────────
-- Re-runnable: core.apply_client_scope_rls() (re)creates every policy from the live
-- catalog. Run it again after adding a client-owned table (the guard test insists).
create or replace function core.apply_client_scope_rls() returns integer
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  r record; v_n int := 0; v_expr text;
  c_gate constant text := '(select core.client_scope_bypass())';
  c_in   constant text := ' in (select core.accessible_location_ids())';
  -- (child schema.table, fk column, parent schema.table) — stage (a) children that carry
  -- no location_id of their own: GL / bank / bills / invoices / payroll / documents.
  children constant text[][] := array[
    array['public.bill_lines',                    'bill_id',               'public.bills'],
    array['public.retainage_releases',            'bill_id',               'public.bills'],
    array['public.invoice_lines',                 'invoice_id',            'public.invoices'],
    array['public.invoice_events',                'invoice_id',            'public.invoices'],
    array['public.payment_applications',          'invoice_id',            'public.invoices'],
    array['public.credit_memo_lines',             'credit_memo_id',        'public.credit_memos'],
    array['public.estimate_lines',                'estimate_id',           'public.estimates'],
    array['public.internal_invoice_lines',        'internal_invoice_id',   'public.internal_invoices'],
    array['public.purchase_order_lines',          'po_id',                 'public.purchase_orders'],
    array['public.goods_receipts',                'po_id',                 'public.purchase_orders'],
    array['public.customer_deposit_applications', 'deposit_id',            'public.customer_deposits'],
    array['public.customer_payments',             'bank_account_id',       'public.bank_accounts'],
    array['public.bank_reconciliations',          'bank_account_id',       'public.bank_accounts'],
    array['public.payment_origination_items',     'batch_id',              'public.payment_origination_batches'],
    array['public.payroll_run_employees',         'payroll_run_id',        'public.payroll_runs'],
    array['public.debt_schedule_lines',           'instrument_id',         'public.debt_instruments'],
    array['public.lease_schedule_lines',          'lease_id',              'public.leases'],
    array['public.depreciation_runs',             'fixed_asset_id',        'public.fixed_assets'],
    array['public.tax_depreciation_runs',         'fixed_asset_id',        'public.fixed_assets'],
    array['public.insurance_amortization_runs',   'schedule_id',           'public.insurance_amortization_schedules'],
    array['public.covenant_measurements',         'covenant_id',           'public.loan_covenants'],
    array['public.recurring_je_runs',             'template_id',           'public.recurring_je_templates'],
    array['public.posting_schedule_runs',         'schedule_id',           'public.posting_schedules'],
    array['public.deferred_tax_items',            'provision_id',          'public.tax_provision'],
    array['public.agent_run_steps',               'run_id',                'public.agent_runs'],
    array['public.job_cost_entries',              'job_id',                'core.jobs'],
    array['public.approval_request_actions',      'request_id',            'public.approval_requests']
  ];
  i int;
begin
  -- (1) owning location_id
  for r in
    select c.table_schema as s, c.table_name as t
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
     where c.table_schema in ('public', 'core') and c.column_name = 'location_id' and c.udt_name = 'uuid'
       -- Excluded: legacy mirror; admin audit log; and access-governance rows (166/165) whose
       -- own RLS already limits them to admins / the requester / the reviewer — client scope
       -- would hide a requester's own request for a client they don't have yet.
       and (c.table_schema, c.table_name) not in (('core', 'membership_locations'), ('core', 'client_scope_shadow_log'),
                                                  ('core', 'access_requests'), ('core', 'access_reviews'),
                                                  ('core', 'sod_exceptions'))
  loop
    v_expr := format('%s or location_id is null or location_id%s', c_gate, c_in);
    execute format('drop policy if exists client_scope_rls on %I.%I', r.s, r.t);
    execute format('create policy client_scope_rls on %I.%I as restrictive for all to public using (%s) with check (%s)',
                   r.s, r.t, v_expr, v_expr);
    v_n := v_n + 1;
  end loop;

  -- (2) special owning columns
  if to_regclass('core.locations') is not null then
    v_expr := format('%s or id%s', c_gate, c_in);
    execute 'drop policy if exists client_scope_rls on core.locations';
    execute format('create policy client_scope_rls on core.locations as restrictive for all to public using (%s) with check (%s)', v_expr, v_expr);
    v_n := v_n + 1;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'accounts' and column_name = 'company_location_id') then
    v_expr := format('%s or company_location_id is null or company_location_id%s', c_gate, c_in);
    execute 'drop policy if exists client_scope_rls on public.accounts';
    execute format('create policy client_scope_rls on public.accounts as restrictive for all to public using (%s) with check (%s)', v_expr, v_expr);
    v_n := v_n + 1;
  end if;

  -- (3) two-party rows: either party in scope
  for r in
    select * from (values ('intercompany_balances', 'from_location_id', 'to_location_id'),
                          ('intercompany_transactions', 'from_location_id', 'to_location_id'),
                          ('intercompany_loans', 'lender_location_id', 'borrower_location_id')) v(t, a, b)
  loop
    continue when (select count(*) from information_schema.columns
                    where table_schema = 'public' and table_name = r.t and column_name in (r.a, r.b)) < 2;
    v_expr := format('%1$s or (%2$I is null and %3$I is null) or %2$I%4$s or %3$I%4$s', c_gate, r.a, r.b, c_in);
    execute format('drop policy if exists client_scope_rls on public.%I', r.t);
    execute format('create policy client_scope_rls on public.%I as restrictive for all to public using (%s) with check (%s)',
                   r.t, v_expr, v_expr);
    v_n := v_n + 1;
  end loop;

  -- (4) report packs: every listed client in scope (null / empty = org-wide)
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'report_packs'
                and column_name = 'location_ids' and udt_name = 'jsonb') then
    v_expr := format('%s or location_ids is null or jsonb_typeof(location_ids) <> ''array'' or not exists ('
                     'select 1 from jsonb_array_elements_text(location_ids) e(v) '
                     'where e.v not in (select x::text from core.accessible_location_ids() x))', c_gate);
    execute 'drop policy if exists client_scope_rls on public.report_packs';
    execute format('create policy client_scope_rls on public.report_packs as restrictive for all to public using (%s) with check (%s)', v_expr, v_expr);
    v_n := v_n + 1;
  end if;

  -- (5) children follow their parent's client
  for i in 1 .. array_length(children, 1) loop
    continue when to_regclass(children[i][1]) is null or to_regclass(children[i][3]) is null;
    continue when not exists (select 1 from information_schema.columns
                               where table_schema || '.' || table_name = children[i][1] and column_name = children[i][2]);
    continue when exists (select 1 from information_schema.columns    -- already covered by (1)
                           where table_schema || '.' || table_name = children[i][1] and column_name = 'location_id');
    continue when not exists (select 1 from information_schema.columns -- parent not client-owned (yet)
                               where table_schema || '.' || table_name = children[i][3] and column_name = 'location_id');
    -- the FK is qualified with the child's own name so it can never bind to a same-named
    -- parent column inside the subquery
    v_expr := format('%1$s or %5$I.%2$I is null or exists (select 1 from %3$s p where p.id = %5$I.%2$I '
                     'and (p.location_id is null or p.location_id%4$s))',
                     c_gate, children[i][2], children[i][3], c_in, split_part(children[i][1], '.', 2));
    execute format('drop policy if exists client_scope_rls on %s', children[i][1]);
    execute format('create policy client_scope_rls on %s as restrictive for all to public using (%s) with check (%s)',
                   children[i][1], v_expr, v_expr);
    v_n := v_n + 1;
  end loop;

  return v_n;
end
$$;
revoke all on function core.apply_client_scope_rls() from public, anon, authenticated;
grant execute on function core.apply_client_scope_rls() to service_role;

select core.apply_client_scope_rls();
