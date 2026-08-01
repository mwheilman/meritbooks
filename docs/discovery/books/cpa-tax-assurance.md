# CPA Brief: Tax & Assurance Reality vs. an Owned-Ledger AI

**Author posture:** 20+ yrs, tax + assurance (audit/review), SMB and mid-market.
**Audience:** MeritBooks engineering.
**Ground:** MeritBooks OWNS the GL (not a QBO overlay) and is pitched as an *autonomous
accounting workforce + a supervision/trust layer* (`docs/canon/CANON-ANCHOR.md` §1). That framing
is exactly what makes the tax/assurance angle a moat — **the ledger is the evidence**, so the
system can be built to be *audit-defensible by construction*, not cleaned up after the fact.

This brief is written to one question: **what does a CPA actually do against a client's books, and
where does the money leak — such that an owned ledger with a trust layer should catch it at the
moment of posting rather than 10 months later in a fee-heavy scramble?**

A recurring theme: **90% of what a CPA does at year-end is not "tax genius" — it is reconstructing
facts the bookkeeping system failed to capture.** Every reconstruction below is a place MeritBooks
can capture the fact once, at the source, with its provenance intact.

---

## PART A — HOW THE ENGAGEMENTS ACTUALLY RUN

Engineers keep modeling "tax" as a report. It is not. It is a **year-long evidence-gathering
process** that culminates in a filing. Understand the workflow and the product features fall out.

### A1. Business income tax prep (the 1120-S / 1065 / 1120 / Sch. C reality)

What actually happens, in order:

1. **Trial balance lands — and it is wrong.** The CPA does not trust the client's books. First
   move is a **diagnostic review**: negative balances where none should exist (contra-asset in the
   wrong sign, negative cash = missing deposits or double-paid bills, negative AP = payments not
   matched to bills), suspense/"Ask My Accountant" balances, round-dollar plugs, and a
   balance sheet that does not tie to prior-year *ending* (the #1 tell of an unauthorized change to
   a closed period).
2. **Adjusting journal entries (AJEs).** The CPA books depreciation, accruals, prepaid
   amortization, payroll-tax true-ups, loan principal/interest splits, owner draws
   miscoded to expense, and reclasses. In SMB practice **the client's "net income" moves 5–25%**
   between the book they hand over and the adjusted book. Every one of these AJEs is a fact the
   ledger should have known.
3. **Book-to-tax (Schedule M-1/M-3) reconciliation.** Book income ≠ taxable income. The CPA builds
   the bridge: meals (50%), entertainment (0%), penalties/fines (0%), federal tax, tax-exempt
   interest, §179/bonus vs. book depreciation, accrual-to-cash conversions, prepaid rules,
   allowance-for-doubtful vs. actual bad debt (§166), reserve accounts, life insurance, PPP/ERC-type
   items, R&D §174 capitalization. **This is the single richest AI opportunity in the whole brief**
   (§B1).
4. **Fixed-asset roll and depreciation.** Reconcile additions/disposals to the depreciation
   schedule; make §179 / bonus / de-minimis-safe-harbor elections; catch missed dispositions
   (asset sold but still depreciating — a permanent overstatement of deductions and assets).
5. **Basis, distributions, and K-1s (pass-throughs).** S-corp: reasonable-comp check (officer wages
   vs. distributions — a top IRS audit trigger), AAA, stock/debt basis limits on loss deductibility.
   Partnership: 704(b)/704(c), capital accounts (now tax-basis mandatory), guaranteed payments,
   built-in gains. **K-1s cannot be produced correctly if intercompany and owner activity is dirty**
   — which for a multi-entity tenant like Merit is the whole ballgame.
6. **State apportionment & filings.** Where does the entity file? Nexus (payroll, property, sales),
   apportionment factors, composite vs. PTET (pass-through entity tax) elections — a live money
   decision most SMBs miss.
7. **Extensions, estimates, then the return.** Q-estimates driven off a projection; safe-harbor
   (100/110% prior year) math; underpayment-penalty avoidance.

**Product implication:** the return is the *last* step. The value is in steps 1–5, which are
*continuous ledger hygiene*, not April events. A book of record that carries the M-1 character,
the fixed-asset tax life, and the basis roll **as it posts** turns a 40-hour engagement into a
review.

### A2. Income-tax provision (ASC 740) — the review/audit-adjacent one

Any entity that gets an audit or review, or has outside investors/lenders, needs a **tax provision**
in its financials: current + deferred tax expense, deferred tax assets/liabilities from temporary
differences, valuation allowances, uncertain tax positions (FIN 48), and the rate reconciliation.
This is where **book-to-tax differences must be classified as temporary vs. permanent** — the same
M-1 data, but now feeding the financial statements, not just the return. If the ledger already
tags each difference (§B1), the provision is a rollforward, not a project. **Deferred tax is the
#1 restatement source in private-company financials** — usually because someone tracked temporary
differences in a spreadsheet that drifted from the GL.

### A3. Form 1099 season (1099-NEC / 1099-MISC / 1099-K interplay)

The mechanic that bites every SMB:

1. **W-9 must exist BEFORE the first payment**, not in January. In reality nobody collects it, so
   January is a frantic W-9 chase — vendors who've been paid all year, some now unreachable.
2. **Determine reportable vendors**: unincorporated payees (individuals, LLCs, partnerships) paid
   **≥ $600** for services in the calendar year, **by cash/check/ACH** (card/third-party-network
   payments are on the processor's 1099-K — double-reporting if you also issue a 1099-NEC).
3. **TIN matching** against the IRS DB — a mismatch → **CP2100 notice → backup withholding at 24%
   → potential B-notice penalties** ($60–$310 per form, up to ~$1.2M/yr for larger filers).
4. **File by Jan 31** (NEC) to IRS + payee + often state.

**Product implication:** this is a *vendor-master + payment-rail + threshold* query the ledger can
answer perfectly year-round — and MeritBooks already has a Vendor Compliance risk engine (COI/W9,
Session 40). Point it at 1099 readiness (§B4).

### A4. Sales & use tax / nexus

Post-*Wayfair* (2018), **economic nexus** means a business owes sales tax in states where it has no
physical presence, purely on volume (commonly **$100k sales or 200 transactions**, per state,
varying). SMBs blow through thresholds invisibly. Two exposures:

- **Sales tax not collected** where nexus exists → the seller owes it **out of pocket** (they can't
  retroactively bill customers), plus penalty + interest. A multi-state SaaS/e-comm SMB can carry a
  **six-figure undisclosed liability** that surfaces only in due diligence and kills or re-prices a deal.
- **Use tax** on out-of-state purchases where no sales tax was charged — self-assessed, almost never
  is. Also **taxability of the item itself** (SaaS is taxable in some states, not others; services vary).

Nexus also isn't only sales tax — **payroll in a state, inventory in a 3PL warehouse (e.g., FBA),
or remote employees** create income-tax and franchise-tax nexus too.

**Product implication:** the ledger sees ship-to/customer state, revenue by state, and headcount by
location. It can run a **rolling nexus tripwire** (§B3) — the single highest-$ catch in this brief
for a growth-stage tenant.

### A5. Audit & review engagements (assurance)

The three tiers, ascending assurance:

- **Compilation** — no assurance; CPA just presents management's numbers.
- **Review** — *limited* assurance; **analytical procedures + inquiry** (ratios, trends,
  fluctuation explanations). No testing of controls, minimal substantive testing. Most lender-
  required SMB engagements are reviews.
- **Audit** — *reasonable* assurance; risk assessment, **controls understanding**, substantive
  testing, confirmations (AR, bank, debt), sampling, tie-outs, disclosure checklist, management rep
  letter. Required for larger lenders, PE/VC, ESOPs, certain regulators.

How an audit actually runs, and where it hurts:

1. **PBC list ("Prepared By Client").** The auditor sends a 100–300 line request list: trial
   balance, GL detail, bank statements + recs, AR/AP aging, fixed-asset roll, debt agreements &
   covenant calcs, lease schedules, revenue support, **selected journal-entry support**, board
   minutes, and more. **Assembling the PBC list is the single most-hated, most-expensive part of an
   audit for the client** — weeks of pulling documents that should already be attached to the
   transactions. **An owned ledger where source docs are attached at posting makes the PBC list a
   query, not a fire drill. This is arguably MeritBooks' most concrete assurance selling point.**
2. **Tie-outs.** Every FS number must trace to the TB, the TB to the GL, the GL to source. A single
   penny that won't tie can burn hours. Automated, continuous tie-out is a native ledger capability.
3. **Journal-entry testing (required by AU-C 240, fraud standard).** Auditors specifically hunt
   **manual JEs**: entries to round dollars, entries posted by unexpected users, entries at
   period-end/after close, entries to unusual account combinations (e.g., revenue ↔ a balance-sheet
   reserve), entries with no description or support. **Every one of these is something the ledger
   can flag at posting time** (§B7).
4. **Segregation of duties (SoD) & controls.** Who can create a vendor AND pay it? Approve AND post?
   The auditor documents this; weak SoD raises assessed risk and expands testing (= higher fee) or
   yields a **material-weakness / significant-deficiency** letter to the board.
5. **Cutoff testing.** Did revenue/expense land in the right period? (§B6)
6. **Confirmations & analytics** round it out.

**Product implication:** almost the entire audit is *evidence retrieval + anomaly detection over the
ledger*. MeritBooks' "supervision/trust layer" is, functionally, a **continuous audit engine**. If
every posting carries approver, preparer, source doc, and AI-decision provenance, the year-end audit
collapses from an excavation into a report run. **Sell the audit fee reduction — it's a hard-dollar ROI a CFO feels.**

---

## PART B — THE CONTROL / LEAK POINTS AN OWNED-LEDGER AI SHOULD CATCH

Format per item: **the failure prevented · $ / risk · trigger + data needed · human-in-loop posture ·
what makes the AI output audit-defensible (so a CPA signs off).** The last column is the one
engineering under-weights: a CPA will not rely on a black-box suggestion. **Defensibility = the AI
shows its work: the rule/authority it applied, the source facts it read, a confidence, and an
immutable trail of who approved.** Per canon §3: *AI proposes FACTS; the deterministic engine does
the accounting; a human approves; every AI action → Decision Log.* That posture is already correct —
these features must inherit it.

### B1. Book-to-tax difference tagging (M-1/M-3 + ASC 740 temporary/permanent) — COMMON CORE, highest value

- **Failure prevented:** a year-end scramble to reconstruct which expenses are non-deductible or
  timing-different; a wrong provision; a missed deferred tax asset/liability; an M-1 that doesn't foot.
- **$ / risk:** mis-stated taxable income (penalties + interest on underpayment; overpayment if
  conservative); deferred-tax restatement (the #1 private-company restatement source).
- **Trigger + data:** at posting, classify each expense/revenue line for tax character —
  meals (50%), entertainment (0%), penalties/fines, federal tax, §179/bonus vs. book depreciation,
  bad-debt reserve vs. write-off, accruals, prepaids, tax-exempt income. Data: account role, vendor,
  memo, amount, doc. Maintain a running **M-1 bridge** and a **temp/perm classification** as a ledger dimension.
- **Human-in-loop:** AI proposes the tax tag + character; a human (bookkeeper or the CPA at review)
  confirms edge cases; the common cases (a clearly-labeled meal, a clearly non-deductible penalty)
  auto-tag with high confidence, still logged.
- **Audit-defensible because:** each tag cites the Code section / rule and the source facts it read;
  the M-1 bridge is a drill-downable schedule that ties to the GL by construction; every
  reclassification is in the Decision Log with who/when. **A CPA can sign an M-1 whose every line
  traces to a posting.**

### B2. Capex vs. expense misclassification & the depreciation/§179 lifecycle — COMMON CORE

- **Failure prevented:** expensing an asset that should be capitalized (overstates current
  deductions, understates assets — reverses on audit/exam) or capitalizing a repair that should be
  expensed (defers a deduction the client is owed); **missed §179/bonus/de-minimis-safe-harbor
  elections**; assets sold but still depreciating.
- **$ / risk:** tangible-property-regs adjustments on exam; permanently lost deductions if elections
  aren't made timely (they're annual and often irrevocable); overstated fixed assets flagged in audit.
- **Trigger + data:** any payment above a threshold to a capex-suggestive account/vendor
  (equipment, leasehold, software, vehicles) → prompt capitalize-vs-expense with the de-minimis
  safe-harbor ($2,500/$5,000) and repair-vs-improvement (RABI) test. On capitalization, auto-create
  the fixed-asset record, propose useful life + method + §179/bonus eligibility. Track dispositions.
- **Human-in-loop:** AI proposes the classification and the election; **the election itself is a
  human decision** (it's a tax-strategy call and legally the taxpayer's) — present it, don't auto-elect.
- **Audit-defensible because:** the capitalize/expense decision records the safe-harbor threshold and
  RABI factors applied; the fixed-asset subledger ties to the GL control account continuously; every
  election is an explicit, timestamped human approval — exactly what an examiner asks to see.

### B3. Sales/use-tax nexus tripwire — COMMON CORE (segment-weighted to multistate sellers)

- **Failure prevented:** silently crossing economic-nexus thresholds and accruing an
  uncollected-tax liability the seller eats.
- **$ / risk:** six-figure undisclosed liability that surfaces in due diligence; penalties +
  interest; deal re-pricing or breakage. Also income/franchise-tax nexus from payroll/inventory.
- **Trigger + data:** rolling 12-month **revenue and transaction count by ship-to / customer state**
  vs. a maintained per-state threshold table; plus **payroll by state** and **inventory locations
  (3PL/FBA)** for income-tax nexus. Alert at ~80% of threshold, not after breach.
- **Human-in-loop:** AI raises the exposure to `/exceptions` with the state, the threshold, current
  run-rate, and projected breach date; a human decides registration / VDA (voluntary disclosure) /
  taxability analysis. Never auto-register.
- **Audit-defensible because:** the exposure calc shows the exact transactions and states counted and
  the threshold source; it produces a defensible **nexus study** artifact a CPA/SALT specialist can
  review and a board can act on.

### B4. 1099 vendor gap (W-9 / TIN) closure — COMMON CORE

- **Failure prevented:** January W-9 chase; unmatched TINs; backup-withholding exposure; late/incorrect
  1099 penalties; issuing 1099-NEC on card-paid amounts already on a 1099-K (double reporting).
- **$ / risk:** $60–$310 per form penalties (annual cap in the low millions); 24% backup withholding
  the payer becomes liable for; CP2100/B-notice cycles.
- **Trigger + data:** at **vendor creation and first payment**, require W-9 + TIN; run TIN matching;
  flag any vendor approaching **$600 cumulative** in reportable (non-card) payments without a valid
  W-9. Split payments by rail so card/third-party-network amounts are excluded. Year-round readiness dashboard.
- **Human-in-loop:** AI blocks/flags and requests the W-9 (ties into existing Vendor Compliance
  engine); a human can override with reason (logged). Filing is a human-triggered batch.
- **Audit-defensible because:** each reportable determination shows the payments counted, the rail
  split, and the W-9/TIN status with timestamps; the audit trail proves the payer exercised due
  diligence (the penalty-abatement standard).

### B5. Related-party / intercompany integrity — COMMON CORE, and CRITICAL for a multi-entity tenant

- **Failure prevented:** intercompany that doesn't eliminate on consolidation; unbalanced due-to/due-from;
  disguised distributions or loans miscoded as expense; related-party transactions not at arm's length
  or not disclosed; transfer-pricing exposure.
- **$ / risk:** wrong consolidated financials (audit adjustment / restatement); reclassified
  distributions triggering tax; ASC 850 disclosure failures; IRS §482 transfer-pricing adjustments;
  blown K-1s and basis for pass-throughs.
- **Trigger + data:** flag any transaction whose counterparty is a **known related entity/owner**
  (from `core` entity/ownership graph); require the mirror side; run a **continuous intercompany
  matching / elimination** check so due-to = due-from at all times; flag owner-benefit payments.
  (Note: canon §5 makes **11a multi-entity consolidation MANDATORY, top priority** — this control is
  the accounting substance behind that gate.)
- **Human-in-loop:** AI proposes the mirror entry and elimination; a human approves intercompany
  pricing and any owner-related characterization (loan vs. distribution vs. comp).
- **Audit-defensible because:** every intercompany pair is linked and self-eliminating with a visible
  matching status; the related-party graph and disclosure schedule fall out of the ledger — exactly the
  ASC 850 support and consolidation workpaper an auditor demands.

### B6. Revenue & expense cutoff — COMMON CORE (revenue is segment-shaped)

- **Failure prevented:** revenue recognized in the wrong period (before delivery/performance,
  ASC 606), expenses accrued in the wrong period, deferred revenue not established.
- **$ / risk:** overstated income (audit adjustment, covenant breach, tax paid early), or the reverse;
  a classic fraud/error focus in every audit.
- **Trigger + data:** at/near period-end, compare invoice date vs. delivery/performance evidence
  (ship date, job progress, contract milestones); for rev-rec-managed jobs enforce the canon rule —
  **credit Deferred Revenue (2410), not Revenue** — and honor the 9-method rev-rec authority
  (`rev-rec.ts`). Flag large entries within N days of close for cutoff review.
- **Human-in-loop:** AI flags likely-mis-cut items with the evidence; a human confirms the period.
  Rev-rec timing is deterministic (engine-owned), not AI-guessed.
- **Audit-defensible because:** each recognition event links to its performance evidence and the
  method applied; the deferred-revenue rollforward ties to the GL — the auditor's cutoff test is
  pre-answered.

### B7. Unsupported / anomalous journal entries (AU-C 240 JE testing, built-in) — COMMON CORE

- **Failure prevented:** manual entries with no support, round-dollar plugs, entries to unusual
  account pairs, entries posted after close or by unexpected users, entries with blank descriptions —
  the exact population auditors extract to hunt fraud and error.
- **$ / risk:** the mechanism behind most financial-statement fraud and misstatement; expanded audit
  scope and fee when the JE population looks dirty; management-letter comments.
- **Trigger + data:** at posting, score every manual JE on: round-dollar, missing/weak description,
  missing attachment, unusual account combination (e.g., revenue ↔ reserve), timing (post-close /
  weekend / period-end), and preparer identity. Require a reason + support above a materiality threshold.
- **Human-in-loop:** low-risk entries post with logging; higher-risk entries require description +
  attachment + approver before they post. The AI *scores*; it never fabricates support.
- **Audit-defensible because:** the ledger can hand the auditor the **entire manual-JE population
  pre-scored with support attached** — turning JE testing from a sampling exercise into a filtered
  query. This is the feature most likely to make an auditor actively *prefer* MeritBooks clients.

### B8. Audit trail + segregation of duties (the control that underwrites all the others) — COMMON CORE

- **Failure prevented:** inability to prove who did what; SoD violations (same person creates a vendor
  and pays it, or approves and posts); a mutable ledger where closed periods can change.
- **$ / risk:** material-weakness / significant-deficiency findings; expanded substantive testing
  (higher fee); loss of auditor reliance on controls; fraud exposure.
- **Trigger + data:** enforce **preparer ≠ approver** on money movement (canon already: DB CHECK +
  service + explicit human release); immutable period locks (`enforce_period_lock`); full
  `audit_log` / `core.action_log` with human attribution (GL attribution cols are null-for-Clerk by
  design — human identity lives in the action log). Continuously test SoD across role assignments and flag conflicts.
- **Human-in-loop:** the control *is* the human posture — the AI monitors and reports SoD conflicts;
  humans hold the approvals. Per canon, **SoD applies to the AI itself**, and money-movement authz
  must reconcile to `core.memberships/roles` (note: `canApprove` stopgap flagged in §3 — this control
  can't be fully defensible until that reconciliation lands).
- **Audit-defensible because:** every posting carries preparer, approver, timestamp, and source; closed
  periods are provably immutable; the SoD matrix is generated from live role data. This is precisely the
  "controls understanding" an auditor documents first — hand it to them prebuilt.

### B9. PBC-list / tie-out automation (assurance UX layer) — COMMON CORE

- **Failure prevented:** the weeks-long, error-prone PBC-document scramble and manual FS→TB→GL→source
  tie-out.
- **$ / risk:** direct audit-fee inflation and management time; tie-out breaks that delay opinions.
- **Trigger + data:** because source docs are attached **at posting** and every FS figure traces to
  the GL, generate: standard PBC deliverables (TB, GL detail, agings, fixed-asset roll, debt/covenant
  schedules, rec packages, selected-JE support) and a **continuous tie-out** that flags any FS/TB/GL/source break.
- **Human-in-loop:** auditor-driven; the system produces evidence on request. Read-only export; no
  auto-representations to the auditor.
- **Audit-defensible because:** the evidence is the ledger's own immutable records with provenance —
  not a re-keyed workpaper. **This is the feature a CFO buys the platform for after one painful audit.**

---

## PART C — COMMON-CORE vs. SEGMENT-SPECIFIC (build sequencing guidance)

**Common core (every tenant, build once, highest leverage):** B1 book-to-tax tagging, B2 capex/
depreciation lifecycle, B4 1099/W-9, B5 related-party/intercompany, B6 cutoff, B7 anomalous-JE
detection, B8 audit trail/SoD, B9 PBC/tie-out. These are *universal ledger hygiene* and map directly
to canon primitives already in place (deterministic posting, period locks, Decision Log, Vendor
Compliance, multi-entity consolidation as top-priority gate 11a).

**Segment-specific (config/flags, not new engines):**

- **Multistate / e-commerce / SaaS:** B3 nexus is make-or-break; SaaS-taxability and marketplace-
  facilitator rules; heavy 1099-K interplay.
- **Construction / long-term contracts (directly relevant to a Merit-type tenant):** percentage-of-
  completion vs. completed-contract, §460 look-back, retainage, WIP schedules, job-cost cutoff — the
  9-method rev-rec authority and job-costing gate (canon §5, GATE 6) carry this.
- **Professional services:** cash-vs-accrual M-1 swings, WIP/unbilled, owner reasonable-comp scrutiny.
- **Inventory / manufacturing:** §263A UNICAP capitalization, LCM, obsolescence reserves, standard-
  cost variances — big book-to-tax and cutoff surface.
- **Real estate (Merit-adjacent):** cost segregation, §1031 exchanges, passive-activity rules,
  partnership 704(b)/(c), depreciation recapture.
- **Nonprofit / regulated:** functional-expense allocation, restricted funds, single-audit — different
  assurance regime entirely.

**Sequencing recommendation:** the common-core items are *dimensions and checks layered onto the
posting path you already own* — they don't require the segment engines to exist first. Ship B7/B8/B9
early (they're mostly surfacing provenance you already capture and are the clearest assurance ROI),
then B1/B2/B4/B5/B6 as the tax/close moat, with B3 turned on for multistate tenants.

---

## PART D — THE ONE THING TO INTERNALIZE

A CPA signs their name and assumes **legal liability** for an opinion or a return. They will only rely
on an AI's output if it is **traceable, rule-cited, confidence-scored, and human-approved through an
immutable trail** — the canon's *"AI proposes facts, deterministic engine posts, human approves,
Decision Log records"* posture is *exactly* the standard, so build every feature above to inherit it
verbatim. **An owned ledger that is audit-defensible by construction is not a feature — it is the
reason a CPA tells their client to switch off QuickBooks.** The tax and audit motions above are the
proof points that make "autonomous accounting workforce + supervision layer" mean something a
professional will stake their license on.
