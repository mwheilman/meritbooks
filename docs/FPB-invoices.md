# Feature Product Brief — Invoices / Accounts Receivable

**Module:** Invoices & AR (Books, Module 1 of 12)
**Author:** Auditor (Rule 13 FPB authorship)
**Date:** 2026-08-01 (Session 40 canon)
**Status of module today:** Functional — partial (Feature Completeness Ledger, Master Doc Part V.0). ZERO modules are Complete; this is the agreed first FPB.
**Completion standard (Rule 13):** "Complete" ≠ renders/works/real-data. That is the *functional minimum*. Complete = **meets every dimension of this approved brief**, benchmarked against QBO/Sage with named deltas closed or explicitly deferred with reason, and every acceptance criterion below passing.

---

## §0. Scope, grounding, and canon reconciliation

**What this module owns (canon-bound):**
- Books **owns invoice numbering** (CANON-ANCHOR §2 — "Numbering owners: invoice #, bill #, journal-entry #, internal-invoice # → Books").
- Books **owns the AR ledger**, NOT the customer. Customer/Job/Entity are `core`, referenced by FK, never copied (CANON-ANCHOR §2). Invoice reads stitch `core` in JS via `fetchCoreMap` — **no PostgREST embeds across `core`↔`public`** (proven failure mode).
- Every write posts through `postJournalEntry` / `check_journal_balance()` — **debits = credits or it does not post** (CANON-ANCHOR §3).
- **Rev-rec is Books-owned, method-per-job.** For a rev-rec-managed job the customer invoice **credits Deferred Revenue (2410), NOT Revenue** (CANON-ANCHOR §3, Master Doc XI). `rev-rec.ts` is the timing authority; the posting engine delegates to it.
- All money is **bigint cents** (`formatMoney/dollarsToCents/centsToDollars`).
- RLS `org_id = get_org_id()` on every table; GL author columns (`created_by/posted_by`) are uuid+nullable → **write null** for Clerk ids; human attribution to `audit_log` / `core.action_log`.
- **AI proposes, human approves. AI never writes debits/credits and never authorizes money movement. Auto-post OFF by default.**
- Payment rails are NOT transaction types — the rail only picks the cash-side account. **Never re-expense a settlement**: customer payment = DR Cash/Clearing / CR AR.

**Internal (interdepartmental) invoices are OUT of scope here.** Those are the `internal_invoices` engine (migration 015) with eliminating accounts 4990/5990/5991 and consolidation eliminations — a separate brief. This FPB is the **customer-facing AR invoice**.

**Retired — do not touch:** chargebacks, overhead/burden rate, labor classifications. Not relevant to invoices; noted only to prevent drift.

---

## §1. Sixteen-dimension brief

Each dimension states: **Purpose · What best-in-class does · Current MeritBooks state (built / partial / missing, cited to real files) · Named deltas · Testable acceptance criteria.**

---

### Dimension 1 — Data captured (the invoice record)

**Purpose:** Capture everything an issuer needs to bill correctly and everything a customer needs to pay confidently, with an immutable snapshot at issue.

**Current state — BUILT (partial):**
- `public.invoices` (migration 008): org/location/customer/job, `invoice_number` (unique per org), `invoice_date`, `due_date`, `subtotal_cents/tax_cents/retainage_cents/total_cents/amount_paid_cents`, `balance_cents` (generated column = total − paid), `status`, `gl_entry_id`, `is_progress_bill`, `application_number` (AIA G702/G703), `memo`, `sent_at`.
- `invoice_lines` (008): `line_number`, `description`, `account_id` (FK to COA), `quantity` numeric(15,4), `unit_price_cents`, `amount_cents`, `job_phase_id`, `cost_code_id`.
- Migration 050 adds product-grade capture: `po_number`, `sales_rep`, `customer_message` (prints), `internal_note` (never prints), `bill_to`/`ship_to` jsonb snapshots, `discount_cents`, `terms`, `public_token` (unguessable hosted-view key, unique index), `payment_methods_allowed[]`, `card_surcharge_enabled`, `invoice_type` (free-text: 'Progress Bill','Deposit','Final').
- Create route (`app/api/invoices/route.ts` POST) validates via Zod, computes subtotal from lines, resolves retainage via job→customer cascade.

**Named deltas / gaps:**
- **D1.1 — Line-level fields thin.** No per-line `item_id` (product/service catalog), no per-line `tax_code`, no per-line unit-of-measure, no line discount. QBO/Sage bill from a **Product/Service item** that carries default account, default price, and default tax code; MeritBooks types a raw description + picks a GL account each time.
- **D1.2 — `discount_cents` and `po_number`/`sales_rep`/`ship_to` exist in schema but are NOT captured in the create UI** (`invoice-manager.tsx` create form posts only lines/dates/tax/retainage). Schema-ahead-of-UI.
- **D1.3 — No `bill_to`/`ship_to` snapshot written at issue** — the create route never populates the jsonb snapshot columns, so a later change to the `core.customer` address silently rewrites history on the hosted view. A book of record must snapshot.
- **D1.4 — No currency field surfaced** (multi-currency is seam-only/deferred per GATE 11 — acceptable to defer, but the invoice should stamp the tenant's functional currency).
- **D1.5 — No attachments** (customer PO, signed proposal). QBO supports attachments on the transaction.

**Acceptance criteria:**
- AC1.1 Creating an invoice persists every captured field (po_number, sales_rep, customer_message, discount, ship_to) and they round-trip to GET `/api/invoices/[id]` and render on the PDF + hosted page.
- AC1.2 On issue (status leaves DRAFT), `bill_to` and `ship_to` jsonb are written as an immutable snapshot; a subsequent edit to the `core.customer` record does NOT change the issued invoice's printed address.
- AC1.3 A line references an optional catalog item; selecting an item defaults the description, unit price, GL account, and tax code, all still editable.
- AC1.4 Sum of line `amount_cents` = `subtotal_cents`; `total_cents = subtotal − discount + tax − retainage`; a Zod + DB check rejects any mismatch.

---

### Dimension 2 — Document / PDF output

**Purpose:** A branded, professional PDF that is the legal artifact of the bill — emailed, downloaded, printed.

**Current state — BUILT:**
- `lib/invoices/invoice-pdf.tsx` (`@react-pdf/renderer`, Node runtime) renders a branded PDF.
- Two routes: authed `GET /api/invoices/[id]/pdf` (drawer download/print) and **tokenized** `GET /api/pay/[token]/pdf` (customer, no session — deliberately separate because the id route is Clerk-gated and 404s for customers).
- `invoice_templates` (050): per-entity `style` (MODERN/CLASSIC/MINIMAL/BOLD/COMPACT), `logo_url`, `accent_color` (#10b981 default), `remit_to`, `footer_text`, `default_message`; public `branding` storage bucket for logos.
- `invoice_text_overrides` (050): customer-facing text overridable at INVOICE / INVOICE_TYPE / JOB / CUSTOMER scope, most-specific-wins (`resolve-invoice-text.ts`).

**Named deltas / gaps:**
- **D2.1 — Five `style` variants declared but rendering fidelity unverified.** The enum exists; the PDF component must actually branch on all five or the choice is a lie (Rule 4: no skeletons).
- **D2.2 — No "PAID"/"VOID"/"PAST DUE" watermark** on the PDF by status. QBO stamps PAID.
- **D2.3 — No remittance slip / tear-off** with remit-to + amount + invoice # (Sage and QBO print one).
- **D2.4 — Logo upload UI:** bucket exists; confirm a settings screen actually uploads and sets `logo_url` (branding settings). If absent, branding is schema-only.

**Acceptance criteria:**
- AC2.1 PDF renders in all data states: multi-line, with discount, with tax, with retainage, partially paid (shows Paid + Balance due), zero-balance PAID.
- AC2.2 Each of the 5 styles produces a visibly distinct, correct layout; the tenant's logo, accent, remit-to, and footer appear.
- AC2.3 A PAID invoice PDF shows a PAID indicator; a VOIDED invoice shows VOID and is watermarked.
- AC2.4 The tokenized PDF is byte-identical to the authed PDF for the same invoice and requires no login.

---

### Dimension 3 — Lifecycle & status tracking

**Purpose:** Every invoice has an auditable life story, not a bare status enum.

**Current state — BUILT (partial):**
- Status enum (008): DRAFT, SENT, PARTIALLY_PAID, PAID, OVERDUE, VOIDED, WRITTEN_OFF.
- `invoice_events` append-only log (050, widened by 054 for PAY_PROCESSING): CREATED, POSTED, EDITED, SENT, DELIVERED, VIEWED, PAY_INITIATED, PAY_PROCESSING, PAY_SUCCEEDED, PAY_FAILED, FUNDS_SETTLED, PAYMENT_APPLIED, REMINDER_SENT, MARKED_PAID, REFUNDED, VOIDED, CREDITED, WRITTEN_OFF.
- `recordInvoiceEvent` + `summarizeInvoiceEvents` (`lib/invoices/invoice-events.ts`) produce the timeline ("Issued · Sent · Opened 3× · last …").
- Transitions wired: CREATED (create), POSTED (post_to_gl), SENT (send route, only on provider confirm), VIEWED (hosted page load), PAY_INITIATED (intent), PAY_PROCESSING/PAY_SUCCEEDED/PAY_FAILED (webhook).

**Named deltas / gaps:**
- **D3.1 — OVERDUE is never persisted.** It is computed on the fly (`daysOverdue` in the list route). No nightly job flips SENT→OVERDUE, so the OVERDUE status tab/count and any dunning trigger cannot fire off status. QBO/Sage age invoices on a schedule.
- **D3.2 — VOIDED and WRITTEN_OFF are enum values with no route or UI** (see Dimension 5).
- **D3.3 — DELIVERED / bounce not tracked.** Enum has DELIVERED, but the send route only records SENT; there is no Resend webhook consuming delivery/bounce/complaint events. "Sent" ≠ "delivered."
- **D3.4 — FUNDS_SETTLED not wired for ACH.** `payout.paid` posts the AR payout to GL but does not stamp FUNDS_SETTLED on the specific invoice.

**Acceptance criteria:**
- AC3.1 A scheduled job (daily) transitions unpaid invoices past `due_date` to OVERDUE and writes no duplicate events; the OVERDUE tab count matches `v_ar_aging` non-current rows.
- AC3.2 The drawer renders a chronological timeline from `invoice_events` with view count and last-viewed timestamp.
- AC3.3 A Resend delivery webhook records DELIVERED; a bounce records a distinct failure event and surfaces a warning badge on the invoice.
- AC3.4 Every status transition is both a row update AND an `invoice_events` entry; the two never disagree (guard test).

---

### Dimension 4 — Delivery (email / share link / view tracking)

**Purpose:** Get the invoice to the customer with a working Pay button, and prove it arrived and was opened.

**Current state — BUILT:**
- `POST /api/invoices/[id]/send` — resolves email provider (Resend, `lib/email/provider.ts`), builds a branded email (`invoice-email.ts`, unit-tested), attaches the PDF, includes the `/pay/[token]` link, and **records SENT only after the provider confirms with a message id** (deliberate — avoids the silent-success failure). Returns EMAIL_NOT_CONFIGURED / EMAIL_FROM_MISSING / CUSTOMER_EMAIL_MISSING / EMAIL_SEND_FAILED as **distinct** codes. Flips DRAFT→SENT. Logs `invoice.send` to the human action log.
- Hosted shareable link `/pay/[token]` — public, tokenized, branded (logo/accent), records VIEWED on open, shows balance + Pay Now + remit-to.

**Named deltas / gaps:**
- **D4.1 — No CC/BCC, no multiple recipients, no custom message-per-send.** QBO lets you edit the email, add recipients, and CC yourself. Send here is one-shot to the single `core.customer.email`.
- **D4.2 — No resend / send history in UI** beyond the raw event log; no "send a copy to me."
- **D4.3 — No delivery confirmation loop** (ties to D3.3) — issuer cannot see delivered vs bounced.
- **D4.4 — No "copy pay link" affordance** in the manager for issuers who want to paste it into their own channel.

**Acceptance criteria:**
- AC4.1 Send with a configured provider delivers a branded email with the PDF attached and a working Pay link; SENT recorded with the provider message id in `meta`.
- AC4.2 Send with no provider / no from-address / no customer email each returns its distinct code and records nothing.
- AC4.3 Opening the hosted link records exactly one VIEWED per page load, attributed to `customer`; the issuer sees an incrementing open count.
- AC4.4 The issuer can add recipients and edit the message before sending; a "send me a copy" toggle CCs the sender.

---

### Dimension 5 — Edit / correction (drafts vs posted; credit memos; void/reissue)

**Purpose:** Reconcile editing to the canon's immutability rule for a book of record.

**Canon rule (binding):** **Posted invoices are immutable in place.** Corrections = **credit memo / adjustment** or **void-and-reissue**. Drafts edit freely. (Master Doc XI: "edit-with-override … financial change reverses+reposts GL"; the *product-correct* posture layered on top is that customer-facing correction of an *issued* invoice should be a credit memo, not an in-place mutation.)

**Current state — BUILT (partial) / MISSING:**
- **BUILT:** `PATCH /api/invoices/[id]` — DRAFT edits freely; a non-DRAFT invoice requires a typed `override.reason` (else 403 OVERRIDE_REQUIRED). A financial edit under override **voids the old GL issuance entry and re-posts a fresh balanced entry** (`voidJournalEntry` + `postJournalEntry`), so the trial balance never drifts; every changed field + the reason is written to `audit_log`. This is the "edit-with-override" mechanism and it is correct as an admin escape hatch.
- **MISSING — Credit memos.** There is NO customer credit-memo object, route, UI, or GL path. (`billing-consumer.ts` "credit_memo" is the *internal interdepartmental* billing path, not a customer AR credit memo.) A credit memo should: create a negative-signed AR document, post DR Revenue (or DR Deferred Revenue 2410 for rev-rec jobs) / CR AR 1100, optionally apply against one or more open invoices, and reduce AR aging.
- **MISSING — Void workflow.** VOIDED is in the enum; no route sets it, no GL reversal is tied to a void action, no UI. Void must reverse the issuance JE, set status VOIDED, keep the number (never reuse/delete — audit).
- **MISSING — Reissue.** No "void and reissue" that clones the invoice to a fresh number and links the two.
- **MISSING — Write-off.** WRITTEN_OFF in the enum; no route. Write-off = DR Bad Debt Expense / CR AR 1100 (or against an allowance), status WRITTEN_OFF, removed from aging.

**Named deltas / gaps:**
- **D5.1 — Correction posture is "override-and-reprepost," not the canon's credit-memo model** for issued invoices. The override mechanism should remain for genuine mistakes on freshly-issued invoices, but customer-visible corrections after delivery must be credit memos so the customer's copy and the GL agree.
- **D5.2 — No credit memo → refund bridge** (issue a credit, then refund via Stripe).

**Acceptance criteria:**
- AC5.1 A DRAFT invoice edits with no reason and no GL side effect.
- AC5.2 A posted invoice cannot be edited without a typed reason; with a reason, the GL is reversed+reposted and the trial balance is unchanged (existing guard).
- AC5.3 Issuing a credit memo posts a balanced entry (DR Revenue/Deferred / CR AR), reduces the target invoice balance and AR aging, writes a CREDITED event, and prints its own branded document.
- AC5.4 Voiding an issued invoice reverses its issuance JE, sets VOIDED, retains the invoice number, and removes it from AR aging; a VOID watermark shows on the PDF.
- AC5.5 Writing off posts DR Bad Debt / CR AR, sets WRITTEN_OFF, and removes the balance from aging.

---

### Dimension 6 — Automation (recurring, dunning / late fees, reminders)

**Purpose:** Eliminate manual re-billing and manual collections chasing — a core MeritBooks pillar ("AI automation that eliminates manual data entry").

**Current state — MISSING (mostly):**
- **Recurring invoices: MISSING.** The recurring engine (`lib/posting/recurring-engine.ts`, `/recurring` page) is **journal-entry-only** — it generates JEs from `recurring_templates`, not invoices. There is no recurring-invoice schedule that clones a template invoice, generates + optionally auto-sends on a cadence.
- **Dunning / reminders: MISSING.** `REMINDER_SENT` is an enum value with no scheduler, no reminder ladder, no engine. (Contrast: the receipt-chase and vendor-compliance chase pipelines exist and are a proven pattern to mirror.)
- **Late fees: MISSING.** No late-fee assessment (finance charge posting DR AR / CR Late Fee Income).

**Named deltas / gaps:**
- **D6.1 — Recurring invoices absent** — a table-stakes SMB feature (QBO/Sage both have it).
- **D6.2 — Automated dunning ladder absent** — this is where MeritBooks should *beat* QBO: an AI-assisted, tiered reminder cadence (e.g. 3 days before due, on due, +7, +14, +30) with tone escalation, quiet hours, and a one-click "pause chasing," mirroring the existing receipt-chase design (VIII Standing business logic).
- **D6.3 — Late-fee / finance-charge policy absent.**

**Acceptance criteria:**
- AC6.1 A recurring-invoice template with a cadence (monthly/quarterly/annual), start/end, and optional auto-send generates the next invoice on schedule, numbered by Books, catching up missed periods without posting out of order (mirror the JE engine's catch-up guarantee).
- AC6.2 A dunning ladder sends reminders at configured offsets to open/overdue invoices, records REMINDER_SENT with the tier, respects quiet hours, stops on payment, and is pausable per invoice/customer.
- AC6.3 Auto-post remains OFF by default; auto-send of recurring invoices is a per-tenant, per-task autonomy dial (VIII.7 — "there is never a global 'let the AI run' switch").
- AC6.4 A late-fee policy assesses a finance charge on overdue invoices as a balanced posting and a new line/child invoice, only when the tenant opts in.

---

### Dimension 7 — Analytics (AR aging, DSO, collection metrics)

**Purpose:** Tell the operator how healthy receivables are and where cash is stuck.

**Current state — BUILT (partial):**
- **AR aging: BUILT.** `v_ar_aging` view + `/api/reports/ar-aging` + `reports/ar-aging-report.tsx`, bucketed CURRENT / 1-30 / 31-60 / 61-90 / 90+, with location filter and total outstanding.

**Named deltas / gaps:**
- **D7.1 — No DSO** (Days Sales Outstanding). This was explicitly named as wanted depth.
- **D7.2 — No collection metrics** — no CEI (Collection Effectiveness Index), no average days-to-pay per customer, no % current, no rolling AR trend.
- **D7.3 — No per-customer AR drill-down / statement** from aging.
- **D7.4 — No AR aging "as of" date** — aging appears to be as-of-now only; a controller needs as-of-period-end for close.
- **D7.5 — Aging keyed to `due_date` bucket only** — no invoice-date-based aging option.

**Acceptance criteria:**
- AC7.1 A DSO metric computes `(AR / credit sales) × days` for a selectable trailing period and renders with a trend.
- AC7.2 AR aging supports an "as of" date (defaults today) and both due-date and invoice-date aging methods.
- AC7.3 A collections dashboard shows % current, average days-to-pay, CEI, and top overdue customers, each drilling to the invoice list.
- AC7.4 Every analytic ties to `v_ar_aging` / real invoice data — no hardcoded arrays (Rule 4).

---

### Dimension 8 — RBAC (which roles do what)

**Purpose:** Enforce that only authorized roles issue, send, credit, void, and write off — segregation of duties on AR.

**Current state — PARTIAL (defined, NOT enforced):**
- `lib/rbac/permissions.ts` defines feature `invoices` (category Relationships, actions view/create/approve, internalOnly) and business-view `biz_invoices` (view). Roles map: owner/admin `all`; controller/AR roles view+create; business-view customer sees only their own.
- **NOT enforced:** nav shows all; page/route guards not wired (Master Doc IV: "nav/page enforcement by role NOT wired"). Only `gl/post` has the `require-permission` reference guard.
- Edit override is gated by required-reason + audit, NOT by role (Master Doc XI).

**Named deltas / gaps:**
- **D8.1 — No route-level permission checks on invoice create/send/credit/void/write-off.** Any authed org user can hit these routes.
- **D8.2 — Separation of duties not expressed for AR** — the same actor can create and "approve"/send. Money movement has preparer≠approver (migration 042); AR should at minimum gate void/write-off/credit-memo to elevated roles.
- **D8.3 — `canApprove` still reads `core.employees.role` as a stopgap** (CANON-ANCHOR §3) — any AR approval gate must reconcile to `core.users/memberships/roles`, not bake a Books-private rule.

**Acceptance criteria:**
- AC8.1 Create/send require the `invoices:create` permission; credit-memo/void/write-off require an elevated permission (e.g. `invoices:approve` or admin); denied requests return the standard `permissionDenied`.
- AC8.2 The sidebar/page hides Invoices for roles without `invoices:view`.
- AC8.3 Business-view customers see only their own invoices (org + customer scoped), never another customer's.
- AC8.4 Any AR authorization reconciles to `core` identity, not `core.employees.role`.

---

### Dimension 9 — Payments (Stripe Pay Now, ACH / card, the fee model)

**Purpose:** Let the customer pay online in one click; post the money correctly to the book of record.

**Current state — BUILT (verification-pending per GATE 12.1):**
- **Pay Now end-to-end:** `/pay/[token]` → `POST /api/pay/[token]/intent` creates a **destination-charge** PaymentIntent to the tenant's connected Stripe account (Express), application fee = platform spread; returns client secret + publishable key. Methods resolved by cascade (`resolve-payment-methods.ts`) intersected with provider support; CARD + ACH online, CHECK shows remit-to.
- **Two-layer fee model (BUILT):** Layer 1 = what MeritBooks charges the merchant, read from `merchant_fee_schedules` (migration 057, `lib/money/fees.ts`, `computeFee`) with rate + cap/floor (replaced hardcoded 1%/3%); Layer 2 = pass-through vs absorb, asymmetric by method (card passes through unless off; ACH absorbed unless on), invoice-level override honored, customer must accept a passed-through fee. Fee economics locked: card 3%, ACH 1% uncapped (mirrors QBO).
- **Webhook (`api/webhooks/stripe/route.ts`):** `payment_intent.succeeded` → `applyStripePaymentToInvoice` (posts the balanced payment JE, records `customer_payment`, reduces balance, flips PARTIALLY_PAID/PAID, PAY_SUCCEEDED) — **GL posts BEFORE status flips**, and on failure the idempotency claim is released so Stripe retries (a book of record never shows PAID with no JE). `payment_intent.processing` → PAY_PROCESSING (informational, no GL). `payment_failed` → PAY_FAILED. `payout.paid` → `postArPayout`. Platform fee income posts on Merit's own books when `PLATFORM_ORG_ID` is set. Idempotent on Stripe `event.id` (`stripe_events`, migration 051) and on `customer_payments.reference_number = PI id`.
- GL on tenant books: DR Settlement Clearing (net) + DR Merchant Fee Expense (fee) / CR AR 1100 (base).

**Named deltas / gaps:**
- **D9.1 — GATE 12.1 open blocker:** payment→PAID→GL was NOT verified end-to-end (suspected platform-account webhook-scope misconfig; needs a `4242` card test). Until verified, Payments is "built, unverified." This is the single highest invoice-adjacent priority.
- **D9.2 — No manual "record payment" parity check.** The manager has an `onPaymentClick`; confirm the manual (check/cash/ACH-offline) payment path posts DR Cash / CR AR, applies via `payment_applications`, and flips status — same as the Stripe path.
- **D9.3 — No refund path** (Stripe refund → REFUNDED event → DR AR or contra / CR Clearing).
- **D9.4 — No partial-payment UX on the hosted page** — customer can only pay the full balance.
- **D9.5 — Surcharge fixed at 3% in the hosted UI copy** while the real fee is schedule-driven — cosmetic mismatch to reconcile.

**Acceptance criteria:**
- AC9.1 A `4242` card payment flips the invoice to PAID and posts a balanced JE (DR Clearing + DR Fee / CR AR); the trial balance ties (payment-chain integration test un-skipped and green).
- AC9.2 ACH `processing` records PAY_PROCESSING and does NOT post GL or flip status; on later success it posts and flips.
- AC9.3 Duplicate webhook deliveries post exactly once (idempotency on event.id and PI id).
- AC9.4 A manual offline payment posts DR Cash / CR AR, applies to the invoice, and flips status identically.
- AC9.5 A refund posts a balanced reversal, records REFUNDED, and re-opens the balance/aging.
- AC9.6 A passed-through fee is added to the amount charged only; the invoice `total_cents` never changes.

---

### Dimension 10 — Rev-rec interaction (Deferred Revenue 2410)

**Purpose:** Reconcile invoicing to revenue recognition — billing must not equal recognition for rev-rec-managed jobs.

**Canon rule (binding):** For a **rev-rec-managed job**, the customer invoice credits **Deferred Revenue (2410), NOT Revenue**. Recognition is posted separately by `rev-rec.ts` (posting delta = earned − already-recognized: DR 2410 + DR 1180 Unbilled remainder / CR Revenue; reversal if delta < 0). Billing is **decoupled from recognition** unless the method is POINT_OF_SALE / AS_BILLED (Master Doc XI). Resolution order: per-job override → per-revenue-type → company default → legacy job_type map.

**Current state — PARTIAL / MISSING at the invoice layer:**
- **MISSING in the manual invoice path:** `app/api/invoices/route.ts` POST posts **DR AR / CR each line's revenue account directly** — it does NOT consult the rev-rec resolver, so a manual invoice against a rev-rec-managed job wrongly credits Revenue instead of Deferred Revenue 2410. This is a **correctness defect** for the book of record.
- **PARTIAL elsewhere:** `billing-consumer.ts` (the JOB_BILLING event path from the Projects module) does route through rev-rec/deferral. The seam works; the **operator-created invoice does not**.

**Named deltas / gaps:**
- **D10.1 — Manual invoice posting bypasses rev-rec.** Must resolve the job's effective method; if deferred, credit 2410 (and 1180 as applicable) instead of the line revenue accounts.
- **D10.2 — No UI signal** that an invoice is on a rev-rec job (the issuer should see "this bills to Deferred Revenue; recognition runs monthly").

**Acceptance criteria:**
- AC10.1 An invoice on a rev-rec-managed job posts DR AR 1100 / CR Deferred Revenue 2410 (not the line revenue account); an invoice on a POINT_OF_SALE/AS_BILLED job posts directly to Revenue.
- AC10.2 Recognition continues to be posted by `rev-rec.ts` on its monthly schedule; invoicing never double-recognizes.
- AC10.3 A guard test asserts that for a job with a deferred method, no invoice-issuance JE credits a REVENUE-type account.
- AC10.4 The create UI shows the resolved revenue treatment before posting.

---

### Dimension 11 — QBO / Sage / best-in-class benchmark (Rule 14, NAMED DELTAS)

**Purpose (Rule 14, mandatory):** Itemize what the market leaders do that MeritBooks must **match** or **beat**. QBO/Sage are the AR bar; MeritBooks' differentiation is AI-native collections + a true book of record with rev-rec built in.

| # | Capability | QuickBooks Online | Sage (Intacct / 50) | MeritBooks today | Verdict |
|---|---|---|---|---|---|
| B1 | Product/Service **item catalog** driving lines (default account, price, tax) | Yes (core) | Yes | No — raw description + manual GL pick (D1.1) | **MATCH** (build catalog) |
| B2 | **Recurring invoices** with auto-send | Yes | Yes | No — recurring engine is JE-only (D6.1) | **MATCH** |
| B3 | **Credit memos** + apply to invoices/refund | Yes | Yes | No customer credit memo (D5.1) | **MATCH** |
| B4 | **Automated payment reminders / dunning** | Yes (basic ladder) | Yes | No (D6.2) | **BEAT** — AI-tiered, tone-escalating, quiet hours |
| B5 | **Late fees / finance charges** | Yes | Yes | No (D6.3) | **MATCH** |
| B6 | **Online Pay Now** (ACH + card), hosted page | Yes (QuickBooks Payments) | Yes | Yes — Stripe Connect destination charges (verify D9.1) | **MATCH** (near-parity) |
| B7 | **Customer statements** (open-item / balance-forward) | Yes | Yes | No | **MATCH** |
| B8 | **Estimates / quotes → invoice** conversion | Yes | Yes | No | **MATCH** (defer-able) |
| B9 | **AR aging** report | Yes | Yes (deep) | Yes — `v_ar_aging` bucketed | **MATCH** |
| B10 | **DSO / collections KPIs** | Partial | Yes (Intacct strong) | No (D7.1/D7.2) | **BEAT** — DSO + CEI + AI collections triage |
| B11 | **Progress / AIA billing** (schedule of values, G702/G703, retainage) | Weak | Add-on | Columns exist (`is_progress_bill`, `application_number`, retainage cascade); no SOV UI | **BEAT** — construction-native |
| B12 | **Sales tax** automation (rates, nexus, per-line codes) | Yes (auto sales tax) | Yes | Flat `tax_cents` only (D1.1) | **MATCH** (defer to GATE 11d) |
| B13 | **Multi-entity / consolidated AR** | Weak (QBO) | Yes (Intacct) | Location/entity scoped; consolidation is GATE 11a | **BEAT** (via 11a) |
| B14 | **Rev-rec on billing** (defer vs recognize) | Add-on / weak | Yes (Intacct) | Engine exists; **not wired to manual invoice** (D10.1) | **BEAT** — native, once wired |
| B15 | **Delivery/open tracking** ("viewed") | Yes | Partial | VIEWED tracked; DELIVERED/bounce not (D3.3) | **MATCH** |
| B16 | **Attachments** on the invoice | Yes | Yes | No (D1.5) | **MATCH** |
| B17 | **Batch invoicing / batch send** | Yes | Yes | No | **MATCH** (defer-able) |
| B18 | **Portal** where a customer sees all their invoices/history | Yes | Yes | Single-invoice hosted page only; `biz_invoices` view defined not built | **MATCH** |

**Where MeritBooks must BEAT (the moat, GATE 9):** AI-native collections (B4/B10) — an autonomous, supervised dunning + cash-application agent that triages overdue AR, drafts escalating outreach, predicts pay dates, and proposes write-offs, all human-approved and audited; native rev-rec on billing (B14); construction-native progress/retainage billing (B11). Parity items (B1/B2/B3/B5/B7) are table stakes to reach "Complete."

---

### Dimension 12 — Testable acceptance criteria (roll-up + module-level gates)

Beyond the per-dimension ACs above, the module is **Complete** only when:
- **AC-M1** The skipped `payment-chain.integration.test.ts` is un-skipped and green (payment → PAID → balanced GL).
- **AC-M2** A schema-contract guard asserts every status/event literal the code writes is accepted by its CHECK/enum (extend `schema-contract.test.ts` to invoices).
- **AC-M3** A rev-rec guard asserts deferred-method jobs never credit a REVENUE-type account at invoice issuance (AC10.3).
- **AC-M4** Tenant-isolation test covers invoices, invoice_events, invoice_templates, invoice_text_overrides (RLS proven, not assumed).
- **AC-M5** Every list/report renders loading / empty / populated / error; every destructive action (void, write-off, delete draft) confirms; search debounced; lists paginated (Rules 3–5).
- **AC-M6** No route posts to GL off unverified schema (Rule 11 — column names cat'd against migrations).

---

### Dimension 13 — Data model changes required to reach Complete

New/extended objects (spec, not code — migrations serialize through the lead):
1. **`invoice_items` / catalog** in `core` (owned by Core masters) — item, default account, default price, default tax code, active. Lines reference `item_id` (nullable).
2. **`credit_memos`** (`public`) — mirror of invoices (negative), `applied_to` links, GL entry id, status, public document. `credit_memo_applications` (memo → invoice).
3. **`recurring_invoices`** (`public`) — template header + lines, cadence, next_run_date, auto_send flag, last_generated_at (mirror `recurring_templates` shape for the catch-up guarantee).
4. **`invoice_reminders`** config + a dunning ladder table (offsets, tiers, quiet hours) — mirror the receipt-chase / vendor-compliance chase pattern.
5. **Late-fee policy** columns/table (rate, grace days, income account role LATE_FEE_INCOME).
6. **`bill_to`/`ship_to` snapshot population** (columns exist — wire the write on issue).
7. **Persist OVERDUE** via a scheduled transition (no schema change; a job + event).
8. **Account roles** needed: BAD_DEBT_EXPENSE (write-off), LATE_FEE_INCOME, ALLOWANCE_FOR_DOUBTFUL (optional) — resolve **by role, not hardcoded number** (canon).

All new tables: `org_id` + RLS `org_id = get_org_id()`, cents=bigint, idempotent migration, guard tests.

---

### Dimension 14 — AI behavior (per the three pillars, all human-approved)

**Purpose:** AI does the manual labor; staff supervise; leaders verify.
- **AI collections triage:** rank overdue AR by risk/amount, draft the next dunning message at the right tier, predict pay date — **proposals only**, human sends (or per-task autonomy dial enables auto-send).
- **AI cash application (GATE 8):** match incoming bank/Stripe receipts to open invoices, propose the application, human approves — never auto-applies material/ambiguous items.
- **AI write-off suggestion:** flag likely-uncollectible AR with reasoning; human approves the write-off JE.
- **Guardrails (VIII.7):** advisory by default; SoD on the AI itself (the agent that drafts collections cannot also approve a write-off); every AI action → Decision Log (`public.ai_decisions`); AI never writes debits/credits; ask ONE disambiguating question when ambiguous; non-standard GAAP flagged. AI routes only through `@meritbooks/core-ai` (metered to `core.ai_usage_log`, tenant budget enforced across the suite).

**Acceptance:** AC14.1 every AI-proposed collections/cash-app/write-off action is logged with inputs and rationale and requires a human approve step before any GL or send; AC14.2 no AI path holds an Anthropic key or calls the API directly.

---

### Dimension 15 — Current-state ledger row (Rule 15)

| Dimension | State | Evidence |
|---|---|---|
| 1 Data captured | 🔶 Partial | 008 + 050 columns; UI captures subset; no catalog/snapshot |
| 2 PDF output | ✅ Built | `invoice-pdf.tsx`, both PDF routes, templates/branding |
| 3 Lifecycle | 🔶 Partial | events log built; OVERDUE/VOID/WRITE-OFF/DELIVERED gaps |
| 4 Delivery | 🔶 Partial | send route + hosted link + VIEWED; no CC/multi-recipient/delivery |
| 5 Edit/correct | 🔶 Partial | override-and-repost built; credit memo / void / write-off missing |
| 6 Automation | ❌ Missing | recurring is JE-only; no dunning; no late fees |
| 7 Analytics | 🔶 Partial | AR aging built; no DSO/CEI/collections |
| 8 RBAC | 🔶 Partial | perms defined, not enforced |
| 9 Payments | 🔶 Built-unverified | Stripe end-to-end built; GATE 12.1 not verified |
| 10 Rev-rec | ❌ Defect | manual invoice credits Revenue, not 2410 |
| 11 Benchmark | — | see Dimension 11 |

Overall: **Functional — partial.** Not Complete.

---

## §2. Build sequence — Functional-partial → Complete

Strictly ordered; each slice behind the wave pipeline (FPB → disjoint slices → builder wave → verifier + chrome-auditor + security for money → reviewer → integrate → scribe). Migrations to Supabase first.

**Wave A — Correctness & verification (blockers, do first):**
1. **Verify GATE 12.1** — resolve the platform-account webhook scope, run a `4242` card test, un-skip `payment-chain.integration.test.ts` (D9.1, AC9.1/AC-M1). *Highest priority — nothing else in AR is trustworthy until money posts.*
2. **Wire rev-rec into the manual invoice** — resolve job method, credit 2410/1180 when deferred; add the guard test (D10.1, AC10.1/AC-M3). *Correctness defect on the book of record.*
3. **Snapshot bill_to/ship_to on issue** + **persist OVERDUE** via a scheduled transition (D1.3, D3.1).

**Wave B — Correction model (canon compliance):**
4. **Credit memos** (object + GL + apply + document) (D5.1).
5. **Void** and **write-off** workflows + routes + PDF watermark (D5.2, D3.2).

**Wave C — Automation (the pillar + the moat):**
6. **Recurring invoices** engine mirroring the JE catch-up guarantee (D6.1).
7. **Dunning ladder** mirroring receipt-chase, + REMINDER_SENT wiring, pausable, quiet hours (D6.2).
8. **Late fees** policy + posting (D6.3).

**Wave D — Depth & analytics:**
9. **DSO + collections dashboard** (DSO/CEI/avg-days-to-pay, as-of aging) (D7.1–D7.4).
10. **Item catalog** driving lines (D1.1); capture discount/PO/sales-rep/ship-to in the create UI (D1.2).
11. **Delivery tracking** (Resend delivery/bounce webhook → DELIVERED/bounce) + CC/multi-recipient send (D3.3, D4.1).

**Wave E — Governance & polish:**
12. **RBAC enforcement** on invoice routes + nav (reconciled to `core` identity, not `core.employees.role`); SoD gates on void/write-off/credit (D8.1–D8.3). *Coupled to the standing NO-GO RBAC gate.*
13. **Customer statements** + **portal** (`biz_invoices`) (B7/B18).
14. **AI collections triage + cash application** proposals, human-approved, logged (Dimension 14; ties to GATE 8/9).

**Deferred with reason (not required for first Complete):** sales-tax automation (GATE 11d), estimates→invoice (B8), multi-currency (seam-only, GATE 11), batch invoicing (B17). State the deferral in the Ledger.

---

## §3. Definition of Complete for this module

Invoices is **Complete** when: every Wave A–D slice ships and passes its acceptance criteria; the module-level gates AC-M1…AC-M6 are green; every Rule-14 benchmark row is MATCH-or-better (or explicitly deferred with reason in the Ledger); and the verifier + chrome-auditor + security agents confirm TRUTH against the deployed app and live Supabase. Wave E raises it toward **Verified**. Until then the Ledger row stays **Functional — partial**.
