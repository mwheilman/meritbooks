# MeritBooks — Session 42 Handoff

**Date:** 2026-08-01/02
**Supersedes:** session 41. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), and the FPBs (invoices, financial-reports, bank-reconciliation, payroll,
financial-control-exceptions, team-performance, identity-multitenancy,
tenant-model-consolidation-analytics, payments-fees).

> **Coordination note (read first):** two Cowork sessions now commit to this one repo —
> **MeritBooks** (this handoff) and **MeritProjects** (Module 6, the `feat(projects): …`
> commits). They are disjoint workstreams sharing one git history, one Supabase, one
> migration sequence. Rules in force: **path-scoped `git add`** (never `git add -A`), and
> **disjoint migration bands — Books `0xx`, Projects `1xxx`.** In this handoff, ignore the
> `proj`/`projects` commits (`e412b7f`, `ba2dad4`, `0378edd`, `a8a18b9`, migrations
> `066/067`, `1001–1005`) except where they touch the shared spine.

---

## 1. Headline

The session that **broadened the book of record into a controllership platform** while
closing the largest identity gap. Multi-tenant org resolution — the dominant gate-#9
blocker — was fixed: `require-permission` and the money/write routes now resolve the
caller's **real org from the verified Clerk claim** (not first-org), and the event workers
post under **each event's own org** with a shared auth guard. On top of that spine the
session shipped, depth-first and behind FPBs: **Payroll GATE 12.3 Phase A** (provider-
agnostic, Check-ready), **Invoices to near-complete** (credit memos, void, write-off,
recurring, AR statements, collections/DSO, export), a **~11-class Financial Control
Exception Library** (all detect-only), **budgets + budget-vs-actual**, **per-entity
profitability**, a **Close Command Center**, a **Team Performance KPI dashboard**, and
**vendor ledger** depth. Discovery was deepened into six per-segment deep-dives
(~230 capabilities) + an honest COVERAGE-MATRIX. Owner directive recorded: **NL prompts
for processing + FP&A as a cross-cutting feature.**

Everything below is on `main`. **Latest READY production deploy is `de11940`** (Team
Performance dashboard); every Books wave commit through it is Vercel **READY** (`next build`
— the authoritative full-project typecheck — green). The two newest commits — `1de6593`
(docs-only) and HEAD `a8a18b9` (Projects G6 UI, verified locally `tsc --noEmit` + `next
build` green) — were **QUEUED/building** at handoff and are expected green.

---

## 2. What shipped this session (Books; verified via `next build` READY)

### Identity / RBAC gate #9 — SUBSTANTIALLY ADVANCED (the top blocker moved)
- **Multi-tenant org resolution — the dominant blocker — fixed** (`00ff6d1`, HIGH-1). The
  route-level RBAC guard previously resolved the org as "first org"
  (`select id from organizations limit 1`) and checked the caller's role in the *wrong*
  tenant. It now resolves the org from the **verified Clerk `org_id` claim** (`requireAuth`,
  the same source `get_org_id()` enforces in RLS), reads the role scoped to that org, and
  normalizes it so page/route/approval authz agree. First-org survives only as a transitional
  fallback until the claim is provisioned; also filters `is_active`.
- **`resolveOrgId(db, preferredOrgId?)` claim-first, threaded across write paths** (`42cca3f`)
  — payments / period-engine / posting / bank-accounts / integrations(plaid) / sandbox +
  posting-verify all prefer the verified claim org.
- **Event workers post per-event org + auth guard** (`645ed13`). `events/{billing,dept-invoice,
  progress}/process` drains now post under **each event's own `org_id`** (was first-org =
  cross-tenant leak); a shared `authorizeEventWorker` guard (Clerk session **or** constant-time
  `EVENT_WORKER_SECRET` header) covers all three — `dept-invoice` was previously unguarded.
- **Control-scan route RBAC made consistent** (`63cfa71`) — `require-permission`
  (`journal_entries:create`) added to duplicate-payments / anomalous-je / uncategorized-leakage
  / intercompany-balance scan routes (missed-accruals already had it); unprivileged members 403.
- Carried from the session-41 wave and still in force: `canApprove` → `core.memberships`
  (+ role-normalize, inactive-employee deny), membership auto-provision on login, lifecycle
  sync on deactivate/reactivate/role-change, `require-permission` on 12 money routes,
  page-level RBAC guards on 7 sensitive pages.

**STILL OPEN (gate #9 residual):** a dedicated **`payments` permission** and a **`team_performance`
/ control-route permission** set (money + control routes still borrow checks/bills/payroll/
journal_entries:create); full **control-route `require-permission` coverage** consistency;
**`core.assignments`** (per-user location/company scoping) not built; the **event-worker "peek"
scoping** (a worker draining events must not read across orgs beyond the event it posts);
**location-scoped RLS** (per-client fiduciary isolation, identity FPB §7.1) specced, not built.
See §4.

### Payroll — GATE 12.3 Phase A (provider-agnostic, Check-ready) (`3b2c9fa`, migration 069)
- **Provider-agnostic `PayrollEngine` interface** so any provider plugs in and MeritBooks is
  **never the regulated party**: `MockPayrollEngine` (deterministic dev/no-provider fallback),
  `CheckPayrollEngine` (Check API shape, creds from Vault `secret_ref`, degrades when
  unconfigured), `resolvePayrollEngine` (reads `core.provider_connections` capability PAYROLL,
  mock fallback).
- **Run state machine** DRAFT→PREVIEWED→APPROVED→RELEASED→PROCESSING/PAID. **Release is the
  ONLY money-movement step** (explicit human). SoD via `approvals(kind PAYROLL_RUN)` +
  `canApprove` + DB CHECK. `postRun` posts a **balanced GL entry** with `entry_type='PAYROLL_RUN'`.
- **No PII stored** — `payroll_runs / payroll_run_employees / pay_schedules` hold only amounts +
  provider refs; PII lives at the provider + Vault, `core.employees` stays thin. RLS org-isolation.
- **Security GO for Phase A (mock).** **Phase B checklist (task #34):** enforce releaser ≠ preparer
  at release, a payroll **double-post guard**, and live Check sandbox — blocked on the provider pick.

### Invoices — driven to NEAR-COMPLETE (FPB-invoices)
- **Credit memos** (`bc887a5`, migration 071): create/post/apply/void; post = balanced GL
  (DR revenue **or** Deferred 2410 for rev-rec-managed linked invoices + DR sales tax / CR AR by
  role; `source_ref=credit_memo:<id>` so migration 064 guards double-post); apply reduces invoice
  balance (clamped). 10 tests.
- **Void + write-off** (`42cca3f`): void reverses the AR posting (refuses if paid → credit-memo
  instead); write-off = DR Bad Debt Expense / CR AR by role, `source_ref` guarded. *Needs a
  `BAD_DEBT_EXPENSE` account role + `v_ar_aging` to exclude `WRITTEN_OFF` — flagged.*
- **Recurring invoices** (`645ed13`, migration 073): template CRUD + cadence math + generate-due
  through the **shared create-invoice core** (rev-rec-aware GL), idempotent, optional auto-send;
  Recurring tab. 23 tests.
- **AR customer statements** (`645ed13`): branded PDF (aging + open items) + email via existing
  transport (graceful degrade); Statement actions on the customer drawer. 12 tests.
- **AR Collections / DSO** (`36fc6cc`, `/invoices/collections`): aging buckets, DSO,
  avg-days-to-pay, ranked worklist with one-click reminder, per-customer rollup — real data.
- **Financial-statement export** (`42cca3f`): branded PDF (@react-pdf) + Excel(CSV) for P&L/BS/CF/TB,
  reusing the RLS report endpoints + filters/consolidation. (native xlsx lib later.)

### Financial Control Exception Library — ~11 detect-only classes on `ai_decisions → /exceptions`
All are **detect-only** (propose to `/exceptions`, never move money), tiered, idempotent via
`ai_decisions` open-dedup (**migration 070** unique guarantor):
- **EC-1** duplicate-payment / duplicate-vendor (23 tests) — `8b74bcf`
- **EC-10** anomalous-JE (missing support, structuring, sensitive account, backdated, round-dollar,
  after-hours; dedup widened to APPROVED/REJECTED + log-once to kill audit noise) — `8b74bcf`,`5a2004e`
- **EC-4** uncategorized/unposted cost-leakage (blocks a clean close >$25k) (20 tests) — `0409a1e`
- **EC-3** intercompany/interdept out-of-balance (19 tests) — `0409a1e`
- **EC-2** missed-accrual (vendor recurrence gaps, due templates, unposted schedules; drafts an
  accrual JE) (36 tests) — `bc887a5`
- **EC-6** revenue-not-recognized (reuses rev-rec) — `42cca3f`
- **EC-12** cutoff-error (economic-date vs posted-period, materiality) — `42cca3f`
- **EC-7** sales-tax nexus tripwire (trailing-12mo revenue+txns by destination state vs economic-
  nexus thresholds, per-state overrides) — `645ed13`
- **CASH_APPLICATION** AI cash-application (matches unmatched bank deposits to open invoices,
  single + sum-to-total, composite scorer; `cashapp:<txn>` dedup) (19 tests) — `63cfa71`
- **BILL_ANOMALY** bill/AP anomaly (vendor price/qty variance, first-time-large, round-dollar
  before-post; `billanom:<bill_id>` dedup) (20 tests) — `c6af45a`
- **1099-NEC readiness** (`/compliance-1099`): vendors paid >$600/yr (card rails excluded) ×
  W-9/TIN status → READY / MISSING-W9 / NOT-MARKED; flag-gap queues a W-9 chase — `c6af45a`

*Not yet wired: `scoreToTier` into the actual auto-post/queue **disposition** (still logging-only).*

### FP&A / close / reporting depth
- **Budgets + Budget-vs-Actual** (`c6af45a`, `/budgets`, migration 013): budget authoring grid +
  variance report (budget/actual/var$/var% by section, favorable/unfavorable); vs-actual route is
  RLS + dept-scoped.
- **Per-entity profitability** (`c6af45a`, `/profitability`, Practice plane): P&L by TYPE per
  company + portfolio roll-up + chart.
- **Report comparatives** (`104636d`): P&L comparison now derives the prior window from the SELECTED
  range (None / Prior-Period / Prior-Year / Budget + variance).
- **Reports RLS + real eliminations** (`36fc6cc`): consolidated **nets `is_eliminating` accounts to
  zero** at roll-up (tie-out test); cash-flow classifies by account TYPE/role.
- **Close Command Center** (`bc887a5`, `/close-status`, `close_mgmt:view`): per-entity close
  readiness (period, bank-rec, EC-4 leakage, open-exception $, flagged) → green/amber/red + roll-up.
- **Bank-Rec Wave B** (`c6af45a`): in-rec adjusting entries (bank fee DR 6630 / CR cash; interest DR
  cash / CR income) via `postJournalEntry`, mirrors a cleared `bank_transaction` so the rec ties to
  $0; `source_ref` guards. (Wave A per-line check-off + migration 065 shipped session 41.)

### Team Performance (new console)
- **Team Performance FPB** (`104636d`, `docs/FPB-team-performance.md`) — 30+ objective KPIs
  (throughput, cycle-time upload→categorized→approved, approval latency, rework/correction rate,
  autonomy machine-vs-human, engagement, backlog aging) across manager / IT-admin / bookkeeper lenses.
- **Dashboard + instrumentation** (`de11940`, **migration 074**): `bank_transactions.categorized_at`,
  `bills.received_at`, `fiscal_periods.close_started_at/closed_at`, `performance_config`
  (difficulty weights + targets). `/api/team-performance` (RLS; manager sees team via `team:view`,
  self sees own card) computes per-person scorecards from `action_log` + the new timestamps with a
  **difficulty-weighted composite that is QUALITY-GATED** (a high-volume/high-rework worker is
  flagged, never top — anti-gaming), null-when-no-data. Performance tab on `/team`.
- **Vendor ledger depth** (`104636d`): vendor detail drawer — open bills, payment history, YTD/TTM
  spend, W-9/COI compliance, hold state.

### Onboarding / rev-rec
- Onboarding / settings rev-rec wizard offers **all 9 methods** with plain-language industry
  guidance (carried + reinforced).

### Discovery / governance
- **Six per-segment deep-dives** (`1de6593`, expert × AI-engineer, ~230 capabilities with
  build-state): budgeting-fpna (40), accounts-payable (40), accounts-receivable (35), gl-close (36),
  bank-cash (36), tax-compliance (43), under `docs/discovery/segments/`.
- **`docs/discovery/COVERAGE-MATRIX.md`** — honest per-segment depth scorecard (operator-need depth
  0–3, AI-capability depth 0–3 + count, build-state, biggest gap, Low/Med/High completeness).
  Verdict: discovery was broad-not-deep; **thinnest = Budgeting/FP&A, Consolidation, Job Costing,
  Fixed Assets, Customer Mgmt.**
- FPBs now on disk: invoices, financial-reports, bank-reconciliation, payroll,
  financial-control-exceptions, **team-performance** (new), identity-multitenancy,
  tenant-model-consolidation-analytics, payments-fees. (No dedicated `nl-copilot` FPB yet —
  the NL directive is recorded in COVERAGE-MATRIX / owner directive, not yet an FPB.)
- **Owner directive recorded:** NL prompts for both processing and FP&A, as a cross-cutting feature.

---

## 3. Data / infra changes (reproducibility notes)

- **Books migrations applied to Supabase this session (Supabase first, then code):**
  - `068_report_views_security_invoker.sql` — `security_invoker=true` on public views (applied
    `5a2004e`; **renumbered from the duplicate-066 collision** — see below).
  - `069_payroll_run_model.sql` — payroll runs / run-employees / pay-schedules (RLS).
  - `070_ai_decisions_dedup_unique.sql` — open-dedup unique index (the exception-library guarantor).
  - `071_credit_memos.sql`.
  - `073_recurring_invoice_templates.sql`. **(Note: there is NO `072` — the number was skipped;
    the sequence goes 071 → 073.)**
  - `074_team_performance_timestamps.sql`.
  - (Session-41 `064` dedupe indexes, `065` bank-rec link remain applied.)
- **Migration-collision fix:** a parallel MeritProjects `git add -A` swept `066_proj_seam.sql` +
  `067_proj_contract_progress_standalone.sql` onto `main` and they collided with the Books
  security-invoker file, which was **renumbered to `068`**. Going forward the two workstreams
  **share one sequence** and use **path-scoped `git add` + disjoint bands (Books `0xx`, Projects
  `1xxx`).** The Projects seam (`066/067`) and operational migrations (`1001–1005`) are applied by
  the Projects workstream, not Books; do not assume Books owns them.
- **Key ids unchanged:** org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project
  `npqeijipggtuduhkejxq`; Clerk user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team
  `team_2EwoHwR0BcH6GNjMjCbMaVAW`, project `meritbooks-web`.
- **Auto-push loop still live** on Mike's machine (ships `main` commits automatically). Claude
  cannot push from the sandbox and must not handle a token.

---

## 4. Open items — DO NOT FORGET

### Identity gate #9 — the residual (org resolution is fixed; these remain before it closes)
- [ ] **Dedicated `payments` permission** in `permissions.ts` (money routes still borrow
      checks/bills/payroll). (task #33)
- [ ] **`team_performance` + control-route permissions** — control/report routes still borrow
      `journal_entries:create`; make the permission set first-class and consistent.
- [ ] **`core.assignments`** — per-user location/company scoping — not built.
- [ ] **Event-worker "peek" scoping** — a worker draining `core.events` must not read across orgs
      beyond the event it posts (it now *posts* per-event org; tighten the *read*).
- [ ] **Location-scoped RLS** (per-client fiduciary isolation, identity FPB §7.1) — specced, not built.

### Payroll Phase B (task #34; blocked on provider pick)
- [ ] Enforce **releaser ≠ preparer** at release; **payroll double-post guard**; wire the **live
      Check sandbox**. Phase A (mock) is GO and buildable now.

### Verification still owed
- [ ] **Browser-verify** the money loop end-to-end + the new surfaces with real data: payroll run
      DRAFT→PAID; credit memo / void / write-off; recurring-invoice generate; `/budgets`,
      `/profitability`, `/close-status`, `/team` Performance tab, `/compliance-1099`,
      `/invoices/collections`; the ~11 control detectors landing in `/exceptions`. `next build`
      (authoritative typecheck) is green; pages have not all been walked in a browser.

### Known drift / deferred (carried forward)
- [ ] Invoice write-off needs a **`BAD_DEBT_EXPENSE` account role** + `v_ar_aging` to exclude
      `WRITTEN_OFF`.
- [ ] `api/vendors/route.ts` references `core.vendors` columns that don't exist on the live table
      (country/notes/tax_id/payment_terms/is_1099) — that path errors; migrations lag live schema.
- [ ] **AP attachment**: `bills.source_file_url` set null — needs a Supabase **storage bucket**
      (one-time) + upload wiring.
- [ ] AP line coding falls back to acct 6660 (Misc OPEX) when no account resolves.
- [ ] `scoreToTier` not yet wired into control-exception **disposition** (logging-only).

### Mike's manual to-dos (Claude can't do these)
- [ ] **Ratify the Master-Doc amendments** — `docs/PROPOSED-MASTER-DOC-AMENDMENTS.md` (task #19).
- [ ] **Pick the payroll provider** — **Check** vs. Gusto — to unblock Payroll Phase B. (task #32,
      leaning Check.)
- [ ] **Rotate the Resend API key** and set **`INVOICE_FROM_EMAIL`** for live invoice/statement email.
- [ ] **Clerk production instance** + JWT template + register Supabase (dev works now).
- [ ] **Set `EVENT_WORKER_SECRET`** (the event-worker auth guard's constant-time header secret).

---

## 5. Direction — what's next

Per the canon gate order and `NORTH-STAR.md` (autonomous engine + supervision/trust layer;
depth-first, one pipeline per parallel wave, behind an FPB):

1. **Finish closing identity gate #9** — org resolution is done; land the dedicated `payments`/
   control permissions, `core.assignments`, event-worker read-scoping, and location-scoped RLS.
2. **Deepen the thin segments the COVERAGE-MATRIX exposed** — **Budgeting/FP&A, Consolidation
   (11a — MANDATORY), Job Costing, Fixed Assets, Customer Mgmt** — each behind its FPB.
3. **Payroll Phase B** once the provider is picked (releaser≠preparer, double-post guard, live Check).
4. **Wire `scoreToTier` into control-exception disposition** (auto-post/queue), not just logging;
   extend the library toward the full EC-1..EC-13 set.
5. **NL prompts for processing + FP&A** (owner directive) — author the FPB, then build.
6. **AP inbox pipeline** once the storage bucket exists.

Execution model unchanged: file-disjoint vertical slices, 3–5 concurrent builder/general-purpose
agents (all **opus 4.8**) in one message, shared spine single-threaded through the lead, migrations
to Supabase first, Vercel `next build` as the authoritative typecheck. **Now with a second
concurrent workstream (MeritProjects) in the same repo — path-scoped commits + disjoint migration
bands are mandatory.**

---

## 6. Agents

Eight in `.claude/agents/` (builder, verifier, auditor, reviewer, designer, scribe, security,
chrome-auditor) plus SDK agents (general-purpose, Explore, Plan). **Every agent runs on `opus` —
`claude-opus-4-8` — no exceptions** (Owner directive, binding in CLAUDE.md §0.1). This session ran
multiple concurrent `general-purpose`/builder waves on disjoint slices, with security review on the
money/identity/control waves (Payroll Phase A mock = GO; Phase B fixes gated to task #34).

---

## 7. Live state

- **Latest READY production deploy: `main` @ `de11940`** (Team Performance dashboard). Every Books
  wave commit through it is Vercel **READY** (`next build`/typecheck green). HEAD is `a8a18b9`
  (Projects G6 UI) with `1de6593` (docs) behind it — both **QUEUED/building** at handoff, expected
  green (docs-only + locally build-verified). One Books commit shows CANCELED (`c6af45a`) only
  because its child `b0f6092` superseded it mid-build; its code is live via that child.
- Books migrations `064–065` + `068–074` (no `072`) applied to Supabase; Projects `066/067` +
  `1001–1005` applied by the Projects workstream.
- Clerk↔Supabase active on the **dev** Clerk instance; auto-push loop running on Mike's machine.
- **Verification:** the session verifier reported **~600 tests passing** (money/identity/billing/
  rev-rec/reconciliation/payroll + the ~11-class control library + team-performance; a mid-wave
  verifier snapshot showed 496/500 before later suites landed). **Standing pre-existing harness
  failures — NOT regressions:** the PGlite migration-replay harness fails when pglite isn't
  installed in the sandbox, and `src/test/tenant-isolation.test.ts` has a parse error; both predate
  this session.

---

## 8. One-line for the next session

Start by reading `docs/canon/CANON-ANCHOR.md` then this file. Gate-#9 **multi-tenant org resolution
is fixed** (claim-first `require-permission` + per-event-org workers); Payroll Phase A, Invoices
(near-complete), a ~11-class detect-only Control Exception Library, budgets/profitability/close/
team-performance all shipped and READY. **Close the gate-#9 residual** (dedicated permissions,
`core.assignments`, location RLS), then **deepen the thin segments the COVERAGE-MATRIX names**
(FP&A, Consolidation 11a, Job Costing) and add **NL prompts** — spec-first, disjoint parallel
slices, migrations-first, path-scoped commits alongside the concurrent MeritProjects workstream.
