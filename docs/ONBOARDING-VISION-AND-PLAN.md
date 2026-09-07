# MeritBooks Onboarding — Vision, Reality, and Build Plan

*The thesis: onboarding is the product. If a firm can pour its corporate documents,
financials, and operational data in on day one and walk out with a live, tied-out book
of record — with AP, AR, debt, leases, payroll, equity, and approval rules already
configured — then MeritBooks is a fully-integrated system from the first hour, not after
a six-week implementation. This document is the plan to make that the easiest and most
comprehensive setup experience on the market.*

---

## 1. North Star

A new firm should be able to do exactly one thing — **drag every document and export
they have into one place** — and watch the system assemble itself:

- Their entities, chart of accounts, and opening balances, **tied to the penny**.
- Their customers and open invoices; their vendors and open bills.
- Their loans (with amortization schedules and covenants), leases (ROU/liability),
  fixed assets (with depreciation), prepaids, subscriptions, insurance.
- Their cap table and ownership (from the operating agreement).
- Their expense and bill-approval **policies as enforced rules**.
- Their people and the **approval chain** those rules run through.
- Their bank and card feeds, and an AP mailbox that reads incoming bills automatically.

Everything AI-proposed, human-confirmed, and posted through the deterministic engine —
never a black box. The measure of success is a single number: **cold-start-to-live time**
(from empty tenant to a balanced trial balance with subledgers tied out).

---

## 2. Where we actually are (this is the surprise: it's deep)

A full audit of the codebase found the foundation is much further along than a typical
"we need to build onboarding" starting point.

**A real 7-step first-run wizard already exists** (`app/(app)/onboarding/onboarding-wizard.tsx`):
source select → confirm/create company (auto-seeds the chart of accounts + fiscal
periods + rev-rec method) → review chart → **opening balances with a human tie-out gate
and a balanced `OPENING_BALANCE` posting** → connect bank (Plaid) → connect ERP → invite
team → launch. Completion is tracked durably and is idempotent.

**The system already ingests 26 kinds of documents and data**, almost all fully wired,
every one following the same safe pattern (*AI proposes facts → human reviews → the
deterministic engine posts*):

| Already ingested today | Becomes |
|---|---|
| Trial balance / GL history / open AR / open AP (CSV wizard + onboarding conversion) | Opening balances, tied out and posted |
| Loan agreement / promissory note | Debt instrument + amortization schedule + **covenants** |
| Lease | ROU asset + lease liability (ASC 842) |
| Vendor bill (upload **or monitored email inbox**) | AP bill (drop-and-parse) |
| Bank / card statement | Categorizable bank transactions |
| Customer contract / SOW | Invoice or recurring schedule + rev-rec suggestion |
| Capex / equipment invoice | Fixed asset + depreciation |
| Prepaid, subscription, insurance policy | Their respective schedules/registers |
| **Operating agreement / cap table** | Equity holders + consolidation ownership |
| WIP schedule (CSV or PDF) | Open jobs + WIP tie-out (over/under-billing) |
| Written **expense policy** and **bill-approval policy** | **Enforced rulesets**, not prose |
| Payroll register (PDF or CSV) | Balanced payroll journal entry |
| Vendor W-9 / COI | Vendor tax + insurance-compliance status |

That is a remarkable amount of raw-material-to-record capability already shipping.

### The gaps (what stands between today and the North Star)

1. **No corporate/legal document intake or "document vault."** No capture of EIN /
   articles of organization / operating agreement (as a legal record) / business licenses.
   The operating agreement is read *only* for equity, and nothing stores the formation
   record or the documents themselves as a permanent, searchable company file.
2. **No org chart / approval-chain ingestion.** Approval workflows must be built by hand
   in Settings. The AP-policy compiler reads a *policy* but doesn't build the *hierarchy*.
3. **No budget import.** Budgets are built in-app; there's no CSV/XLSX budget intake.
4. **No live CRM connector.** Customers come only via CSV or the AR importer.
5. **AP email is forward-only.** A webhook exists, but there's no one-click OAuth
   mailbox link (Gmail/Outlook) to turn on automatic bill reading.
6. **Opening trial balance is CSV-only** — no drop-and-parse for a PDF/image TB, even
   though every long-tail domain already has document parsing.
7. **Real ERP pull (QuickBooks/Xero/Sage) is stubbed** — only mock/fixture data flows;
   the OAuth adapters await credentials.
8. **The long-tail domains sit on an optional side board**, not in the guided flow, so a
   first-time user may never discover that they can load debt, leases, assets, and equity.
9. **The guided tour is a placeholder.**
10. **Two schema gaps** already parsed-but-not-stored: W-9 TIN/EIN + entity type, and
    COI carrier/policy detail.

---

## 3. The conjured experience — "The Intake"

Replace "a wizard you click through" with **a room you pour everything into.**

**Step 0 — The drop zone that accepts anything.** One big target: "Drop everything you
have — we'll sort it out." The firm dumps a folder: articles of org, the EIN letter, the
operating agreement, three loan notes, the lease, last month's QuickBooks trial-balance
PDF, a customer list, a vendor list, the WIP schedule, the expense policy, the org chart.
An **AI router** classifies each file and dispatches it to the right parser — the user
never has to know which uploader to use. Each becomes a proposed record in a live queue.

**The Readiness Ledger (always on screen).** A right-hand panel that fills in as documents
land: *Company ✓ · Chart of accounts ✓ · Opening balances — tie-out $0 ✓ · Customers 142 ·
Vendors 88 · Loans 3 · Leases 1 · Cap table 100% · Approval chain ✓ · Bank — connect · AP
mailbox — connect.* It is the single source of "how done am I," and it always shows the
**one next best action.**

**Confirm in a stream, not a maze.** Every proposed record is a review card: the extracted
fields on the left, the source document on the right, confidence flags on the uncertain
ones. Approve, edit, or reject. Nothing posts until confirmed. The opening balances keep
the existing **hard tie-out gate** — the firm cannot go live on books that don't balance.

**Three doors, same room.** For firms coming from QuickBooks/Xero/Sage, the same intake
offers a one-click **migration pull** instead of file drops. For firms starting fresh, it
offers guided manual entry. For everyone, the document drop zone is always there.

**Turn on the feeds.** Two switches finish the job: connect the **bank** (Plaid) and link
the **AP mailbox** (Gmail/Outlook OAuth) so bills read themselves from day one.

**Go live.** When the Readiness Ledger's required rows are green, one button flips the
tenant live and drops the user into their Inbox with real work waiting.

---

## 4. The Day-One Intake Catalog

Everything a firm can hand us, and where it lands. **Bold = gap to build.**

| Category | Artifact | Produces | Status |
|---|---|---|---|
| **Formation** | **EIN letter, articles of org/incorporation, operating agreement, licenses** | **Company legal record + document vault** | **Build** |
| Financials | Trial balance / GL history (CSV) | Opening balances (tied out) | Have |
| Financials | **Trial balance as PDF/image** | Opening balances | **Build** |
| Financials | ERP live pull (QBO/Xero/Sage) | Opening balances | Partial (stubbed) |
| AR | Customer list; open invoices; contracts/SOWs | Customers + invoices + rev-rec | Have |
| AR | **Live CRM (HubSpot/Salesforce)** | Customers | **Build** |
| AP | Vendor list; open bills; vendor bills (upload/email) | Vendors + bills | Have |
| AP | **AP mailbox OAuth link** | Auto bill reading | **Build** |
| Debt | Loan/credit agreements | Debt + schedule + covenants | Have |
| Leases / Assets | Leases; capex invoices | ROU/liability; fixed assets | Have |
| Recurring | Prepaids, subscriptions, insurance | Their schedules | Have |
| Payroll | Payroll register | Payroll JE | Have |
| Equity | Operating agreement / cap table | Equity + ownership | Have |
| Jobs | WIP schedule | Jobs + WIP tie-out | Have |
| **Governance** | **Org chart** | **Approval chain / hierarchy** | **Build** |
| Governance | Expense policy; bill-approval policy | Enforced rulesets | Have |
| **Planning** | **Budget file (CSV/XLSX)** | **Budget** | **Build** |
| Compliance | W-9, COI | Vendor tax/insurance status | Have (2 schema gaps) |
| Feeds | Bank / card | Bank transactions | Have (Plaid) |

---

## 5. Build plan — in waves

Each wave is shippable on its own and follows the house pipeline (build → security/verify
→ deploy green). Migrations go to Supabase first. Nothing here changes the posting engine.

**Wave 1 — Make the existing depth discoverable + finish the loose ends (mostly UI + small schema).**
- Fold the long-tail domains (debt, leases, assets, equity, prepaids, subscriptions,
  insurance) into the guided flow as an optional "Load your existing books" step, driven
  by the Readiness Ledger — so users actually find them.
- The **Readiness Ledger** panel itself (a live, always-on "what's next").
- Close the two parsed-but-not-stored schema gaps (W-9 TIN/EIN + entity type; COI
  carrier/policy detail).
- Opening **trial balance drop-and-parse** (PDF/image), reusing the existing conversion
  tie-out — the core flow gains the parsing the long-tail already has.

**Wave 2 — The universal drop zone + AI router.**
- One intake target that accepts any file, classifies it, and dispatches to the right
  existing parser; a unified review queue. This is the "pour everything in" experience and
  it sits on top of parsers that already exist.
- A **document vault**: every uploaded file retained, linked to the record it produced,
  and searchable (the retention plumbing already exists for parsed docs).

**Wave 3 — Corporate formation + governance intake (new parsers).**
- **Formation-document parser**: EIN letter, articles, operating agreement → a company
  legal record (legal name, entity type, formation date/state, EIN, registered agent,
  members/officers) + vault storage.
- **Org-chart / approval-chain intake**: from an uploaded org chart or a simple builder,
  generate the approval hierarchy and wire it to the existing approval-workflow engine +
  the AP/expense policy rulesets.

**Wave 4 — Turn on the feeds + planning.**
- **AP mailbox OAuth** (Gmail/Outlook) → the existing inbound-bill pipeline, one click.
- **Budget importer** (CSV/XLSX) → budgets.
- **Live CRM connector** (HubSpot/Salesforce) → customers.

**Wave 5 — Real ERP migration + the guided tour.**
- Implement the QBO/Xero/Sage OAuth adapters behind the existing framework (credential-gated).
- Replace the placeholder tour with a real, role-aware first-session walkthrough.

---

## 6. Design principles (how it stays *easy*)

- **One target, not twelve uploaders.** The user drops; the system routes.
- **Always show the one next best action.** The Readiness Ledger removes "what do I do now?"
- **Never block on the optional; always block on the wrong.** Go-live is gated on the
  tie-out (books must balance) and nothing else; every domain is optional and resumable.
- **AI proposes, human confirms, engine posts.** Every record is reviewable against its
  source document. This is already the canon — we keep it everywhere.
- **Resumable and degrade-safe.** Close the laptop, come back, pick up. AI off? Fall back
  to CSV/manual. A missing column never loses the document.

---

## 7. How we test it (proving "easiest + most comprehensive")

1. **A golden fixture packet.** Assemble one realistic firm's full document set — articles,
   EIN, operating agreement, 3 loan notes, a lease, a QBO trial-balance PDF, customer and
   vendor lists, a WIP schedule, an expense policy, an org chart, a budget. This packet is
   the reusable benchmark for every onboarding change.
2. **End-to-end browser tests** (the tooling used in this session): drive a fresh tenant
   through the intake with the fixture packet and assert the Readiness Ledger goes green,
   the trial balance balances, and each subledger ties to its control account.
3. **Tie-out assertions as the pass/fail.** The product already computes tie-out blockers;
   the test simply asserts *zero blockers* after the packet is loaded and confirmed.
4. **The cold-start-to-live stopwatch.** Instrument the time from empty tenant to
   go-live-ready. Track it release over release; it only goes down. This single number is
   the headline claim ("live in under an hour").
5. **A router-accuracy check.** For the universal drop zone, assert each fixture file is
   classified to the correct parser; misroutes are the thing to catch.
6. **Adversarial documents.** Scanned/skewed PDFs, multi-loan packages, messy CSVs with
   subtotal rows — the fixture set includes the ugly cases, because real firms' documents
   are ugly, and "comprehensive" means handling them without losing data.

---

## 8. The one metric

**Cold-start-to-live.** Empty tenant → balanced trial balance with subledgers tied out.
Everything in this plan is in service of driving that number down while widening the set
of documents a firm can simply *drop in*. That is the moat: not any single feature, but
the fact that a firm's whole paper reality becomes a live book of record in an afternoon.
