# AI-Native Capability Catalog v2 — Consolidated Superset (Books, Module 1 of 12)

**Author:** Discovery synthesizer (read-only analysis).
**Date:** 2026-08-01 (Session 41 canon).
**Status:** Discovery synthesis. **Analysis only. No capability below is a build authorization.** Each
must earn an approved Rule-13 FPB (16 dimensions + a QBO/Sage/best-in-class benchmark) and land behind
its `Prereq:` gate before a line of code is written.

**What this is.** The v1 catalog (`docs/discovery/books/AI-CAPABILITY-CATALOG.md`) was a shallow first
pass: 29 cross-segment capabilities (A1–H4) synthesized from the five operator briefs. Between then and
now, six per-segment deep-dives landed in `docs/discovery/segments/` — **~230 capabilities** enumerated
against the live repo. This v2 folds all six deep-dives **plus** the v1 catalog into a single, deduped,
ranked superset. **The v1 file is kept as the record of the first pass; this file supersedes it for
planning.**

**Sources folded:** `segments/budgeting-fpna.md` (40), `segments/accounts-payable.md` (40),
`segments/accounts-receivable.md` (35), `segments/gl-close.md` (36), `segments/bank-cash.md` (36),
`segments/tax-compliance.md` (43) = **230 raw**; plus v1 `AI-CAPABILITY-CATALOG.md` (29, all subsumed);
reconciled against `docs/COVERAGE-MATRIX.md`, `docs/canon/CANON-ANCHOR.md` §5 (gate state), the nine
`docs/FPB-*.md`, and a live read of `apps/web/src/lib/controls/*` (10 detect-only detectors verified),
`lib/services/*`, `lib/cash/`, `lib/posting/`, `lib/invoices/`, `lib/reconciliation` (autopilot).

---

## §0. Method — how to read v2

**Canon posture (inherited by every row, never restated):** *AI proposes a fact or a draft → the
deterministic engine does any accounting (debits=credits, direction from account TYPE, role-not-number)
→ a human with the right Core role approves anything that moves money, changes the book, changes vendor
banking, or touches a client relationship → every AI action and human decision writes `core.action_log`
with actor = specific human OR AI+version. Auto-post is OFF by default; autonomy is a per-tenant/per-task
dial loosened only as the machine earns it; SoD binds the AI; on ambiguity, fail closed and ask.* Money
is bigint cents. AI routes only through `@meritbooks/core-ai` (metered, tenant-budget capped).

**Gateway buckets** (Core AI gateway): **EXTRACT · CLASSIFY · MATCH · DETECT · FORECAST · RECONCILE ·
DRAFT**, plus **DET** (deterministic engine/rules, non-AI) and **WORKFLOW/ORCH** (status/approval/
dependency machinery).

**HITL posture** (compressed): `propose→approve` (drafted, queued, human confirms — the default) ·
`detect→triage` (advisory exception to `/exceptions`, no ledger effect) · `hard-gate` (blocking control) ·
`human-release` (money movement, preparer≠approver + explicit release) · `elevated-role` (SoD-gated
action) · `read-only` (derived intelligence) · `auto-clear(dial)` (only within the per-tenant autonomy
dial, always reversible + logged).

**Build-state** (reconciled to the repo, Session 41): **built** (live/functional, incl. detect-only that
is shipped) · **partial** (substrate exists, material gap named) · **none** (gap / not built / needs a
shared-spine table) · `·FPB` suffix = an approved or drafted FPB already covers it.

**Value tier:** Critical / High / Med / Low — annual $-at-risk × likelihood × trust-to-sign.

**Composite score** (v1 rubric, higher = build sooner): `ROI×0.35 + TrustImpact×0.30 + BuildEase×0.20 +
FP-Safety×0.15`. v1 items carry their v1 score; segment-native items are scored on the same 1–5 axes.

**Dedup rule.** A capability that recurs across segments (cash application, covenant monitor,
intercompany balance, anomalous-JE, 1099, nexus, duplicate-payment, uncategorized close gate) is listed
**once, at its richest home**, with a *folds:* note naming the segment IDs collapsed into it. Truly
cross-cutting trust/supervision capabilities are lifted into **§1 PLATFORM-WIDE**. IDs keep their
source-doc prefix so every row traces back (FP-=fpna, AP-, AR-, GL-=gl-close, BC-=bank-cash, TX-=tax).

---

## §1. PLATFORM-WIDE capabilities (the supervision spine — the moat)

These are not one segment's feature; they are the trust layer every segment plugs into. Lifted out of the
per-segment lists and deduped across all six.

| ID | Capability (one-liner) | Bucket | HITL | Build | Tier | Score |
|---|---|---|---|---|---|---|
| **PW1** | **Financial Control Exception Library** — always-on reconcile of the owned ledger; $-quantified exceptions into `/exceptions`; the frame every detector plugs into (v1 H1) | DETECT+RECONCILE | detect→triage | partial·FPB | **Critical** | **4.45** |
| **PW2** | **Anomalous / unsupported JE detection (AU-C 240)** — score every manual JE (round-dollar, weak desc, no attachment, odd pair, off-hours, preparer); block high-risk without support (v1 H2; *folds GL-F1, TX-F1, AP-I3*) | DETECT | detect→triage / hard-gate | **built** (detect-only) | **Critical** | **4.20** |
| **PW3** | **Audit trail + SoD + machine-vs-human attribution** — immutable `action_log`, actor=human OR AI+version, preparer≠approver≠releaser keyed to `core.memberships`, period-lock trail, legible attribution timeline (v1 H3; *folds GL-J1/J4, TX-F4, BC-E8, AR-C36*) | DET+ORCH | hard-gate | partial·FPB | **Critical** | **4.20** |
| **PW4** | **Confidence-tier routing + per-task autonomy dial + materiality + kill-switch** — `scoreToTier`→disposition; supervisor dials; $-materiality scaling; granular throttle degrades to propose-only, never a dead book (v1 H4; *folds GL-J2/J3/J5, BC-F9, FP-K4*) | ORCH | hard-gate / auto-clear(dial) | partial | **Critical** | **4.20** |
| **PW5** | **NL Command / FP&A Copilot front door** — plain-English → balanced role-resolved JE (`je-composer`, built) and → real report/plan/what-if config, never fabricated figures (*folds GL-A1 built, FP-E3/K1, reports NL box*) | DRAFT→DET | propose→approve | partial | High | 3.90 |
| **PW6** | **Decision Log for every AI proposal** — inputs/assumptions/confidence/approver on every draft to `ai_decisions`/`action_log`; reversible, attributable (*folds FP-K3, BC-F10, GL trust*) | DET | read-only | **built** (infra) | High | 3.85 |
| **PW7** | **Document / answer "chasing-people" orchestration** — any txn blocked on a missing doc/approval/answer → drafted ask in operator voice, auto-follow-up, one "waiting-on" board (*folds AP-I8, firm-partner G4, AR dunning-adjacent*) | DRAFT | propose→approve / auto-send(dial) | partial (send layer blocked GATE 4) | High | 3.40 |
| **PW8** | **Pre-post anomaly interceptor** — move the detect-only detectors onto the synchronous posting path so an error is caught *before* it enters the owned book, not in next month's flux (GL-C2) | DETECT | hard-gate | partial | High | 3.80 |

*Cross-suite seam:* PW1 is the Books-side mirror of the MeritProjects **Billing Integrity Auditor**; both
share `core.events` (FROZEN v3), `core.action_log`, `scoreToTier`, `/exceptions`, and dedup on `source_ref`
so a cost Projects flags unbilled and Books flags uncategorized-leakage is **one** exception, not two.

---

## §2. Per-segment catalogs (deduped)

### 2.1 Budgeting & FP&A (`FP-`) — 37 native (home of covenant + flux narrative)

Build ground truth: only a thin budget-entry grid, a single-scenario BvA, and the 13-week cash forecast
exist. The whole planning discipline (drivers, scenarios, rolling forecast, three-statement, headcount,
board pack, covenant) is unbuilt — the owner-flagged gap.

| ID | Capability | Bucket | HITL | Build | Tier | Score |
|---|---|---|---|---|---|---|
| FP-A1 | AI budget draft from prior actuals + growth/driver assumptions ★ | FORECAST+CLASSIFY | propose→approve | none | **Critical** | 4.20 |
| FP-A2 | Seasonality-aware spreading (own historical curve, not 1/12) | FORECAST | propose→approve | partial | High | 3.70 |
| FP-A3 | Driver-based budgeting (driver×rate model) ★ | DET+FORECAST | propose→approve | none | **Critical** | 4.10 |
| FP-A4 | Zero-based budgeting mode w/ justification scaffold | DRAFT+DETECT | propose→approve | none | Med | 2.90 |
| FP-A5 | Budget version management + plan-of-record lock ★ | DET | elevated-role | none | High | 3.85 |
| FP-A6 | Top-down vs bottom-up "gap to target" reconciliation | DETECT+DRAFT | propose→approve | none | High | 3.30 |
| FP-A7 | Assumption library + contractual step-up auto-application | CLASSIFY+DET | propose→approve | none | Med | 3.10 |
| FP-B1 | Rolling forecast (actuals-to-date + forecast-remaining) ★ | FORECAST | propose→approve | none | **Critical** | 4.15 |
| FP-B2 | Continuous forecast auto-tuning from actuals | FORECAST | propose→approve | none | High | 3.55 |
| FP-B3 | Reforecast-on-variance trigger ★ (an Exception-Library class) | DETECT+FORECAST | detect→triage | none | High | 3.80 |
| FP-B4 | Three-statement (integrated) forecast — P&L→BS→CF | DET+FORECAST | propose→approve | none | **Critical** | 4.00 |
| FP-B5 | Revenue / pipeline-driven revenue forecast | FORECAST | propose→approve | none | High | 3.40 |
| FP-B6 | Cohort & unit-economics (CAC/LTV/retention/payback) | DET+FORECAST | read-only | none | Med | 3.10 |
| FP-B7 | Monthly indirect cash/liquidity budget tied to the 13-wk direct | FORECAST | read-only | partial (13-wk built) | High | 3.50 |
| FP-C1 | Headcount / roster / fully-loaded comp planning ★ | DET+FORECAST | propose→approve | none | **Critical** | 3.95 |
| FP-C2 | Compensation & merit-cycle modeling (affordability-checked) | DET+FORECAST | propose→approve | none | Med | 3.15 |
| FP-C3 | Capex budgeting + capex→depreciation→cash bridge | DET+CLASSIFY | propose→approve | none | High | 3.35 |
| FP-C4 | Debt/financing schedule & interest forecast (feeds covenant) | DET | read-only | none | High | 3.40 |
| FP-D1 | Versioned, dimensional, drill-through BvA | DET | read-only | partial | High | 3.70 |
| FP-D2 | **AI flux / variance narrative** ★ (*folds GL-E1*) | DETECT+DRAFT | propose→approve | none | **Critical** | 3.95 |
| FP-D3 | Missing-variance-explanation detector + close gate | DETECT | hard-gate | none | High | 3.40 |
| FP-D4 | Real-time approaching/over-budget alerts (run-rate) | DETECT+FORECAST | detect→triage | none | High | 3.45 |
| FP-D5 | Commitment-aware budget consumption (encumbrance) | DET | read-only / hard-gate | none | Med | 3.05 |
| FP-E1 | Scenario modeling (base/upside/downside) ★ | DET+FORECAST | propose→approve | none | **Critical** | 3.90 |
| FP-E2 | Sensitivity / tornado on the drivers that move EBITDA/cash | DET | read-only | none | High | 3.30 |
| FP-E3 | NL "what-if" query → modeled P&L/cash ★ (*→ PW5*) | DRAFT→DET | propose→approve | none | High | 3.60 |
| FP-E4 | Goal-seek / target-driven planning | DET | propose→approve | none | Med | 3.00 |
| FP-E5 | Monte-Carlo / probabilistic ranges (P10/P50/P90) | DET | read-only | none | Low | 2.55 |
| FP-F1 | Department budget collaboration & submission workflow | WORKFLOW | propose→approve | none | High | 3.35 |
| FP-F2 | Budget approval/ratification workflow (SoD-bound) | DET | elevated-role | none | High | 3.30 |
| FP-F3 | Budget change log & audit trail | DET | read-only | none | Med | 3.00 |
| FP-F4 | Budget owner nudge / deadline chase (*→ PW7*) | DRAFT | propose→approve | none | Med | 2.85 |
| FP-G1 | Board / management package auto-generation ★ | DRAFT over DET | propose→approve | none | **Critical** | 3.90 |
| **FP-G2** | **Covenant-aware continuous monitor + draft certificate** ★ (v1 E1; *folds BC-F1*) | FORECAST+DRAFT | elevated-role (never auto-file) | none | **Critical** | 3.85 |
| FP-G3 | Borrowing-base certificate & eligible-collateral forecast | DET+DETECT | elevated-role | none | High | 3.30 |
| FP-G4 | Lender/investor package & data-tape generation | DRAFT | propose→approve | none | High | 3.20 |
| FP-G5 | Benchmark vs peers/industry | DETECT | read-only | none | Med | 2.80 |
| FP-H1 | Long-range plan (3–5 yr) that refreshes off actuals | DET+FORECAST | propose→approve | none | High | 3.25 |
| FP-H2 | Value-creation / equity-bridge & MOIC/IRR (PE) | DET | read-only | none | Med | 3.00 |
| FP-H3 | Reusable deal/ad-hoc model templates | DET | propose→approve | none | Med | 2.95 |

### 2.2 Accounts Payable / Procure-to-Pay (`AP-`) — 35 native (home of duplicate-payment + BEC)

Build: 7 controls/engines live (COI/W-9 gate, vendor dedupe, bill-anomaly, dup-payment detect,
check-run, comp-hold gate, retainage). The keystone gap is a **PO model in Books** (blocks all 3-way
matching + encumbrance) and a **BEC/vendor-bank-change** control (zero coverage today).

| ID | Capability | Bucket | HITL | Build | Tier | Score |
|---|---|---|---|---|---|---|
| AP-A1 | PDF/image invoice extraction (line-level) | EXTRACT | propose→approve | partial | High | 3.95 |
| AP-A2 | Email AP-inbox ingestion (bills@tenant) | EXTRACT | propose→approve | none (blocked GATE 4) | High | 3.90 |
| AP-A3 | Source-document vault + provenance (prereq to audit-grade A1) | DET | read-only | none | High | 3.85 |
| AP-A4 | Vendor-portal / EDI invoice fetch | EXTRACT | propose→approve | none | Med | 2.90 |
| AP-A5 | Duplicate-at-intake block (inline, before save) | MATCH+DETECT | hard-gate | partial | High | 4.00 |
| AP-B1 | Vendor auto-create from an invoice | EXTRACT+CLASSIFY | propose→approve | partial | Med | 3.10 |
| AP-B2 | W-9/TIN capture + IRS TIN matching + payment gate (*folds TX-B1*) | EXTRACT+DET | hard-gate | partial | High | 3.90 |
| AP-B3 | COI (GL+WC) tracking + expiry chase | DETECT+DRAFT | hard-gate | **built** (send blocked GATE 4) | High | 3.90 |
| AP-B4 | **BEC / vendor bank-change verification** (quarantine + dual-control) | DETECT+DRAFT | human-release | none | **Critical** | 4.10 |
| AP-B5 | Duplicate-vendor-master detection & merge proposal | MATCH+DETECT | propose→approve | **built** | High | 3.60 |
| AP-B6 | Vendor sanctions / OFAC / watchlist screen | DETECT | detect→triage | none | Med | 2.85 |
| AP-C1 | AP line-level auto-coding by vendor history | CLASSIFY | propose→approve | partial | High | 3.95 |
| AP-C2 | Cost→job/cost-code attribution + `JOB_COST` emit ★ (suite moat) | CLASSIFY+MATCH | propose→approve | partial | **Critical** | 4.05 |
| AP-C3 | Capex-vs-expense classifier + FA lifecycle (*= TX-D1*) | CLASSIFY | propose→approve | partial | High | 3.30 |
| AP-C4 | Tax-character tagging at AP posting (*→ TX-C1*) | CLASSIFY | propose→approve | none | High | 3.60 |
| AP-D1 | **PO model in Books** + `bills.purchase_order_id` (keystone) | DET | elevated-role | none (NEEDS-CENTRAL) | **Critical** | 4.10 |
| AP-D2 | 3-way match (PO↔receipt↔invoice) | MATCH | propose→approve / hard-gate | none | **Critical** | 4.00 |
| AP-D3 | 2-way match / PO-variance flag | DETECT | detect→triage | none | High | 3.60 |
| AP-D4 | Bill-amount anomaly (no PO needed) | DETECT | detect→triage | **built** | High | 3.70 |
| AP-D5 | **Duplicate/erroneous payment detection** ★ (v1 B1; *folds BC-E1*) | DETECT+MATCH | detect→triage → hard-gate | **built** (detect-only) | **Critical** | 4.60 |
| AP-D6 | Math/foot validation at entry | DET | hard-gate | none | Med | 3.10 |
| AP-E1 | Approval routing by amount/type/cost-center | DET | propose→approve | partial | High | 3.40 |
| AP-E2 | SoD enforcement + continuous conflict scan (*→ PW3*) | DET+DETECT | hard-gate | partial | High | 3.70 |
| AP-E3 | Approval SLA / aging nudges (protect discounts) | DRAFT+DETECT | propose→approve | none | Med | 3.05 |
| AP-F1 | Check-run builder (batch due-soon, idempotent) | DET | human-release | **built** | High | 3.50 |
| AP-F2 | Payment-timing / dynamic-discount optimizer (2/10≈36%) | FORECAST | propose→approve | none | High | 3.45 |
| AP-F3 | Multi-rail disbursement + correct rail accounting | DET | human-release | partial | High | 3.40 |
| AP-F4 | Positive-pay / ACH-fraud file (*= BC-E3/E4*) | DET | read-only | none | High | 3.35 |
| AP-F5 | Compliance-hold payment gate | DET | hard-gate | **built** | High | 3.60 |
| AP-F6 | Retainage withholding on sub bills | DET | elevated-role | **built** | Med | 3.10 |
| AP-G1 | Disbursement→bank reconciliation (stale-check surfacing) | MATCH+RECONCILE | propose→approve | partial | Med | 3.20 |
| AP-G2 | Vendor-statement reconciliation (lost-invoice/credit leaks) | EXTRACT+MATCH | propose→approve | none | High | 3.35 |
| AP-H1 | RNI / recurring accrual auto-draft from open POs (*= GL-B*) | FORECAST+CLASSIFY | propose→approve | partial | High | 3.65 |
| AP-H3 | Recurring bill templates (AP side) | DET | propose→approve | none | Med | 3.05 |
| AP-I4 | Spend analytics & vendor concentration | DETECT+FORECAST | read-only | partial | Med | 2.95 |
| AP-I5 | Contract/subscription renewal tracking (auto-renew traps) | DETECT+DRAFT | propose→approve | none | Med | 2.90 |

*(AP-I1 1099 → TX-B3; AP-I2 intercompany-AP mirror → GL-H1; AP-I3 anomalous-JE → PW2; AP-I6 payables→13-wk
feed → BC-D3; AP-I7 uncategorized → GL-close gate; AP-I8 doc-chase → PW7; AP-I9 PBC/tie-out → GL-G/TX-F3.)*

### 2.3 Accounts Receivable & Collections (`AR-`) — 35 native (home of cash application + dunning)

Build: the AR *money spine* shipped (branded delivery+Pay-Now live, recurring invoices, collections/DSO
worklist, credit memos, void, write-off posting, statements, Stripe pay live, cash-application detector).
The gaps are the **collections automation moat** (dunning ladder / outreach / promise-to-pay) and the
**cash-application disposition + subledger tie-out**.

| ID | Capability | Bucket | HITL | Build | Tier | Score |
|---|---|---|---|---|---|---|
| AR-A1 | Product/service item catalog driving invoice lines | CLASSIFY | propose→approve | none | Med | 3.05 |
| AR-A2 | Rev-rec-aware invoice posting (credit Deferred Rev 2410) | CLASSIFY | read-only | partial | High | 3.60 |
| AR-A3 | Progress / AIA billing (SOV, G702/G703, retainage) | CLASSIFY | propose→approve | partial | High | 3.30 |
| AR-A4 | Recurring invoices (subscriptions/retainers) auto-send | DET | auto-send(dial) | **built** | High | 3.40 |
| AR-A5 | Revenue-leakage detection (work done, not billed) (w/ Projects) | DETECT+RECONCILE | propose→approve | partial | High | 3.75 |
| AR-A6 | Attachments + customer-PO capture on invoice | EXTRACT | propose→approve | none | Med | 2.95 |
| AR-A7 | Estimate/quote → invoice conversion | DET | propose→approve | none | Low | 2.50 |
| AR-B8 | Branded delivery (email+PDF+Pay-Now) w/ failure codes | DET | propose→approve | **built** | High | 3.50 |
| AR-B9 | Delivery / open / bounce tracking | DETECT | detect→triage | partial | Med | 3.05 |
| AR-B10 | CC / multi-recipient / custom-message send | DET | propose→approve | none | Med | 2.80 |
| AR-B11 | Self-serve customer portal (pay any/many, dispute, history) | DET | read-only | none | High | 3.25 |
| AR-C12 | Collections / DSO command center + collector worklist | DETECT/agg | read-only | **built** | High | 3.75 |
| AR-C13 | Manual one-click reminder (manual dunning rung) | DET | propose→approve | **built** | Med | 3.10 |
| AR-C14 | **Automated tiered dunning ladder** (tone/quiet-hours/pausable) ★ | FORECAST+DRAFT | propose→approve / auto-send(dial) | none | **Critical** | 3.60 |
| AR-C15 | AI collections outreach drafting (tone-matched, escalating) | DRAFT | propose→approve | none | High | 3.40 |
| AR-C16 | Promise-to-pay capture & broken-promise escalation | DETECT+FORECAST | propose→approve | none | High | 3.35 |
| AR-C17 | Payment-plan / installment automation | DET+FORECAST | elevated-role | none | Med | 3.05 |
| AR-C18 | Credit scoring & credit-limit management | DETECT+FORECAST | propose→approve | partial | High | 3.30 |
| AR-C19 | Credit-hold automation (order/ship gate) | DETECT | hard-gate | none | High | 3.25 |
| AR-C20 | Auto late-fees / finance charges (opt-in, balanced posting) | DET | elevated-role | none | Med | 2.95 |
| AR-C21 | At-risk / churn signal on the AR book | DETECT+FORECAST | read-only | none | Med | 3.05 |
| AR-C22 | **AI cash application** (deposits→open AR, lump/split) ★ (v1 C1; *folds BC-B8, GL-D3*) | MATCH | propose→approve | **built** (propose-only) | **Critical** | 3.90 |
| AR-C23 | Lockbox / BAI2 bank-file ingestion + auto-apply | EXTRACT+MATCH | propose→approve | none | Med | 3.00 |
| AR-C24 | Partial / short-pay handling → open a deduction | DETECT | propose→approve | none | High | 3.30 |
| AR-C25 | Unapplied-cash / on-account & customer-deposit ledger | DET | propose→approve | none | High | 3.25 |
| AR-C26 | Dispute / deduction detection + resolution workflow | DETECT+DRAFT | elevated-role | none | High | 3.30 |
| AR-C27 | Credit memos (issue/apply/refund bridge) | DET | elevated-role | **built** (refund bridge none) | High | 3.35 |
| AR-C28 | Void & reissue (retain number, watermark) | DET | elevated-role | **built** | Med | 3.10 |
| AR-C29 | Bad-debt write-off + allowance for doubtful accounts | DETECT | elevated-role | partial | High | 3.40 |
| AR-C30 | Refunds (overpayment/credit → money out) | DET | human-release | none | Med | 3.00 |
| AR-C31 | Customer statements (open-item/balance-forward) + delivery | DET | propose→approve | **built** | Med | 3.15 |
| AR-C32 | Online Pay Now (ACH+card), hosted, correct GL | DET | read-only | **built & live** | High | 3.55 |
| AR-C33 | Two-layer merchant-fee model (charge + pass-through/absorb) | DET | read-only | **built** | Med | 3.10 |
| AR-C34 | Behavior-weighted AR collection feed → 13-wk forecast (*= BC-D2*) | FORECAST | read-only | partial | High | 3.35 |
| AR-C35 | AR subledger↔GL (1100) tie-out + unapplied-cash close gate | RECONCILE+DETECT | hard-gate | none | **Critical** | 3.70 |

### 2.4 GL, Close & Consolidation (`GL-`) — 24 native (home of intercompany + close orchestration)

Build: 10 live (NL JE composer, missed-accruals w/ auto-draft, deferred-rev release, bank-rec autopilot,
close command center, IC-imbalance detect, year-end close, vendor/1099 gate, cash-app) + the posting-engine
gates + EC detectors. Biggest gaps: **consolidation depth** (11a MANDATORY), **flux narrative**, **working
papers/evidence**, and wiring tier→disposition (see PW4).

| ID | Capability | Bucket | HITL | Build | Tier | Score |
|---|---|---|---|---|---|---|
| GL-A2 | Recurring-JE auto-generation w/ reversing logic | CLASSIFY | propose→approve | partial | High | 3.55 |
| GL-A3 | Learned recurring-entry discovery ("make this recurring?") | CLASSIFY | propose→approve | partial | Med | 3.10 |
| GL-B1 | Auto-accrual of expected-but-absent recurring costs (the *missing* accrual) ★ | FORECAST+DETECT | propose→approve | **built** | **Critical** | 3.90 |
| GL-B2 | Prepaid amortization / straight-line schedule engine | DET+DETECT | propose→approve | partial | High | 3.40 |
| GL-B3 | Deferred-revenue release (rev-rec-driven) | DET+DETECT | propose→approve | **built** | High | 3.50 |
| GL-B4 | Depreciation & interest accrual scheduler (dual-book) | DET | propose→approve | partial | Med | 3.15 |
| GL-C1 | Continuous ("soft") close orchestration + days-to-close-ready | ORCH+DET | read-only | partial | High | 3.60 |
| GL-C4 | **Uncategorized/"Ask My Accountant" cleanup + empty-before-close gate** (v1 D1; *folds AP-I7, BC-F7*) | CLASSIFY+DETECT | hard-gate | **built** (detect feeds close) | High | 4.05 |
| GL-D2 | Subledger→GL control-account tie-out (standing control) | DETECT | detect→triage | partial | High | 3.55 |
| GL-D4 | Write-off / reserve proposal with rationale (*= AR-C29*) | DETECT | elevated-role | partial | Med | 3.20 |
| GL-E2 | Missing-variance-explanation gate (*rides FP-D2*) | DETECT | hard-gate | none | High | 3.40 |
| GL-E3 | Anomaly-by-shape analytical review (ratio/trend engine) | DETECT | detect→triage | partial | High | 3.35 |
| GL-F1 | **Real-time close command center** (per-entity, ledger-derived) ★ | DERIVE+ORCH | read-only | **built** | High | 3.95 |
| GL-F2 | Close-task orchestration w/ dependency graph | ORCH | propose→approve | partial | **Critical** | 3.80 |
| GL-F3 | Auto-verify mechanical close tasks from the ledger | DERIVE→ORCH | read-only | partial | High | 3.65 |
| GL-F4 | Close workload / capacity / throughput view (machine+humans) | DERIVE | read-only | partial | Med | 3.15 |
| GL-G1 | Working-paper auto-generation + tie-out | PACKAGE+DERIVE | elevated-role | partial | High | 3.70 |
| GL-G2 | Roll-forward schedules (prepaids/accruals/deferred/debt/FA/equity) | DERIVE+PACKAGE | read-only | none | High | 3.30 |
| GL-G3 | Audit-ready evidence packaging (*= TX-F3*) | PACKAGE | elevated-role | none | High | 3.55 |
| GL-G4 | PBC request automation (self-fulfilling audit list) | ORCH+PACKAGE | propose→approve | none | High | 3.35 |
| GL-H1 | **Intercompany matching + mirror-draft + imbalance block** ★ (*folds TX-E1, BC-F6, AP-I2*) | MATCH+DETECT | propose→approve | **built** (detect) | High | 3.75 |
| GL-H2 | **Consolidation depth: ownership%/NCI/invest-in-sub/groupings/booked eliminations** ★ | DERIVE+PROPOSE | elevated-role | partial·FPB | **Critical** | 4.00 |
| GL-H3 | Currency translation (CTA) — multi-currency groups | DERIVE+PROPOSE | propose→approve | none | Med | 2.80 |
| GL-I1 | Year-end close (P&L→retained earnings, idempotent) | DERIVE→post | elevated-role | **built** | Med | 3.20 |
| GL-I2 | Prior-period adjustment / controlled-reopen workflow + alarm | ORCH+DETECT | elevated-role | partial | High | 3.45 |
| GL-I3 | Close analytics (cycle time, bottlenecks, autonomy rate) → dials | DERIVE | read-only | none | High | 3.30 |

### 2.5 Bank & Cash / Treasury (`BC-`) — 27 native (home of reconciliation + 13-wk forecast)

Build: strong — Plaid feed, categorization, pattern-learning, reconciliation autopilot + adjusting
entries, cash dashboard, 13-week forecast, money-movement SoD, cash-flow report all live. Gaps: the
reconciliation *controller mechanics* (per-line check-off/finalize/lock), a *decision-grade* forecast
(scheduled outflows + behavior), and the treasury fraud controls (BEC, positive-pay, sweep).

| ID | Capability | Bucket | HITL | Build | Tier | Score |
|---|---|---|---|---|---|---|
| BC-A1 | Bank & card feed ingestion (Plaid sync) | ingest | read-only | **built** | High | 3.60 |
| BC-A2 | AI bank-feed auto-categorization (confidence-sorted) ★ (v1 A1) | CLASSIFY | propose→approve / auto-clear(dial) | **built** | **Critical** | 4.75 |
| BC-A3 | Vendor-pattern learning loop | learning | read-only | **built** | High | 3.40 |
| BC-A4 | Feed-vs-bill double-count block (at categorization) | MATCH+DETECT | hard-gate | partial | High | 3.50 |
| BC-A5 | Shared-card split & dimension tagging | CLASSIFY | propose→approve | partial | Med | 3.05 |
| BC-B1 | Statement reconciliation (per-line check-off to $0) | RECONCILE | elevated-role | partial | High | 3.55 |
| BC-B2 | AI reconciliation autopilot (composite score→tier) ★ | MATCH+RECONCILE | propose→approve | **built** | High | 3.90 |
| BC-B3 | Per-line cleared/reconciled linkage (finalize/lock/undo) | DET | read-only | partial (data model built) | High | 3.45 |
| BC-B4 | In-rec adjusting entries (bank fee/interest/error) | DET | propose→approve | **built** | Med | 3.20 |
| BC-B5 | "Find the difference" AI diagnosis | DETECT | detect→triage | none | Med | 3.05 |
| BC-B6 | Unreconcile / undo with audit | DET | elevated-role | none | Med | 2.95 |
| BC-B7 | Statement import (CSV/OFX/QFX) + manual line entry | EXTRACT | propose→approve | none | High | 3.20 |
| BC-B9 | Split/grouped-deposit + inter-account transfer detection | MATCH | propose→approve | none | Med | 3.05 |
| BC-B10 | Reconciliation report (PDF) + stale-check aging | report | read-only | none | Med | 3.00 |
| BC-B11 | Reconciliation-required close gate (auto-verified) | DET | hard-gate | partial | High | 3.55 |
| BC-C1 | Real-time multi-entity cash-position dashboard | dashboard | read-only | **built** | High | 3.50 |
| BC-C2 | Balance-freshness / stale-feed monitor | DETECT | detect→triage | partial | Med | 3.00 |
| BC-C3 | Cash-requirement / payroll & debt-service safety alert | DETECT+FORECAST | hard-gate | none | **Critical** | 3.75 |
| BC-C4 | Sweep / idle-cash optimization (propose, never move) | FORECAST | human-release | none | High | 3.25 |
| BC-C5 | Intercompany cash pooling / netting view (multi-entity) | FORECAST | human-release | none | High | 3.20 |
| BC-D1 | 13-week direct cash forecast ★ (v1 E2) | FORECAST | read-only | **built** | High | 3.75 |
| BC-D2 | Behavior-adjusted forecast (predicted collection dates) | FORECAST | propose→approve | none | High | 3.45 |
| BC-D3 | Scheduled-outflow overlay (payroll/debt/tax/recurring) | FORECAST | propose→approve | none | **Critical** | 3.70 |
| BC-D4 | Scenario / what-if + funding recommendation | FORECAST | human-release | none | High | 3.30 |
| BC-E2 | **Vendor bank-change / BEC blocking gate** (*= AP-B4*) | DETECT | human-release | none | **Critical** | 4.10 |
| BC-E5 | Bank-fee anomaly / analysis-statement audit | DETECT | detect→triage | none | Med | 2.95 |
| BC-E6 | NSF / return / overdraft tracking (reverse cash-app, re-open) | DETECT | propose→approve | none | Med | 3.05 |

*(BC-B8 cash-app → AR-C22; BC-E1 dup-payment → AP-D5; BC-E3/E4 positive-pay/ACH-filter → AP-F4; BC-E7
interest tracking folds into BC-B4; BC-E8 SoD → PW3; BC-F1 covenant → FP-G2; BC-F6 IC → GL-H1; BC-F7
uncategorized → GL-C4; BC-F8 anomalous → PW2; BC-F9 autonomy → PW4; BC-F10 decision-log → PW6; BC-F11
cash-flow statement is a report, built; BC-F2 borrowing-base → FP-G3; BC-F3 FX seam → GL-H3; BC-F4 float,
BC-F5 unreconciled-aging retained as segment-tail, low.)*

### 2.6 Tax & Compliance (`TX-`) — 39 native (home of nexus + book-to-tax + 1099)

Build: 10 live (nexus tripwire, W-9/COI gate, 1099 readiness, dual-book depreciation, tax-year params,
IC matching, anomalous-JE, cutoff, obligation tracker). **Never the regulated party** — filing/TIN-match/
rate/e-file cross a licensed boundary and hand off to a provider. Biggest gap: **book-to-tax M-1/M-3
tagging** ("the single richest AI opportunity") and the **PBC/assurance pack**.

| ID | Capability | Bucket | HITL | Build | Tier | Score | Provider |
|---|---|---|---|---|---|---|---|
| TX-A1 | Sales-tax economic-nexus tripwire (rolling 12-mo, ~80% alert) ★ (v1 F1) | DETECT | detect→triage | **built** | **Critical** | 3.95 | — |
| TX-A2 | Income/franchise nexus (payroll/property/inventory) | DETECT | propose→approve | none | High | 3.40 | — |
| TX-A3 | Sales-tax registration & filing-status tracker | WORKFLOW | read-only | none (NEEDS-CENTRAL) | High | 3.30 | — |
| TX-A4 | Rate & taxability determination at billing | CLASSIFY | propose→approve | none | High | 3.30 | **required** (Avalara/TaxJar/Stripe Tax) |
| TX-A5 | Sales-tax liability accrual + return-prep worksheet | WORKFLOW+DRAFT | human-release | none | High | 3.25 | returns via provider |
| TX-A6 | Use-tax accrual on untaxed purchases | DETECT+CLASSIFY | propose→approve | none | High | 3.35 | taxability lookup |
| TX-A7 | Exemption-certificate management (missing/expired) | DETECT+WORKFLOW | propose→approve | none | High | 3.20 | optional (CertCapture) |
| TX-A8 | Marketplace-facilitator / 1099-K interplay reconciliation | CLASSIFY | read-only | partial (rail-split built) | Med | 3.00 | — |
| TX-B2 | IRS TIN matching (name+TIN) | DETECT | propose→approve | partial (presence only) | High | 3.35 | **required** (IRS/Tax1099) |
| TX-B3 | **1099-NEC/MISC readiness (year-round, rail-split)** ★ (v1 F3; *folds AP-I1*) | DETECT | propose→approve | **built** | High | 3.30 | e-file is TX-B4 |
| TX-B4 | 1099 e-file (IRS+state) & recipient delivery | WORKFLOW | propose→approve | none | High | 3.15 | **required** (Track1099/Sovos) |
| TX-B5 | Backup-withholding trigger & accrual (24%) | DETECT+WORKFLOW | human-release | none | Med | 3.05 | remittance via provider |
| TX-C1 | **Book-to-tax difference tagging (M-1/M-3)** ★ (v1 F2; "richest AI opportunity") | CLASSIFY | propose→approve | none | **Critical** | 3.75 | — |
| TX-C2 | Temporary vs permanent classification (ASC 740 dim) | CLASSIFY | propose→approve | none | High | 3.55 | — |
| TX-C3 | Deferred-tax rollforward (DTA/DTL) | WORKFLOW+FORECAST | elevated-role | none (depr substrate seeded) | High | 3.30 | — |
| TX-C4 | Income-tax provision (current+deferred, rate rec, FIN 48) | WORKFLOW+DRAFT | elevated-role | none | High | 3.20 | complex returns → provider |
| TX-C5 | Estimated-payment scheduler + safe-harbor math | FORECAST+WORKFLOW | human-release | none | Med | 3.05 | EFTPS by human |
| TX-C6 | Multistate apportionment factors | WORKFLOW | elevated-role | none (rev-by-state substrate) | Med | 3.00 | return prep → provider |
| TX-C7 | PTET / composite election tracker | DETECT+WORKFLOW | elevated-role | none | Med | 3.00 | election by CPA |
| TX-C8 | R&D / §174 capitalization + §41 credit substrate | DETECT+CLASSIFY | elevated-role | none | Med | 2.95 | R&D study specialist |
| TX-C9 | Other-credits capture (WOTC, energy, state) | DETECT | detect→triage | none | Low | 2.60 | provider-assisted |
| TX-D1 | Capex-vs-expense classifier + de-minimis safe harbor (*= AP-C3*) | CLASSIFY+DRAFT | propose→approve | partial | High | 3.30 | — |
| TX-D2 | Dual-book depreciation (book SL vs tax MACRS/§179/bonus) | DET | read-only | **built** | High | 3.40 | — |
| TX-D3 | §179/bonus/de-minimis election presenter (never auto-elect) | DRAFT | elevated-role | partial | High | 3.20 | — |
| TX-D4 | Disposition & depreciation-recapture (§1245/1250) | DETECT+WORKFLOW | propose→approve | partial | Med | 3.05 | — |
| TX-D5 | Tax-year statutory-parameter management (confirmed gate) | DRAFT | elevated-role | **built** | Med | 3.00 | — |
| TX-E2 | Related-party graph + ASC 850 disclosure schedule | DETECT | elevated-role | partial | High | 3.30 | — |
| TX-E3 | Owner-benefit / disguised-distribution classifier | DETECT+CLASSIFY | elevated-role | none | High | 3.25 | — |
| TX-E4 | S-corp reasonable-compensation monitor | DETECT | elevated-role | none | Med | 2.95 | comp-benchmark optional |
| TX-E5 | Transfer-pricing / §482 flag | DETECT | elevated-role | none | Low | 2.60 | TP study specialist |
| TX-E6 | Basis / capital-account / K-1 roll (pass-through) | WORKFLOW | elevated-role | none | High | 3.10 | K-1 via tax software |
| TX-F2 | Revenue & expense cutoff enforcement (*= v1 F4*) | DETECT | detect→triage | **built** | High | 3.05 |  |
| TX-F3 | **PBC / tie-out assurance pack** (audit-fee ROI) ★ (*= GL-G3*) | WORKFLOW | read-only | none | **Critical** | 3.55 | — |
| TX-G1 | Generic regulatory obligation/filing tracker | WORKFLOW+DETECT | propose→approve | **built** | Med | 3.10 | — |
| TX-G2 | Tax-calendar automation (fed/state/local due dates) | WORKFLOW+DRAFT | propose→approve | partial | High | 3.25 | rule-set feed optional |
| TX-G3 | Entity / registered-agent / annual-report / franchise calendar | WORKFLOW+DETECT | propose→approve | none | Med | 3.00 | CSC/CT/Harbor |
| TX-G4 | Business-license / SoS good-standing monitor | DETECT | propose→approve | none | Low | 2.70 | compliance-data provider |

*(TX-B1 W-9 gate → AP-B2; TX-E1 IC → GL-H1; TX-F1 anomalous-JE → PW2; TX-F4 SoD matrix → PW3.)*

---

## §3. Distinct-count & build-state census

**Raw enumerated across the six deep-dives:** 40 + 40 + 35 + 36 + 36 + 43 = **230**. Plus v1's 29 —
all subsumed into the rows above.

**After dedup** (8 lifted to PLATFORM-WIDE; ~17 cross-segment duplicates collapsed to a single home — cash
application, covenant, intercompany, anomalous-JE, 1099, nexus, duplicate-payment, uncategorized close
gate, positive-pay, capex classifier, etc.):

| Group | Distinct rows | built | partial | none |
|---|---|---|---|---|
| PLATFORM-WIDE | 8 | 2 | 5 | 1 |
| FP&A | 37 | 0 | 4 | 33 |
| AP | 35 | 7 | 12 | 16 |
| AR | 35 | 10 | 6 | 19 |
| GL / Close / Consolidation | 24 | 6 | 12 | 6 |
| Bank & Cash | 27 | 9 | 8 | 10 |
| Tax & Compliance | 39 | 6 | 8 | 25 |
| **Total** | **≈ 205 distinct** | **≈ 40** | **≈ 55** | **≈ 110** |

**Headline (v2 segment-first pass):** of ~205 distinct capabilities, **~40 are built** (functional or
shipped detect-only), **~55 partial**, **~110 not started**. **Real remaining work ≈ 165** capabilities
(partial + none); of those, **~110 are net-new** (nothing in the repo yet). The count is heavily front-loaded
on the transactional core (AP/AR/Bank all >25% built) and near-empty on **FP&A (0/37 built)** and **Tax
(6/39)** — exactly the owner-flagged planning/analytical thinness.

**TRUE superset headline (v2 + the modality-sweep ⭐NEW, Session 42 — see §6):** the segment × 14-modality
sweep (`AI-CAPABILITY-MATRIX.md`) surfaced **98 distinct net-new capabilities** with no home in the v2 list
above (5 platform-wide cross-cutting rows + 93 segment-specific). Folding them in:
**≈ 303 distinct capabilities total, ~40 built, ~55 partial, ~208 none/spec → ≈ 263 remaining.** Built count
is **unchanged** — every ⭐NEW row is spec/partial/none. The new work concentrates in the whole-column blind
spots (M13 search, M8 NL, M7 narrative, M9 agentic, M14 learning) and the segments v2 folded away or omitted
(Rev-Rec, Fixed Assets, Customer, Expense/Card, Procurement, Payroll, Practice, Job-Costing, Team-Performance,
Onboarding). **This file is now the true superset; `AI-CAPABILITY-MATRIX.md` is the one-screen index over it.**

**Already-built, so NOT remaining work** (the ~40): PW2 anomalous-JE, PW5 NL JE composer, PW6 decision
log; AP B3/B5/D4/D5/F1/F5/F6; AR A4/B8/C12/C13/C22(propose)/C27/C28/C31/C32/C33; GL B1/B3/F1/H1(detect)/I1
+ C4(detect); BC A1/A2/A3/B2/B4/C1/D1 + cash-flow report; TX A1/B3/D2/D5/F2/G1. Plus the deterministic
posting-engine gates and the 10 `/exceptions` detectors (EC-1/2/3/4/7/8/10/12 + rev-rec + bill-anomaly),
all verified live in `apps/web/src/lib/controls/`.

---

## §4. BUILD NEXT — the top 25 (ranked, mapped to gate + FPB)

Ranked by composite × trust-to-sign × owned-ledger leverage, respecting the canon rule that **no gate
starts until its `Prereq:` gates are DONE** and that the open identity/RBAC NO-GO gate (#9) underwrites
every approval/attribution story. **Each needs an approved Rule-13 FPB before build.**

| # | Capability (refs) | Home gate | Value | FPB status |
|---|---|---|---|---|
| 1 | **Supervision & Autonomy Control Plane** — wire `scoreToTier`→disposition + per-task dial + materiality + kill-switch + pre-post interceptor (PW4, PW8, GL-I3) | GATE 5 (+9) | Critical | **NEW FPB** (Supervision & Autonomy) |
| 2 | **Close identity/RBAC NO-GO gate** — multi-tenant org resolution, control-route RBAC, SoD org-scoping (PW3; tasks #9/#33) | GATE 10/9 | Critical | `FPB-identity-multitenancy.md` (built-to) |
| 3 | **Duplicate/erroneous payment → blocking gate** + **BEC vendor-bank-change** (AP-D5, AP-A5, AP-B4 / BC-E2) | GATE 8/9 | Critical | EC-1 in exceptions FPB; **NEW** vendor-banking-fraud FPB |
| 4 | **Consolidation depth** — ownership%/NCI/invest-in-sub/groupings/booked eliminations + IC auto-mirror (GL-H2, GL-H1) | **GATE 11a (MANDATORY)** | Critical | extend `FPB-tenant-model-consolidation-analytics.md` |
| 5 | **Book-to-tax M-1/M-3 tagging + temp/perm** (TX-C1, TX-C2) — "richest AI opportunity" | GATE 7/8 | Critical | EC-9 in exceptions FPB; **NEW** book-to-tax module FPB |
| 6 | **Flux/variance auto-narrative + missing-explanation gate** (FP-D2, FP-D3, GL-E2) | GATE 7 | Critical | **NEW FPB** (Flux & Variance Narrative) |
| 7 | **Close orchestration** — dependency graph + ledger auto-verify + capacity view (GL-F2, GL-F3, GL-F4) | GATE 8 | Critical | **NEW FPB** (Close Orchestration) |
| 8 | **AR subledger↔GL tie-out + cash-app disposition + unapplied-cash ledger** (AR-C35, AR-C22 completion, AR-C25) | GATE 8 | Critical | cash-application FPB; extend for tie-out |
| 9 | **Reconciliation moat completion** — per-line check-off/finalize/lock/unreconcile + close gate + statement import + PDF (BC-B1/B3/B6/B7/B10/B11) | GATE 8 | High | extend `FPB-bank-reconciliation.md` (Waves B) |
| 10 | **PO model in Books + 3-way/2-way match** (AP-D1 keystone, AP-D2, AP-D3) | GATE 11b | Critical | **NEW FPB** (AP PO / 3-way) — NEEDS-CENTRAL |
| 11 | **Budget triad** — version mgmt + AI draft off actuals + seasonality (FP-A5, FP-A1, FP-A2) | GATE 7 | Critical | **NEW FPB** (extends `FPB-financial-reports.md` D8) |
| 12 | **Rolling forecast + reforecast-on-variance trigger** (FP-B1, FP-B3) | GATE 7 | Critical | **NEW FPB** (D9.2) |
| 13 | **Covenant continuous monitor + board-package generator** (FP-G2, FP-G1) | GATE 7 (seg) | Critical | **NEW FPB** (Covenant & Liquidity) |
| 14 | **Automated dunning ladder + AI outreach + promise-to-pay** (AR-C14, AR-C15, AR-C16) | GATE 9 | Critical | **NEW FPB** (Dunning/Collections Automation) |
| 15 | **Working papers auto-gen + tie-out + evidence/PBC pack** (GL-G1, GL-G3, TX-F3) | GATE 8 | High | **NEW FPB** (Working Papers & Audit Evidence) |
| 16 | **Uncategorized cleanup → empty-before-close hard gate** (GL-C4) | GATE 8 | High | fold into Close Orchestration FPB |
| 17 | **Driver-based budgeting + scenarios + NL what-if** (FP-A3, FP-E1, FP-E3/PW5) | GATE 7 | High | **NEW FPB** (D9.1/D9.3) |
| 18 | **AP line-level auto-coding + cost→job attribution** (AP-C1, AP-C2) | GATE 6 | Critical | **NEW FPB** (AP coding) |
| 19 | **AP source-doc vault + line-level extraction** (AP-A3, AP-A1) | GATE 8 (prereq GATE 4) | High | **NEW FPB** (AP intake) |
| 20 | **Decision-grade cash forecast** — scheduled-outflow overlay + payroll/debt safety alert + behavior-adjusted dates (BC-D3, BC-C3, BC-D2) | GATE 7 | Critical | **NEW FPB** (Cash Forecast & Liquidity) |
| 21 | **Fixed-asset tax lifecycle** — capex classifier + election presenter + disposition/recapture (TX-D1, TX-D3, TX-D4 / AP-C3) | GATE 8 | High | **NEW FPB** (FA tax lifecycle) |
| 22 | **Registration tracker + income/franchise nexus** (TX-A3, TX-A2) — unblocks the built tripwire | GATE 11d (prereq) | High | extend EC-7 FPB; A3 is NEEDS-CENTRAL |
| 23 | **Anomalous-JE enforce posture** — detect-only → block high-risk w/o support (PW2 upgrade) | GATE 9 | High | in exceptions FPB |
| 24 | **Credit scoring + limit mgmt + credit-hold** (AR-C18, AR-C19) | GATE 8/11 | High | **NEW FPB** (Credit Management) |
| 25 | **Prior-period adjustment / controlled-reopen workflow + alarm** (GL-I2) | GATE 8 | High | **NEW FPB** (Period Governance) |

**Top 10, one line each (for the impatient):** 1) autonomy control plane 2) close the identity gate
3) dup-payment block + BEC 4) consolidation depth (11a) 5) book-to-tax M-1 tagging 6) flux narrative
7) close orchestration 8) AR tie-out + cash-app disposition 9) finish the reconciliation moat 10) PO model
+ 3-way match.

---

## §5. Biggest gaps by segment

- **FP&A (0/37 built — the deepest hole):** the entire planning discipline is absent. No driver model, no
  scenarios, no rolling forecast, no three-statement, no version-of-record, no covenant engine, no board
  pack, no headcount/comp plan, no flux narrative. The catalog's "FP&A" was covenant+cash+flux; the
  *planning* half is greenfield. **Biggest single gap:** FP-A1/A3/A5 + FP-B1 (draft-off-actuals +
  drivers + versions + rolling forecast) — the owned-ledger moat's purest expression.

- **Tax & Compliance (6/39):** book-to-tax (TX-C1) — "the single richest AI opportunity" — has no ledger
  dimension; the whole provision/deferred-tax stack (C2–C5) rides on it; the SALT collection engine
  (A4–A7) is unbuilt and provider-gated. **Biggest gap:** TX-C1/C2 book-to-tax tagging, then TX-F3
  assurance/PBC pack.

- **GL / Consolidation:** the transactional close is strong, but **consolidation depth (GL-H2)** — the
  canon's MANDATORY top-priority GATE 11a — is only a 100%-flat roll-up: no ownership%/NCI, no
  invest-in-sub elimination, no arbitrary groupings, no booked elimination ledger, no CTA. Highest
  mismatch between roadmap urgency and build depth. Also missing: flux narrative, working-paper/evidence
  packaging, close-analytics/autonomy-rate loop.

- **AR:** money spine is built, but the **collections automation moat** (dunning ladder, AI outreach,
  promise-to-pay, credit-hold) and the **cash-application disposition + subledger tie-out** are missing —
  i.e. the DSO lever and the certify-AR floor.

- **AP:** the **PO model (AP-D1)** is the keystone NEEDS-CENTRAL gap — it blocks all 3-way matching,
  encumbrance, and RNI auto-draft, and completes cost→job attribution. Plus **BEC/vendor-bank-change**
  (zero coverage on the #1 AP fraud vector) and line-level AI coding on bills.

- **Bank & Cash:** best-covered segment, but the **reconciliation controller mechanics** (per-line
  check-off/finalize/lock), a **decision-grade forecast** (scheduled outflows + behavior), and the
  **treasury fraud/optimization controls** (BEC, positive-pay, sweep, IC pooling) are the residual.

- **Cross-cutting:** the whole detect-only control library is **logging, not governing** — PW4 (wire
  `scoreToTier` into real disposition + kill-switch + materiality) is the smallest change with the largest
  trust payoff and the precondition every operator brief makes non-negotiable before they will *sign*.

- **Under-discovered even after the deep-dives** (per COVERAGE-MATRIX): Job Costing (no cost-to-complete /
  WIP over-under-billing AI), Fixed Assets as a segment, and Customer master (credit/risk/behavior) remain
  thin; the practice plane (firm-partner G1–G4) is fully designed, nothing built (blocked on GATE 10/11a).

---

---

## §6. ⭐NEW capabilities folded in from the modality sweep (Session 42 — makes this the true superset)

Surfaced by forcing all 14 AI modalities against all 24 segments (`AI-CAPABILITY-MATRIX.md`, merging the three
`ai-modality/*.md` panels + `INTEGRATION-MAP.md`). These have **no home in §1–§2 above**. Per the dedup rule,
the four cross-cutting modalities (M7 narrative, M8 NL, M9 agentic, M13 search) + M14 learning collapse to
**one platform-wide row each** (they recur in ~15 segments; counting them once is the honest distinct count).
**98 distinct: 5 platform-wide + 33 R2R + 31 P2P/O2C + 29 FP&A/Tax/Payroll/Practice.** IDs prefixed `NEW-`.
All build-state **spec/none/partial** (nothing here is built). HITL/Tier/Effort per the matrix §3.

### §6.0 Platform-wide (collapse the whole-column blind spots)
| ID | Capability | Modality | Build |
|---|---|---|---|
| NEW-PW1 | Knowledge & Retrieval spine — semantic search over ledger/reports/contracts/vendors/customers/collections-history/assets/jobs + GAAP/policy Q&A | M13 | none |
| NEW-PW2 | Universal NL command surface — transactional + analytical NL across every segment (→ `FPB-nl-copilot` intents) | M8 | partial |
| NEW-PW3 | Per-object narrative / "explain-this-X" UX over the built decision-log infra | M7 | none |
| NEW-PW4 | Named agentic orchestration loops — AP · vendor-onboarding · morning-cash · O2C · pay-run · expense · procure-to-pay · close-run · conversion · provision · per-client close-to-deliver | M9 | partial |
| NEW-PW5 | Platform-wide learning/personalization memory (beyond the one built vendor-pattern loop) | M14 | partial |

### §6.1 Record-to-Report (33)
- **Rev-Rec (7):** NEW-RR1 ASC 606 contract IDP→POB/price/SSP · NEW-RR2 AI POB price allocation · NEW-RR3 billed↔recognized↔deferred waterfall tie-out · NEW-RR4 deferred-rev roll-off forecast · NEW-RR5 ASC 606/SSP memo drafting · NEW-RR6 best-fit method recommendation · NEW-RR7 milestone-due monitor.
- **Fixed Assets (6):** NEW-FA1 capex-invoice→asset IDP · NEW-FA2 asset-class/useful-life/MACRS assignment · NEW-FA3 FA subledger→GL + physical tie-out · NEW-FA4 ghost/missed-run/neg-NBV anomaly · NEW-FA5 depreciation forecast + capex bridge · NEW-FA6 missed-run/fully-depreciated/expiry alert.
- **Reporting intelligence (7):** NEW-RP1 external/prior-auditor financials IDP · NEW-RP2 COA→statement-line mapping · NEW-RP3 cross-report/report→GL tie-out · NEW-RP4 statement-integrity checks · NEW-RP5 footnote/MD&A/disclosure drafting · NEW-RP6 insight surfacing/which-KPI · NEW-RP7 report-freshness/KPI-breach alert.
- **Close intelligence (4):** NEW-CL1 close-binder doc OCR · NEW-CL2 days-to-close-ready ETA · NEW-CL3 close-path/critical-path optimization · NEW-CL4 close-deadline/phase-slip alert.
- **Reconciliation depth (4):** NEW-RC1 statement-PDF OCR + ending-balance anchor · NEW-RC2 plug/stale-item detector (canon §1.5 #12) · NEW-RC3 predicted clearing dates · NEW-RC4 reconciliation-memo drafting.
- **GL & Consolidation (5):** NEW-GL1 duplicate-JE/reversing-pair matching · NEW-GL2 stuck/unposted-batch monitor · NEW-GL3 invest-in-sub↔equity match · NEW-GL4 elimination-completeness detector · NEW-GL5 pre-consolidation-readiness monitor.

### §6.2 Procure-to-Pay / Order-to-Cash (31)
- **Procurement front-half (7):** NEW-PO1 PO/goods-receipt OCR · NEW-PO2 PO-line commodity/cost-code coding · NEW-PO3 maverick/split-PO detect · NEW-PO4 commitment/encumbrance forecast · NEW-PO5 PO/RFQ draft generation · NEW-PO6 sourcing/contract-price-compliance optimization · NEW-PO7 encumbrance-vs-budget/receiving-overdue alert.
- **Customer Management (6):** NEW-CU1 onboarding doc extraction (credit app/resale cert) · NEW-CU2 classification/segmentation · NEW-CU3 duplicate-customer detect & merge (vendor-dedupe mirror) · NEW-CU4 credit-abuse/fraud detect · NEW-CU5 customer comms drafting · NEW-CU6 credit re-review + master-staleness monitor.
- **Money Movement (6):** NEW-MM1 payment-rail classification · NEW-MM2 payment-run fraud screen at release · NEW-MM3 settlement-date prediction · NEW-MM4 remittance-advice + payment-confirmation generation · NEW-MM5 rail optimization · NEW-MM6 payment-status/failed-payment monitoring.
- **Expense & Card (5):** NEW-EX1 expense-policy/out-of-policy detect · NEW-EX2 expense accrual/spend forecast · NEW-EX3 expense-report/reimbursement drafting · NEW-EX4 missing-receipt chase + card-program optimization · NEW-EX5 uncoded-card/policy-breach aging alert.
- **Vendor Management (3):** NEW-VN1 vendor-reliability/delivery-risk score · NEW-VN2 vendor-consolidation/preferred-vendor recommendation · NEW-VN3 continuous OFAC/watchlist re-screen.
- **AR/Collections points (4):** NEW-AR1 pre-send billing-error detection · NEW-AR2 email/PDF remittance-advice parsing · NEW-AR3 invoice send-time/channel optimization · NEW-AR4 early-pay-discount offer optimization.

### §6.3 FP&A / Tax / Payroll / Practice (29)
- **Payroll (6):** NEW-PR1 run anomaly review · NEW-PR2 labor→job/dept/class attribution · NEW-PR3 auto-reconcile provider bank debit · NEW-PR4 employer-tax/PTO-liability run-rate forecast · NEW-PR5 pay-register/branded pay-stub drafting · NEW-PR6 payroll monitoring alerts.
- **Job Costing/WIP (6):** NEW-JC1 cost-to-complete/EAC forecast · NEW-JC2 WIP over/under-billing schedule + true-up · NEW-JC3 margin-fade/cost-overrun detect · NEW-JC4 change-order-leakage detect · NEW-JC5 AIA/SOV progress-bill (G702/703) draft · NEW-JC6 job-cost monitoring alerts.
- **Onboarding/Conversion (5):** NEW-ON1 bulk AI categorization of historical txns → standard COA · NEW-ON2 opening-TB tie-out gate · NEW-ON3 COA remap from prior system · NEW-ON4 conversion-quality anomaly detect · NEW-ON5 cleanup-effort/onboarding-load estimate.
- **Practice/Multi-client (5):** NEW-PC1 cross-client exception sweep · NEW-PC2 portfolio close-slippage + capacity/peak-load prediction · NEW-PC3 staff↔client assignment optimization + key-person backup · NEW-PC4 realization/scope-creep drift detect + re-price evidence · NEW-PC5 engagement-letter/deliverable-pack drafting.
- **Team Performance (5):** NEW-TP1 AI performance summaries (ledger-grounded) · NEW-TP2 fairness/anti-gaming sentinel · NEW-TP3 coaching-pattern detect · NEW-TP4 capacity-vs-load/time-to-clear prediction · NEW-TP5 instrumentation-health meta-metric.
- **Forecasting framings (2):** NEW-FC1 covenant-breach-date projection (dated + continuous monitor) · NEW-FC2 cross-lens tie-out (13-wk direct ↔ monthly indirect).

*(Governance note carried from the integration map: 7 route handlers — `receipts/categorize`,
`bank-feed/categorize`, `journal-entries/compose`, `categorize`, `bills/parse`, `bills/intake`,
`posting/predict` — read `ANTHROPIC_API_KEY` directly and bypass `@meritbooks/core-ai`; un-metered/un-budgeted
AI, a canon §2 violation to fix before trusting per-tenant AI cost. See `AI-CAPABILITY-MATRIX.md` §5.)*

---

*Analysis only. Supersedes v1 for planning; v1 retained as the first-pass record. Now the true superset with
§6 folded in. No build authorization — every capability above must clear its Rule-13 FPB and its `Prereq:`
gate first.*
