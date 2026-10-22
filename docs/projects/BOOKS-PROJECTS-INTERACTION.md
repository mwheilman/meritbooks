# MeritBooks ↔ Merit Projects — how the two interact (Books-side answer)

**From:** the MeritBooks workstream, 2026-10-21. **For:** the Projects v2 lead.
**Replies to:** `docs/projects/BOOKS-SEAM-CHANGES-FOR-PROJECTS-V2.md`.
**Owner decisions recorded here are final (Mike, 2026-10-21).**

---

## 0. Ground rule — Books stands alone

MeritBooks is a complete book of record on its own. **Many clients will never use Projects.** Nothing in Books may
require Projects to exist, be enabled, or be reachable. Everything below applies **only to a client that uses both**
(`core.organizations.entitlements.projects = true` and the client has Projects switched on).

Consequences:
- Every Books feature that Projects can feed (job costing, billing, purchase orders, dealer units, warranty, time)
  also works inside Books alone — by direct entry, import, or another connected system.
- When a client turns Projects on for a domain, Books turns **its own entry path for that domain off for that client**
  so there is exactly one master (purchase orders and dealer operations below). Turning Projects off turns Books' path
  back on. No data is lost either way.
- The seam is `core.events` only (Suite architecture). No cross-module table writes, no shared internal APIs.

## 1. Owner decisions

| Topic | Decision |
|---|---|
| **Job labor cost** (`JOB_TIME`) | **Actual payroll cost** — gross wages + employer taxes + benefits from the posted payroll run — **allocated to jobs by hours worked** (Projects time entries). A standard hourly rate may be used to estimate cost mid-period; it is **trued up to actual when payroll posts**. This is NOT the retired overhead / burden-rate engine (no shared-OpEx pool, no plug rate). Labor has one origin: the payroll post. |
| **Purchase orders** | When a client uses Projects, **Projects owns job purchase orders (commitments)**. Books does not create `purchase_orders` for job-tagged spend for that client; it matches bills to Projects commitments. Non-job POs and clients without Projects keep Books POs. |
| **Independence** | §0 above. |

## 2. Response to the seam request (`BOOKS-SEAM-CHANGES-FOR-PROJECTS-V2.md`)

Accepted in full, with these adjustments:

| Item | Books response |
|---|---|
| **Stop-gap (do first)** | Books will **reject** any `JOB_BILLING` with `schema_version > 1` (and any unknown event type) with an `error_code`, instead of ignoring keys, so "Waiting on Merit Books" is accurate. |
| A1 exactly-once | Partly live already (migrations 167/170, 2026-10-21): atomic claim with lease, finalize only while holding the claim, one invoice per `core.events` row (`invoices.source_event_id` unique), GL `source_ref='core.events:<id>'`. Books will **add your business key** too: `invoices.source_ref` unique per org = `payload.source_ref`, so a re-emitted billing (new event id) still can't create a second invoice. |
| A2 one invoice path | Agreed — the consumer becomes a thin adapter over the standard invoice creator (AR by role, per-line revenue, sales tax, retainage, customer terms, invoice events). |
| A3 retainage | Agreed as written: bill = DR AR (net) + DR Retainage receivable / CR revenue-or-deferred (gross earned). Release = DR AR / CR Retainage receivable, no revenue. Books then sets `entitlements.books_seam_version = 2`. |
| A4–A6 rev-rec | Agreed. As-of actuals and billed-to-date come from the GL; one method resolver in canon order; progress snapshots pinned by `(job, snapshot_version)`; loss provision when EAC > contract. |
| A7 re-tag after close | Agreed: `job_id` / `cost_code_id` immutable once the period is HARD_CLOSE. |
| A8 close vs seam | Agreed: hard close is blocked by pending/rejected seam events for that client + period. |
| `JOB_DEPOSIT_REQUEST` | Agreed, but it runs through **Books' existing customer-deposits feature** (one way to hold and apply deposits), deduped on `source_ref`. |
| `JOB_COMMITMENT` | Agreed (non-posting AP match target; honors `payment_hold`; default bill retainage; no Books PO rows) per §1. |
| `JOB_COST` (Books → Projects) | Agreed: richer keys; emitted from every job-tagged cost path. |
| `JOB_TIME` | Per §1 (actual payroll allocated by hours). Books owns the cost; Projects owns the hours. |
| Scheduling | Books' cron will call `pm.run_seam_cycle(null)` after the Books event workers — **only for orgs entitled to Projects**. (Cron needs `CRON_SECRET` set in Vercel.) |

Books-side order: stop-gap → A1–A3 (billing correct) → deposits + commitments → A4–A8 → `JOB_TIME`.

### Status of the Books side (migration 173, 2026-10-21 — built, not yet applied)

Stop-gap, A1–A3 and `JOB_DEPOSIT_REQUEST` are built (`lib/services/billing-consumer.ts`, `lib/services/deposit-request-consumer.ts`,
`lib/events/seam.ts`). Ack columns Books writes on the event row: `status`, `invoice_id`, `invoice_number`, `gl_entry_id`,
`processed_at`, and on rejection `error = '<CODE>: <message>'` + `error_code` (new column); extra ids in `ack_meta` (new column;
`deposit_id` for a deposit request). GL entries carry `source_ref = 'job_billing:<payload.source_ref>'` /
`'job_deposit:<payload.source_ref>'`. 173 sets `entitlements.books_seam_version = 2` for Projects orgs (and keeps it set when
Projects is switched on later).

### Open questions for Projects

1. **Final billing marker.** Books applies collected deposits at the job's final invoice. Today it infers "final" the way
   `pm.guard_final_billed` does (gross billed ≥ `core.jobs.contract_amount_cents`, pinned by `JOB_PROGRESS`). Please add an
   additive `is_final: true` to the final `JOB_BILLING` (Books already honours it).
2. **`lines[].cost_code_id`** is a `pm.cost_codes` id; Books' `invoice_lines.cost_code_id` references `job_cost_codes`, so Books
   does not store it on the invoice line (it stays in the event payload). Agree a mapping if Books should report billing by cost code.
3. **Negative STANDARD lines** are rejected (`INVALID_AMOUNT`) — a reduction is a credit memo in Books. Confirm Projects never emits them.
4. **Sales tax.** Books computes tax on STANDARD lines from the customer's jurisdiction, so the invoice total can exceed Projects'
   `net_cents`. Show Books' invoice total (read it from Books) rather than `net_cents` as the amount due.
5. **Rejection codes.** `error_code` values: `UNSUPPORTED_SCHEMA_VERSION`, `UNSUPPORTED_EVENT_TYPE`, `UNSUPPORTED_BILLING_SUBTYPE`,
   `UNSUPPORTED_LINE_TYPE`, `MISSING_SOURCE_REF`, `NO_BILLABLE_LINES`, `INVALID_AMOUNT`, `RETAINAGE_TIE`, `GROSS_TIE`,
   `COMPANY_NOT_FOUND`, `NO_CUSTOMER`, `NO_FISCAL_PERIOD`, `PERIOD_CLOSED`, `ACCOUNT_UNRESOLVED`, `PARTIAL_INVOICE`,
   `INVOICE_FAILED`, `GL_POST_FAILED`, `DEPOSIT_FAILED`, `CONSUMER_ERROR`. Projects may read `error_code` directly.
6. **Event types.** `JOB_COMMITMENT`, `JOB_TIME`, `JOB_MATERIAL`, `JOB_PAYABLE_REQUEST` stay `pending` until Books builds them; any
   other unknown type from Projects is rejected `UNSUPPORTED_EVENT_TYPE`. `JOB_PROGRESS` v2 is still accepted by the existing
   consumer (A6 not yet built) — not version-gated in this slice.

## 3. Dealers — Projects replacing the dealer system (c-Systems etc.)

Owner direction: **Merit Projects should replace c-Systems** (the dealer management system) for dealer clients.
Today the Projects `equipment_dealer` pack runs the **service shop** and says "whole-goods deals and floor plan stay in
Books and the dealer system". To replace the dealer system, Projects needs the operational side of a dealership;
Books keeps the money side. Books' Dealer Pack (`docs/FPB-dealer-pack.md`, `docs/dealer-pack-api.md`, migration 169)
already works **without** Projects (data comes from imports of the dealer system's exports) — that stays.

### 3.1 Who owns what when a dealer uses both

| Area | Projects (operations master) | Books (money master) |
|---|---|---|
| Units (whole goods) | Receiving, serial/VIN, make/model/year, PDI/setup, location, status (in stock / demo / rental / sold), photos, customer-owned equipment & service history | Cost basis in the GL, floor-plan note per unit, aging for accounting, write-downs |
| Floor plan | Shows floored / paid-off status and payoff due (read from Books) | Lenders, lines, programs, notes, interest, curtailments, payoffs, lender statement reconciliation, sold-out-of-trust detection |
| Sales desk | Quotes, deals, trade appraisals, F&I products, delivery | Deal invoice, AR, deposits applied, sales tax, trade-in booking, over-allowance, lien payoff |
| Parts | Parts catalog, bins, counter tickets, special orders, OEM parts ordering, physical counts | Parts inventory value in the GL, COGS, AP for OEM parts invoices |
| Service | Repair orders, tech time, PDI, internal ROs on new units | Customer-pay revenue, internal RO cost added to unit cost, labor cost (actual payroll by hours, §1) |
| Warranty | Files claims with the manufacturer, tracks claim status | Warranty receivable, matching manufacturer credits, short-pays, write-offs |
| Manufacturer incentives | Applies rebates/programs on deals | Incentive receivable, accounting treatment, collection |
| Rentals | Rental contracts, check-out/in | Rental revenue, rental fleet depreciation |

When a dealer client has Projects on, Books' Dealer Pack **imports for units, deals, parts and warranty claims are
switched off for that client** (one master); floor plan, lender statements and manufacturer statements stay in Books.

### 3.2 Events Projects → Books (all carry `source_ref`, `schema_version`, client `location_id`)

| Event | When | Books does |
|---|---|---|
| `DEALER_UNIT_RECEIVED` | Unit checked in against a manufacturer invoice | Creates/links the Books unit, cost from the invoice; proposes flooring if the program says floored |
| `DEALER_UNIT_COST` | Freight, setup/PDI labor, accessories added | Adds to unit cost basis |
| `DEALER_UNIT_STATUS` | Demo, rental, transfer, return to manufacturer | Updates accounting status; flags lender rules (e.g., demo still floored) |
| `DEALER_DEAL_FINALIZED` | Deal delivered | Deal invoice + full deal entry (price, trades, rebates, fees, tax, deposits); proposes floor-plan payoff (a person releases) |
| `DEALER_DEAL_UNWOUND` | Deal cancelled after posting | Reversing entries; reopens floor-plan note if needed |
| `DEALER_TRADE_RECEIVED` | Trade taken in | Used unit at the lower of appraisal and allowance; over-allowance; lien payoff to track |
| `DEALER_PARTS_SALE` | Counter ticket closed | Parts revenue, COGS, sales tax |
| `DEALER_RO_CLOSED` | Repair order closed | Customer-pay revenue; internal RO cost to the unit; warranty portion → warranty claim receivable |
| `DEALER_WARRANTY_CLAIM` | Claim submitted / status changes | Warranty receivable; status changes inform matching |
| `DEALER_WARRANTY_REGISTRATION` | Unit registered with the manufacturer | Feeds sold-out-of-trust detection (lenders use these dates) |
| `DEALER_RENTAL_BILLED` | Rental invoiced | Rental revenue |

### 3.3 Events Books → Projects

| Event | Projects does |
|---|---|
| `DEALER_FLOOR_STATUS` (per unit: floored / paid off, payoff due date, amount) | Shows on the unit and the deal; warns before delivery if a payoff is due |
| `DEALER_SOT_ALERT` (sold, not yet paid off) | Surfaces on the deal/unit; manager notification |
| `DEALER_WARRANTY_PAID` (credited / short-paid / rejected with amount) | Updates claim status |
| Event acks (`status`, `invoice_id`, `gl_entry_id`) | Same pattern as billing acks; "Waiting on Merit Books" when pending |

### 3.4 What to move out of c-Systems (for the Projects migration)

Units in stock (serial, make/model/year, cost, received date, lender + note number if floored, status) · open
quotes/deals · customers and the equipment they own (with service history) · parts inventory (part #, bin, on-hand,
cost, price) and price books · open repair orders · open warranty claims · rental fleet and open contracts · manufacturer
(vendor) accounts. Books needs from the same export only what ties the GL: unit cost and floor-plan notes (to reconcile
to the lender), open warranty/incentive receivables, and parts inventory value.

### 3.5 Lenders and manufacturers are setup data

No lender or manufacturer is hard-coded anywhere. Each client adds its own lenders (e.g., a bank term note, and
whole-goods floor-plan lenders), programs (free-floor days, rate, curtailment schedule) and manufacturers in setup.

## 4. Shared mechanics (both directions)

Exactly-once (claim + business-key dedupe), `schema_version` with explicit rejection of unknown versions, ack columns on
the event row, a visible "waiting" state on the sender, pending-age alarm, and hard close blocked by an unprocessed
backlog for that client and period. Payload shapes for §3 to be agreed in the Projects dealer blueprint before either
side builds them.
