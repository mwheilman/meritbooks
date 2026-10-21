# Merit Projects v2 — Rebuild Blueprint

**Status:** binding build plan for the full teardown + rebuild of Merit Projects (`apps/projects`, schema `proj` → `pm`).
**Date:** 2026-10-20. **Author:** Projects lead session (synthesis of 9 industry research reports + 5 MeritBooks deep reviews).
**Inputs (all in the claude.ai Project, `claude/meritprojects-research-0[1-9]-*.md`, and `/home/claude/review/0[1-5]-*.md` at authoring time):**
industry surveys (commercial, residential, field service, manufacturing/ETO, flooring + interior design, dealers + RE development,
horizontal PM + AI, onboarding UX, accounting integration) and Books reviews (shell/design/IA, identity/onboarding, money seam, AI layer, schema/teardown).

---

## 0. The product in one paragraph

Merit Projects is the operations half of the Merit Suite: one project-management engine that **becomes the right product for
each industry** through declarative **industry packs** (commercial GC, specialty trade, residential remodel, home builder,
field service, ETO manufacturing, flooring, interior design, equipment dealer, real-estate development, professional services,
general). A new customer describes their business in one sentence (or picks a tile); the system proposes a configured
workspace — job types, stages, cost codes, billing modes, vocabulary, modules — they confirm it, and they are looking at a
real job in under three minutes. Every financial fact flows to MeritBooks through the frozen event seam, so job cost ties to
the GL **by construction**: cost is entered once, invoices have one owner (Books), and nothing is double-billed.

## 1. Binding decisions (made by the lead; recorded here so no agent re-litigates them)

| # | Decision | Why |
|---|---|---|
| D1 | **New schema `pm`** (migration band **1100–1199**); legacy `proj` stays read-only until cutover, then `DROP SCHEMA proj CASCADE` after one close cycle. `1008–1099` reserved for legacy hotfixes. | Function bodies hard-code `proj.`; clean grant baseline; single exit. Canon amendment: "Projects owns schema `pm`". |
| D2 | **`core.jobs` stays the one job master**; `pm.projects` is a 1:1 extension keyed by `job_id` with composite FK `(org_id, job_id) → core.jobs(org_id, id)`. | Books FKs (GL lines, invoices, bills, rev-rec) all target `core.jobs`. |
| D3 | **Industry packs are code-authored, versioned, declarative manifests** in `packages/industry-packs` (pure TS + Zod, no DB). Merit publishes packs; tenants change behavior only through **override deltas**. Install scope = **(org, company)**: one primary pack + optional add-on packs per company. | Packs configure; they never invent schema. Holding-group tenants mix industries per company. |
| D4 | **AI configures within pack rules**: rules classifier first (tiles, NAICS, keywords), AI second via the Core gateway with a **forced tool** whose `pack_id` is an enum of the catalog; a **deterministic compiler** produces the workspace plan; the user approves; an idempotent apply runs. AI-down = same flow, rules only. | Canon §3: AI proposes facts, deterministic engine acts, human approves. |
| D5 | **Design = Merit Suite Style Guide v2.3, verbatim**, via a new shared package `packages/merit-ui` (kit `system.css` copied byte-for-byte + Next adapter + strict Tailwind preset + React shell/primitives). Projects is the first consumer and is strict from day one (no emerald, no radius, no mono, no lucide, no "portfolio"). | The prior re-skin was rejected because it swapped colors without changing structure. Rebuild structure. |
| D6 | **Shell grammar identical to Books**: rail (Merit Projects lockup, text links + counts) · bar (⌘J context chip, crumbs, ⌘K, sync) · ctxline · page. Contexts: workspace / company / consolidated. **A job is a page object, never a context.** ⌘K = jump + ask (typed questions route to NL). ⌘J popover carries a "Products" group to hop to Books. | One switcher; same muscle memory across the suite. |
| D7a | **Customers and vendors: one shared master** (`core.customers`, `core.vendors`) — no sync, both apps read the same row. Projects creates them through definer fns (`pm.create_customer`, `pm.create_vendor`, 1108; vendors provisional with W-9 MISSING); Books owns terms, credit, tax/1099 and compliance. | Owner question 2026-10-21. |
| D7 | **One owner per object** (table in §5). Projects owns operational objects (projects, stages, tasks, estimates-for-jobs, budgets by cost code, change orders, job commitments, SOV/pay-app drafts, time capture, field records). Books owns money (invoice #, AR, AP, GL, tax, payroll, inventory valuation, deposits, rev-rec outputs). | Native integration guarantee #1. |
| D8 | **Seam**: keep frozen v3 (`JOB_COST` in; `JOB_BILLING`, `JOB_PROGRESS` out). `billing_type` on the wire stays within `MILESTONE|PROGRESS|TIME_MATERIALS|DRAW`; subtype (SOV, RETAINAGE_RELEASE, ALLOWANCE, RECURRING) rides an additive `billing_subtype` key + `schema_version`. New request events (named, never reshaped): `JOB_COMMITMENT`, `JOB_PAYABLE_REQUEST`, `JOB_TIME`, `JOB_MATERIAL`, `JOB_DEPOSIT_REQUEST`. Books stays the **sole JOB_COST originator**. | Research 09 + review 03. |
| D9 | **Labor (OWNER RULING 2026-10-21):** **direct labor job cost = payroll + payroll burden** (employer taxes, workers' comp, benefits) — never overhead. **Estimating labor rate = pay rate + payroll burden + overhead allocation**, used only for bids in Projects; overhead is recovered in **gross margin**, never charged to a job. The retired Books overhead-allocation engine stays retired. Projects pins a cost rate (pay × (1+burden)) on approved time (`pm.approve_time_entries`, 1108) and emits `JOB_TIME` hours; Books costs labor from payroll + burden. Budgets/cost estimates sent to Books exclude overhead. | Owner ruling. |
| D10 | **Stage machines** are pack data; transitions are guarded by a **closed vocabulary of SQL predicates** (`pm.guard_<name>`), packs select/order guards, never inject expressions. Stage → `core.jobs.status` via a definer function (Projects is the job-identity creator). | Safe configurability. |
| D11 | **Extension fields hybrid**: money/seam/guard/KPI data = real columns; descriptive industry attributes = `ext jsonb` validated against `pm.field_defs`; promoted fields get expression indexes. Never per-tenant DDL. | Reportable without sprawl. |
| D12 | **Security baseline** for every `pm` object: RLS `USING + WITH CHECK (org_id = public.get_org_id())`; definer functions start with an org guard; `REVOKE EXECUTE … FROM PUBLIC, anon`; money/approval state changes only through definer functions (UPDATE on state columns revoked). | The live `proj` had PUBLIC-executable definer fns (fixed in 1007). |

## 2. Industry packs

### 2.1 Engine archetypes (fixed vocabulary)
`project` (contract jobs with phases) · `field_service` (dispatchable work orders) · `eto` (engineer-to-order production) ·
`retail_order` (sell + install orders) · `engagement` (fee-based services) · `recurring_service` (agreements/memberships) ·
`development` (RE projects with lots/units + lender draws) · `dealer_service` (repair orders on serialized units).

### 2.2 Modules (engine features a pack toggles)
estimates · budget (cost codes) · schedule (tasks + dependencies) · change_orders · commitments (POs/subcontracts) ·
billing (modes: fixed, progress %, SOV/pay-app, milestone, T&M, draw, deposit, recurring) · retainage · allowances ·
selections · daily_logs · punch_warranty · time · dispatch · service_agreements · assets (serialized equipment) ·
production (routings/work centers/operations) · procurement_markup (designer client POs) · lots_units · lender_draws ·
rfis_submittals · compliance (COI/lien waivers) · documents · client_approvals.

### 2.3 The packs (v1)

| Pack | Primary archetypes | Signature modules & vocabulary | Billing default | Portfolio fit |
|---|---|---|---|---|
| `general` | project, engagement | budget, schedule, time, documents | fixed / milestone | any |
| `commercial_gc` | project | SOV/pay-app (AIA G702/703), retainage, commitments (subs), COs (PCO→COR→CO), RFIs/submittals, daily logs, compliance (COI, lien waivers), CSI MasterFormat cost codes | SOV progress | commercial construction |
| `specialty_trade` | project, field_service | T&M tickets, pay apps to GC, retainage receivable, labor productivity by cost code, crews | SOV / T&M | electrical/mechanical/concrete subs |
| `residential_remodel` | project | selections + allowances, deposits, client approvals, design phase, schedule, COs with client e-sign, warranty/punch, NAHB-style cost codes | deposit + milestone draws | AIM, Crystal K&B, Revived |
| `home_builder` | project, development | plans & options, lots, draw schedules, purchase orders to trades, warranty, selections | lender draws / closing | Artistry Homes |
| `field_service` | field_service, recurring_service | dispatch board, work orders, flat-rate price book, service agreements/memberships, assets (equipment at site), truck stock, tech time | per-visit invoice / recurring | Dorrian, Heartland, Metro HVAC |
| `manufacturing_eto` | eto | quote → engineering → BOM/cut list → routings & work centers → production operations → install; materials issue; shop-floor time by operation | deposit + progress/milestone | Iowa Custom Cabinetry |
| `flooring` | retail_order, project | measure appointment, product selection (dye lot), material order + receive, install scheduling, remnants, labor by sq ft | deposit + balance | Heritage Interiors |
| `interior_design` | engagement, retail_order | design fee (hourly/fixed/% of purchases), client proposals per item, procurement with markup, receiving/warehouse, install day, client approvals | retainer + item proposals | Wild Rose, Revived (design) |
| `equipment_dealer` | dealer_service | repair orders on serialized units, PDI, warranty claims (OEM payer), parts issue, tech flag-rate time | RO invoice; OEM warranty claim | Clive Power Equipment |
| `real_estate_development` | development | entitlement/permit stages, budget by line (hard/soft costs), lender draws with inspection, lots/units, investor reporting | lender draws | Swan Creek SPEs |
| `professional_services` | engagement, recurring_service | phases/deliverables, time & expense, retainers, budgets by role | T&M / fixed / retainer | agencies, consultants |

Each manifest contains: identity (`key`, `version`, `extends`), classifier inputs (NAICS prefixes, weighted keywords, tile),
archetypes, `vocabulary` map, `modules`, `jobTypes[]` (key, label, archetype, billing modes, progress basis, stage machine,
rev-rec **hint** only), `stageMachines[]` (stages with `core_status`, transitions with named guards and approval policy),
`costCodes[]` (code, name, cost_type, parent, account **role** hint), `fieldDefs[]`, `priceBook[]` (optional starter), `kpis[]`,
`docTemplates[]` (keys only in v1), `questions[]` (3–5 follow-ups with typed answers + deterministic effects), `paramsSchema`,
`aiProfile` (tone, what to watch for), and `sampleJob` (one realistic job used for the "aha" in onboarding).

Golden-snapshot tests per pack: manifest validates; compile(manifest, defaults) is stable; every stage machine is reachable and
terminates; every cost code has a valid cost_type; no account numbers anywhere (roles only); vocabulary covers the base keys.

## 3. Onboarding (≤ 4 answers, < 3 minutes to a configured workspace, < 10 minutes to "aha")

The "aha" = a real job visible with its budget and at least one financial fact flowing to Books (e.g., a deposit request).

1. **Front door (shared with Books).** Sign in once. If the user's org already has Books, everything Books knows is inherited:
   companies, customers, vendors, COA roles, team. A standalone Projects signup creates the org + first company through the
   same path Books uses.
2. **"What kind of work does {Company} do?"** — tiles for the 12 packs + a free-text line ("We build custom cabinets and install
   them") + prefilled guess from Books (company industry, rev-rec method, existing jobs). One screen per company that runs jobs
   (auto-skipped when there's one company; companies without jobs are unchecked).
3. **"Here's your workspace."** Preview cards from the compiled plan: job types, stages, cost codes (count + sample), billing,
   modules on/off, vocabulary ("We'll call them Work Orders"). Each card has a toggle/edit. 2–3 pack follow-up questions
   appear inline, prefilled when AI found evidence (badged "Suggested from your description" with the quoted phrase).
   **Confirm** applies the plan in one transaction.
4. **"Bring your work."** Tiles: *Jobs already in Books* (shown as done if present) · *Drop a file* (Buildertrend / JobTread /
   simPRO / Innergy / RFMS / spreadsheet export → column auto-map, AI only for unmapped headers) · *Start with a sample job*
   (from the pack, clearly labeled sample, one-click remove) · *Start fresh*.
5. **"Who runs the work?"** (optional) — invite PMs/supers/techs by email or phone; role defaults from the pack.
6. **Land on Home** with the first job open in the side panel and a one-line next step ("Send the deposit invoice — Books will
   number it and post it").

State is stored in `pm.onboarding_runs` (per company) and `core.organizations.onboarding_state.projects` (summary flag).
Every step is resumable; the control-tower pattern (board O-control-tower) shows multi-company progress.

## 4. Information architecture (Merit Projects)

**Workspace rail:** Home · Inbox · **Work:** Jobs · Schedule · Approvals · **Insights:** Margin by job · Backlog · Compare companies ·
Onboarding · Settings.

**Company rail** (entries gated by installed modules — e.g., Dispatch only for `field_service`, Production only for `eto`):
Home · Inbox · To review · **Sell:** Leads · Estimates · **Jobs:** Jobs · Change orders · Selections · **Field:** Schedule · Dispatch ·
Work orders · Daily logs · Time · **Make:** Production · **Buy:** Commitments · Subcontractors · **Bill:** Billing · Retainage · Draws ·
**Cost:** Job cost · WIP (read-only Books view) · **Controls:** Activity · AI decisions · Settings (pack, stages, cost codes, fields).

**Job page** (page object): header (number · name · customer · stage pip + word · PM) + ctxline (contract // cost to date //
projected margin // next billing) + tabs driven by modules: Overview · Budget · Schedule · Change orders · Commitments · Billing ·
Selections · Logs · Time · Documents · Activity.

**Homes by role** (density by role): PM / estimator / scheduler / coordinator = `.density-cockpit` work board (S1 pattern:
primary widget top-left 8/12 = "Needs you", jobs at risk, billing due, approvals); owner / ops leader = `.density-report`
(S6 pattern: margin by job, backlog, cash by job, statement with notes). No KPI-card strip, no banner, every figure has a
comparison and a destination.

## 5. Object ownership (one master each)

| Object | Owner | Mechanism |
|---|---|---|
| Job identity, number | Core (Projects creates) | `core.jobs`; `pm.projects` extends |
| Job status | Projects (stage machine) | definer fn maps stage → `core.jobs.status` |
| Contract value, EAC, physical % (rev-rec **inputs**) | Projects authors; Books pins | `JOB_PROGRESS` (+ `as_of_date`, `snapshot_version`, `pending_co_value_cents`) |
| Rev-rec method/outputs, WIP, 1180/2410 | Books | read model |
| Estimates for jobs, proposals | Projects (`pm.estimates`) | Books `public.estimates` remains for non-job quotes |
| Budget by cost code, cost codes | Projects (`pm.cost_codes`, `pm.budgets`) | totals via `JOB_PROGRESS.cost_estimate_cents`; future `core.cost_codes` promotion |
| Change orders | Projects only (`pm.change_orders`) | contract delta via `JOB_PROGRESS` |
| Job commitments (POs, subcontracts, CCOs) | Projects when entitled | `JOB_COMMITMENT` (non-posting) → Books AP match targets |
| SOV / pay-app drafts / billing requests | Projects | `JOB_BILLING` |
| Invoice #, AR, tax, terms, payments | Books | ack-in-place on `core.events` |
| Deposits (2420) | Books | `JOB_DEPOSIT_REQUEST` |
| AP bills, approval, payment, 1099 | Books | `JOB_PAYABLE_REQUEST` in, `JOB_COST` out |
| Time capture & approval | Projects | `JOB_TIME` |
| Labor cost, payroll | Books | `JOB_COST` LABOR |
| Inventory on hand / valuation | Books (until MeritInventory) | `JOB_MATERIAL` (issue/return) |
| Field records (logs, punch, RFIs, selections, work orders, dispatch, assets, production ops) | Projects | — |
| Documents | shared `public.documents` + bucket (Core carve later) | `pm.document_links` |

## 6. Data model (`pm`, migrations 1100+)

- **1100 `pm_foundation`** — schema, grants baseline (no PUBLIC execute), `core.jobs unique(org_id,id)` (shared-spine,
  additive), packs (`pack_registry`, `pack_installs`, `pack_overrides`), materialized config (`job_types`, `stage_defs`,
  `stage_transitions`, `field_defs`, `approval_policies`, `vocabulary` via resolved manifest), `onboarding_runs`, job spine
  (`projects`, `wbs_nodes`, `tasks`, `task_deps`), money-adjacent (`cost_codes`, `budgets`, `budget_lines`, `contracts`,
  `change_orders`, `progress_snapshots`), operations (`field_logs`, `punch_items`, `time_entries`, `document_links`, `activity`).
  Definer functions: `pm.apply_pack_plan(plan jsonb)`, `pm.create_project(...)` (creates `core.jobs` + `pm.projects` atomically,
  mints job number), `pm.transition_stage(job, to_stage)` (guards + core status), `pm.emit_job_progress(job, trigger)`.
- **1101 `pm_commitments_billing`** — `commitments`, `commitment_lines`, `commitment_changes`, `receipts`, `sov_versions`,
  `sov_lines`, `billing_requests`, `billing_request_lines`, `retainage_ledger`, `allowances`, `selections`, `billing_links`;
  fns `approve_change_order`, `approve_commitment` (+ `JOB_COMMITMENT`), `generate_billing` (by mode), `approve_and_emit_billing`.
- **1102 `pm_cost_drain`** — `job_costs` projection, `job_cost_applied_events`, `event_cursor`, `drain_job_costs(org)`
  (service_role; replayable), `rebuild_job_costs(org)`, views `v_job_financials` (contract, revised, committed, actual, projected,
  billed, retainage, margin), `v_cost_code_status`.
- **1103 `pm_field_service`** — `work_orders`, `dispatch_assignments`, `crews`, `crew_members`, `skills`, `service_agreements`,
  `assets`, `price_book_items`, `stock_locations`, `material_moves`.
- **1104 `pm_production`** — `work_centers`, `routings`, `routing_steps`, `wo_operations`.
- **1105 `pm_development`** — `draw_schedules`, `draws`, `lots` (WBS LOT nodes by default; child jobs optional).
- **1110 `pm_migrate_from_proj`** (preserve UUIDs + `source_ref`) → **1120 cutover** (atomic drain switch) → **1199 drop proj**.

## 7. Seam work (both sides)

Projects side (this workstream): `pm` emitters for `JOB_PROGRESS` (as_of_date = period end the PM chose), `JOB_BILLING`
(frozen type + `billing_subtype`, `retainage_cents`, `schema_version`), `JOB_COMMITMENT`, `JOB_DEPOSIT_REQUEST`; drain for `JOB_COST`;
reconcile writeback; scheduler (Vercel cron hitting a service-role route guarded by `EVENT_WORKER_SECRET`); pending-age alarm.

Books side (must land before real traffic — coordinated, path-scoped, behind tests G1–G16 in review 03):
JOB_BILLING consumer re-platformed onto `createInvoice` (role-based AR, tax, retainage gross-up, `invoices.source_ref` unique,
atomic claim), RETAINAGE_RELEASE = reclass only, one rev-rec resolver in canon order, derive actual cost/billed-to-date from GL,
`job_progress_snapshots` pinning, JOB_COST carries `cost_code_id` + `commitment_line_id`, inventory/JE/expense job postings emit
JOB_COST, block job-tag edits in HARD_CLOSE, close step checks seam backlog, consumers for the new request events.

## 8. AI in the product

- **Configurator** (onboarding §3) — recipe `industry-configure`, feature `PROJECTS_PACK_CONFIGURE`, decision row in `ai_decisions`.
- **Intake** — drop any export; rules + column auto-map first, AI only for unmapped headers and cost-code matching against the
  installed pack's closed list.
- **Daily briefing + Ask** — deterministic facts (margin fade, over-budget cost codes, unbilled completed work, stale logs,
  expiring compliance, aging retainage, schedule slip) phrased by the model; NL questions answered from an allowlisted metric
  catalog with keyword fallback. All AI rendered as auditor's notes (claim · evidence that sums · basis/confidence · actions).
- **Graceful AI-down** everywhere ("AI assist paused" note; rules path continues). Projects never holds an Anthropic key in
  code paths outside the Core gateway helper.

## 9. Build waves

| Wave | Scope | Exit criteria |
|---|---|---|
| **A — Foundation** | `packages/merit-ui`; `packages/industry-packs` (12 manifests, classifier, compiler, tests); migration 1100; new `apps/projects` shell + onboarding (§3) + Home + Jobs list + Job page (Overview/Budget/Schedule/COs/Activity) | A new tenant can onboard any of the 12 industries and see a configured workspace with a sample or real job; Vercel READY; security review GO |
| **B — Money spine** | 1101/1102; estimates → budget; COs; commitments; billing by mode incl. SOV + retainage + deposits; drain + reconcile + scheduler; job financials (the four numbers: contract · committed · actual · projected) | Seam round-trip proven on the seeded tenant: deposit + progress bill post in Books, a Books bill flows back as JOB_COST against the right cost code |
| **C — Industry modules** | dispatch/work orders/agreements/assets (field service); production (ETO); selections/allowances (residential, interior, flooring); draws/lots (RE, builder); repair orders (dealer) | Each pack's signature workflow works end to end |
| **D — Books seam hardening + new events** | §7 Books side; JOB_TIME/JOB_MATERIAL/JOB_PAYABLE_REQUEST consumers | Tests G1–G16 green |
| **E — AI depth + cutover** | intake, briefing, Ask, detectors; migrate `proj` → `pm`, cutover, soak, drop | `proj` dropped; handoff written |

## 10. Open items for Mike (do not block the build)

1. ~~Ratify D9~~ — RULED 2026-10-21 (see D9).
2. Domains — RULED 2026-10-21: `projects.meritmgt.com` (meritbooks-projects) and `books.meritmgt.com` (meritbooks-web); added in Vercel, DNS CNAMEs pending at GoDaddy. Clerk production on `meritmgt.com` makes the session carry across both.
3. Apply migration **154** (identity/control write lock): the Supabase tool asks for confirmation of destructive statements; it
   timed out unattended on 2026-10-20.
4. Vercel Deployment Protection on `meritbooks-projects` (currently SSO wall).
5. Duplicate tenant `eb3d8087…` cleanup.
