# AI Modality × Segment Grid — FP&A · Tax · Payroll · Practice cluster

**Author:** AI engineer, MeritBooks discovery panel (PLANNING / COMPLIANCE / WORKFORCE / PRACTICE clusters).
**Date:** 2026-08-02 (Session 42 canon). **Posture:** analysis / spec only — **no build authorization.**
Every capability below inherits the canon posture verbatim (`docs/canon/CANON-ANCHOR.md` §3): *AI proposes
FACTS → the deterministic engine does the accounting → a human with the right Core role approves anything that
moves money / changes the book / touches a client relationship → every AI action writes `core.action_log` /
`ai_decisions`. Auto-post is OFF by default; autonomy is a per-tenant/per-task dial; SoD binds the AI itself;
on ambiguity, fail closed and ask.* All model calls route ONLY through `@meritbooks/core-ai` (metered,
tenant-budget capped across the combined suite). Money is bigint cents. Accounts by role, not number.

**Why this pass exists.** The catalog v2 (`docs/discovery/AI-CAPABILITY-CATALOG-v2.md`) folded six deep-dives —
but only **two of this cluster's eight segments** (Budgeting/FP&A and Tax) are represented there. **Payroll,
Practice/multi-client, Job-Costing/WIP, Team-Performance, and Onboarding/Conversion have NO segment section in
catalog v2** (they live only in FPBs or operator briefs, or nowhere). That is exactly the miss-surface this
exhaustive modality sweep is built to close. The first-pass proof-of-thinness was the **pervasive NL FP&A
surface** (now `docs/FPB-nl-copilot.md`); this doc aligns to that FPB rather than re-specifying the copilot,
and hunts the *rest* of the misses by construction — every segment × every one of the 14 modalities.

**Alignment with `FPB-nl-copilot.md`:** M8 (Conversational NL) and the NL/what-if halves of M5/M6/M7 across
ALL segments are **surfaces of the one Universal NL Command & FP&A Copilot** — a cross-cutting capability, not
per-segment reinventions. Where a cell below says "→ nl-copilot", it means *that segment contributes an intent
(a catalog entry / a per-surface embed) to the single copilot*, and must not build a parallel NL box. This doc
enumerates the **intents**; the copilot FPB owns the **surface, router, allowlist, and citation spine.**

**Legend.** HITL: `propose→approve` · `detect→triage` · `hard-gate` · `human-release` (money) · `elevated-role`
· `read-only` · `auto(dial)`. Build: **built** (live/functional incl. shipped detect-only) · **partial**
(substrate exists, gap named) · **spec** (in an FPB/catalog, no code) · **NONE** (gap; not anywhere).
**⭐NEW** = the capability is **not present in catalog v2** (its richest home is missing there). Catalog refs
(FP-/TX-/PW-/AP-/AR-/BC-/GL-) trace to v2; "FPB-x" traces to a written brief.

**Modalities (columns):** M1 Doc-extraction/OCR/IDP · M2 Classification & coding · M3 Matching &
reconciliation · M4 Anomaly/control detection · M5 Forecasting & prediction · M6 Content generation &
drafting · M7 Narrative & explanation · M8 Conversational NL interface · M9 Agentic multi-step orchestration ·
M10 Autonomy governance & human-in-loop · M11 Recommendation & optimization · M12 Monitoring & proactive
alerting · M13 Search & retrieval / knowledge · M14 Learning & personalization.

---

## 1. Budgeting & FP&A

Build ground truth: only a thin budget-entry grid, single-scenario BvA, and the 13-wk direct cash forecast
exist (`013_budgets.sql`, `/api/budgets`, `/api/budgets/vs-actual`, `lib/cash/forecast.ts`). **FP&A is 0/37
built** in catalog v2 — the deepest hole. Home gate GATE 7.

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | — no document-extraction surface in planning (budgets are keyed/derived, not scanned). Adjacent: ingest a board target-letter into assumptions | propose→approve | NONE | ⭐NEW (minor) |
| M2 | One-timer / non-recurring tagging when seeding a budget baseline off actuals; contractual step-up detection (rent/SaaS escalators) | propose→approve | NONE | FP-A1, FP-A7 |
| M3 | Reconcile bottom-up department submissions to the top-down target ("gap to target"); tie budget version to the GL baseline it was seeded from | propose→approve | NONE | FP-A6 |
| M4 | Approaching/over-budget run-rate detection; missing-variance-explanation close gate; reforecast-on-variance trigger (material+persistent) | detect→triage / hard-gate | NONE | FP-D3, FP-D4, FP-B3 |
| M5 | **The planning engine:** AI budget draft off actuals, seasonality spread, driver-based model, rolling reforecast, three-statement (P&L→BS→CF), headcount/comp plan, capex→depr bridge | propose→approve | partial (13-wk only) | FP-A1/A2/A3, FP-B1/B4, FP-C1/C3 |
| M6 | Budget draft grid from actuals; **board / management package auto-generation**; lender/investor data-tape; ZBB justification scaffold | propose→approve | NONE | FP-A1, FP-G1/G4, FP-A4 |
| M7 | **AI flux / variance narrative** (the FP&A moat) — auto-draft the "why", citing the driving JEs/vendors; board commentary | propose→approve | NONE | FP-D2 |
| M8 | NL "ask any budget/forecast view" + **NL what-if / scenario** ("hire 5 reps, +4% price") → named drivers on a deterministic model | propose→approve | NONE (decorative box) | FP-E3/K1 → **FPB-nl-copilot** (A5/A6) |
| M9 | Budget-cycle orchestration: seed → collect dept submissions → reconcile gap → assemble → route ratification → lock plan-of-record → seasonalize | propose→approve / elevated-role | NONE | FP-A5, FP-F1/F2 |
| M10 | Budget version management + plan-of-record lock; SoD-bound ratification workflow; forecast-autonomy dial (auto-refresh within tolerance vs stop-ask) | elevated-role | NONE | FP-A5, FP-F2, FP-K4 → PW4 |
| M11 | Scenario optimization / goal-seek ("what levers hit 22% EBITDA?"); sensitivity/tornado on EBITDA/cash drivers; spend-reallocation proposal | propose→approve / read-only | NONE | FP-E2/E4 |
| M12 | Real-time budget-overrun alert; covenant-headroom drift alert; budget-owner deadline chase | detect→triage / propose→approve | NONE | FP-D4, FP-G2, FP-F4 → PW7 |
| M13 | Prior-period / prior-version lookup ("how did we budget travel last year"); assumption-library retrieval | read-only | NONE | FP-A7, FP-F3 |
| M14 | **Per-tenant driver memory** — learned seasonal curves, driver rates, forecast-bias backtest feeding auto-tune + the autonomy dial | read-only | NONE | FP-B2, FP-K2 |

---

## 2. Forecasting (cash + P&L + covenant)

Treated as its own plane because catalog v2 scatters it across FP&A (FP-B*), Bank/Cash (BC-D*), and covenant
(FP-G2). Build: the **13-week direct cash forecast is built** (`lib/cash/forecast.ts`, pure/deterministic,
AR/AP-due-date + bank-balance driven). Everything decision-grade beyond it is NONE.

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | — forecasting reads structured ledger, not documents | — | — | — |
| M2 | Classify inflows/outflows by predictability (contractual vs discretionary vs one-time) to weight the forecast | read-only | NONE | ⭐NEW |
| M3 | Reconcile the 13-wk direct forecast to the monthly indirect cash budget (short lens ↔ long lens tie-out) | read-only | NONE | FP-B7 |
| M4 | Cash-runway / minimum-liquidity breach detection; forecast-vs-actual drift (the machine is off) | detect→triage / hard-gate | partial | BC-C3, FP-K2 |
| M5 | **Prediction core:** behavior-adjusted collection dates, scheduled-outflow overlay (payroll/debt/tax), P&L rolling reforecast, **covenant-breach-date projection** | propose→approve / elevated-role | partial (13-wk direct only) | BC-D2/D3, FP-B1, FP-G2 |
| M6 | Draft the covenant compliance certificate; borrowing-base certificate; funding-need memo | elevated-role (never auto-file) | NONE | FP-G2/G3 |
| M7 | Narrate the forecast ("why cash dips in wk 6 → the Q3 tax estimate + payroll cluster"); assumptions-changed diff | read-only | NONE | ⭐NEW (folds FP-B2 attribution) |
| M8 | NL cash/forecast query ("will we have cash in 8 weeks?", "cash for Heartland now") → deterministic forecast + citations | read-only | NONE | → **FPB-nl-copilot** (A4) |
| M9 | Reforecast orchestration each close: actualize closed period → roll drivers forward → re-run covenant/cash → raise funding exception | propose→approve | NONE | FP-B1, BC-D4 |
| M10 | Forecast-autonomy dial (auto-refresh rolling forecast within tolerance); a forecast never *moves money* — treasury sweeps are human-release | human-release / auto(dial) | NONE | BC-C4, FP-K4 → PW4 |
| M11 | Funding recommendation (draw/paydown/sweep) to protect covenant & liquidity; idle-cash optimization (propose, never move) | human-release | NONE | BC-C4/C5, BC-D4 |
| M12 | **Covenant-drift + cash-safety proactive alerting** (green/amber/red headroom, projected breach date, payroll/debt-service safety) | detect→triage / hard-gate | NONE | FP-G2, BC-C3 |
| M13 | Retrieve credit-agreement covenant definitions & prior certificates for the forecast context | read-only | NONE | ⭐NEW (folds FP-G2 defs) |
| M14 | Per-tenant collection-behavior + payment-timing memory (predicted pay dates by customer/vendor); forecast-accuracy learning | read-only | NONE | BC-D2, FP-K2 |

---

## 3. Tax & Compliance (SALT / nexus · 1099 · income-tax provision / M-1 / M-3)

Build: 10 live (nexus tripwire, W-9/COI gate, 1099 readiness, dual-book depreciation, tax-year params, IC
matching, anomalous-JE, cutoff, obligation tracker). **Never the regulated party** — filing/TIN-match/rate/
e-file hand off to a licensed provider. Catalog v2 = **6/39 built**. Biggest gap: **book-to-tax M-1/M-3.**

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | Extract W-9 / exemption-certificate / prior-return data (TIN, entity type, state) at intake | propose→approve | partial (W-9 presence) | TX-B1, TX-A7 |
| M2 | **Book-to-tax M-1/M-3 tagging** (meals 50%, entertainment 0%, penalties, §174, book-vs-tax depr) + temp/perm (ASC 740); tax-character at posting; capex-vs-expense + de-minimis; use-tax character | propose→approve | NONE (depr partial) | TX-C1/C2, TX-D1, TX-A6 |
| M3 | Marketplace-facilitator / 1099-K rail-split reconciliation (exclude card volume from seller liability & 1099-NEC); apportionment-factor tie-out | read-only | partial (rail-split built) | TX-A8, TX-C6 |
| M4 | **Sales-tax economic-nexus tripwire** (built); income/franchise nexus (payroll/property/inventory); anomalous-JE (AU-C 240); cutoff; owner disguised-distribution; S-corp reasonable-comp | detect→triage | built (A1/F1/F2) / NONE (A2/E3/E4) | TX-A1/A2, TX-F1/F2, TX-E3/E4 |
| M5 | Estimated-payment scheduler + safe-harbor math; deferred-tax rollforward (DTA/DTL); provision projection; nexus-breach-date projection | human-release / elevated-role | NONE | TX-C5/C3/C4, TX-A1 |
| M6 | Draft the sales-tax return worksheet; 1099 batch file (data → provider); tax workpapers; **PBC / tie-out assurance pack** | propose→approve / read-only | NONE (F3) | TX-A5, TX-B4, TX-F3 |
| M7 | Narrate the effective-rate reconciliation; explain each M-1 adjustment with its Code cite; related-party (ASC 850) disclosure narrative | elevated-role | NONE | TX-C4, TX-C1, TX-E2 |
| M8 | NL tax Q&A ("do we have nexus in TX?", "what's our 1099 exposure this year?") → allowlisted tax reads + citations | read-only | NONE | → **FPB-nl-copilot** (A1/A2) |
| M9 | Provision-run orchestration: assemble M-1/M-3 bridge → temp/perm → DTA/DTL roll → rate rec → workpaper pack; 1099 season run (readiness → TIN-match → e-file handoff) | elevated-role | partial (1099 readiness built) | TX-C1→C4, TX-B2/B3/B4 |
| M10 | Human-release / elevated-role on every filing, election, registration, remittance — **AI never files, registers, remits, or elects** (§174/§179 election is the taxpayer's act) | elevated-role / human-release | partial (D5 confirmed-gate built) | TX-D3/D5, §1.10 liability rule |
| M11 | Tax-saving move recommendations: PTET/composite election, §179/bonus election presenter, WOTC/R&D credit capture, use-tax vs absorb | elevated-role | partial (D3) / NONE | TX-C7, TX-D3, TX-C8/C9 |
| M12 | Filing-deadline calendar automation (fed/state/local, sales-tax cadence, Jan-31 1099, franchise/annual report); backup-withholding trigger; expiring-cert/W-9 chase | propose→approve | built (G1) / partial (G2) | TX-G1/G2/G3, TX-B5 |
| M13 | Tax-law / taxability Q&A (SaaS taxable by state, de-minimis thresholds); registration-status & prior-filing lookup | read-only | NONE | TX-A3/A4 (provider-gated) |
| M14 | Per-tenant taxability-mapping memory (SKU→tax-code once, reused); per-vendor 1099-eligibility learning; nexus-footprint memory | read-only | partial | TX-A4, TX-B3 |

*Provider-gated (never the regulated party): rate/taxability (Avalara/TaxJar/Vertex/Stripe Tax), IRS TIN match,
1099 e-file (Track1099/Sovos), state return prep (CCH/Lacerte), R&D/WOTC studies, registered-agent/annual report.*

---

## 4. Payroll

**NOT a segment in catalog v2** — lives only in `docs/FPB-payroll.md`. So every AI cell here is ⭐NEW relative
to the catalog (the FPB names four of them). Build: GATE 12.3 **Phase A built** — provider-agnostic
`PayrollEngine` (mock + Check adapter), run state machine (`lib/payroll/run.ts`), balanced dimensioned GL post
(`entry_type='PAYROLL_RUN'`, `lib/posting/payroll.ts`), SoD preparer≠approver, release=only money step. Phase B
(live provider, releaser≠preparer, webhooks) gated on Mike's Check-vs-Gusto pick. **Provider is always the
regulated party** — Books never computes a tax or moves the money.

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | Extract hours from timesheets / prior-provider pay registers / historical W-2s at onboarding (PII stays with provider) | propose→approve | NONE | ⭐NEW |
| M2 | **Labor → job/dept/class attribution** — propose the dimension stamp per pay line from recent time entries/history so labor lands job-costed; earnings/deduction classification | propose→approve | spec | ⭐NEW (FPB-payroll §13.2) |
| M3 | **Auto-reconcile the provider's consolidated bank debit** against the posted run + payable clearings (extends recon autopilot); payroll-liability→GL tie-out | propose→approve | spec | ⭐NEW (FPB-payroll §13.3) |
| M4 | **Run anomaly review** (highest-value payroll AI) — paycheck N× trailing avg, terminated employee still on roster, missing hours, duplicate off-cycle, changed garnishment | detect→triage | spec | ⭐NEW (FPB-payroll §13.1) |
| M5 | Employer-tax + benefit run-rate for the 13-wk forecast; PTO-liability accrual projection; comp/headcount-plan feed (→ FP&A C1) | read-only / propose→approve | partial (GL feed) | ⭐NEW (folds FP-C1) |
| M6 | Draft the pay register / native branded pay-stub PDF (v2); off-cycle/correction-run draft | propose→approve | NONE | ⭐NEW |
| M7 | Labor-cost variance narrative (overtime spike, headcount cost trend by dept/job); effective burden-rate readout (reporting only — NOT the retired overhead engine) | read-only | NONE | ⭐NEW |
| M8 | NL payroll ("run payroll for the biweekly schedule", "why did Jordan's check change?") → proposed run / cited answer | propose→approve | NONE | → **FPB-nl-copilot** (P-intent + A) |
| M9 | **Payroll close orchestration:** draft → provider preview (gross-to-net) → SoD approve → explicit release → post → reconcile → period-spanning accrual JE | propose→approve / human-release | partial (Phase A state machine) | ⭐NEW (FPB-payroll §5/§9) |
| M10 | Money-safety governance: **no auto-run switch ever**; release is an explicit logged human act; preparer≠approver DB-CHECK; SoD binds the AI (drafter≠releaser) | human-release | partial (built Phase A) | ⭐NEW → PW3/PW4 |
| M11 | Payroll-timing / funding optimization; garnishment routing (2270); benefit-plan / classification recommendation; contractor-vs-employee (1099 vs W-2) flag | propose→approve / elevated-role | NONE | ⭐NEW (folds AP 1099 path) |
| M12 | Proactive alerts: pay-run due, funding-shortfall vs bank, terminated-still-paid, garnishment-change, filing-deadline (via provider) | detect→triage | NONE | ⭐NEW |
| M13 | Payroll policy / multi-state withholding Q&A; retrieve prior runs and pay history | read-only | NONE | ⭐NEW |
| M14 | Per-employee comp memory (recurring earnings/deductions, default dimensions); learned anomaly baselines per employee | read-only | partial (comp defaults) | ⭐NEW |

---

## 5. Practice / Multi-client (the accounting-firm plane)

**NOT a segment in catalog v2** — lives only in `docs/discovery/books/accounting-firm-partner.md` (design only,
nothing built) and is blocked on **practice identity (multi-client model) + GATE 10/11a**. Substrate that
exists today: `/api/operations` (org-level actor split, autonomy, feed), `/api/client-health` (per-entity
backlog + "who's behind" flags — keyed to entity, not to the owning human, and single-org). Everything
cross-tenant / firm-economics / portal / playbook is NONE. **Nearly every AI cell here is ⭐NEW.**

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | Bulk-extract a new client's historical docs at conversion (→ segment 8); client-uploaded statement/receipt IDP through the portal | propose→approve | NONE | ⭐NEW (→ §8) |
| M2 | Auto-apply the firm's standard COA/close-playbook mapping to each client's ledger; classify client transactions to the firm standard consistently across 40 books | propose→approve | NONE | ⭐NEW |
| M3 | Cross-client subledger/IC tie-out sweep; reconcile portfolio close-state against the calendar | detect→triage | partial (per-entity only) | ⭐NEW (folds GL-D2) |
| M4 | **Cross-client exception sweep** — unreconciled/stale/out-of-balance-IC/negative-balance anomalies across ALL clients at once; realization-drift & scope-creep detection; key-person concentration risk | detect→triage | partial (client-health, single-org) | ⭐NEW |
| M5 | **Portfolio close-slippage prediction** (which client misses business-day-N); capacity-vs-load & peak-load (close-crunch) forecast; per-client onboarding-load model | detect→triage / read-only | NONE | ⭐NEW |
| M6 | Draft engagement letters / proposals / scope-change memos; auto-assemble each client's monthly deliverable pack; draft the client-facing status update | propose→approve | NONE | ⭐NEW (folds FP-G1 per client) |
| M7 | Per-client profitability narrative (fee vs fully-loaded hours); realization / write-down story; scope-creep evidence pack for the re-price conversation | read-only | NONE | ⭐NEW |
| M8 | NL practice queries ("which clients are behind?", "who's over-allocated?", "least profitable clients") → cross-client rollup + citations | read-only | NONE | → **FPB-nl-copilot** (cross-tenant, post-11a) |
| M9 | **Close-to-deliver orchestration per client** — enforce the standardized playbook (sequence/gates) across the portfolio; agentic pre-review (auto tie-outs, clear mechanical checks) so humans only touch judgment | propose→approve / elevated-role | NONE | ⭐NEW (firm-partner B3/B4) |
| M10 | Practice autonomy governance: the AI is a supervised "preparer" in the preparer→reviewer→partner chain; per-client/per-task dial; sign-off stays human | hard-gate / elevated-role | NONE | ⭐NEW → PW3/PW4 |
| M11 | **Staff↔client assignment optimization** — balance the book-of-business grid by capacity/tier/skill; re-price/re-scope/re-staff recommendations; backup-reviewer suggestions for key-person risk | propose→approve / elevated-role | NONE | ⭐NEW |
| M12 | Portfolio close-board alerting (on-track/at-risk/late); SLA-breach warning; scope-creep & realization-drop alerts; review-bottleneck buildup alert | detect→triage | NONE | ⭐NEW |
| M13 | Firm-playbook / SOP knowledge retrieval; prior-client-treatment lookup ("how did we handle this rev-rec for client X?") | read-only | NONE | ⭐NEW |
| M14 | **Per-firm playbook memory** — the firm's close/onboarding IP + per-client variants learned and applied identically; realization-baseline learning per client tier | read-only | NONE | ⭐NEW |

---

## 6. Job Costing / WIP

Catalog v2 has **no job-costing segment** (it notes the gap in §5: "no cost-to-complete / WIP over-under-billing
AI") — only AP-C2 (cost→job attribution) and the job-profitability view touch it. Build: job list, job-cost
ledger report (`/api/reports/job-cost`, `job_cost_entries`), `v_job_profitability` (contract / estimated /
actual / billed / pct_complete), `JOB_COST`/`JOB_BILLING`/`JOB_PROGRESS` events (FROZEN v3 seam to
MeritProjects). **All the AI is NONE and mostly ⭐NEW.**

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | Extract cost-line detail from subcontractor invoices / lien waivers / AIA G702-G703 pay apps at intake | propose→approve | partial (AP OCR partial) | ⭐NEW (folds AP-A1) |
| M2 | **Cost → job / cost-code attribution** (labor, material, sub, equipment); commitment vs actual classification | propose→approve | partial | AP-C2 |
| M3 | **WIP schedule reconciliation** — cost-to-date vs billed-to-date → over/under-billing true-up; unbilled-cost (revenue-leakage) detection; retainage tie-out | propose→approve / detect→triage | partial (retainage built) | ⭐NEW (folds AR-A5) |
| M4 | **Margin-fade / cost-overrun detection**; change-order-leakage (work done, no CO) detection; anomalous job-cost coding | detect→triage | NONE | ⭐NEW |
| M5 | **Cost-to-complete forecast** (EAC / percent-complete revenue true-up); over/under-billing projection; job cash-flow / margin-at-completion prediction | propose→approve | NONE | ⭐NEW |
| M6 | Draft the AIA / SOV progress bill (G702/G703); draft the WIP schedule; change-order draft | propose→approve | partial (progress billing partial) | ⭐NEW (folds AR-A3) |
| M7 | Job-cost variance narrative (why margin faded, which cost-code overran, CO impact); WIP-movement explanation | read-only | NONE | ⭐NEW |
| M8 | NL job queries ("which jobs are over budget?", "margin on the Coho job?", "**jobs over budget AND behind billing AND dragging DSCR**" — the cross-domain moat) | read-only | NONE | → **FPB-nl-copilot** (A7 moat) |
| M9 | Progress-billing cycle orchestration: pull JOB_PROGRESS → compute % complete → true-up deferred revenue → draft pay app → post on approval | propose→approve | partial (rev-rec method-per-job built) | ⭐NEW (folds rev-rec) |
| M10 | Governance: AI proposes % complete / EAC, never *invents* it; human owns the revenue true-up; rev-rec deferral rule deterministic (managed job → Deferred Rev 2410) | propose→approve | partial | GL/rev-rec canon §3 |
| M11 | Bid/estimate accuracy recommendation; job-mix / margin optimization; retainage-release timing; sub-vs-self-perform cost signal | read-only | NONE | ⭐NEW |
| M12 | Proactive alerts: job crossing budget, margin-fade threshold, unbilled-cost aging, retainage overdue, over-billing exceeding cost | detect→triage | NONE | ⭐NEW |
| M13 | Job history / prior-similar-job lookup; contract & change-order retrieval for context | read-only | NONE | ⭐NEW |
| M14 | Per-cost-code estimate-vs-actual learning (sharpen future EAC/bids); per-customer billing-behavior memory | read-only | NONE | ⭐NEW |

---

## 7. Team Performance / Workforce supervision

**NOT a segment in catalog v2** — lives in `docs/FPB-team-performance.md`. Build: the pure compute layer +
guard is **built** (`lib/team-performance/compute.ts` + `guard.ts`, migration 074 `performance_config`,
quality-gated difficulty-weighted KPIs, `/api/team-performance`); dashboard partial; the **AI dimension
(summaries / coaching / fairness sentinel) is spec.** Read/analytics only — never posts, moves money, or
changes a permission. **AI cells are ⭐NEW relative to the catalog.**

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | — no document surface (metrics derive from `core.action_log` + ledger) | — | — | — |
| M2 | Classify each logged action into a work-family + difficulty weight (T7) so throughput normalizes for job mix (built as deterministic config; AI-assisted weight tuning is the extension) | read-only | partial (deterministic built) | ⭐NEW |
| M3 | Instrumentation-health tie-out — % of mutating actions that wrote an `action_log` row with a resolved actor (the meta-metric that gates every number) | read-only | partial | ⭐NEW (FPB §16) |
| M4 | **Fairness sentinel** (anti-gaming) — flag throughput-up-while-quality-down, trivial-batch-approval inflation, latency-improving-because-review-skipped; rework/reopen-rate outliers | detect→triage | spec | ⭐NEW (FPB §7) |
| M5 | **Capacity-vs-load / time-to-clear prediction** (queue grows faster than it clears → early warning); backlog-aging trajectory per person | read-only | spec | ⭐NEW (FPB M5) |
| M6 | Draft **AI performance summaries** — plain-English per person/team/period, grounded strictly in computed KPIs (no invented numbers) | read-only | spec | ⭐NEW (FPB §7) |
| M7 | Explain a scorecard movement ("weighted throughput +12% while rework held at 2%; AP latency slipped"); preparer↔reviewer pairing narrative | read-only | spec | ⭐NEW |
| M8 | NL team queries ("who's behind?", "show Jordan's scorecard", "team rework this month") → RBAC-scoped metrics + drill-through | read-only | NONE | → **FPB-nl-copilot** (analytical) |
| M9 | — no multi-step ledger orchestration (analytics module); nightly rollup (`performance_daily`) is a deterministic job, not agentic | — | NONE (rollup spec) | ⭐NEW (minor) |
| M10 | Governance: AI outputs are proposals to the manager only — **never auto-determine pay/ranking/discipline**; human judgment is the final gate; viewing scorecards is itself logged | read-only | spec | ⭐NEW (FPB §11) |
| M11 | **Coaching-pattern detection** (same cut-off error 3 months running → training signal); load-balancing & backup-reviewer recommendation; autonomy-dial tuning off measured accuracy | detect→triage | spec | ⭐NEW (FPB §7) |
| M12 | Proactive alerts: rising override rate (AI miscalibration), backlog outgrowing clear-rate, key-person concentration, autonomy-rising-while-errors-rising (kill-switch trigger) | detect→triage / hard-gate | spec | ⭐NEW → PW4 |
| M13 | Drill-through retrieval to the `action_log` rows behind any number ("demonstrated, not asserted") | read-only | partial | ⭐NEW |
| M14 | Per-tenant weight/band memory (fairness = config, versioned); per-person baseline for trend & anomaly | read-only | partial (config built) | ⭐NEW |

---

## 8. Onboarding / Historical Conversion

**NOT a segment in catalog v2.** Build: a real import pipeline is **built** (`/api/import`, `lib/import/`,
`/import` UI, `/setup` wizard) — CSV, Suite-Core split (master → `core`, ledger → `public`), typed field defs
with header-alias auto-map, trial-balance / open-AR / open-AP / GL-history importers, per-company posting. The
**AI layer on top (categorize the historical mess, tie out the opening TB, map the COA, run the conversion
playbook) is NONE** — and the accounting-firm brief B10 makes this the make-or-break moment. **Mostly ⭐NEW.**

| M | Capability — one line | HITL | Build | Ref |
|---|---|---|---|---|
| M1 | **Extract from prior-system exports** (QBO/Sage/Xero/spreadsheets — one-time migration sources) + scanned statements/prior returns; auto-map CSV headers to fields | propose→approve | partial (alias auto-map built; OCR NONE) | ⭐NEW |
| M2 | **Bulk AI categorization of historical transactions** to the firm/tenant COA; **COA remap** from the prior system's chart to the standard; item/customer/vendor type classification | propose→approve | NONE | ⭐NEW |
| M3 | **Opening trial-balance tie-out** — imported TB balances (debits=credits, subledgers to control accounts); dedup imported master data (vendors/customers) on import | hard-gate / propose→approve | partial (TB import built; tie-out AI NONE) | ⭐NEW (dedup folds AP-B5) |
| M4 | Conversion-quality detection — gaps/duplicates/orphaned balances in imported history; prior-period-mess anomalies (mis-coded, unreconciled, negative-where-impossible) | detect→triage | NONE | ⭐NEW |
| M5 | Cleanup-effort / onboarding-load estimate (how many hours will this conversion take → capacity feed to the practice plane) | read-only | NONE | ⭐NEW (→ §5 M5) |
| M6 | Draft the opening-balance JE; draft the COA-mapping crosswalk; draft the conversion summary / first-close checklist | propose→approve | NONE | ⭐NEW |
| M7 | Explain what changed in conversion (prior-book → MeritBooks deltas, reclasses, opening adjustments) for the client sign-off | read-only | NONE | ⭐NEW |
| M8 | NL conversion ("import my QBO export", "did the opening balances tie out?") → mapped import action / cited status | propose→approve | NONE | → **FPB-nl-copilot** (P-intent) |
| M9 | **Conversion playbook orchestration** — collect access → import from source → map COA → tie out opening TB → clean up → first clean close, gated & repeatable per client | propose→approve / elevated-role | partial (import steps built, no orchestration) | ⭐NEW (firm-partner A4/B10) |
| M10 | Governance: **nothing posts to the owned GL until a human blesses the opening position**; AI does bulk import/categorization + proposes the opening TB, staff/partner tie out & approve | hard-gate | partial | ⭐NEW (firm-partner B10) |
| M11 | Recommend COA-mapping targets; suggest which historical periods to convert vs summarize; flag which prior balances need a cleanup entry | propose→approve | NONE | ⭐NEW |
| M12 | Conversion-progress alerting (steps blocked, opening TB out of balance, access still missing) | detect→triage | NONE | ⭐NEW |
| M13 | Prior-system-mapping knowledge (QBO/Sage account-type conventions → MeritBooks roles); prior-conversion lookup | read-only | NONE | ⭐NEW |
| M14 | Learned mapping memory — a firm's repeated QBO→standard-COA crosswalk applied identically each new client; categorization patterns carried from conversion into steady-state | read-only | NONE | ⭐NEW (→ §5 M14) |

---

## ⭐NEW capabilities this pass surfaced (not in catalog v2)

These are capabilities whose **richest home segment is absent from catalog v2**, so they were structurally
missed. Grouped; each is a distinct build target needing its own Rule-13 FPB. (NL/what-if variants are counted
under `FPB-nl-copilot`, not double-counted here.)

**Payroll (whole segment missing from v2 — the FPB names 4, the modality sweep surfaces more):**
1. Payroll **run anomaly review** (N×-paycheck, terminated-still-on-roster, missing hours, duplicate off-cycle). ⭐
2. **Labor → job/dept/class attribution** at the pay line (the ledger-native job-costing differentiator). ⭐
3. **Auto-reconcile the provider bank debit** to the posted run + payable clearings. ⭐
4. Payroll **close orchestration** (draft→preview→approve→release→post→reconcile→accrual) as an agentic chain. ⭐
5. Employer-tax/benefit **run-rate + PTO-liability forecast** feed. ⭐  6. Labor-cost variance narrative. ⭐
7. Per-employee comp/anomaly-baseline memory. ⭐  8. Payroll monitoring alerts (funding-shortfall, terminated-still-paid). ⭐

**Practice / multi-client plane (whole plane missing from v2):**
9. **Cross-client exception sweep** (portfolio-wide anomalies in one pane). ⭐
10. **Portfolio close-slippage prediction** + capacity/peak-load forecast. ⭐
11. **Agentic pre-review** (auto tie-outs / mechanical-check clearing so humans touch only judgment). ⭐
12. **Staff↔client assignment optimization** + key-person-risk backup suggestion. ⭐
13. **Realization / scope-creep drift detection** + re-price evidence pack. ⭐
14. Per-client profitability narrative. ⭐  15. **Per-firm playbook memory** (close/onboarding IP applied identically). ⭐
16. Engagement-letter / deliverable-pack / client-status drafting. ⭐  17. Practice knowledge retrieval (prior-client treatment). ⭐

**Job Costing / WIP (segment missing from v2):**
18. **Cost-to-complete / EAC forecast** (percent-complete revenue true-up). ⭐
19. **WIP over/under-billing schedule + true-up** (reconciliation). ⭐
20. **Margin-fade / cost-overrun detection.** ⭐  21. **Change-order-leakage detection.** ⭐
22. **AIA / SOV progress-bill draft** (G702/G703). ⭐  23. Job-cost variance narrative. ⭐
24. Per-cost-code estimate-vs-actual learning. ⭐  25. Job-cost monitoring alerts (budget-crossing, unbilled-cost aging). ⭐

**Team Performance (segment missing from v2, FPB exists):**
26. **AI performance summaries** (ledger-grounded, no invented numbers). ⭐
27. **Fairness sentinel / anti-gaming detection.** ⭐  28. **Coaching-pattern detection** (recurring-error training signal). ⭐
29. **Capacity-vs-load / time-to-clear prediction.** ⭐  30. Instrumentation-health meta-metric. ⭐

**Onboarding / Historical Conversion (segment missing from v2):**
31. **Bulk AI categorization of historical transactions** to the standard COA. ⭐
32. **Opening-TB tie-out** (debits=credits, subledger→control). ⭐  33. **COA remap** from prior system. ⭐
34. **Conversion-quality anomaly detection** (gaps/dups/orphans in imported history). ⭐
35. **Conversion playbook orchestration** (access→import→map→tie-out→cleanup→first close). ⭐
36. Learned QBO/Sage→standard-COA mapping memory. ⭐  37. Cleanup-effort/onboarding-load estimate. ⭐

**Forecasting-as-its-own-plane (scattered in v2; a few genuinely new framings):**
38. **Covenant-breach-date projection** as a first-class prediction (FP-G2 exists but the *dated* projection + continuous monitor is thin). ⭐(partial)
39. Forecast narrative / assumptions-changed diff. ⭐  40. Cross-lens tie-out (13-wk direct ↔ monthly indirect). ⭐

**Count:** **~40 distinct ⭐NEW capabilities** not represented in catalog v2 (Payroll ~8, Practice ~9,
Job-Costing ~8, Team-Performance ~5, Onboarding ~7, Forecasting ~3). All NL/what-if surfaces consolidate into
the single `FPB-nl-copilot` and are not counted above.

---

## Per-segment top-3 (highest owned-ledger leverage × trust-to-sign × build-on-existing-primitives)

**1. Budgeting & FP&A** — (a) budget-draft-off-actuals + version-of-record + seasonality (M5/M6/M10, FP-A1/A2/A5);
(b) **AI flux/variance narrative** with exact JE citations (M7, FP-D2 — the marquee "BEAT QBO" surface);
(c) driver model + scenarios + NL what-if (M5/M8/M11, FP-A3/E1 → nl-copilot). All GATE 7.

**2. Forecasting** — (a) **covenant continuous-monitor + breach-date projection + certificate draft** (M5/M6/M12,
FP-G2 — existential, the owned-ledger moat's purest expression); (b) decision-grade cash: scheduled-outflow
overlay + behavior-adjusted collection dates + payroll/debt safety alert (M5/M12, BC-D3/D2/BC-C3); (c) NL cash
Q&A (M8 → nl-copilot A4).

**3. Tax & Compliance** — (a) **book-to-tax M-1/M-3 tagging + temp/perm** (M2, TX-C1/C2 — "the single richest AI
opportunity"; pure posting-path dimension, nothing blocks it); (b) **PBC / tie-out assurance pack** (M6, TX-F3 —
the hard-dollar audit-fee ROI a CFO feels; ~90% substrate already present); (c) registration tracker +
income/franchise nexus to unblock the built tripwire (M4/M12, TX-A2/A3).

**4. Payroll** — (a) **run anomaly review** (M4 — highest-value payroll AI, pre-submit, advisory); (b) **labor→job
attribution** (M2 — the ledger-native job-costing differentiator every incumbent lacks); (c) **auto-reconcile the
provider debit** (M3 — extends the built recon autopilot). All Phase A, buildable now; provider-live gated on Mike's pick.

**5. Practice / Multi-client** — (a) **cross-client exception sweep + portfolio close board** (M4/M12 — the #1 thing
a single-company tool structurally cannot do); (b) **agentic pre-review** (M9 — highest-leverage AI insertion in a
firm; collapses the reviewer bottleneck); (c) **staff↔client assignment + realization/scope-creep drift** (M11/M4).
All gated on the practice identity (multi-client) model + GATE 10/11a.

**6. Job Costing / WIP** — (a) **cost-to-complete / EAC forecast + percent-complete revenue true-up** (M5 — the
canon-flagged gap); (b) **WIP over/under-billing schedule** (M3); (c) **margin-fade + change-order-leakage
detection** (M4). Reuses `v_job_profitability` + the FROZEN-v3 JOB_* event seam; the cross-domain NL query (M8, A7)
is the unique moat. GATE 6.

**7. Team Performance** — (a) **AI performance summaries** grounded in the built KPI compute (M6 — cheap, high value,
substrate live); (b) **fairness sentinel / anti-gaming** (M4 — protects the metric's legitimacy, the module's whole
risk); (c) **coaching-pattern + capacity-vs-load prediction** (M11/M5). Compute + config already built (mig 074).

**8. Onboarding / Historical Conversion** — (a) **bulk AI categorization of historical transactions** to the standard
COA (M2 — the worst-realization phase of any engagement); (b) **opening-TB tie-out gate** (M3 — nothing posts to the
owned GL until it ties and a human blesses it); (c) **conversion playbook orchestration** (M9). Reuses the built
import pipeline; the make-or-break moment for both a self-serve tenant and a firm winning a client (firm-partner B10).

---

*Analysis / spec only. No build authorization. Every capability above must clear its Rule-13 FPB (16 dimensions +
a QBO/Sage/best-in-class benchmark with named deltas) and its `Prereq:` gate before a line of code. The ~40 ⭐NEW
rows are candidates to fold into catalog v3 (adding Payroll, Practice, Job-Costing, Team-Performance, and
Onboarding as first-class segments). NL/what-if surfaces align to `FPB-nl-copilot.md` — one copilot, many intents.*
