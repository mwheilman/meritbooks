-- ============================================================================
-- 1110 · Merit Projects — Wave 0a access foundation: roles, job access, money visibility
--
-- Spec: docs/projects/WAVE0-ACCESS-FOUNDATION-SPEC.md (§2, §2.4, §3, §6).
-- Code source of truth: packages/projects-access (capabilities.ts, roles.ts); the GENERATED
-- blocks below are written by packages/projects-access/scripts/generate-seed.ts and a guard
-- test (packages/projects-access/test/registry.test.ts) fails when DB ≠ code.
--
-- Plugs into Books RBAC v2 (157–167). No second permission system: authority is still
-- core.access_assignments (membership × company scope × role / permission set).
--
-- What this migration does
--   A. core.capabilities_module_chk gains 'projects'. core.rbac_mirror_capabilities now
--      deprecates only keys of the MODULES PRESENT IN ITS INPUT (a Books re-mirror never
--      deprecates projects.*, and vice versa). For a Books-only input the behavior is
--      identical to 157 (every active key then lives in books/core/platform). The one edge
--      that changes: an EMPTY input used to deprecate everything; it now deprecates nothing.
--   B. 20 projects.* capabilities (GENERATED).
--   C. 10 persona platform role templates + 2 platform permission sets (GENERATED), seeded
--      through core.rbac_seed_platform_roles / core.rbac_seed_platform_permission_sets
--      (158 / 159), cloned into every tenant by pm.access_provision_tenant (same row shape
--      as core.rbac_import_tenant_roles, so a later Books provision run skips them).
--        projects_payroll_admin    labor_rates:view, time:view+approve (spec §2.2)
--        projects_legacy_all_jobs  jobs_all, store, leads, customers, dispatch — DEPLOY BACKFILL ONLY (deviation 1)
--   D. pm.job_members + pm.v_job_team + pm.job_team_upsert / pm.job_team_remove (§2.4).
--   E. Access helpers (STABLE, SECURITY DEFINER, search_path pm, core, public):
--        pm.my_access(), pm.my_location_ids(cap, action), pm.my_job_ids(),
--        pm.my_money_job_ids() [+ (money_cap) overload], pm.can(cap, action, location),
--        and the policy building blocks pm.my_job_ids_with(cap, action), *_any, pm.can_any,
--        pm.my_member_location_ids, pm.is_projects_member, pm.my_employee_ids, pm.my_crew_ids.
--      Policies call them only as UNCORRELATED subqueries — `col in (select pm.f(...))` /
--      `(select pm.can(...))` — so each is evaluated once per statement (hashed subplan /
--      InitPlan), never per row.
--   F. Policy classes for EVERY base table in schema pm (registry pm.access_table_classes;
--      a guard test fails for any unclassified table, and pm.access_apply_policies() raises).
--   G. Money-column masking (registry pm.access_masked_columns) + masked views.
--   H. pm.can() guards injected at the top of money-writing definer RPCs (registry
--      pm.access_rpc_guards).
--   I. Backfill (idempotent) + new-owner provisioning trigger. Nobody is locked out.
--
-- POLICY STRATEGY — restrictive policies, existing policies untouched.
--   Every classified table gets up to four RESTRICTIVE policies `pm_access_select|insert|
--   update|delete` TO authenticated. Postgres ANDs restrictive policies with the existing
--   permissive ones, so the org_isolation / org_select / state-pin policies from 1100–1109
--   (org_id = public.get_org_id(), "only DRAFT rows are client-writable", …) keep working
--   exactly as before and the class rule can only NARROW. Replacing the permissive policies
--   instead would have meant re-stating ~30 hand-written state pins (and drifting from them).
--   Restrictive policies never widen: a table with no permissive policy for a command stays
--   closed. service_role bypasses RLS (hosted Supabase); definer functions run as the table
--   owner and bypass RLS by design (they carry their own guards — section H).
--
-- CLASSES (spec §3)
--   J job-scoped     job_id in (select pm.my_job_ids())             (optionally ∩ a cap)
--   M money job      job_id in (select pm.my_money_job_ids(<money cap>))
--   C company        location_id in (select pm.my_location_ids_any(<caps>, 'view'))
--   S settings       read: any Projects member of the company; write: projects.settings:configure
--                    (or the table's own write cap, e.g. production for routings)
--   P personal       own rows (employee / user) or the approving capability
--   O org config     unchanged org isolation; writes need projects.settings:configure
--   Child tables (no job_id / location_id) inherit their parent's class through an explicit
--   `fk in (select id from pm.<parent> where <parent predicate>)` subquery.
--   Writes: WITH CHECK mirrors the read predicate plus <write cap>:<create|edit|delete>.
--   111 tables classified (107 from 1100–1109 + job_members + the 3 registries):
--     C 33 · J 25 · M 25 · S 14 · O 11 · P 3  (select class, count(*) from pm.access_table_classes group by 1).
--   time_entries (P): own rows, time:approve on the job, or time:view + jobs_all:view at the
--   job's company (office / accounting see company time). Approval stays job-scoped (reach), so
--   an own-jobs approver (PM / supervisor) sees their jobs' time, not the whole company's.
--   85 money-writing definer RPCs guarded (pm.access_rpc_guards: billing, draws, commitments,
--   change orders, contract / progress, estimates, allowances / selections, time approval,
--   labor rates, service agreements, dealer deals / units / parts / rentals / warranty, samples).
--
-- MASKED VIEWS (definer + security_barrier — see deviation 2). Column SELECT on the masked
-- base columns is revoked from authenticated; the views null them unless the money capability
-- holds for that row's job / company:
--   pm.v_time_entries_masked       cost_rate_cents (labor_rates), bill_rate_cents (contract_value)
--   pm.v_estimates_masked          cost_total_cents (financials on the job, or the estimate's author)
--   pm.v_estimate_lines_masked     unit_cost_cents, cost_cents, ext._labor (same rule)
--   pm.v_work_order_lines_masked   unit_cost_cents (financials)
--   pm.v_tasks_masked              billing_amount_cents (contract_value)
--   pm.v_wbs_nodes_masked          billing_amount_cents (contract_value)
--   pm.v_units_masked              contract_price_cents, lender_release_price_cents (contract_value)
--   pm.v_work_centers_masked       rate_cents (financials at the company)
--   pm.v_change_orders_masked      amount_cents (contract_value), cost_impact_cents (financials)
--   pm.v_price_book_items_masked, v_parts_masked, v_assets_masked, v_parts_ticket_lines_masked,
--   v_parts_order_lines_masked, v_dealer_deals_masked, v_dealer_deal_lines_masked,
--   v_dealer_fi_products_masked, v_dealer_trades_masked, v_dealer_quotes_masked,
--   v_selections_masked, v_selection_options_masked, v_procurement_items_masked (security review M2)
--   pm.v_core_jobs_masked, v_core_customers_masked, v_core_vendors_masked (core masters, H1)
-- Masking and the class WHERE apply when the statement runs as a member role (authenticated /
-- anon). Definer code (current_user = owner) and service_role read base values, so money
-- computations inside definer RPCs (e.g. v_job_money in pm.emit_job_progress) are never masked.
-- Also: pm.v_company_team (Team page: company members, names, Projects role per company;
-- rows only where the caller holds projects.team:view) and pm.v_job_team (§2.4).
-- Invoker-read audit (every masked column vs pm/core/public views, invoker functions, triggers,
-- RLS policies): only pm.v_job_money read one as the caller (fixed above); time_entries'
-- draft_insert policy names cost_rate / bill_rate (policy quals need no column privilege —
-- tested); tg_estimate_line_guard reads NEW only.
--
-- SECURITY REVIEW HARDENING (2026-10-22)
--   H1 Projects-only seats (Projects grants, no Books / Core / Platform grant) get a RESTRICTIVE
--      select policy pm_projects_seat_narrow on core.jobs / core.customers / core.vendors /
--      core.events: rows only where they hold projects.contract_value or projects.financials
--      (or settings:configure). Every other seat is unchanged; no core column is revoked. The
--      Projects app reads these masters through pm.v_core_jobs_masked / v_core_customers_masked /
--      v_core_vendors_masked (rows: reachable or company-wide work; money columns masked).
--      Invoker pm views and functions that read core.jobs / customers / vendors (or a masked pm
--      column) as the caller are re-pointed at the masked views by pm.access_rewrite_views /
--      pm.access_apply_function_rewrites (v_project_list, v_job_money, v_billing_queue,
--      v_commitment_status, v_job_financials, v_parts_on_hand, v_dealer_unit_inventory,
--      v_selection_status, v_procurement_status, the draw / KPI views, cost_code_usable, …).
--   H2 Every member-executable SECURITY DEFINER function in pm is guarded (pm.access_rpc_guards,
--      134 functions) or allowlisted with a reason (pm.access_rpc_allowlist: the caller's own
--      access helpers, self-checking team RPCs, trigger-only row readers). pm.access_unguarded_rpcs()
--      must be empty (guard test). Nothing in pm is executable by anon / PUBLIC.
--   M1 Definer views (masked views, v_job_team, v_company_team) grant members SELECT only.
--   M2 More masks: price-book / part / unit cost and floor payoff, parts ticket / order line cost,
--      deal line / F&I cost, trade ACV, finance reserve / subvention, deal + quote documents
--      (gross keys stripped), selections and selection-option / procurement money. Invoker
--      triggers that copy those costs read them through trigger-only definer row readers
--      (pm.access_unmasked_*); pm.dealer_deal_totals answers members through a wrapper that
--      strips cost / gross without projects.financials.
--   Projects-only seat = core.memberships.projects_only (opt-in flag; pm.set_projects_only /
--      service_role only; never owner / admin seats; the backfill flags nobody). Flagged seats see
--      core.jobs rows only for their money jobs, and only their own memberships / assignments rows
--      unless they hold projects.team:view.
--   Books data: core.is_projects_only_seat() (one STABLE definer helper) + a RESTRICTIVE
--      `projects_only_seat_deny` policy (all commands, to authenticated) on every RLS-enabled
--      table in public and core: false for a Projects-only seat, true for everyone else (Books
--      staff, legacy members, service paths unaffected). Justified exceptions live in
--      pm.access_seat_exceptions (identity / RBAC catalog exempt; the four narrowed masters
--      exempt; public.documents and public.ai_decisions narrowed to Projects rows).
--      BOOKS MIGRATIONS THAT CREATE A TABLE MUST ADD IT:
--        select core.apply_projects_only_seat_deny('public.<new_table>');
--      The guard test (pm.access_seat_unprotected_tables() must be empty) fails otherwise.
--   Low: the automatic Projects owner ends when the seat is demoted / deactivated; access_is_service
--      trusts only service_role or the postgres / supabase_admin login without a JWT subject;
--      v_company_team lists only members holding a Projects grant at that company; the client-
--      staff backfill reads active assignments only.
--
-- DEVIATIONS FROM THE SPEC (safest option chosen; reported to the lead)
--   1. Backfill of non-admin members: the spec says "projects_pm on all_clients (today
--      everyone sees everything)". projects_pm is an OWN-jobs role, so on its own it would
--      lock existing members out of every job they are not on (acceptance #7), and it has no
--      store / leads / dispatch-edit. They also get the permission set projects_legacy_all_jobs
--      (jobs_all:view; store, leads, customers, dispatch operational actions; all_clients;
--      source backfill) — the Books legacy_full_books pattern — which keeps today's reach. It
--      grants no approvals, posting, pay rates or settings. Owners narrow by removing it.
--   2. Masked views are SECURITY DEFINER views with security_barrier and the table's class
--      predicate + org filter in their WHERE, not security-invoker views: a security-invoker
--      view cannot read a column the caller has no SELECT privilege on, so "revoke the column
--      + invoker view" is not implementable. The WHERE is generated by the same builder as
--      the RLS policies (pm.access_pred), so the two cannot drift.
--   3. pm.projects has no pm_membership_id. "Own job" uses pm.projects.pm_user_id /
--      super_user_id (Clerk ids), pm.job_members, task / punch assignees, dispatch
--      assignments (employee or crew), and work-order operations (employee).
--   4. (Superseded by the security review: those columns are now masked; see M2 above.)
--   5. change_orders is class M (rows need contract_value) but INSERT only needs reach +
--      change_orders:create, so a Supervisor can file a CO without a price (spec §2.1), and the
--      author can read their own CO rows back; amount_cents / cost_impact_cents are masked
--      (pm.v_change_orders_masked). pm.v_job_money is re-created here reading that masked view
--      (same columns and math) because it read those columns as the caller.
--   6. RPC guards are injected into the existing function bodies (pg_get_functiondef → insert
--      after the outer BEGIN, marker `pm_access_guard`) instead of copying ~85 bodies here.
--      The guard runs once per request (transaction-local flag pm.access_entry): nested
--      definer calls (e.g. accept_estimate → set_contract) are authorized by the entry RPC.
--   7. New memberships after this migration: owners/admins get projects_owner automatically
--      (trigger); everyone else gets NO Projects role until an owner assigns one (the
--      spec's backfill is a deploy-time measure).
--
-- APPLY RULE: after the 1100–1109 set. Re-applying 1100 re-baselines pm grants (revokes
-- every member grant and function EXECUTE) — re-apply 1110 after it. Idempotent: safe twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. Capability registry: 'projects' module + module-scoped deprecation
-- ----------------------------------------------------------------------------
alter table core.capabilities drop constraint if exists capabilities_module_chk;
alter table core.capabilities add constraint capabilities_module_chk
  check (module in ('books', 'core', 'platform', 'projects'));

create or replace function core.rbac_mirror_capabilities(p_caps jsonb) returns integer
  language plpgsql as
$$
declare n integer := 0; r jsonb;
begin
  for r in select * from jsonb_array_elements(p_caps) loop
    insert into core.capabilities as c
      (key, module, domain, actions, label, description, tags, risk_tier, platform_only,
       field_classes, supports_constraints, introduced_in, status)
    values (
      r->>'key', r->>'module', r->>'domain',
      array(select jsonb_array_elements_text(r->'actions')),
      r->>'label', coalesce(r->>'description', ''),
      array(select jsonb_array_elements_text(r->'tags')),
      r->>'risk_tier', (r->>'platform_only')::boolean,
      array(select jsonb_array_elements_text(r->'field_classes')),
      array(select jsonb_array_elements_text(r->'supports_constraints')),
      r->>'introduced_in', coalesce(r->>'status', 'active'))
    on conflict (key) do update set
      module = excluded.module, domain = excluded.domain, actions = excluded.actions,
      label = excluded.label, description = excluded.description, tags = excluded.tags,
      risk_tier = excluded.risk_tier, platform_only = excluded.platform_only,
      field_classes = excluded.field_classes, supports_constraints = excluded.supports_constraints,
      introduced_in = coalesce(c.introduced_in, excluded.introduced_in),
      status = excluded.status, updated_at = now()
    where (c.module, c.domain, c.actions, c.label, c.description, c.tags, c.risk_tier,
           c.platform_only, c.field_classes, c.supports_constraints, c.status)
      is distinct from
          (excluded.module, excluded.domain, excluded.actions, excluded.label, excluded.description,
           excluded.tags, excluded.risk_tier, excluded.platform_only, excluded.field_classes,
           excluded.supports_constraints, excluded.status);
    n := n + 1;
  end loop;
  -- Keys removed from code are deprecated, never deleted (grants may reference them) — but
  -- only within the modules this input describes (1110: Books and Projects mirror separately).
  update core.capabilities set status = 'deprecated', updated_at = now()
   where status = 'active'
     and module in (select distinct e->>'module' from jsonb_array_elements(p_caps) e)
     and key not in (select e->>'key' from jsonb_array_elements(p_caps) e);
  return n;
end
$$;
revoke all on function core.rbac_mirror_capabilities(jsonb) from public, anon, authenticated;
grant execute on function core.rbac_mirror_capabilities(jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B. Projects capabilities
-- ----------------------------------------------------------------------------
-- BEGIN GENERATED projects_capabilities (packages/projects-access/scripts/generate-seed.ts — do not edit by hand)
select core.rbac_mirror_capabilities($seed$[
  {"key":"projects.jobs","module":"projects","domain":"Jobs","actions":["view","create","edit","delete"],"label":"Jobs","description":"Jobs, tasks, schedule, logs, photos and punch on the jobs the person can reach.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.jobs_all","module":"projects","domain":"Jobs","actions":["view"],"label":"All jobs","description":"Reach every job in the company, not only the jobs the person is on.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.financials","module":"projects","domain":"Money","actions":["view","edit","export"],"label":"Job financials","description":"Cost, budget dollars, committed, actual, margin, WIP, job cost and estimate cost lines.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.contract_value","module":"projects","domain":"Money","actions":["view"],"label":"Contract value","description":"Contract and sell price, change-order and invoice amounts.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.labor_rates","module":"projects","domain":"Money","actions":["view","edit"],"label":"Labor rates","description":"Individual pay rates and burden.","tags":["sensitive"],"risk_tier":"elevated","platform_only":false,"field_classes":["comp"],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.leads","module":"projects","domain":"Sales","actions":["view","create","edit","delete"],"label":"Leads","description":"Leads, pipeline and activities.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.customers","module":"projects","domain":"Sales","actions":["view","create","edit"],"label":"Customers","description":"Customer and site contact information (writes still go through definer functions).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.estimates","module":"projects","domain":"Sales","actions":["view","create","edit","approve"],"label":"Estimates","description":"Estimates, quotes and proposals; approve = release below the margin floor.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.change_orders","module":"projects","domain":"Money","actions":["view","create","edit","approve"],"label":"Change orders","description":"Change orders (field roles create without a price — an app rule).","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.commitments","module":"projects","domain":"Money","actions":["view","create","edit","approve"],"label":"Commitments","description":"Purchase orders and subcontracts.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.billing","module":"projects","domain":"Money","actions":["view","create","edit","approve","post"],"label":"Billing","description":"Billing requests, pay applications and draws; post = send to Books.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.time","module":"projects","domain":"Field","actions":["view","create","edit","approve"],"label":"Time","description":"Time entries (own entries need create; approve = crew / timesheet approval).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.dispatch","module":"projects","domain":"Field","actions":["view","edit"],"label":"Dispatch","description":"Dispatch, crew and install boards.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.documents","module":"projects","domain":"Field","actions":["view","create","edit","delete"],"label":"Documents","description":"Files, photos, drawings and field logs.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.selections","module":"projects","domain":"Field","actions":["view","create","edit","approve"],"label":"Selections","description":"Selections and allowances.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.production","module":"projects","domain":"Field","actions":["view","create","edit"],"label":"Production","description":"Work orders and the production board.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.store","module":"projects","domain":"Store","actions":["view","create","edit","approve"],"label":"Dealer store","description":"Units, deals, parts counter, rentals and warranty (deal gross needs Job financials).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.reports","module":"projects","domain":"Admin","actions":["view","export"],"label":"Reports","description":"Dashboards and reports.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.settings","module":"projects","domain":"Admin","actions":["view","configure"],"label":"Projects settings","description":"Packs, job types, stages, cost codes, templates and labor settings.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"},
  {"key":"projects.team","module":"projects","domain":"Admin","actions":["view","edit"],"label":"Job teams","description":"Job-team assignment and Projects role assignment requests.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"projects-wave0a","status":"active"}
]$seed$::jsonb);
-- END GENERATED projects_capabilities

-- ----------------------------------------------------------------------------
-- C. Persona role templates + permission sets (platform), cloned per tenant
-- ----------------------------------------------------------------------------
-- BEGIN GENERATED projects_role_templates (packages/projects-access/scripts/generate-seed.ts — do not edit by hand)
select core.rbac_seed_platform_roles($seed$[
  {"key":"projects_owner","name":"Projects owner","description":"Every job and all money in the companies assigned, including pay rates, approvals, export and settings.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"projects.billing","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"projects.change_orders","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.financials","actions":["view","edit","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.labor_rates","actions":["view","edit"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.reports","actions":["view","export"],"constraints":{}},{"capability":"projects.selections","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.settings","actions":["view","configure"],"constraints":{}},{"capability":"projects.store","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.team","actions":["view","edit"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_gm","name":"General manager","description":"Every job and all job money; runs operations and approvals. Sees but does not edit pay rates; no settings changes.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"projects.billing","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"projects.change_orders","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.financials","actions":["view","edit","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.labor_rates","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.reports","actions":["view","export"],"constraints":{}},{"capability":"projects.selections","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.settings","actions":["view"],"constraints":{}},{"capability":"projects.store","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.team","actions":["view","edit"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_office_manager","name":"Office manager","description":"Every job and customer; leads, billing requests, dispatch and documents. Contract values only — no cost or margin.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.billing","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.change_orders","actions":["view"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view"],"constraints":{}},{"capability":"projects.reports","actions":["view"],"constraints":{}},{"capability":"projects.selections","actions":["view"],"constraints":{}},{"capability":"projects.settings","actions":["view"],"constraints":{}},{"capability":"projects.store","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view"],"constraints":{}}]},
  {"key":"projects_project_accountant","name":"Project accountant","description":"Every job and all job money; billing end to end (approve, send to Books), commitment approval, report export.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.billing","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"projects.change_orders","actions":["view"],"constraints":{}},{"capability":"projects.commitments","actions":["view","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view"],"constraints":{}},{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.estimates","actions":["view"],"constraints":{}},{"capability":"projects.financials","actions":["view","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.reports","actions":["view","export"],"constraints":{}},{"capability":"projects.settings","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view"],"constraints":{}}]},
  {"key":"projects_dispatcher","name":"Dispatcher","description":"Every job and customer; leads, scheduling and dispatch. No job money (price-book sell prices only).","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view"],"constraints":{}}]},
  {"key":"projects_purchasing","name":"Purchasing","description":"Every job; writes and approves purchase orders and subcontracts. Sees job cost, not contract value.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.financials","actions":["view"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.production","actions":["view"],"constraints":{}},{"capability":"projects.store","actions":["view"],"constraints":{}}]},
  {"key":"projects_pm","name":"Project manager","description":"Their own jobs, with full money on those jobs (no individual pay rates); approves change orders, commitments, time and selections.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.billing","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.change_orders","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view"],"constraints":{}},{"capability":"projects.dispatch","actions":["view"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.financials","actions":["view","edit","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.reports","actions":["view"],"constraints":{}},{"capability":"projects.selections","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.team","actions":["view","edit"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_supervisor","name":"Supervisor","description":"Their own jobs: schedule, logs, crew time approval and change-order requests. Hours and quantities only — no dollars.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.change_orders","actions":["view","create"],"constraints":{}},{"capability":"projects.dispatch","actions":["view"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.jobs","actions":["view","edit"],"constraints":{}},{"capability":"projects.production","actions":["view","edit"],"constraints":{}},{"capability":"projects.selections","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_labor","name":"Crew","description":"The jobs they are assigned to: today's work, their own time, photos and field logs. No dollars and nobody's pay.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"any_grantor","grants":[{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit"],"constraints":{}}]},
  {"key":"projects_sales","name":"Sales","description":"All leads; customers and estimates end to end; their own jobs. Contract values; cost only on the estimates they wrote.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.reports","actions":["view"],"constraints":{}},{"capability":"projects.selections","actions":["view"],"constraints":{}}]}
]$seed$::jsonb);
-- END GENERATED projects_role_templates

-- BEGIN GENERATED projects_permission_sets (packages/projects-access/scripts/generate-seed.ts — do not edit by hand)
select core.rbac_seed_platform_permission_sets($seed$[
  {"key":"projects_payroll_admin","name":"Projects payroll admin","description":"See individual pay rates and approve timesheets.","audience":"internal_staff","field_policy":{"comp":"visible"},"max_assignment_days":null,"is_envelope":false,"is_sealed":false,"grants":[{"capability":"projects.labor_rates","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view","approve"],"constraints":{}}]},
  {"key":"projects_legacy_all_jobs","name":"Legacy all jobs (Projects)","description":"Reach every job, the store, leads and dispatch, as before roles existed. Added by the deploy backfill — review and remove.","audience":"internal_staff","field_policy":{},"max_assignment_days":null,"is_envelope":false,"is_sealed":false,"grants":[{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.store","actions":["view","create","edit"],"constraints":{}}]}
]$seed$::jsonb);
-- END GENERATED projects_permission_sets

-- BEGIN GENERATED projects_persona_rank (packages/projects-access/scripts/generate-seed.ts — do not edit by hand)
create or replace function pm.access_persona_rank(p_key text) returns integer
language sql immutable
as $$
  select case p_key
    when 'projects_owner' then 100
    when 'projects_gm' then 90
    when 'projects_office_manager' then 65
    when 'projects_project_accountant' then 70
    when 'projects_dispatcher' then 50
    when 'projects_purchasing' then 55
    when 'projects_pm' then 60
    when 'projects_supervisor' then 30
    when 'projects_labor' then 10
    when 'projects_sales' then 40
    else 0 end
$$;
-- END GENERATED projects_persona_rank

-- Clone every active Projects platform template (role + permission set) into a tenant as a
-- standard tenant role / set, exactly like core.rbac_import_tenant_roles step (b) does for
-- Books templates (same columns, same upstream / home template links). Idempotent.
create or replace function pm.access_provision_tenant(p_org uuid) returns integer
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t record; v_id uuid; n int := 0;
begin
  if p_org is null or not exists (select 1 from core.organizations o where o.id = p_org) then return 0; end if;
  for t in
    select rd.* from core.role_definitions rd
     where rd.owner_level = 'platform' and rd.status = 'active' and rd.key like 'projects\_%'
     order by rd.key
  loop
    continue when exists (select 1 from core.role_definitions x
                           where x.owner_level = 'tenant' and x.org_id = p_org and x.key = t.key);
    insert into core.role_definitions
      (owner_level, org_id, key, name, description, kind, audience, upstream_template_id, upstream_version,
       home_template_id, default_scope, field_policy, auth_policy, max_assignment_days, assignable_band, status)
    values ('tenant', p_org, t.key, t.name, t.description, 'standard', t.audience, t.id, t.current_version,
            t.id, t.default_scope, t.field_policy, t.auth_policy, t.max_assignment_days, t.assignable_band, 'active')
    returning id into v_id;
    perform core.rbac_publish_role_grants(v_id, core.rbac_role_current_grants(t.id),
      'Cloned from the Merit Projects standard role');
    n := n + 1;
  end loop;
  for t in
    select ps.* from core.permission_sets ps
     where ps.owner_level = 'platform' and ps.status = 'active' and ps.key like 'projects\_%'
     order by ps.key
  loop
    continue when exists (select 1 from core.permission_sets x
                           where x.owner_level = 'tenant' and x.org_id = p_org and x.key = t.key);
    insert into core.permission_sets
      (owner_level, org_id, key, name, description, kind, audience, upstream_template_id, upstream_version,
       field_policy, auth_policy, max_assignment_days, assignable_band, status, is_envelope, is_sealed)
    values ('tenant', p_org, t.key, t.name, t.description, 'standard', t.audience, t.id, t.current_version,
            t.field_policy, t.auth_policy, t.max_assignment_days,
            case when t.key = 'projects_legacy_all_jobs' then 'tenant_admin_only' else t.assignable_band end,
            'active', t.is_envelope, t.is_sealed)
    returning id into v_id;
    perform core.rbac_publish_set_grants(v_id, core.rbac_set_current_grants(t.id),
      'Cloned from the Merit Projects standard permission set');
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
declare o record;
begin
  for o in select id from core.organizations loop
    perform pm.access_provision_tenant(o.id);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- D1. Job teams
-- ----------------------------------------------------------------------------
create table if not exists pm.job_members (
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  membership_id uuid not null references core.memberships(id) on delete cascade,
  slot          text not null,
  added_by      text,
  added_at      timestamptz not null default now(),
  primary key (org_id, job_id, membership_id),
  constraint job_members_job_fk foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade,
  constraint job_members_slot_chk check (slot in ('pm','apm','superintendent','foreman','lead','crew','estimator',
                                                  'sales','coordinator','accountant','designer','other'))
);
create index if not exists job_members_membership_idx on pm.job_members (membership_id, job_id);
comment on table pm.job_members is
  '1110: job team (spec §2). Being on the team makes the job one of the person''s own jobs. Written only by pm.job_team_upsert / pm.job_team_remove.';

-- The membership must be a seat in the row's org (cross-org team rows are un-insertable).
create or replace function pm.tg_job_member_org() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from core.memberships m where m.id = new.membership_id and m.org_id = new.org_id) then
    raise exception 'PM_FORBIDDEN: membership % is not a seat in org %', new.membership_id, new.org_id using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_job_member_org on pm.job_members;
create trigger trg_job_member_org before insert or update on pm.job_members
  for each row execute function pm.tg_job_member_org();

alter table pm.job_members enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'job_members' and policyname = 'org_isolation') then
    create policy org_isolation on pm.job_members for all
      using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- E. Access helpers (the DB side of the §2.4 contract)
-- ----------------------------------------------------------------------------

-- Trusted server context: the service role (role GUC or JWT role claim), or an explicitly listed
-- platform login (postgres / supabase_admin: migrations, cron, SQL editor) that has not SET ROLE
-- to a member role and carries no JWT subject. Everything else is a member.
create or replace function pm.access_is_service() returns boolean
language sql stable
set search_path = pm, core, public
as $$
  select coalesce(current_setting('role', true), '') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
      or (session_user::text in ('postgres', 'supabase_admin')
          and coalesce(current_setting('role', true), 'none') in ('none', 'postgres', 'supabase_admin')
          and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '') = '')
$$;

-- One row per (company, projects capability, granting role) the caller holds through active,
-- in-effect assignments. all_clients → every company of the org. Mirrors the decision rules of
-- core.membership_has_capability (published versions only, read_only / muted narrow their own
-- assignment, H3/H5 ceilings, client roles stay inside the client envelope, every held action
-- implies view). role_key = the platform template key for cloned roles / sets.
create or replace function pm.my_access()
returns table (location_id uuid, capability text, actions text[], role_key text, role_name text)
language sql stable security definer
set search_path = pm, core, public
as $$
  with me as (
    select ms.id, ms.org_id, ms.audience
      from core.memberships ms
     where ms.id = core.client_scope_caller_membership()
  ), asg as (
    select a.id, a.org_id, a.grant_type, a.role_id, a.permission_set_id, a.scope_type, a.location_id,
           a.client_set_id, a.read_only, a.muted, me.audience as m_audience,
           coalesce(rd.owner_level, ps.owner_level)  as owner_level,
           coalesce(rd.location_id, ps.location_id)  as source_location_id,
           coalesce(rd.audience, ps.audience)        as source_audience,
           coalesce(urd.key, rd.key, ups.key, ps.key) as role_key,
           coalesce(rd.name, ps.name)                as role_name
      from me
      join core.access_assignments a on a.membership_id = me.id and a.org_id = me.org_id
      left join core.role_definitions rd  on a.grant_type = 'role' and rd.id = a.role_id
      left join core.role_definitions urd on urd.id = rd.upstream_template_id and urd.owner_level = 'platform'
      left join core.permission_sets ps   on a.grant_type = 'permission_set' and ps.id = a.permission_set_id
      left join core.permission_sets ups  on ups.id = ps.upstream_template_id and ups.owner_level = 'platform'
     where a.status = 'active'
       and a.effective_from <= now()
       and (a.effective_to is null or a.effective_to > now())
       and a.scope_type in ('all_clients', 'client', 'client_set')
  ), locs as (
    select asg.id as asg_id, l.id as location_id
      from asg join core.locations l on l.org_id = asg.org_id
     where asg.scope_type = 'all_clients'
    union
    select asg.id, l.id
      from asg join core.locations l on l.id = asg.location_id and l.org_id = asg.org_id
     where asg.scope_type = 'client'
    union
    select asg.id, l.id
      from asg
      join core.client_set_members csm on csm.set_id = asg.client_set_id
      join core.locations l on l.id = csm.location_id and l.org_id = asg.org_id
     where asg.scope_type = 'client_set'
  ), grants as (
    select asg.id as asg_id, g.capability, g.actions
      from asg
      join core.role_versions v on asg.grant_type = 'role' and v.role_id = asg.role_id and v.state = 'published'
      join core.role_grants g on g.role_version_id = v.id
     where g.capability like 'projects.%'
    union all
    select asg.id, g.capability, g.actions
      from asg
      join core.permission_set_versions v on asg.grant_type = 'permission_set'
                                         and v.permission_set_id = asg.permission_set_id and v.state = 'published'
      join core.permission_set_grants g on g.permission_set_version_id = v.id
     where g.capability like 'projects.%'
  ), held as (
    select asg.id as asg_id, asg.role_key, asg.role_name, gr.capability, h.act
      from asg
      join grants gr on gr.asg_id = asg.id
      join core.capabilities c on c.key = gr.capability and c.status = 'active' and c.module = 'projects'
      cross join lateral unnest(gr.actions) as h(act)
     where h.act = any (c.actions)
       and asg.owner_level is not null
       and (asg.owner_level <> 'platform' or 'platform' in (asg.m_audience, asg.source_audience))
       and not (asg.read_only and h.act not in ('view', 'export'))
       and not (coalesce(asg.muted -> gr.capability, '[]'::jsonb) ? h.act)
       and core.rbac_ceiling_allows(gr.capability, h.act, array[asg.m_audience, asg.source_audience])
       and (asg.owner_level <> 'client' or exists (
             select 1
               from core.client_access_policies p
               join core.permission_set_versions ev on ev.permission_set_id = p.envelope_permission_set_id
                                                   and ev.state = 'published'
               join core.permission_set_grants eg on eg.permission_set_version_id = ev.id
                                                 and eg.capability = gr.capability
              where p.org_id = asg.org_id and p.location_id = asg.source_location_id
                and h.act = any (eg.actions)))
  ), agg as (
    select l.location_id, h.capability, h.role_key, h.role_name,
           array_agg(distinct h.act) || array['view']::text[] as acts
      from held h join locs l on l.asg_id = h.asg_id
     group by l.location_id, h.capability, h.role_key, h.role_name
  )
  select a.location_id, a.capability,
         array(select x.a from unnest(core.rbac_actions()) with ordinality as x(a, o)
                where x.a = any (a.acts) order by x.o) as actions,
         a.role_key, a.role_name
    from agg a
$$;
comment on function pm.my_access() is
  '1110 / spec §2.4: the caller''s effective projects.* grants per company (one row per company × capability × granting role).';

create or replace function pm.my_location_ids(p_cap text, p_action text) returns setof uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select l.id from core.locations l where public.get_org_id() is null or l.org_id = public.get_org_id();
    return;
  end if;
  return query select distinct a.location_id from pm.my_access() a
                where a.capability = p_cap and p_action = any (a.actions);
end $$;

create or replace function pm.my_location_ids_any(p_caps text[], p_action text) returns setof uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select l.id from core.locations l where public.get_org_id() is null or l.org_id = public.get_org_id();
    return;
  end if;
  return query select distinct a.location_id from pm.my_access() a
                where a.capability = any (p_caps) and p_action = any (a.actions);
end $$;

-- Companies where the caller holds ANY projects capability ("a member of the company").
create or replace function pm.my_member_location_ids() returns setof uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select l.id from core.locations l where public.get_org_id() is null or l.org_id = public.get_org_id();
    return;
  end if;
  return query select distinct a.location_id from pm.my_access() a;
end $$;

create or replace function pm.can(p_cap text, p_action text, p_location uuid default null) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or exists (select 1 from pm.my_access() a
                  where a.capability = p_cap and p_action = any (a.actions)
                    and (p_location is null or a.location_id = p_location))
$$;
comment on function pm.can(text, text, uuid) is
  '1110 / spec §3: may the caller do cap:action at this company (NULL = at any company)? service_role → true.';

create or replace function pm.can_any(p_caps text[], p_action text) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or exists (select 1 from pm.my_access() a where a.capability = any (p_caps) and p_action = any (a.actions))
$$;

create or replace function pm.is_projects_member() returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service() or exists (select 1 from pm.my_access())
$$;

-- core.employees rows of the caller in the request org (JWT sub = employees.clerk_user_id).
create or replace function pm.my_employee_ids() returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select e.id from core.employees e
   where e.org_id = public.get_org_id()
     and e.clerk_user_id is not null
     and e.clerk_user_id = pm.current_user_id()
$$;

create or replace function pm.my_crew_ids() returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select c.id from pm.crews c
   where c.org_id = public.get_org_id() and c.lead_employee_id in (select pm.my_employee_ids())
  union
  select cm.crew_id from pm.crew_members cm
   where cm.org_id = public.get_org_id() and cm.employee_id in (select pm.my_employee_ids())
$$;

-- Jobs that are the caller's own: job team, PM / super on pm.projects, task or punch assignee,
-- dispatched (as employee or crew), or on a work-order operation.
create or replace function pm.my_own_job_ids() returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  with me as (select public.get_org_id() as org, pm.current_user_id() as uid, core.client_scope_caller_membership() as mid)
  select jm.job_id from pm.job_members jm, me where jm.org_id = me.org and jm.membership_id = me.mid
  union
  select p.job_id from pm.projects p, me
   where p.org_id = me.org and me.uid is not null and (p.pm_user_id = me.uid or p.super_user_id = me.uid)
  union
  select t.job_id from pm.tasks t, me
   where t.org_id = me.org
     and ((me.uid is not null and t.assignee_user_id = me.uid) or t.assignee_employee_id in (select pm.my_employee_ids()))
  union
  select pi.job_id from pm.punch_items pi, me where pi.org_id = me.org and me.uid is not null and pi.assignee_user_id = me.uid
  union
  select d.job_id from pm.dispatch_assignments d, me
   where d.org_id = me.org
     and (d.employee_id in (select pm.my_employee_ids()) or d.crew_id in (select pm.my_crew_ids()))
  union
  select o.job_id from pm.wo_operations o, me where o.org_id = me.org and o.employee_id in (select pm.my_employee_ids())
$$;

create or replace function pm.my_job_ids() returns setof uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select j.id from core.jobs j where public.get_org_id() is null or j.org_id = public.get_org_id();
    return;
  end if;
  return query
    select j.id from core.jobs j
     where j.org_id = public.get_org_id()
       and (j.location_id in (select pm.my_location_ids('projects.jobs_all', 'view'))
            or (j.location_id in (select pm.my_location_ids('projects.jobs', 'view'))
                and j.id in (select pm.my_own_job_ids())));
end $$;
comment on function pm.my_job_ids() is
  '1110 / spec §3: jobs the caller can reach — every job where they hold projects.jobs_all:view, plus own jobs where they hold projects.jobs:view.';

-- Reachable jobs in companies where the caller holds cap:action.
create or replace function pm.my_job_ids_with(p_cap text, p_action text) returns setof uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select j.id from core.jobs j where public.get_org_id() is null or j.org_id = public.get_org_id();
    return;
  end if;
  return query
    select j.id from core.jobs j
     where j.org_id = public.get_org_id()
       and j.id in (select pm.my_job_ids())
       and j.location_id in (select pm.my_location_ids(p_cap, p_action));
end $$;

create or replace function pm.my_job_ids_with_any(p_caps text[], p_action text) returns setof uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select j.id from core.jobs j where public.get_org_id() is null or j.org_id = public.get_org_id();
    return;
  end if;
  return query
    select j.id from core.jobs j
     where j.org_id = public.get_org_id()
       and j.id in (select pm.my_job_ids())
       and j.location_id in (select pm.my_location_ids_any(p_caps, p_action));
end $$;

create or replace function pm.my_money_job_ids() returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.my_job_ids_with('projects.financials', 'view')
$$;
comment on function pm.my_money_job_ids() is
  '1110 / spec §3: reachable jobs in companies where the caller holds projects.financials:view.';

-- Same, for another money capability (projects.contract_value for sell-side rows).
create or replace function pm.my_money_job_ids(p_money_cap text) returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.my_job_ids_with(p_money_cap, 'view')
$$;

-- ----------------------------------------------------------------------------
-- E2. RPC guard helpers (raise PM_FORBIDDEN / 42501). The guard runs once per request:
--     pm.access_guard_enter() returns false for trusted callers and for nested calls.
-- ----------------------------------------------------------------------------
create or replace function pm.access_guard_enter() returns boolean
language plpgsql volatile
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then return false; end if;
  if coalesce(current_setting('pm.access_entry', true), '') = 'on' then return false; end if;
  perform set_config('pm.access_entry', 'on', true);
  return true;
end $$;

create or replace function pm.access_assert_location(p_cap text, p_actions text[], p_location uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare a text;
begin
  if pm.access_is_service() then return; end if;
  if p_location is null or not exists (select 1 from core.locations l where l.id = p_location and l.org_id = public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  foreach a in array p_actions loop
    if not pm.can(p_cap, a, p_location) then
      raise exception 'PM_FORBIDDEN: requires %:% at this company', p_cap, a using errcode = '42501';
    end if;
  end loop;
end $$;

create or replace function pm.access_assert_job(p_cap text, p_actions text[], p_job uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; a text;
begin
  if pm.access_is_service() then return; end if;
  select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = public.get_org_id();
  if v_loc is null then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if not exists (select 1 from pm.my_job_ids() x where x = p_job) then
    raise exception 'PM_FORBIDDEN: job % is not one of the caller''s jobs', p_job using errcode = '42501';
  end if;
  foreach a in array p_actions loop
    if not pm.can(p_cap, a, v_loc) then
      raise exception 'PM_FORBIDDEN: requires %:% on this job', p_cap, a using errcode = '42501';
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- F. Table classes registry + predicate builder + policy installer
-- ----------------------------------------------------------------------------
create table if not exists pm.access_table_classes (
  table_name           text primary key,
  class                text not null,
  scope                text not null,
  read_caps            text[] not null default '{}',
  write_cap            text,
  parent_table         text,
  parent_column        text,
  read_extra           text,   -- SQL template OR-ed into the read predicate (%1$s = column qualifier); P: the whole predicate
  write_extra          text,   -- SQL template OR-ed into the write predicate (%1$s qualifier, %2$s action); P: the whole predicate
  insert_without_money boolean not null default false,
  note                 text,
  constraint access_table_classes_class_chk check (class in ('J','M','C','S','P','O')),
  constraint access_table_classes_scope_chk check (scope in ('job','job_or_location','job_or_org','location','parent','org')),
  constraint access_table_classes_parent_chk check ((scope = 'parent') = (parent_table is not null and parent_column is not null)),
  constraint access_table_classes_p_chk check (class <> 'P' or (read_extra is not null and write_extra is not null)),
  constraint access_table_classes_m_chk check (class <> 'M' or scope = 'parent' or cardinality(read_caps) = 1)
);
comment on table pm.access_table_classes is
  '1110 / spec §3: the access class of every base table in schema pm. A guard test fails for any unclassified table.';

insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  -- job spine (1100)
  ('activity',                'J','job_or_location', '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, 'activity feed; job rows by reach, company rows by jobs:view'),
  ('budget_lines',            'M','parent',          '{}',                         'projects.financials',    'budgets', 'budget_id', null, null, false, null),
  ('budgets',                 'M','job',             '{projects.financials}',      'projects.financials',    null, null, null, null, false, null),
  ('change_orders',           'M','job',             '{projects.contract_value}',  'projects.change_orders', null, null,
     '%1$screated_by = (select pm.current_user_id())', null, true,
     'field roles may INSERT a CO without a price (reach + change_orders:create) and read back their own; amounts masked (pm.v_change_orders_masked)'),
  ('contracts',               'M','job',             '{projects.contract_value}',  null,                     null, null, null, null, false, 'written only by pm.set_contract'),
  ('field_logs',              'J','job',             '{projects.jobs}',            'projects.documents',     null, null, null, null, false, 'crews write logs with documents:create'),
  ('progress_snapshots',      'M','job',             '{projects.financials}',      null,                     null, null, null, null, false, null),
  ('projects',                'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, null),
  ('punch_items',             'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, null),
  ('task_deps',               'J','parent',          '{}',                         'projects.jobs',          'tasks', 'pred_id', null, null, false, null),
  ('tasks',                   'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, 'billing_amount_cents masked (pm.v_tasks_masked)'),
  ('time_entries',            'P','job',             '{projects.time}',            'projects.time',          null, null,
     '(%1$semployee_id in (select pm.my_employee_ids()) or %1$suser_id = (select pm.current_user_id()) or %1$sjob_id in (select pm.my_job_ids_with(''projects.time'', ''approve'')) or (%1$sjob_id in (select pm.my_job_ids_with(''projects.time'', ''view'')) and %1$sjob_id in (select pm.my_job_ids_with(''projects.jobs_all'', ''view''))))',
     '(((%1$semployee_id in (select pm.my_employee_ids()) or %1$suser_id = (select pm.current_user_id())) and %1$sjob_id in (select pm.my_job_ids_with(''projects.time'', ''%2$s''))) or %1$sjob_id in (select pm.my_job_ids_with(''projects.time'', ''approve'')))',
     false, 'own entries, time:approve on the job, or time:view + jobs_all:view at the job''s company; rates masked (pm.v_time_entries_masked)'),
  ('wbs_nodes',               'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, 'billing_amount_cents masked (pm.v_wbs_nodes_masked)'),
  ('document_links',          'J','job_or_org',      '{projects.documents}',       'projects.documents',     null, null, null, null, false, null),
  ('job_members',             'J','job',             '{projects.jobs}',            null,                     null, null, null, null, false, 'written only by pm.job_team_upsert / remove'),
  -- pack + config layer (1100)
  ('pack_registry',           'O','org',             '{}',                         null,                     null, null, null, null, false, 'global catalog (no org_id)'),
  ('pack_installs',           'O','org',             '{}',                         null,                     null, null, null, null, false, null),
  ('pack_overrides',          'O','org',             '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('onboarding_runs',         'O','org',             '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('doc_counters',            'O','org',             '{}',                         null,                     null, null, null, null, false, 'internal; no member grants'),
  ('job_types',               'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('stage_defs',              'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('stage_transitions',       'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('approval_policies',       'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('field_defs',              'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('cost_codes',              'S','location',        '{}',                         'projects.settings',      null, null, null,
     '(%1$sjob_id is not null and %1$sjob_id in (select pm.my_job_ids_with(''projects.jobs'', ''edit'')))', false, 'job-level codes also writable with jobs:edit on the job'),
  ('price_book_items',        'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, 'readable by every company member (tg_wo_line / tg_selection_option read it as the caller); cost not masked — deviation 4'),
  ('kpi_defs',                'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, null),
  -- commitments + billing (1102)
  ('estimates',               'C','location',        '{projects.estimates}',       'projects.estimates',     null, null, null, null, false, 'cost_total_cents masked (pm.v_estimates_masked)'),
  ('estimate_lines',          'C','parent',          '{}',                         'projects.estimates',     'estimates', 'estimate_id', null, null, false, 'cost masked (pm.v_estimate_lines_masked)'),
  ('commitments',             'M','job',             '{projects.financials}',      'projects.commitments',   null, null, null, null, false, null),
  ('commitment_lines',        'M','parent',          '{}',                         'projects.commitments',   'commitments', 'commitment_id', null, null, false, null),
  ('commitment_changes',      'M','job',             '{projects.financials}',      'projects.commitments',   null, null, null, null, false, null),
  ('receipts',                'M','job',             '{projects.financials}',      'projects.commitments',   null, null, null, null, false, null),
  ('compliance_docs',         'J','job',             '{projects.commitments}',     'projects.commitments',   null, null, null, null, false, 'vendor compliance; commitments:view on the job'),
  ('sov_versions',            'M','job',             '{projects.contract_value}',  'projects.billing',       null, null, null, null, false, null),
  ('sov_lines',               'M','parent',          '{}',                         'projects.billing',       'sov_versions', 'sov_version_id', null, null, false, null),
  ('billing_requests',        'M','job',             '{projects.contract_value}',  'projects.billing',       null, null, null, null, false, null),
  ('billing_request_lines',   'M','parent',          '{}',                         'projects.billing',       'billing_requests', 'billing_request_id', null, null, false, null),
  ('billing_links',           'M','job',             '{projects.contract_value}',  'projects.billing',       null, null, null, null, false, null),
  ('retainage_ledger',        'M','job',             '{projects.contract_value}',  null,                     null, null, null, null, false, null),
  ('deposit_requests',        'M','job',             '{projects.contract_value}',  'projects.billing',       null, null, null, null, false, null),
  ('allowances',              'M','job',             '{projects.contract_value}',  'projects.selections',    null, null, null, null, false, null),
  -- cost drain (1103)
  ('job_costs',               'M','job',             '{projects.financials}',      null,                     null, null, null, null, false, 'Books projection'),
  ('job_cost_applied_events', 'O','org',             '{}',                         null,                     null, null, null, null, false, 'seam bookkeeping; no money columns'),
  ('event_cursor',            'O','org',             '{}',                         null,                     null, null, null, null, false, 'seam bookkeeping'),
  -- field service (1104)
  ('work_orders',             'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, null),
  ('work_order_lines',        'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, 'unit_cost_cents masked (pm.v_work_order_lines_masked)'),
  ('dispatch_assignments',    'J','job',             '{projects.jobs}',            'projects.dispatch',      null, null, null, null, false, null),
  ('crews',                   'C','location',        '{projects.dispatch}',        'projects.dispatch',      null, null,
     '%1$sid in (select pm.my_crew_ids())', null, false, 'dispatch, or the caller''s own crews'),
  ('crew_members',            'C','parent',          '{}',                         'projects.dispatch',      'crews', 'crew_id', null, null, false, null),
  ('skills',                  'S','org',             '{}',                         'projects.dispatch',      null, null, null, null, false, null),
  ('employee_skills',         'P','org',             '{projects.dispatch}',        'projects.dispatch',      null, null,
     '(%1$semployee_id in (select pm.my_employee_ids()) or (select pm.can_any(array[''projects.dispatch'', ''projects.production'']::text[], ''view'')))',
     '(select pm.can(''projects.dispatch'', ''edit''))', false, 'own skills, or dispatch / production'),
  ('service_agreements',      'C','location',        '{projects.customers,projects.dispatch}', 'projects.customers', null, null, null, null, false, null),
  ('agreement_assets',        'C','parent',          '{}',                         'projects.dispatch',      'service_agreements', 'agreement_id', null, null, false, null),
  ('assets',                  'C','location',        '{projects.customers,projects.store,projects.dispatch}', 'projects.customers', null, null,
     '%1$sid in (select w.asset_id from pm.work_orders w where w.org_id = public.get_org_id() and w.asset_id is not null and w.job_id in (select pm.my_job_ids()))',
     null, false, 'equipment / units; also the assets on the caller''s work orders. dealer cost not masked — deviation 4'),
  ('asset_service_history',   'C','parent',          '{}',                         'projects.dispatch',      'assets', 'asset_id', null, null, false, null),
  ('stock_locations',         'C','location',        '{projects.store,projects.dispatch,projects.production,projects.jobs}', 'projects.store', null, null, null, null, false, null),
  ('stock_targets',           'C','parent',          '{}',                         'projects.store',         'stock_locations', 'stock_location_id', null, null, false, null),
  ('material_moves',          'J','job_or_location', '{projects.jobs}',            null,                     null, null, null, null, false, 'written only by pm.record_material_move'),
  ('warranty_claims',         'J','job',             '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  -- production (1105)
  ('work_centers',            'S','location',        '{}',                         'projects.production',    null, null, null, null, false, 'rate_cents masked (pm.v_work_centers_masked)'),
  ('routings',                'S','location',        '{}',                         'projects.production',    null, null, null, null, false, null),
  ('routing_steps',           'S','parent',          '{}',                         'projects.production',    'routings', 'routing_id', null, null, false, null),
  ('wo_operations',           'J','job',             '{projects.jobs}',            'projects.production',    null, null, null, null, false, null),
  ('bom_lines',               'J','job',             '{projects.jobs}',            'projects.production',    null, null, null, null, false, null),
  -- selections (1106)
  ('selections',              'J','job',             '{projects.jobs}',            'projects.selections',    null, null, null, null, false, 'allowance money not masked — deviation 4'),
  ('selection_options',       'J','parent',          '{}',                         'projects.selections',    'selections', 'selection_id', null, null, false, null),
  ('client_approvals',        'M','job',             '{projects.contract_value}',  'projects.selections',    null, null, null, null, false, null),
  ('procurement_items',       'J','job',             '{projects.selections}',      'projects.selections',    null, null, null, null, false, 'selections:view on the job; cost not masked — deviation 4'),
  ('measures',                'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, null),
  ('measure_areas',           'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, null),
  -- development (1107)
  ('units',                   'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, 'prices masked (pm.v_units_masked)'),
  ('entitlements',            'J','job',             '{projects.jobs}',            'projects.jobs',          null, null, null, null, false, null),
  ('draw_schedules',          'M','job',             '{projects.financials}',      'projects.billing',       null, null, null, null, false, null),
  ('draw_budget_lines',       'M','job',             '{projects.financials}',      'projects.billing',       null, null, null, null, false, null),
  ('draw_budget_revisions',   'M','job',             '{projects.financials}',      'projects.billing',       null, null, null, null, false, null),
  ('draws',                   'M','job',             '{projects.financials}',      'projects.billing',       null, null, null, null, false, null),
  ('draw_lines',              'M','job',             '{projects.financials}',      'projects.billing',       null, null, null, null, false, null),
  -- parties + labor (1108)
  ('vendor_profiles',         'S','location',        '{}',                         null,                     null, null, null, null, false, 'written only by pm.create_vendor'),
  ('labor_settings',          'C','location',        '{projects.labor_rates,projects.estimates}', 'projects.labor_rates', null, null, null, null, false, null),
  ('labor_rate_cards',        'C','location',        '{projects.labor_rates,projects.estimates}', 'projects.labor_rates', null, null, null, null, false, 'role rate cards; estimators read them to price labor'),
  ('employee_rate_cards',     'P','location',        '{projects.labor_rates}',     'projects.labor_rates',   null, null,
     '(%1$semployee_id in (select pm.my_employee_ids()) or %1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')))',
     '%1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''edit''))', false, 'individual pay mapping: own row or labor_rates'),
  ('time_entry_events',       'M','job',             '{projects.labor_rates}',     null,                     null, null, null, null, false, 'pinned individual rates: labor_rates on the job'),
  -- dealer (1109)
  ('dealer_settings',         'S','location',        '{}',                         'projects.settings',      null, null, null, null, false, null),
  ('dealer_deals',            'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('dealer_deal_lines',       'C','parent',          '{}',                         'projects.store',         'dealer_deals', 'deal_id', null, null, false, null),
  ('dealer_quotes',           'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('dealer_trades',           'C','parent',          '{}',                         'projects.store',         'dealer_deals', 'deal_id', null, null, false, null),
  ('dealer_fi_products',      'C','parent',          '{}',                         'projects.store',         'dealer_deals', 'deal_id', null, null, false, null),
  ('dealer_deposits',         'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('dealer_unit_costs',       'C','location',        '{projects.financials}',      null,                     null, null, null, null, false, 'unit cost: financials at the company'),
  ('dealer_floor_status',     'C','location',        '{projects.financials}',      null,                     null, null, null, null, false, 'floor plan payoff: financials'),
  ('dealer_sot_alerts',       'C','location',        '{projects.financials}',      null,                     null, null, null, null, false, 'sold-out-of-trust: financials'),
  ('dealer_outbox',           'C','location',        '{projects.financials}',      null,                     null, null, null, null, false, 'seam payloads carry deal money'),
  ('dealer_inbound_events',   'O','org',             '{}',                         null,                     null, null, null, null, false, 'seam bookkeeping'),
  ('dealer_warranty_payments','J','parent',          '{}',                         'projects.store',         'warranty_claims', 'claim_id', null, null, false, null),
  ('parts',                   'C','location',        '{projects.store,projects.jobs}', 'projects.store',     null, null, null, null, false, 'catalog for techs too; cost not masked — deviation 4'),
  ('parts_tickets',           'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('parts_ticket_lines',      'C','parent',          '{}',                         'projects.store',         'parts_tickets', 'ticket_id', null, null, false, null),
  ('parts_orders',            'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('parts_order_lines',       'C','parent',          '{}',                         'projects.store',         'parts_orders', 'order_id', null, null, false, null),
  ('parts_special_orders',    'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('parts_counts',            'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('parts_count_lines',       'C','parent',          '{}',                         'projects.store',         'parts_counts', 'count_id', null, null, false, null),
  ('rental_rates',            'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('rental_contracts',        'C','location',        '{projects.store}',           'projects.store',         null, null, null, null, false, null),
  ('rental_billings',         'C','location',        '{projects.store}',           null,                     null, null, null, null, false, null),
  -- 1110 registries
  ('access_table_classes',    'O','org',             '{}',                         null,                     null, null, null, null, false, 'catalog (no org_id)'),
  ('access_masked_columns',   'O','org',             '{}',                         null,                     null, null, null, null, false, 'catalog (no org_id)'),
  ('access_rpc_guards',       'O','org',             '{}',                         null,                     null, null, null, null, false, 'catalog (no org_id)'),
  ('access_rpc_allowlist',    'O','org',             '{}',                         null,                     null, null, null, null, false, 'catalog (no org_id)'),
  ('access_core_views',       'O','org',             '{}',                         null,                     null, null, null, null, false, 'catalog (no org_id)'),
  ('access_function_rewrites','O','org',             '{}',                         null,                     null, null, null, null, false, 'catalog (no org_id)'),
  ('access_seat_exceptions',  'O','org',             '{}',                         null,                     null, null, null, null, false, 'catalog (no org_id)')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

-- Base tables of schema pm that have no access class (the guard test asserts this is empty).
create or replace function pm.access_unclassified_tables() returns setof text
language sql stable
set search_path = pm, core, public
as $$
  select c.relname::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'pm' and c.relkind in ('r', 'p')
     and not exists (select 1 from pm.access_table_classes a where a.table_name = c.relname)
   order by 1
$$;

-- Predicate for one registry row (non-parent scope). p_q = column qualifier ('t.' or 'tbl.').
create or replace function pm.access_pred_row(r pm.access_table_classes, p_op text, p_q text) returns text
language plpgsql stable
set search_path = pm, core, public
as $$
declare
  q text := p_q;
  caps text := format('array[%s]::text[]', coalesce((select string_agg(quote_literal(c), ', ') from unnest(r.read_caps) c), ''));
  v_job text; base text; wc text := r.write_cap; a text;
begin
  if p_op = 'select' then
    if r.class = 'P' then return '(' || format(r.read_extra, q) || ')'; end if;
    case r.class
      when 'O' then base := 'true';
      when 'S' then
        base := case when r.scope = 'location'
                     then format('(%1$slocation_id in (select pm.my_member_location_ids()) or (%1$slocation_id is null and (select pm.is_projects_member())))', q)
                     else '(select pm.is_projects_member())' end;
      when 'C' then
        base := format('(%1$slocation_id in (select pm.my_location_ids_any(%2$s, ''view'')) or (%1$slocation_id is null and (select pm.can_any(%2$s, ''view''))))', q, caps);
      when 'M' then
        base := format('%1$sjob_id in (select pm.my_money_job_ids(%2$L))', q, r.read_caps[1]);
      when 'J' then
        v_job := case when r.read_caps = array['projects.jobs']::text[]
                      then format('%1$sjob_id in (select pm.my_job_ids())', q)
                      else format('%1$sjob_id in (select pm.my_job_ids_with_any(%2$s, ''view''))', q, caps) end;
        base := case r.scope
                  when 'job' then v_job
                  when 'job_or_location' then
                    format('((%1$sjob_id is not null and %2$s) or (%1$sjob_id is null and (%1$slocation_id in (select pm.my_location_ids_any(%3$s, ''view'')) or (%1$slocation_id is null and (select pm.can_any(%3$s, ''view''))))))', q, v_job, caps)
                  when 'job_or_org' then
                    format('((%1$sjob_id is not null and %2$s) or (%1$sjob_id is null and (select pm.can_any(%3$s, ''view''))))', q, v_job, caps)
                end;
    end case;
    if base is null then raise exception 'PM_ACCESS_REGISTRY: no read predicate for % (% / %)', r.table_name, r.class, r.scope; end if;
    if r.read_extra is not null then base := format('(%s or %s)', base, format(r.read_extra, q)); end if;
    return base;
  end if;

  if p_op not in ('insert', 'update', 'delete') then raise exception 'PM_ACCESS_REGISTRY: unknown op %', p_op; end if;
  if wc is null then return 'false'; end if;
  a := case p_op when 'insert' then 'create' when 'update' then 'edit' else 'delete' end;
  if wc = 'projects.settings' then a := 'configure';
  elsif not exists (select 1 from core.capabilities c where c.key = wc and a = any (c.actions)) then a := 'edit';
  end if;
  if not exists (select 1 from core.capabilities c where c.key = wc and a = any (c.actions)) then
    raise exception 'PM_ACCESS_REGISTRY: % has no action % (table %)', wc, a, r.table_name;
  end if;
  if r.class = 'P' then return '(' || format(r.write_extra, q, a) || ')'; end if;
  case r.class
    when 'O' then base := format('(select pm.can(%1$L, %2$L))', wc, a);
    when 'S', 'C' then
      base := case when r.scope = 'location'
                   then format('(%1$slocation_id in (select pm.my_location_ids(%2$L, %3$L)) or (%1$slocation_id is null and (select pm.can(%2$L, %3$L))))', q, wc, a)
                   else format('(select pm.can(%1$L, %2$L))', wc, a) end;
    when 'M' then
      base := case when r.insert_without_money and p_op = 'insert'
                   then format('%1$sjob_id in (select pm.my_job_ids_with(%2$L, %3$L))', q, wc, a)
                   else format('(%1$sjob_id in (select pm.my_money_job_ids(%2$L)) and %1$sjob_id in (select pm.my_job_ids_with(%3$L, %4$L)))', q, r.read_caps[1], wc, a) end;
    when 'J' then
      v_job := format('%1$sjob_id in (select pm.my_job_ids_with(%2$L, %3$L))', q, wc, a);
      base := case r.scope
                when 'job' then v_job
                when 'job_or_location' then
                  format('((%1$sjob_id is not null and %2$s) or (%1$sjob_id is null and (%1$slocation_id in (select pm.my_location_ids(%3$L, %4$L)) or (%1$slocation_id is null and (select pm.can(%3$L, %4$L))))))', q, v_job, wc, a)
                when 'job_or_org' then
                  format('((%1$sjob_id is not null and %2$s) or (%1$sjob_id is null and (select pm.can(%3$L, %4$L))))', q, v_job, wc, a)
              end;
  end case;
  if base is null then raise exception 'PM_ACCESS_REGISTRY: no write predicate for % (% / %)', r.table_name, r.class, r.scope; end if;
  if r.write_extra is not null then base := format('(%s or %s)', base, format(r.write_extra, q, a)); end if;
  return base;
end $$;

-- Predicate for a table (resolves child → parent explicitly, so it is also correct inside
-- definer views where the parent's RLS does not apply).
create or replace function pm.access_pred(p_table text, p_op text, p_q text) returns text
language plpgsql stable
set search_path = pm, core, public
as $$
declare r pm.access_table_classes; pr pm.access_table_classes; v_alias text;
begin
  select * into r from pm.access_table_classes where table_name = p_table;
  if not found then raise exception 'PM_ACCESS_UNCLASSIFIED: pm.% has no access class', p_table; end if;
  if r.scope <> 'parent' then return pm.access_pred_row(r, p_op, p_q); end if;
  select * into pr from pm.access_table_classes where table_name = r.parent_table;
  if not found or pr.scope = 'parent' then
    raise exception 'PM_ACCESS_REGISTRY: parent % of % must be a classified top-level table', r.parent_table, p_table;
  end if;
  if pr.class <> r.class then
    raise exception 'PM_ACCESS_REGISTRY: % (class %) must have its parent''s class % (%)', p_table, r.class, pr.class, r.parent_table;
  end if;
  if p_op <> 'select' then
    pr.write_cap := r.write_cap;
    pr.write_extra := r.write_extra;
    pr.insert_without_money := r.insert_without_money;
  end if;
  v_alias := 'par_' || r.parent_table;
  return format('(%1$s%2$I in (select %3$s.id from pm.%4$I %3$s where %3$s.org_id = public.get_org_id() and %5$s))',
                p_q, r.parent_column, v_alias, r.parent_table, pm.access_pred_row(pr, p_op, v_alias || '.'));
end $$;

-- Install the restrictive class policies on every classified table. Raises when a base table
-- of schema pm is unclassified (so a new table cannot silently stay org-wide).
create or replace function pm.access_apply_policies() returns integer
language plpgsql
set search_path = pm, core, public
as $$
declare v_t text; v_tables text[]; v_pols text[]; v_pol text; v_q text; n int := 0; v_missing text;
  v_sel text; v_ins text; v_upd text; v_del text;
begin
  select string_agg(t, ', ') into v_missing from pm.access_unclassified_tables() t;
  if v_missing is not null then
    raise exception 'PM_ACCESS_UNCLASSIFIED: classify these pm tables in pm.access_table_classes: %', v_missing;
  end if;
  -- materialize first: the registry itself is one of the tables altered below
  select array_agg(a.table_name order by a.table_name) into v_tables
    from pm.access_table_classes a where to_regclass(format('pm.%I', a.table_name)) is not null;
  foreach v_t in array v_tables loop
    v_q := format('%I.', v_t);
    v_sel := pm.access_pred(v_t, 'select', v_q);
    v_ins := pm.access_pred(v_t, 'insert', v_q);
    v_upd := pm.access_pred(v_t, 'update', v_q);
    v_del := pm.access_pred(v_t, 'delete', v_q);
    select coalesce(array_agg(policyname::text), '{}') into v_pols
      from pg_policies where schemaname = 'pm' and tablename = v_t and policyname like 'pm\_access\_%';
    execute format('alter table pm.%I enable row level security', v_t);
    foreach v_pol in array v_pols loop
      execute format('drop policy %I on pm.%I', v_pol, v_t);
    end loop;
    execute format('create policy pm_access_select on pm.%I as restrictive for select to authenticated using (%s)', v_t, v_sel);
    execute format('create policy pm_access_insert on pm.%I as restrictive for insert to authenticated with check (%s)', v_t, v_ins);
    execute format('create policy pm_access_update on pm.%I as restrictive for update to authenticated using (%s) with check (%s)', v_t, v_upd, v_upd);
    execute format('create policy pm_access_delete on pm.%I as restrictive for delete to authenticated using (%s)', v_t, v_del);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- G. Money-column masks + masked views
-- ----------------------------------------------------------------------------
create table if not exists pm.access_masked_columns (
  schema_name  text not null default 'pm',
  table_name   text not null,
  column_name  text not null,
  visible_when text not null,   -- SQL over alias t: true when the caller may see this row's value
  masked_expr  text,            -- value when hidden (default NULL), e.g. strip jsonb keys
  note         text,
  primary key (schema_name, table_name, column_name),
  constraint access_masked_columns_schema_chk check (schema_name in ('pm', 'core'))
);
comment on table pm.access_masked_columns is
  '1110 / spec §3: money columns on otherwise-visible rows. pm tables: column SELECT is revoked from authenticated and pm.v_<table>_masked exposes them per row. core tables (Books-owned, never revoked): pm.v_core_<table>_masked is what the Projects app reads.';

-- Row rule of the core masked views (members only; definer code / service_role see every row).
create table if not exists pm.access_core_views (
  table_name text primary key,
  row_pred   text not null,      -- SQL over alias t
  note       text
);

-- Strip money keys from a jsonb document (objects and arrays, any depth).
create or replace function pm.access_strip_keys(p_doc jsonb, p_keys text[]) returns jsonb
language sql immutable
set search_path = pm, core, public
as $$
  select case jsonb_typeof(p_doc)
    when 'object' then (select coalesce(jsonb_object_agg(k, pm.access_strip_keys(v, p_keys)), '{}'::jsonb)
                          from jsonb_each(p_doc) as e(k, v) where not (k = any (p_keys)))
    when 'array'  then (select coalesce(jsonb_agg(pm.access_strip_keys(v, p_keys) order by i), '[]'::jsonb)
                          from jsonb_array_elements(p_doc) with ordinality as a(v, i))
    else p_doc end
$$;

-- Money keys in dealer deal documents (dealer_deal_totals / snapshot / approval shapes).
create or replace function pm.access_deal_money_keys() returns text[]
language sql immutable
as $$ select array['unit_cost_cents','fee_cost_cents','trade_acv_cents','acv_cents','fi_cost_cents','cost_cents','dealer_cost_cents',
                   'books_cost_cents','finance_reserve_cents','subvention_cents','front_gross_cents','back_gross_cents',
                   'total_gross_cents','front_gross_pct','gross_cents','margin_pct','margin_floor_pct','min_front_gross_cents']::text[] $$;

insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('time_entries',     'cost_rate_cents',          't.job_id in (select pm.my_job_ids_with(''projects.labor_rates'', ''view''))', null::text, 'individual pay rate + burden'),
  ('time_entries',     'bill_rate_cents',          't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))',      null, 'T&M sell rate'),
  ('estimates',        'cost_total_cents',         '(t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or t.created_by = (select pm.current_user_id()))', null, 'estimate cost; also the estimate''s author'),
  ('estimate_lines',   'unit_cost_cents',          't.estimate_id in (select e.id from pm.estimates e where e.org_id = public.get_org_id() and (e.job_id in (select pm.my_money_job_ids(''projects.financials'')) or e.created_by = (select pm.current_user_id())))', null, null),
  ('estimate_lines',   'cost_cents',               't.estimate_id in (select e.id from pm.estimates e where e.org_id = public.get_org_id() and (e.job_id in (select pm.my_money_job_ids(''projects.financials'')) or e.created_by = (select pm.current_user_id())))', null, null),
  ('estimate_lines',   'ext',                      't.estimate_id in (select e.id from pm.estimates e where e.org_id = public.get_org_id() and (e.job_id in (select pm.my_money_job_ids(''projects.financials'')) or e.created_by = (select pm.current_user_id())))', 't.ext - ''_labor''', 'ext._labor carries the labor cost breakdown'),
  ('work_order_lines', 'unit_cost_cents',          't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, null),
  ('tasks',            'billing_amount_cents',     't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, 'milestone billing value'),
  ('wbs_nodes',        'billing_amount_cents',     't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, 'milestone billing value'),
  ('units',            'contract_price_cents',     't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null),
  ('units',            'lender_release_price_cents','t.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null),
  ('work_centers',     'rate_cents',               't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, 'shop cost rate'),
  ('change_orders',    'amount_cents',             't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, 'sell amount; authors without contract_value see null'),
  ('change_orders',    'cost_impact_cents',        't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, 'cost impact'),
  -- catalog / store cost (financials at the company)
  ('price_book_items', 'cost_cents',               't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, 'price-book cost (sell price stays visible)'),
  ('parts',            'cost_cents',               't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, 'part cost'),
  ('assets',           'dealer_cost_cents',        't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, 'unit cost'),
  ('assets',           'books_cost_cents',         't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, 'unit cost per Books'),
  ('assets',           'payoff_cents',             't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, 'floor-plan payoff'),
  ('parts_ticket_lines','unit_cost_cents',         't.ticket_id in (select x.id from pm.parts_tickets x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, null),
  ('parts_order_lines','unit_cost_cents',          't.order_id in (select x.id from pm.parts_orders x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, null),
  -- dealer deal gross (financials at the company)
  ('dealer_deal_lines','cost_cents',               't.deal_id in (select x.id from pm.dealer_deals x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, null),
  ('dealer_fi_products','cost_cents',              't.deal_id in (select x.id from pm.dealer_deals x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, null),
  ('dealer_trades',    'acv_cents',                't.deal_id in (select x.id from pm.dealer_deals x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, 'trade cost basis'),
  ('dealer_deals',     'finance_reserve_cents',    't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, 'back-end gross'),
  ('dealer_deals',     'subvention_cents',         't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, null),
  ('dealer_deals',     'approved_totals',          't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', 'pm.access_strip_keys(t.approved_totals, pm.access_deal_money_keys())', 'gross keys stripped'),
  ('dealer_deals',     'final_totals',             't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', 'pm.access_strip_keys(t.final_totals, pm.access_deal_money_keys())', 'gross keys stripped'),
  ('dealer_deals',     'approval',                 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', 'pm.access_strip_keys(t.approval, pm.access_deal_money_keys())', 'margin keys stripped'),
  ('dealer_quotes',    'totals',                   't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', 'pm.access_strip_keys(t.totals, pm.access_deal_money_keys())', 'gross keys stripped'),
  ('dealer_quotes',    'snapshot',                 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', 'pm.access_strip_keys(t.snapshot, pm.access_deal_money_keys())', 'cost keys stripped'),
  -- selections / procurement (sell side = contract_value, cost side = financials, on the job)
  ('selections',       'allowance_cents',          't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null),
  ('selections',       'chosen_total_cents',       't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null),
  ('selections',       'allowance_applied_cents',  't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null),
  ('selections',       'variance_cents',           't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null),
  ('selection_options','unit_cost_cents',          't.selection_id in (select x.id from pm.selections x where x.org_id = public.get_org_id() and x.job_id in (select pm.my_money_job_ids(''projects.financials'')))', null, null),
  ('selection_options','markup_pct',               't.selection_id in (select x.id from pm.selections x where x.org_id = public.get_org_id() and x.job_id in (select pm.my_money_job_ids(''projects.financials'')))', null, null),
  ('selection_options','unit_price_cents',         't.selection_id in (select x.id from pm.selections x where x.org_id = public.get_org_id() and x.job_id in (select pm.my_money_job_ids(''projects.contract_value'')))', null, null),
  ('selection_options','amount_cents',             't.selection_id in (select x.id from pm.selections x where x.org_id = public.get_org_id() and x.job_id in (select pm.my_money_job_ids(''projects.contract_value'')))', null, null),
  ('procurement_items','unit_cost_cents',          't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, null),
  ('procurement_items','markup_pct',               't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, null),
  ('procurement_items','freight_cents',            't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, null),
  ('procurement_items','cost_total_cents',         't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, null),
  ('procurement_items','unit_sell_cents',          't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null),
  ('procurement_items','sell_total_cents',         't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, null)
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set
  visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

-- core masters the Projects app reads (H1): rows + money columns for members.
insert into pm.access_core_views as v (table_name, row_pred, note) values
  ('jobs',
   '(t.org_id = public.get_org_id() and (t.id in (select pm.my_job_ids()) or t.location_id in (select pm.my_location_ids_any(array[''projects.jobs_all'',''projects.leads'',''projects.customers'',''projects.estimates'',''projects.store'',''projects.dispatch''], ''view''))))',
   'reachable jobs, or every job of a company where the caller works company-wide'),
  ('customers',
   '(t.org_id = public.get_org_id() and ((t.location_id is null and (select pm.can_any(array[''projects.customers'',''projects.leads'',''projects.estimates'',''projects.store'',''projects.dispatch'',''projects.jobs_all''], ''view''))) or t.location_id in (select pm.my_location_ids_any(array[''projects.customers'',''projects.leads'',''projects.estimates'',''projects.store'',''projects.dispatch'',''projects.jobs_all''], ''view'')) or t.id in (select j.customer_id from core.jobs j where j.org_id = public.get_org_id() and j.id in (select pm.my_job_ids()))))',
   'customers of companies worked company-wide, or of the caller''s jobs'),
  ('vendors',
   '(t.org_id = public.get_org_id() and (select pm.can_any(array[''projects.commitments'',''projects.store'',''projects.financials'',''projects.selections'',''projects.settings''], ''view'')))',
   'vendor pickers for purchasing / store / selections / settings')
on conflict (table_name) do update set row_pred = excluded.row_pred, note = excluded.note;

-- core money columns: every *_cents / markup column of core.jobs (sell side → contract_value,
-- cost side → financials), customer credit / tax id, vendor spend. Columns Books revokes from
-- members (vendors.tin_encrypted) are always null for members.
insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'core', 'jobs', c.column_name::text,
       case when c.column_name ~ '^(estimated_cost|budget_|actual_(cost|labor|materials|subcontractor|other))' or c.column_name = 'markup_pct'
            then 't.id in (select pm.my_money_job_ids(''projects.financials''))'
            else 't.id in (select pm.my_money_job_ids(''projects.contract_value''))' end,
       null, 'core.jobs money'
  from information_schema.columns c
 where c.table_schema = 'core' and c.table_name = 'jobs' and (c.column_name like '%\_cents' or c.column_name = 'markup_pct')
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, note = excluded.note;
insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note) values
  ('core', 'customers', 'credit_limit_cents', '((t.location_id is null and (select pm.can(''projects.financials'', ''view''))) or t.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, 'credit limit'),
  ('core', 'customers', 'tax_id',             '((t.location_id is null and (select pm.can(''projects.financials'', ''view''))) or t.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, 'tax id'),
  ('core', 'vendors',   'ytd_spend_cents',    '(select pm.can(''projects.financials'', ''view''))', null, 'vendor spend')
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, note = excluded.note;

-- Is the statement running as a PostgREST member role? Inside a definer function current_user is
-- the function owner, so masked views give definer code (and service_role) base-table semantics —
-- money computations such as pm.v_job_money inside pm.emit_job_progress are never masked.
create or replace function pm.access_member_role() returns boolean
language sql stable
set search_path = pm, core, public
as $$ select current_user::text in ('authenticated', 'anon') $$;

-- (Re)build pm.v_<table>_masked (pm tables) and pm.v_core_<table>_masked (core masters). pm base
-- tables lose member SELECT on the masked columns (the Books 167 pattern); core tables are never
-- revoked (Books reads them through RLS). Masked views are read-only for members (M1).
create or replace function pm.access_apply_masks() returns integer
language plpgsql
set search_path = pm, core, public
as $$
declare t record; c record; v_cols text; v_plain text; v_masked text; v_sql text; v_view text; v_pred text; n int := 0;
begin
  for t in select distinct schema_name, table_name from pm.access_masked_columns order by 1, 2 loop
    if to_regclass(format('%I.%I', t.schema_name, t.table_name)) is null then
      raise exception 'PM_ACCESS_MASK: %.% does not exist', t.schema_name, t.table_name;
    end if;
    v_view := case t.schema_name when 'pm' then 'v_' || t.table_name || '_masked' else 'v_core_' || t.table_name || '_masked' end;
    if t.schema_name = 'pm' then
      v_pred := pm.access_pred(t.table_name, 'select', 't.');
    else
      select row_pred into v_pred from pm.access_core_views where table_name = t.table_name;
      if v_pred is null then raise exception 'PM_ACCESS_MASK: no pm.access_core_views row for core.%', t.table_name; end if;
    end if;
    v_cols := null; v_plain := null; v_masked := null;
    for c in
      select ic.column_name::text as col, m.visible_when, m.masked_expr,
             has_column_privilege('authenticated', format('%I.%I', t.schema_name, t.table_name), ic.column_name, 'SELECT') as member_readable,
             (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
               where a.attrelid = format('%I.%I', t.schema_name, t.table_name)::regclass and a.attname = ic.column_name) as coltype
        from information_schema.columns ic
        left join pm.access_masked_columns m
          on m.schema_name = t.schema_name and m.table_name = ic.table_name and m.column_name = ic.column_name
       where ic.table_schema = t.schema_name and ic.table_name = t.table_name
       order by ic.ordinal_position
    loop
      if c.visible_when is not null then
        v_cols := concat_ws(', ', v_cols, format('(case when not (select pm.access_member_role()) or (%s) then t.%I else %s end)::%s as %I',
                                                 c.visible_when, c.col, coalesce(c.masked_expr, 'null'), c.coltype, c.col));
        v_masked := concat_ws(', ', v_masked, format('%I', c.col));
      elsif t.schema_name = 'core' and not c.member_readable then
        v_cols := concat_ws(', ', v_cols, format('(case when not (select pm.access_member_role()) then t.%I end)::%s as %I', c.col, c.coltype, c.col));
      else
        v_cols := concat_ws(', ', v_cols, format('t.%I', c.col));
        v_plain := concat_ws(', ', v_plain, format('%I', c.col));
      end if;
    end loop;
    if v_masked is null then
      raise exception 'PM_ACCESS_MASK: registry columns of %.% do not exist', t.schema_name, t.table_name;
    end if;
    v_sql := format('create or replace view pm.%I with (security_barrier = true) as select %s from %I.%I t where not (select pm.access_member_role()) or (%s)',
                    v_view, v_cols, t.schema_name, t.table_name,
                    case when t.schema_name = 'pm' then format('t.org_id = public.get_org_id() and %s', v_pred) else v_pred end);
    execute v_sql;
    execute format('comment on view pm.%I is %L', v_view,
                   format('1110: %s.%s for members — class-scoped rows, money columns (%s) null / stripped unless the caller holds the money capability. Definer + security_barrier, read-only (see 1110 header).', t.schema_name, t.table_name, v_masked));
    execute format('revoke all on pm.%I from public, anon, authenticated', v_view);
    execute format('grant select on pm.%I to authenticated', v_view);
    execute format('grant select on pm.%I to service_role', v_view);
    if t.schema_name = 'pm' then
      -- base table: members keep SELECT on every other column only
      execute format('revoke select on table pm.%I from authenticated', t.table_name);
      execute format('revoke select (%s) on table pm.%I from authenticated', v_masked, t.table_name);
      execute format('grant select (%s) on table pm.%I to authenticated', v_plain, t.table_name);
      execute format('grant select on table pm.%I to service_role', t.table_name);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Invoker views that read a masked column (or a core master) as the caller are re-pointed at the
-- masked views (same columns): members keep working and get masked values, definer code and
-- service_role get base values. Text-level rewrite of pg_get_viewdef (names fully qualified).
create or replace function pm.access_rewrite_views() returns integer
language plpgsql
set search_path = pg_catalog
as $$
declare v record; t record; v_def text; v_new text; n int := 0;
begin
  for v in
    select c.oid, c.relname::text as name
      from pg_class c join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'pm' and c.relkind = 'v'
       and coalesce(array_to_string(c.reloptions, ','), '') ~ 'security_invoker=(on|true)'
     order by c.relname
  loop
    v_def := pg_get_viewdef(v.oid);
    v_new := v_def;
    for t in
      select distinct m.schema_name, m.table_name
        from pm.access_masked_columns m
        join information_schema.view_column_usage u
          on u.view_schema = 'pm' and u.view_name = v.name
         and u.table_schema = m.schema_name and u.table_name = m.table_name and u.column_name = m.column_name
      union
      select distinct u.table_schema::text, u.table_name::text
        from information_schema.view_table_usage u
       where u.view_schema = 'pm' and u.view_name = v.name and u.table_schema = 'core'
         and u.table_name in (select table_name from pm.access_core_views)
    loop
      v_new := regexp_replace(v_new, format('\m%s\.%s\M', t.schema_name, t.table_name),
                              format('pm.%s', case t.schema_name when 'pm' then 'v_' || t.table_name || '_masked'
                                                                 else 'v_core_' || t.table_name || '_masked' end), 'g');
    end loop;
    if v_new is distinct from v_def then
      execute format('create or replace view pm.%I with (security_invoker = on) as %s', v.name, v_new);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Definer row readers for invoker TRIGGERS that copy a masked cost into the row being written
-- (price-book / part / unit cost onto a work-order, deal, ticket or order line). Callable by a
-- member only from inside a trigger — a direct call cannot read cost.
create or replace function pm.access_unmasked_price_book_item(p_id uuid) returns setof pm.price_book_items
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_is_service() and pg_trigger_depth() = 0 then
    raise exception 'PM_FORBIDDEN: trigger-only reader' using errcode = '42501';
  end if;
  return query select * from pm.price_book_items x where x.id = p_id and (pm.access_is_service() or x.org_id = public.get_org_id());
end $$;
create or replace function pm.access_unmasked_part(p_id uuid) returns setof pm.parts
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_is_service() and pg_trigger_depth() = 0 then
    raise exception 'PM_FORBIDDEN: trigger-only reader' using errcode = '42501';
  end if;
  return query select * from pm.parts x where x.id = p_id and (pm.access_is_service() or x.org_id = public.get_org_id());
end $$;
create or replace function pm.access_unmasked_asset(p_id uuid) returns setof pm.assets
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_is_service() and pg_trigger_depth() = 0 then
    raise exception 'PM_FORBIDDEN: trigger-only reader' using errcode = '42501';
  end if;
  return query select * from pm.assets x where x.id = p_id and (pm.access_is_service() or x.org_id = public.get_org_id());
end $$;

create or replace function pm.access_unmasked_deal(p_id uuid) returns setof pm.dealer_deals
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_is_service() and pg_trigger_depth() = 0 then
    raise exception 'PM_FORBIDDEN: trigger-only reader' using errcode = '42501';
  end if;
  return query select * from pm.dealer_deals x where x.id = p_id and (pm.access_is_service() or x.org_id = public.get_org_id());
end $$;

-- Text rewrites of existing invoker functions (regex → replacement; applied to every overload;
-- fails when the pattern is gone and the replacement is not already present).
create table if not exists pm.access_function_rewrites (
  function_name text not null,
  find_regex    text not null,
  replacement   text not null,
  note          text,
  primary key (function_name, find_regex)
);
insert into pm.access_function_rewrites as r (function_name, find_regex, replacement, note) values
  ('tg_wo_line',           'from pm\.price_book_items p where p\.id = new\.price_book_item_id', 'from pm.access_unmasked_price_book_item(new.price_book_item_id) p where p.id = new.price_book_item_id', 'copies price-book cost'),
  ('tg_selection_option',  'from pm\.price_book_items p where p\.id = new\.price_book_item_id', 'from pm.access_unmasked_price_book_item(new.price_book_item_id) p where p.id = new.price_book_item_id', 'copies price-book cost'),
  ('tg_dealer_deal_line',  'from pm\.assets x where x\.org_id = new\.org_id and x\.id = new\.asset_id', 'from pm.access_unmasked_asset(new.asset_id) x where x.org_id = new.org_id and x.id = new.asset_id', 'copies unit cost'),
  ('tg_dealer_deal_line',  'from pm\.parts x where x\.org_id = new\.org_id and x\.id = new\.part_id', 'from pm.access_unmasked_part(new.part_id) x where x.org_id = new.org_id and x.id = new.part_id', 'copies part cost'),
  ('tg_parts_ticket_line', 'from pm\.parts x where x\.org_id = new\.org_id and x\.id = new\.part_id', 'from pm.access_unmasked_part(new.part_id) x where x.org_id = new.org_id and x.id = new.part_id', 'copies part cost'),
  ('tg_parts_order_line',  'from pm\.parts x where x\.org_id = new\.org_id and x\.id = new\.part_id', 'from pm.access_unmasked_part(new.part_id) x where x.org_id = new.org_id and x.id = new.part_id', 'copies part cost'),
  ('tg_dealer_deal_line',  'from pm\.dealer_deals x where x\.org_id = (new|old)\.org_id and x\.id = (new|old)\.deal_id', 'from pm.access_unmasked_deal(\2.deal_id) x where x.org_id = \1.org_id and x.id = \2.deal_id', 'reads the whole deal row'),
  ('tg_dealer_trade',      'from pm\.dealer_deals x where x\.org_id = (new|old)\.org_id and x\.id = (new|old)\.deal_id', 'from pm.access_unmasked_deal(\2.deal_id) x where x.org_id = \1.org_id and x.id = \2.deal_id', 'reads the whole deal row'),
  ('tg_dealer_fi_product', 'from pm\.dealer_deals x where x\.org_id = v_org and x\.id = v_deal', 'from pm.access_unmasked_deal(v_deal) x where x.org_id = v_org and x.id = v_deal', 'reads the whole deal row'),
  ('cost_code_usable',     '\mcore\.jobs\M', 'pm.v_core_jobs_masked', 'core.jobs is narrowed for Projects-only seats (H1)'),
  ('guard_has_customer',   '\mcore\.jobs\M', 'pm.v_core_jobs_masked', 'core.jobs is narrowed for Projects-only seats (H1)'),
  ('billing_preconditions','\mcore\.jobs\M', 'pm.v_core_jobs_masked', 'core.jobs is narrowed for Projects-only seats (H1)')
on conflict (function_name, find_regex) do update set replacement = excluded.replacement, note = excluded.note;

-- The caller's active membership in the request org (for the memberships / assignments narrowing).
create or replace function pm.access_my_membership() returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$ select core.client_scope_caller_membership() $$;

-- Exceptions to the Projects-only-seat deny on public / core tables (section J explains).
create table if not exists pm.access_seat_exceptions (
  schema_name text not null,
  table_name  text not null,
  kind        text not null,
  narrow_pred text,            -- narrowed: what a Projects-only seat may read / write
  reason      text not null,
  primary key (schema_name, table_name),
  constraint access_seat_exceptions_kind_chk check (kind in ('exempt', 'narrowed')),
  constraint access_seat_exceptions_pred_chk check ((kind = 'narrowed') = (narrow_pred is not null))
);
insert into pm.access_seat_exceptions as e (schema_name, table_name, kind, narrow_pred, reason) values
  ('core', 'organizations',           'exempt', null, 'tenant name / entitlements (own org only, Books RLS)'),
  ('core', 'locations',               'exempt', null, 'company names (own org, client scope)'),
  ('core', 'memberships',             'narrowed', '(id = (select pm.access_my_membership()) or (select pm.can(''projects.team'', ''view'')))', 'own seat; the org''s seats with projects.team:view (Team page)'),
  ('core', 'users',                   'exempt', null, 'self-read (Books RLS)'),
  ('core', 'employees',               'exempt', null, 'crew / time pickers; pay columns revoked by 167'),
  ('core', 'access_assignments',      'narrowed', '(membership_id = (select pm.access_my_membership()) or (select pm.can(''projects.team'', ''view'')))', 'own assignments; everyone''s with projects.team:view (Team page)'),
  ('core', 'role_definitions',        'exempt', null, 'role catalog'),
  ('core', 'role_versions',           'exempt', null, 'role catalog'),
  ('core', 'role_grants',             'exempt', null, 'role catalog'),
  ('core', 'permission_sets',         'exempt', null, 'permission-set catalog'),
  ('core', 'permission_set_versions', 'exempt', null, 'permission-set catalog'),
  ('core', 'permission_set_grants',   'exempt', null, 'permission-set catalog'),
  ('core', 'client_sets',             'exempt', null, 'assignment scopes'),
  ('core', 'client_set_members',      'exempt', null, 'assignment scopes (Team page)'),
  ('core', 'capabilities',            'exempt', null, 'capability catalog'),
  ('core', 'jobs',                    'exempt', null, 'narrowed by pm_projects_seat_narrow (money holders only)'),
  ('core', 'customers',               'exempt', null, 'narrowed by pm_projects_seat_narrow (money holders only)'),
  ('core', 'vendors',                 'exempt', null, 'narrowed by pm_projects_seat_narrow (money holders only)'),
  ('core', 'events',                  'exempt', null, 'narrowed by pm_projects_seat_narrow (money holders only)'),
  ('public', 'documents',             'narrowed',
   '(entity_type like ''pm.%'' and (uploaded_by_user = (select pm.current_user_id()) or id in (select l.document_id from pm.document_links l)))',
   'Projects attachments (unit photos, job documents); Books documents (bills, W-9s, loans) stay hidden'),
  ('public', 'ai_decisions',          'narrowed', '(feature like ''PROJECTS\_%'')', 'Projects AI proposals (onboarding)')
on conflict (schema_name, table_name) do update set kind = excluded.kind, narrow_pred = excluded.narrow_pred, reason = excluded.reason;

create or replace function pm.access_apply_function_rewrites() returns integer
language plpgsql
set search_path = pm, core, public
as $$
declare r record; f record; v_def text; v_new text; n int := 0;
begin
  for r in select * from pm.access_function_rewrites order by function_name, find_regex loop
    if not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'pm' and p.proname = r.function_name) then
      raise exception 'PM_ACCESS_REWRITE: pm.% does not exist', r.function_name;
    end if;
    for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'pm' and p.proname = r.function_name loop
      v_def := pg_get_functiondef(f.oid);
      if v_def !~ r.find_regex then
        if position(split_part(r.replacement, '(', 1) in v_def) > 0 then continue; end if;   -- already rewritten
        raise exception 'PM_ACCESS_REWRITE: pattern % not found in pm.%', r.find_regex, r.function_name;
      end if;
      v_new := regexp_replace(v_def, r.find_regex, r.replacement, 'g');
      execute v_new;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- dealer_deal_totals (invoker, called by members via RPC and by definer deal code): for members it
-- answers through this definer wrapper, which needs projects.store:view at the deal's company and
-- strips cost / gross unless projects.financials:view there. Definer callers get full totals.
create or replace function pm.access_dealer_deal_totals_member(p_deal uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; v jsonb;
begin
  select d.location_id into v_loc from pm.dealer_deals d where d.id = p_deal and d.org_id = public.get_org_id();
  if v_loc is null or not pm.can('projects.store', 'view', v_loc) then return null; end if;
  v := pm.dealer_deal_totals(p_deal);
  if pm.can('projects.financials', 'view', v_loc) then return v; end if;
  return pm.access_strip_keys(v, pm.access_deal_money_keys());
end $$;

-- ----------------------------------------------------------------------------
-- H. Guards on money-writing definer RPCs
-- ----------------------------------------------------------------------------
create table if not exists pm.access_rpc_guards (
  function_name text primary key,
  args          text[] not null,   -- argument names the guard reads (verified against the function)
  guard_sql     text not null,     -- guard: run inside `if pm.access_guard_enter() then … end if;`; prologue: run as is
  note          text,
  kind          text not null default 'guard',
  constraint access_rpc_guards_kind_chk check (kind in ('guard', 'prologue'))
);
comment on table pm.access_rpc_guards is
  '1110 / spec §3: pm.can() checks injected at the top of money-writing definer RPCs (marker pm_access_guard).';

-- Resolve a row of a classified table to its job / company (child rows through their parent)
-- and assert cap:actions there. Unknown / other-org rows → PM_FORBIDDEN.
create or replace function pm.access_assert_row(p_cap text, p_actions text[], p_table text, p_id uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r pm.access_table_classes; v_parent uuid; v_job uuid; v_loc uuid; v_found boolean; a text;
  v_has_job boolean; v_has_loc boolean;
begin
  if pm.access_is_service() then return; end if;
  select * into r from pm.access_table_classes where table_name = p_table;
  if not found then raise exception 'PM_ACCESS_UNCLASSIFIED: pm.%', p_table; end if;
  if r.scope = 'parent' then
    execute format('select %I from pm.%I where id = $1 and org_id = public.get_org_id()', r.parent_column, p_table)
      into v_parent using p_id;
    if v_parent is null then
      raise exception 'PM_FORBIDDEN: % % not found in the caller''s organization', p_table, p_id using errcode = '42501';
    end if;
    perform pm.access_assert_row(p_cap, p_actions, r.parent_table, v_parent);
    return;
  end if;
  select exists (select 1 from information_schema.columns where table_schema = 'pm' and table_name = p_table and column_name = 'job_id'),
         exists (select 1 from information_schema.columns where table_schema = 'pm' and table_name = p_table and column_name = 'location_id')
    into v_has_job, v_has_loc;
  execute format('select true, %s, %s from pm.%I where id = $1 and org_id = public.get_org_id()',
                 case when v_has_job then 'job_id' else 'null::uuid' end,
                 case when v_has_loc then 'location_id' else 'null::uuid' end, p_table)
    into v_found, v_job, v_loc using p_id;
  if v_found is null then
    raise exception 'PM_FORBIDDEN: % % not found in the caller''s organization', p_table, p_id using errcode = '42501';
  end if;
  if v_job is not null then perform pm.access_assert_job(p_cap, p_actions, v_job);
  elsif v_loc is not null then perform pm.access_assert_location(p_cap, p_actions, v_loc);
  else
    foreach a in array p_actions loop
      if not pm.can(p_cap, a) then
        raise exception 'PM_FORBIDDEN: requires %:%', p_cap, a using errcode = '42501';
      end if;
    end loop;
  end if;
end $$;

-- Any-of form for reads that two capabilities may serve (rate cards: labor_rates or estimates).
create or replace function pm.access_assert_row_any(p_caps text[], p_action text, p_table text, p_id uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c text;
begin
  if pm.access_is_service() then return; end if;
  foreach c in array p_caps loop
    begin
      perform pm.access_assert_row(c, array[p_action], p_table, p_id);
      return;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  raise exception 'PM_FORBIDDEN: requires one of % (%)', p_caps, p_action using errcode = '42501';
end $$;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  -- billing
  ('approve_and_emit_billing',  '{p_request}',  'perform pm.access_assert_row(''projects.billing'', array[''approve'',''post''], ''billing_requests'', p_request);', 'approve + send to Books'),
  ('void_billing_request',      '{p_request}',  'perform pm.access_assert_row(''projects.billing'', array[''approve''], ''billing_requests'', p_request);', null),
  ('finalize_billing_retainage','{p_request}',  'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''billing_requests'', p_request);', null),
  ('generate_milestone_billing','{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', null),
  ('generate_progress_billing', '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', null),
  ('generate_sov_billing',      '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', null),
  ('generate_tm_billing',       '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', null),
  ('request_retainage_release', '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', null),
  ('request_deposit',           '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', null),
  ('bill_allowance_overage',    '{p_allowance}','perform pm.access_assert_row(''projects.billing'', array[''create''], ''allowances'', p_allowance);', null),
  ('emit_deposit_request',      '{p_deposit}',  'perform pm.access_assert_row(''projects.billing'', array[''post''], ''deposit_requests'', p_deposit);', null),
  ('reemit_deposit_request',    '{p_deposit}',  'perform pm.access_assert_row(''projects.billing'', array[''post''], ''deposit_requests'', p_deposit);', null),
  ('activate_sov_version',      '{p_version}',  'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''sov_versions'', p_version);', null),
  ('revise_sov',                '{p_version}',  'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''sov_versions'', p_version);', null),
  -- draws
  ('activate_draw_schedule',    '{p_schedule}', 'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draw_schedules'', p_schedule);', null),
  ('create_draw',               '{p_schedule}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''draw_schedules'', p_schedule);', null),
  ('submit_draw',               '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', null),
  ('record_draw_inspection',    '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', null),
  ('return_draw',               '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', null),
  ('cancel_draw',               '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', null),
  ('approve_draw',              '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''approve''], ''draws'', p_draw);', null),
  ('fund_draw',                 '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''post''], ''draws'', p_draw);', null),
  ('revise_draw_budget_line',   '{p_line}',     'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''draw_budget_lines'', p_line);', null),
  -- commitments
  ('approve_commitment',        '{p_commitment}','perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''commitments'', p_commitment);', null),
  ('execute_commitment',        '{p_commitment}','perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''commitments'', p_commitment);', null),
  ('void_commitment',           '{p_commitment}','perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''commitments'', p_commitment);', null),
  ('close_commitment',          '{p_commitment}','perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitments'', p_commitment);', null),
  ('set_commitment_hold',       '{p_commitment}','perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitments'', p_commitment);', null),
  ('approve_commitment_change', '{p_change}',   'perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''commitment_changes'', p_change);', null),
  ('reject_commitment_change',  '{p_change}',   'perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''commitment_changes'', p_change);', null),
  ('record_receipt',            '{p_commitment_line}','perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitment_lines'', p_commitment_line);', null),
  ('verify_compliance_doc',     '{p_doc}',      'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''compliance_docs'', p_doc);', null),
  -- change orders, contract, progress
  ('approve_change_order',      '{p_co}',       'perform pm.access_assert_row(''projects.change_orders'', array[''approve''], ''change_orders'', p_co);', null),
  ('advance_change_order',      '{p_co,p_to}',  'perform pm.access_assert_row(''projects.change_orders'', case when p_to in (''VOID'',''REJECTED'') then array[''approve''] else array[''edit''] end, ''change_orders'', p_co);', 'reject / void are approval decisions'),
  ('set_contract',              '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', null),
  ('set_progress',              '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', null),
  ('emit_job_progress',         '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', 'nested calls are covered by the entry RPC'),
  ('create_project',            '{p_location,p_contract_cents}',
     'perform pm.access_assert_location(''projects.jobs'', array[''create''], p_location); if p_contract_cents is not null then perform pm.access_assert_location(''projects.financials'', array[''edit''], p_location); end if;', null),
  -- estimates, allowances, selections
  ('accept_estimate',           '{p_estimate}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''estimates'', p_estimate);', 'creates the contract + budget'),
  ('send_estimate',             '{p_estimate}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''estimates'', p_estimate);', null),
  ('decline_estimate',          '{p_estimate}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''estimates'', p_estimate);', null),
  ('revise_estimate',           '{p_estimate}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''estimates'', p_estimate);', null),
  ('close_allowance',           '{p_allowance}','perform pm.access_assert_row(''projects.selections'', array[''approve''], ''allowances'', p_allowance);', null),
  ('approve_selection',         '{p_selection}','perform pm.access_assert_row(''projects.selections'', array[''approve''], ''selections'', p_selection);', null),
  -- time + labor rates
  ('approve_time_entries',      '{p_ids}',      'perform pm.access_assert_row(''projects.time'', array[''approve''], ''time_entries'', x) from unnest(p_ids) as x;', null),
  ('unapprove_time_entry',      '{p_id}',       'perform pm.access_assert_row(''projects.time'', array[''approve''], ''time_entries'', p_id);', null),
  ('save_labor_rate_card',      '{p_location}', 'perform pm.access_assert_location(''projects.labor_rates'', array[''edit''], p_location);', null),
  ('set_labor_settings',        '{p_location}', 'perform pm.access_assert_location(''projects.labor_rates'', array[''edit''], p_location);', null),
  ('set_employee_rate_card',    '{p_location}', 'perform pm.access_assert_location(''projects.labor_rates'', array[''edit''], p_location);', null),
  ('price_labor_line',          '{p_rate_card}','perform pm.access_assert_row_any(array[''projects.labor_rates'',''projects.estimates''], ''view'', ''labor_rate_cards'', p_rate_card);', 'returns rates'),
  -- service agreements
  ('activate_agreement',        '{p_agreement}','perform pm.access_assert_row(''projects.customers'', array[''edit''], ''service_agreements'', p_agreement);', null),
  ('renew_agreement',           '{p_agreement}','perform pm.access_assert_row(''projects.customers'', array[''edit''], ''service_agreements'', p_agreement);', null),
  ('cancel_agreement',          '{p_agreement}','perform pm.access_assert_row(''projects.customers'', array[''edit''], ''service_agreements'', p_agreement);', null),
  -- dealer store
  ('create_deal',               '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location);', null),
  ('order_unit',                '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location);', null),
  ('open_parts_ticket',         '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location);', null),
  ('create_parts_order',        '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location);', null),
  ('upsert_part',               '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''edit''], p_location);', null),
  ('receive_unit',              '{p_location,p_cost_cents}',
     'perform pm.access_assert_location(''projects.store'', array[''create''], p_location); if p_cost_cents is not null then perform pm.access_assert_location(''projects.financials'', array[''edit''], p_location); end if;', null),
  ('write_deal',                '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', null),
  ('deliver_deal',              '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', null),
  ('reopen_deal',               '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', null),
  ('cancel_deal',               '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', null),
  ('request_deal_deposit',      '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', null),
  ('issue_dealer_quote',        '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', null),
  ('check_deal_delivery_item',  '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', null),
  ('approve_deal',              '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''approve''], ''dealer_deals'', p_deal);', 'desk approval / margin floor'),
  ('mark_deal_funded',          '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''approve''], ''dealer_deals'', p_deal);', null),
  ('unwind_deal',               '{p_deal}',     'perform pm.access_assert_row(''projects.store'', array[''approve''], ''dealer_deals'', p_deal);', null),
  ('accept_dealer_quote',       '{p_quote}',    'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_quotes'', p_quote);', null),
  ('decline_dealer_quote',      '{p_quote}',    'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_quotes'', p_quote);', null),
  ('add_unit_cost',             '{p_unit}',     'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''assets'', p_unit);', null),
  ('set_dealer_unit_status',    '{p_unit}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit);', null),
  ('transfer_unit',             '{p_unit}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit);', null),
  ('set_dealer_settings',       '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', null),
  ('close_parts_ticket',        '{p_ticket}',   'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_tickets'', p_ticket);', null),
  ('void_parts_ticket',         '{p_ticket}',   'perform pm.access_assert_row(''projects.store'', array[''approve''], ''parts_tickets'', p_ticket);', null),
  ('submit_parts_order',        '{p_order}',    'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_orders'', p_order);', null),
  ('receive_parts_order',       '{p_order}',    'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_orders'', p_order);', null),
  ('post_parts_count',          '{p_count}',    'perform pm.access_assert_row(''projects.store'', array[''approve''], ''parts_counts'', p_count);', null),
  ('bill_rental',               '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract);', null),
  ('advance_warranty_claim',    '{p_claim}',    'perform pm.access_assert_row(''projects.store'', array[''edit''], ''warranty_claims'', p_claim);', null),
  -- sample data (writes contracts / billing)
  ('load_sample_job',           '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', null),
  ('remove_sample_data',        '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', null)
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- ---- H2 (security review): every member-executable definer RPC is guarded or allowlisted ----
-- Boolean building blocks for guards that accept one of several capabilities.
create or replace function pm.access_forbid(p_msg text) returns void
language plpgsql volatile
as $$ begin raise exception 'PM_FORBIDDEN: %', p_msg using errcode = '42501'; end $$;

create or replace function pm.access_can_job(p_cap text, p_action text, p_job uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or exists (select 1 from core.jobs j
                  where j.id = p_job and j.org_id = public.get_org_id()
                    and j.id in (select pm.my_job_ids())
                    and pm.can(p_cap, p_action, j.location_id))
$$;

-- (job, company, found) of a row of a classified table; child rows through their parent.
create or replace function pm.access_row_scope(p_table text, p_id uuid, out job_id uuid, out location_id uuid, out found boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r pm.access_table_classes; v_parent uuid; v_has_job boolean; v_has_loc boolean;
begin
  found := false;
  select * into r from pm.access_table_classes a where a.table_name = p_table;
  if r.table_name is null then raise exception 'PM_ACCESS_UNCLASSIFIED: pm.%', p_table; end if;
  if r.scope = 'parent' then
    execute format('select %I from pm.%I where id = $1 and org_id = public.get_org_id()', r.parent_column, p_table) into v_parent using p_id;
    if v_parent is null then return; end if;
    select s.job_id, s.location_id, s.found into job_id, location_id, found from pm.access_row_scope(r.parent_table, v_parent) s;
    return;
  end if;
  select exists (select 1 from information_schema.columns c where c.table_schema = 'pm' and c.table_name = p_table and c.column_name = 'job_id'),
         exists (select 1 from information_schema.columns c where c.table_schema = 'pm' and c.table_name = p_table and c.column_name = 'location_id')
    into v_has_job, v_has_loc;
  execute format('select true, %s, %s from pm.%I where id = $1 and org_id = public.get_org_id()',
                 case when v_has_job then 'job_id' else 'null::uuid' end,
                 case when v_has_loc then 'location_id' else 'null::uuid' end, p_table)
    into found, job_id, location_id using p_id;
  found := coalesce(found, false);
end $$;

create or replace function pm.access_can_row(p_cap text, p_action text, p_table text, p_id uuid) returns boolean
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s record;
begin
  if pm.access_is_service() then return true; end if;
  select * into s from pm.access_row_scope(p_table, p_id);
  if not s.found then return false; end if;
  if s.job_id is not null then return pm.access_can_job(p_cap, p_action, s.job_id); end if;
  if s.location_id is not null then return pm.can(p_cap, p_action, s.location_id); end if;
  return pm.can(p_cap, p_action);
end $$;

-- At a company (NULL company = at any company of the org).
create or replace function pm.access_can_location(p_cap text, p_action text, p_location uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or (p_location is null and pm.can(p_cap, p_action))
      or (p_location is not null
          and exists (select 1 from core.locations l where l.id = p_location and l.org_id = public.get_org_id())
          and pm.can(p_cap, p_action, p_location))
$$;

-- The caller is dispatched on this work order (as employee or crew) or works one of its operations.
create or replace function pm.access_my_work_order(p_wo uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select exists (select 1 from pm.dispatch_assignments d
                  where d.org_id = public.get_org_id() and d.work_order_id = p_wo
                    and (d.employee_id in (select pm.my_employee_ids()) or d.crew_id in (select pm.my_crew_ids())))
      or exists (select 1 from pm.wo_operations o
                  where o.org_id = public.get_org_id() and o.work_order_id = p_wo and o.employee_id in (select pm.my_employee_ids()))
$$;

create or replace function pm.access_try_uuid(p text) returns uuid
language plpgsql immutable
as $$ begin return p::uuid; exception when others then return null; end $$;

-- Member-executable definer functions that need no injected guard (read helpers that only
-- describe the caller's own access, or functions that check access themselves).
create table if not exists pm.access_rpc_allowlist (
  function_name text primary key,
  reason        text not null
);
insert into pm.access_rpc_allowlist as a (function_name, reason) values
  ('my_access',              'describes the caller''s own grants'),
  ('my_location_ids',        'caller''s own scope'),
  ('my_location_ids_any',    'caller''s own scope'),
  ('my_member_location_ids', 'caller''s own scope'),
  ('my_job_ids',             'caller''s own scope'),
  ('my_job_ids_with',        'caller''s own scope'),
  ('my_job_ids_with_any',    'caller''s own scope'),
  ('my_money_job_ids',       'caller''s own scope'),
  ('my_own_job_ids',         'caller''s own scope'),
  ('my_employee_ids',        'caller''s own employee rows'),
  ('my_crew_ids',            'caller''s own crews'),
  ('can',                    'caller''s own grants'),
  ('can_any',                'caller''s own grants'),
  ('is_projects_member',     'caller''s own grants'),
  ('job_team_upsert',        'checks projects.team:edit on a reachable job itself'),
  ('job_team_remove',        'checks projects.team:edit on a reachable job itself'),
  ('access_dealer_deal_totals_member', 'checks projects.store:view itself; strips gross without financials'),
  ('access_unmasked_price_book_item', 'trigger-only (refuses direct member calls)'),
  ('access_unmasked_part',   'trigger-only (refuses direct member calls)'),
  ('access_unmasked_asset',  'trigger-only (refuses direct member calls)'),
  ('access_unmasked_deal',   'trigger-only (refuses direct member calls)'),
  ('access_projects_only_seat', 'describes the caller''s own seat (core narrowing policies)'),
  ('access_my_membership',   'the caller''s own seat id'),
  ('set_projects_only',      'checks projects.team:edit at every company of the seat itself; never owner / admin / self')
on conflict (function_name) do update set reason = excluded.reason;

-- Member-executable definer functions in pm that are neither guarded nor allowlisted (the guard
-- test asserts this is empty).
create or replace function pm.access_unguarded_rpcs() returns setof text
language sql stable
set search_path = pm, core, public
as $$
  select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'pm' and p.prosecdef
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
     and not exists (select 1 from pm.access_rpc_guards g where g.function_name = p.proname and g.kind = 'guard')
     and not exists (select 1 from pm.access_rpc_allowlist a where a.function_name = p.proname)
   order by 1
$$;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  -- jobs / stages / onboarding
  ('adopt_job',               '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''create''], p_job);', null),
  ('set_job_customer',        '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', null),
  ('transition_stage',        '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', null),
  ('apply_pack_plan',         '{p_plan}',     'if pm.access_try_uuid(p_plan ->> ''location_id'') is not null then perform pm.access_assert_location(''projects.settings'', array[''configure''], pm.access_try_uuid(p_plan ->> ''location_id'')); end if;', 'an invalid location keeps the original PLAN_INVALID error'),
  ('record_entitlement_status','{p_entitlement}','perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''entitlements'', p_entitlement);', null),
  ('finalize_measure',        '{p_measure}',  'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''measures'', p_measure);', null),
  -- parties
  ('create_customer',         '{p_location}', 'if not pm.access_can_location(''projects.customers'', ''create'', p_location) then perform pm.access_forbid(''requires projects.customers:create''); end if;', null),
  ('create_vendor',           '{p_location}', 'if not (pm.access_can_location(''projects.commitments'', ''create'', p_location) or pm.access_can_location(''projects.store'', ''edit'', p_location) or pm.access_can_location(''projects.settings'', ''configure'', p_location)) then perform pm.access_forbid(''requires projects.commitments:create, projects.store:edit or projects.settings:configure''); end if;', null),
  -- work orders / dispatch (dispatch:edit, or the crew dispatched on it)
  ('create_work_order',       '{p_job}',      'if not (pm.access_can_job(''projects.production'', ''create'', p_job) or pm.access_can_job(''projects.dispatch'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.production:create or projects.dispatch:edit on this job''); end if;', null),
  ('schedule_work_order',     '{p_wo}',       'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''work_orders'', p_wo);', null),
  ('cancel_work_order',       '{p_wo}',       'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''work_orders'', p_wo);', null),
  ('close_work_order',        '{p_wo}',       'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''work_orders'', p_wo);', 'closing bills the visit'),
  ('start_work_order',        '{p_wo}',       'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires a dispatch on this work order or projects.dispatch:edit''); end if;', null),
  ('hold_work_order',         '{p_wo}',       'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires a dispatch on this work order or projects.dispatch:edit''); end if;', null),
  ('complete_work_order',     '{p_wo}',       'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires a dispatch on this work order or projects.dispatch:edit''); end if;', null),
  ('decide_work_order_options','{p_wo}',      'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires a dispatch on this work order or projects.dispatch:edit''); end if;', 'customer approves priced options on site'),
  ('set_assignment_status',   '{p_assignment}','if not (exists (select 1 from pm.dispatch_assignments d where d.id = p_assignment and d.org_id = public.get_org_id() and (d.employee_id in (select pm.my_employee_ids()) or d.crew_id in (select pm.my_crew_ids()))) or pm.access_can_row(''projects.dispatch'', ''edit'', ''dispatch_assignments'', p_assignment)) then perform pm.access_forbid(''requires your own dispatch or projects.dispatch:edit''); end if;', null),
  ('generate_agreement_visits','{p_agreement}','perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''service_agreements'', p_agreement);', null),
  ('create_warranty_claim_from_ro','{p_wo}',  'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', null),
  ('record_asset_service',    '{p_asset,p_work_order}','if not ((p_work_order is not null and pm.access_my_work_order(p_work_order)) or pm.access_can_row(''projects.dispatch'', ''edit'', ''assets'', p_asset) or pm.access_can_row(''projects.store'', ''edit'', ''assets'', p_asset)) then perform pm.access_forbid(''requires a dispatch on the work order, projects.dispatch:edit or projects.store:edit''); end if;', null),
  ('retire_asset',            '{p_asset}',    'if not (pm.access_can_row(''projects.customers'', ''edit'', ''assets'', p_asset) or pm.access_can_row(''projects.store'', ''edit'', ''assets'', p_asset)) then perform pm.access_forbid(''requires projects.customers:edit or projects.store:edit''); end if;', null),
  ('record_material_move',    '{p_job,p_from,p_to}', 'if p_job is not null then if not (pm.access_can_job(''projects.jobs'', ''edit'', p_job) or pm.access_can_job(''projects.production'', ''edit'', p_job) or pm.access_can_job(''projects.store'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.jobs / production / store edit on this job''); end if; elsif not (pm.access_can_row(''projects.store'', ''edit'', ''stock_locations'', coalesce(p_from, p_to)) or pm.access_can_row(''projects.production'', ''edit'', ''stock_locations'', coalesce(p_from, p_to)) or pm.access_can_row(''projects.dispatch'', ''edit'', ''stock_locations'', coalesce(p_from, p_to))) then perform pm.access_forbid(''requires projects.store / production / dispatch edit at the stock location''); end if;', null),
  -- production
  ('create_production_order', '{p_job}',      'perform pm.access_assert_job(''projects.production'', array[''create''], p_job);', null),
  ('apply_routing',           '{p_wo}',       'perform pm.access_assert_row(''projects.production'', array[''edit''], ''work_orders'', p_wo);', null),
  ('approve_drawings',        '{p_wo}',       'perform pm.access_assert_row(''projects.production'', array[''edit''], ''work_orders'', p_wo);', null),
  ('release_to_shop',         '{p_wo}',       'perform pm.access_assert_row(''projects.production'', array[''edit''], ''work_orders'', p_wo);', null),
  ('start_operation',         '{p_op}',       'if not (exists (select 1 from pm.wo_operations o where o.id = p_op and o.org_id = public.get_org_id() and o.employee_id in (select pm.my_employee_ids())) or pm.access_can_row(''projects.production'', ''edit'', ''wo_operations'', p_op)) then perform pm.access_forbid(''requires your own operation or projects.production:edit''); end if;', null),
  ('complete_operation',      '{p_op}',       'if not (exists (select 1 from pm.wo_operations o where o.id = p_op and o.org_id = public.get_org_id() and o.employee_id in (select pm.my_employee_ids())) or pm.access_can_row(''projects.production'', ''edit'', ''wo_operations'', p_op)) then perform pm.access_forbid(''requires your own operation or projects.production:edit''); end if;', null),
  ('skip_operation',          '{p_op}',       'perform pm.access_assert_row(''projects.production'', array[''edit''], ''wo_operations'', p_op);', null),
  -- selections
  ('propose_selection',       '{p_selection}','perform pm.access_assert_row(''projects.selections'', array[''edit''], ''selections'', p_selection);', null),
  ('reject_selection',        '{p_selection}','perform pm.access_assert_row(''projects.selections'', array[''edit''], ''selections'', p_selection);', null),
  ('void_selection',          '{p_selection}','perform pm.access_assert_row(''projects.selections'', array[''approve''], ''selections'', p_selection);', null),
  ('create_procurement_from_selection','{p_selection}','perform pm.access_assert_row(''projects.selections'', array[''edit''], ''selections'', p_selection);', null),
  ('advance_procurement_item','{p_item}',     'perform pm.access_assert_row(''projects.selections'', array[''edit''], ''procurement_items'', p_item);', null),
  -- development units (contract price = money)
  ('set_unit_status',         '{p_unit,p_contract_price_cents}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''units'', p_unit); if p_contract_price_cents is not null then perform pm.access_assert_row(''projects.financials'', array[''edit''], ''units'', p_unit); perform pm.access_assert_row(''projects.contract_value'', array[''view''], ''units'', p_unit); end if;', null),
  -- dealer store
  ('open_unit_pdi',           '{p_unit}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit);', null),
  ('register_unit_warranty',  '{p_unit}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit);', null),
  ('reserve_rental',          '{p_unit}',     'perform pm.access_assert_row(''projects.store'', array[''create''], ''assets'', p_unit);', null),
  ('check_out_rental',        '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract);', null),
  ('check_in_rental',         '{p_contract,p_damage_cents}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract); if coalesce(p_damage_cents, 0) <> 0 then perform pm.access_assert_row(''projects.store'', array[''approve''], ''rental_contracts'', p_contract); perform pm.access_assert_row(''projects.contract_value'', array[''view''], ''rental_contracts'', p_contract); end if;', 'damage charges are money'),
  ('cancel_rental',           '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract);', null),
  ('advance_special_order',   '{p_so}',       'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_special_orders'', p_so);', null),
  ('request_special_order',   '{p_part}',     'perform pm.access_assert_row(''projects.store'', array[''create''], ''parts'', p_part);', null),
  ('set_part_stocking',       '{p_part}',     'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts'', p_part);', null),
  ('supersede_part',          '{p_old,p_new}','perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts'', p_old); perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts'', p_new);', null),
  ('start_parts_count',       '{p_stock_location}','perform pm.access_assert_row(''projects.store'', array[''create''], ''stock_locations'', p_stock_location);', null),
  ('suggest_parts_order',     '{p_stock_location}','perform pm.access_assert_row(''projects.store'', array[''create''], ''stock_locations'', p_stock_location);', null),
  ('resend_dealer_event',     '{p_outbox}',   'if not (pm.access_can_row(''projects.settings'', ''configure'', ''dealer_outbox'', p_outbox) or pm.access_can_row(''projects.billing'', ''post'', ''dealer_outbox'', p_outbox)) then perform pm.access_forbid(''requires projects.settings:configure or projects.billing:post''); end if;', 'seam re-send'),
  -- org-level maintenance RPCs
  ('reconcile_my_billing',    '{}',           'if not pm.can(''projects.billing'', ''view'') then perform pm.access_forbid(''requires projects.billing:view''); end if;', null),
  ('refresh_job_costs',       '{}',           'if not pm.can(''projects.financials'', ''view'') then perform pm.access_forbid(''requires projects.financials:view''); end if;', null)
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- Raw prologues (no once-per-request gate): member calls of dealer_deal_totals answer through the
-- masking wrapper; definer callers (current_user = owner) compute in place.
insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note, kind) values
  ('dealer_deal_totals', '{p_deal}', 'if pm.access_member_role() then return pm.access_dealer_deal_totals_member(p_deal); end if;', 'cost / gross masked for members without financials', 'prologue')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note, kind = excluded.kind;

-- Inject the guard right after the outer BEGIN of every overload of each registered function.
-- Fails loudly (migration error) if a function is missing, is not plpgsql, lacks an argument the
-- guard reads, or the injection point cannot be found.
create or replace function pm.access_apply_rpc_guards() returns integer
language plpgsql
set search_path = pm, core, public
as $$
declare g record; f record; v_def text; v_body_at int; v_rest text; v_begin int; v_new text; n int := 0; v_arg text;
begin
  for g in select * from pm.access_rpc_guards order by function_name loop
    if not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                    where s.nspname = 'pm' and p.proname = g.function_name) then
      raise exception 'PM_ACCESS_GUARD: pm.% does not exist', g.function_name;
    end if;
    for f in
      select p.oid, l.lanname, coalesce(p.proargnames, '{}'::text[]) as argnames
        from pg_proc p join pg_namespace s on s.oid = p.pronamespace join pg_language l on l.oid = p.prolang
       where s.nspname = 'pm' and p.proname = g.function_name
    loop
      if f.lanname <> 'plpgsql' then
        raise exception 'PM_ACCESS_GUARD: pm.% is % (only plpgsql can be guarded)', g.function_name, f.lanname;
      end if;
      foreach v_arg in array g.args loop
        if not (v_arg = any (f.argnames)) then
          raise exception 'PM_ACCESS_GUARD: pm.%(%) has no argument %', g.function_name, f.oid::regprocedure, v_arg;
        end if;
      end loop;
      v_def := pg_get_functiondef(f.oid);
      continue when position('pm_access_guard' in v_def) > 0;   -- already guarded
      -- pg_get_functiondef: header lines, then `AS $tag$` on its own line, then the body.
      v_body_at := regexp_instr(v_def, '\mAS \$[A-Za-z0-9_]*\$', 1, 1, 1);
      if v_body_at = 0 then raise exception 'PM_ACCESS_GUARD: cannot find the body of pm.%', g.function_name; end if;
      v_rest := substr(v_def, v_body_at);
      v_begin := regexp_instr(v_rest, '\mbegin\M', 1, 1, 1, 'i');
      if v_begin = 0 then raise exception 'PM_ACCESS_GUARD: no BEGIN in pm.%', g.function_name; end if;
      v_new := substr(v_def, 1, v_body_at - 1) || substr(v_rest, 1, v_begin - 1)
            || E'\n  -- pm_access_guard (1110_pm_access.sql): capability check before any work\n'
            || case when g.kind = 'guard' then '  if pm.access_guard_enter() then ' || g.guard_sql || E' end if;\n'
                    else '  ' || g.guard_sql || E'\n' end
            || substr(v_rest, v_begin);
      execute v_new;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- D2. Job team view + RPCs (spec §2.4)
-- ----------------------------------------------------------------------------
-- Definer + security_barrier: it joins core.users (not member-readable row by row); rows are
-- class J (reachable jobs only) by its own WHERE.
create or replace view pm.v_job_team with (security_barrier = true) as
select
  jm.job_id,
  jm.membership_id,
  jm.slot,
  coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, u.clerk_user_id) as display_name,
  u.email,
  (select rd.name
     from core.access_assignments a
     join core.role_definitions rd on rd.id = a.role_id
     left join core.role_definitions up on up.id = rd.upstream_template_id
    where a.membership_id = jm.membership_id and a.grant_type = 'role' and a.status = 'active'
      and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
      and coalesce(up.key, rd.key) like 'projects\_%'
    order by pm.access_persona_rank(coalesce(up.key, rd.key)) desc, rd.name
    limit 1) as role_name
from pm.job_members jm
join core.memberships ms on ms.id = jm.membership_id and ms.org_id = jm.org_id
join core.users u on u.id = ms.user_id
where jm.org_id = public.get_org_id()
  and jm.job_id in (select pm.my_job_ids());
comment on view pm.v_job_team is '1110 / spec §2.4: job teams (class J — reachable jobs only).';

create or replace function pm.job_team_upsert(p_job uuid, p_membership uuid, p_slot text) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_loc uuid;
begin
  select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = v_org;
  if v_org is null or v_loc is null then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if not pm.access_is_service()
     and (not exists (select 1 from pm.my_job_ids() x where x = p_job) or not pm.can('projects.team', 'edit', v_loc)) then
    raise exception 'PM_FORBIDDEN: requires projects.team:edit on this job' using errcode = '42501';
  end if;
  if not exists (select 1 from core.memberships m where m.id = p_membership and m.org_id = v_org and m.status = 'active') then
    raise exception 'PM_FORBIDDEN: membership % is not an active seat in the caller''s organization', p_membership using errcode = '42501';
  end if;
  if p_slot is null or p_slot not in ('pm','apm','superintendent','foreman','lead','crew','estimator',
                                      'sales','coordinator','accountant','designer','other') then
    raise exception 'PM_INVALID: unknown job-team slot %', p_slot using errcode = '22023';
  end if;
  insert into pm.job_members (org_id, job_id, membership_id, slot, added_by)
  values (v_org, p_job, p_membership, p_slot, pm.current_user_id())
  on conflict (org_id, job_id, membership_id) do update
    set slot = excluded.slot, added_by = excluded.added_by, added_at = now();
  perform pm.log_activity(v_org, v_loc, p_job, 'job_team.upsert', 'job_members', null,
    format('Job team: %s', p_slot), jsonb_build_object('membership_id', p_membership, 'slot', p_slot));
end $$;

create or replace function pm.job_team_remove(p_job uuid, p_membership uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_loc uuid;
begin
  select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = v_org;
  if v_org is null or v_loc is null then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if not pm.access_is_service()
     and (not exists (select 1 from pm.my_job_ids() x where x = p_job) or not pm.can('projects.team', 'edit', v_loc)) then
    raise exception 'PM_FORBIDDEN: requires projects.team:edit on this job' using errcode = '42501';
  end if;
  delete from pm.job_members where org_id = v_org and job_id = p_job and membership_id = p_membership;
  if found then
    perform pm.log_activity(v_org, v_loc, p_job, 'job_team.remove', 'job_members', null,
      'Removed from job team', jsonb_build_object('membership_id', p_membership));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- I. Backfill (idempotent) + new-owner provisioning
-- ----------------------------------------------------------------------------
-- Does this membership hold any Projects role / permission set (any status but revoked)?
create or replace function pm.access_has_projects_assignment(p_membership uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select exists (
    select 1 from core.access_assignments a
      left join core.role_definitions rd on a.grant_type = 'role' and rd.id = a.role_id
      left join core.permission_sets ps on a.grant_type = 'permission_set' and ps.id = a.permission_set_id
     where a.membership_id = p_membership
       and a.status in ('active', 'pending_approval', 'suspended')
       and coalesce(rd.key, ps.key) like 'projects\_%')
$$;

-- Spec §3 backfill for one tenant:
--   owner / company_admin / admin (normalized like Books) → projects_owner, all companies;
--   any other active internal member → projects_pm + projects_legacy_all_jobs, all companies
--   (deviation 1); client-staff members → the same, on their one client; external / platform
--   seats → nothing (they never held internal Projects access). Only members with NO Projects
--   assignment yet. Then seeds pm.job_members from pm.projects PM / superintendent.
create or replace function pm.access_backfill(p_org uuid) returns integer
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  m record; v_owner uuid; v_pm uuid; v_set uuid; v_loc uuid; v_n int := 0; v_rows int;
begin
  perform pm.access_provision_tenant(p_org);
  select id into v_owner from core.role_definitions where owner_level = 'tenant' and org_id = p_org and key = 'projects_owner';
  select id into v_pm    from core.role_definitions where owner_level = 'tenant' and org_id = p_org and key = 'projects_pm';
  select id into v_set   from core.permission_sets  where owner_level = 'tenant' and org_id = p_org and key = 'projects_legacy_all_jobs';
  if v_owner is null or v_pm is null or v_set is null then return 0; end if;

  for m in
    select ms.id, ms.role, ms.audience from core.memberships ms
     where ms.org_id = p_org and coalesce(ms.status, 'active') = 'active'
     order by ms.created_at, ms.id
  loop
    continue when pm.access_has_projects_assignment(m.id);
    if m.audience = 'internal_staff' then
      if core.rbac_normalize_legacy_role(m.role) = 'company_admin' then
        insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, source, reason, backfill_key)
        values (p_org, m.id, 'role', v_owner, 'all_clients', 'backfill',
                format('Projects deploy backfill: %s → Projects owner (all companies)', m.role), 'projects:role:owner')
        on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
        get diagnostics v_rows = row_count; v_n := v_n + v_rows;
      else
        insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, source, reason, backfill_key)
        values (p_org, m.id, 'role', v_pm, 'all_clients', 'backfill',
                format('Projects deploy backfill: %s → Project manager (all companies)', m.role), 'projects:role:pm')
        on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
        get diagnostics v_rows = row_count; v_n := v_n + v_rows;
        insert into core.access_assignments (org_id, membership_id, grant_type, permission_set_id, scope_type, source, reason, backfill_key)
        values (p_org, m.id, 'permission_set', v_set, 'all_clients', 'backfill',
                'Projects deploy backfill: keeps today''s reach to every job — review and remove', 'projects:set:legacy_all_jobs')
        on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
        get diagnostics v_rows = row_count; v_n := v_n + v_rows;
      end if;
    elsif m.audience = 'client_staff' then
      select a.location_id into v_loc from core.access_assignments a
       where a.membership_id = m.id and a.status = 'active' and a.scope_type = 'client'
       order by a.created_at limit 1;
      continue when v_loc is null;
      insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, source, reason, backfill_key)
      values (p_org, m.id, 'role', v_pm, 'client', v_loc, 'backfill',
              'Projects deploy backfill: client staff → Project manager (their company)', 'projects:role:pm')
      on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
      get diagnostics v_rows = row_count; v_n := v_n + v_rows;
      insert into core.access_assignments (org_id, membership_id, grant_type, permission_set_id, scope_type, location_id, source, reason, backfill_key)
      values (p_org, m.id, 'permission_set', v_set, 'client', v_loc, 'backfill',
              'Projects deploy backfill: keeps today''s reach to every job — review and remove', 'projects:set:legacy_all_jobs')
      on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
      get diagnostics v_rows = row_count; v_n := v_n + v_rows;
    end if;
  end loop;

  -- Job teams from the existing pm.projects people columns (Clerk ids → active seats).
  insert into pm.job_members (org_id, job_id, membership_id, slot, added_by)
  select p.org_id, p.job_id, ms.id, x.slot, 'backfill'
    from pm.projects p
    cross join lateral (values (p.pm_user_id, 'pm'), (p.super_user_id, 'superintendent')) as x(uid, slot)
    join core.users u on u.clerk_user_id = x.uid
    join core.memberships ms on ms.user_id = u.id and ms.org_id = p.org_id and ms.status = 'active'
   where p.org_id = p_org and x.uid is not null
  on conflict (org_id, job_id, membership_id) do nothing;
  return v_n;
end $$;

-- New owner / admin seats get Projects owner as soon as they exist (deviation 7); a seat that stops
-- being an active internal owner / admin loses that automatic grant (manual grants are untouched).
-- Other new members wait for an owner to assign a Projects role.
create or replace function pm.tg_membership_projects_owner() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_owner uuid; a record;
begin
  if coalesce(new.status, 'active') <> 'active' or new.audience is distinct from 'internal_staff'
     or core.rbac_normalize_legacy_role(new.role) is distinct from 'company_admin' then
    for a in select x.id from core.access_assignments x
              where x.membership_id = new.id and x.backfill_key = 'projects:role:owner' and x.status in ('active', 'pending_approval', 'suspended') loop
      perform core.access_end_assignment(a.id, null, 'Projects: seat is no longer an active owner / admin — automatic Projects owner ended');
    end loop;
    return null;
  end if;
  if pm.access_has_projects_assignment(new.id) then return null; end if;
  perform pm.access_provision_tenant(new.org_id);
  select id into v_owner from core.role_definitions where owner_level = 'tenant' and org_id = new.org_id and key = 'projects_owner';
  if v_owner is null then return null; end if;
  -- a re-promoted seat: retire the ended automatic row's key so a fresh grant can take it
  update core.access_assignments set backfill_key = 'projects:role:owner:ended:' || id::text
   where membership_id = new.id and backfill_key = 'projects:role:owner' and status in ('revoked', 'expired');
  insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, source, reason, backfill_key)
  values (new.org_id, new.id, 'role', v_owner, 'all_clients', 'backfill',
          format('Projects: %s seat → Projects owner (all companies)', new.role), 'projects:role:owner')
  on conflict (membership_id, backfill_key) where backfill_key is not null do nothing;
  return null;
end $$;
drop trigger if exists trg_membership_projects_owner on core.memberships;
create trigger trg_membership_projects_owner after insert or update of status, role, audience on core.memberships
  for each row execute function pm.tg_membership_projects_owner();

-- ----------------------------------------------------------------------------
-- J. Apply: registries' own RLS, policies, masks, RPC guards, backfill, grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['access_table_classes', 'access_masked_columns', 'access_rpc_guards', 'access_rpc_allowlist',
                           'access_core_views', 'access_function_rewrites', 'access_seat_exceptions'] loop
    execute format('alter table pm.%I enable row level security', t);
    execute format('drop policy if exists catalog_read on pm.%I', t);
    execute format('create policy catalog_read on pm.%I for select to authenticated using (true)', t);
    execute format('revoke all on table pm.%I from public, anon, authenticated', t);
    execute format('grant select on table pm.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table pm.%I to service_role', t);
  end loop;
end $$;

revoke all on table pm.job_members from public, anon, authenticated;
grant select on table pm.job_members to authenticated;
grant select, insert, update, delete on table pm.job_members to service_role;

select pm.access_apply_policies();
select pm.access_apply_masks();

-- Invoker views that read masked columns / core masters as the caller now read the masked
-- views (e.g. pm.v_job_money → v_change_orders_masked, v_project_list → v_core_jobs_masked,
-- v_parts_on_hand → v_parts_masked); invoker functions that copy costs read definer row readers.
select pm.access_rewrite_views();
select pm.access_apply_function_rewrites();

-- Company members for the Team page (core.users is self-read only): one row per company the
-- caller holds projects.team:view at × active seat of the org × Projects role / set held there
-- (role columns null when the person holds none at that company). Definer + security_barrier.
drop view if exists pm.v_company_team;
create view pm.v_company_team with (security_barrier = true) as
select
  l.id                                                                  as location_id,
  ms.id                                                                 as membership_id,
  ms.user_id,
  coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, u.clerk_user_id) as display_name,
  u.email,
  ms.role                                                               as membership_role,
  ms.audience,
  r.assignment_id,
  r.grant_type,
  r.role_key,
  r.role_name,
  r.scope_type,
  r.effective_to
from core.memberships ms
join core.users u on u.id = ms.user_id
join core.locations l on l.org_id = ms.org_id
join lateral (
  select a.id as assignment_id, a.grant_type, a.scope_type, a.effective_to,
         coalesce(urd.key, rd.key, ups.key, ps.key) as role_key,
         coalesce(rd.name, ps.name)                 as role_name
    from core.access_assignments a
    left join core.role_definitions rd  on a.grant_type = 'role' and rd.id = a.role_id
    left join core.role_definitions urd on urd.id = rd.upstream_template_id and urd.owner_level = 'platform'
    left join core.permission_sets ps   on a.grant_type = 'permission_set' and ps.id = a.permission_set_id
    left join core.permission_sets ups  on ups.id = ps.upstream_template_id and ups.owner_level = 'platform'
   where a.membership_id = ms.id and a.status = 'active'
     and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
     and coalesce(urd.key, rd.key, ups.key, ps.key) like 'projects\_%'
     and (a.scope_type = 'all_clients'
          or (a.scope_type = 'client' and a.location_id = l.id)
          or (a.scope_type = 'client_set' and exists (select 1 from core.client_set_members m
                                                       where m.set_id = a.client_set_id and m.location_id = l.id)))
) r on true
where ms.org_id = public.get_org_id()
  and ms.status = 'active'
  and l.id in (select pm.my_location_ids('projects.team', 'view'));
comment on view pm.v_company_team is
  '1110: Team page — members holding a Projects role / set at the company, with name, email and that role; rows only for companies where the caller holds projects.team:view.';
-- M1: definer views are read-only for members (they are auto-updatable and would write as owner).
revoke all on pm.v_company_team from public, anon, authenticated;
grant select on pm.v_company_team to authenticated, service_role;
revoke all on pm.v_job_team from public, anon, authenticated;
grant select on pm.v_job_team to authenticated, service_role;

-- H1: Projects-only seats (Projects capabilities, no Books / Core / Platform capability) see a
-- core.jobs / core.customers / core.vendors / core.events row only where they hold money or
-- settings rights; every other seat — all Books staff, legacy members without assignments — is
-- unchanged. The Projects app reads these masters through pm.v_core_<table>_masked.
-- "Projects-only seat" is an EXPLICIT, opt-in property of a membership (security re-review):
-- core.memberships.projects_only, default false, set only by service_role or by the definer RPC
-- pm.set_projects_only (projects.team:edit at every company of the seat; never an owner / admin
-- seat). Nothing infers it from grants — Books' legacy-mode members, new owners and backfilled
-- members are never Projects-only. The backfill flags nobody.
alter table core.memberships add column if not exists projects_only boolean not null default false;
comment on column core.memberships.projects_only is
  '1110: opt-in. True = a Projects-only seat: no Books data (projects_only_seat_deny), job-scoped core.jobs. Set via pm.set_projects_only or service_role only; never on owner / admin seats.';
revoke update (projects_only) on core.memberships from public, anon, authenticated;

-- An owner / admin seat can never be Projects-only (also covers later promotions).
create or replace function core.tg_membership_projects_only_guard() returns trigger
language plpgsql
set search_path = core, public, pg_temp
as $$
begin
  if new.projects_only and core.rbac_normalize_legacy_role(new.role) = 'company_admin' then
    new.projects_only := false;
  end if;
  return new;
end $$;
drop trigger if exists trg_membership_projects_only_guard on core.memberships;
create trigger trg_membership_projects_only_guard before insert or update of projects_only, role on core.memberships
  for each row execute function core.tg_membership_projects_only_guard();

-- The ONE helper: the flag on the caller's active membership in the request org, nothing else.
-- STABLE + SECURITY DEFINER; policies call it as `(select core.is_projects_only_seat())` so it runs
-- once per statement.
create or replace function core.is_projects_only_seat() returns boolean
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select not core.client_scope_is_service()
     and coalesce((select ms.projects_only from core.memberships ms where ms.id = core.client_scope_caller_membership()), false)
$$;
comment on function core.is_projects_only_seat() is
  '1110: true when the caller''s active membership is flagged projects_only (opt-in). Used by the projects_only_seat_deny / pm_projects_seat_narrow policies.';
revoke all on function core.is_projects_only_seat() from public, anon;
grant execute on function core.is_projects_only_seat() to authenticated, service_role;

-- Flag / unflag a seat as Projects-only. Org-guarded; the caller needs projects.team:edit at every
-- company the seat is assigned to (at least one company when it has none); never the caller's own
-- seat; never an owner / admin seat.
create or replace function pm.set_projects_only(p_membership uuid, p_on boolean) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m core.memberships%rowtype; v_loc uuid;
begin
  select * into m from core.memberships x where x.id = p_membership;
  if m.id is null or m.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: membership % not found in the caller''s organization', p_membership using errcode = '42501';
  end if;
  if p_on is null then raise exception 'PM_INVALID: p_on is required' using errcode = '22023'; end if;
  if not pm.access_is_service() then
    if m.id = core.client_scope_caller_membership() then
      raise exception 'PM_FORBIDDEN: nobody changes their own seat' using errcode = '42501';
    end if;
    if not pm.can('projects.team', 'edit') then
      raise exception 'PM_FORBIDDEN: requires projects.team:edit' using errcode = '42501';
    end if;
    for v_loc in
      select distinct l.id
        from core.access_assignments a
        join core.locations l on l.org_id = m.org_id
       where a.membership_id = m.id and a.status in ('active', 'pending_approval', 'suspended')
         and (a.scope_type = 'all_clients'
              or (a.scope_type = 'client' and a.location_id = l.id)
              or (a.scope_type = 'client_set' and exists (select 1 from core.client_set_members s where s.set_id = a.client_set_id and s.location_id = l.id)))
    loop
      if not pm.can('projects.team', 'edit', v_loc) then
        raise exception 'PM_FORBIDDEN: requires projects.team:edit at every company of this seat' using errcode = '42501';
      end if;
    end loop;
  end if;
  if p_on and core.rbac_normalize_legacy_role(m.role) = 'company_admin' then
    raise exception 'PM_FORBIDDEN: an owner / admin seat cannot be Projects-only' using errcode = '42501';
  end if;
  update core.memberships set projects_only = p_on where id = m.id;
end $$;

create or replace function pm.access_projects_only_seat() returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$ select not pm.access_is_service() and core.is_projects_only_seat() $$;

do $$
declare t text; v_pred text;
begin
  foreach t in array array['jobs', 'customers', 'vendors', 'events'] loop
    v_pred := case
      when t = 'jobs' then
        '(not (select pm.access_projects_only_seat())
           or id in (select pm.my_money_job_ids(''projects.contract_value''))
           or id in (select pm.my_money_job_ids(''projects.financials'')))'
      when t = 'customers' then
        '(not (select pm.access_projects_only_seat())
           or location_id in (select pm.my_location_ids_any(array[''projects.contract_value'', ''projects.financials''], ''view''))
           or location_id in (select pm.my_location_ids(''projects.settings'', ''configure''))'
        || case when t = 'customers' then
             ' or (location_id is null and ((select pm.can_any(array[''projects.contract_value'', ''projects.financials''], ''view'')) or (select pm.can(''projects.settings'', ''configure''))))'
           else '' end || ')'
      else
        '(not (select pm.access_projects_only_seat())
           or (select pm.can_any(array[''projects.contract_value'', ''projects.financials''], ''view''))
           or (select pm.can(''projects.settings'', ''configure'')))'
      end;
    execute format('drop policy if exists pm_projects_seat_narrow on core.%I', t);
    execute format('create policy pm_projects_seat_narrow on core.%I as restrictive for select to authenticated using %s', t, v_pred);
  end loop;
end $$;

-- Projects-only seats never touch Books data: one RESTRICTIVE policy (all commands) named
-- projects_only_seat_deny on every RLS-enabled table in schema public and core, false for a
-- Projects-only seat and true for everyone else. Exceptions (pm.access_seat_exceptions):
--   exempt    — identity / tenancy / RBAC catalog the Projects app reads as the caller
--               (organizations, locations, memberships, users, employees [pay columns are
--               member-revoked by 167], access_assignments, role / permission-set definitions,
--               versions and grants, client sets, capabilities) and the masters 1110 already
--               narrows (jobs, customers, vendors, events: pm_projects_seat_narrow);
--   narrowed  — shared tables Projects writes: public.documents (only pm.* attachments the seat
--               uploaded or that are linked from a visible pm.document_links row) and
--               public.ai_decisions (only PROJECTS_* features).
-- Books migrations that create a table later must add the policy:
--   select core.apply_projects_only_seat_deny('public.my_new_table');
-- (pm.access_seat_exceptions is created with the other registries, section G.)

-- For Books' future migrations: put the Projects-only-seat deny on one table (idempotent).
create or replace function core.apply_projects_only_seat_deny(p_table regclass) returns void
language plpgsql
set search_path = core, public, pg_temp
as $$
begin
  execute format('drop policy if exists projects_only_seat_deny on %s', p_table);
  execute format('create policy projects_only_seat_deny on %s as restrictive for all to authenticated '
                 'using (not (select core.is_projects_only_seat())) with check (not (select core.is_projects_only_seat()))', p_table);
end $$;
revoke all on function core.apply_projects_only_seat_deny(regclass) from public, anon, authenticated;
grant execute on function core.apply_projects_only_seat_deny(regclass) to service_role;

create or replace function pm.access_apply_seat_policies() returns integer
language plpgsql
set search_path = pm, core, public
as $$
declare t record; v_tables text[]; v_t text; v_s text; e record; n int := 0;
begin
  select array_agg(format('%s.%s', n.nspname, c.relname) order by n.nspname, c.relname) into v_tables
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'core') and c.relkind in ('r', 'p') and c.relrowsecurity;
  foreach v_t in array coalesce(v_tables, '{}') loop
    v_s := split_part(v_t, '.', 1);
    select * into e from pm.access_seat_exceptions x where x.schema_name = v_s and x.table_name = split_part(v_t, '.', 2);
    execute format('drop policy if exists projects_only_seat_deny on %I.%I', v_s, split_part(v_t, '.', 2));
    if e.kind = 'exempt' then continue; end if;
    if e.kind = 'narrowed' then
      execute format('create policy projects_only_seat_deny on %I.%I as restrictive for all to authenticated '
                     'using ((not (select core.is_projects_only_seat())) or %s) with check ((not (select core.is_projects_only_seat())) or %s)',
                     v_s, split_part(v_t, '.', 2), e.narrow_pred, e.narrow_pred);
    else
      perform core.apply_projects_only_seat_deny(format('%I.%I', v_s, split_part(v_t, '.', 2))::regclass);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- RLS-enabled public / core tables with neither the deny policy nor an exception (guard test: empty).
create or replace function pm.access_seat_unprotected_tables() returns setof text
language sql stable
set search_path = pm, core, public
as $$
  select format('%s.%s', n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'core') and c.relkind in ('r', 'p') and c.relrowsecurity
     and not exists (select 1 from pm.access_seat_exceptions x where x.schema_name = n.nspname and x.table_name = c.relname and x.kind = 'exempt')
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'projects_only_seat_deny' and not p.polpermissive)
   order by 1
$$;

select pm.access_apply_seat_policies();
select pm.access_apply_rpc_guards();

do $$
declare o record;
begin
  for o in select id from core.organizations loop
    perform pm.access_backfill(o.id);
  end loop;
end $$;

-- Function grants (1100 pattern). Nothing in pm is executable by anon / PUBLIC. 1110's own helpers
-- are service-only except the member surface: the §2.4 contract, the predicate building blocks RLS
-- policies and masked views evaluate as the caller, and the trigger-only row readers.
revoke execute on all functions in schema pm from public, anon;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm'
              and (p.proname like 'access\_%' or p.proname like 'my\_%'
                   or p.proname in ('can','can_any','is_projects_member','tg_job_member_org','tg_membership_projects_owner',
                                    'job_team_upsert','job_team_remove','set_projects_only')) loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm'
              and p.proname in ('my_access','my_location_ids','my_location_ids_any','my_member_location_ids','can','can_any',
                                'is_projects_member','my_employee_ids','my_crew_ids','my_own_job_ids','my_job_ids',
                                'my_job_ids_with','my_job_ids_with_any','my_money_job_ids','access_is_service',
                                'access_persona_rank','access_member_role','access_projects_only_seat','access_strip_keys',
                                'access_deal_money_keys','access_unmasked_price_book_item','access_unmasked_part',
                                'access_unmasked_asset','access_unmasked_deal','access_dealer_deal_totals_member','set_projects_only','access_my_membership','job_team_upsert','job_team_remove') loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

-- ============================================================================
-- end 1110_pm_access
-- ============================================================================
