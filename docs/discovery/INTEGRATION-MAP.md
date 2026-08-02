# MeritBooks — External-Systems / Integration Map

**Owner:** Integration architect (discovery panel) · **Status:** Analysis/spec — no code changes.
**Reconciled against repo:** 2026-08-01, `main` (post–Session 42). Build-state in every row is
verified against the live tree, not asserted from memory.

## 0. Why this document exists

Discovery enumerated MeritBooks' AI capabilities and per-segment features, but **integrations were
only ever mentioned incidentally, inside a segment** (Plaid under Banking, Stripe under AR, Azure
under AP intake, Resend under Invoices). No one assembled the *external-systems layer as its own
provable surface*. This doc is that layer: every system MeritBooks should connect to, its direction,
contract, cadence, failure posture, the AI role at the seam, and what is actually built.

This is a **book-of-record** integration map, and that framing constrains everything below (canon
`CANON-ANCHOR.md` §1–2):

- **Books OWNS the general ledger.** External accounting systems (QBO/Sage/Xero) are **one-time
  migration import sources only** — never live sync-back. There is no "push journal entries to
  QuickBooks" seam and there never will be. After migration Books is authoritative.
- **Books owns the ledger, NOT the business objects.** Customer / Vendor / Item / Employee / Entity
  are `core`-schema master data referenced by FK. An inbound integration that creates a customer
  writes `core`, not a Books-private copy.
- **The AI gateway is Merit Core-owned, not Books-owned.** No module holds an Anthropic key or calls
  the model directly; every AI call at every seam is supposed to route through `@meritbooks/core-ai`,
  meter to `core.ai_usage_log`, and count against the **combined-suite tenant budget** (§2, §5 GATE 1).
- **Regulated custody is pushed to the provider.** Check custodies payroll PII, Stripe custodies KYC,
  Plaid custodies bank credentials. Books holds **opaque handles + amounts**, never the raw secret or PII.

---

## 1. Integration architecture pattern (where connectors live)

MeritBooks is a **modular monolith on one Postgres with three ownership zones** (Suite Core / Books /
reserved namespaces) — there is no database-per-module and no internal API boundary (canon §1). That
shapes where a connector is allowed to live:

**a) The capability-adapter boundary (money movement).** Money-movement providers are hidden behind
**one interface per capability** in `apps/web/src/lib/money/providers/types.ts`:
`Capability = 'AR_COLLECTION' | 'AP_DISBURSEMENT' | 'PAYROLL' | 'BANK_FEED'`. Concrete adapters
(`plaid.ts`, `stripe.ts`, payroll `check.ts`/`mock.ts`, …) implement exactly one capability and are
**selected per-tenant at runtime from `core.provider_connections`**. The rule enforced by the comment
at the top of that file: *no provider SDK type, webhook shape, or identifier may leak above this
boundary* — that is what keeps providers swappable without touching ledger / reconciliation / approval
/ audit / UI. A connected provider does **not** by itself enable a capability — the tenant must also be
**entitled** (`core.organizations.entitlements`, a Core ruling; see `lib/money/connections.ts`).

**b) Secret placement — Vault vs Vercel env (canon §2, verified in the adapters).** Two distinct
storage classes, and the split is deliberate:
- **Per-tenant secrets → Supabase Vault**, referenced by `core.provider_connections.secret_ref`
  (migration `041_provider_connections.sql`), read server-side only via `lib/money/secrets.ts`.
  Examples: each Plaid **Item `access_token`** (per bank login), each tenant's **Check API key**,
  a tenant's connected-account handle. The returned `ProviderConnection` object *never* includes the
  secret value.
- **Platform-wide runtime keys → Vercel environment variables** (not Vault; Vault is per-tenant only).
  Examples: `STRIPE_SECRET_KEY` (the single platform key that acts on behalf of every connected
  account), `PLAID_CLIENT_ID`, and the Plaid **platform** secret (`PLAID_SECRET`, or preferably a Vault
  ref `PLAID_SECRET_REF` — `plaid.ts` reads Vault first, env second). Stripe is constructed with the
  **fetch HTTP client** (avoids stale keep-alive sockets on Vercel serverless) and its destination-charge
  `payment_intent.*` events fire on the **platform account**, so the webhook listens there (canon §2).

**c) The email/provider-agnostic pattern (outbound comms + doc ingestion).** `lib/email/provider.ts`
defines an `EmailProvider` interface with two implementations planned — `resend` (live, deliverability)
and `ms_graph` (spec, for GATE 4 mailbox ingestion). Callers never import Resend directly. Failure
posture is explicit: `send` **throws** on provider failure and never reports success-on-failure (the
documented anti-pattern that produced "invoice marked SENT that never left the building").

**d) The Suite internal event bus (Books ↔ other modules).** Not an *external* system but the most
important seam: cross-module state moves over **`core.events`, contract FROZEN v3** — `JOB_COST`
(Books→Projects), `JOB_BILLING` + `JOB_PROGRESS` (Projects→Books), unique `(org_id, event_id)`,
consumed by the `/api/events/*` workers behind `authorizeEventWorker` (canon §2). New event types get
new names; **an existing shape is never mutated**.

**e) The import pipeline (one-time migration).** `lib/import/definitions.ts` + `lib/import/csv.ts`
route CSV rows to the correct zone: **master data → `core`** (entities/customers/vendors/items),
**ledger data → Books/`public`** (trial balance, open AR, open AP, GL history). This is the *only*
sanctioned path from a legacy accounting system, and it is **file-based, not a live API**.

**Governing constraint:** because there is no internal API boundary, a connector is just a module of
the monolith — but the **reserved shared spine is single-threaded through the lead** (migrations,
`packages/shared`, `api-handler`, `navigation`, `rbac/permissions`). A new integration that needs a
table/column/entitlement/permission **stops and reports it**; it never invents schema (CLAUDE.md §0.1).

---

## 2. The external-systems layer (enumerated)

Legend for **Build-state**: **BUILT** = wired to a real provider and live/near-live · **PARTIAL** =
adapter/scaffold present, not production-proven · **SPEC** = interface/contract defined, no working
connector · **NONE** = identified need, nothing in repo.

### 2.1 Banking & cash

| System / category | Direction | Purpose | Auth model | Data contract (objects/fields) | Cadence | Failure / reconciliation | AI role at the seam | Build-state |
|---|---|---|---|---|---|---|---|---|
| **Plaid** (BANK_FEED) | Inbound feed | Bank/CC transaction feed + balances for categorization & bank rec | Platform `client_id`+secret (env/Vault); **per-Item `access_token` in Vault** on `core.provider_connections` | `AccountBase` (balances, mask, type) + `Transaction` (amount, date, merchant, pending) → normalized domain shape in `plaid.ts`; mapped to internal accounts via `plaid/map` | Webhook + `plaid/sync` cursor pull | Cursor-based sync is resumable; pending→posted reconciled on next pull; `plaid/diag` health route | **AI categorizes the bank feed** (composite vendor/amount/date score; ≥90% auto, 70–89% review, <70% flag) | **BUILT** (GATE 12.0, live) |
| **Direct bank / BAI2 / prior-day file** | Inbound feed | Bank-native statement/balance file for banks not on Plaid, or treasury-grade cash positioning | SFTP + bank agreement (per-tenant Vault) | BAI2 type codes → normalized transactions + BAI balance records | Batch (daily prior-day file) | Duplicate-file detection; per-account balance tie-out to feed | AI maps BAI2 type codes → GL accounts; anomaly flag on balance breaks | **NONE** |
| **ACH / wire origination** (AP_DISBURSEMENT) | Outbound push | Actually *move* money out for approved bills / disbursements | Provider API key per-tenant (Vault); provider (Increase/Modern Treasury/Melio class) is regulated party | `ApDisburser` interface (create disbursement, status, cancel) — objects: payee handle, amount cents, rail, memo | Webhook (settlement/return) | Return codes (R01…) reconciled; preparer≠approver + explicit human release already enforced upstream (`checks/run` only QUEUES) | AI never releases money; AI proposes the check-run batch, human approves/releases | **SPEC** (`ApDisburser` interface only; no adapter — `checks/run` prepares approvals, no rail) |
| **Positive pay** | Outbound push | Send issued-check register to bank so unmatched checks are rejected (fraud control) | SFTP/API per bank (Vault) | Issued-check file: check #, payee, amount, issue date, void flag | Batch (on each check run) | Bank exception report ingested back; mismatches → exception queue | AI reconciles bank exceptions vs issued register; flags anomalies | **NONE** |
| **Lockbox** | Inbound feed | Bank receives/scans customer paper checks → remittance file for AR cash application | SFTP per bank (Vault) | Lockbox remittance: check amount, customer ref, invoice #(s), image URL | Batch (daily) | Unapplied cash suspense; short/over-payment handling | **AI cash application** — matches remittance to open invoices (CASH_APPLICATION detector already exists detect-only) | **NONE** (detector exists; no lockbox feed) |

### 2.2 Card & expense

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **Stripe Connect** (AR_COLLECTION) | Bidirectional | Customer "Pay Now" (card + ACH) on AR invoices; hosted KYC | **Platform `STRIPE_SECRET_KEY` in Vercel env**; per-tenant `acct_…` handle on `core.provider_connections`; Express onboarding via Account Links | Out: PaymentIntent (amount, invoice metadata). In (webhook on platform acct): `payment_intent.succeeded/processing`, fee, payout id → PAID + balanced GL | Webhook (realtime) | **Resume-safe idempotency; migration 064 UNIQUE indexes make the DB the double-post guarantor**; `payment_intent.processing` handled | AI does not touch settlement; realized processor fee read from `invoice_events` meta (coded fee path RETIRED) | **BUILT** (GATE 12.1, live) |
| **Corporate-card feed (direct issuer / network)** | Inbound feed | Daily card-transaction feed for categorization when card runs through Plaid-less issuer | Issuer API/file (Vault) | Card txn: amount, MCC, merchant, last4, cardholder | Batch/webhook | Statement-total tie-out; **settlement posts to Credit Card Payable (liability), never cash** (canon §3) | AI categorizes card lines (same engine as bank feed); MCC → GL hint | **PARTIAL** (a `/credit-cards` feed UI + Credit Card Payable posting exist; no dedicated issuer connector — rides Plaid) |
| **Ramp / Brex / Expensify** (spend & receipts) | Inbound feed | Corporate-card spend + captured receipts + memos as pre-coded expense transactions | OAuth or API key per-tenant (Vault) | Transaction + receipt image + user-entered memo/GL hint + policy flags | Webhook/batch | Dedup vs bank/card feed (same charge two sources); policy-violation flag | AI reconciles spend-tool coding vs its own proposal; OCR on attached receipt; surfaces disagreements | **NONE** |
| **Receipt capture** (mobile/email) | Inbound feed | Employee receipts → matched to card/bank lines | App session (Clerk) | Uploaded image/PDF → parsed vendor/amount/date/tax | On upload | Unmatched-receipt queue; match to bank line by amount+date | **AI parses the OCR output** (`receipts/categorize`) and proposes GL coding + match | **BUILT** (`/receipts`, `receipts/submit` + `receipts/categorize`) |

### 2.3 Payroll & HR

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **Payroll provider (Check / Gusto / ADP — provider-agnostic engine)** | Bidirectional | Run payroll; provider is the regulated party (computes gross-to-net, files taxes, custodies PII) | **Per-tenant API key in Vault** via `core.provider_connections.secret_ref`; per-tenant company handle | `PayrollEngine` contract (provider-agnostic): employees (opaque handles), pay-run input, gross-to-net result, funding status. Books holds **handles + amounts only** | Provider webhook on run status; release is the only money step | Fails GRACEFULLY with `PayrollProviderNotConfiguredError` if creds absent; **releaser≠preparer + double-post guard** = Phase B (gated on provider pick) | **AI validates the payroll-to-GL post** — balanced `entry_type='PAYROLL_RUN'`; AI never releases funds | **PARTIAL** (GATE 12.3 Phase A: engine + **Mock** live + **Check** adapter scaffold w/ TODOs vs live sandbox; provider not yet picked) |
| **Benefits / carriers** | Inbound feed | Deductions & employer contributions into payroll + GL | Via payroll provider or carrier API (Vault) | Deduction/contribution lines per employee per run | Batch (per run) | Tie deduction totals to remittance to carrier | AI validates deduction↔GL mapping | **NONE** |
| **Time / scheduling** | Inbound feed | Hours → gross pay inputs | **Lives in the separate PM module**, arrives via `core.events`, not a Books external connector | (PM-owned) | Event | — | — | **N/A to Books** (canon §2: in-app time tracking retired here; PM owns it) |

### 2.4 Tax & compliance

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **Sales-tax engine (Avalara / TaxJar class)** | Bidirectional | Real-time rate/jurisdiction calc on invoices; return filing | API key per-tenant (Vault) | Out: line address + amount + tax code. In: tax amount, jurisdiction breakdown | Realtime (calc) / batch (filing) | Rate-service outage → fallback table + flag; return-vs-collected reconciliation | AI already runs **EC-7 sales-tax-nexus** detection (detect-only); would validate calc vs booked tax liability | **NONE** (nexus *detector* exists; no rate/filing engine) |
| **1099 e-file (IRS FIRE / IRIS + state)** | Outbound push | Transmit 1099-NEC/MISC to IRS/states at year-end | TCC / transmitter creds (platform, secure) | 1099 records: payee TIN, address, box amounts | Batch (annual) | IRS acceptance/reject file ingested; TIN-match failures queued | AI drives **1099/W-9 readiness** (detect-only exists) → TIN validation, box classification | **PARTIAL** (`compliance/1099` + readiness detector; **no e-file transmit**) |
| **Income-tax / provision (tax prep handoff)** | Outbound push | Trial balance / tax package to CPA or provision engine | Export (CSV/API) | Adjusted TB, book-tax differences, M-1 items | Batch (annual/quarterly) | Export reconciled to filed return | AI proposes book-tax adjustments, drafts M-1 schedule | **NONE** |
| **Secretary of State / registered agent** | Inbound feed | Entity good-standing, annual-report deadlines, registered-agent status | API (CT/Corp class) or scrape | Entity status, filing due dates, jurisdiction | Batch (periodic) | Deadline-miss alerting | AI monitors deadlines, drafts filings | **NONE** |

### 2.5 Document intelligence & ingestion

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **Microsoft 365 Graph — email-to-bill ingestion** | Inbound feed | Monitored mailbox → inbound vendor bills/receipts auto-created | Azure app registration (OAuth client-credentials); tenant mailbox consent | Message + attachments (PDF/image) → parsed bill draft | Webhook (Graph subscription) / poll | **BLOCKED on IT returning Azure creds since Session 22**; `ms_graph` is the planned 2nd `EmailProvider` | AI parses inbound doc → bill draft (`bills/intake`, `bills/parse`) | **SPEC / BLOCKED** (GATE 4; `EmailProvider` interface reserves `ms_graph`) |
| **Azure Document Intelligence / OCR (dedicated)** | Inbound (service) | High-fidelity OCR/layout on scanned invoices where LLM vision is insufficient | Azure key (platform/Vault) | Document → structured fields (vendor, line items, totals, tax) | Sync (per doc) | Low-confidence → human review queue | Complements LLM parse; AI reconciles OCR fields vs LLM extraction | **SPEC / BLOCKED** (GATE 4 — creds) |
| **LLM vision bill/receipt parse (interim OCR)** | Inbound (service) | Current document-intelligence path via Claude vision | `ANTHROPIC_API_KEY` | PDF/image base64 → structured invoice JSON (`bill-parser.ts`) | Sync (on upload, ≤10MB) | Bad file-type/size rejected; parse-fail surfaced | **AI parses the OCR output** — vendor/lines/totals/tax extraction | **BUILT** ⚠️ **but bypasses the Core AI gateway** (calls Anthropic directly — see Finding F1) |

### 2.6 e-Signature & document storage

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **DocuSign / e-sign class** | Bidirectional | Signed W-9s, vendor agreements, engagement letters | OAuth per-tenant (Vault) | Envelope (doc + signer) out; completed PDF + audit cert in | Webhook (envelope status) | Envelope-status reconciliation; expiry re-send | AI pre-fills W-9 fields; validates returned doc completeness | **NONE** (vendor-compliance chases W-9/COI today by email, not e-sign) |
| **Box / Google Drive / SharePoint** | Bidirectional | Source-document storage & retrieval (bill/receipt/contract backup) | OAuth per-tenant (Vault) | File + metadata; link stored on the transaction | Webhook/on-demand | Missing-doc detection vs posted transaction | AI classifies/files uploaded docs; links to GL entry | **NONE** (docs currently in Supabase Storage; SharePoint reachable only via M365 GATE 4) |

### 2.7 Migration & source accounting systems (one-time import ONLY)

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **QBO / Sage / Xero — CSV migration** | Inbound (one-time) | Seed `core` master data + Books opening balances from a legacy system. **Books OWNS the GL after — no sync-back** | File upload (Clerk session) | Master → `core` (entities/customers/vendors/items); Ledger → `public` (trial balance, open AR, open AP, GL history). `import/definitions.ts` maps + validates | Batch (one-time cutover) | Trial-balance debits=credits enforced; grouped GL history balanced per entry; per-field validation | AI auto-maps CSV columns → fields (alias matching); flags unmapped/ambiguous | **BUILT** (CSV pipeline; `/import`) |
| **QBO / Sage / Xero — direct API import** | Inbound (one-time) | Same, but pull via provider API instead of CSV export | OAuth per source (transient) | Same object set as CSV, richer | Batch (one-time) | Same tie-out | AI maps source COA → Books COA template by role | **NONE** (CSV only today) |

### 2.8 CRM, procurement, BI/warehouse, Suite bus, AI gateway

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **CRM / customer master (Salesforce/HubSpot class)** | Bidirectional | Customer master sync; invoice/payment status back to CRM | OAuth per-tenant (Vault) | `core.customers` ↔ CRM account; AR status out | Webhook/batch | Dedup + survivorship on customer master | AI dedupes/merges customer records; entity resolution | **NONE** |
| **Procurement / PO systems (3-way match)** | Inbound feed | PO + receiving → matched against vendor bill | API/file per system (Vault) | PO, receipt, bill → 3-way match | Batch/webhook | Price/qty variance → exception queue | AI performs 3-way match, flags variances (BILL_ANOMALY detector adjacent) | **NONE** (GATE 11b — PO/3-way, not yet built) |
| **BI / warehouse export (Snowflake / BigQuery / CSV / API)** | Outbound push | Ship GL/report data to a tenant's warehouse/BI | Per-tenant warehouse creds (Vault) or signed API | Fact/dimension export: GL entries, dims, balances | Batch (scheduled) / API pull | Row-count + control-total reconciliation | AI generates semantic layer / NL-to-query over the export | **NONE** (report CSV/PDF export exists for humans; no warehouse connector) |
| **Merit Suite internal event bus** (`core.events`, FROZEN v3) | Bidirectional | Books ↔ Projects (and future modules) state exchange | In-DB (RLS + `authorizeEventWorker`); no external auth | `JOB_COST` (Books→Projects), `JOB_BILLING` + `JOB_PROGRESS` (Projects→Books); unique `(org_id, event_id)` | Event (near-realtime workers) | Idempotent unique key; per-event org posting; worker read-scoping still open (canon §5) | AI consumes JOB_PROGRESS for rev-rec timing; validates event→GL post | **BUILT** (FROZEN v3; `/api/events/*`) |
| **Core AI gateway** (`@meritbooks/core-ai` → Anthropic) | Outbound (service) | The **single** model-provider integration for the whole suite | API key **passed in by host, never read from env in the provider**; server-only | Standard request/response; entitlement → runaway guards → budget (feature→user→tenant) → meter tokens→cents → `core.ai_usage_log` | Sync per call | Over hard cap → degrade/block per overage policy; concurrency + rate guards | **This IS the AI seam** — every other row's "AI role" is supposed to transit here | **BUILT** (GATE 1) ⚠️ **but several Books routes bypass it — Finding F1** |

### 2.9 Communications

| System / category | Direction | Purpose | Auth model | Data contract | Cadence | Failure / reconciliation | AI role | Build-state |
|---|---|---|---|---|---|---|---|---|
| **Resend (transactional email)** | Outbound push | Invoice delivery, reminders, AR statements | Platform API key (env); `INVOICE_FROM_EMAIL` per-tenant sender | `EmailMessage` (to, subject, html, text, attachments incl. invoice PDF) → `SendResult` | On-demand (send/remind/statement) | **Throws on failure — never success-on-failure**; caller records SENT only on real success | AI drafts collections/reminder copy; AR-timing decisions | **BUILT** (`resend` `EmailProvider`) — ⚠️ needs key rotation + `INVOICE_FROM_EMAIL` set (open task) |
| **SMS (Twilio class)** | Outbound push | Payment reminders / approval nudges by text | Provider key (Vault/env) | Message: to, body, link | On-demand | Delivery-receipt handling; opt-out | AI decides channel/timing (email vs SMS) | **NONE** (settings UI exposes SMS notification prefs; **no SMS provider wired**) |

---

## 3. Build-state rollup (verified against the tree)

- **BUILT (real provider, live/near-live): 8** — Plaid, Stripe Connect, Resend, Core AI gateway,
  CSV migration import, receipt capture + parse, LLM-vision bill parse, Suite event bus.
- **PARTIAL (scaffold/adapter, not production-proven): 4** — Payroll (Check adapter scaffold + Mock),
  corporate-card feed (rides Plaid; Credit Card Payable posting), 1099 (readiness detector, no e-file),
  and the money-out `ApDisburser` boundary (interface + queued check-run, no rail).
- **SPEC / BLOCKED: 3** — M365 Graph email-to-bill, Azure Document Intelligence OCR (both GATE 4,
  blocked on Azure creds), direct-API QBO/Sage/Xero import.
- **NONE (identified need, nothing in repo): ~15** — BAI2/direct bank, ACH/wire origination adapter,
  positive pay, lockbox, Ramp/Brex/Expensify, benefits carriers, sales-tax engine, income-tax handoff,
  Secretary-of-State, DocuSign, Box/Drive/SharePoint, CRM, procurement/PO, BI/warehouse export, SMS.

**~30 external systems enumerated across 9 categories.**

### Findings surfaced during verification
- **F1 (governance drift — highest).** Canon §2 requires **every** AI call to route through
  `@meritbooks/core-ai` (metered, budget-enforced across the suite). Verified: the *services*
  (`je-composer`, `exception-ai`, `categorization`) go through the gateway, but **seven route handlers
  read `ANTHROPIC_API_KEY` directly** — `receipts/categorize`, `bank-feed/categorize`,
  `journal-entries/compose`, `categorize`, `bills/parse`, `bills/intake`, `posting/predict`. These AI
  seams are **un-metered and un-budgeted**. Route them through the gateway.
- **F2.** The money-out capability (`AP_DISBURSEMENT`) is **interface-only** — `checks/run` prepares
  approvals but no rail exists. Any "MeritBooks pays your bills" claim is not yet real.
- **F3.** SMS appears in the settings UI as a notification preference but **has no provider** — a
  dangling promise to close or wire.

---

## 4. Priority-ranked "connect next" (tied to gates)

1. **Azure Document Intelligence + M365 Graph email-to-bill** — *unblocks GATE 4 (AP OCR / inbox
   ingestion).* Single dependency: **IT returns Azure creds** (blocked since Session 22). This is the
   highest-leverage AI seam — it turns "upload a bill" into "bills arrive and post themselves." The
   `EmailProvider` + `bills/intake` scaffolding is already waiting for it.
2. **Pick the payroll provider (Check vs Gusto) → finish the Check adapter** — *unblocks GATE 12.3
   Phase B* (releaser≠preparer, double-post guard, live sandbox). The engine + Mock + Check scaffold
   exist; only the provider decision + live creds are missing (open owner decision, task #32).
3. **Route the 7 direct-Anthropic seams through `@meritbooks/core-ai` (Finding F1)** — not a new
   vendor, but the **integration-correctness** fix that makes every AI seam metered and budget-bound
   per canon §2. Cheap, high-governance-value, and a prerequisite to trusting per-tenant AI cost.
4. **AP disbursement rail (Increase / Modern Treasury / Melio class) behind `ApDisburser`** — *closes
   GATE 8 money-out.* The capability interface, per-tenant Vault secret model, and preparer≠approver
   check-run already exist; this is "implement one adapter," and it makes the book of record able to
   actually move money out, not just record it.
5. **Sales-tax engine (Avalara/TaxJar class)** — *feeds GATE 11d (sales-tax).* The EC-7 nexus detector
   already tells tenants they *have* a tax obligation; a rate/calc/filing connector lets Books *honor*
   it at invoice time instead of just flagging it after the fact.
6. **Lockbox + AI cash application feed** — *completes GATE 8 AI cash application.* The
   `CASH_APPLICATION` detector is built detect-only; a lockbox/remittance inbound feed gives it real
   remittance data to auto-apply against open AR — a headline autonomous-workforce win.

*(Deliberately below the line for now: direct-API QBO/Sage import (CSV covers cutover), BI/warehouse
export, CRM, DocuSign, SMS, positive pay — real but not gate-blocking. 3-way-match/PO rides GATE 11b.)*
