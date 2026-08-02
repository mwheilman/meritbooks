# Segment Deep-Dive — General Ledger & Month-End Close

**Segment:** The GL as book of record + the monthly/quarterly/annual **close** (single-entity and
multi-entity/consolidated). This is the beating heart of an owned-ledger product: everything else
(AP, AR, bank feed, rev-rec, reports) exists so that *the close ties, the consolidation eliminates,
and a named human can sign*.

**Authors' frame:** written by a pair — a 25+ yr multi-entity Controller / close leader (holdco +
PE portfolio consolidation) and a senior AI engineer. Part 1 is the operational reality the software
must reproduce. Part 2 is a comprehensive AI-automation catalog (36 capabilities) with build-state
against the live repo. Part 3 is a ranked build-first shortlist mapped to gates and FPBs.

**Grounding (read/reconciled):** `docs/canon/CANON-ANCHOR.md` (posting engine §3, rev-rec method-
per-job, intercompany elimination, `core.action_log`, gate state §5, 11a consolidation "MANDATORY,
top priority"); `docs/discovery/books/accounting-manager.md` (supervision surface B1–B10);
`docs/discovery/books/controller-cfo.md` (control/leak points 1–11); the live control library
(`apps/web/src/lib/controls/*`), `/close` + `/close-status`, consolidation
(`app/api/reports/consolidated/*` + `eliminations.ts`), `year-end-close.ts`, `intercompany.ts`,
`fiscal-periods.ts`, `je-composer.ts`, `schedule-engine.ts`, migrations 007/035/038, and
`docs/FPB-financial-control-exceptions.md`.

**Canon invariants that bind everything below (non-negotiable):** AI proposes **facts** + drafts a
fix; the **deterministic engine** posts (debits=credits, direction from account TYPE); a **human
approves**; **auto-post OFF by default**, autonomy a per-tenant/per-task dial; **SoD binds the AI
itself** (detector ≠ approver); **fail closed** on ambiguity; every action → Decision Log /
`action_log`; money is **bigint cents**; accounts referenced **by role, not number** (COA is 137,
per-tenant); RLS `org_id = get_org_id()`; master data in `core`, ledger in `public`, stitch via
`fetchCoreMap`; AI only via `@meritbooks/core-ai`.

---

## PART 1 — HOW THE CLOSE ACTUALLY RUNS (the operational reality to reproduce)

### 1.1 The close is a phased pipeline, not an event

A real multi-entity close runs on the **calendar, not the org chart**, in three phases per entity,
plus a group consolidation phase on top. The repo already encodes the three phases
(`close_checklists.phase` = `INITIAL` / `MID_CLOSE` / `FINAL`, with `due_day` 3 / 7 / 10):

- **Continuous / pre-close (all month).** Keep the ledger current so close is a *verification*, not a
  *reconstruction*: bank-feed coding, AP intake/coding, AR billing + cash application, uncoded-line
  cleanup. **Every uncoded line that survives to day 1 is month-end archaeology.** The controller's
  dream is the *continuous / soft close* — nothing left to build in week 1 because it was booked as
  it happened.
- **Initial phase (≈ days 1–3) — cutoff & completeness.** Cut off AP/AR (all bills/invoices for the
  period in), post the last bank/card activity, sweep the uncategorized/suspense buckets to zero,
  confirm every sub-ledger has stopped moving for the period. Gate: *is everything that belongs in
  the period actually in the period?*
- **Mid phase (≈ days 4–7) — adjust & reconcile.** Book **accruals, prepaids, deferrals**
  (received-not-invoiced, prepaid amortization, deferred-revenue release, payroll accrual, interest,
  depreciation); **reconcile every balance-sheet account** (bank, credit card, loans, AR/AP subledger
  → GL control account, clearing/suspense, intercompany); run the **intercompany true-up** so every
  IC leg has an equal-and-opposite mirror. Gate: *does every balance tie to independent support, and
  do the estimates have a basis?*
- **Final phase (≈ days 8–10) — review, flux, sign-off, lock.** Analytical/flux review (vs prior
  month & budget), clear all review notes, produce working papers, obtain preparer + reviewer sign-
  off, **lock the period** (SOFT_CLOSE → HARD_CLOSE). Gate: *does every material move have a story,
  and can I put my name on it?*
- **Consolidation phase (group, ≈ days 8–12).** Aggregate entities, apply **eliminations** (IC
  revenue/expense, IC receivable/payable, investment-in-sub vs equity), handle **ownership % / NCI /
  minority interest**, roll up to arbitrary **reporting groupings** (by fund, by region, by
  business line), produce consolidated + entity P&L / BS / CF, budget-vs-actual with variance
  narrative, then the covenant + board packages.

### 1.2 The working papers & tie-outs (the evidence that lets you sign)

Every reconciled account produces a **working paper**: GL balance vs an independent supporting
balance, the variance, an explanation, tickmarks, supporting-doc links, and a preparer/reviewer
sign-off. The repo's `working_papers` table already models exactly this (generated `variance_cents`
column, `tickmarks jsonb`, `supporting_doc_urls`, `prepared_by/reviewed_by`). **Unreconciled = not
done, full stop** — the controller looks at the *reconciling items*, not just "difference = 0". A
plug used to force a rec to zero is a red flag, not a reconciliation.

### 1.3 The gates a close must clear before sign-off

1. **Completeness** — all period activity captured; suspense/uncoded ≤ threshold (repo: EC-4
   leakage close-readiness).
2. **Reconciliation** — every balance-sheet control account tied to independent support, zero
   *unexplained* difference (repo: `bank_reconciliations`, reconciliation autopilot).
3. **Accruals/cutoff** — period-boundary correct; expected recurring items booked; no revenue/expense
   on the wrong side of the cut (repo: EC-2 missed-accruals, EC-12 cutoff-errors).
4. **Intercompany** — every IC pair nets to zero before consolidation runs (repo: EC-3 intercompany-
   balance + `intercompany_transactions`).
5. **Analytical/flux** — every material variance has an explanation.
6. **Review & SoD** — preparer ≠ reviewer; nothing to the client/CFO a second set of eyes didn't
   touch.
7. **Lock** — period hard-closed; no back-dated edit without a documented, approved reopen (repo:
   `enforce_period_lock` trigger + `fiscal_periods` status machine).

### 1.4 Consolidation & intercompany reality

- **Each legal entity keeps its own books, periods, and retained earnings** (repo: `core.locations`
  is the entity; year-end close is per entity; each posting respects its own fiscal period).
- **Intercompany** transactions book a balanced entry *on each entity's books*, tagged with the
  counterparty entity, using Intercompany Receivable (role `INTERCOMPANY_AR`/1160) and Payable
  (`INTERCOMPANY_AP`/2020). The two legs must **net to zero across the group** (repo:
  `gl_entry_lines.counterparty_location_id`, `intercompany.ts` with FUNDING / EXPENSE_ON_BEHALF /
  REPAYMENT natures).
- **Two elimination layers at roll-up:** (a) **interdepartmental** — `is_eliminating` internal-
  invoice Services Revenue/Cost accounts net to zero within a company; (b) **intercompany** — the
  reciprocal AR/AP positions net across entities. The consolidated P&L already nets `is_eliminating`
  accounts while preserving genuine third-party costs (repo: `eliminations.ts`; the Session-22 bug —
  dropping every `INTERCOMPANY` entry and erasing real third-party expense — is documented and
  fixed).
- **What real consolidation still needs that the repo lacks:** ownership **% (partial ownership /
  NCI / minority interest)**, **investment-in-sub vs equity elimination**, **arbitrary reporting
  groupings** (fund / region / business-line sub-consolidations, not just the flat all-entities
  roll-up), a formal **elimination-entry ledger** (today eliminations are computed at report time,
  informationally — not booked to an elimination "company"), and **currency translation** (CTA) for
  any non-USD entity.

### 1.5 Every leak / delay / error the close must catch (Controller's ranked list)

Mapped to the controller-cfo brief and the live detectors:

| # | Leak / error | Where it bites | Repo detector (build-state) |
|---|---|---|---|
| 1 | **Duplicate / erroneous vendor payments** | 0.1–0.5% of AP paid twice; BEC fraud | EC-1 `duplicate-payments.ts` — **live, detect-only** |
| 2 | **Intercompany out-of-balance** | consolidation won't eliminate; misstated equity/EBITDA | EC-3 `intercompany-balance.ts` — **live, detect-only** |
| 3 | **Missed / mis-estimated accruals & deferrals** | #1 audit adjustment; a missed 6-fig accrual flips a covenant | EC-2 `missed-accruals.ts` — **live, detect + drafts JE** |
| 4 | **Unposted / uncategorized cost leakage** | wrong departmental/entity P&L; "clean" close isn't | EC-4 `uncategorized-leakage.ts` — **live, feeds close-status** |
| 5 | **Period cut-off errors** | income in wrong period; audit adj / covenant / early tax | EC-12 `cutoff-errors.ts` — **live, detect-only** |
| 6 | **Anomalous / unsupported manual JEs** | fraud vector; round-dollar, undocumented, off-hours | EC-10 `anomalous-je.ts` — **live, detect-only** |
| 7 | **Unreconciled aging** (AR/AP subledger vs GL, bank) | overstated assets; bad-debt surprise; blown DSO | Reconciliation autopilot + `bank_reconciliations` — **live** |
| 8 | **Revenue not recognized on schedule** | ASC 606 misstatement; deferred rev not released | `revenue-not-recognized.ts` + `rev-rec.ts` — **live** |
| 9 | **Close-checklist gaps** (a step silently skipped) | restatement; inconsistent quality across entities | `close_checklists` + `/close`, `/close-status` — **partial** |
| 10 | **Audit-trail / SoD weakness** (incl. AI as actor) | material weakness; failed audit; unprovable close | `audit_log`, `ai_audit_log`, `core.action_log`, preparer≠approver — **partial** |
| 11 | **Re-expensed settlement** (DR expense instead of clearing AP/CC) | double-counted expense; canon §3 violation | posting engine forbids it structurally — **live** |
| 12 | **Plug to force a reconciliation** | hides the real reconciling item | not yet a dedicated detector — **gap** |
| 13 | **Prior-period adjustment to a locked period** | silent restatement of signed books | `enforce_period_lock` blocks; controlled-reopen workflow — **gap** |
| 14 | **Flux with no story** (40% move, no explanation) | management decides on unexplained numbers | flux/variance auto-narrative — **not built** |
| 15 | **Missing / late working-paper tie-out** | can't evidence the sign-off in audit/diligence | `working_papers` table exists; auto-gen + tie-out UI — **gap** |

---

## PART 2 — COMPREHENSIVE AI-AUTOMATION CATALOG (36 capabilities)

**Legend.** *Gateway bucket* = the canonical routing lane for the AI output:
**PROPOSE** (AI drafts a fact/entry → `ai_decisions` PROPOSED → `/exceptions` or a review queue →
human approves → deterministic engine posts) · **DETECT** (continuous control → `$-at-risk`
exception, no write) · **DERIVE** (read-only intelligence computed from the ledger; no AI authorship
of accounting) · **ORCHESTRATE** (workflow/status/dependency automation) · **NARRATE** (LLM writes
prose over deterministic numbers) · **PACKAGE** (assembles evidence/PBC artifacts).
*Build-state:* **LIVE** · **PARTIAL** · **PRIMITIVE** (dependency exists) · **NOT BUILT**.

### Group A — JE drafting & the NL front door

**A1. Natural-language JE composer.**
- *What:* plain-English ("accrue $12k December rent for Heritage") → a **balanced, role-resolved**
  proposed JE using only the org's real COA; predicts BS treatment (capex/prepaid/deferred rev) and
  asks one clarifying question when substance is ambiguous.
- *Trigger/data:* user text + org COA + account roles; runs through `@meritbooks/core-ai` (GATE 3).
- *Gateway:* PROPOSE. *Human:* approve/edit before post; never auto-posts.
- *Value:* collapses the single largest manual-JE labor sink; front door for every adjustment.
- *Build-state:* **LIVE** — `je-composer.ts`, writes `ai_decisions` per proposal.

**A2. Recurring-JE auto-generation (with reversing logic).**
- *What:* generate the period's recurring entries (rent, insurance, standard accruals) from a
  template; auto-reverse reversing accruals into the next period.
- *Trigger/data:* `recurring_templates` (frequency, next_run_date, is_reversing, template_lines).
- *Gateway:* PROPOSE (→ optionally auto-post per the autonomy dial once earned). *Human:* review the
  batch; SoD applies.
- *Value:* eliminates re-keying the same 30–80 entries every month; prevents forgotten reversals.
- *Build-state:* **PARTIAL** — table + `/api/recurring` exist; auto-generate + reversing orchestration
  and the "template is *due* but never ran" catch live in EC-2. Batch-generate UI is thin.

**A3. Learned recurring-entry discovery.**
- *What:* propose *new* recurring templates by detecting a cadence in history ("this vendor bills
  monthly, always coded 6100 — make it recurring?").
- *Trigger/data:* bill/entry history; vendor-pattern learning (migration 040).
- *Gateway:* PROPOSE. *Human:* accept the template.
- *Value:* the ledger teaches itself its own recurring shape; shrinks the manual template build.
- *Build-state:* **PARTIAL** — cadence detection exists inside `missed-accruals.ts`
  (`detectCadence`/`assessVendorRecurrence`); not surfaced as a "create template" suggestion.

### Group B — Accruals, prepaids, deferrals

**B1. Auto-accrual of expected-but-absent recurring costs (the *missing* accrual).**
- *What:* the owned-ledger catch a bolt-on can't make — a vendor that bills every month goes
  **silent** this period → draft the run-rate accrual; a recurring template due but never generated;
  a scheduled deferral run missing.
- *Trigger/data:* vendor recurrence history, `recurring_templates`, `posting_schedule` runs.
- *Gateway:* PROPOSE (draft balanced accrual + basis) → DETECT (gap → `/exceptions`). *Human:*
  approve the estimate.
- *Value:* kills the #1 audit adjustment; "the leak is the accrual you *forgot*."
- *Build-state:* **LIVE** — EC-2 `missed-accruals.ts` (signals A vendor_recurrence / B
  recurring_template / C scheduled_deferral), drafts the JE, idempotent via dedup_key.

**B2. Prepaid amortization & straight-line schedule engine.**
- *What:* set up a prepaid/deferral once → the engine posts each period's amortization on schedule.
- *Trigger/data:* `posting_schedule` + `posting_schedule_runs` (schedule engine).
- *Gateway:* PROPOSE/derive-then-post; missed runs → DETECT via EC-2 signal C. *Human:* approve
  schedule; runs can be auto once earned.
- *Value:* prepaids never sit un-amortized; deferred-rev release is mechanical.
- *Build-state:* **PARTIAL** — `schedule-engine.ts` + missing-run detection live; front-end to
  create/manage schedules and confirm each run is thin.

**B3. Deferred-revenue release (rev-rec-driven).**
- *What:* release deferred revenue per the job's rev-rec method (managed-job invoices credit Deferred
  Revenue 2410, then release on schedule/POC); flag schedules due, stalled, or inconsistent with
  billing.
- *Trigger/data:* `rev-rec.ts` (9 methods, method-per-job), contract/progress inputs.
- *Gateway:* DERIVE (deterministic timing) + DETECT (`revenue-not-recognized.ts`). *Human:* approve
  POC %; AI never invents % complete.
- *Value:* ASC 606 correctness; the material estimate for contract/project tenants.
- *Build-state:* **LIVE** (segment: contract/subscription/project tenants).

**B4. Depreciation & interest accrual automation.**
- *What:* period depreciation (dual-book tax/GAAP) and interest accrual on debt as scheduled entries.
- *Trigger/data:* fixed-asset schedules, `dual_book_tax_depreciation` (migration 033), loan terms.
- *Gateway:* PROPOSE→post. *Human:* review.
- *Value:* two more standing manual entries removed.
- *Build-state:* **PARTIAL** — dual-book depreciation schema exists; a general depreciation/interest
  scheduler surfaced in close is not wired.

### Group C — Continuous / soft close

**C1. Continuous ("soft") close orchestration.**
- *What:* keep the books close-ready all month so week-1 is verification not reconstruction — code as
  it lands, accrue on schedule, reconcile continuously; surface a live "days-to-close-ready" number.
- *Trigger/data:* live ledger + queue state (leakage, unreconciled, open exceptions).
- *Gateway:* ORCHESTRATE + DERIVE. *Human:* supervises exceptions.
- *Value:* the CFO's headline ask — collapse close-cycle time; decisions on current numbers.
- *Build-state:* **PARTIAL** — `/close-status` derives readiness continuously; no explicit
  soft-close *target/track* or "continuous accrual" scheduler binding it together.

**C2. Pre-post anomaly gates (catch it before it enters the book of record).**
- *What:* run the controller's error-hunt as **pre-post** checks — duplicate, wrong-period, wrong-
  entity, expense-vs-capitalize, re-expensed settlement, unusual amount/vendor/account vs history —
  and *hold* anomalies before they post.
- *Trigger/data:* proposed entry + history; deterministic engine gates (balance, period lock, COA
  approval, control accounts, dimensions).
- *Gateway:* DETECT (fail closed → block + route). *Human:* clears the hold.
- *Value:* in an *owned* ledger there's no upstream system to blame — catch at proposal time.
- *Build-state:* **PARTIAL** — deterministic engine gates are LIVE; the detectors (EC-1/3/4/10/12)
  run **post-hoc** on `/exceptions`, not yet as a synchronous pre-post interceptor on the posting path.

### Group D — Reconciliations

**D1. Auto bank/card reconciliation (reconciliation autopilot).**
- *What:* three-way tie bank feed ↔ GL ↔ subledger; auto-clear confident matches; surface reconciling
  items; require zero *unexplained* difference before close.
- *Trigger/data:* Plaid feed, `bank_reconciliations`, match scoring (migration 065).
- *Gateway:* PROPOSE match → DERIVE rec statement. *Human:* clears exceptions; approves write-offs.
- *Value:* removes the largest week-1 reconciliation labor; bank rec must hit true zero.
- *Build-state:* **LIVE** — reconciliation autopilot + `bank_reconciliations` (Bank-Rec Wave A).

**D2. Subledger-to-GL control-account tie-out.**
- *What:* continuously assert AR subledger = 1100 control, AP subledger = 2000 control, payroll
  clearing = 0, credit-card liability ties to statement; flag drift.
- *Trigger/data:* subledger balances vs GL control-account balances per period.
- *Gateway:* DETECT. *Human:* investigates drift.
- *Value:* "subledger doesn't tie to GL" is a classic silent misstatement; catch it continuously.
- *Build-state:* **PARTIAL** — reconciliation-gl / balance services exist; a standing control-account
  tie-out exception class is not yet its own detector.

**D3. AI cash application (lump deposit → open invoices).**
- *What:* match a lump ACH/wire/lockbox deposit to open invoices (the deceptively manual AR task).
- *Trigger/data:* `cash-application.ts`, open AR, remittance text.
- *Gateway:* PROPOSE application. *Human:* confirms low-confidence.
- *Value:* removes a daily AR labor sink; keeps AR aging honest.
- *Build-state:* **LIVE** (detect/propose) — `cash-application.ts`.

**D4. Write-off / reserve proposal with rationale.**
- *What:* propose bad-debt reserve / write-off candidates from aged AR with a rationale; controller
  approves (judgment + SoD).
- *Trigger/data:* AR aging + customer payment history.
- *Gateway:* PROPOSE. *Human:* approves the write-off.
- *Value:* stops stale AR sitting at full value; disciplined reserves.
- *Build-state:* **PARTIAL** — AR Collections/DSO live; write-off/reserve *proposal* not surfaced.

### Group E — Flux / variance / narrative

**E1. Flux & variance auto-narrative.**
- *What:* compute period-over-period and vs-budget variance per account/department/entity, then
  **write the explanation** ("6100 up 41% — new Heritage insurance renewal, $18k, recurring") drawing
  on the transactions behind the move; flag any material move with *no* discoverable story.
- *Trigger/data:* two periods (or actual vs budget) of GL + the driving transactions/vendors.
- *Gateway:* DERIVE (variance math) + NARRATE (LLM prose over the numbers). *Human:* edits the
  narrative; owns the story.
- *Value:* the final-phase analytical review the controller does by "shape" — automated; a number
  that moved with no story becomes a flagged question, not a missed fact.
- *Build-state:* **NOT BUILT** — no variance/flux service in the repo (high-value gap).

**E2. Missing-variance-explanation gate.**
- *What:* close cannot sign while any material variance lacks an explanation.
- *Trigger/data:* variance set + explanation status.
- *Gateway:* DETECT (blocking). *Human:* provides the story.
- *Value:* forces the analytical review to actually happen.
- *Build-state:* **NOT BUILT** (depends on E1).

**E3. Anomaly-by-shape detection (analytical review as a control).**
- *What:* margin drift, an expense line suddenly empty, revenue in the wrong period — caught by shape
  vs history before checking a single entry.
- *Trigger/data:* trended account/ratio history.
- *Gateway:* DETECT. *Human:* investigates.
- *Value:* reproduces the controller's "sniff test."
- *Build-state:* **PARTIAL** — EC-10/12 catch specific shapes; no general ratio/trend anomaly engine.

### Group F — Close orchestration & status

**F1. Real-time close command center (derived, per-entity readiness).**
- *What:* the single-pane "where is every entity in the close, and what's blocking a clean one,"
  **derived from live ledger/queue state**, not a typed checklist — period status, bank-rec state,
  leakage $-at-risk, open exceptions, flagged items → green/amber/red with explicit blockers + a
  portfolio roll-up.
- *Trigger/data:* `fiscal_periods`, `bank_reconciliations`, EC-4 leakage (dry-run), `ai_decisions`,
  flagged bank/receipt/bill rows.
- *Gateway:* DERIVE + ORCHESTRATE. *Human:* clicks into red cells to intervene.
- *Value:* the #1 thing the accounting manager wants automated (A3/B1); "demonstrated, not asserted."
- *Build-state:* **LIVE** — `/close-status` (`app/api/close-status/route.ts` + board).

**F2. Close-task orchestration with dependency tracking.**
- *What:* a structured checklist per entity with **owner (human OR agent), preparer/reviewer, due
  date, status, dependencies** (can't start consolidation until every entity's IC is matched; can't
  flux until accruals posted); auto-status the mechanical items from the ledger.
- *Trigger/data:* `close_checklists` (phase/task/due_day/is_complete/is_auto_verified) + ledger-derived
  auto-verify.
- *Gateway:* ORCHESTRATE. *Human:* owns judgment tasks + sign-off.
- *Value:* nothing falls through; consistent quality across 17+ entities.
- *Build-state:* **PARTIAL** — `close_checklists` + `/close` grid exist (3 phases, manual complete
  toggles); **no dependency graph**, limited ledger auto-verification, no owner=agent attribution.

**F3. Auto-verify mechanical close tasks from the ledger.**
- *What:* the system self-certifies "bank rec: 0 difference ✓", "suspense = 0 ✓", "IC matched ✓",
  "accruals posted ✓" instead of a human ticking a box.
- *Trigger/data:* the detectors + reconciliation state feeding `is_auto_verified`.
- *Gateway:* DERIVE → ORCHESTRATE. *Human:* owns only the judgment items.
- *Value:* the checklist becomes truth, not a stale spreadsheet.
- *Build-state:* **PARTIAL** — `is_auto_verified` column exists; wiring detectors → auto-tick is
  incomplete.

**F4. Workload / capacity view (machine + humans).**
- *What:* live counts + aging of the exception/review queue by entity, workstream, tier, assignee;
  throughput vs inflow; projected time-to-clear vs the close calendar; warn when the queue grows
  faster than it clears.
- *Trigger/data:* `ai_decisions` queue, `action_log`, close calendar.
- *Gateway:* DERIVE. *Human:* reassigns, re-tiers, pulls in help.
- *Value:* no silent backlog; the exception wall never surprises you.
- *Build-state:* **PARTIAL** — `/exceptions` queue + close-status roll-ups exist; a dedicated
  capacity/throughput view does not.

### Group G — Working papers, tie-outs, evidence

**G1. Working-paper auto-generation + tie-out.**
- *What:* for every balance-sheet account, auto-build the working paper (GL balance vs supporting
  balance, computed variance, tickmarks, links), pre-filled from the reconciliation + subledger, ready
  for preparer/reviewer sign-off.
- *Trigger/data:* `working_papers` (variance generated column, tickmarks jsonb, doc urls,
  prepared/reviewed).
- *Gateway:* PACKAGE + DERIVE. *Human:* reviews & signs.
- *Value:* the evidence that lets you sign; makes audit/diligence a download, not a scramble.
- *Build-state:* **PARTIAL** — schema is rich (migration 007); auto-generation from recs/subledgers
  and the review UI are the gap.

**G2. Roll-forward schedules (BS accounts).**
- *What:* beginning balance + activity − releases = ending balance, per period, for prepaids, accruals,
  deferred rev, debt, fixed assets, equity — the auditor's favorite artifact.
- *Trigger/data:* period-over-period GL + schedule runs.
- *Gateway:* DERIVE + PACKAGE. *Human:* reviews.
- *Value:* instant roll-forwards; catches un-rolled or stuck schedules.
- *Build-state:* **NOT BUILT** — no roll-forward generator (equity-changes report is the nearest
  primitive).

**G3. Audit-ready evidence packaging.**
- *What:* one-click bundle per period/entity: reconciliations, working papers, JE support, approval
  chain, the Decision Log of what the AI did autonomously vs what a human overrode.
- *Trigger/data:* `working_papers`, `audit_log`, `ai_audit_log`, `core.action_log`, doc links.
- *Gateway:* PACKAGE. *Human:* delivers to auditor/lender.
- *Value:* an unprovable close is worthless; this is what lets a controller *sign*.
- *Build-state:* **NOT BUILT** — the logs exist (007, 039, 062); no packager.

**G4. PBC (prepared-by-client) request automation.**
- *What:* generate & track the annual audit PBC list, auto-fulfilling items the ledger can produce
  (recs, roll-forwards, GL detail) and chasing the human-supplied ones.
- *Trigger/data:* prior-year PBC template + what the ledger can auto-produce.
- *Gateway:* ORCHESTRATE + PACKAGE. *Human:* supplies external items.
- *Value:* audit prep collapses from weeks to a checklist that fills itself.
- *Build-state:* **NOT BUILT** (compliance_obligations/filings schema is a distant primitive).

### Group H — Intercompany & consolidation

**H1. Intercompany auto-matching + mirror-entry drafting.**
- *What:* pair every IC transaction with its counterpart via shared IC id + counterparty entity;
  auto-draft the mirror when the pair is provable; daily IC-imbalance report; consolidation refuses to
  close with unmatched IC over threshold.
- *Trigger/data:* `intercompany_transactions`, `gl_entry_lines.counterparty_location_id`, roles
  1160/2020.
- *Gateway:* PROPOSE (mirror) + DETECT (imbalance). *Human:* adjudicates timing differences.
- *Value:* IC is the #2 multi-entity leak; eliminates the day-5 mismatch hunt.
- *Build-state:* **LIVE (detect)** — EC-3 `intercompany-balance.ts` (interdept + intercompany +
  one-sided invoice) + `intercompany.ts` posting; auto-mirror *from a single side* + a threshold
  block on consolidation are the extensions.

**H2. Consolidation with ownership % / NCI / arbitrary groupings.**
- *What:* roll up entities with **partial ownership** (minority interest / NCI), eliminate
  **investment-in-sub vs equity**, and support **arbitrary reporting groupings** (fund / region /
  business line sub-consolidations), plus a formal **elimination-entry ledger** booked to an
  elimination company (not just report-time netting).
- *Trigger/data:* ownership %/hierarchy on `core.locations`, elimination account roles, grouping config.
- *Gateway:* DERIVE + PROPOSE (elimination entries). *Human:* reviews the consolidation.
- *Value:* canon §5 marks **11a MANDATORY, top priority**; this is the paid depth for holdco/PE tenants.
- *Build-state:* **PARTIAL** — 100% flat roll-up with P&L `is_eliminating` netting + informational
  IC AR/AP netting is LIVE (`eliminations.ts`); **ownership %, NCI, invest-in-sub, groupings, CTA,
  booked elimination entries are NOT built.**

**H3. Currency translation (CTA).**
- *What:* translate non-USD entity balances at the right rates; book the cumulative translation
  adjustment to equity.
- *Trigger/data:* FX rates + entity functional currency.
- *Gateway:* DERIVE + PROPOSE. *Human:* reviews.
- *Value:* required for any multi-currency group.
- *Build-state:* **NOT BUILT** (segment: multi-currency tenants).

### Group I — Year-end, prior-period, close analytics

**I1. Year-end close (temporary accounts → retained earnings).**
- *What:* per entity, zero every P&L account and roll net income to Retained Earnings via one
  `entry_type='CLOSING'` entry dated year-end; idempotent, reversible, re-runnable after late
  adjustments.
- *Trigger/data:* year's POSTED non-CLOSING P&L activity; role RETAINED_EARNINGS/3020.
- *Gateway:* DERIVE → PROPOSE → post. *Human:* runs/approves; can reverse.
- *Value:* mechanical year-end that used to be a careful manual entry per entity.
- *Build-state:* **LIVE** — `year-end-close.ts`, `/year-end-close`, migration 038.

**I2. Prior-period adjustment control (locked-period governance).**
- *What:* a locked period cannot be edited except through a documented, approved **reopen** (who,
  why, what changed) with a re-lock and re-close; any unexplained change to a closed period is a
  red-alert control failure.
- *Trigger/data:* `enforce_period_lock`, `fiscal_periods` status, `audit_log`.
- *Gateway:* ORCHESTRATE + DETECT (unauthorized change → alert). *Human:* authorizes the reopen.
- *Value:* protects the integrity of signed books; prevents silent restatement.
- *Build-state:* **PARTIAL** — `enforce_period_lock` blocks posting and reopen requires a reason; a
  formal reopen *workflow* (approval + evidence + re-close) and a "change to locked period" alarm are
  gaps.

**I3. Close analytics (cycle time, bottlenecks, autonomy rate).**
- *What:* trend close-cycle time per entity, identify bottleneck workstreams, and — the trust loop —
  **autonomy rate** (% handled without a human), **override/error rate**, escaped-vs-caught error
  rate, backlog aging; these metrics *govern the autonomy dials*.
- *Trigger/data:* checklist timestamps, `action_log`, `ai_decisions` outcomes, override events.
- *Gateway:* DERIVE. *Human:* tunes dials, tightens/loosens autonomy, investigates regressions.
- *Value:* is the machine actually earning trust? The feedback loop of the whole supervision layer.
- *Build-state:* **NOT BUILT** — timestamps exist (074); no analytics surface.

### Group J — Trust, attribution, materiality (the supervision spine)

**J1. Machine-vs-human work attribution (`action_log` made legible).**
- *What:* filter any period/entity/account by "what the machine posted autonomously," "what a human
  overrode," "what agent X did" — with actor (human OR AI+version), confidence, reason.
- *Trigger/data:* `core.action_log` / `audit_log` (GL attribution is uuid-nullable, so identity lives
  in the action log — load-bearing).
- *Gateway:* DERIVE. *Human:* supervises a workforce it can't see working.
- *Value:* proves SoD when part of the "staff" is software; ends "the computer did it."
- *Build-state:* **PARTIAL** — `action_log` (062) + `trust/action-log.ts` + `actor.ts` exist; the
  legible filter/timeline UI is the gap.

**J2. Confidence-tiered review routing + per-task autonomy dial.**
- *What:* every proposed fact carries a confidence → tier (auto / review / escalate); the accounting
  manager's tunable dials per task/entity; auto-band items stay sampleable.
- *Trigger/data:* `scoreToTier` / `getTierPolicy` (`trust/score-tier.ts`), tenant config.
- *Gateway:* ORCHESTRATE. *Human:* sets thresholds; can only loosen after the machine earns it.
- *Value:* trust the routine, inspect the exceptions — the core supervision instinct.
- *Build-state:* **PARTIAL** — `scoreToTier` exists and detectors compute a tier; canon flags it's
  not yet wired into the actual auto-post/queue **disposition**, only logging.

**J3. Materiality-driven review scaling.**
- *What:* scale scrutiny by dollars × judgment — trust the rule below a per-tenant materiality
  threshold; hard-stop above it; route by risk.
- *Trigger/data:* per-tenant/per-account materiality config feeding every detector's tier.
- *Gateway:* ORCHESTRATE. *Human:* sets materiality per tenant/segment.
- *Value:* attention goes where the dollars and judgment are, not on the $12 coffee charge.
- *Build-state:* **PARTIAL** — detectors carry $-at-risk and tiering; a first-class, tenant-
  configurable **materiality** object driving all of them is not built.

**J4. SoD enforcement binding the AI (preparer ≠ approver ≠ releaser).**
- *What:* the agent that detects/proposes cannot approve/apply; money movement stays human-released;
  approval authority reconciles to `core.memberships/roles`.
- *Trigger/data:* money-movement approvals (042/043), `core.memberships`, DB CHECK + service.
- *Gateway:* ORCHESTRATE (blocking). *Human:* the approver/releaser.
- *Value:* fraud/mis-control prevention; the wall can't be collapsed even by accident.
- *Build-state:* **PARTIAL** — preparer≠approver enforced for money movement; canApprove reconciled
  to memberships; **multi-tenant org resolution still open (gate #9)** and control-route RBAC pending.

**J5. Kill-switch / autonomy throttle (task / entity / global).**
- *What:* the supervisor's immediate, granular throttle — drop a task/entity/all to "propose-only"
  when override/error spikes, a material error escapes, confidence miscalibrates, or after a model
  change; degrades gracefully (never stops the books).
- *Trigger/data:* autonomy config + the I3 metrics.
- *Gateway:* ORCHESTRATE. *Human:* the final gate; can halt sign-off over any confidence score.
- *Value:* the controller will not sign a close it can't stop; this is the precondition of trust.
- *Build-state:* **NOT BUILT** — autonomy is effectively OFF by default (safe floor), but no
  first-class per-task/entity/global throttle surface.

### Group K — Compliance & tax overlays (segment)

**K1. Vendor/tax compliance gates (1099 / W-9 / COI).**
- *What:* block/flag at setup & payment on missing W-9, expired COI, banking-change; assemble the
  annual 1099 file.
- *Trigger/data:* vendor-compliance engine (037), YTD 1099 accumulation.
- *Gateway:* DETECT + PACKAGE. *Human:* clears exceptions, files.
- *Value:* stops quiet backup-withholding / penalty leakage.
- *Build-state:* **LIVE** — vendor-compliance pipeline.

**K2. Sales/use-tax nexus & covenant drift monitors.**
- *What:* nexus threshold monitoring (`sales-tax-nexus.ts`); continuous covenant computation
  (DSCR/leverage/liquidity) with graduated headroom alerts + drafted compliance certificate (never
  auto-filed).
- *Trigger/data:* jurisdiction sales, machine-readable covenant definitions, live+forecast GL.
- *Gateway:* DETECT + NARRATE (draft cert). *Human:* files/signs.
- *Value:* nexus assessments and covenant breaches are existential; catch them continuously.
- *Build-state:* **PARTIAL** — `sales-tax-nexus.ts` live (detect); covenant monitor **NOT BUILT**
  (segment: leveraged tenants; FP&A GATE 7).

---

## PART 3 — RANKED BUILD-FIRST SHORTLIST → GATES → FPBs

Ranked by **(close-signature value × leak-$ prevented) ÷ build cost**, respecting the gate order
(no class ships on data a DONE gate doesn't already own). Each item needs its own FPB before build.

| # | Capability | Cap-refs | Home gate | Why first | FPB needed |
|---|---|---|---|---|---|
| 1 | **Wire `scoreToTier` into real disposition + per-task autonomy dial + materiality object** | J2, J3, J5 | GATE 5 (+9) | Turns the whole detect-only library into an actual supervised workforce; unblocks auto-remediation safely; the trust spine the controller signs behind | **FPB: Supervision & Autonomy Control Plane** |
| 2 | **Close-task orchestration w/ dependency graph + ledger auto-verify** | F2, F3, F4 | GATE 8 | Makes the close a governed pipeline (nothing falls through, consistent across 17 entities); auto-ticks mechanical tasks from the detectors already live | **FPB: Close Orchestration** |
| 3 | **Consolidation depth: ownership % / NCI / invest-in-sub / groupings / booked eliminations** | H2, H1, H3 | **GATE 11a (MANDATORY, top priority)** | Canon's #1 open gate; the paid holdco/PE moat; today's roll-up is 100%-flat only | **FPB: Multi-Entity Consolidation** (tenant-model-consolidation FPB exists — extend) |
| 4 | **Flux/variance auto-narrative + missing-explanation gate** | E1, E2, E3 | GATE 7 (FP&A) | Automates the final-phase analytical review the controller does by "shape"; a material move with no story becomes a blocking question | **FPB: Flux & Variance Narrative** |
| 5 | **Working-paper auto-generation + tie-out + evidence packaging** | G1, G3, G2 | GATE 8 | The evidence that lets a human *sign*; makes audit/diligence a download; schema (007) already rich | **FPB: Working Papers & Audit Evidence** |
| 6 | **Prior-period adjustment / controlled-reopen workflow** | I2 | GATE 8 | Protects signed books from silent restatement; `enforce_period_lock` is the floor, needs the workflow + alarm | **FPB: Period Governance & Reopen** |
| 7 | **Pre-post anomaly interceptor (move detectors onto the posting path)** | C2 | GATE 5 | Catch the error *before* it enters the owned book of record, not next-month's flux | fold into FPB #1 |
| 8 | **Machine-vs-human attribution timeline UI** | J1 | GATE 9 | Lets the supervisor see what the AI did autonomously vs human overrides; SoD proof | fold into FPB #1 |

**Immediate #1 pick:** capability **#1 (Supervision & Autonomy Control Plane)** — it converts the
already-live detect-only control library (EC-1/2/3/4/10/12 + rev-rec + cash-app + vendor-compliance)
from *logging* into a *governed, materiality-scaled, dial-controlled autonomous workforce with a
kill-switch*. It is the smallest change with the largest trust payoff and the precondition the
accounting-manager and controller briefs both make non-negotiable before they will sign a close.
Everything else (orchestration, consolidation depth, flux, working papers) plugs into that spine.

---

### Build-state summary (what exists vs what's missing)

- **LIVE (10):** A1 NL JE composer, B1 missed-accruals (auto-accrual incl. the *absent* one),
  B3 deferred-rev release, D1 bank-rec autopilot, D3 cash application, F1 close command center,
  H1 IC imbalance detection, I1 year-end close, K1 vendor/1099 compliance, plus the deterministic
  posting-engine gates and the EC-1/4/10/12 detectors.
- **PARTIAL / PRIMITIVE (18):** recurring-JE gen, learned-template discovery, prepaid/deferral
  schedule UI, depreciation/interest scheduler, continuous-close orchestration, pre-post interceptor,
  control-account tie-out, write-off proposal, anomaly-by-shape, close-task dependency graph,
  auto-verify, capacity view, working-paper auto-gen, consolidation depth, attribution UI, PPA
  workflow, tier→disposition wiring, materiality object, SoD multi-tenant org resolution.
- **NOT BUILT (8):** flux/variance auto-narrative + gate, roll-forward schedules, audit-evidence
  packager, PBC automation, currency translation, close analytics, kill-switch/throttle surface,
  covenant monitor.

*One doc, analysis/spec only — no code changed.*
