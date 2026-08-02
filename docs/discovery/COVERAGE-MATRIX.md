# MeritBooks Discovery — COVERAGE MATRIX

**Author:** Discovery auditor (read-only analysis)
**Date:** 2026-08-01 (Session 41 canon)
**Purpose:** An honest, owner-facing map of how deeply the panel/discovery has *engaged* each platform
segment, how much *AI capability* has been proposed for it, what is actually *built*, and where the
single biggest **gap** still sits. This is analysis only — no build authorization, no FPB.

## Sources this audit read
- `docs/discovery/books/AI-CAPABILITY-CATALOG.md` (the ranked union of all proposed AI capabilities, A1–H4)
- The five operator briefs in `docs/discovery/books/`: `controller-cfo.md`, `cpa-tax-assurance.md`,
  `accounting-firm-partner.md`, `bookkeeper-processor.md`, `accounting-manager.md`
- All nine `docs/FPB-*.md`
- `docs/canon/CANON-ANCHOR.md` §5 (gate state)
- Live code surface: `apps/web/src/app/(app)/` (44 route folders), `.../app/api/` (66 API groups,
  incl. `reports/` 21 routes, `controls/` 10 routes), `lib/controls/` (10 detectors), `lib/services/`

## How to read the scores

**Operator-need depth captured (0–3):** 0 = not raised anywhere; 1 = mentioned in passing in a brief;
2 = a brief substantively covered the segment; 3 = a **dedicated deep-dive** exists in
`docs/discovery/segments/`.
> **Ceiling note:** `docs/discovery/segments/` is **empty at audit time** (a parallel wave is writing
> per-segment deep-dives). So **no segment can honestly score 3 yet** — every segment is capped at 2
> until its deep-dive lands. This is itself the headline finding: discovery is broad (briefs) but not
> yet *deep* (dedicated dossiers) on any single segment.

**AI-capability depth proposed (0–3):** 0 = nothing in the catalog; 1 = tangential/partial; 2 = at least
one dedicated capability with a full scorecard; 3 = a marquee/multi-capability treatment. `(n)` = count
of distinct catalog capabilities touching the segment.

**Build-state:** none / partial (scaffold, thin) / functional (real Supabase, works) / FPB-written
(spec exists, may or may not be built).

---

## The matrix

| # | Segment | Op-need depth (doc) | AI depth (catalog count) | Build-state (key files) | Biggest single GAP | Discovery COMPLETE? |
|---|---|---|---|---|---|---|
| 1 | **General Ledger** | 2 — controller-cfo, bookkeeper, manager | 2 (A1, H3) | functional — `lib/services/gl-posting.ts`, `je-composer.ts`, `posting-verify.ts`, migrations (6 balance triggers) | No AI *narration* of the ledger ("explain this account's movement"); GL is treated as plumbing, not an operator surface | **Med** |
| 2 | **Journal Entries** | 2 — cpa (AU-C 240), manager B4 | 2 (H2 anomalous-JE) | functional — `(app)/journal-entries`, `api/journal-entries` (3), `lib/controls/anomalous-je.ts` | Detect-only today; no *blocking* gate on unsupported high-risk JEs above materiality (H2 posture not yet enforced) | **Med** |
| 3 | **AP / Bills** | 2 — controller #1, bookkeeper CORE-2/3, manager B4 | 3 (A2, B1, B3, B4, B5 — 5 caps) | functional — `(app)/bills`, `api/bills` (5), `bill-ap.ts`, `bill-parser.ts`, `lib/controls/duplicate-payments.ts`,`bill-anomaly.ts` | AP **inbox OCR (A2)** blocked on GATE 4 (Azure creds); recurring/accrual drafting (B3) + missing-accrual detection not built | **Med** |
| 4 | **AR / Invoices** | 2 — bookkeeper CORE-11, controller #7 | 2 (C1 cash-app) | functional / FPB-written — `(app)/invoices` (drawer, recurring, credit-memos), `api/invoices` (5), `api/credit-memos` (5), `docs/FPB-invoices.md` | AI **cash application** (C1) — matching inflows to open AR — is designed but not built; needs live Resend key for dunning email | **Med** |
| 5 | **Collections** | 2 — invoices FPB, controller #7 | 2 (C2 dunning) | functional — `(app)/invoices/collections`, AR aging/DSO live, `lib/controls/…` | No pay-date *prediction* or auto-escalating outreach cadence; reserve/write-off SoD flow not built | **Med** |
| 6 | **Bank / Cash** | 2 — bookkeeper CORE-1, controller #4/#6 | 2 (A1 feed — flagship) | functional — `(app)/bank-feed`, `cash`, `api/bank-feed` (5), `api/plaid`, `categorization.ts` | Vendor-recents + inline GL search polish; multi-bank idle-cash sweep signal (ties to E2) not surfaced | **High** |
| 7 | **Reconciliation** | 2 — bookkeeper CORE-7, manager A2 | 2 (D2 autopilot) | functional / FPB-written — `reconciliation.ts` (match/balance/adjustment/gl), `api/reconciliation` (5), `docs/FPB-bank-reconciliation.md` (GATE 8) | Wave A only; auto-drafted adjusting entries + "must-tie-to-zero-to-close" hard gate not fully wired | **High** |
| 8 | **Close** | 2 — manager B1 (#1 ask), controller #9, firm-partner | 2 (D1 uncat gate, D3 command center) | partial — `(app)/close`, `close-status`, `year-end-close`, `api/close`, `fiscal-periods.ts` | **D3 real-time close command center** (per-entity × per-workstream state machine off live ledger) not built; still closer to a checklist | **Med** |
| 9 | **Consolidation / Intercompany** | 2 — firm-partner, controller | 1 (IC-balance detector only; no dedicated *consolidation* AI cap) | partial / FPB-written — `(app)/intercompany`, `internal-invoices`, `reports/consolidated`, `intercompany.ts`, `lib/controls/intercompany-balance.ts`, `docs/FPB-tenant-model-consolidation-analytics.md` | **GATE 11a (multi-entity consolidation) is MANDATORY + top-priority but OPEN.** No AI capability proposed for elimination logic, minority interest, or FX — catalog is thin exactly where the roadmap is hottest | **Low** |
| 10 | **Reporting / Financial Statements** | 2 — controller (board pkg), manager A2 | 2 (E3 flux/narrative) | functional / FPB-written — `api/reports` (21 routes: B/S, P&L, cash-flow, equity, AP/AR aging, WIP, job-cost…), `docs/FPB-financial-reports.md` (GATE 7) | Reports render, but **E3 auto-flux + board-narrative generation** is not built; no drill-through narrative layer | **Med** |
| 11 | **Budgeting / FP&A** | **1 — mentioned inside controller-cfo (covenant/variance context) only** | **1 — no dedicated budgeting/planning capability; only E1 covenant + E3 flux touch it** | partial — `(app)/budgets` (entry-grid, budget-vs-actual, workspace), `api/budgets` (2) | **★ OWNER-FLAGGED.** There is **no discovery of budgeting/planning as a discipline** — no driver-based planning, no annual operating plan, no rolling re-forecast, no scenario/what-if, no headcount/rev-driver models. The catalog's whole "FP&A" section is covenant + cash + flux, not *planning*. The budgets UI is a grid with no AI and no operator-need dossier behind it | **Low** |
| 12 | **Forecasting** | 2 — controller #5/#6, bookkeeper | 2 (E1 covenant drift, E2 13-week cash) | functional (cash) — `(app)/forecast` (grid), `api/forecast`, 13-week cash built (Session 40); covenant monitor not built | **E1 covenant drift monitor** (DSCR/FCCR/leverage, projected breach date, draft certificate) — the CFO's #1 career-risk catch — designed but **not built**; forecast is cash-only | **Med** |
| 13 | **Tax / Sales-tax** | 2 — cpa A2/A4/B1, controller #11 | 2 (F1 nexus tripwire, F2 book-to-tax M-1/ASC 740) | partial — `lib/controls/sales-tax-nexus.ts`,`cutoff-errors.ts`; no dedicated tax UI/subledger | **F2 book-to-tax tagging** (cpa called it "the single richest AI opportunity") has no ledger dimension yet; nexus is detect-only with no per-state threshold table UI | **Med** |
| 14 | **1099 / Compliance** | 2 — cpa A3/B4, controller #11, bookkeeper CORE-4 | 2 (F3 1099 readiness, B2 vendor compliance) | functional — `(app)/compliance-1099`, `compliance`, `vendor-compliance.ts` (Session-40 engine) | Rail-split $600 tracking (exclude card/1099-K) + missing-valid-W-9 gate not reconciled to the built vendor-compliance engine | **Med** |
| 15 | **Payroll** | 2 — bookkeeper CORE-10 | 2 (B4 payroll JE automation) | partial / FPB-written — `(app)/payroll`, `api/payroll` (7), `docs/FPB-payroll.md` (GATE 12.3) | **Provider not chosen (Check vs Gusto — task #32/#34).** Embedded run→post→remit→file is spec-only; only the JE-shape automation is designed | **Med** |
| 16 | **Job Costing** | 1–2 — controller #8 (cutoff), manager | 1 (F4 cutoff touches it; no dedicated job-cost AI cap) | partial — `(app)/jobs`, `api/jobs` (3), `reports/job-cost`,`job-profitability`,`wip`, `job-cost-events.ts`, `job-progress.ts` | GATE 6 (job-costing depth) OPEN; **no AI capability proposed for cost-to-complete, WIP over/under-billing, or committed-cost** — and the ops seam lives in MeritProjects, under-mapped here | **Low** |
| 17 | **Fixed Assets** | 1 — cpa B2 (capex only) | 2 (B5 capex/depreciation/§179 lifecycle) | partial — `(app)/fixed-assets` (asset-drawer), `api/fixed-assets` (1) | **No operator brief owns fixed-asset management as a segment** — only capex-classification was raised. No depreciation-run, disposal, or roll-forward discovery; subledger is thin | **Low** |
| 18 | **Revenue Recognition** | 2 — cpa B6, controller #8, manager A2 | 2 (F4 cutoff enforcement) | functional — `(app)/rev-rec`, `api/rev-rec` (2), `lib/services/rev-rec.ts`, `revenue-not-recognized.ts` control; 9 methods in onboarding | Cutoff is detect-only near close; no AI for method selection or over-time %-complete validation (engine stays deterministic by design) | **Med** |
| 19 | **Vendor Mgmt** | 2 — bookkeeper CORE-4, controller #11 | 2 (B2 W-9/TIN/COI chase + gate) | functional — `(app)/vendors`,`vendor-compliance`, `api/vendors` (2), `vendor-compliance.ts` | Vendor-master **dedupe** (name/EIN/bank/remit) + changed-bank-detail BEC block (part of B1) not surfaced in the vendor UI | **Med** |
| 20 | **Customer Mgmt** | 1 — implied by AR/collections; no brief owns it | 1 — no dedicated customer-master AI capability | partial — `(app)/customers` (drawer, peek), `api/customers` (2), `client-health` | **Under-discovered.** No credit-limit / customer-risk / payment-behavior profile discovery; customer master is a thin CRUD surface with no operator dossier | **Low** |
| 21 | **Practice / Multi-client** | 2 — firm-partner A/B/C (whole brief) | 3 (G1 portfolio board, G2 playbooks, G3 assignment grid, G4 client portal — 4 caps) | none/partial — `api/client-health`; practice plane not built (GATE 11a/10 prereq) | **Everything is designed, nothing built.** Practice plane needs identity/multi-tenancy (GATE 10) + consolidation (11a) first; highest structural moat, lowest build progress | **Med** |
| 22 | **Team Performance** | 2 — manager B3/B8, bookkeeper Part 3 | 2 (H4 autonomy dial + G3 realization) | functional / FPB-written — `(app)/team`, `api/team` (5), `team-performance`, `docs/FPB-team-performance.md` (built de11940) | Ties to the autonomy dial (H4) — override-rate/backlog metrics that *govern* the dials not yet wired to disposition | **High** |
| 23 | **Onboarding** | 2 — firm-partner A4, manager | 2 (A4 conversion pipeline) | partial — `(app)/import`, `api/import`, `api/setup`, `settings`; rev-rec method capture done | **A4 historical-conversion pipeline** (import QBO/Sage → AI-categorize → propose opening TB → human ties out) not built; needs practice plane (GATE 11a) | **Med** |
| 24 | **Money Movement** | 2 — controller #6, security posture | 2 (embedded in C1/E2 + fee model) | functional / FPB-written — `api/payments`,`pay`, Stripe (GATE 12.1 live), `api/plaid`, `docs/FPB-payments-fees.md` | Real multi-tenant org resolution + dedicated `payments` permission still open (task #33); "AI never initiates a transfer" posture holds | **High** |
| 25 | **AI / Exception controls** | 2 — every brief (union) | 3 (H1 marquee library, H2, H4 — plus all A–G classes feed it) | functional / FPB-written — `lib/controls/` (10 detectors + tests), `(app)/exceptions`,`ai-decisions`, `api/controls` (10), `api/exceptions` (2), `docs/FPB-financial-control-exceptions.md` (GATE 9) | **`scoreToTier` not yet wired into actual auto-post/queue *disposition*** — detectors log, but tiering doesn't yet govern disposition; EC-2/5–9/11–13 remain | **High** |
| 26 | **Security / Identity** | 2 — controller #10, cpa B8, manager B2/B6 | 2 (H3 audit trail + SoD + attribution) | partial / FPB-written — RBAC guards on 12 money routes + 7 pages, `core.memberships` reconciled, `docs/FPB-identity-multitenancy.md` | **NO-GO gate #9 OPEN:** real multi-tenant **org resolution** (first-org fallback everywhere), control-route RBAC, location-scoped RLS — the floor the whole trust story keys to | **Med** |

---

## Verdict summary — "Confidence discovery is COMPLETE" per segment

- **High (5):** Bank/Cash, Reconciliation, Team Performance, Money Movement, AI/Exception controls.
  These have both a substantive brief treatment *and* real, tested code; a deep-dive would confirm, not
  reshape.
- **Med (14):** GL, Journal Entries, AP/Bills, AR/Invoices, Collections, Close, Reporting, Forecasting,
  Tax/Sales-tax, 1099/Compliance, Payroll, Rev-Rec, Vendor Mgmt, Practice/Multi-client, Onboarding,
  Security/Identity. Well-raised in briefs; the *depth dossier* and/or the build is partial.
- **Low (6):** **Budgeting/FP&A, Consolidation/Intercompany, Job Costing, Fixed Assets, Customer Mgmt,**
  (and Practice is Med only because the firm-partner brief is unusually thorough). These are where the
  panel has genuinely thin operator-need capture and/or the catalog proposed little to no dedicated AI.

**Overall:** discovery is **broad but not yet deep.** Five operator briefs give strong *cross-segment*
coverage and the AI catalog ranks 29 capabilities well — but **zero per-segment deep-dives exist yet**
(`docs/discovery/segments/` is empty), so no segment can honestly be called discovery-COMPLETE. The
coverage is also **lopsided toward the transactional core** (AP, feed, recon, exceptions) and **thin on
the planning/analytical and master-data segments** — exactly the owner's Budgeting/FP&A concern.

## Prioritized list — segments most UNDER-discovered (deep-dives needed first)

1. **Budgeting / FP&A** — ★ owner-flagged and confirmed. *No* discovery of budgeting/planning as a
   discipline (no driver-based plan, rolling re-forecast, scenario/what-if, or headcount/rev models).
   The "FP&A" in the catalog is covenant + cash + flux, none of which is *planning*. Needs a dedicated
   deep-dive before any GATE 7 build claims FP&A completeness.
2. **Consolidation / Intercompany** — the roadmap's MANDATORY top priority (GATE 11a) has the *thinnest*
   AI-capability treatment: only an IC-balance detector; nothing on eliminations, minority interest, or
   FX translation. Highest mismatch between roadmap urgency and discovery depth.
3. **Job Costing** — GATE 6 open, no dedicated job-cost AI capability (cost-to-complete, WIP
   over/under-billing, committed cost), and the ops seam to MeritProjects is under-mapped.
4. **Fixed Assets** — no brief owns it as a segment; only capex-classification (B5) was raised. No
   depreciation-run / disposal / roll-forward discovery.
5. **Customer Mgmt** — no brief owns customer master; no credit-limit / customer-risk / payment-behavior
   discovery. Thin CRUD surface with no operator dossier.

*(Runner-up: Close — the D3 real-time command center is the manager's #1 ask but is still closer to a
checklist than the proposed live state machine.)*
