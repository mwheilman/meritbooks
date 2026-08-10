# MeritBooks — Session 49 Handoff

**Date:** 2026-08-09
**Supersedes:** session 48. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), the AI-capability master (`docs/discovery/AI-CAPABILITY-MATRIX.md` +
`INTEGRATION-MAP.md`), and the FPBs (invoices, financial-reports, bank-reconciliation,
payroll, financial-control-exceptions, team-performance, identity-multitenancy,
tenant-model-consolidation-analytics, payments-fees, nl-copilot).

> **Coordination note (read first):** two Cowork sessions commit to this one repo —
> **MeritBooks** (this handoff) and **MeritProjects** (Module 6, the `feat(projects): …`
> commits). Disjoint workstreams sharing one git history, one Supabase, one migration
> sequence. Rules in force: **path-scoped `git add`** (never `git add -A`), and **disjoint
> migration bands — Books `0xx`/`1xx` core band, Projects `1xxx`.** This session had **no
> Projects commits** in the Books range; all six commits are Books.

---

## 1. Headline

A **depth-and-polish session** — no new architecture, no gate flips, no auth/billing
changes. With the practice-plane / white-label productization shipped in Session 48 and the
AI account still dark, Session 49 spent its entire wave **deepening the deterministic
modules** that work without live AI: AP disbursement, reports, close, reconciliation,
payroll import, rev-rec reporting, job costing, tax/1099, inventory, subscriptions, vendor
360, expenses, the board package, and the approval-workflow surface. Roughly **+105 new
pure unit tests** landed in the final wave alone, plus more across the session.

The arc, in commit order:

1. **AP pay-run + remittance, report saved-views/drill/comparatives, close-readiness,
   onboarding robustness, cash/treasury depth** (`deb9818`) — the biggest commit; introduced
   migrations **137** (vendor payment profiles) and **138** (report views).
2. **Deterministic CSV/XLSX payroll-register importer, no AI** (`8a6d0cb`, migration **136**)
   — a fully deterministic register import → balanced payroll JE path with a zero-dependency
   XLSX reader; honest primary payroll path while no provider is connected.
3. **Customer statements, job POC P&L + WIP schedule, report-export comparatives + exec
   summary, a11y/responsive polish** (`fcf4fde`).
4. **1099 NEC-vs-MISC box classification + candidate worklist, inventory stock-valuation
   report + GL tie-out, documents center + audit-trail depth, ASC 740 deferred rollforward +
   M-1 subtotals, a11y + tests** (`667545a`).
5. **Chart-of-accounts grouped balances + `/api/accounts/balances`, rev-rec deferred
   rollforward + per-contract waterfall + method summary, expenses approver queue +
   reimbursement batch, subscriptions run-rate/creep/renewals/triage, vendor 360, inbox
   live-count depth** (`423ac0c`) — also removed a raw `tin_encrypted` PII field from the
   vendor list API response.
6. **Bank-feed saved views + deterministic confidence explainer + bulk select-by-band/vendor,
   reconciliation outstanding-item aging + difference decomposer (surfaces the residual plug)
   + read-only history, board-package deterministic MD&A + KPI trend strip + DSO/DPO flowing
   into PDF/XLSX, approval-workflow chain visualizer + read-only scenario simulator +
   coverage-gap detector, and ~105 new unit tests** (`43ff536` — current HEAD).

Everything below is on `main`. **HEAD is `43ff536`; `origin/main == HEAD` (0 ahead / 0
behind — all pushed).** The auto-push loop ships commits to Vercel, whose `next build` is the
authoritative full-project typecheck. Migrations 136, 137, 138 were applied to Supabase
**first**, then the dependent code committed (canon migration rule). At the time of writing,
the earlier commits are Vercel **READY**; the latest commit `43ff536` may still be
**BUILDING** — confirm READY before trusting its typecheck.

---

## 2. What shipped this session (Books)

Commit range `5a34006..43ff536` (6 Books commits; **no** Projects commits in this range).

### AP pay-run + remittance, reports, close, cash/treasury (`deb9818`, migrations 137 + 138)
- **AP disbursement depth**: check-number assignment (`/api/ap/disbursements/check-numbers`),
  vendor payment profiles (`/api/ap/vendor-payment-profiles`, migration **137**), a
  remittance-advice document + PDF (`lib/ap/remittance-doc.ts`, `remittance-pdf.tsx`,
  `/api/ap/disbursements/remittance`), vendor-payment detail view + tests.
- **Report saved views** (migration **138**, `/api/reports/views` + `[id]`): save/name a
  report configuration; a `saved-views.tsx` picker on the report viewer, plus GL drill-down
  and report-comparative wiring.
- **Close-readiness automation**: a `readiness-checklist.tsx` on onboarding + a close-package
  route (`/api/close/package`) and close-grid hooks.
- **Cash/treasury depth**: cash obligations (`/api/cash/obligations`, `lib/cash/obligations.ts`),
  cash trend (`/api/cash/trend`, `lib/cash/trend.ts`), debt summary (`/api/debt/summary`),
  dashboard + treasury tests.
- **Onboarding robustness**: conversion client + post-route hardening.

### Deterministic payroll-register importer (`8a6d0cb`, migration 136)
- `register-csv-import.tsx` + `lib/payroll/register-csv.ts` + a zero-dependency
  `lib/payroll/xlsx-read.ts`: parse a payroll register CSV/XLSX → mapped columns →
  **balanced payroll JE**, **no AI in the loop**. Column mappings persist via
  `/api/payroll/register-mappings` (migration **136**, `payroll_register_mappings`).
  Register import is the **honest primary payroll path** while no provider is connected
  (the mock run remains labeled an estimate — see §4).

### Customer statements, job P&L/WIP, report exports (`fcf4fde`)
- **Customer statements** on the customer drawer (AR activity ledger,
  `lib/ar/activity-ledger.ts` + tests).
- **Job POC P&L statement** (`jobs/[id]/job-pl-statement.tsx`, `/api/jobs/pl`) + a deepened
  **WIP schedule** client.
- **Report export comparatives + exec summary** on the export menu / report viewer.
- Broad a11y/responsive polish across bank-feed, journal-entries, invoices, receipts,
  reconciliation, periods, credit-cards, expenses.

### 1099 boxes, inventory valuation, documents/audit, deferred-tax rollforward (`667545a`)
- **1099 NEC-vs-MISC box classification** (`lib/tax/box-classify.ts` + tests) + a candidate
  worklist on the 1099 compliance client + readiness depth.
- **Inventory stock-valuation report + GL tie-out** (`lib/inventory/stock-valuation.ts`,
  `/api/inventory/valuation-report`, `inventory/valuation/page.tsx`).
- **Documents center + audit-trail depth**: expanded audit client, `/api/audit/summary`,
  `/api/audit/timeline`, `/api/audit/export`; documents schema + store hardening.
- **ASC 740 deferred rollforward + M-1 subtotals** (`lib/tax/provision-service.ts`,
  return-package + tax-provision page depth).

### COA grouped balances, rev-rec reporting, expenses, subscriptions, vendor 360, inbox (`423ac0c`)
- **Chart-of-accounts grouped-balances view** (`accounts-grouped-view.tsx`,
  `gl-detail-modal.tsx`, `/api/accounts/balances`).
- **Rev-rec reporting**: deferred-revenue rollforward + per-contract waterfall + method
  summary (`lib/services/rev-rec-reporting.ts`, `/api/rev-rec/reporting`, `rev-rec-reports.tsx`).
- **Expenses**: approver queue + reimbursement batch (`/api/expenses/batch`,
  `lib/expenses/queue-summary.ts` + tests).
- **Subscriptions**: run-rate / creep / renewals / triage analytics
  (`lib/subscriptions/analytics.ts` + tests, subscription views/types).
- **Vendor 360** drawer depth. **PII fix:** the vendor list API (`/api/vendors`) no longer
  returns the raw `tin_encrypted` field.
- **Inbox** live-count depth (exceptions queue, tabs, snooze, keynav hooks).

### Bank-feed, reconciliation, board package, approval workflow (`43ff536` — HEAD)
- **Bank feed**: saved views (`bank-feed-views.ts` + hook + tests), a **deterministic
  confidence explainer** (`confidence-explainer.tsx`), and a refine bar with **bulk
  select-by-confidence-band / by-vendor** (`bank-feed-refine.ts` + tests).
- **Reconciliation**: outstanding-item **aging** + a **difference decomposer** that surfaces
  the residual plug (`lib/services/reconciliation-aging.ts` + tests,
  `reconciliation-analytics.tsx`) and a **read-only history** view (`reconciliation-history.tsx`,
  `/api/reconciliation/history`, `/api/reconciliation/session`).
  ⚠️ **Security note for the next pass:** the history route uses the **admin client** to
  resolve finalizer display names, **strictly scoped to the `core.users` ids that appear on
  the caller's own org-scoped recs** (no cross-tenant exposure) — flag for the security lane.
- **Board package**: deterministic **MD&A** + a **KPI trend strip** + **DSO/DPO** flowing into
  the PDF and XLSX exports (`lib/reports/board-package.ts` + tests, board-package sections/viewer,
  `/api/reports/board-package/*`).
- **Approval workflow** (`/settings/approvals`): a **chain visualizer**, a **read-only scenario
  simulator**, and a **coverage-gap detector** (`lib/approvals/analysis.ts` + service + tests).
- **~105 new pure unit tests** across approvals, board-package, reconciliation-aging,
  rev-rec-reporting, bank-feed views/refine, pricing/expenses/subscriptions edge suites.

---

## 3. Data / infra changes (reproducibility notes)

**Migrations added THIS session and applied to Supabase (project `npqeijipggtuduhkejxq`)
first, then code committed** (canon migration rule):

| File | Commit | Purpose |
|---|---|---|
| `136_payroll_register_mappings.sql` | `8a6d0cb` | Persist payroll-register column mappings for the deterministic importer. |
| `137_vendor_payment_profiles.sql` | `deb9818` | Vendor payment profiles for the AP pay-run / remittance path. |
| `138_report_views.sql` | `deb9818` | Saved report views/configurations. |

- **Ground-truth correction:** the Session-48 handoff said "next Books migration: 136."
  Migrations **136, 137, 138 all landed in THIS session** (verified via
  `git log -- packages/supabase/migrations/`), not in Session 48. The Session-48 body/§7
  banner listing "136 payroll mappings / 137 vendor payment profiles / 138 report views" as
  already-recorded is inaccurate — they are Session-49 additions.
- **Highest Books migration file: `138`. Next free Books migration number: `139`.** (The
  Books band still has designed gaps — `134` skipped, and `114–119`, `122–129` unused; the
  Projects band is `1xxx`.)
- **Two live Merit orgs (both named "Merit Management Group") — carried forward from S48:**
  - **`1d1aa1ef-4218-4187-a622-4a80da1a9e11`** — the **working seeded dev tenant** (3
    locations), bound to the **DEV Clerk instance**; this is what production authenticates
    against today.
  - **`eb3d8087-7798-480d-9617-bdf73f63918a`** — the **empty parked live tenant** (1
    location), bound to **prod Clerk**. Production cutover remains deferred (§4).
- **Working tree:** one uncommitted change — `apps/web/.env.local.example` (+12 lines,
  documenting env vars) — left for the lead; not part of any committed slice.
- **Vercel deploy:** auto-push loop → `next build` (authoritative typecheck). Earlier commits
  READY; `43ff536` may still be BUILDING at time of writing — verify READY.

---

## 4. Open items — DO NOT FORGET

### KNOWN-OPEN launch blockers (carried forward, unchanged this session — human-only)

1. **Anthropic org is DISABLED / unfunded → ALL AI is operationally down.** Account-level,
   **not a code bug** — `ANTHROPIC_API_KEY` shows "This organization has been disabled." The
   app degrades gracefully everywhere (calm "AI temporarily paused" payloads via
   `isAiUnavailableError` / `AiUnavailableNotice`; deterministic paths and the FP&A heuristic
   parser still work). This session added **only deterministic depth**, so nothing regressed
   while AI is dark. **Fix = fund/re-enable the Anthropic account** (Mike), then re-verify a
   full drop-and-parse round-trip + NL/FP&A against live AI.
2. **Production is intentionally on the DEV Clerk instance** (concise-dolphin dev instance).
   Do **NOT** re-cut to prod until all are ready together: (a) a **separate prod Supabase
   project**, (b) prod-Clerk **Third-Party-Auth trust** repointed, (c) a **funded Anthropic
   key**, and (d) a **live-billing decision**. The prior failed attempt was a **crossed
   publishable/secret key** — double-check `pk_`/`sk_` pairing on the next cutover. Parked
   live tenant `eb3d8087-…`.
3. **Live tenant billing/charging via Stripe is NOT wired.** Operator Console MRR/ARR is
   **list-price computed only** (plan × active company count). No charge button.
4. **Stripe is in TEST mode and Plaid in SANDBOX.** No real money moves in the current
   environment.
5. **Payroll provider unpicked** (Check vs Gusto, task #34). The **register-import → balanced
   JE** path added this session is the **honest primary**; the mock run engine is an
   **estimate only** ("no money moves," not a tax calc). Gates Payroll Phase B
   (releaser≠preparer, double-post guard, live provider).
6. **Marketing-site honesty items** — reconcile claims to reality: **semantic search is
   Postgres FTS (GIN tsvector), NOT vector/embeddings**; **1099 IRIS/FIRE e-file is NOT built**
   as a real IRS submission (this session added NEC-vs-MISC **box classification** + a
   candidate worklist, not IRS transmission); **insurance now DOES post** (S48 migration 132).
7. **The paused hourly autonomous build task** remains paused — do not assume it is running.
8. **Standing pre-existing tsc / pglite test-harness failures are NOT regressions.** The known
   set — Stripe module types when the SDK/env is unbuilt in the sandbox (present on Vercel),
   `pglite` not installed so the migration-replay suites skip/error,
   `tenant-isolation.test.ts` / `schema-contract.test.ts` parse/`any` nits — predates this
   session. Baseline noise, not new breakage.

### New this-session flags for the next security/verifier pass
- **Reconciliation history route (`/api/reconciliation/history`) uses the admin client** to
  resolve finalizer display names — **scoped to `core.users` ids present on the caller's own
  org-scoped recs**, so no cross-tenant leak, but it is an admin-client seam worth a
  confirming security review.
- **Vendor list PII:** confirmed the raw `tin_encrypted` field was **removed** from the
  `/api/vendors` response this session (regression guard for any future edit).

### Feature-shape caveats to record (deterministic-by-design, not gaps to "fix" blindly)
- **1099-MISC classifies today; NEC generates** — box classification distinguishes NEC vs MISC,
  but only NEC produces an output form. MISC form generation + IRS IRIS transmission are future.
- **Per-entity approval chains would need schema** — the approval-workflow simulator/coverage
  work rides migration 092, which is **org + doc_type + amount-tier**, not per-entity.
- **Historical DSO/DPO sparklines would need a stored period-end aging snapshot** — the board
  package computes current DSO/DPO; trend history is not yet persisted.

### Carried-forward identity / RBAC residual (from S45–S48 — still open)
- Org resolution is **CLOSED live** (Clerk native `o.id` claim + auto-bind; page-guard
  single-membership + `get_org_id` single-active-seat fallbacks are additive/fail-closed).
  **MANUAL for Mike:** stand up the **Clerk production instance for `app.meritbooks.app` +
  `org_id` claim** (retires the fallbacks), add `app.meritbooks.app` to the **`meritbooks-web`**
  Vercel project, set **`NEXT_PUBLIC_APP_URL`** + **`EVENT_WORKER_SECRET`**, rotate the
  **Resend key** + set **`INVOICE_FROM_EMAIL`**. ⚠️ The marketing site is a SEPARATE Vercel
  project (`meritbooks-marketing`) — apex `meritbooks.app` stays with marketing; the app gets
  `app.` only. **Claude-side residual:** split `payments` into per-route keys is DONE (S48 SoD),
  remaining are `core.assignments`, event-worker read/"peek" scoping, location-scoped RLS,
  control/`team_performance` permissions.

### Other standing opens
- Master-Doc amendments awaiting Mike's ratification (task #19).
- Payroll provider pick — Check vs Gusto (task #34) — gates Payroll Phase B.
- Browser-verify the newest pages (task #18) — the S49 depth surfaces (AP pay-run/remittance,
  saved report views, reconciliation history/aging, board package, approval-chain simulator,
  payroll register import) have **not** been Chrome-audited yet.

---

## 5. Direction — what's next

1. **Fund/re-enable the Anthropic account** to bring the whole AI surface back online, then
   re-verify a full drop-and-parse round-trip (upload → gateway → extraction) and the NL/FP&A
   paths against live AI.
2. **Make a live-billing decision**, then (if go) wire real Stripe subscription charging so the
   Operator Console MRR is realized, not list-price computed.
3. **Prepare (do not execute) the real production cutover** — dedicated prod Supabase project,
   prod-Clerk Third-Party-Auth trust, funded Anthropic key, scripted env swap with a pk/sk
   pairing check so the crossed-key failure cannot recur.
4. **Chrome-audit the S49 depth** (AP pay-run + remittance PDF, saved report views + drill,
   reconciliation history/aging/plug, board-package MD&A/KPI/DSO-DPO, approval-chain
   simulator/coverage, payroll register import → JE) on the deployed dev-Clerk app.
5. **Pick the payroll provider** to unblock Phase B; keep driving Invoices / Reports /
   Bank-Rec / Reconciliation to **Complete** behind their FPBs.
6. Security lane: confirm the reconciliation-history admin-client name-resolution seam; add
   the identity Claude-side residual (`core.assignments`, event-worker read-scoping,
   location-scoped RLS, control/`team_performance` permissions).

---

## 6. Agents

Eight defined agents in `.claude/agents/` (builder, verifier, auditor, reviewer, designer,
scribe, security, chrome-auditor) + SDK agents (general-purpose, Explore, Plan). **All on
opus 4.8** (CLAUDE.md §0.1 binding). Parallel builder/general-purpose agents on file-disjoint
slices, 3–5 concurrent, one verification lane through the lead. Reserved shared spine
(migrations, `packages/shared`, `api-handler.ts`, `navigation.ts`, `rbac/permissions.ts`) is
single-threaded through the lead.

## 7. Live state

- **Repo HEAD:** `43ff536` on `main`. **`origin/main == HEAD`** (0 ahead / 0 behind — all
  pushed). Auto-push loop ships to Vercel; `next build` is the authoritative typecheck. Earlier
  commits READY; `43ff536` may still be BUILDING — verify READY.
- **Auth:** production runs on the **DEV Clerk instance** (deliberate — see §4).
- **Supabase:** project `npqeijipggtuduhkejxq`; migrations through **138** applied this session
  (136/137/138 new); next Books number **139**.
- **Working tenant:** `1d1aa1ef-…` (seeded, 3 locations, dev Clerk). Parked live tenant:
  `eb3d8087-…` (1 location, prod Clerk).
- **AI:** Anthropic account **disabled/unfunded** — ALL AI seams operationally down; app
  degrades gracefully. This session added only deterministic depth. Plumbing/grants correct.
- **Money rails:** Stripe **TEST** mode, Plaid **SANDBOX**; live tenant billing NOT wired.
- **Known non-regression noise:** Stripe/pglite/tenant-isolation/schema-contract type-harness
  failures (baseline).

## 8. One-line for the next session

A pure deterministic-depth session while the AI account stays dark: AP pay-run + remittance
PDF (mig 137), saved report views (mig 138), deterministic payroll-register importer (mig 136),
customer statements, job POC P&L/WIP, 1099 box classification, inventory valuation, deferred-tax
rollforward, rev-rec rollforward/waterfall, bank-feed saved-views/confidence-explainer,
reconciliation aging + plug decomposer + read-only history, board-package MD&A/KPI/DSO-DPO into
PDF/XLSX, approval-chain visualizer/simulator/coverage, and ~105 new unit tests — HEAD `43ff536`,
all pushed; next: **fund Anthropic, decide live billing, prep a clean prod-Supabase + prod-Clerk
cutover, and Chrome-audit the new depth.**
