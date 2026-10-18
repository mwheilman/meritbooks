# MeritBooks — Role-Based Access Control Spec (fully customizable RBAC)

**Status:** DRAFT for owner review · authored 2026-10-18 · governs the access-control build that sits under
`IA-SPEC.md` §1–§2, §5 and §7. It is a spec, not code. Schema items are a numbered migration list (columns,
not SQL); the lead assigns real numbers (on-disk Books migrations run through `153`).

**Binding requirement (owner, verbatim):** *"make sure that there is complete customizability for RBA. I want
each tenant and client to be able to create role-based access for standard or customized roles."*

**Inputs (binding order):** `00-OWNER-DIRECTIVE.md` → suite `merit-suite-identity-access-model.md` (Core owns
identity, roles and memberships; modules gate surfaces but never own the access decision; what a user sees =
entitlements ∩ permissions) → `IA-SPEC.md` → `01-CODE-REALITY.md` / `03-CODE-INVENTORY.md` →
`FPB-identity-multitenancy.md` → the live RBAC code (`lib/rbac/*`, `lib/team/*`, `lib/money/approvals.ts`,
migrations 014, 042, 061, 092, 106, 109, 121, 130, 145).

**What this changes in IA-SPEC (amendments, called out where they occur):** `core.membership_locations` stops
being the authoritative client-access list; **access assignments** (§1.4) replace it, and `can_access_location()`
reads them (IA M-3/M-4). `approval_workflow_steps.approver_role` is replaced by a capability plus dollar limit
(§3.4). IA §2.6 delegation becomes the general ceiling rule in §4.2. Everything else in IA-SPEC stands.

---

## 0. Decisions on one page

1. **A role is data, not code.** Role definitions live in `core.role_definitions` and are owned at one of three
   levels: **platform** (system templates), **tenant** (standard or custom), and **client** (roles a client defines
   for its own staff, kept inside a ceiling the tenant sets). `permissions.ts` stops being the source of truth.
   It becomes the seed for the platform templates plus a compatibility shim for one release.
2. **Permissions are capabilities:** `resource × action`, using 9 canonical actions (view · create · edit ·
   delete · approve · post · release · export · configure). Resources are namespaced by module (`books.ap.bills`)
   so Projects and later modules register their own resources in the same catalog.
3. **An assignment is membership × scope × role.** Scope is *all clients*, *one client*, a *client set*, or a
   *consolidation group*. One person can be bookkeeper on Client A and reviewer on Client B. Roles stack by union.
4. **Permission sets are add-on grants** layered on top of roles, Salesforce-style. Each is scoped and can be
   time-boxed. An assignment can also be narrowed: it can **mute** specific capabilities or be made **read-only**.
5. **Constraints live on grants, not on roles in general.** Constraints cover client scope, dimension
   restrictions (department / class / job), approve and release dollar limits, document types, record ownership,
   field sensitivity (pay, SSN/TIN, bank numbers), time boxes, MFA / step-up / IP rules, and consolidation-group
   access (the holder needs access to every member).
6. **Guardrails beat customization.** A small set of **hard rules** cannot be configured away: no
   self-administration, the delegation ceiling, read-only external audiences, transaction-level preparer ≠
   approver ≠ releaser, an immutable access log, and platform-only capabilities. Static role-level SoD conflicts
   are **soft** by default: the system warns, requires a written justification, and puts them in access review.
   A tenant can promote any soft rule to hard.
7. **One policy decision point:** `authorize(principal, action, resource)` in a Core package. It is called by every
   API route, page guard, money-approval path, widget data route and nav builder. The database enforces the
   coarse layer: client access in RLS, plus capability checks on post/approve/release state transitions and
   masked views for sensitive fields.
8. **Template changes never apply silently.** A tenant role cloned from a template keeps its grants. When the
   platform publishes a new template version, the tenant admin sees **"Update available"** with a diff and adopts
   it, or cherry-picks from it. Only *restrictions* (platform locks or SoD rules) apply globally, and always with
   notice.
9. **The UI is permission-filtered.** Anything the user can't do is **hidden, not disabled**. There is one
   exception: an action blocked only by a limit shows its alternative ("Route for approval"). A 403 page offers
   **Request access**.
10. **Every change to access is logged, explainable and reviewable.** That includes an append-only access log, a
    "why can / can't X do Y" explainer, read-only "view as" simulation, and a quarterly attestation campaign.

---

## 0.1 Code reality: what exists and what is wrong (verified in repo 2026-10-18)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| C1 | 9 roles hardcoded in `permissions.ts`. The 41 feature keys and 14 action verbs are all static. | `ROLE_DEFINITIONS`, `FEATURE_CATALOG` | Roles can't be versioned or owned per client. Role flags (`canManageUsers`, `canEditAccountingSettings`, `canEditSystemSettings`, `mfaRequired`, `payrollVisibility`, `companyScope`, `assignableBy`) sit **outside** the matrix and are not customizable. |
| C2 | Custom roles + cell overrides exist (mig 130). An override on a **system role key** rewrites that role for the whole tenant. | `core.custom_roles`, `core.role_permission_overrides`, `/api/rbac/overrides` | Changes are unversioned, show no people-affected count and get no SoD validation. For example, granting `check_processor` both `check_run` and `ap_disbursement_release` is accepted silently. |
| C3 | **Money approval ignores overrides and custom roles.** `canApprove()` → `normalizeMembershipRole()` → `roleMayApproveMoney()` uses static `hasPermission`. | `lib/money/approvals.ts:103-108,156` | **Security bug:** an override that *revokes* `bills/checks/payroll:approve` from CFO is not honored when approving money. Custom roles never normalize, so they can never approve money even when granted. Rec sign-off (`/api/reconciliation/session`) borrows this money-approval check. |
| C4 | Route guard and page guard read different role sources. `requirePermission` reads `core.employees.role`. `requirePagePermission` and `canApprove` read `core.memberships.role` first. | `require-permission.ts`, `page-guard.ts` | A user whose membership role differs from their employee role gets different answers on the page and on its API. |
| C5 | User and role admin is gated by `ROLE_DEFINITIONS[employees.role].canManageUsers`. | `lib/team/guard.ts` | Only `company_admin` can manage. A custom role can never be an admin. `user_permissions:assign` exists but gates nothing. The accounting manager's delegation is described but blocked. |
| C6 | `/api/me` returns static `roleDef.features`. Custom roles get `{}`. | `app/api/me/route.ts:221,310` | The nav fails open (shows everything) for custom roles, and the UI never reflects overrides. |
| C7 | The nav borrows coarse keys and leaves many pages unmapped. Rev rec, estimates, deposits and collections use `invoices`. Budgets, FP&A, consolidation, board package and borrowing base use `reports`. Approvals, autonomy, payments, billing, ERP and operations use `settings_system`. Debt, tax, expenses, inventory, documents, agents, AI decisions, obligations, subscriptions, inbox, departments and categorize have **no mapping** (always shown). | `components/layout/nav-permissions.ts` | Access can't be tailored per module. Owner-requested modules have no permission of their own. |
| C8 | Approval workflow steps name a system role (`approver_role text`). | mig 092, `lib/approvals/service.ts` | Custom roles can't be approvers, and there are no per-person dollar limits. |
| C9 | Client access is UI-only. RLS is `org_id` only. 99 API route files use the RLS-bypassing admin client. | `01-CODE-REALITY.md` | Every scope rule in this spec must be enforced in the API decision point, and in the DB where a user-scoped client or definer RPC is used (§5.2). |
| C10 | `admin_scope` (MANAGEMENT/PREPARER, mig 109) is a parallel capability system that **fails open**. | `lib/team/admin-scope*.ts` | It folds into capabilities (§2.3). |
| C11 | External auditor is a custom role cloned from `business_user` (mig 145). It is not time-boxed and has no field masking. | `lib/audit-access/external-auditor-role.ts` | It becomes a standard template with a hard time box (§7). |
| C12 | Deleting a custom role checks only `employees.role` for holders. | `/api/rbac/custom-roles/[key]` DELETE | Members who hold the role through a membership are orphaned into deny-all (fails closed, but locks them out). |
| C13 | Dormant legacy `public.role_permission_overrides` (mig 014). | mig 130 header | Drop it in R-14. |

**C3 is a must-fix before any tenant edits a system role.** The interim fix is to route `roleMayApproveMoney`
through `effectivePermission()`. It disappears entirely when `canApprove` calls `authorize()` (R-11).

---

## 1. Model

### 1.1 Objects

```
Capability catalog (code registry, mirrored to core.capabilities)
   └─ capability = resource × action   e.g. books.ap.bills:approve

Role definition  (core.role_definitions)        owner_level: platform | tenant | client
   ├─ versions (immutable)                      core.role_versions
   │    └─ grants: capability [+ constraints]   core.role_grants
   └─ policies: default scope, field classes, auth (MFA/step-up/IP), max duration, assignable band

Permission set   (core.permission_sets)         same owner levels, same versioned grants
                                                core.permission_set_versions / _grants

Membership       (core.memberships)             one person × one tenant (+ audience, status, expiry)
   └─ Access assignment (core.access_assignments)
         role OR permission set × scope (all clients | client | client set | consolidation group)
         + narrowing: mutes[], read_only, constraint overrides (only tighter), effective dates
   └─ Capacity assignment (core.client_assignments, IA M-5)  preparer/reviewer/approver/lead
         drives queues and transaction-level SoD; NOT a permission

Client access policy (core.client_access_policies)   per client: may it define roles? within what envelope?
SoD policy           (core.sod_rules + tenant overrides + exceptions)
Access log           (core.access_change_log, append-only)
```

### 1.2 Three ownership levels

| Level | Who authors | Who can assign it | Visible to | Typical use |
|---|---|---|---|---|
| **Platform template** | Platform admin (Mike) | Nobody directly. Tenants **clone** it into a tenant role (auto-cloned at provisioning for the standard set). | Every tenant, as a read-only library | Standard roles (§7), audience-locked roles (client contact, external auditor), platform roles. |
| **Tenant role** | Tenant admin, or anyone holding `access.roles:configure` | Grantors within the ceiling (§4.2) | That tenant | **Standard** (cloned from a template, labelled "Standard" or "Standard · modified") or **Custom** (from scratch, or cloned from any template or tenant role). |
| **Client role** | Client admin (a person holding `access.roles:configure` scoped to *that client*), only if the tenant enabled it for that client | Client admin, tenant grantors | That tenant + that client | A client's own AP clerk, office manager or approver. Grants must stay inside the client's **envelope** (§1.6). Assignable only on that client. |

Platform-owned capabilities (`platform.*`) can only appear in platform-audience roles. Tenant and client roles can
never contain them (hard rule H5).

### 1.3 Role definition attributes (beyond grants)

| Attribute | Values | Purpose |
|---|---|---|
| `audience` | `internal_staff` · `client_staff` · `external` (auditor, client contact) · `platform` | Sets the **ceiling**, as Sage Intacct's user type does: an `external` role can never hold ledger writes, money actions or configuration, however it is edited (H3). |
| `kind` | `standard` · `custom` | Library grouping. Also controls whether "Update available" applies. |
| `upstream_template_id`, `upstream_version` | link | Lineage for diff and upgrade. **Not live inheritance** (§1.7). |
| `default_scope` | `all_clients` · `assigned` | Pre-fills the assignment dialog. |
| `field_policy` | per sensitivity class (§3.6) | Default masking. |
| `auth_policy` | `mfa_required`, `step_up_minutes` for release/configure, `ip_allowlist_id`, `session_max_hours`, `idle_timeout_minutes` | Authentication strength per role (§3.8). |
| `max_assignment_days` | int or null | Forces time-boxing (auditor ≤ 120 by default). |
| `assignable_band` | `tenant_admin_only` · `managers` · `any_grantor` | An extra, tightening-only delegation filter on top of the ceiling rule (replaces `assignableBy`). |
| `status` | `draft` · `active` · `deprecated` (no new assignments) · `archived` | Lifecycle. A role can't be archived while it has holders. |

### 1.4 Assignment = membership × scope × (role | permission set)

| Scope type | Meaning | Notes |
|---|---|---|
| `all_clients` | Every client in the tenant, including the tenant's own books and clients added later | This is the IA's `client_scope = all`. |
| `client` | One client (`location_id`) | The common case. Bookkeeper on Client A. |
| `client_set` | A **saved, dynamic set**: an explicit list, or a rule such as "clients tagged HVAC" or "clients where I am primary preparer" | Proactive enhancement: firms can staff by segment without editing 40 rows. The set is re-evaluated when clients or tags change, and each change is logged. |
| `consolidation_group` | A named group (IA M-6) | Grants only `books.consol.*` capabilities. Valid only while the holder can access **every** member (§3.9). |
| `tenant` | Tenant-level resources only (team, billing, settings, templates) | No client data. |

**Stacking rule.** In a client context, the effective grant set is the union of every active assignment whose
scope covers that client. That includes `all_clients` roles, the client's own roles, client sets containing it,
and permission sets on any of those scopes. Each assignment's mutes and read-only flag apply *only to grants from
that assignment*. So a manager with a read-only `all_clients` monitoring role and a full role on Client A has
full access on A and read-only access elsewhere.

**Capacity is separate.** Being the *preparer* on Client A comes from `client_assignments`. It needs access (an
assignment) and it feeds transaction-level SoD and work queues. Capacity never grants a capability.

**The membership's primary role** (`core.memberships.role_definition_id`) is the role shown on the person's card
and the default in invites. Authority comes only from assignments. Invites (mig 106) carry intended assignments,
which are materialized on accept.

### 1.5 Permission sets (add-on grants)

- These are versioned bundles of grants with optional constraints, for example **"Wire release up to $50k"**,
  **"Payroll comp visibility"**, **"Consolidation manage"**, **"Year-end close"** or **"Quarter-end auditor
  extras"**.
- They are assigned the same way roles are (scope, dates, reason) and are subject to the same ceiling, SoD and
  second-approval rules.
- **No permission-set groups.** A role already *is* the bundle. Salesforce needed groups because profiles
  couldn't carry the bundle; here they would add a third layer with no new expressive power.
- **Muting is at assignment level.** An assignment can mute any capability its role grants (e.g. "Controller,
  but not hard-close on Client B"). This gives Salesforce muting-permission-set behavior without cloning a role.
- **JIT elevation (proactive).** A user can *request* a permission set for a time box ("release up to $25k, today
  only"). The request routes to a grantor who holds it, and the grant expires on its own.

### 1.6 Client-defined roles: the envelope

`core.client_access_policies` (one row per client, defaults from tenant settings):

| Field | Default (firm tenant) | Default (company tenant) | Meaning |
|---|---|---|---|
| `client_roles_enabled` | false | true | Whether a client admin may author client roles. |
| `envelope_permission_set_id` | "Client staff envelope" (platform template) | "Company staff envelope" | **The maximum** any client role can contain. Client-role grants are validated as ⊆ envelope ∩ the client admin's own grants. |
| `client_admin_may_invite` | true (client staff + client contacts only) | true | Seats are created under the tenant. The audience is forced to `client_staff`/`external`. |
| `firm_approval_required_for` | `approve`, `release`, `post`, `configure` | none | New or changed client-role grants touching these actions need a tenant grantor's approval before they publish. |
| `max_client_members` | null | null | Optional seat cap. |
| `mfa_required` | true | tenant default | A floor on client-staff auth. |

The envelope is just a permission set, so firms can build "what clients may self-serve" in the same builder. The
standard "Client staff envelope" contains: AP bills create/approve on own client, expenses and receipts, client
requests, documents, reports view/export, cash position view, vendor/customer create/edit (no bank details),
invoices create/send. It contains **no** GL post, period, reconciliation sign-off, access outside the client,
integrations or AI-autonomy configuration.

### 1.7 Inheritance, versioning and template change

- **Lineage, not live inheritance.** Cloning copies grants into the new role's version 1 and records
  `upstream_template_id`/`upstream_version`. Edits upstream never flow down by themselves. (NetSuite and
  Salesforce both work this way: customized roles are copies. Live inheritance makes "what changed my access?"
  unanswerable.)
- **Versions are immutable.** Saving produces a draft version. **Publish** makes it current, either now or at a
  scheduled time. Assignments always resolve to the current published version. Rollback means publishing an older
  version's grants as a new version. Every publish is logged with a reason and its impact (§6.2).
- **When a template changes,** the platform publishes template v(n+1) with a changelog. Each change is classified
  as `add`, `remove`, `constraint`, `split` or `rename`.
  - `add` / `remove` / `constraint` → every derived tenant role shows **"Update available"** (role library and
    tenant-admin home). The admin opens the diff (their current grants vs vN vs vN+1) and can **Adopt all**,
    **Adopt safe changes** (read-only additions only), **Cherry-pick**, or **Dismiss**. Nothing applies until
    they act.
  - `split` (one capability becomes two finer ones) and `rename` are **equivalence-preserving**. They are applied
    automatically, so a role holding the parent gets both children and nobody's effective access changes. They
    are announced in the update inbox and logged as `catalog.equivalence_migration`.
  - **Restrictions apply immediately, globally and with notice.** This covers platform locks and SoD rules (§4)
    and is never done through template grants. Example: the platform adds a rule that vendor bank-detail edits
    need a second approver. That is a lock, not a template edit.
- **New capabilities from new features** ship absent from every tenant role. The tenant admin sees them in the
  update inbox with suggested roles. (Open question Q3.)
- **Client roles** can be cloned from tenant roles. The same lineage and update-available flow applies one level
  down.

### 1.8 Resolution (the order every decision follows)

```
authorize(principal, action, resource) →
 1  Authenticate: Clerk user → core.users → membership(org) ; status active ; not expired ; tenant not suspended
 2  Context: client = resource.location_id | group = resource.group_id | tenant-level
 3  Ceiling = catalog(cap,action valid)
            ∩ entitlements(module owned by tenant)              — suite rule: entitlements ∩ permissions
            ∩ audience ceiling(membership/role audience)
            ∩ client envelope (client-owned roles only)
            ∩ platform locks
 4  Grants  = ⋃ assignments covering context → current role/permission-set version grants
            − that assignment's mutes ; read_only ⇒ keep only view/export from that assignment
 5  Match   = grants for (cap, action) inside Ceiling ; none → DENY(no_grant | ceiling:<which>)
 6  Constraints, per matching grant (any one satisfied ⇒ pass; limits = max over passing grants):
            dimension restriction · amount ≤ limit · doc type · ownership · period rule
 7  Transaction SoD (hard): preparer≠approver≠releaser ; JE poster≠preparer ≥ threshold ;
            bank-detail change recency ; not acting on own access
 8  Auth obligations: MFA satisfied ; step-up fresh for release/configure ; IP allowed → else DENY(obligation)
 9  Field obligations: masks per field class (§3.6)
10  Return Decision{allow, reason, trace[matching assignment/role/version/grant], obligations, limits}
```

Deny is the default. The only explicit denies are mutes, read-only, ceilings, locks and SoD. Roles and permission
sets only *allow*, which keeps stacking predictable: more assignments can never reduce access, except through the
narrowing applied on a specific assignment.

---

## 2. Permission vocabulary

### 2.1 Actions (9 canonical)

| Action | Means | Implies | Today's verbs folded in |
|---|---|---|---|
| `view` | Read the screen and its data (masked per field policy) | — | view |
| `create` | Make new records, including drafts, requests, imports and "submit for approval" | view | create, request, generate, run (import) |
| `edit` | Change records that are not final: code a transaction, complete a close task, resolve an exception, prepare a reconciliation | view | edit, resolve, reconcile |
| `delete` | Delete or archive records that have never been final (drafts, masters with no activity). Posted items are reversed, never deleted. | view | delete |
| `approve` | A control decision that lets an item proceed (bill approval, reviewer sign-off, COA approval, budget lock) | view | approve |
| `post` | Write to the general ledger, including reversals and voids. The deterministic engine still enforces balance, period and control-account rules. | view | post |
| `release` | Cause an **irreversible external effect**: move money, transmit a bank, tax or IRS file, or deliver a document outside the tenant (invoice, dunning notice, lender certificate) | view | run (money), send |
| `export` | Take data out (download, scheduled email to self) | view | export |
| `configure` | Change settings, rules, templates or access for the resource | view | manage, assign |

`approve` does **not** imply `create`. `release` does **not** imply `approve`. That separation is what lets SoD
be expressed with roles at all.

**UI presets** (per resource row in the builder; they only set checkboxes): **None** · **View** (view, export) ·
**Prepare** (view, create, edit, delete-draft) · **Approve** (view, approve) · **Full** (all applicable). These
presets play the role of NetSuite's permission levels, but the underlying cells stay individually editable.

### 2.2 Capability catalog

Key format: `<module>.<domain>.<resource>:<action>`. The module is `books` unless noted (`core`, `platform`).
Below, the `books.` prefix is omitted. Actions: V view · C create · E edit · D delete · A approve · P post ·
R release · X export · K configure. Tags: **[M]** money effect, **[S]** sensitive fields, **[L]** locked (step-up
and MFA always required, never in `external` audiences), **[G]** group-scoped.

| Domain | Resource | Actions | Notes |
|---|---|---|---|
| **GL** | `gl.accounts` | V C E D A X K | C = request account. A = approve request (COA approval workflow). K = COA rules and groups. |
| | `gl.journal_entries` | V C E D A P X | A = reviewer approval. P = post. Txn SoD threshold (§4.1 H6). |
| | `gl.recurring_entries` | V C E D A P | Propose → approve → post. |
| | `gl.periods` | V E A K | E = open / soft-close. A = **hard close** (gated). K = fiscal calendar. |
| | `gl.period_override` | P [L] | Post into a soft-closed period. Hard-closed periods can't be posted to at all (DB 152). |
| | `gl.reporting_basis` | V C E P | Accrual/cash/tax overlay adjustments. |
| | `gl.dimensions` | V C E D K | Departments, classes, items. |
| | `gl.year_end` | V P | Close to retained earnings. |
| | `gl.intercompany` | V C E A P | Intercompany matching and pair balances. |
| | `gl.internal_invoices` | V C E A P R | R = issue to counterparty department or client. |
| | `gl.posted_edit` | E [L] | The "privileged override" edit of posted records (reverse and re-post, typed reason). |
| **Close** | `close.checklist` | V E A K | E = complete tasks / mark ready. A = reviewer sign-off. K = checklist templates. |
| | `close.package` | V X R | R = deliver the client packet. |
| **Bank** | `bank.connections` | V C D K [S] | Plaid link and account mapping. |
| | `bank.transactions` | V E A X | E = code. A = approve coding, which posts through the engine (no separate P needed; the engine owns the JE). |
| | `bank.rules` | V C E D | Deterministic coding rules. |
| | `bank.statements` | V C | Statement import. |
| | `bank.reconciliations` | V C E A X | E = preparer signs. A = **reviewer sign-off** (replaces the borrowed money `canApprove`). |
| | `bank.transfers` | V C A R [M] | Planned: transfers between accounts and clients. |
| **Cards** | `cards.transactions` | V E A X | Card feed, including Ramp. |
| | `cards.ramp_sync` | V K | Push COA/dimensions/vendors to Ramp. |
| **AP** | `ap.bills` | V C E D A P X | Includes intake queue and OCR drafts. |
| | `ap.vendor_credits` | V C A P | |
| | `ap.purchase_orders` | V C E D A | Includes goods receipts and 3-way match. |
| | `ap.policy` | V K | AP policy engine (NL → rules). |
| **Payments** | `pay.batches` | V C E A R X [M] | Pay runs and check runs. C = build/queue (today `check_run`). A = approve. R = release (today `ap_disbursement_release`). X = positive-pay / NACHA file. |
| | `pay.checks` | V C E P | C/E = assign numbers, print, remittance PDF. P = void (posts reversal). |
| | `pay.customer_payments` | V C E P | Record payment / cash application (today `payments_execute`). |
| | `pay.refunds` | V C A R [M] | |
| | `pay.vendor_bank_details` | V E [S][L] | Bank account and routing on vendor payment profiles. Split out of vendor edit because it is the most common payment-fraud vector. |
| | `pay.provider_connections` | V K [L] | Stripe/ACH/bank origination setup. |
| **Expenses** | `exp.receipts` | V C E D A | Supports the ownership constraint (own / team / all). |
| | `exp.reports` | V C E A | Expense reports and approver queue. |
| | `exp.reimbursements` | V C A R [M] | Reimbursement batches. |
| | `exp.policy` | V K | Mileage, per-diem and out-of-policy rules. |
| **AR** | `ar.invoices` | V C E D A P R X | R = send to customer. P = post/void. |
| | `ar.credit_memos` | V C A P | |
| | `ar.write_offs` | V C A P | |
| | `ar.estimates` | V C E D R | |
| | `ar.deposits` | V C P | Customer deposits and retainers. |
| | `ar.recurring` | V C E D | |
| | `ar.collections` | V E R | E = worklist, promise-to-pay. R = send dunning. |
| | `ar.statements` | V R | |
| | `ar.payment_links` | V K | Stripe Pay Now per client. |
| **Rev rec** | `revrec.methods` | V E K | Per-job method assignment (9 methods). |
| | `revrec.runs` | V C P | Recognition runs, 2410/1180 entries. |
| | `revrec.schedules` | V X | Roll-forward, waterfall. |
| **Jobs** | `jobs.jobs` | V C E D | Jobs, cost codes, job P&L. |
| | `jobs.change_orders` | V C A | |
| | `jobs.wip` | V E P X | WIP schedule, EAC, over/under-billing adjustments. |
| **Inventory** | `inv.items` | V C E D | |
| | `inv.movements` | V C A P | Movement approval. |
| | `inv.valuation` | V P K | FIFO/standard, GL tie-out. |
| **Assets** | `fa.assets` | V C E D P | Includes depreciation runs (P), tax book, disposals. |
| | `fa.leases` | V C E P | ASC 842 commence, modify, terminate. |
| | `fa.prepaids` | V C E P | Prepaids, insurance amortization, intangibles. |
| **Debt** | `debt.loans` | V C E P | Origination, P&I, payoff, refinance. |
| | `debt.covenants` | V E K | Monitor and compute. |
| | `debt.certificates` | V C A R | Compliance certificate. R = send to lender. |
| | `debt.borrowing_base` | V C A R | |
| **Cash** | `cash.position` | V | |
| | `cash.forecast` | V C E | 13-week and direct forecast. |
| | `cash.obligations` | V C E | Renewals and subscriptions calendar. |
| **Payroll** | `payroll.runs` | V C E A R [M] | R = release to provider (today `payroll_release`). |
| | `payroll.register` | V C P | Register import → JE. |
| | `payroll.employees` | V C E [S] | HR record. Pay rate and bank fields fall under field classes `comp` and `bank`. |
| | `payroll.remittances` | V C R [M] | |
| | `payroll.settings` | V K | Pay schedules, register mappings, provider. |
| **Tax** | `tax.sales_tax` | V E P K | Rates, worksheet, filing calendar, nexus. |
| | `tax.filings` | V C A R | R = file (sales-tax return, FIRE 1099 transmission). |
| | `tax.1099` | V C E X [S] | W-9 gaps, Copy B. Field class `tin`. |
| | `tax.provision` | V C E P | ASC 740, book-to-tax M-1/M-3, return package. |
| **FP&A** | `fpa.budgets` | V C E A X | A = lock a budget version. |
| | `fpa.scenarios` | V C E | Drivers, reforecast, what-if. |
| | `fpa.profitability` | V X | |
| **Reports** | `reports.financial` | V X | P&L, BS, CF, TB, GL detail, aging. |
| | `reports.saved_views` | V C E D | |
| | `reports.packs` | V C E R | R = scheduled delivery to others. |
| | `reports.board_package` | V C A R | |
| **Consolidation** | `consol.groups` | V C E D K [G] | K = membership, method, FX. |
| | `consol.statements` | V X [G] | Requires all-member access (§3.9). |
| | `consol.eliminations` | V C P [G] | Group-level top-side adjustments. |
| **Controls** | `ctl.exceptions` | V E A | E = resolve. A = accept risk. |
| | `ctl.approval_workflows` | V K | Mig 092 chains, simulator. |
| | `ctl.compliance` | V E A | SOX command center. |
| | `ctl.vendor_compliance` | V E A | W-9/COI. |
| | `ctl.pbc` | V C E A | Auditor request list. |
| | `ctl.audit_trail` | V X | |
| | `ctl.ai_decisions` | V X | AI decision log. |
| **Masters** | `mdm.vendors` | V C E D | Merge and dedupe = E. Bank details are **not** included (see `pay.vendor_bank_details`). |
| | `mdm.customers` | V C E D | Merge, risk dossier. |
| | `mdm.items` | V C E D | |
| **Docs & requests** | `docs.documents` | V C D X | |
| | `req.client_requests` | V C E R | C/E = draft and answer. R = send / remind (external). |
| **Portals** | `portal.customer` | V K R | R = issue magic link. |
| | `portal.vendor` | V K R | |
| | `portal.client` | V K | Firm-client portal (planned). |
| **Onboarding** | `onb.clients` | V C E D | Add/archive clients (`D` = archive). |
| | `onb.wizard` | V E | Replaces admin_scope PREPARER. |
| | `onb.imports` | V C P | TB/AR/AP/WIP/equity imports. P = post opening balances. |
| | `onb.conversion` | V A P | A = pass the tie-out gate. |
| **Integrations** | `int.connections` | V C D K [L] | QBO/Xero/Sage/ERP/Ramp connectors. |
| | `int.api_keys` | V C D [L] | |
| | `int.sync_runs` | V E | Retry, resolve sync errors. |
| **AI** | `ai.assist` | V | ⌘K / NL query, JE composer drafts (outputs still need the underlying capability to save). |
| | `ai.agents` | V C K | C = run an agent recipe. K = recipe settings. |
| | `ai.autonomy` | V K [L] | Autonomy dial and kill switch. |
| **Workspace** | `home.workspace` | V | Tenant workspace surfaces. Widgets add their own capability (IA §5.4). |
| | `home.client` | V | Client home. |
| | `ws.client_health` | V | Operations / client health, capacity. |
| | `ws.assignments` | V C E D | Capacity assignments (IA M-5). Bounded by the ceiling. |
| **Access (core)** | `core.access.members` | V C E D | Invite, deactivate, edit profile. |
| | `core.access.roles` | V C E D K [L] | Author roles and permission sets. K = publish. |
| | `core.access.assignments` | V C E D [L] | Grant and revoke (ceiling, §4.2). |
| | `core.access.reviews` | V C A X | Run and attest access reviews. |
| | `core.access.simulate` | V | View-as (read-only, §5.6). |
| | `core.access.sod_policy` | V K [L] | Tighten SoD, approve exceptions. |
| **Tenant (core)** | `core.tenant.settings` | V K [L] | System, security (MFA/IP/session), branding. |
| | `core.tenant.accounting_settings` | V K | GL rules, close gates (today `settings_acct`). |
| | `core.tenant.billing` | V K | Plan, payment method. K limited to the billing owner. |
| | `core.tenant.dashboard_layouts` | V K | Publish role layouts (IA M-8). |
| | `core.tenant.support_access` | V A | Approve platform support grants (IA M-9). |
| | `core.tenant.export` | X [L] | Full tenant export. |
| | `core.tenant.reset` | D [L] | Sandbox/tenant reset. Two-person rule. |
| **Platform** | `platform.tenants` | V C E | Provision, suspend, lifecycle. |
| | `platform.entitlements` | V K | |
| | `platform.templates` | V C E K | Role, permission-set and envelope templates, SoD rules, dashboard defaults. |
| | `platform.support` | V C | Request support access, run sessions. |
| | `platform.billing` | V K | |
| | `platform.health` | V | Ops, AI gateway, integrations. |
| | `platform.break_glass` | C [L] | Incident access per IA Q6. |

That is about 110 resources. The catalog is a **code registry** (`packages/core-access/catalog/*.ts`, one file per
module, each entry carrying `resource`, `actions`, `label`, `description`, `tags`, `fieldClasses`,
`supportsConstraints[]`, `introducedIn`, `aliases`). It is mirrored to `core.capabilities` at deploy time so the DB
can foreign-key and RLS functions can read it. A guard test fails the build if a route, page, widget or nav item
references a capability that isn't in the registry, **or if a page/route has no capability** (closes C7).

### 2.3 Mapping every existing `permissions.ts` key

The backfill (R-2) applies these mappings so that **effective access is unchanged**, except where a row says
"tighten".

| Old feature : actions | New capability(ies) | Notes |
|---|---|---|
| `dashboard`: view | `home.workspace:V`, `home.client:V` | Widgets gated individually (IA §5.4). |
| `bank_feed`: view/edit/approve | `bank.transactions` V/E/A, `bank.rules` C E D (where edit) | |
| `credit_cards`: view/edit/approve | `cards.transactions` V/E/A | |
| `receipts`: view/edit/approve | `exp.receipts` V/E+C/A | |
| `bills`: view/create/approve | `ap.bills` V / C+E+D / A ; `ap.purchase_orders` same; `ap.vendor_credits` C/A | `/purchase-orders` borrowed `bills`. Split with the same grants. |
| `journal_entries`: view/create/post | `gl.journal_entries` V / C+E+D / P | |
| `flagged`: view/resolve | `ctl.exceptions` V / E | |
| `vendors`: view/create/edit | `mdm.vendors` V/C/E | **Tighten:** `pay.vendor_bank_details:E` granted only to roles that held `vendors:edit` **and** a money-approve key. The others get V (masked). Listed in the migration report. |
| `customers`: view/create/edit | `mdm.customers` V/C/E | |
| `invoices`: view/create/approve | `ar.invoices` V / C+E+R / A ; `ar.estimates`, `ar.deposits`, `ar.collections`, `ar.statements`, `ar.recurring`, `ar.credit_memos` and `revrec.*` get the same pattern | These all borrowed `invoices`. Split with equivalent grants. |
| `jobs`: view/create/edit | `jobs.jobs` V/C/E ; `jobs.change_orders`, `jobs.wip` same | `/jobs/wip` borrowed it. |
| `reports`: view/export | `reports.financial` V/X ; `fpa.budgets`, `fpa.scenarios`, `fpa.profitability`, `reports.board_package`, `debt.borrowing_base` V(+X) | **Tighten:** `consol.statements` needs a group grant on top (IA R4). Roles with `all_clients` get group view per IA Q4. |
| `chart_of_accounts`: view/request/approve | `gl.accounts` V/C/A | |
| `reconciliation`: view/reconcile | `bank.reconciliations` V / C+E ; **A** granted to roles that pass today's `canApprove` | Ends the borrowing of money approval. |
| `close_mgmt`: view/manage | `close.checklist` V / E+A ; `gl.periods` V / E (+A for company_admin, cfo, merit_controller, accounting_manager as today) | The hard-close A split is equivalence-preserving at backfill. Tenants can then narrow it. |
| `payroll`: view/create/approve | `payroll.register` V/C+P ; `payroll.runs` V/C+E/A ; `payroll.employees` V/E | |
| `intercompany`: view/create | `gl.intercompany` V/C+E+P ; `gl.internal_invoices` V/C+E+R | |
| `payments`: view/run | retired coarse superset | It existed only as a fallback (`requireMoneyMovement` tier 2). Its holders get the granular keys below. |
| `payments_execute`: view/run | `pay.customer_payments` V / C+E+P | |
| `check_run`: view/run | `pay.batches` V / C+E | |
| `ap_disbursement_release`: view/run | `pay.batches` R | |
| `payroll_release`: view/run | `payroll.runs` R | |
| `cash_position`: view | `cash.position` V | |
| `forecast`: view/edit | `cash.forecast` V / C+E ; `cash.obligations` same | |
| `team`: view/manage | `core.access.members` V / C+E+D ; `ws.assignments` V / C+E+D | |
| `user_permissions`: view/assign | `core.access.roles` V / C+E+D+K ; `core.access.assignments` V / C+E+D | It now actually gates admin (closes C5). |
| `compliance`: view/manage | `ctl.vendor_compliance` V/E+A ; `ctl.compliance` V/E+A ; `ctl.pbc` V/C+E+A | `/pbc` borrowed it. |
| `fixed_assets`: view/create | `fa.assets`, `fa.leases`, `fa.prepaids` V / C+E+P | |
| `recurring`: view/create | `gl.recurring_entries` V/C+E (+P where `journal_entries:post`) | |
| `settings_acct`: view/edit | `core.tenant.accounting_settings` V/K | |
| `settings_system`: view/edit | `core.tenant.settings` V/K ; split: `core.tenant.billing`, `pay.provider_connections`, `ctl.approval_workflows`, `ai.autonomy`, `int.connections`, `ws.client_health` | These pages borrowed it. Split with equivalent grants. |
| `import`: view/run | `onb.imports` V/C (+P where `journal_entries:post`) ; `onb.conversion` V/A+P | |
| `audit_trail`: view | `ctl.audit_trail` V ; `ctl.ai_decisions` V | |
| `checks`: view/create/approve | `pay.checks` V/C+E ; `pay.batches` A (where approve) | |
| `biz_*` (6 keys) | retired | `business_user` → **Owner** template on `assigned` scope: `reports.financial` V X, `ar.invoices` V, `jobs.jobs` V, `cash.position` V, payroll comp `grouped`. |
| flag `canManageUsers` | `core.access.*` per row above | |
| flag `canEditAccountingSettings` | `core.tenant.accounting_settings:K` | |
| flag `canEditSystemSettings` | `core.tenant.settings:K` | |
| flag `mfaRequired` | role `auth_policy.mfa_required` | |
| flag `payrollVisibility` | role `field_policy.comp` (§3.6) | |
| flag `companyScope` | role `default_scope` + backfilled assignment scope | `portcos_and_3rdparty` → `all_clients` **minus** the tenant's own books becomes a saved client set "All clients except own books". This keeps today's behavior, which is visible and reviewable. |
| `assignableBy[]` | role `assignable_band` + the ceiling rule | |
| `admin_scope` MANAGEMENT / PREPARER (mig 109) | MANAGEMENT → `core.access.members` C/E, `core.access.assignments` C/E ; PREPARER → `onb.wizard:E`, `onb.imports:C` | Ends the fail-open parallel system (C10). |
| unmapped pages (debt, tax, expenses, inventory, documents, agents, AI decisions, obligations, subscriptions, inbox, departments, categorize, search) | `debt.*`, `tax.*`, `exp.*`, `inv.*`, `docs.documents`, `ai.agents`, `ctl.ai_decisions`, `cash.obligations`, `ctl.exceptions` (inbox aggregates per item), `gl.dimensions`, `bank.transactions`, `ai.assist` | Backfill grants **V** to every internal role that had `reports:view`, and writes as today's routes allow. This is equivalence-preserving because the pages were ungated, and it is reported for review. |

---

## 3. Data scopes and constraints

Constraints attach to a **grant**: a role-version grant, a permission-set grant, or an assignment-level override,
which may only tighten. When several grants match, the request passes if **any** one passes, and the effective
dollar limit is the **highest** among passing grants. Every constraint is evaluated server-side in `authorize()`.
List endpoints apply the same constraints as query filters, so a list never contains rows the user would be
denied when opening them.

### 3.1 Client scope

Scope is set by assignment: `all_clients` · `client` · `client_set` (static or dynamic) · `consolidation_group`
· `tenant` (§1.4). The tenant's own books are an ordinary client (IA §2.1). There is no special "can see
management company" capability.

**Read-only cross-client view.** Use an assignment with `read_only = true` and an `all_clients` or `client_set`
scope. Typical holders are a reviewing manager, owner or lender-package preparer. The standard "View-only" role is
the same thing as a role.

### 3.2 Entity and subsidiary

A client is one legal entity, so entity scope is client scope. Subsidiaries are separate clients linked through
`entity_ownership`. Seeing a parent never implies seeing its subsidiaries. Roll-ups go through §3.9.

### 3.3 Dimension restrictions (NetSuite-style)

`dimension_restriction` constraint: `{ dimension: department|class|job, values: uuid[] | "my_departments", mode:
"view_and_edit" | "edit_only", include_unassigned: bool }`.

- `view_and_edit`: rows outside the values are invisible (lists, drill, reports filtered).
- `edit_only`: the holder can see all rows but can only change or approve rows tagged with the values. This suits
  department heads approving their own department's bills while seeing the company P&L.
- `my_departments` resolves through `core.membership_departments` (IA M-3).
- Reports under a restriction show a **"Filtered to: Service, Install"** chip, and totals are labelled as partial.
  A restricted user never sees an unlabelled company total.

### 3.4 Dollar limits

`amount_limit` constraint on `approve`, `post` or `release`: `{ max_per_item_cents, max_per_day_cents?,
currency: "client_functional" }`.

- Template defaults are in §7, and tenants set their own.
- **Approval workflows (mig 092) key on capability plus limit, not role.** `approval_workflow_steps` gains
  `approver_capability` (e.g. `ap.bills:approve`) and `min_approver_limit_cents`. A step is satisfied by anyone
  whose effective grant passes for that amount. `approver_role` stays as a compat column for one release (closes
  C8).
- **Over-limit UX:** the Approve button becomes **"Approve up to your limit → route to next approver"** and shows
  who can approve. This is the one case where an action is shown in an altered state rather than hidden.
- `max_per_day_cents` applies to `release` only. It is a sum over the holder's releases per client per business
  day.

### 3.5 Document types and ownership

- `doc_types` constraint: `{ allowed: ["bill","vendor_credit","expense_report","po"] }` or, for JEs,
  `["standard","adjusting","reversing","accrual"]` (`closing`/year-end only through `gl.year_end`). It lets a
  tenant say "AP clerk may approve expense reports but not bills".
- `ownership` constraint: `own` (records they created or are the employee on) · `team` (their department or
  direct reports) · `all`. Used for receipts, expense reports and saved views.
- `period` constraint on `post`: `open_only` (default) · `allow_soft_closed` (equivalent to holding
  `gl.period_override:P`).

### 3.6 Field-level sensitivity

| Field class | Fields | Levels (per role field_policy; assignment may only tighten) |
|---|---|---|
| `comp` | Pay rates, gross/net per person, bonuses, payroll register lines | `hidden` · `grouped` (department/client totals only; today's "grouped") · `visible` (today's "ungrouped") |
| `tin` | SSN, ITIN, EIN of sole proprietors on W-9 / 1099 / employee records | `hidden` · `masked` (last 4) · `reveal_logged` (click to reveal; each reveal logged with reason) · `visible` |
| `bank` | Bank account and routing numbers (vendor profiles, employee direct deposit, tenant accounts) | same as `tin` |
| `personal` | Employee home address, DOB, personal phone | `hidden` · `visible` |
| `secrets` | API keys, provider tokens | **never** visible after creation (platform lock). Rotate only. |

Enforcement:

1. Serializers in the API apply masks from `Decision.obligations` before responding.
2. The DB exposes `*_masked` views (e.g. `v_vendor_payment_profiles_masked`) that user-scoped clients read. Raw
   tables are definer-only.
3. Exports honor the same mask.
4. AI gateway prompts never include `tin`, `bank` or `secrets` fields, regardless of the requester.

Defaults: `external` audiences get `tin`/`bank` = `masked`, and `comp` = `grouped`. An auditor can be raised to
`reveal_logged` through a permission set.

### 3.7 Time-boxed grants

- Every assignment and permission-set grant has `effective_from` and `effective_to`. A role's
  `max_assignment_days` forces `effective_to` (the auditor default is 120 days; a tenant can set up to 365).
- **Expiry reminders** go to the grantor and holder 7 days and 1 day before. Renewal is one click and re-runs the
  ceiling and SoD checks.
- A sweeper job deactivates grants at `effective_to` and bumps the access epoch (§5.4). As defense in depth,
  `can_access_location()` checks the date in the DB.

### 3.8 Authentication requirements per role

| Policy | Mechanism | Default |
|---|---|---|
| `mfa_required` | The PDP rejects a session without a verified second factor. Uses the Clerk session factor-verification claim; the UI forces enrollment. | On for every `internal_staff` role that holds any [M] or [L] capability. On for platform roles. Tenant setting can require it for all. |
| `step_up_minutes` | `release`, `configure` on [L] resources, and `pay.vendor_bank_details:E` require a re-verification within N minutes (Clerk reverification) | 10 minutes |
| `ip_allowlist_id` | Tenant-defined CIDR lists (`core.ip_allowlists`). Checked against the platform-verified client IP. | Off. Tenants can bind to any role. |
| `session_max_hours` / `idle_timeout_minutes` | Checked against session issue time and last activity | 12 h / 60 min for [M] roles |

The decision returns `obligation: "step_up"` and the UI shows the re-verification prompt instead of a 403.

### 3.9 Consolidation-group access

- `consol.*` capabilities are only meaningful with a `consolidation_group` scope, or an `all_clients` role (IA Q4:
  implicit **view**).
- **Validity rule (hard):** the holder must be able to `view` `reports.financial` on **every** current member.
  Group creation, member add and grant creation check it. When a member is added and a holder lacks access to it,
  that holder's group grant is **suspended**, not deleted, and the grantor is notified (IA M-6 trigger).
- Eliminations and member figures are returned only by the group route. Member-level drill links are filtered by
  the user's own member access, which by the rule above is all of them.

---

## 4. Guardrails

### 4.1 Hard rules (platform-locked; no tenant or client can configure them away)

| # | Rule | Enforced where |
|---|---|---|
| H1 | **No self-administration.** No one may create, edit, extend or delete their own assignments, permission sets, limits, mutes or SoD exceptions, or approve their own grant request. | PDP + DB check (`granted_by <> membership.user_id`) |
| H2 | **Delegation ceiling** (§4.2). You can only grant what you hold, on clients you can access, with limits at most your own and durations at most your own remaining time box. | PDP + DB trigger on `access_assignments` |
| H3 | **Audience ceilings.** `external` roles (auditor, client contact) can never hold `post`, `release`, `configure`, or `approve` on [M] resources, any [L] resource, or `core.access.*`. `client_staff` roles can never exceed their client envelope. | Catalog + publish validation + PDP |
| H4 | **Auditor is read-only and time-boxed.** Only `view`/`export` plus `ctl.pbc` C/E/A. `effective_to` is required. | Template lock |
| H5 | **Platform capabilities stay in platform roles.** Tenants can't grant `platform.*`. Platform roles hold no tenant data access; that only comes through an approved support grant (IA M-9). | Catalog + PDP |
| H6 | **Transaction SoD on money and GL.** The preparer cannot approve or release the same item. The approver cannot release it unless the tenant is in sole-approver mode (Q1). The poster of a manual JE at or above the threshold (Q4) must differ from its preparer. A releaser cannot release a payment to a vendor whose bank details they changed or approved in the last 10 days. | DB (mig 042 CHECK, extended) + PDP step 7 |
| H7 | **Access history is immutable.** `core.access_change_log` is append-only (trigger as mig 153). No capability can delete it. | DB |
| H8 | **Support and break-glass can't self-authorize.** The requester of support access can't approve it. Break-glass needs a second platform admin. | M-9 + PDP |
| H9 | **Last-admin protection.** The tenant always has at least one active member holding `core.access.assignments` on `all_clients` + `core.tenant.settings:K`, and exactly one billing owner. | DB trigger |
| H10 | **Secrets are never readable** after creation (§3.6). | Serializer + DB |

### 4.2 The delegation ceiling (the general form of IA §2.6)

A grantor G may create or extend assignment X (role or permission set R, scope S, constraints C, dates D) only if
**all** of the following hold:

1. G holds `core.access.assignments:create` (or `:edit`) on every client in S, or on `tenant` for tenant-scope
   grants.
2. For every capability in R that lies inside the ceiling, G holds it on every client in S, with constraints at
   least as permissive: limits ≥ C's limits, dimension values ⊇ C's, field levels ≥ C's.
3. R's `assignable_band` admits G.
4. D's end ≤ G's own grant end, if G is time-boxed.
5. The grantee is not G (H1).
6. If R or C crosses a **high-risk** line (any `release`, `core.access.*`, `pay.vendor_bank_details:E`,
   `ai.autonomy:K`, limit > $100k), the grant is created **pending** and needs a second grantor's approval (Q5).

**The tenant admin is the root of trust.** Holders of the standard Tenant admin role may assign any tenant role on
any client even without holding its capabilities. This is how a non-accountant admin can staff a controller. Items
5 and 6 still apply.

**Role authoring is not granting.** `core.access.roles:K` lets you *author and publish* roles within the tenant
ceiling (catalog ∩ entitlements ∩ audience). The risk is controlled at *assignment*, so authoring needs no
holder-ceiling. Editing a published role that **you** hold is allowed, but publishing it re-runs H1: if the change
widens your own access, the publish needs a second approver.

**Revocation** is allowed to anyone who could grant the assignment, plus the tenant admin. Revoking never needs a
second approval.

**Client admins** apply the same ceiling with S limited to their client and R limited to client roles inside the
envelope (§1.6).

### 4.3 Static SoD rules (role-level, on the effective set per client)

Platform-defined defaults (`core.sod_rules`). Each rule has an `enforcement` of `soft` or `hard`. A tenant may
promote soft → hard. Only the platform can demote.

| # | Conflict (same person, same client) | Default | Why |
|---|---|---|---|
| S1 | `pay.batches:C` + `pay.batches:A` + `pay.batches:R` (all three) | soft | Full payment chain in one person. Common in owner-run companies; flagged for review. |
| S2 | `pay.vendor_bank_details:E` + `pay.batches:R` | soft (firm tenants: **hard**) | Change-the-account-then-pay fraud. |
| S3 | `ar.credit_memos:A` or `ar.write_offs:A` + `pay.customer_payments:C` | soft | Lapping / skimming. |
| S4 | `payroll.employees:E` (comp or bank) + `payroll.runs:R` | soft (firm: **hard**) | Ghost employee / rate change then release. |
| S5 | `gl.journal_entries:P` + `gl.periods:E` (reopen) | soft | Posting into a reopened period without oversight. |
| S6 | `core.access.assignments:C` + any `release` | soft | Access admin plus money release. H1 blocks self-grants, but two admins could still grant each other. |
| S7 | `mdm.vendors:C` + `ap.bills:A` + `pay.batches:R` | soft | Fictitious-vendor chain. |
| S8 | `ai.autonomy:K` + `pay.batches:R` | soft | Enabling auto-actions on what one releases. |
| S9 | `bank.reconciliations:E` + `bank.reconciliations:A` | **txn-only** | The same person may hold both but never sign both sides of one reconciliation (IA Q5 governs the tenant setting). |

**Behavior.**
- **Hard:** the role builder blocks publishing a role that contains the conflict, and the assignment dialog blocks
  a grant that would create it in the effective set. Both show the rule and the conflicting source.
- **Soft:** inline amber warning. The grantor must enter a justification and an optional compensating control
  ("CFO reviews release report weekly"). This creates a `core.sod_exceptions` row with an expiry (default 1 year)
  that appears in every access review until removed.
- SoD is evaluated on the **effective set** (roles + permission sets − mutes), not per role. Two harmless roles
  that together conflict are caught.

### 4.4 Least-privilege defaults

- An invite with no chosen role creates a membership with **no assignments**, which shows a "Waiting for access"
  screen. There is no implicit dashboard role.
- A custom role created "from scratch" starts empty. "Clone" copies the source's grants exactly.
- New catalog capabilities are absent until adopted (§1.7).
- `assigned` scope is the default for every template except Tenant admin, Owner (company tenants), CFO and
  Controller.
- **Usage-based right-sizing (proactive).** `core.capability_usage` records `last_used_at` per (membership, client,
  capability). Access review flags grants unused for 90 days and proposes a one-click reduction. The role builder
  shows "used by 2 of 14 holders in the last 90 days" per row.
- **Dormant access.** A client assignment with no activity on that client for 90 days is flagged (IA §2.6).

### 4.5 Break-glass and emergency access

- **Platform break-glass** follows IA Q6: incident-only, 30 minutes, read-only, second platform admin, tenant admin
  notified immediately, shown in the tenant log.
- **Tenant emergency access (proactive):** a sealed permission set "Emergency finance access" that the tenant admin
  pre-defines and names who may activate (e.g. the controller when the CFO is unreachable during a payroll
  emergency). Activation needs a reason and a second person (any tenant admin or CFO). It expires after 4 hours,
  notifies all tenant admins, and is flagged in the next access review.
- **Tenant-admin lockout recovery** is a platform process: identity verified out of band, two platform admins
  approve, a new tenant-admin assignment is created, and the event is logged in the tenant log. Platform staff
  never gain books access through it.

---

## 5. Enforcement architecture

### 5.1 One policy decision point

`packages/core-access` (suite-level, per the identity model's "Core owns"):

```
authorize(ctx, cap: CapabilityKey, action: Action, resource?: ResourceRef) → Decision
  ResourceRef = { locationId?, groupId?, amountCents?, docType?, dimensions?, ownerUserId?,
                  preparedBy?, approvedBy?, bankDetailsChangedBy?/At?, periodStatus? }
  Decision    = { allow, reason: 'ok'|'no_grant'|'ceiling:entitlement'|'ceiling:audience'|'ceiling:envelope'
                  |'lock'|'constraint:limit'|'constraint:dimension'|'constraint:doc_type'|'constraint:ownership'
                  |'sod:txn'|'auth:mfa'|'auth:step_up'|'auth:ip'|'membership_inactive'|'tenant_suspended',
                  trace: GrantRef[], limits?, obligations: { masks, stepUp?, routeTo? } }

can(ctx, cap, action, resource?) → boolean        (sugar)
require(ctx, cap, action, resource?) → void|403   (throws ForbiddenError with reason + requestAccess hint)
accessibleClients(ctx, cap, action) → uuid[]|'all' (for list filters)
compile(membershipId) → AccessSnapshot            (cached; §5.4)
```

**Wiring (each consumer is replaced, not wrapped):**

| Today | Becomes |
|---|---|
| `requirePermission(userId, feature, action)` (reads `employees.role`) | `require(ctx, cap, action, resource)` via `apiHandler` ctx (`ctx.access`) |
| `requirePagePermission(feature, action)` (reads memberships) | `requirePageAccess(cap, action, { clientFromContext })` |
| `canApprove()` + `roleMayApproveMoney()` (static) | `require(ctx, 'pay.batches' \| 'payroll.runs' \| 'pay.refunds', 'approve', { amount, preparedBy })` (closes C3) |
| `requireMoneyMovement()` three-tier fallback | Deleted. Routes call `require(…, 'release', …)` directly. |
| `requireManageUsers()` (`canManageUsers`) | `require(ctx, 'core.access.assignments', 'create', { locationId })` + ceiling check (closes C5) |
| `admin-scope-guard` (fail-open) | `require(ctx, 'onb.wizard', 'edit', …)` (closes C10) |
| `/api/me` static `featurePermissions` | `/api/access/me` compiled snapshot (closes C6) |
| `nav-permissions.ts` href map | The nav registry carries `requiredCapability` for **every** item. Unmapped is a build failure (closes C7). |
| Approval steps `approver_role` | `approver_capability` + `min_approver_limit_cents` (closes C8) |

**`apiHandler` gains a declarative form:** `apiHandler(schema, handler, { access: { cap: 'ap.bills', action:
'approve', resource: (body) => ({ locationId: body.locationId, amountCents: body.totalCents }) } })`. A guard test
asserts every route under `app/api/**` (except the allowlisted public token routes and webhooks) declares
`access` or calls `require()`.

### 5.2 Database-level enforcement

Defense in depth. The application decision point is primary while 99 routes still use the admin client (C9).

1. **Client access in RLS.** IA M-4 stands, but `public.can_access_location(loc)` reads
   **`core.effective_access`** (§5.4) instead of `membership_locations`. A row exists for a `*` scope (all
   clients) or for the location, and it is unexpired. The RLS template for every `location_id` table is `org_id =
   get_org_id() AND (location_id IS NULL OR can_access_location(location_id))`. Child tables follow their parent.
2. **State transitions through definer RPCs.** Posting, approving and releasing happen in
   `security definer` functions (`books.post_journal_entry(id)`, `books.approve_item(kind,id)`,
   `books.release_batch(id)`, `books.post_bank_coding(ids[])`). Each one calls
   `core.has_capability(actor_membership, location, cap, action, amount)` and the transaction-SoD checks before
   changing status. The actor is read from the JWT (user-scoped client), or from a signed actor parameter that only
   the app's service path can supply. **A direct `update … set status='POSTED'` is revoked from `authenticated`
   and `anon`.**
3. **Masked views** for field classes (§3.6). Raw sensitive columns are readable only by definer functions.
4. **Grant-integrity triggers** on `access_assignments`, `role_versions` and `permission_set_grants` enforce H1,
   H2, H3, H9, the hard SoD rules and the envelope. The app cannot write a grant the DB considers illegal.
5. **Guard tests:**
   - Extend `schema.test.ts` so every policy on a `location_id` table calls `can_access_location`, and no
     status-transition column is directly updatable by `authenticated`.
   - Extend `tenant-isolation.test.ts` to two clients × two bookkeepers × one consolidation group.
   - New `access-ceiling.test.ts` property tests: random role/permission-set/mute/scope combinations must never let
     a grantor create access exceeding their own.

### 5.3 Permission-filtered UI

- `/api/access/me?client=<id>` returns `{ epoch, capabilities: {cap: actions[]}, limits, fieldLevels,
  clients: 'all' | uuid[], groups: [] }` for the current context. It is computed server-side and compact
  (capability keys, not rows).
- Client hooks: `useCan(cap, action)`, `<Can cap action>…</Can>`, `useLimit(cap, action)`.
- **Hidden, not disabled.** Nav items, tabs, buttons, bulk actions, row menu items and widgets the user can't use
  are not rendered. The only exceptions are a limit-constrained action (shown as "route to approver") and a
  step-up obligation (shown with a lock glyph that triggers re-verification).
- The nav, widget registry (IA §5.4) and command palette (⌘K) all filter by the same snapshot. ⌘K never offers an
  action the user can't take.
- **A 403 is never a dead end.** Direct URL access to a denied page renders "You don't have access to Debt &
  covenants on Heritage Interiors" with **Request access** (pre-filled capability, client and reason). The request
  goes to the nearest grantor who holds it.
- The client is a convenience, never authority. Every action re-checks server-side.

### 5.4 Compilation, caching and invalidation

- **`core.effective_access`** (materialized): `(membership_id, scope_key ['*' | location_id | 'group:'+id], cap,
  actions text[], constraints jsonb, sources jsonb, valid_to)`. It is rebuilt by
  `core.rebuild_effective_access(membership_id)`.
- **Triggers** enqueue rebuilds on any change to assignments, permission-set grants, mutes, role or permission-set
  publish, envelope, catalog equivalence migration, client-set membership change or expiry sweep. A role publish
  that affects N holders runs as one job and reports progress in the publish dialog.
- **`access_epoch bigint`** on `core.memberships`, bumped by every rebuild. API requests already read the
  membership. The in-memory snapshot cache (per instance, keyed `(membership_id, epoch)`, LRU, 5-minute TTL) is
  valid only while the epoch matches. **Revocation takes effect on the next request.**
- **Permissions are never put in the Clerk JWT.** The JWT carries identity and active org only, so token lifetime
  never delays a revocation (this resolves FPB §16's "TTL vs revocation" question).
- The browser refetches `/api/access/me` on window focus and when any response carries `code:
  'ACCESS_STALE'` (sent when the request's epoch header is older than current).

### 5.5 Audit of every grant change

`core.access_change_log` (append-only, H7):

- **Columns:** `id`, `org_id`, `at`, `actor_user_id`, `actor_context` (`tenant` | `client:<id>` | `platform:<session>` |
  `system:sweeper`), `event`, `subject_type`, `subject_id`, `affected_membership_ids[]`, `location_ids[]`,
  `before jsonb`, `after jsonb`, `reason`, `approval_ref`, `sod_exception_id`, `request_ip`.
- **Events:** role/permission-set create, version publish, rollback, archive; assignment grant, revoke, extend,
  expire; mute; limit change; envelope change; SoD exception create/expire; template update adopt/dismiss;
  catalog equivalence migration; view-as start/end; field reveal (`tin`/`bank`); break-glass and emergency
  activation; access-review decisions; access requests and their outcomes.
- Readable by holders of `ctl.audit_trail:V` (tenant), and by the client admin for their client's events.
  Exportable as CSV/PDF for SOC/audit evidence.

### 5.6 "View as" (read-only simulation) and the explainer

- `POST /api/access/simulate { membershipId, clientId? }` opens a **view-as session**:
  - It is read-only (all non-view actions are denied regardless of the target's grants).
  - It is limited to the **intersection** of the simulator's and the target's access, with masks at the stricter
    level. A simulator can never see more than they already can. If the target can see clients the simulator
    can't, those show as "N clients hidden (outside your access)".
  - It lasts at most 30 minutes, shows a violet band in the shell ("Viewing as Dana Ruiz · read-only · End"), and
    is logged at start and end.
  - Requires `core.access.simulate:V`.
- **Explainer** `POST /api/access/explain { membershipId, cap, action, clientId, amountCents? }` → the full
  `Decision.trace` with no data access. It returns, for example: "Allowed: Bookkeeper (v4) on Clive Power
  Equipment grants ap.bills:create" or "Denied: limit. Accounting Manager allows approve ≤ $25,000; this bill is
  $31,400. Can approve: Pat (Controller), Mike (Owner)". It is used by the UX in §6.7 and by the 403 page.

### 5.7 Migration plan from today's code

Numbered **R-1…R-14** (columns, not SQL). Each is additive and idempotent with RLS on. Order relative to IA:
**IA M-1, M-2 → R-1…R-5 → IA M-3 (amended) → R-6…R-11 → IA M-4 (amended) … → R-12…R-14.** Behavior is unchanged
until R-11 flips enforcement, and that flip ships behind a feature flag with a dual-run comparison (below).

**R-1 · Capability registry mirror**
- `core.capabilities`: `key text pk` (resource), `module`, `domain`, `actions text[]`, `label`, `description`,
  `tags text[]` (`money`,`sensitive`,`locked`,`group`), `field_classes text[]`, `supports_constraints text[]`,
  `introduced_in text`, `status` (`active`,`deprecated`), `alias_of text`
- `core.capability_migrations`: `id`, `kind` (`split`,`rename`), `from_key`, `to_keys text[]`, `applied_at`
- Populated by a deploy step from the code registry. A guard test asserts code and DB match.

**R-2 · Role definitions + versions + grants**
- `core.role_definitions`: `id`, `owner_level` (`platform`,`tenant`,`client`), `org_id` (null for platform),
  `location_id` (client level only), `key`, `name`, `description`, `kind` (`standard`,`custom`), `audience`
  (`internal_staff`,`client_staff`,`external`,`platform`), `upstream_template_id` → role_definitions,
  `upstream_version int`, `default_scope` (`all_clients`,`assigned`), `field_policy jsonb`, `auth_policy jsonb`,
  `max_assignment_days int`, `assignable_band` (`tenant_admin_only`,`managers`,`any_grantor`), `status`
  (`draft`,`active`,`deprecated`,`archived`), `current_version int`, `created_by`, timestamps. Unique `(org_id,
  location_id, key)`, with platform keys unique where `org_id is null`.
- `core.role_versions`: `id`, `role_id`, `version int`, `state` (`draft`,`published`,`superseded`),
  `published_at`, `published_by`, `effective_at`, `reason`, `changelog jsonb` (adds/removes vs previous),
  `second_approval_by`, `second_approval_at`. Unique `(role_id, version)`. Immutable once published (trigger).
- `core.role_grants`: `id`, `role_version_id`, `capability` → capabilities, `actions text[]`, `constraints jsonb`
  (§3 schema, validated by a check function).
- **Data step:**
  - (a) Seed platform templates from §7. The 9 legacy roles are seeded as templates under their IA §2.5 new keys,
    with grants per §2.3.
  - (b) Per tenant, auto-clone the standard set into tenant roles (`kind = standard`, version 1 =
    template grants).
  - (c) Fold each tenant's mig-130 overrides on a **system** key into that tenant role's version 2
    (changelog = "imported override").
  - (d) Each `core.custom_roles` row becomes a tenant custom role with `upstream` = its base template, version 1 =
    base grants + its overrides.
  - (e) The external auditor custom role (mig 145) maps to the standard External auditor template, with grants
    unioned and a time box of `now() + 120 days` stamped on holders. The tenant admin is told.

**R-3 · Permission sets**
- `core.permission_sets` (same columns as role_definitions minus scope defaults, plus `is_envelope boolean`,
  `is_sealed boolean` for emergency sets, `activators uuid[]`)
- `core.permission_set_versions`, `core.permission_set_grants` (same shape as R-2)
- Seed the platform sets: "Client staff envelope", "Company staff envelope", "Legacy full books (company_admin)",
  "Payroll comp visibility", "Consolidation manage", "Emergency finance access (template)".

**R-4 · Client sets and access assignments**
- `core.client_sets`: `id`, `org_id`, `name`, `kind` (`static`,`rule`), `rule jsonb` (tags, `primary_preparer_of`,
  `exclude_own_books`), `created_by`
- `core.client_set_members` (materialized for `rule` sets): `set_id`, `location_id`, `added_at`
- `core.access_assignments`: `id`, `org_id`, `membership_id`, `grant_type` (`role`,`permission_set`),
  `role_id` | `permission_set_id`, `scope_type` (`all_clients`,`client`,`client_set`,`consolidation_group`,
  `tenant`), `location_id`, `client_set_id`, `group_id`, `read_only boolean`, `muted jsonb` (`{cap: actions[]}`),
  `constraint_overrides jsonb` (tighten-only, validated), `effective_from`, `effective_to`, `status`
  (`pending_approval`,`active`,`suspended`,`expired`,`revoked`), `granted_by`, `approved_by`, `reason`,
  `sod_exception_ids uuid[]`, `source` (`invite`,`manual`,`client_admin`,`jit_request`,`emergency`,`backfill`),
  timestamps
- `core.memberships` + `role_definition_id` (primary role, display/default only), `audience`, `access_epoch
  bigint default 0`
- **Data step (replaces IA M-3's backfill):**
  - `memberships.role` (normalized via the §2.5 rename map) gives the primary role.
  - Old `companyScope` `all` → one `all_clients` assignment. `portcos_and_3rdparty` → a `client_set`
    "All clients except own books". `assigned`/`own_company` → one `client` assignment per
    `employee_locations`/`membership_locations` row.
  - `company_admin` holders also receive "Legacy full books (company_admin)" so effective access is identical.
  - `membership_locations` becomes a **compat view** over `access_assignments` for one release.
- `core.membership_invitations` + `intended_assignments jsonb` (replaces `role` + `location_ids` +
  `onboarding_location_ids` at claim time; old columns read for one release)

**R-5 · Client access policies (envelopes) + client roles**
- `core.client_access_policies`: `org_id`, `location_id` (pk with org), `client_roles_enabled`,
  `envelope_permission_set_id`, `client_admin_may_invite`, `firm_approval_required_for text[]`,
  `max_client_members`, `mfa_required`, `updated_by`, timestamps
- `core.organizations` + `default_client_access_policy jsonb` (tenant defaults by tenant type)

**R-6 · Field sensitivity**
- `core.field_classes` (platform registry): `key` (`comp`,`tin`,`bank`,`personal`,`secrets`), `levels text[]`
- `core.field_class_columns`: `field_class`, `schema`, `table`, `column` (drives the masked-view generator + guard
  test)
- `core.field_reveals`: `id`, `org_id`, `membership_id`, `field_class`, `subject_table`, `subject_id`, `reason`,
  `at`
- Masked views: `v_vendor_payment_profiles_masked`, `v_employees_masked`, `v_w9_masked`,
  `v_payroll_register_lines_masked`, … (generator lists them from `field_class_columns`)

**R-7 · Authentication policies**
- `core.ip_allowlists`: `id`, `org_id`, `name`, `cidrs cidr[]`
- `core.organizations` + `security_policy jsonb` (`mfa_all_staff`, `default_step_up_minutes`, `session_max_hours`,
  `idle_timeout_minutes`)
- (role-level `auth_policy` already on role_definitions R-2)

**R-8 · SoD**
- `core.sod_rules`: `id`, `org_id` (null = platform), `key` (`S1`…), `description`, `conflict jsonb` (sets of
  `cap:action`), `enforcement` (`soft`,`hard`,`txn_only`), `tenant_type_override jsonb`, `status`
- `core.sod_exceptions`: `id`, `org_id`, `rule_key`, `membership_id`, `location_id`, `justification`,
  `compensating_control`, `approved_by`, `expires_at`, `revoked_at`
- `core.organizations` + `je_self_post_threshold_cents bigint`, `sole_approver_mode boolean default false` (Q1, Q4)
- Extend the mig 042 money-approval CHECK to include `released_by <> approved_by` (unless sole-approver mode), and
  add `released_by <> prepared_by` explicitly.

**R-9 · Access log, reviews, usage, requests**
- `core.access_change_log` (§5.5), append-only trigger
- `core.access_reviews`: `id`, `org_id`, `name`, `period_start`, `period_end`, `scope jsonb`, `due_at`,
  `status` (`draft`,`open`,`closed`), `auto_revoke_unreviewed boolean`, `created_by`
- `core.access_review_items`: `id`, `review_id`, `reviewer_membership_id`, `subject_kind` (`assignment`,
  `permission_set`, `sod_exception`, `dormant_access`, `unused_capability`), `subject_id`, `evidence jsonb`,
  `decision` (`keep`,`reduce`,`revoke`,`delegate`), `decision_note`, `decided_at`
- `core.capability_usage`: `org_id`, `membership_id`, `location_id`, `capability`, `action`, `last_used_at`,
  `count_30d` (upserted asynchronously from the PDP, sampled)
- `core.access_requests`: `id`, `org_id`, `requester_membership_id`, `capability`, `actions`, `location_id`,
  `permission_set_id`, `duration_days`, `reason`, `routed_to_membership_ids uuid[]`, `status`, `decided_by`,
  `decided_at`

**R-10 · Template updates**
- `core.template_updates`: `id`, `template_id`, `from_version`, `to_version`, `org_id`, `derived_role_id`,
  `status` (`available`,`adopted`,`partially_adopted`,`dismissed`), `decided_by`, `decided_at`,
  `adopted_changes jsonb`

**R-11 · Effective access + DB functions + enforcement flip**
- `core.effective_access` (§5.4) + `core.rebuild_effective_access(membership_id)` + enqueue triggers
- `core.has_capability(membership_id, location_id, cap, action, amount_cents default null) returns boolean`
- `public.current_membership_id()` (IA M-4) and `public.can_access_location()` rewritten over
  `effective_access`
- Definer RPCs for post/approve/release (§5.2.2) + revoke direct status updates
- **Dual-run:** for 7 days, `authorize()` runs alongside the legacy guards. Disagreements are logged to
  `app_error_log` with both decisions. The flag flips once disagreements = 0 or each one is explained (expected
  ones: C3/C5/C6 fixes and the §2.3 "tighten" rows).

**R-12 · Approval workflows on capability**
- `public.approval_workflow_steps` + `approver_capability text`, `min_approver_limit_cents bigint`,
  `approver_client_set_id uuid` (optional). Backfill from `approver_role` via the §2.3 map. `approver_role` stays
  as compat for one release.

**R-13 · Emergency access + support integration**
- `core.emergency_activations`: `id`, `org_id`, `permission_set_id`, `activated_by`, `second_by`, `reason`,
  `started_at`, `expires_at`, `ended_at`
- IA M-9 `support_access_grants` + `capability_scope text[]` (support read-write limited to named capabilities)

**R-14 · Retire legacy**
- Drop `public.role_permission_overrides` (mig 014), `core.custom_roles` / `core.role_permission_overrides`
  (mig 130, after R-2 import and one release read-only), `memberships.admin_scope` / `employees.admin_scope` /
  `membership_invitations.admin_scope` (mig 109), and the `employees.role` authority reads (the column stays as HR
  data). Retire the `membership_locations` compat view.
- Code: `permissions.ts` becomes `lib/rbac/legacy-map.ts` (old feature → capability, used only by the dual-run and
  by stored references), then is deleted. `role-normalize.ts` stays one release for stored strings.

### 5.8 API surface

All routes go through `apiHandler` with a declared `access`. All writes return the new `version`/`epoch` and
accept `if_version` (optimistic concurrency on role versions).

| Method + path | Capability | Purpose |
|---|---|---|
| GET `/api/access/catalog` | any member | Capabilities, actions, field classes, constraint schemas, presets |
| GET `/api/access/me?client=` | any member | Compiled snapshot for the context (§5.3) |
| GET `/api/access/roles?level=&kind=&status=` | `core.access.roles:V` | Library with holder counts, last change, update-available flag |
| POST `/api/access/roles` | `…roles:C` | Create (from scratch, or `cloneFrom: templateId \| roleId`) |
| GET `/api/access/roles/:id` | `…roles:V` | Definition + current version + grants |
| PATCH `/api/access/roles/:id` | `…roles:E` | Metadata/policies (creates a draft version if grants change) |
| PUT `/api/access/roles/:id/draft` | `…roles:E` | Replace the draft grant set (builder save) |
| GET `/api/access/roles/:id/impact?version=` | `…roles:V` | People/clients affected, per-person gains/losses, SoD hits, envelope violations |
| GET `/api/access/roles/:id/diff?against=template\|version:N\|role:ID` | `…roles:V` | Cell-level diff |
| POST `/api/access/roles/:id/publish` | `…roles:K` | `{version, reason, effectiveAt?}` → may return `pending_second_approval` |
| POST `/api/access/roles/:id/rollback` | `…roles:K` | Publish an older version's grants as new |
| DELETE `/api/access/roles/:id` | `…roles:D` | Archive. Refused while there are holders (counts **assignments**, closes C12). |
| GET `/api/access/roles/compare?ids=a,b,c` | `…roles:V` | Side-by-side, differences-only option |
| (same 10 routes) `/api/access/permission-sets/*` | same | Permission sets and envelopes |
| GET `/api/access/template-updates` | `…roles:V` | Inbox |
| POST `/api/access/template-updates/:id/adopt` | `…roles:K` | `{mode: 'all'\|'safe'\|'pick', changes?[]}` |
| POST `/api/access/template-updates/:id/dismiss` | `…roles:K` | |
| GET `/api/access/members/:membershipId` | `core.access.members:V` | Every assignment, permission set, mute, limit, SoD exception, expiry, last use, per client |
| POST `/api/access/assignments` | `core.access.assignments:C` | Grant (ceiling + SoD + envelope evaluated; may return `pending_approval` or `sod_justification_required`) |
| PATCH `/api/access/assignments/:id` | `…assignments:E` | Extend, mute, tighten, read-only |
| DELETE `/api/access/assignments/:id` | `…assignments:D` | Revoke (immediate epoch bump) |
| POST `/api/access/assignments/:id/approve` \| `/deny` | `…assignments:C` (not the grantor) | Second approval |
| POST `/api/access/assignments/bulk` | `…assignments:C` | Staff many clients at once (preview → commit) |
| GET `/api/access/clients/:locationId` | `…assignments:V` on that client | Who has what on this client |
| GET/PUT `/api/access/clients/:locationId/policy` | `core.tenant.settings:K` | Client envelope / client-roles enablement |
| GET/POST `/api/access/client-sets` (+ `/:id`) | `…assignments:C` | Saved and dynamic client sets |
| POST `/api/access/explain` | `core.access.members:V` (or self) | Decision trace (§5.6) |
| POST/DELETE `/api/access/simulate` | `core.access.simulate:V` | View-as session |
| GET/PUT `/api/access/sod-policy` | `core.access.sod_policy:V/K` | Tenant tightening, thresholds, sole-approver mode |
| POST `/api/access/sod-exceptions` (+ revoke) | `core.access.sod_policy:K` or the grantor at assignment | |
| POST `/api/access/requests` · POST `/api/access/requests/:id/decide` | any member · a grantor holding it | Request access / JIT |
| POST `/api/access/emergency/:permissionSetId/activate` · `/end` | named activator + second person | |
| GET/POST `/api/access/reviews` · GET `/api/access/reviews/:id/items` · POST `/api/access/reviews/:id/items/:itemId/decide` · GET `/api/access/reviews/:id/export` | `core.access.reviews:*` | Recertification |
| GET `/api/access/log?subject=&member=&client=&from=&to=&format=csv` | `ctl.audit_trail:V` | Access change log |
| GET `/api/access/export?format=xlsx` | `core.access.reviews:X` | Full matrix: members × clients × capabilities |
| Platform: GET/POST/PATCH `/api/platform/templates/*`, POST `/api/platform/templates/:id/publish`, GET/PUT `/api/platform/sod-rules` | `platform.templates:*` | Template authoring |

The legacy `/api/rbac/*` routes proxy to the new routes for one release, then are removed.

---

## 6. Admin UX

Design system: the navy shell and Merit brand tokens from the IA. All screens show loading, empty, populated and
error states, are keyboard operable, and work at 1440 and 1024 widths (the builder is desktop-first; access review
also works at 390).

### 6.1 A1 · Role library (`/settings/access/roles`)

- **Tabs:** Roles · Permission sets · Envelopes · Templates (platform library, read-only) · Updates (badge count).
- **Table columns:** name, **level chip** (Platform / Tenant / Client: <name>), kind (Standard · Standard modified ·
  Custom), audience, **holders** (people · clients; click opens list), last published (who/when), SoD exceptions
  count, update-available dot, status.
- **Filters:** level, kind, audience, "has holders", "has SoD exceptions", "unused in 90d".
- **Row actions:** Open · Clone · Compare · Archive (blocked with reason if it has holders).
- **New role** offers three starts: "Start from a standard role" (template picker with one-line job descriptions),
  "Copy an existing role", "Start empty".

### 6.2 A2 · Role builder (`/settings/access/roles/:id`)

- **Header:** name, description, level/audience/kind chips, "Based on **Controller · template v3**", version chip
  (v5 published · draft v6), and **Save draft** / **Review & publish**.
- **Left rail:** domains (GL, Close, Bank, Cards, AP, Payments, Expenses, AR, Rev rec, Jobs, Inventory, Assets, Debt,
  Cash, Payroll, Tax, FP&A, Reports, Consolidation, Controls, Masters, Requests & portals, Onboarding,
  Integrations, AI, Workspace, Access, Tenant). Each shows "n granted". Only entitled modules appear; un-entitled
  ones are listed under "Not in your plan".
- **Matrix:**
  - One row per resource, with the 9 action columns. **Cells that don't apply to a resource are absent**, not
    greyed.
  - The preset selector (None / View / Prepare / Approve / Full) is at the start of each row, and a domain-level
    preset sits in the domain header.
  - Each cell shows a **delta marker vs upstream**: added (filled dot), removed (hollow dot). A constrained cell
    shows a small "≤ $25k" or "dept" tag.
  - Tags show inline: money, sensitive, locked (step-up).
  - Hover shows plain-English meaning (from `permission-catalog.ts` descriptions, carried over).
- **Constraints panel** (right, opens on clicking a constrained-capable cell): dollar limit (per item, per day for
  release), document types, dimension restriction (mode + values or "their departments"), ownership, period rule.
  It validates against `supports_constraints`.
- **Policies tab:** default scope, field classes (comp / TIN / bank / personal with level selectors), auth (MFA,
  step-up minutes, IP list, session), max assignment days, assignable band, audience (locked after first publish).
- **Inline SoD:**
  - As cells change, a strip above the matrix lists triggered rules. **Hard** rules are red, block publishing,
    name the two cells and offer "Remove X" or "Remove Y". **Soft** rules are amber: "Holders will need a written
    justification."
  - Envelope violations (client roles) are red, with "Exceeds what Heritage Interiors' envelope allows".
- **Diff tab:** three-way current published ↔ draft ↔ upstream template (latest), differences only, grouped by
  domain.
- **Review & publish dialog:**
  - **People affected:** "14 people across 9 clients". Expandable per person: gains (green), losses (red), new
    SoD exceptions needed, people who will lose access to a page they used in the last 30 days (warning).
  - Effective now or at a scheduled date. Reason (required). Second-approval notice if the publish is high-risk
    or widens the publisher's own access.
  - Publishing runs the rebuild job with a progress bar.
- **Version history drawer:** each version shows who, when, why and the changelog. **Restore as new version.**

### 6.3 A3 · User access page (`/team/:membershipId/access`)

- **Header:** person, primary role, audience, MFA status, last active, tenant-admin and billing-owner badges.
- **Assignments table:** one row per assignment, grouped by scope (All clients · Client sets · each client ·
  consolidation groups · tenant). Columns: role/permission set, read-only/mutes, limits, effective dates (expiry
  countdown), granted by, approved by, SoD exceptions, **last used on this client**.
- **Effective access by client:** pick a client and see the resolved matrix (read-only, same layout as the builder)
  with a source tooltip on every cell ("from Bookkeeper v4 via Clive Power Equipment assignment").
- **Actions:** Add access (dialog: role or permission set → scope picker with search, multi-select clients, or
  client set → dates → constraints tighten-only → live ceiling/SoD check → submit), Extend, Mute…, Make
  read-only, Revoke, **View as** (if permitted), **Why can't they…?** (opens the explainer prefilled with this
  person).
- **Bulk staffing from the client list:** select 6 clients → "Assign Dana as Bookkeeper (preparer)". This creates
  access assignments and capacity assignments in one confirmed step (IA S11).

### 6.4 A4 · Client access screen (`/clients/:id/access`)

- Who can access this client: people × role, and how (direct / all-clients / client set / group), capacity
  (preparer/reviewer), limits and expiry.
- Shows coverage gaps: "No one holds **pay.batches:release** on this client", "Preparer and reviewer are the same
  person".
- **Client policy panel** (tenant admins): enable client roles, choose the envelope, firm-approval actions, seat
  cap, MFA floor.

### 6.5 A5 · Client-level role screen (client admin)

- The client admin of Heritage Interiors sees **Heritage Interiors · Team & roles** only. It is a simplified A1/A2:
  - The library shows client roles plus the tenant roles the firm made assignable to client staff.
  - The builder shows **only envelope capabilities**. Everything else is absent, with a footer: "Your accounting
    firm controls access beyond this. Request more."
  - People lists only client staff and contacts.
- Changes that touch firm-approval actions show "Pending approval by Merit Management Group" until approved.
- All activity is visible to the firm in the access log.

### 6.6 A6 · Compare roles

Up to 4 roles or permission sets side by side, in the same domain/resource grid with each role as a column.
Options: "Differences only", and "Show constraints" (limits, dimensions, field levels). An "Export" button and
"Create role from selection" (merge or intersection) are offered.

### 6.7 A7 · "Why can / can't X do Y" explainer

- Opened from a user page, a 403 page, an approval screen ("Why can't Sam approve this?") or global search.
- **Inputs:** person, capability (searchable in plain English: "release a payment"), client, optional amount or
  document.
- **Output:** the verdict and the full trace as steps (membership → assignments → role versions → grant →
  constraint → SoD → auth). Each step links to the object that decided it.
- For a denial it offers fixes the viewer is allowed to make: "Grant 'Payments approver ≤ $50k' on Clive (requires
  second approval)", "Raise limit", or "Route to: Pat, Mike".

### 6.8 A8 · Access review / recertification (`/settings/access/reviews`)

- **Campaign setup:** quarterly by default (tenant setting), scope (all or selected clients/roles), reviewers
  (default: each person's grantor or manager; tenant admins review admins; nobody reviews themselves), due date
  (14 days), auto-revoke unreviewed (off by default), reminders.
- **Reviewer inbox:** one card per item, with keyboard (k keep / r reduce / x revoke / j/k move):
  - assignment with usage evidence ("Last used 4 days ago · 212 actions")
  - SoD exceptions with justification
  - dormant access (no activity 90d)
  - unused capabilities (granted, unused 90d → suggest reduction)
  - expiring time-boxed grants
- **Close-out:** a completion report (who reviewed what and when, decisions, changes applied) is exported as PDF/CSV
  for auditors and SOC evidence and saved to Documents.

### 6.9 A9 · Access log & export

- Filterable timeline (person, client, role, event type, date). Each entry shows before/after, reason and approval.
- **Export matrix** (XLSX): members × clients × capabilities with limits and sources, one sheet per client plus a
  summary. This is the "who can do what" artifact auditors ask for.

### 6.10 A10 · SoD policy & template updates

- **SoD policy:** platform rules with their default enforcement. The tenant can promote a rule to hard, set the JE
  self-post threshold, and turn sole-approver mode on or off (Q1). Open exceptions list with expiries.
- **Template updates inbox:** per derived role, show what's new (with a plain-English changelog) and the
  three-way diff, plus "Adopt all" / "Adopt safe changes" / "Pick" / "Dismiss". New-feature capabilities are
  grouped as "New in MeritBooks: Debt covenants". Each shows which standard roles get it by default and "Add to
  roles…".

### 6.11 Request access (every user)

The 403 page, and an inline request from any hidden-feature mention in help, opens a short form (pre-filled
capability and client, reason, duration for JIT). It routes to the nearest grantor holding the capability. The
requester sees status in their inbox. Grantors see a request card on their home (IA widget `ta.access_requests` /
`am.access_requests`).

---

## 7. Standard role templates

All are platform templates, auto-cloned into each tenant as tenant standard roles. Limits are template defaults;
tenants change them. **Codes:** V view · X export · P prepare (create + edit + delete drafts) · A approve · O post
· R release · K configure · — none. Multiple codes combine (`PAO`). Cells summarize a domain. The full per-resource
grants live in `packages/core-access/templates/*.ts` and are what get seeded.

### 7.1 Scope, audience and policy

| Role (key) | Audience | Default scope | MFA | Comp / TIN / Bank fields | Default limits | Notes |
|---|---|---|---|---|---|---|
| Platform admin (`platform_admin`) | platform | platform | req | n/a (no tenant data) | — | Tenant data only through a support grant. |
| Platform support (`platform_support`) | platform | platform | req | masked | — | Read-only inside an approved session unless granted read-write. |
| Tenant admin (`tenant_admin`) | internal | all clients | req | grouped / masked / masked | — | Administers. Books **view only** by default (stack Owner or CFO for more). Root of trust (§4.2). |
| Owner (`owner`) | internal | all (company) · assigned (firm-client owner) | req | visible / reveal_logged / masked | approve unlimited; release unlimited (company) | Decisions, not data entry. |
| CFO (`cfo`) | internal | all clients | req | visible / reveal_logged / reveal_logged | unlimited | Final release and hard close. |
| Controller (`controller`) | internal | all clients (or assigned) | req | visible / masked / reveal_logged | approve ≤ $250k | Release off by default (S1/S2). |
| Finance director (`finance_director`) | internal | assigned | req | visible / masked / masked | approve ≤ $100k; release ≤ $100k | CFO-like within scope. No tenant accounting settings. |
| Accounting manager (`accounting_manager`) | internal | assigned (or all) | req | grouped / masked / masked | approve ≤ $25k; JE post any | Bounded delegation (§4.2). |
| Bookkeeper (`bookkeeper`) | internal | assigned | req if any [M] | grouped / masked / masked | — | **Primary user.** No approve/release on money. |
| AP clerk (`ap_clerk`) | internal | assigned | opt | hidden / masked / masked | — | Bills in, batches prepared. |
| AR clerk (`ar_clerk`) | internal | assigned | opt | hidden / masked / masked | — | Invoices out, cash in. |
| Payments clerk (`payments_clerk`) | internal | assigned | req | hidden / masked / masked | — | Queue, print, file. Never approve or release. |
| Data entry (`data_entry`) | internal | assigned | opt | hidden / masked / masked | — | Receipts, bills, masters. |
| HR / payroll (`hr_payroll`) | internal | assigned or all | req | visible / reveal_logged / reveal_logged | — | Release only through a permission set (S4). |
| Department head (`department_head`) | internal | assigned + `my_departments` (edit_only) | req | grouped (own dept) / hidden / hidden | approve ≤ $5k (own dept) | Approves own department's spend. |
| External auditor (`external_auditor`) | external | assigned, **≤ 120 days** | req | grouped / masked / masked | — | Read + export + PBC. Hard rule H4. |
| View-only (`view_only`) | internal | assigned | opt | hidden / masked / masked | — | Read-only books, no export. |
| Client admin (`client_admin`) | client_staff | one client | req | per envelope | approve ≤ envelope | Manages the client's own staff and roles inside the envelope (only when enabled). |
| Client contact (`client_contact`) | external | one client | magic link / opt | hidden / hidden / hidden | approve only if delegated | Answers requests, uploads documents. Hard rule H3. |

### 7.2 Default matrix: processing domains

| Role | GL & JEs | Close & periods | Bank & rec | Cards | AP bills/PO | Payments & checks | Expenses & receipts | AR & collections | Rev rec | Jobs & WIP | Inventory | Assets / leases / prepaids |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Tenant admin | V | V | V | V | V | V | V | V | V | V | V | V |
| Owner | VX | V | V | V | VA | VAR¹ | VA | VX | V | V | V | V |
| CFO | VXA | VA (hard close) | VA | VA | VA | VAR | VA | VXA | VX | VX | V | VX |
| Controller | PAOK | PAK (hard close) | PA | PA | PAO | PA | PA | PAO | POK | PO | PAO | PO |
| Finance director | VA | V | V | V | VA | VAR | VA | VA | V | V | V | V |
| Accounting manager | PAO | PA (soft close) | PA | PA | PAO | PA | PA | PAO | PO | PO | PA | PO |
| Bookkeeper | P | P (tasks) | PA² | PA² | P | V | P | P + send | V | P | P | V |
| AP clerk | — | — | — | V | P | P | P | — | — | V | — | — |
| AR clerk | — | — | V | — | — | V + cash app PO | — | P + send, cash app | V | V | — | — |
| Payments clerk | — | — | — | — | V | P + checks, files X | — | — | — | — | — | — |
| Data entry | — | — | — | — | C (bills) | — | P | — | — | V | P (items) | — |
| HR / payroll | — | — | — | — | — | — | V | — | — | — | — | — |
| Department head | — | — | — | — | VA³ (dept, PO) | — | VA³ (dept) | — | — | V (dept) | — | — |
| External auditor | VX | VX | VX | VX | VX | VX | VX | VX | VX | VX | VX | VX |
| View-only | V | V | V | V | V | V | V | V | V | V | V | V |
| Client admin | — | — | V | V | PA⁴ | — | PA | P + send⁴ | — | V | — | — |
| Client contact | — | — | answer txn questions | — | A (if delegated) | — | upload | — | — | — | — | — |
| Platform admin / support | — | — | — | — | — | — | — | — | — | — | — | — |

¹ Release on for company tenants. Off in the firm-tenant clone (firm-client owners approve; the firm releases).
² Approve coding = posts via the deterministic engine. Txn SoD still applies to manual JEs.
³ `edit_only` dimension restriction to their departments, ≤ $5k.
⁴ Only within the client envelope.

### 7.3 Default matrix: oversight, platform and admin domains

| Role | Debt & covenants | Cash & forecast | Payroll | Tax | FP&A / budgets | Reports | Consolidation | Controls / audit / PBC | Vendor & customer masters | Bank details | Requests & portals | Onboarding / import | Integrations | AI / autonomy | Access admin | Tenant settings / billing |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Tenant admin | V | V | V | V | V | VX | V (all groups) | V + approval workflows K | V | V (masked) | K portals | P (add clients) | VK | VK | **full** (root) | **K** (billing if owner) |
| Owner | VA + send cert | V | VAR¹ | VA | VA | VX + packs R | V (if granted) | V | V | V | answer, R | V | V | V | V | V |
| CFO | PAR K | PK | VAR | VAR | PAK | VX + packs/board R | V all · K if granted | VA K | V | V | V | V | V | VK | V | accounting K |
| Controller | PO | P | VA | PO | P | VX + packs R | PO K (if granted) | PA K | PK | E (2nd approval) | P R | PO A(tie-out) | V | VK | V | accounting K |
| Finance director | VA | P | VA | V | PA | VX | V (if granted) | VA | V | V | V | V | — | V | V | — |
| Accounting manager | P | P | PA | P | V | VX + packs R | — (if granted) | PA | P | V | P R | PO | V + connect feeds | V | **delegate** (§4.2) | V |
| Bookkeeper | V | V | register P (grouped) | P (sales-tax prep) | — | VX | — | V + resolve exceptions | P | — | P R | P (onboarding preparer) | V | V (assist) | — | — |
| AP clerk | — | — | — | V (1099) | — | V (AP aging) | — | V | vendors P | — | P | — | — | V | — | — |
| AR clerk | — | — | — | — | — | V (AR aging) | — | V | customers P | — | P R (portal links) | — | — | V | — | — |
| Payments clerk | — | — | — | — | — | V (paid reports) | — | — | V | — | — | — | — | — | — | — |
| Data entry | — | — | — | — | — | — | — | — | P | — | P | — | — | V | — | — |
| HR / payroll | — | V | P (runs, register, employees, remittances R) | V (payroll tax) | V (workforce) | V (payroll) | — | V | — | employee bank E | — | — | V | V | — | payroll K |
| Department head | — | — | grouped (dept) V | — | P (dept budget) | V (dept, filtered) | — | — | V | — | answer | — | — | V | — | — |
| External auditor | VX | VX | VX (grouped) | VX | VX | VX | VX (if granted) | V X + PBC P A | VX | masked | — | — | — | V (decisions log) | — | — |
| View-only | V | V | — | V | V | V | — | V | V | — | — | — | — | — | — | — |
| Client admin | V⁴ | V | — | — | V | VX | — | — | P (no bank) | — | P | — | — | — | client staff only⁴ | — |
| Client contact | — | — | — | — | — | V (if firm enables) | — | — | — | — | answer, upload | — | — | — | — | — |
| Platform admin | — | — | — | — | — | — | — | — | — | — | — | — | — | — | platform | platform.* K |
| Platform support | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | platform.health V, support C |

**Backfill mapping:** `company_admin` → Tenant admin + "Legacy full books" permission set (flagged for review).
`cfo` → CFO. `merit_controller` → Controller, plus a permission set "Legacy controller release" (today it
releases). `assistant_cfo` → Finance director on the "All clients except own books" set. `accounting_manager` →
Accounting manager on the same set. `accounting_specialist` → Bookkeeper. `check_processor` → Payments clerk.
`general_admin` → Data entry. `business_user` → Owner (assigned). The external auditor custom role → External
auditor. Every "legacy" permission set appears in the first access review with a suggestion to drop it.

---

## 8. Open questions for the owner (max 5)

| # | Decision | Recommended default |
|---|---|---|
| **Q1** | **Sole-approver mode:** in a small company tenant where one person is the only finance user, may the same person approve and release (prepare stays separate when possible)? | **Yes for company tenants with exactly one member holding money approve. Never for firm tenants.** It is shown as a standing exception on the controls dashboard and in every access review, and turns off automatically when a second approver is added. |
| **Q2** | **Client-defined roles in firm tenants:** on or off by default for a new client? | **Off by default. The firm enables it per client.** It runs inside the standard "Client staff envelope", and any client-role grant touching approve/release/post/configure needs firm approval. In company tenants it is on (each company manages its own staff). |
| **Q3** | **New features and template updates:** should *read-only* access to a new module (e.g. view Debt & covenants) auto-apply to standard roles, or wait for the tenant admin? | **Wait (never silent),** with a one-click **"Adopt safe changes"** in the update inbox and a tenant-admin home card. Restrictions (locks and SoD) apply immediately with notice. Splits and renames apply automatically because they don't change anyone's access. |
| **Q4** | **JE self-post threshold:** at what amount must a manual JE be posted by someone other than its preparer? | **$25,000** for all tenants, plus *any* amount touching equity, intercompany or a soft-closed period. Tenant-configurable down to $0. System-generated entries (bank coding, depreciation, rev rec runs) are exempt because they are approved upstream. |
| **Q5** | **Second-person approval for high-risk grants** (any release capability, access admin, vendor bank-detail edit, AI autonomy, limits > $100k)? | **On for firm tenants and any tenant with ≥ 2 tenant admins. Off (logged) for single-admin tenants.** The approver can't be the grantor or the grantee. |

---

*Research basis for patterns adopted:*
- NetSuite: permission levels map to the builder presets; role restrictions by department/class with an
  edit-only mode map to §3.3.
- Salesforce: permission sets and muting map to §1.5. Permission-set groups were deliberately not adopted.
  Salesforce's planned move of all permissions off profiles was reported cancelled in 2026 (third-party reports),
  so a role-carries-permissions model with add-on sets is mainstream.
- Sage Intacct: user type as the ceiling maps to `audience`; per-user entity access maps to client scope.
- QuickBooks Online Accountant/Advanced: separate firm roles and client roles map to the tenant vs client levels.
- Workday: domain and business-process security policies map to capability domains and capability-keyed approval
  steps; segmented security maps to field classes.
