# Dealer Pack — API contract (slice D1)

Source of truth for what D2 (UI pages, reports/widgets, exception detectors DL-1…DL-13, AI imports
A1–A7) builds on. Blueprint: `docs/FPB-dealer-pack.md`. Schema: `packages/supabase/migrations/169_dealer_pack.sql`.
Code: `apps/web/src/lib/dealer/**` (engines + services), `apps/web/src/app/api/dealer/**` (routes),
`apps/web/src/lib/validations/dealer.ts` (every request schema — read it for exact field limits).

D2 should not need to change any D1 file. Detectors and AI importers call the **service functions**
(`lib/dealer/service/*`) or these routes; UI calls the routes.

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | Every route is `apiHandler` / `apiQueryHandler` (Clerk session). The org is the session's tenant — never sent. |
| Client | Every request carries `locationId` (body for writes, query string for GET). The caller must pass `requirePermission(…, { locationId })` **and** see the client through RLS (client-scope mig 163), else 403/404. |
| Writes | All dealer tables are member **read-only** (mig 169 revokes INSERT/UPDATE/DELETE from `authenticated`). Writes go through these routes / services, which use the service-role client after the checks, pinning `org_id` + `location_id` on every query. D2 must not write dealer tables directly. |
| Money | Integer **cents** everywhere (`*Cents`). Rates in **basis points** (`*Bps`: 900 = 9.00%). Dates `YYYY-MM-DD`. |
| Success | `200` (or `201` on create) → `{ "data": … }`. |
| Errors | `{ "error": string, "code": string, "details"?: object }`. Codes below. Zod failures: `422 VALIDATION_ERROR` with `details` per field (from apiHandler). |
| Idempotency | Every money event has a stable key; repeating a request returns the existing row and never double-posts (DB guarantor: mig 064 unique `gl_entries (org_id, source_ref, entry_type)`, `source_ref = 'dealer:<key>'`). Re-importing the same flooring returns `disposition: "EXISTING"`. |
| GL | Every posting goes through `postJournalEntry`, balanced, `source_module = 'DEALER'`, entry types `FLOOR_PLAN`, `FLOOR_PLAN_INTEREST`, `UNIT_SALE`, `TRADE_IN`, `WARRANTY_CLAIM`, `OEM_INCENTIVE`, `UNIT_COST`. Accounts resolve **by role** for the client; DR/CR derive from the resolved account's type; every line carries the client's department for its department role. Period locks are enforced by the posting service and DB (152/153). GL author columns are null; the actor is on the dealer row + `core.action_log` (`dealer.*` actions). |
| Pack switch | Money events require the pack **enabled** for the client (`409 NOT_ENABLED`). Settings, lines, programs, imports and the **opening** load work before enabling. |

### Error codes

| Code | HTTP | Meaning / D2 handling |
|---|---|---|
| `NO_ORG`, `FORBIDDEN` | 403 | No tenant / missing permission. |
| `NOT_FOUND` | 404 | Row or client not visible to the caller. |
| `NOT_ENABLED` | 409 | Pack is off for this client. |
| `CONFLICT` | 409 | State does not allow it (e.g. posted rows immutable, unposted costs block a sale, DB unique/CHECK). |
| `VALIDATION` | 422 | Business validation (engine refusal, wrong client, bad account type). |
| `UNMAPPED_ROLE` | 422 | `details.role` — "Map 'Floor plan payable' (FLOOR_PLAN_PAYABLE) for this client before using the dealer pack." |
| `UNMAPPED_DEPARTMENT` | 422 | `details.deptRole`. |
| `NOT_FOOTING` | 422 | Statement lines don't foot to the footer: `details.problems[]`, `details.sums`. |
| `INTEREST_VARIANCE` | 409 | DL-9: `details { billedCents, accruedCents, trueUpCents, toleranceCents, detector: "DL-9" }`. Retry with `acceptVariance: true` (approver). |
| `SEPARATION_OF_DUTIES` | 403 | Releaser = proposer, or approver = preparer. |
| `ENABLE_BLOCKED` | 409 | `details.missing[]` (`ROLE:<key>` / `DEPT:<role>`) or `details.problems[]` (opening tie-out). |
| `POSTING_FAILED` | 422 | `postJournalEntry` refused (closed period, no fiscal period, …) — message is the reason. |

### Permissions used today (closest existing cells — `permissions.ts` is reserved spine)

`DEALER_PERMS` in `lib/dealer/service/context.ts`; swapping to dedicated capabilities is a one-line change there.

| Key | Cell | Used for |
|---|---|---|
| `view` | `journal_entries:view` | every GET |
| `edit` | `journal_entries:create` | drafts, imports of rows, proposals, status-only claim moves |
| `post` | `journal_entries:post` | anything that posts GL |
| `approveReceivable` | `invoices:approve` | trade ACV approval, warranty short-pay / write-off / debit, incentive write-off |
| `approveUnit` | `close_mgmt:manage` | rental move, write-down, return to OEM, void unit, waive curtailment, accept interest variance |
| `reconcile` | `reconciliation:reconcile` | lender statement match / resolve / prepare / approve |
| `release` | `payments_execute:run` | payoff release, trade lien payoff release |
| `settings` | `settings_acct:edit` | settings, role map, department map, enable, lines, programs, OEM programs |
| `imports` | `import:run` | import batches |

## 2. Lists (all GET, paginated / sortable / filterable)

Query: `locationId` (required), `page` (1-based), `per_page` (≤ 100, default 50), `sort` (allow-listed column, else default),
`dir` (`asc`|`desc`, default `desc`), `q` (search), `from` / `to` (date column), plus equality filters (comma list = IN; `true`/`false` booleans).

Response `data`: `{ rows: Row[], page, perPage, total, totalPages, sort, dir }`. Rows are the table's columns (snake_case, cents as numbers).

| Route | Table | Sortable | Filters | Search `q` | Date |
|---|---|---|---|---|---|
| `/api/dealer/units` | dealer_units | serial_number, stock_number, model, model_year, status, condition, received_date, sold_date, cost_cents, created_at | status, condition, make_vendor_id, inventory_role, is_consignment, source, import_batch_id | serial, stock #, model, VIN/HIN | received_date |
| `/api/dealer/notes` | floor_plan_notes | floored_date, lender_invoice_number, principal_balance_cents, original_principal_cents, status, maturity_date, payoff_due_date | status, line_id, program_id, unit_id, collateral_type, import_batch_id | invoice #, description | floored_date |
| `/api/dealer/transactions` | floor_plan_transactions | txn_date, txn_type, status, principal_cents, interest_cents, created_at | txn_type, status, line_id, note_id | — | txn_date |
| `/api/dealer/curtailments` | floor_plan_curtailments | due_date, amount_cents, status | status, note_id | — | due_date |
| `/api/dealer/lines` | floor_plan_lines | name, credit_limit_cents, status, created_at | status, lender_vendor_id | name | — |
| `/api/dealer/programs` | floor_plan_programs | name, rate_bps, free_floor_days, effective_from, status | line_id, oem_vendor_id, status | name | — |
| `/api/dealer/sales` | dealer_unit_sales | sale_date, sale_price_cents, status, source, created_at | status, source, unit_id, customer_id, posting_mode, import_batch_id | deal ref, salesperson | sale_date |
| `/api/dealer/trade-ins` | trade_ins | created_at, allowance_cents, acv_cents, status, lien_status | status, lien_status, sale_id | serial, model | — |
| `/api/dealer/warranty` | warranty_claims | submitted_date, filing_deadline, claimed_cents, settled_cents, status, repair_date, created_at | status, oem_vendor_id, unit_id, import_batch_id | claim #, dealer ref, RO, serial | submitted_date |
| `/api/dealer/oem-programs` | oem_programs | name, start_date, end_date, status, program_type | status, oem_vendor_id, program_type, treatment | name, code | — |
| `/api/dealer/incentives` | oem_incentive_claims | earned_date, claim_deadline, accrued_cents, settled_cents, status | status, program_id, unit_id, sale_id, treatment | claim reference | earned_date |
| `/api/dealer/lender-statements` | lender_statements | statement_date, kind, status | line_id, kind, status | — | statement_date |
| `/api/dealer/lender-statements/lines` | lender_statement_lines | line_number, match_status, variance_cents, current_cents | statement_id, match_status, sau_flag, matched_note_id | invoice #, serial, model | — |
| `/api/dealer/oem-statements` | oem_statements | statement_date, status | oem_vendor_id, status | — | statement_date |
| `/api/dealer/oem-statements/lines` | oem_statement_lines | line_number, amount_cents, match_status, line_type | statement_id, match_status, line_type | reference, serial, description | — |
| `/api/dealer/claim-events` | dealer_claim_events | event_date, created_at, amount_cents | claim_kind, warranty_claim_id, incentive_claim_id, event_type | — | event_date |
| `/api/dealer/imports` | dealer_import_batches | created_at, status, file_kind | status, file_kind, source_system | — | — |

Business objects are **ids** (vendor, customer, item, department, account): stitch names in JS via `lib/stitch-core.ts` (PostgREST can't embed `core` from `public`).

## 3. Settings and switching the pack on (FPB §9.3)

| Method + route | Body / query | `data` |
|---|---|---|
| `GET /api/dealer/settings?locationId=` | — | `{ settings: DealerSettings, readiness: Readiness }` |
| `PUT /api/dealer/settings` | `locationId` + any policy field (snake_case, see `settingsPatch`) | `DealerSettings` |
| `PUT /api/dealer/settings/roles` | `{ locationId, mappings: [{ roleKey, accountId \| null }] }` | `Readiness` |
| `PUT /api/dealer/settings/departments` | `{ locationId, mappings: [{ deptRole, departmentId \| null }] }` | `Readiness` |
| `POST /api/dealer/settings/enable` | `{ locationId, enabled }` | `Readiness` (409 `ENABLE_BLOCKED` with `details`) |

`Readiness = { enabled, missing: string[], canEnable, roles: [{ roleKey, label, required, accountId, mappedDirectly, isNew }], departments: [{ deptRole, departmentId }], tieout: { ok, problems[], rows: TieoutRow[] } }`.
Role mappings are written per client (`account_roles.location_id = locationId`); an account must be active, of an allowed
type for the role (e.g. `FLOOR_PLAN_INTEREST` → OPEX or OTHER-expense, the tenant's choice), and not another client's
company-specific account. Required department roles: all six (map several roles to one department if the client is small).
Enabling also requires the opening tie-out (§8 below) to be zero difference. The DB trigger re-checks roles + departments.

**Policies (per client) that encode FPB "[U] unverified" treatments — defaults are the FPB's:**

| Field | Default | Alternatives |
|---|---|---|
| `trade_valuation_policy` | `LOWER_OF_ACV_AND_ALLOWANCE` | `ACV` (under-allowance credits `TRADE_IN_OVER_ALLOWANCE`), `ALLOWANCE` |
| `warranty_recognition` | `ON_SUBMIT` | `ON_RO_CLOSE` |
| `warranty_relieve_parts_inventory` | `true` (claim relieves parts at cost) | `false` when the DMS/inventory flow already relieved the parts |
| `capitalize_setup_labor` | `true` (when the role is mapped) | `false` (labor stays in wages) |
| `cost_reduction_in_stock` | `REDUCE_UNIT_COST` (ASC 705-20) | `REDUCE_COGS` |
| `oem_settlement_default` | `STATEMENT_CREDIT` (DR AP control) | `CASH` |
| per program `treatment` (oem_programs) | by type (`defaultTreatment`) | any of the four |
| per program `day_count` (floor_plan_programs) | `ACT_365` | `ACT_360` |

Other policy fields (thresholds for D2's detectors): `sot_grace_days` (2), `aging_buckets` ({90,180,270,365}), `term_warning_days` (60),
`interest_tolerance_cents` (2500) + `interest_tolerance_bps` (200 → greater of $25 / 2%), `statement_tolerance_cents` (100),
`auto_match_min_confidence_bps` (9500), `curtailment_warn_days` (7), `warranty_deadline_warn_days` (5), `warranty_submitted_aging_days` (45),
`incentive_deadline_warn_days` (10), `incentive_submitted_aging_days` (60), `lien_unpaid_days` (10), `over_allowance_warn_bps` (2000),
`line_utilization_warn_bps` (9000), `trade_acv_approval_threshold_cents` (0 = every trade needs approval).

## 4. Floor plan

| Method + route | Body | `data` |
|---|---|---|
| `POST /api/dealer/lines` · `PATCH` (+`id`) | `lenderVendorId, name, creditLimitCents, liabilityAccountId?, interestDueDay?, scheduledPaymentDay?, statementDay?, sauCodes?[], debtInstrumentId?, status?, notes?` | line row. `sauCodes` = the lender's sold-and-unpaid codes on audits (data, not code). The payable override can't change after postings. |
| `POST /api/dealer/programs` · `PATCH` | `lineId, oemVendorId?, name, freeFloorDays, rateType FIXED\|INDEX_PLUS, rateBps, indexName?, indexRateBps?, spreadBps?, sauPenaltyRateBps?, dayCount, payoffTerms PAY_AS_SOLD\|DAYS_AFTER_SALE, payoffDays, maxTermDays?, curtailDemos?, curtailmentSchedule: [{after_days, pct_bps} \| {after_days, amount_cents}], effectiveFrom?, effectiveTo?, status?` | program row |
| `POST /api/dealer/floor` | `lineId, programId?, collateralType WHOLE_GOOD\|OPEN_ACCOUNT\|OTHER, lenderInvoiceNumber, flooredDate, principalCents, unitId? \| unit?{…unit fields}, scheduledDueDate?, importBatchId?, opening?{interestAccruedThrough?}, dmsInvoiceCostCents?, postNow?, viaImport?` | `FloorResult { note, unit, txn, created, disposition: POSTED\|PROPOSED\|OPENING\|EXISTING, reason? }` |
| `POST /api/dealer/floor/post` | `{ txnId }` | `{ txn, note }` — DR unit inventory / CR floor plan payable |
| `POST /api/dealer/floor/void` | `{ txnId, reason }` | `{ voided: true }` (proposed only) |
| `POST /api/dealer/curtailments/pay` | `curtailmentId` **or** `noteId + amountCents`, `paidDate, bankTransactionId?` | `{ txn, note }` — DR payable / CR bank; unit cost unchanged |
| `POST /api/dealer/curtailments/waive` | `curtailmentId, reason` | `{ waived: true }` |
| `POST /api/dealer/payoffs/propose` | `noteId, date` | PAYOFF txn (`PROPOSED`, `proposed_by`) |
| `POST /api/dealer/payoffs/release` | `txnId, paidDate, bankTransactionId?, paymentId?` | `{ txn, note }` — releaser ≠ proposer (service + DB CHECK). **Never automatic** (`canAutoRelease() === false`). |
| `POST /api/dealer/interest/accrue` | `periodEnd, post?` | `AccrualResult { periodEnd, rows: [{ noteId, lineId, unitId, deptRole, fromExclusive, toInclusive, rateBps, interestBearingDays, penaltyDays, interestCents }], totalCents, skipped[], posted, glEntryId }` |
| `POST /api/dealer/interest/billed` | `lineId, billedCents, billDate, accrualClearedCents?, bankTransactionId?, acceptVariance?, reference?` | `{ txn, trueUpCents }` or 409 `INTEREST_VARIANCE` |
| `POST /api/dealer/fees` | `lineId, noteId?, feeCents, feeDate, memo, bankTransactionId?` | FEE txn |
| `GET /api/dealer/notes/detail?locationId=&id=` | — | `{ note, transactions[], curtailments[] }` |

Flooring modes: default **PROPOSED** (a human posts via `floor/post`); `postNow` posts immediately; `viaImport` lets the tenant's
`DEALER_FLOORING` autonomy dial decide — an "exact match" (`auto` tier) is a pre-existing DMS unit whose `dmsInvoiceCostCents`
equals the floored principal; anything else is a human review. `opening` creates the note + unit + `OPENING` txn + `OPENING`
cost row with **no GL** (go-live; must tie to the migrated trial balance before enabling).

Interest: per note, `Σ day balance × rate / 10,000 / 365|360` over interest-bearing days (after free-floor end, positive end-of-day
balance; the sold-and-unpaid penalty rate replaces the base rate after the payoff due date), summed exactly and rounded half-up
once per note per period. Accrual rows are stored PROPOSED on preview; `post: true` books one batch JE (an expense line per
department) and advances `interest_accrued_through`. Billing clears the line's outstanding accrual by default.

## 5. Units

| Method + route | Body | `data` |
|---|---|---|
| `POST /api/dealer/units` · `PATCH` (+`id`) | unit fields (`serialNumber, condition NEW\|USED\|DEMO\|RENTAL, makeVendorId?, model?, …, isConsignment?, status ON_ORDER\|IN_TRANSIT\|IN_STOCK?, receivedDate?, source?`) | unit row (no GL; owned units get cost via cost rows) |
| `GET /api/dealer/units/detail?locationId=&id=` | — | `{ unit, costs[], notes[], sale }` |
| `POST /api/dealer/units/costs` | `unitId, costType, sourceType BILL_LINE\|INTERNAL_RO\|JE, billLineId?, laborCents?, partsCents?, offset? AP_CONTROL\|OPERATING_BANK\|INVENTORY_ASSET\|SETUP_LABOR_CAPITALIZED, amountCents?, sourceRef?, costDate, memo?, post?` | `{ cost, warnings[] }` |
| `POST /api/dealer/units/costs/post` · `/void` | `{ costId, entryDate }` · `{ costId }` | cost row |
| `POST /api/dealer/units/actions` | `{ unitId, action: { action: MARK_DEMO \| UNMARK_DEMO \| MOVE_TO_RENTAL{date} \| WRITE_DOWN{date, amountCents, reason} \| RETURN_TO_OEM{date, lenderCreditCents, reason} \| RECORD_WARRANTY_REGISTRATION{date} \| MARK_DELIVERED \| VOID{reason} } }` | unit row |

`cost_cents` is maintained by a DB trigger from **POSTED** cost rows. A `BILL_LINE` cost links an already-posted AP bill line
(no second JE) and is refused unless the bill line hit the unit's inventory account. `INTERNAL_RO` setup capitalizes labor at the
DMS internal-RO **actual cost** (no overhead/burden input exists — canon §2) + parts at cost. `RECORD_WARRANTY_REGISTRATION`
stores the manufacturer's retail registration date — an SOT signal (D2's OEM import calls it).

## 6. Sales and trade-ins

| Method + route | Body | `data` |
|---|---|---|
| `POST /api/dealer/sales` | `unitId, customerId (DEAL mode), saleDate, salePriceCents, taxCents?, depositId?, depositAppliedCents?, retailRebateCents?, retailRebateProgramId?, invoiceId? (BOOKS_INVOICE mode), trade?{serialNumber, makeVendorId?, model?, modelYear?, allowanceCents, acvCents, lienPayoffCents?, lienholderVendorId?}, salesperson?, retailFinanceVendorId?, source BOOKS\|DMS, externalDealRef?, importBatchId?` | `{ sale, trade }` (PROPOSED; `externalDealRef` dedupes DMS re-imports) |
| `POST /api/dealer/sales/post` | `{ saleId }` | `PostSaleResult { sale, glEntryId, invoiceId, usedUnitId, payoffProposalId, warnings[] }` |
| `POST /api/dealer/sales/void` | `{ saleId, reason }` | sale (proposed only; voids a draft deal invoice) |
| `POST /api/dealer/trade-ins/approve` | `{ tradeId }` | trade (sales-manager ACV approval) |
| `POST /api/dealer/trade-ins/lien` | `{ tradeId, action: "propose" }` · `{ tradeId, action: "release", paidDate }` | trade (release: different person, `payments_execute:run`) |

**DEAL mode** (no `invoiceId`): posting creates the Books invoice for what the customer owes
(price + tax − trade allowance + lien payoff − retail rebate; lines: unit, trade allowance (negative), lien payoff, rebate (negative))
via `createInvoice`, posts ONE deal JE (AR, sales, sales tax, retail-rebate receivable, used inventory at recorded value,
over/under-allowance, lien payoff, cost of sale) and stamps the invoice `SENT` with that JE — so AR aging, collections and the
AR-control tie keep working. A deposit is then applied to that invoice via the mig 140 service (DR deposits / CR AR); the net
equals FPB §3.4 to the cent. **BOOKS_INVOICE mode** (`invoiceId` of a posted invoice): the invoice already booked revenue; the
pack relieves cost only (trade / rebate / tax / deposit must be on the invoice → 422 otherwise).
In both modes: unit → SOLD, the live note → SOLD_UNPAID with `payoff_due_date`, a payoff is PROPOSED (never released), a used
unit is created from the trade at the recorded value (cost row carries the deal JE), and a retail rebate creates a
`TRANSACTION_PRICE` incentive claim already booked in the deal JE. A sale is refused while the unit has PROPOSED cost rows
(including an unposted flooring) so unit cost ties to the GL. A trade needs approval when `acvCents ≥ trade_acv_approval_threshold_cents`.

## 7. Manufacturer receivables

| Method + route | Body | `data` |
|---|---|---|
| `POST /api/dealer/warranty` · `PATCH` (+`id`, draft only) | `oemVendorId, oemClaimNumber?, dealerClaimRef?, repairOrderRef?, jobId?, unitId?, serialNumber?, customerId?, failureDate?, repairDate?, filingDeadline?, laborHours, laborRateCents, partsCostCents, partsMarkupBps, subletCents?, freightCents?, otherCents?, importBatchId?` | claim (labor = hours × rate, parts = cost × (1 + markup), claimed = Σ — DB CHECK) |
| `POST /api/dealer/warranty/ro-close` | `claimId, roClosedDate` | claim (recognizes when policy `ON_RO_CLOSE`) |
| `POST /api/dealer/warranty/submit` | `claimId, submittedDate, oemClaimNumber?` | claim (recognizes if not yet: DR receivable / CR labor + parts sales; parts COGS/inventory at cost) |
| `POST /api/dealer/warranty/settle` | `claimId, amountCents, method?, date, oemStatementLineId?, reference?` | claim (PARTIAL until covered) |
| `POST /api/dealer/warranty/resolve` | `{ claimId, resolution: ACCEPT_SHORT_PAY{date} \| WRITE_OFF{date} \| REJECTED_BY_OEM{date, reason} \| RESUBMIT{date} \| DEBIT{date, amountCents} }` | claim |
| `POST /api/dealer/oem-programs` · `PATCH` | `oemVendorId, programCode?, name, programType, treatment?, paidDirect?, startDate?, endDate?, claimDeadlineDays?, rules?, sourceDocumentId?` | program (DRAFT; A6 drafts land here) |
| `POST /api/dealer/oem-programs/status` | `{ id, status: ACTIVE \| EXPIRED }` | program (ACTIVE = approved_by) |
| `POST /api/dealer/incentives` | `programId, unitId?, saleId?, amountCents, earnedDate, claimReference?` | `{ claim, warnings[] }` — GL per treatment |
| `POST /api/dealer/incentives/submit` | `claimId, submittedDate, claimedCents?, claimReference?` | claim |
| `POST /api/dealer/incentives/settle` | as warranty settle | claim |
| `POST /api/dealer/incentives/resolve` | `{ claimId, resolution: WRITE_OFF{date} \| REJECTED_BY_OEM{date, reason} }` | claim (write-off reverses into the account the accrual credited) |

Every money event is a `dealer_claim_events` row with its JE (`GET /api/dealer/claim-events`).

## 8. Statements and reconciliation

| Method + route | Body | `data` |
|---|---|---|
| `POST /api/dealer/lender-statements` | `lineId, kind STATEMENT\|AUDIT\|PAYOFF_QUOTE, statementDate, documentId?, importBatchId?, footer{principalCents, interestCents?, feesCents?, lineCount?}, lines[{lenderInvoiceNumber?, serialNumber?, model?, originalCents?, currentCents?, interestCents?, feesCents?, lenderCode?, dispositionDate?, days?}], notes?` | `{ statement, lineCount }` — 422 `NOT_FOOTING` unless lines foot (A1 output goes here) |
| `POST /api/dealer/lender-statements/match` | `{ statementId }` | `MatchResult { lines: [{ lineId, matchedNoteId, matchStatus, method, varianceCents, overTolerance, sauFlag }], booksOnlyNoteIds[], recordSaleTasks: [{ lineId, noteId }], summary }` |
| `POST /api/dealer/lender-statements/resolve-line` | `{ lineId, resolution }` | `{ resolved: true }` |
| `POST /api/dealer/lender-statements/prepare` · `/approve` · `/reopen` | `{ statementId }` | statement (prepare refused while blocking lines remain — `details.lineIds`, DL-8; approve by a different person) |
| `POST /api/dealer/oem-statements` | `oemVendorId, statementDate, footerTotalCents, lines[{lineType, reference?, serialNumber?, description?, amountCents}]` | `{ id, lineCount }` (A2 output goes here) |
| `POST /api/dealer/oem-statements/match` | `{ statementId }` | `{ proposals: [{ lineId, claimKind, claimId, method CLAIM_NUMBER\|CLAIM_NUMBER_SHORT\|SERIAL_AMOUNT, confidenceBps, shortPayCents, autoSettleEligible }], autoSettled: lineId[] }` |
| `POST /api/dealer/oem-statements/settle-line` | `{ lineId, date, claimKind?, claimId? }` | `{ settled: true }` (confirm a proposal or hand-pick) |
| `POST /api/dealer/oem-statements/ignore-line` | `{ lineId }` | `{ ignored: true }` |

`recordSaleTasks` = the lender coded a unit sold-and-unpaid (`line.sau_codes`) that Books still shows unsold — a Books error;
D2 opens a task / feeds DL-1. Auto-settle only fires on an exact claim # + exact open amount + confidence ≥ threshold **and**
the `DEALER_OEM_CREDIT_MATCH` autonomy dial at AUTO_UNDER_LIMIT under its cap — never short-pays.

## 9. Read models for D2

| Route | `data` |
|---|---|
| `GET /api/dealer/summary?locationId=&asOf?=` | `DealerSummary { asOf, enabled, floorPlan { lines: LinePosition[], totalPrincipalCents, totalLimitCents, utilizationBps }, interestMtdCents, units { inStockCount, inStockCostCents, flooredCount, ownedCount, byAge: AgeBucket[], over365Count, withinTermWarning }, sot { count, criticalCount, principalCents, oldestDays }, curtailmentsDue14d { count, cents, missedCount }, warranty { openCents, byAge, over60Cents }, incentives { openCents, byAge, over60Cents }, tieout { ok, problems, rows } }` |
| `GET /api/dealer/sot?locationId=&asOf?=` | `SotFinding[] { noteId, unitId, lineId, serialNumber, severity CRITICAL\|HIGH, detectedBy, saleMissingInBooks, earliestSaleDate, daysSinceSale, payoffDueDate, daysPastDue, principalCents, evidence[{source, date, ref}], dedupKey "DL-1:<noteId>" }` |
| `GET /api/dealer/tieout?locationId=` | `{ ok, problems[], rows: [{ bucket, account_id, subledger_cents, gl_cents, difference_cents }] }` |

`LinePosition = { lineId, lineName, lenderVendorId, lineStatus, creditLimitCents, principalCents, openNoteCount, soldUnpaidCount, soldUnpaidCents, accruedInterestCents, curtailmentsDue30dCents, utilizationBps, nextMaturityDate, lastReconciledDate }`.
`AgeBucket = { label, minDays, maxDays, count, cents }`.

SOT signals: BOOKS_SALE (note SOLD_UNPAID; CRITICAL past payoff due + `sot_grace_days`, else HIGH), DMS_DEAL (a PROPOSED
DMS-sourced sale not posted), WARRANTY_REG (unit's registration date), LENDER_AUDIT (SAU-coded statement line) — the
earliest valid signal dates the sale; any outside signal without a Books sale is CRITICAL. Pure engine:
`lib/dealer/engine/sot.ts#detectSoldOutOfTrust` (D2's DL-1 detector should call `loadSotFindings` and write `ai_decisions`
with `dedupKey`).

**Views** (security_invoker, member-readable, for D2's reports R1–R9): `v_floor_plan_position`, `v_unit_aging`, `v_warranty_aging`,
`v_incentive_aging`, `v_dealer_subledger_tieout` (buckets FLOOR_PLAN_PAYABLE, FLOOR_PLAN_INTEREST_ACCRUED, UNIT_INVENTORY,
WARRANTY_RECEIVABLE, OEM_INCENTIVE_RECEIVABLE, TRADE_LIEN_PAYOFF; GL side = POSTED balance at the client in normal direction).
SQL helpers: `dealer_role_account(org, location, role)`, `dealer_role_map(org, location)`, `dealer_pack_missing_requirements(org, location)`.

## 10. Imports (D2 owns parsing)

| Method + route | Body | `data` |
|---|---|---|
| `POST /api/dealer/imports` · `PATCH` (+`id`) | `sourceSystem, fileKind UNITS\|DEALS\|WARRANTY\|LENDER_STATEMENT\|LENDER_AUDIT\|OEM_STATEMENT\|PROGRAMS\|OPENING, fileName?, documentId?, rowCount?` · `status?, rowCount?, acceptedCount?, rejectedCount?, errors?[]` | batch |
| `POST /api/dealer/imports/undo` | `{ id }` | `{ voided: { notes, sales, warrantyClaims, units } }` — refused (409, `details.blockers`) if anything in the batch posted |

Pass `importBatchId` on every row-creating call (floor, units, sales, warranty, statements). Importers: units → `POST /units`
(or `floor` with `unit`), DMS deals → `POST /sales` with `source: "DMS"`, `externalDealRef`; warranty register → `POST /warranty`;
lender statements/audits → `POST /lender-statements`; OEM statements → `POST /oem-statements`; registrations →
`units/actions RECORD_WARRANTY_REGISTRATION`; opening → `floor` with `opening` + units with `source: "OPENING"`, then `GET /tieout`.

## 11. Lead integration checklist (reserved spine — not edited by D1)

1. **Apply 169 to Supabase first**, then commit.
2. **Capabilities** (`lib/rbac/capabilities.ts`, FPB §9.1): `books.dealer.floor_plan` (V C E A P X K [M]), `books.dealer.units` (V C E D A X K),
   `books.dealer.warranty` (V C E A P X), `books.dealer.incentives` (V C E A P X K), `books.dealer.trade_ins` (V C E A P),
   `books.dealer.lender_statements` (V C E A X), `books.dealer.imports` (V C), `books.dealer.settings` (V K [L]) + default grants per FPB §9.1.
   Then swap `DEALER_PERMS` in `lib/dealer/service/context.ts`.
3. **Navigation** (`navigation.ts`): a "Dealer" group (Dealer home · Floor plan · Units · Lender statements · Warranty · Incentives ·
   Trade-ins · Imports), shown only when `dealer_pack_settings.enabled` for the active client and the user can view a `dealer.*` resource.
4. **Scheduler**: add `DEALER_MONTH_END_JOB` (`lib/scheduler/jobs/dealer-jobs.ts`) to `JOBS` in `registry.ts`.
5. **Autonomy catalog** (`lib/autonomy/catalog.ts`): `DEALER_FLOORING`, `DEALER_INTEREST_ACCRUAL`, `DEALER_OEM_CREDIT_MATCH` (all default PROPOSE).
6. **Borrowing base** (FPB R9): add `excludeFloorPlannedInventory` (default true) to `lib/borrowing-base/calc.ts` using `v_unit_aging.is_floored`.
