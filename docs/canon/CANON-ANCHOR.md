# MeritBooks — CANON ANCHOR

**Read this file in full at every trigger in the Re-Ground Protocol (see CLAUDE.md §0).**
It is deliberately small (~5 min read) so re-grounding is cheap. It is the distilled,
always-current truth. When it conflicts with the repo, **the canon wins** — fix the repo.
Source of truth: the Project-knowledge doc set (mirrored/digested in `docs/canon/`, indexed in `00-INDEX.md`).

Last reconciled: **2026-08-09 (Session 50)**. Latest handoff: `docs/MERITBOOKS-HANDOFF-session50.md`.
Repo HEAD **`e2702c5`** on `main` (`origin/main == d2b438c` — working tree **ahead 3**, the
auto-push loop is shipping `c8c3b22`/`9c0ee28`/`e2702c5`). Migrations through **149**; next Books
migration **150**. Prod on **dev Clerk** on purpose; Anthropic org disabled → all AI operationally
down (app degrades gracefully). **Material S50 milestone: subledger-to-GL tie-out remediation —
subledgers now tie to the GL by construction (independent re-audit confirmed closed).** See the
handoff §4 for the launch blockers.

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
- **Gate #9 (identity/RBAC) — ORG RESOLUTION CLOSED LIVE (Session 45); residual is now
  MANUAL-for-Mike + per-route money keys.** **Session 45:** multi-tenant org resolution is
  **closed live** — tenant resolved **claim-first from the Clerk native `o.id` org claim**
  (the custom `org_id` claim is null on the dev instance), with **auto-bind on login** and the
  **first-org fallbacks removed** (`get_org_id` matched in migration `087`). Prior: per-event-org
  event workers + `authorizeEventWorker`, `canApprove` → `core.memberships`, membership
  auto-provision + lifecycle sync, report-route RLS sweep (mig 068), a **dedicated `payments`
  money-movement permission** gating payments/payroll-release/checks-run, `/api/accounts`
  RLS-scoped, 5 direct Anthropic key reads routed through the Core AI gateway helper. **Still
  open:** the **MANUAL** work — stand up the **Clerk production instance for `app.meritbooks.app`
  + `org_id` claim** (to retire the native-`o.id` fallback), set **`EVENT_WORKER_SECRET`**, rotate
  the **Resend key**; plus (Claude-side) **split `payments` into per-route keys** so
  `check_processor` regains check-run without payroll-release (task #56), control/`team_performance`
  permissions, **`core.assignments`**, event-worker read/"peek" scoping, **location-scoped RLS**.
  (Historical detail — done prior:) multi-tenant org resolution (`resolveOrgId` claim-first),
  per-event-org event workers + `authorizeEventWorker`, `canApprove` → `core.memberships`,
  membership auto-provision + lifecycle sync, report-route RLS sweep (mig 068). **Session 44:**
  a **dedicated `payments` money-movement permission** (permissions.ts) now gates
  **payments / payroll-release / checks-run**; **`/api/accounts` RLS-scoped fix**; **5 direct
  Anthropic key reads routed through the Core AI gateway helper**. **Still open:** the **MANUAL**
  work — stand up the **Clerk production instance + `org_id` claim** (to drop the first-org
  fallbacks), set **`EVENT_WORKER_SECRET`**, rotate the **Resend key**; plus (Claude-side)
  **split `payments` into per-route keys** so `check_processor` regains check-run without
  payroll-release (task #56), control/`team_performance` permissions, **`core.assignments`**,
  event-worker read/"peek" scoping, **location-scoped RLS**.
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
  AI cash application — apply path + subledger↔GL tie-out shipped S44), **11a multi-entity
  consolidation — DEPTH (migration 076: ownership %, NCI, eliminations); 11b PO + 3-way match
  now DEPTH too (Session 44: migration 080, `/purchase-orders`)**; 11c–e (inventory, sales-tax
  [return-prep worksheet + GL tie-out shipped S44], approval-workflow), 10 (productization incl.
  Clerk dev→prod + RBAC nav enforcement + go-live key swap).
- **Session-43 depth builds (each behind its FPB):** the pervasive **NL surface (M8)** — global ⌘K
  command bar + FP&A Copilot (safe NL→ledger analytics on an allowlisted metric catalog, model never
  writes SQL, abstains; NL processing lanes P2–P4 propose→approve; FPB `docs/FPB-nl-copilot.md`);
  **M7 narrative** flux/variance on P&L/BS/CF/budget-vs-actual (deterministic drivers, model phrases
  only); **M13 search/knowledge** (`/search`); a **payment-run fraud screen** (new-payee/BEC/unusual/
  duplicate, detect-only); and depth in the thin segments — **job costing** (EAC + WIP over/under-
  billing), **customer mgmt** (dedupe + credit/risk dossier), **fixed assets** (methods + disposal +
  roll-forward). Gateway governance sweep closed the direct-Anthropic seams the AI-capability
  matrix flagged. **Session-44 depth builds (each behind its FPB):** the thin segments that were
  in flight now shipped — **book-to-tax** M-1/M-3 (migration 077), **onboarding historical
  conversion** (AI-mapped opening TB + tie-out gate + balanced go-live post), **covenant monitor**
  DSCR/FCCR/leverage (migration 078), **fixed-asset methods** enum + disposal roles (migration
  079), **purchase orders + 3-way match** (migration 080), **sales-tax return prep**, **AR
  collections + dunning**, **driver-based budgeting + reforecast**, **board-package generator**,
  and **AR cash-application apply** + subledger tie-out. The **M14 learning** column is now
  **OPENED** — a vendor→GL categorization-memory engine (learns from approved history; still
  the largest column but no longer untouched). **AP doc-intake** queue built, Azure-ready (GATE 4).
  **Session-45 builds (the month-end close / controls / tax / workflow spine; migrations 090–094):**
  **identity gate #9 org resolution CLOSED live** (Clerk native `o.id` claim + auto-bind, fallbacks
  removed); **FP&A dashboard** + what-if/sensitivity; **direct-method cash-flow + forecast**; **close
  orchestration** (ordered task graph, live auto-verify, blocking hard-close gate); **AP policy
  engine generalized** into a reusable primitive (+ expense-policy compiler); **Document Management
  Center + polymorphic attachments** with a **private `documents` Supabase storage bucket** (mig 090),
  AttachmentsPanel mounted on bill/invoice/lease/debt/fixed-asset/JE; **Controls / SOX command
  center**; ranked read-only **Action Inbox**; **configurable N-step approval workflows** by doc
  type + amount tier (mig 092, routes RLS-scoped); **recurring journal entries** propose→approve→post
  (mig 093); **ASC 740 income-tax provision** current+deferred from book-to-tax diffs (mig 091);
  read-only **1120-style Tax Return Package** + PDF export; and the **account-role registry COMPLETED**
  — income-tax/lease/prepaid/intangible/disposal roles, provision+prepaid resolved by role with number
  fallback (seed mig 094). Two legacy dup routes flagged for later cleanup (not deleted): `/recurring`
  (→ `/recurring-journal-entries`) and `/invoices/collections` (→ `/collections`).
- **Session-46 builds (opened the last two AI modalities to depth; migrations 095–098; HEAD `f056033`
  Vercel READY):** **M9 supervised agent orchestration** — a runner (`lib/agents/runner.ts`, mig 096
  `agent_runs`+`agent_run_steps`) with per-step **AUTO / PROPOSE / HUMAN_GATE** audit that honors the
  M10 autonomy dial + kill switch and **never posts money/GL directly** (canon §3); **framework + ONE
  loop (AP intake)** — order-to-cash / close-run / pay-run recipes are next. **M14 learning generalized**
  into an org-scoped **`learned_preferences`** store (mig 097; scopes CATEGORIZATION / CLOSE_CADENCE /
  REPORT_PREFS / TONE / METHOD_SSP) — **informs proposals only, never posts/approves**; opened broader
  than vendor-memory but not exhaustive. **M13 `/search` upgraded to Postgres GIN tsvector full-text**
  (mig 095, weighted, degrade-safe to `.ilike`) — strong **LEXICAL** retrieval, deliberately **NOT
  embeddings**. **Invoices FPB deltas CLOSED** (mig 098): `v_ar_aging` excludes `WRITTEN_OFF`, and a
  **`BAD_DEBT_EXPENSE` role** (+ acct 6670) so write-offs resolve the expense account **by role** — a
  final FPB read-through is the remaining check. Read-only **duplicate-vendor detection** on the vendor
  360 (+ `/api/vendors` `core.vendors` column-drift confirmed fixed). The opening build-ERROR streak had
  a **single cause** — a missing `ROLE_DEFAULT_NUMBER` export (`76bca49`) — now fixed; Vercel `next build`
  green at HEAD. **A Session-47 wave is IN FLIGHT** (M9 loop expansion, reconciliation Wave B,
  explain-this-X, collections depth, AP money-out MVP).
- **Session-47 (operability + white-label + auth-stability; migrations 099–111; HEAD `f961727`):**
  the "make it usable, keep it running" session. **(a) The production Clerk cutover was REVERTED
  to the DEV instance** — the prod attempt failed on **crossed publishable/secret keys**, so
  Vercel Clerk env + Supabase Third-Party-Auth were repointed to dev and production now runs on
  **dev Clerk ON PURPOSE**. ⚠️ Do NOT re-cut to prod until a **separate prod Supabase project +
  prod-Clerk Third-Party-Auth trust + a funded Anthropic key** are ready together (check pk/sk
  pairing). **Parked live tenant `eb3d8087-…` (prod Clerk, empty); working seeded tenant
  `1d1aa1ef-…` (dev Clerk).** **(b) Full sidebar INFORMATION-ARCHITECTURE redesign** —
  `navigation.ts` → **9 workflow groups** (Home · Payables · Receivables · Banking & Cash ·
  Accounting · Reporting & Analytics · Firm & Governance · Settings & Admin · Platform), pages
  folded into tabs/redirects, `planes.ts` remapped. **(c) Company-scoped processing control** —
  an active-company cookie context, header company picker, `useQuery` auto-scoping `location_id`,
  **`CompanyScopeGuard` on 31 processing pages**, sidebar hides processing nav until a company is
  selected, consolidated dashboard otherwise, reports consolidation admin-gated (a few master-data
  / cross-entity pages are intentionally NOT guarded). **(d) migration 110** grants EXECUTE on the
  Core AI-gateway RPCs to `authenticated` (fixed document upload); **migration 111** adds
  `core.locations.is_management_company` — `api/me` now filters on `!is_management_company` instead
  of a hardcoded `'merit management'` name-match (white-label). **(e)** RBAC page-guard
  single-active-membership org fallback (fixed ~18 pages reverting to dashboard); 5 erroring pages
  fixed (tax-dep/sales-tax/book-to-tax/consolidation/fixed-assets — API-envelope + cross-schema
  embed + query-param bugs); per-page help system; FP&A NL scenarios (`/api/fpna/nl-scenario` via
  the gateway); real global search palette + notifications bell; white-label copy scrub
  (Portfolio→Entities). ⚠️ **KNOWN-OPEN, not code bugs:** document AI parse still fails with
  Anthropic **"This organization has been disabled"** — the `ANTHROPIC_API_KEY` account is
  **disabled (billing/credits)**; and the standing Stripe/pglite/nl-route tsc/test-harness
  failures are **pre-existing, not regressions.** Next Books migration: **112**.
- **Session-48 (practice-plane / white-label productization; migrations 112,113,120,121,130–133,135;
  HEAD `2c480e4`):** turned the usable app into a **multi-company practice product**. **(a)
  Company-scope rollout finished** — budgets/reports/profitability/consolidation/board-package + a
  dozen create forms default to the header active company; 5 redundant in-page selectors removed;
  dashboard rebuilt as a per-company work board. **(b) Multi-company practice** (mig 121) — add-company
  dialog (COA seed), member assignment + per-company **"Owns onboarding"** designation; **Roles/admin
  moved to the Practice plane only.** **(c) Customizable permissions** (mig 130) — `core.custom_roles` +
  `core.role_permission_overrides`, a `resolve-permissions` merge layer, `/settings/roles` UI;
  **enforcement WIRED** into require-permission + page-guard via `effectivePermission()`,
  **degrade-safe** to system defaults (never a lock-out). **(d) Operator Console real metrics** (tenants/
  seats/AI cost/storage) + a **per-company pricing model** (mig 131; $99 first 5 + $59 after, Firm $499 +
  wholesale) with **computed list-price MRR — live charging NOT wired.** **(e) Honesty while AI is dark**
  — graceful AI-down everywhere (calm "AI temporarily paused"), FP&A NL made real with a heuristic parser
  that works WITHOUT live AI; **insurance now actually posts** (mig 132, prepaid→amortization, closes the
  overclaim); **consolidation FX/ASC-830 activated** (mig 133, `core.locations.functional_currency`);
  EC-14 out-of-policy detector; **payroll honesty** (register-import = primary; mock run labeled estimate).
  **(f) Launch polish** — report **`.xlsx` export**, **AP inbound email-to-bill** webhook (mig 135,
  `org.inbound_ap_address`), **money-movement SoD completion** (4 granular keys, effective access
  UNCHANGED). **(g)** source-doc retention (mig 112, store file before AI step) + money-out dup-payment
  UNIQUE index (mig 113); `PATCH /api/ai/decisions` gated `flagged:resolve`. Shared-spine: mig 120
  (`get_org_id` single-active-seat fallback, Projects-authored). Next Books migration: **136** (134 skipped).
  ⚠️ **KNOWN-OPEN launch blockers:** (1) **Anthropic org disabled/unfunded → ALL AI operationally down**
  (app degrades gracefully — not a code bug); (2) prod intentionally on **dev Clerk** (do NOT re-cut until
  a separate prod Supabase + prod-Clerk trust + funded Anthropic + live-billing decision are ready
  together; watch pk/sk pairing); (3) **live tenant Stripe charging NOT wired** (Operator MRR is list-price
  computed only); (4) **Stripe TEST + Plaid SANDBOX**; (5) payroll provider unpicked (mock = estimate);
  (6) marketing-honesty items (semantic search is FTS not vector; 1099 IRIS not built; insurance-posts now
  FIXED); (7) the paused hourly autonomous build task; (8) standing tsc/pglite harness failures are NOT
  regressions.
- **Session-49 (deterministic depth-and-polish while AI stays dark; migrations 136–138; HEAD `43ff536`,
  `origin/main == HEAD`):** no new architecture, no gate flips, no auth/billing change — a full wave of
  deterministic module depth that works without live AI. Shipped: **AP pay-run + remittance-advice PDF**
  (mig 137 vendor payment profiles, check-number assignment), **saved report views** (mig 138) + report
  drill/comparatives + exec-summary export, **deterministic CSV/XLSX payroll-register importer → balanced
  JE, no AI** (mig 136, zero-dep XLSX reader; the honest primary payroll path — mock run stays labeled an
  estimate), **customer statements** + AR activity ledger, **job POC P&L + WIP schedule**, **1099
  NEC-vs-MISC box classification + candidate worklist** (classify-only; NEC generates, MISC/IRIS future),
  **inventory stock-valuation report + GL tie-out**, **documents center + audit-trail depth**, **ASC 740
  deferred rollforward + M-1 subtotals**, **COA grouped-balances view** + `/api/accounts/balances`,
  **rev-rec deferred rollforward + per-contract waterfall + method summary**, **expenses approver queue +
  reimbursement batch**, **subscriptions run-rate/creep/renewals/triage**, **vendor 360** (+ removed a raw
  `tin_encrypted` PII field from the `/api/vendors` response), **inbox live-count depth**, **bank-feed
  saved views + deterministic confidence explainer + bulk select-by-band/vendor**, **reconciliation
  outstanding-item aging + difference decomposer (surfaces the residual plug) + read-only history**,
  **board-package deterministic MD&A + KPI trend strip + DSO/DPO into PDF/XLSX**, **approval-workflow
  chain visualizer + read-only scenario simulator + coverage-gap detector**, and **~105 new pure unit
  tests**. ⚠️ **Ground-truth correction:** the S48 handoff said "next migration 136" — in fact **136/137/138
  all landed in S49** (git-verified), so the S48 body listing them as already-recorded was inaccurate.
  ⚠️ **New security seam for the next pass:** the reconciliation-history route (`/api/reconciliation/history`)
  uses the **admin client** to resolve finalizer display names, strictly scoped to `core.users` ids present
  on the caller's own org-scoped recs (no cross-tenant exposure) — flag for the security lane. **KNOWN-OPEN
  launch blockers UNCHANGED** (all human-only): (1) Anthropic org disabled → all AI operationally down (app
  degrades gracefully, not a code bug); (2) prod intentionally on dev Clerk (do NOT re-cut until separate
  prod Supabase + prod-Clerk trust + funded Anthropic + live-billing decision are ready together; watch
  pk/sk pairing); (3) live tenant Stripe charging NOT wired (Operator MRR list-price computed only);
  (4) Stripe TEST + Plaid SANDBOX; (5) payroll provider unpicked (mock = estimate; register-import = honest
  primary); (6) marketing-honesty items (FTS not vector; 1099 IRIS not built); (7) paused hourly autonomous
  build task; (8) standing tsc/pglite harness failures are NOT regressions.
- **Session-50 (product breadth to the credential boundary, then a subledger↔GL INTEGRITY
  remediation; migrations 139–149; HEAD `e2702c5`, working tree ahead 3 of `origin/main`):** no
  gate flips, no auth/billing change. First pushed the last customer-facing gaps out to the
  **credential boundary** (each needs only Mike's live credential/provider): **estimates→invoice**
  (mig 139, non-posting doc; convert calls the unchanged `createInvoice`/GL path) + **customer
  deposits/retainers** (mig 140, 2420 subledger, over-apply impossible); **borrowing base**
  calculator; **customer + vendor self-service portals** (mig 141/142, magic-link, token-scoped;
  vendor uploads land PENDING); **1099-MISC + FIRE e-file** (NEC untouched; transmission needs a
  human TCC); **ACH/wire origination rail** (mig 143, SANDBOX adapter on the already-posted
  disbursement release — **posts nothing to the GL**); **live sales-tax rate engine** (mig 144,
  effective-dated internal table + Avalara/TaxJar scaffold, SAFE fallback); **direct-API migration
  connectors** (QBO/Xero/Sage MOCK pull feeding the real conversion pipeline); **external-auditor
  access + PBC** (mig 145, view-only on the custom-role system); **error observability** (mig 146,
  `app_error_log` wired into api-handler + boundaries, optional Sentry); **perf pagination +
  indexes** (mig 148); and a **reporting-basis overlay** (mig 147, Accrual|Tax|Cash|Custom — a
  non-posting layer on the one GAAP book; the safe stand-in for full parallel-ledger multi-book,
  which stays deferred). Also fixed the **api-client double-`?` URL bug** (broke AR aging via a
  `uuid` cast) and **rebuilt the accounting-manager KPI dashboard** (was silently empty from an
  API-contract mismatch). **THE MATERIAL MILESTONE — `e2702c5` INTEGRITY REMEDIATION (mig 149):**
  a read-only subledger-to-GL tie-out audit found several subledgers not tying to the GL; the fix
  makes them **tie by construction** (independent re-audit **confirmed all closed**): **AR now
  debits AR_CONTROL(1100) BY ROLE** (was a broken account-number range that excluded 1100,
  mis-posting to 12xx on estimate-conversion/recurring/agentic invoices — `v_ar_aging` now ties to
  GL 1100); **lease commencement** posts DR ROU(1580)/CR lease-liability(2550); **debt origination**
  posts DR cash/CR notes-payable(2500) and splits principal vs interest(8000) by role (**fails
  closed 422** without an open period + resolvable roles); **rev-rec** resolves 2410/1180/revenue
  by role + `source_ref` idempotency; **payroll remittance** route clears tax/benefit payables;
  **fixed-asset** orphan-GL reversal + disposal idempotency + prepaid tie-out; **one-click
  cash/accrual** basis toggle; and **security mediums** — rate-limit the 3 public token endpoints
  (429), payroll **releaser≠approver** SoD, `gl/post` empty-org 400, anon grants revoked on
  portal-token tables. Everything still posts only through `postJournalEntry` (debits=credits),
  accounts resolve by role, idempotency via `source_ref` + mig-064 unique index. **Deferred by
  design:** semantic/embeddings search (needs an embedding provider; non-functional with AI down —
  `/search` stays FTS) and full multi-book parallel ledger (basis overlay is the shipped safe
  version). **KNOWN-OPEN launch blockers UNCHANGED** (all human-only): (1) Anthropic org disabled →
  all AI operationally down (graceful, not a code bug); (2) prod intentionally on dev Clerk (do NOT
  re-cut until separate prod Supabase + prod-Clerk trust + funded Anthropic + live-billing decision
  are ready together; watch pk/sk pairing); (3) live tenant Stripe charging NOT wired (Operator MRR
  list-price computed); (4) Stripe TEST + Plaid SANDBOX (+ ACH origination SANDBOX); (5) payroll
  provider unpicked (register-import = honest primary; mock = estimate; the releaser≠preparer SoD
  half now landed); (6) marketing-honesty items (FTS not vector; 1099 IRIS/FIRE-transmission needs a
  TCC; insurance-posts FIXED); (7) paused hourly autonomous build task; (8) standing tsc/pglite
  harness failures are NOT regressions. ⚠️ **Branded invoice email already works — do NOT list email
  as a blocker.** Minor follow-ups: basis-adjustments manager still allows manual CASH rows the
  toggle ignores; role-based sidebar shows-all for custom roles (fail-safe; page-guards still
  enforce); the new public-token rate limiter is per-instance in-memory (move to a shared store for
  cross-instance throttling).
- **No gate may start until its `Prereq:` gates are DONE. "Complete" is demonstrated, not asserted.**

## 6. Canonical immediate priorities (Session 50 reconciliation — unchanged from S48/S49; all human-gated)

0. **Clear the launch blockers, then prep a clean prod cutover.** (a) **Fund/re-enable the
   Anthropic account** — the org is disabled/unfunded so ALL AI is operationally down (the app
   degrades gracefully; this is NOT a code bug). Re-verify a full drop-and-parse round-trip + the
   NL/FP&A paths against live AI once funded. (b) **Make a live-billing decision**, then (if go)
   wire real Stripe subscription charging so the Operator Console MRR is realized, not list-price
   computed. (c) **Prepare — do NOT execute — the production cutover:** stand up a dedicated
   **prod Supabase project**, repoint **prod-Clerk Third-Party-Auth trust**, ensure a **funded
   Anthropic key**, and script the env swap with a **pk/sk pairing check** so the crossed-key
   failure cannot recur. (d) **Verify the practice operator flow in Chrome** on the deployed
   (dev-Clerk) app: new company → assign member + onboarding owner → per-company scoped processing
   → custom-role enforcement → Operator Console metrics → tenant billing page. (e) **Reconcile the
   marketing site to shipped reality** (semantic search is FTS not vector; 1099 IRIS not built;
   insurance-posts now FIXED). Keep every money/GL step on the deterministic engines behind human
   gates. Note: Stripe is TEST mode + Plaid SANDBOX; payroll provider still unpicked (mock = estimate).
1. **Finish closing identity gate #9** — org resolution is **CLOSED live** (Clerk native `o.id`
   claim + auto-bind, fallbacks removed) and the dedicated `payments` permission is DONE. The
   residual is now mostly **MANUAL for Mike:** stand up the **Clerk production instance for
   `app.meritbooks.app` + `org_id` claim** (retires the native-`o.id` fallback), add
   `app.meritbooks.app` to the **`meritbooks-web`** Vercel project, set **`NEXT_PUBLIC_APP_URL`**
   + **`EVENT_WORKER_SECRET`**, rotate the **Resend key**. ⚠️ The marketing site is a SEPARATE
   Vercel project (`meritbooks-marketing`) — apex `meritbooks.app` stays with marketing; the app
   gets `app.` only. Then (Claude-side) **split `payments` into per-route keys** (task #56), add
   control/`team_performance` permissions, `core.assignments`, event-worker read-scoping, and
   location-scoped RLS.
2. **Polish the now-deepened segments** — consolidation (11a), job-costing, fixed-assets,
   customer-mgmt, book-to-tax (077), onboarding conversion, covenant monitor (078), POs (080),
   sales-tax, collections, driver budgeting, board package, cash-application — against their
   follow-ups; clear **verifier concerns (task #52)**.
3. **Payroll Phase B** once the provider is picked (releaser≠preparer, double-post guard,
   live Check). Invoices near-complete — finish write-off account role + `v_ar_aging`.
   **Unblock GATE 4** (AP OCR / email ingestion) with **Azure creds** — the AP intake queue is
   built and Azure-ready.
4. **Extend the control library toward EC-1..EC-13** and let the **M10 autonomy plane** govern
   more dispositions (it currently governs 10 detectors).
5. **Grow the M14 learning column** — now OPENED with vendor→GL categorization memory; extend
   personalization beyond it (the modality is opened, not full).

## 7. Session-40/41 note (honest)

Session 40 built real, deployed code **downstream of the gate order and without FPBs**, off
a stale repo `CLAUDE.md`, because the Project-knowledge canon was not read. **Session 41
corrected course:** it established the canon mirror + re-ground protocol (CLAUDE.md §0/§0.1,
opus-4.8 binding), authored the AI Capability Catalog + 5 operator briefs + five FPBs
(invoices, financial-reports, bank-reconciliation, payroll, financial-control-exceptions),
and did the money/identity/governance work spec-first and back on the gate order. See
`PROPOSED-MASTER-DOC-AMENDMENTS.md` (task #19, awaiting Mike's ratification) for the
autonomous-workforce framing and canon updates still to fold in.
