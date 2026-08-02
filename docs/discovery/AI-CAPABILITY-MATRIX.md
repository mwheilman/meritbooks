# AI-Capability MATRIX — the master, provable segment × modality map (Books, Module 1 of 12)

**Author:** Discovery lead (read-only synthesis). **Date:** 2026-08-02 (Session 42 canon).
**Status:** Analysis / spec only. **No capability below is a build authorization.** Every capability must
clear its Rule-13 FPB (16 dimensions + a QBO/Sage/best-in-class benchmark) and land behind its `Prereq:`
gate before a line of code is written.

**What this is.** The single master that merges the AI-engineer's three modality-sweep panels
(`ai-modality/record-to-report.md`, `ai-modality/p2p-o2c.md`, `ai-modality/fpna-tax-payroll-practice.md`),
the external-systems layer (`INTEGRATION-MAP.md`), and the deduped capability superset
(`AI-CAPABILITY-CATALOG-v2.md`) into **one screen**. It exists because a segment-first catalog misses
capabilities that only appear when you force **every AI modality against every segment** — the same class
of miss that let a pervasive NL-FP&A surface go undiscovered on the first pass. This matrix makes every
blank cell a *visible, provable gap*.

**Canon posture inherited by every cell (never restated):** *AI proposes a **fact** or a **draft** → the
deterministic engine does any accounting (debits=credits, direction from account TYPE, role-not-number) → a
human with the right `core` role approves anything that moves money / changes the book / touches a client →
every AI action + human decision writes `core.action_log` / `ai_decisions` (actor = specific human OR
AI+version).* Auto-post is OFF by default; autonomy is a per-tenant/per-task dial; SoD binds the AI itself;
on ambiguity fail closed and ask. Money is bigint cents. **AI routes only through `@meritbooks/core-ai`
(metered, tenant-budget capped) — see the governance callout in §5, which is currently violated by 7 routes.**

---

## §0. The 14-modality legend (columns)

| M | Modality | | M | Modality |
|---|---|---|---|---|
| **M1** | Doc-extraction / OCR / IDP | | **M8** | Conversational NL interface |
| **M2** | Classification & coding | | **M9** | Agentic multi-step orchestration |
| **M3** | Entity matching & reconciliation | | **M10** | Autonomy governance & HITL |
| **M4** | Anomaly / fraud / control detection | | **M11** | Recommendation & optimization |
| **M5** | Forecasting & prediction | | **M12** | Monitoring & proactive alerting |
| **M6** | Content generation & drafting | | **M13** | Search / retrieval / knowledge |
| **M7** | Narrative & explanation | | **M14** | Learning & personalization |

**Build-state marks:** **●** built (live/functional, incl. shipped detect-only) · **◐** partial (substrate
exists, material gap) · **○** spec (designed / in an FPB / catalog, no code) · **·** none (gap; no code and
no catalog home — mostly ⭐NEW) · **—** n/a (modality not meaningful for that segment).

**Segments (rows), 24 across three clusters:**
*Record-to-Report* — S1 GL/JE · S2 Close · S3 Recon · S4 Reporting · S5 Rev-Rec · S6 Fixed Assets · S7 Consol/IC.
*Procure-to-Pay / Order-to-Cash* — P1 AP/Bills · P2 Vendor Mgmt · P3 Bank/Cash · P4 AR/Invoices · P5 Collections/Cash-App · P6 Customer Mgmt · P7 Money Movement · P8 Expense & Card · P9 Procurement/PO/3-way.
*FP&A / Tax / Payroll / Practice* — F1 Budgeting/FP&A · F2 Forecasting · F3 Tax & Compliance · F4 Payroll · F5 Practice/Multi-client · F6 Job Costing/WIP · F7 Team Performance · F8 Onboarding/Conversion.

---

## §1. THE MASTER MATRIX (24 segments × 14 modalities)

Reconciled cell-by-cell against the three panels + a live repo read. Blank-looking columns (·/○) are the
provable gaps.

| Segment | M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 | M9 | M10 | M11 | M12 | M13 | M14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **S1 GL / JE** | ○ | ● | ◐ | ● | ● | ● | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ○ | ◐ |
| **S2 Close** | ○ | ● | ◐ | ● | ○ | ◐ | ○ | ○ | ◐ | ◐ | ○ | ○ | ○ | ○ |
| **S3 Reconciliation** | ◐ | ● | ● | ○ | ○ | ◐ | ○ | ○ | ◐ | ◐ | ◐ | ◐ | ○ | ● |
| **S4 Reporting** | ○ | ◐ | ○ | ○ | ◐ | ○ | · | · | · | ◐ | ○ | ○ | ○ | ○ |
| **S5 Revenue Rec** | ○ | ◐ | ○ | ● | ○ | ○ | ○ | ○ | ◐ | ◐ | ○ | ◐ | ○ | ○ |
| **S6 Fixed Assets** | ○ | ◐ | ○ | ○ | ○ | ◐ | ○ | ○ | ◐ | ◐ | ◐ | ○ | ○ | ○ |
| **S7 Consol / IC** | ○ | ◐ | ◐ | ● | · | ◐ | ○ | ○ | ◐ | ◐ | ◐ | ◐ | ○ | ○ |
| **P1 AP / Bills** | ◐ | ◐ | ◐ | ● | ○ | · | · | · | · | ◐ | ○ | ○ | · | ● |
| **P2 Vendor Mgmt** | ◐ | ◐ | ● | ○ | · | ● | ◐ | · | · | ● | · | ◐ | · | · |
| **P3 Bank / Cash** | ○ | ● | ● | ◐ | ◐ | ◐ | ○ | · | · | ◐ | ○ | ◐ | · | ● |
| **P4 AR / Invoices** | ○ | ◐ | ◐ | · | ◐ | ● | · | · | · | ◐ | · | ◐ | · | · |
| **P5 Collections / Cash-App** | · | ○ | ● | ◐ | ◐ | ○ | · | ◐ | ○ | ◐ | ◐ | ○ | · | ◐ |
| **P6 Customer Mgmt** | · | · | · | · | ◐ | · | · | · | · | ◐ | ◐ | · | · | · |
| **P7 Money Movement** | — | ◐ | ◐ | ◐ | ◐ | · | · | · | ◐ | ● | · | · | · | · |
| **P8 Expense & Card** | ◐ | ◐ | ◐ | · | · | · | · | · | · | ◐ | · | ◐ | · | · |
| **P9 Procurement / PO** | · | · | ○ | · | · | · | · | · | · | ◐ | · | · | · | · |
| **F1 Budgeting / FP&A** | · | · | · | · | ◐ | · | · | · | · | · | · | · | · | · |
| **F2 Forecasting** | — | · | · | ◐ | ◐ | · | · | · | · | · | · | · | · | · |
| **F3 Tax & Compliance** | ◐ | · | ◐ | ● | · | · | · | · | ◐ | ◐ | ◐ | ● | · | ◐ |
| **F4 Payroll** | · | ○ | ○ | ○ | ◐ | · | · | · | ◐ | ◐ | · | · | · | ◐ |
| **F5 Practice / Multi-client** | · | · | ◐ | ◐ | · | · | · | · | · | · | · | · | · | · |
| **F6 Job Costing / WIP** | ◐ | ◐ | ◐ | · | · | ◐ | · | · | ◐ | ◐ | · | · | · | · |
| **F7 Team Performance** | — | ◐ | ◐ | ○ | ○ | ○ | ○ | · | — | ○ | ○ | ○ | ◐ | ◐ |
| **F8 Onboarding / Conversion** | ◐ | · | ◐ | · | · | · | · | · | ◐ | ◐ | · | · | · | · |

**How to read the density:** the transactional core is dense with **●/◐** on the left (M1–M4 extraction /
classify / match / anomaly) — that is where MeritBooks is real. The right half (M7 narrate, M8 NL, M9 agentic,
M11 optimize, M13 search, M14 learn) is a wall of **○/·** for all but a handful of segments — that is the
provable frontier. The bottom third (F1 FP&A, F2 Forecasting, P6 Customer, P9 Procurement) is almost entirely
**·/○** — the greenfield planning/master-data/procurement gaps the owner and COVERAGE-MATRIX already flagged.

---

## §2. WHOLE-COLUMN BLIND SPOTS (the systemic misses)

Reading the matrix **down each column** (not across rows) surfaces modalities that are near-empty
*platform-wide* — the misses no single segment owns, so no single FPB catches them:

- **M13 — Search / retrieval / knowledge · THE largest structural gap.** **0 built across all 24 segments**
  (one lone partial: Team-Performance drill-through to `action_log`). MeritBooks OWNS the ledger yet cannot be
  *queried as knowledge*: no semantic JE/GL search, no close-binder retrieval, no source-doc pull for a bank
  line, no contract-terms/ASC-606 retrieval, no vendor-360 / customer-360, no collections-interaction history
  ("what was already tried" — an explicit AR leak), no catalog/contract-price lookup, no accounting-policy /
  GAAP Q&A. Retrieval-as-a-modality is essentially absent from catalog v2 entirely. **Name it: build a
  platform-wide Knowledge & Retrieval spine.**
- **M8 — Conversational NL beyond the composer.** The **only** non-empty cells are the built NL JE composer
  (S1) and a collections worklist (P5); everything else is **·/○**. There is no NL front door for reports,
  cash, AP, AR, vendors, customers, payments, budgets, tax, payroll, jobs, or the practice book. This is the
  *exact* pervasive-NL miss the whole modality exercise was chartered to prevent — now proven to recur on the
  transactional and analytical surfaces, not just JE + reports. **It consolidates into one surface:
  `FPB-nl-copilot` (one router, many intents) — do not build parallel NL boxes.**
- **M7 — Narrative & explanation. 0 built platform-wide.** No "explain-this-JE," no flux/variance board
  narrative (still NONE), no reconciling-items story, no vendor-compliance-status readout, no invoice rev-rec
  rationale, no collections account-summary, no customer-360, no payment cash-impact, no consol-vs-sum bridge,
  no forecast narrative, no labor-cost / job-cost / scorecard story. Decision-log *infrastructure* exists
  (PW6); object-level "explain this" UX does not. The FP&A flux narrative (FP-D2) is the marquee instance.
- **M14 — Learning & personalization. Essentially one primitive, cloned.** The only built cells (S3, P1, P3
  match/vendor-pattern learning) are all the *same* vendor-descriptor→coding memory loop. Every other
  personalization surface — tenant close-cadence, report/KPI/tone prefs, method-per-rev-type + SSP library,
  asset-class defaults, per-customer/vendor/employee memory, per-firm playbook memory, driver/seasonal-curve
  memory — is **○/·**. Personalization is a platform capability treated as a single AP feature.

*(Runner-up thin columns: **M1 extraction** has 0 fully-built cells — only partials [AP intake, receipts,
import alias-map] — so document intelligence is active but nothing is production-hardened, and it is
**GATE-4-blocked on Azure creds**; **M11 optimization** and **M9 agentic loops** are almost entirely ○/·
outside a few partial autopilots.)*

---

## §3. THE CONSOLIDATED ⭐NEW ROSTER (surfaced this pass, not in catalog v2)

Every capability the three panels surfaced that has **no home in catalog v2**, deduped across the three
clusters. Per the brief, the four cross-cutting modalities (**M7 narrative, M8 NL, M9 agentic, M13 search**)
plus **M14 learning** collapse to **one platform-wide row each** instead of being counted 15× — those five
rows are the systemic misses of §2. **Total distinct net-new = 98** (5 platform-wide + 33 R2R + 31 P2P/O2C +
29 FP&A/Tax/Payroll/Practice).

**HITL key:** `p→a` propose→approve · `detect` detect→triage · `read` read-only · `gate` hard-gate ·
`release` human-release (money) · `role` elevated-role. **Effort:** S small (mirror/extend existing) · M
medium (new service on existing substrate) · L large (new model/table/orchestration).

### 3a. Platform-wide cross-cutting (5 rows — the §2 blind spots as build targets)

| # | Capability (collapses N per-segment cells) | Modality | HITL | Tier | Effort |
|---|---|---|---|---|---|
| PN-1 | **Knowledge & Retrieval spine** — semantic search over ledger/reports/contracts/vendors/customers/collections-history/assets/jobs + GAAP/tenant-policy Q&A, grounded + cited | M13 | read | **Critical** | L |
| PN-2 | **Universal NL command surface** — transactional + analytical NL across every segment (→ `FPB-nl-copilot` intents; one router/allowlist/citation spine) | M8 | p→a / read | **Critical** | L |
| PN-3 | **Per-object narrative / "explain-this-X"** — object-level explanation UX over the built decision-log infra (JE, bill, invoice, rec item, payment, consol, scorecard, forecast) | M7 | read | High | M |
| PN-4 | **Named agentic orchestration loops** — AP · vendor-onboarding · morning-cash · order-to-cash · pay-run · expense · procure-to-pay · close-run · conversion-playbook · provision-run · per-client close-to-deliver (each a supervised loop over built pieces) | M9 | p→a / release | **Critical** | L |
| PN-5 | **Platform-wide learning/personalization memory** — tenant close-cadence, report/KPI/tone prefs, method+SSP library, asset defaults, per-entity + per-firm-playbook memory (beyond the one built vendor-pattern loop) | M14 | read | High | M |

### 3b. Record-to-Report ⭐NEW (33 distinct)

| Theme | Capabilities (modality) | HITL | Tier | Effort |
|---|---|---|---|---|
| **Revenue Recognition (7)** | ASC 606 contract IDP → POB/price/SSP facts (M1); AI POB price allocation (M2); billed↔recognized↔deferred waterfall tie-out (M3); deferred-rev roll-off forecast (M5); ASC 606 / SSP memo drafting (M6); best-fit method recommendation (M11); milestone-due monitor (M12) | p→a / detect | **Critical** | M–L |
| **Fixed Assets (6)** | capex-invoice → asset IDP (M1); asset-class / useful-life / MACRS assignment (M2); FA subledger→GL + physical tie-out (M3); ghost-asset / missed-run / neg-NBV anomaly (M4); depreciation forecast + capex bridge (M5); missed-run / fully-depreciated / warranty-lease-expiry alert (M12) | p→a / detect | High | M |
| **Reporting intelligence (7)** | external / prior-auditor financials IDP (M1); COA→statement-line mapping (M2); cross-report / report→GL tie-out (M3); statement-integrity checks (M4); footnote / MD&A / disclosure drafting (M6); insight surfacing / which-KPI-to-review (M11); report-freshness / KPI-breach alert (M12) | p→a / detect | High | M |
| **Close intelligence (4)** | close-binder doc OCR (M1); days-to-close-ready ETA (M5); close-path / critical-path optimization (M11); close-deadline / phase-slip alert (M12) | p→a / read / detect | High | M |
| **Reconciliation depth (4)** | statement-PDF OCR + ending-balance anchor (M1); plug / stale-item detector (canon §1.5 #12) (M4); predicted clearing dates (M5); in-rec reconciliation-memo drafting (M6) | p→a / detect | High | S–M |
| **GL & Consolidation (5)** | duplicate-JE / reversing-pair matching (M3); stuck / unposted-batch monitor (M12); investment-in-sub ↔ subsidiary-equity match (M3); elimination-completeness detector (M4); pre-consolidation-readiness monitor (M12) | detect / p→a | High | S–M |

### 3c. Procure-to-Pay / Order-to-Cash ⭐NEW (31 distinct)

| Theme | Capabilities (modality) | HITL | Tier | Effort |
|---|---|---|---|---|
| **Procurement front-half (7)** | PO / goods-receipt OCR (M1); PO-line commodity / cost-code coding (M2); maverick / split-PO threshold-dodge detect (M4); commitment / encumbrance forecast (M5); PO / RFQ draft generation (M6); sourcing / contract-price-compliance optimization (M11); encumbrance-vs-budget / receiving-overdue alert (M12) | p→a / detect | **Critical** | L |
| **Customer Management (6)** | onboarding doc extraction — credit app / resale cert (M1); classification / segmentation (M2); **duplicate-customer detect & merge** (mirror of built vendor dedupe) (M3); credit-abuse / fraud detect (M4); customer-facing comms drafting (M6); credit re-review + master-staleness monitor (M12) | p→a / detect | High | S–M |
| **Money Movement (6)** | payment-rail classification (M2); **payment-run fraud screen at release** — new-payee / positive-pay / ACH-filter (M4); settlement-date prediction (M5); remittance-advice + payment-confirmation generation (M6); rail optimization — cheapest/fastest, virtual-card rebate (M11); payment-status / failed-payment monitoring (M12) | p→a / release / detect | **Critical** | M |
| **Expense & Card (5)** | expense-policy / out-of-policy detect (M4); expense accrual / spend forecast (M5); expense-report / reimbursement drafting (M6); missing-receipt chase + card-program optimization (M11); uncoded-card / missing-receipt / policy-breach aging alert (M12) | p→a / detect | High | M |
| **Vendor Management (3)** | vendor-reliability / delivery-risk score (M5); vendor-consolidation / preferred-vendor recommendation (M11); continuous OFAC / watchlist re-screen (M12) | read / detect | Med | S–M |
| **AR / Collections points (4)** | pre-send billing-error detection (wrong price/qty/tax → silent dispute) (M4); email / PDF remittance-advice parsing for cash-app (M1); invoice send-time / channel optimization (M11); early-pay-discount offer optimization (M11) | p→a / detect | High | S–M |

### 3d. FP&A / Tax / Payroll / Practice ⭐NEW (29 distinct)

| Theme | Capabilities (modality) | HITL | Tier | Effort |
|---|---|---|---|---|
| **Payroll (6)** | run anomaly review — N×-paycheck / terminated-still-paid / missing-hours (M4); labor → job/dept/class attribution at pay line (M2); auto-reconcile provider bank debit → posted run (M3); employer-tax + PTO-liability run-rate forecast (M5); pay-register / branded pay-stub drafting (M6); payroll monitoring alerts — funding-shortfall / terminated-still-paid (M12) | detect / p→a | High | M |
| **Job Costing / WIP (6)** | cost-to-complete / EAC forecast + %-complete true-up (M5); WIP over/under-billing schedule + true-up (M3); margin-fade / cost-overrun detect (M4); change-order-leakage detect (M4); AIA / SOV progress-bill (G702/G703) draft (M6); job-cost monitoring alerts — budget-crossing / unbilled-cost aging (M12) | p→a / detect | High | M |
| **Onboarding / Conversion (5)** | bulk AI categorization of historical transactions → standard COA (M2); opening-TB tie-out gate — debits=credits, subledger→control (M3); COA remap from prior system (M2); conversion-quality anomaly detect — gaps/dups/orphans (M4); cleanup-effort / onboarding-load estimate (M5) | p→a / gate / detect | High | M |
| **Practice / Multi-client (5)** | cross-client exception sweep — portfolio-wide anomalies in one pane (M4); portfolio close-slippage + capacity/peak-load prediction (M5); staff↔client assignment optimization + key-person-risk backup (M11); realization / scope-creep drift detect + re-price evidence pack (M4); engagement-letter / deliverable-pack drafting (M6) | detect / p→a | High | L (post-11a) |
| **Team Performance (5)** | AI performance summaries — ledger-grounded, no invented numbers (M6); fairness / anti-gaming sentinel (M4); coaching-pattern detect — recurring-error training signal (M11); capacity-vs-load / time-to-clear prediction (M5); instrumentation-health meta-metric (M3) | read / detect | Med–High | S–M |
| **Forecasting framings (2)** | covenant-breach-date projection (dated + continuous monitor) (M5); cross-lens tie-out — 13-wk direct ↔ monthly indirect (M3) | detect / read | High | S |

---

## §4. RE-RANKED BUILD-NEXT — TOP 30 (whole platform: catalog v2 + ⭐NEW)

Ranked by composite × trust-to-sign × owned-ledger leverage, respecting that **no gate starts until its
`Prereq:` gates are DONE** and that the open identity/RBAC NO-GO gate (#9) underwrites every
approval/attribution story. **FPB column splits `EXTENDS` an existing FPB vs `NEW FPB` required.**

| # | Capability (refs) | Home gate | Tier | FPB status |
|---|---|---|---|---|
| 1 | **Supervision & Autonomy Control Plane** — wire `scoreToTier`→disposition + per-task dial + materiality + kill-switch + pre-post interceptor (PW4, PW8, GL-I3) | GATE 5 (+9) | Crit | **NEW FPB** (Supervision & Autonomy) |
| 2 | **Close the identity / RBAC NO-GO gate** — multi-tenant org resolution, control-route RBAC, SoD org-scoping (PW3; #9/#33) | GATE 10/9 | Crit | EXTENDS `FPB-identity-multitenancy` |
| 3 | **Dup-payment blocking gate + BEC vendor-bank-change** (AP-D5, AP-A5, AP-B4 / BC-E2) | GATE 8/9 | Crit | EXTENDS `FPB-financial-control-exceptions` (EC-1) + **NEW** vendor-banking-fraud FPB |
| 4 | **Consolidation depth** — ownership%/NCI/invest-in-sub/groupings/booked eliminations + IC auto-mirror + elim-completeness + pre-consol readiness (GL-H2/H1, S7 ⭐NEW) | **GATE 11a (MANDATORY)** | Crit | EXTENDS `FPB-tenant-model-consolidation-analytics` |
| 5 | **Book-to-tax M-1/M-3 tagging + temp/perm** (TX-C1, TX-C2) — "richest AI opportunity" | GATE 7/8 | Crit | **NEW FPB** (Book-to-Tax) |
| 6 | **Flux/variance auto-narrative + missing-explanation gate** (FP-D2, FP-D3, GL-E2, S4 M7) | GATE 7 | Crit | **NEW FPB** (Flux & Variance Narrative) |
| 7 | **Close orchestration** — dependency graph + ledger auto-verify + capacity + days-to-close ETA + phase-slip alert + uncategorized empty-before-close gate (GL-F2/F3/F4, GL-C4, S2 ⭐NEW) | GATE 8 | Crit | **NEW FPB** (Close Orchestration) |
| 8 | **AR subledger↔GL tie-out + cash-app disposition + unapplied-cash ledger** (AR-C35, AR-C22 completion, AR-C25) | GATE 8 | Crit | EXTENDS cash-application/`FPB-invoices` (add tie-out) |
| 9 | **Reconciliation moat completion** — per-line check-off/finalize/lock + close gate + statement-PDF OCR + plug/stale detector + rec memo (BC-B1/B3/B6/B7/B11, S3 ⭐NEW) | GATE 8 | High | EXTENDS `FPB-bank-reconciliation` (Waves B) |
| 10 | **PO model in Books + 3-way/2-way match + procurement front-half** (AP-D1 keystone, AP-D2/D3, P9 ⭐NEW) | GATE 11b | Crit | **NEW FPB** (AP PO / 3-way) — NEEDS-CENTRAL |
| 11 | **Automated dunning ladder + AI outreach + promise-to-pay + collections-interaction retrieval** (AR-C14/15/16, P5 M13) | GATE 9 | Crit | **NEW FPB** (Dunning / Collections Automation) |
| 12 | **Universal NL command surface** (transactional + analytical, PW5, PN-2) | GATE 7 | Crit | EXTENDS `FPB-nl-copilot` |
| 13 | **Covenant continuous monitor + breach-date projection + certificate + board pack** (FP-G2, FP-G1, F2 ⭐NEW) | GATE 7 | Crit | **NEW FPB** (Covenant & Liquidity) |
| 14 | **Budget triad** — version-of-record lock + AI draft off actuals + seasonality (FP-A5, FP-A1, FP-A2) | GATE 7 | Crit | **NEW FPB** (extends `FPB-financial-reports` D8) |
| 15 | **Decision-grade cash forecast** — scheduled-outflow overlay + payroll/debt safety alert + behavior-adjusted dates + rolling reforecast (BC-D3, BC-C3, BC-D2, FP-B1/B3) | GATE 7 | Crit | **NEW FPB** (Cash Forecast & Liquidity) |
| 16 | **Payment-run fraud screen at release + pay-run agent + remittance-advice generation** (P7 ⭐NEW, PN-4) | GATE 9 | Crit | EXTENDS `FPB-payments-fees` |
| 17 | **AP line-level auto-coding + cost→job attribution + source-doc vault + line extraction** (AP-C1/C2/A3/A1) | GATE 6/8 (prereq GATE 4) | Crit | **NEW FPB** (AP Intake & Coding) |
| 18 | **Knowledge & Retrieval spine** (M13, PN-1) — the largest structural gap; the trust "find-it-fast" multiplier | GATE 7 | High | **NEW FPB** (Knowledge & Retrieval) |
| 19 | **Revenue-Rec AI** — ASC 606 contract IDP → POB/price/SSP + waterfall tie-out + roll-off forecast + method rec (S5 ⭐NEW) | GATE 8 | High | **NEW FPB** (Rev-Rec AI) |
| 20 | **Customer master** — duplicate-customer detect/merge + credit scoring/limit/hold + customer-360 (P6 ⭐NEW, AR-C18/C19) | GATE 8/11 | High | **NEW FPB** (Customer Management) |
| 21 | **Working papers auto-gen + tie-out + PBC/evidence pack** (GL-G1, GL-G3, TX-F3) | GATE 8 | High | **NEW FPB** (Working Papers & Audit Evidence) |
| 22 | **Payroll AI (Phase A)** — run anomaly review + labor→job attribution + auto-reconcile provider debit (F4 ⭐NEW) | GATE 12.3 | High | EXTENDS `FPB-payroll` |
| 23 | **Fixed-asset AI lifecycle** — capex asset IDP + asset-class assignment + ghost/missed-run anomaly + FA→GL tie-out + §179/bonus election presenter (S6 ⭐NEW, TX-D1/D3/D4) | GATE 8 | High | **NEW FPB** (FA Lifecycle) |
| 24 | **Driver-based budgeting + scenarios + NL what-if** (FP-A3, FP-E1, FP-E3/PN-2) | GATE 7 | High | **NEW FPB** (extends the Budget triad FPB) |
| 25 | **Job Costing / WIP AI** — cost-to-complete/EAC + WIP over/under-billing + margin-fade / change-order-leakage detect (F6 ⭐NEW) | GATE 6 | High | **NEW FPB** (Job Costing / WIP) |
| 26 | **Reporting integrity** — COA→statement mapping + cross-report/report→GL tie-out + statement-integrity checks + footnote/MD&A drafting (S4 ⭐NEW) | GATE 7 | High | EXTENDS `FPB-financial-reports` |
| 27 | **Expense & Card** — policy/out-of-policy detect + receipt↔card↔bill 3-way + capture→reimburse agent (P8 ⭐NEW) | GATE 8 | High | **NEW FPB** (Expense & Card) |
| 28 | **Onboarding / conversion AI** — bulk categorization + opening-TB tie-out gate + COA remap + conversion playbook (F8 ⭐NEW) | GATE 11a (prereq) | High | **NEW FPB** (Historical Conversion) |
| 29 | **Registration tracker + income/franchise nexus + sales-tax rate/calc engine** (TX-A3/A2/A4) — honor the built nexus tripwire | GATE 11d (prereq) | High | EXTENDS EC-7 in `FPB-financial-control-exceptions` + **NEW** sales-tax-engine FPB |
| 30 | **Practice plane** — cross-client exception sweep + portfolio close board + agentic pre-review (F5 ⭐NEW, firm-partner B3/B4) | GATE 10/11a | High | **NEW FPB** (Practice / Multi-client) |

**Split summary:** **EXTENDS existing FPB (9):** #2 identity, #3 (partial) exceptions, #4 consolidation, #8
invoices, #9 bank-rec, #12 nl-copilot, #16 payments, #22 payroll, #26 financial-reports, #29 (partial)
exceptions. **NEEDS A NEW FPB (21+):** the rest — Supervision & Autonomy, Book-to-Tax, Flux Narrative, Close
Orchestration, PO/3-way, Dunning, Covenant & Liquidity, Budget triad, Cash Forecast, AP Intake & Coding,
Knowledge & Retrieval, Rev-Rec AI, Customer Management, Working Papers, FA Lifecycle, Driver Budgeting,
Job-Costing/WIP, Expense & Card, Historical Conversion, Sales-Tax Engine, Practice.

---

## §5. GOVERNANCE MUST-FIX — 7 route handlers bypass the Core AI gateway (canon violation)

**Finding F1 from `INTEGRATION-MAP.md`, re-verified against the live tree
(`grep ANTHROPIC_API_KEY apps/web/src`, Session 42).** Canon §2 / GATE 1 require **every** AI call in the
suite to route through `@meritbooks/core-ai` so it is entitlement-checked, runaway-guarded, metered to
`core.ai_usage_log`, and counted against the **combined-suite tenant budget**. The *services*
(`je-composer`, `exception-ai`, `categorization`) correctly transit the gateway — but **seven route handlers
read `ANTHROPIC_API_KEY` directly and call Anthropic un-metered and un-budgeted:**

1. `apps/web/src/app/api/receipts/categorize/route.ts`
2. `apps/web/src/app/api/bank-feed/categorize/route.ts`
3. `apps/web/src/app/api/journal-entries/compose/route.ts`
4. `apps/web/src/app/api/categorize/route.ts`
5. `apps/web/src/app/api/bills/parse/route.ts`
6. `apps/web/src/app/api/bills/intake/route.ts`
7. `apps/web/src/app/api/posting/predict/route.ts`

*(The 8th hit, `apps/web/src/app/api/ai/gateway/route.ts`, is the sanctioned gateway itself — not a
violation.)*

**Why it's a must-fix:** on a fintech book of record these are exactly the high-volume AI seams (OCR,
categorization, JE compose, posting prediction). Un-metered, they make per-tenant AI cost **untrustworthy and
uncapped** — a tenant can burn unbounded model spend with no budget enforcement, and the suite cannot bill or
throttle AI fairly. It is cheap to fix (route through the existing gateway; no new vendor) and is a
**prerequisite to trusting any per-tenant AI-cost or autonomy-dial claim** (BUILD-NEXT #1). Track as its own
slice; it blocks the Supervision & Autonomy control plane's cost story.

---

*Analysis / spec only. One master. No build authorized — every capability must clear its Rule-13 FPB and its
`Prereq:` gate first. Merges `ai-modality/{record-to-report,p2p-o2c,fpna-tax-payroll-practice}.md`,
`INTEGRATION-MAP.md`, and `AI-CAPABILITY-CATALOG-v2.md`; reconciled to `CANON-ANCHOR.md` §5 and a live repo
read (Session 42). The 98 ⭐NEW rows are folded into `AI-CAPABILITY-CATALOG-v2.md` so that catalog remains the
true superset; this matrix is the one-screen index over it.*
