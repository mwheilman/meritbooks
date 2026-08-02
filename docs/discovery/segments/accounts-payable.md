# Segment Deep-Dive — Accounts Payable / Procure-to-Pay (Books, Module 1 of 12)

**Authors:** AP / procurement operations leader (25+ yrs, multi-entity P2P) + senior AI engineer.
**Date:** 2026-08-01 (Session 41 canon).
**Status:** Discovery / analysis + spec. **Nothing below is a build authorization.** Every capability
must earn an approved Rule-13 FPB (16 dimensions + a QBO/Sage/Bill.com/AvidXchange benchmark) and land
behind its `Prereq:` gate before a line of code is written.

**Grounding (`docs/canon/CANON-ANCHOR.md`):** MeritBooks **OWNS the GL** — AP is not a skin over QBO;
QBO/Sage are one-time import sources. AI **proposes facts → the deterministic engine posts debits/credits
→ a human with the right Core role approves → every action writes the Decision Log**. Auto-post is **OFF by
default**; autonomy is a per-tenant/per-task dial. **Segregation of duties binds the AI too** (the agent
that drafts a bill is not the human that approves the pay; preparer ≠ approver on money movement — DB CHECK
+ service). Money is **bigint cents**. Accounts resolve by **role/type (COGS/OPEX), never hard-coded number**.
Vendor/entity are `core`, referenced by FK; the ledger is `public`.

**The moat, stated once:** because Books owns the ledger *and* sits in the Merit Suite next to Projects, an
AP bill can carry its **GL account + dimension (location/dept/class) + job/cost-code** at the moment of
capture, emit a `JOB_COST` event to Projects, and be **audit-defensible by construction** (source doc,
preparer, approver, AI provenance all attached at posting). No overlay product (Bill.com, Ramp, Tipalti)
can do cost→job attribution or continuous audit trail, because none of them own the book of record. **That
is the thing to protect in every capability below.**

**Sources synthesized:** `docs/discovery/books/bookkeeper-processor.md` (CORE-2/3/4/9), `cpa-tax-assurance.md`
(B2/B4/B5/B7/B8), `docs/discovery/books/AI-CAPABILITY-CATALOG.md`, and a read of the live AP code
(`lib/ap/intake.ts`, `lib/services/vendor-compliance.ts`, `lib/controls/{duplicate-payments,bill-anomaly}.ts`,
`api/compliance/1099`, `api/checks/run`, migrations 005/022/036/037).

---

## PART 1 — THE REAL AP LIFECYCLE AND EVERY LEAK / ERROR / FRAUD POINT

AP is a **procure-to-pay (P2P) chain**. Each hand-off is a control point; each control point is a leak
point. The lifecycle below is the multi-entity SMB/mid-market reality (directly relevant to a Merit-type
tenant with trades/construction subs), stage by stage, with the failure modes engineers under-model.

### Stage 0 — Requisition & commitment (the pre-invoice world Books mostly can't see today)
A cost is *committed* before an invoice ever arrives: a PO is cut, a subcontract is signed, a change order
is approved. In construction/trades this is the **committed cost** against a job budget. **Leak/error:**
- **Maverick / off-contract spend** — someone buys without a PO; the first the book hears of it is an invoice.
- **No encumbrance** — committed-but-unbilled cost is invisible, so job cost-to-complete and cash forecast
  are both wrong.
- **Commitment lives in the wrong module** — `proj.commitments` (Projects, migration 1003) holds POs/subs,
  but `public.bills` carries **no `purchase_order_id`** and no commitment link. This is the single biggest
  structural gap in AP today (see Part 3, NEEDS-CENTRAL).

### Stage 1 — Invoice capture / intake
Invoices arrive as PDF attachments, job-site phone photos, vendor-portal logins, EDI, and paper. Someone
hand-keys vendor, invoice #, date, due date, terms, amount, tax, freight, GL account(s), entity, and job.
**Leak/error/fraud:**
- **Human-OCR tax** — 2–4 min/bill of pure transcription; the data is right there on the PDF.
- **Lost invoices** — a texted photo or a portal-only invoice never enters the book → missed discount, late
  fee, or a vendor "past due" call; at close it's a missing accrual.
- **Transposition / fat-finger** — $1,240.00 keyed as $1,420.00; wrong invoice date lands it in the wrong period.
- **No source doc retained** — today intake stores **no image** (no storage bucket wired), so substantiation
  is lost and the audit PBC pull becomes a scramble.
- **Fraud — fictitious invoice / shell vendor** — a fabricated invoice from a vendor that doesn't exist or a
  look-alike ("Aacme" vs "Acme"); round-dollar amounts are a tell.

### Stage 2 — Vendor setup & onboarding
A bill from an unknown vendor forces a stop-and-create. A real vendor master needs: legal name + DBA, remit-to
address, **W-9 (TIN + entity type, before the first payment)**, banking (for ACH), and for trades/subs a
**Certificate of Insurance (GL + Workers' Comp)**. **Leak/error/fraud:**
- **W-9 collected in January, not at onboarding** → the annual 1099 chase; unreachable paid vendors; backup-
  withholding exposure (24%) and per-form penalties ($60–$310).
- **Duplicate vendor masters** — "Acme", "Acme Inc", "ACME LLC" fragment spend, defeat duplicate-bill controls,
  and split a vendor below the $600 1099 threshold so it's under-reported.
- **Uninsured-sub liability** — paying a sub whose COI lapsed pushes their injury/damage onto the payer's policy.
- **Fraud — Business Email Compromise (BEC) / bank-change fraud** — a spoofed "please update our remit bank"
  email reroutes a real vendor's payment to a mule account. **This is the #1 dollar-loss AP fraud in the wild
  and MeritBooks has NO control for it today.**

### Stage 3 — Coding (GL account + dimensions + job/cost-code)
The judgment step: is this Amazon charge OPEX supplies or job COGS? Is the Home Depot charge a repair
(expense) or a capitalizable improvement? Which entity/location/department/class? Which job + cost code?
**Leak/error:**
- **Miscoding distorts the P&L** — the classic capex-vs-expense error (B2): expensing a capital asset
  overstates deductions and understates assets (reverses on exam); capitalizing a repair defers a deduction.
- **Wrong dimension corrupts job cost** — a material bill on the wrong job makes cost-to-complete and margin
  wrong on *two* jobs.
- **Uncategorized swamp** — anything not confidently coded parks in "Ask My Accountant"; it can't be closed with.

### Stage 4 — Matching & validation (2-way / 3-way match)
Before approving, does the invoice match reality? **3-way match = PO ↔ goods-receipt ↔ invoice** on price,
quantity, and terms; **2-way = PO ↔ invoice**. **Leak/error/fraud:**
- **Overbilling** — vendor invoices 120 units, PO says 100; unit price $12 vs. contracted $10.
- **Duplicate invoice** — "just following up" re-send paid twice; the double-count when both a bill *and* its
  bank-feed payment post.
- **Bill over its committed cost** — a sub invoices past the subcontract/change-order value; needs a flag
  before it posts against the job.
- **Math doesn't foot** — line items ≠ subtotal; tax/freight wrong.

### Stage 5 — Approval & routing (segregation of duties)
The invoice routes to an approver by amount / type / cost-center / job. Money can't move on one person's say-so.
**Leak/error/fraud:**
- **Approval bottleneck** — invoices sit unapproved, blowing early-pay discounts and due dates.
- **Weak SoD** — same person creates the vendor, enters the bill, approves it, and releases the cash → the
  textbook embezzlement path (create shell vendor → invoice → self-approve → pay).
- **Over-limit slippage** — a bill split into two to dodge an approval threshold.

### Stage 6 — Payment / disbursement (the money leaves)
Pay by check, ACH, wire, virtual card, or on-account, on a **check-run** batched by due date, netting discounts.
**Leak/error/fraud:**
- **Paying early = lost float; paying late = late fees + missed 2/10 net-30 discounts** — the timing trade-off
  no SMB optimizes.
- **Duplicate / overpayment** — same bill paid twice via two rails; a payment exceeding the bill total.
- **Wrong rail accounting** — a credit-card payment mis-booked to cash instead of Credit Card Payable; a
  wire fee not captured.
- **Positive-pay / check fraud** — altered or forged checks; ACH sent to a fraud-changed bank account (BEC).
- **Compliance hold bypass** — paying a vendor whose W-9/COI is missing (the engine gates this today).

### Stage 7 — Post-payment: reconciliation & clearing
The payment clears the bank; the bank feed shows the debit. The book must **reconcile the disbursement to the
statement**, clear the AP, and reconcile the **vendor statement** (their open-items list) to ours.
**Leak/error:**
- **Unreconciled disbursements** — a check never clears (stale-dated) and sits as a book balance forever.
- **Vendor statement drift** — the vendor shows an open invoice we have no record of (a lost invoice) or a
  credit memo we never took.
- **Bill ↔ feed double-count** — the payment posts from the feed *and* the bill was separately expensed.

### Stage 8 — Period close & accrual
At close, **received-not-invoiced (RNI) goods/services must be accrued**; recurring bills (rent, utilities)
estimated; prepaids amortized; the AP sub-ledger tied to the GL control account. **Leak/error:**
- **Missing accruals** — a big December service billed in January but not accrued → expense in the wrong period
  (cutoff error, B6); covenant and tax impact.
- **AP sub-ledger ≠ GL control** — the aging doesn't tie to the balance-sheet AP account (a restatement tell).

### Stage 9 — Compliance & year-end (1099 / audit)
- **1099-NEC/MISC** — every unincorporated payee paid ≥ $600 by **cash/check/ACH** (card is on the processor's
  1099-K — issuing a 1099-NEC too is double-reporting) needs a form by Jan 31; TIN must match the IRS DB or
  CP2100 → backup withholding.
- **Audit PBC** — AP aging, selected bill support, disbursement support, vendor confirmations; a fire drill
  unless source docs are attached at posting.
- **Related-party AP (B5)** — an intercompany bill must have a mirror due-to/due-from and eliminate on
  consolidation; owner-benefit payments miscoded as expense are disguised distributions.

**The through-line:** every leak above is a **fact the owned ledger could capture once, at the source, with
provenance** — instead of a CPA reconstructing it 10 months later. That is the design target.

---

## PART 2 — CAPABILITY CATALOG (AI + non-AI automations)

Format per item: **what it does · trigger + data (read/written) · Core-AI gateway bucket · human-in-loop ·
value ($/time) · build-state.** Gateway buckets (from the catalog): **EXTRACT, CLASSIFY, MATCH, DETECT,
FORECAST, RECONCILE, DRAFT** — plus **DETERMINISTIC** for non-AI engine/rules work. Build-state legend:
**BUILT** (in repo, working) · **PARTIAL** (exists, material gaps) · **GAP** (not built) · **NEEDS-CENTRAL**
(needs a change to the reserved shared spine — schema/api-handler — so it's REPORTED, not invented by a slice).

### Group A — INTAKE (get the invoice into the owned ledger with zero keying)

**A1 — PDF/image invoice extraction (line-level).** OCR + field extraction of vendor, inv#, dates, terms,
subtotal/tax/freight/total, **and line items**. Trigger: bill uploaded. Bucket: **EXTRACT**. Human-in-loop:
side-by-side extracted-fields-next-to-source-image review; confirm, then it's a draft. Value: kills 2–4
min/bill of transcription. **Build-state: PARTIAL** — `lib/ap/intake.ts` + `bill-parser.ts` extract header
fields and lines and create a PENDING/ON_HOLD draft bill; **gaps:** the source document is **not retained**
(no storage bucket — `source_file_url` left null), line-level GL is not resolved, and vendor contact fields
aren't extracted.

**A2 — Email AP inbox ingestion (bills@tenant).** Watch a dedicated mailbox; each inbound invoice email →
A1 automatically; the email body/thread becomes context and the audit source. Trigger: inbound email
(M365/Graph). Bucket: **EXTRACT**. Human-in-loop: lands in the same draft-review queue. Value: removes the
"download the attachment and upload it" step; catches invoices that would otherwise be lost. **Build-state:
GAP / BLOCKED** — GATE 4 (M365 ingestion) is blocked on IT returning Azure creds; intake is upload-only today.

**A3 — Source-document vault + provenance.** Store every source invoice/receipt/statement immutably, linked
to the bill, surfaced in review and in the audit PBC pull. Trigger: any intake. Bucket: **DETERMINISTIC**.
Human-in-loop: none (storage). Value: substantiation for the deduction; PBC becomes a query (B9). **Build-state:
GAP** — no storage bucket wired; `intake.ts` explicitly TODOs this. **Prerequisite for A1 to be audit-grade.**

**A4 — Vendor-portal / EDI fetch.** Log into vendor portals or accept EDI 810 to pull invoices no human
downloads. Trigger: schedule / EDI feed. Bucket: **EXTRACT**. Human-in-loop: same draft queue. Value: closes
the "portal-only invoice" lost-invoice leak. **Build-state: GAP.**

**A5 — Duplicate-at-intake guard.** On every new bill, fuzzy-match vendor + inv# + amount + date against
existing bills; block a re-keyed/re-sent duplicate with a side-by-side "looks like bill #X" before it's saved.
Trigger: bill create/intake. Bucket: **MATCH/DETECT**. Human-in-loop: blocking choice — duplicate/discard vs.
genuinely different; never auto-deletes. Value: prevents double-pay (a control, not a convenience).
**Build-state: PARTIAL** — the EC-1 `duplicate-payments` control detects dup bills *post-hoc* into `/exceptions`;
there is **no inline block at the moment of entry** (the highest-trust placement).

### Group B — VENDOR MASTER & ONBOARDING

**B1 — Vendor auto-create from an invoice.** Unknown vendor on a bill → draft a vendor record (name/DBA,
remit-to, contact) for one-click confirm. Trigger: intake, no vendor match. Bucket: **EXTRACT/CLASSIFY**.
Human-in-loop: human approves before the vendor is "real"; `auto_approve=false` on machine-created vendors.
Value: removes the stop-and-create interrupt. **Build-state: PARTIAL** — `intake.ts` creates a name-only
vendor; contact/remit/W-9 fields not populated (parser doesn't surface them).

**B2 — W-9 / TIN capture + IRS TIN matching.** Require a W-9 at onboarding (before first payment); validate
TIN format; run **IRS TIN matching**; store entity type (drives 1099-reportability). Trigger: vendor create /
first payment. Bucket: **EXTRACT (W-9 doc) + DETERMINISTIC (TIN match)**. Human-in-loop: block/flag with
override-with-reason. Value: kills the January W-9 chase; avoids CP2100/backup-withholding. **Build-state:
PARTIAL** — vendor-compliance tracks a `W9` doc + hold; **no W-9 field extraction, no IRS TIN matching.**

**B3 — COI (GL + WC) tracking + expiry chase.** Track General-Liability and Workers'-Comp COIs (+ WC
exemption); compute a payment hold when missing/expired; schedule escalating chase reminders (weekly if
expired/≤14 days, biweekly otherwise). Trigger: bill from a sub / doc expiry. Bucket: **DETECT + DRAFT**.
Human-in-loop: hold is computed; override is ONE_TIME/TEMPORARY/PERMANENT with a reason; every grant/consume/
release audited. Value: kills uninsured-sub liability + the "your COI expired" emails. **Build-state: BUILT**
— `services/vendor-compliance.ts` + migration 037; **gap:** chase is *scheduled* but **no email is sent** (rides
GATE 4).

**B4 — BEC / vendor bank-change verification.** Any change to a vendor's remit banking (or a "please update our
bank" request) freezes payment and forces an out-of-band verification (call the known-good number on file,
dual-control confirm) before the new account can be paid. Trigger: bank-detail change / inbound change request.
Bucket: **DETECT + DRAFT**. Human-in-loop: mandatory dual-control release; the change is quarantined until
verified. Value: prevents the single largest AP fraud loss category. **Build-state: GAP** — no vendor-banking
model or change-control exists. **High priority; no analogue in the exception library yet.**

**B5 — Duplicate-vendor-master detection & merge proposal.** Flag near-duplicate masters (matching TIN, or
high name similarity + shared email/address) that fragment spend and dodge duplicate + 1099 controls. Trigger:
continuous scan / vendor create. Bucket: **MATCH/DETECT**. Human-in-loop: propose a merge; a human confirms
(never auto-merges). Value: restores dup-bill and 1099-threshold integrity. **Build-state: BUILT** — rule C
of the EC-1 `duplicate-payments` control (`scoreDuplicateVendors`, TIN + `vendorSimilarity`).

**B6 — Vendor risk / sanctions & watchlist screen.** Screen new vendors against OFAC/denied-party lists and a
basic "is this a real business" heuristic. Trigger: vendor create. Bucket: **DETECT**. Human-in-loop: flag →
exceptions. Value: sanctions-payment avoidance; shell-vendor deterrence. **Build-state: GAP.**

### Group C — CODING (GL account + dimension + job/cost-code)

**C1 — Auto-code by vendor history.** Propose the GL account + dimensions from this vendor's prior coding
(learned map of descriptor → account + dept/location/class). Trigger: bill line / feed line. Bucket:
**CLASSIFY**. Human-in-loop: pre-coded, one-click/batch approve; sorted lowest-confidence-first. Value: removes
the daily coding grind; the flagship trust-builder. **Build-state: PARTIAL** — vendor-pattern learning exists
for the **bank feed** (migration 040, `categorize/learn`); **bill lines still fall back to the vendor default
or 6660 Miscellaneous** — no line-level AI coding on bills yet.

**C2 — Auto-attribute cost to job + cost-code (the suite moat).** Propose the job + cost code for a bill line
from the vendor, the PO/commitment, and the job's open budget lines, and emit a `JOB_COST` event to Projects.
Trigger: bill line coded to a job-costable account. Bucket: **CLASSIFY + MATCH**. Human-in-loop: confirm the
job/cost-code. Value: **the differentiator** — real-time job cost + margin no overlay tool can produce.
**Build-state: PARTIAL** — the `JOB_COST` seam (FROZEN v3, `job_cost_attributions.bill_id`) and cost/billing
seam (021/025) exist; **AI job/cost-code suggestion on bill lines is not built**, and there's no PO to match to.

**C3 — Capex-vs-expense classifier + fixed-asset lifecycle.** On a payment above a threshold to a
capex-suggestive account/vendor, prompt capitalize-vs-expense with the de-minimis safe-harbor and repair-vs-
improvement (RABI) test; on capitalize, auto-create the fixed-asset record with proposed life/method/§179/bonus.
Trigger: bill to equipment/software/leasehold accounts. Bucket: **CLASSIFY**. Human-in-loop: AI proposes; the
**§179/bonus election stays a human tax decision**. Value: prevents the classic capex miscode (B2); catches
missed elections. **Build-state: PARTIAL** — dual book/tax depreciation + fixed-asset schema exist (migrations
033/034, `services/fixed-assets`); the **at-intake capex prompt is not wired to bill entry.**

**C4 — Tax-character tagging at AP posting (M-1 / temp-perm).** Tag each expense line for tax character —
meals (50%), entertainment (0%), penalties (0%), federal tax — feeding a running M-1 bridge. Trigger: bill
line post. Bucket: **CLASSIFY**. Human-in-loop: high-confidence auto-tag, edge cases confirmed at review.
Value: turns year-end M-1 reconstruction into a rollforward (cpa B1). **Build-state: GAP** for AP (tax-params
scaffolding exists in `posting/tax-params`, not applied to bill lines).

### Group D — MATCHING & VALIDATION

**D1 — Purchase-order model in Books (foundation).** A first-class PO/commitment on the bill
(`bills.purchase_order_id` + a PO header/lines Books can read). Trigger: PO issue / bill entry. Bucket:
**DETERMINISTIC**. Human-in-loop: PO approval. Value: unlocks D2–D4 and encumbrance reporting. **Build-state:
NEEDS-CENTRAL** — `proj.commitments` (Projects) exists but Books can't read it and `public.bills` carries no
PO FK. `bill-anomaly.ts` explicitly documents this as the blocker for PO-variance. **This is the keystone gap.**

**D2 — 3-way match (PO ↔ receipt ↔ invoice).** Auto-match invoice to PO and goods-receipt on price, qty, and
terms; auto-approve within tolerance, route exceptions. Trigger: invoice against an open PO. Bucket: **MATCH**.
Human-in-loop: tolerance auto-pass; out-of-tolerance → approver. Value: stops overbilling/quantity fraud; the
core AP control every ERP has and MeritBooks lacks. **Build-state: GAP** (blocked on D1 + a goods-receipt model).

**D3 — 2-way match / PO-variance flag.** Where there's no receipt, flag a bill exceeding its PO/commitment
value or contracted unit price. Trigger: bill vs. PO. Bucket: **DETECT**. Human-in-loop: variance →
exceptions. Value: catches over-commitment before it posts to the job. **Build-state: GAP** — this is exactly
"Signal B" that `bill-anomaly.ts` cannot implement without D1.

**D4 — Bill-amount anomaly (no PO needed).** Flag a bill materially above this vendor's historical average,
a first-time large vendor, or a large round-dollar amount (estimate-keyed-as-invoice tell). Trigger: PENDING/
ON_HOLD bill. Bucket: **DETECT**. Human-in-loop: detect-only into `/exceptions`. Value: catches inflated/
fabricated invoices without a PO. **Build-state: BUILT** — `lib/controls/bill-anomaly.ts` (signals A/C/D,
detect-only, idempotent).

**D5 — Duplicate-payment detection.** Flag a bill whose posted settlements exceed its total (paid twice), and
duplicate-bill pairs where both already disbursed cash. Trigger: continuous scan. Bucket: **DETECT/MATCH**.
Human-in-loop: detect-only into `/exceptions`. Value: recovers real dollars already out the door.
**Build-state: BUILT** — EC-1 `duplicate-payments.ts` rules A/B.

**D6 — Math/foot validation.** Deterministic check that lines sum to subtotal, tax/freight reconcile, and the
total foots. Trigger: bill save. Bucket: **DETERMINISTIC**. Human-in-loop: block on mismatch. Value: catches
transposition at entry. **Build-state: GAP** (parser extracts amounts; no foot-validation gate documented).

### Group E — APPROVAL & ROUTING

**E1 — Approval routing by amount/type/cost-center.** Route each bill to the right approver by rules (amount
band, account/type, job/PM, responsible party). Trigger: bill ready for approval. Bucket: **DETERMINISTIC**.
Human-in-loop: the approval itself. Value: kills the approval bottleneck; enforces limits. **Build-state:
PARTIAL** — `bills.approver_type` (ACCOUNTING/RESPONSIBLE_PARTY/PM_LEADER) + `cost_approval_rules` (021/022)
exist; a full rules UI + threshold ladder + delegation/out-of-office is not built.

**E2 — Segregation-of-duties enforcement (preparer ≠ approver).** Enforce that the entrant isn't the approver
and the approver isn't the releaser, reconciled to `core.memberships/roles`; continuously test for SoD
conflicts (same person creates a vendor and pays it). Trigger: any approval/release. Bucket: **DETERMINISTIC +
DETECT**. Human-in-loop: the control *is* the human posture. Value: closes the embezzlement path; audit
"controls understanding" prebuilt (B8). **Build-state: PARTIAL** — money-movement approvals enforce preparer
≠ approver (migrations 042/043, `money/approvals.ts`); **continuous SoD-conflict scanning is not built**, and
`canApprove` org-resolution is the open identity-gate #9 blocker.

**E3 — Approval SLA / aging nudges.** Track how long each bill sits unapproved; nudge approvers before a
discount or due date is blown. Trigger: bill age in approval. Bucket: **DRAFT/DETECT**. Human-in-loop: nudge
only. Value: recovers lost discounts and avoids late fees. **Build-state: GAP** (received_at is stamped for
team-performance; no SLA nudge).

### Group F — PAYMENT / DISBURSEMENT

**F1 — Check-run builder.** Batch payable, due-soon APPROVED bills into disbursement approvals (DRAFT →
PENDING_APPROVAL), idempotently, optionally by location. Trigger: manual/scheduled run. Bucket:
**DETERMINISTIC**. Human-in-loop: approval + explicit release are separate human steps. Value: the core AP
disbursement workflow. **Build-state: BUILT** — `api/checks/run` (prepares approvals only; never releases/posts).

**F2 — Payment-timing / dynamic-discount optimizer.** For each due bill, recommend pay-now vs. pay-at-due
by weighing early-pay discount (2/10 net-30 ≈ 36% annualized) against cash position and float; propose the
optimal check-run date. Trigger: open payables + cash forecast. Bucket: **FORECAST**. Human-in-loop: propose;
human sets the run. Value: hard-dollar discount capture + float preservation. **Build-state: GAP** — no
discount-terms model on bills; 13-week cash forecast exists to feed it.

**F3 — Multi-rail disbursement orchestration (check / ACH / wire / virtual card).** Execute the approved
payment on the chosen rail, booking the correct cash-side account (**credit card → Credit Card Payable, not
cash**; capture wire/card fees), and drive the GL post deterministically. Trigger: released approval. Bucket:
**DETERMINISTIC**. Human-in-loop: the release. Value: real payment execution + correct rail accounting. **Build-
state: PARTIAL** — the money-movement posting engine + rail→cash-account logic exist (migrations 043/055);
outbound rails (actual ACH/check/virtual-card issuance) are not integrated.

**F4 — Positive-pay / ACH-fraud file.** Generate the bank positive-pay file (issued-check register) and
ACH debit filters so the bank blocks altered/forged/unauthorized items. Trigger: check-run / ACH batch.
Bucket: **DETERMINISTIC**. Human-in-loop: none. Value: check/ACH fraud prevention. **Build-state: GAP.**

**F5 — Compliance-hold payment gate.** Block payment to a non-compliant vendor (missing/expired W-9/COI)
unless an active override applies (consuming a ONE_TIME override), fully audited. Trigger: payment attempt.
Bucket: **DETERMINISTIC**. Human-in-loop: override-with-reason. Value: no uninsured/un-W-9'd payments slip.
**Build-state: BUILT** — `enforcePaymentAllowed` in `services/vendor-compliance.ts`.

**F6 — Retainage withholding on sub bills.** On a subcontractor bill with a retainage %, recognize full cost
as expense but hold back (subtotal + tax − retainage) as the payable; track the retainage-payable balance for
later release. Trigger: sub bill with retainage. Bucket: **DETERMINISTIC**. Human-in-loop: release approval.
Value: correct construction AP; retainage never over-/under-paid. **Build-state: BUILT** — migration 036 +
`services/retainage`.

### Group G — POST-PAYMENT: RECONCILIATION & CLEARING

**G1 — Disbursement-to-bank reconciliation.** Match each posted payment to the bank-feed debit; surface
uncleared/stale checks. Trigger: bank feed + payments. Bucket: **MATCH/RECONCILE**. Human-in-loop: sign-off on
the rec. Value: no orphaned book balances; stale-check cleanup. **Build-state: PARTIAL** — reconciliation
autopilot exists (migration 065, `reconciliation/autopilot`) for the bank feed generally; AP-disbursement-
specific clearing is not a distinct surface.

**G2 — Vendor-statement reconciliation.** Ingest a vendor's monthly statement and reconcile their open-items
list to our open bills — surfacing invoices they show that we don't have (a lost invoice) and credits we
haven't taken. Trigger: statement upload/email. Bucket: **EXTRACT + MATCH**. Human-in-loop: confirm
adds/credits. Value: closes the lost-invoice and unused-credit leaks; prevents "past due" surprises. **Build-
state: GAP.**

**G3 — Bill-vs-feed double-count guard.** Flag when a bill and its bank-feed payment both hit expense (the
double-count). Trigger: feed import + open bills. Bucket: **DETECT/MATCH**. Human-in-loop: resolve. Value:
prevents doubled expense. **Build-state: PARTIAL** — conceptually covered by duplicate-payments/cash-application
controls; not a dedicated bill↔feed guard.

### Group H — PERIOD CLOSE & ACCRUAL

**H1 — Received-not-invoiced (RNI) / recurring accrual automation.** Auto-propose accruals for received-but-
unbilled goods/services and for recurring bills not yet arrived (rent, utilities) at period-end; reverse next
period. Trigger: period close. Bucket: **FORECAST/CLASSIFY**. Human-in-loop: review/release the accrual batch.
Value: correct cutoff (B6); no expense in the wrong period. **Build-state: PARTIAL** — `lib/controls/missed-
accruals.ts` detects likely missing accruals into `/exceptions`; **auto-draft of the RNI accrual entry from
open POs is not built** (needs D1).

**H2 — AP sub-ledger ↔ GL control tie-out.** Continuously assert the AP aging equals the balance-sheet AP
control account; flag any break. Trigger: continuous / close. Bucket: **RECONCILE**. Human-in-loop: investigate
break. Value: catches the restatement tell early. **Build-state: PARTIAL** — AP aging report exists
(`reports/ap-aging`); a continuous tie-out assertion is not wired.

**H3 — Recurring bill templates.** Define a recurring payable (fixed or variable) that pre-drafts each period
for review/release. Trigger: schedule. Bucket: **DETERMINISTIC**. Human-in-loop: release the batch. Value:
removes re-keying rent/subscriptions; no "forgot one" miss. **Build-state: PARTIAL** — recurring-invoice
templates exist on the **AR** side (migration 073); no AP recurring-bill equivalent.

### Group I — COMPLIANCE, ANALYTICS & AUDIT

**I1 — 1099-NEC/MISC readiness + filing.** Year-round: every vendor paid ≥ $600 by a **non-card (reportable)**
rail with W-9/TIN/eligibility status and a readiness flag; split payments by rail to exclude card/1099-K
amounts; flag gaps and chase W-9s; batch-file at year-end. Trigger: payment / year-end. Bucket: **DETECT +
DRAFT**. Human-in-loop: chase + human-triggered filing. Value: no January scramble; penalty/backup-withholding
avoidance. **Build-state: PARTIAL** — `api/compliance/1099` builds the readiness report + queues chases (detect/
queue only); **no actual form generation/e-filing, no TIN matching.**

**I2 — Related-party / intercompany AP integrity.** Flag a bill whose counterparty is a known related entity/
owner; require the mirror due-to/due-from; keep intercompany self-eliminating; flag owner-benefit payments
miscoded as expense. Trigger: bill to a related counterparty. Bucket: **DETECT/MATCH**. Human-in-loop: approve
mirror + characterization. Value: clean consolidation + K-1s; ASC 850 / §482 support (B5). **Build-state:
PARTIAL** — intercompany model + balance control exist (migration 035, `controls/intercompany-balance.ts`,
`api/intercompany`); AP-side auto-mirror on a related-party *bill* is not wired; consolidation gate 11a is the
top-priority downstream.

**I3 — Anomalous-JE detection over AP entries.** Score manual AP-related JEs for round-dollar, weak
description, odd account pairs, post-close/weekend timing, unexpected user. Trigger: JE post. Bucket:
**DETECT**. Human-in-loop: high-risk requires description + attachment + approver. Value: AU-C 240 JE testing
built-in (B7). **Build-state: BUILT** — `lib/controls/anomalous-je.ts` (general JE population; applies to AP JEs).

**I4 — Spend analytics & vendor concentration.** Analyze spend by vendor/category/dept/job/period; surface
vendor concentration, off-contract spend, price drift, and savings opportunities. Trigger: on-demand /
scheduled. Bucket: **DETECT/FORECAST**. Human-in-loop: insight only. Value: negotiating leverage + leakage
visibility. **Build-state: PARTIAL** — expense-by-vendor + AP aging reports exist; no analytics/concentration
surface.

**I5 — Contract & subscription tracking.** Track recurring vendor contracts/subscriptions: renewal dates,
auto-renew traps, price increases, unused seats; alert before renewal. Trigger: contract record / renewal
window. Bucket: **DETECT/DRAFT**. Human-in-loop: decide renew/cancel. Value: kills silent subscription creep.
**Build-state: GAP.**

**I6 — AP-driven cash-requirement forecast.** Roll open payables (by due date, net of expected discounts)
into the 13-week cash forecast so the operator sees the disbursement wall. Trigger: continuous. Bucket:
**FORECAST**. Human-in-loop: informs the check-run. Value: no cash surprises; funds the discount optimizer (F2).
**Build-state: PARTIAL** — 13-week cash forecast exists (`api/forecast`); explicit AP-payables integration
into it is not confirmed.

**I7 — Uncategorized / "Ask My Accountant" cleanup (AP side).** Re-propose coding for bills/lines parked as
uncategorized as more context arrives; gate close on the queue being empty. Trigger: uncategorized accrual.
Bucket: **CLASSIFY**. Human-in-loop: approve/redirect. Value: no unknowns hidden at close. **Build-state:
PARTIAL** — `controls/uncategorized-leakage.ts` detects unposted/uncategorized leakage into `/exceptions`.

**I8 — Document-chase orchestration (the "chasing people" killer).** For any bill blocked on a missing doc/
approval/answer (W-9, COI, receipt, "what was this charge", "which job"), send + auto-follow-up on the ask and
give the operator a single "waiting-on" board. Trigger: any blocked transaction. Bucket: **DRAFT**. Human-in-
loop: review-before-send or trusted-category auto-send; operator watches the board. Value: reclaims the
invisible hours/week of nagging. **Build-state: PARTIAL** — vendor-compliance *schedules* chases with cadence +
audit; **the send/reply/board layer is unbuilt** (rides GATE 4).

**I9 — Audit trail + PBC/tie-out for AP.** Every bill/payment carries preparer, approver, timestamp, source
doc, and AI provenance; generate AP PBC deliverables (aging, selected-bill support, disbursement support) and
continuous FS→TB→GL→source tie-out on demand. Trigger: audit request. Bucket: **RECONCILE/DETERMINISTIC**.
Human-in-loop: read-only export. Value: collapses the AP audit from an excavation to a query (B8/B9). **Build-
state: PARTIAL** — `core.action_log`/`audit_log` + immutable period locks exist and capture human/AI attribution;
the PBC-generation UX and A3 source-doc vault are the missing pieces.

**Count: 40 capabilities enumerated** (A1–A5, B1–B6, C1–C4, D1–D6, E1–E3, F1–F6, G1–G3, H1–H3, I1–I9).
Build-state tally: **BUILT 8** (B3, B5, D4, D5, F1, F5, F6, I3) · **PARTIAL 18** · **GAP 12** · **NEEDS-CENTRAL 1** (D1)
plus one BLOCKED (A2, GATE 4).

---

## PART 3 — RANKED BUILD-FIRST SHORTLIST (each needs an FPB before build)

Ranked by the catalog's composite bias (ROI × TrustImpact × BuildEase × FP-safety), constrained by the gate
order and by what protects the **owned-ledger + cost→job suite moat**. Each item names its gate and the FPB
that must exist first.

1. **D1 — Purchase-Order model in Books + `bills.purchase_order_id`** *(the keystone; NEEDS-CENTRAL)*.
   Everything in Group D (3-way match, PO-variance, encumbrance, RNI accrual auto-draft) is blocked on this,
   and it is the piece that makes cost→job attribution *complete*. Because it touches the reserved shared spine
   (schema + the Projects/Books seam), it must be **designed centrally, not invented by a slice**. **Gate:
   11b (PO/3-way).** *Needs a new FPB: `FPB-accounts-payable-po-3way.md`.*

2. **D2/D3 — 3-way / 2-way match + PO-variance flag.** The core AP control every ERP has and MeritBooks
   lacks; directly stops overbilling/quantity fraud and over-commitment on jobs. Rides on D1 + a goods-receipt
   model. High ROI, high trust (lets a controller sign the disbursement). **Gate: 11b.** *Same FPB as D1.*

3. **B4 — BEC / vendor bank-change verification.** Highest single-loss fraud category in AP, and MeritBooks
   has **zero** control today. Cheap-ish (a bank-change quarantine + dual-control release on the existing
   money-movement SoD spine), enormous trust impact. **Gate: 9 (identity/RBAC) money-movement extension.**
   *Needs a new FPB: `FPB-vendor-banking-fraud-controls.md`* (or a section in the payments FPB).

4. **A3 + A1 completion — Source-document vault + line-level extraction.** A3 (storage) is a prerequisite to
   making A1 audit-grade and to I9 (PBC-as-a-query). Cheap, universal, and it's the substantiation the whole
   assurance moat depends on. **Gate: 8 (module depth) / prerequisite to GATE 4.** *Covered by an AP-intake FPB:
   `FPB-accounts-payable-intake.md`.*

5. **C1/C2 — AP line-level auto-coding + job/cost-code attribution.** Extends the proven bank-feed vendor-
   pattern learning to bill lines and adds the **cost→job** suggestion that is the suite differentiator. High
   ROI (kills the coding grind), high moat value. **Gate: 6 (job-costing depth).** *Needs
   `FPB-accounts-payable-coding.md`.*

6. **F2 + I6 — Payment-timing/discount optimizer fed by an AP cash-requirement forecast.** Hard-dollar
   discount capture (2/10 ≈ 36% annualized) + float preservation, riding the existing 13-week forecast. Needs a
   discount-terms model on bills first. **Gate: 8.** *Covered by a disbursement FPB: `FPB-accounts-payable-
   disbursement.md`.*

7. **E1/E2/E3 — Approval-workflow depth + continuous SoD scanning + SLA nudges.** Completes the approval spine
   (threshold ladder, delegation, conflict detection) — the audit "controls understanding" prebuilt. Gated on
   closing identity gate #9's org-resolution. **Gate: 11e (approval-workflow) + 9.** *Covered by the identity/
   money-movement FPBs, extended.*

8. **I1 completion + B2 — 1099 form generation/e-file + W-9 extraction + IRS TIN matching.** Turns the
   readiness surface into an actual filing pipeline; closes the penalty/backup-withholding exposure. Seasonal
   but high-certainty ROI. **Gate: 8.** *Needs `FPB-accounts-payable-1099-compliance.md`.*

9. **G2 — Vendor-statement reconciliation.** Closes the lost-invoice and unused-credit leaks; extends the
   reconciliation autopilot to the vendor side. **Gate: 8.** *Extend the bank-reconciliation FPB.*

10. **I8 completion — Document-chase send/board layer.** Turns the already-scheduled chase cadence into actual
    outreach + a "waiting-on" board — the biggest quality-of-life win for the operator. **Blocked on GATE 4**
    (M365 creds); build the board now, wire the send when GATE 4 unblocks. *Covered by the intake/compliance FPBs.*

**Moat reminder for every FPB above:** the benchmark section must name the delta vs. Bill.com/Ramp/Tipalti/
AvidXchange and QBO/Sage AP — and the winning delta is always the same two things they structurally cannot do:
**(a) cost→job attribution on the owned ledger** (C2/D1) and **(b) audit-defensible-by-construction provenance**
(A3/I9/E2). Build toward those, not toward feature parity.
