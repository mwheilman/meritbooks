# Feature Product Brief — Financial Control Exception Library

**Module:** Financial Control Exception Library (Books, Module 1 of 12) — **GATE 9 (AI moat)**, with exception
classes homed across GATE 8 / 11a / 7 / 11d / 6.
**Author:** Lead AI product architect + adversarial reviewer (Rule 13 FPB authorship)
**Date:** 2026-08-01 (Session 40 canon)
**Status of module today:** Does not exist as a unified module. The *primitives* exist (Vendor Compliance risk
engine, Reconciliation autopilot, 13-Week Cash Forecast, `/exceptions` queue, `scoreToTier`, `core.action_log`);
several exception *classes* are latent inside those. **Functional — none.** ZERO modules are Complete.
**Completion standard (Rule 13):** "Complete" ≠ renders/works/real-data (that is the functional minimum). Complete =
**meets every dimension of this approved brief**, benchmarked against QBO/Sage/best-in-class continuous-control
tooling with named deltas closed or explicitly deferred with reason, and every acceptance criterion below passing.

**Gate dependencies:** **Prereq — GATE 3 (AI proposal layer, live-stamp pending), GATE 5 (confidence routing/learning),
GATE 10 (RBAC/identity — the standing NO-GO gate, tasks #9/#28/#29).** Consumes GATE 2 (posting engine, DONE),
GATE 12.0 (Plaid feed, DONE). Individual exception classes further depend on their home gate (IC → 11a; covenant/cash →
7; nexus → 11d; cutoff/rev-rec → 6). This module **must not ship a class whose home gate is not DONE** — it surfaces
what the ledger already knows, and fabricating a control on absent data violates "demonstrated, not asserted."

---

## §0. Scope, grounding, and canon reconciliation

**What this module IS.** An always-on, AI-assisted **continuous control layer** that reconciles the owned ledger on a
cadence and surfaces **$-quantified exceptions** — each with a detection signal, an evidence trail, a confidence tier,
a dollar-at-risk, and a **one-click remediation the AI drafts (never auto-applies for money/filings)** — into the
existing `/exceptions` queue. It is the Books analogue of the MeritProjects **Billing Integrity Auditor**: where the
Auditor polices the *operations→ledger seam* (every `JOB_COST` gets billed; every `JOB_BILLING` ties to real cost),
this polices the *ledger's own internal integrity.* It is the surface that makes a controller, a CPA, and an
accounting manager willing to **sign** — the supervision/trust layer that the canon says *is the product* (§1.6).

**What this module is NOT.** It is **not** a new posting path, a new money-movement rail, or a generative accountant.
It never authors a debit/credit (the deterministic engine does that), never moves money, never files a return or
covenant certificate, never auto-registers for tax, never deletes a record. It **detects and drafts**; humans decide.

**Canon invariants this module inherits verbatim (CANON-ANCHOR):**
- **AI proposes FACTS; the deterministic engine posts; a human approves; every AI action → Decision Log** (§3). An
  exception is a *proposed fact* ("this looks like a duplicate of bill #4471, $12,400 at risk") + a *drafted remediation*
  ("void draft payment / merge vendor"); a human with the right Core role acts. **Auto-post OFF by default**; any
  auto-remediation is a per-tenant/per-task autonomy dial that starts OFF and is loosened only as the machine earns it.
- **SoD binds the AI itself** (§3): the agent that *detects/proposes* an exception cannot also *approve/apply* its own
  remediation. Money-movement remediation stays **preparer ≠ approver ≠ releaser**, reconciled to
  `core.memberships/roles` — **not** the `core.employees.role` stopgap (§3 flag; tasks #27/#29).
- **On ambiguity, fail closed** — surface the exception and ask; never guess-and-suppress. A missed exception that
  reaches the close costs more trust than a hundred correct catches earn (accounting-manager B10).
- **All money is bigint cents**; `$-at-risk` is cents (`formatMoney`). **Account references by role, not number** (COA
  is 137, per-tenant; §2). **RLS `org_id = get_org_id()`** on every new table.
- **Master data in `core`, ledger in `public`; no PostgREST embeds across the boundary** — stitch via `fetchCoreMap`.
- **AI routes only through `@meritbooks/core-ai`** (metered to `core.ai_usage_log`, tenant budget enforced across the
  whole suite); this module holds no Anthropic key and makes no direct API call (§2).

**Reuses the trust spine already built (do not rebuild):** `core.action_log` (append-only, machine-vs-human
attribution), `scoreToTier` (auto/review/escalate tiering with per-tenant `getTierPolicy`), the `/exceptions` queue and
its routing, the per-task autonomy dial, and the deterministic engine's own gates (`check_journal_balance`,
`enforce_period_lock`, `enforce_coa_approval`, control accounts, `validate_dimensions`).

**The central design risk (state it up front):** an exception engine that **cries wolf gets muted**, and a muted
control is worse than none — it manufactures false assurance. Therefore **tiering, $-materiality thresholds,
per-class suppression/learning, and calibrated confidence are load-bearing**, not polish. A false *positive* must be a
cheap dismissed queue item; a false *negative* (a real exception never raised) is the true failure mode. The engine is
evaluated on **precision-at-tier and recall on seeded exceptions**, never on raw exception count or automation rate
(accounting-manager: "fast and wrong is the failure mode that ends careers").

**Cross-suite de-dup contract (JOB_COST/JOB_BILLING seam).** Where an exception has both an ops cause and a ledger
symptom (a cost Projects flags as unbilled *and* Books flags as uncategorized-leakage), it is **one** exception,
deduplicated on `core.events.source_ref`, owned by whichever module is authoritative for the remediation (Books for a
GL/payment fix; Projects for a billing fix). Neither module reads the other's tables; the seam is `core.events`
(FROZEN v3). See Dimension 11.

**Retired — do not touch:** chargebacks / overhead-rate / labor-classification exceptions (retired Session 12, §2).

---

## §1. The exception classes (the heart of the module)

The enumerated control set the five briefs surfaced. Each class states: **detection rule/signal · data source ·
confidence/tier · $-at-risk basis · the one-click remediation the AI drafts · human-in-loop · scope.** Money-movement
and filing remediations are **draft-only**; the human (right Core role, SoD-enforced) applies.

> **Tiering key (via `scoreToTier`):** **ESCALATE** = hard-stop / block the underlying action, route to an owner;
> **REVIEW** = queued proposal, non-blocking; **AUTO** = advisory, sampled, eligible for the autonomy dial only for the
> safest classes. Tier is a function of confidence × $-materiality × class-risk, tunable per tenant.

### EC-1 — Duplicate & duplicate-vendor payments  ★ [common-core]
- **Signal:** fuzzy match (vendor + invoice# + amount + date) of a bill/payment against all prior payments and the
  feed; **vendor-master dedupe** on name/EIN/bank-account/remit-address; **new-or-changed vendor bank detail** flag.
- **Data:** `bills`, `payments`, `bank_transactions`, `core.vendors`. **Tier:** ESCALATE (blocks the pay; banking-change
  = always ESCALATE — the #1 BEC vector). **$-at-risk:** the full duplicate payment amount (~0.1–0.5% of AP spend
  industry loss rate; $50k–$250k/yr on $50M AP).
- **Remediation (draft):** "void the draft payment / merge vendor record #B into #A / hold pending banking-change
  verification." **HITL:** human chooses merge / discard-as-dup / genuinely-different; **never auto-deletes; never
  auto-pays a banking change; SoD on release.**

### EC-2 — Missed / mis-estimated accruals & deferrals  ★ [common-core; deep rev-rec deferral: segment]
- **Signal:** an *expected* recurring accrual absent this period (a vendor that bills monthly went silent);
  open-PO/received-not-invoiced with no accrual; a prepaid not amortized; deferred revenue past its release date.
- **Data:** recurring-accrual register, PO/receipt data, prepaid & deferred-revenue schedules, prior-period history.
  **Tier:** REVIEW (estimate = judgment). **$-at-risk:** the accrual's run-rate estimate; a single missed six-figure
  accrual can flip a covenant.
- **Remediation (draft):** a balanced accrual JE with its basis + confidence, ready to post through the engine on
  approval. **HITL:** controller reviews the estimate; **AI never books an estimate silently.** The high-value catch is
  the *missing* accrual, not the one already booked.

### EC-3 — Intercompany out-of-balance  ★ [segment: multi-entity]
- **Signal:** an IC receivable/due-from in Entity A with no matching payable/due-to in Entity B; an IC pair that does
  not net to zero; a residual after elimination.
- **Data:** IC-tagged transactions with counterpart entity + shared IC id; the matched-pair register. **Tier:**
  ESCALATE for consolidation (consolidation refuses to close over-threshold); REVIEW for timing differences.
  **$-at-risk:** misstated consolidated equity/EBITDA → wrong covenant math; audit adjustments; days of close lost.
- **Remediation (draft):** the mirror entry when the pair is provable; else an IC-imbalance report per pair. **HITL:**
  AI auto-books the mirror **only when it can prove the pair** (and even then behind the dial); humans adjudicate
  genuine timing. **Home gate 11a (MANDATORY, top priority) — the accounting substance behind that gate.**

### EC-4 — Unposted / uncategorized cost leakage  ★ [common-core]
- **Signal:** age of items in suspense/clearing/"Ask My Accountant"; bank/CC lines with no GL coding beyond N days.
- **Data:** suspense/clearing account balances, uncoded `bank_transactions`, vendor-history model. **Tier:** REVIEW;
  the aggregate blocks close (Dimension 10). **$-at-risk:** the uncoded dollar total (often 1–5% of transactions);
  mis-stated departmental/entity P&L → decisions on bad numbers.
- **Remediation (draft):** re-propose coding as context arrives (a later receipt, a vendor pattern). **HITL:**
  approve/redirect; **close is gated on this queue clearing.** Grounds on the existing bank-feed engine (catalog A1/D1).

### EC-5 — Unreconciled aging (AR/AP subledger vs GL, and true bank rec)  ★ [common-core]
- **Signal:** subledger control-account balance ≠ GL; a "paid" bill still open; stale AR at full value; a bank item
  that never clears; a non-zero bank-rec difference at period end.
- **Data:** AR/AP subledgers, GL control accounts, `bank_reconciliations`, aging buckets. **Tier:** ESCALATE at close;
  REVIEW intra-month. **$-at-risk:** overstated assets + bad-debt surprise; borrowing-base overstated (lending against
  aged/ineligible AR is a covenant violation).
- **Remediation (draft):** propose reserve/write-off candidates with rationale; surface the reconciling item. **HITL:**
  controller approves write-offs/reserves (judgment + SoD). **Coordinates with `FPB-bank-reconciliation.md`** — the
  bank-rec-difference slice is that module's; this class covers the subledger-to-GL tie and aging.

### EC-6 — Revenue not recognized on schedule  ★ [segment: contract/subscription/project]
- **Signal:** deferred revenue past its release date not released; a milestone/POC due not booked; a subscription not
  ratably recognized; billing inconsistent with the rev-rec schedule.
- **Data:** per-contract rev-rec method/schedule (`rev-rec.ts`, 9 methods), deferred-revenue + unbilled/contract-asset
  roll-forwards, progress inputs. **Tier:** REVIEW. **$-at-risk:** ASC 606 misstatement / restatement risk; distorted
  EBITDA feeding covenants + valuation.
- **Remediation (draft):** the recognition entry per the **deterministic** rev-rec engine (engine owns timing).
  **HITL:** human approves POC estimates/overrides; **AI never invents % complete.** Managed job credits **Deferred
  Revenue 2410**, not Revenue (§3). Home gate 6.

### EC-7 — Sales-tax nexus drift  [segment: multistate/e-comm/SaaS]
- **Signal:** rolling 12-mo revenue + transaction count by ship-to/customer state vs a maintained per-state threshold
  table crosses ~80%; plus payroll-by-state and inventory (3PL/FBA) locations for income/franchise nexus.
- **Data:** revenue by state, transaction counts, `core` payroll/location, threshold table. **Tier:** ESCALATE
  (existential-$). **$-at-risk:** an uncollected-tax liability the **seller eats** (can't retro-bill) + penalty +
  interest — a six-figure undisclosed liability that surfaces in diligence.
- **Remediation (draft):** a defensible **nexus-study artifact** (states, transactions counted, threshold source,
  projected breach date). **HITL:** human decides register / VDA / taxability analysis; **never auto-registers.**
  Home gate 11d.

### EC-8 — 1099 / W-9 gaps  ★ [common-core US]
- **Signal:** a reportable vendor (unincorporated, ≥$600 cumulative in **non-card** payments) without a valid W-9/TIN;
  TIN mismatch; a 1099-NEC about to double-report a card/3rd-party-network amount already on a 1099-K.
- **Data:** vendor payments split by rail, W-9/TIN status (`core.vendors` + Vendor Compliance engine). **Tier:** REVIEW
  (payment-gate = ESCALATE if configured). **$-at-risk:** 24% backup withholding the payer becomes liable for; $60–$310
  per-form penalties.
- **Remediation (draft):** auto-request the W-9 + reminders; assemble the annual 1099 file. **HITL:** human clears
  exceptions and files (filing is a human-triggered batch). Extends the built Vendor Compliance engine.

### EC-9 — Book-to-tax differences (M-1/M-3 + ASC 740 temp/perm)  ★ [common-core]
- **Signal:** an expense/revenue line whose tax character (meals 50%, entertainment 0%, penalties/fines, federal tax,
  §179/bonus vs book depreciation, bad-debt reserve vs write-off, prepaids) is untagged or inconsistent; an M-1 that
  doesn't foot; a temporary difference drifting from the GL.
- **Data:** account role, vendor, memo, amount, doc; the running M-1 bridge + temp/perm dimension. **Tier:** REVIEW/AUTO
  (clear cases auto-tag, logged). **$-at-risk:** wrong provision; **deferred tax is the #1 private-company restatement
  source**; book NI moves 5–25% between handoff and adjusted.
- **Remediation (draft):** the tax tag + M-1 bridge line, each **citing the Code section + source facts** (audit-
  defensible). **HITL:** CPA confirms edge cases at review. Home gate 7/8.

### EC-10 — Anomalous / unsupported journal entries (AU-C 240)  ★ [common-core]
- **Signal:** a manual JE scored on round-dollar, missing/weak description, missing attachment, unusual account pair
  (revenue ↔ reserve), timing (post-close/weekend/period-end), unexpected preparer.
- **Data:** every manual JE + `core.action_log` preparer identity. **Tier:** ESCALATE above materiality without support;
  REVIEW otherwise. **$-at-risk:** the mechanism behind most FS fraud/misstatement; a dirty JE population expands audit
  scope + fee.
- **Remediation (draft):** require description + attachment + approver before the high-risk entry posts. **HITL:**
  low-risk posts with logging; **AI scores, never fabricates support.** Hands auditors the whole manual-JE population
  pre-scored (CPA B7).

### EC-11 — Covenant drift  [segment: leveraged/bank-financed]
- **Signal:** a covenant (DSCR, FCCR, leverage/debt-to-EBITDA, current ratio, min liquidity, TNW) whose headroom on
  actuals + forecast shrinks past a graduated threshold.
- **Data:** machine-readable covenant defs per credit agreement, live + forecast GL, borrowing-base feed. **Tier:**
  amber = REVIEW, red = ESCALATE. **$-at-risk:** waiver fees $25k–$250k; default-rate interest; acceleration;
  cross-default. Existential — discovered post-quarter is too late to cure.
- **Remediation (draft):** the compliance certificate + a headroom-restoration options memo. **HITL:** CFO reviews and
  **signs — never auto-file a certification.** Home gate 7. Bias conservative (a false amber is cheap; a false green is
  catastrophic).

### EC-12 — Cut-off errors  ★ [common-core; revenue side segment-shaped]
- **Signal:** an entry within N days of period-end whose invoice/bill date disagrees with delivery/performance evidence
  (ship date, job progress, milestone); a large entry landing just across the cut.
- **Data:** entries near close, ship/progress/milestone evidence, `rev-rec.ts`. **Tier:** REVIEW. **$-at-risk:**
  income in the wrong period → audit adjustment, covenant breach, tax paid early; a classic fraud/error audit focus.
- **Remediation (draft):** propose the correct period / a reversing-and-reposting pair (respecting period lock).
  **HITL:** human confirms the period. Home gate 6 for the progress-evidence side.

### EC-13 — Re-expensed settlements  ★ [common-core]
- **Signal:** a payment posted as **DR expense** where it should clear a liability — DR AP / CR Cash for a bill payment,
  DR Credit Card Payable / CR Cash for a CC statement payment, DR Cash / CR AR for a customer payment (§3).
- **Data:** the posting + the open obligation it should have cleared. **Tier:** ESCALATE (double-counts expense +
  overstates the liability). **$-at-risk:** the settlement amount, double-counted in P&L. A top error pattern the
  accounting manager hunts (A2/B4).
- **Remediation (draft):** the corrected clearing entry (reverse the re-expense, clear the obligation). **HITL:** human
  approves the correction. This is a pure ledger-integrity check the owned GL is uniquely able to make at posting time.

**Class → home-gate summary:** EC-1/EC-2/EC-4/EC-5/EC-8/EC-9/EC-10/EC-12/EC-13 are **common-core**; EC-3 → 11a;
EC-6/EC-12(rev) → 6; EC-7 → 11d; EC-11 → 7. The module ships **common-core classes first** and lights up segment
classes as their home gate goes DONE and the tenant's shape warrants them (a single-entity, debt-free, single-state
tenant simply never sees EC-3/EC-7/EC-11).

---

## §2. Sixteen-dimension brief

Each dimension: **Purpose · What best-in-class does · Current MeritBooks state · Named deltas · Testable acceptance criteria.**

### Dimension 1 — Data captured (the exception record + its evidence)
**Purpose:** An exception is an auditable object: class, subject transaction(s), detection signal, confidence, tier,
$-at-risk, state, owner, evidence links, and the drafted remediation — immutable once resolved.
**Best-in-class:** continuous-controls-monitoring tools (e.g. FloQast/Trintech-style) persist each exception with a
full evidence trail and resolution history.
**Current state — MISSING (unified):** `/exceptions` exists and routes items; Vendor Compliance / Reconciliation
autopilot write class-specific exceptions ad hoc. There is **no single `control_exceptions` table** with a class enum,
$-at-risk, tier, evidence, and lifecycle.
**Named deltas:**
- **D1.1** — no unified `control_exceptions` record (class, `subject_ref(s)`, `signal`, `confidence`, `tier`,
  `amount_at_risk_cents`, `status`, `owner`, `detected_at`, `resolved_at`, `resolution`, `dedup_key`).
- **D1.2** — no persisted evidence links (the transactions/accounts/docs the signal read) for drill-down.
- **D1.3** — no `dedup_key` (e.g. `source_ref`) to collapse the same underlying issue across scans and across the
  Projects seam.
**Acceptance:** AC1.1 every exception persists as an immutable-once-resolved record with class, subject refs, signal,
confidence, tier, $-at-risk (cents), state, owner, evidence links, drafted remediation; AC1.2 each record drills to the
exact ledger rows/accounts/docs its signal read; AC1.3 a `dedup_key` prevents the same underlying issue appearing twice
(across scans and across the JOB_COST/JOB_BILLING seam).

### Dimension 2 — Detection engine (scan cadence + signal computation)
**Purpose:** Continuously (or on trigger) evaluate every class's rule over the ledger and emit/refresh exceptions.
**Best-in-class:** event-driven + scheduled scans; incremental so a re-scan doesn't re-alert resolved items.
**Current state — PARTIAL/scattered:** class logic is embedded in feature routes, not a shared scan framework.
**Named deltas:**
- **D2.1** — no shared detection framework (a per-class detector interface: `scan(orgId, period) → Exception[]`) so
  classes are added uniformly and run on a cadence.
- **D2.2** — no incremental/idempotent scan (re-running must update, not duplicate; resolved items must not re-open
  without a genuine new signal).
- **D2.3** — no trigger wiring (post-a-bill → EC-1; post-a-JE → EC-10/EC-13; near-close → EC-12; nightly → EC-2/EC-4/
  EC-5/EC-7/EC-11).
**Acceptance:** AC2.1 a shared detector interface runs every registered class on a schedule + on the relevant trigger;
AC2.2 re-scanning is idempotent (keyed on `dedup_key`) — no duplicate exceptions, no spurious re-open; AC2.3 each class
is independently toggleable per tenant/segment and only runs when its home gate is DONE and its data exists.

### Dimension 3 — Confidence & $-materiality routing (the anti-cry-wolf core)
**Purpose:** Route each exception by confidence × $-at-risk × class-risk so humans see the right things; suppress noise.
**Best-in-class:** materiality-scaled scrutiny (the accounting manager's A2 instinct) — a $12 charge and a $180k accrual
are not reviewed alike.
**Current state — PARTIAL:** `scoreToTier` + per-tenant `getTierPolicy` exist for matching; not generalized to exceptions.
**Named deltas:**
- **D3.1** — no per-class **$-materiality threshold** (below it, an exception is logged-not-surfaced or auto-sampled).
- **D3.2** — no **suppression/learning** (a repeatedly-dismissed pattern should stop surfacing at the same tier; a
  confirmed one should escalate faster) — the mute-avoidance mechanism.
- **D3.3** — no **calibration tracking** (does "90% confidence" actually mean ~90% right, per class, over time).
**Acceptance:** AC3.1 tier = f(confidence, $-at-risk, class-risk) via `scoreToTier` with per-tenant/per-class thresholds;
AC3.2 sub-materiality exceptions are sampled/logged, not surfaced at full weight; AC3.3 a dismissed-pattern suppression
loop reduces recurrence noise, and a class's calibration is measured over time (feeds Dimension 16 metrics).

### Dimension 4 — Remediation drafting (the one-click fix)
**Purpose:** Every exception carries the *drafted* fix so resolution is one reviewed click, not a research project.
**Best-in-class:** proposed adjusting entries / merge actions / draft communications attached to the exception.
**Current state — MISSING (unified):** class features draft some actions (Vendor Compliance drafts the W-9 request);
no consistent "draft remediation on every exception."
**Named deltas:**
- **D4.1** — no consistent remediation object per class (a balanced JE draft for EC-2/EC-5/EC-6/EC-12/EC-13; a
  merge/void for EC-1; a request/artifact for EC-7/EC-8/EC-11).
- **D4.2** — remediations that post to the GL must route through `postJournalEntry` (balanced, period-lock-respecting,
  role-resolved accounts) — never a bespoke write.
- **D4.3** — no "explain the fix" (the remediation must show its accounting so a human can approve the *reasoning*).
**Acceptance:** AC4.1 every exception has a drafted remediation typed to its class; AC4.2 any GL-posting remediation
routes through the deterministic engine (balanced, respects `enforce_period_lock`, resolves accounts **by role**);
AC4.3 money-movement/filing remediations are **draft-only** and require the SoD-correct human to apply; AC4.4 the
remediation shows its accounting/authority so the human approves the reasoning, not a black box.

### Dimension 5 — Triage lifecycle (the exception state machine)
**Purpose:** An exception moves through a controlled lifecycle with attribution at every hop.
**Best-in-class:** OPEN → ACKNOWLEDGED → IN_PROGRESS → REMEDIATED / DISMISSED(with reason) / SUPPRESSED, with recurrence
tracking and reassignment.
**Current state — PARTIAL:** `/exceptions` supports accept/reject on some items; no unified lifecycle across classes.
**Named deltas:**
- **D5.1** — no shared state machine + owner assignment across classes.
- **D5.2** — no dismissal-with-reason (required — a silent dismissal defeats the control) or SUPPRESS-with-expiry.
- **D5.3** — no recurrence link (this exception is the 4th time this vendor/account tripped) — a QC + training signal.
**Acceptance:** AC5.1 every exception follows a shared state machine with owner + timestamps; AC5.2 DISMISS requires a
reason and SUPPRESS an expiry, both logged to `core.action_log`; AC5.3 recurrence is tracked and surfaced.

### Dimension 6 — Autonomy dial (auto-remediation, OFF by default)
**Purpose:** Let a tenant, per class, allow the safest tier to auto-remediate — but only after the machine earns it.
**Best-in-class:** graduated autonomy with a demonstrated track record (accounting-manager B8/B9).
**Current state — MISSING.**
**Named deltas:**
- **D6.1** — no per-tenant/per-class autonomy dial (default OFF, canon §3 "never a global let-the-AI-run switch").
- **D6.2** — no SoD guard on auto-remediation (the detector agent ≠ the applier).
- **D6.3** — money-movement, banking-change, filings, and any ESCALATE-tier class are **never** dial-eligible.
**Acceptance:** AC6.1 the dial is per-tenant/per-class, defaults OFF, and can only enable AUTO-tier auto-remediation
with SoD on the AI + full Decision-Log audit; AC6.2 money-movement/banking-change/filing/ESCALATE classes are
hard-excluded from the dial; AC6.3 an immediate, granular (class/tenant/global) **kill-switch** drops the module to
propose-only without stopping the books (accounting-manager B10).

### Dimension 7 — Lifecycle, audit & reversibility
**Purpose:** Every detection, tier assignment, human decision, and applied remediation is attributable and reversible.
**Current state — PARTIAL:** `core.action_log` exists; not consistently written by all class paths.
**Named deltas:**
- **D7.1** — not every class writes proposal + human decision to `core.action_log` with actor = human OR AI+version.
- **D7.2** — applied remediations that post GL must be reversible via the normal reversing-entry path (never a mutation).
- **D7.3** — no field-level trail on suppression/threshold changes (those are themselves auditable control config).
**Acceptance:** AC7.1 detection, tiering, decision, and remediation each write to `core.action_log` with correct
machine-vs-human attribution; AC7.2 an applied posting-remediation is reversible with a full trail; AC7.3 threshold /
suppression / dial changes are audited config events.

### Dimension 8 — Auditor / assurance evidence pack (the assurance ROI)
**Purpose:** Turn the exception history into the artifacts a CPA/auditor asks for — the CPA brief's biggest selling point.
**Best-in-class:** the PBC list becomes a query; JE testing becomes a filtered export (CPA B7/B9).
**Current state — MISSING.**
**Named deltas:**
- **D8.1** — no export of the pre-scored manual-JE population (EC-10) for AU-C 240 testing.
- **D8.2** — no exception-history / control-operating-effectiveness report (what was caught, when, by whom resolved).
- **D8.3** — no tie-out artifact linking each exception to its source evidence for a PBC pull.
**Acceptance:** AC8.1 the module exports the pre-scored manual-JE population with support status; AC8.2 a
control-effectiveness report (exceptions by class, detection→resolution time, $ prevented) exports to PDF/XLSX; AC8.3
every exception's evidence is retrievable read-only for a PBC request.

### Dimension 9 — Exception surfaces & UX
**Purpose:** The operator sees exceptions **lowest-confidence/highest-$ first**, drills to evidence, acts in one click.
**Current state — PARTIAL:** `/exceptions` exists; not unified across classes, no $-sort, no evidence drill.
**Named deltas:** D9.1 no unified `/exceptions` view across all classes with class filter + $-sort + tier badges; D9.2
no side-by-side evidence + drafted remediation panel; D9.3 no per-entity/per-period scoping in the view.
**Acceptance:** AC9.1 a unified `/exceptions` surface sorts by tier then $-at-risk, filters by class/entity/period, and
renders loading/empty/populated/error; AC9.2 each row drills to evidence + the drafted remediation with a one-click
(SoD-gated) apply; AC9.3 no dead controls; destructive/apply actions confirm (Rules 3–5).

### Dimension 10 — Period-close gate integration
**Purpose:** A period must not HARD_CLOSE with open blocking (ESCALATE-tier) exceptions — the whole point of a control layer.
**Current state — PARTIAL:** `fiscal_periods` + `close_checklists` exist; exceptions are not a close gate.
**Named deltas:** D10.1 no close-checklist auto-verify item reading open-ESCALATE-exception count for the entity/period;
D10.2 no per-entity exception roll-up in the close grid (open by class, $ at risk); D10.3 uncategorized-leakage (EC-4)
and unreconciled-aging (EC-5) not wired as blocking close conditions.
**Acceptance:** AC10.1 a close-checklist item auto-verifies zero open ESCALATE exceptions (or explicit override + reason
+ audit) before HARD_CLOSE; AC10.2 the close grid shows per-entity open exceptions by class + $-at-risk; AC10.3 close is
blocked while EC-4/EC-5 exceed their thresholds (respecting `enforce_period_lock`).

### Dimension 11 — QBO / Sage / best-in-class benchmark (Rule 14, NAMED DELTAS)
**Purpose (mandatory):** Itemize what the market does that MeritBooks must **match** or **beat**. QBO/Sage have *point*
checks (duplicate-bill warning, basic bank rules); dedicated CCM tools (FloQast/Trintech/Vic.ai/AppZen) do continuous
control but **as a bolt-on that must reconcile back to the GL.** MeritBooks' moat: the control runs **inside the owned
ledger** — no reconciliation boundary, evidence attached at posting, remediation posts through the same deterministic
engine, and the JOB_COST/JOB_BILLING seam is native (the Billing Integrity Auditor's Books mirror).

| # | Capability | QuickBooks Online | Sage (Intacct/50) | Dedicated CCM bolt-on | MeritBooks target | Verdict |
|---|---|---|---|---|---|---|
| X1 | Duplicate-bill/payment warning (EC-1) | Basic exact-match warning | Basic | Strong fuzzy + fraud | Fuzzy + vendor-master dedupe + banking-change block + SoD | **BEAT** |
| X2 | Missed/expected-accrual detection (EC-2) | No | Partial (recurring) | Some | Detects the *absent* expected accrual | **BEAT** |
| X3 | Intercompany out-of-balance (EC-3) | Weak | Yes (Intacct) | Some | Native IC pairing + auto-mirror behind dial | **BEAT** (via 11a) |
| X4 | Uncategorized/leakage + close gate (EC-4) | Uncategorized report | Yes | Some | Aged leakage as a **blocking** close gate | **BEAT** |
| X5 | Subledger↔GL / aging tie (EC-5) | Manual | Yes | Yes | Continuous three-way tie + reserve proposals | **MATCH→BEAT** |
| X6 | Rev-rec-on-schedule (EC-6) | Add-on | Yes (Intacct) | n/a | Native 9-method rev-rec + release detection | **BEAT** (via 6) |
| X7 | Sales-tax nexus tripwire (EC-7) | Add-on (Avalara) | Add-on | Specialist tools | Native rolling tripwire + nexus-study artifact | **MATCH** (defer to 11d) |
| X8 | 1099/W-9 readiness (EC-8) | Basic 1099 | Basic | AppZen-class | Year-round rail-split readiness + auto-chase | **BEAT** |
| X9 | Book-to-tax tagging (EC-9) | No | Partial | Tax specialist | M-1 bridge as a ledger dimension, Code-cited | **BEAT** |
| X10 | Anomalous-JE testing (EC-10) | No | Audit-trail report | Yes (audit tools) | Pre-scored manual-JE population at posting | **BEAT** |
| X11 | Covenant drift (EC-11) | No | No | FP&A tools | Daily covenant + forecast + draft certificate | **BEAT** (via 7) |
| X12 | Cut-off error detection (EC-12) | No | Partial | Audit tools | Near-close evidence-vs-date flagging | **BEAT** |
| X13 | Re-expensed-settlement detection (EC-13) | No | No | No | Native owned-ledger settlement-integrity check | **BEAT (unique)** |
| X14 | Remediation posts through one engine | n/a | Partial | No (bolt-on re-keys) | Every fix routes `postJournalEntry` | **BEAT** |
| X15 | Evidence attached at posting (PBC) | Weak | Partial | Re-collected | Native — PBC becomes a query | **BEAT** |
| X16 | Continuous, not point-in-time | No | Partial | Yes | Yes, inside the GL | **MATCH→BEAT** |

**Where MeritBooks BEATS (the moat):** the whole set runs **inside the owned ledger** (no reconcile boundary, evidence
native, remediation through one deterministic engine), the *missing-accrual* and *re-expensed-settlement* catches are
things bolt-ons structurally can't see, and the auditor evidence pack (X10/X15) turns an audit into a query. Parity
items (X5/X7/X16) are table stakes; X7 defers to GATE 11d.

### Dimension 12 — Roll-up module-level acceptance gates
Beyond per-dimension ACs, the module is **Complete** only when:
- **AC-M1 (recall)** — a seeded-exception test fixture (one seeded instance of every common-core class) is detected at
  the correct tier with the correct $-at-risk; **no seeded exception is missed** (recall = 1.0 on the fixture).
- **AC-M2 (precision/anti-cry-wolf)** — a clean-ledger fixture produces **zero** ESCALATE exceptions and no more than
  the configured sub-materiality sample of REVIEW items (false-positive budget asserted).
- **AC-M3 (isolation)** — a tenant-isolation test proves org B never sees or acts on org A's exceptions (RLS on
  `control_exceptions` and every scan route).
- **AC-M4 (determinism)** — every posting-remediation posts balanced through `postJournalEntry`, respects
  `enforce_period_lock`, resolves accounts by role, and is reversible (schema-contract + settlement-chain tests: an
  EC-13 fix produces DR AP / CR Cash, never a re-expense).
- **AC-M5 (SoD/identity)** — the detector agent cannot approve/apply its own remediation; money-movement remediation is
  preparer≠approver≠releaser reconciled to `core.memberships/roles` (**not** `core.employees.role`); denied requests
  return `permissionDenied`.
- **AC-M6 (audit)** — detection, tiering, decision, remediation, suppression, and dial/threshold changes all write to
  `core.action_log` with correct machine-vs-human attribution; the log is append-only.
- **AC-M7 (states/Rules 3–5)** — every surface renders loading/empty/populated/error; apply/dismiss confirm; lists
  paginate; no dead controls.
- **AC-M8 (dedup/seam)** — an exception with both an ops cause and a ledger symptom appears **once**, deduplicated on
  `source_ref` across scans and across the JOB_COST/JOB_BILLING seam.

### Dimension 13 — Data model changes required (spec, not code; migrations serialize through the lead, Supabase first)
1. **`control_exceptions`** — `id`, `org_id`, `class` (enum EC-1…EC-13), `subject_refs` (jsonb of typed refs),
   `signal` (text/jsonb), `confidence`, `tier` (AUTO/REVIEW/ESCALATE), `amount_at_risk_cents` (bigint), `status` (enum),
   `owner`, `dedup_key`, `detected_at`, `resolved_at`, `resolution` (jsonb draft + applied), `evidence` (jsonb links).
   RLS `org_id = get_org_id()`; append-only-once-resolved discipline.
2. **`control_exception_events`** — append-only lifecycle/audit rows (actor human-or-AI+version, from→to state, reason)
   — or reuse `core.action_log` with a typed subject (preferred, to avoid a parallel log).
3. **`control_class_config`** — per-tenant/per-class enablement, `$-materiality threshold`, tier thresholds, autonomy
   dial (default OFF), suppression rules. Audited config.
4. **Account roles** for remediation entries (BANK_FEES_EXPENSE, INTEREST_INCOME, ALLOWANCE_DOUBTFUL, etc.) — resolve
   **by role, not number** (§2).
5. **Close-checklist hook** — a `close_checklists.is_auto_verified` item type reading open-ESCALATE-exception count.
6. **`dedup_key`/`source_ref` index** shared with `core.events` for the Projects-seam de-dup (Dimension 11 / AC-M8).
All new tables: `org_id` + RLS, bigint cents, idempotent migration, guard tests. Attribution: any `*_by` uuid col
written null-or-core-uuid (never a Clerk text id); human identity to `core.action_log`.

### Dimension 14 — AI behavior (the automation pillar, all human-approved)
- **Detection (propose):** each class's DETECT/RECONCILE signal produces an exception with confidence + $-at-risk +
  human-readable reasoning + Code/authority citation where relevant (EC-9/EC-11); logged as `actorType:'AI'`.
- **Remediation drafting (propose):** DRAFT the fix (JE draft / merge / request / artifact); **never applies** for
  money/filings; posting fixes route through the deterministic engine.
- **Learning:** dismissals feed suppression; confirmations feed faster escalation; calibration is tracked per class
  (Dimension 3/16). The learning loop tunes *noise*, never *fabricates* a suppression that hides a real class.
- **Guardrails (canon §3):** advisory by default; auto-remediation only via the per-class autonomy dial for the safest
  tier with SoD on the AI (detector ≠ applier); ask ONE disambiguating question when ambiguous; fail closed. All calls
  route through `@meritbooks/core-ai` (metered, tenant budget enforced across the suite); **no Anthropic key here.**
**Acceptance:** AC14.1 every AI-proposed exception + remediation logs inputs + rationale and requires a human step
before anything posts/pays/files (unless the dial explicitly enables the safest non-money class); AC14.2 no AI path
holds an Anthropic key or calls the API directly; AC14.3 confidence is calibrated per class and the calibration is
measured over time.

### Dimension 15 — RBAC & segregation of duties
**Purpose:** The control layer is itself a high-authority surface — who can dismiss/suppress an exception, tune a
threshold, or apply a remediation must be role-gated; the AI cannot approve its own work.
**Current state — PARTIAL/BLOCKED:** routes are auth-gated + RLS-scoped (the reference pattern); no `exceptions:*`
permissions; the standing NO-GO RBAC/identity gate (tasks #9/#28/#29) is unresolved.
**Named deltas:** D15.1 no `exceptions:view/triage/apply/suppress/configure` permissions in `lib/rbac/permissions.ts`;
D15.2 no SoD wall between detector-agent and human applier; D15.3 authorization must reconcile to
`core.users/memberships/roles`, not the `core.employees.role` stopgap.
**Acceptance:** AC15.1 view is broad; **apply-remediation, suppress, and configure-thresholds require elevated
permissions**; a money-movement remediation is preparer≠approver≠releaser; AC15.2 the detector agent cannot apply its
own remediation (SoD on the AI); AC15.3 authorization reconciles to `core` identity; denied → `permissionDenied`;
AC15.4 a tenant-isolation test proves cross-org exceptions are invisible/unactionable.

### Dimension 16 — Current-state ledger row (Rule 15) + governing metrics
| Dimension | State | Evidence |
|---|---|---|
| 1 Data captured | ❌ Missing (unified) | `/exceptions` routes items; no `control_exceptions` table |
| 2 Detection engine | 🔶 Scattered | class logic embedded in feature routes; no shared scan framework |
| 3 Confidence/$-routing | 🔶 Partial | `scoreToTier`/`getTierPolicy` exist for matching; not generalized |
| 4 Remediation drafting | 🔶 Partial | Vendor Compliance drafts requests; not consistent per class |
| 5 Triage lifecycle | 🔶 Partial | accept/reject on some `/exceptions` items; no shared state machine |
| 6 Autonomy dial | ❌ Missing | per-task dial concept exists; not wired to exceptions |
| 7 Lifecycle/audit | 🔶 Partial | `core.action_log` exists; not written by all class paths |
| 8 Auditor evidence pack | ❌ Missing | no JE-population export / control-effectiveness report |
| 9 Surfaces/UX | 🔶 Partial | `/exceptions` exists; not unified, no $-sort/evidence drill |
| 10 Close-gate | 🔶 Partial | periods + checklists exist; exceptions not a close gate |
| 11 Benchmark | — | see Dimension 11 |
| 15 RBAC/SoD | 🔶 Partial/Blocked | RLS-scoped; no `exceptions:*` gates; NO-GO identity gate open |

**Governing metrics (the trust feedback loop — accounting-manager B8):** per class and trended — **recall on seeded
exceptions**, **precision-at-tier / false-positive rate**, **$ prevented**, **detection→resolution time**,
**dismissal rate** (rising = cry-wolf, tighten), **confidence calibration** (does 90% mean 90%), **autonomy rate** (only
allowed to rise while override/error stays low), and **escaped-to-close count** (any > 0 = a kill-switch-worthy event).
The module is judged on these, **never on raw exception count or automation rate.**

Overall: **Functional — none** (primitives exist, unified module does not). This brief defines the unification.

---

## §3. Build sequence — none → Complete

Strictly ordered; each slice behind the wave pipeline (FPB → disjoint slices → builder wave → verifier +
chrome-auditor + security for money/identity → reviewer → integrate → scribe). Migrations to Supabase first. **No class
ships before its home gate is DONE.**

**Wave 0 — Prereqs (blockers, not this module's code):** close the **RBAC/identity NO-GO gate** (tasks #9/#28/#29 —
`canApprove`→`core.memberships/roles`, report-route RLS leak) and live-stamp GATE 3. Without these the SoD/audit spine
(AC-M5/AC-M6/D15) can't be defensible.

**Wave A — The spine (do first; class-agnostic):**
1. **Migration:** `control_exceptions` + `control_class_config` + close-checklist hook (Dimension 13); RLS + guard tests.
2. **Shared detection framework** (detector interface, idempotent incremental scan on schedule + trigger, `dedup_key`).
3. **Unified `/exceptions` surface** (tier→$ sort, class/entity/period filter, evidence + drafted-remediation drill,
   Rules 3–5 states) + shared triage state machine + `core.action_log` on every hop.
4. **Confidence/$-materiality routing** generalized from `scoreToTier`; per-class thresholds; dismissal-suppression loop.

**Wave B — Common-core classes (highest-$ first, each reusing the spine):**
5. **EC-1 duplicate/duplicate-vendor payments** + **EC-13 re-expensed settlements** — the two highest-integrity ESCALATE
   controls; EC-1 layers on the existing composite matcher; EC-13 is the unique owned-ledger catch (settlement-chain test).
6. **EC-10 anomalous/unsupported JEs** (AU-C 240) + the **auditor evidence pack** (Dimension 8) — the assurance moat.
7. **EC-4 uncategorized leakage + close gate** and **EC-5 subledger/aging tie** — wire the blocking close conditions
   (Dimension 10).
8. **EC-2 missed/expected accruals** + **EC-12 cut-off** + **EC-8 1099/W-9** (extend the built Vendor Compliance engine)
   + **EC-9 book-to-tax tagging** — the close/tax hygiene set.

**Wave C — Segment classes (as each home gate goes DONE):**
9. **EC-3 intercompany out-of-balance** — with GATE **11a** (MANDATORY, top priority); auto-mirror behind the dial.
10. **EC-11 covenant drift** + **EC-6 rev-rec-on-schedule** — with GATE **7** / **6**.
11. **EC-7 sales-tax nexus** — with GATE **11d**; the nexus-study artifact.

**Wave D — Governance depth (the BEAT + the pillar):**
12. **Autonomy dial + kill-switch** (Dimension 6) — per-class, OFF by default, SoD on the AI, money/filing classes
    excluded; the granular immediate throttle to propose-only.
13. **Governing metrics + calibration dashboard** (Dimension 16) — recall/precision-at-tier/$ prevented/dismissal/
    calibration/escaped-to-close; these *govern the dials*.
14. **`exceptions:*` RBAC** reconciled to `core` identity (Dimension 15) — coupled to the NO-GO RBAC gate.

**Deferred with reason (not required for first Complete):** EC-7 until 11d; full transfer-pricing depth on EC-3; the
"find-the-difference" heuristic assist beyond the drafted remediation. State each deferral in the Feature Completeness
Ledger.

## §4. Definition of Complete for this module

The Financial Control Exception Library is **Complete** when: the spine (Wave A — `control_exceptions`, shared detector,
unified `/exceptions`, $-materiality routing) ships; every **common-core** class (EC-1/2/4/5/8/9/10/12/13) detects at the
correct tier with correct $-at-risk and a drafted, engine-routed, reversible remediation; the auditor evidence pack and
the blocking close-gate are built; the module-level gates **AC-M1…AC-M8** are green (recall = 1.0 on the seeded fixture,
zero false ESCALATEs on the clean fixture, tenant isolation proven, EC-13 fix posts DR AP / CR Cash not a re-expense,
SoD/identity reconciled to `core.memberships/roles`, append-only audit, seam de-dup); every Rule-14 benchmark row is
MATCH-or-better (or deferred with reason in the Ledger); the autonomy dial + kill-switch + governing metrics are live
(OFF by default); and verifier + chrome-auditor + security confirm TRUTH against the deployed app and live Supabase.
Segment classes (EC-3/6/7/11) raise it toward **Verified** as their home gates land. Until then the Ledger row stays
**Functional — partial** (or **none** until Wave A ships). It is evaluated on **precision, recall, and $ prevented —
never on exception count or automation rate.**
