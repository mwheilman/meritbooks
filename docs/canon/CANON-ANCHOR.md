# MeritBooks — CANON ANCHOR

**Read this file in full at every trigger in the Re-Ground Protocol (see CLAUDE.md §0).**
It is deliberately small (~5 min read) so re-grounding is cheap. It is the distilled,
always-current truth. When it conflicts with the repo, **the canon wins** — fix the repo.
Source of truth: the Project-knowledge doc set (mirrored/digested in `docs/canon/`, indexed in `00-INDEX.md`).

Last reconciled: **2026-08-02 (Session 43)**.

---

## 0. If you are resuming from a summary — STOP

If this turn opened with a "summary of the conversation so far" block instead of the real
history, a **compaction** happened and your fidelity is degraded. Re-read this anchor and
the newest handoff BEFORE building anything. (This is exactly the failure that produced
ungated, spec-less work in Session 40.)

---

## 1. What MeritBooks IS (never drift from this)

- An **AI-native, multi-tenant SaaS book of record** — it **OWNS the general ledger**. It is
  **NOT** an automation layer on top of QuickBooks/Sage. QBO/Sage are **one-time migration
  import sources only.** This is the defining architectural fact.
- **Module 1 of 12 in the Merit Enterprise Suite** — one unified system sold as separate
  modules; **modular monolith, one Postgres, one schema, three ownership zones** (Suite Core /
  Books / reserved namespaces). No database-per-module, no internal API boundary.
- **Generic platform.** Merit Management Group is just a **standard tenant**. NEVER hardcode
  Merit-specific concepts ("holding company," "portfolio company," fixed entity list). Goal:
  white-label resale.
- **Three pillars:** (1) book of record / the GL; (2) AI automation that eliminates manual
  data entry; (3) native FP&A.
- **The product is an autonomous accounting workforce + a supervision/trust layer** — the AI
  does the manual labor; staff *supervise the machine*; leaders verify it's done right.
  (Session-40 sharpening; formal canon amendment proposed — see `PROPOSED-MASTER-DOC-AMENDMENTS.md`.)

## 2. Facts that OVERRIDE the repo (hard invariants)

- **Retired in Session 12 — do NOT rebuild:** chargeback engine, overhead/burden-rate engine,
  5 labor classifications (`employees.labor_type`), cost-allocation/shared-cost, in-app time
  tracking (lives in the separate PM module), MeritContext (does not exist).
  ⚠️ The repo `CLAUDE.md` historically described "workforce chargebacks / overhead rate" as
  live — that is STALE; the Master Doc retires them.
- **Account types are ASSET, LIABILITY, EQUITY, REVENUE, COGS, OPEX, OTHER — there is NO
  `EXPENSE` type.** Resolve cost accounts by COGS/OPEX.
- **Master data lives in `core` schema; the ledger in `public`.** PostgREST CANNOT embed
  `core` from `public` — stitch in JS via `lib/stitch-core.ts` (`fetchCoreMap`).
- **RLS on every table via `org_id = get_org_id()` — never `auth.uid()`** (Clerk id is text).
- **All money is bigint cents** — `formatMoney/dollarsToCents/centsToDollars`, never floats.
- **GL attribution columns (`gl_entries.created_by/posted_by`) are uuid + nullable → write
  null** (Clerk ids are text). Human attribution lives in `audit_log` / `core.action_log`.
- **COA is per-tenant** (a seed template). The template encodes **137 accounts, not 251**
  (accepted as-is). Reference accounts **by role, not by hard-coded number** (high numbers
  may not exist). AR 1100, Deferred Revenue 2410, Unbilled/Contract Asset 1180 exist.
- **AI gateway is Merit Core-owned, not Books-owned.** No module holds an Anthropic key or
  calls the API directly; every call routes through `@meritbooks/core-ai`, meters to
  `core.ai_usage_log`, and the **tenant monthly budget is enforced across COMBINED suite usage.**
- **Books owns the ledger, NOT the business objects.** Customer/Vendor/Item/Employee/Entity
  are `core`, referenced by FK, never copied. Write only fields you own (ownership matrix).
- **Event contract is FROZEN v3.** `JOB_COST` (Books→Projects), `JOB_BILLING` +
  `JOB_PROGRESS` (Projects→Books) via `core.events` (unique `(org_id,event_id)`). New event
  types get new names; never mutate an existing shape.
- **Numbering owners:** invoice #, bill #, journal-entry #, internal-invoice # → Books.
- **Stripe runtime keys are Vercel env vars, not Vault** (Vault = per-tenant secrets only).
  Construct Stripe with the fetch HTTP client. Destination-charge `payment_intent.*` fire on
  the **platform account** — webhook must listen there.

## 3. The accounting engine — rules a builder must not violate

- Everything posts through `postJournalEntry` / `check_journal_balance()` — **debits must
  equal credits** or it does not post.
- **Debit/credit direction is derived mechanically from account TYPE** — never hard-coded.
- **Payment rails (cash/check/ACH/wire/card/on-account) are NOT transaction types** — the rail
  only picks the cash-side account. Credit card → **Credit Card Payable (liability), not cash.**
- **Never re-expense a settlement.** Pay a bill = DR AP / CR Cash (clears the obligation);
  CC statement payment = DR Credit Card Payable / CR Cash; customer payment = DR Cash / CR AR.
- **AI proposes FACTS; the deterministic engine does the accounting; a human approves.** AI
  never writes debits/credits. **Auto-post is OFF by default**; autonomy is a per-tenant,
  per-task dial. Segregation of duties applies to the AI itself. Every AI action → Decision Log.
- **Rev-rec is Books-owned, method-per-job** (9 methods; `rev-rec.ts` is the authority — the
  posting engine delegates timing to it). For a rev-rec-managed job the customer invoice credits
  **Deferred Revenue (2410), NOT Revenue.** Resolution order: per-job override → per-revenue-type
  → company default → legacy job_type map.
- Respect period status (`enforce_period_lock`), COA approval (`enforce_coa_approval`), control
  accounts, and the stricter of per-account/per-location dimension flags (`validate_dimensions`).
- **Money-movement authorization must reconcile to Core identity** (`core.users/memberships/roles`).
  Preparer ≠ approver (DB CHECK + service); explicit human release; full audit. Do NOT bake a
  Books-private "who may approve" that won't reconcile to `core.memberships`.
  ⚠️ Session-40 `canApprove` currently reads `core.employees.role` as a **stopgap** — flagged for
  reconciliation to the identity contract.

## 4. Governance / completion standard (Rules 13–16)

- **A module is not "Complete" until it meets an approved Feature Product Brief (FPB).** The old
  render/works/real-data check is now only the **functional minimum**. Every module today is
  **"Functional — partial"; ZERO are Complete** (no FPB approved yet).
- **Write the FPB before building a module** (16 dimensions, incl. a QBO/Sage/best-in-class
  benchmark with named deltas). The Feature Completeness Ledger (Master Doc Part V.0) tracks depth.
- **No feature is built from a one-line description** — field-level spec first (Purpose · UI · AI
  behavior · Data model · Validation/gates · testable Acceptance criteria).

## 5. Current gate state (the STRICTLY ORDERED, GATED roadmap)

- **DONE & verified:** GATE 0 (foundation), GATE 1 (Core AI gateway), GATE 2 (deterministic
  posting engine, 18/18), GATE 12.0 (Plaid bank feed, live).
- **DONE & live (Session 41):** GATE 12.1 (Stripe "Pay Now") — payment→PAID→GL hardened
  (resume-safe idempotency; migration 064 UNIQUE indexes make the DB the double-post
  guarantor) and live. The coded platform-fee GL path is **RETIRED** — Merit books its own
  processor income via its own bank feed; the Operator Console (`/platform`) reads realized
  fee from `invoice_events` meta; `PLATFORM_ORG_ID` removed.
- **Build-complete, live-stamp pending:** GATE 3 (AI proposal layer) — owed: exercise the
  `ai:true` predict path against the live gateway once.
- **NO-GO gate #9 (identity/RBAC) — SUBSTANTIALLY ADVANCED (Session 42: the dominant blocker
  moved), STILL OPEN.** Done: **multi-tenant org resolution fixed** — `require-permission` +
  money/write routes resolve the caller's real org from the **verified Clerk claim** (not
  first-org; `resolveOrgId` claim-first), event workers post **per-event org** + shared
  `authorizeEventWorker` guard; plus (from S41) `canApprove` → `core.memberships`
  (+ role-normalize, inactive-employee deny), membership auto-provision + lifecycle sync,
  `require-permission` on 12 money routes, page-guards on 7 pages, report-route RLS sweep +
  migration 068 (security_invoker). **Still open:** a dedicated **`payments` permission** +
  first-class control/`team_performance` permissions (routes still borrow
  `journal_entries:create`); full control-route RBAC consistency; **`core.assignments`**
  (per-user scoping); the **event-worker read/"peek" scoping**; **location-scoped RLS**.
- **Financial Control Exception Library — ~11 detect-only classes (Session 42)** on the
  `ai_decisions → /exceptions` rail (migration 070 dedup guarantor): EC-1 duplicate-payment,
  EC-2 missed-accrual, EC-3 intercompany-balance, EC-4 uncategorized-leakage, EC-6
  revenue-not-recognized, EC-7 sales-tax-nexus, EC-10 anomalous-JE, EC-12 cutoff-error,
  CASH_APPLICATION, BILL_ANOMALY, 1099/W-9 readiness. All **detect-only**. **Session 43:** the
  **M10 Autonomy & Kill-Switch Control Plane** is LIVE (migration 075, `/settings/autonomy`:
  per-feature dial + global kill switch + disposition helper) and now **wired into 10 detectors** —
  a proposal's disposition (auto/queue/hold) honors the tenant's dial and surfaces on `/exceptions`,
  advancing the old `scoreToTier`-logging-only residual toward governed (still human-override)
  action. EC-5/8/9/11/13 remain.
- **Also shipped Session 42:** Payroll GATE 12.3 **Phase A** (provider-agnostic PayrollEngine,
  Mock + Check adapter; release = only money step; balanced GL `entry_type='PAYROLL_RUN'`;
  Phase B — releaser≠preparer + double-post guard + live Check — gated on provider pick).
  Invoices near-complete (credit memos, void, write-off, recurring [mig 073], AR statements,
  collections/DSO, report comparatives + PDF/CSV export). Budgets + budget-vs-actual,
  per-entity profitability, Close Command Center, Team Performance dashboard (mig 074,
  quality-gated KPIs), vendor ledger, onboarding all 9 rev-rec methods.
- **Discovery deepened:** six per-segment deep-dives (~230 caps) + `docs/discovery/COVERAGE-MATRIX.md`
  (honest depth scorecard; **thinnest = Budgeting/FP&A, Consolidation, Job Costing, Fixed Assets,
  Customer Mgmt**). **Owner directive:** NL prompts for processing + FP&A, cross-cutting.
- **Two Cowork workstreams share this repo** (MeritBooks + MeritProjects/Module 6): **path-scoped
  `git add` + disjoint migration bands — Books `0xx`, Projects `1xxx`.** Note: Books sequence
  **skips `072`**; migration `068` (report security_invoker) was renumbered off a `066` collision
  with the Projects seam.
- **Blocked:** GATE 4 (M365 email ingestion) — on IT returning Azure creds.
- **Open:** GATE 5 (confidence routing/learning), 6 (job-costing depth), 7 (reporting/FP&A
  depth — FPB written), 8 (remaining modules incl. bank-rec to Complete — FPB written — and
  AI cash application), **11a multi-entity consolidation — NOW HAS DEPTH (Session 43: migration
  076, `/consolidation` — ownership %, NCI, intercompany eliminations); polish per task #47**,
  11b–e (PO/3-way, inventory, sales-tax, approval-workflow), 10 (productization incl. Clerk
  dev→prod + RBAC nav enforcement + go-live key swap).
- **Session-43 depth builds (each behind its FPB):** the pervasive **NL surface (M8)** — global ⌘K
  command bar + FP&A Copilot (safe NL→ledger analytics on an allowlisted metric catalog, model never
  writes SQL, abstains; NL processing lanes P2–P4 propose→approve; FPB `docs/FPB-nl-copilot.md`);
  **M7 narrative** flux/variance on P&L/BS/CF/budget-vs-actual (deterministic drivers, model phrases
  only); **M13 search/knowledge** (`/search`); a **payment-run fraud screen** (new-payee/BEC/unusual/
  duplicate, detect-only); and depth in the thin segments — **job costing** (EAC + WIP over/under-
  billing), **customer mgmt** (dedupe + credit/risk dossier), **fixed assets** (methods + disposal +
  roll-forward). Gateway governance sweep closed the **7 direct-Anthropic seams** the AI-capability
  matrix flagged. **Still thin / in flight:** tax book-to-tax, onboarding conversion, covenant
  monitor, and the **M14 learning** column (untouched).
- **No gate may start until its `Prereq:` gates are DONE. "Complete" is demonstrated, not asserted.**

## 6. Canonical immediate priorities (Session 43 reconciliation)

1. **Finish closing identity gate #9** — org resolution is DONE; land the dedicated
   `payments` + control/`team_performance` permissions, `core.assignments`, event-worker
   read-scoping, and location-scoped RLS.
2. **Finish the thin-segment deepening now IN FLIGHT** — tax **book-to-tax**, **onboarding
   conversion**, **covenant monitor** — each behind its FPB; polish the Session-43 depth builds
   (consolidation 11a, job-costing, fixed-assets, customer-mgmt) against task #47.
3. **Payroll Phase B** once the provider is picked (releaser≠preparer, double-post guard,
   live Check). Invoices near-complete — finish write-off account role + `v_ar_aging`.
4. **Extend the control library toward EC-1..EC-13** and let the now-live **M10 autonomy plane**
   govern more dispositions (it currently governs 10 detectors).
5. **Open the M14 learning/personalization column** — the last untouched AI modality the
   14×24 matrix exposed (author the FPB first).

## 7. Session-40/41 note (honest)

Session 40 built real, deployed code **downstream of the gate order and without FPBs**, off
a stale repo `CLAUDE.md`, because the Project-knowledge canon was not read. **Session 41
corrected course:** it established the canon mirror + re-ground protocol (CLAUDE.md §0/§0.1,
opus-4.8 binding), authored the AI Capability Catalog + 5 operator briefs + five FPBs
(invoices, financial-reports, bank-reconciliation, payroll, financial-control-exceptions),
and did the money/identity/governance work spec-first and back on the gate order. See
`PROPOSED-MASTER-DOC-AMENDMENTS.md` (task #19, awaiting Mike's ratification) for the
autonomous-workforce framing and canon updates still to fold in.
