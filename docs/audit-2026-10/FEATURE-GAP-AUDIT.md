# MeritBooks: Feature Gap Audit and Build Plan

**Date:** 2026-10-22. **Author:** auditor agent (product lead). **Repo:** `main` @ `f19ff09`. **Live DB:** `npqeijipggtuduhkejxq` (read-only). **Vercel:** `meritbooks-web` (key names only).
**Inputs:** A (1,853 spec rows), B (5,866 conversation/IA/FPB/board rows), C (verified code reality), D (partner portal reporting), E (reporting benchmark). I also checked the repo, live DB and Vercel directly today; those checks are marked "verified today".
**Status scale:** **FULL** means the code path does the whole job end to end. It does *not* mean anyone has used it with real data (see the live row counts in C). **PARTIAL** means it exists but a named step is missing. **STUB** means a screen, setting or registered job that does nothing. **MISSING** means it is not in the code.
**Priority:** **P0** = blocks go-live for Merit as tenant #1 *or* was named by the owner on 2026-10-22. **P1** = core to a credible book of record. **P2** = enhancement.

---

## 1. Executive summary (for Mike)

**What I did.** I took everything you specified (the formal docs and everything you said in this build conversation): 7,670 requirement rows once the 49 retired items are removed. Many say the same thing several times, so I merged them into **300 distinct features**. Then I checked each one against the actual code, the live database and the live server settings.

**The scorecard (300 features):**

| Result | Features | Share | What it means in plain English |
|---|--:|--:|---|
| Full | 71 | 24% | The code does the whole job. Almost none of it has been used with real data, though: today the live system holds 2 bills, 3 invoices, 0 receipts, 0 payroll runs, 0 bank reconciliations and 0 check runs. |
| Partial | 128 | 43% | It exists, but a step you would notice is missing. |
| Stub | 19 | 6% | A screen or setting that does nothing. The "Receipt Chase" settings tab is an example. |
| Missing | 82 | 27% | Not built. |

**66 open P0 gaps.** The domains with the most missing depth:
- Reporting and FP&A: 19 of 42 features missing.
- Receipt chase and the Workforce app: 6 of 11 missing.
- Check processing: 5 of 8 missing.
- Integrations: 6 of 11 missing.

**You were right.** The core accounting is broad and mostly sound: the ledger, bank-feed review, bills, reconciliation, consolidation, close grid, tax schedules and permissions. What is thin is:
- everything that has to **reach a person** (chasing receipts, W-9s and COIs, dunning);
- everything that has to **run on its own** (11 scheduled jobs are placeholders);
- everything that touches **real money or real mail** (Stripe is pinned to test mode, Plaid is in sandbox, there is no check printing, and the AP email inbox is switched off);
- the **presentation layer** for reporting and FP&A, which your partner portal currently beats.

**The 10 most important gaps**

| # | Gap | Why it matters |
|---|---|---|
| 1 | **Online payments and bank feeds are not live.** Stripe is hard-coded to test mode (`api/payments/connect/route.ts:17`). There is one Stripe account per tenant, not one per company. Plaid is in sandbox. Bank sync never runs on its own. | Customers cannot actually pay, and the books don't fill themselves. The Payments screen even says "payments are live" while in test mode. |
| 2 | **Reporting and FP&A depth.** There is no shared report engine. "P&L by Department/Class" show the plain P&L. There are no charts in Reports, no metric catalog, no budget versions or approvals, and no "books closed through" governance. | Your partner portal beats it today (37 metric cards, charts, bridges, league table). |
| 3 | **Nothing chases anyone.** There is no shared engine that sends requests, reminders or escalations. Receipt chase, W-9/COI chase and dunning are settings or counters only. | The core promise is that the system does the follow-up. |
| 4 | **No receipt capture and no Merit Workforce app.** | Card spend can't be documented, and employees have no app. |
| 5 | **The check processor can't print or mail checks.** There is no check stock or MICR line, no check numbering, no void, no check register, and the "positive pay" file isn't one. | The approved-bill-to-paper-check workflow you described doesn't exist past "export a CSV". |
| 6 | **Split transactions are missing.** | Every mixed purchase needs a manual journal entry. |
| 7 | **Payables email import is built but switched off.** The secret isn't set, there's no mail provider, and the address is never shown in the app. | Bills don't flow in by themselves. |
| 8 | **Invoice customization is buried and shallow.** It sits in a legacy Settings tab. There are no column or field options. Customer invoices print your GL account numbers. The pay link isn't on the PDF. Card payments are off by default. | It isn't credible to send these to customers. |
| 9 | **11 scheduled jobs are placeholders** (`lib/scheduler/registry.ts:218-242`). | Recurring invoices, dunning, the monthly rev-rec run, Plaid sync, lender packs and budget-vs-actual pushes never happen automatically. |
| 10 | **You couldn't find things that do exist:** the rev-rec election (a Settings tab), team performance (a tab inside "Team & access") and the check run (labelled "Pay runs"). There are no role homes, and legacy black/green screens remain. | If you can't see it, it doesn't exist for you. |

**Why depth was lost (candidly):**
1. **Breadth over depth.** 131 pages, 522 API routes and 158 migrations (numbered up to 174) were built. Each feature stopped when "the code path works", not when a person had used it with real data. With 3 invoices in the system, the missing steps never surfaced.
2. **Engines without screens, and screens without a way to find them.** The rev-rec election, team performance, check runs, the AP inbox address and invoice branding all exist but are buried or mislabelled. The R1 redesign re-skinned pages rather than rethinking where things belong.
3. **The last mile depends on providers and secrets nobody set up:** inbound email, SMS, Gusto, QuickBooks keys, Plaid production and Stripe live mode. Features were marked done at "adapter written".
4. **Scheduled jobs were registered as placeholders,** so every "automatic" feature is manual.
5. **Specs were written but not built.** The FPBs for the 175-report library, the Workforce app, the vendor chase and team performance all exist. The builds stopped at the first slice.
6. **"Built" was claimed from tests and type-checks,** not from what you can see and click. You said it yourself: "live" must mean visible to you.

**What's next.** Two waves of 5 parallel slices each go first.
- **Wave 1:** make money live; invoice customization and pay links; split transactions; the shared chase/notification engine; the rev-rec election and WIP.
- **Wave 2:** vendor W-9/COI chase; receipt capture and chase; check printing with a register and voids; the payables email inbox live; the scheduled jobs.
- **Waves 3 and 4:** rebuild reporting and FP&A on one engine, aiming to beat your partner portal.
- I need **10 decisions** from you (§6.4). The first three are about Stripe, Plaid and checks.

---

## 2. Your named items, answered

Each item gives: what exists (with evidence), what is missing, what "world class" looks like, the effort (S ≈ one builder slice, M ≈ one to two slices, L ≈ a multi-slice program) and the dependencies.

### 2.1 Receipt chase and the Merit Workforce app

- **What exists:**
  - A "Receipt Chase" tab in Settings (`settings-client.tsx:209-232`) with first-reminder, interval, escalation, channel and quiet-hours fields. **Nothing reads these settings.**
  - A `receipts.chase_reminder_count` column and a "chase count" badge on the credit-card feed. **They are never incremented, so they always show 0.**
  - `POST /api/receipts/submit`. **No screen calls it**, and there are 0 live receipts.
  - `/receipts` categorizes receipts that already exist.
  - An expense-line ↔ card-charge matcher (`api/expenses/lines/[lineId]/match-card`).
  - FPB-workforce-app.md is written: screens, the per-tenant and per-client chase switch, the Pay tab and commissions.
- **What's missing:**
  - Receipt capture of any kind: upload, phone camera, email-in, text-in.
  - The chase sender: the job is a TODO at `registry.ts:224`.
  - Any SMS or push provider.
  - Card → cardholder assignment.
  - The tenant/client on-off switch.
  - The Workforce app itself (no app, no PWA manifest): clock-in, pay stubs and commission statements.
- **World class** (Ramp/Expensify/Brex pattern):
  - The moment a card is swiped, the cardholder gets a push or text: "Shell $68.42, reply with a photo".
  - Replying with a photo, or forwarding the e-receipt, attaches it. AI reads it, matches it to the charge and codes it from the vendor's history.
  - Reminders follow the cadence (0/2/5/10 days) and respect quiet hours. They escalate to the supervisor, and optionally the card is locked after N days.
  - Charges under a threshold need no receipt (IRS $75 rule, configurable).
  - Receipts are pulled automatically from connected inboxes (Amazon, Home Depot, Uber).
  - Missing-receipt aging appears on the bookkeeper's home.
  - In Workforce: "What do I owe?" (receipts), "What am I owed?" (reimbursements), "What did I get paid?" (stubs and commissions), and "Am I on the clock?".
- **Effort:** **L**.
  - Web capture and chase: M (Wave 2B).
  - Workforce PWA: M (Wave 5B).
  - Clock-in depends on the Projects time module and must hide itself for Books-only clients (Books stands alone).
- **Dependencies:**
  - The shared request engine (Wave 1D).
  - An inbound email provider (shared with AP, Wave 2D).
  - **Your decision on SMS** (Twilio-class, which needs business 10DLC registration). Until then, email plus in-app notifications.
  - The payroll provider, for pay stubs (Gusto decision).

### 2.2 Vendor W-9 / COI chase

- **What exists (strong tracking, nothing sent):**
  - Document tracking for W-9, GL COI, WC COI and WC exemption, with expiry states and a 60-day window (`lib/services/vendor-compliance.ts`, `/vendor-compliance`).
  - A payment hold enforced at pay time, with one-time, temporary and permanent overrides that require a reason.
  - AI W-9 and COI parsing.
  - A nightly scan (`vendors.compliance_scan` has run 4×) that **schedules and counts** chases and logs `CHASE_SCHEDULED`.
  - A magic-link vendor upload portal (`app/portal/vendor/[token]`). **The link is only copied to the clipboard** (`vendor-portal-access.tsx:131`).
  - The submission list hardcodes `reviewStatus:'PENDING'`. Live: 0 docs, 0 tokens.
- **What's missing:**
  - The sender (email/SMS with the portal link).
  - A requirement model: what each vendor owes by type, state, job or client, including limits and endorsements.
  - Submission review (accept/reject → VALID doc with expiry → hold lifts automatically).
  - Your cadence: request at T-30, reminders at T-15 and T-0, then weekly until cured.
  - Chasing the vendor's insurance agent directly.
  - OFAC screening and IRS TIN match.
- **World class** (TrustLayer/myCOI/Certificial plus Track1099):
  - Requirement templates per vendor type (for example GL $1M/$2M, WC statutory, auto, umbrella, additional-insured and waiver-of-subrogation endorsements).
  - AI reads the COI *and* the endorsements, then checks limits and named insured against the requirement. Every deficiency is listed in plain English.
  - The request goes to both the vendor and its broker. The vendor uploads by phone or e-signs a W-9 with TIN validation.
  - A person accepts with one click. The hold lifts and the renewal is chased automatically.
  - One document covers every company that uses the vendor.
- **Effort:** **M** (Wave 2A).
- **Dependencies:** the request engine (1D); Resend (present); optional SMS. FPB: `FPB-vendor-compliance-chase.md` (exists).

### 2.3 Check processor: print and mail approved checks

- **What exists:**
  - A 5-step check run: queue approved bills → capture details → review → export or mark → release (`checks-client.tsx:330`).
  - Preparer ≠ approver ≠ releaser. Release posts DR A/P / CR Cash with a duplicate guard and a compliance gate (`api/ap/disbursements/release`).
  - A remittance-advice PDF.
  - A role key `payments_clerk` exists. **The nav item is labelled "Pay runs"** (`navigation.ts:76`), which is why you didn't see a check processor. Live: 0 batches.
- **What's missing:**
  - Printing on check stock: MICR E-13B line, signature image, voucher stub, alignment test, reprint/spoil.
  - Check-number sequencing per bank account, with gap detection. Today a typed number is stored as a reference only.
  - Void / stop-payment: reverse the JE, reopen the bill, flag the positive-pay void.
  - A check register (printed, cleared, voided, stale).
  - A real positive-pay file. Today's CSV has no check number or account number (`disbursement-export.ts:54-67`).
  - Mailing through a provider.
  - NACHA has placeholder bank fields because only masked account numbers are stored.
- **World class** (Bill.com/Melio/Checkbook/Lob):
  - The check processor's home shows "12 checks approved, $48,210, ready to print".
  - Print on blank stock with MICR, a dual signature above a threshold and the remittance on the stub.
  - **Or** send to a print-and-mail service with tracking.
  - The positive-pay file is generated in the bank's own format and uploaded before cutoff.
  - Checks clear automatically from the bank feed. Stale checks over 90/180 days are surfaced, with an escheat note.
  - Voids are one click with full reversal.
- **Effort:** **L**.
  - Print, register, numbering and void: M (Wave 2C).
  - Mail provider: S once you decide.
  - Positive-pay formats: S per bank.
- **Dependencies:**
  - **Your decision:** print in-house (MICR-capable printer or toner, blank stock, bank sign-off on the layout), mail via a service (per-check fee), or both.
  - Which banks need positive pay.
  - Secure signature storage.
  - The security agent must review this.

### 2.4 Team performance dashboard for accounting managers

- **What exists** (good engine, no data, hard to find):
  - `lib/team-performance/compute.ts` (473 lines, tested) and `team/performance-panel.tsx` (1,046 lines).
  - Per-person: weighted throughput, items by family, $ processed, approval latency, rework rate, override rate and a composite score.
  - Team KPIs: close on-time % and filing on-time %.
  - Self vs team views follow permissions. It lives at `/team` → Performance tab, under "Team & access" in the firm workspace (`navigation.ts:178`).
  - Only 11 `core.action_log` rows exist live, so it is effectively empty.
- **What's missing:**
  - An accounting-manager home that leads with this.
  - A screen to set weights and targets.
  - Queue aging and backlog *per bookkeeper* (today only per company on `/operations`).
  - Capacity and workload (0 `practice_assignments`).
  - Status badges ("On fire / On track / Behind") and the stack-rankings views from your original audit (#336–341). The Master Doc dropped these silently.
- **World class** (Karbon/Double plus a CFO lens):
  - The AM cockpit shows:
    - each person's queue (count, oldest item, $ at stake);
    - throughput vs target;
    - first-pass quality;
    - close status by client;
    - "who's behind and why".
  - One click opens the items. Fair comparisons are weighted by difficulty, and coaching patterns are surfaced ("Jen's reclasses are mostly fuel cards").
- **Effort:** **M** (Wave 5A). Surfacing it on an AM home is S (lead nav change in Wave 1).
- **Dependencies:** real usage (action_log fills as people work); practice assignments entered. FPB: `FPB-team-performance.md` (exists).

### 2.5 Elect to accrue revenue / accrue AR for underbillings

- **What exists** (the accounting is real; the "election" is hidden):
  - 9 rev-rec methods.
  - The election is the **method choice**: company default in Settings → Revenue Recognition (`rev-rec-config.tsx`), a job-type → method map, and a per-job override.
  - The engine posts the earned delta to 2410 (deferred) and 1180 (unbilled).
  - A separate underbilling (1180) accrual with preview / post / reverse (`/rev-rec` → Accrual tab).
  - Rev-rec reports and a WIP schedule (`/jobs/wip`).
- **What's missing:**
  - Plain-English wording. Nothing on screen says "accrue revenue" or "accrue AR for underbillings".
  - A **company switch "accrue underbillings automatically at month-end"**.
  - A close step that proposes the accrual every period.
  - The monthly job `revrec.monthly` has never run and is propose-only.
  - The WIP screen doesn't tie to the GL or post the over/under adjustment.
- **World class** (Foundation/Sage 100 Contractor pattern):
  - On company setup: "How do you recognize revenue on jobs? [Percent complete – accrue earned revenue and underbillings each month (recommended for contractors)] [As billed] [Completed contract]…" with a one-line example of the journal entry it will make.
  - Each month-end the close checklist shows "WIP: 14 jobs, underbilled $212k, overbilled $88k → proposed entry", tied out to the 1180/2410 GL balances. It is approved in one click and auto-reverses next month.
  - Per-job exceptions are allowed.
- **Effort:** **S–M** (Wave 1E).
- **Dependencies:** none external. The spec is `REV-REC-WIP-SPEC.md`; promote it to an FPB.

### 2.6 Import from the payables email

- **What exists (built, switched off):**
  - The webhook `POST /api/webhooks/inbound-email` with shared-secret auth and de-dup.
  - Claude-vision parse into a PROPOSED draft in `/bills/intake-queue` ("Received by email from …").
  - Per-tenant addresses exist in the DB (e.g. `ap-merit-management-group-live@inbound.meritbooks.app`).
- **Why it doesn't work:**
  - `INBOUND_EMAIL_SECRET` is **not set** in Vercel, so the route rejects everything.
  - There is no mail provider and no MX record for `inbound.meritbooks.app`.
  - **The address is never shown anywhere in the app.**
  - It is per tenant, not per company, and every bill lands on the default company.
  - There is no Gmail/Outlook mailbox connection.
- **World class** (Bill.com/Ramp/Vic.ai):
  - Each company has its own address, shown on the Bills page and in onboarding with a "copy" button and an IT one-pager.
  - Forwarded bills are parsed and matched to the vendor, PO and job. Duplicates are blocked.
  - Statements and non-bills are routed separately, and the sender gets an auto-reply.
  - A connected Outlook/Gmail mailbox can be backfilled.
- **Effort:** **S** for code; owner DNS work (Wave 2D). OAuth mailboxes: M (Wave 6).
- **Dependencies:** **your approval** of an inbound provider (Postmark recommended) and a DNS change; the secret set in Vercel.

### 2.7 Split transactions

- **What exists:** nothing for bank or card lines. `api/bank-feed/approve/route.ts:142-149` always builds exactly two lines. Bills, JEs and expense reports are multi-line.
- **What's missing:**
  - Splitting one bank or card transaction across accounts, departments, classes, jobs and companies.
  - Cross-company splits that create the intercompany due-to/due-from pair.
  - Remembered split rules.
- **World class** (QBO/Xero plus multi-entity):
  - A "Split" button in the edit panel. Allocate by $ or %, with a live "remaining to allocate" meter and keyboard entry.
  - Each line carries its own account, dimensions, job and company.
  - Cross-company lines post due-to/due-from automatically and stay eliminated in consolidation.
  - "Remember this split for Verizon (60/40 HVAC/Plumbing)".
  - The AI suggests the split from history.
- **Effort:** **M** (Wave 1C).
- **Dependencies:** a migration for split lines and rules; a short new FPB.

### 2.8 Reporting and FP&A depth vs your partner portal

- **What exists:**
  - `/reports`: P&L and BS with prior-period / prior-year / budget comparisons and drill-down; TB; direct cash flow; AR/AP aging; exports; saved views and packs with email scheduling (0 used); an AI narrative panel.
  - `/fpna`: 16 KPI tiles, two hand-drawn charts, plan variance, NL scenarios.
  - Budgets with import, drivers and reforecast.
  - A 13-week cash forecast (AR/AP only).
  - A board package with an AI executive summary.
- **What's missing or broken:**
  - P&L by Department/Class are mislabelled plain P&Ls.
  - 1099 and Sales Tax summaries say "not yet implemented".
  - Generic tables stop at 200 rows on screen.
  - Indirect cash flow uses only the first company.
  - No charts in Reports.
  - No metric catalog with formulas.
  - No YoY/CAGR/EBITDA bridge/seasonality/working-capital days.
  - No league table across companies.
  - No budget versions, approvals, templates or department budgets.
  - No "books closed through" or restatement log.
  - No report builder.
- **The portal beats MeritBooks on 11 of its 14 parity items (M1–M7, M9–M12).** MeritBooks partly matches M8 (debt), M13 (budget) and M14 (design).
- **World class:** see §4. In short, one engine, ≥40 metrics, a chart kit with the portal's ChartCard contract, true consolidation, drill to the source document, cited AI commentary and governed release dates.
- **Effort:** **L** (Waves 3–4, about 10 slices).
- **Dependencies:** your decision on whether MeritBooks replaces the portal's financial reporting (X12), and whether cap table / waterfall live in Books.

### 2.9 Invoice customization, online payment links, and Stripe/Plaid "live"

You said: "I already have Stripe and Plaid set up, and your invoices didn't appear to allow customization or online payment links." This is what I verified today.

**Customization: what exists**
- Settings → **"Invoice Display"** tab (`settings/invoice-branding.tsx`). It is a legacy black/emerald screen inside the general Settings page, not in Invoices, which is why you didn't find it.
- Per company you get:
  - 5 PDF styles (Modern, Classic, Minimal, Bold, Compact);
  - accent colour, defaulting to **emerald `#10b981`**, which is off-brand;
  - logo upload;
  - remit-to, footer and default message.
- Text overrides by customer, job or invoice type (`components/invoice-text-overrides.tsx`).
- Payment methods by company, customer or job (`components/entity-invoice-settings.tsx`).
- **Live: 0 saved templates**, so every invoice uses the defaults.

**Customization: what's missing**
- **Columns and fields:** you can't hide or show columns (date, SKU, quantity, rate). There are no custom fields.
- **Templates:** there is one template per company, so you can't pick a template per customer or per invoice. Fonts are fixed (Helvetica/Times).
- **What prints:**
  - Customer PDFs **print your GL account number and name under each line** (`invoice-pdf.tsx:99`). This needs fixing before any real customer sees one.
  - The `terms_note` and `payment_instructions` text slots can be edited but are **never printed** (verified: no renderer uses them).
- **Attachments:** they don't go out with the invoice.
- **Email:**
  - There is no CC or multiple recipients (one address only).
  - The invoice email uses the banned fonts (Plus Jakarta Sans and JetBrains Mono).
  - There is no AIA G702/G703 format.

**Pay links: what exists**
- The emailed invoice has a **"Pay this invoice"** button linking to the hosted page `/pay/[token]`, which shows the company logo and colour and offers ACH and card through Stripe. The PDF is attached.
- Reminders, collections and the customer portal also carry the pay link.
- The invoice drawer has Send/Resend and a **"copy customer link"** button (`invoice-drawer.tsx:229`).

**Pay links: what's missing**
- No pay link or QR code on the **PDF**, so printed or mailed invoices can't be paid online.
- No pay-link panel or "paid online" status column in the invoice list.
- **Card is off by default** (`resolve-payment-methods.ts`: `DEFAULT_METHODS = ['CHECK','ACH']`).

**Stripe: why it isn't live**
- The code hard-codes the connection environment: `const ENV = 'test' as const; // sandbox until live keys are swapped in` (`api/payments/connect/route.ts:17`).
- The only live Stripe connection row is `AR_COLLECTION:stripe:environment=test` (verified in the DB).
- Vercel has `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET_CONNECT`. The values are encrypted, so whether they are live or test keys can't be told from here. Either way the app labels and looks up the connection as "test", and the connected account (`acct_1Tl…`) was created in test mode. It won't exist under a live key.
- **The Payments screen says "Connected — payments are live" whenever Stripe reports the account active, including in test mode** (`payments-connect.tsx`). That is probably why it looked set up to you.
- There is **one Stripe account per tenant.** `core.provider_connections` has no company column, and the pay endpoint takes the first active Stripe connection for the whole tenant. All companies' customer payments would land in one bank account.

**Plaid: why it isn't live**
- `PLAID_ENV` exists in Vercel (value encrypted).
- The only live Plaid connection row is `BANK_FEED:plaid:environment=test`, i.e. **sandbox** (`plaid-feed.ts:28-29` maps anything but `production` to sandbox).
- The newest bank transaction is 2026-06-10.
- Sync only runs when someone clicks; the scheduled job is a stub (`registry.ts:220`).

**What it takes for real customers to pay online:**
1. **You** put live Stripe keys and live webhook secrets in Vercel. Claude must not handle them.
2. Code change: derive test/live from the key and label it honestly on screen (Wave 1A).
3. Code change plus migration 175: **one Stripe account per company**. Each company finishes Stripe's onboarding with its own bank account.
4. Turn card on per company and decide who pays the 3%. Default: the customer, shown at checkout.
5. Set MeritBooks' fee for your own companies; I suggest $0.
6. Put the pay link and QR on the PDF; add a pay-link panel to the invoice drawer.
7. Run a $1 live payment and refund end to end, then confirm the GL entry.

**What it takes for Plaid to be live:**
1. Plaid production approval, plus OAuth registration for banks like Chase, Wells Fargo and BofA.
2. `PLAID_ENV=production` with the production secret.
3. Re-link every bank account.
4. Turn on the scheduled sync (Wave 2E).

**Effort:** M (Waves 1A + 1B).

---

## 3. Domain-by-domain gap register

**How to read the register**

Each row is one **canonical feature**, the de-duplicated unit described in Appendix §7.1.

- **"Intended (source IDs)"** gives a sample of the source IDs merged into the row:
  - `#n` = Mike's April feature-audit number;
  - `S-xxxx` = spec rows from A;
  - `C-xxxx` = rows from B, with the owner's own requests listed first;
  - the bracket gives the total number of A+B rows merged into the feature.
- **"Built"** uses the depth scale above. Evidence cites C or a check verified today.
- **Priority:** see the header.

**Domain roll-up**

| Domain | Canonical features | FULL | PARTIAL | STUB | MISSING | Open P0 gaps | Source rows |
|---|--:|--:|--:|--:|--:|--:|--:|
| BF Bank feed & categorization | 11 | 4 | 5 | 1 | 1 | 3 | 199 |
| GL GL, journal entries & COA | 15 | 5 | 8 | 1 | 1 | 1 | 197 |
| RC Receipts, receipt chase & Merit Workforce | 11 | 0 | 3 | 2 | 6 | 6 | 236 |
| AP AP, bills & payables email | 15 | 4 | 5 | 1 | 5 | 2 | 136 |
| VN Vendors & W-9 / COI chase | 11 | 3 | 5 | 0 | 3 | 4 | 245 |
| CK Check processing (print & mail) | 8 | 1 | 2 | 0 | 5 | 6 | 105 |
| PM Payments & money movement | 11 | 3 | 4 | 1 | 3 | 2 | 211 |
| AR AR, invoicing & collections | 16 | 3 | 9 | 2 | 2 | 4 | 273 |
| RR Revenue recognition, WIP & job costing | 13 | 5 | 5 | 1 | 2 | 3 | 235 |
| PR Payroll & commissions | 8 | 2 | 3 | 1 | 2 | 0 | 219 |
| EX Expenses | 8 | 2 | 3 | 0 | 3 | 0 | 134 |
| BR Bank reconciliation | 6 | 4 | 2 | 0 | 0 | 0 | 157 |
| CL Close & controls | 10 | 2 | 4 | 1 | 3 | 2 | 226 |
| SC Fixed assets, leases & schedules | 6 | 3 | 2 | 0 | 1 | 0 | 118 |
| DB Debt, equity & covenants | 7 | 2 | 4 | 1 | 0 | 0 | 137 |
| CO Consolidation & intercompany | 6 | 3 | 1 | 0 | 2 | 0 | 208 |
| TX Tax, 1099 & compliance | 6 | 2 | 3 | 0 | 1 | 0 | 162 |
| RP Reports | 21 | 4 | 9 | 2 | 6 | 9 | 626 |
| FP FP&A, budgets & cash forecasting | 21 | 1 | 7 | 0 | 13 | 7 | 490 |
| DS Role dashboards & team performance | 9 | 2 | 4 | 0 | 3 | 2 | 390 |
| PRC Practice management | 6 | 0 | 3 | 0 | 3 | 0 | 196 |
| AI AI agents & automation | 12 | 4 | 5 | 2 | 1 | 1 | 437 |
| OB Onboarding & migration | 11 | 1 | 5 | 1 | 4 | 2 | 541 |
| IN Integrations | 11 | 1 | 3 | 1 | 6 | 3 | 296 |
| PT Portals | 5 | 2 | 2 | 0 | 1 | 1 | 103 |
| RB Admin, RBAC & security | 10 | 2 | 7 | 0 | 1 | 1 | 633 |
| PL Platform, notifications & scheduler | 12 | 1 | 7 | 1 | 3 | 4 | 297 |
| UX Design, IA & navigation | 7 | 1 | 6 | 0 | 0 | 3 | 205 |
| DL Dealer pack | 3 | 2 | 1 | 0 | 0 | 0 | 200 |
| PJ Projects seam | 4 | 2 | 1 | 0 | 1 | 0 | 58 |
| **Total** | **300** | **71** | **128** | **19** | **82** | **66** | **7670** |

### BF — Bank feed & categorization

Source rows mapped here: 199 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| BF-01 | Split one bank/card transaction across accounts, dimensions, companies, jobs | S-0060; owner C-0001 (4 rows) | **MISSING** | `api/bank-feed/approve/route.ts:142-149` always builds 2 lines; no split table (C §7) | Split editor in edit panel; amounts must sum; per-line dims/company; IC pair when cross-company | P0 |
| BF-02 | Scheduled / incremental Plaid sync (daily pull) + stale-feed monitor | #74; S-0008, S-0063; C-0027, C-0047 … (7 rows) | **STUB** | `registry.ts:220` stub; pull is user-triggered; newest live txn 2026-06-10 (C §9) | Implement sync job + freshness monitor | P0 |
| BF-03 | Plaid connection (entity-first), account mapping, health | #73; S-0010, S-0012 …; C-0019, C-0026 … (17 rows) | **PARTIAL** | Link/exchange/map built; the only live connection row is `environment=test` (sandbox) | Plaid production access + OAuth institutions; re-link in production | P0 |
| BF-04 | Statement / file import (CSV, OFX/QFX, BAI2, CAMT) | #75, #81, #298; S-0065; C-0028, C-0029 … (8 rows) | **PARTIAL** | `api/bank-feed/import-statement`, `lib/bank/statement-parse.ts`; no OFX/BAI2 parser (grep) | OFX/QFX/BAI2/CAMT parsers; BAI2 type-code→GL map | P1 |
| BF-05 | AI categorization + vendor-pattern learning | #76; S-0001, S-0011 …; C-0011, C-0021 … (22 rows) | **FULL** | categorization service, learned vendor memory, `/categorize` | Live use near zero | — |
| BF-06 | Matching cascade, composite score (40/40/20), confidence routing, explainer | #77, #78, #160, #161, #163, #172 …; S-0002, S-0003 …; C-0002, C-0003 … (44 rows) | **FULL** | bank-feed confidence explainer; composite score | — | — |
| BF-07 | Review UX: confidence-sorted list, bars, badges, Approve/Flag/Edit, batch & vendor select, sorting, metrics strip, shortcuts, saved views, edit panel with recents | #162, #174; S-0006, S-0019 …; C-0005, C-0007 … (82 rows) | **FULL** | `bank-feed/*` ≈4.5k lines (C §9) | — | — |
| BF-08 | Flagged-items queue with AI note + inline resolve | S-0028, S-0030; C-0068, C-0091 (4 rows) | **FULL** | `/flagged` | — | — |
| BF-09 | Transfers, card-payment settlement, NSF/returns, fee & interest templates, double-count guard | S-0015, S-0016 …; C-0017, C-0024 … (26 rows) | **PARTIAL** | Double-count guard + settlement rules in posting engine; no NSF/return workflow found | NSF/return workflow; fee/interest templates in UI | P1 |
| BF-10 | Auto-approve rule (≥85%, trusted vendor, ≤$10k) under the autonomy dial | S-0004, S-0005 …; C-0016, C-0022 … (7 rows) | **PARTIAL** | Autonomy dials exist; auto-post OFF by default (canon) | Per-task enablement wired to bank feed with accuracy evidence | P1 |
| BF-11 | Credit-card feed: receipt status, personal-charge flag, shared-card split | S-0062; C-0040, C-0043 … (9 rows) | **PARTIAL** | `/credit-cards`; receipt badge is always 0 | Depends on RC-02..05 and BF-01 | P1 |

### GL — GL, journal entries & COA

Source rows mapped here: 197 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| GL-01 | Split lines on every document type (one shared split component) | S-0659; owner C-1605 (4 rows) | **PARTIAL** | Bills/JEs/invoices are multi-line; bank-feed and receipt splits missing (BF-01) | One split component reused by bank feed, receipts, card lines | P0 |
| GL-02 | Multi-dimensional GL, DB-enforced double entry, period lock, control accounts, posting engine | #1, #2, #6, #20, #22, #26; S-0403, S-0615 …; C-0282, C-1476 … (53 rows) | **FULL** | 6 integrity triggers; dims location/dept/class/item/job | — | — |
| GL-03 | Per-tenant COA template, tree, groups, sub-types, company-specific accounts | #3, #10, #23, #24, #25, #27; S-0608, S-0611 …; C-0076, C-1442 … (35 rows) | **FULL** | `/chart-of-accounts`; template is 137 accounts (spec 251) | 251 vs 137 accepted "for now" | — |
| GL-04 | COA request → approve → activate workflow | #8, #9, #21; S-0609, S-0635; C-1693, C-4605 … (8 rows) | **PARTIAL** | Request affordance in `chart-of-accounts/page.tsx`; no approver queue | Approver queue + activation audit | P2 |
| GL-05 | JE create/post, reversing, AI/NL composer | #4, #11, #12, #13, #14, #19 …; S-0618, S-0641 …; C-1615, C-1638 … (33 rows) | **FULL** | `/journal-entries`, `je-ai-composer.tsx` | — | — |
| GL-06 | JE approval workflow + required reason/attachment | S-0650, S-0668; C-1612, C-1616 … (13 rows) | **PARTIAL** | Approval engine (11e) wired to bills; JE approval is only a capability | Route manual JEs above materiality through approvals | P1 |
| GL-07 | Recurring JEs with reversal + catch-up | #183, #184, #185; S-0653, S-0654 …; C-0643, C-0709 … (17 rows) | **FULL** | `/recurring-journal-entries`; nightly propose job ran ok | Learned "make recurring?" missing | — |
| GL-08 | JE import from spreadsheet | owner C-1606 (3 rows) | **PARTIAL** | Import affordance in JE list; validation unverified | Template + dry-run + error report | P2 |
| GL-09 | Statistical accounts / journals | #7; C-1619, C-1670 (3 rows) | **MISSING** | No code (grep) | Statistical account type | P2 |
| GL-10 | Multi-book (tax/cash/accrual), alternate reporting COAs | #5, #18; C-1621, C-1622 … (7 rows) | **PARTIAL** | Cash/tax basis overlay + dual-book depreciation | Decide scope (contradiction 12) | P2 |
| GL-11 | Multi-currency | S-0374, S-0623 …; C-0884, C-1625 … (7 rows) | **STUB** | currency/fx_rate seam only | Deferred by canon | P2 |
| GL-12 | Field-level audit trail / JE timeline; edit-with-override | S-0610, S-0620; C-0288, C-1614 … (7 rows) | **PARTIAL** | audit_log + action_log; override with reason | Old→new field timeline UI | P1 |
| GL-13 | Anomalous-JE, cutoff, missed-accrual, duplicate detectors | S-0607, S-0645 …; C-0639, C-0762 … (21 rows) | **FULL** | `lib/controls/anomalous-je.ts`, `cutoff-errors.ts`, `missed-accruals.ts` | — | — |
| GL-14 | Opening balances, year-end close to RE, Period 13 | #15, #16; C-1669 (3 rows) | **PARTIAL** | Opening balances + YE close built; no Period 13 | Period 13 | P1 |
| GL-15 | Ask-the-ledger / semantic search / explain-this-account | S-0552, S-0651 … (7 rows) | **PARTIAL** | `/search`, `api/explain` | Semantic search, movement narration | P2 |

### RC — Receipts, receipt chase & Merit Workforce

Source rows mapped here: 236 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| RC-01 | Merit Workforce employee app (PWA): sign-in, employer branding, home | #400; S-0075, S-1350 …; owner C-0116, C-0117, C-0118, C-0191 … (24 rows) | **MISSING** | No `apps/workforce`, no PWA manifest (C §1) | PWA shell per FPB-workforce-app | P0 |
| RC-02 | Receipt capture: camera, upload, email-in, SMS-in | #289, #290, #393, #397; S-0074, S-0085 …; C-0123, C-0125 … (25 rows) | **MISSING** | `POST /api/receipts/submit` exists but nothing calls it; live receipts = 0 | Capture UI (web + Workforce), forwarding address, SMS reply | P0 |
| RC-03 | AI receipt extraction + pre-populated confirm screen | #166, #167, #168, #291, #394, #395 …; S-0073; C-3464, C-4589 (10 rows) | **PARTIAL** | `/receipts` categorizes existing rows; parsers reused from bills | Wire extraction to capture; confirm screen with purchase types | P0 |
| RC-04 | Receipt ↔ card-charge match (±$5/±3 days) + 3-way with bill | #292; S-0079, S-0083 …; C-0124, C-0229 … (10 rows) | **PARTIAL** | `api/expenses/lines/[lineId]/match-card` | Auto-match on capture; card-match notice | P1 |
| RC-05 | Receipt chase engine: request on card post, cadence, quiet hours, escalation, auto-approve threshold | #165, #293, #294, #296, #297, #353 …; S-0072, S-0076 …; owner C-0114, C-0115, C-0223 (103 rows) | **STUB** | Settings tab only (`settings-client.tsx:209-232`); sender `registry.ts:224` TODO | Shared request engine (PL-01) + cadence + escalation | P0 |
| RC-06 | Chase channels: push, SMS, email | #295; S-0078; C-0159, C-0160 … (9 rows) | **MISSING** | No SMS/push library (C §1) | SMS + push provider (owner decision) | P0 |
| RC-07 | Tenant / client chase on-off switch (audited) | owner C-0193, C-0212, C-0213 (4 rows) | **MISSING** | Planned `receipt_chase_enabled` not in schema | Migration + toggle | P1 |
| RC-08 | Card → cardholder assignment + contact data | #354; C-0120, C-0128 … (14 rows) | **STUB** | Legacy settings mention only | Assignment table + UI; employee phone/email | P0 |
| RC-09 | Workforce: clock in / out | S-1349, S-1353; C-0140, C-0195 … (11 rows) | **MISSING** | Projects time is office-side; punches not built | Punch model (Projects-owned) surfaced in Workforce | P1 |
| RC-10 | Workforce: pay stubs, commissions, reimbursements owed | C-0133, C-0136 … (7 rows) | **MISSING** | Payroll provider not live; commission engine has no screen | Capability-driven Pay tab | P1 |
| RC-11 | Receipt review queue, batch approve, leakage detection | #164, #169; S-0081, S-0082 …; C-0174, C-0186 … (16 rows) | **PARTIAL** | `/receipts`; EC-4 leakage detector | — | P1 |

### AP — AP, bills & payables email

Source rows mapped here: 136 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| AP-01 | Payables email import live (inbound webhook + parse → intake queue) | S-0103, S-0104 …; owner C-0296 (24 rows) | **PARTIAL** | Code built; `INBOUND_EMAIL_SECRET` unset, no MX/provider (C §6) | Provider + DNS + secret; end-to-end test | P0 |
| AP-02 | AP inbox address shown in the UI, per company | S-0123; owner C-0298 (7 rows) | **MISSING** | Address is per org and never shown (grep) | Per-company alias + "Forward bills to…" card | P0 |
| AP-03 | Connected mailbox ingestion (Gmail / Outlook OAuth, backfill) | owner C-0297, C-0320 (2 rows) | **MISSING** | No Gmail/Graph code | OAuth + poller | P1 |
| AP-04 | Bill entry + AI parse + dimensional lines + side-by-side review | #29, #45, #170, #171; S-0095, S-0098 …; C-0301, C-0304 … (34 rows) | **FULL** | `/bills`, `/bills/intake-queue`, `api/bills/parse` | — | — |
| AP-05 | Duplicate-at-intake + bill anomaly detection | #31; S-0101, S-0110 … (8 rows) | **FULL** | `lib/controls/bill-anomaly.ts` | — | — |
| AP-06 | Approval routing (N-step, AI policy), SLA nudges, delegation | #32, #33; S-0093, S-0099 …; C-0248 (8 rows) | **PARTIAL** | `/settings/approvals`, `/bills/policy`; delegation/SLA not found | Delegation + aging nudges | P1 |
| AP-07 | POs, goods receipts, 3-way match | #36, #44; S-0112, S-0117 …; C-0645, C-0674 … (15 rows) | **FULL** | `/purchase-orders`, `three-way-match.ts`; 0 POs | — | — |
| AP-08 | Requisitions, encumbrance vs budget, spend controls | #46, #47; S-0096, S-0134 … (12 rows) | **MISSING** | No requisition code (grep) | Requisition → PO; budget check | P2 |
| AP-09 | Recurring bills | #35; S-0139, S-0140 (3 rows) | **MISSING** | Only recurring invoices / JEs exist | Recurring bill templates | P1 |
| AP-10 | Vendor credits / debit memos / vendor refunds | #43; S-0097; C-0644, C-0710 (4 rows) | **MISSING** | Capability label only | Vendor credit object | P1 |
| AP-11 | Retainage on sub bills + lien waivers gated to payment | S-0144 (1 rows) | **PARTIAL** | Retainage built; no lien-waiver code | Lien-waiver doc + gate | P1 |
| AP-12 | Accruals: received-not-invoiced, recurring accrual drafts | S-0118, S-0119 (2 rows) | **PARTIAL** | EC-2 missed-accrual detector | Auto-draft accrual JEs | P1 |
| AP-13 | Pay-run proposal (scheduled agent), early-pay discounts | #34; S-0100, S-0102 …; C-0334, C-0660 (10 rows) | **STUB** | `registry.ts:226` stub; discount field only | Scheduled pay-run draft; discount capture | P1 |
| AP-14 | Subscription tracker, vendor-statement rec, spend analytics | #432; S-0094, S-0141 …; C-1453, C-3220 … (9 rows) | **PARTIAL** | `/subscriptions`; no vendor-statement rec | — | P2 |
| AP-15 | Job / cost-code attribution on bill lines | #30; S-0109, S-0129 …; C-0331, C-4381 … (15 rows) | **FULL** | Bill lines carry job; JOB_COST events | Cost-code depth limited | — |

### VN — Vendors & W-9 / COI chase

Source rows mapped here: 245 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| VN-01 | Chase sender: email/SMS with portal link on cadence (T-30/T-15/T-0, then weekly) | #244, #245; S-0184; owner C-0342, C-0383, C-0429, C-0437 (42 rows) | **MISSING** | `vendor-compliance.ts:313-345` schedules + counts only; sender TODO (C §2) | Shared request engine + Resend email (+ SMS opt-in) | P0 |
| VN-02 | Requirement model: what each vendor owes (type/state/job/client) | S-0168, S-0173 …; C-0349, C-0375 … (56 rows) | **MISSING** | B C-0383: "no requirement model" | Requirement rules | P0 |
| VN-03 | Submission review → accept/reject → VALID doc with expiry → hold lifts | C-0368, C-0449 … (12 rows) | **MISSING** | `api/vendor-portal/tokens` returns `reviewStatus:"PENDING"` hardcoded | Review queue | P0 |
| VN-04 | Vendor upload portal (magic link, phone-friendly), auto-sent | #247; C-0357, C-0362 … (14 rows) | **PARTIAL** | `app/portal/vendor/[token]/*` built; link only copied to clipboard | Auto-email link | P0 |
| VN-05 | Compliance tracking W-9 / GL COI / WC COI / WC exemption, expiry, badges | #243, #248; S-0169, S-0192; C-0346, C-0356 … (27 rows) | **FULL** | `vendor-compliance.ts`, `/vendor-compliance`; 0 docs live | — | — |
| VN-06 | Pay-time hold + overrides (one-time / temporary / permanent) with reason + audit | #249, #250; S-0171, S-0183 …; C-0350, C-0354 … (20 rows) | **FULL** | `enforcePaymentAllowed` in `recordBillPayment` | — | — |
| VN-07 | AI W-9 / COI parse | S-0193; C-0387, C-0419 … (10 rows) | **FULL** | `api/vendors/w9-parse`, `coi-parse` | — | — |
| VN-08 | Nightly scan + chase schedule | S-0170, S-0287; C-0345, C-0386 … (5 rows) | **PARTIAL** | `vendors.compliance_scan` ran 4× | Feeds VN-01 | — |
| VN-09 | Vendor directory, 360, AI defaults, dedupe/merge | #239, #240, #241, #242; S-0167, S-0172 …; owner C-0343 (60 rows) | **PARTIAL** | `/vendors`, `lib/vendors/dedupe.ts` | Merge UI | P1 |
| VN-10 | Bank-change (BEC) verification, OFAC screening, TIN match | S-0186, S-0188 …; C-0397, C-0453 … (6 rows) | **PARTIAL** | Payment-fraud detector flags bank changes; no OFAC/TIN match (grep) | OFAC + IRS TIN match | P1 |
| VN-11 | Org-level outreach (one doc covers all companies), sub pack | #246; S-0191; C-0347, C-0378 … (10 rows) | **PARTIAL** | Docs held at org-level vendor | Per-client overlays | P2 |

### CK — Check processing (print & mail)

Source rows mapped here: 105 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| CK-01 | Print checks on stock: MICR E-13B, signature, voucher stub, alignment test | C-0547, C-0553 … (8 rows) | **MISSING** | No MICR / check-stock code (C §3) | Check-stock PDF (top/middle/bottom), MICR font, signature, reprint/spoil | P0 |
| CK-02 | Mail checks through a print-and-mail provider | C-0545, C-0584 (2 rows) | **MISSING** | No integration | Provider adapter + tracking | P0 |
| CK-03 | Check-processor role, queue, discoverable nav (today: "Pay runs") | S-0202, S-0204; owner C-0542, C-0543, C-0552 (25 rows) | **PARTIAL** | Role key `payments_clerk`; `/checks` labelled "Pay runs" (`navigation.ts:76`) | Rename + check-processor home | P0 |
| CK-04 | Check numbering: sequence per bank account, gaps, spoiled/reprint | S-0205; C-0593, C-0613 … (4 rows) | **MISSING** | `check-numbers` route stores a reference only | Per-account sequence | P0 |
| CK-05 | Void / stop-payment → reverse JE, reopen bill, positive-pay void | C-0619, C-0620 … (3 rows) | **MISSING** | No void route (C §3) | Void flow | P0 |
| CK-06 | Check register (printed / cleared / void / stale) | S-0208, S-0211; C-0548, C-0555 … (9 rows) | **MISSING** | No register | Register + clearing from bank feed | P0 |
| CK-07 | Positive-pay file per bank + exception adjudication | #48; S-0201, S-0206 …; C-0544, C-0549 … (18 rows) | **PARTIAL** | CSV lacks check #/account # (`disbursement-export.ts:54-67`) | Bank formats + exceptions | P1 |
| CK-08 | Check run stepper, SoD release, remittance advice | #37, #200, #201, #202; S-0200, S-0203; C-0546, C-0556 … (37 rows) | **FULL** | `checks-client.tsx:330`, `api/ap/disbursements/release`, `remittance-pdf.tsx` | 0 live batches | — |

### PM — Payments & money movement

Source rows mapped here: 211 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| PM-01 | Live-mode cutover: live Stripe keys, platform entity, descriptor, live webhooks; Plaid production | S-0224, S-0234; C-1378 (3 rows) | **MISSING** | `api/payments/connect/route.ts:17` hardcodes `ENV = "test"`; both live provider rows are `environment=test` | Derive mode from key; reconnect live; TEST badge until then | P0 |
| PM-02 | Stripe Connect account per company (each company has its own bank) | S-0212, S-0223 …; C-0681, C-0704 … (6 rows) | **PARTIAL** | `core.provider_connections` has no `location_id`; pay intent takes the first active Stripe row for the org | Per-company connected accounts | P0 |
| PM-03 | Hosted Pay Now (ACH + card), surcharge cascade, fee transparency | S-0220, S-0222 …; owner C-0750 (9 rows) | **FULL** | `app/pay/[token]`, `api/pay/[token]/intent` (test mode) | Card off by default (`DEFAULT_METHODS`) | — |
| PM-04 | Payment → PAID → GL, idempotent, ACH processing state | #40; S-0216, S-0221 …; owner C-0734 (20 rows) | **FULL** | mig 064 unique indexes; Stripe webhook | — | — |
| PM-05 | Per-merchant fee schedule + admin UI | S-0254, S-0341; owner C-0744, C-0751 (19 rows) | **PARTIAL** | `lib/money/fees.ts` resolves schedule; no admin UI | Operator fee editor | P1 |
| PM-06 | ACH / wire disbursement on a live rail | #38; S-0228, S-0229 …; C-0636, C-0652 … (20 rows) | **STUB** | `lib/money/origination/sandbox.ts` only | Rail partner decision | P1 |
| PM-07 | Money SoD, release threshold, double-pay block, fraud screen | S-0213, S-0214 …; owner C-0630 (67 rows) | **FULL** | mig 174; `lib/controls/payment-fraud.ts` | — | — |
| PM-08 | Virtual card / card issuing / Ramp rails | #39; S-0218; C-0654, C-0708 … (6 rows) | **MISSING** | No code | Owner decision (Ramp) | P2 |
| PM-09 | Payment scheduling, early-pay optimization, settlement prediction | #41, #42, #82; S-0236, S-0241 …; C-0647, C-0655 … (22 rows) | **PARTIAL** | Check-run batches; no scheduler | — | P2 |
| PM-10 | Cross-entity bill pay (pay one company’s bills from another’s bank, with IC due-to/from) | C-0634, C-0706 (2 rows) | **MISSING** | Not found (grep) | Posting + UI | P1 |
| PM-11 | Vendor payment profiles, new-payee call-back verification, bank-change callout on run | S-0250; owner C-0631 (21 rows) | **PARTIAL** | Payment-fraud detector; profiles partial | Call-back workflow | P1 |

### AR — AR, invoicing & collections

Source rows mapped here: 273 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| AR-01 | Invoice customization: styles, logo, accent, remit-to, footer, message, text overrides | #53; S-0262, S-0263 …; C-0797, C-0887 … (11 rows) | **PARTIAL** | Settings → "Invoice Display" tab (`settings/invoice-branding.tsx`, legacy UI); 0 templates saved; default accent emerald `#10b981` | Template designer in merit-ui; per-customer template; brand defaults | P0 |
| AR-02 | Invoice document: terms & payment instructions printed, no GL codes shown to customer, Pay link + QR on PDF, custom fields, line columns | S-0348; C-0251, C-0872 … (8 rows) | **PARTIAL** | PDF prints `account_number · name` under each line (`invoice-pdf.tsx:99`); `terms_note`/`payment_instructions` slots never rendered; no pay link on PDF | Column config, custom fields, QR + URL, terms block | P0 |
| AR-03 | Send by email with Pay button + PDF; CC / multi-recipient; copy to self | S-0280, S-0282 …; C-0798, C-0829 … (21 rows) | **PARTIAL** | `lib/invoices/send-invoice.tsx` sends to one address; email template uses banned fonts | CC/BCC, multiple contacts, on-brand email | P0 |
| AR-04 | Pay link visible in invoice list/detail (copy, QR, resend, status) | S-0295; C-0906 (2 rows) | **PARTIAL** | Only a "Customer link copied" button (`invoice-drawer.tsx:229`) | Pay-link panel | P0 |
| AR-05 | View / open / bounce tracking + event timeline | S-0276, S-0278; C-0856, C-0897 … (10 rows) | **PARTIAL** | VIEWED on hosted page; no email open/bounce webhook | Resend webhook | P1 |
| AR-06 | Invoice creation: lines, dims, item catalog, PO, bill-to snapshot | #52, #62; S-0271, S-0277 …; C-0874, C-0881 … (14 rows) | **PARTIAL** | `/invoices` 3k lines; bill-to snapshot not written (FPB D1.3); no item catalog | Catalog + snapshot | P1 |
| AR-07 | Recurring invoices that auto-send | #54; S-0260, S-0269 …; C-0792, C-0799 … (12 rows) | **STUB** | `lib/invoices/recurring-invoices.ts`; cannot run unattended (`registry.ts:228`) | Enable job | P1 |
| AR-08 | Automated dunning ladder + late fees | #63; S-0259, S-0273 …; C-0443, C-0807 … (21 rows) | **STUB** | Dunning stub `registry.ts:230`; no late-fee code | Ladder + late-fee policy | P1 |
| AR-09 | Collections worklist, promise-to-pay, AI outreach drafts, DSO | #64; S-0275, S-0281 …; C-0805, C-0806 … (28 rows) | **FULL** | `/collections`, `lib/collections/promises.ts` | — | — |
| AR-10 | Cash application (AI), deposits/retainers, unapplied cash | #59; S-0265, S-0298 …; C-0802, C-0804 … (27 rows) | **FULL** | `/cash-application`, `/customer-deposits` | — | — |
| AR-11 | Credit memos, void/reissue, write-off, refunds, bad-debt allowance | #58; S-0258, S-0264 …; C-0796, C-0800 … (31 rows) | **PARTIAL** | Credit memo/void/write-off built; refunds only for deposits; no allowance method | Refunds + allowance | P1 |
| AR-12 | Customer statements + customer portal (auto-invited) | #61, #65; S-0297; C-0808, C-0919 (5 rows) | **PARTIAL** | `app/portal/customer/[token]`; link not emailed | Portal invite | P1 |
| AR-13 | Estimates → invoice | #55; S-0316; C-0801, C-0823 … (8 rows) | **FULL** | `/estimates`; 0 live | — | — |
| AR-14 | Progress / AIA billing (schedule of values, G702/G703) | S-0304; C-0879, C-0926 … (5 rows) | **MISSING** | Columns only; no SOV UI; G702 absent (grep) | SOV editor + AIA PDF | P1 |
| AR-15 | Credit limits/hold, lockbox/BAI2, disputes/deductions, sales receipts | #57; S-0266, S-0301 …; C-0803, C-0811 … (18 rows) | **MISSING** | credit_limit field only | — | P2 |
| AR-16 | Customer master, 360, import, dedupe | #60, #72; S-0255, S-0256 …; owner C-0795 (44 rows) | **PARTIAL** | `/customers` | Import + dedupe | P1 |

### RR — Revenue recognition, WIP & job costing

Source rows mapped here: 235 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| RR-01 | Visible election to accrue revenue / accrue AR for underbillings (company, job type, job) | owner C-0931, C-0932 (4 rows) | **PARTIAL** | Election = method choice in Settings → Revenue Recognition tab (`rev-rec-config.tsx`) + job override; owner could not find it; no "accrue" wording | Plain-English election card on company setup and /rev-rec | P0 |
| RR-02 | Company switch "auto-accrue underbillings at close"; close step proposes every period | S-0436; owner C-1011, C-1012 (7 rows) | **MISSING** | No company-level switch (C §5) | Switch + close task | P0 |
| RR-03 | Unbilled (1180) accrual preview / post / reverse | S-0387, S-0395 …; C-0942, C-0989 … (13 rows) | **FULL** | `lib/rev-rec/unbilled-accrual-service.ts`; /rev-rec Accrual tab | — | — |
| RR-04 | 9 rev-rec methods, resolution order, post the earned delta, 2410 deferral | #188, #190, #261; S-0379, S-0380 …; C-0935, C-0938 … (65 rows) | **FULL** | `lib/services/rev-rec.ts:38-40` | — | — |
| RR-05 | Scheduled monthly recognition run | #187; S-0326, S-0376 …; owner C-0934 (21 rows) | **STUB** | `revrec.monthly` never ran; propose-only | Enable + surface in close | P1 |
| RR-06 | WIP schedule with over/under billing, GL tie-out, post adjustment | #191, #256; S-0375, S-0378 …; C-0952, C-0967 … (19 rows) | **PARTIAL** | `/jobs/wip`; WIP screen does not post; tie-out not shown | Tie-out tile + post-from-WIP | P0 |
| RR-07 | Job setup, phases / cost codes, phase budgets, estimate vs actual, EAC | #253, #254, #265; S-0386, S-0412 …; C-0948, C-0957 … (21 rows) | **PARTIAL** | Jobs + EAC; cost-code depth limited (GATE 6) | Cost-code budget UI | P1 |
| RR-08 | Change orders, fade/gain, job profitability | #257, #259; S-0385, S-0399 …; C-0947, C-0950 … (19 rows) | **PARTIAL** | CO fields on job; job P&L; no fade analysis | CO log; fade report | P1 |
| RR-09 | Retainage receivable / payable | #260; S-0384, S-0437 …; C-0951, C-0953 … (15 rows) | **FULL** | `/retainage` | — | — |
| RR-10 | Job labor cost from payroll by hours (JOB_TIME) | #263 (1 rows) | **MISSING** | B C-1118: "JOB_TIME not built" | Allocation engine | P1 |
| RR-11 | ASC 606 contract parse / POB allocation | #186, #252; S-0404, S-0405 …; C-0946, C-0958 … (16 rows) | **PARTIAL** | `lib/invoices/contract-parse.ts` | POB allocation | P2 |
| RR-12 | Rev-rec reports (deferred roll-forward, waterfall, by method) | #189; S-0394, S-0424; C-0943, C-0988 … (11 rows) | **FULL** | `rev-rec-reports.tsx` | — | — |
| RR-13 | Projects seam (JOB_PROGRESS / JOB_COST); works without Projects | #56, #255, #258, #262, #264; S-0382, S-0400 …; C-0936, C-0975 … (23 rows) | **FULL** | task #22; mig 173 | — | — |

### PR — Payroll & commissions

Source rows mapped here: 219 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| PR-01 | Payroll register import → balanced GL post | #180; S-0459, S-0461 …; C-1069, C-1070 … (27 rows) | **FULL** | `/payroll` import + `payroll-posting.ts`; 0 runs live | — | — |
| PR-02 | Live payroll provider (Gusto first): run → post → remit → file | S-0460, S-0462 …; owner C-1062, C-1119, C-1128, C-1194 (61 rows) | **STUB** | Gusto adapter `TODO(gusto-sandbox)`; no keys; decision #32 | Owner decision + partner agreement | P1 |
| PR-03 | Commissions engine + statements | owner C-1063, C-1121, C-1130, C-1142 (30 rows) | **PARTIAL** | Engine (26 tests); no screen | Statements UI + earnings handoff | P1 |
| PR-04 | Labor → job / dept / class attribution | #182; S-0458, S-0476 …; owner C-1065, C-1118 (12 rows) | **PARTIAL** | Allocation edit in register import | Hours-based allocation (RR-10) | P1 |
| PR-05 | Payroll accrual at close; payroll in cash forecast; anomaly review | S-0470, S-0475 …; C-1111, C-1168 … (17 rows) | **MISSING** | Not found | Accrual JE + 13-week overlay | P1 |
| PR-06 | Employee self-service pay stubs (via Workforce) | S-0491, S-0494; owner C-1064 (16 rows) | **MISSING** | See RC-10 | — | P1 |
| PR-07 | Payroll release SoD; mock engine cannot release real payroll | S-0466, S-0468 …; C-0668, C-0690 … (42 rows) | **FULL** | `lib/payroll/providers/mock.ts:79-161` fails closed | — | — |
| PR-08 | Commission plan editor with live example, statements, clawbacks, reinstatement | C-1115, C-1146 … (23 rows) | **PARTIAL** | Engine only | Editor + statements | P1 |

### EX — Expenses

Source rows mapped here: 134 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| EX-01 | Expense reports build → submit → approve → reimburse | #299, #300, #305, #307; S-0496, S-0499 …; C-1243, C-1262 … (30 rows) | **FULL** | `/expenses`; 0 live | — | — |
| EX-02 | Expense policy upload → AI rules → simulate → publish → acknowledge | #301; S-0497, S-0504; owner C-1240, C-1270, C-1292 (40 rows) | **PARTIAL** | `/expenses/policy` compiler; upload/acknowledge partial | Upload, versions, acknowledgement | P1 |
| EX-03 | Mileage, per diem, cash advances | #304, #306; C-1244, C-1246 … (10 rows) | **PARTIAL** | Rules in policy schema; no claim entry or advances | Claim types | P2 |
| EX-04 | Org chart → approval chains | owner C-1242 (1 rows) | **MISSING** | Deferred | Org-chart import | P1 |
| EX-05 | Spend analytics (category / dept / employee) | #302, #308; S-0502, S-0509; C-1247, C-1254 … (7 rows) | **MISSING** | No code | Spend dashboard | P2 |
| EX-06 | Out-of-policy detector; reimbursement SoD | #303; S-0498, S-0501 …; C-0665, C-0691 … (9 rows) | **FULL** | `out-of-policy-expense.ts` | — | — |
| EX-07 | Policy depth: meals attendees, lodging caps, acknowledgement tracking, tools-over-$X via PO, scanned DOCX/PDF | S-0510; C-0172, C-1255 … (23 rows) | **PARTIAL** | Policy engine rules; acknowledgement missing | — | P1 |
| EX-08 | Corporate cards with live budgets/controls, cash-back posting, travel booking (Ramp territory) | S-0500, S-0512 …; C-1248, C-1249 … (16 rows) | **MISSING** | Not built | Ramp integration | P2 |

### BR — Bank reconciliation

Source rows mapped here: 157 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| BR-01 | Rec workspace: statement, check-off to $0, finalize/lock/undo, in-rec adjustments | #79, #85; S-0525, S-0526 …; C-1347, C-1358 … (43 rows) | **FULL** | `/reconciliation`, 10 tested services; 0 live recs | — | — |
| BR-02 | Autopilot matching, plug/stale detection, aging, AI memo/diagnosis | #80; S-0248, S-0362 …; C-1348, C-1349 … (62 rows) | **FULL** | `lib/services/reconciliation-*` | — | — |
| BR-03 | Statement import (CSV / OFX / PDF OCR) | S-0517, S-0523 …; C-1366, C-1376 … (11 rows) | **PARTIAL** | CSV import; OFX none; PDF OCR unverified | OFX + PDF | P1 |
| BR-04 | Rec report PDF + history | #84; S-0521, S-0532 …; C-1351, C-1354 … (11 rows) | **FULL** | history tab | — | — |
| BR-05 | Rec-required close gate | S-0533; C-1355, C-1364 … (13 rows) | **FULL** | reconciliation close-gate service | — | — |
| BR-06 | Every balance-sheet account reconciled; bank↔GL↔subledger tie | S-0542, S-0543 …; C-1386, C-1425 … (7 rows) | **PARTIAL** | Cash-focused | Non-cash BS rec | P1 |

### CL — Close & controls

Source rows mapped here: 226 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| CL-01 | Close orchestration grid, phases, auto-verified tasks, close-status board | #121, #122, #123, #124, #125, #126 …; S-0567, S-0568 …; C-1467, C-1479 … (34 rows) | **FULL** | `/close`, `/close-status`; `close_checklists` = 0 | — | — |
| CL-02 | Close checklist templates per entity, assignment, dependencies | #141; S-0555, S-0561 …; C-1468, C-1491 … (16 rows) | **MISSING** | No template code (grep) | Template library | P1 |
| CL-03 | Period Close Gate (all checks) + manager override | #146; S-0583, S-0586 …; C-1357, C-1363 … (21 rows) | **PARTIAL** | Rec gate exists; full gate composition partial | Gate + override reason | P0 |
| CL-04 | Working papers: preparer/reviewer sign-off, tickmarks, auto tie-out | #136, #137, #138, #142; S-0554, S-0589 …; C-1471, C-1487 … (11 rows) | **MISSING** | No working-paper code (grep) | Working-paper module | P1 |
| CL-05 | Flux / variance analysis with materiality + required explanations before sign-off | S-0587, S-0599; C-1600, C-3774 … (6 rows) | **MISSING** | AI narrative only (`narrative-panel.tsx`) | Flux table + explanation gate | P0 |
| CL-06 | Period locks, year-end close, controlled reopen | #139, #140, #143, #144, #145; S-0557, S-0562 …; C-1460, C-1464 … (38 rows) | **PARTIAL** | DB lock; YE close; reopen in periods grid | Reopen approval/alarm | — |
| CL-07 | Exception detectors (EC-1/2/3/4/10/12/14, payment fraud, nexus) + /controls | S-0556, S-0559 …; C-1477, C-1478 … (57 rows) | **FULL** | `lib/controls/*` (13 detectors), `controls.nightly` ran ok | — | — |
| CL-08 | Scheduled period engine (depreciation, amortization, accruals) + autonomous close agent | S-0558, S-0560 …; C-1465, C-1470 … (12 rows) | **STUB** | `registry.ts:232` stub; close-run recipe on-demand only | Enable | P1 |
| CL-09 | Close analytics (days to close, slip alerts), review notes | S-0573, S-0579 …; C-1469 (9 rows) | **PARTIAL** | Close on-time % on /team | Trend + review notes | P2 |
| CL-10 | PBC / auditor access / evidence packaging | S-0578, S-0601; C-1480, C-1482 … (9 rows) | **PARTIAL** | `/pbc`, `api/audit-access`; 0 live | Evidence binder | P2 |

### SC — Fixed assets, leases & schedules

Source rows mapped here: 118 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| SC-01 | Fixed-asset register, depreciation methods, disposal, roll-forward | #192, #193, #194, #195, #196, #197 …; S-0070, S-0676 …; C-1381, C-1700 … (46 rows) | **FULL** | `/fixed-assets`; 5 live assets | — | — |
| SC-02 | Dual-book tax depreciation, §179 / bonus | S-0697; C-1745 (2 rows) | **FULL** | `/tax-depreciation` | Election presenter | — |
| SC-03 | Leases ASC 842, prepaids, insurance, intangibles schedule engine | #317; S-0657, S-0678 …; C-1702, C-1707 … (41 rows) | **FULL** | pages + AI parse; 0 leases | — | — |
| SC-04 | Capex classifier, auto-create asset, capitalization threshold | S-0682, S-0683 …; C-1717 (10 rows) | **PARTIAL** | Cap-threshold defaults | Classifier on bill lines | P2 |
| SC-05 | Physical asset tracking (barcode, check-in/out, maintenance) — Asset Panda replacement | #309, #310, #311, #312, #313, #314 …; S-0694, S-0700; C-1706 (18 rows) | **MISSING** | Never scheduled (A: orphaned) | Defer / separate module | P2 |
| SC-06 | Scheduled depreciation / amortization runs | S-0702, S-0704 …; C-4332 (4 rows) | **PARTIAL** | `prepaid.amortize` registered; period engine stub | Enable | P1 |

### DB — Debt, equity & covenants

Source rows mapped here: 137 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| DB-01 | Debt register, AI loan parse (multi-loan, drag-drop, 15 MB), amortization, P&I split | #208; S-0720, S-0723 …; owner C-1752, C-1753, C-1754 (29 rows) | **FULL** | `/debt`: 3 instruments, 72 schedule lines live | Owner reported failures on 9/7 (marked fixed); re-verify in browser | — |
| DB-02 | Covenants from loan doc, computed from GL, headroom, breach forecast, certificate | S-0721, S-0722 …; owner C-1750, C-1751, C-1755 (69 rows) | **PARTIAL** | `/covenants` with headroom; 1 covenant, 0 measurements; no breach projection | Measurement job + projection | P1 |
| DB-03 | Borrowing-base certificate | #431; S-0729; C-1774, C-1790 … (8 rows) | **FULL** | `/borrowing-base` | — | — |
| DB-04 | Lender packs auto-sent on schedule | S-0737; C-1809, C-3574 (3 rows) | **STUB** | `registry.ts:234` | Enable | P1 |
| DB-05 | Equity register / cap table / contributions & distributions | #209; S-0724, S-0731 …; C-1644, C-5262 (8 rows) | **PARTIAL** | Equity import in onboarding; generic equity report | Equity register UI | P1 |
| DB-06 | Debt dashboard: outstanding, undrawn, weighted rate, maturity ladder, coming due | S-0730, S-0738; C-1734, C-1816 … (5 rows) | **PARTIAL** | `debt-summary.tsx`; no maturity ladder (grep) | Portal-parity tiles | P1 |
| DB-07 | Lenders configurable in setup | owner C-1756 (15 rows) | **PARTIAL** | Dealer lender section; general lender master partial | — | P2 |

### CO — Consolidation & intercompany

Source rows mapped here: 208 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| CO-01 | Consolidation engine: ownership %, NCI, FX, eliminations | S-0752, S-0753 …; owner C-1861 (94 rows) | **FULL** | `/consolidation` | — | — |
| CO-02 | Any client as consolidator; permission-gated roll-up; consolidation groups | S-0761, S-0762 …; owner C-1862, C-1886, C-1887 (38 rows) | **PARTIAL** | Location hierarchy; gating partial (S47 admin-only) | Group builder + permission | P1 |
| CO-03 | Intercompany due-to/from, matching, mirror drafts, EC-3 imbalance | #17, #66, #203, #204, #205, #206 …; S-0257, S-0612 …; C-1866, C-1870 … (45 rows) | **FULL** | `/intercompany`, `intercompany-balance.ts` | — | — |
| CO-04 | Inter-department internal invoices with elimination | S-0648, S-0745 …; C-1872, C-1878 … (20 rows) | **FULL** | `/internal-invoices` | — | — |
| CO-05 | Intercompany loans: AI promissory note, e-sign, 3-tier approval, P&I both sides | S-0744; C-1978 (2 rows) | **MISSING** | No e-sign code | Loan workflow + e-sign provider | P2 |
| CO-06 | Management-fee allocations, cash pooling / netting | S-0773; C-0817, C-0863 … (7 rows) | **MISSING** | Not found | — | P2 |

### TX — Tax, 1099 & compliance

Source rows mapped here: 162 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| TX-01 | 1099 tracking: dated thresholds, box classification, W-9 status, cross-entity | #49, #251; S-0796, S-0797 …; owner C-2017, C-2084 (32 rows) | **FULL** | `/compliance-1099`; `get1099Thresholds` | — | — |
| TX-02 | 1099 e-file (IRIS transmission), recipient delivery, TIN match | S-0798, S-0818 …; C-2018, C-2037 … (17 rows) | **PARTIAL** | FIRE file generation only | IRIS + TIN match | P1 |
| TX-03 | Sales tax: rates, posting, return prep, calendar, nexus tripwire | S-0793, S-0794 …; C-2019, C-2021 … (43 rows) | **PARTIAL** | `/sales-tax-return`, `/sales-tax-calendar`, nexus detector; 0 rates configured | Rate engine or table | P1 |
| TX-04 | Book-to-tax M-1, ASC 740 provision, tax package, MACRS | S-0792, S-0803 …; C-2027, C-2028 … (25 rows) | **FULL** | `/book-to-tax`, `/tax-provision`, `/tax-package` | — | — |
| TX-05 | Compliance dashboard (entity × obligation), filing archive, calendar, good standing | #50, #147, #148, #149, #150, #151 …; S-0237, S-0788 …; C-1725, C-1727 … (37 rows) | **PARTIAL** | `/compliance`, `/obligations`; metrics/archive partial | Archive + penalty exposure | P1 |
| TX-06 | Estimated payments, K-1, PTET, credits, apportionment | S-0791, S-0824 …; C-2031, C-2032 (12 rows) | **MISSING** | Not found | — | P2 |

### RP — Reports

Source rows mapped here: 626 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| RP-01 | Shared report engine: period/compare engine, dimension engine, row layouts, universal drill | C-0922, C-1450 … (18 rows) | **MISSING** | Each report is a bespoke renderer or the `GenericReport` table (C §8a) | Report-definition engine (E §3) | P0 |
| RP-02 | P&L and balance sheet with comparatives (PP, PY, budget) and drill | #28, #91, #92, #94, #95, #96 …; S-0850, S-0851 …; C-2115, C-2127 … (46 rows) | **FULL** | `report-viewer.tsx`; drill on P&L/BS | — | — |
| RP-03 | P&L by department / class / location / job (dimension columns) | #86, #89, #90; S-0841, S-0858 …; C-2151, C-2177 … (43 rows) | **STUB** | Renders plain P&L (`report-viewer.tsx:737-739`) | Real dimension columns | P0 |
| RP-04 | Multi-period: months, quarters, years, TTM, YTD/QTD, common-size % | #87, #93; S-0871; owner C-2485 (21 rows) | **PARTIAL** | 12-column P&L by month only | Period engine | P0 |
| RP-05 | Multi-entity columns + consolidated with eliminations column | #105; S-0855, S-0865 …; C-1975, C-2355 … (15 rows) | **PARTIAL** | Consolidated report is a generic table; detail in `/consolidation` | Entity columns → elims → consolidated | P0 |
| RP-06 | Cash flow: indirect (multi-entity) and direct | #98, #99; S-0852, S-0893 …; C-2143, C-2211 … (9 rows) | **PARTIAL** | Indirect uses the first selected entity only | Fix multi-entity | P0 |
| RP-07 | GL detail / transaction list without on-screen truncation | #102, #103, #104, #115; S-0854, S-0877; C-2128, C-2187 … (12 rows) | **PARTIAL** | `rows.slice(0,200)` in `GenericReport` | Paginate / virtualize | P0 |
| RP-08 | Budget vs actual (versioned, dimensional, drill, favourability) | #113; S-0857; C-2498, C-2551 … (10 rows) | **PARTIAL** | Generic table | BvA renderer | P0 |
| RP-09 | AR/AP aging, balances, open items, sales/expense by customer/vendor | #69, #70, #71, #88, #111; S-0864, S-0883 …; C-2119, C-2123 … (53 rows) | **PARTIAL** | Aging FULL; the rest generic tables | Purpose renderers | P1 |
| RP-10 | 1099 Summary and Sales Tax Summary in the catalog | C-2280, C-2306 … (5 rows) | **STUB** | "Report not yet implemented" (`report-viewer.tsx:765-781`) | Wire or remove | P0 |
| RP-11 | Equity changes, debt schedule, TB worksheet (adj/unadj), job/WIP, rec reports | #101, #106, #112; S-0853, S-0895 …; C-2139, C-2214 … (21 rows) | **PARTIAL** | Generic tables; TB has no AJE columns | Purpose renderers | P1 |
| RP-12 | Charts in reports + ChartCard contract (table / CSV / xlsx / summary sentence) | S-0876, S-0881 …; owner C-2108, C-2109 (30 rows) | **MISSING** | "No charts in /reports" (C §8a) | Chart kit | P0 |
| RP-13 | Custom report builder; NL → saved report definition | S-0867, S-0878 …; C-2134, C-2135 … (18 rows) | **MISSING** | No builder (grep); NL query API exists | Builder on the engine | P1 |
| RP-14 | Export PDF/XLSX/CSV; saved views; packs with scheduled delivery | #114, #118, #119, #288; S-0888, S-0889; C-2116, C-2117 … (87 rows) | **FULL** | `api/reports/export/*`, `report-compiler.tsx`; 0 packs/views live | — | — |
| RP-15 | AI narrative, insights, board package | #117, #120, #287; S-0859, S-0860 …; C-2111, C-2121 … (56 rows) | **PARTIAL** | `narrative-panel.tsx`; `/board-package` AI summary | Cited, approval-gated commentary | P1 |
| RP-16 | Cash / accrual / tax basis toggle | S-0862, S-0872 …; C-2150, C-2180 … (13 rows) | **FULL** | P&L/BS/TB overlay | Other reports lack it | — |
| RP-17 | Annotations, publish approval, governance (closed-through, restatements, draft watermark) | S-0916, S-0928 …; C-2297, C-2448 … (6 rows) | **MISSING** | Not found | Governance layer | P1 |
| RP-18 | Industry benchmarks | S-0880, S-0922; C-2338, C-2350 … (14 rows) | **MISSING** | No code | Data-source decision | P2 |
| RP-19 | Report center UX: categories, period presets, entity multi-select, summary/detail, drill | #67, #68, #100, #107, #108, #109 …; S-0869, S-0873 …; C-0156, C-2114 … (68 rows) | **FULL** | `report-viewer.tsx:135-180` | — | — |
| RP-20 | Report library organized by question shelves (≈175 reports) incl. management reports (flash, weekly operating, PVM bridge) | C-2110, C-2120 … (64 rows) | **MISSING** | IA spec only | Build on RP-01 engine | P1 |
| RP-21 | Report trust details: period-final footer, CF ties to BS cash, fiscal-calendar comparatives, client branding, side-by-side compare | S-0377, S-0524 …; C-1345, C-1904 … (35 rows) | **PARTIAL** | Some tie-outs exist; footer/branding not found | — | P1 |

### FP — FP&A, budgets & cash forecasting

Source rows mapped here: 490 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| FP-01 | Metric registry (≥37 cards with formula, period chip, semantic delta, sparkline, unavailable states) | C-2734, C-2757 … (17 rows) | **MISSING** | `/fpna` has 16 tiles, layout saved client-side; no formulas/unavailable states (D §3) | Typed metric registry (portal M1) | P0 |
| FP-02 | Chart kit: MonthlyCombo (PY dashed, budget ticks, TTM, hatched preliminary), waterfall, scatter | owner C-2774 (6 rows) | **MISSING** | Hand-drawn inline SVG; no chart system (D §3) | merit-ui chart kit (portal M3/M7) | P0 |
| FP-03 | Analytics: YoY, CAGR, EBITDA bridge, margins, seasonality, WC days/CCC, revenue/employee, Rule of 40 | #215, #277; S-0935, S-0959 …; C-1305, C-2869 … (12 rows) | **MISSING** | No CAGR / Rule-of-40 code (grep) | Analytics library (portal M4) | P0 |
| FP-04 | Scope views: client / multi-select / consolidated / ownership-weighted; league table; share bars | S-0939, S-0941; C-1423, C-1440 … (11 rows) | **PARTIAL** | `/profitability` ranked NI; `/portfolio` RAG | Scope model (portal M5, X1) | P0 |
| FP-05 | Budget entry grid, import CSV/XLSX, copy prior year, BvA | #266, #269, #285; S-0945, S-0948 …; owner C-2613, C-2775, C-2801, C-2802 … (44 rows) | **FULL** | `/budgets`; 12 live rows | — | — |
| FP-06 | Budget versions + approval (draft → approved → superseded) | #272; S-0962, S-0983 …; C-2630, C-2708 … (24 rows) | **MISSING** | 0 `budget_versions`; no workflow (C §8b) | Versioning + approval | P0 |
| FP-07 | Budget templates (system / tenant / client), editor, recommended set | #270; S-0988; owner C-2614, C-2615, C-2776, C-2807 … (41 rows) | **MISSING** | No template code (grep) | Template library | P1 |
| FP-08 | Department budgets: owners, submit/review/approve, monthly BvA push | #267, #268, #271; S-0942, S-0944 …; owner C-2611, C-2616, C-2777, C-2813 … (54 rows) | **MISSING** | No dept-head workflow; FP&A push stub `registry.ts:242` | Workflow + push | P1 |
| FP-09 | Driver-based budget, reforecast, rolling forecast | #273, #274, #275, #278; S-0938, S-0949 …; C-2626, C-2627 … (56 rows) | **PARTIAL** | `/budgets/drivers`, `/budgets/reforecast`, `/forecast` | Auto-roll each close | P1 |
| FP-10 | Three-statement forecast; scenarios (base/up/down, NL what-if, sensitivity, Monte-Carlo) | #217, #218, #219, #276, #279, #280 …; S-0936, S-0951 …; C-2621, C-2622 … (53 rows) | **PARTIAL** | NL scenario bar + scenario modeler; no 3-statement (grep) | 3-way model | P1 |
| FP-11 | 13-week cash forecast with payroll/recurring/debt/tax overlays, AI pay dates, accuracy | #213, #214, #216, #220; S-0937, S-0954 …; C-2620, C-2623 … (31 rows) | **PARTIAL** | `lib/cash/forecast.ts` uses AR/AP only (C §8b) | Overlays + scenarios + accuracy | P0 |
| FP-12 | Daily cash position across entities + minimum-cash alerts | #83, #210, #211, #212; S-0931, S-0932 …; C-2656, C-2665 … (19 rows) | **PARTIAL** | `/cash` dashboard | Min-cash alerts | P1 |
| FP-13 | Headcount / workforce planning | #283, #284; S-0943, S-0972 …; C-2632, C-2651 … (14 rows) | **MISSING** | Only scenario text | Roster plan | P1 |
| FP-14 | Board / investor / partner packet (frozen, per-company summary, PDF) | S-0950; owner C-2612 (5 rows) | **PARTIAL** | `/board-package` (one chart, no BvA section) | Portal-parity packet (M12) | P1 |
| FP-15 | Number governance: books-closed-through, release cutoff, restatements, freshness, deadlines | S-0985, S-1004; C-2821 (3 rows) | **MISSING** | Not found | Portal M11 / X6 | P0 |
| FP-16 | AI CFO: proactive insights, FP&A copilot, forecast narrative | S-0952, S-0953 …; C-2633, C-2653 … (15 rows) | **PARTIAL** | NL scenario; narratives; proactive agent stub | Proactive feed | P1 |
| FP-17 | Capex budgeting, encumbrance-aware consumption, over-budget alerts | S-0975, S-0976; C-2617, C-2694 … (9 rows) | **MISSING** | Not found | — | P2 |
| FP-18 | Cap table, waterfall calculator, holdings org chart (portal M9/M10) | S-1005 (1 rows) | **MISSING** | Not in Books (Suite governance) | Decide Books vs Suite | P2 |
| FP-19 | Vertical KPI packs (HVAC service & agreements, cabinets/millwork, construction scorecard, dealer) | S-0933; C-2722, C-2723 … (24 rows) | **MISSING** | Not built (E §2.E/F) | Pack definitions on metric registry | P1 |
| FP-20 | Revenue forecast from payment patterns, committed layer (signed jobs, POs, agreements), pipeline | S-0940, S-0969 …; C-2637, C-2702 … (9 rows) | **MISSING** | Not found | — | P2 |
| FP-21 | Budget collaboration: threaded comments/@mention, justification requests, CFO review on biggest gap, tie-out footer | S-0947, S-0957 …; C-2618, C-2629 … (48 rows) | **MISSING** | Not found | — | P1 |

### DS — Role dashboards & team performance

Source rows mapped here: 390 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| DS-01 | Team performance scorecard (throughput, $, latency, rework, overrides, composite, close on-time) | #336, #337, #338, #339, #340, #341; S-1016, S-1022 …; owner C-3218 (46 rows) | **FULL** | `lib/team-performance/compute.ts` (473 lines), `team/performance-panel.tsx` (1046); 11 action_log rows | Real data; findability (DS-03) | — |
| DS-02 | Performance targets/weights UI, status badges, period presets | #342, #343; S-1052, S-1055; C-3002, C-3087 … (22 rows) | **PARTIAL** | Config table exists, no UI (C §4) | Config screen | P1 |
| DS-03 | Accounting-manager home that leads with team performance | S-1023, S-1042; owner C-2985, C-2986 (14 rows) | **PARTIAL** | Performance is a tab inside "Team & access" (`navigation.ts:178`) | AM cockpit home | P0 |
| DS-04 | Queue aging / backlog per bookkeeper; capacity & workload | S-1030, S-1034 …; C-3078, C-3171 … (12 rows) | **MISSING** | Client-level aging only (`api/client-health`); 0 practice_assignments | Per-person attribution | P1 |
| DS-05 | Coaching, anti-gaming, AI performance summaries | S-1032, S-1033 …; C-1418, C-3181 … (15 rows) | **MISSING** | Not found | — | P2 |
| DS-06 | Role homes per tier via widget registry | #116, #153, #154, #155, #156, #157 …; S-1018, S-1019 …; owner C-2989, C-2990, C-2991, C-3027 (198 rows) | **PARTIAL** | R1 shell; IA §5.6 127-widget registry not built | Role homes | P0 |
| DS-07 | Admin arranges and locks per-role layouts (server-persisted) | owner C-2992, C-3028 (31 rows) | **MISSING** | FP&A layout persisted client-side only | Layout store | P1 |
| DS-08 | Ranked action inbox / unified exception queue | S-1021, S-1024 …; C-2997, C-2999 … (33 rows) | **FULL** | `/inbox`, Exceptions | — | — |
| DS-09 | Legacy dashboard metrics (TTM revenue, pending review, EBITDA, volume chart, activity feed) | #159; S-1015, S-1020 …; owner C-3156 (10 rows) | **PARTIAL** | `/dashboard` | Fold into role homes | P2 |

### PRC — Practice management

Source rows mapped here: 196 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| PRC-01 | Tenant types, clients, staff ↔ client assignments, delegation | #327, #329, #333, #334; S-1058, S-1059 …; owner C-3316, C-3317 (85 rows) | **PARTIAL** | `core.practice_assignments` (mig 102) on /portfolio; 0 rows | Assignment grid | P1 |
| PRC-02 | Firm cockpit: close & health across all clients | #324; S-1067, S-1068 …; C-3334, C-3345 … (18 rows) | **PARTIAL** | `/operations`, `/close-status` | Unified firm home | P1 |
| PRC-03 | Client questions / document requests ("waiting-on") | #326; C-3328, C-3330 … (14 rows) | **MISSING** | PBC only for auditors | Client request lists | P1 |
| PRC-04 | Tasks, workflow templates, playbooks | #330, #332, #335; S-1069, S-1076 …; C-3324, C-3357 … (23 rows) | **PARTIAL** | Close tasks only | — | P2 |
| PRC-05 | Utilization, realization, client profitability, time | S-1071, S-1073 …; C-3319, C-3321 … (38 rows) | **MISSING** | Not found | — | P2 |
| PRC-06 | Client portal (branded sharing), engagement letters, chat/email | #328, #331; S-1056, S-1057 …; C-3397, C-3412 (9 rows) | **MISSING** | Not found | — | P2 |

### AI — AI agents & automation

Source rows mapped here: 437 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| AI-01 | Decision log & explainability | S-1095, S-1110 …; C-3470, C-3520 … (15 rows) | **FULL** | `/ai-decisions` (111 rows) | — | — |
| AI-02 | Autonomy dials, kill switch, auto-post off by default, SoD on AI | S-1107, S-1108 …; C-3471, C-3491 … (37 rows) | **FULL** | `/settings/autonomy` | — | — |
| AI-03 | Agent runner (6 recipes) — scheduled, not only on demand | S-1131, S-1141 …; C-3474, C-3482 … (37 rows) | **PARTIAL** | `lib/agents/runner.ts`; scheduled jobs are stubs | Schedule recipes | P1 |
| AI-04 | NL command bar (⌘K) with 3-lane routing | S-1115, S-1116 …; owner C-3624, C-3625 (50 rows) | **PARTIAL** | `components/nl/command-bar.tsx` mounted | Routing lanes, coverage | P1 |
| AI-05 | Learning loop, learned preferences, shared memory | #367; S-1114, S-1118 …; C-3118, C-3483 … (18 rows) | **FULL** | learned prefs, vendor memory | Cross-tenant benchmarks missing | — |
| AI-06 | AI gateway metering, usage dashboard, tenant budgets | #356, #368; S-1102, S-1122 …; C-3476, C-3489 … (27 rows) | **PARTIAL** | `api/ai/usage`, operator dashboard | Tenant caps | P1 |
| AI-07 | Proactive CFO feed, watch rules, digests | S-1117; C-3473, C-3486 … (8 rows) | **STUB** | `registry.ts:240` stub | Digest + alerts | P1 |
| AI-08 | CPA Desk advisor, explain-this-X, document-to-everything ingestion | #357, #358, #359, #360, #361, #420; S-1094, S-1096 …; C-0126, C-3468 … (50 rows) | **PARTIAL** | `api/explain`; per-type document parsers | Unified ingestion | P2 |
| AI-09 | System Console, suggest-a-feature, AI eval suite | #362, #363, #364, #365, #366; S-1099, S-1119 …; C-3472, C-3475 … (61 rows) | **MISSING** | Not found | Eval suite first | P2 |
| AI-10 | Scheduled automations from Build Spec §19 (hourly email sync, daily categorization, monthly rev rec, continuous receipt chase, daily vendor check) | #419, #422, #424, #425; C-3705 (5 rows) | **STUB** | Each maps to a stub or missing job in `registry.ts:218-242` | Implement jobs | P0 |
| AI-11 | NL copilot governance: citations on every figure, abstention, propose-action, reversible proposals | S-1104, S-1133 …; C-1384, C-1387 … (59 rows) | **PARTIAL** | `api/nl/*`; citation assembler/abstention per FPB-nl-copilot not verified | Complete per FPB | P1 |
| AI-12 | Exception engine discipline (tier = f(confidence, $, risk), remediation via posting engine, determinism, dedupe) | S-1113, S-1124 …; owner C-3463, C-3467, C-3499 (52 rows) | **FULL** | `lib/controls/*` tests | — | — |

### OB — Onboarding & migration

Source rows mapped here: 541 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| OB-01 | Onboarding wizard: smart intake, readiness, tour, control-tower stages | #369, #370, #371, #372, #373, #375 …; S-1175, S-1176 …; owner C-3801, C-3806, C-3807, C-3815 … (123 rows) | **PARTIAL** | `/onboarding` 3.4k-line wizard; task #11 in progress | Finish onboarding spec | P0 |
| OB-02 | QuickBooks import (OAuth) with production keys | S-1202; C-3889, C-4066 … (11 rows) | **STUB** | No QBO keys in Vercel | Keys + Intuit prod approval | P0 |
| OB-03 | Other ERP/accounting imports (Sage, Xero, field ERPs) + guided-export recipes | S-1207, S-1212 …; C-3823, C-3831 … (11 rows) | **MISSING** | Catalog entries `PLANNED`, `authorizeUrl:null` | Recipes for every named system | P1 |
| OB-04 | Opening balances, conversion, TB tie-out gate, COA remap | S-1180, S-1187 …; C-3819, C-3820 … (67 rows) | **FULL** | `/onboarding/reconciliation`, conversion | — | — |
| OB-05 | Owner intake list: corporate docs, loans, WIP, GL, customers/CRM, budgets, expense policies, org chart | S-1185; owner C-3802, C-3803, C-3804, C-3873 … (19 rows) | **PARTIAL** | Formation, loan, WIP intake partial; CRM / org chart missing | Close each intake card | P1 |
| OB-06 | Email mailbox linking at onboarding | S-1190; C-3997, C-4147 (3 rows) | **MISSING** | See AP-03 | — | P1 |
| OB-07 | Bank connection, team invites, policies during onboarding | #382; S-0411, S-1051 …; C-0971, C-1847 … (37 rows) | **PARTIAL** | Plaid sandbox; invites | — | P1 |
| OB-08 | Golden-fixture test + cold-start-to-live metric | S-1196; owner C-3805, C-3879 (5 rows) | **MISSING** | Promised, not built | — | P2 |
| OB-09 | Data-quality preflight checks (PF-01…24: AR/AP vs control, suspense, abnormal signs…) with client report | C-3866, C-3887 … (53 rows) | **PARTIAL** | QBO preflight in `api/integrations/erp/quickbooks/pull`; full PF list not built | Full PF catalogue + branded PDF | P1 |
| OB-10 | Practice (shadow) close, side-by-side old vs new, sign-off certificate, go-live & rollback | owner C-3872 (59 rows) | **MISSING** | Board screens O19–O23 only | Parallel-run mode | P1 |
| OB-11 | Staging (propose → validate → commit), undo/reset, mappings as tenant asset, drop-and-parse TB | S-1229; C-3007, C-3280 … (134 rows) | **PARTIAL** | Section framework partial | Undo/reset per client | P1 |

### IN — Integrations

Source rows mapped here: 296 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| IN-01 | Field ERPs: ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, c-Systems, Jobber, Procore | S-1232, S-1235 …; owner C-4272, C-4278, C-4279, C-4281 … (74 rows) | **MISSING** | No live connector (C §9) | Recipes, then API connectors | P1 |
| IN-02 | Ramp custom-ledger connection | S-1243; C-4275, C-4314 … (11 rows) | **MISSING** | Not built | Owner is rolling out Ramp | P1 |
| IN-03 | Payroll provider (Gusto / Check / Finch) | #181; S-1248, S-1249 …; owner C-4469, C-4470 (25 rows) | **STUB** | See PR-02 | — | P1 |
| IN-04 | Email providers: inbound parse; Resend domain + key rotation | S-1253, S-1263; C-4287, C-4290 … (8 rows) | **PARTIAL** | Resend present; inbound absent | — | P0 |
| IN-05 | SMS / push provider | S-1264; C-4466 (2 rows) | **MISSING** | None | Twilio-class | P0 |
| IN-06 | Stripe & Plaid connection registry + webhooks | S-1234, S-1239 …; owner C-4413 (32 rows) | **PARTIAL** | Registry built; both connections test/sandbox | Live | P0 |
| IN-07 | Sales-tax engine, e-sign, doc storage, CRM, BI export, Slack/Teams, OCR | S-1250, S-1251 …; C-4276, C-4284 … (25 rows) | **MISSING** | None (Azure DI optional, no keys) | — | P2 |
| IN-08 | Suite event bus core.events | S-1238, S-1240 …; C-4306, C-4324 … (18 rows) | **FULL** | FROZEN v3; events.drain job | — | — |
| IN-09 | Integrations hub: per-client connections, sync health, error queue, retry, token rotation | S-1236, S-1242; owner C-4274 (59 rows) | **PARTIAL** | `/integrations/erp`; no error queue (grep) | Health + error queue | P1 |
| IN-10 | MCP server (read + role-scoped proposals) | C-4455 (1 rows) | **MISSING** | No code | — | P2 |
| IN-11 | More source systems: Housecall Pro, ServiceTrade, Foundation, Viewpoint, Sage 300 CRE, NetSuite, Shopify/Square, dealer DMS files | S-1233, S-1259 …; owner C-4273, C-4282 (40 rows) | **MISSING** | Catalog entries only | Recipes | P2 |

### PT — Portals

Source rows mapped here: 103 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| PT-01 | Hosted pay page + tokenized PDF | S-1289, S-1293 …; C-4575, C-4576 … (7 rows) | **FULL** | `app/pay/[token]` (test mode) | Live mode PM-01 | — |
| PT-02 | Customer portal (statements, pay), auto-invited | S-1285, S-1286 …; C-4518, C-4533 … (9 rows) | **PARTIAL** | Link not emailed | Invite email | P1 |
| PT-03 | Vendor portal, auto-invited | S-1287; C-4516, C-4521 … (17 rows) | **PARTIAL** | See VN-04 | — | P0 |
| PT-04 | Auditor access + PBC | S-0840, S-1288; C-4520, C-4526 … (8 rows) | **FULL** | `/pbc` | 0 live | — |
| PT-05 | Client portal for firm clients; lender / board share links | #325; S-1290, S-1291 …; owner C-4517 (49 rows) | **MISSING** | Not found | — | P2 |

### RB — Admin, RBAC & security

Source rows mapped here: 633 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| RB-01 | Custom roles and permission catalog for tenants and clients; Current/Proposed UI | #402, #406, #409; S-1299, S-1301 …; owner C-4606, C-4609, C-4610, C-4797 … (202 rows) | **FULL** | `/settings/roles`; wave 2A dual-run ends Oct 27 | Switch after dual-run | — |
| RB-02 | Location-scoped RLS, SoD, field masks, multi-tenant org resolution | #51, #407; S-1318, S-1323 …; C-0794, C-4619 … (76 rows) | **FULL** | Waves 2B/2C | — | — |
| RB-03 | Access reviews / requests / log; review campaign auto-open | S-1298, S-1302 …; C-4613, C-4616 … (58 rows) | **PARTIAL** | Built; campaign auto-open stub `registry.ts:238` | — | P2 |
| RB-04 | MFA / step-up, session policy, lockout, IP allowlist | #408, #411, #412; S-1297, S-1324 …; C-4629, C-4684 … (24 rows) | **PARTIAL** | Auth policy MFA/step-up; allowlist; sessions via Clerk | Clerk prod settings | P1 |
| RB-05 | Clerk production instance + app subdomain | S-1329; C-3566, C-4643 … (13 rows) | **MISSING** | Open owner action (CLAUDE.md) | Owner | P0 |
| RB-06 | Audit trail incl. data-export tracking | #413, #414, #415; S-1326, S-1333 …; C-4621, C-4711 … (19 rows) | **PARTIAL** | audit_log / action_log; no export tracking (grep) | Export log | P1 |
| RB-07 | Platform admin: add/manage tenants, users, invites | #344, #345, #346, #351, #352, #401 …; S-1300, S-1303 …; owner C-4607, C-4608, C-4612, C-4646 … (82 rows) | **PARTIAL** | `/platform` operator console | Tenant provisioning wizard | P1 |
| RB-08 | Approval engine & authority limits; org chart → hierarchy | S-1308, S-1322 …; owner C-4920 (33 rows) | **PARTIAL** | Engine built; org-chart import missing | — | P1 |
| RB-09 | Dollar authority limits on approve/post/release; delegation ceiling; hard-close approval | S-1346; C-4685, C-4687 … (20 rows) | **PARTIAL** | `effective-access.ts` mentions limits; enforcement on all money routes unverified | Verify + over-limit UX | P1 |
| RB-10 | Access explainers ("What can I do?"), view-as-user, user groups, assignment grants | #355; S-1296, S-1310 …; owner C-4611, C-4617, C-4644 (115 rows) | **PARTIAL** | Roles UI explainers; view-as not found | — | P2 |

### PL — Platform, notifications & scheduler

Source rows mapped here: 297 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| PL-01 | Shared request/chase engine + outbound send layer (email now; SMS/push next) | S-1357, S-1361; C-5787, C-5859 … (5 rows) | **MISSING** | No engine; chase jobs TODO (`registry.ts:224`) | Core enabler for RC-05, VN-01, AR-08, FP-08, PRC-03 | P0 |
| PL-02 | Notification center (bell, inbox), digests, watch rules | S-1356, S-1359 …; C-5677, C-5706 … (13 rows) | **MISSING** | "No notification center or bell" (C §9) | — | P0 |
| PL-03 | Scheduler: the 11 stub jobs implemented | S-1406; C-5614, C-5631 … (16 rows) | **PARTIAL** | `registry.ts:218-242` | Implement each | P0 |
| PL-04 | Tenant billing activation (Stripe) | #433; S-1377, S-1383 …; owner C-5814 (23 rows) | **STUB** | `settings/billing` "coming soon" | — | P1 |
| PL-05 | White-label theming, entitlements, module selection | #435, #436; S-1362, S-1363 …; owner C-5813, C-5820 (29 rows) | **PARTIAL** | Entitlements built; theming partial | — | P2 |
| PL-06 | Mobile PWA | — (0 rows) | **MISSING** | No manifest | With RC-01 | P0 |
| PL-07 | Seeded sandbox tenant, go-live runbook, observability, security hardening | S-1368; owner C-5613, C-5621 (25 rows) | **PARTIAL** | `/sandbox`; Sentry optional | — | P1 |
| PL-08 | Usage cost per company, honest build-status labels, success metrics | S-1358, S-1365 …; C-5619, C-5642 … (10 rows) | **PARTIAL** | Operator dashboard | — | P2 |
| PL-09 | Platform console: tenant lifecycle, provisioning, onboarding funnel, consented support access, platform defaults | S-1366, S-1370 …; owner C-5654, C-5655, C-5815 (139 rows) | **PARTIAL** | `/platform` operator console; support access is a capability only | Provisioning + consented support sessions | P1 |
| PL-10 | Document center + attachments on any record | S-1400; C-5627, C-5704 … (5 rows) | **FULL** | mig 090; `AttachmentsPanel` | — | — |
| PL-11 | Inventory MVP (items, FIFO/average valuation, GL tie-out) | S-1401; C-5622, C-5623 … (5 rows) | **PARTIAL** | `/inventory`, `/inventory/valuation` | Landed cost, multi-warehouse | P2 |
| PL-12 | Governance: FPB per module, field-level spec, feature-audit checklist | S-0310, S-1367 …; C-5626, C-5649 … (19 rows) | **PARTIAL** | 16 FPBs exist; several modules lack one | Author missing FPBs | — |

### UX — Design, IA & navigation

Source rows mapped here: 205 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| UX-01 | Every screen on merit-ui (no legacy emerald), incl. settings, payments, invoice email/PDF defaults | #418; S-0522, S-1379 …; owner C-5423, C-5424, C-5425, C-5429 … (26 rows) | **PARTIAL** | R1 shell ported; legacy emerald remains (`payments-connect.tsx`, `invoice-branding.tsx`, `invoice-email.ts` fonts) | Rebuild pages, not re-skin | P0 |
| UX-02 | IA: owner-named features are findable | S-1393; owner C-0933, C-5426, C-5450, C-5543 (47 rows) | **PARTIAL** | Owner Q-08/Q-12 could not find them; several live in settings tabs or under other labels | Findability pass | P0 |
| UX-03 | Role homes without banners; plain-language labels; no rule codes | S-1398; owner C-5428, C-5432, C-5441, C-5452 … (22 rows) | **PARTIAL** | Boards fixed; pages partial | — | P0 |
| UX-04 | Every row clickable, slide-over detail, proposed vs posted distinct | S-1373, S-1389 …; C-0616, C-5444 … (10 rows) | **PARTIAL** | Drawers on many pages | — | P1 |
| UX-05 | Accessibility AA, keyboard, empty states | S-1394, S-1395 …; C-1979, C-3262 … (36 rows) | **PARTIAL** | merit-ui components | Audit | P1 |
| UX-06 | Global company switcher, dimension tags | #417; S-1391, S-1392 …; C-5433, C-5434 … (21 rows) | **FULL** | company scope | — | — |
| UX-07 | Context model (client context chip, narrowest hat by default), server-side saved views, shared chart & page header | #416; owner C-5427 (45 rows) | **PARTIAL** | company-scope cookie; saved views only in capability list | — | P1 |

### DL — Dealer pack

Source rows mapped here: 200 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| DL-01 | Dealer operations (floor plan, units, deals, warranty, incentives, lender/OEM statements, imports) | owner C-5165, C-5173, C-5353 (172 rows) | **FULL** | 71 API routes; every dealer table has 0 rows | Browser-verify with real data | — |
| DL-02 | Dealer reports and exception checks | C-5191, C-5197 … (10 rows) | **PARTIAL** | Invalid keys show "not yet implemented" | — | P2 |
| DL-03 | Generic switch-on module, nothing hardcoded | owner C-5166, C-5187 (12 rows) | **FULL** | mig 169; settings | — | — |

### PJ — Projects seam

Source rows mapped here: 58 (A + B, retired excluded).

| Key | Canonical feature | Intended (source IDs) | Built | Evidence | Gap → fix | Pri |
|---|---|---|---|---|---|---|
| PJ-01 | Books stands alone; one-master-per-domain toggle | owner C-5365, C-5377, C-5378 (3 rows) | **FULL** | task #22; mig 173 | — | — |
| PJ-02 | Exactly-once billing, retainage, deposits from Projects | C-5369, C-5373 … (12 rows) | **FULL** | mig 173 | — | — |
| PJ-03 | Projects owns job POs for Projects clients | owner C-5366, C-5367, C-5380 (9 rows) | **PARTIAL** | Open decision | — | P2 |
| PJ-04 | Time / clock (Projects) → JOB_TIME labor cost | owner C-5398 (20 rows) | **MISSING** | Not built | — | P1 |

---

## 4. Reporting and FP&A plan: beat the partner portal, then the market

**Goal.** Your partners should prefer MeritBooks over the portal, and a CFO should prefer it over Fathom, Jirav or Sage Intacct reporting.

**Why we can win.** MeritBooks owns the general ledger, so it can do things the portal (statements imported from QuickBooks) and the add-on tools cannot:
- drill from any figure to the source document;
- show true eliminations;
- report closed months as fact (from the period locks);
- produce AI commentary that cites real transactions.

**Principles:**
1. **One engine, many definitions.** Each of the 175 reports in FPB-reports-fpna §1 is a *definition* rendered by shared code, not a page.
2. **Refuse to invent.** A missing month shows as a gap, never as zero. Every metric has explicit "unavailable" states.
3. **Plain English first.** Each chart carries a deterministic one-sentence summary. AI commentary is layered on top, with citations.
4. **merit-ui only:** Syne/DM Sans, Electric Blue/Midnight, square geometry, `density-report` for owner/CFO/partner and `density-cockpit` for staff.
5. **No "portfolio" wording.** Use "clients", "companies" and "consolidation group" (owner directive).

### 4.1 The shared report engine (Wave 3A)

| Layer | Contract |
|---|---|
| **Balances store** | Materialized period balances by account × company × department × class × location × job (+ customer/vendor for subledger reports). Refreshed on post, via the existing event drain. Migration in Wave 3A. Target: 12 months × 17 companies × departments renders in under 2 seconds. |
| **Period engine** | Fiscal-year aware. Month, quarter, year, MTD/QTD/YTD, TTM, and custom ranges. Columns across months, quarters or years. Comparisons: prior period, prior year, approved budget, forecast, scenario; each with $, % and favourable/unfavourable by account type. Margins compare in **points**. |
| **Dimension engine** | Filter, group or split columns by any dimension. Saved groups (e.g. "Install BU", "East"). Department/class/location/job columns are real (they fix the mislabelled stubs). |
| **Scope engine** | One company · selected companies (combined, ids in the URL) · consolidation group (eliminated, NCI) · ownership-weighted (look-through %) · the tenant's own books. Each request is re-validated against permissions (location-scoped RLS, roll-up permission). |
| **Row layouts** | Two built-in layouts, *As reported* (COA groups) and *Standard lines → EBITDA* (Revenue → COGS → GP → opex buckets → EBITDA → Adjusted EBITDA → below the line). Plus a custom row/column designer (Wave 4). Each standard line opens to its accounts. |
| **Drill contract** | Statement line → account → GL lines → journal entry → source document (bill, invoice, bank line, receipt). A side panel with breadcrumbs, keeping the filters. |
| **Output contract** | Screen, branded PDF, XLSX (live formulas where possible), CSV, and an expiring read-only share link. Every report states its basis (accrual/cash/tax) and period status (final / preliminary). |
| **States** | Loading, empty (why, plus the next action), populated, error with retry, and partial-period warning. No on-screen truncation: paginate or virtualize. |
| **Security** | RLS client only (`createServerSupabase`); views use `security_invoker` (lesson from migration 066); share tokens are scoped and expiring. |

### 4.2 P0 report list (named, all on the engine)

| # | Report | Notes / fixes current defect |
|---|---|---|
| R1 | Profit & Loss (standard, % of revenue, PP/PY/budget) | Exists; move to engine |
| R2 | P&L by month (12/24/36 + total, TTM column) | Exists as 12 columns only |
| R3 | P&L by quarter and by year (3–5 years) | New |
| R4–R7 | P&L by **department**, **class**, **location**, **job** | Today these render the plain P&L |
| R8 | P&L by company (columns) → combined → eliminations → consolidated | Today a generic table |
| R9 | Balance sheet (comparative; by company; consolidated) | Exists; add company columns |
| R10 | Cash flow, indirect and direct (multi-company) | Indirect uses the first company only |
| R11 | Trial balance worksheet (unadjusted / adjustments / adjusted) | Add adjusting-entry columns |
| R12 | General ledger detail and transaction list (paginated, drill to source) | 200-row cap today |
| R13 | Statement of changes in equity (by holder/class) | Generic table today |
| R14 | Budget vs actual (approved version only, F/U, YTD + full year, by department) | Generic table today |
| R15 | Flux analysis (MoM/QoQ/YoY/BvA, materiality $ and %, required explanations) | New; also a close gate |
| R16 | EBITDA and adjusted-EBITDA bridge (waterfall, YTD/TTM) | New |
| R17 | 13-week cash forecast (AR × predicted pay dates, AP due, payroll, debt service, tax, recurring) | AR/AP only today |
| R18 | Daily cash position by bank and company (+ minimum-cash line) | Partial |
| R19 | AR aging summary/detail (+ retainage) and DSO/BPDSO/ADD/CEI trend | Aging exists |
| R20 | Customer concentration (top-N, any customer over 10% flagged) | New |
| R21 | AP aging + DPO + cash requirements (bills due vs cash) | Partial |
| R22 | WIP schedule with GL tie-out and over/under adjustment | WIP exists, no tie-out |
| R23 | Job profitability, fade/gain, backlog, retainage | Partial |
| R24 | Covenant compliance and headroom (with breach projection) | Partial |
| R25 | Borrowing-base certificate; debt schedule with maturity ladder | Partial |
| R26 | Close status board; reconciliation status of all balance-sheet accounts | Partial |
| R27–R28 | 1099 summary; sales-tax liability by jurisdiction | Dead catalog entries today; wire them to `/compliance-1099` and `/sales-tax-return` data |
| P1 | Monthly management pack · Partner/Board packet · Lender pack (see §4.6) | Board package exists; packs are new |

The remaining ~140 reports in FPB-reports-fpna §1 come in Wave 4D and later as definitions on the same engine, shelved by question ("How did we do?", "Where is the cash going?", "Who owes us?", …).

### 4.3 KPI catalog (metric registry, Wave 3B)

Every metric is a typed registry entry with: formula string, period chip, comparison, semantic delta words ("improvement / erosion", "favourable / unfavourable"), sparkline, drill target, and **unavailable states**:
- Not enough history;
- Not on file;
- Not mapped;
- Not meaningful (base ≤ 0, sign flip, base under 5% of a typical month);
- No approved budget;
- Preliminary (period not closed).

| Group | Metrics (formula notes) |
|---|---|
| Growth | Revenue · Revenue growth YoY (YTD and month) · Revenue CAGR 1/3/5y (TTM-to-TTM) · EBITDA CAGR 1/3/5y · Rule of 40 (growth % + EBITDA margin %) |
| Profitability | Gross profit · Gross margin (Δ in pts) · EBITDA (operating income + D&A, from account roles, never a hand-entered number) · EBITDA margin · Adjusted EBITDA (+ documented add-backs, each with a reason) · Net income / net margin · Opex % of revenue · SG&A · Contribution margin |
| Plan | Revenue / EBITDA / Opex variance vs **approved** budget ($, %, F/U) · Full-year outlook (actuals + forecast) vs budget · Forecast accuracy (last 4 weeks / last quarter) |
| Cash & liquidity | Cash · Days cash on hand · Net burn (3-mo average) · Runway (months) and zero-cash date · Free cash flow · FCF conversion (FCF ÷ EBITDA) · Working capital · Current ratio · Quick ratio |
| Working capital | DSO · Best-possible DSO · Average days delinquent · Collection effectiveness index · DPO · DIO (if inventory) · Cash conversion cycle · AR over 90 days % · Unapplied cash |
| Lender | Total debt · Net debt · Debt / TTM EBITDA · DSCR · Fixed-charge coverage · Interest coverage · Minimum covenant headroom (%) · Borrowing-base availability · Undrawn commitments · Weighted average rate · Next maturity |
| Jobs (construction) | Backlog $ and months of coverage · Underbillings · Overbillings · Net over/under · Job GP % vs bid · Fade $ and pts · Retainage receivable / payable |
| Efficiency | Revenue per employee and EBITDA per employee (TTM ÷ average headcount, ≥ 6 months of headcount) · Labour cost % of revenue |
| Shape | Best / worst month (fiscal YTD) · Seasonality index (calendar month ÷ average month, complete years) |
| Books health | Books closed through · Days to close · Unreconciled accounts · Uncategorized $ · Exceptions open · AI auto-coded % · Missing receipts · Vendors on payment hold |

That is ≈ 60 metrics, beating the portal's 37 (M1). The defaults per audience are administrator-curated (§4.9).

### 4.4 Chart frame contract (ChartCard, Wave 3C, in `packages/merit-ui`)

**Every chart includes:**
- title;
- basis line (e.g. "By month, Sep ’24 – Aug ’26, with the same month a year earlier and TTM");
- a **deterministic summary sentence**, which doubles as the alt text;
- an (i) definition the administrator can edit;
- a period chip;
- **View as table**, **CSV** and **XLSX**;
- a footer naming gaps, preliminary months and eliminations;
- click-through drill;
- all four states;
- print CSS (the table prints under the chart);
- a 390 px layout.

**Encodings:**
- prior-year same month as a dashed Midnight line;
- approved budget as tick marks;
- TTM in a synced sub-panel (never on a second axis);
- preliminary months hatched;
- forecast months dotted (distinct from preliminary);
- unfavourable variance hatched;
- one y-axis only;
- bars start at zero;
- readable without colour;
- DM Sans tabular numerals, auto $/$K.

**Kit:** MonthlyCombo · Waterfall/Bridge · VarianceBars · Bullet (covenant, budget) · Share bars · Scatter (Rule of 40) · League table · Heat grid (companies × KPIs) · Sparkline · Fan chart (forecast band) · Maturity ladder · S-curve (job billing). The designer agent owns this kit.

### 4.5 Analyses that beat the portal (Wave 3B library, Wave 4A screens)

- YoY table (Month / FYTD / TTM; points for margins).
- CAGR ladder; EBITDA bridge (volume at prior margin → rate → opex; steps sum exactly); price/volume/mix bridge.
- Margins with a YTD / TTM / monthly switch; seasonality index; working-capital days + CCC.
- Rule-of-40 scatter.
- **Plus what owning the GL adds:**
  - elimination bridge (sum of companies → consolidated);
  - drill to transaction;
  - flux with explanations;
  - covenant headroom trend with projected breach date;
  - 13-week cash with click-a-week-to-see-items.

### 4.6 Packs (Wave 4D)

- **Designer:** a block-based pack designer (cover, AI executive summary, KPI grid, statement, chart, table, commentary, image, page break).
- **Templates:**
  - Monthly management pack;
  - Partner/Board packet (per-company page: data through, headline vs comparison vs budget, T12M revenue and EBITDA, balance sheet vs a year earlier, which is the portal's M12);
  - Lender pack (statements + compliance certificate + headroom + borrowing base + AR aging + debt schedule);
  - Surety pack (WIP, completed contracts, backlog, working capital);
  - Department BvA.
- **Release:** apply a template to N companies at once. **Release on close sign-off**. The released version is **frozen** (hash stored) and delivered by email/portal through the request engine, as a branded PDF and an expiring share link.
- **Today vs gap:** the existing `report-compiler`, `saved-packs` and scheduled delivery are the base (0 used today).

### 4.7 AI narratives (Waves 3–4, on the AI gateway)

- **Layered on the deterministic sentences:** an executive summary of 5–7 bullets (what happened, why, what to do).
- **Explain this variance:** decomposes by dimension, vendor and job, separates one-off from recurring, and flags likely misclassification, with the top transactions linked.
- **Auto flux commentary at close;** "questions your board or lender will ask".
- **Guardrails:**
  - every figure is cited to the query that produced it;
  - text is a **draft until a person approves it**;
  - the system abstains when data is missing;
  - everything is logged to `ai_decisions`;
  - it degrades to deterministic output if AI is down.

### 4.8 Group and consolidated views (Wave 4A)

- **Scope switcher** on every FP&A view: one company · selected companies · consolidation group (eliminated) · ownership-weighted.
- The URL is shareable. The roll-up is gated by the consolidation permission, so each bookkeeper sees only their clients (owner rule C-1862).
- **Group home shows:**
  - combined revenue and EBITDA (MonthlyCombo + TTM);
  - where revenue and EBITDA come from (share bars, losses hatched);
  - a sortable league table (revenue, growth, GM, EBITDA, margin, share, Rule of 40) with stale-data flags;
  - a Rule-of-40 scatter;
  - a heat grid;
  - the elimination bridge.
- **"In group from" date per company:** no figures before acquisition.

### 4.9 Governance of numbers (Wave 3D)

- **Books closed through** comes from the latest HARD_CLOSE period per company. It is a fact, not a QuickBooks date (portal X6).
- **Release rule** per tenant: partners see a month only after hard close + N days. The admin can preview unreleased months with an amber banner.
- **Restatement log:** a statement hash is snapshotted at release and compared nightly. Changed months are listed with the delta and the journal entries that caused it.
- **Packets are frozen at notice.**
- **Freshness card** per company: bank-feed last sync, close status, source.
- **Reporting-deadline tiles** (configurable obligations, e.g. board package within 45 days, quarterly within 60, reviewed annual within 90).
- **Draft watermark** on any unclosed period.

### 4.10 How it plugs into role homes (Wave 5C)

Every metric, chart and report is a **widget** in the IA §5.6 registry, with role defaults:
- **Owner** (report density): cash, profit vs plan, what needs you, group league.
- **CFO:** KPI scorecard, 13-week cash, covenant headroom, flux.
- **Controller:** close board, reconciliation status, exceptions, flux gate.
- **Accounting manager:** team performance, queues by person.
- **Bookkeeper:** queues and chases.
- **Department head:** own BvA.
- **Partner** (read-only audience mode, X12): curated cards and frozen packets.

The admin publishes and locks role layouts on the server; users rearrange their own.

### 4.11 Parity map: partner portal (D §3) → where it lands

| Portal item | Wave/slice |
|---|---|
| M1 metric catalogue | 3B (registry) + 4A (screens) |
| M2 period basis/range | 3A |
| M3 MonthlyCombo | 3C |
| M4 analytic cards | 3B + 4A |
| M5 group views | 4A |
| M6 statements by month, line → account drill | 3A |
| M7 ChartCard contract | 3C |
| M8 debt tiles, maturity ladder | 4E |
| M9 cap table / waterfall | **owner decision #8** (Suite governance vs Books) |
| M10 holdings org chart | 4A (P2) |
| M11 governance | 3D |
| M12 board packet | 4D |
| M13 approved budgets, xlsx round-trip | 4B |
| M14 craft | 3C (designer) |
| X1 true consolidation | 3A |
| X2 drill to transaction | 3A |
| X3 cash flow + 13-week | 3A + 4C |
| X4 forecast/scenarios | 4C |
| X5 AI variance narrative | 4D |
| X6 live close status | 3D |
| X7 AR/AP depth | 3A |
| X8 covenants from GL | 4E |
| X9 scheduled packs | 4D |
| X10 benchmarks | Wave 6 (data source decision) |
| X11 dimensions | 3A |
| X12 partner audience mode | 5C |

---

## 5. Enhancements beyond the spec (world-class, each justified)

| # | Enhancement | Why |
|---|---|---|
| E1 | **Stripe payout ↔ bank deposit auto-reconciliation** (gross, fee and net split) | Without it, every online payment leaves a manual reconciliation item. Owning both the invoice and the bank feed makes this automatic. |
| E2 | **"Where's my payment?" in the vendor portal** (bill status, check #, cleared date) | Cuts AP phone calls and reuses the portal we're about to email out. |
| E3 | **Customer autopay, saved methods and payment plans** on the hosted pay page | Shortens DSO. Stripe supports it natively. |
| E4 | **Owner morning brief** (7am email/push): cash by company, what needs you, overnight exceptions, chase status | Makes "the system does it" visible to a non-accountant owner (Q-01, Q-11). |
| E5 | **Close-readiness score per company** with a "why is it red" narrative | Focuses the accounting manager. It builds on the existing close grid and detectors. |
| E6 | **Explain any number** (press "?" on any cell) with transaction citations | Only a GL owner can do this. It is the strongest differentiator against the portal and add-ons. |
| E7 | **Proof of cash and a data-quality score per client** | Trust signal for firm tenants and lenders; reuses onboarding preflight checks. |
| E8 | **Mobile approvals** (bills, payments, JEs) in the Workforce/PWA with step-up auth | Approval latency is the main bottleneck the team-performance data will show. |
| E9 | **Check-fraud defense:** payee positive pay, dual signature above a threshold, call-back on vendor bank changes | Checks are the top payment-fraud vector, and we are about to start printing them. |
| E10 | **Adjusted-EBITDA add-back finder** + lender/surety pack | A holding company with lenders needs normalized EBITDA. This is open lane E-AI11. |
| E11 | **Fade early-warning on jobs** (cost burn vs % complete, change-order lag) | Matters for surety; no surveyed tool does it (E-AI7). |
| E12 | **Forecast confidence bands and covenant-breach probability** | Open lane (E-AI5); turns the 13-week forecast into a risk tool. |
| E13 | **Auto-fetch receipts from connected inboxes** (Amazon, Home Depot, Uber) | Cuts receipt-chase volume before the chase even starts (Ramp pattern). |
| E14 | **"What changed since you last looked"** strip on every home | Orientation for a non-technical owner; answers "I don't understand what you actually did". |

---

## 6. Build plan

### 6.1 Ground rules honoured

- **Books stands alone without Projects.** Anything that touches time or job POs is capability-driven and hidden when Projects is off.
- **Security/RBAC wave 2 is done.** The 7-day dual-run ends **Oct 27**. The lead flips enforcement then, before any Wave 1 money feature is released to live mode.
- **New or rebuilt screens use `packages/merit-ui`.** No legacy emerald.
- **Migrations are lead-serialized** from **175**, applied to Supabase before the dependent code is committed. Builders *report* schema needs; they never write migrations.
- **Reserved spine (lead only):** `packages/shared/*`, `api-handler.ts`, `navigation.ts`, `rbac/permissions.ts`.
- **Every slice:** FPB confirmed → builder (+ designer on UI) → verifier + chrome-auditor (+ security on money/identity/public routes) → reviewer → scribe. "Done" means **you can see it and click it in production.**

### 6.2 Wave 0 (lead + auditor, this week, no parallel builders)

1. **Owner-visible quick fixes:**
   - Stop printing GL account numbers on customer invoice PDFs (`invoice-pdf.tsx`).
   - Change the Payments screen's "payments are live" to show the actual Stripe mode.
   - Hide or wire the dead "1099 Summary" and "Sales Tax Summary" catalog entries.
2. **Navigation (lead-only file):**
   - "Pay runs" → **"Checks & payments"**.
   - Add **"Team performance"** to the accounting-manager menu.
   - Add **"Revenue & WIP settings"** under Revenue recognition.
   - Surface **Invoice design** under Invoices.
   - Add an **AP inbox** card to Bills (showing "not yet active" until Wave 2D).
3. **RBAC:** switch to enforcement on Oct 27 after the dual-run report is clean.
4. **FPBs (auditor):**
   - author FPB-bank-feed-splits, FPB-request-engine-notifications, FPB-check-processing and FPB-ap-intake;
   - promote REV-REC-WIP-SPEC → FPB-rev-rec-wip;
   - amend FPB-invoices (customization, pay link on PDF), FPB-payments-fees (live cutover, per-company Stripe) and FPB-financial-reports (engine);
   - renumber FPB-reports-fpna's proposed migrations 155–160, which are already taken.

### 6.3 Waves (each: 3–5 parallel, file-disjoint slices for opus builders)

**Wave 1: Money live + the owner's visible gaps** (migrations 175–179)

| Slice | Features | Scope (files/areas) | Mig | FPB | Owner-visible acceptance |
|---|---|---|---|---|---|
| **1A Live payments & bank** | PM-01, PM-02, BF-03, PM-05 (display) | `lib/money/*`, `api/payments/*`, `api/pay/*`, `settings/payments/*` (rebuilt in merit-ui), Plaid env handling | **175** `provider_connections.location_id` + new unique key | FPB-payments-fees (amended) | Settings → Payments lists every company with its Stripe status, payout bank, **TEST/LIVE badge**, card/ACH toggles. A $1 live payment on company X lands in company X's Stripe and posts PAID → GL. Security review. |
| **1B Invoice design & pay links** | AR-01, AR-02, AR-03, AR-04, AR-05 | `lib/invoices/*` (pdf, email, doc), `invoices/invoice-drawer`, new `invoices/design/*` screen | **176** `invoice_templates` (columns, custom fields, font, terms, show_qr), customer→template, invoice CC recipients | FPB-invoices (amended) | Invoices → Design: pick a template per customer, show/hide columns, add custom fields, terms and payment instructions print, logo/colour in brand defaults. PDF has a pay URL + QR. The drawer has a pay-link panel (copy, QR, viewed). Email supports CC. |
| **1C Split transactions** | BF-01, GL-01, BF-11 (card lines) | `bank-feed/edit-panel` split grid, `api/bank-feed/approve`, `lib/posting` split builder, credit-card feed | **177** `bank_transaction_splits`, `split_rules` | FPB-bank-feed-splits (new) | Split by $ or % with a remaining-to-allocate meter. Cross-company lines create due-to/due-from. "Remember this split". It posts N balanced lines. |
| **1D Request engine + notifications** | PL-01, PL-02 | new `lib/requests/*`, `lib/notify/*`, scheduler job `requests.dispatch`, bell + inbox component in the shell (the shell file is assigned to this slice only) | **178** `core.requests`, `request_events`, `notifications`, `notification_prefs` (quiet hours) | FPB-request-engine-notifications (new) | A bell with unread count. A test request goes out by email on cadence, respects quiet hours, escalates and stops when fulfilled. |
| **1E Rev-rec election & WIP** | RR-01, RR-02, RR-05, RR-06 | `rev-rec/*`, `jobs/wip/*`, `settings/rev-rec-config` → merit-ui, close-task hook | **179** company rev-rec policy (`auto_accrue_underbillings`, `propose_on_close`) | FPB-rev-rec-wip (promoted) | Plain-English "How do you recognize revenue?" card with an example entry. Close shows a "WIP: proposed accrual" task each month. The WIP screen ties to 1180/2410 and posts the adjustment. |

**Wave 2: Chase, checks, AP email, automation** (migrations 180–184; depends on 1D)

| Slice | Features | Scope | Mig | FPB | Acceptance |
|---|---|---|---|---|---|
| **2A Vendor W-9/COI closed loop** | VN-01…VN-04, VN-10 (bank-change call-back) | `vendor-compliance/*`, `portal/vendor/*`, `lib/services/vendor-compliance.ts` | **180** `vendor_requirements`, submission review state | FPB-vendor-compliance-chase | A vendor missing a COI gets an email with a magic link at T-30/T-15/T-0, then weekly. The upload is AI-checked against the requirement. One-click accept lifts the hold. |
| **2B Receipt capture & chase (web + email)** | RC-02…RC-08, RC-11 | `receipts/*`, `credit-cards/*`, card-assignment settings in merit-ui | **181** `card_assignments`, `receipt_chase_enabled` (tenant + client) | FPB-workforce-app §4.2, §4.9 | A card charge creates a receipt request to the cardholder. Upload or forward a receipt and it auto-matches. Chase count increments. Tenant/client switch is audited. |
| **2C Check printing, register, void** | CK-01, CK-03…CK-07; CK-02 adapter behind decision | `checks/*`, `lib/ap/check-print/*` (MICR E-13B font, layouts), `lib/ap/disbursement-export.ts` (bank positive-pay formats), void route | **182** `bank_check_sequences`, `check_stock_profiles`, check status/void columns | FPB-check-processing (new) | The check processor home shows "N checks ready". It prints an alignment test, then checks with MICR and stub. Numbers come from the account sequence. The register shows cleared/void/stale. Void reverses the JE and reopens the bill. Positive-pay file in the bank's format. Security review. |
| **2D Payables email live** | AP-01, AP-02 | `api/webhooks/inbound-email`, provider adapter (signature verify), per-company alias UI on Bills / intake queue / company settings / onboarding, IT one-pager | **183** per-company inbound aliases | FPB-ap-intake (new) | Forward a PDF to `ap-heritage@…` and a draft bill appears on Heritage within a minute, with the sender shown. The address is visible with a copy button. |
| **2E Scheduler: make "automatic" true** | PL-03, BF-02, AR-07, AR-08, CL-08, SC-06, AP-13, AI-10 | `lib/scheduler/*` (registry owned by this slice), job modules | **184** late-fee policy | SCHEDULER.md + FPB-invoices D6 | Plaid sync runs nightly with a stale-feed alert. Recurring invoices generate and send. The dunning ladder and late fees run. Depreciation/amortization post on schedule. Pay-run draft is proposed. Each is visible in a "Jobs" log. |

**Wave 3: Report engine foundation** (migrations 185–187)

| Slice | Features | Scope | Mig | FPB |
|---|---|---|---|---|
| **3A Engine + core statements** | RP-01…RP-08, RP-10, RP-16, R1–R14 | `lib/reports/engine/*`, report routes, `reports/report-viewer` rebuilt in merit-ui | **185** materialized period balances by dimension | FPB-financial-reports (amended) |
| **3B Metric registry + analytics lib** | FP-01, FP-03 | `lib/metrics/*`, `lib/analytics/*` (pure, tested) | — | FPB-reports-fpna §1.15 |
| **3C Chart kit + ChartCard** | FP-02, RP-12 | `packages/merit-ui/src/charts/*` (designer-led) | — | FPB-reports-fpna §2 |
| **3D Number governance** | FP-15, RP-17 | `lib/reports/governance/*`, release/preview UI | **186** report releases, restatement snapshots | FPB-tenant-model-consolidation-analytics |
| **3E Flux + close gate** | CL-05, CL-03 | `close/*`, `lib/close/flux/*` | **187** flux explanations, materiality | FPB-financial-reports (amended) |

**Wave 4: FP&A experience and packs** (migrations 188–190)
- **4A FP&A workspace rebuild:** FP-04, the M1–M7 screens, group views, league table.
- **4B Budgets depth:** FP-06…FP-08, FP-21, R14. **188**: budget versions/approval, templates, department owners, submissions.
- **4C Cash & forecast:** FP-09…FP-12, R17–R18. **189**: forecast snapshots / accuracy.
- **4D Packs + cited AI commentary + first 60 shelf reports:** FP-14, RP-15, RP-20, DB-04. **190**: pack versions / frozen hashes.
- **4E Debt & equity parity:** DB-02, DB-05, DB-06 (covenant measurement job, maturity ladder, equity register).

**Wave 5: People** (migrations 191+)
- **5A Accounting-manager cockpit and team performance depth:** DS-02…DS-04, with a config UI and per-person queue aging.
- **5B Merit Workforce PWA:** RC-01, RC-09 (Projects-gated), RC-10, PR-03, PR-06, PL-06.
- **5C Role homes + widget registry + admin-locked layouts + partner audience mode:** DS-06, DS-07, UX-03, X12.
- **5D Practice:** client requests ("waiting-on"), assignment grid, firm cockpit (PRC-01…PRC-03).
- **5E Expense policy upload/acknowledgement + org chart → approval chains:** EX-02, EX-04, EX-07, RB-08.

**Wave 6: Integrations and depth** (as decisions land)
- Gusto live (PR-02).
- QBO production keys (OB-02).
- Ramp connection (IN-02).
- Field-ERP guided-export recipes, then API connectors (IN-01).
- Gmail/Outlook AP mailboxes (AP-03).
- Check mailing provider (CK-02).
- AIA progress billing (AR-14).
- Recurring bills, vendor credits, lien waivers (AP-09…AP-11).
- OFAC + IRS TIN match + IRIS e-file (VN-10, TX-02).
- Sales-tax rate engine (TX-03).
- Benchmarks (RP-18).
- SMS channel (RC-06, IN-05).

**Throughput note.** The real ceiling is the single verification lane plus migration serialization, not agent count. Expect one wave per verification cycle.

### 6.4 Decisions and inputs needed from you (plain English)

1. **Stripe live:**
   - Put your live Stripe keys and live webhook secrets into Vercel yourself (I must not handle them).
   - Confirm **each company gets its own Stripe payout account** (recommended, so money lands in the right company's bank).
   - Should card payments be on? Default is that the customer pays the 3% card fee and ACH is free to them.
2. **What MeritBooks charges your own companies** per online payment. I suggest $0 for Merit's companies. Other tenants use the fee schedule.
3. **Plaid production:** confirm Plaid has approved production access, and list the banks. Chase, Wells Fargo and BofA need an extra OAuth registration.
4. **Checks:**
   - Print in your office (MICR-capable printer/toner and blank check stock; your bank signs off on a sample), have a service print and mail them (about $1–2 per check), or both?
   - Which banks require positive-pay files?
5. **Text messages for receipt chase:** approve an SMS provider (Twilio-class; needs a one-time business registration), or start with email + app notifications only.
6. **AP email:** approve an inbound email service (Postmark recommended) and one DNS change. Confirm addresses like `ap-<company>@inbound.meritbooks.app`.
7. **Payroll:** confirm Gusto (pending task #32) so the partner application can start.
8. **Partner reporting:**
   - Should MeritBooks become what your partners see, retiring the portal's financial tabs?
   - Should the cap table / waterfall live in MeritBooks or stay in the portal?
9. **Clerk production** instance and the app's final web address.
10. **Ramp:** build the Ramp connection now (you said you're rolling it out), and should Ramp or MeritBooks own card receipts and reimbursements?

---

## 7. Appendix

### 7.1 Dedupe method

1. **Parse.** Every table row in A (1,853) and B (5,866) was parsed by script: ID, feature, detail, origin, stated status.
2. **Retired rows.** The 49 rows in A's "Retired / superseded" domain were excluded and stay retired: chargebacks, overhead/burden, labour classes, in-app time clock, MeritContext and the platform-fee GL. That leaves **7,670** live rows.
3. **Unified domains.** A's 33 domains and B's 30 domains were mapped onto **30 unified domains**. Mobile/workforce joins Receipts; Job costing joins Rev rec; Notifications, Platform and Other join Platform.
4. **Canonical features.** I hand-wrote **300 canonical features** from A's owner-numbered items, B's owner-requested rows, the FPBs, and C/D/E. Each has a status grounded in C or in a check verified today, plus a keyword pattern.
5. **Assignment.** Each row was assigned to the canonical feature in its domain whose pattern matched the row's title with the **longest, most specific** keyword (falling back to title + detail). Rows with no match in their own domain fell back to the best title match across all domains. These are cross-domain duplicates, such as AP rows filed under Payments.
6. **Coverage.** **7,665 of 7,670 rows (99.9%) mapped.** Five residual rows were inspected and are sub-details of mapped features: C-0270 "mark charge not required", C-1844 "BBC AR section", C-3086 "bk.agenda Due this week", C-4138 and C-4240 (onboarding decision ledger).
7. **Caveat.** The row-to-feature mapping is keyword-based, so the per-feature row counts are indicative. The **status of each canonical feature is a human judgement against code evidence**, and the scorecard counts statuses, not rows.

### 7.2 Counts

**Status by canonical feature:** FULL 71 · PARTIAL 128 · STUB 19 · MISSING 82 (300).

**Status weighted by source rows:**

| Status | Rows | Share |
|---|--:|--:|
| FULL | 2,495 | 33% |
| PARTIAL | 3,414 | 45% |
| STUB | 411 | 5% |
| MISSING | 1,345 | 18% |

The domains with the most rows (RBAC, reports, onboarding) are relatively well built, so row-weighting flatters the result.

**P0 features:** 66, all open (31 PARTIAL, 7 STUB, 28 MISSING). There is no P0 feature that is FULL, by construction: P0 was assigned only to gaps.

**Owner-requested rows (B, 189):** every one maps to a canonical feature. The owner rows that land on MISSING/STUB features cluster in:
- receipt chase / Workforce (RC-01, RC-05, RC-07);
- vendor chase (VN-01);
- checks (CK-03);
- splits (BF-01);
- AP email (AP-02, AP-03);
- budgets (FP-07, FP-08);
- role homes (DS-07).

**Rows by domain and source:**

| Domain | A rows | B rows | Cross-domain fallbacks | Canonical features |
|---|--:|--:|--:|--:|
| BF Bank feed & categorization | 86 | 144 | 3 | 11 |
| GL GL, journal entries & COA | 105 | 116 | 8 | 15 |
| RC Receipts, receipt chase & Merit Workforce | 54 | 179 | 15 | 11 |
| AP AP, bills & payables email | 94 | 60 | 0 | 15 |
| VN Vendors & W-9 / COI chase | 46 | 216 | 2 | 11 |
| CK Check processing (print & mail) | 17 | 89 | 1 | 8 |
| PM Payments & money movement | 51 | 144 | 23 | 11 |
| AR AR, invoicing & collections | 124 | 141 | 20 | 16 |
| RR Revenue recognition, WIP & job costing | 101 | 134 | 8 | 13 |
| PR Payroll & commissions | 41 | 187 | 1 | 8 |
| EX Expenses | 29 | 107 | 1 | 8 |
| BR Bank reconciliation | 42 | 105 | 24 | 6 |
| CL Close & controls | 78 | 135 | 21 | 10 |
| SC Fixed assets, leases & schedules | 72 | 49 | 7 | 6 |
| DB Debt, equity & covenants | 27 | 110 | 8 | 7 |
| CO Consolidation & intercompany | 54 | 152 | 11 | 6 |
| TX Tax, 1099 & compliance | 68 | 98 | 5 | 6 |
| RP Reports | 127 | 517 | 2 | 21 |
| FP FP&A, budgets & cash forecasting | 115 | 381 | 4 | 21 |
| DS Role dashboards & team performance | 56 | 325 | 18 | 9 |
| PRC Practice management | 48 | 139 | 14 | 6 |
| AI AI agents & automation | 99 | 320 | 24 | 12 |
| OB Onboarding & migration | 71 | 451 | 26 | 11 |
| IN Integrations | 53 | 242 | 10 | 11 |
| PT Portals | 13 | 77 | 14 | 5 |
| RB Admin, RBAC & security | 75 | 567 | 5 | 10 |
| PL Platform, notifications & scheduler | 40 | 249 | 14 | 12 |
| UX Design, IA & navigation | 18 | 189 | 7 | 7 |
| DL Dealer pack | 0 | 194 | 6 | 3 |
| PJ Projects seam | 0 | 44 | 14 | 4 |
| **Total** | **1804** | **5861** | | **300** |

*Counts are rows landing on each domain's canonical features (after cross-domain fallback), so they differ slightly from the source files' own domain totals.*

### 7.3 FPB coverage (Rule 13)

- **FPBs that exist:** invoices, payments-fees, bank-reconciliation, financial-control-exceptions, financial-reports, reports-fpna, team-performance, vendor-compliance-chase, workforce-app, payroll, commissions, dealer-pack, identity-multitenancy, onboarding, nl-copilot, tenant-model-consolidation-analytics.
- **FPBs needed before their wave** (Wave 0 auditor work):
  - FPB-bank-feed-splits;
  - FPB-request-engine-notifications;
  - FPB-check-processing;
  - FPB-ap-intake;
  - FPB-rev-rec-wip (promote the spec);
  - FPB-budgets (or split FPB-reports-fpna §4 out);
  - FPB-close-flux;
  - FPB-role-homes (from IA §4/§5.6).
- **Important:** the FPBs for reports-fpna, workforce-app, vendor-compliance-chase and team-performance were *written but their builds stopped at slice one*. The plan above executes them rather than re-writing them.

### 7.4 Contradictions (from A) with recommended resolutions

| # | Contradiction | Recommended resolution |
|---|---|---|
| 1 | 461 vs 436 features in the audit | Use **436**, the numbered items. Fix the headers in the audit and Master Doc. |
| 2 | Emerald/Plus Jakarta vs Merit Suite Style Guide v2.3 | **merit-ui v2.3 is binding.** Purge emerald defaults (invoice accent `#10b981`, invoice email fonts, legacy settings/payments screens). Re-brand the marketing site later. |
| 3 | COA "hardcoded 251" vs per-tenant template (137 encoded) | **Per-tenant template is canonical.** Ship two system templates, "Merit standard (251)" and "Starter (137)", plus bring-your-own. |
| 4 | "Portfolio" language | **Owner directive wins:** use clients, companies and consolidation groups. Rename routes with redirects (`/portfolio` → `/clients`). Scrub help copy. |
| 5 | Practice features "future" vs firms as a primary tenant type | **Owner directive wins.** Practice assignment, firm cockpit and client requests move to P1 (Wave 5D). |
| 6 | Four different role sets | Ship the **owner's list** (owner, CFO, controller, finance director, accounting manager, bookkeeper, HR/payroll, operations leader, check processor, plus platform and tenant admin) as standard templates on the custom-role engine. Drop "Merit Controller". |
| 7 | Consolidation visible to admins only vs by permission | **By permission** (owner). Default it on for owner/CFO/controller templates. |
| 8 | Rev-rec 4 vs 8 vs 9 methods | **9** (engine + Posting Engine Spec). Docs updated. Onboarding groups them in plain English. |
| 9 | Auto-approve live vs auto-post OFF by default; two scoring scales | **Auto-post OFF by default.** "≥85% + trusted vendor + ≤$10k" is the *eligibility* rule once a task's autonomy dial is on. Use the composite score as the one routing scale; show the AI confidence as an explainer. |
| 10 | Fixing posted invoices: credit memo/void vs edit-with-override | **Owner's later choice:** edit with override (typed reason, reverse-and-repost). Credit memos remain for partial credits. |
| 11 | BuildSpec v4.3 status claims unreliable | Ignore spec status columns. **This register + the Completeness Ledger** are the source of truth. |
| 12 | Multi-book | Cash and tax as reporting overlays, plus dual-book depreciation (MD9 X.1). Alternate COAs and full tax books are P2, only on a customer need. |
| 13 | MeritContext planned vs "do not build" | **Retired.** Do not build. |
| 14 | Chargebacks still referenced | **Retired.** Remove the stale references in CLAUDE.md (Code Organization, Database sections) and BuildSpec tiers. |
| 15 | Pricing | Latest marketing model ($99/company for the first 5, $59 thereafter; firms $499 + wholesale; Enterprise custom). Owner to ratify in the Master-Doc amendments (task #19). |
| 16 | ACH fee uncapped vs 1% capped at $10 | **Per-merchant schedule; default ACH 1% capped at $10, card 3% no cap** (owner C-0744/C-0751). |
| 17 | Platform-fee income posted to Merit's books | **Retired (S41).** Merit books processor income from its own bank feed. |
| 18 | Inventory in Books vs MeritInventory | Keep the Books MVP (valuation + GL tie-out). Quantity depth (warehouses, lots) belongs to MeritInventory. No further Books inventory investment. |
| 19 | Customer deposits 2410 vs 2420 | **Refundable deposits and retainers → 2420; non-refundable advances / billings in excess → 2410** (as S50 built). Update MD9. |
| 20 | Year-end close assumes Dec 31, but fiscal year is configurable | Year-end close must use **each company's fiscal year end**. Verify and fix in Wave 0/1 (lead check). |
| 21 | Discovery docs disagree on build state | Defer to C-CODE-REALITY and this register. |
| 22 | Who owns the bill-pay rail (Ramp vs a MeritBooks adapter) | MeritBooks owns the AP subledger, check printing and positive pay. ACH goes through a MeritBooks disbursement adapter (bring-your-own bank or partner). Ramp bill pay only if you adopt it (decision #10). |
| 23 | SMS specified but no provider | Decision #5. Until then the chase runs on email + in-app/push; SMS is an adapter on the request engine. |
| + | Stack rankings #336–341 silently dropped from the Master Doc | **Restored** as DS-01/DS-02 (status badges, periods, rankings) in Wave 5A. |
