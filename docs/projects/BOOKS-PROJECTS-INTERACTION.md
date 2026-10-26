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
6. **Event types.** `JOB_MATERIAL`, `JOB_PAYABLE_REQUEST` stay `pending` until Books builds them; any other unknown type from
   Projects is rejected `UNSUPPORTED_EVENT_TYPE`. `JOB_COMMITMENT` v1, `JOB_TIME` v1 and `JOB_PROGRESS` v1/v2 are consumed as of
   part 2 (migration 194); other versions are rejected `UNSUPPORTED_SCHEMA_VERSION`.

### Part 2 — commitments, labor, A4–A8 (migration 194, 2026-10-26 — built, not yet applied)

Code: `lib/projects-seam/*` (commitments, commitment-match, job-time, labor-allocate, labor-allocation, labor-accrual,
job-po-block, status), `lib/rev-rec/{method,as-of-inputs}.ts`, `lib/services/{job-progress,rev-rec}.ts`,
`lib/close/seam-close-signal.ts`, `lib/parties/match.ts`, `lib/scheduler/jobs/projects-seam-jobs.ts`. Screens:
`/jobs/projects-seam`, `/customers/duplicates`, `/vendors/duplicates`; "Already in Merit" on the new-customer / new-vendor forms.

**Testable criteria** (each is a test in `apps/web/src/test/projects-seam-part2.test.ts` or a pure suite next to the code):

| # | Criterion |
|---|---|
| S2-1 | A `JOB_COMMITMENT` snapshot creates one AP match target per Projects commitment (`ap_commitments` + lines + a version row), acked `processed` with `ack_meta {commitment_id, version, bills_held, bills_released}`; no `purchase_orders` row is ever created. |
| S2-2 | A higher `version` replaces the target; an equal or lower version is acked `superseded: true` and changes nothing (the version guard is in the UPDATE itself). |
| S2-3 | `CLOSED` / `VOID` retire the target (`active = false`, `retired_at`); existing matches stay, no new auto-match. |
| S2-4 | A bad snapshot is rejected with an `error_code` (`INVALID_PAYLOAD`, `INVALID_AMOUNT`, `MISSING_SOURCE_REF`, `JOB_NOT_FOUND`, `VENDOR_NOT_FOUND`, `COMPANY_NOT_FOUND`, `UNSUPPORTED_SCHEMA_VERSION`); nothing is written. |
| S2-5 | A line absent from a newer version is kept (bills may be matched to it) and marked `removed`. |
| S2-7 | Bill entry: a job line from a vendor with exactly one open commitment line for that job is AUTO-matched (or the one whose cost type matches); otherwise the line is left for a person and the open lines are offered (`GET /api/ap/commitments`). |
| S2-8 | An explicit pick that is not an open commitment of that vendor + job is refused (422). |
| S2-9 | With no retainage % given, the bill defaults to the commitment's `retainage_pct` (fraction → percent). |
| S2-10 | `payment_hold` is honoured like `ON_HOLD`: matched open bills (PENDING / APPROVED / SCHEDULED / PARTIALLY_PAID) go `ON_HOLD` with "Projects commitment {number} is on payment hold: {reason}"; a new bill against it lands `ON_HOLD`; when Projects releases the hold the bills return to their prior status (only bills this commitment held). |
| S2-11 | 3-way status per matched line: `OVER_COMMITTED` (billed > committed), `BILLED_OVER_RECEIVED` (a PO with receiving in use billed beyond received), `NO_RECEIPT`, else `OK` — re-scored whenever a new version moves amounts / receipts. Warnings, never blocks. |
| S2-12 | `JOB_COST` from a matched bill line carries the additive keys `commitment_line_id` (the Projects line id), `vendor_id`, `cost_code` / `cost_code_id`; the frozen key set is unchanged when absent. |
| S2-13 | G14: a job-tagged Books PO line is refused for a Projects org (API 409 `JOB_PO_OWNED_BY_PROJECTS` with a link to Projects; DB trigger `guard_job_po_projects`); non-job POs and Books-only orgs are unaffected. |
| S2-14 | `JOB_TIME` APPROVED records hours once per `(source_ref, revision)` (re-delivery is a no-op); it never posts. Hours must be > 0 and ≤ 24 per entry (`INVALID_HOURS`). |
| S2-15 | `UNAPPROVED` withdraws that revision; if payroll already costed it the posted entry stands and the row is surfaced as "withdrawn after payroll". |
| S2-16 | When a payroll run posts, each employee's ACTUAL cost (gross + employer tax + employer benefits) is allocated to the jobs they worked in the pay period by approved hours: denominator = max(paid hours, job hours); largest-remainder split per component, so jobs + "not on a job" = payroll cost to the cent. One reclass: DR `JOB_LABOR_COST` (5000) per job / CR `WAGES_EXPENSE`, `PAYROLL_TAX_EXPENSE` (+ `HEALTH_INSURANCE_EXPENSE` for employer benefits). |
| S2-17 | The reclass ties to the payroll JE: wages / tax expense keep exactly the paid time not on a job; `JOB_COST` CLEARED (LABOR, gate TIMESHEET_PAYROLL) goes back per job × cost code; hours with no payroll line are reported as unallocated hours, never costed at a guessed rate. |
| S2-18 | Idempotent per payroll run (`job_labor_allocations` UNIQUE per run + GL `source_ref payroll_labor:<run>`); a failed allocation is retried by the cron. |
| S2-19 | Optional standard-rate accrual (per company, off by default): DR `JOB_LABOR_COST` / CR `ACCRUED_EXPENSES` at the JOB_TIME `cost_rate_cents` (else the employee's hourly rate); the payroll that pays those hours reverses exactly what was accrued, so the job ends at actual and accrued expenses at 0; the accrual's `JOB_COST` rows are VOIDED. |
| S2-20 | A4: rev-rec inputs come from the books as of the date (`public.job_inputs_as_of`): cost = opening + posted job-tagged COGS / OPEX (WIP / rev-rec entries excluded); billed = opening + posted invoice subtotals (deposits, retainage releases excluded); contract / estimate / % = the newest pinned snapshot ≤ as-of. Used by the JOB_PROGRESS path AND the month-end WIP engine (one path). |
| S2-21 | A6: `JOB_PROGRESS` v2 pins `(job, snapshot_version)` atomically; a re-delivery is a no-op; an older version is history only (never overwrites); each snapshot recognizes its own incremental delta (no "already recognized" rejection). |
| S2-22 | A negative delta relieves the job's 1180 first, then books 2410; when EAC > contract the anticipated loss is provided (the WIP engine's own math, posted as a `REV_REC_WIP` entry the month-end run adjusts over). |
| S2-23 | A7: `job_id` (GL lines, bill lines) and `job_id` / `cost_code_id` (job_cost_entries) cannot change once the period is `HARD_CLOSE` (`JOB_TAG_LOCKED`). |
| S2-24 | A8: close task `projects_seam_settled` (blocking) — Projects → Books messages dated ≤ period end that are pending, or rejected without a later processed message with the same business key, block the hard close for that company; a read error fails closed; Books-only orgs pass. |
| S2-25 | Projects off → `JOB_COMMITMENT` / `JOB_TIME` are released untouched, bill planning and labor allocation are no-ops. |
| A5 | One method resolver (`lib/rev-rec/method.ts`): override → revenue type → legacy job-type map → company default, used by billing (`resolveBillingRevRecMethod` delegates), the JOB_PROGRESS path and the WIP engine. |
| Door | "Already in Merit": the new-customer / new-vendor forms and the CSV import call `core.match_parties` (1111) before create; an EXACT match is offered (Use existing / Create anyway → `create_anyway: true`); the shared duplicate review queue is at `/customers/duplicates` and `/vendors/duplicates`. Works with or without Projects. |

**For the Projects lead**

1. *Ties to Books — commitments and time can stop being `pending`.* Books now records what those checks need, exposed as
   `security_invoker` views (members read their org):
   - `public.v_books_commitment_tieout (org_id, location_id, job_id, commitments, committed_cents, matched_bill_cents,
     matched_bills, bills_on_commitment_hold, latest_version)` — compare `matched_bill_cents` with `Σ pm.commitment_lines.billed_cents`
     (both are bills against the commitment) and `committed_cents` with Projects' committed value.
   - `public.v_books_labor_tieout (org_id, location_id, job_id, approved_hours_x100, payroll_hours_x100, labor_cost_cents,
     accrued_open_cents, entries_awaiting_payroll, withdrawn_after_payroll)` — `approved_hours_x100` is in the same unit as
     the `time` check's `projects_cents` (approved hours × 100); `payroll_hours_x100` is what payroll has costed.
   Suggested `pm.v_job_tieout` branches: commitments → `books_cents = matched_bill_cents`, exception when it differs from
   `billed_to_date_cents`; time → `books_cents = approved_hours_x100`, exception when it differs, `detail` adds
   `payroll_hours_x100` / `entries_awaiting_payroll`.
2. *Cron.* Books' `projects.seam` job (per org, only when `entitlements.projects`) drains JOB_COMMITMENT and JOB_TIME, sweeps
   labor allocation, then calls `pm.run_seam_cycle(org)`.
3. *Workers must map to Books employees.* JOB_TIME hours with no `employee_id` (or an id Books does not know) cannot be
   costed; they are recorded and shown as "approved hours with no Books employee".
4. *Cross-company labor.* An employee paid by company A working a job of company B is not reclassed in this slice (it needs
   an intercompany pair); those hours show as unallocated on B. Open question for the owner.
5. `JOB_COST` from payroll labor uses `source_ref = payroll_labor:<run>:<job>:<cost code>` (CLEARED) and, for the standard-rate
   estimate, `labor_accrual:<hours row>` (CLEARED, then VOIDED at true-up).

### Security review follow-ups for the Projects lead (2026-10-26, Wave 4 — Books side done, not yet applied)

1. **`public.v_books_labor_tieout` is now a DEFINER view (194 §100).** The per-person labor columns it sums
   (`job_labor_hours.employee_id / standard_rate_cents / allocated_cents / accrued_cents` and every amount + `employee_id`
   on `job_labor_allocation_lines`) are column-revoked for members (comp field class, 194 §99). The view keeps the same
   columns (per-job aggregates only) and pins its rows itself: `get_org_id()` + Books client scope
   (`client_scope_bypass()` / `accessible_location_ids()`) + never a Projects-only seat (when `core.is_projects_only_seat()`
   exists). `pm.v_job_tieout` (a definer view) can read it unchanged; the end user's JWT still drives the pin. Do not
   read `job_labor_hours` / `job_labor_allocation_lines` amounts directly from Projects member code — use the view.
2. **`core.match_parties` (1111) ignores Books client scope.** For a Books seat (`v_books`) it matches org-wide and returns
   full email / phone (`visible = true`), so a client-scoped bookkeeper could see another client's customer. Books now
   post-filters in `apps/web/src/lib/parties/match.ts` (`visibleToCaller`: candidate ids re-read through the caller's RLS —
   163's `client_scope_rls` on `core.customers`; a contact follows its customer; read failure → no candidates) and
   rate-limits `/api/parties/match` per user. **Ask:** move the same rule into 1111 so Projects callers get it too — in
   `scoped`, when `v_books`, require `p.location_id is null or (select core.client_scope_bypass()) or p.location_id in
   (select core.accessible_location_ids())` for customers (and the contact's customer). No Books migration replaces the
   function (Projects owns 1111).
3. **Commitment payment hold.** A job line from a vendor whose commitment for that job is on payment hold can no longer be
   left unmatched (bill create → 422 naming the commitment) nor have its match cleared (`/api/ap/commitments/match` → 422),
   so the hold can't be sidestepped. Projects' release (`payment_hold = false` in a new JOB_COMMITMENT version) still
   restores the bills it held.

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
