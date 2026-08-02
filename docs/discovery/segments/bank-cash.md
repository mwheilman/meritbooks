# Segment Deep-Dive — Bank & Cash Management (Treasury)

**Authors:** a Treasury / cash-management leader (25+ yrs across holdcos, PE portfolios, and
multi-bank operating groups) paired with a senior AI engineer.
**Scope:** the Bank & Cash Management segment of MeritBooks — bank feeds, categorization,
reconciliation, cash positioning, forecasting, funding/liquidity, and the fraud/leak controls that
sit on top of the cash accounts. **Analysis & specification only — no code changed.**
**Grounding:** `docs/canon/CANON-ANCHOR.md`, `docs/discovery/books/controller-cfo.md`,
`docs/discovery/books/bookkeeper-processor.md`, `docs/FPB-bank-reconciliation.md`, plus a live read
of the bank-feed / reconciliation / cash / forecast code (Session 41, `main`).

**Canon frame that governs every item below:** MeritBooks **owns the GL** and is an *autonomous
accounting workforce + a supervision/trust layer*. So each capability is stated as **AI proposes a
fact → the deterministic engine posts → a human approves**, with **auto-post OFF by default** and
autonomy a per-tenant, per-task dial. **Money never moves autonomously** — money movement is
preparer≠approver with explicit human release (DB CHECK + service; `042/043`). Everything is
**bigint cents**; AI routes only through `@meritbooks/core-ai` (metered, tenant-budget capped); every
AI action lands in the Decision Log (`core.action_log` / `ai_decisions`). Nothing here is
Merit-specific. Items are tagged **[common-core]** (ship to every tenant) or **[segment-specific]**.

---

## Part 1 — How treasury / cash management actually runs (and where it leaks)

Treasury is a *daily* discipline layered under the monthly close. The org chart says "the controller
reconciles monthly"; reality is that someone touches cash every single morning, and the money either
lands where it should or it doesn't. Below is the real operating loop and, for each stage, the leaks.

### 1.1 The daily cash cycle (before anything else happens)

**Morning cash positioning (07:00–08:00).** Pull yesterday's *ending ledger + available* balances
across every entity and every bank. In a holdco with 10–20 operating entities and 6–8 banks that is
40–80 accounts. Someone keys them into a spreadsheet (the "cash sheet"), nets them to a concentration
view, and answers three questions: *do we have enough to clear today's outflows; is any account below
its minimum; is there idle cash to sweep or invest.* **This is 30–60 minutes of manual re-keying,
every day, and it is stale the moment it's printed.**

- **Leak — stale/blind position.** A balance pulled at 7am is wrong by 9am; decisions get made on a
  number that already moved. Multi-bank means no single pane of glass, so the true consolidated
  position is a mental estimate.
- **Leak — idle cash drag.** Cash sitting in a non-interest DDA above the operating minimum is
  measurable lost yield (at 4–5% short rates, $2M idle = ~$80–100K/yr forgone). Nobody sweeps because
  nobody has time to compute the sweepable surplus per account each morning.
- **Leak — trapped cash.** In a multi-entity group, Entity A is overdrawn and drawing revolver
  interest while Entity B sits on surplus, because there is no netting/pooling view.

**Positive-pay / ACH-filter exceptions (bank-imposed morning deadline, ~10:00–11:00).** Banks present
a daily list of checks and ACH debits that *don't match* what treasury told them to expect (positive
pay = issued-check file vs. presented items; ACH debit filter = allowed originators). Treasury must
**pay or return each exception before the bank's cutoff** or the bank makes the default decision.

- **Leak — fraud gets paid.** Miss the window and a fraudulent/altered check or an unauthorized ACH
  debit clears and is far harder to claw back. Check fraud and BEC are the #1 and #2 payment-fraud
  vectors; the positive-pay window is the last human gate.
- **Leak — false-positive fatigue.** A legit check flagged (payee-name mismatch from an OCR quirk)
  gets returned, bouncing a real vendor payment.

**Clear today's outflows / fund the day.** Decide which AP runs, payroll files, tax payments, and
debt-service drafts go today, and **fund the disbursement/concentration accounts** to cover them.

- **Leak — overdraft / NSF.** An unfunded account + a large draft = overdraft fees, returned items,
  and a bank-relationship ding. Worst case, a **missed payroll or debt-service date** — an existential
  event, not a fee.
- **Leak — surprise drafts.** Auto-drafted items (loan payments, insurance, tax) hit accounts nobody
  was watching.

### 1.2 The transaction-capture loop (all day, every entity)

**Bank & card feed categorization.** Overnight the feed dumps hundreds of lines — every checking,
savings, and 3–5 credit cards per entity. Each line needs: *who is this* (cryptic descriptors, one
vendor under six strings), *what GL account* (supplies vs. job material vs. capitalizable), *which
entity/dimension* (a shared card spans three entities), and *is it already booked as a bill* (the
feed-vs-bill double-count). This is the single largest labor sink and the largest error surface.

- **Leak — miscoded P&L.** Tired coding at 7:30am distorts departmental/entity margins; management
  decides on wrong numbers.
- **Leak — uncoded pile.** Lines that can't be confidently coded get parked in "Uncategorized / Ask My
  Accountant." 1–5% of transactions sit uncoded at any time; it becomes month-end archaeology.
- **Leak — double-count.** Payment in the feed **and** the bill both booked → expense recognized twice.

**Deposits / cash application (inflows).** A lump ACH/wire/lockbox deposit has to be split across the
open invoices it settles. Deceptively manual: "which of their 5 open invoices does this $9,000 cover?"

- **Leak — mis-applied cash / bad AR.** Wrong application corrupts AR aging and DSO; a customer looks
  past-due when they paid, or vice versa.

### 1.3 Reconciliation (continuous, formalized monthly)

The non-negotiable control: **book (GL cash) must equal the bank** at period end, to *zero*. Match
every book line to a statement line; isolate the true exceptions (uncleared checks, un-booked fees,
timing, a transposed digit); book adjusting entries; sign off.

- **Leak — the last few dollars.** "Book 14,203.11, statement 14,251.86" burns an hour per account
  hunting a transposition, a missed fee, a duplicate, or a stale check — × N accounts × N entities.
- **Leak — un-booked bank fees/interest.** Statement lines the book never captured silently drift the
  balance and, uncorrected, understate expense.
- **Leak — stale outstanding checks.** Checks issued months ago that never cleared sit as "outstanding"
  forever, overstating outflow and masking escheatment/void candidates.
- **Leak — reconciliation that never ties.** A book that closes "close enough" instead of to zero is a
  book of record you cannot certify — trust collapse.

### 1.4 Forecasting & funding (weekly, the CFO's forward look)

**The 13-week direct cash forecast** is the treasury standard: starting cash → weekly inflows (AR by
expected-collection date) − weekly outflows (AP by due date, plus payroll, debt service, tax,
recurring commitments) → weekly closing balance and low-water mark. Drives funding, revolver draws,
sweep timing, and the covenant/liquidity conversation.

- **Leak — naive timing.** Forecasting AR at the invoice due date is fiction; customers pay to their
  *behavior*, not your terms. A forecast that ignores actual days-to-pay is optimistic and wrong.
- **Leak — missing the scheduled outflows.** Payroll, debt service, tax estimates, and recurring
  drafts are the largest, most certain outflows — a forecast built only from open AP/AR misses them
  and shows false comfort.
- **Leak — covenant surprise.** Discovering a DSCR / leverage / minimum-liquidity covenant tripped
  *after* quarter-end, when it's too late to cure — waiver fees, default-rate interest, cash sweeps,
  cross-default. The CFO's career risk. **[segment-specific — leveraged tenants]**

### 1.5 Fraud & control surface (always on)

Beyond positive pay: **vendor bank-detail changes** (the #1 BEC vector — "update our remittance
account"), **duplicate/erroneous payments** (~0.1–0.5% of AP spend, much never recovered),
**bank-fee creep** (banks re-price; nobody audits the analysis statement), and **segregation of
duties** (the same person prepares and releases a wire). New with autonomy: **the AI is an actor** and
must be inside SoD too — it proposes, a human with the right role releases, both are logged.

### 1.6 The core truth (what the system must do)

Most of treasury is **labor** (pulling balances, coding lines, matching, hunting differences) and a
thin slice is **judgment** (fund/sweep decisions, covenant risk, fraud adjudication, reconciliation
sign-off). An owned-ledger AI's job: **collapse the labor to near-zero and surface the judgment early
with the numbers already computed** — automate the toil, gate the controls, never move money or clear
a reconciliation without a named human.

---

## Part 2 — Capability catalog (36 capabilities)

For each: **what it does · trigger/data · gateway bucket · human-in-loop · value · build-state.**

**Gateway buckets** (how a proposal is dispositioned): **auto-clear** (safest tier, only if the
per-tenant autonomy dial is ON) · **review-queue** (drafted, one-click/batch human approve) ·
**escalate** (hard-stop to a named human) · **detect-only** (advisory alert to `/exceptions`, no
ledger effect) · **human-release** (money movement — preparer≠approver, explicit release).

**Build-state legend:** ✅ Built · 🔶 Partial · 🟡 Detect-only-built · ❌ Missing · 🌱 Seam-only.

### Group A — Feed capture & categorization

**A1. Bank & card feed ingestion (Plaid) — [common-core]**
- *What:* Pull transactions + balances from connected bank logins via Plaid `/transactions/sync`
  (incremental by cursor), dedupe, map Plaid accounts → `bank_accounts`, detect re-auth
  (`ITEM_LOGIN_REQUIRED`). *Trigger/data:* scheduled/`/sync`; `plaid_items` cursor. *Bucket:* n/a
  (ingest). *Human:* connect/re-auth via Plaid Link. *Value:* the raw material for everything else;
  kills manual statement download. *Build-state:* ✅ **Built, live (GATE 12.0)** — mig `046/048/049`,
  `/api/integrations/plaid/*`, `plaid-link-button`.

**A2. AI bank-feed auto-categorization — [common-core]**
- *What:* Propose GL account + vendor + department for each line, with confidence + reasoning. Tier-1
  free deterministic vendor-pattern match; Tier-2 gateway AI when no confident pattern. *Trigger/data:*
  new feed line; `vendor_patterns` history (mig 040); composite score. *Bucket:* review-queue (sorted
  **lowest-confidence-first**); auto-clear only within the dial. *Human:* one-click / batch approve;
  approve the doubtful. *Value:* removes the 60–90 min/day grind; the flagship trust-builder.
  *Build-state:* ✅ **Built** — `lib/services/categorization.ts`, `/api/bank-feed/categorize|approve`,
  `bank-feed` page (confidence bars, batch approve, keyboard shortcuts).

**A3. Vendor-pattern learning loop — [common-core]**
- *What:* Every confirmed coding writes back to `vendor_patterns` so Tier-1 catches the repeat for
  free; the system gets cheaper and more confident over time. *Trigger/data:* human approve/redirect.
  *Bucket:* n/a (learning). *Human:* implicit (the approval is the label). *Value:* compounding
  automation rate; lower AI spend. *Build-state:* ✅ **Built** (`learnVendorPattern`).

**A4. Duplicate / already-booked detection on the feed — [common-core]**
- *What:* Flag a feed line whose payment already appears as a booked bill (and vice versa) — the
  feed-vs-bill double-count. *Trigger/data:* feed import + open bills; fuzzy vendor+amount+date.
  *Bucket:* escalate (blocking, side-by-side). *Human:* choose duplicate/discard vs. genuinely
  different; never auto-delete. *Value:* prevents double-expensing. *Build-state:* 🔶 **Partial** —
  duplicate-payment control (D1) exists as detect-only; the *feed-vs-bill* variant at categorization
  time is not an explicit blocking gate.

**A5. Split & dimension tagging on a shared card — [common-core]**
- *What:* One card line split across entities/departments/jobs; propose the split from history.
  *Trigger/data:* multi-dimension card usage. *Bucket:* review-queue. *Human:* confirm the split.
  *Value:* correct entity/departmental P&L on shared cards. *Build-state:* 🔶 **Partial** — edit panel
  supports GL/dimension edit; no first-class multi-line split proposal.

### Group B — Reconciliation

**B1. Statement reconciliation (classic controller flow) — [common-core]**
- *What:* Enter statement ending balance + outstanding items; server computes GL cash as-of period end;
  `difference = GL − adjusted`; `is_reconciled` at zero. *Trigger/data:* period end; `bank_reconciliations`
  (mig 007). *Bucket:* human sign-off. *Human:* controller finalizes. *Value:* the non-negotiable
  control artifact. *Build-state:* 🔶 **Partial** — totals-only modal; no per-line check-off / running
  diff-to-$0, no explicit finalize/lock (per FPB D4/D5).

**B2. AI reconciliation autopilot — [common-core]**
- *What:* Split statement lines into cleared vs. uncleared; propose the best match per uncleared line
  (open bill or learned vendor pattern) with the **FROZEN composite score (Vendor 40% + Amount 40% +
  Date 20%)** → `scoreToTier` (auto/review/escalate). *Trigger/data:* account+period; `reconciliation-match.ts`.
  *Bucket:* review-queue / escalate (accept stages match; reject → `/exceptions`). *Human:* adjudicate;
  every proposal + decision audited. *Value:* does the 95% mechanical matching; **beats QBO** with
  tiered auto/review + Decision Log. *Build-state:* ✅ **Built** (browser-verify still open, task #18) —
  `/api/reconciliation/autopilot`.

**B3. Per-line cleared/reconciled linkage — [common-core]**
- *What:* Durable link from each cleared bank line → the reconciliation run + `reconciled_at`, enabling
  line-level audit, finalize-lock, and unreconcile. *Trigger/data:* accept a match. *Bucket:* n/a.
  *Human:* n/a. *Value:* the keystone the FPB flags — without it undo/lock/line-audit are impossible.
  *Build-state:* ✅ **Built (data model)** — mig 065 added `reconciliation_id` + `reconciled_at`; UI
  wiring to finalize/lock is 🔶 partial.

**B4. In-reconciliation adjusting entries (bank fee / interest / error) — [common-core]**
- *What:* Book the un-captured statement line from inside the rec so it ties to $0 — DR Bank-Fee /
  CR Cash, or DR Cash / CR Interest Income — direction derived mechanically from account type; posts
  through `postJournalEntry`, respects period lock, mirrors as a `bank_transactions` line so it clears.
  *Trigger/data:* non-zero difference. *Bucket:* human approve → engine posts. *Human:* approve the
  adjustment. *Value:* closes the residual difference correctly. *Build-state:* ✅ **Built** —
  `reconciliation-adjustment.ts` (+ tests), `/api/reconciliation/adjustment`.

**B5. "Find the difference" AI diagnosis — [common-core]**
- *What:* When the rec won't tie, surface likely culprits: a single line equal to the difference, a
  transposition, a duplicate, a missed fee. *Trigger/data:* non-zero difference + candidate lines.
  *Bucket:* detect-only (advisory) → feeds B4. *Human:* pick the fix. *Value:* kills the hour-per-account
  hunt. *Build-state:* ❌ **Missing** (FPB D6.2, deferred).

**B6. Unreconcile / undo with audit — [common-core]**
- *What:* Re-open a finalized rec, un-clear its linked lines, reverse adjusting entries (or block if the
  period is closed), full trail. *Trigger/data:* authorized request. *Bucket:* escalate (role-gated).
  *Human:* elevated role. *Value:* correct mistakes without silent mutation. *Build-state:* ❌ **Missing**
  (now *possible* on mig 065; FPB Wave B).

**B7. Statement import (CSV/OFX/QFX) + manual line entry — [common-core]**
- *What:* Import a downloaded statement / hand-enter lines for accounts Plaid can't connect; dedupe vs.
  feed; reconcile feed against the *official* statement. *Trigger/data:* uploaded file. *Bucket:*
  review-queue (dupe detection). *Human:* confirm import. *Value:* covers non-feed accounts; catches
  feed miss/duplicate. *Build-state:* ❌ **Missing** (FPB D2).

**B8. Deposit → open-invoice matching (AI cash application) — [common-core]**
- *What:* Match an unmatched inbound deposit to the open AR invoice(s) it settles; propose the
  application (handles splits/partials); a human approves and the existing payment-application path
  posts DR Cash / CR AR. Idempotent (dedup_key `cashapp:<bank_txn_id>`, mig 070). *Trigger/data:*
  unmatched deposit + open invoices. *Bucket:* review-queue (proposal → `/exceptions`); posts only on
  approve. *Human:* approve (gated on `invoices:approve`). *Value:* fixes mis-applied cash / AR aging;
  the symmetric inflow side of the autopilot; **beats QBO**. *Build-state:* ✅ **Built (detect/propose,
  GATE 8)** — `lib/controls/cash-application.ts`, `/api/controls/cash-application`.

**B9. Split / grouped-deposit & inter-account transfer detection — [common-core]**
- *What:* One deposit → many invoices; one bank line → many bills; and detect offsetting lines across
  the tenant's own accounts as a **transfer** (not income/expense). *Trigger/data:* matched offsetting
  pairs. *Bucket:* review-queue. *Human:* confirm transfer/split. *Value:* stops phantom
  income/expense on internal moves; matches QBO/Sage. *Build-state:* ❌ **Missing** (FPB D3.2/D3.3).

**B10. Reconciliation report (PDF) + outstanding-items aging — [common-core]**
- *What:* The auditable artifact — beginning balance, cleared deposits/checks, ending balance,
  outstanding items, book balance, difference; plus a stale/uncashed-check aging report. *Trigger/data:*
  finalized rec. *Bucket:* n/a (report). *Human:* review/export. *Value:* audit evidence; surfaces
  escheatment/void candidates. *Build-state:* ❌ **Missing** (FPB D9).

**B11. Reconciliation-required close gate — [common-core]**
- *What:* Period cannot HARD_CLOSE until every active bank account is reconciled to $0; auto-verified
  from `bank_reconciliations.is_reconciled`. *Trigger/data:* close checklist; `fiscal_periods`.
  *Bucket:* hard gate. *Human:* override with reason + audit only. *Value:* no book closes with an
  un-tied bank account; **beats QBO**. *Build-state:* 🔶 **Partial** — modal blocks HARD_CLOSE
  reconciling; not yet an auto-verified checklist gate (FPB D10).

### Group C — Cash position & liquidity

**C1. Real-time multi-account / multi-entity cash-position dashboard — [common-core]**
- *What:* Every active bank account's current + available balance, grouped by entity (location),
  consolidated total, per-entity cash-health band (HEALTHY/ADEQUATE/NEAR_MINIMUM/CRITICAL) vs. each
  entity's `minimum_cash_cents`, critical/near-min counts. RLS-scoped. *Trigger/data:* `bank_accounts`
  balances (Plaid-fed) + `core.locations.minimum_cash_cents`. *Bucket:* n/a (dashboard). *Human:*
  reads it each morning. *Value:* replaces the 30–60 min manual cash sheet with a single live pane.
  *Build-state:* ✅ **Built** — `/api/cash`, `cash-dashboard.tsx`. *Gap:* balance freshness depends on
  Plaid sync cadence; no intraday auto-refresh; no AI recommendations yet.

**C2. Balance-freshness / stale-feed monitor — [common-core]**
- *What:* Flag accounts whose `balance_updated_at` is stale or whose Plaid item is `login_required`, so
  the position isn't trusted blindly. *Trigger/data:* `plaid_items.status`, `balance_updated_at`.
  *Bucket:* detect-only. *Human:* re-auth. *Value:* prevents deciding on a dead feed. *Build-state:*
  🔶 **Partial** — status exists on `plaid_items`; a first-class staleness alert on the dashboard is
  missing.

**C3. Cash-requirement / payroll & debt-service safety alert — [common-core]**
- *What:* Compare projected available cash against **known scheduled outflows** (upcoming payroll
  file, debt-service drafts, tax estimates) and raise a graduated alert if an account will not cover a
  dated obligation. *Trigger/data:* forecast + payroll run dates (mig 069) + scheduled commitments.
  *Bucket:* escalate (alert). *Human:* treasury funds/moves. *Value:* prevents a missed payroll/
  debt-service date — existential. *Build-state:* ❌ **Missing** (forecast has a generic negative-week
  warning but does not know payroll/debt dates).

**C4. Sweep / idle-cash optimization — [common-core (deeper for multi-entity)]**
- *What:* Compute per-account sweepable surplus above the operating minimum + buffer and **propose** a
  sweep to a concentration/interest account (or a paydown of a drawn revolver). *Trigger/data:*
  balances + minimums + (optional) rate assumptions. *Bucket:* **human-release** (proposal only — money
  movement is preparer≠approver, explicit release; AI never initiates a transfer). *Human:* treasury
  approves the transfer. *Value:* recovers idle-cash yield / cuts revolver interest. *Build-state:*
  ❌ **Missing**.

**C5. Intercompany cash pooling / netting view — [segment-specific — multi-entity]**
- *What:* Net surplus and deficit accounts across entities into a group position; propose
  intercompany funding (with the matching IC loan/AP-AR entry) instead of an external revolver draw.
  *Trigger/data:* per-entity balances + IC framework (mig 035). *Bucket:* human-release + review-queue
  (the IC booking). *Human:* approve the pool move + IC entry. *Value:* stops paying revolver interest
  while a sister entity sits on cash; the classic holdco win. *Build-state:* ❌ **Missing** (IC ledger
  plumbing exists; the treasury pooling view/proposal does not).

### Group D — Forecasting

**D1. 13-week direct cash forecast — [common-core]**
- *What:* Starting cash = active CHECKING/SAVINGS balances; inflows = open AR by due date; outflows =
  open AP by due date; roll weekly opening → net → closing across 13 weeks; per-entity or consolidated;
  drill-down per week; low-water-mark negative-week warning. Pure, testable engine. *Trigger/data:*
  `bank_accounts`, open `invoices`, open `bills`. *Bucket:* n/a. *Human:* reads/acts. *Value:* the
  treasury standard forward look. *Build-state:* ✅ **Built** — `lib/cash/forecast.ts`, `/api/forecast`,
  `forecast-grid.tsx`.

**D2. Driver-based / behavior-adjusted forecast — [common-core]**
- *What:* Replace naive "AR at due date" with **predicted collection date** from each customer's actual
  days-to-pay history; add recurring/seasonal drivers. *Trigger/data:* historical payment behavior per
  customer; recurring templates. *Bucket:* review-queue (assumptions surfaced). *Human:* accept/adjust
  drivers. *Value:* turns a fiction into a decision-grade forecast. *Build-state:* ❌ **Missing**
  (current model buckets purely by due date).

**D3. Scheduled-outflow overlay (payroll / debt / tax / recurring) — [common-core]**
- *What:* Fold the large certain outflows into the forecast: payroll run schedule (mig 069), loan
  amortization (interest+principal), tax estimate dates, recurring drafts. *Trigger/data:* payroll runs,
  loan schedules, recurring templates. *Bucket:* n/a (forecast input). *Human:* confirm schedules.
  *Value:* the forecast stops missing its biggest, most-certain outflows. *Build-state:* ❌ **Missing**
  (forecast is AR/AP-only today).

**D4. Scenario / what-if & funding recommendation — [common-core]**
- *What:* "If we delay these discretionary payments / accelerate these collections / draw $X on the
  revolver, here's the new low-water mark." Propose the minimum funding move to stay above zero.
  *Trigger/data:* forecast + leverable AP/AR + facilities. *Bucket:* review-queue → **human-release** for
  any actual draw. *Human:* choose the scenario / approve the draw. *Value:* turns the forecast into a
  plan. *Build-state:* ❌ **Missing**.

### Group E — Fraud & payment controls

**E1. Duplicate / erroneous payment prevention (EC-1) — [common-core]**
- *What:* Fuzzy-match invoice#+vendor+amount+date against prior payments; hard-flag suspected
  duplicates. *Trigger/data:* bill entry + payment history. *Bucket:* detect-only today → should be
  escalate/blocking. *Human:* adjudicate merge/discard. *Value:* ~0.1–0.5% of AP spend at risk.
  *Build-state:* 🟡 **Detect-only built** — `lib/controls/duplicate-payments.ts` → `/exceptions`.

**E2. Vendor bank-change / BEC detection — [common-core]**
- *What:* Detect a new-or-changed vendor remittance bank account (the #1 BEC vector) and **hard-block
  payment** pending out-of-band verification; never auto-pay a banking change. *Trigger/data:* vendor
  master banking-field change. *Bucket:* escalate (blocking) + human-release. *Human:* verify + second
  approver. *Value:* stops wire fraud — the highest-dollar single-event loss. *Build-state:* ❌ **Missing**
  (vendor-compliance engine exists for W-9/COI; bank-change monitoring is not wired).

**E3. Positive-pay / issued-check file — [segment-specific — check-issuing tenants]**
- *What:* Generate the daily issued-check file to the bank; ingest and adjudicate the bank's positive-
  pay exception list (payee/amount/serial mismatch) before the cutoff. *Trigger/data:* checks issued;
  bank exception feed. *Bucket:* escalate (per-exception pay/return, deadline-driven). *Human:* decide
  each exception. *Value:* the last gate against check fraud. *Build-state:* ❌ **Missing**.

**E4. ACH debit filter / unauthorized-debit detection — [segment-specific]**
- *What:* Maintain the allowed-originator list; flag any ACH debit hitting an account from an
  unapproved originator. *Trigger/data:* feed debits vs. allow-list. *Bucket:* escalate. *Human:*
  authorize/return. *Value:* catches unauthorized drafts. *Build-state:* ❌ **Missing**.

**E5. Bank-fee anomaly / analysis-statement audit — [common-core]**
- *What:* Track recurring bank fees per account; flag a new fee, a fee that jumped, or a service the
  tenant no longer uses; reconcile the analysis statement. *Trigger/data:* fee lines in the feed +
  historical baseline. *Bucket:* detect-only. *Human:* dispute/negotiate. *Value:* banks re-price
  quietly; this recovers real dollars. *Build-state:* ❌ **Missing** (the bill-anomaly control is the
  nearest analogue but not bank-fee-specific).

**E6. NSF / return / overdraft tracking — [common-core]**
- *What:* Detect NSF/returned-item and overdraft-fee lines; alert, and (for a returned customer
  deposit) reverse the cash application and re-open the invoice. *Trigger/data:* feed return codes.
  *Bucket:* escalate + review-queue (the reversal). *Human:* approve reversal / follow up. *Value:*
  keeps AR honest after a bounced payment; flags overdraft leakage. *Build-state:* ❌ **Missing**.

**E7. Interest & investment-income tracking — [common-core]**
- *What:* Recognize interest credits and sweep/investment returns to the right income account (not
  miscoded to "other"), and track expected vs. received on swept balances. *Trigger/data:* interest
  lines; sweep terms. *Bucket:* review-queue. *Human:* confirm coding. *Value:* correct income
  recognition; validates the sweep is actually earning. *Build-state:* 🔶 **Partial** — B4 can book
  interest inside a rec; no standing interest-tracking capability.

**E8. Segregation-of-duties on money movement (incl. AI) — [common-core]**
- *What:* Preparer ≠ approver on any transfer/wire/payment; explicit human release; the AI (a proposer)
  can never also release; every step attributed. *Trigger/data:* money-movement request. *Bucket:*
  human-release (DB CHECK + service). *Human:* second, authorized person. *Value:* the whole control of
  a book of record. *Build-state:* ✅ **Built** — mig 042/043, money-movement approvals + posting; RBAC
  reconciliation to Core identity is the open gate (#9/#33).

### Group F — Compliance, covenants & advanced (segment)

**F1. Covenant / liquidity monitoring — [segment-specific — leveraged tenants]**
- *What:* Machine-readable covenant definitions (DSCR, fixed-charge coverage, leverage/debt-to-EBITDA,
  current ratio, minimum liquidity, TNW) computed **daily on actuals + forecast**; graduated
  green/amber/red with projected breach date; draft the compliance certificate. *Trigger/data:* credit-
  agreement terms + live/forecast GL + (where relevant) borrowing base. *Bucket:* escalate (alert) →
  human sign (never auto-file a certification). *Human:* CFO reviews + signs. *Value:* prevents the
  after-the-fact covenant surprise — existential. *Build-state:* ❌ **Missing** (no covenant model).

**F2. Borrowing-base / eligible-collateral monitor — [segment-specific — ABL tenants]**
- *What:* Compute eligible AR/inventory against advance rates and ineligibility rules; flag when a
  borrowing-base certificate would over-state availability (lending against aged/ineligible AR is a
  violation). *Trigger/data:* AR aging + inventory + BB rules. *Bucket:* detect-only → human sign.
  *Human:* CFO. *Value:* keeps draws inside the base; audit-safe BB certificate. *Build-state:* ❌
  **Missing**.

**F3. FX exposure / multi-currency seam — [segment-specific — cross-border tenants]**
- *What:* Track balances and exposures by currency; flag net open FX position; (later) revaluation.
  *Trigger/data:* multi-currency accounts. *Bucket:* detect-only. *Human:* treasury hedges.
  *Value:* visibility into FX risk. *Build-state:* 🌱 **Seam-only** — single-currency (cents) today;
  no currency dimension. Explicitly a future seam.

**F4. Deposit-timing / float optimization — [segment-specific]**
- *What:* Flag deposits held longer than needed and model availability/float to optimize when funds are
  usable. *Trigger/data:* deposit dates + availability schedules. *Bucket:* detect-only. *Human:*
  treasury. *Value:* faster access to cash. *Build-state:* ❌ **Missing**.

**F5. Unreconciled-aging control — [common-core]**
- *What:* Continuous three-way tie (feed ↔ GL ↔ subledger); age unreconciled items; flag accounts
  drifting from a clean rec; surface stale outstanding checks. *Trigger/data:* rec status + item ages.
  *Bucket:* detect-only → `/exceptions`. *Human:* clear/adjust. *Value:* nothing rots un-reconciled
  between closes. *Build-state:* 🔶 **Partial** — autopilot isolates exceptions; a standing aging
  control across accounts/periods is not built.

**F6. Intercompany cash-balance control (EC-3) — [segment-specific — multi-entity]**
- *What:* Ensure every IC cash move has an equal-and-opposite entry in the counterpart entity; flag
  IC imbalance before consolidation. *Trigger/data:* IC transactions (mig 035). *Bucket:* detect-only.
  *Human:* adjudicate timing diffs. *Value:* clean consolidation eliminations. *Build-state:* 🟡
  **Detect-only built** — `lib/controls/intercompany-balance.ts`.

**F7. Uncategorized / cash-leakage control (EC-4) — [common-core]**
- *What:* Age items in suspense/uncategorized and un-coded feed lines; gate close on the queue being
  empty. *Trigger/data:* uncoded lines. *Bucket:* detect-only → review-queue. *Human:* code/redirect.
  *Value:* correct margins; no close with unknowns. *Build-state:* 🟡 **Detect-only built** —
  `lib/controls/uncategorized-leakage.ts`.

**F8. Anomalous-transaction detection (EC-10) — [common-core]**
- *What:* Flag unusual cash-account entries (round-dollar spikes, off-hours, atypical vendor/amount) for
  review. *Trigger/data:* posted entries + baseline. *Bucket:* detect-only. *Human:* review. *Value:*
  catches error/fraud the rules miss. *Build-state:* 🟡 **Detect-only built** — `lib/controls/anomalous-je.ts`.

**F9. Autonomy dial + batch-accept (governance) — [common-core]**
- *What:* Per-tenant, per-task switch to enable auto-clear for the *safest* tier only (SoD on the AI:
  proposer ≠ finalizer), plus one-action batch-accept of a tier; OFF by default; every action logged.
  *Trigger/data:* tenant config. *Bucket:* configures auto-clear. *Human:* sets the dial. *Value:*
  earns automation as trust builds without ever losing the audit. *Build-state:* ❌ **Missing** (tiering
  computes an `auto` count but there is no auto-accept path; FPB D7.1).

**F10. Decision Log / immutable audit for all cash actions — [common-core]**
- *What:* Every AI proposal + human decision on a cash line/rec/application → `core.action_log` /
  `ai_decisions`, reversible and attributable, traceable to source. *Trigger/data:* every action.
  *Bucket:* n/a. *Human:* inspects/reverses. *Value:* the trust franchise — certify any number.
  *Build-state:* ✅ **Built** — `logAction`/`logHumanAction`, `ai_decisions` (mig 039/070).

**F11. Cash-flow statement (indirect) reporting — [common-core]**
- *What:* Generate the GAAP indirect cash-flow statement from the GL (RLS-scoped). *Trigger/data:* GL.
  *Bucket:* n/a (report). *Human:* review. *Value:* the required statement, book-of-record clean.
  *Build-state:* ✅ **Built** — `/api/reports/cash-flow`.

---

## Part 3 — Ranked build-first shortlist → gates (each needs its own FPB)

Ranked by (control value + treasury demand) × (leverages what's already built). Everything behind the
mandatory wave pipeline (FPB → disjoint slices → builder wave → verifier + chrome-auditor + **security**
for money/identity → reviewer → integrate → scribe); migrations to Supabase first.

**Tier 1 — finish the reconciliation moat (GATE 8; extends `FPB-bank-reconciliation.md`).** The keystone
data model (mig 065) already shipped; convert it into the controller mechanics.
1. **B1/B3/B6 — per-line check-off to $0, explicit finalize/lock, unreconcile-with-audit.** Highest
   control value; unblocks everything downstream. *FPB: exists (bank-rec) — build to Waves B.*
2. **B11 — reconciliation-required close gate** (auto-verified from `bank_reconciliations`). *Same FPB.*
3. **B7 — statement import (CSV/OFX/QFX) + manual line entry.** Covers non-Plaid accounts. *Same FPB.*
4. **B10 — reconciliation report (PDF) + stale-outstanding-check aging.** Audit artifact. *Same FPB.*

**Tier 2 — make the cash forecast decision-grade (new GATE, FP&A pillar).**
5. **D3 — scheduled-outflow overlay (payroll/debt/tax/recurring)** then **C3 — payroll/debt-service
   safety alert.** Turns the forecast from AR/AP-only into a real liquidity guard; prevents a missed
   payroll date. *Needs a new **FPB: Cash Forecast & Liquidity**.*
6. **D2 — behavior-adjusted collection dates.** Kills the naive due-date fiction. *Same FPB.*

**Tier 3 — the fraud/leak controls treasury asks for first (new GATE, extends the Exception Library).**
7. **E2 — vendor bank-change / BEC blocking gate.** Highest-dollar single-event risk; grounds on the
   existing vendor-compliance engine. *Needs an **FPB: Payment-Fraud Controls** (positive-pay + BEC).*
8. **E1 — promote duplicate-payment from detect-only to a blocking gate** wired into the pay path.
   *Same FPB.*
9. **E5 — bank-fee anomaly** and **E6 — NSF/return handling** (return → reverse cash app, re-open
   invoice). *Same FPB.*

**Tier 4 — treasury optimization & multi-entity depth (new GATE; segment).**
10. **C4 — sweep / idle-cash optimization** (proposal → human-release) and **C5 — intercompany cash
    pooling** (multi-entity). *Needs an **FPB: Treasury Optimization** — must reconcile to the money-
    movement preparer≠approver contract.*
11. **F1 — covenant / liquidity monitoring** (leveraged tenants) — top of the segment paid-depth list.
    *Needs an **FPB: Covenant & Liquidity Monitoring**.*

**Cross-cutting (do alongside Tier 1):** **F9 — the autonomy dial + batch-accept** (so auto-clear is
possible where trust is earned) and **RBAC gate #9/#33** reconciliation for all cash/reconciliation/
money-movement permissions — both are prerequisites before any auto-clear or money-move capability ships.

**Deferred with reason:** B5 "find the difference" AI diagnosis (nice-to-have once B4 adjusting entries
are wired); F3 FX (seam-only until a cross-border tenant); F2 borrowing-base and F4 deposit-timing
(narrow segment). State each deferral in the Feature Completeness Ledger.

---

*End — `docs/discovery/segments/bank-cash.md`. Analysis/spec only; no product code changed.*
