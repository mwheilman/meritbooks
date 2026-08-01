# MeritBooks — CANON ANCHOR

**Read this file in full at every trigger in the Re-Ground Protocol (see CLAUDE.md §0).**
It is deliberately small (~5 min read) so re-grounding is cheap. It is the distilled,
always-current truth. When it conflicts with the repo, **the canon wins** — fix the repo.
Source of truth: the Project-knowledge doc set (mirrored/digested in `docs/canon/`, indexed in `00-INDEX.md`).

Last reconciled: **2026-08-01 (Session 40)**.

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
- **Build-complete, live-stamp pending:** GATE 3 (AI proposal layer) — owed: exercise the
  `ai:true` predict path against the live gateway once.
- **Open blocker — highest priority:** GATE 12.1 (Stripe "Pay Now") — payment→PAID→GL chain not
  verified; suspected platform-account webhook-scope issue; run a `4242` card test.
- **Blocked:** GATE 4 (M365 email ingestion) — on IT returning Azure creds.
- **Open:** GATE 5 (confidence routing/learning), 6 (job-costing depth), 7 (reporting/FP&A depth),
  8 (remaining modules incl. AI cash application), **11a multi-entity consolidation — MANDATORY,
  top priority**, 11b–e (PO/3-way, inventory, sales-tax, approval-workflow), 9 (AI moat), 10
  (productization incl. Clerk dev→prod + RBAC nav enforcement + go-live key swap).
- **No gate may start until its `Prereq:` gates are DONE. "Complete" is demonstrated, not asserted.**

## 6. Canonical immediate priorities (per Session 37 + reconciliation)

1. Unblock & verify **GATE 12.1** (Stripe payment→PAID→GL: webhook scope + card test).
2. Reconcile **`canApprove`** to the `core.memberships/roles` identity contract.
3. Write the **Invoice FPB**, then build Invoices to *Complete* (email send is the biggest gap:
   branded email + PDF + Pay Now button; then credit memos, recurring, dunning/late fees, AR aging/DSO).
4. Only then resume downstream waves (7/8/9/11a) — each behind its FPB.

## 7. Session-40 note (honest)

Session 40 built real, deployed, typecheck-green code (Stripe fee schedule, Check Run,
`canApprove` fix, and a wave: Vendor Compliance risk engine, Reconciliation autopilot, 13-Week
Cash Forecast) — but built **downstream of the gate order and without FPBs**, off a stale repo
`CLAUDE.md`, because the Project-knowledge canon was not read. Value is salvageable but must be
reconciled to the canon (and folded into FPBs) rather than treated as complete. See
`PROPOSED-MASTER-DOC-AMENDMENTS.md` for the ideas from this session that should update the canon.
