# MeritBooks — Product Feature Overview

**Purpose:** the single, honest source a homepage-building session can trust. Every feature below is
tagged **[LIVE]** (a real screen/route + backing code is shipped), **[IN-PROGRESS]** (partial,
detect-only, adapter-scaffold, or gated on an external decision/credential), or **[PLANNED]**
(identified need, no code yet). When in doubt we downgraded — a homepage built on vaporware is worse
than a modest one.

**Grounded in:** `apps/web/src/lib/navigation.ts` (every shipped sidebar screen), the `(app)/` and
`api/` route trees, `docs/discovery/AI-CAPABILITY-MATRIX.md`, `COVERAGE-MATRIX.md`, `INTEGRATION-MAP.md`,
the session-44 handoff + `CANON-ANCHOR.md`, and `git log` feat commits through session 44.
**Reconciled:** 2026-08-02 (post–Session 44).

---

## 1. Positioning (one paragraph)

MeritBooks is an **AI-native, multi-tenant book of record** — it *owns* the general ledger rather than
automating on top of QuickBooks or Sage (those are one-time migration import sources, never a live
sync-back). On one shared Postgres schema it unifies what businesses today stitch together from a stack
of separate tools: **core accounting + close, FP&A + budgeting, fixed assets + intangibles + leases,
expense/T&E, AP automation with 3-way match, AR/collections, revenue recognition, debt & covenant
monitoring, multi-entity consolidation, and AI bookkeeping**. The operating model is consistent
everywhere: **the AI proposes a fact or a draft, a deterministic engine does the accounting
(debits must equal credits, direction derived from account type), and a human with the right role
approves anything that moves money or changes the book** — with every AI action and human decision
written to an audit log and every model call metered per tenant. It is Module 1 of 12 in the Merit
Enterprise Suite and is built generic for white-label resale, not hardcoded to any one customer.

---

## 2. Accounting Features

### General Ledger & Close
- Double-entry general ledger with DB-enforced balance (debits = credits) and six posting triggers — **[LIVE]**
- Journal entries with a natural-language composer (AI drafts, engine posts, human approves) — **[LIVE]**
- Chart of accounts (per-tenant seed template, role-not-number account resolution) — **[LIVE]**
- Fiscal periods with OPEN / SOFT_CLOSE / HARD_CLOSE enforcement per location/month — **[LIVE]**
- Close Management + real-time Close Command Center + Year-End Close — **[LIVE]** (command center is closer to a live checklist than a full per-workstream state machine — depth still maturing)
- Audit trail / action log on every posting and approval — **[LIVE]**

### AP / Bills & Procurement (incl. 3-way match)
- Bills with AP subledger, approval routing, and posting to AP (never re-expensed on payment) — **[LIVE]**
- AP intake queue — drop a bill/PDF, AI reads vendor/lines/totals/tax into a draft — **[LIVE]** (via LLM-vision parse; high-fidelity Azure OCR + monitored-mailbox auto-ingestion are **[IN-PROGRESS]**, blocked on Azure creds)
- Purchase orders + goods receipts + 3-way match (PO ↔ receipt ↔ bill) — **[LIVE]**
- Vendors master + vendor compliance (W-9 / COI auto-chase, drop-and-parse intake) — **[LIVE]**
- Check run — prepares/queues approved disbursements (preparer ≠ approver) — **[LIVE]**; actual money-out rail (ACH/wire origination) — **[PLANNED]** (interface defined, no adapter)

### AR / Invoicing / Collections
- Invoices with drawer, recurring invoices, credit memos, void/write-off, PDF + email delivery — **[LIVE]**
- Contract/SOW drop-and-parse → proposed invoice + rev-rec setup — **[LIVE]**
- Cash application — human-approved apply path + AR subledger ↔ GL tie-out — **[LIVE]**
- Collections workflow with dunning cadence + AR aging / DSO — **[LIVE]**
- Customer payments via Stripe ("Pay Now", card + ACH) → PAID → balanced GL — **[LIVE]**

### Bank & Cash / Reconciliation
- Bank feed (Plaid) with AI categorization, confidence scoring, batch approve — **[LIVE]**
- Credit-card feed → Credit Card Payable posting — **[LIVE]** (rides Plaid; dedicated issuer connector **[PLANNED]**)
- Bank statement PDF drop-and-parse for non-Plaid accounts — **[LIVE]**
- Reconciliation with AI-drafted adjusting entries + "must-tie-to-zero-to-close" gate — **[LIVE]**
- Cash position dashboard — **[LIVE]**

### Revenue Recognition
- Books-owned rev-rec, method-per-job (9 methods), deferred-revenue posting (credits 2410 not Revenue) — **[LIVE]**
- Cutoff / revenue-not-recognized detection near close — **[LIVE]** (detect-only by design)
- AI method selection / over-time %-complete validation — **[PLANNED]** (engine stays deterministic by design)

### Fixed Assets & Intangibles
- Fixed-asset register with depreciation methods (straight-line, declining-balance/150DB, SYD, units-of-production), disposal gain/loss, roll-forward — **[LIVE]**
- Capex invoice drop-and-parse → proposed asset record — **[LIVE]**
- Intangible assets + amortization (reuses the asset register) — **[LIVE]**

### Leases (ASC 842)
- Lease drop-and-parse → ROU asset + lease liability + amortization schedule — **[LIVE]**
- Lease depth: modifications, CPI/index resets, early termination — **[LIVE]**

### Debt & Covenants
- Debt register + amortization with loan-document drop-and-parse — **[LIVE]**
- Debt depth: variable-rate resets, refinance, payoff — **[LIVE]**
- Covenant monitor (DSCR / FCCR / leverage) — ledger-computed headroom, forecast-projected breach date, AI-drafted compliance certificate — **[LIVE]**
- Covenant extraction from loan documents (drop-and-parse) — **[LIVE]**

### Payroll
- Payroll register import → balanced payroll JE (drop-and-parse) — **[LIVE]**
- Provider-agnostic payroll engine + Mock adapter live + Check adapter scaffold — **[IN-PROGRESS]** (Phase A)
- Embedded run → post → remit → file (Phase B) — **[IN-PROGRESS]/[PLANNED]** (gated on provider pick: Check vs Gusto)

### Tax
- Book-to-tax M-1 / M-3 difference tagging + Schedule M-1 reconciliation — **[LIVE]**
- Tax depreciation (MACRS) feeding book-vs-tax to M-1 — **[LIVE]**
- Sales-tax return prep — per-jurisdiction liability worksheet + GL tie-out + nexus cross-reference — **[LIVE]**
- Sales-tax nexus tripwire detector — **[LIVE]** (detect-only); real-time rate/calc/filing engine (Avalara/TaxJar class) — **[PLANNED]**
- 1099-NEC generation — records, branded Copy B PDFs, filing-service e-file — **[LIVE]**; direct IRS FIRE/IRIS transmit — **[IN-PROGRESS]** (filing-service dependent)
- 1099 readiness + W-9/TIN validation — **[LIVE]**

### Multi-entity Consolidation (eliminations & NCI)
- Consolidated financials across entities — ownership %, non-controlling interest, booked eliminations (GATE 11a) — **[LIVE]**
- Intercompany + internal (inter-department) invoices with elimination on consolidation — **[LIVE]**
- Intercompany-balance detector — **[LIVE]** (detect-only)
- FX / currency translation — **[PLANNED]**

### Prepaids & Insurance
- Prepaid-expense amortization — schedule, propose, post by role — **[LIVE]**
- Insurance policy register (drop-and-parse) — **[LIVE]**

### Expense Management
- Employee expense reports + corporate-card reconciliation (receipt → report → reimburse) — **[LIVE]**
- Receipt capture + AI parse + GL coding + match to bank/card line — **[LIVE]**
- Out-of-policy / expense-policy detection — **[PLANNED]**

### Subscriptions / Spend
- Subscription catcher — recurrence detection, creep guard, keep/cancel workflow, agreement parse — **[LIVE]**
- Renewals & Obligations — unified calendar aggregating leases/debt/insurance/subscriptions/contracts — **[LIVE]**

### Budgeting / FP&A
- Budgets — entry grid, budget-vs-actual, workspace — **[LIVE]**
- Driver-based budgeting + rolling reforecast — **[LIVE]**
- 13-week direct cash forecast — **[LIVE]**
- Scenario / what-if planning, headcount & rev-driver models — **[IN-PROGRESS]** (drivers live; full scenario modeling still thin)

### Reporting / Board Packages
- Financial statements — B/S, P&L, cash flow, equity, AP/AR aging, WIP, job-cost (21 report routes, all RLS-scoped) — **[LIVE]**
- Board-ready financial package + notes generator with branded PDF export — **[LIVE]**
- Profitability / entity profitability — **[LIVE]**
- Jobs & Projects + Job WIP schedule (EAC cost-to-complete, WIP over/under-billing) — **[LIVE]**
- Retainage tracking — **[LIVE]**

### Onboarding & Migration
- CSV migration import (QBO/Sage/Xero → `core` master data + opening balances) with AI column mapping — **[LIVE]**
- Historical conversion pipeline — AI-mapped opening TB + human tie-out gate + balanced go-live post — **[LIVE]**
- Direct-API import from QBO/Sage/Xero — **[PLANNED]** (CSV only today)

---

## 3. AI Features (by modality)

Trust posture is uniform: **AI proposes → deterministic engine posts → human with the right role
approves; every action is audited to `action_log`/`ai_decisions`; every model call is metered per
tenant through the Core AI gateway.** Auto-post is OFF by default; autonomy is a per-tenant, per-task dial.

### Document extraction — "drop-and-parse everywhere" (M1)
- Drop a document and AI reads it into a proposed record — bills, receipts, capex→asset, W-9/COI,
  bank/CC statement PDFs, loan/covenant docs, customer contracts/SOWs, payroll registers, insurance
  policies, leases, debt, subscription agreements — **[LIVE]** (propose→confirm through the gateway)
- High-fidelity Azure Document Intelligence OCR + monitored-mailbox (M365) auto-ingestion — **[IN-PROGRESS]** (blocked on Azure creds; the LLM-vision path works today)

### Categorization + learning/memory (M2, M14)
- Bank-feed / receipt / bill AI categorization with confidence scoring (≥90% auto, 70–89% review, <70% flag) — **[LIVE]**
- Vendor→GL coding memory — learns each tenant's approved coding over time — **[LIVE]** (metered, audited); broader per-entity/per-firm personalization — **[PLANNED]**

### Anomaly & fraud / control exception library (M4)
- Detect-only exception detectors, each riding `ai_decisions → /exceptions`: duplicate-payment,
  anomalous-JE, uncategorized-leakage, intercompany-balance, missed-accruals, revenue-not-recognized,
  cutoff-errors, sales-tax-nexus, bill-anomaly, cash-application — **[LIVE]** (detect→triage, audited)
- Payment-run fraud screen + duplicate-pay blocking gate at release — **[LIVE]** (blocks, not just flags)
- `scoreToTier` → actual auto-post/queue disposition wiring — **[IN-PROGRESS]** (adoption/disposition recorded; full tiering-governs-disposition still maturing)

### Forecasting & prediction (M5)
- 13-week direct cash forecast — **[LIVE]**
- Covenant breach-date projection — **[LIVE]**
- EAC / cost-to-complete job forecast — **[LIVE]**
- Driver-based rolling reforecast — **[LIVE]**

### Narrative / explanation on statements (M7)
- AI flux/variance auto-narrative on P&L, cash flow, and budget-vs-actual (deterministic driver
  computation, AI writes the story) — **[LIVE]**
- Per-object "explain-this-X" (JE, bill, invoice, rec item, payment) — **[PLANNED]** (decision-log infra exists; object-level UX not yet)

### Conversational NL command bar + FP&A copilot (M8)
- Universal NL command bar (global ⌘K) with intent router — **[LIVE]**
- Safe NL→ledger analytical lane — allowlisted metric catalog, no model-authored SQL, explicit abstain path — **[LIVE]** (read-only, grounded)
- NL processing lanes P2–P4 (categorize / draft-bill / draft-invoice) — **[LIVE]** (propose→approve)

### Search / knowledge / retrieval (M13)
- Plain-English "find anything" semantic search over the ledger — **[LIVE]**
- Full grounded+cited knowledge spine over contracts/policies/GAAP Q&A — **[IN-PROGRESS]/[PLANNED]** (the search lane is the first slice; full retrieval spine is the largest remaining structural gap)

### Autonomy dial + kill-switch control plane (M10)
- Autonomy & Kill-Switch Control Plane — per-tenant/per-task dial, materiality thresholds, kill switch — **[LIVE]**
- Per-feature disposition adoption recorded on every control-exception proposal — **[LIVE]**

### Agentic workflows (M9)
- NL processing lanes are the first supervised propose→approve loops — **[LIVE]** (narrow)
- Named end-to-end agentic loops (AP run, morning-cash, order-to-cash, pay-run, close-run) — **[PLANNED]**

### Governance note
All AI routes are metered/budget-capped through `@meritbooks/core-ai`; the 7 route handlers that once
called Anthropic directly have been routed back through the gateway (session-44). Per-tenant AI spend is
therefore trackable and cappable — **[LIVE]**.

---

## 4. The AI-native Differentiators (why this isn't "QuickBooks plus a chatbot")

1. **One owned schema, one query.** Ledger, subledgers, vendors/customers, jobs, assets, debt, and
   AI decisions live on one Postgres — so an operational question and a ledger question are answered
   from the same source of truth, not reconciled across a stack of integrations.
2. **Every manual entry becomes drop-a-document-and-parse.** Bills, receipts, contracts, leases, loans,
   payroll registers, insurance, capex, W-9s, bank statements — the default data-entry motion across
   the whole product is "drop the document, approve the parse," not keying rows.
3. **AI proposes, a deterministic engine posts, a human approves — all audited and metered.** The AI
   never writes debits/credits directly; the balance-enforcing engine does the accounting and a
   right-role human approves anything touching money or the book. Nothing is a black box.
4. **A real autonomy dial + kill switch, per tenant and per task.** Auto-post is off by default;
   trust is earned task-by-task and can be pulled back instantly — segregation of duties binds the AI
   itself, not just people.
5. **Portfolio / multi-entity by design.** Multi-tenant RLS, ownership %, NCI, booked eliminations,
   intercompany, and consolidated reporting are core, not an add-on — built for holding companies and
   multi-client firms rather than a single set of books.

---

## 5. Competitive Positioning

MeritBooks' thesis is **unification on an AI-native, owned ledger**: the categories below are typically
bought as separate products and reconciled by hand. Positioning is by **category coverage + the
unified-ledger/AI-native angle** — we do not assert unverifiable specifics about competitors' internals.

| Category | Representative tool(s) | MeritBooks covers it? | The MeritBooks angle |
|---|---|---|---|
| Core accounting / GL (SMB) | QuickBooks Online | **Yes — live** | Owns the GL with the same double-entry rigor, but AI-native and multi-entity from the ground up |
| Core accounting / GL (mid-market) | Sage Intacct | **Partial → Yes** | Multi-entity consolidation, dimensions, and close are live; ecosystem/marketplace maturity is where Sage still leads |
| AI-native bookkeeping | Puzzle, Digits, "Double" | **Yes — live** | Same "AI does the data entry" promise, but on an owned ledger with propose→approve + audit, not a categorization layer over someone else's books |
| FP&A / budgeting / forecasting | Datarails, Jirav | **Partial** | Driver-based budgeting, rolling reforecast, 13-week cash, covenant forecasting, flux narrative are live; deep scenario modeling is still maturing |
| Fixed-asset tracking | Asset Panda | **Yes — live** | Full asset register with 4 depreciation methods, disposal, roll-forward, MACRS/book-tax — and it posts straight to the GL it lives on |
| Expense / T&E | SAP Concur | **Partial** | Expense reports, receipt capture+parse, corporate-card reconciliation are live; travel booking and policy-enforcement depth are not |
| AP automation | Bill.com | **Partial** | Drop-and-parse intake, 3-way match, approval routing, check-run prep are live; the outbound payment rail (money-out) is not yet wired |
| Corporate spend / cards | Ramp, Brex | **Partial / Planned** | Card feed + Credit Card Payable posting + subscription/spend catcher are live; issuing cards and a native spend platform are not the product |
| Revenue recognition | (Sage/NetSuite modules) | **Yes — live** | Books-owned ASC 606 rev-rec, 9 methods, method-per-job, deferred-revenue handling |
| Multi-entity consolidation | (Sage Intacct / FloQast class) | **Yes — live** | Ownership %, NCI, booked eliminations, intercompany; FX translation still planned |
| Migration source (not a competitor) | QuickBooks, Sage, Xero | **Import only** | These are one-time migration import sources — MeritBooks owns the ledger after cutover, no live sync-back |

### Where competitors are still ahead (be honest in marketing)
- **QuickBooks / Sage ecosystem maturity** — years of third-party app marketplaces, accountant
  networks, bank/payroll integrations, and edge-case coverage MeritBooks has not accumulated.
- **Concur's travel booking + policy engine** — MeritBooks does expense capture and reconciliation,
  not corporate travel booking or a deep policy-enforcement suite.
- **Datarails' spreadsheet-native UX** — finance teams that live in Excel get a native spreadsheet
  surface there; MeritBooks' FP&A is app-native and still maturing on scenario modeling.
- **Bill.com / Ramp / Brex money movement** — those actually move money and issue cards today;
  MeritBooks records and prepares disbursements but its outbound payment rail is not yet live.
- **Payroll providers (Gusto/ADP/Check)** — MeritBooks posts payroll and is provider-agnostic by
  design, but does not itself compute gross-to-net or file taxes; a provider is still being chosen.

---

## 6. Status Legend + Caveat

- **[LIVE]** — shipped to the app, backed by real Supabase queries and posting code, with a screen in
  the sidebar (or a live sub-flow). Verified against `navigation.ts`, the route trees, and feat commits.
- **[IN-PROGRESS]** — partial, detect-only (by design or otherwise), adapter-scaffold, or gated on an
  external decision/credential (e.g. payroll provider pick, Azure OCR creds, IRS e-file transmit).
- **[PLANNED]** — an identified need in the discovery matrix with no shipped code yet.

**Caveat:** this reflects the build **as of the Session-44 handoff (2026-08-02)**. LIVE means shipped to
the running app for the first tenant. **Standing up a second production tenant still requires completing
the identity / RBAC multi-tenant org-resolution gate (open gate #9), the Clerk production instance, and
per-tenant secret setup (Resend key rotation + `INVOICE_FROM_EMAIL`, provider connections).** Marketing
copy should describe capabilities as they exist in the product, and should not promise a self-serve
second-tenant signup until that identity/SSO + secret setup is closed.
