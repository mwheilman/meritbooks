# 08 — Onboarding & Migration v2 Spec ("connect or drop what you have; we build your books; you prove them")

**Status:** DRAFT for owner review · authored 2026-10-18 · governs every onboarding, import, migration and
connector-facing build from here on. It is **v2 of `docs/FPB-onboarding.md`**: every v1 principle and target
stays, and this doc extends them to three audiences, many clients, field/ERP systems, history, shadow close
and certification. Where they conflict, this doc wins for onboarding UX and FPB-onboarding §5 contracts stay
binding until replaced by §4 below.

**Inputs (binding order):** owner directive (`00-OWNER-DIRECTIVE.md` + the onboarding asks quoted in §0.1) →
`docs/canon/CANON-ANCHOR.md` → `IA-SPEC.md` (account model, contexts, M-1…M-10) → `05-RBAC-SPEC.md`
(capabilities, assignments, R-1…R-14) → `04-CAPABILITY-MAP.md` (ONB-*, INT-*, BNK-08) →
`06-EXISTING-UI-AUDIT.md` (duplicates) → `03-CODE-INVENTORY.md` → the code under `app/(app)/onboarding/**`,
`app/api/onboarding/**`, `lib/onboarding/**`, `lib/companies/**`, `lib/integrations/erp/**`.
**Sibling:** `07-INTEGRATIONS-PLAN.md` (being written concurrently) owns the **connector framework**:
auth, transport, rate limits, webhooks, per-system API realities and the connector registry. This doc owns
the **wizard side of the contract** (§4): what every connector must hand the wizard so it can plug into
*connect → preview → map → import → tie out* without new UI.

**Canon guardrails this doc never bends**
- MeritBooks **owns the GL**. QuickBooks / Xero / Sage / NetSuite are **one-time migration sources**. We
  read them; we never write back; we never "sync" a ledger.
- Field/ERP systems (ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems, …) are **operational
  systems**. Onboarding backfills from them and then leaves them connected as **ongoing feeds of business
  documents** (jobs, invoices, costs) into the book of record. They are never a second ledger.
- **AI proposes facts** (a mapping, a document type, a duplicate pair, a department). The **deterministic
  engine** does the accounting. A **human approves**. AI never sees or authors a balance during conversion
  (already true in `lib/onboarding/mapping-ai.ts`; keep it).
- Money is bigint cents. Accounts are referenced by **role**, never by number. Account types are ASSET,
  LIABILITY, EQUITY, REVENUE, COGS, OPEX, OTHER.
- No word "portfolio" in product or code going forward (IA §3.7). A managed company is a **client**.

---

## 0. Decisions on one page

1. **One migration object per client.** Every client being brought on gets a `migration_project` with a
   cutover date, a history depth, its sources, a lead and a reviewer, and a stage. Everything else (pulls,
   mappings, tie-outs, the certificate) hangs off it. Today the state is scattered across
   `ai_decisions` JSON sessions, `locations.onboarding_status` and `organizations.onboarding_state`.
2. **Three journeys, one spine.** Platform admin provisions the tenant (O1). Tenant admin / accounting
   manager sets up the tenant (O3–O9). The accounting team migrates each client (O10–O24). All three share
   the same delegate, resume and proof mechanics.
3. **Every source plugs in through one five-verb contract**: `connect → discover (preview) → pull (stage)
   → map → tie-out`. A connector that can't provide **control totals** can't certify. Every system gets
   at least a **guided-export recipe** on day one, so "as many ERPs as we can integrate with" means
   *every* system has a path, and API connectors upgrade the path without changing the UI.
4. **Staging is not the books.** Pulled and dropped data lands in staging with full source references.
   Nothing touches the GL until a human approves a mapped, tied-out run. Every posted run can be undone
   with reversing entries until go-live.
5. **History has three depths:** *Opening balances only* · *Monthly history* (default: current fiscal
   year to date + the prior full fiscal year, posted as one summary entry per month) · *Detail reference*
   (transaction-level history kept read-only for drill-down and used to **teach vendor memory**, never
   posted twice).
6. **Mappings are a tenant asset, not a session artifact.** An approved mapping on Client A is proposed
   on Client B. Firms can migrate many clients onto **one tenant standard chart + dimensions**. That is
   how Merit finally gets a universal chart without re-keying.
7. **Dimensions are inferred, not configured.** Departments, jobs and classes are proposed from the source
   data (QBO classes/locations, sub-customers, account-name suffixes, field-system business units and job
   lists), with evidence counts. The human accepts.
8. **Preflight before mapping.** The moment a source connects, a data-quality preflight runs and reports
   problems in dollars and plain English. The QBO preflight (6 checks) becomes a generic library of 24.
9. **Proof is the product.** Three proofs, in order: the **tie-out grid** (month × account, source vs
   MeritBooks, every cell zero), the **independent ties** (bank, loans, AR/AP, WIP, payroll and sales-tax
   liabilities against outside evidence), and the **shadow close** (the first month closed in MeritBooks
   and diffed against the old system). Together they produce the **Conversion Certificate**.
10. **Reversible until go-live, controlled after.** Before the certificate: undo any run, reset a
    client's migration, nothing in the old system changes. Issuing the certificate hard-closes the
    pre-cutover periods. After that, rollback means a controller-approved reopen with reversing entries
    and a superseding certificate.
11. **Many clients are one motion.** The **Migration Control Tower** (`/clients/onboarding`, the IA's
    "Onboarding tracker") runs waves of clients with bulk actions, shared cutover dates and shared mapping
    sets. Its stages run Plan · Connect · Preflight · Map · Tie-out · Shadow close · Certified · Live.
12. **Buy-in is designed, not hoped for.** Accounting teams get side-by-side old-vs-new reports,
    "where did this number come from" on every figure, a no-write-back promise, rollback, learning by
    doing on their own client's real data, and a **"What changed for my workflow"** page for each role.
13. **Five ways to add a company and four ways to import a TB collapse to one each** (§13).

### 0.1 Owner asks this spec must satisfy (traceability)

| Owner ask | Where |
|---|---|
| "The most useful tool ever … seamless so we have buy-in from accounting teams" | §2, §12, AC-B* |
| Link to ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems "and as many ERPs as we can" | §4, §5.3, §9, catalog fix §1.3 |
| Corporate docs: EIN, articles, operating agreement | §5.2 T2, §11.1, O13 |
| Loan agreements | §10.5 continuity, O18 |
| WIP schedule | §9.4, O18, tie-out §10.3 |
| General ledger | §4, §10 (history depth) |
| Customer database / CRM | §5.3 (sources), §9 |
| Budgets | §10.5, O18 |
| Expense policies | §11.4, O7 |
| Org chart → approval chains | §11.3, O6 |
| Linking email accounts for payables parsing | §11.5, O8 |
| "Easiest onboarding in the world"; "most comprehensive system on the market" | §2 targets, §14 |

### 0.2 Illustrative proof case: the first tenant

Merit Management Group is a `firm` tenant (IA Q1). Its clients are exactly the hard case this spec has to
handle. Per Merit's own tech-stack inventory (8 of 15 entities documented; the rest are **[gap]** and must
be discovered during onboarding, not assumed):

| Client | Field / job system | Ledger | What it forces in this design |
|---|---|---|---|
| AIM Kitchen & Bath | Buildertrend | QBO | Field-system jobs ↔ QBO sub-customers |
| Dorrian Heating & Cooling | FieldEdge | QBO | A system outside the owner's named six → recipe path |
| Heritage Interiors | RFMS (hosted) + QBTime | QBO (+ Sage noted) | Two ledgers' worth of evidence; the most complex single stack |
| Iowa Custom Cabinetry | Innergy | QBO | Manufacturing WIP/jobs |
| Revived Interiors | Buildertrend | [gap] | Unknown ledger: the plan must ask, not assume |
| Clive Power Equipment | C-Systems | Sage Intacct (**cancelled effective 10/1/2026**) | Source may already be read-only or gone. Needs file-only migration, a legacy archive and a TB rebuild |
| Heartland Heating & Cooling | simPRO | QBO | simPRO jobs/invoices as an ongoing feed |
| Merit Fund III | none | QBO | Ledger-only, fund entity |
| Metro, Swan Creek, Artistry, Wild Rose, Crystal, SPE 5, MMG LLC | [gap] | [gap] | Discovery step must exist (§5.3 step C1) |

Two further facts shape the design. **The QBO connection authorizes one company (realm) at a time**, so a
firm with 10 QBO clients needs a fast "connect the next company" loop (§6.4). And **no Merit entity files a
monthly P&L/BS today**, so the monthly tie-out grid will be the first clean monthly history these companies
have ever had. That makes it a buy-in asset, not just a gate. Nothing in this table is hard-coded. It's the
test packet (§14.3).

---

## 1. What exists today (carry forward, don't rebuild)

### 1.1 Assets to keep

| Asset | Code | Carry-forward |
|---|---|---|
| Front-door router (`resolveFrontDoor`, `decideOnboardingFlow`) | `lib/onboarding/flow.ts`, `front-door.ts` | Keep; re-point targets per IA §3.2 + §5 here |
| Section framework (`SectionDefinition`: propose → validate → commit, `deriveStatus` live-count truth) | `lib/onboarding/sections/registry.ts` + 7 domain sections | **The** extension point for O18 schedules. Keep the "live count beats stale flag" invariant |
| Historical conversion: source lines → mapping → assembled opening TB → balance + BS identity checks → tie-out blockers → `postJournalEntry` with deterministic `source_ref` | `lib/onboarding/conversion.ts`, `session.ts`, `api/onboarding/conversion/**` | Becomes the **Opening run** type inside a migration project. Pure math stays |
| Extended tie-out (subledger→control, WIP→GL) + Conversion Reconciliation report | `lib/onboarding/reconciliation/*` | Generalize into the tie-out engine (§10.3) |
| AI mapping with heuristic first pass, no dollars to the model | `lib/onboarding/mapping-ai.ts` | Becomes stage 5 of the mapping cascade (§7.1) |
| QBO OAuth + Vault tokens + live pull + transforms | `lib/integrations/erp/quickbooks/*` | Conform to the §4 contract; make per-client (G-ON-1) |
| QBO preflight (6 deterministic checks, plain English, dollars) | `quickbooks/preflight.ts` | Seed of the generic preflight library (§8) |
| Migration provider seam (`ConnectorProvider`, mapping profiles, conversion adapter, mock provider) | `lib/integrations/erp/providers/*` | Superseded by `MigrationConnector` (§4). Mock stays for tests/sandbox only |
| ERP catalog (28 rows, connection-method taxonomy) | `lib/integrations/erp/catalog.ts` | Moves into 07's connector registry; fix statuses (§1.3) |
| Smart Intake: rules + AI classification, 24 doc types, storage-path handoff (never re-upload) | `lib/onboarding/intake/*`, `smart-intake.tsx` | Becomes **Drop everything** v3 (O13) with client auto-routing |
| TB parsing incl. QuickBooks title rows, xlsx, GL-vs-TB detection | `lib/onboarding/tb-import/*`, `lib/companies/portfolio/tb-grid.ts` | Keep; one TB intake path |
| AR/AP/WIP/equity/formation importers | `lib/onboarding/import/*`, `wip-import/*`, `equity-import/*`, `formation/*` | Keep as staged-run producers |
| Bulk companies, multi-TB drop matched to companies, Control Tower (5 stages) | `lib/companies/portfolio/*`, `app/(app)/onboarding/portfolio/*` | Rename (IA §3.7) and extend to 8 stages (§6) |
| `createCompany` (single company-creation path; pre-current months SOFT_CLOSE) | `lib/companies/create-company.ts` | The only add-client path (§13) |
| Sample-data guard (fixture data can never post to a real company) | `lib/onboarding/sample-guard.ts` | Keep; extend to every connector's mock mode |
| Honest progress (skipped ≠ done) | `lib/onboarding/wizard-progress.ts` | Keep the rule everywhere |
| InviteHelper, drop-zone, proposal-card, tie-out-banner, connected-system-fallback | `components/onboarding/*` | Reuse; tie-out-banner folds into the shared `TieOut` component |
| Existing-loan mode (no origination JE) | `lib/debt/create.ts` (B9) | Used by O18 loans |
| Policy compilers (AP + expense NL → rules), N-step approval workflows + Simulator | `/bills/policy`, `/expenses/policy`, `/settings/approvals` | Targets for O6/O7 handoffs |
| Vendor memory + learned preferences | `lib/learning/*` | Fed by the detail-history "learn-only" import (§10.2) |
| Company legal record (EIN, entity type, members, formation) | migration 151 `core.company_legal_records` | Target for formation parsing; feeds ownership edges (§11.1) |

### 1.2 FPB v1 blockers B1–B9: code evidence (verify live before relying on it)

| ID | Evidence in code | Status for v2 |
|---|---|---|
| B1 SOFT_CLOSE pre-cutover; default cutover | `create-company.ts`, `fiscal-periods.ts`, `conversion.ts defaultCutoverDate` | Shipped in code. v2 adds: HARD_CLOSE only at certificate (§10.6) |
| B2 QBO connect or guided export | `quickbooks/*`, `connected-system-fallback.tsx` | Shipped. Needs Intuit prod keys. Generalized as recipe tier (§4.3) |
| B3 No fixture data in prod | `sample-guard.ts` | Shipped |
| B4 Real invite + `/sign-up` + tour | `app/sign-up`, `invite-helper.tsx`, `tour/*` | Shipped |
| B5 `/setup` folded | `app/setup` still exists | Finish in §13 |
| B6 Sign-in → `/` | front-door | Shipped |
| B7 `/api/setup` resolves caller org | `api/setup/route.ts` (claim-first; "first" there means the caller's own first bound membership) | Shipped. Re-verify under multi-membership |
| B8 Subledger blockers before "tied out" | `session.ts computeGateBlockers → extendedTieOutBlockers` | Shipped |
| B9 Existing-loan mode | `lib/debt/create.ts` | Shipped |

### 1.3 New gaps this review found (each is closed by a slice in §16)

| ID | Gap (evidence) | Why it blocks the vision |
|---|---|---|
| **G-ON-1** | `core.erp_connections` is **unique on (org_id, erp_id)** (migration 108). One QBO connection per *tenant*. | A firm can't connect 10 clients' QBO files. Hard blocker for firm tenants |
| **G-ON-2** | `inbound_ap_address` lives on `core.organizations` (migration 135), one per tenant | AP email parsing can't route bills to the right client |
| **G-ON-3** | `approval_workflows` is one active per (org, doc_type). Steps use `approver_role` only (migration 092). No client, department, named-person or "requester's manager" approver | Org-chart-derived approval chains are impossible |
| **G-ON-4** | Conversion state lives in `ai_decisions` JSON (`kind = ONBOARDING_CONVERSION`). No migration project, run, snapshot or certificate objects | No resume across sources, no immutable proof, no audit object for the certificate |
| **G-ON-5** | Opening balances only. No monthly history, no detail reference, no comparatives | Teams can't compare to last year on day one, which kills buy-in |
| **G-ON-6** | `ORG_CHART` and `EXPENSE_POLICY` intake types route to `/documents` with **no parser** (`intake/types.ts`) | Two owner asks dead-end |
| **G-ON-7** | Catalog has **no simPRO and no C-Systems** rows. QuickBooks shows PLANNED even though onboarding connects it live (`catalog.ts`; UI audit §4) | Two of the owner's six named systems are missing. The catalog contradicts the product |
| **G-ON-8** | `ConnectorProvider` is hard-typed to 3 providers × 6 entities (accounts, customers, vendors, open AR/AP, TB). No jobs, items, WIP, employees, payroll, monthly TB, control totals or date windows | Field systems can't plug in |
| **G-ON-9** | Control Tower stages are TB-only (`created → uploaded → matched → checked → live`). Owner is `practice_assignments` (keyed to employees, not memberships) | Can't run a real multi-source wave, and conflicts with IA M-5 / RBAC R-4 |
| **G-ON-10** | Mapping is per session. Nothing is remembered across clients or re-used | Every client is re-mapped from scratch |
| **G-ON-11** | No dimension inference | Departments/jobs/classes are re-keyed by hand |
| **G-ON-12** | No platform provisioning (ONB-10), no lifecycle funnel (ONB-11) | Audience (a) has no surface |
| **G-ON-13** | Onboarding sub-pages have no page guard except `/onboarding/portfolio` (UI audit §1.3) | Security gap on a money-adjacent flow |
| **G-ON-14** | No outstanding-items import at cutover (uncleared checks/deposits) | The first bank rec after go-live won't tie, which is the most common migration failure |
| **G-ON-15** | No YTD continuity balances (1099 vendor payments, payroll YTD, sales-tax period-to-date) | Mid-year cutovers produce wrong 1099s/W-2s at year end |

---

## 2. Principles (each is an acceptance test)

| # | Principle | The test |
|---|---|---|
| P1 | **Fetch, don't ask** | No field is presented empty if a connected source, a parsed document or another client in the tenant could have filled it. Prefilled fields show their source chip ("from QuickBooks", "from Operating Agreement p.3") |
| P2 | **Prefill and confirm** | Every proposal screen's primary button is "Confirm" or "Accept all ≥90%", never "Fill in". Editing is the exception path |
| P3 | **Drop everything** | One drop zone at tenant level and per client takes any pile of files (zip, pdf, xlsx, csv, images, email .eml). Each file is classified, routed to its parser **and** to the right client |
| P4 | **Never re-upload** | A file dropped anywhere is reachable by every parser by storage path (FPB v1 §5). A tenant-level document covering several clients (a master credit agreement with co-borrowers) is linked to each, not copied |
| P5 | **AI-off fallbacks** | With the AI gateway off, every step still completes via rules, recipes, CSV column maps, the crosswalk library and manual mapping. The run is labelled "AI paused: rules and memory only" (§15.1 matrix) |
| P6 | **Never fake data** | No fixture, sample or mock record can reach a real client's GL (sample guard on every connector's mock mode). Staged data is visibly "Staged, not in your books". Skipped steps show as skipped |
| P7 | **Delegate any step** | Every card, step and blocker has an assignee and "Ask someone": a teammate (InviteHelper, real email link), a client contact (IA M-7 client request, magic link), or MeritBooks concierge (support grant, IA M-9) |
| P8 | **Resume anywhere** | All state is server-side on the migration project. Any deep link resumes at the exact step with the same staged data. Closing the browser loses nothing. Every step is idempotent |
| P9 | **Many clients, one motion** | Any action that makes sense across clients (set cutover, apply mapping set, assign lead, run preflight, request documents, issue certificates) can be taken on a selection in the Control Tower |
| P10 | **Proof is the product** | No client goes live without a certificate. Every blocker is stated in dollars, never cents, before attestation |
| P11 | **Reversible until go-live** | Every posted run has "Undo run" (reversing entries, never deletes, consistent with migration 153 immutability) until the certificate is issued |
| P12 | **Nothing changes in the old system** | Every connector requests read-only scopes where the vendor offers them. The connect screen states "MeritBooks will only read. Nothing in {system} changes." Write-back code paths don't exist |
| P13 | **Explain everything** | Every number on every onboarding screen opens a "where this came from" panel: source system, run, source account/record, mapping rule and who approved it |
| P14 | **Plain English on the happy path** | No accounting jargon without a one-line explanation (FPB v1 §6). Dollars, dates and names, never ids |

### 2.1 Targets (extend FPB v1 §1)

| Scenario | Human time | Elapsed |
|---|---|---|
| Platform admin provisions a tenant | ≤ 5 min | instant; invite delivered |
| Tenant setup, firm with 15 clients + 10 staff (clients, groups, staff, roles, assignments, approvals, policies, inboxes) | ≤ 90 min, delegable | same day |
| One client leaving QBO, opening balances only | ≤ 20 min (FPB v1) | live same day |
| One client leaving QBO with monthly history + one field system | ≤ 45 min | live in 1–2 days; certified after shadow close |
| One client with **file-only** ledger (Sage desktop, a cancelled Intacct, spreadsheets) | ≤ 90 min | 1–3 days |
| 17-client tenant, mixed sources | ≤ 6 h for ledger-only clients (FPB v1). Add ≤ 15 min per field-system connection | first client live day 1; all live in ~2 weeks; all certified after their first shadow close |
| Support tickets needed on the happy path | 0 | — |
| Hard dead ends | 0 | — |

---

## 3. Object model (new and changed schema, columns not SQL)

Numbered **OM-1…OM-12**. The lead assigns real migration numbers **after** IA M-1/M-2/M-6 and RBAC R-1…R-5
(first free Books number at authoring was 154). All tables are additive and idempotent, RLS on with
`org_id = get_org_id()`. Every table with `location_id` takes the IA M-4 / RBAC R-11 client-access predicate.

**OM-1 · Migration project** (`public.migration_projects`, one per client being onboarded)
- `id`, `org_id`, `location_id` (unique while not archived), `wave_id` → OM-2 (nullable)
- `stage` check (`plan`,`connect`,`preflight`,`map`,`tie_out`,`shadow_close`,`certified`,`live`,`paused`,`abandoned`)
- `cutover_date date` (last day before MeritBooks takes over), `history_depth` check (`opening_only`,`monthly`,`monthly_plus_detail`), `history_start date`
- `target_go_live date`, `shadow_mode` check (`parallel`,`clean_switch`,`none`), `shadow_period_id` → fiscal_periods
- `chart_strategy` check (`keep_source_chart`,`tenant_standard`), `mapping_set_id` → OM-5
- `lead_membership_id`, `reviewer_membership_id` (DB check: reviewer ≠ lead). These mirror `client_assignments` capacity `lead`/`reviewer`, function `onboarding` (IA M-5); the assignment is authoritative and these are denormalized for the Tower
- `blocker_summary jsonb` (computed: counts and $ by blocker class), `next_action jsonb`, `stage_changed_at`, `certified_at`, `certificate_id` → OM-10
- replaces `locations.onboarding_status` as the source of truth (keep the column as a derived mirror for one release, the same "live count wins" rule as `deriveStatus`)

**OM-2 · Migration waves** (`public.migration_waves`): `id`, `org_id`, `name` ("Wave 1 — QBO HVAC"), `default_cutover_date`, `default_history_depth`, `default_mapping_set_id`, `target_go_live`, `status`, `created_by`. Waves are optional (a single company tenant never sees them).

**OM-3 · Sources and connections**
- **`core.erp_connections` (fix G-ON-1):** + `location_id uuid` (nullable for tenant-level connections such as Ramp or a directory), + `external_ref text` (QBO realmId, Xero tenantId, ServiceTitan tenant id, …), + `role` check (`ledger_source`,`field_system`,`bank`,`card_spend`,`payroll`,`crm`,`directory`,`mailbox`,`docs`), + `scopes text[]`, + `read_only boolean`. Drop unique `(org_id, erp_id)`. New unique `(org_id, erp_id, external_ref)`. Index `(org_id, location_id)`. Secrets stay in Vault (`meta.secretRef`). 07 owns the lifecycle; this doc only requires per-client binding
- **`public.migration_sources`**: `id`, `org_id`, `project_id`, `kind` check (`connector`,`file_set`,`manual`), `connection_id` (nullable), `system_id` (registry slug, e.g. `quickbooks`, `servicetitan`, `c-systems`), `role` (as above), `entities text[]` (what we bring from it), `authority jsonb` (per entity: `ledger_control` | `detail_enrich` | `reference_only`, see §9.2), `status` check (`planned`,`connected`,`pulled`,`stale`,`error`,`archived`), `last_run_id`

**OM-4 · Runs and staging** (immutable snapshots: the evidence chain)
- **`public.migration_runs`**: `id`, `org_id`, `project_id`, `source_id`, `run_kind` check (`discover`,`pull`,`file_parse`,`opening_post`,`history_post`,`subledger_post`,`schedule_post`,`shadow_pull`,`undo`), `window_start`, `window_end`, `as_of date`, `status` (`running`,`staged`,`approved`,`posted`,`undone`,`failed`), `record_counts jsonb`, `control_totals jsonb` (§4.2), `content_hash text` (sha-256 over the normalized payload), `source_fingerprint jsonb` (vendor "last modified" markers for stale detection), `posted_entry_ids uuid[]`, `undone_by_run_id`, `created_by`, `approved_by` (≠ `created_by` for `*_post` kinds when the tenant has ≥ 2 finance users), timestamps
- **`public.staged_records`**: `id`, `org_id`, `run_id`, `entity` (`account`,`tb_line`,`monthly_tb_line`,`gl_txn`,`customer`,`vendor`,`item`,`job`,`employee`,`open_invoice`,`open_bill`,`wip_job`,`loan`,`lease`,`asset`,`prepaid`,`equity_holder`,`budget_line`,`outstanding_bank_item`,`ytd_1099`,`ytd_payroll`,`sales_tax_ptd`, …), `external_id`, `payload jsonb` (normalized shape, money in cents), `source_ref jsonb` (file + sheet + row, or API object + id), `dedupe_key text`, `match_status` (`new`,`matched`,`merge_proposed`,`conflict`,`ignored`), `matched_object_id uuid`, `confidence numeric(4,3)`, `decision_by`, `decision_at`. Partitioned or pruned 90 days after certificate. The run's hash keeps the proof

**OM-5 · Mapping sets** (fix G-ON-10)
- **`public.mapping_sets`**: `id`, `org_id` (null = platform crosswalk library), `name` ("QBO → Merit standard chart"), `source_family` (`quickbooks`,`xero`,`sage_intacct`,`sage_50`,`netsuite`,`generic`), `target` (`tenant_standard`), `version int`, `status` (`draft`,`active`,`retired`)
- **`public.mapping_rules`**: `id`, `org_id`, `mapping_set_id`, `match_kind` check (`exact_number`,`exact_name`,`normalized_name`,`detail_type`,`regex`), `match_value`, `source_account_type`, `target_account_id`, `target_dimensions jsonb` (e.g. `{department: "HVAC Install"}` when a source account becomes account + dimension), `confidence_floor`, `evidence_count int` (clients it was approved on), `approved_by`, `approved_at`, `conflicts jsonb` (other clients that mapped the same key differently)
- **`public.client_mappings`**: per project, the resolved mapping per source account: `project_id`, `source_account_key`, `target_account_id`, `target_dimensions`, `source` (`rule`,`crosswalk`,`heuristic`,`ai`,`human`), `rule_id`, `confidence`, `approved_by`. Replaces `ConversionSessionData.mapping` (keep a reader for old sessions)

**OM-6 · Dimension proposals** (`public.dimension_proposals`): `id`, `org_id`, `project_id`, `dimension` (`department`,`class`,`job`,`item`,`location`), `proposed_name`, `evidence jsonb` (e.g. `{qbo_class: "HVAC-Install", txn_count: 1840, accounts: [...]}`), `confidence`, `status` (`proposed`,`accepted`,`renamed`,`merged`,`rejected`), `created_object_id`.

**OM-7 · Master-data crosswalk** (`core.master_data_links`): `id`, `org_id`, `location_id` (null for tenant-level masters such as a shared vendor), `object_type` (`customer`,`vendor`,`item`,`job`,`employee`,`account`), `object_id` (core/public id), `system_id`, `connection_id`, `external_id`, `external_number` (invoice#/job#), `authority` (`origin`,`enrich`,`reference`), `linked_by` (`rule`,`ai`,`human`), `confidence`, `active`. Unique `(org_id, system_id, connection_id, object_type, external_id)`. This is the table that makes the post-go-live ERP feeds idempotent and dedupe-safe.

**OM-8 · Preflight findings** (`public.preflight_findings`): `id`, `org_id`, `project_id`, `run_id`, `check_id` (§8 ids), `severity` (`blocker`,`warning`,`info`), `amount_cents bigint`, `accounts text[]`, `records jsonb` (sample + count), `message`, `disposition` check (`open`,`fixed_in_source`,`carry_as_reconciling_item`,`accepted_with_note`,`not_applicable`), `disposition_note`, `disposed_by`, `disposed_at`. Dispositions flow into the certificate.

**OM-9 · Tie-out snapshots** (`public.tieout_snapshots`): `id`, `org_id`, `project_id`, `kind` (`monthly_grid`,`cutover_tb`,`subledger`,`schedule`,`independent`,`shadow_close`), `as_of`, `grid jsonb` (rows × months × {source, merit, diff}), `all_zero boolean`, `blocker_count`, `run_ids uuid[]`, `content_hash`, `computed_at`. Immutable. The certificate references specific snapshot ids.

**OM-10 · Conversion certificates** (`public.conversion_certificates`): `id`, `org_id`, `location_id`, `project_id`, `certificate_number` (Books-owned numbering, like JE#), `version int`, `supersedes_id`, `cutover_date`, `history_depth`, `sources jsonb` (system, run ids, hashes), `snapshot_ids uuid[]`, `preflight_dispositions jsonb`, `independent_ties jsonb`, `shadow_close jsonb`, `prepared_by`, `prepared_at`, `approved_by` (DB check ≠ `prepared_by`), `approved_at`, `document_id` (PDF in documents), `status` (`issued`,`voided`), `void_reason`.

**OM-11 · Per-client inboxes and approval chains** (fix G-ON-2, G-ON-3)
- **`public.inbound_mailboxes`**: `id`, `org_id`, `location_id`, `kind` (`forwarding_address`,`oauth_mailbox`), `address` (generated `ap+{client_code}@{tenant-slug}.in.meritbooks.app`), `connection_id` (Gmail/M365 OAuth via OM-3), `filter jsonb` (folder/label/sender rules), `backfill_days int default 60`, `status`. `organizations.inbound_ap_address` becomes the tenant default/fallback
- **`public.approval_workflows`** + `location_id` (null = tenant default, a client row overrides), + `department_id` (optional narrowing). Unique-active becomes `(org_id, coalesce(location_id), doc_type, coalesce(department_id))`
- **`public.approval_workflow_steps`** + `approver_kind` check (`role`,`capability`,`membership`,`manager_of_requester`,`department_head`,`client_owner`), + `approver_membership_id`. Composes with RBAC R-12 `approver_capability`
- **`core.org_chart_nodes`**: `id`, `org_id`, `location_id` (nullable for tenant-wide), `membership_id` (nullable until the person is invited), `employee_id` (core HR record), `display_name`, `title`, `department_id`, `reports_to_node_id`, `approval_limit_cents`, `source_document_id`, `source` (`parsed`,`directory`,`payroll`,`manual`)

**OM-12 · Legacy archive & continuity**
- **`public.legacy_archives`**: `id`, `org_id`, `location_id`, `system_id`, `report_kind` (`pl_monthly`,`bs_monthly`,`tb_monthly`,`gl_detail`,`ar_aging`,`ap_aging`,`1099_detail`,`payroll_summary`,`sales_tax_liability`,`audit_log_export`), `period_start`, `period_end`, `document_id`, `content_hash`, `pulled_at`. Read-only and retained per tenant policy (default 7 years)
- **`public.continuity_balances`**: `id`, `org_id`, `location_id`, `kind` (`ytd_1099_vendor`,`ytd_payroll_employee`,`sales_tax_ptd`,`outstanding_bank_item`,`asset_tax_basis`,`rev_rec_job_inputs`), `subject_id` (vendor/employee/bank account/job), `as_of`, `amounts jsonb` (cents), `run_id`. Read by 1099, payroll, sales tax, reconciliation and rev-rec so year-end and the first rec are right (G-ON-14, G-ON-15)

**Permissions used** (RBAC §2.2; the lead adds any missing keys to the capability registry, a reserved spine):
`platform.tenants` (provision) · `onb.clients` C/E/D · `onb.wizard` V/E · `onb.imports` V/C/P (P = post a run) ·
`onb.conversion` V/A/P (A = pass the tie-out gate and approve the certificate) · `int.connections` V/C/D/K ·
`int.sync_runs` V/E · `core.access.members` / `.assignments` / `.roles` · `core.tenant.settings` ·
`core.tenant.dashboard_layouts` K. **New keys requested:** `onb.mappings` V/C/E/K (K = publish a tenant mapping
set), `onb.waves` V/C/E, `onb.certificate` V/A/D (D = void, controller-level, reason required).

---

## 4. The connector contract (wizard side): connect → discover → pull → map → tie out

07 owns how a connector authenticates, paginates, retries, rate-limits and receives webhooks. **This
section is the interface the wizard calls.** Any connector that implements it appears in O9/O12 with zero
new UI. It replaces `ConnectorProvider` (`providers/types.ts`, G-ON-8).

### 4.1 Interface (TypeScript shape; lives in the 07 registry package)

```ts
type SourceRole = 'ledger_source' | 'field_system' | 'bank' | 'card_spend' | 'payroll' | 'crm' | 'directory' | 'mailbox' | 'docs';
type Tier = 'native_api' | 'aggregator' | 'recipe' | 'generic_file';
type StagedEntity =
  | 'accounts' | 'tb_cutover' | 'tb_monthly' | 'gl_detail' | 'customers' | 'vendors' | 'items' | 'jobs'
  | 'employees' | 'open_invoices' | 'open_bills' | 'wip_jobs' | 'payroll_registers' | 'ytd_1099'
  | 'ytd_payroll' | 'outstanding_bank_items' | 'budgets' | 'classes_locations' | 'business_units';

interface ConnectorDescriptor {
  systemId: string;                 // registry slug, never renamed
  name: string; role: SourceRole; tier: Tier;
  entities: StagedEntity[];         // what it can bring
  historyLimitMonths: number | null;// vendor API look-back limit, null = unlimited
  readOnlyScopes: boolean;          // P12 badge
  ongoingFeed: boolean;             // stays connected after go-live (field systems, bank, Ramp)
  recipe: ExportRecipe;             // ALWAYS present — the fallback (§4.3)
}

interface MigrationConnector {
  descriptor: ConnectorDescriptor;
  connect(ctx: ClientCtx): Promise<ConnectStart | ConnectResult>;     // OAuth redirect, API key form, or "use recipe"
  discover(conn: ConnectionRef): Promise<Discovery>;                  // the PREVIEW — §4.2; no staging
  pull(conn: ConnectionRef, req: PullRequest): AsyncIterable<StagedBatch>; // writes staged_records via the run
  controlTotals(conn: ConnectionRef, asOf: string[]): Promise<ControlTotals>; // REQUIRED to certify
  mappingHints?(conn: ConnectionRef): Promise<MappingHint[]>;         // detail types, classes, account roles
  fingerprint(conn: ConnectionRef): Promise<SourceFingerprint>;      // stale detection between pull and post
}
```

Rules every connector meets (and the 07 conformance test asserts):
1. **Degrade-safe.** No credentials means `connect` returns "use recipe", never throws, never calls the network (today's pattern).
2. **Read-only.** No method writes to the source. A connector that requests write scopes fails conformance unless 07 documents why (none should for onboarding).
3. **Money in cents, dates ISO, ids external.** Normalization to the staged shape happens in the connector's deterministic **profile** (today's `mapping.ts` pattern). No AI in profiles.
4. **Control totals are mandatory for certification.** At minimum: TB by account at each requested date; AR aging total and AP aging total at cutover; for field systems, job count + contract value + billed-to-date + cost-to-date totals, and open-invoice total. A connector without them can still import, but its data is marked **"not independently tied"** on the certificate.
5. **Fingerprint.** Return vendor change markers (QBO `MetaData.LastUpdatedTime` max per entity, CDC cursor, export file hash) so the tie-out can flag "source changed since pull" (§10.3).
6. **Mock mode is sandbox-only.** Fixtures carry the sample-guard marker and can't post to a real client (B3).

### 4.2 What "preview" (discover) shows before anything is staged

For each entity: record count, date range available, last-modified, and a 5-row sample. For a ledger:
fiscal year start, home currency, multi-currency on/off, closing date (QBO "books closed through"), class/location
tracking on/off, account count by type, and **the preflight teaser** (top 3 findings in dollars, computed from
discover-level data where possible). For a field system: business units, job count by status, open invoices,
customers, technicians/employees. The human chooses **what to bring** (pre-ticked by role, §5.3 step C4) and
**the window** (pre-set from the project's history depth). Nothing is stored except the discovery summary.

### 4.3 Tiers, and why every system has a path on day one

| Tier | Meaning | UI | Example (subject to 07's API research) |
|---|---|---|---|
| **native_api** | Direct API connector built by us | Connect button → OAuth / key | QuickBooks Online (live), Xero, Sage Intacct, NetSuite, Plaid, Ramp |
| **aggregator** | Reached through a unified API (07 decides which, if any) | Connect button | Long-tail ledgers/field systems where the aggregator has coverage |
| **recipe** | Guided export: exact menu path, report names, date settings and file type for that system, plus a **parser profile** that recognizes the file deterministically | "Export from {system} in N steps" panel with screenshots, then drop | Buildertrend, Innergy, RFMS, C-Systems, FieldEdge, QuickBooks Desktop, Sage 50/100/300 until an API connector exists |
| **generic_file** | Any CSV/XLSX/PDF. Column mapping with saved maps, AI type detection, rules fallback | Drop zone | Anything not in the registry, plus "My system isn't listed" (records demand for 07) |

**The upgrade path never changes the UI.** When 07 ships an API connector for a recipe-tier system, the
card's primary action flips from "Export & drop" to "Connect". Staged shape, mapping, tie-out and certificate
are identical. The recipe stays as the fallback (for example, when Intacct is cancelled, as with Clive).

### 4.4 Source catalog the wizard must present (role, what it brings, ongoing or one-time)

Status tiers are **targets for 07 to confirm**. Until 07 verifies a public API and terms, a system ships at the
**recipe** tier. The catalog must never show a status the product doesn't honor (G-ON-7).

| Group | Systems (minimum set) | Brings | After go-live |
|---|---|---|---|
| **Ledger (one-time)** | QuickBooks Online · QuickBooks Desktop · Xero · Sage Intacct · Sage 50 / 100 / 300 · NetSuite · FreshBooks / Wave (generic) · spreadsheets | accounts, TB cutover + monthly, GL detail, customers, vendors, items, classes/locations, open AR/AP, 1099 YTD, sales-tax PTD, budgets, uncleared bank items | **Disconnected + archived** at certificate (canon). Shadow pull allowed during shadow month only |
| **Field / job / ERP (ongoing)** | **ServiceTitan · Buildertrend · Innergy · simPRO · RFMS · C-Systems** · FieldEdge · Procore · Jobber · Housecall Pro · BuildOps · ServiceTrade · JobTread · Knowify · Contractor Foreman · Foundation · Sage 100 Contractor · JobNimbus · AccuLynx · Comp-U-Floor · QFloors · RollMaster | customers, jobs (+ status, contract value, change orders), items/price book, open invoices, deposits, job costs, WIP inputs, technicians/employees, business units | **Stays connected** as an origination feed (MD IX: jobs into departments). Feeds jobs and business documents through the crosswalk (OM-7) |
| **Bank & card** | Plaid (live) · **Ramp** (BNK-08, top priority) · Amex/US Bank/Chase via Plaid or statement files · OFX/QFX/CSV/BAI2 statements | accounts, balances at cutover, transactions after cutover, uncleared items; Ramp: card txns with receipts + coding, bills, reimbursements, entities/departments | Ongoing |
| **Payroll** | Gusto · ADP · Paychex · QBO Payroll · Paylocity · register files (PRL-01 live) | employees, departments, YTD payroll by employee, liabilities at cutover, register history | Register import ongoing (provider TBD, task #32) |
| **Spend / AP tools** | Concur (Merit uses it) · Bill.com · Ramp bill pay | open bills, vendors, approval chains (as evidence for O6) | Ramp ongoing; others one-time |
| **CRM** | HubSpot · Salesforce · CSV | customers/contacts (master data only, no pipeline in Books) | Optional ongoing master-data enrich |
| **Directory** | Microsoft 365 / Entra · Google Workspace | staff names, emails, titles, managers (**org chart**), departments | Optional ongoing for joiner/leaver sync |
| **Mailbox** | Gmail · Microsoft 365 (GATE 4) · forwarding address | AP bills, receipts, vendor statements; 60-day backfill → open bills + vendor discovery | Ongoing |
| **Documents** | Drop · Dropbox · Google Drive · SharePoint/OneDrive (folder pick) | formation docs, loans, leases, policies, WIP, budgets, insurance, W-9/COI | One-time pick + optional watched folder |

**Catalog fixes now (G-ON-7):** add `simpro` and `c-systems` rows; set QuickBooks Online to its true status;
split "Sage" into Intacct and desktop families; add FieldEdge (already present) and payroll, directory and
mailbox groups; every row carries its `recipe`.

---

## 5. Journeys per audience

Legend: **H** = the human does it · **S** = the system does it · **t** = target human time.

### 5.1 (a) Platform admin: provision a tenant (O1, O2)

Two modes, both from `/platform/tenants/new`: **Guided provision** (Mike sets it up and hands over) and
**Invite the tenant** (a signup link with plan, modules and tenant type pre-set; the tenant self-serves O2).

| # | H | S | t |
|---|---|---|---|
| A1 | Enters tenant legal name, website (optional), tenant type (`firm` / `company`), plan, modules (Books + others), region/currency, first admin's name + email | Prefills from website domain (name, logo, brand color for white-label preview) and from any uploaded engagement letter/MSA (client list). Suggests tenant type from the answers ("keeps books for others?") | 2 min |
| A2 | Picks templates: COA template (or "tenant brings its own chart"), role templates (RBAC §7, auto-cloned), dashboard defaults (IA §5), close-calendar default | Creates `core.organizations` (+ IA M-1 `tenant_type`, `lifecycle_status = invited`, `provisioned_by`), Clerk org, cloned roles, published layouts, COA seed, inbound address | 1 min |
| A3 | Optional: pre-creates clients (paste list) and sets a migration wave | Calls `createCompany` per row; creates draft migration projects | 1 min |
| A4 | Chooses **who sets up**: tenant admin (default), or **MeritBooks concierge** (platform support runs setup under a tenant-approved support grant, IA M-9) | Sends the invite (real email, B4). Funnel row appears in `pf.funnel` at "Invited" | 30 s |
| A5 | — | Tracks lifecycle `invited → signed_up → setting_up → converting → live`. Nudge and "offer concierge" actions appear when a stage exceeds its SLA (3 business days default) | — |

Platform admin **never sees tenant figures** (IA R13). The funnel shows counts, stages, days-in-stage and
blockers by *class* ("2 clients waiting on documents"), never dollars from the tenant's books.

### 5.2 (b) Tenant admin / accounting manager: set up the tenant (O3–O9)

Lands on **Tenant setup home (O3)**: a board of cards, each with status, owner, "Do it", "Ask someone" and a
one-line *why*. Required cards gate the first client's go-live. Optional cards never nag (FPB tone rules).
Order is a recommendation, not a sequence. Cards unlock in parallel.

| Card | H | S | Gate | t |
|---|---|---|---|---|
| **T1 Confirm your account** | Confirms prefilled tenant name, type, brand, fiscal-year default, close-due business day | Prefill from provisioning/website | required | 1 min |
| **T2 Clients & structure** (O4) | Pastes or drops a client list, **or** drops formation docs / operating agreements, **or** connects QBO companies one after another | Creates clients via `createCompany` (one path). Parses EIN/articles/OAs into `company_legal_records` (151). Proposes **ownership edges** (`entity_ownership`) from OA member tables and **consolidation groups** (IA M-6) from the resulting tree. Flags the tenant's own books (`is_tenant_own_books`) | required (≥1 client) | 10 min for 15 clients |
| **T3 Team** (O5) | Drops a staff CSV, or connects M365/Google directory, or types names | Proposes members with titles, departments and managers. Maps titles to role templates ("Staff Accountant" → bookkeeper) with confidence | required (≥1 reviewer ≠ preparer for firm tenants, IA Q5) | 5 min |
| **T4 Roles & client assignments** (O5) | Reviews the proposed matrix (people × clients × capacity). Bulk: "Dana → preparer on 6 HVAC clients" | Proposes from directory departments, from client tags, and from who already has QBO accountant access per client (when discoverable). Validates the RBAC ceiling, SoD and delegation. Writes RBAC R-4 `access_assignments` + IA M-5 `client_assignments`, then sends invites carrying `intended_assignments` | required | 10 min |
| **T5 Dashboard defaults** | Accepts role templates or moves widgets. Chooses lock level | Publishes tenant role layouts (IA M-8) | optional | 3 min |
| **T6 Approval chains from the org chart** (O6) | Drops the org chart (PDF/image/XLSX/PPT) or accepts the directory's manager lines. Drops the AP/expense policy (or answers 3 questions: bill approval threshold, payment release threshold, expense limit) | Builds `org_chart_nodes`, then proposes per doc type (BILL, PAYMENT, EXPENSE, JOURNAL_ENTRY, PAYROLL) a chain with dollar bands. Steps can be `manager_of_requester`, `department_head`, `client_owner` or a capability. Runs the existing **Simulator** on the last 90 days of source bills (when pulled) to show who would have approved what. SoD validated | recommended (required before money movement) | 10 min |
| **T7 Policies** (O7) | Drops expense policy and AP policy documents | Hands off to the existing NL → rules compilers (`/expenses/policy`, `/bills/policy`). Closes G-ON-6 (route EXPENSE_POLICY there, not `/documents`). Shows each rule with its source sentence | optional | 5 min |
| **T8 Email inboxes for AP** (O8) | Per client: accepts the generated forwarding address and/or connects a mailbox (Gmail / M365) with a folder/label filter | Generates per-client addresses (OM-11). Backfills 60 days, finds open bills and vendor statements, and stages **open bills** and **new vendors** into that client's migration (dedupe vs ledger open AP, §9) | optional | 2 min per client |
| **T9 Integrations** (O9) | Connects tenant-level systems (Ramp, directory, payroll, Dropbox) and sees per-client connection needs | One matrix: clients × systems with status. "Connect the next one" loop | optional | varies |
| **T10 Migration plan** | Groups clients into waves, sets default cutover and history depth, picks the mapping strategy (keep chart vs tenant standard) | Creates waves (OM-2) and projects (OM-1). Opens the Control Tower | required for firms with >3 clients | 5 min |

**Company tenant (single entity) collapses this:** T2 is one card ("Your company"), T4 is "who's on your
team", T10 disappears, and the user lands straight in the client migration (5.3) with T3/T6/T8 as side cards.

### 5.3 (c) The accounting team: migrate one client (O11–O24)

The **client migration workspace** (`/clients/[id]/migration`) is a left rail of eight stages with live
status and an assignee on each. The main panel is the current stage. A right drawer holds "Where this came
from", comments and "Ask someone". Every stage can be done out of order where data allows. The rail shows
skipped as skipped.

| # | Stage | H | S | t (QBO + 1 field system) |
|---|---|---|---|---|
| C1 | **Plan** (O11) | Confirms prefilled cutover ("MeritBooks takes over Oct 1; September and earlier stay as they were"), history depth (default monthly: current FY YTD + prior FY), shadow mode, lead and reviewer, and **which systems this client uses** (multi-select pre-checked from tenant knowledge; "Not sure" sends a 3-question discovery request to the client contact) | Defaults from the wave. Validates cutover against period status (B1). Creates `migration_sources` for each system picked | 2 min |
| C2 | **Connect** (O12, O13) | Clicks Connect per source (OAuth, read-only promise shown) or follows the recipe and drops files. Drops corporate docs, loans, leases, WIP, budgets, last bank rec, policy docs into the same zone | Discovery preview per source (§4.2). Smart Intake classifies each file and routes it to its parser **and this client**. Requests the missing pieces from the client contact via a magic-link document request (IA M-7) with a checklist ("Last bank reconciliation for each account", "Loan statements as of Sep 30") | 5 min |
| C3 | **Preflight** (O14) | Reads the findings. Picks a disposition per finding: fix in source / carry as reconciling item / accept with note. Can send the report to the client | Runs the preflight library (§8) on discovery + first pull. Ranks by $ impact. Recomputes when the source is re-pulled | 5 min |
| C4 | **Pull & map** (O15–O17) | Bulk-accepts the Ready band, decides the Check/Decide bands (ordered by $), accepts dimension proposals, resolves duplicate/match proposals for customers, vendors and jobs | Pulls the selected entities and window into staging (one run per source × entity). Runs the mapping cascade (§7.1) against the tenant mapping set, dimension inference (§7.3) and master-data matching (§9). Shows ledger-vs-field reconciliation of customers/jobs/open invoices | 10 min |
| C5 | **Opening & schedules** (O18) | Reviews each schedule card's proposal (loans, leases, assets, prepaids, equity holders, WIP jobs, budgets, outstanding bank items, 1099 YTD, payroll YTD) and confirms | Section framework `propose → validate → commit`. Each schedule ties to its GL control at cutover (debt register = loan liability accounts, …). Existing-loan mode (B9) by default | 8 min |
| C6 | **Tie-out** (O19, O20) | Opens the grid. Resolves any non-zero cell (drill to source records). Reviews the independent ties. Opens side-by-side reports. Preparer **signs** the tie-out | Posts history runs and opening runs as **staged-approved → posted** (each undoable). Computes the month × account grid, cutover TB, subledger ties, schedule ties and independent ties. Stale-source detection | 5 min |
| C7 | **Shadow close** (O21) | Works the first month in MeritBooks (normal bookkeeper loop, IA §6). At month end reviews the diff vs the old system | In `parallel` mode: shadow-pulls the source TB/GL for the month and diffs by account with transaction-level explanations. In `clean_switch` mode: compares MeritBooks close to the trend and to independent ties only | normal month + 10 min review |
| C8 | **Certify & go live** (O22, O23) | Reviewer (≠ preparer) reviews the packet and **approves the certificate** | Issues the certificate (PDF + hash). HARD_CLOSEs pre-cutover periods. Disconnects and archives ledger sources (legacy archive OM-12). Flips field/bank/Ramp sources to ongoing feeds. Client status → `active`. Hands the client to the bookkeeper home | 5 min |

**Go-live before shadow close is allowed** (the client starts transacting in MeritBooks after C6). The
certificate then issues after C7. The stage chip shows "Live, certification pending shadow close". This keeps
the "live the same day" FPB target without weakening the proof.

### 5.4 Delegation map (who typically does each step; anyone can be handed any step)

| Step | Default owner (capacity) | Typical hand-off |
|---|---|---|
| A1–A5 | platform admin | concierge (platform support with grant) |
| T1–T10 | tenant admin; T4/T6 accounting manager | controller (T6), office manager (T8), owner (T6 thresholds) |
| C1 | migration lead (accounting manager) | — |
| C2 | bookkeeper (preparer) | client contact for documents and OAuth consent (they own the QBO login) |
| C3 | bookkeeper | client contact for "fix in source" items |
| C4 | bookkeeper | accounting manager for mapping-set decisions |
| C5 | bookkeeper | controller for equity, loans, rev-rec inputs |
| C6 | bookkeeper signs | reviewer reviews |
| C7 | bookkeeper | reviewer |
| C8 | reviewer approves | controller voids/reopens if needed |

**Client-side OAuth consent:** the person who owns the QBO/ServiceTitan login is often the client, not the
firm. "Ask the client to connect" sends a magic link that runs **only** the connect step for that one
source on that one client, with the read-only promise in plain English. The firm never handles the
client's password.

---

## 6. Migration Control Tower (firms onboarding many clients)

Route `/clients/onboarding`, title **Migration Control Tower** (IA nav label "Onboarding tracker"). It's
Cockpit-style (IA §4.0 rule 7). It replaces `app/(app)/onboarding/portfolio/control-tower.tsx` +
`lib/companies/portfolio/tower*.ts` (renamed to `lib/clients/onboarding/*`). Capability: `onb.clients` V +
the client-access filter (a bookkeeper sees only their clients' rows).

### 6.1 Layout (opens on work, no banner)

```
Oct 19 · Wave 1 cutover Sep 30 · 9 of 17 clients live · 3 certified · $41,220 in open blockers
[ All 17 ] [ Plan 2 ] [ Connect 3 ] [ Preflight 1 ] [ Map 2 ] [ Tie-out 2 ] [ Shadow 4 ] [ Certified 3 ]   Wave ▾  Lead ▾  System ▾
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☐ Client               Stage        Sources            Blockers         Next action               Lead / Rev   Due │
│ ☐ Clive Power Equip.   Connect      Sage(file) C-Sys   TB missing       Ask client: Intacct TB    Dana / Kim  Oct 21│
│ ☐ Heartland H&C        Tie-out      QBO simPRO         $3,140 · 2 cells Resolve Oct 1099 cell     Dana / Kim  Oct 22│
│ ☐ Heritage Interiors   Map          QBO RFMS           38 to decide     Decide 38 mappings ($92k) Lee  / Kim  Oct 23│
│ ☐ AIM K&B              Shadow       QBO Buildertrend   —                Shadow diff due Nov 3     Lee  / Kim  Nov 3 │
└──────────────────────────────────────────────────────────────── [Bulk: Set cutover · Apply mapping set · Assign · Request docs · Run preflight] ┘
```

### 6.2 Columns (every one sorts and filters)
Client · stage (with days in stage and SLA dot) · sources (system chips, each with a health dot: connected /
stale / error / recipe-awaiting-file) · history depth · cutover · **blockers** (count and $, by class:
documents, preflight, mapping, dedupe, tie-out cells, independent ties, shadow diff) · next action (one verb
button, the exact step) · lead / reviewer (inline reassign → effective-dated `client_assignments`) · target
go-live · certificate status.

### 6.3 Bulk actions (P9)
Set cutover / history depth / shadow mode for the selection · move to wave · **apply mapping set** (re-runs
the cascade, shows a per-client delta before committing) · assign lead/reviewer · **request documents** (one
checklist, sent per client contact, tracked per client) · run preflight · re-pull stale sources · **issue
certificates** (only rows with all gates green; each still needs its reviewer's approval, batched into one
review queue item per reviewer) · export the tracker (XLSX, for the owner).

### 6.4 "Connect the next company" loop (QBO realm-per-company reality)
From the Tower: "Connect QuickBooks for 6 clients" queues the selected clients. Each OAuth return lands back
in the loop with the next client pre-selected. The Intuit company picker's chosen company name is matched to
the client (dice similarity today in `company-match.ts`, plus EIN from QBO CompanyInfo vs
`company_legal_records`). A mismatch stops the loop with "This looks like Swan Creek, not Metro. Swap?". The
same loop works for ServiceTitan tenants and Xero orgs.

### 6.5 Wave mechanics
A wave is a cohort sharing cutover, history depth, mapping set and target go-live. Recommended wave plan
(auto-suggested, editable): **Wave 1** = 2–3 clean QBO clients (proves the mapping set) → **Wave 2** = the rest of
the QBO clients using the now-hardened mapping set → **Wave 3** = file-only and unusual ledgers (Sage, cancelled
systems, spreadsheets). Wave burndown chart: blockers $ and stage counts by day, with a drill.

### 6.6 Supervisor module and done state
IA `am.onboarding` widget = the Tower's top 5 "stuck longest" rows plus the stage tabs. Done state: "All 17
clients certified. Average 4.2 days plan-to-live, 31 human minutes per client." The Tower then hides from
nav until a client enters `plan` again.

---

## 7. Mapping intelligence

### 7.1 COA mapping cascade (per source account, first hit wins; every hit records its `source` and rule)

| Stage | Method | Confidence | Notes |
|---|---|---|---|
| 1 | **Tenant mapping set rule**: exact key (number, then normalized name) approved on another client | 0.97 (≥2 clients) / 0.93 (1 client) | Shared mapping across clients (decision 6) |
| 2 | **Platform crosswalk library** (`mapping_sets.org_id = null`): QBO account *detail types* (e.g. `UndepositedFunds`, `AccountsReceivable`, `CostOfLabor`), Xero system accounts, Intacct categories → MeritBooks **account roles** | 0.95 for control/system roles, 0.85 for detail types | Deterministic. Works with AI off |
| 3 | **Exact number** match to the target chart | 0.99 when `chart_strategy = keep_source_chart`, 0.75 otherwise (numbers coincide by accident across charts) | today's heuristic |
| 4 | **Name heuristics** (exact 0.90, contained 0.70) + type guard | as today | `mapping-ai.ts heuristicMap` |
| 5 | **AI proposal** via the Core gateway (`CONVERSION_MAP`), given numbers, names, types, detail types and the client's industry. **No balances** | model confidence capped at 0.89, so AI alone never lands in Ready | today's AI path |
| 6 | Unmapped: the human decides | — | balance-bearing unmapped accounts block tie-out (today) |

**Bands** (same as the bank feed, so staff learn one system): **Ready ≥ 0.90** (preselected, "Accept all
Ready"), **Check 0.70–0.89**, **Decide < 0.70** or any type-guard warning. **Review order is by absolute
cutover balance plus history activity in dollars**, not alphabetically. The first screen shows "38 accounts
to decide · $92,410 of balance · 61% of P&L activity".

**Type guard (hard):** source type → target type must be compatible (ASSET → ASSET, REVENUE → REVENUE, COGS ↔
OPEX allowed with a warning, OTHER allowed). Incompatible proposals can't be accepted without a typed reason.
They're shown in the certificate.

**Many-to-one and one-to-many:**
- *Merge:* 12 source accounts → 1 target. Allowed. The grid can show "by source account" and "by MeritBooks account".
- *Split by dimension:* `Revenue – HVAC Install` and `Revenue – HVAC Service` → `Revenue` + department `Install` / `Service`. Proposed by §7.3. The mapping rule carries `target_dimensions`.
- *Split by amount* (one source account across two targets): not allowed in a mapping. Use a reclass in the opening run with a stated reason. That keeps the trail auditable.

**Chart strategy (per project, default from tenant):**
- `keep_source_chart`: create target accounts from the source chart (role-tagged, approval-workflow honored as "bulk request accounts" for the controller). Fastest for a single company.
- `tenant_standard`: map onto the tenant's standard chart + dimensions. **Default for firm tenants.** This is how a firm standardizes every client's chart during migration (an active Merit goal). Accounts with no good target produce a **"Request account"** proposal in bulk for the controller (COA approval workflow), never an ad-hoc account.

### 7.2 Shared mapping across clients
- Approving a mapping on a client writes or reinforces a `mapping_rules` row in the project's mapping set (`evidence_count++`).
- **Conflict detection:** if Client B maps `6120 Truck Fuel` differently from Client A, the rule shows a conflict badge. The accounting manager resolves it once (pick one, or make it client-specific).
- **Publishing:** a mapping set is `draft` until the accounting manager publishes it (`onb.mappings` K). Published sets are what bulk "Apply mapping set" uses. Versioned. A diff shows which clients a change would remap.
- **Mapping-set library** screen (O26): rules, evidence, conflicts, clients using it, export/import (XLSX). Firms reuse their own mapping know-how across years and tenants (platform can promote anonymized patterns to the crosswalk library only with tenant opt-in).

### 7.3 Dimension inference (OM-6)

| Signal | Proposes | Evidence shown |
|---|---|---|
| QBO **classes** / **locations**, Xero tracking categories, Intacct dimensions | departments or classes (human picks which) | txn count, $ volume, accounts touched |
| QBO **sub-customers** (`Customer:Job`), projects | jobs | open/closed, revenue to date, matched field-system job # |
| Account-name **suffix families** (`Revenue - X`, `COGS - X`) | departments X, and the split-by-dimension mapping | the account family |
| Field-system **business units** (e.g. ServiceTitan business units), divisions, trades | departments | job count, revenue |
| Field-system **job list** | jobs (crosswalked to QBO sub-customers by job number/name/customer) | match confidence |
| Payroll **departments** | departments + employee home department | headcount |
| Item / price-book categories | items / item classes | usage |

Rules: never create more than one department per signal family without a merge prompt. Proposals that
collide with existing tenant departments are offered as "merge into existing". Accepted dimensions
re-run the mapping cascade so the split-by-dimension rules apply. Dimension requirements
(`validate_dimensions`) are switched on **after** history posts, so history doesn't fail validation for
months before the dimension existed. History lines are tagged where the source had the tag. Otherwise
they're untagged and labelled "pre-dimension".

---

## 8. Data-quality preflight (generalizes `quickbooks/preflight.ts`)

Runs on discover and after every pull. Pure, deterministic, unit-tested, AI-free (an AI "explain this
finding" button is optional). Each finding has severity, $ impact, plain-English message, accounts/records,
suggested fix, and a disposition (OM-8). **Blockers stop tie-out; warnings need a disposition; info is
informational.**

| ID | Check | Severity | Fix options |
|---|---|---|---|
| PF-01 | AR aging ≠ AR control (today's #1) | blocker | fix in source · carry the difference as one reconciling item |
| PF-02 | AP aging ≠ AP control (today's #2) | blocker | same |
| PF-03 | Undeposited Funds balance (today's #3) | warning | match in source · carry and clear in month 1 |
| PF-04 | Uncategorized income/expense/asset (today's #4) | warning | categorize in source · bring over to a review queue |
| PF-05 | Ask My Accountant / suspense balances (today's #5) | warning | same |
| PF-06 | Opening Balance Equity ≠ 0 (today's #6) | warning | reclass to RE/owner equity (proposal, controller approves) |
| PF-07 | TB doesn't balance at a requested date | blocker | re-pull · rebuild TB from GL detail |
| PF-08 | **Prior-year net income not closed to retained earnings** (RE roll breaks) | blocker | let MeritBooks run year-end close on history (LIVE engine) |
| PF-09 | Abnormal-sign balances (credit cash, debit AP, negative inventory, debit deferred revenue) | warning | explain / reclass |
| PF-10 | **Bank accounts not reconciled recently** (last reconciled date > 60 days before cutover, or uncleared items > 90 days old) | warning (blocker if > 180 days) | reconcile in source · import the last rec's outstanding items (G-ON-14) |
| PF-11 | **Edits to closed periods in the source** (changes dated after the source's "books closed" date, or fingerprint changed between pulls) | warning | re-pull · accept |
| PF-12 | Inactive accounts with balances | warning | map anyway (shown) |
| PF-13 | Duplicate customers / vendors (fuzzy name + email/phone/TIN) | info → feeds §9 | merge proposals |
| PF-14 | **1099-eligible vendors missing TIN/W-9** with YTD payments over threshold | warning | W-9 request via vendor portal (LIVE) |
| PF-15 | Sales-tax liability ≠ last filed return + period-to-date collections | warning | carry; note in tax calendar |
| PF-16 | Payroll liabilities aged > 30 days | warning | verify remittance |
| PF-17 | Fixed assets without accumulated depreciation, or depreciation not run in months | warning | catch-up depreciation proposal (schedule card) |
| PF-18 | Customer deposits / retainers booked as revenue | warning | reclass to deposits liability (2420) |
| PF-19 | Retainage folded into trade AR/AP | warning | split to retainage accounts |
| PF-20 | **WIP schedule ≠ GL** (Σ cost-to-date vs WIP asset, Σ unbilled vs 1180, Σ billings in excess vs 2410) | blocker for rev-rec-managed jobs | fix schedule · post true-up proposal |
| PF-21 | Loan balances in GL ≠ lender statement / amortization schedule | warning | true-up proposal with statement attached |
| PF-22 | **Cross-client intercompany mismatch** (Client A's due-from-B ≠ Client B's due-to-A, at cutover) | warning | only a firm can see this. Proposes the investigation pair |
| PF-23 | Field system open invoices ≠ ledger open AR for the same customers | warning | §9.3 rules decide which is control |
| PF-24 | Multi-currency or foreign balances in source | info | functional currency per client (mig 133); transactional FX is PLANNED |

**The preflight report is a deliverable.** "Send to client" produces a branded PDF ("What we found in your
books before we moved them"), listing the items the client must fix in source. Firms use this as proof of
value before go-live.

---

## 9. Master data & ERP reconciliation (dedupe and authority)

### 9.1 One golden record per thing, many external ids
Customers, vendors, items, employees and jobs are **core objects owned by Core** (canon: Books references
them by FK, never copies). Every external record that represents the same thing gets a crosswalk row
(OM-7). Imports **create or link**, never duplicate. The crosswalk is what keeps post-go-live feeds
idempotent ("ServiceTitan invoice 88123 already linked to MeritBooks INV-1042").

### 9.2 Authority matrix (per client, per source, per entity; set at C1, editable)

| Entity | Default origin (golden fields) | Enrichers | Reference only |
|---|---|---|---|
| Chart of accounts | target chart (tenant) | ledger mapping | field systems' GL codes (used as mapping hints) |
| Customers | field system (name, service address, contacts) when one exists, else ledger | ledger (terms, tax status, AR balance as control), CRM (contacts) | — |
| Vendors | ledger (name, remit address, TIN, 1099 flag) | Ramp/Bill/Concur (payment details via vendor portal only, never imported bank numbers), field system (subs) | — |
| Jobs | field system (job #, status, contract, change orders, business unit) | ledger sub-customers/projects (historical revenue/cost by job) | — |
| Items | field system price book | ledger items (income/expense account links) | — |
| Employees | payroll / directory | field system (technician ids) | — |
| **Opening AR (control)** | **ledger aging at cutover** (it ties to the AR control by PF-01) | field system invoice detail enriches each open invoice (job link, lines, deposits) | — |
| **Opening AP (control)** | **ledger aging at cutover** | mailbox backfill / Ramp bills enrich (document image) | — |
| Historical revenue & cost | **ledger** (monthly history) | — | field-system history (context for job P&L only, **never posted**) |
| Post-cutover documents | field system (invoices, deposits, job costs) via ongoing feed | — | ledger (disconnected) |

The core rule: **load AR/AP once as detail from the control source, and derive the control (never
double-count).** That's the ONBOARDING-DESIGN-SPEC §4 guardrail, now made explicit per source.

### 9.3 Matching rules (deterministic first, AI for proposals only)

| Object | Keys in order | Auto-link | Propose | Never |
|---|---|---|---|---|
| Customer | external id already linked → TIN → email domain + normalized name → phone → billing/service address → name dice ≥ 0.92 | ≥ 0.97 | 0.75–0.96 (side-by-side, one-click merge/keep both) | merge across clients; merge an individual with a business |
| Vendor | TIN → remit address + name → email domain → name ≥ 0.92 | ≥ 0.97 | 0.75–0.96 | import bank account numbers from any source (vendor portal only) |
| Job | job # equality across systems → customer + job name → customer + address + start date | ≥ 0.97 | 0.70–0.96 | link a closed job to an open job |
| Open invoice (field ↔ ledger) | invoice # → customer + amount + date ± 3 days | exact | amount/date near | create a second open item: one side is always enrichment |
| Item | SKU/code → name | exact | name ≥ 0.9 | — |
| Employee | email → payroll id → name + hire date | exact | name | — |

Shared tenant-level vendors (the same supplier used by many clients) are proposed as **one core vendor
with per-client AP**, but only where the ownership matrix allows tenant-scoped vendors. Customers are
never cross-client merged.

### 9.4 Jobs, WIP and rev-rec at cutover
- Open jobs come from the field system (or the WIP schedule file) and are crosswalked to ledger sub-customers.
- Per open job, the WIP card (existing `wip-import`) stages contract value + approved change orders, EAC/budget by cost code, cost to date, billed to date, retainage both sides and deposits, then ties Σ to GL (PF-20) and writes `continuity_balances.rev_rec_job_inputs` so the rev-rec engine (9 methods, method per job) starts from the right place.
- **Cutoff rule for feeds:** field documents dated **on or before** cutover are crosswalk-only (already inside opening balances). Documents dated **after** cutover originate in MeritBooks via the feed. The feed refuses to originate a pre-cutover document and posts an exception instead.

---

## 10. Cutover, history, tie-out, shadow close, certificate, rollback

### 10.1 Cutover date
Default: last day of the prior month (B1). Suggest the nearest quarter or fiscal year end if within 45 days
("Cleaner: Sep 30 is your Q3 end"). Per client, or shared by the wave. Validation: the cutover period and
all history periods must be SOFT_CLOSE or OPEN (never HARD_CLOSE before the certificate). `ensureCutoverPeriod`
auto-generates missing periods (today).

### 10.2 History depth

| Option | Posts | Use when | Default |
|---|---|---|---|
| **Opening only** | one opening entry at cutover (today) | brand-new or tiny clients; "start fresh" stays a separate explicit choice | company tenants with no prior system |
| **Monthly history** | one `SYSTEM` summary entry per month per client (lines = mapped account × dimension nets), `source_ref = migration:{project}:{run}:{yyyy-mm}`, into SOFT_CLOSE periods. Year-end closes run on history years so RE rolls. The opening at window start is the TB at `history_start − 1 day` | anyone who wants comparatives, trends, budgets vs last year, lender trailing-12 on day one | **current FY to date + prior full FY** (minimum: current FY to date when the cutover is mid-year) |
| **Detail reference** | nothing additional posts. Transaction-level history is stored read-only (staged + archived) and **drill-down from a monthly summary line opens the source transactions**. Also runs **learn-only** into vendor memory / learned preferences (proposal influence only) | firms that want "show me what was in that number" and day-1 categorization that matches their habits | on for firm tenants when the source supports `gl_detail` |

Entry type: use existing enum members only (`SYSTEM` for history, `STANDARD` for the opening as today). The
schema guard test (`schema.test.ts`) must stay green.

### 10.3 The tie-out engine (O19)

Four layers, all computed (OM-9 snapshots), all must be green to certify:

1. **Monthly grid (month × account):** for every month in the window and every target account (toggle: by
   source account), `source net` (from the source's monthly TB via the mapping) vs `MeritBooks net` (posted
   history), and month-end balances for BS accounts. **Plus a roll-forward integrity row:** opening at window
   start + Σ monthly activity = source TB at cutover. That catches sources that changed between pulls. Cell
   states: `0` green · non-zero red with $ · `stale` amber (fingerprint changed since pull, PF-11) ·
   `pre-dimension` grey tag. Every cell drills to the staged source records and the posted lines.
2. **Cutover TB:** debits = credits, balance-sheet identity, P&L handling (today's `validateBalanceSheet`, `plAcknowledged`).
3. **Subledger & schedule ties at cutover:** AR detail = AR control, AP detail = AP control, retainage
   both sides, customer deposits, WIP (Σ cost to date, Σ unbilled 1180, Σ billings in excess 2410), debt
   register = loan liabilities, lease register = ROU/lease liabilities, fixed-asset register = cost and
   accumulated depreciation, prepaid schedule = prepaid accounts, equity holder ledger = equity accounts,
   payroll liabilities = payroll provider liabilities. All accounts are resolved by role (`account-roles.ts`).
   This extends `reconciliation/build.ts` from 4 sections to all schedules.
4. **Independent ties (outside evidence):** bank and card balances at cutover vs Plaid/Ramp balance or the
   statement **after** applying imported outstanding items · loan balances vs lender statements · sales tax vs
   last return + PTD · payroll YTD vs provider · 1099 YTD vs source vendor report. Each is marked
   **Evidenced** (outside document attached), **Internal only** (source-consistent but no outside evidence), or
   **Not applicable**. Internal-only ties don't block, but they're printed on the certificate.

**The preparer signs the tie-out** (records `tiedOutBy/At`, today's semantics) only when layers 1–3 are zero
and every layer-4 tie has a status.

### 10.4 Side-by-side reports (O20)
P&L by month, balance sheet by month, TB, AR aging, AP aging, job P&L: **source column · MeritBooks column ·
difference**, for any month in the window. The source column comes from the latest pull or from the legacy
archive once disconnected. The same view is the shadow-close diff (10.5) and is what the accounting team
holds next to QuickBooks during the parallel month. Export to XLSX with both columns.

### 10.5 Continuity balances (the things migrations usually forget)
Imported into OM-12 `continuity_balances`, each with a schedule card in O18:
- **Outstanding bank items** at cutover (uncleared checks, deposits in transit) from the source's reconcile status or the last bank-rec report. The first MeritBooks reconciliation pre-loads them.
- **1099 YTD vendor payments** (when cutover is mid-year), so year-end 1099s are complete.
- **Payroll YTD by employee** (only when payroll will run in MeritBooks' provider; otherwise informational).
- **Sales-tax period-to-date** collections/liability.
- **Fixed-asset tax basis** and method (tax depreciation book).
- **Rev-rec job inputs** (§9.4).
- **Budgets** for the current and next FY (from QBO Budgets or file), so BvA works on day 1.
- **Loans** in existing-loan mode (B9) with covenants parsed from the agreement (LIVE parse, AI) and the next covenant test date seeded into obligations.

### 10.6 Shadow close (O21)
- **`parallel`** (default for firm tenants' first wave and any client with >$5M revenue or a lender package):
  the old system keeps being kept for month 1. At month end MeritBooks shadow-pulls the source TB + GL detail
  for the month (`shadow_pull` run) and diffs by account. Every non-zero account gets transaction-level
  explanations: present in source only / present in MeritBooks only / amount differs / coded differently,
  with links. The reviewer resolves each as "MeritBooks right", "source right → adjust", or "timing".
  Output: a shadow-close snapshot (OM-9) with residual $ = 0 or explained.
- **`clean_switch`** (default for single small companies): no parallel keeping. The first MeritBooks close is
  compared to trend (flux vs the history months) and to independent ties only.
- **`none`**: allowed only with a typed reason from a controller. Printed on the certificate.

### 10.7 Conversion Certificate (O22)
Contents (one PDF, hash-stamped, stored in documents; certificate number Books-owned): client legal name and
EIN (masked) · cutover date · history depth and window · sources (system, connection, run ids, content
hashes, pulled-at) · mapping summary (accounts by band, overrides with reasons, type-guard exceptions) ·
dimension decisions · preflight findings with dispositions · tie-out layers 1–4 results (snapshot ids) ·
shadow close result · continuity balances imported · open items carried as reconciling items, with owners ·
**prepared by** (preparer) and **approved by** (reviewer ≠ preparer, DB-enforced) with timestamps.

**On issue:** pre-cutover and history periods → **HARD_CLOSE** (this reconciles ONBOARDING-DESIGN-SPEC's
"hard-close pre-conversion" with FPB B1: SOFT_CLOSE while reversible, HARD_CLOSE when certified) · ledger
sources disconnected, tokens revoked, legacy archive pulled (OM-12) · field/bank/Ramp sources flipped to
ongoing · `client_status = active`, project stage `certified`/`live` · the client appears in the bookkeeper's
`bk.my_clients` · a "Books are live" note to the client contact (optional).

### 10.8 Reversible until go-live; controlled after
- **Before certificate:** each posted run has **Undo run**: generates exact reversing entries (same periods,
  `source_ref` suffixed `:undo`), marks the run `undone`, and keeps the staged data so a corrected re-post is
  one click. **Reset this client's migration** reverses all runs and returns the project to `map` (scoped
  version of tenant reset; two-person confirmation if anything posted).
- **After certificate:** **Reopen conversion** needs `onb.certificate` D (controller), a reason and a second
  approver. It reopens the affected periods (audit-logged), posts correcting entries (never deletes), and
  issues **certificate v2 superseding v1**. v1 is voided with the reason, both kept.
- **Old system is never touched**, so the ultimate rollback ("keep using QuickBooks") is always available
  until the client cancels it. The legacy archive is pulled *before* disconnection so cancelling the old
  subscription loses nothing (the Clive/Intacct case).

---

## 11. Tenant-setup details (audience b)

### 11.1 Clients & structure from documents (T2, O4)
- **Inputs, any mix:** pasted list; CSV/XLSX; formation docs (articles, certificates, EIN letters CP-575/SS-4); operating agreements; cap tables; a QBO connection per client (CompanyInfo legal name, EIN, address, fiscal year); an engagement letter or MSA schedule listing serviced entities.
- **System:** dedupes clients by EIN, then legal name. Creates via `createCompany`. Writes `company_legal_records`. From OA member tables and cap tables proposes `entity_ownership` edges (parent, child, %, effective date) with page citations. From the tree proposes **consolidation groups**: one `consolidated` group per client with owned subsidiaries, plus suggested `combined` groups by shared ownership. Proposes the tenant's own-books client (the firm's legal entity).
- **Review:** an ownership tree with % on edges and page-cited sources; accept, edit or remove edges; groups appear as cards with their members and a one-line "consolidated vs combined" explanation (IA S12).

### 11.2 Staff, roles and assignments (T3/T4, O5)
- Directory connect (M365/Google) or CSV → proposed members with title, department, manager, email.
- Title → role template mapping (editable dictionary per tenant: "Staff Accountant" → bookkeeper, "Controller" → controller, "Office Manager" → data entry or client contact).
- Proposed **assignment matrix** (people × clients): a cell is `preparer` / `reviewer` / `approver` / `lead` (+ function), seeded from department/client tags, the wave plan and capacity (`weekly_capacity_hours` from the CSV when present). Validation inline: delegation ceiling, SoD (preparer ≠ reviewer on the same client), "reviewer has access to every client they review", consolidation grants only where the person can access every member (IA M-6).
- Commit writes RBAC R-4 `access_assignments` + IA M-5 `client_assignments` and sends invites with `intended_assignments`. Invitees land on **their** "What changed for my workflow" page (§12.4) and then their home.

### 11.3 Org chart → approval chains (T6, O6) — fixes G-ON-6 (ORG_CHART) and G-ON-3
1. **Parse:** org chart PDF/image/PPT/XLSX (AI extract `ORG_CHART_EXTRACT`, a new gateway feature) **or** directory manager lines **or** payroll supervisor field. With AI off: XLSX/CSV with "name, title, reports to" columns, or a drag-to-arrange manual builder. Output: `org_chart_nodes`.
2. **Thresholds:** from the AP/expense policy documents (existing compilers) or three plain questions.
3. **Propose chains** per doc type and (optionally) per client/department, e.g. BILL: < $2,500 department head → $2,500–$25,000 + controller → > $25,000 + owner; PAYMENT release: CFO (SoD: not the preparer). Steps use `approver_kind` (OM-11).
4. **Simulate** on the last 90 days of the client's pulled bills/expenses (existing Simulator): "Under this chain, 212 bills would have needed 1 approval, 31 two, 4 three. Average approvals per bill: 1.2. Coverage gaps: 0."
5. **Publish** per client or tenant-wide. Coverage-gaps tab (LIVE) must be empty for money doc types before money movement is enabled.

### 11.4 Policies (T7, O7)
Expense policy and AP policy documents route to the existing compilers (NL → rules). The review shows each
rule next to its source sentence. Rules that require data not yet present (card → cardholder map) become
follow-up cards. Fixes G-ON-6 for `EXPENSE_POLICY`.

### 11.5 Email inboxes for payables (T8, O8)
- **Forwarding address per client** (always available, no OAuth): generated, copyable, with a "send a test bill" check.
- **Mailbox link** (Gmail now; M365 when GATE 4 credentials land): OAuth with read-only mail scope, folder/label filter, sender allowlist suggestions from the ledger vendor list.
- **Backfill (default 60 days):** finds bills, statements and receipts. Stages open bills for the client's migration (dedupe vs ledger open AP by vendor + invoice # + amount: the ledger stays the control; the email copy attaches the document image) and **new vendors** not in the ledger (flagged, never auto-created without review).
- After go-live the same mailbox feeds the AP intake lane (AP-03) with no reconfiguration.

---

## 12. Buy-in features for accounting teams (designed, not hoped for)

| # | Feature | What it does | Why it wins the team over |
|---|---|---|---|
| B1 | **Side-by-side old vs new** (O20) | Source column, MeritBooks column and difference for P&L/BS/TB/aging/job P&L, any month | "Show me it matches" is the first thing a skeptical accountant asks |
| B2 | **Where did this number come from** (P13) | Every number drills to run → source record → mapping rule → approver | Trust comes from traceability, not assurances |
| B3 | **Nothing changes in your old system** | Read-only scopes; a promise on every connect screen; no write-back code | Removes the fear of breaking the books they're responsible for |
| B4 | **Undo run / reset / reopen** (§10.8) | Mistakes are cheap before go-live and controlled after | Staff will try things if trying is safe |
| B5 | **Your vendor rules came with you** | Detail history teaches vendor memory, so day-1 bank-feed suggestions match how *they* coded it ("Ferguson → 5100 Materials, 214 times") | The AI looks like it already knows the client. Big first impression |
| B6 | **Learn by doing on real data** | A first-week guided path inside their own migrated client (not a demo company): "Approve your first 10 bank transactions", "Reconcile Operating Checking for October" (outstanding items pre-loaded), "Answer a client question", "Run your first close checklist". Coach marks, no fake data. Progress per person is visible to the manager | Training sticks when the work is real; managers see adoption |
| B7 | **What changed for my workflow** (§12.4) | One page per role, auto-generated from the old system + the role | Answers "what do I do differently on Monday" |
| B8 | **Terminology bridge** | Inline "In QuickBooks this was …" hints for 40 common terms (Classes → Departments/Classes, Undeposited Funds → payment clearing, Sub-customers → Jobs, Memorized → Recurring) | Removes the vocabulary tax |
| B9 | **Familiar shortcuts** | Keyboard map comparison; bank-feed keys (j/k/a/f) shown on first use | Speed is respect |
| B10 | **Preflight as a gift** | "We found $41,220 of issues in your QuickBooks before moving them", as a sendable report | Positions the migration as a cleanup the team gets credit for |
| B11 | **Proof artifacts they can hand to the partner/owner** | Tie-out grid export, certificate PDF, shadow-close report | The accountant looks good to their boss |
| B12 | **Report a mismatch** | One button on any onboarding number → creates a tracked issue with context to the migration lead | Concerns get captured instead of becoming hallway resistance |
| B13 | **Time-saved receipt** | After the first close: "Your first close took 6.1 hours vs 14 last month in QuickBooks (from your time standards)" | Makes the gain visible in their own numbers |
| B14 | **Client communication kit** | Drafted email + portal invite to the client contact explaining what changes for them (how to answer questions, where to send bills) | The client side doesn't become the accountant's problem |

### 12.4 "What changed for my workflow" page (O24)
Generated per role × prior system (QBO/Xero/Sage/spreadsheets) × the tenant's enabled features. Sections:
**Stays the same** (you still review every transaction; you still reconcile monthly) · **Now automated**
(with the evidence: "bank transactions arrive coded; Ready items batch-approve") · **Moved** (verb map: "In
QuickBooks: Banking → For Review. Here: Client home → To review") · **New for you** (client requests,
reviewer sign-off, the books-review loop) · **Your first-week path** (B6). Static content per role from
`help-content`, with tenant-specific facts filled in (their approval thresholds, their reviewer's name).
Linked from the invite email and the tour, and reachable from Help forever.

---

## 13. Merge / delete today's duplicates

| Today | Disposition |
|---|---|
| **Add a company, 5 paths:** `/settings/new-entity`, Settings → Companies, Team "New company", onboarding Company step, `/onboarding/portfolio` bulk (+ `/import` Companies) | One **Add client** (single, O4 drawer) and **Add clients (bulk)** (`/onboarding/clients`), both through `createCompany`. Retire `/settings/new-entity` (redirect), remove Team "New company" (link to Add client), remove the Companies tab in `/settings` (link to client registry), fold the `/import` Companies type into bulk add. Delete the duplicated rev-rec option list in `new-entity-wizard.tsx` (use one shared selector) |
| **TB intake, 4 paths:** `/import` TB, `/onboarding/conversion`, portfolio TB drop, SmartIntake | One **Opening run** producer inside the migration project. Smart Intake and multi-file drop *route into it*. Remove the TB type from `/import` (redirect to the client's migration) |
| `/setup` (B5) | Fold into O2 first-run. Redirect `/setup` → `/` front door |
| `/onboarding/portfolio`, Control Tower, `lib/companies/portfolio/*`, `/api/onboarding/portfolio/*` | Rename per IA §3.7 (`/onboarding/clients`, `/clients/onboarding`, `lib/clients/onboarding/*`, `/api/onboarding/clients/*`); 301s for one release |
| `/onboarding` 7-step wizard (`onboarding-wizard.tsx`, 1,092 lines) | Becomes the **single-company fast path** of the client migration workspace (C1–C8) for company tenants. Split the file by stage (reviewer rule: no god-files) |
| `/onboarding/conversion`, `/onboarding/reconciliation`, `/onboarding/sections/*` | Become stages C4–C6 and O18 cards inside `/clients/[id]/migration`. Old routes redirect with the session id mapped to the project |
| `/integrations/erp` catalog (QBO shown PLANNED) | Replaced by O9 using 07's registry. Statuses must match reality (AC-I3) |
| `/import` generic CSV (8 types) | Keep as **Client settings → Add data** for post-go-live bulk loads (customers, vendors, items, budgets). It shares the column-map engine with the migration's generic-file tier. Add a page guard (UI audit) |
| ORG_CHART / EXPENSE_POLICY intake routes to `/documents` | Route to O6 / O7 |
| Tie-out panels ×4 (`tie-out-banner`, `TieOutCard`, deposits, inventory) | One `TieOut` component used by O19 and the books-review loop |
| Drop-and-parse review UIs (debt, leases, prepaids, …) | One `ParseReview` shell (UI audit §2 #14) for every O18 schedule card |
| Onboarding sub-pages with no page guard (G-ON-13) | Every route guarded by `onb.*` capabilities + client access |
| `locations.onboarding_status` + `organizations.onboarding_state.complete` as truth | Derived mirrors of OM-1 for one release, then read-only |

---

## 14. Acceptance criteria

### 14.1 Functional (Rule 3 applies to every screen: loading / empty / populated / error, keyboard, design system, real queries, org + client scoped)
- **AC-1** A platform admin provisions a firm tenant with 3 pre-created clients in ≤ 5 minutes. The invitee receives a working email link and lands on O2 with every provisioning field prefilled.
- **AC-2** A firm tenant with **two QBO clients** can hold two simultaneous QBO connections, each bound to its client (G-ON-1). A third connect to the same realm is refused with the client it's already bound to.
- **AC-3** Dropping a zip of 20 mixed documents for 3 clients classifies ≥ 18 correctly by rules alone (AI off) and routes each to the right client and parser. No file is uploaded twice.
- **AC-4** Every connector in the registry has a recipe. Every catalog row's status matches what the product does.
- **AC-5** Preflight on the golden QBO file reports all seeded issues (PF-01…PF-10 present in the packet) with correct dollar amounts, before any mapping screen is shown.
- **AC-6** On the second client in a wave, ≥ 80% of balance-bearing accounts map in the Ready band from the tenant mapping set (no AI). A conflicting mapping shows a conflict badge on both clients.
- **AC-7** No source account maps across incompatible types without a typed reason. The reason appears on the certificate.
- **AC-8** QBO classes and sub-customers produce department and job proposals with evidence counts. Accepting them re-maps split-by-dimension accounts.
- **AC-9** Customers present in both QBO and the field-system fixture with the same email domain + name auto-link (≥ 0.97). Near matches are proposed. No customer is created twice. No cross-client merge is ever proposed.
- **AC-10** Opening AR loads once: field-system open invoices enrich ledger open invoices by invoice #. Σ open AR = AR control. A field invoice dated after cutover is refused by the opening run and originates via the feed after go-live.
- **AC-11** Monthly history for 21 months posts one `SYSTEM` entry per month. Every cell of the month × account grid is 0. The roll-forward row ties to the cutover TB. Year-end close ran on the history year and RE ties.
- **AC-12** Editing a closed-period transaction in the source after the pull flips the affected cells to `stale` and blocks the tie-out signature until re-pulled or accepted.
- **AC-13** Outstanding bank items imported at cutover make the first MeritBooks reconciliation of October tie with no manual adjustment.
- **AC-14** Mid-year cutover imports 1099 YTD by vendor. The year-end 1099 report equals source YTD + MeritBooks activity.
- **AC-15** "Undo run" reverses every line of a posted history run (TB returns to pre-run state). Re-posting the corrected run is one click. Nothing is deleted from `gl_entries`.
- **AC-16** Certificate approval by the same person who signed the tie-out is refused (DB check). Issuing the certificate HARD_CLOSEs pre-cutover periods, disconnects the ledger source, pulls the legacy archive and flips field sources to ongoing.
- **AC-17** Reopening after certification requires controller + second approver + reason and produces certificate v2 superseding v1. Both are retrievable.
- **AC-18** The org chart XLSX (name, title, reports-to) produces approval chains for BILL and PAYMENT. The Simulator runs on pulled bills. Coverage gaps = 0 is required before payments are enabled.
- **AC-19** A per-client forwarding address routes a test bill to that client's AP intake. Mailbox backfill stages open bills deduped against ledger open AP.
- **AC-20** Every onboarding step has "Ask someone". The teammate invite and the client magic link both deliver working links scoped to exactly that step/client.
- **AC-21** Closing the browser at any stage and reopening the deep link resumes at the same stage with the same staged data.
- **AC-22** With the AI gateway off, the golden packet reaches a certificate using rules, recipes, crosswalk, column maps and manual decisions. Each AI-dependent panel shows "AI paused: rules and memory only".
- **AC-23** A bookkeeper assigned to 2 of 17 clients sees 2 rows in the Control Tower and can't open another client's migration via URL (RLS + API, IA R1/R2).
- **AC-24** The platform admin's funnel never displays a tenant's financial figure (IA R13).

### 14.2 Buy-in acceptance
- **AC-B1** Side-by-side reports exist for P&L, BS, TB, AR/AP aging for any window month, with XLSX export of both columns.
- **AC-B2** Every number on O14–O22 opens "where this came from" with source record, mapping rule and approver.
- **AC-B3** The "What changed for my workflow" page renders for bookkeeper, accounting manager, controller, owner, AP clerk, from QBO and from Sage, with the tenant's real thresholds and reviewer name.
- **AC-B4** The first-week guided path runs on the user's real migrated client and records completion per person.
- **AC-B5** Vendor memory from detail history makes ≥ 70% of the first month's bank transactions land in Ready for the golden client (measured, AI on). Rules-only is measured and reported separately.

### 14.3 Golden packet & stopwatch (extends ONBOARDING-VISION §7)
A versioned fixture tenant shaped like the first tenant (names synthetic, structure real): one QBO client with
21 months history and seeded PF issues, one QBO + simPRO-shaped client, one Buildertrend-shaped client, one
**file-only Sage Intacct export + C-Systems export** client (source cancelled), one fund entity with no
field system, formation docs + OA with a two-level ownership tree, 3 loans, 1 lease, WIP for 12 jobs, an
org chart XLSX, an expense policy PDF, a budget XLSX, a last-bank-rec PDF per account. E2E drives it through
O1→O23. **Stopwatch** instruments human-active minutes per stage (focus + input events, not wall clock) and
cold-start-to-certified. CI asserts zero blockers at certificate, and minutes are tracked release over
release (they must only go down).

### 14.4 Security
Every write route: `requireAuthedContext` + capability check + fail-closed org + client access. Tokens in
Vault only. Read-only scopes. Magic links single-purpose, hashed, expiring, rate-limited (migration 141/142
pattern). Security agent review is mandatory (canon: identity + money adjacency + public routes).

---

## 15. AI-off matrix and screen list

### 15.1 AI-off fallbacks (P5)

| AI use | Fallback |
|---|---|
| Doc classification (`INTAKE_CLASSIFY`) | filename + content rules (`intake/rules.ts`, today) → user picks type |
| Formation / loan / lease / policy / org-chart extraction | structured templates: CSV/XLSX for org chart; manual forms with page viewer side by side |
| COA mapping (`CONVERSION_MAP`) | tenant mapping set → crosswalk library → number/name heuristics → manual |
| Dimension inference | deterministic signals (classes, sub-customers, suffix families) need no AI; only naming suggestions are AI |
| Master-data matching | deterministic keys + dice similarity; AI only adds "why these might be the same" text |
| Preflight | AI-free by design |
| Shadow-close explanations | deterministic diff categories; AI narrative optional |
| Vendor memory from history | deterministic counts; no AI needed |

### 15.2 Screen list for design (O1…O26)
Each screen shows open, empty, done and error states, at 1440 width (390 where noted), using Merit-shaped
synthetic data.

| # | Screen | Must show |
|---|---|---|
| **O1** | **Provision tenant** (platform) | tenant type explained in one line each; plan/modules; templates; "who sets up" (tenant vs concierge); funnel row preview; honest billing label |
| **O2** | **First-run for the tenant admin** | everything prefilled with source chips; confirm in one screen; "Invite someone to do this" visible; no banner |
| **O3** | **Tenant setup home** | T1–T10 cards with status, owner, why, Do it / Ask someone; required vs optional tone; progress honest (skipped ≠ done); done state hands to the Control Tower |
| **O4** | **Clients & structure** | list paste + doc drop + "connect QBO companies" loop; created clients table with source chips; ownership tree with % and page-cited OA evidence; proposed consolidation groups; own-books flag; duplicate-client warning by EIN |
| **O5** | **Team, roles & assignment matrix** | directory/CSV import; title → role proposals; people × clients matrix with capacity chips; inline SoD/ceiling violations with reasons; bulk assign; invite preview with intended assignments |
| **O6** | **Org chart → approval chains** | parsed chart (tree), editable; thresholds from policy; proposed chains per doc type with bands and approver kinds; Simulator results on 90 days of real bills; coverage gaps; publish per client/tenant |
| **O7** | **Policies** | dropped doc beside compiled rules with source sentences; follow-ups |
| **O8** | **Inboxes** | per-client forwarding addresses (copy, test); mailbox connect with read-only promise; backfill results: bills found, deduped vs ledger, new vendors to review |
| **O9** | **Integrations hub** | clients × systems matrix; tiers honest (Connect vs Export & drop); per-cell health; "connect next" loop; "my system isn't listed" |
| **O10** | **Migration Control Tower** | §6 in full: stage tabs with counts, wave filter, rows with sources/blockers $/next action/lead-reviewer, bulk bar, burndown, done state |
| **O11** | **Client plan** | cutover with plain-English explanation + period check; history depth options with "what you get"; shadow mode; chart strategy; systems this client uses + "Not sure? Ask the client"; lead/reviewer |
| **O12** | **Connect a source** | connector card: read-only promise, OAuth or recipe steps (with screenshots), discovery preview (counts, date ranges, samples, preflight teaser), choose entities + window; "Ask the client to connect" magic link |
| **O13** | **Drop everything** (client or tenant level) | multi-file drop; per-file type + client + parser with confidence and source (rules/AI/user); correct-type dropdown; missing-documents checklist with "Request from client" |
| **O14** | **Preflight report** | findings ranked by $; severity chips; plain English; disposition picker; send-to-client PDF preview; re-run on re-pull; done state "No blockers" |
| **O15** | **COA mapping review** | Ready / Check / Decide bands with counts and $; $-ordered list; source account → target with confidence bar and the rule that produced it; type-guard warnings; bulk accept; conflict badges from other clients; "request account" bulk for controller; by-source / by-target toggle |
| **O16** | **Dimension proposals** | proposed departments/jobs/classes with evidence (txn count, $, accounts); merge into existing; effect preview on mappings |
| **O17** | **Master data & ERP reconciliation** | customers/vendors/jobs: auto-linked, proposed (side-by-side cards), conflicts; ledger open AR vs field open invoices matched by invoice #; authority matrix editor |
| **O18** | **Opening & schedules** | one ParseReview card each: loans (existing mode + covenants), leases, assets, prepaids, equity holders, WIP jobs, budgets, outstanding bank items, 1099 YTD, payroll YTD, sales-tax PTD; each with its GL tie at cutover |
| **O19** | **Tie-out grid** | month × account heat-grid (0 / $ / stale / pre-dimension); roll-forward row; toggle source vs target accounts; cell drill to records; cutover TB checks; subledger & schedule ties; independent ties with Evidenced / Internal only; preparer sign |
| **O20** | **Side-by-side reports** | P&L/BS/TB/aging/job P&L: source · MeritBooks · difference; month picker; export |
| **O21** | **Shadow close** | per-account diff with explanation categories and transaction links; resolve actions; residual = $0; clean-switch variant |
| **O22** | **Conversion Certificate** | the packet (§10.7) as a review screen; prepared-by / approve; PDF preview with hash and number; refused state when approver = preparer |
| **O23** | **Go-live & rollback panel** | what flips at go-live (periods, sources, archive); undo run list; reset client; post-certificate reopen with second approver; certificate versions |
| **O24** | **What changed for my workflow** + first-week path | per role; stays / automated / moved / new; QBO-term bridge; checklist of real first tasks with progress |
| **O25** | **Client document & connect request** (client contact, 390px) | checklist of requested docs with camera/file attach; "Connect QuickBooks" single-purpose consent; plain-English read-only promise; all-done state |
| **O26** | **Mapping-set library** (tenant) | rules, evidence counts, conflicts, clients using each version, publish, diff, XLSX import/export |

---

## 16. Build slices (dependency-ordered; reserved spine stays with the lead)

**Reserved spine (lead only):** all `packages/supabase/migrations/*` (OM-1…OM-12), `packages/shared/*`,
`api-handler.ts`, `navigation.ts`, `rbac/permissions.ts` + the capability registry (new `onb.*` keys).
Agents report needs; they never invent schema.

**External dependencies:** IA **M-1** (tenant_type, lifecycle) · **M-2** (client fields) · **M-4** + RBAC
**R-11** (client-scoped RLS) · **M-5** (client_assignments) · **M-6** (consolidation groups) · **M-7** (client
requests, magic links) · **M-8** (layouts) · **M-9** (support grants) · RBAC **R-1/R-2/R-4** (capabilities,
roles, access_assignments) · **R-12** (approval steps on capability) · **07** connector framework + registry ·
**INT-01** scheduler (shadow pulls, reminders, re-pulls) · GATE 4 Azure/M365 creds (M365 mailbox only) ·
Intuit production keys (QBO, Mike).

| Slice | Scope | Depends on | Disjoint files |
|---|---|---|---|
| **OB-0 Spine** | OM-1…OM-12 migrations; `onb.mappings/waves/certificate` capability keys; nav entries (Tower, Add clients, Mapping sets) | IA M-1/M-2, R-1 | migrations, permissions, navigation (lead) |
| **OB-1 Connector contract** | `MigrationConnector` + descriptor + conformance test; QBO conformed (discover, control totals, fingerprint, monthly TB, GL detail); `erp_connections` per-client (G-ON-1); mock moved to sandbox-only | OB-0, 07 framework | `lib/integrations/connectors/*` (07-owned package), `quickbooks/*` |
| **OB-2 Migration project + Tower v2** | projects/waves services, 8-stage derivation, Tower UI + bulk actions + "connect next" loop; rename portfolio → clients; owner via `client_assignments` | OB-0, IA M-5 | `lib/clients/onboarding/*`, `app/(app)/clients/onboarding/*`, `api/onboarding/clients/*` |
| **OB-3 Preflight library** | PF-01…PF-24 pure checks over staged data; findings + dispositions; client PDF | OB-1 (staged shape) | `lib/onboarding/preflight/*` |
| **OB-4 Mapping intelligence** | cascade, bands, $-ordering, type guard, mapping sets/rules/conflicts/publish, crosswalk library seed (QBO detail types, Xero, Intacct), O15 + O26 | OB-0, OB-1 | `lib/onboarding/mapping/*`, `app/(app)/clients/[id]/migration/map/*` |
| **OB-5 Dimension inference** | signals → proposals → accept/merge; dimension-aware mapping rules; deferred `validate_dimensions` | OB-4 | `lib/onboarding/dimensions/*` |
| **OB-6 History + tie-out engine** | monthly history runs (SYSTEM entries), year-end on history, undo run, 4-layer tie-out snapshots, stale detection, O19 + O20 | OB-1, OB-4 | `lib/onboarding/history/*`, `lib/onboarding/tieout/*` (absorbs `reconciliation/*`) |
| **OB-7 Master data crosswalk** | `master_data_links`, matching rules, authority matrix, ledger↔field reconciliation, cutoff rule for feeds, O17 | OB-1, Core ownership matrix | `lib/onboarding/masters/*` |
| **OB-8 Field-system wave 1** | recipes + parser profiles for ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems, FieldEdge (and API connectors where 07 confirms access); control totals per system | OB-1, OB-7, 07 | one folder per system under the 07 package |
| **OB-9 Schedules & continuity** | O18 cards on `ParseReview` + section framework: outstanding bank items, 1099 YTD, payroll YTD, sales-tax PTD, budgets, WIP inputs → rev-rec, loans/leases/assets/prepaids/equity ties | OB-6 | `lib/onboarding/sections/*` (new files), `continuity/*` |
| **OB-10 Tenant setup** | O1 provisioning (platform), O2, O3 board, O4 clients & structure (OA → ownership → groups), single Add client path, duplicate retirement for add-company | IA M-1/M-2/M-6, R-2 | `app/(app)/platform/tenants/new/*`, `app/(app)/onboarding/tenant/*`, `lib/onboarding/structure/*` |
| **OB-11 Team, assignments, org chart, approvals** | O5 matrix (R-4 writes), invites with intended assignments, O6 org chart → chains (OM-11, R-12), Simulator hookup, `ORG_CHART_EXTRACT` gateway feature | R-4, R-12, IA M-5 | `lib/onboarding/team/*`, `lib/approvals/org-chart/*` |
| **OB-12 Policies + inboxes** | O7 routing to compilers; O8 per-client addresses, Gmail mailbox + backfill + dedupe vs ledger AP; M365 when GATE 4 lands | OM-11, OB-7 | `lib/ap/inbound/*` (per-client), `app/(app)/onboarding/tenant/inboxes/*` |
| **OB-13 Shadow close + certificate + go-live** | shadow pulls (scheduler), diff + explanations, certificate assembly/PDF/numbering/SoD, go-live flips, legacy archive, reopen v2 | OB-6, INT-01 | `lib/onboarding/certificate/*`, `lib/onboarding/shadow/*` |
| **OB-14 Buy-in layer** | "where this came from" panels, workflow-change pages, terminology bridge, first-week path, report-a-mismatch, time-saved receipt, client comms kit | OB-6, OB-13 | `lib/onboarding/buy-in/*`, `help-content` additions |
| **OB-15 Drop everything v3** | multi-client routing, zip/eml support, missing-docs checklist + client request (M-7), O13, O25 | OB-2, IA M-7 | `lib/onboarding/intake/*` |
| **OB-16 Consolidate duplicates + guards** | §13 redirects/removals, page guards on every onboarding route, wizard split | OB-2, OB-10 | route files only |
| **OB-17 Golden packet + stopwatch** | fixture tenant, E2E O1→O23, human-minute instrumentation, CI zero-blocker assertion | all | `apps/web/src/test/onboarding-golden/*` |

**Critical path:** OB-0 → OB-1 → (OB-4 → OB-6 → OB-13) with OB-2/OB-3/OB-7 in parallel after OB-1, then
OB-9 and OB-14. Tenant setup (OB-10/11/12) runs in parallel with the per-client path once IA M-1/M-2/M-5/M-6 and
RBAC R-4 land. **The first shippable milestone** (a firm can migrate many QBO clients with monthly history and
a certificate) = OB-0, OB-1, OB-2, OB-3, OB-4, OB-6, OB-13 (clean-switch only) + OB-16 guards.

**Pipeline per slice (CLAUDE.md §0.1):** FPB amendment (auditor) → builder(s) on disjoint folders (+ designer
on O-screens) → verifier → chrome-auditor → **security (mandatory for OB-1, OB-2, OB-10, OB-11, OB-12, OB-13)** →
reviewer → scribe.

---

## 17. Open questions for the owner (genuine decisions only)

| # | Decision | Recommended default |
|---|---|---|
| **Q1** | Default history depth for firm tenants | **Current FY to date + prior full FY, monthly**, plus detail reference (learn-only). 24+ months only on request |
| **Q2** | Default chart strategy for firm tenants | **Tenant standard chart + dimensions** (it advances Merit's chart standardization). `keep_source_chart` for company tenants |
| **Q3** | Is shadow (parallel) close mandatory before certification? | **Parallel for the first wave of every firm tenant and any client with a lender package. Clean switch otherwise. "None" only with a controller reason** |
| **Q4** | Who may approve a Conversion Certificate | **Reviewer capacity with `onb.conversion` A, ≠ preparer, DB-enforced.** Controller can void/reopen |
| **Q5** | Offer **MeritBooks concierge migration** (platform staff does it under a consent grant) as a paid service? | **Yes, as an option on O1 and in the funnel "Offer concierge" action.** Pricing out of scope here |
| **Q6** | Aggregator for the long tail (one unified-API vendor vs direct connectors only) | **Defer to 07's evaluation.** This spec works either way because the recipe tier guarantees coverage |

---

## 18. Metrics (instrumented from OB-17 on)

Cold-start-to-certified (per tenant, per client) · human-active minutes per stage · % balance-bearing accounts in
Ready on first pass (with and without AI) · tenant mapping-set reuse rate · preflight findings per client and $ ·
tie-out first-pass zero rate · stale-source incidents · shadow-close residual $ and explanation mix · days in
stage vs SLA · "Ask someone" hand-offs and response time · first-month bank-feed Ready rate (vendor memory
effect) · time-saved receipt (first close vs prior) · support tickets per migration (target 0).
