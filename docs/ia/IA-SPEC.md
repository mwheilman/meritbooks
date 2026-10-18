# MeritBooks — Information Architecture & Role Dashboards Spec

**Status:** **v2** DRAFT for owner review · v1 authored 2026-10-18 · **v2 revised 2026-10-18** after three reviews
(`04-CAPABILITY-MAP.md`, `05-RBAC-SPEC.md`, `06-EXISTING-UI-AUDIT.md`) and new owner direction (complete RBAC
customizability; a best-in-class onboarding import wizard; connectors to ServiceTitan, Buildertrend, Innergy, simPRO,
RFMS, C-Systems and many ERPs). Governs the next design round and the tenancy / access / navigation / dashboard build.

**Inputs (binding order):** `00-OWNER-DIRECTIVE.md` (owner's words) → `docs/canon/CANON-ANCHOR.md` →
`05-RBAC-SPEC.md` (**authority for access**) → `04-CAPABILITY-MAP.md` (**the inventory every nav and home must cover**) →
`06-EXISTING-UI-AUDIT.md` → `01-CODE-REALITY.md` / `03-CODE-INVENTORY.md` → `02-MARKET-PATTERNS.md` → `FPB-onboarding.md`
→ `COMPETITIVE-GAP-ANALYSIS-2026-10.md`. Companion specs being written in parallel: **`07-INTEGRATIONS-PLAN.md`**
(connectors, sync, mapping, scheduler use) and **`08-ONBOARDING-V2-SPEC.md`** (the import wizard). This spec gives them
their place in the IA (nav, roles, widgets, sequencing) and defers to them on internals. Where this spec and the owner
directive disagree, the directive wins. Where this spec and 05 disagree **on who may do what**, 05 wins.

**What this is:** the account model, contexts, navigation, the route map, settings, home screens, dashboard
customization, the automation loops, the access rules all of that depends on, and the build order. It is a spec, not
code. Schema items are numbered migrations (columns, not SQL): **M-n** here, **R-n** in 05, plus the migration lists in
07 and 08. The lead assigns real numbers (on-disk Books migrations run through `153`; first free is `154`).

**What this is NOT:** a widget wish-list. Every module answers one question, opens one queue or report, and has a
defined empty/done state. If a module can't name its primary action, it's cut.

### v2 change log

| § | v2 change |
|---|---|
| 0 | Decisions 13–20 added: RBAC as data (05), full capability coverage (04), Controls group, side-by-side compare vs consolidation, one chase engine, integrations/onboarding placement, scheduler prerequisite, build waves. |
| 1 | Glossary and model align to 05 (role definitions, access assignments, capacity assignments, permission sets, client sets, envelopes). M-3/M-4/M-6/M-7/M-8 amended; new M-11…M-15 (cards & receipt policy, scheduler run log, notifications & watch rules, lender reporting & external shares, server-side saved views). |
| 2 | Role catalog replaced by a summary of 05's model + the standard template list, adding **employee / cardholder** and **lender viewer**, client-defined roles, and the IA-side amendments 05 needs (§2.6). |
| 3 | Full navigation per context covering every LIVE/PARTIAL capability in 04; progressive disclosure rules; role-filtered default nav; consolidated + own-books + compare modes; **settings IA (all areas)**; **route-by-route map** of every existing page; duplicate resolutions; the compare-vs-consolidation decision; a coverage index proving all 242 LIVE/PARTIAL capabilities in 04 are placed. |
| 4 | Every role home updated with the 04 widgets; new homes for check processor (payments clerk), employee/cardholder, lender viewer, AP/AR clerk, client admin. |
| 5 | Widget registry rewritten: 127 widgets with RBAC capability, sizes, data source, surfaces; registry keyed to role definitions (custom roles get a home). |
| 6 | Loop extended: AP/pay-run, AR/cash application, receipt chase, vendor-document chase, rev rec, schedules, lender reporting — each tied to its scheduler job. |
| 7 | Security list re-based on 05's PDP; must-fix items from 05 (C3) and 06 (unguarded pages/APIs) added; R1–R5 + C3 are wave 0–2. |
| 8 | Screens S13–S28 added (RBAC builder, user/client access, explainer, access review, integrations hub, onboarding v2, check processor, employee receipts, FP&A, covenants/lender, controller, settings, compare, full client nav). S2/S3 amended. |
| 9 | Open questions merged to 8, with defaults (incl. RBAC, integrations, onboarding, chase). |
| 10 | **New:** build sequencing in numbered waves across M-, R-, scheduler, integrations, onboarding; security first. |

---

## 0. The decisions on one page

1. **"Portfolio" is gone.** The hierarchy is **Platform → Tenant → Client → (optional) Consolidation group**.
2. **A Client is a set of books = one legal entity = one `core.locations` row.** The table name stays; the product
   word is "Client" (firm tenants) or "Company" (company tenants). Same object.
3. **Tenant type (`firm` | `company`) only changes defaults and labels**, never the data model. Merit Management Group
   is a `firm`-type tenant; its operating companies are its clients; **Merit Management Group itself is a client**
   (flagged as the tenant's own books) with subsidiaries.
4. **Consolidation is a first-class, named group.** Seeing a *summed* roll-up is a **group-scoped grant** that can only
   be held by someone who can access **every** member. Bookkeepers don't get it by default.
5. **(v2) Access is data, per `05-RBAC-SPEC`.** Roles are versioned definitions owned at **platform** (templates),
   **tenant** (standard or custom) or **client** (inside an envelope the tenant sets) level. Authority =
   **access assignment = membership × scope × role (or permission set)**, scope = all clients · one client · client set
   · consolidation group · tenant. **Capacity** (preparer / reviewer / approver / lead) is a separate assignment that
   drives queues and transaction SoD, never permissions.
6. **Client access becomes real**, enforced in Postgres RLS (`can_access_location()` over `core.effective_access`) and
   in every API, page, widget and nav item through one decision point, `authorize()` (05 §5). Today it is UI-only —
   that and 05's C3 money-approval bug are the first fixes (§10 wave 0–2).
7. **Contexts, one switcher:** Platform console · Tenant workspace · Client books · Tenant's own books (amber) ·
   Consolidated (steel) · plus overlays for Support session (red) and View-as (violet). One context switcher (⌘J)
   replaces the plane switcher, the header company picker, every in-page company picker and the `'all'` sentinel.
8. **No home opens with a banner.** Every home opens on a work surface: a ranked queue, a status grid, or decisions
   with buttons. One 32px context line at most; no welcome copy; no hero number without a comparison and a drill.
9. **The bookkeeper is the primary user.** Their home is a cross-client day plan ranked by "furthest from close"; inside
   a client it is a four-step books-review loop (Review → Reconcile → Check → Close) that hands them to the next client.
10. **Automation shows its work** in "Done for you — worth a glance", and **agents waiting on a person** surface in the
    queues (`ai.agent_gates`) — never a vanity percentage.
11. **Dashboards are customizable in three layers:** system template per role → tenant-published layout per role
    (Locked / Add-and-move / Unlocked, required widgets) → user personalization. Platform admin publishes defaults. A
    code widget registry filtered by the user's compiled capabilities means no blank widgets. **(v2)** Layouts key to
    role *definitions*, so a custom role inherits the home of the template it was cloned from.
12. **Platform support access requires tenant consent**, is time-boxed and scoped, opens a red-band session, and is
    logged where the tenant can read it.
13. **(v2) Nothing that exists is lost.** Every LIVE/PARTIAL capability in 04 has a nav home (§3.6), and every existing
    route has a stated v2 home — kept, merged or retired (§3.9). The client nav has **10 groups (9 + client settings) with progressive
    disclosure** (modules appear when the client uses them; rare items sit behind a group's "More").
14. **(v2) A Controls group exists in every client** (Exceptions · Approvals · Compliance & SOX · Audit trail · AI
    decision log · Agents · PBC) and in the workspace Work group.
15. **(v2) Side-by-side comparison does not need a group; sums do.** Any user may compare, column by column, the clients
    they can each view. Summed or eliminated statements (P&L/BS/CF/TB, board package, combined borrowing base, group
    covenants) require a consolidation group and a grant (§3.11).
16. **(v2) One request & chase engine.** Client questions, receipt chase to cardholders, vendor W-9/COI chase, PBC and
    lender deliverables all run on M-7's request + reminder engine, with one Requests UI.
17. **(v2) Two new standard roles:** **Employee / cardholder** (my receipts, my expenses, mobile-first) and **Lender
    viewer** (read-only, time-boxed, sees only what was delivered to them). Payments clerk is labelled **"Check
    processor"**.
18. **(v2) Integrations and onboarding have first-class homes:** a workspace **Integrations hub** and per-client
    connections (07), **Add clients / Onboarding tracker / Data import & conversion** running the v2 wizard (08). Data
    from any connector or import lands as **proposals in review queues**; it never posts on its own unless the autonomy
    dial says so.
19. **(v2) A scheduler is a prerequisite**, not a detail: daily feed pulls, nightly detectors, rev rec on the 1st,
    reminders, report packs and connector syncs all need it, and every widget's done state shows its last-run time.
20. **(v2) Build order is fixed** (§10): security fixes → access foundations (M-1/M-2, R-1…R-5) → enforcement flip (R-11,
    M-4) → shell & nav → homes & loop → breadth → chase & external audiences → integrations & onboarding v2 → retire legacy.

---

## 1. Glossary & account model

### 1.1 Glossary (v2) — use these words exactly; never "portfolio", "portco", "holding company", "entities" in UI

| Term | Definition | Stored as |
|---|---|---|
| **Platform** | MeritBooks the operator (Mike + platform staff). Provisions tenants, sees cross-tenant health, never sees a tenant's books without consent. | platform-audience role assignments (05 §1.2) |
| **Tenant** | The customer account that signs and pays. Has users, settings, a brand, and one or more clients. Type `firm` or `company`. | `core.organizations` |
| **Tenant type** | `firm` = keeps books for others. `company` = a business keeping its own books (one or many entities). | `core.organizations.tenant_type` (M-1) |
| **Client** | One set of books for one legal entity: its own COA instance, periods, bank accounts, GL. UI label "Client" (firm) / "Company" (company). | `core.locations` |
| **Tenant's own books** | The client that *is* the tenant (e.g. Merit Management Group LLC). Distinct amber shell treatment. | `core.locations.is_tenant_own_books` (M-2) |
| **Subsidiary** | A client legally owned (fully or partly) by another client; effective-dated. | `public.entity_ownership` |
| **Consolidation group** | A named reporting scope. **Consolidated** (consolidator + subsidiaries, ownership %, NCI, FULL/EQUITY/NONE) or **Combined** (selected sister clients, summed, intercompany eliminated). | `public.consolidation_groups` + `_members` (M-6) |
| **Eliminations** | Intercompany amounts removed at group level; belong to the group, shown as explicit lines. | 076 engine + group top-sides (later) |
| **Compare set** *(v2)* | A saved selection of clients shown **side by side, never summed**. Needs no grant beyond view on each client. | `public.saved_views` surface `compare` (M-15) |
| **Capability** *(v2)* | `resource × action`, e.g. `ap.bills:approve`. 9 actions: view · create · edit · delete · approve · post · release · export · configure. | code registry mirrored to `core.capabilities` (05 R-1) |
| **Role definition** *(v2)* | A versioned bundle of grants (+ policies: default scope, field masking, MFA/step-up, max duration). Owned at platform / tenant / client level; `standard` or `custom`. | `core.role_definitions` / `_versions` / `_grants` (05 R-2) |
| **Permission set** *(v2)* | An add-on bundle of grants assigned like a role, often time-boxed ("Wire release ≤ $50k"). | `core.permission_sets` (05 R-3) |
| **Membership** | One person's seat in one tenant: audience, status, primary role (display/default only), capacity hours, billing-owner flag. | `core.memberships` |
| **Access assignment** *(v2)* | membership × scope × role or permission set, with mutes / read-only / tighten-only constraints and dates. **The only source of authority.** | `core.access_assignments` (05 R-4) |
| **Client set** *(v2)* | A saved static or rule-based set of clients used as an assignment scope ("HVAC clients", "where I'm primary preparer"). | `core.client_sets` (05 R-4) |
| **Capacity assignment** *(renamed from "Assignment")* | Responsibility for work on a client: `preparer` / `reviewer` / `approver` / `lead`, optionally per function (`close`,`ap`,`ar`,`payroll`,`onboarding`). Requires access; never grants it. | `core.client_assignments` (M-5) |
| **Client envelope** *(v2)* | The maximum any client-defined role may contain, per client. | `core.client_access_policies` (05 R-5) |
| **Client admin** *(v2)* | A client-staff person who manages that client's own staff and roles inside the envelope (only if enabled). | standard role `client_admin` |
| **Client contact** | A person at the client who answers requests, uploads documents, approves if delegated — never the ledger. | standard role `client_contact` |
| **Employee / cardholder** *(v2)* | A person who holds a company card or submits expenses: sees only their own charges, receipts, expense reports. | standard role `employee` (§2.2) |
| **Lender viewer** *(v2)* | An external lender/investor contact who sees only certificates and packs delivered to them. | standard role `lender_viewer` (§2.2) + M-14 shares |
| **Request** | A question, document ask, approval, receipt chase, vendor-document chase or PBC item, attached to its subject, with a reminder policy. | `public.client_requests` (M-7, v2 widened) |
| **Chase** *(v2)* | A request whose reminder policy keeps following up until resolved (cadence, escalation, quiet hours, channels). | M-7 `reminder_policy` |
| **Connector** *(v2)* | A configured link to an outside system (Plaid, Stripe, Ramp, ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems, ERPs, QBO/Xero/Sage migration). Defined in 07. | 07 |
| **Conversion** *(v2)* | Bringing a client's history and opening balances in through the v2 wizard, ending at a tie-out gate. Defined in 08. | 08 + `onb.*` capabilities |
| **Workspace** | The tenant-level surface across clients (home, registry, close grid, team, insights, integrations). | UI concept |
| **Books review** | The per-client, per-period four-step loop: Review → Reconcile → Check → Close. | derived from queues + `close_checklists` |

### 1.2 Shape (v2)

```
Platform (MeritBooks)                                   platform role assignments, templates, SoD rules
└── Tenant  [type: firm | company]                      core.organizations
    ├── Role library: tenant roles (standard|custom), permission sets, client sets      05 R-2..R-4
    ├── Memberships (audience · status · primary role · capacity hours)                 core.memberships
    │     ├── Access assignments  (role|perm set × scope × narrowing × dates)  ← AUTHORITY   core.access_assignments
    │     ├── Capacity assignments (client × preparer/reviewer/approver/lead × function)    core.client_assignments
    │     └── Department links (for "my departments" constraints)                         core.membership_departments
    ├── Clients (= legal entity = set of books)                                           core.locations
    │     ├── Client access policy + envelope (+ client roles, if enabled)               core.client_access_policies
    │     ├── Subsidiary edges (%, method, dates)                                        public.entity_ownership
    │     └── Connections (bank, cards, payments, field systems, ERPs)                    07
    ├── Consolidation groups (consolidated | combined)                                   public.consolidation_groups
    └── Effective access (compiled per membership × scope)                               core.effective_access (05 R-11)
```

### 1.3 Merit Management Group mapped (unchanged from v1; illustrative)

| Concept | Merit instance |
|---|---|
| Tenant | **Merit Management Group**, `tenant_type = firm`. |
| Clients | Heritage Interiors, Clive Power Equipment, Heartland Heating & Cooling, Crystal Kitchen & Bath, Dorrian HVAC, Metro Heating & Cooling, Swan Creek, Iowa Custom Cabinets, Revived Interiors, Artistry Homes, AIM, Wild Rose, plus any fund/SPE/property entities Merit keeps books for. |
| Tenant's own books | **Merit Management Group LLC**, `is_tenant_own_books = true`. |
| Subsidiaries | `entity_ownership` edges with parent = Merit Management Group LLC. |
| Consolidation groups | **"Merit Management Group — Consolidated"** (`consolidated`); optionally **"HVAC companies — Combined"** for a lender package. |
| Assignments | Each company may have a different bookkeeper (access: Bookkeeper on that client; capacity: preparer) and a shared reviewer. Bookkeepers see their companies only and no roll-up. |
| Roll-up viewers | Mike (owner), CFO, controller — `all_clients` (implicit group view, Q4) or a group-scoped assignment. |
| *(v2)* Lenders | Northwest / Farmers State / etc. contacts as **lender viewers** scoped to the borrower client or a combined group, seeing delivered certificates and packs only. |
| *(v2)* Cardholders | Field staff at each company as **employees** on that client: snap receipts for their card charges. |

### 1.4 What tenant type changes (defaults only) (v2: rows added)

| Behavior | `firm` | `company` |
|---|---|---|
| Client label | "Clients" | "Companies" |
| Default landing for staff with >1 client | Workspace home | Workspace home (labelled with the company group name) |
| Single-client tenant | n/a | Workspace hidden; users land in the one client; tenant settings move under Settings |
| Client contacts | Expected (external) | Rare |
| Tenant's own books flag | On for the firm's entity | Off unless they mark a parent/HQ entity |
| Default reviewer≠preparer on close sign-off | On | On if ≥2 finance staff, else Off |
| Billing presentation (mig 131) | Firm plan + per-client wholesale | Direct plan, per-company |
| *(v2)* Client-defined roles (05 Q2) | Off; firm enables per client | On |
| *(v2)* Owner template release on money | Off (firm releases) | On |
| *(v2)* Soft→hard SoD defaults (05 S2, S4) | Hard | Soft |
| *(v2)* Employee audience | `client_staff` (inside the client envelope) | `internal_staff` |

### 1.5 Mapping onto existing tables (v2: rows amended per 05)

| Existing | Today | After |
|---|---|---|
| `core.organizations` | tenant; `billing_plan`, `entitlements`, `onboarding_state`, `clerk_org_id` | + `tenant_type`, `lifecycle_status`, close defaults (M-1); + `default_client_access_policy`, `security_policy`, SoD settings (05 R-5/R-7/R-8). |
| `core.locations` | company; `parent_entity_id`, `ownership_pct` (unused by writers), `is_management_company`, `onboarding_status`, `functional_currency` | **The Client.** M-2 fields. Consolidation engine walks `entity_ownership`, not the unwritten column. |
| `public.entity_ownership` | effective-dated parent→child % | Unchanged — legal ownership truth. |
| `core.practice_assignments` | one owner per (org, location, function) keyed to employees | Replaced by `core.client_assignments` (M-5) — **capacity**, not access. |
| `core.memberships` | user↔org↔role, `admin_scope` | Seat record: + `role_definition_id` (primary, display only), `audience`, `access_epoch` (05 R-4); + capacity hours, billing owner (M-3). `role` and `admin_scope` retired (R-14). |
| `core.membership_locations` | write-only mirror | **Compat view over `access_assignments`** for one release (05 R-4), then retired. *(v1 made it authoritative; v2 supersedes.)* |
| `core.employees.role` + `public.employee_locations` | today's real authority | Backfilled into access assignments (R-4); then HR record only. |
| `core.custom_roles` / `role_permission_overrides` (130) | custom roles + cell overrides | Imported as tenant roles (R-2 data step), read-only one release, dropped (R-14). |
| `lib/rbac/permissions.ts` | 9 static roles, 41 features | Seed for platform templates + `legacy-map.ts` shim, then deleted (R-14). |
| `core.users.is_platform_staff` + env allowlist | coarse platform flag | Platform-audience role assignments; env allowlist = break-glass bootstrap only. |
| `core.platform_admin_sessions` | only tenant-reset writes it | Every cross-tenant access opens one, linked to a consent grant (M-9). |
| `public.pbc_requests` (145) | auditor PBC list | Stays; unioned into the one Requests UI (M-7 view). |
| `customers.is_portfolio_company` | flags a customer that is another company | `is_related_client` + `related_location_id` (M-2). |
| `approval_workflow_steps.approver_role` (092) | system role name | `approver_capability` + `min_approver_limit_cents` (05 R-12). |
| localStorage (FP&A grid, bank-feed views) | only layout/view storage | Homes → `dashboard_layouts` (M-8); views → `saved_views` (M-15). |
| `/settings` tabs (receipt chase, rev-rec, sales tax, invoice display, cost routing…) | one tenant-wide page | Split into tenant settings vs client settings (§3.8); receipt-chase policy → M-11. |
| `recurring_templates` + `lib/posting/recurring-engine.ts` | second live recurring-JE engine | Migrated to `recurring_je_*`, engine retired (06 §4; wave 0). |
| `/insurance` own amortization tables | second amortization engine | Amortization through the prepaids schedule engine; insurance keeps the policy register (wave 0). |

### 1.6 Schema changes — numbered migrations (v2)

All additive + idempotent, RLS on, `org_id = get_org_id()` baseline. Ordering is in §10. **05's R-1…R-14 are the
access migrations; they replace parts of v1's M-3/M-4/M-6 as marked.**

**M-1 · Tenant type & lifecycle** (`core.organizations`) — unchanged from v1
- `tenant_type text not null default 'company'` check (`firm`,`company`)
- `lifecycle_status text not null default 'signed_up'` check (`invited`,`signed_up`,`setting_up`,`converting`,`live`,`at_risk`,`suspended`,`churned`)
- `lifecycle_changed_at timestamptz`, `provisioned_by uuid` → `core.users` (null = self-serve)
- `close_due_business_day int default 10`

**M-2 · Client fields** (`core.locations`) — v2: tags added
- rename `is_management_company` → `is_tenant_own_books` (generated alias column one release)
- `client_status text not null default 'active'` check (`onboarding`,`active`,`paused`,`archived`)
- `client_number text` (unique per org when set); `primary_contact_membership_id uuid`; `close_due_business_day int`
- *(v2)* `tags text[] not null default '{}'` and `industry text` — drive client-set rules (05 R-4), compare sets, and
  the Reports "Industries" filter that exists today (06 §3.7)
- *(v2)* `modules_in_use jsonb` — `{jobs, inventory, payroll, debt, rev_rec, retainage, ramp, …}`, set by
  onboarding (08) and by first use; drives progressive disclosure (§3.6.2). Computed fallback when null.
- `customers.is_portfolio_company` → `is_related_client`; + `customers.related_location_id`

**M-3 · Membership seat fields** — **v2 amended** (scope/role/payroll-visibility moved to 05)
- memberships: `weekly_capacity_hours numeric(5,1)`; `is_billing_owner boolean default false`
- new `core.membership_departments`: `id`, `org_id`, `membership_id`, `location_id`, `department_id`, `granted_by`,
  `granted_at` (resolves 05's `my_departments` constraint)
- ~~`client_scope`~~ → assignment `scope_type` (05 R-4) · ~~`payroll_visibility`~~ → role `field_policy.comp` (05 §3.6)
  · ~~`access_expires_at`~~ → assignment `effective_to` · ~~`users.platform_role`~~ → platform-audience roles
- data step: none here (backfill is 05 R-4)

**M-4 · Location-scoped RLS** — **v2 amended**: reads `core.effective_access` (05 R-11), not `membership_locations`
- `public.current_membership_id()`, `public.can_access_location(location_id)` (row for `*` or the location, unexpired, or
  an approved support grant), `public.can_access_group(group_id)`
- every table with `location_id`: `org_id = get_org_id() AND (location_id IS NULL OR can_access_location(location_id))`;
  child tables via parent or denormalized `location_id`; staged (a) GL, bank, bills, invoices, payroll, documents,
  (b) the rest; guard test asserts full coverage (§7)

**M-5 · Capacity assignments** (`core.client_assignments`, replaces `core.practice_assignments`) — unchanged except
that the "must have access" check calls `core.has_capability(membership, location, 'home.client','view')`
- `id`, `org_id`, `location_id`, `membership_id`, `capacity` (`preparer`,`reviewer`,`approver`,`lead`), `function`
  (`all`,`close`,`ap`,`ar`,`payroll`,`onboarding`), `is_primary`, `effective_start`, `effective_end`, `assigned_by`,
  timestamps; unique `(org_id, location_id, capacity, function) where is_primary`; compat view one release

**M-6 · Consolidation groups** — **v2 amended**: grants are access assignments with `scope_type =
'consolidation_group'` (05 §3.9); v1's `core.consolidation_group_grants` table is **dropped from the plan**
- `public.consolidation_groups`: `id`, `org_id`, `name`, `kind` (`consolidated`,`combined`), `consolidator_location_id`,
  `reporting_currency`, `eliminations_enabled`, `status` (`draft`,`active`,`archived`), `created_by`, timestamps
- `public.consolidation_group_members`: `id`, `org_id`, `group_id`, `location_id`, `include_from`, `include_to`,
  `method_override`; unique `(group_id, location_id, include_from)`
- trigger on member add: group-scoped assignments held by anyone lacking `reports.financial:view` on the new member are
  **suspended** (status `suspended`), grantor notified
- seed: one draft `consolidated` group per client that has `entity_ownership` children

**M-7 · Requests & chase engine** — **v2 widened** (G2; one engine for every follow-up)
- `public.client_requests`: `id`, `org_id`, `location_id`, `kind` check (`transaction_question`,`document`,`approval`,
  `information`,**`receipt`**,**`vendor_document`**,**`lender_deliverable`**), `subject_type` (`bank_transaction`,
  `card_transaction`,`bill`,`invoice`,`vendor`,`period`,`loan`,`none`), `subject_id`, `question`, `answer_options jsonb`,
  `asked_by_membership_id`, `assignee_membership_id` (client contact, **employee**, vendor portal contact), `assignee_email`,
  `assignee_phone`, `status` (`open`,`answered`,`accepted`,`closed`,`cancelled`,`escalated`), `blocking_close`, `due_date`,
  `reminder_policy jsonb` (`cadence_days[]`, `escalate_after_count`, `escalate_to_membership_id`, `quiet_hours`,
  `channels[]` email/sms/push, `stop_when` matched/answered), `last_reminded_at`, `reminder_count`, `answer jsonb`,
  `answered_at`, `answered_via` (`app`,`magic_link`,`email_reply`,`sms_reply`,`portal`), `document_id`, `source`
  (`manual`,`rule`,`detector`,`connector`), timestamps
- `public.client_request_tokens`: hashed, expiring, single-request (or single-batch for a cardholder's open receipts),
  rate-limited like 141/142, anon grants revoked
- `public.request_reminders`: `id`, `request_id`, `sent_at`, `channel`, `status`, `provider_message_id` (delivery log)
- view `v_requests_all` = `client_requests` ∪ `pbc_requests` ∪ vendor-compliance chases (normalized)
- the sender runs on the scheduler (M-12 job `requests.remind`); SMS/push need INT-13 (07)

**M-8 · Dashboard layouts** — **v2 amended**: keyed to role definitions
- `public.dashboard_layouts`: `id`, `org_id` (null = platform), `scope` (`platform`,`tenant`,`user`),
  **`role_definition_id`** (replaces `role_key`; platform rows reference templates), `user_id`, `surface` check
  (`workspace_home`,`client_home`,`platform_home`,**`consolidated_home`**,**`portal_home`**), `layout jsonb`,
  `lock_level` (`locked`,`add_move`,`unlocked`), `required_widget_ids text[]`, `version`, `is_current`, `publish_mode`
  (`new_users`,`override`), `published_by`, `published_at`, `note`
- resolution for a role with no layout of its own walks `upstream_template_id` (05 §1.7), so custom roles get a home
- unique current per (scope, org_id, role_definition_id, user_id, surface); RLS as v1

**M-9 · Platform support access** — unchanged from v1 (+ 05 R-13 `capability_scope`)
- `core.support_access_grants` (`target_org_id`, `requested_by`, `reason`, `ticket_ref`, `access_level`, `location_ids`,
  approval/denial/expiry/revocation timestamps); `platform_admin_sessions` + `grant_id`, `actions_count`; tenant-readable view

**M-10 · Capacity & time standards** — unchanged (`performance_config.targets.time_standards`)

**M-11 · Cards, cardholders & receipt policy** *(v2, G2)*
- `public.card_holders`: `id`, `org_id`, `location_id`, `card_account_id` (bank/card account or Ramp card id),
  `last4`, `membership_id` (employee), `effective_from`, `effective_to`, `assigned_by`
- `public.receipt_policies` (one per client, defaults from tenant): `org_id`, `location_id`, `receipt_required_over_cents`
  (thresholds $10/$25/$50/$100), `auto_approve_under_cents`, `chase_cadence_days int[]` (default `{0,2,5,10}`),
  `escalate_after_count` (default 3), `escalate_to` (`card_owner_manager`,`bookkeeper`,`client_contact`),
  `quiet_hours jsonb`, `channels text[]`, `period_end_action` (`accrue_unsupported`,`flag_only`)
- data step: move today's `/settings?tab=chase` values into `receipt_policies`

**M-12 · Scheduled jobs & run log** *(v2, G24; the scheduler itself is INT-01 — mechanism per 07)*
- `core.scheduled_jobs`: `key` (e.g. `bank.daily_pull`, `controls.nightly`, `revrec.monthly`, `requests.remind`,
  `reports.packs`, `connectors.sync:<id>`, `access.expiry_sweep`), `org_id`, `location_id` (null = all), `cron`,
  `enabled`, `owner_capability`
- `core.job_runs`: `id`, `job_key`, `org_id`, `location_id`, `started_at`, `finished_at`, `status`
  (`ok`,`partial`,`failed`,`skipped`), `items_processed`, `error`, `actor` (`system:scheduler`)
- every widget whose done state depends on a job reads its last `job_runs` row ("Detectors ran 02:10 today")

**M-13 · Notifications, channels & watch rules** *(v2, G15)*
- `core.notification_preferences`: `membership_id`, `channel` (`email`,`sms`,`push`,`slack`,`teams`), `address`,
  `verified_at`, `quiet_hours`, `digest` (`instant`,`daily`,`weekly`)
- `public.watch_rules`: `id`, `org_id`, `owner_membership_id`, `location_id` or `group_id`, `metric` (from the FP&A
  allowlisted metric catalog), `operator`, `threshold`, `compare_to` (`value`,`next_payroll`,`budget`,`prior_period`),
  `channels[]`, `status`, `last_fired_at`; `public.watch_rule_events` (fired log)

**M-14 · Lender reporting, deliveries & external shares** *(v2, G4/G17)*
- `public.lender_obligations`: `id`, `org_id`, `location_id` or `group_id`, `loan_id`, `lender_name`, `kind`
  (`compliance_certificate`,`borrowing_base_certificate`,`financial_statements`,`budget`,`other`), `frequency`,
  `due_offset_days`, `recipients jsonb`, `requires_approval boolean default true`, `last_delivered_at`, `next_due_at`
- `public.report_deliveries`: `id`, `org_id`, `source_type` (`pack`,`board_package`,`certificate`,`bbc`,`client_packet`),
  `source_id`, `recipient`, `channel`, `approved_by`, `sent_at`, `status`, `document_id`
- `public.external_shares`: `id`, `org_id`, `audience` (`lender`,`investor`,`client_contact`), `membership_id` (if
  signed in), `token_hash`, `delivery_ids uuid[]`, `expires_at`, `revoked_at`, `last_viewed_at` — what a lender viewer
  can see is exactly the delivered artifacts listed here

**M-15 · Server-side saved views** *(v2; 06 pattern 7)*
- `public.saved_views`: `id`, `org_id`, `owner_membership_id`, `surface` (`bank_feed`,`report`,`compare`,`queue:<id>`),
  `location_id` (null = cross-client), `name`, `config jsonb`, `shared_with` (`me`,`role:<id>`,`tenant`), timestamps
- data step: import browser-stored bank-feed views on first load; report saved views (mig 138) stay where they are and
  are listed through the same picker

---

## 2. Roles & access (v2) — summary; `05-RBAC-SPEC.md` is the authority

v1's role catalog, scope axis and delegation table are **superseded by 05**. This section keeps only what the IA needs:
how access shapes contexts and homes, the standard templates (with the two new roles), client-defined roles, and the
amendments the IA asks 05 to absorb.

### 2.1 How access works (v2)

- **Capabilities, not roles, gate everything.** Every nav item, tab, button, widget and API route declares a
  capability (`resource:action`, 05 §2.2). The user's compiled snapshot (`/api/access/me?client=`) decides what renders;
  anything they can't use is **hidden, not disabled** (05 §5.3). The two exceptions: an over-limit action shows "Approve
  up to your limit → route", and a step-up obligation shows a lock glyph.
- **Roles are data at three levels** (05 §1.2): platform templates (Mike authors) → tenant roles (`standard` clones or
  `custom`) → client roles (only where the tenant enabled them, inside the client envelope). Changes are versioned;
  template updates never apply silently (05 §1.7).
- **Assignment = membership × scope × role/permission set.** Scopes: `all_clients`, `client`, `client_set`,
  `consolidation_group`, `tenant`. Stacking is a union; mutes and read-only narrow only their own assignment. One person
  can be Bookkeeper on Clive and Reviewer on Swan Creek.
- **Capacity is separate** (M-5): preparer / reviewer / approver / lead drive the close grid, queues, "My clients" and
  transaction SoD; they never grant access.
- **The IA's three questions resolve as:** *Which books?* → clients with `home.client:view` in the snapshot. *Which
  roll-ups?* → groups with `consol.statements:view` (05 §3.9 validity rule). *Which home?* → the layout for the
  membership's primary role definition (M-8), falling back up its template lineage.
- **The tenant's own books are just a client.** No special capability; `canSeeMeritManagement()` is deleted.
- **Guardrails (05 §4)** the IA must show, not just enforce: SoD warnings in the assignment dialog, the delegation
  ceiling (a manager only sees roles/clients they may grant), external-audience ceilings, the immutable access log.

### 2.2 Standard role templates (v2) — what each one gets in the IA

Policy details (MFA, field masking, limits) are in 05 §7. "Contexts" = which shell contexts the role can enter by
default. Visual direction: **B** = Operator Cockpit (dense, queue-first), **A** = Annual Report (decision/performance).

| Template (key) — UI label | Audience · default scope | Contexts | Default home (surface · primary module) | Dir. |
|---|---|---|---|---|
| Platform admin (`platform_admin`) | platform | Platform; tenant data only via support grant | platform_home · `pf.funnel` + `pf.tenant_health` | B |
| Platform support (`platform_support`) | platform | Platform; support sessions | platform_home · `pf.support` | B |
| Tenant admin (`tenant_admin`) | internal · all clients | Workspace, Client (view), Settings | workspace_home · `ta.access` | B |
| Owner (`owner`) | internal · all (company) / assigned (firm-client owner) | Workspace, Client, Consolidated (if granted) | workspace or client home · `ow.decisions` + `ow.glance` | A |
| CFO (`cfo`) | internal · all clients | Workspace, Client, Consolidated | workspace_home · `cfo.kpis` + `cfo.release` | A |
| Controller (`controller`) | internal · all (or assigned) | Workspace, Client, Consolidated | workspace_home · `ctl.close_through` | B |
| Finance director (`finance_director`) | internal · assigned | Workspace, Client, Consolidated (if granted) | workspace_home · `fd.bva` | A |
| Accounting manager (`accounting_manager`) — firm label "Practice manager" | internal · assigned or all | Workspace, Client | workspace_home · `am.close_grid` | B |
| **Bookkeeper** (`bookkeeper`) — PRIMARY | internal · assigned | Workspace, Client | workspace_home · `bk.my_clients`; client_home · books-review loop | B |
| AP clerk (`ap_clerk`) | internal · assigned | Workspace, Client | workspace_home · `ap.intake` | B |
| AR clerk (`ar_clerk`) | internal · assigned | Workspace, Client | workspace_home · `ar.collections` | B |
| **Check processor** (`payments_clerk`) | internal · assigned | Client (Pay runs only) + Workspace queue | workspace_home · `pc.queue` | B |
| Data entry (`data_entry`) | internal · assigned | Client | client_home · `de.drafts` | B |
| HR / payroll (`hr_payroll`) | internal · assigned or all | Workspace, Client (Payroll) | workspace_home · `hr.upcoming` | B |
| Department head / operations leader (`department_head`) | internal · assigned + my departments (edit_only) | Client | client_home · `dh.approvals` + `dh.bva` | A |
| **Employee / cardholder** (`employee`) — *new* | internal (company) / client_staff (firm) · one client, ownership `own` | Employee surface only (no books nav) | client_home (employee layout) · `em.my_receipts` | B, mobile-first |
| External auditor (`external_auditor`) | external · assigned, ≤120 days | Client (read-only), Requests | client_home · `au.pbc` | A |
| **Lender viewer** (`lender_viewer`) — *new* | external · client or consolidation group, ≤365 days | Lender portal only | portal_home · `lv.deliverables` | A |
| View-only (`view_only`) | internal · assigned | Client (read-only) | client_home · owner layout minus decisions | A |
| Client admin (`client_admin`) | client_staff · one client | Client (within envelope), Client · Team & roles | client_home · `ow.decisions` + `ca.team` | A |
| Client contact (`client_contact`) | external · one client | Requests only | portal_home · `cc.requests` | mobile |

**AP clerk / AR clerk** are also expressible as Bookkeeper + capacity `function = ap|ar` — firms choose. Legacy keys map
per 05 §7 backfill (`company_admin` → Tenant admin + "Legacy full books"; `merit_controller` → Controller;
`accounting_specialist` → Bookkeeper; `check_processor` → Check processor; `business_user` → Owner (assigned); etc.).

**New template grants (05 vocabulary; 05 §7 must add these rows — amendment A-1):**

| Template | Grants | Ceiling / policy |
|---|---|---|
| `employee` | `exp.receipts` V C E D (ownership `own`) · `exp.reports` V C E (own) · `cards.transactions` V (own cards via M-11) · `req.client_requests` V E (assigned to me) · `docs.documents` C (own) · `home.client` V (employee layout only) | No ledger, money, configure or cross-client capability (audience ceiling). Comp/TIN/bank `hidden`. Magic-link answering allowed without a login; login optional for the mobile app. |
| `lender_viewer` | `reports.packs` V X · `debt.certificates` V X · `debt.borrowing_base` V X · `reports.board_package` V X — **all with constraint `delivered_to_me`** (amendment A-2) · `req.client_requests` V E (lender_deliverable kind, assigned to me) | `external` audience (05 H3): never live ledger, never post/release/configure; `max_assignment_days` 365; masked TIN/bank; MFA via magic link + email OTP. |

### 2.3 Client-defined roles (v2)

- A tenant enables client roles per client (05 §1.6; default **off** for firm tenants, **on** for company tenants —
  Q6). The client admin then sees **[Client] · Team & roles** under Client settings (05 A5): client roles + the tenant
  roles the firm made assignable to client staff, a builder showing only envelope capabilities, and "Pending approval
  by [firm]" for grants touching approve / release / post / configure.
- Typical client roles: "Office manager — approves bills ≤ $2,500", "Field supervisor — approves crew expenses",
  "Owner's assistant — answers requests". Each gets a home by choosing a home template in the builder (amendment A-4).
- Client-staff people appear in the firm's Team list with a client chip and are never assignable to another client.

### 2.4 Delegation (v2)

Replaced by 05 §4.2's ceiling rule: a grantor can grant only what they hold, on clients they can access, with limits,
dimensions, field levels and dates no wider than their own; high-risk grants need a second approver; nobody
administers themselves (H1); the tenant admin is the root of trust. v1's §2.6 table is an example of the rule, not a
separate policy. In the UI, the assignment dialog lists only roles, clients and limits the grantor may hand out.

### 2.5 Rename map (unchanged in substance; executed by 05 R-2/R-4)

| Old key (`permissions.ts`) | New template | Notes |
|---|---|---|
| `company_admin` | `tenant_admin` (+ "Legacy full books" set, flagged for first access review) | |
| `cfo` | `cfo` | |
| `merit_controller` | `controller` (+ "Legacy controller release" set) | tenant-specific name removed |
| `assistant_cfo` | `finance_director` on "All clients except own books" set | |
| `accounting_manager` | `accounting_manager` | bounded delegation now real |
| `accounting_specialist` | `bookkeeper` | |
| `check_processor` | `payments_clerk` (label **Check processor**) | per-route money keys (task #56) become `pay.batches` C/E/A/R |
| `general_admin` | `data_entry` | |
| `business_user` | `owner` (assigned) | `/business/*` pages dropped |
| — | `hr_payroll`, `department_head`, `external_auditor`, `view_only`, `client_contact`, `client_admin`, `ap_clerk`, `ar_clerk`, **`employee`**, **`lender_viewer`** | new templates |
| `CompanyScope` `all` / `portcos_and_3rdparty` / `assigned` / `own_company` | assignment scopes `all_clients` / client set "All clients except own books" / `client` | |
| `canSeeMeritManagement()` | `authorize(…, 'home.client', 'view', { locationId })` | |

### 2.6 Amendments this IA asks 05 to absorb

| # | Amendment | Why |
|---|---|---|
| A-1 | Add `employee` and `lender_viewer` templates (§2.2) to 05 §7.1–7.3. | G2, G4, G20 |
| A-2 | New constraints: `delivered_to_me` (rows whose `external_shares.delivery_ids` include the item) and `assigned_to_me` (requests). | Lender viewer; employees and client contacts answer only their own requests |
| A-3 | New resources: `cards.cardholders` (V E K — map cards to employees, M-11), `exp.chase_policy` (V K — receipt policy), `alerts.watch_rules` (V C E D — M-13; personal rules need only `create` on own), `debt.lender_obligations` (V C E K — M-14), `int.mappings` (V E — connector mapping queue, 07), `home.platform` (V), `home.portal` (V). | Widgets and settings with no capability today |
| A-4 | `role_definitions` gains `home_template_id` (which standard role's dashboard layouts this role uses; defaults to `upstream_template_id`). | Custom and client roles need a home (M-8) |
| A-5 | Widget, nav and ⌘K registries are capability consumers under 05's guard test ("every page/route/widget/nav item declares a capability"). | 05 §2.2, closes C6/C7 |
| A-6 | `ws.compare` is **not** a capability: compare sets check `reports.financial:view` per column client. | §3.11 |

---

## 3. Navigation (v2)

### 3.1 Contexts and how the shell shows them (v2: view-as, portals, compare mode)

The navy shell (sidebar + top bar) stays. Context is shown by **one context chip** at the left of the top bar; special
contexts add a **4px band** under the top bar plus a chip tag. All colours from tokens.

| Context | Chip shows | Band | Nav tree |
|---|---|---|---|
| **Platform console** | "MeritBooks Platform" | none | §3.4 |
| **Tenant workspace** | Tenant name + "Workspace" | none | §3.5 — no posting happens here |
| **Client books** | Client name, number, period status dot ("Heritage Interiors · Sep open") | none | §3.6 |
| **Tenant's own books** | Client name + **"Own books"** tag | **amber** | §3.6 + own-books items (§3.6.4) |
| **Consolidated view** | Group name + "Consolidated · 9 clients · eliminations on" | **steel**, layered icon | §3.6.5 — read-only, processing hidden |
| **Support session** (overlay) | "Support session · MeritBooks · read-only · 42 min left · End" | **red** | target context, capped by the grant |
| **View-as** (overlay, 05 §5.6) | "Viewing as Dana Ruiz · read-only · End" | **violet** | the intersection of both people's access |
| **Employee surface** | "Clive Power Equipment · My receipts" | none | §3.6.6 — no books nav |
| **Portals** (outside the app shell) | client contact `/portal/client`, lender `/portal/lender`, customer, vendor | n/a | single-purpose pages |

**Compare mode is not a context.** It is a report mode available in the workspace (Insights · Compare clients) and in
Reports when more than one client is selected (§3.11).

Rules: processing pages require a client context (`CompanyScopeGuard` stays as "requires client context"; the `'all'`
sentinel is retired — "all" is the workspace, which has no processing pages). **(v2)** Arriving with `?client=<id>`
on any client route switches context after a server access check — this fixes 06 §5 #11 (links that land on the
picker). Paths stay flat; a client segment in the path (`/c/[id]/…`) is deliberately not adopted now (119-page churn
for no access benefit — the server validates context on every request either way).

### 3.2 Where each role lands (`/` front door) (v2)

| Who | Lands on |
|---|---|
| Platform staff with no tenant membership | `/platform` |
| Membership with **no active assignments** (05 §4.4) | "Waiting for access" screen: who invited you, **Request access** |
| Member with exactly 1 accessible client | that client's home (role layout) |
| Member with >1 accessible client | workspace home (role layout) |
| Employee / cardholder | My receipts (employee layout); from an SMS/email link, straight to that charge |
| Client contact | their Requests ("Nothing needed from you" when clear) |
| Lender viewer | Lender portal: deliverables list |
| First-run tenant | onboarding v2 (`08-ONBOARDING-V2-SPEC`; FPB-onboarding principle 1) |

### 3.3 Context switcher (unchanged from v1, plus compare entry)

- Trigger: the context chip, or `⌘J` (⌘K stays the command bar; `/` opens search — fixes the ⌘K double-binding, 06 §5 #3).
- 480px popover: search (name / number / short code / tag) → **Pinned · My clients** (status dot = close status, open-item
  count) · **All clients** (all-clients holders) · **Consolidated** (groups held) · **Workspace** · **Platform**
  (platform staff) · *(v2)* **Compare…** (opens Insights · Compare with the selection).
- ↑↓ Enter; `Esc` closes; last 5 recents float up. Switching keeps the page type when the target supports it.
- The server validates the context on every request (cookie and `?client=` are hints, never authority — §7 R8).

### 3.4 (a) Platform console nav (v2)

| Group | Items | Capability |
|---|---|---|
| Home | Home | `home.platform:view` |
| Tenants | All tenants (lifecycle tabs) · Onboarding funnel · Provision tenant · *tenant detail tabs:* Overview · Plan & entitlements · Modules · Branding · Support log · Data (export / reset) · **Sandbox** | `platform.tenants`, `platform.entitlements` |
| Revenue | Plans & billing · Billing exceptions · **Processor fee revenue** (today's `FeeRevenueReport`, 06 §3.12) | `platform.billing:view` |
| Health | **Integrations & connectors** (07) · **Scheduler & jobs** (M-12) · AI gateway & spend · **AI evals** · Errors & deploys | `platform.health:view` |
| Support | Access requests · Active sessions · Access log · Break-glass (incident only) | `platform.support`, `platform.break_glass` |
| Defaults | **Role & permission-set templates** · **SoD rules** · **Client envelopes** · Dashboard templates · COA templates · **Connector catalog** (07) · **Import templates & mappings** (08) · Help content | `platform.templates` |
| Admin | Platform team | `platform.templates:configure` |

### 3.5 (b) Tenant workspace nav (v2)

| Group | Items (path) | Default visible to (templates) |
|---|---|---|
| Home | Home `/dashboard` · Inbox `/inbox` | all multi-client internal members |
| Clients | Client registry `/clients` · Add clients `/clients/new` (one or many — the 08 wizard) · Onboarding tracker `/clients/onboarding` | TA, AM, CFO, CTL (registry: anyone with >1 client, filtered) |
| Work | Close grid `/work/close` · Review queue `/work/review` · Requests & chases `/requests` · Exceptions `/exceptions` · Agents & gates `/agents` · Practice tasks `/work/tasks` (ADM-22; close checklists today, client task templates later) | AM, CTL, BK, AP/AR clerk (filtered to own clients) |
| Team | Staff & capacity `/team` · Capacity assignments `/team/assignments` · Access `/team/access` (→ person page 05 A3) · Access requests `/team/access/requests` · Access reviews `/team/access/reviews` (05 A8) | TA, AM (delegation-bounded) |
| Consolidations | Groups `/consolidations` · *(each group the user holds)* | group holders only — absent otherwise |
| Insights | Books health `/insights/books-health` · Cash across clients `/insights/cash` · Compare clients `/insights/compare` · Profitability by client `/insights/profitability` · Team performance `/insights/team` · Client economics `/insights/economics` (firm tenants) | AM, CFO, CTL, OW, FD (cash/profitability per §3.11 rules) |
| Integrations | Integrations hub `/integrations` (07): connected systems, sync health, mapping queue, catalog | TA, AM; BK sees health + mapping queue |
| Settings | Tenant settings `/settings` (§3.8) | per capability |

Workspace widgets and lists only ever include clients in the user's snapshot (§7 R2/R12).

### 3.6 (c) Client books nav (v2) — every LIVE/PARTIAL capability in 04 has a home

#### 3.6.1 The tree

Disclosure: **C** = core (shown whenever permitted) · **A** = activated (shown when the client uses the module —
§3.6.2) · **M** = in the group's "More" fold. Tabs use the existing `?tab=` pattern. Capability = the view gate (05).

| Group | Item → path | Tabs / lanes | View capability | 04 IDs | Disc. |
|---|---|---|---|---|---|
| **Home** | Client home → `/dashboard` | books-review loop: Review · Reconcile · Check · Close | `home.client` | CLS-12, CLS-11 | C |
| | Inbox → `/inbox` *(v2: inside the client too, 06 §3.1)* | Approvals · Exceptions · Alerts · Drafts | `home.client` | CTRL-03 | C |
| | To review → `/review` | lanes **Bank · Cards · Receipts · Draft bills · Deposits to apply · From connected systems · Flagged** | `bank.transactions` (lane-level caps) | BNK-02..07, EXP-02, AP-02/03, AR-11, INT-11 | C |
| | Requests → `/requests` | Open · Waiting on client · Receipts chase · Vendor documents · PBC · Closed | `req.client_requests` | PRT-01/02, EXP-05, VND-04, CTRL-13 | C |
| | Close → `/close` | Tasks · **Periods** (read-only grid + reopen) · Year-end · Package | `close.checklist` | CLS-01..10, GL-11, CLS-05 | C |
| **Banking** | Bank & card transactions → `/bank-feed` | Bank · Cards (register incl. approved history; review happens in To review) | `bank.transactions` | BNK-01..07, BNK-10 | C |
| | Reconciliation → `/reconciliation` | Autopilot · Workspace · Statement import · AR↔GL tie-out · History (tabs into the URL) | `bank.reconciliations` | REC-01..09 | C |
| | Transfers → `/transfers` | — | `bank.transfers` | BNK-12 (PLANNED) | A (when built) |
| **Payables** | Bills → `/bills` | All · Draft bills (intake) · Retainage payable · Vendor credits | `ap.bills` | AP-01..05, AP-10, AP-16 | C |
| | Purchase orders → `/purchase-orders` | POs · Receipts · 3-way match exceptions | `ap.purchase_orders` | AP-11, AP-12 | A (POs used) |
| | Pay runs & checks → `/pay-runs` *(renamed from `/checks`)* | **Queue · Print · Positive pay · ACH files · History · Remittances** | `pay.batches` | PAY-01..12 | C |
| | Expenses & receipts → `/expenses` | **Receipts · Missing receipts · Expense reports · Approvals · Reimbursements · Policy** | `exp.receipts` / `exp.reports` | EXP-01..12 | C |
| | Payroll → `/payroll` | Runs · Register import · Employees · Remittances · Settings | `payroll.register` | PRL-01..10 | A (payroll used) |
| | Vendors → `/vendors` | Directory · 360 (drawer) · Duplicates | `mdm.vendors` | VND-01, AP-08, PAY-10 | C |
| | Vendor compliance → `/vendor-compliance` | Compliance (W-9/COI, holds, overrides) · Portal uploads · 1099 readiness | `ctl.vendor_compliance` | VND-02..07, AP-16 | C |
| **Receivables** | Invoices → `/invoices` | Invoices · Recurring · Credit memos · Progress billing (AIA, when built) | `ar.invoices` | AR-01..05, AR-08, AR-14, AR-18 | C |
| | Estimates → `/estimates` | — | `ar.estimates` | AR-06 | A |
| | Customer deposits → `/customer-deposits` | Held · Applied · Refunded | `ar.deposits` | AR-07 | A |
| | Collections → `/collections` | Worklist (aging) · Risk & cadence · Promises (one dunning path: draft → approve → send) | `ar.collections` | AR-12, AR-13, AR-16 | C |
| | Cash application → `/cash-application` *(un-stubbed: one home for unapplied cash, 06 §3.2–3.3)* | Unapplied payments · Deposits to match · Applied history | `pay.customer_payments` | AR-11 | C |
| | Customers → `/customers` | Directory · Statements · Merge · Risk dossier | `mdm.customers` | AR-15, AR-17, AR-19 | C |
| **Revenue & jobs** | Revenue recognition → `/rev-rec` | Run · Accrue unbilled · Deferred roll-forward · Waterfall · By method (`?tab=`) | `revrec.runs` | REV-01..09 | A (rev-rec policy ≠ as-billed) |
| | Jobs → `/jobs` (+ `/jobs/[id]`) | Active · Closed · Change orders | `jobs.jobs` | REV-10, REV-11, REV-13 | A (jobs used) |
| | WIP → `/jobs/wip` | Over/under billing · EAC & fade | `jobs.wip` | REV-12, REV-13 | A |
| | Retainage → `/retainage` | Receivable · Payable · Due for release | `ar.invoices` / `pay.batches` | REV-14, REV-17 | A |
| | Inventory → `/inventory` (+ `[id]`, `/inventory/valuation`) | Items · Movements · Valuation & tie-out · Reorder | `inv.items` | INV-01..03 | A |
| **Cash & debt** | Cash position & forecast → `/cash` | Position · 13-week forecast (one engine) · Scenarios | `cash.position` | CASH-01..07, CASH-10 | C |
| | Renewals & obligations → `/obligations` | Calendar · By type | `cash.obligations` | CASH-08 | C |
| | Subscriptions → `/subscriptions` | Overview · Price creep · Renewals · Triage · All | `cash.obligations` | CASH-09 | M |
| | Debt & covenants → `/debt` | **Register · Covenants · Borrowing base · Lender reporting** | `debt.loans` | DEBT-01..13 | A (loans exist) |
| **Accounting** | Journal entries → `/journal-entries` | Entries · Recurring | `gl.journal_entries` | GL-06..10 | C |
| | Chart of accounts → `/chart-of-accounts` | Grouped · List · Pending approval | `gl.accounts` | GL-02..05 | C |
| | Assets & schedules → `/assets` (hub tabs only) | **Fixed assets · Leases · Prepaids & insurance · Intangibles · Tax depreciation · Schedules run** | `fa.assets` | FA-01..10, GL-09 | C |
| | Intercompany → `/intercompany` *(un-stubbed)* | Due to / due from · Internal invoices · Pair balances · Loans (planned) | `gl.intercompany` | CON-04..06, DEBT-10 | A (counterparties exist) |
| | Equity → `/equity` | Equity schedule · Cap table (holders, classes, contributions, distributions) | `gl.journal_entries` (view) | FA-11 | M |
| | Tax → `/tax` (hub tabs only) | **Sales tax · 1099 · Book-to-tax · Provision · Return package · Filing calendar** | `tax.sales_tax` / `tax.1099` / `tax.provision` | TAX-01..12 | C |
| | Documents → `/documents` | All · Unfiled · By record | `docs.documents` | CTRL-14 | C |
| **Planning & reports** | Reports → `/reports` | catalog · saved views · compare columns | `reports.financial` | RPT-01..07, RPT-09..11 | C |
| | Board & lender packs → `/packs` | Board package · Lender packs · Client packets · Scheduled · Delivery log | `reports.packs` | FPA-14, RPT-08, RPT-13, DEBT-09, CON-10 | C |
| | Budgets → `/budgets` | **Plan · Drivers · Reforecast · Cycle · Budget vs actual** (one tab row) | `fpa.budgets` | FPA-01..04, FPA-06, FPA-07 | C |
| | FP&A & scenarios → `/fpna` | KPI grid · What-if & sensitivity · NL scenarios | `fpa.scenarios` | FPA-05, FPA-08, FPA-10, FPA-13 | C |
| | Profitability → `/profitability` | By department · job · customer · class | `fpa.profitability` | FPA-12, DIM-06 | M |
| | Basis adjustments → `/reports/basis-adjustments` | — | `gl.reporting_basis` | GL-14 | M |
| **Controls** | Exceptions → `/exceptions` *(un-stubbed)* | Open · By detector · Accepted · Resolved | `ctl.exceptions` | CTRL-01, CTRL-02, GL-18 | C |
| | Approvals → `/approvals` | Waiting on me · In flight (chain status) · History | `ctl.approval_workflows:view` | AP-06, GL-08, CTRL-04 | C |
| | Compliance & SOX → `/compliance` | Filings · Controls · SoD posture · Evidence | `ctl.compliance` | CTRL-05, CTRL-06, TAX-10 | C |
| | Audit trail → `/audit` | Human · AI · System; record timeline | `ctl.audit_trail` | CTRL-07, GL-17 | C |
| | AI decision log → `/ai-decisions` (read-only) | Proposals · Dispositions · Overrides | `ctl.ai_decisions` | CTRL-08, AI-15 | C |
| | Agents → `/agents` | Runs · Waiting on a person · Recipes | `ai.agents` | AI-07, CLS-06, AR-13, PAY-02 | M |
| | Audit requests (PBC) → `/requests?tab=pbc` | — | `ctl.pbc` | CTRL-13 | A (auditor engaged) |
| **Client settings** (gear at the foot of the nav) | `/client-settings/<area>` | §3.8.2 | per area | ONB-04/06/07, AR-02, AR-10, EXP-06/07, REV-02, TAX-01, AP-03, DIM-02..04, GL-02 | C |

Not in the nav but everywhere: ⌘K command bar (AI-04..06), search palette `/` (RPT-11), notifications bell, help,
ExplainPanel / hover peek / AttachmentsPanel on records (RPT-14, CTRL-14).

#### 3.6.2 Progressive disclosure (v2)

1. **Permission first.** An item the snapshot can't view is never rendered; a group with no visible items disappears.
2. **Activation.** Items marked **A** appear when `core.locations.modules_in_use` says the client uses the module
   (set by onboarding 08, or flipped by first use — e.g. the first loan creates `debt`). A client-settings toggle
   ("Modules this client uses") lets a manager show or hide them. Activated items never hide while they hold open work.
3. **"More" fold.** Items marked **M** sit behind "More" at the bottom of their group, with a count badge if they hold
   open work (e.g. 3 subscriptions to triage) — then they auto-promote above the fold.
4. **Pins.** Any user can pin up to 8 items to a "Pinned" group at the top; pins are per user, per tenant.
5. **Order is stable.** Disclosure never reorders groups; hidden items leave no gaps.
6. **Typical result:** a services client with no jobs, inventory, debt or payroll shows ~32 items; a construction client
   with everything active shows ~48 (about 8 of them behind "More" folds); no group exceeds 8 visible items.

#### 3.6.3 Role-filtered default nav (what each template sees inside a client)

Derived from 05 §7 grants; listed so designers can draw each role's sidebar. ● all items · ◐ some items · — none.

| Template | Home | Banking | Payables | Receivables | Rev & jobs | Cash & debt | Accounting | Planning | Controls | Client settings |
|---|---|---|---|---|---|---|---|---|---|---|
| Owner | ◐ home, inbox, requests | ◐ view | ◐ bills, pay runs (approve), expenses | ◐ view | ◐ view | ● | ◐ view | ● | ◐ approvals, audit | ◐ profile, contacts |
| CFO / Controller | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Finance director | ● | ◐ view | ◐ approve | ◐ approve | ◐ view | ● | ◐ view | ● | ◐ | — |
| Accounting manager | ● | ● | ● | ● | ● | ◐ | ● | ◐ | ● | ◐ |
| **Bookkeeper** | ● | ● | ● (pay runs view) | ● | ◐ (rev rec view) | ◐ view | ● (tax: sales tax, 1099) | ◐ reports, packs | ◐ exceptions, audit | ◐ connections, inboxes, cards, import |
| AP clerk | ◐ | — | ● (no payroll) | — | ◐ retainage | — | ◐ documents | ◐ AP reports | ◐ exceptions | — |
| AR clerk | ◐ | ◐ cash application | — | ● | ◐ retainage | — | ◐ documents | ◐ AR reports | ◐ | — |
| Check processor | ◐ inbox | — | ◐ **pay runs** (+ vendors view) | — | — | — | — | — | — | — |
| Data entry | ◐ review, requests | — | ◐ bills, receipts, vendors | ◐ customers | — | — | ◐ documents | — | — | — |
| HR / payroll | ◐ inbox, requests | — | ◐ **payroll** | — | — | ◐ cash view | — | ◐ payroll reports | — | ◐ payroll settings |
| Department head | ◐ home, inbox | — | ◐ approvals (bills, POs, expenses) | — | ◐ jobs (dept) | — | ◐ intercompany (internal invoices to approve) | ◐ budgets, reports (filtered) | ◐ approvals | — |
| External auditor | ◐ requests | ● view | ● view | ● view | ● view | ● view | ● view | ◐ reports | ◐ audit, PBC, AI log | — |
| Client admin | ◐ | ◐ view | ◐ (envelope) | ◐ (envelope) | — | ◐ view | ◐ documents | ◐ reports | — | ◐ team & roles |

#### 3.6.4 Tenant's own books — extra items (v2, G26)

In the amber own-books context only, and only for clients flagged `is_tenant_own_books`:
- **Receivables → Client billing** (`/invoices?tab=client-billing`): recurring management-fee and service invoices to
  related clients, built on internal/intercompany invoices (AR-20), eliminated in consolidation. **Not** the retired
  chargeback/overhead engine.
- **Accounting → Intercompany → Loans** (DEBT-10, planned): requests, approvals, promissory note documents, interest on
  both sides.
- **Insights link → Client economics** (ADM-23): effort per client (activity × time standards) vs fee.

#### 3.6.5 Consolidated context nav (v2, G23)

Read-only; requires `consol.statements:view` on the group (05 §3.9). Path `/consolidations/[groupId]?tab=`.

| Item | Contents | 04 IDs |
|---|---|---|
| Group home | `consolidated_home` layout (`cfo.consolidated`, group cash, covenants, close) | — |
| Statements | P&L, BS, CF, TB with ownership %, NCI, FX (ASC 830); member drill | CON-01, CON-03, CON-08 |
| Eliminations | explicit lines with drill to both sides; top-side adjustments (planned, `consol.eliminations:post`) | CON-02, CON-09 |
| Intercompany pairs | EC-3 pair balances, unmatched items | CON-04 |
| Cash across group | position + 13-week forecast by member and total | CASH-01, CASH-11 |
| Budget vs actual & FP&A | group BvA, scenarios (read-only) | FPA-15 |
| Covenants | covenants measured on the group borrower | DEBT-12 |
| Board & lender packs | group packs and delivery log | CON-10, DEBT-09 |
| Group close | members' close status; group closes only when every member has | CLS-09 |
| Group setup | members, methods, FX rates, ownership tree (needs `consol.groups:configure`) | CON-07 |

#### 3.6.6 Employee surface and portals (v2)

- **Employee surface** (signed-in `employee`): My receipts (card charges needing a receipt, camera attach) · My
  expenses (draft / submitted / reimbursed; mileage & per diem) · My requests. No books nav. 390px-first; installable
  PWA (EXP-03). Deep links from chase SMS/email open one charge.
- **Client-contact portal** `/portal/client/[token]` (or signed in): requests, documents, approvals if delegated, the
  client packet if the firm enables it (PRT-03).
- **Lender portal** `/portal/lender/[token]` (or signed in as `lender_viewer`): deliverables, due calendar, covenant
  status as of the last delivered certificate. Nothing live from the ledger.
- **Customer** `/portal/customer/[token]` and **vendor** `/portal/vendor/[token]` portals and **`/pay/[token]`**: unchanged.

### 3.7 Rename map — every "portfolio" occurrence (unchanged from v1)

| Today | Becomes | Note |
|---|---|---|
| page `/portfolio` ("Entities") | `/clients` — Client registry | redirect one release |
| page `/portfolio/[locationId]` | `/clients/[clientId]` — Client profile | |
| page `/onboarding/portfolio` ("Many Companies") | `/clients/new?mode=bulk` (08 wizard) | v2: was `/onboarding/clients` in v1 |
| `control-tower.tsx` / "Control Tower" | Onboarding tracker `/clients/onboarding` | |
| API `/api/portfolio`, `/assignments`, `/entity`, `/onboarding` | `/api/clients`, `/api/clients/assignments`, `/api/clients/[id]`, `/api/clients/onboarding` | + `authorize()` + scope filter (R2) |
| API `/api/onboarding/portfolio/{periods,tower,tb,companies}` | `/api/onboarding/clients/{periods,tracker,tb,bulk}` (or as 08 defines) | |
| nav "Entities" / "Many Companies" / group "Team & Oversight" / plane "Practice" | "Clients" / "Add clients" / workspace groups / (plane switcher removed) | |
| `help-content.ts` :39, :861–873; profitability copy ("Portfolio rank"); `/operations` copy | "clients", "consolidation group", "Rank among your clients" | |
| `customers.is_portfolio_company` · scope `portcos_and_3rdparty` · `lib/portfolio/*` · `lib/companies/portfolio/*` · `canSeeMeritManagement()` · `merit_controller` | `is_related_client` · client set · `lib/clients/*` · `lib/clients/bulk/*` · `authorize()` · `controller` | |
| UI word "Entities" (where it means books) | "Clients" / "Companies" by tenant type | "Legal entity" stays on the profile's legal tab |

### 3.8 Settings IA (v2) — every settings area has one home

#### 3.8.1 Tenant settings (`/settings/<area>`, workspace gear)

| # | Area | Contents | From today | Capability |
|---|---|---|---|---|
| 1 | Organization | name, tenant type, fiscal defaults, white-label brand (logo, colours, domain) | Settings · Organization | `core.tenant.settings` |
| 2 | Security | MFA for all staff, step-up minutes, session/idle limits, IP allowlists | new (05 R-7) | `core.tenant.settings` |
| 3 | Access & roles | Role library · Permission sets · Envelopes · Templates & updates · SoD policy · Access log · Export matrix (05 A1/A2/A6/A9/A10) | `/settings/roles`, `/settings/permissions` | `core.access.roles` |
| 4 | Approval workflows | Configure · Visualize · Simulate · Coverage gaps | `/settings/approvals` | `ctl.approval_workflows:configure` |
| 5 | Policies | AP and expense policy compilers in one surface (doc-type switch), tenant defaults | `/bills/policy`, `/expenses/policy` | `ap.policy`, `exp.policy` |
| 6 | AI & automation | Autonomy dial + kill switch (AI thresholds merged in) · Learned preferences · Cost routing | `/settings/autonomy`; Settings · AI Thresholds, Learned Preferences, Cost Routing | `ai.autonomy` |
| 7 | Notifications & alerts | channel providers (email, SMS, push, Slack, Teams), tenant quiet hours, digest defaults | new (M-13) | `core.tenant.settings` |
| 8 | Dashboard layouts | publish role layouts, lock levels, required widgets, version history | new (M-8) | `core.tenant.dashboard_layouts` |
| 9 | Integrations | tenant-level connectors and credentials (07) — same page as nav Integrations | `/integrations/erp` | `int.connections` |
| 10 | Defaults for new clients | revenue policy defaults, sales-tax rate tables, invoice display defaults, receipt-chase defaults, close checklist template, client access policy default | Settings · Revenue Recognition, Sales Tax Rates, Invoice Display, Receipt Chase | `core.tenant.accounting_settings` |
| 11 | Plan & billing | plan, seats, per-company pricing, AI usage vs budget ("Activate billing" honest label until live) | `/settings/billing` | `core.tenant.billing` |
| 12 | Support access | approve/deny requests, active sessions, access log | new (M-9) | `core.tenant.support_access` |
| 13 | Data & danger zone | full export, sandbox/tenant reset (two-person rule), retention | Settings · Danger Zone; `/sandbox` (platform side) | `core.tenant.export`, `core.tenant.reset` |

Settings · Companies tab → **Clients registry**. Settings · "Get started" → the onboarding tracker.

#### 3.8.2 Client settings (`/client-settings/<area>`, gear at the foot of the client nav)

| # | Area | Contents | From today | Capability |
|---|---|---|---|---|
| 1 | Client profile | legal name/EIN (masked), tags & industry, business context the agents read (AI-10), primary contact, status | `/portfolio/[id]`, `/settings/new-entity` | `onb.clients:edit` |
| 2 | People & access | who has access and how (05 A4); client contacts; client access policy; **Team & roles** if client roles are enabled (05 A5) | new | `core.access.assignments:view` |
| 3 | Accounting setup | account roles, required dimensions, departments, classes, items, fiscal calendar, modules this client uses | `/departments`, `/api/classes`, account-role registry | `core.tenant.accounting_settings` |
| 4 | Bank & card connections | Plaid items, card accounts, Ramp (07), statement-only accounts | bank connect flows | `bank.connections` |
| 5 | Cards & receipt chase | card → cardholder (M-11), receipt thresholds, chase cadence, escalation, quiet hours, channels | Settings · Receipt Chase | `cards.cardholders`, `exp.chase_policy` |
| 6 | Inboxes | AP email-to-bill address (mig 135), M365 mailboxes (GATE 4) | `org.inbound_ap_address` | `ap.policy:configure` |
| 7 | Online payments | Stripe Connect onboarding and status | `/settings/payments` (+ refresh/return callbacks) | `pay.provider_connections` |
| 8 | Invoice branding & delivery | 5 styles, logo, reply-to, payment terms text | `entity-invoice-settings.tsx`, Settings · Invoice Display | `ar.invoices:configure` |
| 9 | Revenue policy | basis + method per revenue stream, true-up rule (REV-02, REV-08) | Settings · Revenue Recognition | `revrec.methods:configure` |
| 10 | Sales tax | nexus, rates, provider (Avalara/TaxJar) | Settings · Sales Tax Rates | `tax.sales_tax:configure` |
| 11 | Close checklist | template, due business day, reviewer≠preparer setting | close templates | `close.checklist:configure` |
| 12 | Policies (overrides) | client-specific AP/expense rules on top of tenant defaults | — | `ap.policy`, `exp.policy` |
| 13 | Integrations for this client | field systems and ERPs mapped to this client (ServiceTitan tenant, Buildertrend company, etc.), mapping rules (07) | `/integrations/erp` | `int.connections` |
| 14 | Data import & conversion | the 08 wizard for this client: TB/AR/AP/WIP/equity, historical conversion with tie-out gate, generic CSV, QBO/Xero/Sage pull | `/import`, `/onboarding/conversion`, `/onboarding/reconciliation` | `onb.imports`, `onb.conversion` |

#### 3.8.3 Personal settings (avatar menu)

Profile · Notifications & quiet hours (M-13) · My watch rules · My dashboard (reset to role default) · Approval
delegation while away (AP-07, planned) · Devices (receipt app) · My access ("What can I do?" — the 05 explainer on self).

### 3.9 Route-by-route map (v2) — every existing page and its v2 home

**K** kept (same path) · **K→** kept, moved/renamed (old path redirects one release) · **M** merged into another page
(old path redirects to the target tab) · **R** retired (redirect to the named replacement, then removed) · **N** new.
"Client" / "Workspace" / "Platform" = context.

| Route today | v2 home | Disp. | Notes |
|---|---|---|---|
| `/` | Front door resolver (§3.2) | K | targets re-pointed |
| `/dashboard` | Role home for the current context (workspace / client / consolidated / employee) | K | today's company board feeds `ow.clients_compare`, `am.close_grid`; activity feed feeds `bk.done_for_you`; keep per-count deep links on client rows (06 §3.14) |
| `/inbox` | Workspace · Home · Inbox **and** Client · Home · Inbox | K | strongest page; context-filtered |
| `/bank-feed` | Client · Banking · Bank & card transactions (register); review moves to To review lanes | K | Credit Cards tab → Cards tab (fix dead Flag); Apply Deposits tab → `/cash-application` |
| `/credit-cards` (stub) | `/bank-feed?tab=cards` / `/review?lane=cards` | R | |
| `/categorize` | To review (manual coding lane) | R | posts without guard today (06 §5) — retire in wave 0; keep `/api/categorize/learn` |
| `/flagged` (stub) | `/review?lane=flagged` | R | |
| `/reconciliation` | Client · Banking · Reconciliation | K | tabs into the URL; split the 1,599-line file |
| `/cash-application` (stub) | Client · Receivables · Cash application | N (un-stub) | absorbs bank-feed Apply Deposits + Invoices "Unapplied payments" TODO |
| `/bills` | Client · Payables · Bills | K | add paging (50-row cap), move to DetailDrawer |
| `/bills/intake-queue` | `/review?lane=draft-bills` and Bills · Draft bills tab | M | one intake pipeline for the 4 document→bill paths |
| `/bills/policy` | Settings · Policies (doc type AP) / Client settings · Policies | M | |
| `/expenses/policy` | Settings · Policies (doc type expense) | M | |
| `/retainage` | Client · Revenue & jobs · Retainage (+ Bills · Retainage payable tab deep link) | K | add page guard (wave 0) |
| `/purchase-orders` | Client · Payables · Purchase orders | K | shared drawer |
| `/checks` | Client · Payables · Pay runs & checks `/pay-runs` | K→ | one name ("Pay runs"); tabs Queue/Print/Positive pay/ACH files/History/Remittances; replace `window.confirm` |
| `/expenses` | Client · Payables · Expenses & receipts | K | adds Receipts/Missing tabs; split 951-line file |
| `/receipts` | Expenses & receipts · Receipts tab + `/review?lane=receipts` | M | add guard |
| `/payroll` | Client · Payables · Payroll | K | remove in-modal company pickers; fix `?entry=` link |
| `/vendors` | Client · Payables · Vendors | K | add guard, error state, hover peek; delete dead files |
| `/vendor-compliance` | Client · Payables · Vendor compliance | K | add guard; Portal uploads tab |
| `/compliance-1099` | Client · Accounting · Tax · 1099 tab | M | add company scope; Vendor compliance keeps a "1099 readiness" link |
| `/invoices` | Client · Receivables · Invoices | K | Unapplied tab → Cash application; Collections button → `/collections`; own-books: Client billing tab |
| `/invoices/collections` (stub) | `/collections` | R | |
| `/estimates` | Client · Receivables · Estimates | K | add send |
| `/customer-deposits` | Client · Receivables · Customer deposits | K | |
| `/collections` | Client · Receivables · Collections | K | one dunning path; tabs into URL |
| `/customers` | Client · Receivables · Customers | K | add guard and scope |
| `/rev-rec` | Client · Revenue & jobs · Revenue recognition | K | add server guard, `?tab=` |
| `/jobs`, `/jobs/[id]` | Client · Revenue & jobs · Jobs | K | `[id]` gets context guard; one shared method selector |
| `/jobs/wip` | Client · Revenue & jobs · WIP | K | Reports `wip` links here (one WIP view) |
| `/inventory`, `/inventory/[id]`, `/inventory/valuation` | Client · Revenue & jobs · Inventory | K | |
| `/cash` | Client · Cash & debt · Cash position & forecast | K | **one** 13-week forecast (retire `/api/forecast/cash` duplicate) |
| `/forecast` (stub) | `/cash?tab=forecast` | R | |
| `/obligations` | Client · Cash & debt · Renewals & obligations | K | source for `bk.agenda`, `cash.obligations` |
| `/subscriptions` | Client · Cash & debt · Subscriptions | K | |
| `/debt` | Client · Cash & debt · Debt & covenants | K | tabs Register · Covenants · Borrowing base · Lender reporting |
| `/covenants` (stub) | `/debt?tab=covenants` | R | keep `focus=` through the redirect |
| `/borrowing-base` | `/debt?tab=borrowing-base` | M | move the certificate calculation server-side; combined BBC needs a group |
| `/journal-entries` | Client · Accounting · Journal entries | K | add Post/Void/Reverse drawer actions |
| `/recurring-journal-entries` (stub) | `/journal-entries?tab=recurring` | R | |
| `/recurring` | `/journal-entries?tab=recurring` | R | migrate `recurring_templates`; retire old engine (wave 0) |
| `/chart-of-accounts` | Client · Accounting · Chart of accounts | K | add guard; check Approve/Reject responses |
| `/assets` | Client · Accounting · Assets & schedules (hub tabs only) | K | card page dropped |
| `/fixed-assets`, `/leases`, `/prepaids`, `/intangibles`, `/tax-depreciation` | Assets & schedules tabs | K | fixed assets gets "Run depreciation"; intangibles impairment dialog replaces `window.prompt` |
| `/insurance` | Assets & schedules · Prepaids & insurance (policy register) | M | amortization via the prepaids engine (wave 0) |
| `/internal-invoices` | Client · Accounting · Intercompany · Internal invoices | M | fix `?highlight=` link; DH approvals feed |
| `/intercompany` (stub) | Client · Accounting · Intercompany | N (un-stub) | due-to/due-from moves out of `/consolidation` |
| `/departments` | Client settings · Accounting setup · Departments | K→ | |
| `/periods` | `/close?tab=periods` (read-only grid + reopen with reason) | M | hard close only through the Close gate (override path) |
| `/close` | Client · Home · Close | K | Status tab → Workspace `/work/close` |
| `/close-status` (stub) | `/work/close` | R | |
| `/year-end-close` (stub) | `/close?tab=year-end` | R | |
| `/tax` | Client · Accounting · Tax (hub tabs only) | K | card page dropped |
| `/tax/sales-tax` | Tax · Sales tax + Filing calendar tabs | K | header below tabs fixed; worksheet link keeps dates |
| `/sales-tax-calendar`, `/sales-tax-return` (stubs) | `/tax/sales-tax?tab=calendar` / `?tab=worksheet` | R | keep date params |
| `/book-to-tax`, `/tax-provision`, `/tax-package` | Tax tabs | K | add guards; drop in-page pickers |
| `/documents` | Client · Accounting · Documents | K | add guard + context |
| `/reports` | Client · Planning & reports · Reports (+ compare columns) | K | fix dead "Ask for any report…" (route to ⌘K); `?location_id=` honored via `?client=` |
| `/reports/basis-adjustments` | Planning & reports · Basis adjustments | K | |
| `/board-package` | Planning & reports · Board & lender packs `/packs` | M | fix "Operating income ← ebitdaCents" |
| `/fpna` | Planning & reports · FP&A & scenarios | K | KPI grid layout → M-8 |
| `/budgets` | Planning & reports · Budgets (one tab row) | K | add guard; remove in-page picker |
| `/budgets/drivers`, `/budgets/reforecast` (stubs) | `/budgets?tab=drivers` / `?tab=reforecast` | R | |
| `/profitability` | Workspace · Insights · Profitability by client `/insights/profitability`; client page becomes by dept/job/customer | K→ | API gets `authorize()` + per-client filter |
| `/consolidation` | Workspace · Consolidations `/consolidations` (setup) + Consolidated context `/consolidations/[groupId]` | K→ | intercompany tab → `/intercompany`; R4 guard |
| `/exceptions` (stub) | Client · Controls · Exceptions; Workspace · Work · Exceptions | N (un-stub) | Inbox Exceptions tab remains a feed |
| `/controls` (stub) | `/compliance?tab=controls` | R | |
| `/compliance` | Client · Controls · Compliance & SOX | K | delete dead `compliance-grid.tsx` |
| `/audit` | Client · Controls · Audit trail | K | |
| `/ai-decisions` | Client · Controls · AI decision log (read-only) | K | act in queues; remove `window.prompt` reject |
| `/agents` | Client · Controls · Agents; Workspace · Work · Agents & gates | K | start from a record, never a typed UUID |
| `/pbc` | `/requests?tab=pbc` (+ Controls · Audit requests) | M | via `v_requests_all` |
| `/search` | search palette "See all results" view | M | page chrome retired; results scoped to context |
| `/import` | Client settings · Data import & conversion (08) | K→ | |
| `/onboarding` | First-run + onboarding v2 (08) | K | sub-pages get guards |
| `/onboarding/conversion` | Client settings · Data import & conversion · Conversion (08) | K→ | tie-out gate = `onb.conversion:approve` |
| `/onboarding/reconciliation` | Conversion · opening-balance reconciliation step (08) | K→ | |
| `/onboarding/sections/[section]`, `/onboarding/sections/equity` | onboarding v2 sections (08) | K | |
| `/onboarding/tour` | role-aware tour (per template) | K | |
| `/onboarding/portfolio` | `/clients/new?mode=bulk` | K→ | |
| `/portfolio` | Workspace · Clients · Client registry `/clients` | K→ | R2 guard; row links switch context |
| `/portfolio/[locationId]` | `/clients/[clientId]` (profile; tabs Overview · Access · Policy · Capacity) | K→ | |
| `/operations` | Workspace · Insights · Books health | M | server guard |
| `/team` | Workspace · Team (Staff & capacity · Capacity assignments · Access · Requests · Reviews) + Insights · Team performance | K (split) | "New company" → `/clients/new`; split 1,288/1,046-line files |
| `/integrations/erp` | Workspace · Integrations hub `/integrations` (catalog tab) | K→ | one registry (QBO shown as connected, not "planned") — 07 |
| `/settings` | Tenant settings `/settings/<area>` + Client settings `/client-settings/<area>` | K (split) | §3.8 tab-by-tab |
| `/settings/approvals` | Settings · Approval workflows | K | |
| `/settings/autonomy` | Settings · AI & automation | K | absorbs AI Thresholds |
| `/settings/billing` | Settings · Plan & billing | K | |
| `/settings/roles` | Settings · Access & roles `/settings/access/roles` (05 A1) | K→ | |
| `/settings/permissions` | `/settings/access/roles` | R | exact alias today |
| `/settings/new-entity` | `/clients/new` | M | one "Add client" path (of five today) |
| `/settings/payments`, `/settings/payments/refresh`, `/settings/payments/return` | Client settings · Online payments | K→ | the two Stripe Connect callback routes keep their paths |
| `/sandbox` | Platform · Tenant detail · Sandbox | K→ | platform-only guard |
| `/platform` | Platform · Home (+ the §3.4 tree) | K | fix "Companies" column sorting by MRR |
| `/pay/[token]`, `/portal/customer/[token]`, `/portal/vendor/[token]` | public | K | |
| `/setup`, `/sign-in`, `/sign-up` | public / first-run | K | `/setup` hands off to 08 |
| — | `/review`, `/requests`, `/approvals`, `/pay-runs`, `/equity`, `/packs`, `/transfers` (when built) | N | client |
| — | `/clients`, `/clients/new`, `/clients/[id]`, `/clients/onboarding`, `/work/close`, `/work/review`, `/team/assignments`, `/team/access/*`, `/consolidations/*`, `/insights/*`, `/integrations` | N | workspace |
| — | `/client-settings/<area>`, `/settings/<area>` (security, access, policies, notifications, layouts, defaults, support, data) | N | settings |
| — | `/platform/tenants/*`, `/platform/revenue`, `/platform/health/*`, `/platform/support/*`, `/platform/defaults/*`, `/platform/team` | N | platform |
| — | `/portal/client/[token]`, `/portal/lender/[token]`, `/r/[token]` (one receipt / one request) | N | public token routes, rate-limited (05 allowlist) |

**Redirect stubs** keep working one release after their target ships, then are deleted; links that still point at
stubs are fixed first (06 §4 last row).

### 3.10 Duplicates resolved (v2, from 06 §4)

| Overlap | v2 decision |
|---|---|
| Two recurring-JE engines | `recurring_je_*` wins; migrate templates; repoint `missed-accruals.ts`; retire `/recurring` + old engine (wave 0) |
| Two insurance amortization engines | prepaids schedule engine wins; insurance keeps its policy register (wave 0) |
| Four document→bill paths | one intake pipeline → To review · Draft bills lane |
| AI proposals in three places | act in queues; `/ai-decisions` read-only log; dashboard "Proposals" count retired |
| AP vs expense policy compilers | one Policies surface with a doc-type switch |
| Two dunning paths | draft → approve → send only |
| Two 13-week forecasts | one forecast engine feeding `/cash` and `cfo.forecast` |
| Obligations ×3 | `/obligations` is the source; Cash panel and Subscriptions Renewals embed it |
| Tie-out cards ×4 | one `TieOut` component |
| Period control ×2 | hard close only via the Close gate; `/periods` → read-only grid + reopen |
| Consolidated statements ×2 | consolidated context only; Reports `consol` links there |
| BvA ×3, NL scenario ×2 | one BvA view (Budgets · Budget vs actual); one scenario component |
| Board packs ×2 | `/packs` |
| Per-company performance ×3 | Insights · Books health + Profitability by client + client profile |
| Search page vs palette vs ⌘K | palette (`/`) + command bar (⌘K); page retired |
| Add a company ×5 | `/clients/new` (one or many; 08) |
| Trial-balance intake ×4 | Conversion (with tie-out gate) only |
| `/settings/roles` = `/settings/permissions` | `/settings/access/roles` |
| AI thresholds vs autonomy | Settings · AI & automation |
| ERP catalog vs live QBO | one integrations registry (07) |
| `/assets`, `/tax` card pages | hub tabs only |
| `/tax-package` re-shows three screens | output view only; no pickers |
| WIP ×3 | `/jobs/wip`; one method selector |
| In-page company pickers (~12 pages) | removed; the context switcher is the only picker (R8) |

### 3.11 Side-by-side comparison vs consolidation (v2 decision — closes 06 §3.7)

**Decision: side-by-side comparison of accessible clients is allowed without a group; anything summed or eliminated
requires a consolidation group and a group-scoped grant.**

| Surface | Without a group (any user) | Requires a group + grant |
|---|---|---|
| Reports | one column per selected client (each needs `reports.financial:view` on that client); variance columns per client; "Industries" filter = client tags | a total column, a combined statement, eliminations |
| Insights · Compare clients | KPIs per client in rows (revenue, GM %, EBITDA, cash, DSO, close status), sort and rank | — |
| Profitability by client | per-client P&L ranking | group P&L |
| Board package / packs | a per-client appendix pack | a group board package |
| Borrowing base / covenants | per-borrower certificate | combined BBC, group covenants |
| Cash across clients | per-client rows | a group total |
| Workspace work counts | items to review, open requests, exceptions — summable (they're work, not financials) | — |

Rules: (1) A compare view never shows a sum of money across clients unless the viewer holds `consol.statements:view` on
a group whose members are exactly the selection — then it offers "Open as group". (2) `all_clients` holders get implicit
view on every group (Q4), so their compare views may show group totals for existing groups. (3) Holders of
`consol.groups:create` see "Create a combined group from these clients". (4) Compare sets save to `saved_views`
(M-15); a saved set silently drops clients the viewer later loses access to and says so ("2 clients hidden — no access").


### 3.12 Coverage index — LIVE/PARTIAL capabilities outside the client tree (v2)

§3.6.1 tags each client-nav item with its 04 IDs; §3.6.5 covers CON-*. The rest of 04's LIVE/PARTIAL capabilities live
in the workspace, platform, settings, shell or engine. Together these two tables place all 242 LIVE/PARTIAL
capabilities. Most PLANNED capabilities (Ramp, transfers, receipt chase, lender portal, access review, watch rules, tenant provisioning, context switcher, layouts) are placed by name where they will appear; the rest keep the IA home given in 04's catalog.

| Home | 04 IDs |
|---|---|
| **Engine / infrastructure** (no nav; visible through the queues and tie-outs it feeds) | GL-01 (posting engine), DIM-01 (dimensions on every line), CLS-13 (tie-outs → step 3 `TieOut` card, `ctl.close_through`), BNK-13 (payment match on feed → To review), REV-15 (Projects↔Books events), REV-16 (COGS routing → job picker in To review), INT-03 (provider registry + Vault), INT-04 (Resend), INT-05 (Clerk), INT-06 (Azure DI → Draft bills lane) |
| **Platform console** | AI-01 (Health · AI gateway, `pf.ai`), INT-14 (Health · Errors, `pf.errors`), ADM-13 (Tenant detail · Plan & entitlements / Modules), ADM-14 (Platform home), ONB-12 (Tenant detail · Sandbox / Data), ADM-17 (Tenant detail · Branding), AI-14 (`pf.ai`, `ta.ai_usage`) |
| **Workspace** | FPA-11 (Insights · Profitability by client), ADM-05 (Team · Capacity assignments), ADM-07 (Team · Staff & capacity), ADM-08 (Insights · Team performance), ADM-22 (Work · Practice tasks), ONB-05 (Clients · Add clients / Onboarding tracker), ONB-09 (capacity `lead`+`onboarding`; Onboarding tracker) |
| **Tenant settings** (§3.8.1) | ADM-01 / ADM-03 (Access & roles — 05), PAY-14 (Access & roles: `pay.batches` C/A/R split), AP-14 (Approval workflows · cost-approval rules), CTRL-09 (AI & automation), AI-08 (AI & automation · Learned preferences; `bk.done_for_you`), ADM-12 (Plan & billing; P · Revenue), ADM-17 (Organization · brand), ADM-18 (the whole §3.8 split), ONB-12 (Data & danger zone) |
| **Client settings** (§3.8.2) | DIM-05 (Accounting setup · items; Inventory), INT-02 (Online payments), ONB-03 / ONB-06 / ONB-07 (Data import & conversion, per 08), ONB-08 (Accounting setup · departments & charge method) |
| **Onboarding (08)** | ONB-01 (front door, `/setup`, wizard, readiness, tour), ONB-02 (drop-anything intake → wizard + To review) |
| **Queues & decisions** | AP-15 (Reports · AP aging; `ap.due`), PAY-13 (approve-by-exception → `ow.decisions`, `cfo.release`), PAY-15 (customer refunds → Customer deposits / Customers · Refund; `cfo.release` via `pay.refunds:R`), AI-03 (clarifying question → Decide band, `bk.ai_judgment`) |
| **Everywhere (shell & panels)** | ADM-20 (help, notifications bell, search palette), AI-02 (`ParseReview` in every module that accepts a document), AI-09 (narrative panels in Reports, Packs, Reconciliation, Debt; `fpa.flux`), AI-12 ("why" forensics in ⌘K) |

---

## 4. Home dashboard per role (v2)

### 4.0 Rules every home follows (v2: rules 9–11 added)

1. **Open state = work.** Above the fold on 1440×900: a 32px context line (date · period · close day N of target · one
   status phrase) and the role's **primary module** in the top-left 8 of 12 columns. No greeting, no banner.
2. **Every number has a comparison and a drill.** A tile with no "vs" and no destination is cut.
3. **Every module has one primary action** (a verb button or a row click into a filtered queue).
4. **Empty is not "No data".** Each module defines an *empty* state (nothing configured) and a *done* state
   (configured, nothing to do — a calm check and the next due date).
5. **Never a blank widget for missing rights** — the widget is not rendered and the grid reflows.
6. **Lazy-load below the fold**; the primary module renders first from one query.
7. **Visual direction:** queue-first homes use **B "Operator Cockpit"**; decision/performance homes use **A "Annual
   Report"** (§2.2 column). Same tokens, different density.
8. **AI-down honesty:** modules that depend on the gateway show "AI paused — rules and vendor memory still coding"
   inline (`ai-unavailable-notice.tsx`), never a dead tile.
9. *(v2)* **Last run is visible.** Any module fed by a scheduled job shows its last run in the done state ("Detectors
   ran 02:10 today") and turns amber if the job is late or failed (M-12). A stopped job can't hide behind a calm check.
10. *(v2)* **Seasonal and activated modules.** Modules tied to a season (1099s Nov–Feb, budget cycle, year-end) or to a
    module the client uses (jobs, inventory, debt, payroll) appear only when relevant; they are in the template, not
    removed, so they return on their own.
11. *(v2)* **Rows deep-link with context.** A row about a client opens the target page in that client's context
    (`?client=`), never on the picker prompt.

Widget ids are registry ids (§5.4). Rows in the layout tables are the **system template** (layer 1, §5.1).

### 4.1 Bookkeeper — the primary user (v2)

**What it's for:** plan and work my day across every client I'm assigned, hardest-to-close first, and keep payables,
receivables, receipts and vendor paperwork moving — without hunting.

**Layout (system template):**

| Row | Modules |
|---|---|
| 1 (above fold) | `bk.my_clients` (8 col) · `bk.agenda` + `ai.agent_gates` stacked (4 col) |
| 2 | `bk.ai_judgment` · `exp.missing_receipts` · `ap.intake` · `ar.collections` |
| 3 (lazy) | `bk.requests_out` · `bk.unreconciled` · `ap.due` · `ar.unapplied` · `ar.to_bill` · `vc.expiring` · `rr.recognition` (only if any assigned client has rev-rec-managed revenue) · `int.mapping_queue` (when connectors feed my clients) · `vc.portal_uploads` · `onb.my_conversions` (when I lead an onboarding) · `bk.done_for_you` · `bk.feeds` (hidden when healthy) · `tax.1099` (Nov–Feb) |

Example open state for a bookkeeper on four Merit clients:

```
Mon Oct 19 · September close · day 12 of 15 · 2 of 4 clients ready for review
┌ My clients ───────────────────────────────────────────────────────────────┐ ┌ Due this week ────────┐
│ Client            Step       Review  Unrec  Rcpts  Bills due  Req.   Due   ● │ │ Today  Swan Creek rec  │
│ Clive Power Eq.   Reconcile  41 (6⚑) 2      9      3 ($18.2k) 3(5d)  Oct 21●│ │ Tue    Clive close     │
│ Swan Creek        Review     18      1      0      0          0      Oct 21●│ │ Wed    Heritage payroll│
│ Heritage Int.     Check       0      0      2      1 ($2.4k)  1(1d)  Oct 23●│ │ Thu    Wild Rose 1099s │
│ Wild Rose         Ready ✓     —      —      —      —          —      Oct 23●│ ├ Waiting on you ───────┤
└───────────────────────────────────────────────────────────────[Start Clive]┘ │ AP intake run · Clive  │
                                                                              │  paused at "approve" 2h│
                                                                              └────────────────────────┘
```

**Distance from close** (unchanged): `remaining_minutes = Σ(open units × time standard)` over unreviewed feed/AI items,
unreconciled accounts, open close tasks, open blocking requests (M-10). Status: **Ready** · **Blocked** (feed down >2
days, blocking request >5 business days, missing statement) · **Overdue** · **At risk** (remaining > my available
minutes before due) · **On track**. *(v2)* Missing receipts and draft bills count as units.

| # | Module (id) | Question it answers | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **My clients** `bk.my_clients` | Which of my clients is furthest from close, and what step is each on? *(v2 columns: receipts missing, bills due, per-count deep links)* | **Start [client]** → client home at its step; any count → that queue in that client | Empty: "No clients assigned — your manager assigns them" + manager name. Done: "September is ready for review on all 4." |
| 2 | **Due this week** `bk.agenda` | What's due today and this week? *(v2 sources: + receipt-chase escalations, vendor doc expiries, covenant/BBC dates for my clients, rev-rec and depreciation runs, recurring invoices, sales-tax and 1099 dates, payroll dates)* | Row → the task | Done: "Nothing due until Oct 26." |
| 3 | **Waiting on you** `ai.agent_gates` *(v2)* | Which agent runs are paused for my decision? | **Review step** → the gate in its queue | Done: "No agent is waiting on you." |
| 4 | **Needs your judgment** `bk.ai_judgment` | What did the AI not get, or flag as uncertain? Bands Decide <70 · Check 70–89 · Ready ≥90 | Open band in To review (j/k/a/f) | Done: "Every item has a confident code. 212 ready for batch approval →" |
| 5 | **Receipts to chase** `exp.missing_receipts` *(v2)* | Which card charges still lack a receipt, from whom, and how much is unsupported at period end? | **Nudge now** / **Escalate** / **Mark not required** (per policy) | Done: "Every charge over $25 has a receipt." Empty: "Map cards to cardholders" → Client settings · Cards. |
| 6 | **Bills to review** `ap.intake` *(v2)* | Which draft bills from the inbox, drops or connectors await my review? | **Review** → To review · Draft bills | Done: "No draft bills." |
| 7 | **Collections follow-ups** `ar.collections` *(v2)* | Who's overdue, whose promise is due today, which dunning drafts await approval? | **Approve & send** / **Log promise** | Done: "Nothing overdue more than 30 days." |
| 8 | **Waiting on clients** `bk.requests_out` | What am I waiting on clients for; is any blocking close? | **Nudge** · **Answer for them** | Done: "No open requests." |
| 9 | **Unreconciled accounts** `bk.unreconciled` | Which accounts still need reconciling, and how far off? | **Reconcile** | Done: "All 11 accounts reconciled through Sep 30." |
| 10 | **Bills due** `ap.due` *(v2)* | What's due in 14 days with no pay run, and which discounts expire? | **Propose pay run** (→ `ap.pay_run_proposal` flow) | Done: "Everything due is in a run." |
| 11 | **Unapplied cash** `ar.unapplied` *(v2)* | Which payments and deposits haven't been applied to invoices? | **Apply** → Cash application | Done: "All cash applied." |
| 12 | **Ready to bill** `ar.to_bill` *(v2)* | What should be invoiced now — recurring due, accepted estimates, milestones reached, unbilled 1180, own-books client billing? | **Create invoices** (batch draft) | Done: "Nothing waiting to be billed." |
| 13 | **Vendor paperwork** `vc.expiring` *(v2)* | Which W-9s / COIs are missing or expiring in 60 days, and is any blocking a payment? | **Chase** (vendor-document request) / **Open hold** | Done: "All active vendors compliant." |
| 14 | **Revenue to recognize** `rr.recognition` *(v2, activated)* | Has this period's recognition been proposed and approved for my clients? | **Review run** | Done: "September recognized · posted Oct 3." |
| 15 | **Connector items to map** `int.mapping_queue` *(v2, 07)* | Which records from connected systems (ServiceTitan jobs, Buildertrend invoices…) need a client/department/job mapping? | **Map** (rule-learning) | Hidden when none. |
| 16 | **Done for you — worth a glance** `bk.done_for_you` | What did the system do, and should I spot-check any of it? | **Spot-check 5** · **Undo** where reversible | Linked counts only, never "AI auto-approved 95%". |
| 17 | **Feeds & connections** `bk.feeds` *(v2: + connectors)* | Is any bank, card, Ramp, inbox or field-system connection broken? | **Reconnect** / **Ask client to reconnect** | Hidden when healthy. |
| 18 | **1099 season** `tax.1099` *(v2, Nov–Feb)* | Are my clients' 1099s ready: W-9 gaps, box classification, file status? | **Fix gaps** | Done: "All 1099s filed." |

**Inside a client — the books-review loop (v2).** Header row = the four steps with live counts; the active step
expands below.

| Step | What's in it (v2) | Done when | System pre-work |
|---|---|---|---|
| **1 Review** | To review lanes: **Bank · Cards · Receipts · Draft bills · Deposits to apply · From connected systems · Flagged**; uncategorized (EC-4) | 0 Decide, 0 Check, Ready batch approved; no unapplied deposits; draft bills resolved | coding, matching, transfer pairing, duplicates (EC-1), cash-application suggestions, connector proposals |
| **2 Reconcile** | every bank / card / loan account: statement, GL, difference, outstanding aging | every difference = 0, preparer-signed | statement import, auto-match, difference decomposition |
| **3 Check** | exceptions for this client & period (EC-1/2/3/4/6/10/12/14…), subledger↔GL tie-outs (AR, AP, inventory, payroll, prepaid, deposits) as one `TieOut` card, missing receipts over threshold, payroll liability tie, "Returned by reviewer" on top | each item resolved, explained, or accepted with a note | detectors nightly + on demand (M-12) |
| **4 Close** | close tasks (auto-verified pre-ticked), **`ctl.schedules` proposals** (depreciation, amortization, leases, prepaids, recurring JEs), **`rr.recognition`** for rev-rec clients, client packet draft, blocking requests | all tasks complete → **Mark ready for review** | auto-verify, propose runs, draft packet + narrative |

On "Mark ready for review" the item enters the reviewer's queue, the row turns Ready, and the button becomes **Next
client →** (by distance from close).

### 4.2 Accounting manager (v2)

**What it's for:** every client closes on time and right; clear what's waiting on me; move people to the work; staff
and grant access within my scope.

| Row | Modules |
|---|---|
| 1 | `am.close_grid` (12 col, review-queue chip in header) |
| 2 | `am.review_queue` · `am.capacity` · `ai.agent_gates` |
| 3 (lazy) | `am.blocked` · `am.requests_stale` · `exp.missing_receipts` (team view) · `am.exceptions` · `am.access_requests` · `rpt.packs` · `am.quality` · `am.onboarding` (while any client onboarding) · `int.sync_health` · `am.client_economics` (firm) |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Close grid** `am.close_grid` | Which clients are on track / at risk / overdue / blocked — and who's on them? | Row → client; **Reassign** inline; filters | Done: "September closed on all 14 — 2 days early on average." |
| 2 | **Review queue** `am.review_queue` *(v2 sources: + expense approvals, reimbursement batches, rev-rec runs, schedule runs, COA requests, payment holds, close sign-offs, JEs to post)* | What's waiting for my review or approval? | **Review** · **Approve** / **Return with note** | Done: "Nothing waiting on you." |
| 3 | **Capacity this week** `am.capacity` | Who is over/under loaded vs what's due? | **Reassign** (drag) · **Cover vacation** | Empty: "Set weekly capacity" → Team. |
| 4 | **Waiting on you** `ai.agent_gates` | Agent runs paused for a manager decision (pay-run drafts, close-run gates) | **Review step** | Done. |
| 5 | **Blocked work** `am.blocked` | What is stuck, and why? | fix action | Done: "Nothing blocked." |
| 6 | **Stale requests** `am.requests_stale` *(v2: all kinds incl. receipts, vendor docs)* | Which requests are aging and hurting close? | **Escalate** | Done. |
| 7 | **Receipts to chase (team)** `exp.missing_receipts` | Which clients have the most unsupported spend? | → client lane | Done. |
| 8 | **Exceptions across clients** `am.exceptions` | High-severity exceptions anywhere? | Row → exception | Done + last run. |
| 9 | **Access requests** `am.access_requests` *(v2, 05 §6.11)* | Who is asking for access I can grant? | **Grant** (ceiling-checked) / **Deny** | Hidden when none. |
| 10 | **Packs & deliveries** `rpt.packs` *(v2)* | Which client packets / scheduled packs are due, sent, failed? | **Send** / **Fix** | Done: "All September packets sent." |
| 11 | **Team quality** `am.quality` | Is the team's work sticking? | Person → their clients | Empty under 30 days. |
| 12 | **Onboarding tracker** `am.onboarding` *(v2: 08 steps)* | Which new clients are stuck in setup or conversion? | Row → wizard step / **Invite to finish** | Hidden when none. |
| 13 | **Connector health** `int.sync_health` *(v2, 07)* | Which client connectors are failing or waiting on mapping? | **Fix** | Hidden when healthy. |
| 14 | **Client economics** `am.client_economics` *(v2, firm)* | Which clients cost more effort than their fee? | → Insights | Empty under 60 days. |

### 4.3 Platform admin (v2)

| Row | Modules |
|---|---|
| 1 | `pf.funnel` · `pf.tenant_health` |
| 2 | `pf.billing` · `pf.integrations` · `pf.ai` · `pf.scheduler` |
| 3 (lazy) | `pf.support` · `pf.errors` · `pf.conversions` · `pf.fee_revenue` · `pf.template_adoption` |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Onboarding funnel** `pf.funnel` | Where is every tenant between sign-up and live? | Tab → tenants; **Nudge** / **Offer concierge setup** | Empty: "No tenants — Provision tenant." |
| 2 | **Tenant health** `pf.tenant_health` | Which tenants are at risk? | Row → tenant; **Request support access** | Done. |
| 3 | **Billing exceptions** `pf.billing` | Who needs a billing action? ("MRR is list-price computed" until live charging) | Row → tenant billing | Done. |
| 4 | **Integration health** `pf.integrations` *(v2: every connector in 07's catalog)* | Which providers/connectors are failing platform-wide? | Provider → affected tenants | Done per provider + last check. |
| 5 | **AI gateway** `pf.ai` | Is AI working; any tenant over budget? (today: Anthropic org disabled = **critical** row) | **Open gateway settings** | Done. |
| 6 | **Scheduler & jobs** `pf.scheduler` *(v2, M-12)* | Did every scheduled job run, platform-wide? | Job → failing tenants; **Re-run** | Done: "All 9 job types ran on time." |
| 7 | **Support access** `pf.support` | Requests waiting; open sessions | **Request** · **End session** | Done. |
| 8 | **Errors & deploys** `pf.errors` | Did the last deploy break anything? | Row → error group | Done. |
| 9 | **Conversions in flight** `pf.conversions` *(v2, 08)* | Which tenants' imports/conversions are stuck or failed tie-out? | Row → tenant (with support grant) | Hidden when none. |
| 10 | **Processor fee revenue** `pf.fee_revenue` *(v2, 06 §3.12)* | Realized processor fee this month vs last | → Revenue | — |
| 11 | **Template adoption** `pf.template_adoption` *(v2, 05 §1.7)* | How many tenants adopted the latest role/dashboard templates; who dismissed? | → Defaults | Done. |

No tenant financial figures on this home (R13). **Platform support home** = `pf.support`, `pf.integrations`,
`pf.errors`, `pf.conversions`, filtered to tenants with an open ticket.

### 4.4 Tenant admin (v2)

| Row | Modules |
|---|---|
| 1 | `ta.access` · `ta.support` (only when pending) · `ta.access_requests` |
| 2 | `ta.access_review` · `ta.template_updates` · `ta.clients` |
| 3 (lazy) | `ta.connections` · `ta.sod_exceptions` · `ta.ai_usage` · `ta.billing` |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Access & seats** `ta.access` | Who's invited, active, missing MFA, waiting for access? | **Invite** / **Resend** / **Revoke** | Done: "12 of 15 seats · everyone on MFA." |
| 2 | **Support access requests** `ta.support` | Is MeritBooks asking to see our books? | **Approve (60 min, read-only)** / **Deny** | Hidden when none. |
| 3 | **Access requests** `ta.access_requests` *(v2)* | Who wants access to what? | **Grant** / **Deny** | Hidden when none. |
| 4 | **Access review** `ta.access_review` *(v2: 05 A8 campaigns)* | Is a review due; who hasn't attested; stale / unused / dormant access? | **Start review** / **Remove access** | Done: "Reviewed Oct 1 — next due Jan 1." |
| 5 | **Role template updates** `ta.template_updates` *(v2)* | Are there template changes or new-feature capabilities to adopt? | **Review diff** → Adopt all / safe / pick / dismiss | Done: "Roles up to date." |
| 6 | **Clients** `ta.clients` | How many clients, what status, who's assigned? | **Add client** / **Add many** | Empty: onboarding entry. |
| 7 | **Connections** `ta.connections` *(v2: + connectors)* | Anything disconnected across the tenant? | **Reconnect** | Hidden when healthy. |
| 8 | **SoD exceptions** `ta.sod_exceptions` *(v2)* | Which soft-SoD exceptions are active or expiring? | **Review** / **Revoke** | Done: "No exceptions." |
| 9 | **AI usage** `ta.ai_usage` *(v2)* | AI spend vs budget by client and feature | → Plan & billing | — |
| 10 | **Plan & billing** `ta.billing` | What are we paying; anything due? | **Manage plan** | — |

### 4.5 Owner (v2)

**What it's for:** know how the business is doing in ten seconds; make the decisions only I can make; know I'm safe
with lenders and cash. Privacy toggle blurs all figures.

| Row | Modules |
|---|---|
| 1 | `ow.decisions` · `ow.glance` |
| 2 | `cash.min_cash` · `ow.covenants` · `debt.borrowing_base` · `alerts.watch` |
| 3 (lazy) | `ow.books_status` · `ow.clients_compare` · `ow.consolidated` (grant) · `cash.obligations` · `cash.subscriptions` · `fpa.scenarios` |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Needs your input** `ow.decisions` | What is waiting on me (bills, payment runs, POs, requests, sign-offs)? Fraud-screen flags inline | **Approve** / **Answer** (one tap; SoD respected) | Done: "Nothing needs you. Books current through Sep 30." |
| 2 | **Business at a glance** `ow.glance` | Am I making money and do I have cash? | Tile → report | Empty before first close. |
| 3 | **Cash cushion** `cash.min_cash` *(v2)* | Is any company below, or heading below, its minimum cash in 14 days? | **See transfer suggestion** | Done: "All companies above minimum through Nov 2." |
| 4 | **Covenants** `ow.covenants` | Am I safe with my lenders? | Row → covenant | Hidden without covenants. |
| 5 | **Borrowing availability** `debt.borrowing_base` *(v2)* | How much can I draw vs what's drawn; when was the last certificate sent? | → Debt · Borrowing base | Hidden without a line. |
| 6 | **My watch rules** `alerts.watch` *(v2)* | Did anything I asked to watch fire? | One-click action from the rule | Empty: "Tell me when…" composer. |
| 7 | **Books status** `ow.books_status` | Can I trust these numbers? | **See what's open** | Done: "Closed through September · reviewed by J. Smith." |
| 8 | **Companies side-by-side** `ow.clients_compare` | Which of my companies is up or down? (per company, never summed — §3.11) | Row → client home | — |
| 9 | **Consolidated** `ow.consolidated` (**grant only**) | How is the group doing? Eliminations as a line | **Open consolidated** | Not rendered without a grant. |
| 10 | **Coming due** `cash.obligations` *(v2)* | Renewals, loan, lease and insurance payments in 30 days | Row → source | Done. |
| 11 | **Scenarios** `fpa.scenarios` *(v2)* | My pinned what-ifs and their cash/EBITDA impact | **Open scenario** | Empty: "Ask a what-if" (⌘K). |

Mike's own home as owner of the Merit tenant: this layout with `ow.consolidated` for "Merit Management Group —
Consolidated" and `ow.clients_compare` across all clients.

### 4.6 CFO (v2)

| Row | Modules |
|---|---|
| 1 | `cfo.kpis` strip (12 col) · then `cfo.release` (8) · `cash.min_cash` (4) |
| 2 | `cfo.compare` + `fpa.flux` · `fpa.reforecast` · `cfo.covenants` · `debt.lender_calendar` · `debt.borrowing_base` |
| 3 (lazy) | `cfo.forecast` · `fpa.scenarios` · `jobs.wip` · `jobs.retainage` · `cfo.close_blockers` · `cfo.consolidated` · `rpt.packs` · `cash.obligations` · `debt.maturities` · `alerts.watch` |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **KPI strip** `cfo.kpis` | Where are we vs plan? (cash, 13-week low, revenue vs budget, EBITDA vs budget, DSO, DPO) | Tile → report | — |
| 2 | **Awaiting release** `cfo.release` | What money waits for my release — pay runs, ACH/wire, payroll, refunds, reimbursements? SoD excludes my own | **Release** (step-up; fraud card inline) | Done: "Nothing to release." |
| 3 | **Cash cushion** `cash.min_cash` | Which clients are below or heading below minimum? | **Transfer suggestion** | Done. |
| 4 | **Entities side-by-side** `cfo.compare` | Which clients drive variance? | Row → variance report | — |
| 5 | **What moved and why** `fpa.flux` *(v2)* | Top 5 variance drivers (deterministic; AI only words them) | → flux report | "Computed (AI unavailable)" label when dark |
| 6 | **Forecast vs budget** `fpa.reforecast` *(v2)* | Latest forecast vs budget; when was the last reforecast? | **Reforecast now** | Empty: "No budget for FY26." |
| 7 | **Covenant headroom** `cfo.covenants` | Inside every covenant, and how close; projected breach date | **Prepare certificate** | Hidden when none. |
| 8 | **Lender calendar** `debt.lender_calendar` *(v2)* | What's due to which lender, when (certificates, BBCs, financials)? | **Prepare** / **Approve & send** | Done: "Next: Northwest compliance cert, Nov 15." |
| 9 | **Borrowing base** `debt.borrowing_base` *(v2)* | Availability vs drawn; eligible AR/inventory trend | → Borrowing base | Hidden without a line. |
| 10 | **13-week cash** `cfo.forecast` | What do the next 13 weeks look like? | **Open forecast** | — |
| 11 | **Scenarios** `fpa.scenarios` *(v2)* | Pinned scenarios | **Open** | — |
| 12 | **WIP & fade** `jobs.wip` *(v2, activated)* | Over/under billing, profit fade on jobs | → WIP | Hidden without jobs. |
| 13 | **Close blockers** `cfo.close_blockers` | Will the close be late, and why? | Row → client | Done. |
| 14 | **Consolidated** `cfo.consolidated` | Group performance and eliminations | **Open consolidated** | Not rendered without groups. |
| 15 | **Packs & deliveries** `rpt.packs` *(v2)* | Board / lender packs due, sent, failed | **Send** | Done. |
| 16 | **Coming due** `cash.obligations` · **Maturities** `debt.maturities` · **Watch rules** `alerts.watch` *(v2)* | obligations 30d; 12-month maturity/refinance ladder; my rules | → source | — |

### 4.7 Controller (v2)

| Row | Modules |
|---|---|
| 1 | `ctl.close_through` (8) · `rr.recognition` (4) |
| 2 | `ctl.approvals` · `ctl.exceptions` · `ctl.manual_jes` · `ctl.rec_signoff` · `ctl.schedules` · `jobs.wip` |
| 3 (lazy) | `ctl.intercompany` · `ctl.periods` · `ctl.agenda` · `tax.filings_due` · `tax.nexus` · `debt.lender_calendar` · `ctl.sox` · `ctl.ai_review` · `ic.internal_invoices` · `jobs.retainage` · `cash.subscriptions` · `ctl.working_papers` (when built) |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Close-through matrix** `ctl.close_through` | Which modules are closed through which date, per client (bank rec, AR/AP/inventory/payroll/prepaid/deposit ties, depreciation, accruals, rev rec, intercompany, period status)? | Cell → module in that client | Done: all cells through period end. |
| 2 | **Revenue to recognize** `rr.recognition` *(v2)* | Proposed recognition per job/contract, earned vs billed, method | **Review & approve** | Done: "September recognized · posted Oct 3." |
| 3 | **Approvals waiting on me** `ctl.approvals` *(v2)* | JEs over the self-post threshold, COA requests, write-offs, credit memos, vendor bank-detail changes, reopen requests | **Approve** / **Return** | Done. |
| 4 | **Exceptions by severity** `ctl.exceptions` | Open control exceptions | Row → exception | Done + last run. |
| 5 | **Unusual & manual JEs** `ctl.manual_jes` | Manual entries above materiality, EC-10, post-close entries | **Review** | Done: "None above $5,000." |
| 6 | **Recs to sign off** `ctl.rec_signoff` | Preparer-signed recs needing my sign-off | **Sign off** / **Return** | Done. |
| 7 | **Period schedules** `ctl.schedules` *(v2)* | Depreciation, amortization, lease, prepaid, insurance, intangibles, recurring JE runs — proposed / posted / failed | **Post all proposed** | Done: "All September schedules posted." |
| 8 | **WIP & fade** `jobs.wip` *(v2)* | Over/under billing adjustments needed | → WIP | Hidden without jobs. |
| 9 | **Intercompany & eliminations** `ctl.intercompany` | Do pairs agree so groups consolidate clean? | **Resolve** pair | Done. |
| 10 | **Period control** `ctl.periods` *(v2: + reopen & year-end, 06 §3.15)* | Open / soft / hard; reopen requests; year-end status | **Hard close** (gated) · **Reopen** (reason) · **Year-end** | — |
| 11 | **Controller calendar** `ctl.agenda` *(v2)* | Lender, tax, close-gate and audit dates across clients | Row → task | Done. |
| 12 | **Filings due** `tax.filings_due` *(v2)* | Client × obligation grid filed / due / overdue + penalty exposure | Row → filing | Done. |
| 13 | **Nexus watch** `tax.nexus` *(v2)* | Any state approaching a sales-tax threshold? | → Tax | Done. |
| 14 | **Lender calendar** `debt.lender_calendar` *(v2)* | Certificates and BBCs to prepare | **Prepare** | Done. |
| 15 | **SOX & controls** `ctl.sox` *(v2)* | Control tests due/failed, evidence missing | → Compliance | Done. |
| 16 | **AI oversight** `ctl.ai_review` *(v2)* | Sample of AI/agent decisions, override rate by feature, autonomy dial state | **Adjust autonomy** | — |
| 17 | **Internal invoices** `ic.internal_invoices` *(v2)* | Sent-not-approved aging; per-period integrity badge | Row → invoice | Done. |

### 4.8 Finance director (v2 — no longer "CFO minus covenants")

| Row | Modules |
|---|---|
| 1 | `fd.bva` (8) · `fpa.flux` (4) |
| 2 | `cfo.release` (scope) · `fpa.reforecast` · `fpa.budget_cycle` (in season) |
| 3 (lazy) | `cfo.compare` (scope) · `jobs.wip` · `cfo.close_blockers` (scope) · `alerts.watch` |

`fd.bva` — "Which of my units (clients / departments) is off plan, and why?" → variance report; **Explain** opens flux
for that unit. `fpa.budget_cycle` — "Who has submitted their budget, what's overdue?" → **Review submission**. All
modules filtered to the FD's scope; no accounting-settings actions.

### 4.9 HR / payroll (v2)

| Row | Modules |
|---|---|
| 1 | `hr.upcoming` (calendar across all clients in scope) |
| 2 | `hr.tied` · `hr.remit` · `tax.filings_due` (payroll filings filter) |
| 3 | `hr.requests` |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Upcoming payrolls** `hr.upcoming` *(v2: cross-client calendar + funding check)* | What pays next, per client, and is the funding account covered? | **Import register** / **Submit for release** | Done: "Next payroll Oct 24 · funded." |
| 2 | **Posted & tied** `hr.tied` | Did each payroll post balanced and tie to its register; liability accounts back to $0? | Row → JE | Done. |
| 3 | **Liabilities to remit** `hr.remit` | Which tax/benefit payables are due? | **Record remittance** | Done. |
| 4 | **Payroll filings** `tax.filings_due` (filter `payroll`) *(v2)* | 940/941, state withholding/UI due or overdue | Row → filing | Done. |
| 5 | **Requests** `hr.requests` | What does the bookkeeper need from me? | **Answer** | Hidden when none. |

Provider honesty: until a provider is chosen, `hr.upcoming` shows "Register import is the payroll source · runs are
estimates" (BuildStatusBadge).

### 4.10 Department head / operations leader (v2)

| Row | Modules |
|---|---|
| 1 | `dh.approvals` (8) · `dh.bva` (4) |
| 2 | `fpa.budget_cycle` (in season) · `dh.pos` · `ap.match_exceptions` · `dh.internal_charges` |
| 3 | `dh.jobs` · `inv.reorder` |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Approvals** `dh.approvals` *(v2: + internal invoices to my department, change orders, expense reports)* | What spend is waiting on me? | **Approve** / **Reject with note** | Done: "Nothing waiting." |
| 2 | **Department vs budget** `dh.bva` | Am I on budget MTD/YTD? ("Filtered to: Service, Install" chip) | → dept report | Empty: "No budget set." |
| 3 | **Budget submission** `fpa.budget_cycle` *(v2)* | Is my budget due, drafted, submitted? | **Open my budget** | Hidden out of season. |
| 4 | **Open POs** `dh.pos` | Committed but not received | Row → PO | Hidden when none. |
| 5 | **Match exceptions** `ap.match_exceptions` *(v2)* | PO/receipt/bill variances on my POs | **Resolve** | Hidden when none. |
| 6 | **Internal charges** `dh.internal_charges` *(v2)* | What other departments charged mine this period (cost transfers) | Row → internal invoice | Done. |
| 7 | **Jobs** `dh.jobs` · **Reorder** `inv.reorder` | My jobs over/under; items below reorder point | Row → job / item | Hidden when none. |

### 4.11 Check processor — payments clerk (v2, G5)

**What it's for:** turn approved bills into correct payments — queued, numbered, printed or exported, positive-pay
filed, released by someone else, cleared.

| Row | Modules |
|---|---|
| 1 | `pc.queue` (8) · `pc.print` (4) |
| 2 | `pc.positive_pay` · `pc.ach_files` · `pc.history` |
| 3 | `pc.reimbursements` |

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Ready to queue** `pc.queue` | What's approved and ready for a run, per client and pay date? | **Queue run** | Done: "Next batch expected Thu." |
| 2 | **To print / export** `pc.print` | Which approved runs need check numbers, printing or export; reprint/void with reason | **Assign numbers & print** | Done. |
| 3 | **Positive pay** `pc.positive_pay` | Issue files sent? Bank exceptions to approve/reject? | **Send file** / **Decide exception** | Done. |
| 4 | **ACH files** `pc.ach_files` | NACHA files generated, transmitted (sandbox label until a provider), returns | **Generate** / **Mark transmitted** | Done. |
| 5 | **Check history** `pc.history` | Outstanding >90 days, voided, cleared this week; remittance-advice send failures | **Void & reissue** / **Resend remittance** | Done. |
| 6 | **Reimbursements** `pc.reimbursements` *(06 §3.4)* | Approved expense reimbursements ready to batch | **Create batch** | Done. |

Nav for this role = Payables · Pay runs & checks (+ Vendors view). Release is never on this home (05 S1/H6).

### 4.12 AP clerk · AR clerk · data entry (v2)

- **AP clerk:** row 1 `ap.intake` · `ap.due`; row 2 `ap.match_exceptions` · `ap.holds` · `vc.expiring`; row 3
  `ap.pay_run_proposal`. `ap.holds` — "Which payments are blocked by compliance or lien-waiver holds?" → **Chase** /
  **Request override**. `ap.pay_run_proposal` — "Agent-drafted run by due date" → **Review run**.
- **AR clerk:** row 1 `ar.to_bill` · `ar.collections`; row 2 `ar.unapplied` · `bk.requests_out` (AR filter).
- **Data entry:** `de.drafts` ("Receipts and bills I keyed that are incomplete" → **Finish**) · `ap.intake`.

### 4.13 Employee / cardholder (v2, new, G2)

**What it's for:** clear my missing receipts in seconds from my phone, and get my expenses reimbursed.

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **My receipts** `em.my_receipts` | Which of my card charges need a receipt? (one card per charge: date, merchant, amount, card last 4, days outstanding, reminder count) | **Snap receipt** (camera) · **Upload** · **No receipt — explain** · **Personal charge** | Done: "You're all caught up. Next statement closes Oct 31." |
| 2 | **My expenses** `em.my_expenses` | What have I submitted, what's approved, when will I be paid? | **New expense** (mileage / per diem / out-of-pocket) · **Submit** | Empty: "Add your first expense." |

390px first. A chase SMS/email (M-7 `kind = receipt`) opens `/r/[token]` straight to that charge; answering there
needs no login. Quiet hours and cadence come from the client's receipt policy (M-11).

### 4.14 External auditor (unchanged from v1)

Primary `au.pbc` (requested / provided / accepted, overdue → accept/return); `au.periods` (is the period I'm testing
frozen?); `au.statements` (drill to GL → source document); `au.audit_trail`. Persistent chip "Auditor · read-only ·
access until Nov 30" (from the assignment's `effective_to`).

### 4.15 Lender viewer (v2, new, G4)

**What it's for:** get what the borrower owes me on time and see it in one place — never more than was delivered.

| # | Module (id) | Question | Primary action | Empty / done |
|---|---|---|---|---|
| 1 | **Deliverables** `lv.deliverables` | What has the borrower delivered (certificates, BBCs, financial packs), when, and what's late? | **Open / download** | Empty: "Nothing delivered yet." |
| 2 | **Due calendar** `lv.calendar` | What's due from the borrower next? (from M-14 obligations for my loans) | — | Done: "Next: Q3 compliance certificate, due Nov 15." |
| 3 | **Covenant status** `lv.covenant_status` | As of the last delivered certificate, which covenants passed and with what headroom? | → certificate | Hidden until a certificate is delivered. |

Lives in the lender portal (§3.6.6). Every view is logged to the access log and shown to the tenant.

### 4.16 Client contact (unchanged from v1) and client admin (v2)

- **Client contact** (`cc.requests`): the requests themselves — transaction card, question, one-tap answers, camera
  attach, free text. Done: "You're all caught up. Your bookkeeper is Dana Lee." Signed in or magic link.
- **Client admin** *(v2)*: owner layout limited to the envelope (`ow.decisions`, `ow.glance`, `ow.books_status`) plus
  `ca.team` — "Who on our staff has access, and is anything pending firm approval?" → **Manage team & roles**.

### 4.17 Consolidated home (v2)

Surface `consolidated_home`, for anyone in the consolidated context: `cfo.consolidated` (group P&L/BS headline with
eliminations line) · `con.group_close` (members' close status; group closes when all have) · `cash.min_cash` (group
filter) · `cfo.covenants` (group borrower) · `ctl.intercompany` (this group's pairs) · `rpt.packs` (group packs).

---

## 5. Dashboard customization model

### 5.1 Three layers, most specific wins (within the lock) (v2: keyed to role definitions)

| Layer | Who sets it | Applies to | Stored |
|---|---|---|---|
| **1 System template** | product (code) | every standard template | registry `defaultLayouts` (§4 layout tables) |
| **1b Platform default** | platform admin | every tenant that hasn't published its own for that role | `dashboard_layouts` scope `platform` |
| **2 Tenant role layout** | holders of `core.tenant.dashboard_layouts:configure` | everyone whose **primary role definition** is that role (or whose role's `home_template_id` points to it) | scope `tenant` + `lock_level` + `required_widget_ids` |
| **3 User personalization** | the user | themselves | scope `user` |

Resolution: user layout (if the lock allows and it's based on the current tenant version) → tenant layout for the
role → tenant layout for its `home_template_id` → platform default → system template. Then **filter by the compiled
capability snapshot for the current context**: widgets whose capability the user lacks are removed and the grid
reflows; required widgets the user can't see are skipped, not shown blank. Client-defined roles resolve the same way
(their home template is chosen in the builder; amendment A-4).

### 5.2 Lock levels (unchanged)

| Lock | User may | User may not |
|---|---|---|
| **Locked** | collapse a widget, change its own filters | add, remove, move, resize |
| **Add & move** | add from catalog, move, resize, remove non-required | remove required widgets |
| **Unlocked** | everything | remove required widgets |

### 5.3 Edit-mode UX (unchanged from v1, two additions)

- **Customize** enters edit mode in place; 12/6/1-column grid; sizes `S 3×2 · M 6×2 · L 6×4 · W 12×2 · XL 12×4`; drag
  and resize handles; keyboard (arrows move, Shift+arrows resize, Enter drops); catalog drawer filtered by permission;
  ⌘Z; **Reset to role default**.
- **Admins:** **Edit role layout** → pick role definition and surface → preview **as a sample user of that role on a
  chosen client** (uses 05's view-as rules: never more than the admin can see) → **Publish** (lock level · required
  widgets · New users only | Everyone (resets N) · note) → version history and rollback.
- **Platform defaults** never overwrite a tenant's published layout: "New default available — Compare / Adopt /
  Dismiss" (Q3).
- *(v2)* **Seasonal widgets** stay in the layout and render only in season; edit mode shows them dimmed with "Shown
  Nov–Feb".
- *(v2)* The FP&A KPI grid's localStorage layouts migrate into user-scope `dashboard_layouts` on first load.

### 5.4 Widget registry (code, `lib/dashboard/registry.ts`) — entry fields (v2)

| Field | Meaning |
|---|---|
| `id` | stable key, e.g. `bk.my_clients` |
| `title`, `question` | title + the one question it answers (shown in catalog) |
| `category` | v2: Work · Close · Banking · Payables · Receivables · Revenue & jobs · Cash & debt · Payroll · Tax & compliance · Planning · Controls · Team & access · Integrations & onboarding · Platform |
| `surfaces` | `workspace_home` · `client_home` · `platform_home` · `consolidated_home` · `portal_home` |
| **`requiredCapability`** *(v2)* | `{ cap, action }` in 05 vocabulary, evaluated per client the widget shows (rows from clients without it are dropped server-side) |
| `requiresGroupScope` / `requiresPlatformAudience` | group-scoped (05 [G]) or platform-only |
| *(v2)* `activation` | e.g. `modules_in_use.jobs`, `has_covenants`, `capacity:lead+onboarding`, `tenant_type:firm` |
| *(v2)* `season` | e.g. `{ from: '11-01', to: '02-28' }` |
| *(v2)* `lastRunJob` | M-12 job key whose last run the done state shows |
| `sizes`, `defaultSize` | allowed grid sizes |
| `dataSource` | `GET /api/dashboard/widgets/<id>` via `apiQueryHandler` + `authorize()`; underlying source listed in §5.6 |
| `refresh` | `live` (focus + 60s) · `5m` · `on_open` |
| `configSchema` | Zod schema (client filter, band, period, horizon) |
| `primaryAction` | label + route builder (always carries `?client=`) |
| `emptyState`, `doneState` | copy + optional CTA |
| `loadPriority` | `primary` (SSR) · `lazy` |
| `suggestedTemplates` | templates whose system layout includes it |

Every widget data route goes through the PDP; widgets never filter client-side. A guard test fails the build if a
registry entry lacks `requiredCapability` or names one not in the capability registry (05 §2.2).

### 5.5 Layout JSON (unchanged)

```json
{ "grid": 12,
  "items": [
    { "widget": "bk.my_clients", "x": 0, "y": 0, "w": 8, "h": 4, "config": {} },
    { "widget": "bk.agenda",     "x": 8, "y": 0, "w": 4, "h": 2, "config": { "horizon": "week" } },
    { "widget": "ai.agent_gates","x": 8, "y": 2, "w": 4, "h": 2, "config": {} } ] }
```

### 5.6 The registry (v2) — every widget

Surfaces: **W** workspace · **C** client · **P** platform · **X** consolidated · **R** portal / employee. Sizes: allowed,
**default in bold**. Capability per 05 (`:V` view, `:C` create, `:E` edit, `:A` approve, `:P` post, `:R` release, `:X`
export, `:K` configure); "(own)" = ownership constraint, "(dlv)" = `delivered_to_me`, "(asg)" = `assigned_to_me`,
"rows" = rows filtered by each item's own capability.

| id | Title | Category | Capability | Sizes | Data source | Surf. | Templates |
|---|---|---|---|---|---|---|---|
| `bk.my_clients` | My clients | Work | `close.checklist:V` per client | L,**XL** | `client_assignments` (me) × periods × `bank_transactions` × `bank_reconciliations` × `close_checklists` × `client_requests` × receipts × bills; `lib/close/readiness` | W | BK, AP, AR |
| `bk.agenda` | Due this week | Work | `home.workspace:V` (rows) | M,**L** | `lib/obligations/collect` + close due days, pay schedules, sales-tax/1099 dates, requests, lender obligations, M-12 runs | W,C | BK, AM |
| `bk.ai_judgment` | Needs your judgment | Work | `bank.transactions:E` | M,**L** | `bank_transactions` bands + `ai_decisions` clarifying questions | W,C | BK |
| `bk.requests_out` | Waiting on clients | Work | `req.client_requests:C` | M,**L** | `v_requests_all` (asked by me / my clients) | W,C | BK, AR |
| `bk.unreconciled` | Unreconciled accounts | Close | `bank.reconciliations:E` | **M**,L | `bank_accounts` × `bank_reconciliations`, decomposer | W,C | BK |
| `bk.done_for_you` | Done for you — worth a glance | Work | `ai.agents:V` (rows) | M,**L** | `agent_runs`/`_steps`, `ai_decisions`, auto-verified tasks, recurring runs, auto-matches, `learned_preferences` | W,C | BK, AM |
| `bk.feeds` | Feeds & connections | Integrations & onboarding | `bank.connections:V` | **M** | `plaid_items`, `core.provider_connections`, Ramp/connector status (07), inbound AP | W,C | BK |
| `ai.agent_gates` | Waiting on you (agents) | Work | `ai.agents:V` (rows by gate cap) | **M**,L | `agent_runs` at HUMAN_GATE assigned to me | W,C | BK, AM, CTL |
| `exp.missing_receipts` | Receipts to chase | Payables | `exp.receipts:E` | M,**L** | card txns without receipt × `card_holders` × `client_requests(kind=receipt)` × `receipt_policies` | W,C | BK, AM |
| `ap.intake` | Bills to review | Payables | `ap.bills:C` | **M**,L | intake queue drafts (inbox, drops, connectors) | W,C | BK, AP, DE |
| `ap.due` | Bills due | Payables | `ap.bills:V` | **M**,L | open bills by due date not in a batch; discount terms | W,C | BK, AP, CFO |
| `ap.pay_run_proposal` | Proposed pay run | Payables | `pay.batches:C` | **M** | pay-run agent recipe drafts | W,C | AP, AM |
| `ap.match_exceptions` | Match exceptions | Payables | `ap.purchase_orders:E` | **M** | `lib/procurement` 3-way match variances | W,C | AP, DH |
| `ap.holds` | Payment holds | Payables | `ctl.vendor_compliance:V` | **M** | compliance holds (mig 037), lien-waiver holds | W,C | AP, AM |
| `ar.collections` | Collections follow-ups | Receivables | `ar.collections:E` | M,**L** | `lib/collections` worklist, promises, dunning drafts | W,C | BK, AR, AM |
| `ar.unapplied` | Unapplied cash | Receivables | `pay.customer_payments:C` | **M** | `cash-application` candidates, unapplied deposits | W,C | BK, AR |
| `ar.to_bill` | Ready to bill | Receivables | `ar.invoices:C` | **M**,L | recurring due, accepted estimates, milestones, unbilled 1180, own-books client billing | W,C | BK, AR |
| `vc.expiring` | Vendor paperwork | Tax & compliance | `ctl.vendor_compliance:E` | **M** | W-9/COI status, expiry ≤60d, chase requests | W,C | BK, AP, AM |
| `vc.portal_uploads` | Vendor uploads to review | Tax & compliance | `ctl.vendor_compliance:A` | **S**,M | vendor portal PENDING uploads (mig 142) | W,C | BK |
| `rr.recognition` | Revenue to recognize | Revenue & jobs | `revrec.runs:V` (approve needs `:P`) | M,**L** | `lib/rev-rec` preview per job/contract | W,C | CTL, BK |
| `jobs.wip` | WIP & fade | Revenue & jobs | `jobs.wip:V` | M,**L** | WIP schedule, EAC (`lib/jobcost`) | W,C,X | CTL, CFO, FD, DH |
| `jobs.retainage` | Retainage due | Revenue & jobs | `jobs.jobs:V` | **M** | retainage receivable/payable due for release | W,C | CTL, CFO |
| `inv.reorder` | Reorder | Revenue & jobs | `inv.items:V` | **S**,M | reorder scan | C | DH, BK |
| `int.mapping_queue` | Connector items to map | Integrations & onboarding | `int.mappings:E` (A-3) | **M** | 07 mapping queue | W,C | BK, AM |
| `int.sync_health` | Connector health | Integrations & onboarding | `int.sync_runs:V` | **M** | 07 sync runs + M-12 `connectors.sync:*` | W | AM, TA |
| `onb.my_conversions` | My onboardings | Integrations & onboarding | `onb.conversion:V` | **M**,L | 08 wizard state + tie-out status | W | BK (lead), AM |
| `tax.1099` | 1099 season | Tax & compliance | `tax.1099:V` | **M** | `/compliance-1099` readiness, W-9 gaps, file status | W,C | BK, CTL |
| `tax.filings_due` | Filings due | Tax & compliance | `tax.filings:V` | M,**L** | `/compliance` filing grid, sales-tax calendar, payroll filings | W,C | CTL, CFO, HR |
| `tax.nexus` | Nexus watch | Tax & compliance | `tax.sales_tax:V` | **S**,M | EC-7 nexus tripwire | W,C | CTL |
| `am.close_grid` | Close grid | Close | `close.checklist:V` + `ws.assignments:V` | W,**XL** | per client: period, due, capacity assignees, step status, blockers | W | AM, CTL |
| `am.review_queue` | Review queue | Work | rows (any `:A`/`:P` held) | M,**L** | ready-for-review clients, JEs to post, recs, COA, holds, expense approvals, reimbursements, rev-rec/schedule runs | W | AM |
| `am.capacity` | Capacity this week | Team & access | `ws.assignments:E` | **L** | `weekly_capacity_hours` vs remaining minutes | W | AM |
| `am.blocked` | Blocked work | Work | `ws.client_health:V` | **M** | broken feeds, stale blocking requests, locked periods w/ open items | W | AM |
| `am.requests_stale` | Stale requests | Work | `req.client_requests:E` | **M** | `v_requests_all` aging | W | AM |
| `am.exceptions` | Exceptions across clients | Controls | `ctl.exceptions:V` | **M**,L | `ai_decisions` exception rail | W | AM |
| `am.access_requests` | Access requests | Team & access | `core.access.assignments:C` | **S**,M | `core.access_requests` routed to me | W | AM |
| `am.quality` | Team quality | Team & access | `ws.client_health:V` | **M** | `/api/team-performance` (mig 074) | W | AM |
| `am.onboarding` | Onboarding tracker | Integrations & onboarding | `onb.clients:V` | **M**,L | `locations.onboarding_status`, 08 wizard state | W | AM, TA |
| `am.client_economics` | Client economics | Team & access | `ws.client_health:V` (firm) | **M** | activity × time standards vs fee (ADM-23) | W | AM, OW (firm) |
| `rpt.packs` | Packs & deliveries | Planning | `reports.packs:V` | **M** | report packs, `report_deliveries` (M-14), M-12 `reports.packs` | W,C,X | CFO, CTL, AM |
| `ta.access` | Access & seats | Team & access | `core.access.members:V` | **M** | memberships, invitations, MFA, no-assignment members | W | TA |
| `ta.support` | Support access requests | Team & access | `core.tenant.support_access:A` | **S**,M | `support_access_grants` | W | TA |
| `ta.access_requests` | Access requests | Team & access | `core.access.assignments:C` | **S**,M | `core.access_requests` | W | TA |
| `ta.access_review` | Access review | Team & access | `core.access.reviews:V` | **M** | `access_reviews`, `capability_usage`, dormant access | W | TA |
| `ta.template_updates` | Role template updates | Team & access | `core.access.roles:K` | **S**,M | `core.template_updates` | W | TA |
| `ta.clients` | Clients | Team & access | `onb.clients:V` | **M** | `locations` status + capacity | W | TA |
| `ta.connections` | Connections | Integrations & onboarding | `int.connections:V` | **M** | as `bk.feeds`, all clients + connectors | W | TA |
| `ta.sod_exceptions` | SoD exceptions | Controls | `core.access.sod_policy:V` | **S**,M | `core.sod_exceptions` | W | TA |
| `ta.ai_usage` | AI usage | Platform | `core.tenant.billing:V` | **M** | `core.ai_usage_log` by client/feature | W | TA |
| `ta.billing` | Plan & billing | Platform | `core.tenant.billing:V` | **S** | mig 131 plan, computed MRR | W | TA |
| `ca.team` | Our team & roles | Team & access | `core.access.assignments:V` (client) | **M** | client-scope assignments, pending firm approvals | C | client admin |
| `ow.decisions` | Needs your input | Work | rows (approve caps) | M,**L** | approval requests, requests assigned to me, sign-offs; fraud screen | W,C | OW, client admin |
| `ow.glance` | Business at a glance | Cash & debt | `reports.financial:V` + `cash.position:V` | M,**L** | cash + 13-week low, revenue/GM vs LM & budget, AR overdue, AP due | W,C | OW |
| `ow.books_status` | Books status | Close | `close.checklist:V` | **S**,M | close status per client | W,C | OW, client admin |
| `ow.clients_compare` | Companies side-by-side | Planning | `reports.financial:V` per column | L,**W** | per-client KPIs (never summed, §3.11) | W | OW |
| `ow.consolidated` | Consolidated | Planning | `consol.statements:V` [G] | **L** | consolidation engine for the granted group | W | OW |
| `ow.covenants` | Covenants | Cash & debt | `debt.covenants:V` | **M** | `covenant_measurements` (mig 078) | W,C | OW |
| `cash.min_cash` | Cash cushion | Cash & debt | `cash.position:V` | **M** | `/api/cash` min-cash status + forecast low point | W,C,X | CFO, OW, CTL |
| `cash.obligations` | Coming due | Cash & debt | `cash.obligations:V` | **M** | `lib/cash/obligations` 30-day | W,C | CFO, OW |
| `cash.subscriptions` | Subscriptions | Cash & debt | `cash.obligations:E` | **S**,M | creep, renewals to decide | W,C | CTL, OW |
| `debt.borrowing_base` | Borrowing base | Cash & debt | `debt.borrowing_base:V` | **M** | `lib/borrowing-base` (server-side) | W,C | CFO, OW |
| `debt.lender_calendar` | Lender calendar | Cash & debt | `debt.certificates:V` | **M**,L | `lender_obligations` (M-14) | W,C,X | CFO, CTL |
| `debt.maturities` | Maturities | Cash & debt | `debt.loans:V` | **M** | debt schedules, 12-month ladder | W,C | CFO, OW |
| `alerts.watch` | My watch rules | Planning | `alerts.watch_rules:V` (own) | **S**,M | `watch_rules` + `watch_rule_events` (M-13) | W,C | OW, CFO, CTL, AM |
| `fpa.flux` | What moved and why | Planning | `reports.financial:V` | **M**,L | variance drivers (deterministic) + narrative | W,C,X | CFO, CTL, FD, OW |
| `fpa.reforecast` | Forecast vs budget | Planning | `fpa.budgets:V` | **M** | budgets, reforecast versions | W,C,X | CFO, FD |
| `fpa.scenarios` | Scenarios | Planning | `fpa.scenarios:V` | **M** | pinned scenarios (`/fpna`) | W,C | CFO, OW |
| `fpa.budget_cycle` | Budget cycle | Planning | `fpa.budgets:E` | **M** | budget submissions by dept/client (FPA-06) | W,C | FD, CFO, DH |
| `cfo.kpis` | KPI strip | Planning | `reports.financial:V` + `cash.position:V` | **W** | 6 KPIs vs budget | W,C | CFO |
| `cfo.release` | Awaiting release | Payables | any of `pay.batches:R`, `payroll.runs:R`, `exp.reimbursements:R`, `pay.refunds:R` | M,**L** | batches pending release; `PaymentFraudCard`, `ApprovalChainStatus` | W,C | CFO, FD, OW (company) |
| `cfo.compare` | Entities side-by-side | Planning | `reports.financial:V` per column | L,**W** | per-client P&L vs budget | W | CFO, FD |
| `cfo.close_blockers` | Close blockers | Close | `close.checklist:V` | **M** | close grid at-risk/overdue/blocked | W | CFO, FD |
| `cfo.covenants` | Covenant headroom | Cash & debt | `debt.covenants:V` | **M** | covenants, projected breach | W,C,X | CFO |
| `cfo.consolidated` | Consolidated | Planning | `consol.statements:V` [G] | **L** | consolidation engine | W,X | CFO, CTL |
| `cfo.forecast` | 13-week cash | Cash & debt | `cash.forecast:V` | M,**L** | the one forecast engine | W,C,X | CFO |
| `ctl.close_through` | Close-through matrix | Close | `close.checklist:V` | L,**XL** | per client × module closed-through dates, tie-outs (mig 149) | W | CTL |
| `ctl.approvals` | Approvals waiting on me | Controls | rows (`gl.journal_entries:P`, `gl.accounts:A`, `ar.write_offs:A`, `ar.credit_memos:A`, `gl.periods:E`…) | **M**,L | approval requests + JE threshold queue | W,C | CTL |
| `ctl.exceptions` | Exceptions by severity | Controls | `ctl.exceptions:V` | **M**,L | exception rail; M-12 `controls.nightly` | W,C | CTL |
| `ctl.manual_jes` | Unusual & manual JEs | Controls | `gl.journal_entries:A` | **M** | manual JEs > materiality, EC-10, post-close | W,C | CTL |
| `ctl.rec_signoff` | Recs to sign off | Close | `bank.reconciliations:A` | **M** | preparer-signed recs | W,C | CTL, AM |
| `ctl.schedules` | Period schedules | Close | rows (`fa.assets:P`, `fa.leases:P`, `fa.prepaids:P`, `gl.recurring_entries:P`) | **M**,L | schedule engines' proposals/posted/failed | W,C | CTL, BK (step 4) |
| `ctl.intercompany` | Intercompany & eliminations | Controls | `gl.intercompany:V` | **M** | EC-3, pair balances, group preview | W,X | CTL |
| `ctl.periods` | Period control | Close | `gl.periods:V` | **M** | `fiscal_periods`, reopen requests, year-end | W,C | CTL |
| `ctl.agenda` | Controller calendar | Work | `home.workspace:V` (rows) | **M** | lender, tax, close-gate, audit dates | W | CTL, CFO |
| `ctl.sox` | SOX & controls | Controls | `ctl.compliance:V` | **M** | `/compliance` control tests, evidence | W,C | CTL |
| `ctl.ai_review` | AI oversight | Controls | `ctl.ai_decisions:V` | **M** | `ai_decisions` sample, override rate, autonomy state | W,C | CTL, AM |
| `ctl.working_papers` | Working papers | Close | `close.checklist:E` | **M** | BS account support, tickmarks (CLS-07, when built) | W,C | CTL |
| `ic.internal_invoices` | Internal invoices | Controls | `gl.internal_invoices:V` | **M** | sent-not-approved aging, integrity badge | W,C | CTL, BK |
| `con.group_close` | Group close | Close | `consol.statements:V` [G] | **M** | members' close status | X | CFO, CTL |
| `fd.bva` | Budget vs actual by unit | Planning | `fpa.budgets:V` | L,**W** | BvA by client/department in scope | W,C | FD |
| `hr.upcoming` | Upcoming payrolls | Payroll | `payroll.runs:V` | L,**W** | `pay_schedules`, `payroll_runs`, funding account cash | W,C | HR |
| `hr.tied` | Posted & tied | Payroll | `payroll.register:V` | **M** | `payroll_runs` × `PAYROLL_RUN` JEs, register totals | W,C | HR |
| `hr.remit` | Liabilities to remit | Payroll | `payroll.remittances:C` | **M** | payroll liability balances | W,C | HR |
| `hr.requests` | Requests for me | Payroll | `req.client_requests:E` (asg) | **S**,M | requests assigned to me | W,C | HR |
| `dh.approvals` | Approvals | Work | rows (`ap.bills:A`, `ap.purchase_orders:A`, `exp.reports:A`, `gl.internal_invoices:A`, `jobs.change_orders:A`) with dimension restriction | M,**L** | approval requests routed by department (mig 092 / R-12) | C | DH |
| `dh.bva` | Department vs budget | Planning | `fpa.budgets:V` (dimension) | **M** | dept P&L vs budget | C | DH |
| `dh.pos` | Open POs | Payables | `ap.purchase_orders:V` | **M** | open POs by department | C | DH |
| `dh.internal_charges` | Internal charges | Controls | `gl.internal_invoices:V` (dimension) | **M** | internal invoices into my department | C | DH |
| `dh.jobs` | My jobs | Revenue & jobs | `jobs.jobs:V` (dimension) | **M** | job WIP, EAC | C | DH |
| `pc.queue` | Ready to queue | Payables | `pay.batches:C` | M,**L** | approved bills not batched | W,C | PC |
| `pc.print` | To print / export | Payables | `pay.checks:C` | **M** | approved batches without numbers/print | W,C | PC |
| `pc.positive_pay` | Positive pay | Payables | `pay.batches:X` | **M** | issue files, bank exceptions | W,C | PC |
| `pc.ach_files` | ACH files | Payables | `pay.batches:X` | **M** | NACHA exports, transmission state (sandbox label) | W,C | PC |
| `pc.history` | Check history | Payables | `pay.checks:V` | **M** | outstanding >90d, voided, cleared, remittance failures | W,C | PC |
| `pc.reimbursements` | Reimbursements | Payables | `exp.reimbursements:C` | **S**,M | approved expense reports not batched | W,C | PC |
| `de.drafts` | My drafts | Work | `ap.bills:C` or `exp.receipts:C` | **M** | incomplete items I created | C | DE |
| `em.my_receipts` | My receipts | Payables | `exp.receipts:C` (own) | **L** | my card charges needing receipts (M-11, M-7) | R | EM |
| `em.my_expenses` | My expenses | Payables | `exp.reports:C` (own) | **M** | my expense reports & reimbursements | R | EM |
| `au.pbc` | PBC list | Controls | `ctl.pbc:V` | **L** | `pbc_requests` | C | AU |
| `au.periods` | Locked periods | Close | `gl.periods:V` | **S** | `fiscal_periods` | C | AU |
| `au.statements` | Statements | Planning | `reports.financial:V` | **L** | statements with drill | C | AU |
| `au.audit_trail` | Audit trail | Controls | `ctl.audit_trail:V` | **M** | `audit_log`, `core.action_log` | C | AU |
| `lv.deliverables` | Deliverables | Cash & debt | `reports.packs:V` (dlv) | **L** | `report_deliveries` ∩ `external_shares` (M-14) | R | LV |
| `lv.calendar` | Due calendar | Cash & debt | `debt.certificates:V` (dlv) | **M** | `lender_obligations` for my loans | R | LV |
| `lv.covenant_status` | Covenant status | Cash & debt | `debt.certificates:V` (dlv) | **M** | figures from the last delivered certificate only | R | LV |
| `cc.requests` | Your requests | Work | `req.client_requests:E` (asg) | **L** | requests assigned to me | R | CC |
| `pf.funnel` | Onboarding funnel | Platform | `platform.tenants:V` | L,**W** | `organizations.lifecycle_status` | P | PA |
| `pf.tenant_health` | Tenant health | Platform | `platform.tenants:V` | L,**W** | activity, feeds, close lag, `app_error_log`, AI burn, billing | P | PA |
| `pf.billing` | Billing exceptions | Platform | `platform.billing:V` | **M** | plans, seats, trials, failures | P | PA |
| `pf.integrations` | Integration health | Platform | `platform.health:V` | **M**,L | providers + 07 connector catalog health | P | PA, PS |
| `pf.ai` | AI gateway | Platform | `platform.health:V` | **M** | gateway status, `core.ai_usage_log` | P | PA |
| `pf.scheduler` | Scheduler & jobs | Platform | `platform.health:V` | **M** | `core.job_runs` (M-12) | P | PA |
| `pf.support` | Support access | Platform | `platform.support:V` | **M** | grants, sessions | P | PA, PS |
| `pf.errors` | Errors & deploys | Platform | `platform.health:V` | **M** | `app_error_log`, Vercel state | P | PA, PS |
| `pf.conversions` | Conversions in flight | Platform | `platform.tenants:V` | **M** | 08 wizard / conversion state (metadata only) | P | PA, PS |
| `pf.fee_revenue` | Processor fee revenue | Platform | `platform.billing:V` | **M** | `invoice_events` meta (`FeeRevenueReport`) | P | PA |
| `pf.template_adoption` | Template adoption | Platform | `platform.templates:V` | **S**,M | `core.template_updates` across tenants | P | PA |

**Counts (v2):** 127 widgets — 62 carried from v1, 44 proposed in 04 (`+ctl.working_papers` is registered but ships only when CLS-07 is built), 21 new in v2 (lender, client-admin, client-contact, consolidated, access-request, template-update, SoD, scheduler, conversions, fee revenue, connector, ACH, reimbursement and approval widgets). Every id used in §4 appears here and every id here is placed on at least one home in §4; the registry guard test checks it.

---

## 6. The automation loops (v2)

Principle (canon §3): **AI proposes facts → the deterministic engine does the accounting → a human approves.**
Auto-post is OFF by default; the M10 autonomy dial raises it per task per tenant. Connector and import data (07/08)
enter as proposals on the same rail.

### 6.1 The bookkeeper's books loop (v1 steps, v2 additions marked)

| # | Step | System does automatically | Human decides | Where it surfaces | Job (M-12) |
|---|---|---|---|---|---|
| 1 | Ingest — bank | Plaid pulls per client account; dedupes | — | `bk.feeds`, step 1 | `bank.daily_pull` |
| 2 | Ingest — cards incl. Ramp | Ramp pulls `ready_to_sync` txns, bills, reimbursements with receipts + coding (07); MeritBooks pushes COA/dims/vendors | — | `bk.feeds`, step 1 Cards lane | `connectors.sync:ramp` |
| 3 | Ingest — documents | Email-to-bill (mig 135), drops, receipts; stored before AI (mig 112) | — | step 1 Draft bills / Receipts lanes, `ap.intake` | inbound webhook |
| 3b | *(v2)* Ingest — field systems & ERPs | ServiceTitan / Buildertrend / Innergy / simPRO / RFMS / C-Systems / ERP records (jobs, invoices, bills, payments) mapped to client/department/job per 07 | map unknowns | step 1 "From connected systems" lane, `int.mapping_queue` | `connectors.sync:<id>` |
| 4 | Pair & dedupe | transfers, bill payments, Ramp statement payment, EC-1 | confirm ambiguous pairs | step 1 Check band | on ingest |
| 5 | Code | rules → vendor memory / `learned_preferences` → AI categorizer (works without AI) | — | — | on ingest |
| 6 | Score & band | composite (vendor 40 / amount 40 / date 20): Ready ≥90, Check 70–89, Decide <70; auto-approve eligibility ≥85 AND trusted vendor AND ≤$10,000 AND dial = auto (**read from org settings**, not hardcoded — 06 §5 #14) | — | `bk.ai_judgment` | — |
| 7 | Review | keyboard queue (j/k/a/f/e, Space alias for select), vendor batch, ≥90 select, saved views, sortable columns, job picker (COGS needs a job), dept/class enforcement, confidence explainer, GL search with vendor recents | approve / edit / flag | step 1 | — |
| 7b | *(v2)* Apply cash | deposits matched to open invoices (AI cash application), over-apply guard | approve application | step 1 Deposits lane, `ar.unapplied` | on ingest |
| 8 | Ask client | request with suggested answers; magic link; reminders; answer re-codes and teaches memory | whether to ask; accept answer | `bk.requests_out`, `am.requests_stale` | `requests.remind` |
| 9 | Post | engine: balance, period lock, COA approval, dimensions, control accounts; idempotent `source_ref` | (approval was step 7) | errors return to step 1 | — |
| 10 | Reconcile | statement import, auto-match, aging, decomposer, never auto-plug | preparer signs; reviewer signs off | step 2, `ctl.rec_signoff` | — |
| 11 | Check | exception library EC-1/2/3/4/6/7/10/12/14 + tie-outs + payroll ties + missing-receipt threshold | resolve / explain / accept | step 3, `am.exceptions`, `ctl.exceptions` | `controls.nightly` |
| 12 | Close checklist | auto-verify; propose recurring JEs, depreciation, amortization, leases, prepaids, rev-rec run | complete tasks; mark ready | step 4, `ctl.schedules`, `rr.recognition` | `close.period_end`, `revrec.monthly` |
| 13 | Review & sign-off | reviewer packet | approve / return; hard close (gated) | `am.review_queue` | — |
| 14 | Deliver | client packet + narrative; group statements; board/lender packs | send (`release` on packs) | `ow.books_status`, `rpt.packs` | `reports.packs` |
| 15 | Learn | approved codings, answered requests → memory (proposal-only influence) | — | `bk.done_for_you` | — |

### 6.2 Other loops (v2)

| Loop | System does | Human decides | Surfaces | Job (M-12) |
|---|---|---|---|---|
| **Procure-to-pay** | PO → goods receipt → bill → 3-way match within tolerance; compliance & lien-waiver holds; pay-run agent drafts a run by due date and discount; check numbers; remittance PDFs; positive-pay issue file; NACHA export; fraud screen at release | approve bills (DH/OW by workflow), approve run, **release** (≠ preparer ≠ approver), decide positive-pay exceptions | `ap.*`, `pc.*`, `cfo.release`, `dh.approvals` | `ap.pay_run_propose` (daily) |
| **Order-to-cash** | recurring invoices, accepted estimates, milestones → drafts; send; dunning drafts; predicted pay date; cash application | approve & send; promises; write-offs (approve) | `ar.*`, `ar.collections` | `ar.recurring`, `ar.dunning` |
| **Receipt chase** *(G2)* | card charge posts → if over threshold and no receipt: request `kind=receipt` to the cardholder (M-11) via push/SMS/email per cadence (default day 0/2/5/10), quiet hours respected, escalate after N to the policy target, never stops until matched or excused; at period end accrue or flag unsupported spend | snap/upload/explain (employee); excuse (BK) | `em.my_receipts`, `exp.missing_receipts`, step 3 | `requests.remind` |
| **Vendor documents** | W-9/COI missing or expiring in 60 days → vendor-document request via vendor portal link; 2-weekly then weekly; payment hold when policy says | review uploads; grant overrides (AM+) | `vc.expiring`, `vc.portal_uploads`, `ap.holds` | `requests.remind`, `vendors.compliance_scan` |
| **Revenue recognition** | on the 1st, preview recognition per job/contract by method; unbilled 1180 accrual; deferred roll-forward | approve & post run | `rr.recognition`, step 4 | `revrec.monthly` |
| **Lender reporting** *(G4)* | from M-14 obligations: draft compliance certificate / BBC / financial pack N days before due; covenant compute | approve & send (`release`); deliveries logged; lender sees only delivered items | `debt.lender_calendar`, `lv.*` | `lenders.prepare` |
| **Payroll** | register import → balanced JE; liability tie; remittance reminders; funding check | release (provider phase), remit | `hr.*`, `cfo.release` | `payroll.funding_check` |
| **Access hygiene** (05) | expiry reminders 7d/1d; sweeper deactivates at `effective_to`; usage tracking; quarterly review campaign | renew / keep / reduce / revoke | `ta.access_review`, `am.access_requests` | `access.expiry_sweep`, `access.review_campaign` |
| **Onboarding** (08) | wizard imports (TB/AR/AP/WIP/equity, history), AI mapping, tie-out gate, go-live post | approve tie-out (`onb.conversion:A`), go live | `onb.my_conversions`, `am.onboarding`, `pf.conversions` | per 08 |

---

## 7. Security & access requirements this IA depends on (v2)

The IA is only honest if access is enforced server-side. Enforcement mechanics are 05 §5; this list is what the IA
requires and when. **Wave** = §10.

| # | Requirement | Current gap | Fix | Wave |
|---|---|---|---|---|
| **R0** *(v2)* | Money approval honors overrides and custom roles | `canApprove()` → static `roleMayApproveMoney()` ignores mig-130 overrides; revoking approve from CFO isn't honored; custom roles can never approve (05 C3) | interim: route through `effectivePermission()`; final: `authorize(…,'approve',{amount,preparedBy})` (R-11) | **0** |
| **R0b** *(v2)* | Pages and APIs that post, pay or roll up have guards | `/categorize` posts JEs with no guard or company scope; `/retainage` releases payments with no guard; `/consolidation`, `/portfolio*`, `/profitability` and their APIs have no permission check; `/operations` is browser-checked only (06 §5) | retire `/categorize`; guard `/retainage`; server checks on the four APIs; interim guard on the remaining unguarded pages listed in 06 §5 | **0** |
| **R1** | Client access enforced in Postgres | RLS is `org_id` only | M-4 over `core.effective_access`; guard tests (every `location_id` policy calls `can_access_location`; no status column directly updatable by `authenticated`); two-client × two-bookkeeper × one-group isolation test | **2** |
| **R2** | Every API checks scope through one decision point | APIs don't compare `location_id`; 99 routes use the admin client | `apiHandler(…, { access })` declarative form + `ctx.access.accessibleClients()`; guard test: every route declares `access` or calls `require()` | **2** |
| **R3** | `assigned` means assigned | `portcos_and_3rdparty` ignores assignments | backfilled to an explicit client set (05 R-4); scope from assignments only | **1** |
| **R4** | Summed roll-ups require a group and all-member access | `/api/consolidation/statements` unguarded; `canConsolidate` client-side; reports accept any multi-select sum | M-6 groups + group-scoped assignments; `requireGroupAccess`; compare mode returns per-client columns only (§3.11) | **3** |
| **R5** | Authority comes from access assignments | authority = `employees.role`; route and page guards read different sources (05 C4) | 05 R-4 backfill; dual-run then flip (R-11) | **1–2** |
| R6 | Bounded delegation, no self-administration | only `company_admin` manages users | 05 §4.2 ceiling + H1, DB triggers on `access_assignments` | 2 |
| R7 | Support access by consent | no consent flow; env allowlist = ambient power | M-9 + 05 H8; red band; tenant-visible log | 3 |
| R8 | Context cookie and `?client=` are hints | `mb_active_company` with `'all'` sentinel | validate per request; retire `'all'`; reject processing writes without a validated client | 3 |
| R9 | External audiences can't reach the ledger | client contact (new), employee (new), lender viewer (new) | audience ceilings (05 H3); middleware allowlist per audience; token routes hashed, single-purpose, rate-limited on a **shared store** (today's limiter is per-instance — CA S50 follow-up), anon grants revoked | 6 |
| R10 | Auditors read-only, time-boxed | auditor is a custom role (mig 145), no time box | standard template with required `effective_to` (H4), masked TIN/bank, every view logged | 2 |
| R11 | SoD preserved through capacity | — | transaction SoD (H6) also refuses when the actor is the `preparer` capacity on that item; close sign-off reviewer≠preparer (Q5) | 2 |
| R12 | Widgets, nav and ⌘K don't leak | dashboard shows all companies; nav fails open for custom roles (05 C6/C7) | server-side widget routes via the PDP; nav/registry/⌘K from the same snapshot; build-time guard tests | 3–4 |
| R13 | Platform never sees figures by default | Operator Console metrics | platform homes show counts, health and money owed to MeritBooks only | 3 |
| **R14** *(v2)* | Scheduled jobs run as a scoped system actor | no scheduler | M-12: each job runs per `org_id` (and `location_id`) with `actor = system:scheduler`, never cross-tenant in one transaction; writes are proposals unless the autonomy dial allows | 1 |
| **R15** *(v2)* | Connector data and credentials | Vault exists (mig 041); connectors planned | credentials in Vault per tenant (`int.connections:K` is [L], step-up); inbound records land as proposals; secrets never readable (05 H10); AI prompts never include TIN/bank/secrets | 7 |
| **R16** *(v2)* | Sensitive fields masked by default | raw `tin_encrypted` was once returned by `/api/vendors` | 05 R-6 masked views + serializer masks; exports honor masks | 2 |

**R0, R0b, R1–R5 are must-fix before a second tenant, before any bookkeeper is given client-scoped access in
production, and before any tenant edits a system role.**

---

## 8. Screen list for the next design round (v2)

Each uses Merit-shaped sample data, shows **open, empty and done** states, and 1440 + 390 widths where noted. All
screens show the **full role-filtered nav** (06 §3.5), not a 13-item sample. Resolve the design-system conflict (CLAUDE.md
emerald/dark vs design-studio v2 Electric Blue/Warm — 06 §5) before the port; it's a designer decision, not an IA one.
Component sheet must include hover peek, ExplainPanel, AttachmentsPanel, TieOut, OverrideReasonDialog (replaces every
`window.prompt`/`confirm`), ParseReview, DetailDrawer.

| # | Screen | Must show |
|---|---|---|
| S1 | **Bookkeeper home** (B) — *v2 amended* | context line; `bk.my_clients` with v2 columns and all 5 statuses; `bk.agenda` + `ai.agent_gates`; row 2 `bk.ai_judgment` · `exp.missing_receipts` · `ap.intake` · `ar.collections`; `bk.feeds` with one broken Ramp connection; done state |
| S2 | **Client home — books-review loop** — *v2 amended* | four steps; step 1 with all lanes (Bank · Cards · Receipts · Draft bills · Deposits · From connected systems · Flagged); step 3 `TieOut` card; step 4 with `ctl.schedules` + `rr.recognition`; Returned-by-reviewer; Next client →; **full client nav with disclosure** |
| S3 | **To review — bank & card lane** — *v2 amended* | everything in v1 **plus** (06 §3.6): saved views, vendor filter + click-vendor batch select, sortable columns, header actions (Refresh / Import statement / AI categorize), job picker + "COGS needs a job", dept/class enforcement, confidence-explainer modal, flag-reason dialog, metrics strip, Cards receipt-chase badge, Space alias |
| S4 | Client request — answer (390) | unchanged |
| S5 | Accounting manager home | v1 + `am.access_requests`, `int.sync_health`, `rpt.packs` |
| S6 | Owner / CFO home with a permitted consolidation (A) | v1 + `cash.min_cash`, `debt.borrowing_base`, `alerts.watch`; CFO variant with `fpa.flux`, `fpa.reforecast`, `debt.lender_calendar`; no-grant variant |
| S7 | Context switcher + shell states | v1 + **violet view-as band**, employee surface chip, "Compare…" entry |
| S8 | Dashboard edit mode | v1 + seasonal widget dimmed, admin preview-as on a chosen client |
| S9 | Platform console home | v1 + `pf.scheduler` (one job late), `pf.conversions`, `pf.fee_revenue`; full §3.4 nav incl. Defaults |
| S10 | Support access — request & approve | unchanged |
| S11 | Team & access — staff, capacity, bulk staffing | v1 rewritten on 05: bulk "Assign Dana as Bookkeeper (preparer) on 6 clients" creating access + capacity in one step; ceiling-limited role list; consolidation grant blocked "no access to Dorrian HVAC" |
| S12 | Consolidation group setup + consolidated context | v1 + consolidated nav (§3.6.5), group close, group covenants |
| **S13** | **Role library & role builder** (05 A1/A2) | library with level chips, holders, update dot; builder matrix with presets, delta markers, constraint panel, inline SoD strip (one hard, one soft), review & publish with people-affected |
| **S14** | **User access page** (05 A3) | assignments grouped by scope, effective-access-by-client matrix with source tooltips, Add access dialog with live ceiling/SoD check, View as, "Why can't they…?" |
| **S15** | **Client access + client roles** (05 A4/A5) | who has access to Heritage Interiors and how, coverage gaps; client policy panel; client admin's simplified builder with "Pending approval by Merit Management Group" |
| **S16** | **Explainer, 403 & request access** (05 A7, §6.11) | denial trace with fixes; 403 page "You don't have access to Debt & covenants on Heritage Interiors" + Request access; grantor's request card |
| **S17** | **Access review campaign** (05 A8; 390 too) | reviewer inbox with keep/reduce/revoke keys, usage evidence, SoD exceptions, export |
| **S18** | **Integrations hub & connector setup** (07) | catalog (ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems, ERPs, Ramp, Plaid, Stripe, QBO/Xero/Sage migration) with real status; connect flow (credentials, client mapping, what syncs, schedule); sync health; mapping queue — **detail per 07** |
| **S19** | **Onboarding wizard v2** (08) | the screens 08 defines; at minimum: start (one or many clients), source pick (file / connector / QBO-Xero-Sage), AI mapping review, tie-out gate, go-live, tracker row — **detail per 08 when available** |
| **S20** | **Check processor home + pay run** | `pc.*` home; `/pay-runs` tabs Queue · Print (number range, reprint/void with reason) · Positive pay (exception decide) · ACH files (sandbox label) · History; release shown only on the CFO side |
| **S21** | **Employee receipts** (390-first) | chase SMS → `/r/[token]` → charge card → camera → done; My receipts list; My expenses; quiet-hours note |
| **S22** | **Receipt chase — bookkeeper side** | `exp.missing_receipts` widget; Expenses · Missing receipts tab; Client settings · Cards & receipt chase (card→cardholder map, thresholds, cadence, escalation, channels) |
| **S23** | **FP&A** | CFO forecast vs budget (`fpa.reforecast`) → Budgets one-row tabs; `fpa.flux` drivers; scenarios; department head budget submission (`fpa.budget_cycle`) |
| **S24** | **Debt & covenants + lender view** | `/debt` tabs Register · Covenants · Borrowing base · Lender reporting; `debt.lender_calendar` → approve & send certificate; **lender portal** (`lv.deliverables`, `lv.calendar`, `lv.covenant_status`) |
| **S25** | **Controller home** | `ctl.close_through` + `rr.recognition`; approvals, schedules, filings grid, SOX, AI oversight |
| **S26** | **Settings IA** | tenant settings index (13 areas) and client settings index (14 areas) with the "from today" mapping visible in a migration banner for one release |
| **S27** | **Compare clients** (side-by-side) | per-client columns, no total; "Open as group" when a matching group exists; "Create a combined group" for holders; hidden-clients notice |
| **S28** | **Full client nav states** | services client (~32 items) vs construction client (~48); "More" folds with work badges; pins; own-books amber additions |

---

## 9. Open questions for the owner (v2 — merged from IA v1 Q1–Q6 and 05 Q1–Q5; 8 total)

| # | Decision | Recommended default |
|---|---|---|
| **Q1** | Is Merit's tenant a **firm** ("Clients", Merit Management Group LLC as "Own books") or a **company** ("Companies")? | **Firm.** Merit services its companies under an MSA, bills them, staffs per company — and it's the template for firms you'll resell to. |
| **Q2** | **Light seats:** do client contacts, auditors, employees/cardholders and lender viewers need logins at launch, and are they billable? | **Magic link at launch, login optional; all four free** (pricing stays per company, mig 131). Employees get an installable receipt app later. Friction on these sides kills response rates. |
| **Q3** | **Platform power over tenants:** may the platform force a dashboard layout, a role-template change, or new-module access onto tenants — and is there break-glass? | **Never silent.** Customized tenants get "New default / update available — Compare / Adopt (safe) / Dismiss"; only *restrictions* (platform locks, SoD rules, required security/billing notices) apply immediately with notice. Break-glass only for a declared security/legal incident: 30 min, read-only, second platform admin, tenant notified and logged. |
| **Q4** | **Roll-up visibility:** do all-clients roles (tenant admin, CFO, controller) see every consolidation group automatically, and can anyone compare clients side by side without a group? | **Yes and yes.** All-clients roles get implicit *view* on every group (manage needs a grant). Side-by-side comparison of clients you can each view needs no group; any **sum or elimination** needs a group (§3.11). |
| **Q5** | **SoD defaults bundle:** (a) close sign-off by someone other than the preparer; (b) sole-approver mode for one-person companies; (c) manual-JE self-post threshold; (d) second-person approval for high-risk grants. | (a) **On** for firms and any tenant with ≥2 finance users. (b) **Allowed only for company tenants with exactly one money approver**, shown as a standing exception, auto-off when a second approver exists. (c) **$25,000**, plus any amount touching equity, intercompany or a soft-closed period; system-generated entries exempt. (d) **On** for firms and tenants with ≥2 admins. Money-release SoD stays DB-enforced regardless. |
| **Q6** | **Client-defined roles in firm tenants:** on or off by default for a new client? | **Off; the firm enables it per client**, inside the "Client staff envelope", with firm approval for any approve/release/post/configure grant. **On** for company tenants. |
| **Q7** | **Data coming in (07/08):** may connector or import data ever post without a person; who passes the onboarding tie-out gate; which connectors ship first? | **Proposals only** — connector and import records land in To review lanes; posting follows the autonomy dial (off by default). Tie-out gate approval = `onb.conversion:approve` held by an accounting manager or controller, never the preparer of the conversion; a client stays `onboarding` until it passes. First wave: **Ramp** (top priority per CG#1) and the field systems Merit's own clients run (ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems) **in the order 07 sets**; QBO/Xero/Sage stay migration-only. |
| **Q8** | **Chase defaults:** cadence, escalation and channels for receipt and vendor-document chases. | **Receipts:** required over $25; remind day 0/2/5/10 then weekly until matched; quiet hours 8pm–7am local; escalate after 3 to the cardholder's manager (or the client contact); at period end flag (not accrue) unsupported spend. **Channels:** email + push at launch; **SMS opt-in** once an SMS provider is chosen (07) and the employee consents. **Vendor docs:** from 60 days before expiry, every 2 weeks then weekly; payment hold at expiry. All per-client editable. |

---

## 10. Build sequencing (v2, new)

Numbered waves. A wave starts only when its dependencies are **verified done** (verifier + chrome-auditor; security
agent on any access/money/public-route wave), per CLAUDE.md §0.1. **Migrations go to Supabase first, then the code that
depends on them.** Shared-spine files (`migrations/*`, `packages/shared/*`, `api-handler.ts`, `navigation.ts`,
`permissions.ts` / the capability registry) are single-threaded through the lead. Each wave's module needs its FPB
first (Rule 13): the identity FPB (`FPB-identity-multitenancy.md`) covers waves 1–3; dashboards/homes, requests & chase,
lender reporting, integrations (07) and onboarding v2 (08) each need one (auditor authors).

| Wave | Contents | Depends on | Exit gate |
|---|---|---|---|
| **0 · Security & integrity fixes (now)** | R0 interim (`roleMayApproveMoney` → `effectivePermission()`); R0b (retire `/categorize`, guard `/retainage`, server checks on `/api/consolidation/statements`, `/api/portfolio*`, `/api/profitability`, `/api/operations`, interim page guards on the 06 §5 list); collapse duplicate engines (recurring JE → `recurring_je_*`; insurance amortization → prepaids engine); 06 §5 bugs 1–7 (vendor-name edit dropped, dead Card flag, ⌘K double-bind, dead CPA Desk button, ignored `?highlight=`/`?entry=` links, silent COA approve failure, 50-row caps) | none | security GO; tests green; Vercel READY |
| **1 · Access foundations** | **M-1, M-2** → **R-1** capability registry (all ~110 resources incl. the ~20 module keys 04 G22 found missing, plus A-3) → **R-2** role definitions + templates (incl. A-1 `employee`, `lender_viewer`) → **R-3** permission sets → **R-4** access assignments + client sets + backfill → **R-5** client access policies → **M-3** (amended) → **M-5** capacity assignments. **M-12** scheduler run log + the scheduler mechanism (INT-01, per 07) in parallel — it has no access dependency, and R14 applies | wave 0 | backfill report shows effective access unchanged except the 05 §2.3 "tighten" rows; guard test: code registry = `core.capabilities` |
| **2 · Enforcement flip** | **R-6** field masks · **R-7** auth policies · **R-8** SoD · **R-9** access log/reviews/usage/requests · **R-10** template updates · **R-11** effective access + `has_capability` + definer RPCs for post/approve/release + **7-day dual-run** → flip → **M-4** location RLS (staged a → b) · **R-12** approval workflows on capability · auditor template time box (R10) | wave 1 | dual-run disagreements = 0 or explained; two-client × two-bookkeeper × one-group isolation test green; security GO. **Unblocks: second tenant; client-scoped bookkeepers in prod** |
| **3 · Shell, context & nav** | context switcher + bands (amber/steel/red/violet), `?client=` arrival, `'all'` retired (R8); nav registry with `requiredCapability` on every item + progressive disclosure (`modules_in_use`); three nav trees (§3.4–3.6); route moves/redirects per §3.9; settings split (§3.8); **M-6** groups + group-scoped assignments + consolidated context (R4); compare mode (§3.11) + **M-15** saved views; **M-9** support access (R7); 05 admin UX A1–A3, A7, 403/request access | wave 2 | chrome-auditor: every §3.9 route resolves to its v2 home; nav per template matches §3.6.3; no leaked clients in switcher/compare |
| **4 · Homes & the books loop** | **M-8** layouts + widget registry + edit mode/publish; **M-10** time standards; first homes **S1 bookkeeper, S2/S3 client loop, S5 manager, S9 platform, tenant admin**; **M-7** requests & chase engine (client questions first) + client-contact portal (S4); books-loop lanes (Deposits, Draft bills, Receipts) | wave 3 (+ M-12 for last-run states) | registry guard test (every widget has a capability and a home); chrome-auditor on each home in all states |
| **5 · Role-home breadth** | controller (S25), CFO/owner (S6), FD, HR, DH, check processor + `/pay-runs` tabs (S20), AP/AR clerk, data entry; FP&A widgets (S23); debt hub tabs + **M-14** lender obligations/deliveries (S24 internal side); **M-13** notifications + watch rules; rev-rec & schedules widgets; filings grid | wave 4 | each home verified; release paths re-tested for SoD (security) |
| **6 · Chase & external audiences** | **M-11** cards & cardholders + receipt policy; receipt chase on M-7 (S21/S22) with email + push (SMS when 07's provider lands); vendor-document chase sender; employee surface + `/r/[token]`; lender portal (`lv.*`, M-14 external shares); shared-store rate limiting for all token routes (R9); access review campaigns (05 A8, S17) | waves 4–5; INT-13 channels (07) | security GO on every token route; 390px chrome-auditor pass |
| **7 · Integrations & onboarding v2** | **07-INTEGRATIONS-PLAN** migrations and connectors (Ramp first; field systems in 07's order; ERP catalog as one registry) → Integrations hub (S18), per-client connections, `int.*` widgets, "From connected systems" lane, mapping queue; **08-ONBOARDING-V2-SPEC** migrations and the wizard (S19) → `/clients/new` (one or many), Data import & conversion, tie-out gate (`onb.conversion:A`), `onb.my_conversions`, `pf.conversions` | waves 2–4 (capabilities `int.*`/`onb.*`, scheduler, M-7 for document asks, client registry); 08 can be **designed** during wave 3 and **built** after wave 2 because it creates clients and assignments | FPBs approved; connector writes proven proposal-only; tie-out gate proven blocking |
| **8 · Retire legacy** | **R-13** emergency access + support capability scope; **R-14** drop mig-014/130 tables, `admin_scope`, `employees.role` authority, `membership_locations` compat view, `permissions.ts` → deleted; delete redirect stubs one release after targets ship; remove `/api/rbac/*` proxies | waves 2–7 stable one release | no references to legacy keys (guard test); stub links all repointed |

**Critical path:** wave 0 → 1 → 2 is strictly serial (the migration lane and the dual-run are the throughput ceiling).
Waves 3+ fan out to parallel builder agents on file-disjoint slices (3–5 at a time, opus 4.8), with the lead holding the
shared spine. Waves 5, 6 and 7 can overlap once wave 4's registry and layouts exist.
