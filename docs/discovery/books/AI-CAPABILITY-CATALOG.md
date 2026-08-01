# AI-Native Capability Catalog — MeritBooks (Books, Module 1 of 12)

**Author:** Lead AI product architect + adversarial reviewer
**Date:** 2026-08-01 (Session 40 canon)
**Grounding:** `docs/canon/CANON-ANCHOR.md` (owned GL; AI proposes facts → deterministic engine posts →
human approves → Decision Log; auto-post OFF by default; SoD binds the AI; per-tenant/per-task autonomy dial;
AI gateway is Merit-Core-owned via `@meritbooks/core-ai`, metered to `core.ai_usage_log`, tenant budget
enforced across the whole suite).
**Sources synthesized:** the five operator briefs in `docs/discovery/books/` — controller-cfo, cpa-tax-assurance,
accounting-firm-partner, bookkeeper-processor, accounting-manager.
**Status:** Discovery synthesis. **No capability below is a build authorization.** Each must get an approved
Rule-13 FPB (16 dimensions + QBO/Sage benchmark) before build, and each must land behind its `Prereq:` gate.

---

## §0. How to read this catalog

This is the ranked, de-duplicated union of every control/leak/automation point the five briefs surfaced,
mapped onto the canon gate roadmap and the trust spine that already exists (`core.action_log`, `scoreToTier`
tiering, the `/exceptions` queue, the per-task autonomy dial, the deterministic posting engine).

**Every capability inherits the canon posture verbatim** (so it isn't restated per row): *AI proposes a fact
or a draft; the deterministic engine does any accounting; a human with the right Core role approves anything
that moves money, changes the book, changes vendor banking, or touches a client relationship; every AI action
and every human decision writes to `core.action_log` with actor = specific human OR specific AI agent+version;
auto-post is OFF by default and is a per-tenant/per-task dial that can only be loosened after the machine earns
it; on ambiguity the machine fails **closed** and asks.*

### Core AI gateway feature buckets (all routed through `@meritbooks/core-ai`)

| Bucket | What it does | Reused by |
|---|---|---|
| **EXTRACT** | OCR + field extraction from a document (bill, receipt, statement, W-9, COI, bank stmt) | AP inbox, receipt match, statement import, onboarding |
| **CLASSIFY** | Propose a category/tag/character (GL account, dimension, tax character, 1099-reportable) | Feed coding, book-to-tax, capex/expense, cutoff |
| **MATCH** | Fuzzy composite match between two record sets (bill↔payment, deposit↔invoice, receipt↔charge, IC pair) | Dup detection, cash app, recon autopilot, intercompany |
| **DETECT** | Anomaly / outlier / rule-violation scoring over the ledger | Exception Library, anomalous-JE, dup payments, nexus tripwire |
| **FORECAST** | Project a forward series (cash, covenant headroom, pay-date, close slippage) | 13-week cash, covenant drift, collections, close board |
| **RECONCILE** | Tie-out reasoning + "find the difference" diagnosis | Recon autopilot, PBC/tie-out, close checklist |
| **DRAFT** | Natural-language generation of an outreach/memo/certificate draft (never auto-sent for money/filings) | Doc chase, dunning, covenant certificate, review notes |

### Rank scoring

Each capability is scored 1–5 on four axes, then composited. The composite biases toward *ship-now* value on a
book of record: **Composite = ROI×0.35 + TrustImpact×0.30 + BuildEase×0.20 + FP-Safety×0.15.**

- **ROI** — annual $-at-risk prevented × likelihood × how badly today's tooling handles it.
- **TrustImpact** — how much this capability builds (or, if wrong, destroys) an operator's willingness to let
  the machine work. Controls that let a controller *sign* score high.
- **BuildEase** — inverse of build cost (5 = cheap layer on existing primitives; 1 = new engine/schema/segment).
- **FP-Safety** — inverse of false-positive blast radius (5 = a false positive is a cheap dismissed queue item;
  1 = a false positive blocks a legitimate payment/close or cries wolf until operators mute it).

Higher composite = build sooner. Ties broken by TrustImpact (a book of record lives or dies on trust).

---

## §1. Capability catalog, grouped by lifecycle / function

Format per capability: **one-line description · demanded by · failure prevented + $-at-risk logic · trigger +
data read/written · Core AI bucket · human-in-loop posture · degraded behavior · false-positive risk ·
[ROI / BuildEase / FP-Safety / TrustImpact] → Composite.**

---

### A. INTAKE (get the world into the owned ledger with zero keying)

#### A1 — Bank/credit-card feed auto-categorization (confidence-sorted)
- **One-liner:** Propose GL account + dimensions for every feed line, sorted lowest-confidence-first, one-click/batch approve.
- **Demanded by:** bookkeeper CORE-1 (flagship trust-builder); manager B3; controller #4.
- **Failure/$:** Miscoded lines distort departmental/entity P&L → decisions on bad numbers; 1–5% of transactions
  sit uncoded at any time. The single biggest daily labor sink (60–90 min/day/processor). ROI is labor collapse
  + margin accuracy.
- **Trigger/data:** New Plaid lines. Reads vendor-descriptor→GL history, composite confidence (vendor/amount/date).
  Writes proposed coding + confidence + reasoning; on approve, posts through engine.
- **Bucket:** CLASSIFY. **HITL:** pre-coded, queued; auto-approve only within the per-tenant dial (≥85% AND trusted
  vendor AND ≤$10k), always reversible + logged. **Degraded:** dial off → 100% propose-only queue; nothing stops.
- **FP risk:** Low-moderate — a wrong code is a cheap re-code, not a money event. **[ROI 5 / Ease 5 / FP 4 / Trust 5] → 4.75**
- **Status:** Largely BUILT (Bank Feed page, GATE 12.0/3). Cataloged as the reference pattern every other capability copies.

#### A2 — AP inbox: bill extraction from email/PDF (OCR side-by-side)
- **One-liner:** A bill hits an inbox/upload; extract vendor/inv#/date/due/amount/terms/GL; review fields beside the source image.
- **Demanded by:** bookkeeper CORE-2; controller #1 (AP is the largest labor + error/fraud surface).
- **Failure/$:** 2–4 min of pure re-keying per bill × dozens/day; keying errors seed downstream double-pays and
  miscodes. "I am a very expensive OCR engine."
- **Trigger/data:** Inbound email/upload. Reads the document image; matches vendor to `core.vendors`; suggests
  GL/job from vendor history. Writes a draft bill + attached source doc (the audit trail).
- **Bucket:** EXTRACT + CLASSIFY. **HITL:** side-by-side verify; confirm → draft bill pending approval-to-pay.
  **Degraded:** extraction low-confidence → present blank-ish form with the doc, human keys (today's baseline).
- **FP risk:** Moderate — a wrong extracted amount that slips review is dangerous; mitigate with math-foot check + dup gate (A3/B1).
  **[ROI 5 / Ease 3 / FP 3 / Trust 4] → 3.95**
- **Prereq:** GATE 4 (M365 email ingestion — BLOCKED on Azure creds) for the email path; upload path can precede it.

#### A3 — Receipt-to-charge matching (kill the shoebox)
- **One-liner:** Match uploaded/emailed/texted receipts to existing card charges; maintain a live "missing receipts" list per person.
- **Demanded by:** bookkeeper CORE-5; CPA A5 (substantiation = audit survival).
- **Failure/$:** ~1 hr/day matching; missing substantiation is the #1 audit/tax hole → disallowed deductions on exam.
- **Trigger/data:** Receipt arrives. MATCH on amount+date+vendor to feed lines; surfaces unmatched both sides.
  Writes receipt→charge link + attached image.
- **Bucket:** EXTRACT + MATCH. **HITL:** one-tap confirm; ambiguous → human; the *chase* is the machine's job (auto-nudge).
  **Degraded:** no confident match → item stays on the missing list, nudged.
- **FP risk:** Low — a wrong match is a cheap unlink. **[ROI 4 / Ease 4 / FP 4 / Trust 3] → 3.75**

#### A4 — Onboarding / historical conversion pipeline (gated)
- **One-liner:** Import from QBO/Sage/Xero/spreadsheet as a **one-time source**, AI-categorize the mess, propose opening TB, human ties out before "live."
- **Demanded by:** firm-partner A4/B10; manager (new clients = worst realization phase).
- **Failure/$:** A botched conversion (wrong opening balances, mangled COA, untied first close) poisons a just-won
  client from day one — the moment most likely to lose the client + the worst-realization hours.
- **Trigger/data:** New-tenant/new-entity onboarding. Reads import files; proposes COA mapping + opening TB. Writes
  nothing to the live GL until a human blesses the opening position.
- **Bucket:** EXTRACT + CLASSIFY + RECONCILE. **HITL:** AI does bulk import/categorization + proposes opening TB;
  staff/partner tie out and approve. **Degraded:** low-confidence mapping → staff maps manually.
- **FP risk:** Contained — nothing posts pre-approval. **[ROI 3 / Ease 2 / FP 4 / Trust 4] → 3.15**
- **Prereq:** Practice plane + identity (GATE 10/11a); QBO/Sage are import sources only (canon §1).

---

### B. AP / PROCESSING (pay the right vendor, the right amount, once)

#### B1 — Duplicate & erroneous payment detection ★ marquee control
- **One-liner:** Fuzzy-match invoice#+vendor+amount+date against all prior payments AND the feed; hard-block suspected duplicates and any vendor-banking change.
- **Demanded by:** controller #1; bookkeeper CORE-3; manager B4; CPA B5-adjacent.
- **Failure/$:** Duplicate/erroneous payment loss runs ~0.1–0.5% of AP spend — on $50M AP that's **$50k–$250k/yr**,
  much never recovered — plus BEC/fraud exposure (changed bank detail is the #1 vector). This is a **control, not a convenience.**
- **Trigger/data:** Bill entry + feed import. MATCH on vendor/inv#/amount/date; vendor-master dedupe on name/EIN/
  bank/remit; new-or-changed bank-detail flag. Writes an exception with both records side by side.
- **Bucket:** DETECT + MATCH. **HITL:** blocking warning showing both records; human chooses merge / discard-as-dup /
  genuinely-different; **never auto-deletes; never auto-pays a banking change; SoD on release (preparer≠approver).**
  **Degraded:** matcher offline → fall back to exact inv#+amount block (cheaper, still catches the common case).
- **FP risk:** Moderate but *cheap-to-clear* by design (side-by-side human choice), and the asymmetry favors blocking.
  **[ROI 5 / Ease 4 / FP 4 / Trust 5] → 4.60**

#### B2 — Vendor compliance: W-9 / TIN / COI auto-chase + payment gate
- **One-liner:** At vendor create + first payment, require W-9/TIN (and COI for trades); auto-chase + auto-remind; gate payment; badge status.
- **Demanded by:** bookkeeper CORE-4; controller #11; CPA A3/B4.
- **Failure/$:** Backup withholding at 24% the payer becomes liable for; 1099 penalties $60–$310/form (annual cap in
  the low millions); uninsured-sub liability from an expired COI. Individually small, collectively a recurring quiet drain.
- **Trigger/data:** Bill from unknown vendor; missing/expired W-9/COI; COI expiry approaching; vendor nearing $600
  cumulative reportable (non-card) spend. DRAFTs the request; writes compliance badge + exception on breach.
- **Bucket:** DRAFT + DETECT. **HITL:** AI drafts + auto-sends request/reminders; human approves the new vendor and
  any pay-anyway override (logged). **Degraded:** chase engine off → badge still computed, payment still gated manually.
- **FP risk:** Low. **[ROI 4 / Ease 4 / FP 4 / Trust 4] → 3.90**
- **Status:** BUILT as the Session-40 Vendor Compliance risk engine; reconcile + point at 1099 readiness (see B7-tax below).

#### B3 — Recurring / accrual entry drafting (incl. loan interest/principal split)
- **One-liner:** At period open, present the month's recurring entries (rent, depreciation, prepaid burn, accruals, loan splits) as a pre-drafted batch to review + release.
- **Demanded by:** bookkeeper CORE-6; controller #3.
- **Failure/$:** A forgotten accrual is the most common audit adjustment and directly distorts EBITDA → covenants,
  earn-outs, bonus pools. "The leak is the accrual you *forgot*." An afternoon/month of re-keying.
- **Trigger/data:** Recurring template + schedule; loan amortization schedule; period rollover. Proposes the batch;
  posts through engine on release.
- **Bucket:** CLASSIFY + FORECAST (variable accrual estimate). **HITL:** review, adjust variable amounts, release the
  batch. **Critically also flags *missing expected* accruals** (a monthly vendor went silent). **Degraded:** template
  fires as fixed-amount drafts only.
- **FP risk:** Low (proposals). **[ROI 4 / Ease 4 / FP 4 / Trust 4] → 3.90**

#### B4 — Payroll journal automation
- **One-liner:** Build the balanced payroll JE (gross/taxes/withholdings/net, dept & job splits) from the payroll-run output for approval.
- **Demanded by:** bookkeeper CORE-10.
- **Failure/$:** A fat-fingered tax split or missed department allocation corrupts labor cost on **every job**. Same
  entry shape every run — perfect automation candidate. ~1 hr/run.
- **Trigger/data:** Payroll-run import; pay-component→GL/dept map. Proposes the JE.
- **Bucket:** CLASSIFY. **HITL:** confirm the split before post (high-confidence but expensive-if-wrong). **Degraded:** mapping gap → human completes the split.
- **FP risk:** Low-moderate (structured). **[ROI 3 / Ease 4 / FP 4 / Trust 3] → 3.30**

#### B5 — Capex-vs-expense + depreciation/§179 lifecycle
- **One-liner:** On a capex-suggestive payment above threshold, prompt capitalize-vs-expense (de-minimis safe harbor + RABI test); auto-create the fixed-asset record + propose life/method/election; track disposals.
- **Demanded by:** CPA B2.
- **Failure/$:** Expensing an asset (reverses on exam) or capitalizing a repair (defers a deduction owed); **missed
  §179/bonus/de-minimis elections** (annual, often irrevocable); assets sold but still depreciating (permanent overstatement).
- **Trigger/data:** Payment to capex-suggestive account/vendor above threshold. CLASSIFY the RABI/safe-harbor call;
  writes FA subledger record + M-1 tag.
- **Bucket:** CLASSIFY + DETECT. **HITL:** AI proposes; **the election itself is a human tax-strategy decision — present, never auto-elect.**
  **Degraded:** below-threshold or low-confidence → normal expense coding path.
- **FP risk:** Low (proposal). **[ROI 3 / Ease 3 / FP 4 / Trust 3] → 3.00**
- **Prereq:** fixed-asset subledger (part of GATE 8/tax moat).

---

### C. AR / COLLECTIONS (bill correctly, apply cash, chase money)

#### C1 — AI cash application (deposits/receipts → open AR)
- **One-liner:** Match incoming ACH/wire/lockbox/Stripe receipts to open invoices (incl. one deposit → many invoices); propose the application; human confirms partials/splits.
- **Demanded by:** bookkeeper CORE-11; controller #7; both existing FPBs (recon + invoices) flag it as the symmetric inflow gap.
- **Failure/$:** Mis-applied lump payments create recurring AR cleanup; unapplied cash overstates AR and blows DSO/borrowing-base.
- **Trigger/data:** Incoming payment log. MATCH by customer+amount+reference against open AR; split/partial detection.
  Writes proposed application; on approve, posts DR Cash / CR AR (never re-recognizes revenue).
- **Bucket:** MATCH. **HITL:** confirm; ambiguous/material never auto-applied. **Degraded:** no confident match → unapplied-cash queue.
- **FP risk:** Low-moderate (mis-apply is reversible). **[ROI 4 / Ease 4 / FP 4 / Trust 4] → 3.90**
- **Prereq:** GATE 8 (AI cash application) + GATE 12.1 (Stripe posting verified).

#### C2 — Autonomous, supervised collections / dunning
- **One-liner:** Triage overdue AR, predict pay-dates, draft escalating outreach, propose write-offs/reserves — all human-approved and audited.
- **Demanded by:** invoices FPB (the GATE 9 moat); controller #7 (reserve/write-off is a judgment + SoD action).
- **Failure/$:** Stale AR carried at full value → bad-debt surprise + blown DSO; slow collections = working-capital drag.
- **Trigger/data:** AR aging + customer payment behavior. FORECAST pay-date; DRAFT outreach; propose reserve/write-off.
- **Bucket:** FORECAST + DRAFT. **HITL:** human sends (or trusted categories auto-send); **write-offs/reserves require approval + SoD.**
  **Degraded:** aging + static reminder cadence only.
- **FP risk:** Moderate (tone/relationship). **[ROI 4 / Ease 3 / FP 3 / Trust 3] → 3.30**
- **Prereq:** GATE 9 (AI moat), builds on Invoices FPB.

---

### D. CLOSE (nothing skipped, everything ties, judgment surfaced early)

#### D1 — Uncategorized / "Ask My Accountant" cleanup + empty-before-close gate
- **One-liner:** Accumulate un-coded items, re-propose coding as context arrives, and **gate the period lock on the queue being empty.**
- **Demanded by:** bookkeeper CORE-8; controller #4; manager A7.
- **Failure/$:** Real spend hiding in suspense/clearing → wrong margins + a pre-close scramble every month.
- **Trigger/data:** Items that failed confident coding. Re-CLASSIFY on new signal (a later receipt, a vendor pattern).
  Writes proposals; blocks HARD_CLOSE while non-empty.
- **Bucket:** CLASSIFY + DETECT. **HITL:** approve/redirect each; close gate is a hard control. **Degraded:** manual drain (today's baseline).
- **FP risk:** Low. **[ROI 4 / Ease 4 / FP 5 / Trust 4] → 4.05**

#### D2 — Statement / bank reconciliation autopilot
- **One-liner:** Clear the obvious book↔statement matches, hand the human only the true exceptions with a best-guess explanation; sign-off stays human; recon required to close.
- **Demanded by:** bookkeeper CORE-7; manager A2 ("unreconciled = not done"); controller #7.
- **Failure/$:** Hours/account/entity at close; a subledger that won't tie to the GL control account is where trust dies.
- **Trigger/data:** Statement import + cleared feed. MATCH (composite scorer, tiers) + RECONCILE ("likely bank fee $36").
  Writes proposed matches + adjusting-entry drafts.
- **Bucket:** MATCH + RECONCILE. **HITL:** human approves the reconciliation + adjusting entries; must reach true zero.
  **Degraded:** matcher off → manual check-off list.
- **FP risk:** Low (clearing is reversible). **[ROI 4 / Ease 4 / FP 4 / Trust 4] → 3.90**
- **Status:** BUILT as Session-40 Reconciliation autopilot; **FPB already written** (`FPB-bank-reconciliation.md`, GATE 8) — do not re-catalog, reconcile.

#### D3 — Real-time close command center + checklist auto-verify
- **One-liner:** Live per-entity × per-workstream close state machine driven off actual ledger/queue state (not a typed checklist), with machine-vs-human ownership per cell.
- **Demanded by:** manager B1 (the #1 thing they'd automate); firm-partner B1/B2; controller #9.
- **Failure/$:** The deadline surprise — discovering on day 5 that entity 12's bank rec never started. Restatement/audit
  findings from an omitted step; each extra close day is real payroll cost + delayed decisions.
- **Trigger/data:** Reads recon status, queue depth, review state, IC-match status per entity/period. Auto-verifies
  mechanical items (bank rec = 0 ✓). Blocks HARD_CLOSE on open blocking items.
- **Bucket:** RECONCILE + DETECT (aggregation). **HITL:** read-first situational awareness; humans own judgment items + sign-off.
  **Degraded:** partial signals still roll up; missing signal shows "unknown," never a false green.
- **FP risk:** Low (visibility). **[ROI 4 / Ease 3 / FP 4 / Trust 5] → 3.95**
- **Prereq:** GATE 7 + emits from every common-core module; canon "demonstrated, not asserted" (no manual status entry).

---

### E. REPORTING / FP&A (surface the judgment and the risk early)

#### E1 — Covenant breach drift monitor
- **One-liner:** Compute each covenant (DSCR, FCCR, leverage, liquidity, TNW) daily on actuals + forecast; graduated green/amber/red with projected breach date; draft the compliance certificate.
- **Demanded by:** controller #5 (the CFO's career risk).
- **Failure/$:** A technical default → acceleration, default-rate interest, cash sweeps, **waiver fees $25k–$250k**,
  cross-default across the group. Existential. Discovering it *after* quarter-close is too late to cure.
- **Trigger/data:** Machine-readable covenant defs per credit agreement; live + forecast GL; borrowing-base feed.
  FORECAST headroom; DRAFT the certificate.
- **Bucket:** FORECAST + DRAFT. **HITL:** CFO reviews + signs — **never auto-file a certification.** **Degraded:** compute on actuals only, no forecast.
- **FP risk:** Low-moderate (a false amber is cheap; a false green is catastrophic → bias conservative).
  **[ROI 5 / Ease 3 / FP 3 / Trust 4] → 3.85**
- **Prereq:** GATE 7 (FP&A depth); **[segment: leveraged/bank-financed]** — but the Merit tenant needs it.

#### E2 — 13-week direct cash forecast (multi-entity/multi-bank)
- **One-liner:** Roll all bank balances + AP due-dates + AR expected-collection + debt service + payroll into a rolling 13-week direct forecast by entity and consolidated; flag shortfalls + idle-cash sweeps.
- **Demanded by:** controller #6; bookkeeper (liquidity).
- **Failure/$:** Overdraft/NSF fees, missed debt-service or payroll, drawn-revolver interest; worst case missing payroll.
- **Trigger/data:** Plaid balances, AP/AR by due date, scheduled commitments. FORECAST the series.
- **Bucket:** FORECAST. **HITL:** treasury decides funding/sweeps; **AI never initiates a transfer** (money movement = preparer≠approver + explicit release).
  **Degraded:** actuals + due-date projection without behavioral pay-date modeling.
- **FP risk:** Low. **[ROI 4 / Ease 4 / FP 4 / Trust 3] → 3.75**
- **Status:** BUILT as Session-40 13-Week Cash Forecast; reconcile into an FPB (GATE 7).

#### E3 — Analytical / flux (variance) review + board-package narrative
- **One-liner:** Auto-flux vs prior month + budget; flag material moves with no story; draft the variance narrative + KPI/board roll-up.
- **Demanded by:** manager A2 (the sniff test); controller (board/investor package).
- **Failure/$:** A number that moved 40% with no story reaches the CFO/board; slow, manual narrative assembly.
- **Trigger/data:** GL by period/dimension. DETECT material fluctuations; DRAFT the narrative.
- **Bucket:** DETECT + DRAFT. **HITL:** human owns the explanation; AI proposes candidate drivers + draft prose.
  **Degraded:** flux table without narrative.
- **FP risk:** Low. **[ROI 3 / Ease 3 / FP 4 / Trust 3] → 3.05**
- **Prereq:** GATE 7.

---

### F. TAX / COMPLIANCE (audit-defensible by construction)

#### F1 — Sales/use-tax nexus tripwire
- **One-liner:** Rolling 12-mo revenue + transaction count by ship-to/customer state (plus payroll + inventory locations) vs a maintained per-state threshold table; alert at ~80%, before breach.
- **Demanded by:** CPA A4/B3; controller #11.
- **Failure/$:** Silently crossing economic-nexus thresholds → an uncollected-tax liability the **seller eats out of
  pocket** (can't retro-bill customers) + penalty + interest — a **six-figure undisclosed liability** that surfaces in
  diligence and re-prices or kills a deal. The single highest-$ catch for a growth-stage tenant.
- **Trigger/data:** Revenue by state, transaction counts, payroll-by-state, 3PL/FBA locations. DETECT threshold approach.
- **Bucket:** DETECT. **HITL:** raise to `/exceptions` with state + threshold + run-rate + projected breach date; human
  decides register / VDA. **Never auto-register.** **Degraded:** monthly recompute vs threshold table.
- **FP risk:** Low. **[ROI 5 / Ease 3 / FP 4 / Trust 4] → 3.95**
- **Prereq:** GATE 11d (sales tax); **[segment-weighted: multistate/e-comm/SaaS]**.

#### F2 — Book-to-tax difference tagging (M-1/M-3 + ASC 740 temp/perm)
- **One-liner:** At posting, tag each line's tax character (meals 50%, entertainment 0%, penalties, §179/bonus vs book depr, bad-debt reserve, prepaids); maintain a running M-1 bridge + temp/perm classification as a ledger dimension.
- **Demanded by:** CPA B1 ("the single richest AI opportunity in the whole brief") / A2 (ASC 740).
- **Failure/$:** Year-end scramble to reconstruct non-deductible/timing items; a wrong provision; **deferred tax is the
  #1 private-company restatement source** (a spreadsheet that drifted from the GL). Book NI moves 5–25% between handoff and adjusted.
- **Trigger/data:** Every expense/revenue posting. CLASSIFY tax character from account role/vendor/memo/amount/doc.
  Writes M-1 tag + temp/perm dimension.
- **Bucket:** CLASSIFY. **HITL:** high-confidence common cases auto-tag (logged); CPA confirms edge cases at review.
  Each tag cites the Code section + source facts (audit-defensible). **Degraded:** tag only clearly-labeled cases; rest untagged for review.
- **FP risk:** Low (a wrong tag is caught at review). **[ROI 4 / Ease 3 / FP 4 / Trust 4] → 3.75**
- **Prereq:** GATE 7/8 (tax moat).

#### F3 — 1099 readiness (year-round, rail-split)
- **One-liner:** Track reportable vendors (unincorporated, ≥$600, by cash/check/ACH — **excluding** card/3rd-party-network already on 1099-K); flag missing valid W-9; assemble the annual file.
- **Demanded by:** CPA A3/B4; controller #11; bookkeeper CORE-4.
- **Failure/$:** The January W-9 chase; CP2100 → 24% backup withholding; double-reporting card-paid amounts.
- **Trigger/data:** Vendor payments split by rail; W-9/TIN status. DETECT the $600 threshold crossing without a valid W-9.
- **Bucket:** DETECT. **HITL:** flag + request; filing is a human-triggered batch. **Degraded:** year-end batch report.
- **FP risk:** Low. **[ROI 3 / Ease 4 / FP 4 / Trust 3] → 3.30**
- **Prereq:** extends B2 (Vendor Compliance); **[common-core US]**.

#### F4 — Revenue & expense cutoff enforcement
- **One-liner:** Near period-end, compare invoice/bill date vs delivery/performance evidence; flag likely mis-cut items; enforce the rev-rec deferral rule (managed job credits Deferred Revenue 2410, not Revenue).
- **Demanded by:** CPA B6; controller #8; manager A2/B4.
- **Failure/$:** Revenue/expense in the wrong period → audit adjustment, covenant breach, tax paid early; a classic
  fraud/error focus in every audit.
- **Trigger/data:** Entries within N days of close; ship/progress/milestone evidence. DETECT the cutoff risk; rev-rec
  timing stays deterministic (engine-owned, `rev-rec.ts`).
- **Bucket:** DETECT. **HITL:** human confirms the period; **AI never invents % complete.** **Degraded:** flag large near-close entries by date alone.
- **FP risk:** Low-moderate. **[ROI 3 / Ease 3 / FP 4 / Trust 3] → 3.05**
- **Prereq:** GATE 6 (job-cost/rev-rec depth) for the progress-evidence side; **[revenue side segment-shaped]**.

---

### G. PRACTICE MANAGEMENT (the plane above the ledgers — firm tenants)

#### G1 — Cross-client portfolio dashboard + close board
- **One-liner:** One pane over all N client books: close status, exceptions, review queues, profitability, deadlines — read from live ledger state.
- **Demanded by:** firm-partner B1/B2/C1 (the practice plane's core screen; the #1 thing a single-company tool structurally lacks).
- **Failure/$:** Decisions made blind; a client's books silently slip a committed close date → SLA breach + churn on a
  $2k–$10k/mo recurring fee.
- **Trigger/data:** Aggregate per-client close %, open items, review status, exceptions, profitability. Pure visibility.
- **Bucket:** DETECT/aggregation + FORECAST (slippage). **HITL:** read-first; drill portfolio→client→task. **Degraded:** shows partial signals, flags stale.
- **FP risk:** Low. **[ROI 4 / Ease 3 / FP 4 / Trust 4] → 3.75**
- **Prereq:** practice identity (GATE 11a/10); reads emissions from common core (never manual status).

#### G2 — Enforceable standardized close/onboarding playbooks
- **One-liner:** The firm's IP: a standard close/onboarding checklist applied identically to every client with per-client variants, sequencing, and hard gates (can't review before recs done; can't close before review passes).
- **Demanded by:** firm-partner A3/B4/B10; manager A5 (playbooks/SOPs).
- **Failure/$:** Every staffer closes "their way"; a weak staffer's clients drift → errors, rework/write-downs, trust.
- **Trigger/data:** Playbook templates + per-client deltas + dependency graph. Enforced software gates.
- **Bucket:** (workflow; AI executes mechanical steps consistently). **HITL:** humans own judgment; gates can't be skipped.
  **Degraded:** static checklist without auto-verify.
- **FP risk:** Low. **[ROI 3 / Ease 3 / FP 4 / Trust 3] → 3.05**
- **Prereq:** practice plane (post GATE 11a).

#### G3 — Staff↔client assignment grid + capacity/realization/scope-creep
- **One-liner:** The book-of-business grid (preparer/reviewer/partner per client, tiers, re-assignment, key-person concentration) + utilization, realization, write-downs, per-client profitability, and fixed-fee scope-creep alerts.
- **Demanded by:** firm-partner A1/A2/A7/A9 + B6/B7/B8/B9.
- **Failure/$:** Conflating busy with profitable; silent margin bleed on fixed-fee clients; key-person risk orphaning books.
- **Trigger/data:** Assignments, hours (budget vs actual), fees, transaction volume vs onboarding baseline. DETECT drift.
- **Bucket:** DETECT + FORECAST. **HITL:** partner decides re-price/re-scope/re-staff/fire. **Degraded:** manual grid.
- **FP risk:** Low. **[ROI 3 / Ease 2 / FP 4 / Trust 3] → 2.85**
- **Prereq:** practice plane; needs time/hours data (PM module seam).

#### G4 — Client portal + document/answer chase orchestration
- **One-liner:** A client-facing surface (doc upload, open-question answers, deliverable review/approval, status) with automated escalating reminders; the "waiting on" board.
- **Demanded by:** firm-partner A5/B5; bookkeeper CORE-9 (the "chasing people" killer, the invisible 2–3:30 job).
- **Failure/$:** Every stalled close is capacity locked + a deadline at risk; chase labor is pure non-billable overhead.
- **Trigger/data:** Any transaction blocked on a missing doc/approval/answer. DRAFT the ask (in the operator's voice);
  auto-follow-up; a single "waiting on" board.
- **Bucket:** DRAFT. **HITL:** review before send or let trusted categories auto-send; human owns the relationship.
  **Degraded:** manual request list.
- **FP risk:** Low-moderate (client-facing tone). **[ROI 4 / Ease 3 / FP 3 / Trust 3] → 3.30**
- **Prereq:** practice plane + portal identity.

---

### H. SUPERVISION / TRUST (the moat — the supervision layer *is* the product)

#### H1 — Financial Control Exception Library ★★ marquee capability (its own FPB)
- **One-liner:** An always-on AI-assisted control set that continuously reconciles the owned ledger and surfaces $-quantified exceptions (dup payments, missed accruals, IC out-of-balance, cost leakage, unreconciled aging, rev-not-recognized, nexus drift, 1099 gaps, anomalous JEs, covenant drift, cutoff, re-expensed settlements) into `/exceptions` — the Books analogue of the MeritProjects Billing Integrity Auditor.
- **Demanded by:** every brief (it is the union of controller Part 2, CPA Part B, manager B4, bookkeeper CORE-3/8).
- **Failure/$:** It is the aggregate of B1/D1/E1/F1 etc. — the single surface that makes an operator willing to *sign*.
- **Bucket:** DETECT (+ RECONCILE) over the whole ledger. **HITL:** each exception is a proposal with $-at-risk + a
  one-click remediation draft; humans triage/approve; nothing posts or pays autonomously.
- **FP risk:** The central design problem — an exception engine that cries wolf gets muted, which is worse than none.
  Tiering + $-materiality + suppression/learning are load-bearing (see the FPB).
- **[ROI 5 / Ease 4 / FP 3 / Trust 5] → 4.45** — **reuses the trust spine already built** (`action_log`, `scoreToTier`, `/exceptions`).
- **FPB:** `docs/FPB-financial-control-exceptions.md` (this session). **Home gate:** GATE 9 (AI moat), with class-by-class
  homes across 11a/7/11d/8.

#### H2 — Anomalous / unsupported JE detection (AU-C 240, built-in)
- **One-liner:** Score every manual JE at posting on round-dollar, weak/blank description, missing attachment, unusual account pair (revenue↔reserve), timing (post-close/weekend), preparer identity; require reason+support above materiality.
- **Demanded by:** CPA B7 ("the feature most likely to make an auditor actively *prefer* MeritBooks clients"); manager B4.
- **Failure/$:** Manual JEs are the mechanism behind most FS fraud/misstatement; a dirty JE population expands audit scope + fee.
- **Trigger/data:** Every manual JE. DETECT the risk signals. Writes a score; blocks high-risk without support.
- **Bucket:** DETECT. **HITL:** low-risk posts with logging; high-risk requires description+attachment+approver.
  **AI scores; never fabricates support.** **Degraded:** rule-only scoring without the learned component.
- **FP risk:** Low (a flag asks for support; it doesn't block a legitimate documented entry).
  **[ROI 4 / Ease 4 / FP 4 / Trust 5] → 4.20** — hands the auditor the whole manual-JE population pre-scored.

#### H3 — Audit trail + SoD enforcement + machine-vs-human attribution
- **One-liner:** Immutable append-only `action_log`/`audit_log` with actor = specific human OR AI+version; enforced preparer≠approver≠releaser keyed to Core identity; period-lock + reopen trail; SoD applies to the AI.
- **Demanded by:** controller #10; CPA B8; manager B2/B6/B7 ("load-bearing for me").
- **Failure/$:** Material-weakness/SOX-style findings; failed audit; fraud; **one traceability failure poisons every number.** Non-negotiable baseline.
- **Trigger/data:** Every posting + master-data change. Writes the immutable record + approval chain.
- **Bucket:** (control primitive). **HITL:** the control *is* the human posture. **Degraded:** must never degrade — this is the floor.
- **FP risk:** N/A. **[ROI 4 / Ease 3 / FP 5 / Trust 5] → 4.20** — **gated by the standing NO-GO RBAC/identity gate**
  (`canApprove` must reconcile to `core.memberships/roles`, not `core.employees.role`).
- **Prereq:** GATE 10 (RBAC/identity) — tasks #9/#28/#29.

#### H4 — Confidence-tiered review queue + per-task autonomy dial + kill-switch
- **One-liner:** Every proposal carries a calibrated confidence; tiers route (auto-sampled / review / hard-stop); thresholds are the supervisor's dials, loosened only as the machine earns it; a granular immediate kill-switch degrades to propose-only, never to a dead book.
- **Demanded by:** manager B3/B8/B9/B10 (the crux of supervising a workforce you can't see); bookkeeper Part 3.
- **Failure/$:** The two opposite failures — review everything (drown, defeat automation) or review nothing (errors reach the CFO).
- **Trigger/data:** Confidence + tier per proposal; autonomy-rate/override-rate/backlog metrics that *govern* the dials.
- **Bucket:** (routing over `scoreToTier`). **HITL:** tiers are dials; sampling rights in the trusted band; the human
  supervisor is the final gate and can halt a close over any confidence score. **Degraded:** kill-switch → propose-only.
- **FP risk:** Low. **[ROI 4 / Ease 4 / FP 4 / Trust 5] → 4.20**
- **Prereq:** GATE 5 (confidence routing/learning).

---

## §2. Full ranked list (composite descending)

| Rank | Capability | Group | Composite | Scope | Home gate |
|---|---|---|---|---|---|
| 1 | A1 Feed auto-categorization | Intake | 4.75 | core | 3/5 (built) |
| 2 | B1 Duplicate/erroneous payment detection | AP | 4.60 | core | 8 |
| 3 | H1 Financial Control Exception Library | Trust | 4.45 | core | 9 |
| 4 | H2 Anomalous/unsupported JE detection | Trust | 4.20 | core | 9 |
| 4 | H3 Audit trail + SoD + attribution | Trust | 4.20 | core | 10 |
| 4 | H4 Confidence tiers + autonomy dial + kill-switch | Trust | 4.20 | core | 5 |
| 7 | D1 Uncategorized cleanup + close gate | Close | 4.05 | core | 8 |
| 8 | A2 AP inbox OCR extraction | Intake | 3.95 | core | 4 (blocked) |
| 8 | D3 Close command center + auto-verify | Close | 3.95 | core | 7 |
| 8 | F1 Sales/use-tax nexus tripwire | Tax | 3.95 | seg | 11d |
| 11 | B2 Vendor compliance W-9/COI chase | AP | 3.90 | core | 8 (built) |
| 11 | B3 Recurring/accrual drafting | AP | 3.90 | core | 8 |
| 11 | C1 AI cash application | AR | 3.90 | core | 8 |
| 11 | D2 Reconciliation autopilot | Close | 3.90 | core | 8 (FPB done) |
| 15 | E1 Covenant drift monitor | FP&A | 3.85 | seg | 7 |
| 16 | A3 Receipt-to-charge matching | Intake | 3.75 | core | 8 |
| 16 | E2 13-week cash forecast | FP&A | 3.75 | core | 7 (built) |
| 16 | F2 Book-to-tax tagging (M-1/ASC 740) | Tax | 3.75 | core | 7/8 |
| 16 | G1 Cross-client portfolio dashboard | Practice | 3.75 | practice | 11a/10 |
| 20 | B4 Payroll journal automation | AP | 3.30 | core | 8 |
| 20 | C2 Autonomous collections/dunning | AR | 3.30 | core | 9 |
| 20 | F3 1099 readiness | Tax | 3.30 | core | extends B2 |
| 20 | G4 Client portal + chase orchestration | Practice | 3.30 | practice | 11a |
| 24 | A4 Onboarding/conversion pipeline | Intake | 3.15 | practice | 11a |
| 25 | E3 Flux review + board narrative | FP&A | 3.05 | core | 7 |
| 25 | F4 Revenue/expense cutoff | Tax | 3.05 | seg | 6 |
| 25 | G2 Enforceable playbooks | Practice | 3.05 | practice | 11a |
| 28 | B5 Capex/expense + depreciation lifecycle | AP | 3.00 | core | 8 |
| 29 | G3 Assignment grid + realization/scope-creep | Practice | 2.85 | practice | 11a + PM seam |

---

## §3. BUILD-FIRST shortlist (mapped to the gate roadmap)

The build-first cut favors **common-core, trust-spine-reusing, high-$ controls that let an operator sign** — and
respects the canon rule that **no gate starts until its `Prereq:` gates are DONE**, and that the two open NO-GO
identity/RBAC gates (tasks #9/#28/#29) underwrite the whole trust story. **Each item below must get its own approved
Rule-13 FPB before any build.**

1. **H1 — Financial Control Exception Library** → **GATE 9 (AI moat)**, reusing the trust spine. The marquee frame that
   the individual controls plug into. **FPB written this session** (`FPB-financial-control-exceptions.md`).
2. **B1 — Duplicate/erroneous payment detection** → **GATE 8 (AP)**. Highest hard-$ control ($50k–$250k/yr on $50M AP);
   cheap layer on the existing composite matcher; a *control, not a convenience.* First exception class of H1.
3. **H2 — Anomalous/unsupported JE detection (AU-C 240)** → **GATE 9**. Hands auditors the whole manual-JE population
   pre-scored; the feature most likely to make a CPA prefer MeritBooks clients. An H1 exception class.
4. **H3 — Audit trail + SoD + attribution**, i.e. **close the identity/RBAC NO-GO gate** → **GATE 10** (tasks #9/#28/#29).
   Non-negotiable floor; every other trust capability is only as defensible as the identity it keys to.
5. **B2/F3 — Vendor compliance → 1099 readiness** → **GATE 8, extends the built Session-40 engine**. Reconcile the
   existing engine to canon and point it at rolling $600/rail-split 1099 readiness. Fast, common-core, quiet-drain ROI.
6. **D1 — Uncategorized cleanup + empty-before-close gate** → **GATE 8/close**. Layers on the existing bank feed;
   turns "AI proposes coding" into a *close control* (period can't lock with unknowns hiding). An H1 exception class.
7. **C1 — AI cash application (deposits→AR)** → **GATE 8**, **after GATE 12.1** (Stripe posting verified). The symmetric
   inflow side both existing FPBs flag; unblocks DSO/borrowing-base accuracy.
8. **E1 + F1 — Covenant drift monitor + sales-tax nexus tripwire** → **GATE 7 (FP&A) / GATE 11d**. The two highest-$
   *segment* catches (waiver fees $25k–$250k; six-figure undisclosed nexus liability). Segment-weighted but the Merit
   tenant (leveraged multi-entity) needs the covenant monitor now; both are H1 exception classes.

**Cross-suite coherence note (JOB_COST / JOB_BILLING seam):** the MeritProjects **Billing Integrity Auditor** audits
the *operations→ledger* seam — that every `JOB_COST` incurred gets billed and every `JOB_BILLING` ties back to real cost,
with no leakage between ops and the book. H1 (the Financial Control Exception Library) is its **Books-side mirror**: it
audits the *ledger's own* integrity. They must share the same trust primitives (`core.events`, `core.action_log`,
`scoreToTier`, `/exceptions`) and must **not double-count or contradict** at the seam — a cost that Projects flags as
unbilled and Books flags as uncategorized-leakage is *one* exception, deduplicated on `source_ref`, not two. The seam
is `core.events` (FROZEN v3); neither side reads the other's tables. See the FPB §0 and Dimension 11 for the explicit
de-dup contract.

**Governance reminder:** every build-first item lands behind the mandatory wave pipeline (re-ground → FPB → disjoint
slices → builder wave → verifier + chrome-auditor + security for money/identity → reviewer → integrate → scribe), and
every capability inherits the canon AI posture (propose → deterministic post → human approve → Decision Log; auto-post
OFF; SoD on the AI; gateway via `@meritbooks/core-ai`).
