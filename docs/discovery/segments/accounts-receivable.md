# Segment Deep-Dive — Accounts Receivable & Collections

**Authors' frame:** a 25-yr AR / credit-&-collections leader paired with a senior AI engineer.
This is an exhaustive operational reality + AI-automation catalog for the **AR & Collections**
segment of MeritBooks (Books, Module 1 of 12). Analysis/spec only — no code is changed here.

**Grounded in:** `docs/canon/CANON-ANCHOR.md` (hard invariants, gate state),
`docs/discovery/books/controller-cfo.md` (control/leak taxonomy),
`docs/discovery/books/AI-CAPABILITY-CATALOG.md` (§C AR/Collections; the seven gateway buckets),
and the live repo. Build-state below is reconciled against the actual codebase as of Session 41,
**not** against the FPB's stale "missing" claims — a great deal of AR shipped between the FPB and today.

**Canon rails that bind every capability here (do not restate per-row):**
- Books **owns the AR ledger and invoice numbering**; Customer/Job/Entity live in `core`, referenced
  by FK, stitched in JS via `fetchCoreMap` (no PostgREST embeds `core`↔`public`).
- Every posting goes through `postJournalEntry` / `check_journal_balance()` — **debits = credits or it
  does not post**. Direction is derived from account TYPE (there is no `EXPENSE` type; cost = COGS/OPEX).
- **All money is bigint cents.** Reference accounts **by role, not number** (AR 1100, Deferred Rev 2410,
  Unbilled/Contract Asset 1180 exist; BAD_DEBT_EXPENSE / LATE_FEE_INCOME are not yet first-class roles).
- **AI proposes facts; the deterministic engine posts; a human approves. AI never writes debits/credits
  and never moves money. Auto-post is OFF by default**; autonomy is a per-tenant, per-task dial.
- For a **rev-rec-managed job** the customer invoice credits **Deferred Revenue 2410, not Revenue**;
  `rev-rec.ts` owns recognition timing.
- Every AI action → the Decision Log (`public.ai_decisions`) and the human/AI action log; all AI routes
  through `@meritbooks/core-ai` (metered to `core.ai_usage_log`, tenant budget enforced across the suite).
- **Gateway buckets** (from the AI Capability Catalog): `CLASSIFY · EXTRACT · MATCH · DETECT · RECONCILE ·
  FORECAST · DRAFT`. Every capability below is tagged with the bucket(s) it consumes.

---

## Part 1 — The real AR lifecycle, and where every dollar leaks

AR is the mirror image of AP, but with a crucial asymmetry: **you control AP, you only influence AR.**
On the payables side you decide when and whether to pay; on the receivables side the money is in someone
else's bank account and your job is to make paying you the path of least resistance while protecting the
balance sheet from carrying receivables that will never convert to cash. The lifecycle:

### 1. Establish the customer & credit terms (before the first invoice)
Set up the customer master (in `core.customers`), assign **payment terms** (`payment_terms_days`, default 30),
a **credit limit** (`credit_limit_cents`), tax status, remit/bill-to, and contacts. For anything but tiny
tickets a real AR shop runs a **credit review**: trade references, a credit-bureau pull (D&B / Experian
Business), prior payment history, and sets a limit + terms accordingly. This is the cheapest place to
prevent a loss — bad debt is a credit decision made months earlier, not a collections failure.
- **Leak — over-extension / no credit discipline.** Shipping/servicing on open terms to a customer who
  can't or won't pay. The limit exists as a column but is not enforced anywhere in the flow today.
- **Leak — stale credit.** A customer that was good three years ago is now slow/insolvent; nobody re-reviews.

### 2. Generate the obligation (invoice / progress bill / recurring)
The revenue event happens (goods shipped, service delivered, milestone hit, subscription period elapsed),
and an invoice is cut. Sub-flavors: one-off invoice, **progress/AIA billing** (schedule of values,
G702/G703, retainage), **recurring** (subscriptions/retainers), **deposit/prepayment** invoices.
- **Leak — revenue leakage (work done, not billed).** The single largest and most invisible AR leak.
  Time, materials, change orders, pass-through costs, or usage that were delivered but never made it onto
  an invoice. In services/construction this routinely runs 1–5% of revenue and is pure margin lost. It is
  detected by tying **cost/WIP and contract progress to what has actually been billed** — which in the
  Suite means coordinating with the **Projects Billing Auditor** (JOB_COST vs JOB_BILLING/JOB_PROGRESS
  events) and the Unbilled/Contract-Asset 1180 roll-forward. *Books can see "billed < earned"; Projects
  owns "delivered but not yet earned/billed."*
- **Leak — billing errors.** Wrong price, wrong quantity, wrong tax, missing PO number → the customer
  parks the invoice (a silent dispute) and the clock doesn't start until you notice.
- **Leak — slow invoicing.** Every day between delivery and invoice is a day added to DSO before the
  terms clock even starts. "Bill on the day you deliver" is worth more than any collections tactic.

### 3. Deliver the invoice (and prove it arrived)
Email with a PDF and a **Pay Now** link, hosted page, portal, EDI, or mail. Track sent → delivered →
opened. A large share of "past due" is really "never received / went to the wrong AP inbox."
- **Leak — delivery failures.** Bounced email, wrong contact, no PO on the invoice so the customer's AP
  system rejects it. "Sent" is not "delivered"; "delivered" is not "approved for payment in their system."

### 4. Collect (the terms period, then the dunning ladder)
Before due: a courtesy pre-due reminder. On/after due: a **dunning ladder** of escalating reminders
(tone rising from friendly → firm → final notice → pre-collections), phone calls on large balances,
**promise-to-pay** capture, **payment-plan** negotiation, **credit hold** on new orders, and — last —
handoff to a collections agency or legal.
- **Leak — slow / inconsistent chasing = DSO drift.** Every extra day of DSO is working capital tied up
  and (if you borrow) real interest on the revolver. Manual chasing is uneven: the squeaky/large accounts
  get worked, the long tail rots. A dollar collected in 30 days vs 75 days is the difference between funding
  operations from customers or from your lender.
- **Leak — no memory of what was tried.** The collector re-sends the same note, or double-chases a customer
  who already promised to pay Friday, damaging the relationship.

### 5. Apply the cash (the deceptively hard part)
Money arrives as a Stripe/card settlement, an ACH, a wire, a mailed check, or a **lockbox** file — often a
**single lump deposit that pays many invoices**, sometimes **short-paid** (deduction/dispute), sometimes
with no remittance detail at all. Someone must match the deposit to the open invoices, apply it, and post
DR Cash/Clearing / CR AR — never re-recognize revenue.
- **Leak — misapplied / unapplied cash.** Cash sitting in a suspense/"on account" bucket because nobody
  could figure out what it paid. The customer thinks they're paid; your aging still shows them past due;
  you dun a paid customer and lose trust. Unapplied cash is an AR reconciliation failure that overstates AR.
- **Leak — short-pays swallowed.** A customer pays $9,200 on a $10,000 invoice. If you apply $9,200 and
  close it, you just wrote off $800 with no decision and no trail. The $800 is a **dispute/deduction** that
  needs adjudication, not silent absorption.

### 6. Disputes & deductions (the friction that stops payment)
The customer disputes price, quantity, damaged goods, a missing credit, a service complaint, or takes an
unauthorized deduction (chargeback/promotional/shortage). Payment freezes until resolved. Resolution =
research → valid (issue a credit memo) or invalid (require payment) → close.
- **Leak — disputes with no workflow.** They live in email and one collector's head. Aging shows the
  invoice as "just slow" when it's actually blocked. Un-worked disputes age into write-offs by default.

### 7. Adjust, credit, and (last resort) write off
Legitimate reductions → **credit memo** (DR Revenue/Deferred / CR AR), applied against the invoice or left
as customer credit / refunded. Uncollectible → **bad-debt write-off** (DR Bad Debt Expense / CR AR),
ideally against an **allowance for doubtful accounts** so the P&L reflects expected loss as receivables age,
not as a lumpy surprise.
- **Leak — bad-debt surprise.** No allowance, no early reserve; a big receivable goes from "asset at full
  value" to "gone" in one period, distorting EBITDA (and covenants). The controller's brief calls this out:
  stale AR carried at full value is a bad-debt time bomb and inflates the borrowing base (lending against
  aged/ineligible AR is itself a covenant violation).
- **Leak — write-off with no SoD.** Whoever collects can also write off = a fraud/embezzlement vector
  (lapping). Write-offs must be a segregated, approved action.

### 8. Reconcile & report (continuous + at close)
The **AR subledger must tie to the GL control account (1100)** every period; aging must be reviewed;
DSO/CEI trended; the allowance re-estimated; unapplied cash cleared to zero before close signs off.
- **Leak — subledger ≠ GL.** Silent drift between the AR control account and the sum of open invoices means
  one of your two "sources of truth" is wrong, and you can't certify AR.

**The core truth (mirrors the controller brief):** most of the AR month is *labor* (cut invoices, deliver,
chase, match cash, reconcile) and a few decisions are *judgment* (extend credit, adjudicate a dispute,
reserve/write off, negotiate a plan). MeritBooks' job is to **collapse the labor to near-zero and surface
the judgment early**, with humans supervising exceptions — never letting the machine move money, issue a
credit, or write off on its own.

---

## Part 2 — Comprehensive capability catalog (35 capabilities, grouped)

Each row: **what it does · trigger/data · gateway bucket · human-in-loop · value · build-state.**

Build-state legend: **BUILT** (shipped, functional-partial), **PARTIAL** (some of it exists),
**MISSING** (not started). All are behind the invoices FPB and the gate order; none is "Complete."

### Group A — Bill correctly & completely (stop revenue leakage at the source)

**A1. Product/Service item catalog driving invoice lines.**
Bill from a catalog item that carries default GL account, price, and tax code instead of typing a raw
description and hand-picking a GL account each time. · *Trigger/data:* `core` item master; line references
`item_id`. · *Bucket:* CLASSIFY (default resolution). · *HITL:* item defaults are editable per line. ·
*Value:* fewer mis-codes, faster invoicing, consistent revenue accounts. · **Build-state: MISSING** (lines
are raw description + manual account today; FPB D1.1).

**A2. Rev-rec-aware invoice posting (defer vs recognize).**
For a rev-rec-managed job the invoice credits **Deferred Revenue 2410** (+ 1180 unbilled remainder), not
the line revenue account; recognition posts separately by `rev-rec.ts`. · *Trigger/data:* job's effective
rev-rec method (per-job → per-revenue-type → company default). · *Bucket:* CLASSIFY. · *HITL:* UI shows the
resolved treatment before posting. · *Value:* ASC 606 correctness; native rev-rec is a moat vs QBO. ·
**Build-state: PARTIAL** — the JOB_BILLING event path (`billing-consumer.ts`) routes through rev-rec;
`create-invoice.ts` now carries rev-rec credit logic (`rev-rec-credit.ts` + tests). Verify the manual create
UI surfaces it (FPB D10).

**A3. Progress / AIA billing (schedule of values, G702/G703, retainage).**
Bill a % of a schedule of values with retainage withheld; construction-native. · *Trigger/data:* SOV lines,
`is_progress_bill`, `application_number`, retainage cascade (job→customer). · *Bucket:* CLASSIFY. · *HITL:*
issuer sets % complete per line (AI never invents % complete). · *Value:* BEAT vs QBO (weak here). ·
**Build-state: PARTIAL** — columns + retainage resolution exist; a first-class SOV entry UI is thin.

**A4. Recurring invoices (subscriptions / retainers) with auto-send.**
A template repeats on a cadence, generating a real invoice through the shared `createInvoice` core so
numbering/rev-rec/GL never fork; catch-up + idempotent. · *Trigger/data:* `recurring_invoice_templates`
(migration 073), `next_run_date`, cadence, occurrence/end limits. · *Bucket:* (scheduler; CLASSIFY on rev
treatment). · *HITL:* auto-send is a per-tenant autonomy dial (OFF by default). · *Value:* table-stakes
SMB feature; kills manual re-billing. · **Build-state: BUILT** (`lib/invoices/recurring-invoices.ts`,
`recurring-panel.tsx`, `/api/recurring-invoices`, tests).

**A5. Revenue-leakage detection (work done not billed).**
Flag delivered/earned value that has not been invoiced: WIP/cost with no matching billing, contract earned >
billed, expired-but-unbilled T&M, un-passed-through costs, change orders never billed. · *Trigger/data:*
JOB_COST vs JOB_BILLING/JOB_PROGRESS events (`core.events`), 1180 Contract-Asset roll-forward, cost-billing
seam. · *Bucket:* DETECT + RECONCILE. · *HITL:* proposal with $-at-risk → human bills or explains;
**coordinate with the Projects Billing Auditor** which owns delivered-but-not-yet-earned. · *Value:* recovers
1–5% of revenue that is pure margin. · **Build-state: PARTIAL** — the seam + 1180 exist and
`revenue-not-recognized.ts` control detects deferred-not-released; a dedicated *unbilled-WIP* detector for
Books is not yet built (belongs jointly with Projects).

**A6. Attachments & customer PO capture on the invoice.**
Attach the signed proposal / customer PO and stamp the PO number so the customer's AP system accepts the
bill. · *Trigger/data:* upload + `po_number` field. · *Bucket:* — (EXTRACT optional to read a PO PDF). ·
*HITL:* n/a. · *Value:* fewer rejected/parked invoices. · **Build-state: MISSING** (`po_number` column
exists, not captured in create UI; no attachments — FPB D1.2/D1.5).

**A7. Estimate / quote → invoice conversion.**
Turn an accepted estimate into an invoice without re-keying. · *Bucket:* — · *HITL:* n/a. · *Value:*
parity feature. · **Build-state: MISSING** (deferrable per FPB B8).

### Group B — Deliver & prove receipt

**B8. Branded invoice delivery (email + PDF + Pay Now) with distinct failure codes.**
Send a branded email with the PDF attached and a hosted Pay link; record SENT only after the provider
confirms a message id; distinct codes for no-provider / no-from / no-customer-email / send-failed. ·
*Trigger/data:* Resend provider, `invoice_templates` branding, `public_token`. · *Bucket:* — · *HITL:*
issuer triggers send. · *Value:* the invoice actually arrives with a working pay path. · **Build-state:
BUILT** (`/api/invoices/[id]/send`, `invoice-email.ts` tested, hosted `/pay/[token]`).

**B9. Delivery & open tracking (delivered / bounced / viewed).**
Prove the invoice arrived and was opened; surface bounces as a warning so the collector fixes the contact. ·
*Trigger/data:* Resend delivery/bounce webhook; hosted-page VIEWED event; `invoice_events`. · *Bucket:*
DETECT (bounce). · *HITL:* collector acts on a bounce. · *Value:* removes the "never received" class of
past-due. · **Build-state: PARTIAL** — VIEWED tracked and shown in the collections worklist; DELIVERED/bounce
webhook not consumed (FPB D3.3).

**B10. CC / multiple recipients / "send me a copy" / custom message.**
Send to several AP contacts, CC the sender, edit the cover message. · *Bucket:* — · *HITL:* issuer. ·
*Value:* matches how AP departments actually receive bills. · **Build-state: MISSING** (single
`core.customer.email` today — FPB D4.1).

**B11. Self-serve customer portal (all invoices, history, pay any/many).**
A logged-or-tokenized customer sees every open + historical invoice, statements, and can pay one, several,
or the whole balance, download PDFs, and raise a dispute. · *Trigger/data:* `biz_invoices` business-view
(defined in RBAC, not built), org+customer scoping. · *Bucket:* — · *HITL:* n/a (customer self-service). ·
*Value:* fewer "please resend," faster payment, deflects statement requests. · **Build-state: MISSING** —
only a **single-invoice** hosted `/pay/[token]` page exists; no multi-invoice portal (FPB B18).

### Group C — Collect (the dunning + credit engine)

**C12. Collections / DSO command center + collector worklist.**
Aging buckets (as-of date, age-by-due-or-invoice-date), headline KPIs (Total AR, Overdue AR, % Current,
**DSO**, **avg days-to-pay**), a **priority-ranked worklist** ($×age) carrying each invoice's real
delivery timeline (last sent/viewed/reminded), and a per-customer rollup with drill-down. · *Trigger/data:*
live invoices + `invoice_events` (no snapshot table); RLS-scoped. · *Bucket:* DETECT/aggregation. · *HITL:*
read-first situational awareness; one-click reminder per row. · *Value:* the collector works the right
accounts first instead of guessing. · **Build-state: BUILT** (`/api/invoices/collections`,
`collections/collections-dashboard.tsx`).

**C13. Manual one-click reminder (the MANUAL dunning rung).**
From the worklist, send the branded PDF+email+Pay-Now as a REMINDER_SENT (never re-flips DRAFT→SENT, refuses
to chase paid/void). · *Trigger/data:* invoice row + email provider; records tier in event meta. · *Bucket:*
— · *HITL:* collector clicks send. · *Value:* consistent, logged nudge. · **Build-state: BUILT**
(`/api/invoices/[id]/remind`).

**C14. Automated tiered dunning ladder (tone-escalating, quiet-hours, pausable).**
An unattended cadence — e.g. −3 days (courtesy), due date, +7 (firm), +14 (serious), +30 (final notice) —
with tone escalation, **quiet hours / business-day** gating, per-invoice/per-customer **pause**, auto-stop
on payment or promise-to-pay, and per-tier autonomy (advisory → trusted-category auto-send). · *Trigger/data:*
a dunning-ladder config + schedule/persistence tables; `invoice_events` history; overdue status. · *Bucket:*
FORECAST (pay-date) + DRAFT (message). · *HITL:* human sends by default; auto-send is a per-tenant, per-tier
dial; write-offs never auto. · *Value:* **the moat** — cuts DSO without adding headcount; where MeritBooks
beats QBO's flat reminders. · **Build-state: MISSING** — only the MANUAL rung exists; no cadence engine,
no quiet-hours, no tier config (FPB D6.2; the `/remind` route explicitly flags this as a later wave).

**C15. AI collections outreach drafting (tone-matched, escalating).**
Generate the next dunning message at the right tier — friendly → firm → final — personalized to the account
(balance, age, history, prior promises), in the tenant's brand voice. · *Trigger/data:* account state +
tier; routed through `@meritbooks/core-ai`. · *Bucket:* DRAFT. · *HITL:* human reviews before send (or
trusted-category auto-send); never auto for legal/final demand. · *Value:* consistent, on-brand, escalating
pressure without a person writing each note. · **Build-state: MISSING** (today's reminder is a fixed
template; ties to C14).

**C16. Promise-to-pay (PTP) capture & tracking.**
Record "customer promised $X by date Y," suppress dunning until that date, then auto-escalate on a **broken
promise** (a strong predictor of eventual default). · *Trigger/data:* a PTP object linked to
invoice/customer; feeds the worklist and the cash forecast. · *Bucket:* DETECT (broken-promise) + FORECAST
(expected cash). · *HITL:* collector logs the promise; broken promise re-surfaces to a human. · *Value:*
stops double-chasing, sharpens the forecast, flags deteriorating accounts early. · **Build-state: MISSING**.

**C17. Payment-plan / installment automation.**
Negotiate an aged balance into scheduled installments; auto-generate the schedule, auto-charge (card/ACH)
or auto-remind each installment, track adherence, and default-handle a missed installment. · *Trigger/data:*
a payment-plan object (parent balance → child installments); Stripe for auto-charge. · *Bucket:* (scheduler)
+ FORECAST. · *HITL:* human approves the plan terms; auto-charge is a per-tenant dial. · *Value:* recovers
balances that would otherwise write off; keeps the customer. · **Build-state: MISSING**.

**C18. Credit scoring & credit-limit management.**
Maintain a creditworthiness signal per customer from **internal payment behavior** (avg days-to-pay, broken
promises, dispute rate, trend) plus optional external bureau data; recommend a limit and terms; re-review on
a schedule or on a triggering event. · *Trigger/data:* `credit_limit_cents`/`payment_terms_days` on the
customer + AR history; optional D&B/Experian feed. · *Bucket:* DETECT + FORECAST. · *HITL:* the limit/terms
decision is human (present, never auto-set). · *Value:* prevents the loss before it starts; keeps limits
current. · **Build-state: PARTIAL** — the columns exist and the customer drawer shows a limit; **no scoring,
no re-review, no enforcement**.

**C19. Credit-hold automation (order/ship gate).**
When a customer is over limit or seriously past due, flag/hold new invoices or orders until cleared — with a
one-click supervisor override (logged). · *Trigger/data:* limit vs open+overdue balance at invoice/order
time. · *Bucket:* DETECT. · *HITL:* hard-block that a human with authority releases (SoD, logged). ·
*Value:* stops digging the hole deeper with a known-bad account. · **Build-state: MISSING** (needs C18 +
an enforcement hook at invoice/order creation).

**C20. Auto late-fees / finance charges.**
Assess a policy-driven finance charge on overdue balances as a **balanced posting** (DR AR / CR
LATE_FEE_INCOME) and/or a child invoice, only when the tenant opts in, honoring grace days and a max. ·
*Trigger/data:* late-fee policy (rate, grace, cap), overdue invoices; LATE_FEE_INCOME account role. ·
*Bucket:* (rule) — · *HITL:* opt-in policy; assessment is deterministic + logged. · *Value:* both revenue
and a behavior nudge. · **Build-state: MISSING** — no late-fee code or account role anywhere (FPB D6.3).

**C21. At-risk / churn signal on the AR book.**
Surface customers whose payment behavior is **deteriorating** — slowing days-to-pay, rising disputes, broken
promises, shrinking order size — as an early warning for credit, collections, and (for subscription tenants)
retention. · *Trigger/data:* AR-behavior time series per customer. · *Bucket:* DETECT + FORECAST. · *HITL:*
read-first; feeds credit re-review (C18) and collections priority. · *Value:* catch the problem two quarters
before the write-off. · **Build-state: MISSING**.

### Group D — Apply cash & resolve friction

**C22. AI cash application (deposits/receipts → open AR).**
Scan **unmatched** incoming bank deposits and propose the open invoice(s) each most likely settles —
single-invoice (exact/near amount), **lump remittance** (subset-sum across a resolved payer's invoices),
with payer resolution from the deposit description. Writes a PROPOSED `ai_decisions` row → `/exceptions`;
**never applies, posts, or moves money.** · *Trigger/data:* `bank_transactions` (money-in, unmatched) +
open invoices + `core.customers` names; idempotent dedup key per deposit. · *Bucket:* MATCH. · *HITL:*
one-tap confirm; ambiguous/material never auto-applied; unmatched → unapplied-cash queue. · *Value:* kills
the single most manual AR task; keeps aging honest. · **Build-state: BUILT (detect/propose-only)**
(`lib/controls/cash-application.ts`, `/api/controls/cash-application`, tested). *Delta:* the **approve →
post DR Cash / CR AR + apply** disposition from the proposal is the remaining wire (ties to GATE 8).

**C23. Lockbox / bank-file ingestion + auto-application.**
Ingest a bank **lockbox / BAI2 / remittance** file (check images, remittance detail) and auto-apply at scale;
handle no-remittance and split remittances. · *Trigger/data:* lockbox file feed; extends C22. · *Bucket:*
EXTRACT + MATCH. · *HITL:* confirm exceptions; bulk auto-apply the confident matches. · *Value:* enterprise
AR volumes without a keying team. · **Build-state: MISSING** (C22 is the deposit-level foundation; file
ingestion is the extension).

**C24. Partial-payment & short-pay handling on the hosted page + in application.**
Let a customer pay part of a balance online, and when a payment is short vs the invoice, **open a deduction**
rather than silently absorbing it. · *Trigger/data:* hosted-page amount entry; application math that leaves a
residual + spawns a dispute/deduction. · *Bucket:* DETECT (short-pay). · *HITL:* residual routes to dispute
adjudication. · *Value:* stops silent write-offs; captures the $800-on-a-$10k reality. · **Build-state:
MISSING** — hosted page pays full balance only; short-pay not modeled (FPB D9.4).

**C25. Unapplied-cash / on-account & customer-deposit ledger.**
Hold received money that can't yet be applied (or a prepaid deposit/retainer) as a **customer credit /
on-account balance**, then apply it to future invoices — never leave cash mis-posted or lost. ·
*Trigger/data:* an unapplied-cash / customer-deposit object tied to the customer; the "leave it on account"
outcome of C22. · *Bucket:* — · *HITL:* human applies or refunds. · *Value:* clears the unapplied-cash leak;
correct AR. · **Build-state: MISSING**.

**C26. Dispute / deduction detection + resolution workflow.**
Detect a likely dispute (short-pay, long silence after delivery+open, a "dispute" reply) and run a
structured workflow: reason code → owner → research → resolve (credit memo if valid / require payment if not)
→ close, with dunning paused while open and aging that shows "disputed," not "slow." · *Trigger/data:*
short-pay signal, no-pay-after-open pattern, inbound email/portal dispute; a dispute object. · *Bucket:*
DETECT + (DRAFT resolution note). · *HITL:* human adjudicates every dispute; AI only surfaces + drafts. ·
*Value:* un-worked disputes are the quiet path to write-off; a workflow converts them to cash or a clean
credit. · **Build-state: MISSING**.

### Group E — Adjust, credit, write off

**C27. Credit memos (issue, apply, refund bridge).**
A negative-signed AR document posting the mirror of an invoice — **DR Revenue (or Deferred 2410 for a
rev-rec job) / CR AR** — appliable against one or more invoices (a sub-ledger reallocation that posts **no
new GL** on apply, so AR control never double-relieves), with its own branded document. · *Trigger/data:*
`credit_memos` (migration 071), `credit-memo-posting.ts`. · *Bucket:* — · *HITL:* elevated-role action. ·
*Value:* the canon-correct correction model for issued invoices (vs in-place mutation). · **Build-state:
BUILT** (`lib/invoices/credit-memo-posting.ts` + tests, `credit-memos-panel.tsx`, migration 071). *Delta:*
credit-memo → Stripe **refund** bridge still MISSING (FPB D5.2/D9.3).

**C28. Void & reissue.**
Void an issued invoice: reverse its issuance JE, set VOIDED, **retain the number** (never reuse/delete),
remove from aging, watermark the PDF; optionally clone to a fresh number linked to the void. · *Trigger/data:*
`void-invoice.ts` + reversal. · *Bucket:* — · *HITL:* elevated-role, confirmed, logged. · *Value:* clean
correction with an audit trail. · **Build-state: BUILT** (`lib/invoices/void-invoice.ts`). *Delta:* PDF VOID
watermark + reissue-clone linkage to verify.

**C29. Bad-debt write-off + allowance for doubtful accounts.**
Relieve an uncollectible receivable **DR Bad Debt Expense / CR AR** (never void the sale), ideally against an
**allowance** so expected loss is reserved as AR ages rather than hitting as a lumpy surprise; AI **proposes**
write-off/reserve candidates with reasoning. · *Trigger/data:* aged AR + collection history; BAD_DEBT_EXPENSE
account (resolved by mapping/name today — not yet a first-class role). · *Bucket:* DETECT (candidate) + (human
decision). · *HITL:* controller approves the write-off; **SoD — collector ≠ approver.** · *Value:* removes the
bad-debt time bomb; smooths EBITDA. · **Build-state: PARTIAL** — write-off posting BUILT
(`write-off-posting.ts` + tests); **allowance model + AI reserve/write-off suggestion MISSING**;
BAD_DEBT_EXPENSE should be promoted to a role.

**C30. Refunds (overpayment / credit → money out).**
Return money to a customer (overpayment, approved credit) via Stripe refund with a balanced reversal and a
REFUNDED event that re-opens balance/aging as appropriate. · *Trigger/data:* Stripe refund API; payment
lifecycle. · *Bucket:* — · *HITL:* money-out = preparer≠approver + explicit release (canon). · *Value:*
closes the credit-to-cash loop. · **Build-state: MISSING** (FPB D9.3).

### Group F — Statements, reporting & the money rails

**C31. Customer statements (open-item / balance-forward) + delivery.**
A customer-facing recap: invoices (date/due/amount/paid/balance), aging summary, total due, remit-to; OPEN
(open-item) or ACTIVITY (window) forms; PDF + emailed; as-of-date so a controller can pull period-end. ·
*Trigger/data:* `statement.ts` (pure aging math + tested) + PDF + email + `/api/customers/[id]/statement`. ·
*Bucket:* — · *HITL:* issuer sends. · *Value:* parity; consolidates the "what do I owe" request. ·
**Build-state: BUILT** (`lib/invoices/statement*.ts`, `statement-pdf.tsx`, statement send route, tests).

**C32. Online Pay Now (ACH + card), hosted, correct GL.**
Destination-charge PaymentIntent to the tenant's connected Stripe account; methods resolved by cascade;
webhook posts the balanced payment JE **before** the status flip (a book of record never shows PAID with no
JE); idempotent on Stripe event id + PI id (migration 064 UNIQUE indexes are the DB guarantor). GL:
DR Settlement Clearing (net) + DR Merchant Fee Expense / CR AR 1100. · *Bucket:* — · *HITL:* customer pays;
posting is deterministic. · *Value:* one-click payment = faster cash, lower DSO. · **Build-state: BUILT &
LIVE** (GATE 12.1 verified, Session 41; coded platform-fee GL path retired — Merit books processor income via
its own bank feed). *Delta:* manual offline "record payment" parity + refund (C30) to confirm.

**C33. Two-layer merchant-fee model (charge + pass-through/absorb).**
Layer 1 = what MeritBooks charges the merchant (`merchant_fee_schedules`, rate+cap/floor); Layer 2 =
pass-through vs absorb, asymmetric by method (card passes through unless off; ACH absorbed unless on), invoice
override honored, customer accepts a passed-through fee (invoice `total_cents` never changes). · *Bucket:* —
· *HITL:* policy config. · *Value:* the platform's own economics, done correctly. · **Build-state: BUILT**
(`lib/money/fees.ts`, migration 057).

**C34. AR expected-collection feed into the 13-week cash forecast.**
Feed AR by expected-pay-date (aging + customer payment behavior + open promises-to-pay) into the rolling
13-week direct cash forecast, by entity and consolidated. · *Trigger/data:* AR aging + avg-days-to-pay + PTP;
the forecast engine (`forecast-grid.tsx`, built). · *Bucket:* FORECAST. · *HITL:* treasury reads; AI never
moves money. · *Value:* AR is the biggest swing in near-term cash; a behavior-based expected-pay-date beats
"assume everyone pays on due date." · **Build-state: PARTIAL** — the 13-week forecast exists; a
**behavior-weighted AR collection curve** feeding it is not yet wired (uses simpler assumptions).

**C35. AR subledger ↔ GL control tie-out (1100 reconciliation) + close gate.**
Continuously assert the AR subledger (sum of open invoice balances) equals the AR control account (1100), and
block close sign-off while unapplied cash or a subledger-vs-GL variance exceeds a threshold. · *Trigger/data:*
open invoices vs 1100 GL balance; the close checklist gate. · *Bucket:* RECONCILE + DETECT. · *HITL:* human
resolves any variance; must reach true zero. · *Value:* you can't certify AR if your two sources of truth
disagree. · **Build-state: MISSING** as an AR-specific tie-out (bank-rec autopilot + close board exist as the
pattern to mirror).

### Group G — Governance (binds all of the above)

**C36. RBAC + segregation of duties on AR actions.**
Gate create/send with `invoices:create`; gate **credit-memo / void / write-off / refund** to an elevated
role; enforce **collector ≠ write-off approver**; reconcile to `core` identity (never a Books-private
`employees.role`). · *Bucket:* — · *HITL:* the control *is* the human posture. · *Value:* the whole franchise
of a book of record is trust; write-off without SoD is a fraud vector (lapping). · **Build-state: PARTIAL** —
permissions defined (`rbac/permissions.ts` feature `invoices`, `biz_invoices`), **route/nav enforcement not
wired**; couples to the standing NO-GO identity gate #9.

---

## Part 3 — Ranked build-first shortlist → gates (each needs an FPB)

Ranking = (leak $ closed) × (frequency) × (how badly today's tooling handles it) − (cost/prereqs). The AR
FPB (`docs/FPB-invoices.md`) is the umbrella; the items below that lack coverage need their **own FPB or an
FPB amendment** before building (Rule 13 — no build from a one-liner).

**Tier 1 — Correctness & the money spine (do first; trust depends on it).**
1. **AR subledger ↔ GL (1100) tie-out + unapplied-cash close gate (C35).** Without this AR can't be
   certified. → **GATE 8** (reporting/close depth). *Needs an FPB section.*
2. **Cash-application approve→post→apply disposition (C22 completion) + unapplied-cash ledger (C25).** The
   detector is live; wire the one-tap approve that posts DR Cash / CR AR and the on-account holding bucket.
   → **GATE 8.** *Covered by the cash-application FPB; extend for C25.*
3. **Short-pay / partial-payment + dispute object (C24 + C26 minimal).** Stops silent write-offs; unblocks
   real cash application. → **GATE 8.** *Needs a Disputes/Deductions FPB.*

**Tier 2 — The collections moat (where MeritBooks beats QBO; the DSO lever).**
4. **Automated tiered dunning ladder (C14)** + **AI outreach drafting (C15)** + **promise-to-pay (C16).**
   This trio is the autonomous supervised-collections agent; biggest DSO reduction per build-dollar.
   → **GATE 9** (confidence routing/autonomy) for auto-send tiers; the ladder engine itself can precede it in
   advisory mode. *Needs a Dunning/Collections-Automation FPB.*
5. **Auto late-fees / finance charges (C20).** Small build, direct revenue + behavior nudge; promote
   LATE_FEE_INCOME to an account role. → **GATE 8.** *FPB section (FPB D6.3 already scoped).*

**Tier 3 — Credit discipline (prevent the loss before it happens).**
6. **Credit scoring + limit management (C18)** and **credit-hold automation (C19).** Internal-behavior score
   first (bureau feed optional/deferred); enforce at invoice/order creation. → **GATE 8/11.** *Needs a
   Credit-Management FPB.*
7. **Allowance for doubtful accounts + AI reserve/write-off suggestion (C29 completion).** Removes the
   bad-debt surprise; feeds covenant-safe EBITDA. → **GATE 7/8.** *FPB amendment.*

**Tier 4 — Depth, delivery & self-service (parity + polish).**
8. **Item catalog (A1)** + **PO/attachments capture (A6)** — cleaner, faster, more-accepted invoices.
9. **Delivery/bounce tracking (B9)** + **CC/multi-recipient send (B10).**
10. **Self-serve customer portal (B11)** (`biz_invoices`) + **refund path (C30)** + **credit-memo→refund
    bridge (C27 delta).**
11. **Payment-plan automation (C17)**, **at-risk/churn signal (C21)**, **lockbox ingestion (C23)**,
    **behavior-weighted AR forecast feed (C34 completion)** — enterprise/finance-heavy tenants.

**Tier 5 — Governance (gating, not optional, runs alongside).**
12. **RBAC + SoD enforcement on AR actions (C36)** — coupled to the NO-GO identity gate #9; must land before
    credit memo / void / write-off / refund are exposed broadly.

**Deferred with reason:** estimates→invoice (A7), external credit-bureau integration (part of C18),
multi-currency AR (seam-only, GATE 11), batch invoicing — none block the first "Complete."

---

## Appendix — Build-state at a glance

| # | Capability | Group | Bucket(s) | Build-state |
|---|---|---|---|---|
| A1 | Item catalog on lines | Bill | CLASSIFY | MISSING |
| A2 | Rev-rec-aware posting (2410) | Bill | CLASSIFY | PARTIAL |
| A3 | Progress/AIA billing | Bill | CLASSIFY | PARTIAL |
| A4 | Recurring invoices | Bill | scheduler | **BUILT** |
| A5 | Revenue-leakage (unbilled WIP) | Bill | DETECT+RECONCILE | PARTIAL (w/ Projects) |
| A6 | Attachments + PO capture | Bill | EXTRACT | MISSING |
| A7 | Estimate→invoice | Bill | — | MISSING (defer) |
| B8 | Branded delivery + Pay Now | Deliver | — | **BUILT** |
| B9 | Delivery/bounce/open tracking | Deliver | DETECT | PARTIAL |
| B10 | CC/multi-recipient send | Deliver | — | MISSING |
| B11 | Self-serve portal | Deliver | — | MISSING |
| C12 | Collections/DSO + worklist | Collect | DETECT/agg | **BUILT** |
| C13 | Manual one-click reminder | Collect | — | **BUILT** |
| C14 | Automated dunning ladder | Collect | FORECAST+DRAFT | MISSING |
| C15 | AI outreach drafting | Collect | DRAFT | MISSING |
| C16 | Promise-to-pay tracking | Collect | DETECT+FORECAST | MISSING |
| C17 | Payment-plan automation | Collect | scheduler+FORECAST | MISSING |
| C18 | Credit scoring & limits | Collect | DETECT+FORECAST | PARTIAL |
| C19 | Credit-hold automation | Collect | DETECT | MISSING |
| C20 | Auto late-fees | Collect | rule | MISSING |
| C21 | At-risk / churn signal | Collect | DETECT+FORECAST | MISSING |
| C22 | AI cash application | Apply | MATCH | **BUILT** (propose-only) |
| C23 | Lockbox/bank-file ingestion | Apply | EXTRACT+MATCH | MISSING |
| C24 | Partial/short-pay handling | Apply | DETECT | MISSING |
| C25 | Unapplied-cash / deposit ledger | Apply | — | MISSING |
| C26 | Dispute/deduction workflow | Apply | DETECT+DRAFT | MISSING |
| C27 | Credit memos | Adjust | — | **BUILT** (refund bridge missing) |
| C28 | Void & reissue | Adjust | — | **BUILT** |
| C29 | Write-off + allowance | Adjust | DETECT | PARTIAL |
| C30 | Refunds | Adjust | — | MISSING |
| C31 | Customer statements | Report | — | **BUILT** |
| C32 | Online Pay Now + GL | Rails | — | **BUILT & LIVE** |
| C33 | Two-layer merchant fee | Rails | — | **BUILT** |
| C34 | AR feed → 13-week forecast | Report | FORECAST | PARTIAL |
| C35 | AR subledger↔GL tie-out + gate | Report | RECONCILE+DETECT | MISSING |
| C36 | RBAC + SoD on AR | Govern | — | PARTIAL |

**Count:** 35 capabilities enumerated. BUILT 9 · PARTIAL 8 · MISSING 18.
Everything remains **Functional — partial**; nothing is "Complete" until it meets an approved FPB.
