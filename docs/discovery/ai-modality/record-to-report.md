# AI Modality × Segment Grid — RECORD-TO-REPORT cluster

**Author:** AI engineer on the MeritBooks discovery panel (with the R2R SMEs). Analysis/spec only — **no capability below is a build authorization.** Each must earn a Rule-13 FPB and land behind its `Prereq:` gate first.
**Date:** 2026-08-02 (Session 42 canon).
**Method:** For each of the 7 cluster segments, walk **all 14 AI modalities** and fill every cell — by construction, so nothing is missed the way the pervasive NL-FP&A surface was missed on the first pass. Cells are reconciled against the live repo (`apps/web/src/lib/controls|services|posting|reports|trust`, `app/api/*`) and against `docs/discovery/AI-CAPABILITY-CATALOG-v2.md` so we don't double-count. **Every cell that is NOT already in catalog v2 is flagged ⭐NEW** — those misses are the point.

**Canon posture inherited by every cell (never restated):** *AI proposes a **fact** or a **draft** → the deterministic engine does any accounting (debits=credits, direction from account TYPE, role-not-number) → a human with the right `core` role approves anything that moves money / changes the book / touches a client → every AI action + human decision writes `core.action_log` (actor = specific human OR AI+version).* Auto-post is OFF by default; autonomy is a per-tenant/per-task dial; SoD binds the AI itself; on ambiguity fail closed and ask. Money is bigint cents. AI routes only through `@meritbooks/core-ai` (metered, tenant-budget capped). **Rev-rec is deterministic-by-design: AI proposes facts (POB split, % complete, method fit), the engine posts — AI never invents the debits/credits or the % complete.**

**The 14 modalities (columns):** M1 Doc-extraction/OCR/IDP · M2 Classification & coding · M3 Entity matching & reconciliation · M4 Anomaly/fraud/control · M5 Forecasting & prediction · M6 Content generation/drafting · M7 Narrative & explanation · M8 Conversational NL · M9 Agentic multi-step orchestration · M10 Autonomy governance & HITL · M11 Recommendation & optimization · M12 Monitoring & proactive alerting · M13 Search/retrieval/knowledge · M14 Learning & personalization.

**Build-state legend:** `built` (live/functional incl. shipped detect-only) · `partial` (substrate exists, gap named) · `spec` (designed, nothing in repo) · `NONE` (gap / would need shared-spine work). **HITL:** propose→approve · detect-only · read-only · hard-gate · human-release · elevated-role.

**Segments:** S1 GL & Journal Entries · S2 Month-End Close · S3 Reconciliation · S4 Financial Reporting/Statements · S5 Revenue Recognition · S6 Fixed Assets · S7 Consolidation & Intercompany.

---

## §1. The master grid (segment × 14 modalities)

Compact cell = capability short-name · build-state · ⭐ if not in catalog v2. Detail + HITL per cell in §2.

| | M1 Extract | M2 Classify | M3 Match/Recon | M4 Anomaly | M5 Forecast | M6 Draft | M7 Narrate |
|---|---|---|---|---|---|---|---|
| **S1 GL/JE** | JE-support IDP · spec ⭐ | NL JE role-resolve · **built** | Dup-JE / reversing-pair · partial ⭐ | Anomalous-JE (AU-C 240) · **built** | Accrual run-rate · **built** | JE/accrual draft · **built** | Explain-this-JE · partial ⭐ |
| **S2 Close** | Close-binder doc OCR · spec ⭐ | Suspense→account cleanup · **built** | Subledger→GL tie-out · partial | Missed-accrual/cutoff/leakage · **built** | Days-to-close-ready ETA · spec ⭐ | Adjusting-entry batch draft · partial | "Why is this entity red" · spec ⭐ |
| **S3 Recon** | Statement-PDF OCR + ending-bal · partial ⭐ | Unmatched-line coding · **built** | Bank autopilot + cash-app · **built** | Plug / stale-item detector · spec ⭐ | Predicted clearing dates · spec ⭐ | In-rec adj entry + rec memo · partial ⭐ | Reconciling-items narrative · spec ⭐ |
| **S4 Reporting** | Ext-financials/prior-auditor IDP · spec ⭐ | COA→statement-line mapping · partial ⭐ | Cross-report / report→GL tie-out · spec ⭐ | Statement-integrity checks · spec ⭐ | Trend projection on lines · partial | Footnote/MD&A/disclosure draft · spec ⭐ | **Flux/variance + board narrative · NONE** |
| **S5 Rev Rec** | ASC 606 contract IDP (POB/price/SSP) · spec ⭐ | Revenue-stream→method + POB alloc · partial ⭐ | Billed↔recognized↔deferred tie-out · spec ⭐ | Stalled/ahead-of-delivery release · **built** | Deferred-rev waterfall roll-off · spec ⭐ | ASC 606 / SSP-alloc memo · spec ⭐ | Deferred-rev rollforward story · spec ⭐ |
| **S6 Fixed Assets** | Capex-invoice→asset IDP · spec ⭐ | Capex-vs-expense + asset-class/life · partial | FA subledger→GL + physical tie-out · spec ⭐ | Ghost/missed-run/neg-NBV · spec ⭐ | Depreciation forecast + capex bridge · spec ⭐ | Depreciation/disposal/impair entry · partial | NBV / gain-loss explanation · spec ⭐ |
| **S7 Consol/IC** | Sub-TB / equity-investee IDP · spec ⭐ | Entity→grouping + elim-eligibility · partial ⭐ | IC match+mirror; invest-in-sub↔equity · partial | IC-imbalance + elim-completeness · **built**(IC) | Consolidated / NCI projection · NONE | Elimination-entry + consol memo · partial | Consol-vs-sum bridge narrative · spec ⭐ |

| | M8 NL convo | M9 Agentic orch | M10 Autonomy gov | M11 Recommend/opt | M12 Monitor/alert | M13 Search/knowledge | M14 Learning/personalize |
|---|---|---|---|---|---|---|---|
| **S1 GL/JE** | Ask-the-ledger + NL JE · partial | Recurring-run agent · partial | Auto-post JE dial · partial | Next-best-action + "make recurring?" · partial | Stuck/unposted-batch monitor · partial ⭐ | **Semantic JE/GL search · spec ⭐** | Vendor→account + tenant-phrasing memory · partial |
| **S2 Close** | "What's blocking close" · spec ⭐ | Autonomous close-run agent · partial | Close-task autonomy dial · partial | **Close-path/critical-path optimize · spec ⭐** | Close-deadline / phase-slip alert · spec ⭐ | Search close binder / prior support · spec ⭐ | Learn tenant close cadence + accrual set · spec ⭐ |
| **S3 Recon** | "Reconcile this account" NL · spec ⭐ | End-to-end reconcile agent · partial | Auto-clear rec dial · partial | Best-match / bulk-clear suggest · partial | Stale-feed / unreconciled-aging · partial | Retrieve source doc for a line · spec ⭐ | Match-pattern learning · **built** |
| **S4 Reporting** | **NL report/query builder · NONE** | Auto-assemble report/board pack · NONE | Report-publish approval gate · partial | Insight surfacing / KPI-to-review · spec ⭐ | Report-freshness / KPI-breach alert · spec ⭐ | **Semantic report search + policy Q&A · spec ⭐** | Learn report layout/KPI/tone prefs · spec ⭐ |
| **S5 Rev Rec** | NL "show deferred-rev waterfall" · spec ⭐ | End-to-end rev-rec run · partial | Auto-release deferral dial · partial | Best-fit method recommend · spec ⭐ | Deferral-due / milestone-due monitor · partial | Contract-terms retrieval + 606 Q&A · spec ⭐ | Method-per-rev-type + SSP memory · spec ⭐ |
| **S6 Fixed Assets** | NL asset-register query · spec ⭐ | Monthly depreciation-run agent · partial | Auto-depreciate dial · partial | Method/life + §179/bonus optimize · partial | Missed-run / fully-depreciated alert · spec ⭐ | NL asset search + warranty/lease docs · spec ⭐ | Asset-class→life/method defaults memory · spec ⭐ |
| **S7 Consol/IC** | NL "consolidate fund X" · spec ⭐ | One-click consolidation-run agent · partial | Consolidation-run dial · partial | Grouping design + IC netting/pool · partial | IC-imbalance + pre-consol readiness · partial ⭐ | Ownership-structure + prior-elim retrieval · spec ⭐ | Learn structure + recurring eliminations · spec ⭐ |

*(Every cell is filled — no genuine "—". The R2R cluster has real tasks in all 98 cells; the sparse zones are M4/M13 for the newer segments and the whole M13 column, which catalog v2 barely touched.)*

---

## §2. Per-segment modality detail

Each row: **modality → capability (1 line) · HITL · build-state · ⭐NEW if not in catalog v2 (with the v2 ID it maps to, if any).**

### S1 — GL & Journal Entries
- **M1** JE-support IDP — extract the backup (invoice/contract/amort schedule) behind a manual JE, auto-attach, and validate the JE amount ties to source. propose→approve · **spec** · ⭐NEW.
- **M2** NL JE composer — plain-English → balanced role-resolved JE on the org's real COA. propose→approve · **built** (`je-composer.ts`; v2 A1/PW5).
- **M3** Duplicate-JE / reversing-pair matching — catch a manual JE keyed twice or an accrual never reversed. detect-only · **partial** · ⭐NEW (v2 has AP dup-payment, not dup-JE).
- **M4** Anomalous/unsupported JE (AU-C 240) — round-dollar, weak desc, no attachment, odd pair, off-hours. detect-only→hard-gate · **built** (`anomalous-je.ts`; v2 PW2).
- **M5** Accrual run-rate estimate — draft the run-rate for a recurring cost that went absent. propose→approve · **built** (`missed-accruals.ts`; v2 GL-B1).
- **M6** JE / accrual / prepaid drafting — draft the entry from a template or NL. propose→approve · **built** (v2 A1/GL-A2).
- **M7** Explain-this-JE — narrate what an entry did and why, from its lines + source. read-only · **partial** · ⭐NEW.
- **M8** Ask-the-ledger + NL JE — "what's in 6100 for Heritage in Q2" and NL command. propose→approve/read-only · **partial** (NL JE built; ledger-Q&A thin; v2 PW5).
- **M9** Recurring-entry run agent — generate the month's recurring set + reversals end-to-end. propose→approve · **partial** (v2 GL-A2).
- **M10** Auto-post JE dial — per-task autonomy on drafted entries; `scoreToTier`→disposition. hard-gate/auto-clear(dial) · **partial** (v2 PW4/J2).
- **M11** Next-best-action + "make this recurring?" — learned-cadence template suggestion. propose→approve · **partial** (v2 GL-A3).
- **M12** Stuck/unposted-batch monitor — alert on drafts sitting unposted, stale proposals. detect-only · **partial** · ⭐NEW.
- **M13** Semantic JE/GL search — "find the entry where we booked the insurance renewal" over lines + memos. read-only · **spec** · ⭐NEW (M13 column absent from v2).
- **M14** Vendor→account + tenant-phrasing memory — coding memory and JE-composer style learning. read-only · **partial** (v2 BC-A3 partial-coverage).

### S2 — Month-End Close
- **M1** Close-binder doc OCR — ingest bank/loan/broker statements → parse ending balances/support for the binder. propose→approve · **spec** · ⭐NEW.
- **M2** Suspense / "Ask-My-Accountant" cleanup — classify uncoded lines to accounts, empty-before-close. hard-gate · **built** (`uncategorized-leakage.ts`; v2 GL-C4).
- **M3** Subledger→GL control tie-out — AR=1100, AP=2000, clearing=0, drift flag. detect-only · **partial** (v2 GL-D2).
- **M4** Missed-accrual / cutoff / leakage detectors — the completeness+cutoff gates. detect-only · **built** (EC-2/4/12; v2 GL-B1/C4/TX-F2).
- **M5** Days-to-close-ready ETA — predict close-completion date from queue burn-down. read-only · **spec** · ⭐NEW.
- **M6** Adjusting-entry batch draft — draft the standard month-end accrual/deferral/depreciation set. propose→approve · **partial** (v2 GL-A2/B2/B4).
- **M7** "Why is this entity red" narrative — explain a close-status blocker in words. read-only · **spec** · ⭐NEW.
- **M8** "What's blocking close" NL — conversational close-status interrogation. read-only · **spec** · ⭐NEW.
- **M9** Autonomous close-run agent — orchestrate checklist: gather, propose, chase, auto-verify. propose→approve · **partial** (v2 GL-F2).
- **M10** Close-task autonomy dial — how much of the close runs unattended. hard-gate · **partial** (v2 PW4).
- **M11** Close-path / critical-path optimization — which task unblocks the most, sequence to fastest clean close. read-only · **spec** · ⭐NEW.
- **M12** Close-deadline / phase-slip alert — due_day (3/7/10) monitoring + slip warning. detect-only · **spec** · ⭐NEW.
- **M13** Search the close binder / prior-period support — retrieve last quarter's accrual basis, prior working papers. read-only · **spec** · ⭐NEW.
- **M14** Learn tenant close cadence + typical accrual set — reuse prior-period explanations & recurring adjustments. read-only · **spec** · ⭐NEW.
*(Close command center `/close-status` is **built** — the derived readiness pane [v2 GL-F1] underlies M9/M12.)*

### S3 — Reconciliation
- **M1** Statement-PDF OCR + ending-balance extraction — anchor a rec when there's no feed (distinct from CSV/OFX import). propose→approve · **partial** · ⭐NEW (v2 BC-B7 is CSV/OFX only).
- **M2** Unmatched bank-line coding — classify a feed line to account. propose→approve · **built** (`categorization.ts`; v2 BC-A2).
- **M3** Bank autopilot + cash application — composite-score match → tier; lump deposit → open AR. propose→approve · **built** (`reconciliation-match.ts`, `cash-application.ts`; v2 BC-B2/AR-C22).
- **M4** Plug / stale-item detector — flag a forced-to-zero plug and aged uncleared items (canon §1.5 #12 is an open gap). detect-only · **spec** · ⭐NEW.
- **M5** Predicted clearing dates — when will this outstanding check/deposit clear; stale-check prediction. read-only · **spec** · ⭐NEW.
- **M6** In-rec adjusting entry + reconciliation memo — draft fee/interest entries **and** the rec narrative. propose→approve · **partial** (adj built `reconciliation-adjustment.ts`; **memo ⭐NEW**).
- **M7** Reconciling-items narrative — explain each open item in words. read-only · **spec** · ⭐NEW.
- **M8** "Reconcile this account" NL — conversational reconcile command. propose→approve · **spec** · ⭐NEW.
- **M9** End-to-end reconcile agent — pull feed, match, draft adjustments, surface exceptions, finalize. propose→approve · **partial** (autopilot; v2 BC-B2).
- **M10** Auto-clear rec dial — auto-clear confident matches within the dial. auto-clear(dial) · **partial** (v2 PW4).
- **M11** Best-match / bulk-clear suggestion — rank candidate matches, propose bulk-clear. propose→approve · **partial** (v2 BC-B2).
- **M12** Stale-feed / unreconciled-aging monitor — balance freshness + aging alert. detect-only · **partial** (v2 BC-C2/F5).
- **M13** Retrieve source doc for a bank line — pull the matching invoice/bill/receipt. read-only · **spec** · ⭐NEW.
- **M14** Match-pattern learning — vendor/description pattern memory improves matching. read-only · **built** (v2 BC-A3).

### S4 — Financial Reporting / Statements
- **M1** External-financials / prior-auditor IDP — extract beginning balances/comparatives from acquired-entity or prior-year PDF. propose→approve · **spec** · ⭐NEW.
- **M2** COA→statement-line (grouping) mapping — classify accounts to report lines / disclosure groupings (XBRL-adjacent). propose→approve · **partial** · ⭐NEW (COA groups exist; AI mapping not).
- **M3** Cross-report / report→GL tie-out — BS ties to GL, CF ties to cash delta, inter-report consistency. detect-only · **spec** · ⭐NEW.
- **M4** Statement-integrity checks — BS doesn't balance, impossible signs, ratio out-of-range vs history. detect-only · **spec** · ⭐NEW.
- **M5** Trend projection on report lines — trailing-trend forward on a line (FP&A-adjacent). read-only · **partial** (v2 FP-B*).
- **M6** Footnote / MD&A / disclosure drafting — draft the narrative disclosures over the numbers. propose→approve · **spec** · ⭐NEW.
- **M7** **Flux/variance + board commentary** — compute variance, write the "why", flag material-move-no-story. propose→approve · **NONE** (v2 FP-D2/GL-E1 — known miss, still 0 built).
- **M8** **NL report / query builder** — plain-English → real report/plan config, never fabricated figures. propose→approve · **NONE** (v2 PW5/FP-E3 — the pervasive-NL surface, still unbuilt for reports).
- **M9** Auto-assemble report / board pack — one-click package generation. propose→approve · **NONE** (v2 FP-G1).
- **M10** Report-publish approval gate — SoD before a statement is shared externally. elevated-role · **partial** (report-route RLS built; publish-gate not).
- **M11** Insight surfacing / which-KPI-to-review — proactively point at the number that moved. read-only · **spec** · ⭐NEW.
- **M12** Report-freshness / KPI-threshold-breach alert — notify when a metric crosses a band. detect-only · **spec** · ⭐NEW.
- **M13** **Semantic report search + accounting-policy Q&A** — search across reports; GAAP/tenant-policy Q&A grounded in docs. read-only · **spec** · ⭐NEW.
- **M14** Learn report layout / KPI / narrative-tone preferences per tenant. read-only · **spec** · ⭐NEW.
*(~20 report routes are **built** — income-statement, balance-sheet, cash-flow, agings, GL detail, etc. The AI *layer over* reporting is almost entirely spec/NONE — the biggest surfaced hole after FP&A.)*

### S5 — Revenue Recognition (deterministic-by-design: AI proposes facts, engine posts)
- **M1** ASC 606 contract IDP — parse contract/SOW for performance obligations, transaction price, milestones, SSP → propose rev-rec facts. propose→approve · **spec** · ⭐NEW (major miss).
- **M2** Revenue-stream→method + POB allocation — classify the stream to one of the 5 methods (MILESTONE/AS_BILLED/RATABLY/SUBSCRIPTION/CASH) and allocate price across POBs. propose→approve · **partial** · ⭐NEW (method resolution built `rev-rec.ts`; **AI POB allocation** not).
- **M3** Billed↔recognized↔deferred tie-out — reconcile the waterfall: unbilled 1180 vs deferred 2410 vs recognized. detect-only · **spec** · ⭐NEW.
- **M4** Stalled / ahead-of-delivery release detector — deferral due but not released, or revenue recognized before delivery. detect-only · **built** (`revenue-not-recognized.ts`; v2 GL-B3).
- **M5** Deferred-revenue waterfall roll-off forecast — project future recognition from the current deferred balance + schedules. read-only · **spec** · ⭐NEW.
- **M6** ASC 606 / SSP-allocation memo drafting — draft the recognition memo + contract-mod memo. propose→approve · **spec** · ⭐NEW.
- **M7** Deferred-rev rollforward story — narrate the movement (additions, releases, mods). read-only · **spec** · ⭐NEW.
- **M8** NL "show the deferred-rev waterfall / recognize milestone 2" — conversational rev-rec. propose→approve · **spec** · ⭐NEW.
- **M9** End-to-end rev-rec run — schedule and propose all period releases across jobs. propose→approve · **partial** (`rev-rec-run.tsx` exists; v2 GL-B3).
- **M10** Auto-release deferral dial — auto-post scheduled releases within the dial. auto-clear(dial) · **partial** (v2 PW4).
- **M11** Best-fit method recommendation — recommend the recognition method for a new contract. propose→approve · **spec** · ⭐NEW.
- **M12** Deferral-due / contract-milestone-due monitor — alert when a release or milestone is due. detect-only · **partial** (release built; **milestone monitor** ⭐NEW).
- **M13** Contract-terms retrieval + ASC 606 Q&A — "which contracts have a termination-for-convenience clause"; policy Q&A. read-only · **spec** · ⭐NEW.
- **M14** Method-per-revenue-type + SSP-library memory — learn the tenant's method defaults and standalone-selling-price library. read-only · **spec** · ⭐NEW.

### S6 — Fixed Assets
- **M1** Capex-invoice → asset IDP — extract description, in-service date, cost, qty from a capex bill → create the asset record. propose→approve · **spec** · ⭐NEW.
- **M2** Capex-vs-expense + asset-class/useful-life/MACRS-class assignment — classify and assign the depreciation profile. propose→approve · **partial** (v2 AP-C3/TX-D1 capex classifier; **asset-class assignment** ⭐NEW).
- **M3** FA subledger→GL + physical tie-out — asset cost & accumulated depreciation tie to GL control; physical-count reconcile. detect-only · **spec** · ⭐NEW.
- **M4** Ghost-asset / missed-run / negative-NBV / disposal-without-gain-loss detector. detect-only · **spec** · ⭐NEW.
- **M5** Depreciation forecast + capex→depreciation→cash bridge — future-period depreciation projection. read-only · **spec** · ⭐NEW as FA-native (v2 FP-C3 partial, FP&A home).
- **M6** Depreciation / disposal / impairment entry drafting — post monthly depreciation, disposal gain/loss, impairment. propose→approve · **partial** (`depreciation-engine.ts` STRAIGHT_LINE + `asset-disposal.ts` built; impairment + non-SL methods not).
- **M7** NBV / gain-loss explanation — narrate depreciation & disposal outcomes. read-only · **spec** · ⭐NEW.
- **M8** NL asset-register query — "show fully-depreciated vehicles at Heritage". read-only · **spec** · ⭐NEW.
- **M9** Monthly depreciation-run agent — run depreciation across all assets, idempotent. propose→approve · **partial** (engine built; cross-asset orchestration + close-wiring partial).
- **M10** Auto-depreciate dial — auto-post the scheduled run within the dial. auto-clear(dial) · **partial** (v2 PW4).
- **M11** Method/life + §179/bonus/de-minimis optimization — present the tax-optimal election (never auto-elect). elevated-role · **partial** (`tax-depreciation.ts` MACRS/§179/bonus built; v2 TX-D3 election presenter partial).
- **M12** Missed-run / fully-depreciated / warranty-lease-expiry alert. detect-only · **spec** · ⭐NEW.
- **M13** NL asset search + warranty/lease/insurance doc retrieval. read-only · **spec** · ⭐NEW.
- **M14** Asset-class → useful-life/method default memory per tenant. read-only · **spec** · ⭐NEW.
*(FA subledger is real but shallow: book depreciation is STRAIGHT_LINE-only; tax depreciation [MACRS/§179/bonus] is a parallel non-posting book. Fixed Assets is flagged in COVERAGE-MATRIX as a thin segment — this column confirms it: 10 of 14 cells are ⭐NEW.)*

### S7 — Consolidation & Intercompany
- **M1** Subsidiary-TB / equity-investee statement IDP — parse a non-integrated sub's trial balance or an equity-method investee's statement. propose→approve · **spec** · ⭐NEW.
- **M2** Entity→grouping + elimination-eligibility classification — assign entities to fund/region/business-line groupings; classify which accounts are IC/eliminating. propose→approve · **partial** · ⭐NEW (`is_eliminating` flag exists; AI grouping/eligibility not).
- **M3** IC match + mirror-draft; investment-in-sub ↔ subsidiary-equity match — pair IC legs and draft the mirror; match I-in-S for elimination. propose→approve · **partial** (IC match **built-detect** `intercompany-balance.ts`; **invest-in-sub match** ⭐NEW).
- **M4** IC-imbalance + elimination-completeness detector — IC pairs net to zero; residual post-elimination balance; NCI drift. detect-only · **built** (IC-imbalance; **elim-completeness** ⭐NEW; v2 GL-H1).
- **M5** Consolidated / NCI projection — forecast group results & minority interest. read-only · **NONE** (FP&A-home; v2 GL-H2 adjacent).
- **M6** Elimination-entry + consolidation memo drafting — draft **booked** eliminations (to an elimination company) + the consol memo. elevated-role · **partial** (report-time netting `eliminations.ts` built; **booked entries + memo** — v2 GL-H2, canon 11a).
- **M7** Consol-vs-sum-of-entities bridge narrative — explain what eliminations/NCI did to the group numbers. read-only · **spec** · ⭐NEW.
- **M8** NL "consolidate fund X for Q2" — conversational consolidation command. propose→approve · **spec** · ⭐NEW.
- **M9** One-click consolidation-run agent — aggregate → eliminate → NCI → translate → package. propose→approve · **partial** (flat roll-up built; depth not; v2 GL-H2).
- **M10** Consolidation-run autonomy dial — how much runs unattended. hard-gate · **partial** (v2 PW4).
- **M11** Grouping-structure design + IC netting/cash-pooling optimization. read-only · **partial** (v2 BC-C5).
- **M12** IC-imbalance + pre-consolidation-readiness monitor — are all entities closed & IC matched before consol runs. detect-only · **partial** · ⭐NEW (pre-consol readiness gate).
- **M13** Ownership-structure + prior-elimination retrieval — org-chart / ownership Q&A; recall last period's eliminations. read-only · **spec** · ⭐NEW.
- **M14** Learn structure + recurring eliminations — auto-propose next period's eliminations from history. propose→approve · **spec** · ⭐NEW.
*(Consolidation depth [ownership%/NCI/invest-in-sub/groupings/booked eliminations/CTA] is canon **GATE 11a — MANDATORY, top priority**; today's build is a 100%-flat roll-up with report-time IC netting only, per `eliminations.ts`.)*

---

## §3. ⭐NEW capabilities this pass surfaced (misses NOT in catalog v2)

By walking every segment × modality cell — especially the columns v2 under-covered (**M1 doc-extraction, M4 anomaly for the newer segments, M7 narrative, M8/M13 NL & retrieval, M14 learning**) and the two segments v2 folded away (**Rev Rec, Fixed Assets**) — the following surfaced. Grouped; ~40 net-new.

**Whole-column miss — M13 Search/retrieval/knowledge (7, one per segment):** semantic JE/GL search (S1); close-binder & prior-support search (S2); source-doc retrieval for a bank line (S3); **semantic report search + accounting-policy/GAAP Q&A** (S4); contract-terms retrieval + ASC 606 Q&A (S5); NL asset search + asset-doc retrieval (S6); ownership-structure + prior-elimination retrieval (S7). *v2 has no M13 row anywhere — the single largest structural gap this pass found.*

**Revenue Recognition as its own AI surface (8):** ASC 606 **contract IDP** (POB/price/SSP extraction); AI **POB price allocation**; billed↔recognized↔deferred **waterfall tie-out**; **deferred-rev roll-off forecast**; ASC 606/SSP **memo drafting**; deferred-rev **rollforward narrative**; **best-fit method recommendation**; **milestone-due monitor** + method/SSP **memory**. *v2 treated rev-rec only as GL-B3 release + a detector.*

**Fixed Assets as its own AI surface (10 of 14 cells new):** capex-invoice **asset IDP**; **asset-class/useful-life assignment**; FA subledger→GL + **physical tie-out**; **ghost-asset / missed-run / neg-NBV** anomaly; **depreciation forecast** (FA-native); **NBV/gain-loss narrative**; NL asset-register query; **missed-run/fully-depreciated/expiry alerting**; asset-doc retrieval; asset-class **default memory**.

**Close intelligence (6):** close-binder **doc OCR**; **days-to-close-ready ETA** prediction; **"why is this entity red"** narrative; **"what's blocking close"** NL; **close-path/critical-path optimization**; **close-deadline/phase-slip alerting**; learn-tenant-close-cadence memory.

**Reconciliation depth (6):** statement-**PDF OCR + ending-balance** anchor; **plug/stale-item** detector (canon §1.5 #12 open gap); **predicted clearing dates**; reconciliation **memo** drafting; reconciling-items **narrative**; "reconcile this account" **NL**.

**Reporting intelligence beyond flux (6):** external/prior-auditor **financials IDP**; **COA→statement-line mapping**; cross-report / report→GL **tie-out**; **statement-integrity** anomaly checks; footnote/MD&A **disclosure drafting**; **insight surfacing** + report-freshness/**KPI-breach alerting**; report-layout **preference learning**.

**GL & Consolidation adds (5):** **duplicate-JE / reversing-pair** matching; explain-this-JE narrative; stuck/unposted-batch monitor (S1); **elimination-completeness** detector; **invest-in-sub ↔ equity** match; consol-vs-sum **bridge narrative**; **pre-consolidation-readiness** gate; recurring-elimination **learning** (S7).

*(v2's own known-but-unbuilt items — flux/variance narrative [FP-D2], NL report/query [PW5/FP-E3], board-pack [FP-G1], consolidation depth [GL-H2], working papers/evidence — are **not** counted as ⭐NEW here; they are already catalogued, and re-appear in the grid only to show their build-state is still NONE/partial.)*

---

## §4. Per-segment top-3 highest-value AI capabilities

**S1 GL/JE:** (1) NL JE composer — **built**, the single largest manual-JE labor sink, front door for every adjustment. (2) Anomalous-JE (AU-C 240) → **enforce** (block high-risk w/o support), not just detect. (3) ⭐ Semantic JE/GL search — turn the owned ledger into a queryable knowledge base; the trust/"find it fast" multiplier.

**S2 Close:** (1) Close-run **orchestration agent** with dependency graph + ledger auto-verify — governs the pipeline across 17+ entities. (2) ⭐ Days-to-close-ready ETA + close-path optimization — the CFO's headline "collapse the cycle" ask made concrete. (3) ⭐ Close-deadline/phase-slip **alerting** — nothing silently slips past day 3/7/10.

**S3 Reconciliation:** (1) Bank autopilot + cash application — **built**, kills the largest week-1 labor. (2) ⭐ Plug/stale-item detector — closes canon §1.5 #12; "difference = 0" is not a reconciliation if a plug forced it. (3) ⭐ Statement-PDF OCR + reconciliation-memo drafting — reconcile without a feed and produce the evidence in one pass.

**S4 Financial Reporting:** (1) **Flux/variance + board narrative** (v2 FP-D2, **still NONE**) — automates the final-phase analytical review; a material move with no story becomes a blocking question. (2) **NL report/query builder** (v2 PW5, **NONE**) — the pervasive NL-FP&A surface that was missed first pass; plain-English → real report, never fabricated. (3) ⭐ Semantic report search + **accounting-policy Q&A** — grounded GAAP/tenant-policy answers over reports + docs.

**S5 Revenue Recognition:** (1) ⭐ ASC 606 **contract IDP → POB/price/SSP facts** — the AI-proposes-facts entry point rev-rec was built for; feeds the deterministic engine. (2) ⭐ Billed↔recognized↔deferred **waterfall tie-out** + deferred-rev **roll-off forecast** — certify the rev-rec subledger and see the roll-off. (3) Stalled/ahead-of-delivery **release detector** — **built**; ASC 606 correctness, the material estimate for contract tenants.

**S6 Fixed Assets:** (1) ⭐ Capex-invoice **asset IDP** + capex-vs-expense/asset-class assignment — auto-create the asset and its depreciation profile from the bill. (2) Depreciation-run agent + §179/bonus **election optimizer** — **partial** (engines built); the recurring FA labor + the tax lever. (3) ⭐ Ghost-asset / missed-run / neg-NBV **anomaly** + FA→GL tie-out — the FA subledger integrity floor.

**S7 Consolidation & Intercompany:** (1) **Consolidation depth** — ownership%/NCI/invest-in-sub/groupings/**booked eliminations** (canon **11a MANDATORY**); today is flat roll-up only. (2) IC **auto-mirror** + ⭐ elimination-completeness + pre-consolidation-readiness gate — IC is the #2 multi-entity leak; block consolidation on unmatched IC. (3) ⭐ Consol-vs-sum **bridge narrative** + ownership-structure Q&A — explain the group numbers and answer "what did we eliminate."

---

*Analysis/spec only. One doc. No code changed, no build authorized — every capability must clear its Rule-13 FPB and its `Prereq:` gate first. Reconciled to `AI-CAPABILITY-CATALOG-v2.md`, `CANON-ANCHOR.md` §5, and a live read of the repo (Session 42).*
