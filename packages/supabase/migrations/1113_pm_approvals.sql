-- ============================================================================
-- 1113 · Merit Projects — the approvals engine (one queue, one rule set with Books)
--
-- Spec: expert panel seat 06 §2.2 (BP-26…BP-38), §2c rules 4–8 (thresholds by company size,
-- delegation, preparer ≠ approver, audit, one engine), seat 07 §2R (FIN-127/128/130).
-- App: apps/projects/src/lib/approvals (client mirror of the default rules: defaults.ts — a parity
-- test in packages/projects-access/test/approvals.test.ts fails when they drift).
--
-- ONE RULE SET WITH BOOKS (what is reused, what is added)
--   Reused from Books — the same primitives, not copies:
--     * the step model of public.approval_workflow_steps (092 + 165 R-12): step_order, an amount
--       band (min_amount_cents / max_amount_cents, inclusive), approver_capability ('cap:action'),
--       min_approver_limit_cents, require_distinct ("a distinct human per distinct-required step");
--     * approver dollar limits = the `amount_limit.max_per_item_cents` constraint on the person's
--       role / permission-set grants, tightened by the assignment's constraint_overrides (05 §3.4,
--       lib/rbac/limits.ts): the highest limit among the grants that hold the capability, none =
--       unlimited. Limits only NARROW (a role-routed step is never opened by a limit);
--     * preparer ≠ approver is Books' platform rule H6_PREPARER_APPROVER (core.sod_rules, 165) — the
--       refusal text the inbox shows is that rule's description;
--     * the audit stream: every submit / approve / reject / escalate / cancel / reopen / delegation
--       is written to core.action_log (062, the suite's unified action log) with the subject table
--       and id, so a Books GL line that carries the object id drills to the approval that caused it.
--   Not reused (do not fit): public.approval_workflows / _requests / _request_actions. Their
--   doc_type CHECK is the Books document list, members cannot write them (154: service role only;
--   the Projects app never holds a service-role client), and Books' own act route would act on a
--   Projects request through Books' role-rank engine. Projects requests live in pm (below).
--   Added here (missing in Books): company-size defaults, delegation, escalation, multi-step chains
--   with conditional steps (over budget, below the margin floor, overtime), frozen snapshots that
--   reopen on edit, the solo / two-person self-approval exception report, and DB enforcement on
--   every approvable Projects object. Delegations are in pm.approval_delegations, keyed by
--   core.memberships — Books can honour them through pm.approval_delegations_for(membership).
--
-- TABLES (all classified in pm.access_table_classes; org_isolation permissive + class restrictive)
--   S  pm.approval_settings   per company: size bucket (xs ≤5 · s 6–20 · m 21–50 · l 50+ people),
--                             solo_mode (one- or two-person company), margin floor %, escalation
--                             days + escalation roles. A row = the engine is ON for that company.
--   S  pm.approval_rules      object type × amount band × step × approver (roles and / or capability)
--                             × condition; source default (seeded from the size table) | pack
--                             (compiled from pm.approval_policies for stage transitions) | custom
--                             (edited by a settings:configure holder — a reseed keeps custom rows).
--   P  pm.approval_requests   one per routed object (frozen snapshot + hash, preparers, chain state).
--                             Members read only rows they prepared, acted on, can act on now, or
--                             oversee (settings:configure / the object's approve capability on a
--                             reachable job). amount / snapshot / facts are not member-readable:
--                             the app reads them masked through pm.approval_inbox / _detail.
--   P  pm.approval_request_steps  the frozen chain of a request (parent: approval_requests).
--   P  pm.approval_actions    append-only history (parent: approval_requests).
--   P  pm.approval_delegations    out-of-office cover; rows of the delegator / delegate (or
--                             settings:configure). Written only by the RPCs.
--
-- OBJECTS AND THE DB GATE (pm.tg_approval_gate, trigger a0_pm_approval_gate: BEFORE UPDATE, fires first)
--   change_order       pm.change_orders  stage → APPROVED            executes pm.approve_change_order
--   commitment         pm.commitments    DRAFT → APPROVED            pm.approve_commitment
--   commitment_change  pm.commitment_changes DRAFT → APPROVED       pm.approve_commitment_change
--   billing_request    pm.billing_requests DRAFT/REJECTED → EMITTED  pm.approve_and_emit_billing
--   draw               pm.draws          DRAFT/RETURNED → SUBMITTED  pm.submit_draw (internal chain
--                                        before the lender; the lender's own approval stays approve_draw)
--   time_entry         pm.time_entries   → APPROVED                  pm.approve_time_entries
--   estimate           pm.estimates      DRAFT → SENT / ACCEPTED, only below the margin floor
--                                                                    pm.send_estimate
--   budget_transfer    pm.budgets        REVISED DRAFT → APPROVED    (supersede + approve, in here)
--   dealer_deal        pm.dealer_deals   WRITTEN → APPROVED          pm.approve_deal (gross / floor)
--   stage_transition   pm.projects       stage change whose pm.stage_transitions row has an
--                                        approval_policy_key — stage_transitions.approval_policy_key
--                                        is now ENFORCED (it was recorded only, 1100 §15)
--   The gate lets a transition through only when an APPROVED request for that object was executed
--   by the engine in this very transaction (approval_requests.exec_txid = txid_current()) — members
--   cannot write approval_requests, so the gate is unforgeable. Companies without settings (not
--   using Projects) and service_role are not gated. Calling the old RPCs directly now raises
--   PM_APPROVAL_REQUIRED for every gated object; the app routes them through pm.approval_decide.
--
-- PREPARER ≠ APPROVER IN THE DB
--   pm.tg_approval_action_guard (BEFORE INSERT on approval_actions): an APPROVE by anyone in
--   request.preparers (creator / salesperson / worker / explicit submitter) is refused
--   (PM_SOD_VIOLATION) unless the company is in solo_mode, the action is flagged sod_exception,
--   carries a typed reason (≥ 5 characters) and is not made through a delegation. require_distinct
--   steps refuse a person who approved another step of the same round. The exception rows are the
--   Controller's report (pm.approval_exception_report). The object RPCs keep their own SoD check;
--   for a logged solo exception they skip it only when pm.approval_sod_excepted() (the request
--   being executed in this transaction, by this user, is flagged) — their PM_SOD_VIOLATION raises
--   are wrapped in place (pm._approval_patch_sod, the 1110 injection technique).
--
-- DELEGATION (spec §2c rule 5)
--   dates, delegate, optional dollar cap and object types, notify flag. Never self (CHECK + RPC).
--   The delegate acts for the delegator on steps the delegator could approve; never above the
--   delegate's OWN limit (their own grants + amount_limit) or the delegation cap; never on their
--   own items, nor on the delegator's own items; Owner-tier steps need a management delegate
--   (projects_gm / projects_owner). Logged "approved by B for A" (on_behalf_of_membership).
--
-- ESCALATION
--   Each step has due days. pm._approval_escalate (run by every inbox read and by the service
--   cron entry pm.approval_escalate_overdue) marks overdue steps escalated: the step then also
--   opens to the company's escalation roles (default GM, owner) and the item shows "Escalated".
--
-- RPCs (definer, org-guarded, registered in pm.access_rpc_guards): approval_submit, approval_decide,
--   approval_act, approval_act_many, approval_cancel, approval_needed, approval_inbox,
--   approval_request_detail, approval_object_status, approval_set_delegation,
--   approval_revoke_delegation, approval_my_delegations, approval_delegate_candidates,
--   approval_set_company, approval_policy, approval_exception_report. Allowlisted (describe the
--   caller's own access): approval_visible_request_ids, approval_delegations_for. Helpers (pm._*)
--   and trigger functions are service-only.
--
-- DEVIATIONS / JUDGMENT CALLS (reported to the lead)
--   * Roles in the size table map to persona templates: PUR → purchasing, PM → pm, GM → gm,
--     Owner → owner, PA / Controller → project_accountant (Projects has no controller persona),
--     Sales Mgr → gm, Foreman → supervisor. A tier names the lowest role that may approve; higher
--     roles in the same ladder may too (PM tier = PM, GM or owner). Owner is in every ladder.
--   * Lender steps (draws) stay outside the internal chain: the lender's approval is recorded by
--     pm.approve_draw after submission, as before. Payroll lock is not an approval step.
--   * Vendor bills, non-PO bills, credits, refunds are Books objects (Books' own workflows).
--   * Discount approval on deals uses the dealer margin floor (pm.dealer_settings); estimate and
--     change-order floors use approval_settings.margin_floor_pct (default 15 %).
--   * Parallel steps (BP-29 "Next") are not built: rules with the same step order run in sequence;
--     consecutive identical steps collapse into one.
--   * Time entries are approved per entry (bulk in the inbox), not per weekly timesheet.
--
-- Idempotent; PGlite-safe. Apply after 1100–1112.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then
    raise exception '1113 needs 1110_pm_access.sql (pm.access_table_classes) first';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Vocabulary
-- ----------------------------------------------------------------------------
create or replace function pm.approval_object_types() returns text[]
language sql immutable
as $$ select array['change_order','commitment','commitment_change','billing_request','draw','time_entry',
                   'estimate','budget_transfer','dealer_deal','stage_transition']::text[] $$;

-- Object types the inbox may approve in bulk (one look is enough; no reason / review step).
create or replace function pm.approval_bulk_types() returns text[]
language sql immutable
as $$ select array['change_order','commitment','commitment_change','billing_request','time_entry']::text[] $$;

-- The capability:action whose holders approve the object (ANY steps, limits, oversight).
create or replace function pm.approval_object_cap(p_type text) returns text
language sql immutable
as $$
  select case p_type
    when 'change_order'      then 'projects.change_orders:approve'
    when 'commitment'        then 'projects.commitments:approve'
    when 'commitment_change' then 'projects.commitments:approve'
    when 'billing_request'   then 'projects.billing:approve'
    when 'draw'              then 'projects.billing:approve'
    when 'time_entry'        then 'projects.time:approve'
    when 'estimate'          then 'projects.estimates:approve'
    when 'budget_transfer'   then 'projects.financials:edit'
    when 'dealer_deal'       then 'projects.store:approve'
    else null end
$$;

-- The money capability the request amount belongs to (null = not money).
create or replace function pm.approval_money_cap(p_type text) returns text
language sql immutable
as $$
  select case p_type
    when 'change_order'      then 'projects.contract_value'
    when 'commitment'        then 'projects.financials'
    when 'commitment_change' then 'projects.financials'
    when 'billing_request'   then 'projects.contract_value'
    when 'draw'              then 'projects.financials'
    when 'estimate'          then 'projects.contract_value'
    when 'budget_transfer'   then 'projects.financials'
    when 'dealer_deal'       then 'projects.contract_value'
    else null end
$$;

-- Role ladders of the size table (a tier names the lowest role that may approve).
create or replace function pm.approval_role_set(p_set text) returns text[]
language sql immutable
as $$
  select case p_set
    when 'OWNER'      then array['projects_owner']
    when 'GM'         then array['projects_gm','projects_owner']
    when 'SALES_MGR'  then array['projects_gm','projects_owner']
    when 'PM'         then array['projects_pm','projects_gm','projects_owner']
    when 'PUR'        then array['projects_purchasing','projects_pm','projects_gm','projects_owner']
    when 'FOREMAN'    then array['projects_supervisor','projects_pm','projects_gm','projects_owner']
    when 'PA'         then array['projects_project_accountant','projects_owner']
    when 'CONTROLLER' then array['projects_project_accountant','projects_owner']
    when 'PAYROLL'    then array['projects_payroll_admin','projects_owner']
    else '{}'::text[] end
$$;

create or replace function pm.approval_set_label(p_set text) returns text
language sql immutable
as $$
  select case p_set
    when 'OWNER'      then 'Owner'
    when 'GM'         then 'General manager'
    when 'SALES_MGR'  then 'Sales manager'
    when 'PM'         then 'Project manager'
    when 'PUR'        then 'Purchasing'
    when 'FOREMAN'    then 'Foreman'
    when 'PA'         then 'Project accountant'
    when 'CONTROLLER' then 'Controller'
    when 'PAYROLL'    then 'Payroll'
    else 'Any approver' end
$$;

-- Pack tier roles (legacy employee role words) → ladder.
create or replace function pm.approval_map_legacy_role(p_role text) returns text
language sql immutable
as $$
  select case lower(coalesce(p_role, ''))
    when 'owner' then 'OWNER' when 'principal' then 'OWNER' when 'company_admin' then 'OWNER'
    when 'ops_manager' then 'GM' when 'operations_manager' then 'GM' when 'gm' then 'GM' when 'general_manager' then 'GM'
    when 'controller' then 'CONTROLLER' when 'cfo' then 'CONTROLLER' when 'accounting_manager' then 'CONTROLLER'
    when 'pm' then 'PM' when 'project_manager' then 'PM' when 'service_manager' then 'PM'
    when 'superintendent' then 'FOREMAN' when 'foreman' then 'FOREMAN'
    when 'purchasing' then 'PUR' when 'sales_manager' then 'SALES_MGR'
    else 'OWNER' end
$$;

-- The persona template keys an approver step may name.
create or replace function pm.approval_role_keys() returns text[]
language sql immutable
as $$ select array['projects_owner','projects_gm','projects_office_manager','projects_project_accountant','projects_dispatcher',
                   'projects_purchasing','projects_pm','projects_supervisor','projects_labor','projects_sales',
                   'projects_payroll_admin']::text[] $$;

-- ----------------------------------------------------------------------------
-- 2. Default rules by company size (spec §2c rule 4). Mirrored in
--    apps/projects/src/lib/approvals/defaults.ts (parity test). object_type 'commitment' seeds
--    both commitment and commitment_change. Amounts are bigint cents, max inclusive (null = ∞).
--    set ANY = any holder of the object's approve capability.
-- BEGIN APPROVAL DEFAULTS (keep identical to DEFAULT_RULES in defaults.ts)
-- ----------------------------------------------------------------------------
create or replace function pm.approval_default_rules() returns jsonb
language sql immutable
as $$ select $j$[
  {"size":"xs","object_type":"commitment","min":0,"max":1000000,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":2},
  {"size":"xs","object_type":"commitment","min":1000001,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"xs","object_type":"commitment","min":0,"max":null,"step":2,"set":"OWNER","condition":"over_budget","distinct":false,"due_days":2},
  {"size":"s","object_type":"commitment","min":0,"max":1000000,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"s","object_type":"commitment","min":1000001,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"s","object_type":"commitment","min":0,"max":null,"step":2,"set":"OWNER","condition":"over_budget","distinct":false,"due_days":2},
  {"size":"m","object_type":"commitment","min":0,"max":250000,"step":1,"set":"PUR","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"commitment","min":250001,"max":2500000,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"commitment","min":2500001,"max":10000000,"step":1,"set":"GM","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"commitment","min":10000001,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"commitment","min":0,"max":null,"step":2,"set":"GM","condition":"over_budget","distinct":false,"due_days":2},
  {"size":"l","object_type":"commitment","min":0,"max":500000,"step":1,"set":"PUR","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"commitment","min":500001,"max":5000000,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"commitment","min":5000001,"max":25000000,"step":1,"set":"GM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"commitment","min":25000001,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"commitment","min":0,"max":null,"step":2,"set":"GM","condition":"over_budget","distinct":false,"due_days":2},
  {"size":"l","object_type":"commitment","min":5000001,"max":null,"step":3,"set":"CONTROLLER","condition":"over_budget","distinct":true,"due_days":2},
  {"size":"xs","object_type":"change_order","min":0,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"s","object_type":"change_order","min":0,"max":null,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"change_order","min":0,"max":null,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"change_order","min":0,"max":null,"step":2,"set":"GM","condition":"below_margin_floor","distinct":true,"due_days":2},
  {"size":"l","object_type":"change_order","min":0,"max":null,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"change_order","min":5000001,"max":null,"step":2,"set":"GM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"change_order","min":0,"max":null,"step":2,"set":"GM","condition":"below_margin_floor","distinct":true,"due_days":2},
  {"size":"xs","object_type":"estimate","min":0,"max":null,"step":1,"set":"OWNER","condition":"below_margin_floor","distinct":true,"due_days":2},
  {"size":"s","object_type":"estimate","min":0,"max":null,"step":1,"set":"OWNER","condition":"below_margin_floor","distinct":true,"due_days":2},
  {"size":"m","object_type":"estimate","min":0,"max":null,"step":1,"set":"GM","condition":"below_margin_floor","distinct":true,"due_days":2},
  {"size":"l","object_type":"estimate","min":0,"max":null,"step":1,"set":"SALES_MGR","condition":"below_margin_floor","distinct":true,"due_days":2},
  {"size":"l","object_type":"estimate","min":0,"max":null,"step":2,"set":"GM","condition":"below_margin_floor","distinct":true,"due_days":2},
  {"size":"xs","object_type":"dealer_deal","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":1},
  {"size":"xs","object_type":"dealer_deal","min":0,"max":null,"step":2,"set":"OWNER","condition":"below_margin_floor","distinct":false,"due_days":1},
  {"size":"s","object_type":"dealer_deal","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":1},
  {"size":"s","object_type":"dealer_deal","min":0,"max":null,"step":2,"set":"GM","condition":"below_margin_floor","distinct":false,"due_days":1},
  {"size":"m","object_type":"dealer_deal","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":1},
  {"size":"m","object_type":"dealer_deal","min":0,"max":null,"step":2,"set":"GM","condition":"below_margin_floor","distinct":false,"due_days":1},
  {"size":"l","object_type":"dealer_deal","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":1},
  {"size":"l","object_type":"dealer_deal","min":0,"max":null,"step":2,"set":"GM","condition":"below_margin_floor","distinct":false,"due_days":1},
  {"size":"xs","object_type":"budget_transfer","min":0,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"s","object_type":"budget_transfer","min":0,"max":500000,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"s","object_type":"budget_transfer","min":500001,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"budget_transfer","min":0,"max":500000,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"budget_transfer","min":500001,"max":null,"step":1,"set":"GM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"budget_transfer","min":0,"max":500000,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"budget_transfer","min":500001,"max":null,"step":1,"set":"GM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"budget_transfer","min":5000001,"max":null,"step":2,"set":"CONTROLLER","condition":null,"distinct":true,"due_days":2},
  {"size":"xs","object_type":"time_entry","min":0,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":2},
  {"size":"s","object_type":"time_entry","min":0,"max":null,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"time_entry","min":0,"max":null,"step":1,"set":"FOREMAN","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"time_entry","min":0,"max":null,"step":2,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"time_entry","min":0,"max":null,"step":1,"set":"FOREMAN","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"time_entry","min":0,"max":null,"step":2,"set":"PM","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"time_entry","min":0,"max":null,"step":3,"set":"GM","condition":"overtime","distinct":true,"due_days":2},
  {"size":"xs","object_type":"draw","min":0,"max":null,"step":1,"set":"OWNER","condition":null,"distinct":true,"due_days":3},
  {"size":"s","object_type":"draw","min":0,"max":null,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":3},
  {"size":"s","object_type":"draw","min":0,"max":null,"step":2,"set":"OWNER","condition":null,"distinct":true,"due_days":3},
  {"size":"m","object_type":"draw","min":0,"max":null,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":3},
  {"size":"m","object_type":"draw","min":0,"max":null,"step":2,"set":"PA","condition":null,"distinct":true,"due_days":3},
  {"size":"m","object_type":"draw","min":0,"max":null,"step":3,"set":"OWNER","condition":null,"distinct":true,"due_days":3},
  {"size":"l","object_type":"draw","min":0,"max":null,"step":1,"set":"PM","condition":null,"distinct":true,"due_days":3},
  {"size":"l","object_type":"draw","min":0,"max":null,"step":2,"set":"PA","condition":null,"distinct":true,"due_days":3},
  {"size":"l","object_type":"draw","min":0,"max":null,"step":3,"set":"OWNER","condition":null,"distinct":true,"due_days":3},
  {"size":"xs","object_type":"billing_request","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":2},
  {"size":"s","object_type":"billing_request","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":2},
  {"size":"m","object_type":"billing_request","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":2},
  {"size":"l","object_type":"billing_request","min":0,"max":null,"step":1,"set":"ANY","condition":null,"distinct":true,"due_days":2}
]$j$::jsonb $$;
-- END APPROVAL DEFAULTS

-- ----------------------------------------------------------------------------
-- 3. Tables
-- ----------------------------------------------------------------------------
create table if not exists pm.approval_settings (
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id) on delete cascade,
  size_bucket       text not null default 's' check (size_bucket in ('xs','s','m','l')),
  solo_mode         boolean not null default false,
  margin_floor_pct  numeric(5,4) not null default 0.15 check (margin_floor_pct >= 0 and margin_floor_pct < 1),
  escalation_roles  text[] not null default array['projects_gm','projects_owner']::text[],
  seeded_at         timestamptz,
  updated_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (org_id, location_id),
  constraint approval_settings_roles_chk check (escalation_roles <@ pm.approval_role_keys())
);
comment on table pm.approval_settings is
  '1113: approvals engine settings per company (size bucket for the default tiers, solo / two-person self-approval mode, margin floor, escalation roles). A row = the engine is on for the company.';

create table if not exists pm.approval_rules (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id) on delete cascade,
  object_type              text not null,
  policy_key               text,
  min_amount_cents         bigint not null default 0 check (min_amount_cents >= 0),
  max_amount_cents         bigint check (max_amount_cents is null or max_amount_cents >= 0),
  step_order               int not null default 1 check (step_order between 1 and 9),
  role_set                 text,
  approver_roles           text[] not null default '{}',
  approver_capability      text,
  min_approver_limit_cents bigint check (min_approver_limit_cents is null or min_approver_limit_cents >= 0),
  require_distinct         boolean not null default true,
  due_days                 int not null default 2 check (due_days between 1 and 60),
  condition                text check (condition in ('over_budget','below_margin_floor','overtime')),
  label                    text not null default 'Approver' check (char_length(label) between 1 and 80),
  source                   text not null default 'custom' check (source in ('default','pack','custom')),
  is_active                boolean not null default true,
  created_by               text default pm.current_user_id(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint approval_rules_type_chk check (object_type = any (pm.approval_object_types())),
  constraint approval_rules_policy_chk check ((object_type = 'stage_transition') = (policy_key is not null)),
  constraint approval_rules_band_chk check (max_amount_cents is null or max_amount_cents >= min_amount_cents),
  constraint approval_rules_who_chk check (approver_capability is not null or cardinality(approver_roles) > 0),
  constraint approval_rules_roles_chk check (approver_roles <@ pm.approval_role_keys()),
  constraint approval_rules_cap_fmt check (approver_capability is null
    or approver_capability ~ '^projects\.[a-z_]+:(view|create|edit|delete|approve|post|release|export|configure)$')
);
create index if not exists pm_approval_rules_lookup_idx on pm.approval_rules (org_id, location_id, object_type, is_active);
comment on table pm.approval_rules is
  '1113: approval policy rows — object type × amount band (inclusive, bigint cents) × step × approver (persona roles and / or a capability, Books R-12 shape) × condition. Default rows come from the company-size table; custom rows survive a reseed.';

create table if not exists pm.approval_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  job_id          uuid,
  object_type     text not null check (object_type = any (pm.approval_object_types())),
  object_id       uuid not null,
  object_ref      text,
  policy_key      text,
  object_cap      text,
  money_cap       text,
  title           text not null,
  summary         text,
  href            text,
  amount_cents    bigint not null default 0,
  preparers       text[] not null default '{}',
  submitted_by    text,
  snapshot        jsonb not null default '{}'::jsonb,
  snapshot_hash   text not null,
  facts           jsonb not null default '{}'::jsonb,
  facts_money     jsonb not null default '{}'::jsonb,
  status          text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  round           int not null default 1,
  current_step    int not null default 1,
  step_count      int not null default 1,
  due_at          timestamptz,
  decided_at      timestamptz,
  decided_by      text,
  reject_reason   text,
  sod_exception   boolean not null default false,
  exec_txid       bigint,
  exec_user       text,
  exec_result     jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists pm_approval_requests_one_open
  on pm.approval_requests (org_id, object_type, object_id) where status = 'PENDING';
create index if not exists pm_approval_requests_status_idx on pm.approval_requests (org_id, status, location_id);
create index if not exists pm_approval_requests_object_idx on pm.approval_requests (org_id, object_type, object_id, created_at desc);
create index if not exists pm_approval_requests_exec_idx on pm.approval_requests (exec_txid) where exec_txid is not null;
comment on table pm.approval_requests is
  '1113: one approval request per routed Projects object — frozen snapshot (BP-35), preparers (never approvers), chain state. amount / snapshot / facts are read masked through pm.approval_inbox / pm.approval_request_detail.';

create table if not exists pm.approval_request_steps (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  request_id               uuid not null references pm.approval_requests(id) on delete cascade,
  step_order               int not null,
  label                    text not null,
  approver_roles           text[] not null default '{}',
  approver_capability      text,
  min_approver_limit_cents bigint,
  require_distinct         boolean not null default true,
  due_days                 int not null default 2,
  condition                text,
  status                   text not null default 'WAITING' check (status in ('WAITING','PENDING','APPROVED','REJECTED','SKIPPED')),
  due_at                   timestamptz,
  escalated                boolean not null default false,
  escalated_at             timestamptz,
  decided_by               text,
  decided_at               timestamptz,
  on_behalf_of_membership  uuid,
  unique (request_id, step_order)
);

create table if not exists pm.approval_actions (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  request_id               uuid not null references pm.approval_requests(id) on delete cascade,
  round                    int not null default 1,
  step_order               int,
  decision                 text not null check (decision in ('SUBMIT','APPROVE','REJECT','CANCEL','ESCALATE','REOPEN')),
  actor_user               text,
  actor_membership         uuid,
  on_behalf_of_membership  uuid,
  delegation_id            uuid,
  reason                   text check (reason is null or char_length(reason) <= 2000),
  sod_exception            boolean not null default false,
  channel                  text not null default 'web' check (channel in ('web','phone','api','system')),
  acted_at                 timestamptz not null default now()
);
create index if not exists pm_approval_actions_request_idx on pm.approval_actions (request_id, acted_at);
create index if not exists pm_approval_actions_actor_idx on pm.approval_actions (org_id, actor_user, acted_at desc);
create index if not exists pm_approval_actions_exception_idx on pm.approval_actions (org_id, acted_at) where sod_exception;

create table if not exists pm.approval_delegations (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  delegator_membership_id  uuid not null references core.memberships(id) on delete cascade,
  delegate_membership_id   uuid not null references core.memberships(id) on delete cascade,
  starts_at                timestamptz not null,
  ends_at                  timestamptz not null,
  max_amount_cents         bigint check (max_amount_cents is null or max_amount_cents > 0),
  object_types             text[] not null default '{}',
  notify_delegator         boolean not null default true,
  reason                   text check (reason is null or char_length(reason) <= 500),
  created_by               text,
  created_at               timestamptz not null default now(),
  revoked_at               timestamptz,
  revoked_by               text,
  constraint approval_delegations_not_self check (delegator_membership_id <> delegate_membership_id),
  constraint approval_delegations_window check (ends_at > starts_at and ends_at <= starts_at + interval '366 days'),
  constraint approval_delegations_types check (object_types <@ pm.approval_object_types())
);
create index if not exists pm_approval_delegations_delegate_idx on pm.approval_delegations (org_id, delegate_membership_id, ends_at);
create index if not exists pm_approval_delegations_delegator_idx on pm.approval_delegations (org_id, delegator_membership_id, ends_at);
comment on table pm.approval_delegations is
  '1113: out-of-office approval cover (spec §2c rule 5). Never self; capped by amount / object types; never above the delegate''s own limit (enforced where it is used). Books can honour these through pm.approval_delegations_for(membership).';

-- updated_at maintenance
create or replace function pm.tg_approval_touch() returns trigger
language plpgsql
as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_approval_settings_touch on pm.approval_settings;
create trigger trg_approval_settings_touch before update on pm.approval_settings for each row execute function pm.tg_approval_touch();
drop trigger if exists trg_approval_rules_touch on pm.approval_rules;
create trigger trg_approval_rules_touch before update on pm.approval_rules for each row execute function pm.tg_approval_touch();
drop trigger if exists trg_approval_requests_touch on pm.approval_requests;
create trigger trg_approval_requests_touch before update on pm.approval_requests for each row execute function pm.tg_approval_touch();

-- Member edits of rules: validated; an edited default becomes custom (a reseed keeps it).
create or replace function pm.tg_approval_rule_guard() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_cap text; v_act text;
begin
  if new.approver_capability is not null then
    v_cap := split_part(new.approver_capability, ':', 1);
    v_act := split_part(new.approver_capability, ':', 2);
    if not core.capability_has_action(v_cap, v_act) then
      raise exception 'PM_INVALID: % is not a capability with action %', v_cap, v_act using errcode = '23514';
    end if;
  end if;
  if new.org_id is distinct from (select l.org_id from core.locations l where l.id = new.location_id) then
    raise exception 'PM_INVALID: the company is not in this organization' using errcode = '23514';
  end if;
  if current_user in ('authenticated', 'anon') then
    new.source := 'custom';
    if tg_op = 'INSERT' then new.created_by := pm.current_user_id(); end if;
  end if;
  new.approver_roles := array(select distinct x from unnest(new.approver_roles) x order by 1);
  return new;
end $$;
drop trigger if exists trg_approval_rule_guard on pm.approval_rules;
create trigger trg_approval_rule_guard before insert or update on pm.approval_rules for each row execute function pm.tg_approval_rule_guard();

-- ----------------------------------------------------------------------------
-- 4. Grants of a membership (Books limits model) — used for limits and delegators
-- ----------------------------------------------------------------------------
-- One row per (company, assignment × grant) for projects.* capabilities the membership holds
-- through active, in-effect assignments. role_key = the platform template key (cloned roles keep it).
-- limit_cents = least(grant amount_limit, assignment override amount_limit); null = unlimited.
create or replace function pm._approval_member_grants(p_membership uuid)
returns table (location_id uuid, role_key text, capability text, actions text[], limit_cents bigint)
language sql stable security definer
set search_path = pm, core, public
as $$
  with m as (
    select ms.id, ms.org_id from core.memberships ms
     where ms.id = p_membership and coalesce(ms.status, 'active') = 'active'
  ), asg as (
    select a.id, a.org_id, a.grant_type, a.role_id, a.permission_set_id, a.scope_type, a.location_id, a.client_set_id,
           a.read_only, a.muted, a.constraint_overrides,
           coalesce(urd.key, rd.key, ups.key, ps.key) as rkey
      from m
      join core.access_assignments a on a.membership_id = m.id and a.org_id = m.org_id
      left join core.role_definitions rd  on a.grant_type = 'role' and rd.id = a.role_id
      left join core.role_definitions urd on urd.id = rd.upstream_template_id and urd.owner_level = 'platform'
      left join core.permission_sets ps   on a.grant_type = 'permission_set' and ps.id = a.permission_set_id
      left join core.permission_sets ups  on ups.id = ps.upstream_template_id and ups.owner_level = 'platform'
     where a.status = 'active' and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
       and a.scope_type in ('all_clients', 'client', 'client_set')
  ), locs as (
    select asg.id as asg_id, l.id as location_id from asg join core.locations l on l.org_id = asg.org_id where asg.scope_type = 'all_clients'
    union
    select asg.id, l.id from asg join core.locations l on l.id = asg.location_id and l.org_id = asg.org_id where asg.scope_type = 'client'
    union
    select asg.id, l.id from asg join core.client_set_members csm on csm.set_id = asg.client_set_id
      join core.locations l on l.id = csm.location_id and l.org_id = asg.org_id where asg.scope_type = 'client_set'
  ), grants as (
    select asg.id as asg_id, g.capability, g.actions, g.constraints
      from asg
      join core.role_versions v on asg.grant_type = 'role' and v.role_id = asg.role_id and v.state = 'published'
      join core.role_grants g on g.role_version_id = v.id
     where g.capability like 'projects.%'
    union all
    select asg.id, g.capability, g.actions, g.constraints
      from asg
      join core.permission_set_versions v on asg.grant_type = 'permission_set' and v.permission_set_id = asg.permission_set_id and v.state = 'published'
      join core.permission_set_grants g on g.permission_set_version_id = v.id
     where g.capability like 'projects.%'
  )
  select l.location_id, asg.rkey, gr.capability,
         array(select x from unnest(gr.actions) x
                where not (asg.read_only and x not in ('view', 'export'))
                  and not (coalesce(asg.muted -> gr.capability, '[]'::jsonb) ? x)) || array['view']::text[],
         least((gr.constraints -> 'amount_limit' ->> 'max_per_item_cents')::numeric,
               (asg.constraint_overrides -> 'amount_limit' ->> 'max_per_item_cents')::numeric)::bigint
    from asg join grants gr on gr.asg_id = asg.id join locs l on l.asg_id = asg.id
$$;

-- Limits only narrow: true when the membership holds no grant of p_cap at the company (a
-- role-routed step), or holds one without a limit, or its highest limit covers the amount.
create or replace function pm._approval_limit_ok(p_membership uuid, p_location uuid, p_cap text, p_amount bigint)
returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  with g as (
    select x.limit_cents from pm._approval_member_grants(p_membership) x
     where p_cap is not null and x.location_id = p_location
       and x.capability = split_part(p_cap, ':', 1) and split_part(p_cap, ':', 2) = any (x.actions)
  )
  select p_cap is null
      or not exists (select 1 from g)
      or exists (select 1 from g where g.limit_cents is null)
      or (select max(g.limit_cents) from g) >= coalesce(p_amount, 0)
$$;

-- The caller's approval limit for a capability at a company (null = unlimited; -1 = not held).
create or replace function pm._approval_my_limit(p_location uuid, p_cap text) returns bigint
language sql stable security definer
set search_path = pm, core, public
as $$
  with g as (
    select x.limit_cents from pm._approval_member_grants(pm.access_my_membership()) x
     where x.location_id = p_location and x.capability = split_part(p_cap, ':', 1) and split_part(p_cap, ':', 2) = any (x.actions)
  )
  select case when not exists (select 1 from g) then -1
              when exists (select 1 from g where g.limit_cents is null) then null
              else (select max(g.limit_cents) from g) end
$$;

-- Display name of a Clerk user / membership (definer: core.users is not member-readable).
create or replace function pm._approval_user_name(p_user text) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, 'Someone')
    from core.users u where u.clerk_user_id = p_user limit 1
$$;
create or replace function pm._approval_membership_name(p_membership uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, 'Someone')
    from core.memberships ms join core.users u on u.id = ms.user_id where ms.id = p_membership
$$;
create or replace function pm._approval_membership_user(p_membership uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$ select u.clerk_user_id from core.memberships ms join core.users u on u.id = ms.user_id where ms.id = p_membership $$;

-- ----------------------------------------------------------------------------
-- 5. Seeding (company size → default rules; pack policies → stage-transition rules)
-- ----------------------------------------------------------------------------
create or replace function pm._approval_member_count(p_org uuid, p_location uuid) returns int
language sql stable security definer
set search_path = pm, core, public
as $$
  select count(distinct a.membership_id)::int
    from core.access_assignments a
    join core.memberships ms on ms.id = a.membership_id and coalesce(ms.status, 'active') = 'active'
   where a.org_id = p_org and a.status = 'active' and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
     and (a.scope_type = 'all_clients'
          or (a.scope_type = 'client' and a.location_id = p_location)
          or (a.scope_type = 'client_set' and exists (select 1 from core.client_set_members c where c.set_id = a.client_set_id and c.location_id = p_location)))
     and (exists (select 1 from core.role_versions v join core.role_grants g on g.role_version_id = v.id
                   where a.grant_type = 'role' and v.role_id = a.role_id and v.state = 'published' and g.capability like 'projects.%')
          or exists (select 1 from core.permission_set_versions v join core.permission_set_grants g on g.permission_set_version_id = v.id
                      where a.grant_type = 'permission_set' and v.permission_set_id = a.permission_set_id and v.state = 'published'
                        and g.capability like 'projects.%'))
$$;

-- Solo / two-person self-approval is allowed only while the company really is that small: the
-- flag AND at most two active Projects members right now (security review M1: a company that
-- grows loses it automatically).
create or replace function pm._approval_solo(p_org uuid, p_location uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select s.solo_mode from pm.approval_settings s where s.org_id = p_org and s.location_id = p_location), false)
     and pm._approval_member_count(p_org, p_location) <= 2
$$;

create or replace function pm.approval_size_for_count(p_people int) returns text
language sql immutable
as $$ select case when coalesce(p_people, 0) <= 5 then 'xs' when p_people <= 20 then 's' when p_people <= 50 then 'm' else 'l' end $$;

-- (Re)seed one company: settings row + the default rules of its size. Custom and pack rows stay.
create or replace function pm._approval_seed_company(p_org uuid, p_location uuid, p_size text default null, p_solo boolean default null)
returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_n int; v_size text; v_solo boolean;
begin
  v_n := pm._approval_member_count(p_org, p_location);
  v_size := coalesce(p_size, (select s.size_bucket from pm.approval_settings s where s.org_id = p_org and s.location_id = p_location),
                     pm.approval_size_for_count(v_n));
  if v_size not in ('xs','s','m','l') then raise exception 'PM_INVALID: company size must be xs, s, m or l' using errcode = '22023'; end if;
  v_solo := coalesce(p_solo, (select s.solo_mode from pm.approval_settings s where s.org_id = p_org and s.location_id = p_location), v_n <= 2);
  insert into pm.approval_settings as s (org_id, location_id, size_bucket, solo_mode, seeded_at, updated_by)
  values (p_org, p_location, v_size, v_solo, now(), pm.current_user_id())
  on conflict (org_id, location_id) do update
    set size_bucket = excluded.size_bucket, solo_mode = excluded.solo_mode, seeded_at = now(), updated_by = excluded.updated_by;
  delete from pm.approval_rules r where r.org_id = p_org and r.location_id = p_location and r.source = 'default';
  insert into pm.approval_rules (org_id, location_id, object_type, min_amount_cents, max_amount_cents, step_order, role_set,
                                 approver_roles, approver_capability, require_distinct, due_days, condition, label, source)
  select p_org, p_location, t.object_type, (d ->> 'min')::bigint, (d ->> 'max')::bigint, (d ->> 'step')::int, d ->> 'set',
         pm.approval_role_set(d ->> 'set'),
         case when d ->> 'set' = 'ANY' then pm.approval_object_cap(t.object_type) end,
         (d ->> 'distinct')::boolean, (d ->> 'due_days')::int, d ->> 'condition', pm.approval_set_label(d ->> 'set'), 'default'
    from jsonb_array_elements(pm.approval_default_rules()) d
   cross join lateral unnest(case when d ->> 'object_type' = 'commitment' then array['commitment','commitment_change']
                                  else array[d ->> 'object_type'] end) as t(object_type)
   where d ->> 'size' = v_size;
  return v_size;
end $$;

-- Compile a pack approval policy (tiers {max_cents, roles, count}) into stage-transition rules,
-- when a transition of the company references it.
create or replace function pm._approval_sync_pack_policy(p_org uuid, p_location uuid, p_key text) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare pol pm.approval_policies%rowtype; t jsonb; v_min bigint := 0; v_max bigint; v_roles text[]; v_label text; k int; n int := 0; v_r text;
begin
  if p_key is null then return 0; end if;
  delete from pm.approval_rules r where r.org_id = p_org and r.location_id = p_location and r.policy_key = p_key and r.source = 'pack';
  if not exists (select 1 from pm.stage_transitions st where st.org_id = p_org and st.location_id = p_location and st.approval_policy_key = p_key) then
    return 0;
  end if;
  select * into pol from pm.approval_policies a where a.org_id = p_org and a.location_id = p_location and a.key = p_key and a.is_active;
  if not found then return 0; end if;
  for t in select value from jsonb_array_elements(pol.tiers) loop
    v_max := (t ->> 'max_cents')::bigint;
    v_roles := '{}';
    v_label := null;
    for v_r in select jsonb_array_elements_text(coalesce(t -> 'roles', '[]'::jsonb)) loop
      v_roles := v_roles || pm.approval_role_set(pm.approval_map_legacy_role(v_r));
      v_label := coalesce(v_label, pm.approval_set_label(pm.approval_map_legacy_role(v_r)));
    end loop;
    if cardinality(v_roles) = 0 then v_roles := pm.approval_role_set('OWNER'); v_label := 'Owner'; end if;
    for k in 1 .. greatest(coalesce((t ->> 'count')::int, 1), 1) loop
      insert into pm.approval_rules (org_id, location_id, object_type, policy_key, min_amount_cents, max_amount_cents, step_order,
                                     role_set, approver_roles, require_distinct, due_days, label, source)
      values (p_org, p_location, 'stage_transition', p_key, v_min, v_max, least(k, 9), null,
              array(select distinct x from unnest(v_roles) x), true, 2, coalesce(left(pol.label || ' · ' || v_label, 80), 'Approver'), 'pack');
      n := n + 1;
    end loop;
    exit when v_max is null;
    v_min := v_max + 1;
  end loop;
  return n;
end $$;

create or replace function pm.tg_approval_pack_policy_sync() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if tg_table_name = 'approval_policies' then
    if tg_op = 'DELETE' then perform pm._approval_sync_pack_policy(old.org_id, old.location_id, old.key); return null; end if;
    perform pm._approval_sync_pack_policy(new.org_id, new.location_id, new.key);
  else
    if tg_op in ('UPDATE', 'DELETE') and old.approval_policy_key is not null then
      perform pm._approval_sync_pack_policy(old.org_id, old.location_id, old.approval_policy_key);
    end if;
    if tg_op in ('INSERT', 'UPDATE') and new.approval_policy_key is not null then
      perform pm._approval_sync_pack_policy(new.org_id, new.location_id, new.approval_policy_key);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_approval_pack_policy_sync on pm.approval_policies;
create trigger trg_approval_pack_policy_sync after insert or update or delete on pm.approval_policies
  for each row execute function pm.tg_approval_pack_policy_sync();
drop trigger if exists trg_approval_transition_policy_sync on pm.stage_transitions;
create trigger trg_approval_transition_policy_sync after insert or update of approval_policy_key or delete on pm.stage_transitions
  for each row execute function pm.tg_approval_pack_policy_sync();

-- A company that installs a pack gets the engine with its size defaults.
create or replace function pm.tg_approval_pack_install_seed() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.location_id is not null
     and not exists (select 1 from pm.approval_settings s where s.org_id = new.org_id and s.location_id = new.location_id) then
    perform pm._approval_seed_company(new.org_id, new.location_id, null, null);
  end if;
  return null;
end $$;
drop trigger if exists trg_approval_pack_install_seed on pm.pack_installs;
create trigger trg_approval_pack_install_seed after insert on pm.pack_installs
  for each row execute function pm.tg_approval_pack_install_seed();

-- ----------------------------------------------------------------------------
-- 6. Object resolver: what an approvable object is, right now
--    jsonb: found, approvable, why_not, org_id, location_id, job_id, amount_cents, title, summary,
--    href, preparers[], policy_key, snapshot (material fields — its md5 is the frozen hash),
--    facts (conditions, no money), facts_money (money context: overrun, margin …).
-- ----------------------------------------------------------------------------
create or replace function pm._approval_job_label(p_job uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$ select nullif(concat_ws(' · ', j.job_number, j.name), '') from core.jobs j where j.id = p_job $$;

create or replace function pm._approval_floor(p_org uuid, p_location uuid) returns numeric
language sql stable security definer
set search_path = pm, core, public
as $$ select coalesce((select s.margin_floor_pct from pm.approval_settings s where s.org_id = p_org and s.location_id = p_location), 0.15) $$;

-- Effective budget of a job by cost code (latest approved revision, else the approved original).
create or replace function pm._approval_effective_budget(p_org uuid, p_job uuid)
returns table (cost_code_id uuid, amount_cents bigint)
language sql stable security definer
set search_path = pm, core, public
as $$
  with eff as (
    select b.id from pm.budgets b
     where b.org_id = p_org and b.job_id = p_job and b.status = 'APPROVED' and b.kind in ('ORIGINAL','REVISED')
     order by (b.kind = 'REVISED') desc, b.version desc limit 1
  )
  select bl.cost_code_id, sum(bl.amount_cents)::bigint from pm.budget_lines bl where bl.budget_id in (select id from eff) group by 1
$$;

-- Largest cost-code overrun (cents) once p_add ({cost_code_id: cents}) is committed on the job,
-- on top of the job's approved / executed / closed commitments (except p_exclude). 0 = no budget.
create or replace function pm._approval_overrun(p_org uuid, p_job uuid, p_add jsonb, p_exclude uuid default null)
returns bigint
language sql stable security definer
set search_path = pm, core, public
as $$
  with bud as (select * from pm._approval_effective_budget(p_org, p_job)),
  com as (
    select l.cost_code_id, sum(l.amount_cents)::bigint as amt
      from pm.commitment_lines l join pm.commitments c on c.org_id = l.org_id and c.id = l.commitment_id
     where c.org_id = p_org and c.job_id = p_job and c.status in ('APPROVED','EXECUTED','CLOSED')
       and (p_exclude is null or c.id <> p_exclude)
     group by 1
  ),
  ad as (select (e.key)::uuid as cost_code_id, (e.value #>> '{}')::bigint as amt from jsonb_each(coalesce(p_add, '{}'::jsonb)) e)
  select case when not exists (select 1 from bud) then 0::bigint
              else coalesce(max(greatest(coalesce(c.amt, 0) + a.amt - coalesce(b.amount_cents, 0), 0)), 0)::bigint end
    from ad a left join com c on c.cost_code_id = a.cost_code_id left join bud b on b.cost_code_id = a.cost_code_id
$$;

create or replace function pm._approval_object(p_type text, p_id uuid, p_ref text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid := public.get_org_id();
  r record;
  v_loc uuid; v_job uuid; v_amt bigint := 0; v_title text; v_sum text; v_href text; v_prep text[] := '{}';
  v_ok boolean := false; v_why text; v_snap jsonb := '{}'; v_facts jsonb := '{}'; v_money jsonb := '{}';
  v_policy text; v_lines jsonb; v_add jsonb; v_over bigint; v_pct numeric; v_tot jsonb; v_mach text;
  v_tr pm.stage_transitions%rowtype; v_fail text[]; v_label text; v_week numeric; v_emp_user text; v_ds pm.dealer_settings%rowtype;
  v_old bigint; v_new bigint;
begin
  if v_org is null or p_id is null then return jsonb_build_object('found', false); end if;

  if p_type = 'change_order' then
    select co.*, j.location_id as jloc into r from pm.change_orders co join core.jobs j on j.org_id = co.org_id and j.id = co.job_id
     where co.id = p_id and co.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.jloc; v_job := r.job_id; v_amt := abs(r.amount_cents);
    v_ok := r.stage in ('PCO','COR'); v_why := case when not v_ok then format('it is %s', lower(r.stage)) end;
    v_title := concat_ws(' · ', r.number, r.title); v_href := format('/jobs/%s?tab=change-orders', r.job_id);
    v_prep := array_remove(array[r.created_by], null);
    v_snap := jsonb_build_object('number', r.number, 'title', r.title, 'amount_cents', r.amount_cents,
                                 'cost_impact_cents', r.cost_impact_cents, 'description', r.description);
    v_money := jsonb_build_object('amount_cents', r.amount_cents, 'cost_impact_cents', r.cost_impact_cents);
    if r.amount_cents > 0 and r.cost_impact_cents is not null then
      v_pct := round((r.amount_cents - r.cost_impact_cents)::numeric / r.amount_cents, 4);
      v_money := v_money || jsonb_build_object('margin_pct', v_pct);
      v_facts := jsonb_build_object('below_margin_floor', v_pct < pm._approval_floor(v_org, v_loc));
    end if;

  elsif p_type = 'commitment' then
    select c.*, v.name as vendor_name into r from pm.commitments c left join core.vendors v on v.id = c.vendor_id
     where c.id = p_id and c.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.location_id; v_job := r.job_id;
    select coalesce(sum(l.amount_cents), 0),
           coalesce(jsonb_agg(jsonb_build_object('cost_code_id', l.cost_code_id, 'description', l.description, 'amount_cents', l.amount_cents)
                              order by l.line_no, l.id), '[]'::jsonb)
      into v_amt, v_lines from pm.commitment_lines l where l.org_id = v_org and l.commitment_id = r.id;
    select coalesce(jsonb_object_agg(z.cc::text, z.amt), '{}'::jsonb) into v_add
      from (select l.cost_code_id as cc, sum(l.amount_cents) as amt from pm.commitment_lines l
             where l.org_id = v_org and l.commitment_id = r.id and l.cost_code_id is not null group by 1) z;
    v_ok := r.status = 'DRAFT'; v_why := case when not v_ok then format('it is %s', lower(r.status)) end;
    v_title := concat_ws(' · ', r.number, r.title); v_sum := r.vendor_name; v_href := format('/jobs/%s?tab=commitments', r.job_id);
    v_prep := array_remove(array[r.created_by], null);
    v_snap := jsonb_build_object('number', r.number, 'title', r.title, 'vendor_id', r.vendor_id, 'type', r.commitment_type,
                                 'retainage_pct', r.retainage_pct, 'lines', v_lines);
    v_over := pm._approval_overrun(v_org, v_job, v_add, r.id);
    v_facts := jsonb_build_object('over_budget', v_over > 0, 'lines', jsonb_array_length(v_lines));
    v_money := jsonb_build_object('overrun_cents', v_over, 'lines', v_lines);

  elsif p_type = 'commitment_change' then
    select x.*, c.location_id as cloc, c.status as cstatus, c.number as cnumber, l.cost_code_id as line_cc into r
      from pm.commitment_changes x join pm.commitments c on c.org_id = x.org_id and c.id = x.commitment_id
      left join pm.commitment_lines l on l.org_id = x.org_id and l.id = x.commitment_line_id
     where x.id = p_id and x.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.cloc; v_job := r.job_id; v_amt := abs(r.amount_cents);
    v_ok := r.status = 'DRAFT' and r.cstatus in ('APPROVED','EXECUTED');
    v_why := case when r.status <> 'DRAFT' then format('it is %s', lower(r.status))
                  when not v_ok then format('commitment %s is %s', r.cnumber, lower(r.cstatus)) end;
    v_title := concat_ws(' · ', r.number, r.description); v_sum := r.cnumber; v_href := format('/jobs/%s?tab=commitments', r.job_id);
    v_prep := array_remove(array[r.created_by], null);
    v_snap := jsonb_build_object('number', r.number, 'description', r.description, 'amount_cents', r.amount_cents,
                                 'line_id', r.commitment_line_id, 'cost_code_id', r.cost_code_id);
    if coalesce(r.line_cc, r.cost_code_id) is not null and r.amount_cents > 0 then
      v_over := pm._approval_overrun(v_org, v_job, jsonb_build_object(coalesce(r.line_cc, r.cost_code_id)::text, r.amount_cents), null);
    else v_over := 0; end if;
    v_facts := jsonb_build_object('over_budget', v_over > 0);
    v_money := jsonb_build_object('overrun_cents', v_over, 'amount_cents', r.amount_cents);

  elsif p_type = 'billing_request' then
    select b.* into r from pm.billing_requests b where b.id = p_id and b.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.location_id; v_job := r.job_id; v_amt := abs(r.net_cents);
    v_ok := r.status in ('DRAFT','REJECTED'); v_why := case when not v_ok then format('it is %s', lower(r.status)) end;
    v_title := case when r.application_no is not null then format('Pay application #%s', r.application_no)
                    else initcap(replace(lower(coalesce(r.billing_subtype, r.billing_type)), '_', ' ')) || ' billing' end;
    v_href := format('/jobs/%s?tab=billing', r.job_id);
    v_prep := array_remove(array[r.created_by], null);
    select coalesce(jsonb_agg(jsonb_build_object('type', l.line_type, 'description', l.description, 'amount_cents', l.amount_cents)
                              order by l.sort, l.line_no, l.id), '[]'::jsonb)
      into v_lines from pm.billing_request_lines l where l.org_id = v_org and l.billing_request_id = r.id;
    v_snap := jsonb_build_object('net_cents', r.net_cents, 'gross_cents', r.gross_earned_cents, 'retainage_cents', r.retainage_cents,
                                 'period_end', r.period_end, 'lines', v_lines);
    v_facts := jsonb_build_object('lines', jsonb_array_length(v_lines));
    v_money := jsonb_build_object('gross_cents', r.gross_earned_cents, 'retainage_cents', r.retainage_cents, 'lines', v_lines);

  elsif p_type = 'draw' then
    select d.*, j.location_id as jloc into r from pm.draws d join core.jobs j on j.org_id = d.org_id and j.id = d.job_id
     where d.id = p_id and d.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.jloc; v_job := r.job_id;
    select coalesce(sum(l.requested_cents), 0),
           coalesce(jsonb_agg(jsonb_build_object('line_id', l.draw_budget_line_id, 'requested_cents', l.requested_cents,
                                                 'released_cents', l.retainage_released_cents) order by l.draw_budget_line_id), '[]'::jsonb)
      into v_amt, v_lines from pm.draw_lines l where l.org_id = v_org and l.draw_id = r.id;
    v_ok := r.status in ('DRAFT','RETURNED'); v_why := case when not v_ok then format('it is %s', lower(r.status)) end;
    v_title := format('Draw #%s', r.draw_number); v_href := '/draws';
    v_prep := array_remove(array[r.created_by], null);
    v_snap := jsonb_build_object('draw_number', r.draw_number, 'period_end', r.period_end, 'lines', v_lines);
    v_money := jsonb_build_object('lines', v_lines);

  elsif p_type = 'time_entry' then
    select t.*, j.location_id as jloc, e.clerk_user_id as emp_user,
           nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), '') as emp_name into r
      from pm.time_entries t join core.jobs j on j.org_id = t.org_id and j.id = t.job_id
      left join core.employees e on e.id = t.employee_id
     where t.id = p_id and t.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.jloc; v_job := r.job_id; v_amt := 0;
    v_ok := r.approval_state = 'SUBMITTED'; v_why := case when not v_ok then format('it is %s', lower(r.approval_state)) end;
    v_label := coalesce(r.emp_name, pm._approval_user_name(r.user_id), 'Time');
    v_title := format('%s · %s h on %s', v_label, trim(to_char(r.hours, 'FM990.00')), to_char(r.work_date, 'Mon DD'));
    v_href := '/time';
    v_prep := array(select distinct u from unnest(array[r.created_by, r.user_id, r.emp_user]) u where u is not null);
    select coalesce(sum(t2.hours), 0) into v_week from pm.time_entries t2
     where t2.org_id = v_org and t2.approval_state not in ('REJECTED','VOID')
       and date_trunc('week', t2.work_date) = date_trunc('week', r.work_date)
       and ((r.employee_id is not null and t2.employee_id = r.employee_id) or (r.employee_id is null and t2.user_id = r.user_id));
    v_snap := jsonb_build_object('work_date', r.work_date, 'hours', r.hours, 'job_id', r.job_id, 'cost_code_id', r.cost_code_id,
                                 'employee_id', r.employee_id, 'user_id', r.user_id);
    v_facts := jsonb_build_object('hours', r.hours, 'week_hours', v_week, 'overtime', v_week > 50);

  elsif p_type = 'estimate' then
    select e.* into r from pm.estimates e where e.id = p_id and e.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.location_id; v_job := r.job_id; v_amt := abs(r.total_cents);
    v_ok := r.status = 'DRAFT'; v_why := case when not v_ok then format('it is %s', lower(r.status)) end;
    v_title := format('%s v%s · %s', r.number, r.version, r.title); v_href := format('/jobs/%s?tab=estimates', r.job_id);
    v_prep := array_remove(array[r.created_by], null);
    select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'qty', l.qty, 'amount_cents', l.amount_cents,
                                                 'cost_cents', l.cost_cents) order by l.line_no, l.sort, l.id), '[]'::jsonb)
      into v_lines from pm.estimate_lines l where l.org_id = v_org and l.estimate_id = r.id;
    v_snap := jsonb_build_object('number', r.number, 'version', r.version, 'total_cents', r.total_cents,
                                 'cost_total_cents', r.cost_total_cents, 'lines', v_lines);
    v_pct := case when r.total_cents > 0 then round((r.total_cents - r.cost_total_cents)::numeric / r.total_cents, 4) end;
    v_facts := jsonb_build_object('below_margin_floor', v_pct is not null and v_pct < pm._approval_floor(v_org, v_loc));
    v_money := jsonb_build_object('margin_pct', v_pct, 'margin_floor_pct', pm._approval_floor(v_org, v_loc), 'cost_total_cents', r.cost_total_cents);

  elsif p_type = 'budget_transfer' then
    select b.* into r from pm.budgets b where b.id = p_id and b.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    select j.location_id into v_loc from core.jobs j where j.org_id = v_org and j.id = r.job_id;
    v_job := r.job_id;
    v_ok := r.kind = 'REVISED' and r.status = 'DRAFT';
    v_why := case when r.kind <> 'REVISED' then 'only budget revisions route for approval' when not v_ok then format('it is %s', lower(r.status)) end;
    with nw as (select bl.cost_code_id, sum(bl.amount_cents)::bigint as amt from pm.budget_lines bl where bl.org_id = v_org and bl.budget_id = r.id group by 1),
         od as (select * from pm._approval_effective_budget(v_org, r.job_id))
    select coalesce(sum(greatest(coalesce(nw.amt, 0) - coalesce(od.amount_cents, 0), 0)), 0)::bigint,
           coalesce(sum(coalesce(od.amount_cents, 0)), 0)::bigint, coalesce(sum(coalesce(nw.amt, 0)), 0)::bigint,
           coalesce(jsonb_agg(jsonb_build_object('cost_code_id', coalesce(nw.cost_code_id, od.cost_code_id),
                    'from_cents', coalesce(od.amount_cents, 0), 'to_cents', coalesce(nw.amt, 0)) order by coalesce(nw.cost_code_id, od.cost_code_id))
                    filter (where coalesce(nw.amt, 0) <> coalesce(od.amount_cents, 0)), '[]'::jsonb)
      into v_amt, v_old, v_new, v_lines
      from nw full join od on od.cost_code_id = nw.cost_code_id;
    v_title := coalesce(r.label, format('Budget revision %s', r.version)); v_href := format('/jobs/%s?tab=budget', r.job_id);
    v_prep := array_remove(array[r.created_by], null);
    v_snap := jsonb_build_object('budget_id', r.id, 'version', r.version, 'lines',
                (select coalesce(jsonb_agg(jsonb_build_object('cost_code_id', bl.cost_code_id, 'amount_cents', bl.amount_cents) order by bl.cost_code_id, bl.id), '[]'::jsonb)
                   from pm.budget_lines bl where bl.org_id = v_org and bl.budget_id = r.id));
    v_facts := jsonb_build_object('codes_changed', jsonb_array_length(v_lines));
    v_money := jsonb_build_object('moved_cents', v_amt, 'net_change_cents', v_new - v_old, 'changes', v_lines);

  elsif p_type = 'dealer_deal' then
    select d.*, c.name as customer_name into r from pm.dealer_deals d left join core.customers c on c.id = d.customer_id
     where d.id = p_id and d.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.location_id; v_job := null;
    v_tot := pm.dealer_deal_totals(r.id);
    v_amt := abs(coalesce((v_tot ->> 'sale_price_cents')::bigint, 0));
    v_ok := r.stage = 'WRITTEN'; v_why := case when not v_ok then format('it is %s', lower(r.stage)) end;
    v_title := concat_ws(' · ', 'Deal ' || r.number, r.customer_name); v_href := format('/deals/%s', r.id);
    v_prep := array(select distinct u from unnest(array[r.created_by, r.salesperson_user_id]) u where u is not null);
    v_ds := pm.dealer_settings_row(v_org, v_loc);
    v_pct := (v_tot ->> 'front_gross_pct')::numeric;
    v_facts := jsonb_build_object('below_margin_floor',
                 (v_pct is not null and v_pct < v_ds.margin_floor_pct) or coalesce((v_tot ->> 'front_gross_cents')::bigint, 0) < v_ds.min_front_gross_cents);
    v_snap := jsonb_build_object('number', r.number, 'totals', v_tot - 'unit_cost_cents');
    v_money := jsonb_build_object('front_gross_cents', v_tot -> 'front_gross_cents', 'back_gross_cents', v_tot -> 'back_gross_cents',
                                  'front_gross_pct', v_pct, 'margin_floor_pct', v_ds.margin_floor_pct, 'discount_cents', v_tot -> 'discount_cents');

  elsif p_type = 'stage_transition' then
    select p.*, j.job_number into r from pm.projects p join core.jobs j on j.org_id = p.org_id and j.id = p.job_id
     where p.job_id = p_id and p.org_id = v_org;
    if not found then return jsonb_build_object('found', false); end if;
    v_loc := r.location_id; v_job := r.job_id;
    select jt.stage_machine_key into v_mach from pm.job_types jt where jt.org_id = v_org and jt.id = r.job_type_id;
    select * into v_tr from pm.stage_transitions t
     where t.org_id = v_org and t.location_id = r.location_id and t.machine_key = v_mach and t.from_stage = r.stage_key and t.to_stage = p_ref;
    select s.label into v_label from pm.stage_defs s
     where s.org_id = v_org and s.location_id = r.location_id and s.machine_key = v_mach and s.stage_key = p_ref;
    v_title := format('Move %s to %s', coalesce(pm._approval_job_label(r.job_id), 'the job'), coalesce(v_label, p_ref));
    v_href := format('/jobs/%s', r.job_id);
    if v_tr.id is null then
      v_ok := false; v_why := format('the job cannot move from %s to %s', r.stage_key, coalesce(p_ref, '?'));
    else
      v_policy := v_tr.approval_policy_key;
      v_fail := pm.check_guards(r.job_id, v_tr.guards);
      v_ok := cardinality(coalesce(v_fail, '{}')) = 0;
      v_why := case when not v_ok then 'the job still has open items: ' || array_to_string(v_fail, ', ') end;
    end if;
    v_snap := jsonb_build_object('from', r.stage_key, 'to', p_ref);
    v_facts := jsonb_build_object('from', r.stage_key, 'to', p_ref, 'failing_guards', to_jsonb(coalesce(v_fail, '{}'::text[])));
  else
    raise exception 'PM_INVALID: unknown approval object type %', p_type using errcode = '22023';
  end if;

  return jsonb_build_object('found', true, 'approvable', v_ok, 'why_not', v_why, 'org_id', v_org, 'location_id', v_loc, 'job_id', v_job,
    'amount_cents', coalesce(v_amt, 0), 'title', coalesce(v_title, 'Approval'), 'summary', coalesce(v_sum, pm._approval_job_label(v_job)),
    'href', v_href, 'preparers', to_jsonb(coalesce(v_prep, '{}'::text[])), 'policy_key', v_policy,
    'snapshot', v_snap, 'facts', v_facts, 'facts_money', v_money);
end $$;

create or replace function pm._approval_hash(p_snapshot jsonb) returns text
language sql immutable
as $$ select md5(coalesce(p_snapshot, '{}'::jsonb)::text) $$;

-- Does the object need the engine right now? (engine on for the company; estimates only below
-- the floor; stage moves only on transitions that name an approval policy.)
create or replace function pm._approval_needed_for(p_type text, p_obj jsonb) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((p_obj ->> 'found')::boolean, false)
     and exists (select 1 from pm.approval_settings s
                  where s.org_id = (p_obj ->> 'org_id')::uuid and s.location_id = (p_obj ->> 'location_id')::uuid)
     and case p_type
           when 'estimate' then coalesce((p_obj -> 'facts' ->> 'below_margin_floor')::boolean, false)
           when 'stage_transition' then p_obj ->> 'policy_key' is not null
           else true end
$$;

-- ----------------------------------------------------------------------------
-- 7. Chains, eligibility, visibility
-- ----------------------------------------------------------------------------
-- The ordered steps for an amount + facts: matching active rules (band inclusive; a conditional
-- rule only when its fact is true), sorted by step order (base rules first), consecutive identical
-- approvers (same label, roles, capability, floor) collapsed — "Sales manager, then GM" stays two. No matching rule → one step: any holder of the object's approve capability
-- (stage moves: GM or owner).
create or replace function pm._approval_build_chain(p_org uuid, p_location uuid, p_type text, p_policy text, p_amount bigint, p_facts jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r record; v_out jsonb := '[]'::jsonb; v_prev text; v_key text; n int := 0;
begin
  for r in
    select x.* from pm.approval_rules x
     where x.org_id = p_org and x.location_id = p_location and x.is_active and x.object_type = p_type
       and x.policy_key is not distinct from p_policy
       and coalesce(p_amount, 0) >= x.min_amount_cents and (x.max_amount_cents is null or coalesce(p_amount, 0) <= x.max_amount_cents)
       and (x.condition is null or coalesce((p_facts ->> x.condition)::boolean, false))
     order by x.step_order, (x.condition is not null), x.created_at, x.id
  loop
    v_key := r.label || '|' || coalesce(r.approver_capability, '') || '|' || array_to_string(r.approver_roles, ',') || '|' || coalesce(r.min_approver_limit_cents::text, '');
    continue when v_key = v_prev;
    v_prev := v_key;
    n := n + 1;
    exit when n > 9;
    v_out := v_out || jsonb_build_array(jsonb_build_object('step', n, 'label', r.label, 'roles', to_jsonb(r.approver_roles),
      'cap', r.approver_capability, 'floor', r.min_approver_limit_cents, 'distinct', r.require_distinct, 'due_days', r.due_days,
      'condition', r.condition));
  end loop;
  if jsonb_array_length(v_out) = 0 then
    v_out := jsonb_build_array(jsonb_build_object('step', 1,
      'label', case when pm.approval_object_cap(p_type) is null then 'General manager' else 'Any approver' end,
      'roles', case when pm.approval_object_cap(p_type) is null then to_jsonb(pm.approval_role_set('GM')) else '[]'::jsonb end,
      'cap', pm.approval_object_cap(p_type), 'floor', null, 'distinct', true, 'due_days', 2, 'condition', null));
  end if;
  return v_out;
end $$;

-- Who may act on the CURRENT step of pending requests, for the caller: directly (roles at the
-- company, capability + job reach, own limit) or as a delegate (the delegator qualifies; the
-- delegate holds the capability with a limit that covers it; the delegation's cap and object types
-- allow it; Owner-tier needs a management delegate). Preparers never — except the solo / two-person
-- self-approval (self_exception = true; the act requires a typed reason).
create or replace function pm._approval_candidates(p_request uuid default null)
returns table (request_id uuid, step_order int, delegation_id uuid, delegator_membership uuid, self_exception boolean)
language sql stable security definer
set search_path = pm, core, public
as $$
  with me as (select pm.access_my_membership() as mid, pm.current_user_id() as uid),
  ma as materialized (select a.location_id, a.capability, a.actions, a.role_key from pm.my_access() a),
  jobs as materialized (select x as id from pm.my_job_ids() x),
  cur as (
    select r.id, r.org_id, r.location_id, r.job_id, r.object_type, r.object_cap, r.amount_cents, r.preparers, r.round,
           s.step_order, s.approver_capability as cap, s.min_approver_limit_cents as floor, s.require_distinct,
           case when s.escalated and cardinality(s.approver_roles) > 0
                then array(select distinct x from unnest(s.approver_roles || coalesce(st.escalation_roles, '{}'::text[])) x)
                else s.approver_roles end as roles,
           pm._approval_solo(r.org_id, r.location_id) as solo
      from pm.approval_requests r
      join pm.approval_request_steps s on s.request_id = r.id and s.step_order = r.current_step
      left join pm.approval_settings st on st.org_id = r.org_id and st.location_id = r.location_id
     where r.org_id = public.get_org_id() and r.status = 'PENDING' and (p_request is null or r.id = p_request)
  ),
  base as (
    select c.*, me.mid, me.uid,
           (me.uid = any (c.preparers)) as is_prep,
           exists (select 1 from pm.approval_actions x
                    where x.request_id = c.id and x.round = c.round and x.decision = 'APPROVE' and x.actor_user = me.uid
                      and x.step_order <> c.step_order) as approved_other
      from cur c, me
     where me.uid is not null and me.mid is not null
  ),
  direct as (
    select b.id, b.step_order, null::uuid as did, null::uuid as dmid, b.is_prep as self_ex
      from base b
     where (not b.is_prep or b.solo)
       and (not b.require_distinct or b.solo or not b.approved_other)
       and (b.job_id is null or b.job_id in (select id from jobs))
       and exists (select 1 from ma where ma.location_id = b.location_id)
       and (b.cap is null or exists (select 1 from ma where ma.location_id = b.location_id
                                      and ma.capability = split_part(b.cap, ':', 1) and split_part(b.cap, ':', 2) = any (ma.actions)))
       and (cardinality(b.roles) = 0 or exists (select 1 from ma where ma.location_id = b.location_id and ma.role_key = any (b.roles)))
       and pm._approval_limit_ok(b.mid, b.location_id, coalesce(b.cap, b.object_cap), greatest(b.amount_cents, coalesce(b.floor, 0)))
  ),
  deleg as (
    select distinct on (b.id) b.id, b.step_order, d.id as did, d.delegator_membership_id as dmid, false as self_ex
      from base b
      join pm.approval_delegations d
        on d.org_id = b.org_id and d.delegate_membership_id = b.mid and d.revoked_at is null
       and d.starts_at <= now() and d.ends_at > now()
       and (cardinality(d.object_types) = 0 or b.object_type = any (d.object_types))
       and (d.max_amount_cents is null or b.amount_cents <= d.max_amount_cents)
     where not b.is_prep
       and (not b.require_distinct or not b.approved_other)
       and not exists (select 1 from direct x where x.id = b.id)
       and pm._approval_membership_user(d.delegator_membership_id) <> all (b.preparers)
       -- the delegate's own authority: a member of the company; never above their own limit
       and exists (select 1 from ma where ma.location_id = b.location_id)
       and (b.cap is null or exists (select 1 from ma where ma.location_id = b.location_id
                                      and ma.capability = split_part(b.cap, ':', 1) and split_part(b.cap, ':', 2) = any (ma.actions)))
       and (coalesce(b.cap, b.object_cap) is null
            or exists (select 1 from ma where ma.location_id = b.location_id
                        and ma.capability = split_part(coalesce(b.cap, b.object_cap), ':', 1)
                        and split_part(coalesce(b.cap, b.object_cap), ':', 2) = any (ma.actions)))
       and pm._approval_limit_ok(b.mid, b.location_id, coalesce(b.cap, b.object_cap), greatest(b.amount_cents, coalesce(b.floor, 0)))
       -- the delegator qualifies for the step
       and (b.cap is null or exists (select 1 from pm._approval_member_grants(d.delegator_membership_id) g
                                      where g.location_id = b.location_id and g.capability = split_part(b.cap, ':', 1)
                                        and split_part(b.cap, ':', 2) = any (g.actions)))
       and (cardinality(b.roles) = 0 or exists (select 1 from pm._approval_member_grants(d.delegator_membership_id) g
                                                 where g.location_id = b.location_id and g.role_key = any (b.roles)))
       and pm._approval_limit_ok(d.delegator_membership_id, b.location_id, coalesce(b.cap, b.object_cap), greatest(b.amount_cents, coalesce(b.floor, 0)))
       -- Owner-tier items need a management delegate
       and (not (cardinality(b.roles) > 0 and b.roles <@ array['projects_owner']::text[])
            or exists (select 1 from ma where ma.location_id = b.location_id and ma.role_key in ('projects_owner', 'projects_gm')))
     order by b.id, d.created_at
  )
  select id, step_order, did, dmid, self_ex from direct
  union all
  select id, step_order, did, dmid, self_ex from deleg
$$;

-- Requests the caller may read: prepared / submitted, acted on (or acted for them), can act on
-- now, oversee (settings:configure at the company, or the object's approve capability on a
-- reachable job).
create or replace function pm.approval_visible_request_ids() returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  with me as (select pm.access_my_membership() as mid, pm.current_user_id() as uid),
  ma as materialized (select a.location_id, a.capability, a.actions from pm.my_access() a),
  jobs as materialized (select x as id from pm.my_job_ids() x),
  cfg as materialized (select x as id from pm.my_location_ids('projects.settings', 'configure') x)
  select r.id from pm.approval_requests r, me
   where r.org_id = public.get_org_id() and me.uid is not null
     and (me.uid = any (r.preparers) or r.submitted_by = me.uid
          or exists (select 1 from pm.approval_actions x where x.request_id = r.id
                      and (x.actor_user = me.uid or (me.mid is not null and x.on_behalf_of_membership = me.mid)))
          or r.location_id in (select id from cfg)
          or (r.object_cap is not null and (r.job_id is null or r.job_id in (select id from jobs))
              and exists (select 1 from ma where ma.location_id = r.location_id and ma.capability = split_part(r.object_cap, ':', 1)
                           and split_part(r.object_cap, ':', 2) = any (ma.actions)))
          or r.id in (select c.request_id from pm._approval_candidates(null) c))
$$;
comment on function pm.approval_visible_request_ids() is
  '1113: approval requests the caller may read (RLS of approval_requests / steps / actions; the inbox "all" tab).';

-- Active delegations a membership gives or holds (for Books to honour the same cover).
create or replace function pm.approval_delegations_for(p_membership uuid)
returns table (id uuid, delegator_membership_id uuid, delegate_membership_id uuid, starts_at timestamptz, ends_at timestamptz,
               max_amount_cents bigint, object_types text[])
language sql stable security definer
set search_path = pm, core, public
as $$
  select d.id, d.delegator_membership_id, d.delegate_membership_id, d.starts_at, d.ends_at, d.max_amount_cents, d.object_types
    from pm.approval_delegations d
   where d.org_id = public.get_org_id() and d.revoked_at is null and d.starts_at <= now() and d.ends_at > now()
     and (d.delegator_membership_id = p_membership or d.delegate_membership_id = p_membership)
     and (pm.access_is_service() or p_membership = pm.access_my_membership())
$$;

-- ----------------------------------------------------------------------------
-- 8. The DB gate on every approvable object + preparer ≠ approver on the history
-- ----------------------------------------------------------------------------
-- The engine executed an APPROVED request for this object in this transaction.
create or replace function pm._approval_executing(p_org uuid, p_type text, p_id uuid, p_ref text default null) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select exists (select 1 from pm.approval_requests r
                  where r.org_id = p_org and r.object_type = p_type and r.object_id = p_id and r.status = 'APPROVED'
                    and r.exec_txid = txid_current() and (p_ref is null or r.object_ref = p_ref))
$$;

create or replace function pm.tg_approval_gate() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_type text; v_loc uuid; v_job uuid; v_obj uuid; v_ref text; v_mach text; v_key text; v_o jsonb;
begin
  if pm.access_is_service() then return new; end if;
  -- (each branch reads only its own table's columns: plpgsql resolves NEW fields per statement)
  if tg_table_name = 'change_orders' then
    if new.stage = 'APPROVED' and old.stage is distinct from 'APPROVED' then v_type := 'change_order'; v_obj := new.id; v_job := new.job_id; end if;
  elsif tg_table_name = 'commitments' then
    if new.status = 'APPROVED' and old.status = 'DRAFT' then v_type := 'commitment'; v_obj := new.id; v_loc := new.location_id; end if;
  elsif tg_table_name = 'commitment_changes' then
    if new.status = 'APPROVED' and old.status = 'DRAFT' then v_type := 'commitment_change'; v_obj := new.id; v_job := new.job_id; end if;
  elsif tg_table_name = 'billing_requests' then
    -- EMITTED (sent to Books) and UNISSUED / ISSUED (approved where nothing is sent) are all approvals (review M2)
    if new.status in ('EMITTED','UNISSUED','ISSUED') and old.status in ('DRAFT','REJECTED') then v_type := 'billing_request'; v_obj := new.id; v_loc := new.location_id; end if;
  elsif tg_table_name = 'draws' then
    if new.status = 'SUBMITTED' and old.status in ('DRAFT','RETURNED') then v_type := 'draw'; v_obj := new.id; v_job := new.job_id; end if;
  elsif tg_table_name = 'time_entries' then
    if new.approval_state = 'APPROVED' and old.approval_state is distinct from 'APPROVED' then v_type := 'time_entry'; v_obj := new.id; v_job := new.job_id; end if;
  elsif tg_table_name = 'estimates' then
    if new.status in ('SENT','ACCEPTED') and old.status = 'DRAFT' then v_type := 'estimate'; v_obj := new.id; v_loc := new.location_id; end if;
  elsif tg_table_name = 'budgets' then
    if new.kind = 'REVISED' and new.status = 'APPROVED' and old.status = 'DRAFT' then v_type := 'budget_transfer'; v_obj := new.id; v_job := new.job_id; end if;
  elsif tg_table_name = 'dealer_deals' then
    if new.stage = 'APPROVED' and old.stage = 'WRITTEN' then v_type := 'dealer_deal'; v_obj := new.id; v_loc := new.location_id; end if;
  elsif tg_table_name = 'projects' then
    if new.stage_key is distinct from old.stage_key then
      select jt.stage_machine_key into v_mach from pm.job_types jt where jt.org_id = new.org_id and jt.id = new.job_type_id;
      select t.approval_policy_key into v_key from pm.stage_transitions t
       where t.org_id = new.org_id and t.location_id = new.location_id and t.machine_key = v_mach
         and t.from_stage = old.stage_key and t.to_stage = new.stage_key;
      if v_key is not null then
        v_type := 'stage_transition'; v_obj := new.job_id; v_loc := new.location_id; v_ref := new.stage_key;
      end if;
    end if;
  end if;
  if v_type is null then return new; end if;
  if v_loc is null then
    select j.location_id into v_loc from core.jobs j where j.org_id = new.org_id and j.id = v_job;
  end if;
  if not exists (select 1 from pm.approval_settings s where s.org_id = new.org_id and s.location_id = v_loc) then return new; end if;
  if pm._approval_executing(new.org_id, v_type, v_obj, v_ref) then return new; end if;
  if v_type = 'estimate' then
    v_o := pm._approval_object('estimate', v_obj);
    if not coalesce((v_o -> 'facts' ->> 'below_margin_floor')::boolean, false) then return new; end if;
    if exists (select 1 from pm.approval_requests r where r.org_id = new.org_id and r.object_type = 'estimate' and r.object_id = v_obj
                  and r.status = 'APPROVED' and r.snapshot_hash = pm._approval_hash(v_o -> 'snapshot')) then
      return new;
    end if;
  end if;
  raise exception 'PM_APPROVAL_REQUIRED: this % goes through Approvals (an approver in its chain approves it there)', replace(v_type, '_', ' ')
    using errcode = '42501';
end $$;

do $$
declare t record;
begin
  for t in select * from (values
      ('change_orders', 'stage'), ('commitments', 'status'), ('commitment_changes', 'status'), ('billing_requests', 'status'),
      ('draws', 'status'), ('time_entries', 'approval_state'), ('estimates', 'status'), ('budgets', 'status'),
      ('dealer_deals', 'stage'), ('projects', 'stage_key')) v(tbl, col)
  loop
    if to_regclass('pm.' || t.tbl) is not null then
      execute format('drop trigger if exists a0_pm_approval_gate on pm.%I', t.tbl);
      execute format('create trigger a0_pm_approval_gate before update of %I on pm.%I for each row execute function pm.tg_approval_gate()', t.col, t.tbl);
    end if;
  end loop;
end $$;

-- Direct member INSERTs may not create an object already past its approval (security review H2):
-- the engine never inserts, so a member row born APPROVED / EMITTED / SUBMITTED … is refused.
-- Definer code (current_user = owner) and service paths are not affected.
create or replace function pm.tg_approval_insert_gate() returns trigger
language plpgsql   -- invoker: current_user tells a member's direct write from definer code
set search_path = pm, core, public
as $$
declare v_bad boolean := false;
begin
  if current_user::text not in ('authenticated', 'anon') then return new; end if;
  if tg_table_name = 'change_orders' then v_bad := new.stage = 'APPROVED';
  elsif tg_table_name = 'commitments' then v_bad := new.status <> 'DRAFT';
  elsif tg_table_name = 'commitment_changes' then v_bad := new.status <> 'DRAFT';
  elsif tg_table_name = 'billing_requests' then v_bad := new.status not in ('DRAFT');
  elsif tg_table_name = 'draws' then v_bad := new.status not in ('DRAFT');
  elsif tg_table_name = 'time_entries' then v_bad := new.approval_state = 'APPROVED';
  elsif tg_table_name = 'estimates' then v_bad := new.status in ('SENT','ACCEPTED');
  elsif tg_table_name = 'budgets' then v_bad := new.status <> 'DRAFT';
  elsif tg_table_name = 'dealer_deals' then v_bad := new.stage not in ('QUOTE','WRITTEN','LOST');
  end if;
  if v_bad then
    raise exception 'PM_APPROVAL_REQUIRED: a new % starts as a draft and goes through Approvals', replace(tg_table_name, '_', ' ')
      using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['change_orders','commitments','commitment_changes','billing_requests','draws','time_entries',
                           'estimates','budgets','dealer_deals'] loop
    if to_regclass('pm.' || t) is not null then
      execute format('drop trigger if exists a0_pm_approval_insert_gate on pm.%I', t);
      execute format('create trigger a0_pm_approval_insert_gate before insert on pm.%I for each row execute function pm.tg_approval_insert_gate()', t);
    end if;
  end loop;
end $$;

-- Budgets (security review H2): members change only DRAFT budgets — not an approved / superseded
-- one, not its identity (job, kind, version), and not its lines. A draft ORIGINAL may be approved
-- directly (the original budget is not a transfer); a REVISED one only through the engine (gate);
-- superseding an approved revision is the engine's job wherever the engine is on.
create or replace function pm.tg_budget_member_guard() returns trigger
language plpgsql   -- invoker: current_user tells a member's direct write from definer code
set search_path = pm, core, public
as $$
declare v_loc uuid; v_engine boolean;
begin
  if current_user::text not in ('authenticated', 'anon') then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then raise exception 'PM_BUDGET_LOCKED: only a draft budget can be deleted' using errcode = '42501'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    -- the insert gate keeps new rows DRAFT; a job has one live original budget (re-review H1):
    -- once it has one, changes are revisions (which go through the engine)
    if new.kind = 'ORIGINAL' and exists (select 1 from pm.budgets b where b.org_id = new.org_id and b.job_id = new.job_id
                                           and b.kind = 'ORIGINAL' and b.status <> 'SUPERSEDED') then
      raise exception 'PM_BUDGET_LOCKED: this job already has an original budget; start a revision to change it' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.job_id, new.kind, new.version, new.org_id) is distinct from (old.job_id, old.kind, old.version, old.org_id) then
    raise exception 'PM_BUDGET_LOCKED: a budget''s job, kind and version do not change' using errcode = '42501';
  end if;
  if old.status = 'DRAFT' then
    if new.status not in ('DRAFT', 'APPROVED') then
      raise exception 'PM_BUDGET_LOCKED: a draft budget is approved or stays a draft' using errcode = '42501';
    end if;
    -- a member approves an ORIGINAL only as the job's first budget (re-review H1); after that every
    -- change is a revision through the approvals engine
    if new.status = 'APPROVED' and new.kind = 'ORIGINAL' and exists (
         select 1 from pm.budgets b where b.org_id = new.org_id and b.job_id = new.job_id and b.id <> new.id
            and b.kind in ('ORIGINAL', 'REVISED') and b.status in ('APPROVED', 'SUPERSEDED')) then
      raise exception 'PM_APPROVAL_REQUIRED: this job already has an approved budget; changes are a revision and go through Approvals'
        using errcode = '42501';
    end if;
    return new;
  end if;
  -- a non-draft budget: the only member move is superseding an approved revision, and only where
  -- the approvals engine is off for the company (otherwise the engine supersedes it)
  select j.location_id into v_loc from core.jobs j where j.org_id = new.org_id and j.id = new.job_id;
  v_engine := exists (select 1 from pm.approval_settings s where s.org_id = new.org_id and s.location_id = v_loc);
  if not v_engine and old.kind = 'REVISED' and old.status = 'APPROVED' and new.status = 'SUPERSEDED'
     and (to_jsonb(new) - array['status','updated_at']) = (to_jsonb(old) - array['status','updated_at']) then
    return new;
  end if;
  raise exception 'PM_BUDGET_LOCKED: this budget is %; start a revision to change it', lower(old.status) using errcode = '42501';
end $$;
-- One approved ORIGINAL and one approved REVISED budget per job (re-review H1). Repair first:
-- older duplicates become SUPERSEDED (the newest version stays the job's budget).
update pm.budgets b set status = 'SUPERSEDED'
 where b.status = 'APPROVED' and b.kind in ('ORIGINAL', 'REVISED')
   and exists (select 1 from pm.budgets n where n.org_id = b.org_id and n.job_id = b.job_id and n.kind = b.kind
                  and n.status = 'APPROVED' and n.version > b.version);
create unique index if not exists pm_budgets_one_approved_original on pm.budgets (org_id, job_id) where kind = 'ORIGINAL' and status = 'APPROVED';
create unique index if not exists pm_budgets_one_approved_revised on pm.budgets (org_id, job_id) where kind = 'REVISED' and status = 'APPROVED';

drop trigger if exists a1_pm_budget_member_guard on pm.budgets;
create trigger a1_pm_budget_member_guard before insert or update or delete on pm.budgets
  for each row execute function pm.tg_budget_member_guard();

create or replace function pm.tg_budget_line_member_guard() returns trigger
language plpgsql   -- invoker: current_user tells a member's direct write from definer code
set search_path = pm, core, public
as $$
begin
  if current_user::text not in ('authenticated', 'anon') then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') and exists (select 1 from pm.budgets b where b.org_id = old.org_id and b.id = old.budget_id and b.status <> 'DRAFT') then
    raise exception 'PM_BUDGET_LOCKED: lines of an approved budget do not change; start a revision' using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (select 1 from pm.budgets b where b.org_id = new.org_id and b.id = new.budget_id and b.status <> 'DRAFT') then
    raise exception 'PM_BUDGET_LOCKED: lines go on a draft budget; start a revision' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists a1_pm_budget_line_member_guard on pm.budget_lines;
create trigger a1_pm_budget_line_member_guard before insert or update or delete on pm.budget_lines
  for each row execute function pm.tg_budget_line_member_guard();

-- Last material editor of an approvable object (security review H3: "preparer" = created, priced
-- or last materially edited). Triggers on the objects and their lines record the Clerk user who
-- last changed material fields; the engine adds that person to the request's preparers when it
-- opens or restarts, so an approver who edits an item cannot approve their own edit.
create table if not exists pm.approval_object_editors (
  org_id       uuid not null references core.organizations(id) on delete cascade,
  object_type  text not null check (object_type = any (pm.approval_object_types())),
  object_id    uuid not null,
  edited_by    text not null,
  first_at     timestamptz not null default now(),
  edited_at    timestamptz not null default now(),
  primary key (org_id, object_type, object_id, edited_by)
);
comment on table pm.approval_object_editors is
  '1113 (security review H3, re-review H2): EVERY person who materially edited an approvable object (fields or lines), with their last edit time. Written by triggers only; read by the engine. Rows are never removed.';

-- TG_ARGV[0] = object type, TG_ARGV[1] = the column holding the object id ('id' on the object,
-- the parent key on a line table). On the object itself only material columns count.
create or replace function pm.tg_approval_editor() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_uid text := pm.current_user_id(); v_row jsonb; v_old jsonb; v_id uuid; v_org uuid;
  v_skip text[] := array['status','stage','stage_entered_at','approval_state','approved_by','approved_at','approval','approved_totals',
                         'updated_at','event_id','last_emitted_hold','suppressed_reason','sent_at','accepted_at','accepted_by','emitted_at',
                         'issued_at','submitted_at','submitted_by','cost_rate_cents','bill_rate_cents','source_ref','as_of','invoice_id',
                         'invoice_number','gl_entry_id','error_text','declined_at','decline_reason','budget_id','applied_line_id',
                         'reject_reason','void_reason','original_amount_cents','version'];
begin
  if v_uid is null then return null; end if;
  v_row := to_jsonb(coalesce(new, old));
  if tg_argv[1] = 'id' and tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    if (to_jsonb(new) - v_skip) = (v_old - v_skip) then return null; end if;
  end if;
  v_id := (v_row ->> tg_argv[1])::uuid;
  v_org := (v_row ->> 'org_id')::uuid;
  if v_id is null or v_org is null then return null; end if;
  insert into pm.approval_object_editors as e (org_id, object_type, object_id, edited_by, first_at, edited_at)
  values (v_org, tg_argv[0], v_id, v_uid, now(), now())
  on conflict (org_id, object_type, object_id, edited_by) do update set edited_at = excluded.edited_at;
  -- an open request gains the editor as a preparer right away; nobody is ever removed (re-review H2)
  update pm.approval_requests r set preparers = r.preparers || v_uid
   where r.org_id = v_org and r.object_type = tg_argv[0] and r.object_id = v_id and r.status = 'PENDING'
     and not (v_uid = any (r.preparers));
  return null;
end $$;

do $$
declare t record;
begin
  for t in select * from (values
      ('change_orders','change_order','id','update'), ('commitments','commitment','id','update'),
      ('commitment_lines','commitment','commitment_id','insert or update or delete'),
      ('commitment_changes','commitment_change','id','update'), ('billing_requests','billing_request','id','update'),
      ('billing_request_lines','billing_request','billing_request_id','insert or update or delete'),
      ('draws','draw','id','update'), ('draw_lines','draw','draw_id','insert or update or delete'),
      ('time_entries','time_entry','id','update'), ('estimates','estimate','id','update'),
      ('estimate_lines','estimate','estimate_id','insert or update or delete'), ('budgets','budget_transfer','id','update'),
      ('budget_lines','budget_transfer','budget_id','insert or update or delete'), ('dealer_deals','dealer_deal','id','update'),
      ('dealer_deal_lines','dealer_deal','deal_id','insert or update or delete'), ('dealer_trades','dealer_deal','deal_id','insert or update or delete'),
      ('dealer_fi_products','dealer_deal','deal_id','insert or update or delete')) v(tbl, typ, col, ops)
  loop
    if to_regclass('pm.' || t.tbl) is not null then
      execute format('drop trigger if exists zz_pm_approval_editor on pm.%I', t.tbl);
      execute format('create trigger zz_pm_approval_editor after %s on pm.%I for each row execute function pm.tg_approval_editor(%L, %L)',
                     t.ops, t.tbl, t.typ, t.col);
    end if;
  end loop;
end $$;

-- Everyone who materially edited the object since its last finished approval (all of them when it
-- has none): they are its preparers for the next request.
create or replace function pm._approval_editors(p_org uuid, p_type text, p_id uuid) returns text[]
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(array_agg(e.edited_by order by e.first_at), '{}'::text[])
    from pm.approval_object_editors e
   where e.org_id = p_org and e.object_type = p_type and e.object_id = p_id
     and e.edited_at > coalesce((select max(r.decided_at) from pm.approval_requests r
                                  where r.org_id = p_org and r.object_type = p_type and r.object_id = p_id
                                    and r.status in ('APPROVED', 'REJECTED', 'CANCELLED')), '-infinity'::timestamptz)
$$;

-- Is the object RPC running for a logged solo / two-person self-approval? (Read by the wrapped
-- PM_SOD_VIOLATION raises in the object RPCs.)
create or replace function pm.approval_sod_excepted() returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select exists (select 1 from pm.approval_requests r
                  where r.id = pm.access_try_uuid(nullif(current_setting('pm.approval_exec', true), ''))
                    and r.exec_txid = txid_current() and r.sod_exception and r.exec_user = pm.current_user_id())
$$;

-- History is append-only; an APPROVE by a preparer, or by someone who approved another
-- require-distinct step of the round, is refused here whatever wrote it.
create or replace function pm.tg_approval_action_guard() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; v_solo boolean; v_distinct boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if pg_trigger_depth() > 1 then return coalesce(new, old); end if;
    raise exception 'PM_APPROVAL_HISTORY: approval history cannot be changed' using errcode = '42501';
  end if;
  select * into r from pm.approval_requests x where x.id = new.request_id;
  if r.id is null or r.org_id <> new.org_id then raise exception 'PM_INVALID: approval request not found' using errcode = '23514'; end if;
  if new.decision not in ('APPROVE', 'REJECT') then return new; end if;
  if new.actor_user is null then raise exception 'PM_NO_ACTOR: approvals need a named person' using errcode = '42501'; end if;
  v_solo := pm._approval_solo(r.org_id, r.location_id);
  if new.on_behalf_of_membership is not null and not exists (
       select 1 from pm.approval_delegations d where d.id = new.delegation_id and d.org_id = r.org_id
          and d.delegator_membership_id = new.on_behalf_of_membership and d.delegate_membership_id = new.actor_membership
          and d.revoked_at is null and d.starts_at <= now() and d.ends_at > now()) then
    raise exception 'PM_DELEGATION_INVALID: no active delegation covers this approval' using errcode = '42501';
  end if;
  if new.decision = 'APPROVE' then
    if new.actor_user = any (r.preparers) then
      if not (v_solo and new.sod_exception and new.on_behalf_of_membership is null and char_length(btrim(coalesce(new.reason, ''))) >= 5) then
        raise exception 'PM_SOD_VIOLATION: the person who prepared % cannot approve it', r.title using errcode = '42501';
      end if;
    elsif new.sod_exception then
      raise exception 'PM_INVALID: only a preparer''s own approval is a separation-of-duties exception' using errcode = '23514';
    end if;
    select s.require_distinct into v_distinct from pm.approval_request_steps s where s.request_id = r.id and s.step_order = new.step_order;
    if coalesce(v_distinct, true) and not v_solo and exists (
         select 1 from pm.approval_actions x where x.request_id = r.id and x.round = new.round and x.decision = 'APPROVE'
            and x.actor_user = new.actor_user and x.step_order is distinct from new.step_order) then
      raise exception 'PM_APPROVAL_DISTINCT: you approved an earlier step of %; a different person approves this one', r.title using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_approval_action_guard on pm.approval_actions;
create trigger trg_approval_action_guard before insert or update or delete on pm.approval_actions
  for each row execute function pm.tg_approval_action_guard();

-- Wrap every `raise exception 'PM_SOD_VIOLATION: …;` of an object RPC in
-- `if not pm.approval_sod_excepted() then … end if;` (idempotent; keeps the 1110 guard).
create or replace function pm._approval_patch_sod(p_fn text) returns int
language plpgsql
set search_path = pm, core, public
as $$
declare f record; v_def text; v_new text; n int := 0;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'pm' and p.proname = p_fn loop
    v_def := pg_get_functiondef(f.oid);
    continue when position('approval_sod_excepted' in v_def) > 0;
    -- the message literal may hold ';' (1108), so match the literal first, then its arguments
    v_new := regexp_replace(v_def, '(raise exception ''PM_SOD_VIOLATION:(?:[^'']|'''')*''[^;]*;)',
                            'if not pm.approval_sod_excepted() then \1 end if;', 'g');
    if v_new = v_def then raise exception 'PM_APPROVAL_PATCH: no PM_SOD_VIOLATION raise in pm.%', p_fn; end if;
    execute v_new;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Shared audit stream (core.action_log, 062) + the job activity feed.
create or replace function pm._approval_audit(p_req uuid, p_action text, p_summary text, p_meta jsonb default '{}'::jsonb, p_channel text default 'web')
returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; v_uid text := pm.current_user_id(); v_actor uuid; v_table text;
begin
  select * into r from pm.approval_requests where id = p_req;
  if r.id is null then return; end if;
  select u.id into v_actor from core.users u where u.clerk_user_id = v_uid limit 1;
  v_table := case r.object_type
    when 'change_order' then 'pm.change_orders' when 'commitment' then 'pm.commitments' when 'commitment_change' then 'pm.commitment_changes'
    when 'billing_request' then 'pm.billing_requests' when 'draw' then 'pm.draws' when 'time_entry' then 'pm.time_entries'
    when 'estimate' then 'pm.estimates' when 'budget_transfer' then 'pm.budgets' when 'dealer_deal' then 'pm.dealer_deals'
    else 'pm.projects' end;
  insert into core.action_log (org_id, location_id, actor_type, actor_user_id, action, subject_table, subject_id, summary, metadata)
  values (r.org_id, r.location_id, (case when v_uid is null then 'SYSTEM' else 'HUMAN' end)::core.actor_type, v_actor,
          'approval.' || p_action, v_table, r.object_id::text, left(p_summary, 500),
          coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('request_id', r.id, 'object_type', r.object_type, 'round', r.round,
                                                             'step', r.current_step, 'channel', p_channel, 'actor', v_uid,
                                                             'status', r.status));
  perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'approval.' || p_action, 'approval_requests', r.id, left(p_summary, 500),
                          coalesce(p_meta, '{}'::jsonb) - 'amount_cents' || jsonb_build_object('object_type', r.object_type, 'object_id', r.object_id),
                          case when v_uid is null then 'SYSTEM' else 'HUMAN' end);
end $$;

-- ----------------------------------------------------------------------------
-- 9. The engine: open, reopen, act, execute, cancel, escalate
-- ----------------------------------------------------------------------------
create or replace function pm._approval_insert_steps(p_req uuid, p_org uuid, p_chain jsonb) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare st jsonb; n int := 0;
begin
  delete from pm.approval_request_steps where request_id = p_req;
  for st in select value from jsonb_array_elements(p_chain) loop
    n := n + 1;
    insert into pm.approval_request_steps (org_id, request_id, step_order, label, approver_roles, approver_capability,
                                           min_approver_limit_cents, require_distinct, due_days, condition, status, due_at)
    values (p_org, p_req, n, st ->> 'label', array(select jsonb_array_elements_text(coalesce(st -> 'roles', '[]'::jsonb))),
            st ->> 'cap', (st ->> 'floor')::bigint, coalesce((st ->> 'distinct')::boolean, true), coalesce((st ->> 'due_days')::int, 2),
            st ->> 'condition', case when n = 1 then 'PENDING' else 'WAITING' end,
            case when n = 1 then now() + make_interval(days => coalesce((st ->> 'due_days')::int, 2)) end);
  end loop;
  return n;
end $$;

-- The approval summary a step returns to the app (no money).
create or replace function pm._approval_state(p_req uuid, p_status text, p_message text default null, p_result jsonb default null) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object('status', p_status, 'request_id', r.id, 'object_type', r.object_type, 'object_id', r.object_id,
           'title', r.title, 'step', r.current_step, 'step_count', r.step_count, 'request_status', r.status,
           'waiting_on', (select s.label from pm.approval_request_steps s where s.request_id = r.id and s.step_order = r.current_step and r.status = 'PENDING'),
           'self_approval_allowed', pm._approval_solo(r.org_id, r.location_id) and pm.current_user_id() = any (r.preparers),
           'message', p_message, 'result', p_result)
    from pm.approval_requests r where r.id = p_req
$$;

-- Open (or return) the pending request for an object. p_explicit: the caller submits it and so
-- becomes one of its preparers.
create or replace function pm._approval_open(p_type text, p_id uuid, p_ref text, p_explicit boolean, p_channel text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o jsonb; r pm.approval_requests%rowtype; v_uid text := pm.current_user_id(); v_chain jsonb; v_id uuid; v_n int;
  v_prep text[]; v_org uuid; v_loc uuid;
begin
  if v_uid is null then raise exception 'PM_NO_ACTOR: approvals need a named person' using errcode = '42501'; end if;
  o := pm._approval_object(p_type, p_id, p_ref);
  if not coalesce((o ->> 'found')::boolean, false) then
    raise exception 'PM_FORBIDDEN: % % not found in the caller''s organization', p_type, p_id using errcode = '42501';
  end if;
  v_org := (o ->> 'org_id')::uuid; v_loc := (o ->> 'location_id')::uuid;
  select * into r from pm.approval_requests x
   where x.org_id = v_org and x.object_type = p_type and x.object_id = p_id and x.status = 'PENDING' for update;
  if r.id is not null then
    if r.object_ref is distinct from p_ref and p_type = 'stage_transition' then
      raise exception 'PM_APPROVAL_OPEN: % is already waiting for approval to move to %', r.title, r.object_ref using errcode = '22023';
    end if;
    if p_explicit and not (v_uid = any (r.preparers))
       and not exists (select 1 from pm.approval_actions x where x.request_id = r.id and x.round = r.round and x.decision = 'APPROVE') then
      update pm.approval_requests set preparers = preparers || v_uid where id = r.id;
    end if;
    return r.id;
  end if;
  if not coalesce((o ->> 'approvable')::boolean, false) then
    raise exception 'PM_APPROVAL_NOT_READY: % can''t go for approval: %', o ->> 'title', coalesce(o ->> 'why_not', 'it is not waiting for approval')
      using errcode = '22023';
  end if;
  v_chain := pm._approval_build_chain(v_org, v_loc, p_type, o ->> 'policy_key', (o ->> 'amount_cents')::bigint, o -> 'facts');
  v_prep := array(select distinct x from unnest(array(select jsonb_array_elements_text(o -> 'preparers'))
                    || case when p_explicit then array[v_uid] else '{}'::text[] end
                    || pm._approval_editors(v_org, p_type, p_id)) x where x is not null);
  insert into pm.approval_requests (org_id, location_id, job_id, object_type, object_id, object_ref, policy_key, object_cap, money_cap,
                                    title, summary, href, amount_cents, preparers, submitted_by, snapshot, snapshot_hash, facts, facts_money,
                                    status, round, current_step, step_count)
  values (v_org, v_loc, (o ->> 'job_id')::uuid, p_type, p_id, p_ref, o ->> 'policy_key', pm.approval_object_cap(p_type), pm.approval_money_cap(p_type),
          left(o ->> 'title', 300), left(o ->> 'summary', 300), o ->> 'href', (o ->> 'amount_cents')::bigint, v_prep, v_uid,
          o -> 'snapshot', pm._approval_hash(o -> 'snapshot'), coalesce(o -> 'facts', '{}'::jsonb), coalesce(o -> 'facts_money', '{}'::jsonb),
          'PENDING', 1, 1, 1)
  returning id into v_id;
  v_n := pm._approval_insert_steps(v_id, v_org, v_chain);
  update pm.approval_requests set step_count = v_n,
         due_at = (select s.due_at from pm.approval_request_steps s where s.request_id = v_id and s.step_order = 1)
   where id = v_id;
  insert into pm.approval_actions (org_id, request_id, round, step_order, decision, actor_user, actor_membership, channel)
  values (v_org, v_id, 1, 1, 'SUBMIT', v_uid, pm.access_my_membership(), coalesce(p_channel, 'web'));
  perform pm._approval_audit(v_id, 'submitted', format('Sent %s for approval', o ->> 'title'),
                             jsonb_build_object('steps', v_n, 'explicit', p_explicit), coalesce(p_channel, 'web'));
  return v_id;
end $$;

-- Material change since submission: back to step 1 with a fresh snapshot and chain.
create or replace function pm._approval_reopen(p_req uuid, p_obj jsonb, p_why text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; v_chain jsonb; v_n int;
begin
  select * into r from pm.approval_requests where id = p_req for update;
  v_chain := pm._approval_build_chain(r.org_id, r.location_id, r.object_type, p_obj ->> 'policy_key', (p_obj ->> 'amount_cents')::bigint, p_obj -> 'facts');
  update pm.approval_requests
     set round = round + 1, current_step = 1, amount_cents = (p_obj ->> 'amount_cents')::bigint, title = left(p_obj ->> 'title', 300),
         -- whoever changed it is now one of its preparers (review H3)
         preparers = array(select distinct x from unnest(preparers || array(select jsonb_array_elements_text(p_obj -> 'preparers'))
                             || pm._approval_editors(r.org_id, r.object_type, r.object_id)) x where x is not null),
         snapshot = p_obj -> 'snapshot', snapshot_hash = pm._approval_hash(p_obj -> 'snapshot'),
         facts = coalesce(p_obj -> 'facts', '{}'::jsonb), facts_money = coalesce(p_obj -> 'facts_money', '{}'::jsonb)
   where id = r.id;
  v_n := pm._approval_insert_steps(r.id, r.org_id, v_chain);
  update pm.approval_requests set step_count = v_n,
         due_at = (select s.due_at from pm.approval_request_steps s where s.request_id = r.id and s.step_order = 1)
   where id = r.id;
  insert into pm.approval_actions (org_id, request_id, round, step_order, decision, actor_user, actor_membership, reason, channel)
  values (r.org_id, r.id, r.round + 1, 1, 'REOPEN', pm.current_user_id(), pm.access_my_membership(), left(p_why, 2000), 'system');
  perform pm._approval_audit(r.id, 'reopened', format('%s changed since it was submitted; approval starts again', r.title), '{}'::jsonb, 'system');
  return pm._approval_state(r.id, 'reopened', format('%s changed since it was submitted, so its approval started again.', r.title));
end $$;

-- Run the object's own move (nested: the engine's entry guard authorized the request).
create or replace function pm._approval_execute(p_req uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; v_res jsonb; v_uuid uuid; v_n int; v_fail text[]; v_reason text;
begin
  select * into r from pm.approval_requests where id = p_req;
  select x.reason into v_reason from pm.approval_actions x
   where x.request_id = r.id and x.decision = 'APPROVE' order by x.acted_at desc limit 1;
  perform set_config('pm.approval_exec', r.id::text, true);
  if r.object_type = 'change_order' then
    v_uuid := pm.approve_change_order(r.object_id); v_res := jsonb_build_object('event_id', v_uuid);
  elsif r.object_type = 'commitment' then
    v_uuid := pm.approve_commitment(r.object_id); v_res := jsonb_build_object('event_id', v_uuid);
  elsif r.object_type = 'commitment_change' then
    v_uuid := pm.approve_commitment_change(r.object_id); v_res := jsonb_build_object('event_id', v_uuid);
  elsif r.object_type = 'billing_request' then
    v_uuid := pm.approve_and_emit_billing(r.object_id); v_res := jsonb_build_object('event_id', v_uuid);
  elsif r.object_type = 'draw' then
    v_uuid := pm.submit_draw(r.object_id); v_res := jsonb_build_object('draw_id', v_uuid);
  elsif r.object_type = 'time_entry' then
    v_n := pm.approve_time_entries(array[r.object_id]); v_res := jsonb_build_object('approved', v_n);
  elsif r.object_type = 'estimate' then
    v_uuid := pm.send_estimate(r.object_id); v_res := jsonb_build_object('estimate_id', v_uuid, 'sent', true);
  elsif r.object_type = 'budget_transfer' then
    update pm.budgets set status = 'SUPERSEDED'
     where org_id = r.org_id and job_id = r.job_id and kind = 'REVISED' and status = 'APPROVED' and id <> r.object_id;
    update pm.budgets set status = 'APPROVED', as_of = current_date where org_id = r.org_id and id = r.object_id and status = 'DRAFT';
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'PM_APPROVAL_NOT_READY: the budget revision is no longer a draft' using errcode = '22023'; end if;
    perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'budget.revised', 'budgets', r.object_id, format('Approved %s', r.title), '{}'::jsonb);
    v_res := jsonb_build_object('budget_id', r.object_id, 'job_id', r.job_id, 'budget_revised', true);
  elsif r.object_type = 'dealer_deal' then
    v_res := pm.approve_deal(r.object_id, v_reason);
    v_res := jsonb_build_object('rule', v_res ->> 'rule');
  elsif r.object_type = 'stage_transition' then
    v_fail := pm.transition_stage(r.object_id, r.object_ref);
    if cardinality(coalesce(v_fail, '{}')) > 0 then
      raise exception 'PM_APPROVAL_PRECONDITION: the job cannot move yet: %', array_to_string(v_fail, ', ') using errcode = 'P0001';
    end if;
    v_res := jsonb_build_object('moved', true, 'to', r.object_ref);
  end if;
  perform set_config('pm.approval_exec', '', true);
  return coalesce(v_res, '{}'::jsonb);
end $$;

-- Why the caller can't act on the current step (raises; the inbox / API shows the sentence).
create or replace function pm._approval_refuse(p_req uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; s pm.approval_request_steps%rowtype; v_uid text := pm.current_user_id(); v_solo boolean;
begin
  select * into r from pm.approval_requests where id = p_req;
  select * into s from pm.approval_request_steps where request_id = r.id and step_order = r.current_step;
  v_solo := pm._approval_solo(r.org_id, r.location_id);
  if v_uid = any (r.preparers) and not coalesce(v_solo, false) then
    raise exception 'PM_SOD_VIOLATION: %', coalesce((select x.description from core.sod_rules x where x.org_id is null and x.key = 'H6_PREPARER_APPROVER'),
      'The person who prepares an item can never approve it.') using errcode = '42501';
  end if;
  if s.require_distinct and not coalesce(v_solo, false) and exists (select 1 from pm.approval_actions x where x.request_id = r.id and x.round = r.round
       and x.decision = 'APPROVE' and x.actor_user = v_uid and x.step_order <> r.current_step) then
    raise exception 'PM_APPROVAL_DISTINCT: you approved an earlier step of %; a different person approves this one', r.title using errcode = '42501';
  end if;
  raise exception 'PM_APPROVAL_NOT_YOURS: step % of % waits on % (over your approval limit, or not your role or job)',
    r.current_step, r.step_count, coalesce(s.label, 'another approver') using errcode = '42501';
end $$;

-- Approve or reject the current step of a request as the caller.
create or replace function pm._approval_act(p_req uuid, p_decision text, p_reason text, p_self_reason text, p_channel text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; s pm.approval_request_steps%rowtype; o jsonb; c record; v_uid text := pm.current_user_id();
  v_mid uuid := pm.access_my_membership(); v_reason text; v_self boolean; v_result jsonb; v_next pm.approval_request_steps%rowtype;
  v_channel text := coalesce(p_channel, 'web'); v_for text;
begin
  if v_uid is null then raise exception 'PM_NO_ACTOR: approvals need a named person' using errcode = '42501'; end if;
  if p_decision not in ('approve', 'reject') then raise exception 'PM_INVALID: decide approve or reject' using errcode = '22023'; end if;
  if v_channel not in ('web', 'phone', 'api') then v_channel := 'web'; end if;
  select * into r from pm.approval_requests x where x.id = p_req and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: approval request not found' using errcode = '42501'; end if;
  if r.status <> 'PENDING' then
    raise exception 'PM_APPROVAL_CLOSED: % is already %', r.title, lower(r.status) using errcode = '22023';
  end if;

  o := pm._approval_object(r.object_type, r.object_id, r.object_ref);
  if not coalesce((o ->> 'found')::boolean, false) or not coalesce((o ->> 'approvable')::boolean, false) then
    update pm.approval_requests set status = 'CANCELLED', decided_at = now(), reject_reason = coalesce(o ->> 'why_not', 'no longer waiting')
     where id = r.id;
    update pm.approval_request_steps set status = 'SKIPPED' where request_id = r.id and status in ('PENDING', 'WAITING');
    insert into pm.approval_actions (org_id, request_id, round, step_order, decision, actor_user, actor_membership, reason, channel)
    values (r.org_id, r.id, r.round, r.current_step, 'CANCEL', v_uid, v_mid, left(coalesce(o ->> 'why_not', 'no longer waiting'), 2000), 'system');
    perform pm._approval_audit(r.id, 'cancelled', format('%s left the approval queue: %s', r.title, coalesce(o ->> 'why_not', 'no longer waiting')), '{}'::jsonb, 'system');
    return pm._approval_state(r.id, 'cancelled', format('%s is no longer waiting for approval (%s).', r.title, coalesce(o ->> 'why_not', 'it moved on')));
  end if;
  -- only someone who may act on the step decides (or restarts) it
  select * into c from pm._approval_candidates(r.id) x limit 1;
  if c.request_id is null then perform pm._approval_refuse(r.id); end if;
  if pm._approval_hash(o -> 'snapshot') <> r.snapshot_hash then
    return pm._approval_reopen(r.id, o, 'changed since it was submitted');
  end if;
  select * into s from pm.approval_request_steps where request_id = r.id and step_order = r.current_step for update;
  v_for := case when c.delegator_membership is not null then pm._approval_membership_name(c.delegator_membership) end;

  if p_decision = 'reject' then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then raise exception 'PM_APPROVAL_REASON: say why you are sending it back' using errcode = '22023'; end if;
    insert into pm.approval_actions (org_id, request_id, round, step_order, decision, actor_user, actor_membership, on_behalf_of_membership,
                                     delegation_id, reason, channel)
    values (r.org_id, r.id, r.round, r.current_step, 'REJECT', v_uid, v_mid, c.delegator_membership, c.delegation_id, left(v_reason, 2000), v_channel);
    update pm.approval_request_steps set status = 'REJECTED', decided_by = v_uid, decided_at = now(), on_behalf_of_membership = c.delegator_membership
     where id = s.id;
    update pm.approval_request_steps set status = 'SKIPPED' where request_id = r.id and status = 'WAITING';
    update pm.approval_requests set status = 'REJECTED', decided_at = now(), decided_by = v_uid, reject_reason = left(v_reason, 2000) where id = r.id;
    if r.object_type = 'time_entry' then
      update pm.time_entries set approval_state = 'REJECTED' where org_id = r.org_id and id = r.object_id and approval_state = 'SUBMITTED';
    end if;
    perform pm._approval_audit(r.id, 'rejected', format('Sent back %s%s: %s', r.title, coalesce(' for ' || v_for, ''), v_reason),
                               jsonb_build_object('reason', v_reason, 'on_behalf_of', c.delegator_membership), v_channel);
    return pm._approval_state(r.id, 'rejected', format('Sent back %s.', r.title));
  end if;

  v_self := coalesce(c.self_exception, false);
  if v_self then
    v_reason := nullif(btrim(coalesce(p_self_reason, '')), '');
    if v_reason is null or char_length(v_reason) < 5 then
      raise exception 'PM_APPROVAL_SELF_REASON: you prepared %; in a one- or two-person company you may approve it yourself — type why (it goes on the exception report)', r.title
        using errcode = '22023';
    end if;
  else
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  end if;
  insert into pm.approval_actions (org_id, request_id, round, step_order, decision, actor_user, actor_membership, on_behalf_of_membership,
                                   delegation_id, reason, sod_exception, channel)
  values (r.org_id, r.id, r.round, r.current_step, 'APPROVE', v_uid, v_mid, c.delegator_membership, c.delegation_id, left(v_reason, 2000), v_self, v_channel);
  update pm.approval_request_steps set status = 'APPROVED', decided_by = v_uid, decided_at = now(), on_behalf_of_membership = c.delegator_membership
   where id = s.id;

  if r.current_step < r.step_count then
    select * into v_next from pm.approval_request_steps where request_id = r.id and step_order = r.current_step + 1;
    update pm.approval_request_steps set status = 'PENDING', due_at = now() + make_interval(days => v_next.due_days) where id = v_next.id;
    update pm.approval_requests set current_step = current_step + 1, sod_exception = sod_exception or v_self,
           due_at = now() + make_interval(days => v_next.due_days) where id = r.id;
    perform pm._approval_audit(r.id, 'step_approved',
      format('Approved step %s of %s on %s%s; now with %s', r.current_step, r.step_count, r.title, coalesce(' for ' || v_for, ''), v_next.label),
      jsonb_build_object('on_behalf_of', c.delegator_membership, 'sod_exception', v_self), v_channel);
    return pm._approval_state(r.id, 'pending', format('Approved your step. %s now waits on %s.', r.title, v_next.label));
  end if;

  update pm.approval_requests
     set status = 'APPROVED', decided_at = now(), decided_by = v_uid, sod_exception = sod_exception or v_self,
         exec_txid = txid_current(), exec_user = v_uid
   where id = r.id;
  v_result := pm._approval_execute(r.id);
  update pm.approval_requests set exec_result = v_result where id = r.id;
  perform pm._approval_audit(r.id, 'approved', format('Approved %s%s', r.title, coalesce(' for ' || v_for, '')),
                             jsonb_build_object('on_behalf_of', c.delegator_membership, 'sod_exception', v_self, 'result', v_result), v_channel);
  return pm._approval_state(r.id, 'approved', format('Approved %s.', r.title), v_result);
end $$;

-- Overdue current steps open to the company's escalation roles (idempotent; logged once).
create or replace function pm._approval_escalate(p_org uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare x record; n int := 0;
begin
  for x in
    select s.id as step_id, s.step_order, s.label, r.id as req_id, r.org_id, r.round, r.title
      from pm.approval_request_steps s join pm.approval_requests r on r.id = s.request_id
     where (p_org is null or r.org_id = p_org) and r.status = 'PENDING' and s.step_order = r.current_step
       and s.status = 'PENDING' and not s.escalated and s.due_at is not null and s.due_at < now()
     for update of s skip locked
  loop
    update pm.approval_request_steps set escalated = true, escalated_at = now() where id = x.step_id;
    insert into pm.approval_actions (org_id, request_id, round, step_order, decision, reason, channel)
    values (x.org_id, x.req_id, x.round, x.step_order, 'ESCALATE', format('Overdue with %s; now open to the escalation approvers', x.label), 'system');
    perform pm._approval_audit(x.req_id, 'escalated', format('%s is overdue with %s and was escalated', x.title, x.label), '{}'::jsonb, 'system');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Service / cron entry (every org); members get the same through the inbox.
create or replace function pm.approval_escalate_overdue() returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if pm.access_is_service() then return pm._approval_escalate(public.get_org_id()); end if;
  return pm._approval_escalate(coalesce(public.get_org_id(), '00000000-0000-0000-0000-000000000000'::uuid));
end $$;

-- ----------------------------------------------------------------------------
-- 10. Member RPCs (guards injected from pm.access_rpc_guards — section 12)
-- ----------------------------------------------------------------------------
-- Guard helpers: the caller can see the object (its view capability on a reachable job / company).
create or replace function pm._approval_guard_object(p_type text, p_id uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if p_type is null or not (p_type = any (pm.approval_object_types())) then
    raise exception 'PM_INVALID: unknown approval object type %', p_type using errcode = '22023';
  end if;
  case p_type
    when 'change_order'      then perform pm.access_assert_row('projects.change_orders', array['view'], 'change_orders', p_id);
    when 'commitment'        then perform pm.access_assert_row('projects.commitments', array['view'], 'commitments', p_id);
    when 'commitment_change' then perform pm.access_assert_row('projects.commitments', array['view'], 'commitment_changes', p_id);
    when 'billing_request'   then perform pm.access_assert_row('projects.billing', array['view'], 'billing_requests', p_id);
    when 'draw'              then perform pm.access_assert_row('projects.billing', array['view'], 'draws', p_id);
    when 'estimate'          then perform pm.access_assert_row('projects.estimates', array['view'], 'estimates', p_id);
    when 'budget_transfer'   then perform pm.access_assert_row('projects.financials', array['view'], 'budgets', p_id);
    when 'dealer_deal'       then perform pm.access_assert_row('projects.store', array['view'], 'dealer_deals', p_id);
    when 'stage_transition'  then perform pm.access_assert_job('projects.jobs', array['edit'], p_id);   -- moving a job is an edit
    when 'time_entry' then
      if not exists (select 1 from pm.time_entries t where t.id = p_id and t.org_id = public.get_org_id()
                        and (t.employee_id in (select pm.my_employee_ids()) or t.user_id = pm.current_user_id()
                             or t.job_id in (select pm.my_job_ids_with('projects.time', 'view')))) then
        perform pm.access_forbid('time entry not found among your own time or your jobs');
      end if;
  end case;
end $$;

create or replace function pm._approval_guard_request(p_request uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if p_request is null or not exists (select 1 from pm.approval_visible_request_ids() x where x = p_request) then
    perform pm.access_forbid('approval request not found');
  end if;
end $$;

-- Is the object routed through the engine right now? (false → call the object's own RPC.)
create or replace function pm.approval_needed(p_object_type text, p_object_id uuid, p_object_ref text default null) returns boolean
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  return pm._approval_needed_for(p_object_type, pm._approval_object(p_object_type, p_object_id, p_object_ref));
end $$;

-- Explicit submit ("send for approval"): the caller becomes a preparer.
create or replace function pm.approval_submit(p_object_type text, p_object_id uuid, p_object_ref text default null, p_channel text default 'web')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_id uuid;
begin
  if not pm._approval_needed_for(p_object_type, pm._approval_object(p_object_type, p_object_id, p_object_ref)) then
    return jsonb_build_object('status', 'not_needed', 'object_type', p_object_type, 'object_id', p_object_id);
  end if;
  v_id := pm._approval_open(p_object_type, p_object_id, p_object_ref, true, p_channel);
  return pm._approval_state(v_id, 'submitted', 'Sent for approval.');
end $$;

-- The object's Approve / Reject button: opens the request when needed, then records the caller's
-- decision at the current step when they may act; a preparer (or someone outside the chain)
-- just sends it on. Returns status not_needed | submitted | pending | approved | rejected |
-- reopened | cancelled.
create or replace function pm.approval_decide(p_object_type text, p_object_id uuid, p_decision text default 'approve',
                                              p_reason text default null, p_self_reason text default null,
                                              p_object_ref text default null, p_channel text default 'web')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o jsonb; v_id uuid; v_uid text := pm.current_user_id(); r pm.approval_requests%rowtype; v_can boolean; v_self boolean;
begin
  if p_decision not in ('approve', 'reject', 'submit') then raise exception 'PM_INVALID: decide approve, reject or submit' using errcode = '22023'; end if;
  o := pm._approval_object(p_object_type, p_object_id, p_object_ref);
  if not pm._approval_needed_for(p_object_type, o) then
    return jsonb_build_object('status', 'not_needed', 'object_type', p_object_type, 'object_id', p_object_id);
  end if;
  v_id := pm._approval_open(p_object_type, p_object_id, p_object_ref,
                            p_decision = 'submit' or p_object_type = 'stage_transition', p_channel);
  if p_decision = 'submit' then return pm._approval_state(v_id, 'submitted', 'Sent for approval.'); end if;
  select * into r from pm.approval_requests where id = v_id;
  select true, coalesce(c.self_exception, false) into v_can, v_self from pm._approval_candidates(v_id) c limit 1;
  if not coalesce(v_can, false) then
    if p_decision = 'reject' and v_uid = any (r.preparers) then
      return pm.approval_cancel(v_id, p_reason);
    end if;
    return pm._approval_state(v_id, 'submitted', format('%s is waiting on %s.', r.title,
             coalesce((select s.label from pm.approval_request_steps s where s.request_id = r.id and s.step_order = r.current_step), 'an approver')));
  end if;
  if v_self and p_decision = 'approve' and nullif(btrim(coalesce(p_self_reason, '')), '') is null then
    return pm._approval_state(v_id, 'submitted', format('You prepared %s. Type a reason to approve it yourself, or leave it for someone else.', r.title));
  end if;
  return pm._approval_act(v_id, p_decision, p_reason, p_self_reason, p_channel);
end $$;

create or replace function pm.approval_act(p_request uuid, p_decision text, p_reason text default null, p_self_reason text default null,
                                           p_channel text default 'web')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  return pm._approval_act(p_request, p_decision, p_reason, p_self_reason, p_channel);
end $$;

-- Bulk approve / reject from the inbox: each request on its own (one refusal never blocks the
-- rest); bulk only for the object types in pm.approval_bulk_types(); never a self-approval.
create or replace function pm.approval_act_many(p_requests uuid[], p_decision text, p_reason text default null, p_channel text default 'web')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_id uuid; v_out jsonb := '[]'::jsonb; v_res jsonb; v_type text; v_ok int := 0; v_bad int := 0; v_msg text; v_state text;
begin
  if cardinality(coalesce(p_requests, '{}')) = 0 then return jsonb_build_object('results', '[]'::jsonb, 'done', 0, 'refused', 0); end if;
  if cardinality(p_requests) > 100 then raise exception 'PM_INVALID: decide at most 100 approvals at a time' using errcode = '22023'; end if;
  foreach v_id in array (select array_agg(distinct x) from unnest(p_requests) x) loop
    begin
      select r.object_type into v_type from pm.approval_requests r where r.id = v_id and r.org_id = public.get_org_id();
      if v_type is null or not exists (select 1 from pm.approval_visible_request_ids() x where x = v_id) then
        raise exception 'PM_FORBIDDEN: approval request not found' using errcode = '42501';
      end if;
      if p_decision = 'approve' and not (v_type = any (pm.approval_bulk_types())) then
        raise exception 'PM_APPROVAL_NO_BULK: open % to approve it on its own', replace(v_type, '_', ' ') using errcode = '22023';
      end if;
      v_res := pm._approval_act(v_id, p_decision, p_reason, null, p_channel);
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'ok', true, 'status', v_res ->> 'status', 'message', v_res ->> 'message'));
      v_ok := v_ok + 1;
    exception when others then
      get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'ok', false, 'error', v_msg, 'code', v_state));
      v_bad := v_bad + 1;
    end;
  end loop;
  return jsonb_build_object('results', v_out, 'done', v_ok, 'refused', v_bad);
end $$;

-- Withdraw a pending request: a preparer / the submitter, or settings:configure at the company.
create or replace function pm.approval_cancel(p_request uuid, p_reason text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; v_uid text := pm.current_user_id();
begin
  select * into r from pm.approval_requests x where x.id = p_request and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: approval request not found' using errcode = '42501'; end if;
  if r.status <> 'PENDING' then raise exception 'PM_APPROVAL_CLOSED: % is already %', r.title, lower(r.status) using errcode = '22023'; end if;
  if not (v_uid = any (r.preparers) or r.submitted_by = v_uid or pm.can('projects.settings', 'configure', r.location_id)) then
    perform pm.access_forbid('only the person who sent it, or a settings owner, can withdraw it');
  end if;
  update pm.approval_requests set status = 'CANCELLED', decided_at = now(), decided_by = v_uid,
         reject_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = r.id;
  update pm.approval_request_steps set status = 'SKIPPED' where request_id = r.id and status in ('PENDING', 'WAITING');
  insert into pm.approval_actions (org_id, request_id, round, step_order, decision, actor_user, actor_membership, reason, channel)
  values (r.org_id, r.id, r.round, r.current_step, 'CANCEL', v_uid, pm.access_my_membership(), left(nullif(btrim(coalesce(p_reason, '')), ''), 2000), 'web');
  perform pm._approval_audit(r.id, 'cancelled', format('Withdrew %s from approval', r.title), '{}'::jsonb, 'web');
  return pm._approval_state(r.id, 'cancelled', format('Withdrew %s.', r.title));
end $$;

-- One inbox row (amount / money facts only when the caller holds the money capability for it).
create or replace function pm._approval_row(r pm.approval_requests, p_can boolean, p_delegator uuid, p_self boolean, p_money boolean)
returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'id', r.id, 'object_type', r.object_type, 'object_id', r.object_id, 'object_ref', r.object_ref,
    'location_id', r.location_id, 'company', (select l.name from core.locations l where l.id = r.location_id),
    'job_id', r.job_id, 'job_label', pm._approval_job_label(r.job_id),
    'title', r.title, 'summary', r.summary, 'href', r.href, 'status', r.status,
    'amount_cents', case when p_money then r.amount_cents end, 'money_visible', p_money,
    -- over budget / below the floor are derived from money: they follow the money mask
    'facts', case when p_money then r.facts else r.facts - 'over_budget' - 'below_margin_floor' end,
    'facts_money', case when p_money then r.facts_money - 'lines' - 'changes' end,
    'step', r.current_step, 'step_count', r.step_count, 'round', r.round,
    'step_label', s.label, 'escalated', coalesce(s.escalated, false),
    'due_at', r.due_at, 'overdue', r.status = 'PENDING' and r.due_at is not null and r.due_at < now(),
    'submitted_at', r.created_at, 'submitted_by', pm._approval_user_name(r.submitted_by),
    'prepared_by', (select string_agg(coalesce(pm._approval_user_name(u), u), ', ') from unnest(r.preparers) u),
    'decided_at', r.decided_at, 'decided_by', pm._approval_user_name(r.decided_by), 'reject_reason', r.reject_reason,
    'can_act', p_can, 'on_behalf_of', case when p_delegator is not null then pm._approval_membership_name(p_delegator) end,
    'self_approval', coalesce(p_self, false),
    'bulk_ok', coalesce(p_can, false) and not coalesce(p_self, false) and r.object_type = any (pm.approval_bulk_types()),
    'needs_reason', r.object_type = 'dealer_deal' and coalesce((r.facts ->> 'below_margin_floor')::boolean, false),
    'sod_exception', r.sod_exception,
    'mine', pm.current_user_id() = any (r.preparers) or r.submitted_by = pm.current_user_id())
  from (select 1) one
  left join pm.approval_request_steps s on s.request_id = r.id and s.step_order = r.current_step
$$;

-- The queue. Tabs: mine (I can act now) · waiting (I sent it; waiting on others) · decided (I
-- decided or sent it, last 60 days) · all (pending items I oversee). Escalates overdue steps first.
create or replace function pm.approval_inbox(p_tab text default 'mine', p_types text[] default null, p_location uuid default null,
                                             p_job uuid default null, p_overdue boolean default false, p_limit int default 200)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_uid text := pm.current_user_id(); v_rows jsonb; v_counts jsonb; v_lim int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if p_tab not in ('mine', 'waiting', 'decided', 'all') then raise exception 'PM_INVALID: tab must be mine, waiting, decided or all' using errcode = '22023'; end if;
  perform pm._approval_escalate(public.get_org_id());
  with cand as materialized (select * from pm._approval_candidates(null)),
  vis as materialized (select x as id from pm.approval_visible_request_ids() x),
  mc as materialized (select x as id from pm.my_money_job_ids('projects.contract_value') x),
  mf as materialized (select x as id from pm.my_money_job_ids('projects.financials') x),
  lc as materialized (select x as id from pm.my_location_ids('projects.contract_value', 'view') x),
  lf as materialized (select x as id from pm.my_location_ids('projects.financials', 'view') x),
  base as (
    select r, c.request_id is not null as can_act, c.delegator_membership, c.self_exception,
           case r.money_cap
             when 'projects.contract_value' then (r.job_id is not null and r.job_id in (select id from mc)) or (r.job_id is null and r.location_id in (select id from lc))
             when 'projects.financials' then (r.job_id is not null and r.job_id in (select id from mf)) or (r.job_id is null and r.location_id in (select id from lf))
             else false end as money
      from pm.approval_requests r
      left join cand c on c.request_id = r.id
     where r.org_id = public.get_org_id() and r.id in (select id from vis)
       and (p_types is null or cardinality(p_types) = 0 or r.object_type = any (p_types))
       and (p_location is null or r.location_id = p_location)
       and (p_job is null or r.job_id = p_job)
       and (not coalesce(p_overdue, false) or (r.status = 'PENDING' and r.due_at < now()))
       and case p_tab
             when 'mine' then c.request_id is not null
             when 'waiting' then r.status = 'PENDING' and c.request_id is null and (v_uid = any (r.preparers) or r.submitted_by = v_uid)
             when 'decided' then r.status <> 'PENDING' and r.updated_at > now() - interval '60 days'
                             and (v_uid = any (r.preparers) or r.submitted_by = v_uid
                                  or exists (select 1 from pm.approval_actions x where x.request_id = r.id and x.actor_user = v_uid and x.decision in ('APPROVE','REJECT')))
             else r.status = 'PENDING' end
  ), ranked as (
    select b.*, row_number() over (order by case when p_tab = 'decided' then null else (b.r).due_at end asc nulls last,
                                            case when p_tab = 'decided' then (b.r).updated_at end desc nulls last,
                                            (b.r).amount_cents desc, (b.r).created_at, (b.r).id) as rn
      from base b
  )
  select coalesce(jsonb_agg(pm._approval_row(x.r, x.can_act, x.delegator_membership, x.self_exception, x.money) order by x.rn), '[]'::jsonb)
    into v_rows from ranked x where x.rn <= v_lim;

  select jsonb_build_object(
      'mine', (select count(*) from pm._approval_candidates(null) c join pm.approval_requests r on r.id = c.request_id
                where (p_location is null or r.location_id = p_location)),
      'mine_overdue', (select count(*) from pm._approval_candidates(null) c join pm.approval_requests r on r.id = c.request_id
                        where r.due_at < now() and (p_location is null or r.location_id = p_location)),
      'waiting', (select count(*) from pm.approval_requests r where r.org_id = public.get_org_id() and r.status = 'PENDING'
                   and (v_uid = any (r.preparers) or r.submitted_by = v_uid) and (p_location is null or r.location_id = p_location)
                   and not exists (select 1 from pm._approval_candidates(r.id))))
    into v_counts;
  return jsonb_build_object('tab', p_tab, 'items', v_rows, 'counts', v_counts);
end $$;

-- One request: chain, history, money context (masked), the object's lines (masked).
create or replace function pm.approval_request_detail(p_request uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; c record; v_money boolean; v_steps jsonb; v_hist jsonb; v_lines jsonb; v_limit bigint;
begin
  select * into r from pm.approval_requests x where x.id = p_request and x.org_id = public.get_org_id();
  if r.id is null then perform pm.access_forbid('approval request not found'); end if;
  select * into c from pm._approval_candidates(r.id) x limit 1;
  v_money := case r.money_cap
    when 'projects.contract_value' then (r.job_id is not null and r.job_id in (select pm.my_money_job_ids('projects.contract_value')))
                                        or (r.job_id is null and r.location_id in (select pm.my_location_ids('projects.contract_value', 'view')))
    when 'projects.financials' then (r.job_id is not null and r.job_id in (select pm.my_money_job_ids('projects.financials')))
                                    or (r.job_id is null and r.location_id in (select pm.my_location_ids('projects.financials', 'view')))
    else false end;
  select coalesce(jsonb_agg(jsonb_build_object('step', s.step_order, 'label', s.label, 'status', s.status, 'roles', to_jsonb(s.approver_roles),
           'condition', case when v_money or s.condition = 'overtime' then s.condition end, 'due_at', s.due_at, 'escalated', s.escalated, 'decided_at', s.decided_at,
           'decided_by', pm._approval_user_name(s.decided_by),
           'on_behalf_of', case when s.on_behalf_of_membership is not null then pm._approval_membership_name(s.on_behalf_of_membership) end)
           order by s.step_order), '[]'::jsonb)
    into v_steps from pm.approval_request_steps s where s.request_id = r.id;
  select coalesce(jsonb_agg(jsonb_build_object('decision', a.decision, 'round', a.round, 'step', a.step_order,
           'actor', case when a.actor_user is null then 'Merit Projects' else pm._approval_user_name(a.actor_user) end,
           'on_behalf_of', case when a.on_behalf_of_membership is not null then pm._approval_membership_name(a.on_behalf_of_membership) end,
           'reason', a.reason, 'sod_exception', a.sod_exception, 'channel', a.channel, 'at', a.acted_at) order by a.acted_at, a.id), '[]'::jsonb)
    into v_hist from pm.approval_actions a where a.request_id = r.id;
  v_lines := case when v_money then coalesce(r.facts_money -> 'lines', r.facts_money -> 'changes', '[]'::jsonb) else '[]'::jsonb end;
  if c.request_id is not null and r.object_cap is not null then v_limit := pm._approval_my_limit(r.location_id, r.object_cap); end if;
  return pm._approval_row(r, c.request_id is not null, c.delegator_membership, c.self_exception, v_money)
      || jsonb_build_object('steps', v_steps, 'history', v_hist, 'lines', v_lines,
                            'my_limit_cents', case when v_money and v_limit is not null and v_limit >= 0 then v_limit end);
end $$;

-- The latest request of an object (object pages show "Waiting on GM · step 2 of 3").
create or replace function pm.approval_object_status(p_object_type text, p_object_id uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_id uuid;
begin
  select r.id into v_id from pm.approval_requests r
   where r.org_id = public.get_org_id() and r.object_type = p_object_type and r.object_id = p_object_id
   order by (r.status = 'PENDING') desc, r.created_at desc limit 1;
  if v_id is null then return jsonb_build_object('status', 'none', 'needed', pm.approval_needed(p_object_type, p_object_id, null)); end if;
  return pm.approval_request_detail(v_id);
end $$;

-- Delegation (spec §2c rule 5). The caller delegates their own approvals; an owner with
-- projects.team:edit or settings:configure may set one up for someone else (p_delegator).
create or replace function pm.approval_set_delegation(p_delegate uuid, p_starts timestamptz, p_ends timestamptz,
                                                      p_max_cents bigint default null, p_object_types text[] default '{}',
                                                      p_notify boolean default true, p_reason text default null, p_delegator uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_me uuid := pm.access_my_membership(); v_from uuid; v_org uuid := public.get_org_id(); v_id uuid; v_starts timestamptz;
begin
  if v_me is null then perform pm.access_forbid('no Projects seat in this organization'); end if;
  v_from := coalesce(p_delegator, v_me);
  if v_from <> v_me then
    -- security review H1: cover for someone else is an owner act (settings:configure or an
    -- owner / admin seat), and never names the caller as the delegate.
    if p_delegate = v_me then
      raise exception 'PM_DELEGATION_SELF: you cannot give yourself someone else''s approvals' using errcode = '42501';
    end if;
    if not (pm.can('projects.settings', 'configure')
            or exists (select 1 from core.memberships ms where ms.id = v_me and coalesce(ms.status, 'active') = 'active'
                          and core.rbac_normalize_legacy_role(ms.role) = 'company_admin')) then
      perform pm.access_forbid('only an owner can set up approval cover for someone else');
    end if;
  end if;
  if not exists (select 1 from core.memberships ms where ms.id = v_from and ms.org_id = v_org and coalesce(ms.status, 'active') = 'active') then
    raise exception 'PM_INVALID: that person is not active in this organization' using errcode = '22023';
  end if;
  if p_delegate is null or not exists (select 1 from core.memberships ms where ms.id = p_delegate and ms.org_id = v_org and coalesce(ms.status, 'active') = 'active') then
    raise exception 'PM_INVALID: pick an active teammate as the delegate' using errcode = '22023';
  end if;
  if p_delegate = v_from then raise exception 'PM_DELEGATION_SELF: you cannot delegate approvals to yourself' using errcode = '22023'; end if;
  if not exists (select 1 from pm._approval_member_grants(p_delegate) g where 'approve' = any (g.actions)) then
    raise exception 'PM_DELEGATION_NO_AUTHORITY: % cannot approve anything in Merit Projects, so they cannot cover approvals',
      coalesce(pm._approval_membership_name(p_delegate), 'that person') using errcode = '22023';
  end if;
  v_starts := coalesce(p_starts, now());
  if p_ends is null or p_ends <= v_starts then raise exception 'PM_INVALID: the cover must end after it starts' using errcode = '22023'; end if;
  if p_ends <= now() then raise exception 'PM_INVALID: the cover has already ended' using errcode = '22023'; end if;
  if p_ends > v_starts + interval '366 days' then raise exception 'PM_INVALID: cover lasts at most a year' using errcode = '22023'; end if;
  if p_max_cents is not null and p_max_cents <= 0 then raise exception 'PM_INVALID: the dollar cap must be above zero' using errcode = '22023'; end if;
  if not (coalesce(p_object_types, '{}') <@ pm.approval_object_types()) then
    raise exception 'PM_INVALID: unknown approval type in %', p_object_types using errcode = '22023';
  end if;
  insert into pm.approval_delegations (org_id, delegator_membership_id, delegate_membership_id, starts_at, ends_at, max_amount_cents,
                                       object_types, notify_delegator, reason, created_by)
  values (v_org, v_from, p_delegate, v_starts, p_ends, p_max_cents, coalesce(p_object_types, '{}'), coalesce(p_notify, true),
          left(nullif(btrim(coalesce(p_reason, '')), ''), 500), pm.current_user_id())
  returning id into v_id;
  insert into core.action_log (org_id, actor_type, actor_user_id, action, subject_table, subject_id, summary, metadata)
  values (v_org, 'HUMAN', (select u.id from core.users u where u.clerk_user_id = pm.current_user_id() limit 1), 'approval.delegation_set',
          'pm.approval_delegations', v_id::text,
          format('%s covers approvals for %s', pm._approval_membership_name(p_delegate), pm._approval_membership_name(v_from)),
          jsonb_build_object('delegator', v_from, 'delegate', p_delegate, 'starts_at', v_starts, 'ends_at', p_ends,
                             'max_amount_cents', p_max_cents, 'object_types', to_jsonb(coalesce(p_object_types, '{}'::text[]))));
  return v_id;
end $$;

create or replace function pm.approval_revoke_delegation(p_delegation uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.approval_delegations%rowtype; v_me uuid := pm.access_my_membership();
begin
  select * into d from pm.approval_delegations x where x.id = p_delegation and x.org_id = public.get_org_id() for update;
  if d.id is null then perform pm.access_forbid('delegation not found'); end if;
  if not (d.delegator_membership_id = v_me or d.delegate_membership_id = v_me or d.created_by = pm.current_user_id()
          or pm.can('projects.team', 'edit') or pm.can('projects.settings', 'configure')) then
    perform pm.access_forbid('only the people on this cover, or a team owner, can end it');
  end if;
  if d.revoked_at is not null then return; end if;
  update pm.approval_delegations set revoked_at = now(), revoked_by = pm.current_user_id() where id = d.id;
  insert into core.action_log (org_id, actor_type, actor_user_id, action, subject_table, subject_id, summary, metadata)
  values (d.org_id, 'HUMAN', (select u.id from core.users u where u.clerk_user_id = pm.current_user_id() limit 1), 'approval.delegation_revoked',
          'pm.approval_delegations', d.id::text, format('Ended the cover for %s', pm._approval_membership_name(d.delegator_membership_id)), '{}'::jsonb);
end $$;

create or replace function pm._approval_delegation_json(d pm.approval_delegations) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object('id', d.id, 'delegator_membership_id', d.delegator_membership_id, 'delegator', pm._approval_membership_name(d.delegator_membership_id),
    'delegate_membership_id', d.delegate_membership_id, 'delegate', pm._approval_membership_name(d.delegate_membership_id),
    'starts_at', d.starts_at, 'ends_at', d.ends_at, 'max_amount_cents', d.max_amount_cents, 'object_types', to_jsonb(d.object_types),
    'notify_delegator', d.notify_delegator, 'reason', d.reason, 'revoked_at', d.revoked_at,
    'state', case when d.revoked_at is not null then 'ended' when d.ends_at <= now() then 'ended' when d.starts_at > now() then 'scheduled' else 'active' end,
    'used', (select count(*) from pm.approval_actions a where a.delegation_id = d.id and a.decision in ('APPROVE', 'REJECT')))
$$;

create or replace function pm.approval_my_delegations() returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_me uuid := pm.access_my_membership();
begin
  return jsonb_build_object(
    'me', v_me,
    'outgoing', coalesce((select jsonb_agg(pm._approval_delegation_json(d) order by d.revoked_at nulls first, d.ends_at desc)
                            from pm.approval_delegations d where d.org_id = public.get_org_id() and d.delegator_membership_id = v_me
                             and (d.revoked_at is null or d.revoked_at > now() - interval '90 days') and d.ends_at > now() - interval '90 days'), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(pm._approval_delegation_json(d) order by d.revoked_at nulls first, d.ends_at desc)
                            from pm.approval_delegations d where d.org_id = public.get_org_id() and d.delegate_membership_id = v_me
                             and (d.revoked_at is null or d.revoked_at > now() - interval '90 days') and d.ends_at > now() - interval '90 days'), '[]'::jsonb),
    'managed', case when pm.can('projects.settings', 'configure') then
      coalesce((select jsonb_agg(pm._approval_delegation_json(d) order by d.ends_at desc)
                  from pm.approval_delegations d where d.org_id = public.get_org_id() and d.revoked_at is null and d.ends_at > now()
                   and v_me not in (d.delegator_membership_id, d.delegate_membership_id)), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- Teammates who can approve something at one of the caller's companies (the delegate picker).
create or replace function pm.approval_delegate_candidates() returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_me uuid := pm.access_my_membership();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('membership_id', m.id, 'name', pm._approval_membership_name(m.id),
                     'roles', (select to_jsonb(array_agg(distinct g.role_key)) from pm._approval_member_grants(m.id) g),
                     'management', exists (select 1 from pm._approval_member_grants(m.id) g where g.role_key in ('projects_owner', 'projects_gm')))
                     order by pm._approval_membership_name(m.id))
      from core.memberships m
     where m.org_id = public.get_org_id() and coalesce(m.status, 'active') = 'active' and m.id is distinct from v_me
       and exists (select 1 from pm._approval_member_grants(m.id) g
                    where 'approve' = any (g.actions) and g.location_id in (select pm.my_member_location_ids()))), '[]'::jsonb);
end $$;

-- Company settings (size → default tiers; solo mode; floor; escalation roles). settings:configure.
create or replace function pm.approval_set_company(p_location uuid, p_size text default null, p_solo boolean default null,
                                                   p_margin_floor numeric default null, p_escalation_roles text[] default null,
                                                   p_reseed boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.approval_settings%rowtype; v_org uuid := public.get_org_id();
begin
  if p_size is not null and p_size not in ('xs','s','m','l') then raise exception 'PM_INVALID: company size must be xs, s, m or l' using errcode = '22023'; end if;
  if p_margin_floor is not null and (p_margin_floor < 0 or p_margin_floor >= 1) then
    raise exception 'PM_INVALID: the margin floor is a share between 0 and 1' using errcode = '22023';
  end if;
  if p_escalation_roles is not null and not (p_escalation_roles <@ pm.approval_role_keys()) then
    raise exception 'PM_INVALID: unknown escalation role' using errcode = '22023';
  end if;
  select * into s from pm.approval_settings x where x.org_id = v_org and x.location_id = p_location for update;
  if s.org_id is null or coalesce(p_reseed, false) or (p_size is not null and p_size <> s.size_bucket) then
    perform pm._approval_seed_company(v_org, p_location, p_size, p_solo);
  end if;
  update pm.approval_settings
     set solo_mode = coalesce(p_solo, solo_mode), margin_floor_pct = coalesce(p_margin_floor, margin_floor_pct),
         escalation_roles = coalesce(p_escalation_roles, escalation_roles), updated_by = pm.current_user_id()
   where org_id = v_org and location_id = p_location
  returning * into s;
  insert into core.action_log (org_id, location_id, actor_type, actor_user_id, action, subject_table, subject_id, summary, metadata)
  values (v_org, p_location, 'HUMAN', (select u.id from core.users u where u.clerk_user_id = pm.current_user_id() limit 1), 'approval.settings_changed',
          'pm.approval_settings', p_location::text, 'Changed approval settings',
          jsonb_build_object('size', s.size_bucket, 'solo_mode', s.solo_mode, 'margin_floor_pct', s.margin_floor_pct, 'reseeded', coalesce(p_reseed, false)));
  return pm.approval_policy(p_location);
end $$;

create or replace function pm.approval_policy(p_location uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
begin
  return jsonb_build_object(
    'location_id', p_location,
    'company', (select l.name from core.locations l where l.id = p_location and l.org_id = v_org),
    'people', pm._approval_member_count(v_org, p_location),
    'suggested_size', pm.approval_size_for_count(pm._approval_member_count(v_org, p_location)),
    'can_configure', pm.can('projects.settings', 'configure', p_location),
    'settings', (select to_jsonb(s) - 'org_id' from pm.approval_settings s where s.org_id = v_org and s.location_id = p_location),
    'rules', coalesce((select jsonb_agg(to_jsonb(r) - 'org_id' order by r.object_type, r.policy_key nulls first, r.step_order, r.min_amount_cents, r.condition nulls first)
                         from pm.approval_rules r where r.org_id = v_org and r.location_id = p_location), '[]'::jsonb));
end $$;

-- The Controller's exception report: solo / two-person self-approvals with their typed reasons.
create or replace function pm.approval_exception_report(p_location uuid default null, p_from date default null, p_to date default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('action_id', a.id, 'request_id', r.id, 'acted_at', a.acted_at, 'object_type', r.object_type,
             'title', r.title, 'href', r.href, 'company', (select l.name from core.locations l where l.id = r.location_id),
             'job_label', pm._approval_job_label(r.job_id), 'actor', pm._approval_user_name(a.actor_user), 'reason', a.reason,
             'amount_cents', case when pm.can(coalesce(r.money_cap, 'projects.financials'), 'view', r.location_id) and r.money_cap is not null then r.amount_cents end,
             'request_status', r.status) order by a.acted_at desc)
      from pm.approval_actions a join pm.approval_requests r on r.id = a.request_id
     where a.org_id = public.get_org_id() and a.sod_exception
       and (p_location is null or r.location_id = p_location)
       and (p_from is null or a.acted_at >= p_from) and (p_to is null or a.acted_at < p_to + 1)
       and (pm.can('projects.settings', 'configure', r.location_id) or pm.can('projects.billing', 'post', r.location_id))), '[]'::jsonb);
end $$;

-- What to tell whom after an approval move (the app hands it to lib/notify → pm.notify_emit).
-- All text is built here from stored data — never from the caller's request. PENDING → approval.requested
-- to the people who may act on the current step (and their active delegates); APPROVED / REJECTED /
-- CANCELLED → approval.decided to the preparers / sender (and the delegator when a delegate acted and
-- asked to be told). The fan-out (1114) drops anyone who cannot reach the job and never notifies the actor.
create or replace function pm.approval_notify_plan(p_request uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.approval_requests%rowtype; s pm.approval_request_steps%rowtype; v_rcpt uuid[] := '{}'; v_cap text; v_money boolean;
  v_amount text; v_event text; v_title text; v_title_m text; v_body text; v_last pm.approval_actions%rowtype; v_roles text[];
  m record; v_sender text; v_uid text := pm.current_user_id();
begin
  select * into r from pm.approval_requests where id = p_request and org_id = public.get_org_id();
  if r.id is null then return jsonb_build_object('event', null); end if;
  v_cap := r.money_cap;
  v_money := v_cap is not null and pm.can(v_cap, 'view', r.location_id);
  v_amount := case when v_money then '$' || to_char(r.amount_cents / 100.0, 'FM999,999,999,990.00') end;
  v_sender := pm._approval_user_name(r.submitted_by);
  if r.status = 'PENDING' then
    select * into s from pm.approval_request_steps where request_id = r.id and step_order = r.current_step;
    v_roles := case when s.escalated and cardinality(s.approver_roles) > 0
                    then array(select distinct x from unnest(s.approver_roles || coalesce((select st.escalation_roles from pm.approval_settings st
                                 where st.org_id = r.org_id and st.location_id = r.location_id), '{}'::text[])) x)
                    else s.approver_roles end;
    for m in
      select ms.id, u.clerk_user_id from core.memberships ms join core.users u on u.id = ms.user_id
       where ms.org_id = r.org_id and coalesce(ms.status, 'active') = 'active' and u.clerk_user_id is not null
         and not (u.clerk_user_id = any (r.preparers)) and u.clerk_user_id is distinct from v_uid
    loop
      continue when s.require_distinct and exists (select 1 from pm.approval_actions x where x.request_id = r.id and x.round = r.round
                                                     and x.decision = 'APPROVE' and x.actor_user = m.clerk_user_id);
      continue when s.approver_capability is not null and not exists (
        select 1 from pm._approval_member_grants(m.id) g where g.location_id = r.location_id
           and g.capability = split_part(s.approver_capability, ':', 1) and split_part(s.approver_capability, ':', 2) = any (g.actions));
      continue when cardinality(v_roles) > 0 and not exists (
        select 1 from pm._approval_member_grants(m.id) g where g.location_id = r.location_id and g.role_key = any (v_roles));
      continue when not pm._approval_limit_ok(m.id, r.location_id, coalesce(s.approver_capability, r.object_cap), r.amount_cents);
      v_rcpt := v_rcpt || m.id;
    end loop;
    -- their active cover
    v_rcpt := v_rcpt || array(
      select d.delegate_membership_id from pm.approval_delegations d
       where d.org_id = r.org_id and d.delegator_membership_id = any (v_rcpt) and d.revoked_at is null
         and d.starts_at <= now() and d.ends_at > now()
         and (cardinality(d.object_types) = 0 or r.object_type = any (d.object_types))
         and (d.max_amount_cents is null or r.amount_cents <= d.max_amount_cents)
         and pm._approval_membership_user(d.delegate_membership_id) <> all (r.preparers));
    v_event := 'approval.requested';
    v_title := format('%s needs your approval', r.title);
    v_title_m := case when v_money then format('%s needs your approval (%s)', r.title, v_amount) end;
    v_body := format('Step %s of %s · %s%s', r.current_step, r.step_count, coalesce(s.label, 'Approver'),
                     coalesce(' · sent by ' || v_sender, ''));
  else
    select * into v_last from pm.approval_actions x where x.request_id = r.id and x.decision in ('APPROVE','REJECT','CANCEL')
     order by x.acted_at desc, x.id desc limit 1;
    v_rcpt := array(
      select ms.id from core.memberships ms join core.users u on u.id = ms.user_id
       where ms.org_id = r.org_id and coalesce(ms.status, 'active') = 'active'
         and (u.clerk_user_id = any (r.preparers) or u.clerk_user_id = r.submitted_by));
    if v_last.on_behalf_of_membership is not null and exists (select 1 from pm.approval_delegations d
         where d.id = v_last.delegation_id and d.notify_delegator) then
      v_rcpt := v_rcpt || v_last.on_behalf_of_membership;
    end if;
    v_event := 'approval.decided';
    v_title := format('%s was %s', r.title, case r.status when 'APPROVED' then 'approved' when 'REJECTED' then 'sent back' else 'withdrawn' end);
    v_title_m := null;
    v_body := case r.status
      when 'REJECTED' then left(format('%s sent it back: %s', coalesce(pm._approval_user_name(r.decided_by), 'An approver'), coalesce(r.reject_reason, '')), 600)
      when 'APPROVED' then format('Approved by %s%s', coalesce(pm._approval_user_name(r.decided_by), 'an approver'),
                                  case when v_last.on_behalf_of_membership is not null then ' for ' || pm._approval_membership_name(v_last.on_behalf_of_membership) else '' end)
      else 'It left the approval queue.' end;
  end if;
  v_rcpt := array(select distinct x from unnest(v_rcpt) x where x is not null limit 50);
  if cardinality(v_rcpt) = 0 then return jsonb_build_object('event', null); end if;
  return jsonb_build_object('event', v_event, 'job_id', r.job_id, 'company_id', r.location_id, 'subject_type', r.object_type,
    'subject_id', r.object_id, 'recipients', to_jsonb(v_rcpt), 'title', left(v_title, 200), 'title_money', left(v_title_m, 200),
    'body', v_body, 'money_cap', case when v_money then v_cap end,
    'link', case when r.status = 'PENDING' then '/approvals?tab=mine' else coalesce(r.href, '/approvals?tab=decided') end,
    'dedupe', format('req:%s:r%s:s%s:%s', r.id, r.round, r.current_step, lower(r.status)));
end $$;

-- ----------------------------------------------------------------------------
-- 11. Object RPC patches: solo-exception-aware SoD raises; stage moves record enforcement
-- ----------------------------------------------------------------------------
select pm._approval_patch_sod(f)
  from unnest(array['approve_change_order','approve_commitment','approve_commitment_change','approve_and_emit_billing',
                    'approve_time_entries','approve_deal']) f;

do $$
declare f record; v_def text; v_new text;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'pm' and p.proname = 'transition_stage' loop
    v_def := pg_get_functiondef(f.oid);
    continue when position('approval_enforced'', false' in v_def) = 0;
    v_new := replace(v_def, '''approval_enforced'', false',
                     '''approval_enforced'', (v_tr.approval_policy_key is not null and exists (select 1 from pm.approval_settings aps where aps.org_id = v_org and aps.location_id = v_proj.location_id))');
    execute v_new;
  end loop;
end $$;

-- enforce_approval_policy (1102): when the engine executes the move, return the engine's record
-- (the commitment's approval jsonb then names the request and its chain) instead of the legacy
-- pack-tier role check.
do $$
declare f record; v_def text; v_new text;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'pm' and p.proname = 'enforce_approval_policy' loop
    v_def := pg_get_functiondef(f.oid);
    continue when position('approval_exec' in v_def) > 0;
    v_new := regexp_replace(v_def, '\mbegin\M',
      E'begin\n  if pm.access_try_uuid(nullif(current_setting(''pm.approval_exec'', true), '''')) is not null then\n'
      || E'    return (select jsonb_build_object(''engine'', true, ''request_id'', r.id, ''steps'', r.step_count, ''round'', r.round, ''sod_exception'', r.sod_exception)\n'
      || E'              from pm.approval_requests r where r.id = pm.access_try_uuid(current_setting(''pm.approval_exec'', true)) and r.exec_txid = txid_current());\n'
      || E'  end if;', 1, 1, 'i');
    execute v_new;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 12. 1110 registries: classes, RPC guards, allowlist
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('approval_settings',      'S','location', '{}', 'projects.settings', null, null, null, null, false,
     '1113: approvals engine settings per company; written by pm.approval_set_company'),
  ('approval_rules',         'S','location', '{}', 'projects.settings', null, null, null, null, false,
     '1113: approval policy rows (object × band × step × approver); member edits become custom'),
  ('approval_requests',      'P','location', '{}', null, null, null,
     '(%1$sid in (select pm.approval_visible_request_ids()))', 'false', false,
     '1113: prepared / acted / can act / oversee; written only by the engine RPCs; amount + snapshot read masked through pm.approval_inbox'),
  ('approval_request_steps', 'P','parent',   '{}', null, 'approval_requests', 'request_id',
     '(%1$srequest_id in (select pm.approval_visible_request_ids()))', 'false', false, '1113: frozen chain of a request'),
  ('approval_actions',       'P','parent',   '{}', null, 'approval_requests', 'request_id',
     '(%1$srequest_id in (select pm.approval_visible_request_ids()))', 'false', false, '1113: append-only approval history'),
  ('approval_object_editors','P','org',      '{}', null, null, null, 'false', 'false', false,
     '1113 (review H3): every material editor per object; triggers write it, the engine reads it; no member access'),
  ('approval_delegations',   'P','org',      '{}', null, null, null,
     '(%1$sdelegator_membership_id = (select pm.access_my_membership()) or %1$sdelegate_membership_id = (select pm.access_my_membership()) or (select pm.can(''projects.team'', ''edit'')) or (select pm.can(''projects.settings'', ''configure'')))',
     'false', false, '1113: approval cover; written only by pm.approval_set_delegation / revoke')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('approval_submit',            '{p_object_type,p_object_id}', 'perform pm._approval_guard_object(p_object_type, p_object_id);', '1113: the object''s view capability'),
  ('approval_decide',            '{p_object_type,p_object_id}', 'perform pm._approval_guard_object(p_object_type, p_object_id);', '1113: eligibility is the engine''s (roles, capability, reach, limit, SoD)'),
  ('approval_needed',            '{p_object_type,p_object_id}', 'perform pm._approval_guard_object(p_object_type, p_object_id);', '1113'),
  ('approval_object_status',     '{p_object_type,p_object_id}', 'perform pm._approval_guard_object(p_object_type, p_object_id);', '1113'),
  ('approval_act',               '{p_request}', 'perform pm._approval_guard_request(p_request);', '1113: visible request; eligibility checked by the engine'),
  ('approval_cancel',            '{p_request}', 'perform pm._approval_guard_request(p_request);', '1113'),
  ('approval_request_detail',    '{p_request}', 'perform pm._approval_guard_request(p_request);', '1113'),
  ('approval_act_many',          '{}', 'if not pm.is_projects_member() then perform pm.access_forbid(''requires a Projects role''); end if;', '1113: each id checked inside'),
  ('approval_inbox',             '{}', 'if not pm.is_projects_member() then perform pm.access_forbid(''requires a Projects role''); end if;', '1113: rows are the caller''s'),
  ('approval_set_delegation',    '{}', 'if not pm.is_projects_member() then perform pm.access_forbid(''requires a Projects role''); end if;', '1113: checks the delegator itself'),
  ('approval_revoke_delegation', '{}', 'if not pm.is_projects_member() then perform pm.access_forbid(''requires a Projects role''); end if;', '1113'),
  ('approval_my_delegations',    '{}', 'if not pm.is_projects_member() then perform pm.access_forbid(''requires a Projects role''); end if;', '1113'),
  ('approval_delegate_candidates','{}', 'if not pm.is_projects_member() then perform pm.access_forbid(''requires a Projects role''); end if;', '1113: teammates at the caller''s companies'),
  ('approval_set_company',       '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1113'),
  ('approval_policy',            '{p_location}', 'if not exists (select 1 from pm.my_member_location_ids() x where x = p_location) then perform pm.access_forbid(''not a member of that company''); end if;', '1113'),
  ('approval_notify_plan',       '{p_request}', 'perform pm._approval_guard_request(p_request);', '1113: text built from stored data; recipients by the engine'),
  ('approval_exception_report',  '{}', 'if not (pm.can(''projects.settings'', ''configure'') or pm.can(''projects.billing'', ''post'')) then perform pm.access_forbid(''requires projects.settings:configure or projects.billing:post''); end if;', '1113: the Controller''s report')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

insert into pm.access_rpc_allowlist as a (function_name, reason) values
  ('approval_visible_request_ids', 'describes the caller''s own approval visibility (RLS of approval_requests)'),
  ('approval_delegations_for',     'the caller''s own delegations (service: any)')
on conflict (function_name) do update set reason = excluded.reason;

-- ----------------------------------------------------------------------------
-- 13. RLS (org isolation, permissive) + grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['approval_settings','approval_rules','approval_requests','approval_request_steps','approval_actions','approval_delegations',
                           'approval_object_editors'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
end $$;

revoke all on pm.approval_settings, pm.approval_rules, pm.approval_requests, pm.approval_request_steps, pm.approval_actions,
              pm.approval_delegations, pm.approval_object_editors from public, anon, authenticated;
grant select, insert, update, delete on pm.approval_settings, pm.approval_rules, pm.approval_requests, pm.approval_request_steps,
              pm.approval_actions, pm.approval_delegations, pm.approval_object_editors to service_role;
grant select on pm.approval_settings, pm.approval_request_steps, pm.approval_actions, pm.approval_delegations to authenticated;
grant select, delete on pm.approval_rules to authenticated;
grant insert (org_id, location_id, object_type, policy_key, min_amount_cents, max_amount_cents, step_order, role_set, approver_roles,
              approver_capability, min_approver_limit_cents, require_distinct, due_days, condition, label, is_active) on pm.approval_rules to authenticated;
grant update (min_amount_cents, max_amount_cents, step_order, role_set, approver_roles, approver_capability, min_approver_limit_cents,
              require_distinct, due_days, condition, label, is_active) on pm.approval_rules to authenticated;
-- amount, snapshot, facts, preparers: read through pm.approval_inbox / pm.approval_request_detail (masked)
grant select (id, org_id, location_id, job_id, object_type, object_id, object_ref, policy_key, title, summary, href, status, round,
              current_step, step_count, due_at, decided_at, reject_reason, sod_exception, created_at, updated_at) on pm.approval_requests to authenticated;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and (p.proname like 'approval\_%' or p.proname like '\_approval\_%' or p.proname like 'tg\_approval\_%'
                                        or p.proname in ('tg_budget_member_guard', 'tg_budget_line_member_guard'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('approval_submit','approval_decide','approval_act','approval_act_many','approval_cancel','approval_needed',
                     'approval_inbox','approval_request_detail','approval_object_status','approval_set_delegation',
                     'approval_revoke_delegation','approval_my_delegations','approval_delegate_candidates','approval_set_company',
                     'approval_policy','approval_exception_report','approval_visible_request_ids','approval_delegations_for','approval_notify_plan',
                     'approval_object_types','approval_bulk_types','approval_object_cap','approval_money_cap','approval_role_set',
                     'approval_set_label','approval_map_legacy_role','approval_role_keys','approval_default_rules','approval_size_for_count') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

select pm.access_apply_policies();
select pm.access_apply_rpc_guards();

-- ----------------------------------------------------------------------------
-- 14. Backfill: every company with a pack install gets the engine with its size defaults;
--     transitions that name a pack policy get its compiled rules. Idempotent (settings kept).
-- ----------------------------------------------------------------------------
do $$
declare x record;
begin
  for x in select distinct i.org_id, i.location_id from pm.pack_installs i where i.location_id is not null loop
    if not exists (select 1 from pm.approval_settings s where s.org_id = x.org_id and s.location_id = x.location_id) then
      perform pm._approval_seed_company(x.org_id, x.location_id, null, null);
    end if;
  end loop;
  for x in select distinct t.org_id, t.location_id, t.approval_policy_key from pm.stage_transitions t where t.approval_policy_key is not null loop
    perform pm._approval_sync_pack_policy(x.org_id, x.location_id, x.approval_policy_key);
  end loop;
end $$;

-- ============================================================================
-- end 1113_pm_approvals
-- ============================================================================
