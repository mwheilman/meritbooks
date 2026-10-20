-- =============================================================================
-- Migration 168: lock core.events + core.vendors writes (wave-2 security holes) and
--                close the AR-refund money-approval gap in the R-2 backfill (wave 2F)
-- =============================================================================
--
-- §1  HIGH  core.events was member-WRITABLE over PostgREST: policy org_isolation FOR ALL
--           (org_id = get_org_id()) plus INSERT / UPDATE / DELETE granted to anon and
--           authenticated. Any signed-in member could forge an event in their tenant —
--           e.g. a JOB_BILLING row that the next drain turns into an AR invoice + GL
--           post, a DEPT_INVOICE_ISSUE that books an intercompany entry, or flip a
--           processed row back to 'pending' to double-post. Fix (167 §1 pattern,
--           order-independent): every member-facing write policy is converted to a SELECT
--           policy with the SAME read predicate, service_all is added, and INSERT /
--           UPDATE / DELETE / TRUNCATE are revoked from anon + authenticated.
--           Every app emitter now writes with the service-role client after an explicit
--           permission check, org_id pinned to the session org (apps/web:
--           lib/services/job-cost-events.ts, dept-invoice-events.ts, sandbox.ts). The
--           drains already ran on the service role (mig 167 claim). Projects/PM emit
--           through SECURITY DEFINER functions (proj.* / pm.* — verified definer), so
--           they are unaffected.
--
-- §2  HIGH  core.vendors was member-WRITABLE the same way, and POST / PATCH /api/vendors
--           had no permission check. Same fix; app writes go through the service role
--           after requirePermission('vendors', 'create' | 'edit'), org pinned (apps/web:
--           api/vendors, api/vendors/w9-parse, onboarding/import/ap, lib/ap/intake,
--           lib/bank/vendor-resolution, services/sandbox, services/posting-verify).
--           Column SELECT masks from 167 (tin_encrypted) are untouched; this migration
--           adds no column, but re-runs core.apply_field_column_masks() at the end anyway.
--
-- §3  Money capability gap (2A dual-run). 05 §2.3 maps no legacy key to pay.refunds,
--     so after the R-2 backfill NO imported role could approve or release an AR refund,
--     while today's canApprove() lets every money approver approve one. lib/rbac/
--     legacy-map.ts gains four APPENDED rules (introducedIn '168', mirrored below by the
--     generated block):
--        bills / checks / payroll : approve      → pay.refunds  view + approve
--        ap_disbursement_release : run           → pay.refunds  view + release
--     (05 §2.3 reconciliation-row precedent: "A granted to roles that pass today's
--     canApprove".) New tenants pick these up through the normal import. EXISTING
--     tenants (158–160 are live) get a NEW published version of each affected imported
--     role / legacy permission set — published versions are never edited:
--        * tenant roles imported from a legacy key (system or mig-130 custom),
--          merit_controller's role WITHOUT the release (it lives in "Legacy controller
--          release", 05 §7.3 backfill note);
--        * "Legacy controller release" gets the refund release;
--        * "Legacy full books" (company_admin) gets whatever Tenant admin doesn't hold.
--     Only the 168 rules' grants are added (never a re-import), constraints on existing
--     grants are preserved, external audiences are skipped (H3). If a role already has
--     Proposed changes (a draft), the grants are added to that draft instead. Logged in
--     the access log as source 'backfill'.
--     NOT changed (intended C3 narrowings, 05 §5.1 / §5.7 R-11): a role that approves
--     money today only through bills:approve keeps ap.bills:approve but does not gain
--     pay.batches / payroll.runs approve; assistant_cfo and check_processor do not gain
--     payroll.runs approve. The dual run reports these as 'money_kind' and the flip is
--     refused until a tenant admin acknowledges them.
--
-- M1 lesson: every function below is EXECUTE-revoked from public / anon / authenticated
-- and granted to service_role. Idempotent. PGlite-compatible. No GL effect.
-- =============================================================================

-- ── §1 + §2: write locks on core.events / core.vendors ───────────────────────
do $$
declare
  t record;
  p record;
  v_roles text;
begin
  for t in select * from (values ('core', 'events'), ('core', 'vendors')) as v(sch, tbl) loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      raise notice 'migration 168: %.% not present, skipped', t.sch, t.tbl;
      continue;
    end if;
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);

    -- PERMISSIVE member write policies → SELECT policies with the SAME predicate. A
    -- RESTRICTIVE policy (client scope, 163) never grants anything and is left alone.
    for p in
      select policyname, cmd, roles, qual
        from pg_policies
       where schemaname = t.sch and tablename = t.tbl
         and permissive = 'PERMISSIVE'
         and cmd <> 'SELECT'
         and roles::text <> '{service_role}'
    loop
      execute format('drop policy if exists %I on %I.%I', p.policyname, t.sch, t.tbl);
      if p.cmd = 'ALL' and p.qual is not null then
        v_roles := array_to_string(p.roles, ', ');
        execute format('create policy %I on %I.%I for select to %s using (%s)',
                       p.policyname, t.sch, t.tbl, v_roles, p.qual);
      end if;
    end loop;

    -- A table with no member read policy left (e.g. only INSERT policies) still needs one.
    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and cmd in ('SELECT', 'ALL')
                      and permissive = 'PERMISSIVE' and roles::text <> '{service_role}') then
      execute format('create policy member_read on %I.%I for select using (org_id = public.get_org_id())', t.sch, t.tbl);
    end if;

    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and policyname = 'service_all') then
      execute format(
        'create policy service_all on %I.%I for all to service_role using (true) with check (true)',
        t.sch, t.tbl);
    end if;

    execute format('revoke insert, update, delete, truncate on table %I.%I from anon, authenticated', t.sch, t.tbl);
    execute format('grant insert, update, delete on table %I.%I to service_role', t.sch, t.tbl);
  end loop;
end $$;

-- service_role keeps table SELECT on both (vendors' member SELECT is column-level, 167).
grant select on table core.events to service_role;
grant select on table core.vendors to service_role;

-- ── §3: legacy-rule corrections ──────────────────────────────────────────────
alter table core.legacy_cell_rules add column if not exists introduced_in text not null default '158';
comment on column core.legacy_cell_rules.introduced_in is
  'Migration that introduced the rule (158 = original block; later corrections are appended, rule numbers never shift).';

-- BEGIN GENERATED legacy_168 (apps/web/scripts/rbac/generate-access-seed.ts — do not edit by hand)
insert into core.legacy_cell_rules (rule_no, cell, capability, actions, requires_all, requires_any, introduced_in) values
  (90, 'bills::approve', 'pay.refunds', array['view', 'approve']::text[], '{}'::text[], '{}'::text[], '168'),
  (91, 'checks::approve', 'pay.refunds', array['view', 'approve']::text[], '{}'::text[], '{}'::text[], '168'),
  (92, 'payroll::approve', 'pay.refunds', array['view', 'approve']::text[], '{}'::text[], '{}'::text[], '168'),
  (93, 'ap_disbursement_release::run', 'pay.refunds', array['view', 'release']::text[], '{}'::text[], '{}'::text[], '168')
on conflict (rule_no, capability) do update set cell = excluded.cell, actions = excluded.actions, requires_all = excluded.requires_all, requires_any = excluded.requires_any, introduced_in = excluded.introduced_in;
-- END GENERATED legacy_168

-- Expansion restricted to the rules one migration introduced (same algebra as
-- core.rbac_legacy_grants, 158).
create or replace function core.rbac_legacy_grants_introduced(p_cells text[], p_introduced text) returns jsonb
  language sql stable as
$$
  with fired as (
    select r.capability, a.action
      from core.legacy_cell_rules r
      cross join lateral unnest(r.actions) a(action)
     where r.introduced_in = p_introduced
       and r.cell = any (p_cells)
       and r.requires_all <@ p_cells
       and (cardinality(r.requires_any) = 0 or r.requires_any && p_cells)
  ), per_cap as (
    select f.capability,
           array(select x.a from unnest(core.rbac_actions()) with ordinality x(a, o)
                  where x.a in (select f2.action from fired f2 where f2.capability = f.capability)
                  order by x.o) as actions
      from fired f group by f.capability
  )
  select coalesce(jsonb_agg(jsonb_build_object('capability', capability, 'actions', to_jsonb(actions), 'constraints', '{}'::jsonb)
                            order by capability), '[]'::jsonb)
    from per_cap
$$;

-- Add actions to a grant list, keeping every existing grant's constraints.
create or replace function core.rbac_grants_add_actions(p_cur jsonb, p_add jsonb) returns jsonb
  language sql immutable as
$$
  with cur as (
    select e ->> 'capability' as cap, e from jsonb_array_elements(coalesce(p_cur, '[]'::jsonb)) e
  ), addg as (
    select e ->> 'capability' as cap, array(select jsonb_array_elements_text(e -> 'actions')) as acts
      from jsonb_array_elements(coalesce(p_add, '[]'::jsonb)) e
  ), caps as (
    select cap from cur union select cap from addg
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'capability', c.cap,
           'actions', to_jsonb(array(
              select x from unnest(core.rbac_actions()) x
               where x = any (coalesce(array(select jsonb_array_elements_text(cur.e -> 'actions')), '{}'::text[])
                              || coalesce(addg.acts, '{}'::text[])))),
           'constraints', coalesce(cur.e -> 'constraints', '{}'::jsonb))
         order by c.cap), '[]'::jsonb)
    from caps c
    left join cur on cur.cap = c.cap
    left join addg on addg.cap = c.cap
$$;

-- Apply one correction batch to a ROLE: new published version (or into its draft).
create or replace function core.rbac_m168_add_to_role(p_role uuid, p_add jsonb, p_reason text) returns boolean
  language plpgsql as
$$
declare v_add jsonb; v_draft uuid; e jsonb; v_acts text[]; v_existing text[];
begin
  v_add := core.rbac_grants_minus(coalesce(p_add, '[]'::jsonb), core.rbac_role_current_grants(p_role));
  if jsonb_array_length(v_add) = 0 then return false; end if;
  select id into v_draft from core.role_versions where role_id = p_role and state = 'draft';
  if v_draft is null then
    perform core.rbac_publish_role_grants(p_role, core.rbac_grants_add_actions(core.rbac_role_current_grants(p_role), v_add), p_reason);
    return true;
  end if;
  -- Proposed changes already open: add to the draft so publishing it keeps the access
  -- (only what the draft lacks — keeps this idempotent).
  v_add := core.rbac_grants_minus(v_add, core.access_version_grants('role', v_draft));
  if jsonb_array_length(v_add) = 0 then return false; end if;
  for e in select * from jsonb_array_elements(v_add) loop
    v_acts := array(select jsonb_array_elements_text(e -> 'actions'));
    select actions into v_existing from core.role_grants where role_version_id = v_draft and capability = e ->> 'capability';
    if v_existing is null then
      insert into core.role_grants (role_version_id, capability, actions, constraints)
      values (v_draft, e ->> 'capability', v_acts, '{}'::jsonb);
    else
      update core.role_grants
         set actions = array(select x from unnest(core.rbac_actions()) x where x = any (v_existing || v_acts))
       where role_version_id = v_draft and capability = e ->> 'capability';
    end if;
  end loop;
  return true;
end
$$;

-- Same for a PERMISSION SET.
create or replace function core.rbac_m168_add_to_set(p_set uuid, p_add jsonb, p_reason text) returns boolean
  language plpgsql as
$$
declare v_add jsonb; v_draft uuid; e jsonb; v_acts text[]; v_existing text[];
begin
  v_add := core.rbac_grants_minus(coalesce(p_add, '[]'::jsonb), core.rbac_set_current_grants(p_set));
  if jsonb_array_length(v_add) = 0 then return false; end if;
  select id into v_draft from core.permission_set_versions where permission_set_id = p_set and state = 'draft';
  if v_draft is null then
    perform core.rbac_publish_set_grants(p_set, core.rbac_grants_add_actions(core.rbac_set_current_grants(p_set), v_add), p_reason);
    return true;
  end if;
  v_add := core.rbac_grants_minus(v_add, core.access_version_grants('permission_set', v_draft));
  if jsonb_array_length(v_add) = 0 then return false; end if;
  for e in select * from jsonb_array_elements(v_add) loop
    v_acts := array(select jsonb_array_elements_text(e -> 'actions'));
    select actions into v_existing from core.permission_set_grants
     where permission_set_version_id = v_draft and capability = e ->> 'capability';
    if v_existing is null then
      insert into core.permission_set_grants (permission_set_version_id, capability, actions, constraints)
      values (v_draft, e ->> 'capability', v_acts, '{}'::jsonb);
    else
      update core.permission_set_grants
         set actions = array(select x from unnest(core.rbac_actions()) x where x = any (v_existing || v_acts))
       where permission_set_version_id = v_draft and capability = e ->> 'capability';
    end if;
  end loop;
  return true;
end
$$;

-- Bring one tenant's IMPORTED roles / legacy sets up to the rules a migration
-- introduced. Idempotent: a second run finds nothing to add.
create or replace function core.rbac_apply_legacy_corrections(p_org uuid, p_introduced text) returns integer
  language plpgsql as
$$
declare
  r record; s record; lr core.legacy_roles%rowtype; v_is_legacy boolean;
  v_cells text[]; v_delta jsonb; v_n int := 0;
  v_reason text := format('MeritBooks correction (migration %s): keeps today''s money approval on AR refunds (05 §2.3)', p_introduced);
begin
  -- Roles imported from a legacy key (system key or a mig-130 custom key).
  for r in
    select * from core.role_definitions
     where owner_level = 'tenant' and org_id = p_org and legacy_role_key is not null
       and status <> 'archived' and audience = 'internal_staff'
     order by key
  loop
    select * into lr from core.legacy_roles where role_key = r.legacy_role_key;
    v_is_legacy := found;
    -- company_admin → Tenant admin keeps TEMPLATE grants; its legacy books access is the
    -- "Legacy full books" set (handled below).
    if v_is_legacy and lr.split = 'template_plus_legacy_set' and r.kind = 'standard' then
      continue;
    end if;
    v_cells := core.rbac_legacy_cells(p_org, r.legacy_role_key, true);
    v_delta := core.rbac_legacy_grants_introduced(v_cells, p_introduced);
    if v_is_legacy and lr.split = 'money_release_set' and r.kind = 'standard' then
      v_delta := core.rbac_grants_minus(v_delta, core.rbac_grants_money_release(v_delta));
    end if;
    -- H3 / H5 still apply (defensive: internal audiences only reach here).
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_delta
      from jsonb_array_elements(v_delta) e
     where core.rbac_grant_violation(r.audience, e ->> 'capability',
             array(select jsonb_array_elements_text(e -> 'actions'))) is null;
    if core.rbac_m168_add_to_role(r.id, v_delta, v_reason) then v_n := v_n + 1; end if;
  end loop;

  -- Legacy permission sets.
  for s in
    select * from core.permission_sets
     where owner_level = 'tenant' and org_id = p_org and status <> 'archived'
       and key in ('legacy_full_books', 'legacy_controller_release')
  loop
    if s.key = 'legacy_full_books' then
      v_delta := core.rbac_grants_minus(
        core.rbac_legacy_grants_introduced(core.rbac_legacy_cells(p_org, 'company_admin', true), p_introduced),
        coalesce((select core.rbac_role_current_grants(rd.id) from core.role_definitions rd
                   where rd.owner_level = 'tenant' and rd.org_id = p_org and rd.key = 'tenant_admin'), '[]'::jsonb));
    else
      v_delta := core.rbac_grants_money_release(
        core.rbac_legacy_grants_introduced(core.rbac_legacy_cells(p_org, 'merit_controller', true), p_introduced));
    end if;
    if core.rbac_m168_add_to_set(s.id, v_delta, v_reason) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end
$$;

revoke all on function core.rbac_legacy_grants_introduced(text[], text) from public, anon, authenticated;
grant execute on function core.rbac_legacy_grants_introduced(text[], text) to service_role;
revoke all on function core.rbac_grants_add_actions(jsonb, jsonb) from public, anon, authenticated;
grant execute on function core.rbac_grants_add_actions(jsonb, jsonb) to service_role;
revoke all on function core.rbac_m168_add_to_role(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function core.rbac_m168_add_to_role(uuid, jsonb, text) to service_role;
revoke all on function core.rbac_m168_add_to_set(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function core.rbac_m168_add_to_set(uuid, jsonb, text) to service_role;
revoke all on function core.rbac_apply_legacy_corrections(uuid, text) from public, anon, authenticated;
grant execute on function core.rbac_apply_legacy_corrections(uuid, text) to service_role;

-- Platform permission-set templates whose code grants changed: publish a NEW version
-- (published versions are immutable; 159's v1 stays as shipped). No-op when equal.
create or replace function core.rbac_republish_platform_permission_sets(p_sets jsonb, p_reason text) returns integer
  language plpgsql as
$$
declare t jsonb; v_id uuid; n int := 0;
begin
  for t in select * from jsonb_array_elements(coalesce(p_sets, '[]'::jsonb)) loop
    select id into v_id from core.permission_sets where owner_level = 'platform' and key = t ->> 'key';
    if v_id is null then continue; end if;
    if core.rbac_set_current_grants(v_id) is distinct from coalesce(t -> 'grants', '[]'::jsonb) then
      perform core.rbac_publish_set_grants(v_id, t -> 'grants', p_reason);
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;
revoke all on function core.rbac_republish_platform_permission_sets(jsonb, text) from public, anon, authenticated;
grant execute on function core.rbac_republish_platform_permission_sets(jsonb, text) to service_role;

-- BEGIN GENERATED permission_sets_168 (apps/web/scripts/rbac/generate-access-seed.ts — do not edit by hand)
select core.rbac_republish_platform_permission_sets($seed$[
  {"key":"legacy_full_books","grants":[{"capability":"ap.bills","actions":["create","edit","delete","approve"],"constraints":{}},{"capability":"ap.purchase_orders","actions":["create","edit","delete","approve"],"constraints":{}},{"capability":"ap.vendor_credits","actions":["create","approve"],"constraints":{}},{"capability":"ar.collections","actions":["edit","release"],"constraints":{}},{"capability":"ar.credit_memos","actions":["create","approve","post"],"constraints":{}},{"capability":"ar.deposits","actions":["create","post"],"constraints":{}},{"capability":"ar.estimates","actions":["create","edit","delete","release"],"constraints":{}},{"capability":"ar.invoices","actions":["create","edit","approve","post","release"],"constraints":{}},{"capability":"ar.recurring","actions":["create","edit","delete"],"constraints":{}},{"capability":"ar.statements","actions":["release"],"constraints":{}},{"capability":"ar.write_offs","actions":["create","approve","post"],"constraints":{}},{"capability":"bank.reconciliations","actions":["create","edit","approve"],"constraints":{}},{"capability":"bank.rules","actions":["create","edit","delete"],"constraints":{}},{"capability":"bank.statements","actions":["create"],"constraints":{}},{"capability":"bank.transactions","actions":["edit","approve"],"constraints":{}},{"capability":"cards.transactions","actions":["edit","approve"],"constraints":{}},{"capability":"cash.forecast","actions":["create","edit"],"constraints":{}},{"capability":"cash.obligations","actions":["create","edit"],"constraints":{}},{"capability":"close.checklist","actions":["edit","approve"],"constraints":{}},{"capability":"ctl.compliance","actions":["edit","approve"],"constraints":{}},{"capability":"ctl.exceptions","actions":["edit"],"constraints":{}},{"capability":"ctl.pbc","actions":["create","edit","approve"],"constraints":{}},{"capability":"ctl.vendor_compliance","actions":["edit","approve"],"constraints":{}},{"capability":"exp.receipts","actions":["create","edit","approve"],"constraints":{}},{"capability":"fa.assets","actions":["create","edit","post"],"constraints":{}},{"capability":"fa.leases","actions":["create","edit","post"],"constraints":{}},{"capability":"fa.prepaids","actions":["create","edit","post"],"constraints":{}},{"capability":"fpa.budgets","actions":["export"],"constraints":{}},{"capability":"fpa.profitability","actions":["export"],"constraints":{}},{"capability":"gl.accounts","actions":["create","approve"],"constraints":{}},{"capability":"gl.intercompany","actions":["create","edit","post"],"constraints":{}},{"capability":"gl.internal_invoices","actions":["create","edit","release"],"constraints":{}},{"capability":"gl.journal_entries","actions":["create","edit","delete","post"],"constraints":{}},{"capability":"gl.periods","actions":["edit","approve"],"constraints":{}},{"capability":"gl.recurring_entries","actions":["create","edit","post"],"constraints":{}},{"capability":"jobs.change_orders","actions":["create"],"constraints":{}},{"capability":"jobs.jobs","actions":["create","edit"],"constraints":{}},{"capability":"jobs.wip","actions":["edit"],"constraints":{}},{"capability":"mdm.customers","actions":["create","edit"],"constraints":{}},{"capability":"mdm.vendors","actions":["create","edit"],"constraints":{}},{"capability":"onb.conversion","actions":["approve","post"],"constraints":{}},{"capability":"onb.imports","actions":["create","post"],"constraints":{}},{"capability":"pay.batches","actions":["create","edit","approve","release"],"constraints":{}},{"capability":"pay.checks","actions":["create","edit"],"constraints":{}},{"capability":"pay.customer_payments","actions":["create","edit","post"],"constraints":{}},{"capability":"pay.provider_connections","actions":["view","configure"],"constraints":{}},{"capability":"pay.refunds","actions":["approve","release"],"constraints":{}},{"capability":"pay.vendor_bank_details","actions":["edit"],"constraints":{}},{"capability":"payroll.employees","actions":["edit"],"constraints":{}},{"capability":"payroll.register","actions":["create","post"],"constraints":{}},{"capability":"payroll.runs","actions":["create","edit","approve","release"],"constraints":{}},{"capability":"reports.saved_views","actions":["create","edit","delete"],"constraints":{}},{"capability":"revrec.methods","actions":["edit"],"constraints":{}},{"capability":"revrec.runs","actions":["create","post"],"constraints":{}}]},
  {"key":"legacy_controller_release","grants":[{"capability":"pay.batches","actions":["release"],"constraints":{}},{"capability":"pay.refunds","actions":["release"],"constraints":{}},{"capability":"payroll.runs","actions":["release"],"constraints":{}}]}
]$seed$::jsonb, 'MeritBooks correction (migration 168): AR refund approval / release');
-- END GENERATED permission_sets_168

-- Run for every tenant already provisioned (158–161 are live). Access-log attribution:
-- source 'backfill' (166), transaction-local.
do $$
declare o record; v_total int := 0;
begin
  if to_regprocedure('core.access_set_context(uuid, text, text, text, text)') is not null then
    perform core.access_set_context(null, 'backfill',
      'MeritBooks correction (migration 168): keeps today''s money approval on AR refunds', null, 'migration:168');
  end if;
  for o in
    select distinct org_id from core.role_definitions where owner_level = 'tenant' and legacy_role_key is not null
  loop
    v_total := v_total + core.rbac_apply_legacy_corrections(o.org_id, '168');
  end loop;
  raise notice 'migration 168: % imported roles / legacy sets corrected', v_total;
end $$;

-- End migration 168.

-- Wave-2 integration: re-apply client-scope RLS (163) and the column masks (167) so
-- the policies / grants above compose with them.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
do $$ begin
  if to_regprocedure('core.apply_field_column_masks()') is not null then
    perform core.apply_field_column_masks();
  end if;
end $$;
