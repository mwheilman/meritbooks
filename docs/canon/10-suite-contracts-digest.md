# Digest — Merit Suite Contracts (architecture, ownership matrix, event→GL contract, identity, test tenant)

> Faithful, quote-preserving digest of the five suite-level contract docs. Source of truth = the
> Project-knowledge originals. Read `CANON-ANCHOR.md` first.

## FILE 1 — merit-suite-architecture.md

**Purpose.** "The single source of truth that keeps every build session — MeritBooks, MeritProjects, and future modules — building against the same architecture."

**Thesis.** "Merit Enterprise Suite is **one unified system, sold as separately-purchasable modules** — not separate apps connected by APIs." Multiple modules "operate as one seamless platform with no integration boundary." Books = ledger; Projects = ops/PM; future Inventory, HRIS/Payroll, Context/Agent. Differentiator: no reconciliation boundary between operations and ledger.

**Locked architectural decisions (10):**
1. **Modular monolith. One deployable, one Postgres, one schema.** "Modules are code/ownership boundaries, not data boundaries. No database-per-module. No internal API boundary." (Books/Projects currently separate deployments = temporary drift, converge to one.)
2. Three ownership zones in one schema: Suite Core; Books; reserved namespaces (Projects/Inventory/HRIS).
3. "Canonical objects are referenced by FK, never copied."
4. Thin-canonical vs deep-module split (Core holds minimum; owning module adds depth vs same ID).
5. Append-only event log + typed action API per module; "the agent layer calls the same actions the UI does."
6. Cross-module writes atomic (one DB txn); async only where lag acceptable.
7. Multi-entity GL with consolidation from day one; entity is a canonical core object.
8. "Books owns the ledger, not the business objects." Books does NOT own Customer, Vendor, Item, Employee.
9. Stack: GitHub / Vercel / Supabase (PG+RLS) / Clerk / Anthropic. "All AI calls server-side only... through the single Core-owned AI gateway — no module holds an API key."
10. Module independence both directions (standalone thin stub; gains depth with owning module, zero re-integration).

**Suite Core canonical objects** (stable suite-level UUIDs): Tenant/Org; Users+Entitlements; Entities/Locations; Customers/Contacts; Vendors; Items; Employees; Event log; AI gateway+metering; Provider connections+secrets.

**Thin-canonical frozen shapes:** Item(core): id, sku, name, type, default_price, income_account_id, cogs_account_id. Employee(core): id, name, status, default_labor_rate, default_billing_rate, payroll_account_id. Customer/Vendor/Entity: canonical identity + minimal Books-needed fields. "Freeze these shapes now even for modules that don't exist yet."

**Per-module onboarding.** Completion tracked per **(organization × module)**, not tenant-wide. Shared masters imported once into `core`; import dependency order enforced.

**Entitlements.** jsonb `entitlements` on `core.organizations` (e.g. `{"projects": true}`), default standalone. "A module must never assume a sibling exists; it must read `entitlements`."

### AI Gateway & Cost Governance (Core-owned)
- One Core gateway is the **only** path to Anthropic; no module holds a key or calls directly.
- Metering: tokens→cents via Core model-price table; one row per call to `ai_usage_log` (tenant_id, user_id, module, feature, model, tokens_in/out, cost_cents, correlation_id, occurred_at); running monthly counters; "caps checked against a counter read, never by summing the log on the request path."
- **Nested budget enforcement (before the call), innermost-first:** per-feature cap → per-user sub-budget → **tenant monthly budget (required, binding, across combined usage of all modules).**
- Thresholds: soft ~80% (warn, proceed), hard 100% (block/degrade). `status ∈ ok|warn|degraded|blocked`.
- Attribution key = **`clerk_user_id` (text), NOT `core.users.id`**; `core.ai_usage_log.user_id` (text) matches it.
- Canonical call path = **in-process import** (`@meritbooks/core-ai`, tables in `core`); HTTP = interim bridge only while deployments are separate, "do not over-build it," fails closed. Gateway reached via config, never a hardcoded URL. **Not an event type — never rides `core.events`.**

### Provider Connections & Secrets (Core-owned)
- Built into `core` by the module that first needs it — **Books builds it at GATE 12.** "Do not define a `public.provider_connections` you will later migrate; it lands in `core` from the start."
- `core.provider_connections`: RLS `org_id = get_org_id()`; unique `(org_id, capability, provider, environment)`; row holds only `secret_ref`/`account_handle`, **never the secret** (Vault/KMS, server-side only).
- Webhooks: shared Core verify-and-route; "signature verification must use the Core secret path, never a module-local copy."
- **Boundary:** Core owns registry/secret path/entitlement gating/webhook verify-route. **Books owns:** rails, payroll engine, GL posting, money-movement SoD/approval+audit, provider legal consent (NACHA/ACH). "**Money-movement authorization is module-owned (Books), not Core.**" Requirements: **preparer ≠ approver (server-enforced), explicit human release (no automated transfers)**, audit (`actor` → `core.users.clerk_user_id`, before/after, `provider_correlation_id`). "Do not bake a Books-private notion of 'who may approve' that won't reconcile to `core.memberships`."

**Changes required for Books:** reframe wizard as Suite onboarding; route imports (Customers/Vendors/Items/Entities → Core; COA/opening balances/GL → Books); assign canonical UUIDs at import; Books references not owns; add event log + emit now; multi-entity GL from start; split schema into three zones + thin-canonical contracts.

**Projects (post-build):** references `core`, rides suite event log, owns schema `proj`; consumes `JOB_COST`; emits `JOB_BILLING` + `JOB_PROGRESS`; references core masters by UUID FK only. Open item: "Books must expose `invoice_number` as an additive column on the `core.events` row."

**The one discipline:** "Do not keep MeritBooks 'simple' by deferring the Core/module split until later modules force it."

## FILE 2 — merit-suite-shared-object-ownership-matrix.md

Rule: "Before any module writes to a `core` object, check the matrix. If a module needs a field it does not own, it does so only through the owning module's action/event — never by direct write." "When this conflicts with any module's Master Document, this wins for cross-module concerns."

**Cross-cutting rules:**
- **A.** Status split — each object has `identity_status` (Core) + module-specific status fields; "never let two modules write one status field."
- **B.** Money — one owner per number, integer cents suite-wide, **pinned at time-of-use** (consumer copies, never reads live) "so historical cost/margin never silently changes."
- **C.** Creation authority — any module may create; owner vets (new record enters **provisional** until validated; e.g., Projects-created vendor `w9_status=missing`/unapproved until Books clears).
- **D.** Deactivation — soft-delete only; only identity owner flips `identity_status`; never hard-delete a `core` object referenced by posted data.
- **E.** Numbering owners: job # → Projects; estimate/quote → Projects; **invoice #, bill #, journal-entry #, internal-invoice # → Books.**
- **F.** Temporal — every cross-module financial event respects `fiscal_periods` status; landing on CLOSED/LOCKED is rejected by Books; originator queues/flags.

**core.jobs (two-number model):** identity (id, location_id, department_id, customer_id, name, archetype, identity_status) → Core; operational status/phases/schedule/change-orders → Projects (in `proj_` tables; owned by Books only until Module 2); budget/recognized-cost/WIP accounting cols → Books; rev-rec INPUTS (contract value, cost estimate, physical % complete) → Projects authors, Books pins; rev-rec OUTPUTS (recognized rev, WIP cost, deferred) → Books; `revenue_account_id` (FK→public.accounts) → Books ("Projects never writes it"); GL lines carrying job_id → Books ("Projects never writes GL"). **Method resolution per job:** per-job override (`core.jobs.rev_rec_method_override`) → per-revenue-type (`public.revenue_type_methods` via `revenue_account_id`) → company default (`core.locations.rev_rec_method`) → legacy `job_type`/`archetype` map. **Cost flows Books→Projects; billing flows Projects→Books; Books is the sole cost processor/originator.**

**core.customers:** identity Core; pipeline_status/source → Projects; payment_terms/credit_limit/AR standing/opening AR → Books.
**core.items:** identity Core (thin); default_unit_cost/default_price, income/cogs accounts → Books; UOM/serialization/lot/on-hand/valuation → MeritInventory (reserved — do NOT build now).
**core.employees:** identity Core (thin; `clerk_user_id` is the canonical suite user reference); default_labor_rate/billing_rate/payroll_account_id → Books (until MeritHR); time entries → Projects; benefits/certs/full payroll → MeritHR (reserved); **payroll/bank PII (SSN, bank acct, withholding) → provider + Core secret store, NEVER an app table** — "do not let money-movement work annex payroll PII the matrix reserves for MeritHR."
**core.vendors:** identity Core; default_account/class/department, is_1099/tin_encrypted/w9_status/payment_terms/hold → Books; subcontractor/PO → Projects.
**core.departments:** identity Core; internal_charge_method/gl_classification → Books.
**core.locations (= entity/company):** identity Core ("`location_id` is the entity dimension carried throughout the suite"); rev_rec_method/minimum_cash/default_internal_charge_method/accounting config → Books.
**core.organizations (tenant):** RLS root; Books-owned config; **entitlements Suite-Core-owned.**

**Invoices — two objects, never one dual-edited record:** billing request/draw (draft) → Projects (`proj_`, no GL); on approval → billing event; issued invoice (`invoices`+`invoice_lines`) → **Books only** (mints number; "Projects never edits it"). Posted to AR → never edited in place; corrections = credit memo/adjustment or void-and-reissue if unpaid.

## FILE 3 — merit-suite-event-gl-posting-contract.md (FROZEN v3)

"**FROZEN.** Both sides build to this exactly. Neither session redefines these shapes or field names." Money = integer cents, pinned at time-of-use. "Where this and the Matrix overlap, the Matrix governs ownership, this governs wire shape and behavior."

**Direction & boundary (non-negotiable):** Cost Books→Projects (`JOB_COST`); recognition inputs Projects→Books (`JOB_PROGRESS`); billing Projects→Books (`JOB_BILLING`). "No module reads another module's tables. The seam is `core.events` + each side's typed action." "Projects never writes GL / never posts costs / never edits an issued invoice."

**JOB_COST (Books→Projects):** event_id, event_type, source_module:"BOOKS", org_id, location_id, job_id, department_id?, cost_type: LABOR|MATERIALS|SUBCONTRACTOR|EQUIPMENT|OTHER, amount_cents, occurred_on, lifecycle: PENDING|CLEARED|VOIDED, gate: PAYABLE_APPROVAL|BANKFEED_CATEGORIZATION|TIMESHEET_PAYROLL, source_ref (key on this, not event_id), gl_entry_id?, memo. "One row per lifecycle transition, each with its own event_id, all sharing source_ref. Never sum transitions."

**JOB_BILLING (Projects→Books):** event_id, source_module:"PROJECTS", org_id, location_id, job_id, billing_type: MILESTONE|PROGRESS|TIME_MATERIALS|DRAW, occurred_on, source_ref, memo, lines:[{description, amount_cents, item_id?}]. Books creates invoices+lines, mints number, posts AR + revenue/deferred, returns invoice_id/number on the processed event. **Defer-vs-recognize:** POINT_OF_SALE/AS_BILLED recognize at billing (credit Revenue); all other methods defer (credit **Deferred Revenue 2410**).

**JOB_PROGRESS (Projects→Books, v3):** snapshot keyed by job_id (self-heals on next snapshot; Books upserts). Fields: trigger CONTRACT_SET|CHANGE_ORDER|PROGRESS_UPDATE, contract_value_cents, cost_estimate_cents, pct_complete (null when not physical-% method), occurred_on, source_ref. Books pins the three inputs, recognizes per resolved method, rejects on closed/locked period. "Books does not author these values."

**Gating:** payables → approval → PENDING until approved; bank-feed → categorization (no approval) → CLEARED ("cash already left"); labor → timesheet+payroll approval → CLEARED.

**DDL (deployed):** `core.events` append-only, RLS `org_id=get_org_id()`, unique `(org_id,event_id)`, status ∈ pending|processed|rejected, cols include gl_entry_id, invoice_id, error, processed_at. `gl_entry_lines.job_id` (FK→core.jobs). "New event types reuse the existing `core.events` table; `event_type` distinguishes them."

**Standalone:** Books without Projects = fully functional ledger (sets job_type directly, keys rev-rec inputs directly into core.jobs, never reads a proj_ table). "Never make a `core` capability depend on the other module being installed."

## FILE 4 — merit-suite-identity-access-model.md

Owned by Suite Core; "authoritative for who may access the suite and what they may touch."

**Two business models, one access model:** white-label (users belong to one org) and Merit-managed (staff hold memberships across many client orgs).

**Roles:** **System Admin** (platform flag, the only cross-org role — create orgs/users, assign any role); **Org Admin** (per org — invite, assign org roles, settings); **Accounting User** (Books surfaces per permissions, may span orgs); **Business User** (Projects surfaces). "System Admin is a platform flag, not a membership."

**Core objects (new, Core-owned):**
- **`core.users`** — id (uuid), `clerk_user_id` (text, unique, "the canonical suite user reference"), name, email, `is_system_admin`, status. "Clerk owns authentication, `core.users` owns the suite-side profile." **Distinct from `core.employees`** ("A user logs in; an employee is a labor resource. They may link via `clerk_user_id` but need not").
- **`core.memberships`** — user_id × organization_id × role + status (active/invited/suspended). One user → many memberships.
- **`core.invitations`** — email, org, role, invited_by, status, token. Accepting creates users(if new)+membership.
- **`core.roles` / permission definitions** — "Kept in Core so every module reads the same definitions."

**Access resolution (rules that must hold):** company toggle = membership list; "**RLS must enforce membership, not just org match**" (`get_org_id()` returns selected org AND system verifies active membership; a user must never set context to an org they're not a member of; system admins bypass via flag). "What a user sees within an org = (org entitlements) ∩ (user role permissions)." "Modules gate their surfaces by role but never own the access decision."

**Per-module onboarding:** performed by a designated onboarding rep per module; status per (organization × module); core-master imports assigned individually per (organization × core object) by System Admin; dependency sequencing enforced.

**New-tenant runbook (order):** create org → set entitlements → seed COA (real idempotent path, incl. AR/Deferred/Unbilled) → generate fiscal periods from `fiscal_year_start_month` ("periods are a product of setup, never auto-created at posting") → create first Org Admin via invitation → designate per-module reps + assign imports → each rep runs wizard → hand off.

## FILE 5 — merit-suite-seeded-test-tenant.md

A repeatable, COA-complete tenant exercising the full cross-module chain, **created through the real onboarding/seeding path** (not a one-off script). "Reset = re-run the idempotent seed."

- One org (e.g. `Sandbox Co`), `entitlements={"projects": true}` → Books auto-fed mode.
- ≥2 `core.locations` (one with a non-January `fiscal_year_start_month`); ≥1 closed/locked period (to test the Rule F rejection path).
- COA seeded via real path (**currently 137 accounts, accepted as-is**). "**Reference accounts by role, not by hard-coded number (the chart is 137, not 251). This is a standing guardrail for every module.**"
- Core masters in `core`: 2–3 customers (≥1 meeting JOB_BILLING preconditions), 1–2 vendors, a few items, 1–2 employees, departments.
- Jobs spanning both recognition methods: Job A POC (receives % complete), Job B completed-contract/POS (JOB_PROGRESS inputs ignored), optional Job C per-job override.
- **Round-trip completion criterion:** cost path (Books originates → GL posts with job_id → JOB_COST PENDING→CLEARED reaches Projects, no double-count) + recognition path (JOB_PROGRESS → Books pins+recognizes per method) + billing path (approve draw → JOB_BILLING → Books issues invoice, mints number, writes invoice_number back onto the `core.events` row) + rejection path (event onto closed period → rejected with reason). "The seam is proven only when a real event completes each path. Code-level 'verified in isolation' does not count."

---

### Constraints that constrain building MeritBooks (summary)
See `CANON-ANCHOR.md` §2–3. Key additions from these contracts: reference `core` rows by FK never copy; write only fields you own; money one-owner-per-number pinned at time-of-use; identity_status vs module status never shared; numbering owners fixed; respect period status on every event; event contract FROZEN v3; AI gateway Core-owned metered/capped; provider connections Core-owned (`secret_ref` only); money-movement authorization Books-owned but must reconcile to `core.memberships/roles`; payroll PII never in an app table; access = entitlements ∩ role, RLS enforces membership; reference accounts by role not number (137 not 251).
