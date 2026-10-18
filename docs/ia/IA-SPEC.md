# MeritBooks — Information Architecture & Role Dashboards Spec

**Status:** DRAFT for owner review · authored 2026-10-18 · governs the next design round and the
tenancy/access/dashboard build. **Inputs (binding order):** `00-OWNER-DIRECTIVE.md` (owner's words) →
`docs/canon/CANON-ANCHOR.md` → `01-CODE-REALITY.md` → `02-MARKET-PATTERNS.md` → `FPB-onboarding.md` →
`COMPETITIVE-GAP-ANALYSIS-2026-10.md`. Where this spec and the owner directive disagree, the directive wins.

**What this is:** the account model, roles, navigation, home screens, dashboard customization, the
bookkeeper's automation loop, and the access rules all of that depends on. It is a spec, not code.
Schema items are a numbered migration list (columns, not SQL); the lead assigns real numbers
(on-disk Books migrations run through `153`, so the first free number is `154`).

**What this is NOT:** a widget wish-list. Every module below answers one question, opens one queue or
report, and has a defined empty/done state. If a module can't name its primary action, it's cut.

---

## 0. The decisions on one page

1. **"Portfolio" is gone.** The hierarchy is **Platform → Tenant → Client → (optional) Consolidation group**,
   with **Assignments** saying who works which client in what capacity.
2. **A Client is a set of books = one legal entity = one `core.locations` row.** The table name stays;
   the product word is "Client" (firm tenants) or "Company" (company tenants). Same object.
3. **Tenant type (`firm` | `company`) only changes defaults and labels**, never the data model.
   Merit Management Group is a `firm`-type tenant; its operating companies are its clients; **Merit
   Management Group itself is a client** (flagged as the tenant's own books) with subsidiaries.
4. **Consolidation is a first-class, named group**, attached to a consolidator client (or a set of
   selected clients for combined statements). Seeing a roll-up is a **group-scoped permission** that
   can only be held by someone who can access **every** member. Bookkeepers don't get it by default.
5. **Three independent axes per person:** **Role** (what you can do) · **Client scope** (which books:
   `all` or `assigned`) · **Capacity** (what you're responsible for on a client: preparer / reviewer /
   approver / lead). The old role-baked scopes (`portcos_and_3rdparty`, "can see Merit Management")
   are deleted.
6. **Client access becomes real**, enforced in Postgres RLS via `can_access_location()` and in every
   API via the handler context. Today it is UI-only — that is the #1 must-fix.
7. **Four contexts, four shell states:** Platform console · Tenant workspace (across clients) · Client
   books (inside one client; the tenant's own books get a distinct treatment) · Consolidated view.
   One context switcher replaces the plane switcher and the `'all'` company sentinel.
8. **No home opens with a banner.** Every home opens on a work surface: a ranked queue, a status grid,
   or decisions with buttons. One 32px context line at most; no welcome copy; no hero numbers without a
   comparison and a drill.
9. **The bookkeeper is the primary user.** Their home is a cross-client day plan ranked by "furthest
   from close"; inside a client it is a four-step books-review loop (Review → Reconcile → Check →
   Close) that hands them to the next client when done.
10. **Automation shows its work** in a "Done for you — worth a glance" module: what the system did,
    sampled for spot-check, never a vanity percentage.
11. **Dashboards are customizable in three layers:** system template per role → tenant-published layout
    per role (Locked / Add-and-move / Unlocked, with required widgets) → user personalization. Platform
    admin publishes defaults to all tenants. A code-side widget registry filtered by permission means
    no blank widgets.
12. **Platform support access to a tenant requires tenant consent**, is time-boxed and scoped, opens a
    visible red-band session, and is logged where the tenant can read it.

---

## 1. Glossary & account model

### 1.1 Glossary (use these words exactly; never "portfolio", "portco", "holding company", "entities" in UI)

| Term | Definition | Stored as |
|---|---|---|
| **Platform** | MeritBooks the operator (Mike + platform staff). Provisions tenants, sees cross-tenant health, never sees a tenant's books without consent. | `core.users.platform_role` (new) |
| **Tenant** | The customer account that signs the contract and pays. Has users, settings, a brand, and one or more clients. Type `firm` or `company`. | `core.organizations` |
| **Tenant type** | `firm` = an accounting/management firm that keeps books for others. `company` = a business with in-house finance staff keeping its own books (one or many entities). | `core.organizations.tenant_type` (new) |
| **Client** | One set of books for one legal entity: its own COA instance, periods, bank accounts, GL. Every transaction belongs to exactly one client. UI label: "Client" (firm) / "Company" (company). | `core.locations` |
| **Tenant's own books** | The client that *is* the tenant (e.g. Merit Management Group LLC inside the Merit tenant). Gets a distinct shell treatment so nobody posts to the firm's books thinking they're in a client's. | `core.locations.is_tenant_own_books` (renamed from `is_management_company`) |
| **Subsidiary** | A client legally owned (fully or partly) by another client. Ownership is effective-dated. | `public.entity_ownership` (existing) |
| **Consolidation group** | A named reporting scope that rolls several clients up to one set of statements. Two kinds: **Consolidated** (a consolidator client + subsidiaries, uses ownership %, NCI, FULL/EQUITY/NONE) and **Combined** (selected sister clients under common control, summed, intercompany eliminated). Any client can be a consolidator. | `public.consolidation_groups` + `_members` (new) |
| **Eliminations** | Intercompany balances/transactions removed at the group level. They belong to the group, never to a member's books, and are always shown as explicit lines. | computed (076 engine) + group-scoped top-side adjustments (later) |
| **Membership** | One person's seat in one tenant: role, client scope, payroll visibility, status. | `core.memberships` |
| **Client access** | The list of clients an `assigned`-scope membership may open. | `core.membership_locations` (existing, becomes authoritative) |
| **Assignment** | Responsibility for work on a client in a **capacity**: `preparer`, `reviewer`, `approver`, `lead`, optionally narrowed to a function (`close`, `ap`, `ar`, `payroll`, `onboarding`). Requires access. | `core.client_assignments` (new; replaces `core.practice_assignments`) |
| **Client contact** | A person at the client (owner, office manager) who answers requests, uploads documents and approves bills — never touches the ledger. Login optional (magic link). | membership with role `client_contact` |
| **Client request** | A question or document ask from the bookkeeper to a client contact, attached to the thing it's about (a transaction, a bill, a period). | `public.client_requests` (new) |
| **Workspace** | The tenant-level surface that spans clients (firm home, client registry, close grid, team). Replaces the "Practice" plane and the `'all'` company sentinel. | UI concept |
| **Books review** | The per-client, per-period four-step loop: Review → Reconcile → Check → Close. | derived from existing queues + `close_checklists` |

### 1.2 Shape

```
Platform (MeritBooks)
└── Tenant  [type: firm | company]            core.organizations
    ├── Memberships  (role · client_scope · payroll_visibility)
    │     ├── Client access   (assigned scope only)        core.membership_locations
    │     ├── Assignments     (client × capacity × function) core.client_assignments
    │     └── Group grants    (consolidation view/manage)   core.consolidation_group_grants
    ├── Clients  (= legal entity = set of books)          core.locations
    │     └── Subsidiary edges (%, method, dates)         public.entity_ownership
    └── Consolidation groups (consolidated | combined)    public.consolidation_groups (+ members)
```

### 1.3 Merit Management Group mapped (illustrative; real structure comes from entity setup)

| Concept | Merit instance |
|---|---|
| Tenant | **Merit Management Group**, `tenant_type = firm` (it services its operating companies under an MSA, bills them, and assigns staff per company — firm behavior). |
| Clients | Each operating company is a client: Heritage Interiors, Clive Power Equipment, Heartland Heating & Cooling, Crystal Kitchen & Bath, Dorrian HVAC, Metro Heating & Cooling, Swan Creek, Iowa Custom Cabinets, Revived Interiors, Artistry Homes, AIM, Wild Rose, plus any fund/SPE/property entities Merit keeps books for. |
| Tenant's own books | **Merit Management Group LLC** is itself a client, `is_tenant_own_books = true`. |
| Subsidiaries | Whatever Merit Management Group LLC owns is recorded as `entity_ownership` edges (parent = Merit Management Group LLC). |
| Consolidation groups | e.g. **"Merit Management Group — Consolidated"** (kind `consolidated`, consolidator = Merit Management Group LLC, members = its ownership subtree). Optionally **"HVAC companies — Combined"** (kind `combined`, selected sister clients) for a lender package. Any client that owns others can be a consolidator; the option exists for every client. |
| Assignments | Each company may have a different bookkeeper (preparer) and a shared reviewer (accounting manager). Bookkeepers see their companies only and no roll-up. |
| Roll-up viewers | Mike (owner), CFO, controller — granted the group(s); each can access every member. |

### 1.4 What tenant type changes (defaults only)

| Behavior | `firm` | `company` |
|---|---|---|
| Client label | "Clients" | "Companies" |
| Default landing for staff with >1 client | Workspace home | Workspace home (labelled with the company group name) |
| Single-client tenant | n/a (firms have many) | Workspace is hidden; users land in the one client's books; tenant settings move under Settings |
| Client contacts | Expected (external) | Rare (owners are usually internal members) |
| Tenant's own books flag | On for the firm's entity | Off unless they mark a parent/HQ entity |
| Default reviewer≠preparer on close sign-off | On | On if ≥2 finance staff, else Off |
| Billing presentation (mig 131) | Firm plan + per-client wholesale | Direct plan, per-company |

### 1.5 Mapping onto existing tables

| Existing | Today | After |
|---|---|---|
| `core.organizations` | tenant; `billing_plan`, `entitlements`, `onboarding_state`, `clerk_org_id` | + `tenant_type`, `lifecycle_status`, `close_calendar` defaults. `billing_plan` stays pricing only. |
| `core.locations` | company/legal entity; `parent_entity_id`, `ownership_pct` (unused by writers), `is_management_company`, `onboarding_status`, `functional_currency` | **The Client.** Rename `is_management_company` → `is_tenant_own_books`. Add `client_status` (`onboarding`/`active`/`paused`/`archived`), `client_number`, `primary_contact_membership_id`. Deprecate `parent_entity_id`/`ownership_pct` in favor of `entity_ownership` (the consolidation engine must walk `entity_ownership`, not the unwritten column). |
| `public.entity_ownership` | effective-dated parent→child %, FULL/EQUITY/NONE | Unchanged — the legal ownership truth. Groups read it for %/method. |
| `core.practice_assignments` | one owner per (org, location, function: close/ar/ap/review/onboarding), keyed to `employees` | Replaced by `core.client_assignments` (capacity + function + membership). Backfill: `close`/`ap`/`ar` → `preparer`+function; `review` → `reviewer`; `onboarding` → `lead`+`onboarding`. Keep a read-compat view for one release. |
| `core.memberships` | user↔org↔role, `admin_scope` MANAGEMENT/PREPARER | **The authority record.** + `client_scope`, `payroll_visibility`, `weekly_capacity_hours`, `is_billing_owner`. `admin_scope` retired (expressed by role + scope). |
| `core.membership_locations` | write-only mirror, nothing reads it | **Authoritative client-access list** read by RLS and APIs. |
| `core.employees.role` + `public.employee_locations` | today's real authority | Become the HR record only. One-time backfill into memberships/membership_locations, then authority code stops reading them (role-normalize stays as an alias layer for one release). |
| `core.custom_roles` / `role_permission_overrides` (130) | custom roles + cell overrides | Unchanged; custom roles now also carry a `client_scope` default and appear in dashboard-layout publishing. |
| `core.users.is_platform_staff` + `PLATFORM_STAFF_CLERK_IDS` | coarse platform flag | + `platform_role` (`platform_admin` / `platform_support`); env allowlist becomes break-glass bootstrap only. |
| `core.platform_admin_sessions` | only tenant-reset writes it | Every cross-tenant access opens one, linked to a consent grant. |
| `public.pbc_requests` (145) | auditor PBC list | Stays; surfaced alongside `client_requests` in one Requests UI via a union view. |
| `customers.is_portfolio_company` | flags a customer that is another company | Renamed `is_related_client` + `related_location_id` (links the customer record to the client it represents — feeds intercompany/eliminations). |
| localStorage (FP&A, bank-feed views) | only "layout" storage | Replaced for homes by `dashboard_layouts`. |

### 1.6 Schema changes — numbered migrations (columns, not SQL)

All are additive + idempotent, RLS on, `org_id = get_org_id()` baseline. **M-1…M-3 are prerequisites for
everything else; M-4 (RLS) ships behind its guard test.**

**M-1 · Tenant type & lifecycle** (`core.organizations`)
- `tenant_type text not null default 'company'` check (`firm`,`company`)
- `lifecycle_status text not null default 'signed_up'` check (`invited`,`signed_up`,`setting_up`,`converting`,`live`,`at_risk`,`suspended`,`churned`)
- `lifecycle_changed_at timestamptz`
- `provisioned_by uuid` → `core.users` (null = self-serve)
- `close_due_business_day int default 10` (tenant default close target; per-client override in M-2)

**M-2 · Client fields** (`core.locations`)
- rename `is_management_company` → `is_tenant_own_books` (keep a generated alias column one release)
- `client_status text not null default 'active'` check (`onboarding`,`active`,`paused`,`archived`)
- `client_number text` (unique per org when set)
- `primary_contact_membership_id uuid` → `core.memberships`
- `close_due_business_day int` (null = tenant default)
- `customers.is_portfolio_company` → `is_related_client boolean`; + `customers.related_location_id uuid` → `core.locations`

**M-3 · Membership authority** (`core.memberships`, `core.membership_locations`, `core.users`)
- memberships: `client_scope text not null default 'assigned'` check (`all`,`assigned`); `payroll_visibility text not null default 'none'` check (`ungrouped`,`grouped`,`none`); `weekly_capacity_hours numeric(5,1)`; `is_billing_owner boolean default false`; `access_expires_at timestamptz` (auditors, temps)
- membership_locations: + `org_id uuid not null`, `granted_by uuid` → `core.users`, `granted_at timestamptz`, `expires_at timestamptz`, index `(membership_id, location_id)`
- new `core.membership_departments`: `id`, `org_id`, `membership_id`, `location_id`, `department_id`, `granted_by`, `granted_at` (department heads)
- users: `platform_role text` check (`platform_admin`,`platform_support`) null = none
- data step: backfill memberships.role (rename map §2.5), client_scope from old companyScope, membership_locations from `employee_locations`

**M-4 · Location-scoped RLS**
- `public.current_membership_id()` stable security-definer: membership for (Clerk `sub`, `get_org_id()`), active, not expired
- `public.can_access_location(location_id uuid) returns boolean`: true if membership `client_scope = 'all'`, or a non-expired `membership_locations` row exists, or an approved, unexpired support grant (M-9) covers it
- `public.can_access_group(group_id uuid) returns boolean` (M-6)
- every table with `location_id`: policy becomes `org_id = get_org_id() AND (location_id IS NULL OR can_access_location(location_id))`; child tables without `location_id` (e.g. `gl_entry_lines`, `bill_lines`, `invoice_lines`) get the predicate through their parent or a denormalized `location_id`
- staged: (a) GL, bank feed, bills, invoices, payroll, documents; (b) everything else; guard test asserts full coverage (§7)

**M-5 · Client assignments** (`core.client_assignments`, replaces `core.practice_assignments`)
- `id`, `org_id`, `location_id` → locations, `membership_id` → memberships
- `capacity text` check (`preparer`,`reviewer`,`approver`,`lead`)
- `function text not null default 'all'` check (`all`,`close`,`ap`,`ar`,`payroll`,`onboarding`)
- `is_primary boolean` (one primary preparer per client+function)
- `effective_start date`, `effective_end date` (vacation cover, handoffs)
- `assigned_by uuid`, timestamps
- constraint/trigger: membership must have access to `location_id` (scope `all` or a `membership_locations` row)
- unique `(org_id, location_id, capacity, function) where is_primary`
- compat view `core.practice_assignments_v` for one release

**M-6 · Consolidation groups**
- `public.consolidation_groups`: `id`, `org_id`, `name`, `kind` check (`consolidated`,`combined`), `consolidator_location_id` (required for `consolidated`), `reporting_currency`, `eliminations_enabled boolean default true`, `status` (`draft`,`active`,`archived`), `created_by`, timestamps
- `public.consolidation_group_members`: `id`, `org_id`, `group_id`, `location_id`, `include_from date`, `include_to date`, `method_override text` (null = use `entity_ownership`), unique `(group_id, location_id, include_from)`
- `core.consolidation_group_grants`: `id`, `org_id`, `group_id`, `membership_id`, `level` check (`view`,`manage`), `granted_by`, `granted_at`, `suspended_at`, `suspended_reason`
- trigger: a grant can only be created if the membership can access every current member; when a member is added to a group, grants held by anyone lacking access to it are **suspended** (not deleted) and the grantor is notified
- seed: one draft `consolidated` group per client that has `entity_ownership` children

**M-7 · Client requests**
- `public.client_requests`: `id`, `org_id`, `location_id`, `kind` check (`transaction_question`,`document`,`approval`,`information`), `subject_type` (`bank_transaction`,`bill`,`invoice`,`period`,`none`), `subject_id uuid`, `question text`, `answer_options jsonb` (e.g. suggested categories), `asked_by_membership_id`, `assignee_membership_id` (null if email-only), `assignee_email`, `status` check (`open`,`answered`,`accepted`,`closed`,`cancelled`), `blocking_close boolean`, `due_date`, `reminder_policy` (`none`,`gentle`,`firm`), `last_reminded_at`, `reminder_count int`, `answer jsonb`, `answered_at`, `answered_via` (`app`,`magic_link`,`email_reply`), `document_id uuid`, timestamps
- `public.client_request_tokens`: magic-link tokens (hashed, expiry, single-request scope, rate-limited like the 141/142 portal tokens; anon grants revoked)
- view `v_requests_all` = `client_requests` ∪ `pbc_requests` (normalized columns) for the Requests UI

**M-8 · Dashboard layouts**
- `public.dashboard_layouts`: `id`, `org_id` (null = platform-published), `scope` check (`platform`,`tenant`,`user`), `role_key text` (null for user scope), `user_id uuid` (user scope only), `surface` check (`workspace_home`,`client_home`,`platform_home`), `layout jsonb` (grid items: `widget_id`, `x`,`y`,`w`,`h`, `config`), `lock_level` check (`locked`,`add_move`,`unlocked`), `required_widget_ids text[]`, `version int`, `is_current boolean`, `publish_mode` (`new_users`,`override`), `published_by`, `published_at`, `note`
- unique current per (scope, org_id, role_key, user_id, surface)
- RLS: platform rows readable by all authenticated, writable only by `platform_admin`; tenant rows by org; user rows by owner

**M-9 · Platform support access**
- `core.support_access_grants`: `id`, `target_org_id`, `requested_by` (platform user), `reason text not null`, `ticket_ref`, `access_level` check (`read`,`read_write`), `location_ids uuid[]` (null = all clients), `requested_at`, `approved_by_membership_id`, `approved_at`, `denied_at`, `expires_at` (default approve + 60 min, max 24h), `revoked_at`
- `core.platform_admin_sessions`: + `grant_id` → support_access_grants, `actions_count int`
- tenant-readable view of grants + sessions (their own org only)

**M-10 · Capacity & time standards** (`public.performance_config`)
- `targets` jsonb gains `time_standards` (minutes per unit: AI item review, reconciliation, close task, request follow-up) used by "distance from close" and capacity. No new table.

---

## 2. Role catalog

### 2.1 How roles work now

- **Role** = what you can do (the permission matrix in `permissions.ts` + custom-role overrides).
- **Client scope** = which books: `all` (every client in the tenant, including the tenant's own books) or
  `assigned` (only clients in `membership_locations`). Set per membership, defaulted by role.
- **Capacity** = what you're accountable for on a client (preparer / reviewer / approver / lead). Drives
  queues and the close grid, not permissions — except that SoD checks use it (preparer ≠ approver).
- **Group grants** = which consolidation groups you can view/manage. Requires access to every member.
- The tenant's own books are **just a client**. Seeing them requires access like any other client
  (`canSeeMeritManagement()` is deleted).

### 2.2 Platform tier

| Role | Job to be done | Scope / granted by | Key permissions | Roll-ups |
|---|---|---|---|---|
| **Platform admin** (Mike) | Sign up and run tenants; keep the platform healthy and paid; publish defaults. | All tenants' **metadata** (not books). Granted by another platform admin; bootstrap via env allowlist. | Provision/suspend tenants; set plan & entitlements; publish platform dashboard/role/COA templates; request support access; view AI gateway spend & errors. | Never sees tenant financials without an approved support grant. |
| **Platform support** | Fix a tenant's problem without seeing more than needed. | Tenants where a grant is approved, time-boxed. Granted by platform admin. | Request support access; read (or read-write if granted) inside a session; no provisioning, no billing changes. | Only what the grant covers. |

### 2.3 Tenant administration tier

| Role | Job to be done | Scope / granted by | Key permissions | Roll-ups |
|---|---|---|---|---|
| **Tenant admin** (≈ tenant owner; one membership flagged `is_billing_owner`) | Run the account: seats, roles, clients, billing, integrations, security. May not be an accountant. | `all` by default (can be narrowed). Granted by another tenant admin; first admin created at provisioning/sign-up. | Manage users & roles & custom roles; create/archive clients; billing; integrations; publish tenant dashboard layouts; approve support access; create consolidation groups. | Implicit view on all groups when scope = `all`. |
| **Accounting manager** (firm label option: "Practice manager") | Make sure every client closes on time and right; deploy the team; delegate access. | `all` or `assigned` (a manager of a team of clients). Granted by tenant admin. | Everything a bookkeeper can do + post/approve JEs, approve COA, sign off recs/close, manage close gates; **delegate**: grant/revoke client access and assignments to staff, *only for clients in their own scope and only roles at or below bookkeeper*; reassign work; send/close client requests. | Only groups explicitly granted (and only if they can access all members). |

### 2.4 Client-level users (roles that work inside client books)

| Role | Job to be done | Default scope · who grants | Key permissions | Roll-ups |
|---|---|---|---|---|
| **Owner** (business owner/executive) | Know how the business is doing; make the few decisions only they can make; answer the accountant fast. | Company tenant: `all`. Firm client owner: `assigned` (their client[s]). Granted by tenant admin or accounting manager. | View dashboard/reports/cash; approve bills & payment runs if granted; answer requests; payroll visibility per setting. No ledger edits. | Yes if granted the group (e.g. Mike → Merit consolidated). |
| **CFO** | Cash, performance vs plan, lender/board readiness, money-movement release. | `all`. Tenant admin grants. | Reports all; accounting settings; budgets/forecast; covenants; payment & payroll **release** (SoD: not on items they prepared); close gate final approval. | Implicit view on all groups (scope `all`). |
| **Controller** | The books are right and closed: close-through, controls, exceptions, intercompany, eliminations. | `all` (or `assigned` for a regional controller). Tenant admin / CFO grants. | Post/approve JEs; recs sign-off; close management; intercompany; fixed assets; recurring; audit trail; manage consolidation groups if granted `manage`. | Yes — `manage` on groups they run. |
| **Finance director** | CFO-like oversight for a subset of clients or a business unit. | `assigned`. Tenant admin / CFO grants. | Reports, budgets, approvals, release within scope; no accounting settings. | Only groups whose members are all in scope, if granted. |
| **Bookkeeper** (PRIMARY user) | Process the books for assigned clients to a clean close, with the machine doing the typing. | `assigned`. Accounting manager grants. | Bank/card feed approve; receipts; bills create; invoices create; JEs create (not post); reconcile; complete close tasks; ask client; vendor/customer edit. Payroll `grouped`. | **No** by default. |
| **HR / payroll** | Payroll runs on time, is funded, posts correctly, and liabilities get remitted. | `assigned` or `all`. Tenant admin grants. | Payroll register import; payroll JE create; remittances; employee master (core). Payroll `ungrouped`. Release only if separately granted (SoD). | No. |
| **Department head / operations leader** | Run my department against budget; approve my department's spend. | `assigned` clients + `membership_departments`. Accounting manager grants. | Dept P&L vs budget; approve bills/expenses/POs routed to their dept (approval workflows mig 092); view jobs/WIP for dept. | No. |
| **Payments clerk** (was check processor) | Print/queue checks and payment runs, separated from approval. | `assigned`. Accounting manager grants. | Check run / queue AP only; no release, no payroll. | No. |
| **Data entry** (was general admin) | Key receipts, bills, vendor/customer records. | `assigned`. Accounting manager grants. | Receipts, bills create, vendor/customer create/edit. | No. |
| **External auditor / view-only** | Test the books; get PBC items fulfilled. | `assigned`, `access_expires_at` required for auditors. Tenant admin / controller grants. | Read-only everything in scope incl. audit trail and documents; PBC create/accept. No PII beyond need (TIN masked). | Only if granted for the audited group. |
| **Client contact** | Answer the bookkeeper's questions and send documents, in under a minute, on a phone. | `assigned` (their client). Bookkeeper can **invite** (accounting manager approves if tenant setting requires). | Answer requests; upload documents; approve bills if delegated; view their client's statements if the firm enables it. No ledger routes ever. | No. |

### 2.5 Rename map (role keys)

| Old key (`permissions.ts`) | New key | Notes |
|---|---|---|
| `company_admin` | `tenant_admin` | `is_billing_owner` flag carries "owner of the account". |
| `cfo` | `cfo` | unchanged |
| `merit_controller` | `controller` | tenant-specific name removed |
| `assistant_cfo` | `finance_director` | label "Finance Director"; scope `assigned` |
| `accounting_manager` | `accounting_manager` | gains bounded **delegate** (§2.6); fixes "described as assigning access but blocked" |
| `accounting_specialist` | `bookkeeper` | |
| `check_processor` | `payments_clerk` | keeps SoD; per-route payments keys (task #56) |
| `general_admin` | `data_entry` | |
| `business_user` | `owner` (scope `assigned`) | the never-built `/business/*` pages are dropped; owner uses the real client home |
| — | `hr_payroll`, `department_head`, `external_auditor`, `client_contact`, `view_only` | new system roles (auditor was a custom role in mig 145) |
| `CompanyScope` `all` / `portcos_and_3rdparty` / `assigned` / `own_company` | `client_scope` `all` / `assigned` | `portcos_and_3rdparty` and `own_company` deleted |
| `canSeeMeritManagement()` | `canAccessClient(locationId)` | |

Stored role strings are rewritten by M-3's data step; the existing role-normalize layer maps old → new for one release.

### 2.6 Delegation rules (who may grant what)

| Grant | Tenant admin | Accounting manager | CFO / controller | Bookkeeper |
|---|---|---|---|---|
| Invite user / change role | any role | bookkeeper, data entry, payments clerk, dept head, client contact, auditor (time-boxed) | — | invite client contact (if setting allows) |
| Client access | any client | only clients in own scope | — | — |
| Assignment (capacity) | any | within own scope | within own scope | — |
| Consolidation grant | any group | only groups they hold `manage` on | groups they hold `manage` on | never |
| Money-movement release permission | yes | no | CFO yes | no |

Every grant/revoke writes `core.action_log` (who, what, client, before/after). A quarterly **access
review** module (tenant admin home) lists stale access (no activity on a client in 90 days).

---

## 3. Navigation per tier

### 3.1 Four contexts and how the shell shows them

The navy shell (sidebar + top bar) stays. Context is shown by **one context chip** at the left of the top
bar and, for two special contexts, a **4px band** under the top bar plus a chip tag. All colors from tokens.

| Context | Chip shows | Band | Why |
|---|---|---|---|
| **Platform console** | "MeritBooks Platform" | none | operator-only surface |
| **Tenant workspace** | Tenant name + "Workspace" (e.g. "Merit Management Group · Workspace") | none | across clients; no posting happens here |
| **Client books** | Client name, client number, period status dot (e.g. "Heritage Interiors · Sep open") | none | the standard working state |
| **Tenant's own books** | Client name + **"Own books"** tag | **amber band** | Intuit pattern: never post to the firm's books thinking you're in a client's |
| **Consolidated view** | Group name + "Consolidated · 9 clients · eliminations on" | **steel band**, layered icon | read-only roll-up; processing nav hidden |
| **Support session** (overlay) | "Support session · MeritBooks · read-only · 42 min left · End" | **red band** | consent-based access, always visible to the supporter and in the tenant log |

Rules: processing pages require a client context (the current `CompanyScopeGuard` stays, but the
`'all'` sentinel is retired — "all" is the workspace, which has no processing pages). Consolidated
context offers only reports, consolidation, eliminations and close status.

### 3.2 Where each role lands (`/` front door)

| Who | Lands on |
|---|---|
| Platform staff with no tenant membership | `/platform` |
| Member with exactly 1 accessible client | that client's home |
| Member with >1 accessible client (bookkeeper, manager, CFO…) | workspace home (role layout) |
| Client contact | their Requests (or "Nothing needed from you") |
| First-run tenant | onboarding (per `FPB-onboarding` principle 1) |

### 3.3 Context switcher

- Trigger: the context chip, or `⌘J` (⌘K stays the command bar; the switcher is also reachable from it).
- Opens a 480px popover: search box (client name/number/short code), then sections:
  **Pinned · My clients** (assigned, with status dot = close status §4.1 and the open-item count) ·
  **All clients** (scope `all` only) · **Consolidated** (only groups the user holds; layered icon) ·
  **Workspace** (top row) · **Platform** (platform staff only).
- Keyboard: ↑↓ Enter; `Esc` closes. Last 5 recents float to the top.
- Switching from a client page keeps you on the same page type in the new client
  (bank feed → bank feed) when the target supports it, else goes to client home.
- Server validates the selected context against access on every request (cookie is a hint, never authority — §7 R8).

### 3.4 (a) Platform console nav

| Group | Items |
|---|---|
| Home | Home |
| Tenants | All tenants (lifecycle tabs) · Onboarding funnel · Provision tenant |
| Revenue | Plans & billing · Billing exceptions |
| Health | Integrations · AI gateway & spend · Errors & deploys |
| Support | Access requests · Active sessions · Access log |
| Defaults | Dashboard templates · Role templates · Chart-of-accounts templates · Help content |
| Admin | Platform team |

### 3.5 (b) Tenant workspace nav (across clients)

| Group | Items | Visible to |
|---|---|---|
| Home | Home · Inbox | all multi-client members |
| Clients | Client registry · Add clients (bulk) · Onboarding tracker | manager, admin, CFO, controller |
| Work | Close grid · Review queue · Requests · Exceptions | manager, controller, bookkeeper (filtered to own) |
| Team | Staff & capacity · Assignments · Access | manager, admin |
| Consolidations | Groups · *(each group the user holds)* | group holders only — absent otherwise, never disabled |
| Insights | Books health · Team performance · Profitability by client | manager, CFO, controller |
| Settings | Roles & permissions · Approval workflows · AI autonomy · Dashboard layouts · Integrations · Plan & billing · Tenant settings | admin (manager: workflows, autonomy, layouts per permission) |

### 3.6 (c) Client books nav (inside one client)

Keep the Session-47 workflow groups — they are right for processing — with practice items removed and a
client-scoped Requests + Close at the top.

| Group | Items |
|---|---|
| Home | Client home (books review) · To review (bank & card feed, receipts, AI queue) · Requests · Close |
| Payables | Bills · Expenses · Receipts · Purchase orders · Pay runs · Payroll · Vendors · Vendor compliance |
| Receivables | Invoices · Estimates & quotes · Collections · Customers · Customer deposits · Revenue recognition |
| Banking & cash | Bank feed · Reconciliation · Cash position · Debt & loans · Borrowing base · Renewals & obligations · Subscriptions |
| Accounting | Journal entries · Chart of accounts · Assets & schedules · Internal invoices · Departments · Tax · Documents · Fiscal periods |
| Jobs & costing | Jobs & projects · Job WIP schedule · Inventory |
| Reports | Reports · Basis adjustments · FP&A · Budgets · Board package · Search · AI decision log · Agents |
| Client settings | Client profile · Contacts · Bank connections · Close checklist template · Assignments (read-only for bookkeeper) |

"Consolidation" leaves the client nav (it lives in the consolidated context and the workspace).
"AI Categorizer" folds into To review.

### 3.7 Rename map — every "portfolio" occurrence (from `01-CODE-REALITY`)

| Today | Becomes | Note |
|---|---|---|
| page `/portfolio` ("Entities") | `/clients` — **Client registry** | 301 redirect for one release |
| page `/portfolio/[locationId]` | `/clients/[clientId]` — **Client profile** (workspace) | |
| page `/onboarding/portfolio` ("Many Companies") | `/onboarding/clients` — **Add clients (bulk)** | |
| `control-tower.tsx` / "Control Tower" link | **Onboarding tracker** (`/clients/onboarding`) | |
| API `/api/portfolio` | `/api/clients` | + permission check + scope filter (R2) |
| API `/api/portfolio/assignments` | `/api/clients/assignments` | + `assign` permission + delegation bounds |
| API `/api/portfolio/entity` | `/api/clients/[id]` | |
| API `/api/portfolio/onboarding` | `/api/clients/onboarding` | |
| API `/api/onboarding/portfolio/{periods,tower,tb,companies}` | `/api/onboarding/clients/{periods,tracker,tb,bulk}` | |
| nav "Entities" → /portfolio | "Clients" → /clients | |
| nav "Many Companies" | "Add clients" | |
| nav group "Team & Oversight" / plane "Practice" | workspace groups Clients / Work / Team | plane switcher removed |
| `help-content.ts` :39, :861–873 | rewrite with "clients", "consolidation group" | |
| Profitability board copy | "Profitability by client" | |
| `/operations` page copy ("client health") | folds into workspace **Books health**; route redirects | |
| `customers.is_portfolio_company` | `customers.is_related_client` + `related_location_id` | M-2 |
| scope enum `portcos_and_3rdparty` | deleted → `client_scope` | M-3 |
| `lib/portfolio/*` | `lib/clients/*` | |
| `lib/companies/portfolio/*` | `lib/clients/bulk/*` | test file renamed alongside |
| `canSeeMeritManagement()` | `canAccessClient()` | |
| role `merit_controller` | `controller` | §2.5 |
| UI word "Entities" (where it means books) | "Clients" / "Companies" by tenant type | "Legal entity" kept only on the client profile's legal tab |

Job-cost "portfolio" names are unrelated and stay.

---

## 4. Home dashboard per role

### 4.0 Rules every home follows

1. **Open state = work.** Above the fold on a 1440×900 screen: a 32px context line (date · period ·
   close day N of target · one status phrase) and the role's **primary module** occupying the top-left
   8 of 12 columns. No greeting, no banner, no paragraph. The owner rejected the big blue banner; this
   is the replacement.
2. **Every number has a comparison and a drill.** A tile with no "vs" and no destination is cut.
3. **Every module has one primary action** (a verb button or row click into a filtered queue).
4. **Empty is not "No data".** Each module defines an *empty* state (nothing configured) and a *done*
   state (configured, nothing to do — a calm check, "next item due Oct 22").
5. **Never a blank widget for missing rights** — the widget is not rendered and the grid reflows.
6. **Lazy-load below the fold**; the primary module renders first from one query.
7. **Visual direction:** dense, queue-first homes (platform, manager, bookkeeper, controller, payroll,
   clerk) use **B "Operator Cockpit"**; decision-and-performance homes (owner, CFO, finance director,
   department head, auditor) use **A "Annual Report"**. Same tokens, different density.
8. **AI-down honesty:** when the gateway is off, modules that depend on it show "AI paused — rules and
   vendor memory still coding" inline, never a dead tile.

Widget ids (e.g. `bk.my_clients`) are the registry ids in §5.4.

### 4.1 Bookkeeper — the primary user

**What it's for:** plan and work my day across every client I'm assigned, hardest-to-close first, and
get each one to "ready for review" without hunting.

**First thing visible:** the **My clients** grid — one row per assigned client, ranked by distance from
close — with the **Due this week** agenda to its right. Example open state for a bookkeeper on four Merit
clients:

```
Mon Oct 19 · September close · day 12 of 15 · 2 of 4 clients ready for review
┌ My clients ─────────────────────────────────────────────────────┐ ┌ Due this week ────────┐
│ Client            Step        To review  Unrec  Requests  Due  ●  │ │ Today  Swan Creek rec  │
│ Clive Power Eq.   Reconcile   41 (6 ⚑)   2     3 (5d)    Oct 21 ●│ │ Tue    Clive close     │
│ Swan Creek        Review      18         1     0         Oct 21 ●│ │ Wed    Heritage payroll│
│ Heritage Int.     Check        0         0     1 (1d)    Oct 23 ●│ │ Thu    Wild Rose 1099s │
│ Wild Rose         Ready ✓      —         —     —         Oct 23 ●│ │                        │
└──────────────────────────────────────────────────── [Start Clive]┘ └────────────────────────┘
```

**Distance from close** (drives sort and the status dot):
`remaining_minutes = Σ(open units × time standard)` over: unreviewed feed/AI items, unreconciled accounts,
open close tasks, open blocking requests (M-10 time standards). Status: **Ready/Complete** (step 4 done or
signed off) · **Blocked** (feed disconnected >2 days, blocking request >5 business days unanswered, missing
statement) · **Overdue** (past client close due date) · **At risk** (remaining_minutes > my available minutes
before due, from `weekly_capacity_hours`) · **On track**.

| # | Module (id) | Question it answers | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **My clients** `bk.my_clients` | Which of my clients is furthest from close, and what step is each on? | `client_assignments` (me, preparer) × `fiscal_periods` × `bank_transactions` (status, `ai_confidence`) × `bank_reconciliations` × `close_checklists` × `client_requests`; `/api/close-status`, `/api/client-health` | **Start [client]** → client home at its current step | Empty: "No clients assigned — your manager assigns them" + who your manager is. Done: all rows Ready ✓, "September is ready for review on all 4." |
| 2 | **Due this week** `bk.agenda` | What's due today and this week, across clients? | `close_checklists.due_day` + client due date, payroll dates (`pay_schedules`), `sales_tax_filings`, 1099 dates, `client_requests.due_date` | Row → the task | Done: "Nothing due until Oct 26." |
| 3 | **Needs your judgment** `bk.ai_judgment` | What did the AI not get, or flag as uncertain, across my clients? | `ai_decisions` + `bank_transactions` grouped by band: **Decide** (<70% or has `clarifying_question`), **Check** (70–89%), **Ready** (≥90%, preselected for batch) | Open band in client To review, keyboard flow (j/k/a/f) | Done: "Every item has a confident code. 212 ready for batch approval →" |
| 4 | **Waiting on clients** `bk.requests_out` | What am I waiting on clients for, and is any of it blocking close? | `client_requests` (open, asked_by me or on my clients) — age, reminders sent, blocking flag | **Nudge** (sends reminder now) · **Answer for them** (record a call) | Done: "No open requests." |
| 5 | **Unreconciled accounts** `bk.unreconciled` | Which accounts still need reconciling for the period, and how far off are they? | `bank_accounts` × `bank_reconciliations` (missing/difference); difference decomposer (S49) | **Reconcile** → reconciliation page | Done: "All 11 accounts reconciled through Sep 30." |
| 6 | **Done for you — worth a glance** `bk.done_for_you` | What did the system do while I wasn't looking, and should I spot-check any of it? | `agent_runs`/`agent_run_steps`, `ai_decisions` (accepted by rule/auto), `close_checklists.is_auto_verified`, recurring JE runs, auto-matches (bill/receipt), `learned_preferences` hits | **Spot-check 5** (random sample incl. the largest) · **Undo** where reversible | Shows counts **with links**, e.g. "Matched 38 transactions to bills · Auto-verified 6 close tasks · Prepared 4 recurring JEs." Never "AI auto-approved 95%". Empty when autonomy is off: "Automation is set to propose-only — see AI autonomy." |
| 7 | **Feeds & connections** `bk.feeds` | Is anything broken that will stop work on my clients? | `plaid_items`, `core.provider_connections`, Ramp sync status (planned), inbound AP email | **Reconnect** / **Ask client to reconnect** (creates request) | Hidden when all healthy (the one module allowed to disappear). |

**Inside a client — the books-review loop (client home for a bookkeeper).** Modelled on QBO's Books
review, deepened. Header row = the four steps with live counts; the active step expands below.

| Step | What's in it | Done when | System pre-work |
|---|---|---|---|
| **1 Review** | Bank & card feed by band (Decide → Check → Ready), receipts unmatched, draft bills from intake, uncategorized (EC-4) | 0 Decide, 0 Check, Ready batch approved (or posted per autonomy) | coding, matching to bills/receipts, transfers paired, duplicates flagged (EC-1) |
| **2 Reconcile** | Every bank/card/loan account for the period: statement balance, GL, difference, outstanding aging | every account difference = 0 and signed by preparer | statement import, auto-match, difference decomposition |
| **3 Check** | Exception library for this client & period: anomalous JEs (EC-10), missed accruals (EC-2), cutoff (EC-12), intercompany out of balance (EC-3), negative balances, suspense non-zero, AR/AP subledger tie-out, payroll liability tie | every item resolved, explained, or accepted with a note | detectors run on period end and on demand |
| **4 Close** | `close_checklists` tasks for the period (auto-verified ones pre-ticked), client packet draft, open requests that block close | all tasks complete → **Mark ready for review** | auto-verify tasks; draft P&L/BS/cash packet with narrative (M7) |

On "Mark ready for review": item enters the reviewer's queue (§4.2), the row on My clients turns Ready,
and the button becomes **Next client: Swan Creek →** (next by distance from close). Reviewer returns
items with notes → they appear at the top of step 3 as "Returned by reviewer".

### 4.2 Accounting manager — supervision home

**What it's for:** see every client's close at once, clear what's waiting on me, and move people to where
the work is.

**First thing visible:** the **Close grid** (top, full width) with the **Review queue** count chip in its
header.

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **Close grid** `am.close_grid` | Which clients are on track, at risk, overdue, blocked — and who's on them? | per client in scope: period, due, preparer, reviewer (`client_assignments`), step 1–4 status, % close tasks, blocker reason, status (§4.1 rules) | Row → client home; **Reassign** inline; filter by staff/status | Done: "September closed on all 14 clients — 2 days early on average." |
| 2 | **Review queue** `am.review_queue` | What's waiting for my review or approval? | clients marked ready for review; JEs created-not-posted (bookkeepers can't post); recs awaiting sign-off; COA requests; payment holds; close sign-offs | **Review** (opens the client's step-3 summary with preparer notes) · **Approve** / **Return with note** | Done: "Nothing waiting on you." |
| 3 | **Capacity this week** `am.capacity` | Who is over/under loaded relative to what's due? | `weekly_capacity_hours` vs remaining_minutes on their assigned clients due this week; overdue count; open AI items | **Reassign** (drag a client to a person, writes an effective-dated assignment) · **Cover vacation** | Empty: "Set weekly capacity for your team" → Team. |
| 4 | **Blocked work** `am.blocked` | What is stuck, and why? | broken feeds, blocking requests >5 business days, period locked with open items, missing statements | Row → fix action (reconnect / escalate request / unlock request) | Done: "Nothing blocked." |
| 5 | **Stale client requests** `am.requests_stale` | Which client questions are aging and hurting close? | `client_requests` open >N days, grouped by client and asker | **Escalate** (re-send firm reminder, cc client owner) | Done: "No requests older than 3 days." |
| 6 | **Exceptions across clients** `am.exceptions` | Which control exceptions are high severity anywhere? | `ai_decisions` on the `/exceptions` rail, by severity/client | Row → exception | Done state with last-run time. |
| 7 | **Team quality** `am.quality` | Is the team's work sticking? | `/api/team-performance` (quality-gated KPIs, mig 074): return rate, rec re-opens, AI override rate per person | Person → their clients | Empty if fewer than 30 days of data. |
| 8 | **Onboarding tracker** `am.onboarding` (only while any client `onboarding`) | Which new clients are stuck in setup? | `locations.onboarding_status`, tracker API | Row → onboarding step / **Invite to finish** | Hidden when no clients onboarding. |

### 4.3 Platform admin — platform console home

**What it's for:** keep tenants moving from sign-up to live, catch the ones at risk, and make sure the
platform (billing, integrations, AI) isn't the reason anyone is stuck.

**First thing visible:** **Onboarding funnel** as status tabs with counts, over the **Tenant health**
table sorted by risk.

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **Onboarding funnel** `pf.funnel` | Where is every tenant between sign-up and live, and who's stuck? | `organizations.lifecycle_status`, `onboarding_state`, days in stage | Tab → filtered tenant list; **Nudge owner** / **Offer concierge setup** | Empty: "No tenants yet — Provision tenant." |
| 2 | **Tenant health** `pf.tenant_health` | Which tenants are at risk of failing or leaving? | risk score from: last activity, broken feeds, close lag vs due, error rate (`app_error_log`), AI budget burn (`core.ai_usage_log`), billing status | Row → tenant detail; **Request support access** | Done: "All 6 tenants healthy." |
| 3 | **Billing exceptions** `pf.billing` | Who needs a billing action? | plan (mig 131), seats vs plan, trial end, failed payments. Honest label while live charging is not wired: "MRR is list-price computed" | Row → tenant billing | Done: "No exceptions." |
| 4 | **Integration health** `pf.integrations` | Which provider connections are failing, platform-wide? | `plaid_items` errors, Stripe connected-account restrictions, `core.provider_connections`, inbound-AP webhook failures, Ramp syncs (planned), QBO tokens | Group by provider → affected tenants | Done: per-provider green with last-checked time. |
| 5 | **AI gateway** `pf.ai` | Is AI working, and is any tenant over budget? | gateway status (today: Anthropic org disabled → show as a **critical** row), spend vs budget per tenant (`core.ai_usage_log`, `core.ai_usage_counters`) | **Open gateway settings** | Done: "Gateway healthy · $X this month." |
| 6 | **Support access** `pf.support` | What access am I waiting on, and what sessions are open? | `support_access_grants`, `platform_admin_sessions` | **Request access** · **End session** | Done: "No open sessions." |
| 7 | **Errors & deploys** `pf.errors` | Did the last deploy break anything? | `app_error_log` by route/tenant, Vercel deployment state | Row → error group | Done: "No new errors since deploy abc123." |

Platform admin never sees a tenant's financial figures on this home.

**Platform support home** = modules 6 (their requests + sessions), 4 and 7, filtered to tenants with an
open ticket. Same layout system, smaller.

### 4.4 Tenant admin

**What it's for:** keep the account secure, staffed and paid — who has access to what, and is everything
connected.

**First thing visible:** **Access & seats** (pending invites, seats used vs plan, users without MFA) beside
**Support access requests** awaiting approval (only when any exist).

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **Access & seats** `ta.access` | Who's invited, who's active, who's missing MFA? | `memberships` (status), `membership_invitations`, Clerk MFA flag | **Resend** / **Revoke** / **Invite** | Done: "12 of 15 seats · everyone on MFA." |
| 2 | **Support access requests** `ta.support` | Is MeritBooks asking to see our books? | `support_access_grants` for this org | **Approve (60 min, read-only)** / **Deny** | Hidden when none pending; log link always in Settings. |
| 3 | **Access review** `ta.access_review` | Does anyone have access they no longer use or need? | `membership_locations` vs `core.action_log` activity (90 days); auditors past `access_expires_at` | **Remove access** (bulk) | Done: "Reviewed Oct 1 — next due Jan 1." |
| 4 | **Clients** `ta.clients` | How many clients, what status, who's assigned? | `locations` client_status + assignments | **Add client** / **Add many** | Empty: onboarding entry. |
| 5 | **Connections** `ta.connections` | Is anything disconnected across the tenant? | as `bk.feeds`, all clients | **Reconnect** | Hidden when healthy. |
| 6 | **Plan & billing** `ta.billing` | What are we paying and is anything due? | mig 131 plan, computed MRR | **Manage plan** | — |

### 4.5 Owner

**What it's for:** know how the business is doing in ten seconds, and make the handful of decisions only
I can make.

**First thing visible:** **Needs your input** (decisions with buttons) on the left, **Business at a glance**
on the right. Privacy toggle (eye icon) blurs all figures for screen-sharing.

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **Needs your input** `ow.decisions` | What is waiting on me? | approval_requests routed to me (bills, payment runs, POs), `client_requests` assigned to me, sign-offs | **Approve** / **Answer** inline (one tap; SoD respected) | Done: "Nothing needs you. Books are current through Sep 30." |
| 2 | **Business at a glance** `ow.glance` | Am I making money and do I have cash? | cash today + 13-week low point (`/api/cash`, forecast), revenue & gross margin MTD vs last month and vs budget, AR overdue, AP due next 14 days | Tile → report | Empty before first close: "Your first month closes Oct 15." |
| 3 | **Books status** `ow.books_status` | Can I trust these numbers? | close status per client in scope; last closed period; open blocking items count | **See what's open** | Done: "Closed through September · reviewed by J. Smith." |
| 4 | **Clients side-by-side** `ow.clients_compare` (scope >1 client) | Which of my companies is up or down? | revenue, gross margin %, EBITDA, cash per client, vs last month/budget | Row → client home | — |
| 5 | **Consolidated** `ow.consolidated` (**only with a group grant**) | How is the group doing as a whole? | consolidation engine for the granted group: revenue, EBITDA, cash, net debt; eliminations total shown as a line | **Open consolidated statements** (switches to consolidated context) | Not rendered without a grant. |
| 6 | **Covenants** `ow.covenants` (if any loans) | Am I safe with my lenders? | `covenant_measurements` headroom (mig 078) | Row → covenant | Hidden when no covenants. |

Mike's own home as owner of the Merit tenant = this layout with `ow.consolidated` for "Merit Management
Group — Consolidated" and `ow.clients_compare` across all clients.

### 4.6 CFO

**What it's for:** cash, performance vs plan, lender readiness, and money-movement release — across
everything I oversee.

**First thing visible:** a compact **KPI strip** (one row, 6 tiles, each with vs-budget and drill) above
**Approvals awaiting release**. No hero numbers.

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **KPI strip** `cfo.kpis` | Where are we vs plan? | cash (scope), 13-week low point, revenue MTD vs budget, EBITDA vs budget, DSO, DPO | Tile → report | — |
| 2 | **Awaiting release** `cfo.release` | What money is waiting for my release? | `disbursement_batches`, `payroll_runs`, origination batches pending release; SoD: excludes my own prepared items | **Release** (with fraud-screen flags inline) | Done: "Nothing to release." |
| 3 | **Clients side-by-side** `cfo.compare` | Which entities are driving variance? | per client P&L vs budget; flux narrative (M7) | Row → variance report | — |
| 4 | **Close blockers** `cfo.close_blockers` | Will the close be late, and why? | `am.close_grid` summarised to at-risk/overdue/blocked only | Row → client | Done: "On track to close Oct 15." |
| 5 | **Covenant headroom** `cfo.covenants` | Are we inside every covenant, and how close? | `covenant_measurements`, borrowing base | **Prepare certificate** | Hidden when none. |
| 6 | **Consolidated** `cfo.consolidated` (groups held) | Group performance and eliminations | consolidation engine | **Open consolidated** | Not rendered without groups. |
| 7 | **Forecast** `cfo.forecast` | What does the next 13 weeks look like? | 13-week direct cash flow forecast | **Open forecast** | — |

### 4.7 Controller

**What it's for:** prove the books are right and closed — by module, by client — and keep controls and
intercompany clean.

**First thing visible:** **Close-through matrix** (clients × modules).

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **Close-through matrix** `ctl.close_through` | Which modules are closed through which date, per client? | per client: bank rec, AR tie, AP tie, payroll tie, fixed assets/depr run, accruals, rev-rec run, intercompany, period status | Cell → that module for that client | Done: all cells through period end. |
| 2 | **Exceptions by severity** `ctl.exceptions` | What control exceptions are open? | `/exceptions` rail across scope | Row → exception | Done with last-run time. |
| 3 | **Unusual & manual JEs** `ctl.manual_jes` | Which manual entries above materiality need a look? | `gl_entries` manual source, over materiality, EC-10 flags, post-close entries | **Review** | Done: "None above $5,000." |
| 4 | **Recs to sign off** `ctl.rec_signoff` | Which reconciliations need my sign-off? | `bank_reconciliations` preparer-signed, unreviewed | **Sign off** / **Return** | Done. |
| 5 | **Intercompany & eliminations** `ctl.intercompany` (groups held) | Do intercompany balances agree so groups consolidate clean? | EC-3, `intercompany_balances`, group eliminations preview | **Resolve** pair | Done: "All pairs agree." |
| 6 | **Period control** `ctl.periods` | What's open, soft-closed, hard-closed? | `fiscal_periods` per client | **Hard close** (gated) | — |

### 4.8 Finance director

CFO layout (§4.6) limited to assigned scope, with **Budget vs actual by client/department** replacing
Covenants by default and no accounting-settings actions. Primary module: `fd.bva` — "Which of my
units is off plan and why?" → variance report.

### 4.9 HR / payroll

**What it's for:** every payroll is on time, funded, posted, and its liabilities remitted.

**First thing visible:** **Upcoming payrolls** (per client: pay date, status, funding check).

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **Upcoming payrolls** `hr.upcoming` | What pays next, and is it funded? | `pay_schedules`, `payroll_runs`, cash at funding account vs net pay | **Import register** / **Submit for release** | Done: "Next payroll Oct 24 · funded." |
| 2 | **Posted & tied** `hr.tied` | Did each payroll post balanced and tie to the register? | `payroll_runs` × `gl_entries` (`PAYROLL_RUN`), register-import totals | Row → JE | Done. |
| 3 | **Liabilities to remit** `hr.remit` | What tax/benefit payables are due? | payroll liability balances + remittance route | **Record remittance** | Done: "Nothing due this week." |
| 4 | **Requests** `hr.requests` | What does the bookkeeper need from me? | `client_requests` assigned to me | **Answer** | Hidden when none. |

### 4.10 Department head / operations leader

**What it's for:** run my department against budget and approve my team's spend.

**First thing visible:** **Approvals for my department** beside **My department vs budget**.

| # | Module (id) | Question | Data | Primary action | Empty / done |
|---|---|---|---|---|---|
| 1 | **Approvals** `dh.approvals` | What spend is waiting on me? | `approval_requests` routed by department (mig 092) — bills, expenses, POs | **Approve** / **Reject with note** | Done: "Nothing waiting." |
| 2 | **Department vs budget** `dh.bva` | Am I on budget this month and year? | dept P&L MTD/YTD vs `budgets` (membership_departments scope) | → dept report | Empty: "No budget set — ask finance." |
| 3 | **Open POs** `dh.pos` | What have we committed but not received? | `purchase_orders` open by dept | Row → PO | Hidden when none. |
| 4 | **Jobs** `dh.jobs` (job-costing clients) | Which of my jobs are over/under? | job WIP, EAC | Row → job | Hidden when none. |

### 4.11 External auditor / view-only

**What it's for:** get what I asked for and test it without emailing anyone.

**First thing visible:** **PBC list** status (requested / provided / accepted, overdue).

Modules: `au.pbc` (→ accept/return item), `au.periods` (locked periods — "is the period I'm testing
frozen?"), `au.statements` (statements with drill to GL → source document), `au.audit_trail` (search).
Shell shows a persistent read-only chip "Auditor · read-only · access until Nov 30".

### 4.12 Client contact

**What it's for:** answer my bookkeeper's questions in under a minute, from my phone.

**First thing visible:** the requests themselves — no dashboard. Each card: the transaction (date,
amount, payee, card/bank), the question, **one-tap answers** (suggested categories from the bookkeeper,
"Personal", "I don't know — call me"), attach receipt (camera), free-text. Done state: "You're all caught
up. Your bookkeeper is Dana Lee." Works signed-in or via magic link (M-7).

### 4.13 Payments clerk / data entry

Single-module homes: **Check run queue** (`pc.queue` — what's approved and ready to print/queue →
**Queue run**) and **My drafts** (`de.drafts` — receipts/bills I keyed that are still incomplete →
**Finish**). Done states name the next expected batch.

---

## 5. Dashboard customization model

### 5.1 Three layers, most specific wins (within the lock)

| Layer | Who sets it | Applies to | Stored |
|---|---|---|---|
| **1 System template** | product (code) | every role, every tenant | widget registry `defaultLayouts` |
| **1b Platform default** | platform admin | every tenant that has not published its own for that role | `dashboard_layouts` scope `platform` |
| **2 Tenant role layout** | tenant admin (and accounting manager if granted `dashboard_layouts:publish`) | everyone in the tenant with that role | scope `tenant` + `lock_level` + `required_widget_ids` |
| **3 User personalization** | the user | themselves | scope `user` |

Resolution: user layout (if lock allows and it is based on the current tenant version) → tenant role
layout → platform default → system template. Then **filter by permission**: any widget whose required
permission the user lacks is removed and the grid reflows (never a blank tile). Required widgets are
re-inserted if missing.

### 5.2 Lock levels

| Lock | User may | User may not |
|---|---|---|
| **Locked** | collapse a widget, change a widget's own filters (e.g. confidence band) | add, remove, move, resize |
| **Add & move** | add from catalog, move, resize, remove non-required | remove required widgets |
| **Unlocked** | everything | remove required widgets |

### 5.3 Edit-mode UX

- **Customize** (top-right of every home) enters edit mode in place; the page keeps live data.
- Grid: 12 columns desktop, 6 tablet, single column mobile (mobile order = reading order of desktop rows).
  Allowed sizes per widget snap to `S 3×2 · M 6×2 · L 6×4 · W 12×2 · XL 12×4`.
- Each widget shows a drag handle, a resize handle (only allowed sizes), a ⚙ for its config, and a lock
  icon if required. Keyboard: focus the handle, arrows move, Shift+arrows resize, Enter drops.
- **Widget catalog** drawer (left): search, grouped by category, each card shows a live thumbnail,
  sizes, and what it answers. Only widgets the user is permitted to see are listed.
- **Undo** (⌘Z) and **Reset to role default** (confirm dialog shows what will be lost).
- **Admins** get a second mode: **Edit role layout** → pick role and surface (workspace home / client
  home) → preview as a sample user of that role → **Publish** dialog:
  lock level · required widgets · **Apply to: New users only | Everyone (resets N personalized layouts)**
  · release note. Publishing creates a new version; **Version history** allows rollback.
- **Platform admin** publishes platform defaults the same way. Tenants that have their own published
  layout for that role are **not** overwritten; their admins see "New default available — Compare /
  Adopt / Dismiss". (Open question Q3.)

### 5.4 Widget registry (code, `lib/dashboard/registry.ts`)

Each entry:

| Field | Meaning |
|---|---|
| `id` | stable key, e.g. `bk.my_clients` |
| `title`, `question` | title + the one question it answers (shown in catalog) |
| `category` | Work · Close · Cash · Performance · Controls · Team · Platform |
| `surfaces` | `workspace_home` / `client_home` / `platform_home` / `consolidated` |
| `requiredPermission` | `{ feature, action }` from the feature catalog, plus `requiresGroupGrant` / `requiresPlatformRole` |
| `sizes`, `defaultSize` | allowed grid sizes |
| `dataSource` | API route (e.g. `/api/dashboard/widgets/bk.my_clients`) — server-side, scope-filtered |
| `refresh` | `live` (on focus + 60s) · `5m` · `on_open` |
| `configSchema` | Zod schema for widget settings (client filter, band, period) |
| `primaryAction` | label + route builder |
| `emptyState`, `doneState` | copy + optional CTA |
| `loadPriority` | `primary` (SSR, above fold) · `lazy` |
| `suggestedRoles` | roles whose system template includes it |

Every widget data route goes through `apiQueryHandler` and the scope rules in §7 — widgets never filter
client-side.

### 5.5 Layout JSON (stored in `dashboard_layouts.layout`)

```json
{ "grid": 12,
  "items": [
    { "widget": "bk.my_clients", "x": 0, "y": 0, "w": 8, "h": 4, "config": {} },
    { "widget": "bk.agenda",     "x": 8, "y": 0, "w": 4, "h": 4, "config": { "horizon": "week" } } ] }
```

---

## 6. The bookkeeper's automation loop (end to end)

Principle (canon §3): **AI proposes facts → the deterministic engine does the accounting → a human
approves.** Auto-post is OFF by default; the M10 autonomy dial can raise it per task per tenant.

| # | Step | System does automatically | Human decides | Where exceptions surface |
|---|---|---|---|---|
| 1 | **Ingest — bank** | Plaid pulls transactions per client account; dedupes; tags client from the account | — | `bk.feeds` (disconnected), Client home step 1 |
| 2 | **Ingest — cards incl. Ramp** | *(planned, gap #1)* Ramp Developer-API connection pulls `ready_to_sync` card txns, bills, reimbursements **with receipt and Ramp coding**; Ramp coding is treated as a strong signal, not truth; MeritBooks pushes COA/dimensions/vendors to Ramp | — | sync failures → `bk.feeds`; Ramp-vs-GL completeness detector → step 3 Check |
| 3 | **Ingest — documents** | Email-to-bill inbound (mig 135), receipts upload, smart intake → draft bills/receipts; stored before AI step (mig 112) | — | draft bills in step 1 |
| 4 | **Pair & dedupe** | Transfers between own accounts paired; bill payments matched to bills; Ramp statement payment paired to the posted entry (no double count); duplicate-payment detector (EC-1) | confirm ambiguous pairs | step 1 "Check" band |
| 5 | **Code** | Deterministic rules first → vendor memory / `learned_preferences` → AI categorizer via the Core gateway (works without AI: rules + memory still code) | — | — |
| 6 | **Score & band** | Composite score (vendor 40 / amount 40 / date 20) → **Ready ≥90** (preselected for batch), **Check 70–89**, **Decide <70** or any item with a clarifying question. Auto-approve eligibility shown separately: confidence ≥85 AND trusted vendor AND ≤$10,000 AND autonomy dial = auto | — | `bk.ai_judgment` bands |
| 7 | **Review** | Keyboard queue (j/k/a/f/Space), vendor batch select, "select all ≥90", inline GL search with vendor recents, AI reasoning shown | **Approve / edit / flag** each Check & Decide item; batch-approve Ready | step 1 |
| 8 | **Ask client** | From selected transactions, build a `client_request` with suggested answers; magic link; reminders per policy; answer re-codes the item and teaches vendor memory | **whether to ask** vs decide; accept the answer | `bk.requests_out`, `am.requests_stale` |
| 9 | **Post** | Deterministic engine: debits = credits, period lock, COA approval, dimensions, control accounts; idempotent `source_ref` | (approval was step 7; JE post by manager for manual JEs) | posting errors return to step 1 with reason |
| 10 | **Reconcile** | Statement import, auto-match, outstanding aging, difference decomposer | **sign** each reconciliation (preparer); reviewer signs off | step 2; `ctl.rec_signoff` |
| 11 | **Check** | Exception library runs on period end: EC-1/2/3/4/6/10/12, subledger↔GL tie-outs, payroll ties, suspense, negative balances | **resolve / explain / accept** each | step 3; `am.exceptions`, `ctl.exceptions` |
| 12 | **Close checklist** | Auto-verify tasks whose condition is checkable (`is_auto_verified`); generate recurring JEs, depreciation, amortization, rev-rec runs as proposals | **complete** remaining tasks; **Mark ready for review** | step 4; `am.close_grid` |
| 13 | **Review & sign-off** | Reviewer packet: what changed, returned items, exceptions accepted, auto-work sample | reviewer **approve / return**; controller/CFO hard close (gated) | `am.review_queue` |
| 14 | **Deliver** | Client packet (P&L/BS/cash + narrative) drafted; consolidation for groups; board/lender packs | **send** to client contact / owner | owner `ow.books_status` |
| 15 | **Learn** | Approved codings and answered requests update vendor memory and `learned_preferences` (proposal-only influence) | — | `bk.done_for_you` shows "learned 4 new vendor rules" with undo |

What the bookkeeper actually does in a good month: approve the Ready batch, decide the Decide band,
ask about the handful nobody can know, sign recs, resolve exceptions, mark ready. Everything else is
pre-work they glance at.

---

## 7. Security & access requirements this IA depends on

The IA is only honest if access is enforced server-side. **R1–R5 are must-fix before a second tenant
or before any bookkeeper is given `assigned` scope in production.**

| # | Requirement | Current gap (`01-CODE-REALITY`) | Fix |
|---|---|---|---|
| **R1** | Client access enforced in Postgres | RLS is `org_id` only; client access is UI-only | M-4 `can_access_location()` on every table with `location_id` (and children). Guard test: every policy on a `location_id` table calls it (extend `schema.test.ts`); extend `tenant-isolation.test.ts` to a two-client, two-bookkeeper isolation case. |
| **R2** | Every API checks client scope | APIs don't compare `location_id` to assignment; `/api/portfolio` + `/api/portfolio/assignments` have **no permission check**; dashboard + `/api/portfolio` show all companies to everyone | `apiHandler` ctx gains `accessibleClientIds` + `requireClientAccess(locationId)`; all list routes filter by it; renamed `/api/clients*` get permissions (`clients:view`, `assignments:assign`). |
| **R3** | `assigned` scope actually means assigned | `portcos_and_3rdparty` ignores assignments | delete the scope; `client_scope` from membership only. |
| **R4** | Consolidation requires access to every member | `GET /api/consolidation/statements` has **no permission check**; `canConsolidate` enforced client-side only; no named groups | M-6 groups + grants; server `requireGroupAccess(groupId)` = holds grant AND `can_access_location` for every current member; eliminations and members' figures only returned through the group route; the consolidated option appears in the switcher only for holders. Grant suspension on member add (M-6 trigger). |
| **R5** | Authority comes from `core.memberships` | real authority is `core.employees.role` + `employee_locations`; `membership_locations` write-only | M-3 backfill; `require-permission`, page-guard and RLS read memberships; employees = HR record. |
| R6 | Bounded delegation | only `company_admin` can manage users; accounting manager blocked | §2.6 rules in the assignments/access routes; DB check that granter holds access to the client being granted; all grants to `core.action_log`. |
| R7 | Support access by consent | no consent flow; `platform_admin_sessions` written only by tenant reset; env allowlist = ambient power | M-9: request (reason + ticket) → tenant admin approves → time-boxed, scoped session; red band; tenant-visible log; `can_access_location()` honors only approved, unexpired grants; break-glass only per Q6. |
| R8 | Context cookie is a hint, never authority | `mb_active_company` cookie with `'all'` sentinel | validate on every request; retire `'all'`; reject processing writes without a validated client. |
| R9 | Client contacts can't reach the ledger | (new role) | role has no internal features; middleware allowlist for `client_contact` (requests, documents, approvals); magic-link tokens single-request, hashed, rate-limited, anon grants revoked (same pattern as mig 149). |
| R10 | Auditors are read-only and time-boxed | auditor is a custom role (mig 145) | system role with `access_expires_at` required; TIN/PII masked; every view logged. |
| R11 | SoD preserved through capacity | preparer≠approver is DB + service enforced for money | release/approve checks also refuse when the user is the `preparer` assignment on that client for that item; close sign-off reviewer≠preparer per tenant setting (Q5). |
| R12 | Widgets don't leak | dashboard shows all companies | widget data routes are server-side, scope-filtered (§5.4); a widget the user can't use is never rendered. |
| R13 | Platform never sees figures by default | Operator Console metrics | platform homes show counts, health and money owed to MeritBooks only — no tenant GL figures. |

---

## 8. Screen list for the next design round

Minimum set to prove the IA. Each uses real Merit-shaped sample data (named clients, real-looking
amounts), shows **open state, empty state, done state**, and at 1440 and 390 widths where noted.

| # | Screen | Must show |
|---|---|---|
| **S1** | **Bookkeeper home** (B Cockpit) | context line (no banner); `bk.my_clients` ranked with all 5 statuses incl. one Blocked and one At risk; `bk.agenda`; `bk.ai_judgment` with three bands and counts; `bk.requests_out` with a 5-day blocking request; `bk.done_for_you` with linked counts and "Spot-check 5"; `bk.feeds` with one broken feed. Plus the all-Ready done state. |
| **S2** | **Client home — books-review loop** (inside Clive Power Equipment) | four-step header with counts; step 1 expanded; "Returned by reviewer" item; completion state with **Next client →**. |
| **S3** | **Review queue inside a client** (bank & card feed) | band tabs Decide / Check / Ready with counts; confidence bars; match badges; AI reasoning in the edit panel with vendor-recent GL accounts; batch "Approve 212 Ready"; **Ask client** from 3 selected rows (composer with suggested answers); keyboard hints. |
| **S4** | **Client request — answer** (client contact, magic link, 390px) | transaction card, one-tap answers, camera attach, confirmation, "all caught up" state. |
| **S5** | **Accounting manager workspace home** | `am.close_grid` across ~14 clients with preparer/reviewer and statuses; review queue chip + panel; `am.capacity` with one over-loaded person and drag-to-reassign; blocked work; stale requests. |
| **S6** | **Owner / CFO home with a permitted consolidation** (A Annual Report) | Mike as owner: `ow.decisions` with an approve-payment-run card; `ow.glance`; `ow.clients_compare`; `ow.consolidated` for "Merit Management Group — Consolidated" with an eliminations line; privacy toggle on/off. Variant: same role **without** a grant (module absent, grid reflowed). |
| **S7** | **Context switcher + shell states** | open switcher (Pinned, My clients with status dots, Consolidated section, Workspace); the four shell states side by side: client, **own books** (amber band), **consolidated** (steel band), **support session** (red band with countdown). |
| **S8** | **Dashboard edit mode** | user edit (catalog drawer filtered by permission, drag/resize handles, required-widget lock, reset); admin **Edit role layout** + **Publish** dialog (lock level, required widgets, new users only vs everyone with affected count, version history). |
| **S9** | **Platform console home** | funnel tabs with counts; tenant health table sorted by risk (one tenant at risk, one with broken Plaid); billing exceptions with the "list-price computed" honesty label; AI gateway row in **critical** (org disabled); support access panel. |
| **S10** | **Support access — request & approve** | platform side: request (reason, ticket, scope, duration); tenant admin side: approval card on `ta.support`; tenant-visible access log. |
| **S11** | **Team & access — assign and delegate** | staff list with capacity; assign a bookkeeper to clients with capacity (preparer/reviewer) and function; delegation limits visible (greyed roles above manager); consolidation grant blocked with reason "no access to Dorrian HVAC". |
| **S12** | **Consolidation group setup** | create group (consolidated vs combined explained in one line each); member tree from `entity_ownership` with % and method; add a sister client to a combined group; grant list with a suspended grant. |

---

## 9. Open questions for the owner (genuine decisions only)

| # | Decision | Recommended default |
|---|---|---|
| **Q1** | Is Merit's tenant a **firm** (UI says "Clients", Merit Management Group LLC shown as "Own books") or a **company** (UI says "Companies")? | **Firm.** Merit services its companies under an MSA, bills them and assigns staff per company — and it's the white-label template for firms you'll resell to. |
| **Q2** | Do client contacts need logins at launch, and are client-contact / auditor seats billable? | **Magic link at launch, login optional; client contacts and auditors free** (pricing stays per company, mig 131). Friction on the client side kills response rates. |
| **Q3** | Can the platform admin **force** a dashboard layout onto tenants that customized theirs? | **No** — platform publishes defaults; customized tenants get "New default available"; only platform-**required** widgets (e.g. security/billing notices) are forced. You can still move anything as **tenant admin of Merit**. |
| **Q4** | Do roles with `all` client scope (tenant admin, CFO, controller) see every consolidation group automatically? | **Yes, view only**; `manage` and any `assigned`-scope viewer need an explicit grant. |
| **Q5** | Must close sign-off be by someone other than the preparer? | **Yes for firm tenants and any tenant with ≥2 finance users; tenant setting can turn it off.** Money release SoD stays DB-enforced regardless. |
| **Q6** | Is there a platform **break-glass** (access without tenant approval)? | **Only for a declared security/legal incident**: 30 min, read-only, reason mandatory, tenant admin notified immediately, appears in their log. No routine break-glass. |
