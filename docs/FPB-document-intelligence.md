# FPB — Document intelligence: classify every document and route its content to the right module

Status: **DRAFT for owner approval** · Migration **188** · Owner request (2026-10-24):
"when I add any document to the document management center or during the wizard onboarding, it should use AI to
figure out if that document needs linked to any other relevant page and the relevant content should be inserted into
that linked page. i.e., the lease tab says no leases but there is a lease under the doc management tab. But AI never
linked or extrapolated the content."

Governing: canon §3 ("AI proposes facts; the deterministic engine does the accounting; a human approves" — nothing
posts to the GL from this feature), canon §2 (AI only through `runAiGateway`, metered to `core.ai_usage_log`),
migrations 090/112 (documents + bucket), 163 (client-scope RLS), 171/172 (member read-only business tables,
service-role writes after the route's check), 180 (vendor document submissions; W-9 images are not sent to AI by
default — decision D6), FPB-onboarding (Smart Intake), FPB-ap-intake (AP drafts in `ai_decisions`).

## 1. Purpose
Documents today are inert. A lease dropped in the Documents center stays "Other / Unfiled" and the Leases page says
"No leases yet". This brief makes every document that lands without a home **read, typed, and routed**: the system
works out what it is, which company it belongs to, who the other party is and its key dates, runs the module's
**existing** extractor, and puts a **proposal** in front of the person who owns that module — "1 lease found in your
documents — review". The person accepts (the module's own review form opens pre-filled and its own create path
finalizes), changes the type, links it to a record that already exists, or dismisses it. Every link is two-way.

## 2. Personas
- **Owner / controller** (report density) — drops files anywhere; expects them to show up where they belong.
- **Bookkeeper / AP clerk** (cockpit density) — works the "Needs review" list; accepts proposals into modules.
- **Auditor** — follows a record to its source document and back.

## 3. Benchmark (named deltas)
| | QBO | Sage Intacct | Ramp / Bill.com | Docyt / Booke | **MeritBooks (this brief)** |
|---|---|---|---|---|---|
| Classify any upload | Receipts/bills only | No (attach only) | Bills & receipts | Bills, receipts, statements | **16 classes: lease, loan, policy, COI, W-9, bill, contract, PO, bank/card statement, payroll register, fixed-asset invoice, subscription, formation, tax doc, 1099, budget (+ other)** |
| Works when AI is down | n/a | n/a | Queues | Queues | **Deterministic name + text-layer rules classify immediately; AI retry job every 15 min** |
| Routes content into the module | Bill draft only | No | Bill draft | Bill draft | **Proposal in the module's own review flow (lease, debt + covenants, insurance, prepaid, subscription, fixed asset, customer contract, AP intake draft, vendor W-9/COI submission)** |
| Two-way links | Attachment only | Attachment only | Bill ↔ file | Bill ↔ file | **`document_links`: document → records and record → documents, with "AI" or "you" provenance** |
| Duplicate protection | Weak | n/a | Hash on bills | Partial | **SHA-256 of the bytes: the same file never produces a second lease / loan / bill** |
| Backfill | No | No | No | No | **"Analyze existing documents" — one click (and the job) for everything already stored** |

## 4. Vocabulary (`document_intelligence.doc_class`)
`lease · loan · insurance_policy · coi · w9 · vendor_bill · customer_contract · purchase_order · bank_statement ·
card_statement · payroll_register · fixed_asset_invoice · subscription · formation · tax_document · form_1099 ·
budget · prepaid · ledger_report · other`.
`formation` covers articles / operating agreement / cap table / EIN letter. `tax_document` covers returns and
notices. `ledger_report` covers trial balance / GL / agings (onboarding importers).

## 5. Routing table (class → module, mode, existing extractor, accept permission)
| Class | Target kind | Mode | Extractor (existing, via `runAiGateway`) | Lands in | Accept needs |
|---|---|---|---|---|---|
| lease | `lease` | staged | LEASE_EXTRACT `parseLeaseDocument` | `/leases` review form pre-filled → `POST /api/leases` | journal_entries:create |
| loan | `debt_instrument` | staged | DEBT_EXTRACT `parseLoanDocument` (incl. covenants) | `/debt` | journal_entries:post |
| insurance_policy | `insurance_policy` | staged | INSURANCE_EXTRACT `parsePolicyDocument` | `/insurance` | journal_entries:create |
| prepaid | `prepaid` | staged | PREPAID_EXTRACT `parsePrepaidDocument` | `/prepaids` | journal_entries:create |
| subscription | `subscription` | staged | SUBSCRIPTION_EXTRACT `parseAgreementDocument` | `/subscriptions` | invoices:create |
| customer_contract | `customer_contract` | staged | CONTRACT_EXTRACT `parseContractDocument` | `/invoices` (contract import) | invoices:create |
| fixed_asset_invoice | `fixed_asset` **and** `bill` | staged + native | ASSET_EXTRACT `parseAssetInvoice` + AP provider | `/fixed-assets`, `/bills/intake-queue` | fixed_assets:create / bills:create |
| vendor_bill | `bill` | native | AP_DOC_INTAKE `createDocIntakeDraft` | `/bills/intake-queue` (its own approve) | bills:create |
| coi | `vendor_coi` | native when the vendor matches | COI_EXTRACT via `runAiCheck` | `/vendor-compliance` review | vendors:edit |
| w9 | `vendor_w9` | native when the vendor matches | none (W-9 images stay with a person, D6) | `/vendor-compliance` review | vendors:edit |
| payroll_register | `payroll_register` | route | (module importer) | `/payroll` | payroll:create |
| bank_statement / card_statement | `bank_statement` | route | (module importer needs the account) | `/bank-feed` | bank_feed:edit |
| formation | `formation` | route | (onboarding formation reader) | `/onboarding` | settings_acct:edit |
| budget | `budget` | route | (budget importer) | `/budgets` | settings_acct:edit |
| purchase_order / tax_document / form_1099 / ledger_report / other | `filed` | route | none | kept on file, typed | audit_trail:view |

**staged** = the extractor's output is stored on the proposal in the module's own parse-response shape; the module
page shows it and opens its own review form pre-filled. **native** = the module already has a staging queue (AP intake
drafts, vendor document submissions); the draft is created there and the proposal tracks it. **route** = the
document is typed and linked to the page; nothing is extracted by this feature.

## 6. Data model (migration 188)
- `public.document_intelligence` — one row per document: class, confidence, class source (ai | rules | user),
  suggested company (`location_id` + source), counterparty, key dates (jsonb), amount (bigint cents), summary,
  reason, content SHA-256, duplicate-of, status, AI state (pending | done | unavailable | failed | budget_blocked |
  skipped), attempts, next retry, last error, model, decision id, source (center | onboarding | email | portal |
  backfill), reviewer.
  Status: `queued → classified → routed | proposal_created → accepted | linked`; or `needs_review`, `dismissed`,
  `duplicate`.
- `public.document_proposals` — one row per (document, target kind): mode, status (pending | accepted | dismissed |
  superseded | failed), extract state (done | pending | failed | not_needed), payload (jsonb), title, summary,
  native table/id, target href, accepted target type/id, decided by/at/note. UNIQUE (org, document, target kind) and
  partial UNIQUE (org, content SHA-256, target kind) while pending/accepted → the same bytes never make a second lease.
- `public.document_links` — document ↔ (target_type, target_id), link kind (source | supporting), created via
  (ai | user | module), proposal id, label. UNIQUE (org, document, target type, target id).
- RLS: members SELECT their org; service role writes (the route checks permissions first, org pinned); anon nothing;
  client-scope RLS re-applied (`location_id`). No new functions (M1). PGlite-compatible. No GL effect.

## 7. Behaviour
1. **On upload** (Documents center `POST /api/documents`, onboarding `POST /api/onboarding/intake/file`):
   a `document_intelligence` row is written at once with the deterministic classification (file name + PDF text
   layer / sheet header / plain text) and the SHA-256. Documents created by a module's own drop-and-parse flow
   (entity_type set, e.g. `lease`, `bill`, `receipt`, `inbound_email`) are already routed by that module and are not
   re-proposed; records they are linked to (entity_id set) get a `document_links` row on backfill.
2. **Analyze** (`POST /api/documents/intelligence/analyze`): reads the bytes from the private bucket (path must be
   inside the org: `{org}/…` or `intake/{org}/…`), classifies through the gateway (feature `DOCUMENT_CLASSIFY`),
   merges with rules, suggests the company (only company → it; the onboarding company; a company name found in the
   text/AI answer; else none), then runs the routing table. Same SHA-256 as an earlier document → `duplicate`, no new
   proposal.
3. **AI down** (no key, org disabled, 401/403/429/529, budget block, parse failure): the rules result stands. If the
   rules are confident (≥ 0.6) the document is routed / a proposal is created with `extract_state = pending` ("We
   think this is a lease — AI will read the terms when it's back"); otherwise `needs_review`. Either way
   `next_retry_at` is set (15 min; 60 min for budget blocks; backoff after failures; max 6 attempts) and the job
   `documents.classify_retry` (every 15 min) retries.
4. **W-9 protection**: a document the rules type as a W-9 at ≥ 0.8 is never sent to AI (classification or extraction).
5. **Accept**: from the center ("Open in Leases") or the module banner ("Review") the module's review form opens with
   the proposal's fields; the module's create path validates and creates the record; then
   `POST /api/documents/proposals/{id}/accept {target_type, target_id}` verifies the record exists in the org, marks
   the proposal accepted, writes the link, and stamps the document's `entity_type/entity_id`. Native drafts sync
   lazily: an AP draft APPROVED with a bill → proposal accepted + link to the bill.
6. **Change type** re-routes (pending proposals of the old kind → superseded). **Link to existing record** writes a
   user link and marks the document linked. **Dismiss** stops proposals for the document (a reason is optional).
7. **Backfill** ("Analyze existing documents" + the job's sweep): every eligible document without an intelligence
   row is registered and analyzed, oldest first, 25 per call, idempotent.

## 8. UI (merit-ui v2.3)
- **Documents center** (`/documents`, rebuilt on merit-ui, cockpit density): bands *All · Needs review · Proposals ·
  Linked · Unfiled*; per row: type tag (AI tag when AI typed it), confidence meter, company, linked records ("Lease:
  Office – 123 Main"), status word; actions: Open proposal in module, Change type, Link to existing record, Dismiss,
  View, Download, Delete (confirm). Header: "Analyze existing documents" with a result line; an `AiPaused` notice when
  AI is down ("Typed by rules; AI will re-read N documents").
- **Onboarding Smart Intake**: after "Save to company documents" the card reads e.g. "We found a lease — added to
  Leases for your review." (or "Kept on file — we'll read it when AI is back").
- **Target modules** (leases, debt, insurance, prepaids, subscriptions, fixed assets, invoices): a "From your
  documents" banner lists pending proposals ("1 lease found in your documents — review"), each with the file, AI
  confidence, summary and Review / Dismiss; Review opens the module's own review form pre-filled with a "From
  document: <file>" line. The banner shows on the empty state too.

## 9. Acceptance criteria (testable)
- AC1 A PDF named `20240912122602102.pdf` whose text layer contains "LEASE AGREEMENT … Lessor … Lessee … Premises" is
  classed `lease` by rules alone (no AI) with confidence ≥ 0.6.
- AC2 With no text and an uninformative name, rules return `other` at 0 → status `needs_review`, `ai_status`
  unavailable when no key, `next_retry_at` set.
- AC3 Analyzing the same document twice creates exactly one `lease` proposal (idempotent).
- AC4 A second document with identical bytes is marked `duplicate` (duplicate_of = first) and creates no proposal.
- AC5 Accept writes one `document_links` row (document → lease), sets the proposal accepted and the document's
  entity link; listing links by (lease, id) returns the document, and by document returns the lease.
- AC6 AI-down path: gateway throws "organization disabled" → rules result kept, `ai_status=unavailable`, retry
  scheduled; the retry job re-analyzes only due rows and creates the proposal once AI answers.
- AC7 Company: an org with one company → that company; with several, a company name found in the text is chosen;
  the proposal carries that `location_id` (client-scope RLS hides it from members outside that company).
- AC8 Accept permission is per target (lease → journal_entries:create, bill → bills:create, …); a caller without it
  gets 403 and nothing changes.
- AC9 A W-9 by rules (≥ 0.8) never calls the gateway.
- AC10 Backfill registers and analyzes every eligible document without an intelligence row; module-originated
  documents (entity_type set) are not proposed; documents already linked (entity_id) get a link row.
- AC11 Migration 188 replays in PGlite; every new table has RLS on and no member write grant.
- AC12 Nothing in this feature inserts into `gl_entries` / `gl_entry_lines`.

## 10. Out of scope / later
OCR for scanned PDFs without a text layer when AI is down (the AI read covers them when it is up); per-module
"accept without review" autonomy dial; customer-portal uploads (none exist yet); extracting multiple leases from one
document (the first is proposed; the review form shows the note).
