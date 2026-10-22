# Merit Projects — Wave 0a spec: roles, job access, money visibility

Status: approved scope (owner approved the expert-panel spec and build order, 2026-10-22).
Sources: expert-panel spec (Claude Doc "Merit Projects — Expert Panel Feature Specification", §3, §9.1, §10.2),
panel seat files 06 (business process), 08 (UX), 10 (platform); Books RBAC v2 migrations 157–167.

## 1. Goal and acceptance

Each person in a company gets their own Projects app and only their own level of money.

Acceptance (all must pass, in tests and on the deployed app):

1. A Labor user sees only jobs they are assigned to, sees no contract, budget, cost, margin or
   anyone's pay, and lands on a Today screen. Reading a money table through the data API
   (PostgREST, with their own JWT) returns zero rows or masked columns — not just hidden UI.
2. A PM lands on "My jobs", sees full money for jobs where they are on the job team, and cannot
   read money for other jobs.
3. An Owner sees every job and all money in every company they are assigned to.
4. A Dispatcher/office user sees all jobs and customers in their companies, no margin or cost.
5. A user assigned to company A cannot read company B's Projects rows (location scope).
6. Another tenant's rows are never visible (unchanged org isolation).
7. Nobody is locked out on deploy: every existing active member keeps at least today's access
   (backfill), and owners/admins get the Owner role.
8. "Preview as" lets an owner see the app as any role (narrowing only; never widens).
9. Every menu, home screen and list respects the role; every row is clickable (shipped dc64362).

## 2. Model (plugs into Books RBAC v2 — no second permission system)

Authority = `core.access_assignments` (membership × company scope × role). Projects adds:

- **Capabilities** with `module = 'projects'` in `core.capabilities` (widen
  `capabilities_module_chk`). Code source of truth: `packages/projects-access/src/capabilities.ts`,
  mirrored by migration 1110. `core.rbac_mirror_capabilities` must only deprecate keys of the modules
  present in its input (so a Books re-mirror never deprecates `projects.*`, and vice versa).
- **Platform role templates** (owner_level platform, audience internal_staff) for the Projects
  personas, cloned to each tenant like Books templates. Code source:
  `packages/projects-access/src/roles.ts`.
- **Job teams**: `pm.job_members(org_id, job_id, membership_id, slot, added_by, added_at)` —
  slot ∈ pm, apm, superintendent, foreman, lead, crew, estimator, sales, coordinator, accountant,
  designer, other. "Own jobs" = on the job team, or assigned to a task/visit/work order/dispatch on
  the job (crew/tech/installer), or the job's `pm_membership_id`.

### 2.1 Capability keys (actions ⊆ view, create, edit, delete, approve, post, release, export, configure)

| Key | Actions | Tags | Meaning |
|---|---|---|---|
| projects.jobs | view, create, edit, delete | | Jobs, tasks, schedule, logs, photos, punch on jobs the user can reach |
| projects.jobs_all | view | | Reach every job in the company, not only own jobs |
| projects.financials | view, edit, export | money | Cost, budget dollars, committed, actual, margin, WIP, job cost, estimate cost lines |
| projects.contract_value | view | money | Contract/sell price, change-order and invoice amounts |
| projects.labor_rates | view, edit | sensitive (field class comp) | Individual pay rates and burden |
| projects.leads | view, create, edit, delete | | Leads, pipeline, activities |
| projects.customers | view, create, edit | | Customer and site contact info (writes still via definer fns) |
| projects.estimates | view, create, edit, approve | | Estimates/quotes/proposals (approve = below margin floor) |
| projects.change_orders | view, create, edit, approve | money | COs (create without price for field roles is an app rule) |
| projects.commitments | view, create, edit, approve | money | POs and subcontracts |
| projects.billing | view, create, edit, approve, post | money | Billing requests, pay apps, draws (post = send to Books) |
| projects.time | view, create, edit, approve | | Time entries (own entries need create; approve = crew/timesheet approval) |
| projects.dispatch | view, edit | | Dispatch, crew and install boards |
| projects.documents | view, create, edit, delete | | Files and drawings |
| projects.selections | view, create, edit, approve | | Selections and allowances |
| projects.production | view, create, edit | | Work orders, production board |
| projects.store | view, create, edit, approve | | Dealer store: units, deals, parts counter, rentals, warranty (deal gross = financials) |
| projects.reports | view, export | | Dashboards and reports |
| projects.settings | view, configure | | Packs, job types, stages, cost codes, templates, labor settings |
| projects.team | view, edit | | Job-team assignment; Projects role assignment requests |

### 2.2 Persona role templates (platform → cloned per tenant)

Scope column: **all** = jobs_all granted; **own** = only own jobs. `$` = financials+contract_value.

| Template key | Persona | Jobs | Money | Key grants |
|---|---|---|---|---|
| projects_owner | Management | all | $ + labor_rates | everything incl. settings:configure, approvals, export |
| projects_gm | Management | all | $ (no labor_rates edit) | all operational + approvals |
| projects_office_manager | Admin | all | contract_value only | leads, customers, billing create/edit, dispatch, documents, time view |
| projects_project_accountant | Admin | all | $ | billing all incl approve/post, commitments view/approve, time view, reports export |
| projects_dispatcher | Admin | all | none (price-book sell only, app rule) | leads, customers, dispatch edit, jobs create/edit, time view |
| projects_purchasing | Admin | all | financials view | commitments create/edit/approve, documents |
| projects_pm | PM | own | $ on own jobs | jobs full, COs/commitments approve, billing create/edit, time approve, selections approve, estimates |
| projects_supervisor | Supervisor | own | none (hours & quantities only) | jobs view/edit, time create/approve, documents, change_orders create, dispatch view |
| projects_labor | Labor | own | none | jobs view, time create (own), documents create (photos), field logs |
| projects_sales | Sales | own (+ leads all) | contract_value; financials on estimates they own (app rule) | leads, customers, estimates full |

Industry titles (shown to users) map to these templates in each pack manifest (`roles` slot):
e.g. field_service Technician → projects_labor, CSR → projects_dispatcher, Comfort advisor → projects_sales.

Permission set: `projects_payroll_admin` (labor_rates view, time approve).

### 2.3 Money levels (derived, for UI)

level 1 Labor: no job dollars · 2 Supervisor: hours/quantities · 3 PM: `$` on own jobs, no individual
rates · 4 Management: everything. Derived from capabilities, never stored.

### 2.4 Contract between DB and app (fixed — both sides build to this)

- `pm.my_access() returns table (location_id uuid, capability text, actions text[], role_key text, role_name text)`
  — one row per (company, projects capability) the caller holds through active, in-effect assignments
  (all_clients expands to every operating company of the org). `role_key` = the template key of the
  granting role (cloned tenant roles keep `legacy_role_key`/upstream key = template key); when several
  roles grant the same cap the row repeats per role. EXECUTE granted to authenticated.
- `pm.job_team_upsert(p_job uuid, p_membership uuid, p_slot text)` / `pm.job_team_remove(p_job, p_membership)`
  — definer, org-guarded, require `projects.team:edit` at the job's company.
- `pm.v_job_team` — job_id, membership_id, slot, display_name, email, role_name (RLS: class J).
- App type: `apps/projects/src/lib/access/types.ts` (written first; both sides import it).

## 3. Database enforcement (migration 1110_pm_access.sql)

Helper functions (STABLE, SECURITY DEFINER, `search_path = pm, core, public`, computed once per
statement through uncorrelated subqueries):

- `pm.my_location_ids(p_cap text, p_action text) returns setof uuid` — companies where the caller
  holds cap:action (wraps core assignments; `service_role` → all).
- `pm.my_job_ids() returns setof uuid` — jobs the caller can reach: jobs in companies where they hold
  `projects.jobs_all:view`, plus own jobs (job_members, pm_membership_id, task/visit/work-order/dispatch
  assignment via the employee linked to the membership) in companies where they hold `projects.jobs:view`.
- `pm.my_money_job_ids() returns setof uuid` — subset of my_job_ids in companies where the caller holds
  `projects.financials:view`.
- `pm.can(p_cap text, p_action text, p_location uuid default null) returns boolean`.

Policy classes (every pm table gets exactly one class; a guard test fails CI for an unclassified
table). The existing `org_isolation` stays as the outer predicate (AND).

| Class | Rule | Examples |
|---|---|---|
| J job-scoped | `job_id in (select pm.my_job_ids())` | tasks, field logs, photos, punch, schedule, selections |
| M money job-scoped | `job_id in (select pm.my_money_job_ids())` | budget_lines, job_costs, commitments*, billing_*, sov_*, retainage_ledger, contracts |
| C company-scoped | `location_id in (select pm.my_location_ids('<cap>','view'))` | leads, customers sites, price book, store tables, work centers |
| S settings | read: any member of the company; write: `projects.settings:configure` | job types, stages, cost codes, templates |
| P personal | own rows (membership/employee) or `projects.time:approve` at the company | time entries, labor rates (rates also need labor_rates:view) |
| O org config | unchanged org isolation, read-only to non-configurers | installs, entitlements mirror |

Writes: `with check` mirrors the read predicate plus the edit capability. Definer functions that write
money (`pm.*` RPCs) add an explicit `pm.can(...)` check at the top (after the existing org guard) and
raise `PM_FORBIDDEN` (42501) — so RPC paths can't bypass RLS.

Mixed columns (cost on a non-money row, e.g. `time_entries.cost_rate`, estimate line cost, work-order
line cost): revoke column SELECT from `authenticated` and expose through security-invoker views that
null the column unless `pm.can('projects.financials','view', location)`. The app reads the views.

Backfill (idempotent):

- Provision Projects templates into every tenant (`core.rbac_provision_tenant` path or a Projects
  clone function).
- Every active membership with no Projects assignment: membership role owner/company_admin/admin →
  projects_owner (scope all_clients); any other → projects_pm on all_clients (today everyone sees
  everything; this keeps them working, and owners narrow from there). Source `backfill`.
- Seed `pm.job_members` from existing `pm.projects` PM/super columns where present.

Enforcement: Projects RLS is enforced immediately (Projects has no legacy model to dual-run); the
backfill is what prevents lock-out. Books' `access_enforcement_mode` is not changed.

## 4. Server (apps/projects)

- `lib/access/` (new): `getAccess()` (cached per request) returns
  `{ membershipId, persona, title, caps: Set<string> /* 'cap:action' */, companies: Record<locId, Set<string>>,
     moneyLevel: 1|2|3|4, jobScope: 'all'|'own', preview: null | personaKey }` built from one RPC
  `pm.my_access()` (returns the caller's effective projects grants per company). `can(cap, action, locationId?)`.
- `route()` gains a required `access: { cap, action } | 'none'` option (default compile error if
  omitted on new routes; existing routes get explicit keys in this wave). 403 `FORBIDDEN` when missing.
- Response masking: `maskMoney(obj, access, locationId)` strips known money keys
  (`*_cents` money fields list per object type) when the caller lacks `projects.financials` /
  `projects.contract_value` — defense in depth on top of RLS.
- **Preview as** (owners only, `projects.settings:configure`): cookie `mp_preview` = persona key. Server
  intersects the real grants with the template's grants and applies it to nav, homes, `can()` and masking.
  RLS still runs as the real user (preview can only hide, never reveal). A banner shows "Previewing as
  Technician — exit".

## 5. UI (apps/projects)

- `buildNav()` takes `access` and builds the rail per persona (UX seat §3b): Labor → Today, Time, Jobs, Me;
  Supervisor → Today, My jobs, Schedule, Crew time, Logs, Punch, Docs; PM → Home, My jobs, Schedule,
  Changes, Commitments/POs, Billing, Inbox; Admin → Home, Inbox, Calls/Leads, Jobs, Schedule/Dispatch,
  Billing, Customers, Vendors, Documents, Settings (by grants); Management → Home, Jobs, Pipeline,
  Insights, Approvals, Settings. Items the persona can't use are absent, not greyed.
- Home per persona: Owner (existing report home), PM (existing PmHome, filtered to own jobs), Office
  (needs-you queue), Supervisor (today on site, crew time to approve), Labor (Today: current assignment card,
  rest of day, this week's hours).
- Money columns and figures render only with the capability; derived figures follow their inputs
  (budget-used bars show hours for level ≤ 2).
- Settings → Team: members of each company, their Projects role (industry title), job teams; owners
  change Projects roles (writes through the Books access-assignment RPCs) and add people to job teams.
- Industry titles from the pack `roles` slot; fallback to persona names.

## 6. Tests

- PGlite (`/home/claude/pmtest` harness + Books harness): users Owner/PM/Supervisor/Labor/Dispatcher in org A
  across companies L1/L2, plus org B. Assert for every pm table class: cross-org denied, cross-company
  denied, Labor sees only assigned jobs, money tables empty for non-money roles, PM money only on own jobs,
  masked columns null, definer money RPCs refuse without capability, backfill gives every member access,
  unclassified-table guard.
- Books: `access-foundations.test.ts` still passes (registry guard compares Books modules; Projects keys
  checked by a Projects guard test against `packages/projects-access`).
- Unit: nav per persona, maskMoney, preview narrowing.

## 7. Out of scope for 0a (Wave 0b)

Shared approvals engine with Books, setup format v2 beyond `roles`/nav, shared cost-code master,
notifications, document store, job queue, audit convergence.
