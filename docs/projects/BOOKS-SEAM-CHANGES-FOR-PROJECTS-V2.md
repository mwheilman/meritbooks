# Books-side seam changes required by Merit Projects v2

**For:** the MeritBooks workstream (owner of `apps/web`, the posting engine and the Books consumers).
**From:** the Projects v2 lead, 2026-10-20. **Status:** requested; Projects already emits/consumes the shapes below
(schema `pm`, migrations 1100–1107). Until each item lands, the affected Projects events stay `pending` in
`core.events` and Projects shows "Waiting on Merit Books" (`pm.v_seam_health`), so nothing fails silently.

Sources: `/docs/projects/MERIT-PROJECTS-V2-BLUEPRINT.md` §5/§7 and the read-only seam review (findings below are
from `apps/web/src/lib/services/billing-consumer.ts`, `job-progress.ts`, `job-cost-events.ts`, `rev-rec.ts`, migs 152/153).

## A. Correctness defects in the current consumers (fix before real Projects traffic)

1. **JOB_BILLING is not exactly-once.** No atomic claim; invoice/lines/JE/ack are four requests; `invoices` has no
   `source_ref`. → Claim rows atomically (`update … set status='processing' … returning` or `FOR UPDATE SKIP LOCKED`
   in one transaction), add `invoices.source_ref` (unique per org), post the JE with `source_ref = job_billing:{payload.source_ref}`.
2. **Second, weaker invoice path.** Re-platform the consumer as a thin adapter over `lib/invoices/create-invoice.ts`
   (AR by role `AR_CONTROL`, per-line revenue, sales tax, retainage, `recordInvoiceEvent`, customer terms instead of +30 days).
3. **Retainage receivable never booked.** Projects sends net lines + a negative `line_type='RETAINAGE'` line and
   `retainage_cents`/`gross_earned_cents`. → DR AR (net) + DR RETAINAGE_RECEIVABLE (`retainage_cents`) / CR revenue or
   deferred (`gross_earned_cents`). `billing_subtype='RETAINAGE_RELEASE'` → DR AR / CR RETAINAGE_RECEIVABLE, **no revenue**.
4. **Rev-rec inputs stale.** `core.jobs.actual_cost_cents` / `billed_to_date_cents` are never maintained, so
   PCT_COSTS_INCURRED recognizes 0 and MILESTONE/AS_BILLED never relieve 2410. → Derive as-of actuals and billed from the GL.
5. **Two method resolvers disagree** (`rev-rec.ts` vs `rev-rec-method.ts`; canon order puts the legacy job_type map last;
   consumer passes the org's first revenue account instead of `core.jobs.revenue_account_id`). → One resolver, canon order.
6. **JOB_PROGRESS pins before it can reject.** Second snapshot in a month is marked rejected after inputs were already
   overwritten. → Pin into a `job_progress_snapshots` table keyed by `(job, snapshot_version)`; use payload `as_of_date`;
   a negative delta relieves 1180 then 2410; post the loss provision when EAC > contract.
7. **Job re-tag after hard close.** 152/153 allow `job_id` edits on posted lines in HARD_CLOSE. → Make `job_id` /
   `cost_code_id` immutable once the period is HARD_CLOSE; tag job at `postJournalEntry` time (bill-ap, bank-feed).
8. **Close ignores the seam.** → Hard close blocked by pending/rejected `core.events` for that location/period.

## B. Consumers to add / extend (Projects already emits these)

| Event (from Projects) | Books does | Ack |
|---|---|---|
| `JOB_BILLING` `schema_version: 2` with `billing_subtype` (SOV, RETAINAGE_RELEASE, ALLOWANCE, FIXED, RECURRING), `retainage_cents`, `gross_earned_cents`, `application_no`, `period_end`, `lines[].line_type`, `lines[].cost_code_id` | Items A1–A3. **Until upgraded, reject `schema_version > 1` with `error_code` so Projects shows it — never silently ignore keys.** Then set `core.organizations.entitlements.books_seam_version = 2` (Projects blocks retainage-release emission until ≥ 2). | `status`, `invoice_id`, `invoice_number`, `gl_entry_id` on the event row |
| `JOB_DEPOSIT_REQUEST` (new) `{customer_id, amount_cents, memo, source_ref 'pm:deposit:{id}'}` | Deposit invoice: DR AR / CR CUSTOMER_DEPOSITS (2420); dedupe on `source_ref`; apply at final invoice | same columns |
| `JOB_COMMITMENT` (new, **non-posting**) header + lines (`commitment_line_id`, `cost_code_id`, `amount_cents`, `received_to_date_cents`), `version`, `retainage_pct`, `payment_hold`, `hold_reason` | Upsert an AP match target when `version` is higher; match bill lines to `commitment_line_id`; honor `payment_hold` like ON_HOLD; default bill retainage from `retainage_pct`; retire on CLOSED/VOID. Do **not** create `purchase_orders` rows (one master). Block job-tagged Books POs when `entitlements.projects` is true. | `status` |
| `JOB_PROGRESS` + `as_of_date`, `snapshot_version`, `pending_co_value_cents` (disclosure only, never recognized), `schema_version: 2` | Item A6 | existing |
| `JOB_COST` (Books → Projects) | Add optional keys `cost_code_id` or `cost_code`, `commitment_line_id`, `vendor_id`, `description`; namespaced `source_ref` (`bill_line:{id}`, `bank_txn:{id}`) for new rows; **emit from every job-tagged cost path** (inventory issue, JE, expense report, payroll labor) | Projects marks consumed rows `processed` (legacy convention) under advisory lock `hashtextextended('pm.job_cost_drain:'||org, 0)` |
| `JOB_TIME`, `JOB_MATERIAL`, `JOB_PAYABLE_REQUEST` (reserved names) | Specs in the seam review §3.1/§3.3/§3.4. JOB_TIME needs Mike's ruling that direct-labor rate card + payroll burden ≠ the retired overhead engine. | — |

## C. Scheduling

`pm.run_seam_cycle(null)` (service_role) drains JOB_COST into Projects and reconciles billing/deposit acks. Call it from
the Books cron (`/api/cron/tick`, every 5 min) right after the Books event workers run. During cutover, the legacy
`proj.drain_job_costs` stays revoked (1007) so two drains never split events.

## D. Tests to make green (seam review §4)

G1 exactly-once billing · G2 one invoice path · G3 retainage ties both sides · G4 job cost = GL by construction ·
G5 every job-tagged cost line emits JOB_COST · G6 one resolver · G7 as-of actuals from GL · G8 closed-period WIP
re-prints identically · G9 rejected event leaves no partial pin · G10 no re-tag in HARD_CLOSE · G11 loss provision ·
G12 hard close blocked by seam backlog · G13 labor has one origin · G14 no job-tagged Books PO when Projects entitled ·
G15 pending-age alarm · G16 repo replay = live.
