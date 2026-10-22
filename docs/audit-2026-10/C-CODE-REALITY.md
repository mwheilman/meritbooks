# C — Code Reality Inventory (verifier, 2026-10-22)

**Scope:** what is actually built in `apps/web` (Books) at `main` @ `f19ff09`, compared with what the docs claim. Evidence comes from source reads, the live Supabase DB (`npqeijipggtuduhkejxq`, read-only SELECTs), and the Vercel env list for `meritbooks-web` (key names only, no values).
**Size:** 131 `page.tsx` under `app/(app)/**`, 522 `route.ts` under `app/api/**` (dealer 71, reports 33, onboarding 22, tax 16, integrations 15, payroll 14, expenses 13, controls 13, …), and 158 core migrations (001–174). There are also 17 `1xxx` Projects/PM migrations.

**Depth scale:** **FULL** = real data, complete workflow, all states, and the actions work end to end. **PARTIAL** = it exists, but key steps are missing (each one is named). **STUB** = UI only, mock data, or a placeholder. **MISSING** = not in the code.

> **Important context: live usage is close to zero.** Live DB row counts: bills 2, invoices 3, bank_transactions 50 (newest 2026-06-10), gl_entries 38 / lines 82, bill_payments 1, customer_payments 2, receipts 0, expense_reports 0, payroll_runs 0, bank_reconciliations 0, disbursement_batches 0, payment_origination_batches 0, disbursement_check_numbers 0, report_packs 0, report_views 0, budgets 12, vendor_compliance_docs 0, vendor_portal_tokens 0, purchase_orders 0, leases 0, estimates 0, credit_memos 0, close_checklists 0, pbc_requests 0, all dealer_* 0, practice_assignments 0, performance_config 0, core.action_log 11, ai_decisions 111, orgs 2, locations 4, jobs 26, memberships 1, core.job_runs 74. A "FULL" rating below therefore means **the code path is complete**. Almost none of these paths has been exercised with real volume.

> **Production env gaps (Vercel):** these are **absent**: `INBOUND_EMAIL_SECRET`, all QuickBooks OAuth keys, all Gusto/Check payroll keys, Azure Document Intelligence, and any SMS/push provider (Twilio etc.). These are **present**: Resend, Stripe (and Connect), Plaid, Anthropic, Clerk, `CRON_SECRET`.

---

## 1. Receipt chase and a "Workforce" employee app — **STUB / MISSING**

| Feature | Depth | Evidence | What's missing |
|---|---|---|---|
| Receipt-chase settings (first reminder, interval, escalation, channel Push/SMS/Email, quiet hours) | **STUB** | `app/(app)/settings/settings-client.tsx:209-232` ("Receipt Chase Configuration" tab) | Nothing reads these settings to send anything. |
| Chase sender (SMS, push, or email to cardholders) | **MISSING** | `lib/scheduler/registry.ts:224` is a stub job: *"TODO(M-7): send due reminders for … receipt chase (cadence 0/2/5/10 days, quiet hours) … needs the request engine + an email/SMS sender."* (`implemented:false`, never runs). No Twilio, SMS, or push library exists in the repo. | Request engine, SMS/push provider, a sender job, and per-cardholder contact data. |
| `receipts.chase_reminder_count` column, plus a "chase count" badge on the credit-card feed | **STUB** | `api/credit-cards/route.ts:101-142`, `credit-cards/credit-card-feed.tsx:52` | The counter is never incremented by any code path, so it is always 0. |
| Receipt capture / upload | **MISSING (in UI)** | `POST /api/receipts/submit` exists, but **nothing in the app calls it**. `/receipts` (`receipt-queue.tsx`) only categorizes rows that already exist. Live `receipts` = 0. | Upload UI, mobile capture, email-in, and SMS-in. |
| Receipt-to-card-charge match | PARTIAL | `api/expenses/lines/[lineId]/match-card/route.ts` (an expense-report line is matched to a card charge) | Depends on receipts that cannot be captured. |
| **Merit Workforce app** (employee clock-in, paycheck/paystub view, receipt snap) | **MISSING** | There is no `apps/workforce`, no PWA manifest, and no mobile app. Time entry exists only as **office-side** screens in `apps/projects/src/app/(app)/time` (week grid, approve). There is no employee self-service and no clock-in. | Everything. |

## 2. Vendor chase (W-9 / COI) — **PARTIAL: tracking, scheduling, and portal are built; nothing is SENT**

| Feature | Depth | Evidence | What's missing |
|---|---|---|---|
| Compliance doc tracking (W9, GL_COI, WC_COI, WC_EXEMPTION), expiry states, 60-day "expiring" window | FULL (code) | `lib/services/vendor-compliance.ts`, `/vendor-compliance` | Live usage: 0 docs. |
| Payment hold enforced at pay time, plus overrides (ONE_TIME / TEMPORARY / PERMANENT) | FULL (code) | `enforcePaymentAllowed`, called from `recordBillPayment` (release route) | — |
| AI W-9 and COI parsing | FULL (code) | `api/vendors/w9-parse`, `api/vendors/coi-parse`, `lib/vendors/w9-parse.ts` | — |
| Nightly expiry scan and chase cadence (weekly when missing/expired/≤14 days, otherwise biweekly) | **PARTIAL** | Job `vendors.compliance_scan` (ran 4× ok). `vendor-compliance.ts:313-345` advances `next_chase_at` and `chase_reminder_count` and logs `CHASE_SCHEDULED`. | **It only schedules and counts. No email or SMS is sent**: there is no sender call, and `registry.ts:224` confirms the vendor-document chase sender is a TODO. |
| Vendor upload portal (magic link, upload W-9/COI/banking) | FULL (code) | `app/portal/vendor/[token]/*`, `api/portal/vendor/[token]/upload`, `api/vendor-portal/tokens`, `components/vendor-portal-access.tsx` | The link is **copied to the clipboard** (`vendor-portal-access.tsx:131`) for a human to paste into their own email. The system never emails it. Live tokens = 0. |
| Submission review queue | PARTIAL | `api/vendor-portal/tokens` GET returns submissions with `reviewStatus:'PENDING'` hardcoded | No accept/reject step that converts an upload into a VALID compliance doc with an expiry date. |
| Obligations calendar includes W-9/COI expiries | FULL (code) | `/obligations` | — |

**Answer:** the portal is built. The **chase sender is not.**

## 3. Check processor — **PARTIAL (pay-by-file MVP). No printing, no MICR, no void, no mail.**

| Feature | Depth | Evidence | What's missing |
|---|---|---|---|
| Check run: queue approved bills → capture details → review → export or mark checks → release (5-step stepper) | FULL (code) | `app/(app)/checks/checks-client.tsx:330` (`STEPS`), `api/checks/run`, `api/checks/[id]/approve` (preparer ≠ approver) | Live: 0 batches. |
| Release posts DR A/P / CR Cash with SoD (releaser ≠ preparer), duplicate guard, compliance gate, CAS claim | FULL (code) | `api/ap/disbursements/release/route.ts` | — |
| Check-number capture (a hand-written check number is stored as a reference) | PARTIAL | `api/ap/disbursements/check-numbers/route.ts` ("REFERENCE only") | No auto-sequencing per bank account, no gap detection. |
| Remittance advice PDF | FULL (code) | `api/ap/disbursements/remittance/route.tsx`, `lib/ap/remittance-pdf.tsx` | — |
| Bank file export: "bill-pay / positive-pay CSV" and NACHA | PARTIAL | `lib/ap/disbursement-export.ts`. The CSV header (`:54-67`) has **no check number and no account number**, so it is a bill-pay import file, **not a bank positive-pay file**. NACHA has **placeholder bank fields** because only masked account numbers are stored (`:12-18`). | A real positive-pay format per bank (account#, check#, issue date, amount, payee, void indicator). NACHA needs full vaulted account/routing numbers. |
| ACH origination | STUB | `lib/money/origination/sandbox.ts` is the only provider. `submit/route.ts` says "the SANDBOX adapter simulates the submission". | A live rail. |
| **Print checks** (check-stock layout, MICR E-13B line, signature image, voucher stub) | **MISSING** | No MICR, check-stock, or signature code in the repo (grep finds none) | All of it. |
| **Void / stop-payment** a check or bill payment | **MISSING** | No void route for payments | Reversal of the payment JE, reopening the bill, and positive-pay void. |
| **Check register** | **MISSING** | No register view or report | — |
| **Mail checks** (Lob / Checkbook.io / similar) | **MISSING** | No print-and-mail integration | — |

## 4. Team performance dashboard (`/team` → Performance tab) — **PARTIAL-to-FULL code, but no data**

| Feature | Depth | Evidence | What's missing |
|---|---|---|---|
| Per-person scorecard from `core.action_log`: weighted throughput (difficulty-weighted catalog of 17 actions), item counts by family, dollars processed (JE / bills / invoices / payroll / payments), approval latency (avg and median), coded→approved time, rework rate (quality gate 8%), override rate, composite score, last active | FULL (code) | `lib/team-performance/compute.ts` (473 lines, with tests), `api/team-performance/route.ts` (692), `team/performance-panel.tsx` (1046) | Weights and targets are tenant-config (`performance_config`), but **there is no UI to edit them**. |
| Header KPIs: weighted throughput, $ processed, avg cycle time, **close on-time %** (target business day 5), **filing on-time %**, active people; date-range selector; leaderboard gated on quality | FULL (code) | `performance-panel.tsx:961-1000` | — |
| Self view vs team view (RBAC) | FULL | `team-client.tsx:679` | — |
| **Queue aging / backlog per bookkeeper** | **MISSING on /team** | Client-level aging (oldest uncategorized days, pending, flagged, overdue bills) exists **per company** in `api/client-health`, shown on `/operations` | Not attributed to a person. |
| **Capacity / workload allocation** | **PARTIAL** | `core.practice_assignments` (close/ar/ap/review owner per company, mig 102), editable on `/portfolio` | No capacity model (hours, client load per person). Live assignments = 0. |
| Close progress per entity | FULL (code) | `/close-status` board, `/close` orchestration grid | Not on /team. |
| Real signal | — | Live `core.action_log` = **11 rows** | The dashboard is effectively empty today. |

## 5. Elect to accrue revenue / accrue AR for underbillings — **FULL election (per company / job-type / job); accrual is manual or proposal-only**

| Feature | Depth | Evidence | What's missing |
|---|---|---|---|
| 9 rev-rec methods: PCT_COSTS_INCURRED, PCT_COMPLETE, COMPLETED_CONTRACT, POINT_OF_SALE, MILESTONE, AS_BILLED, RATABLY, SUBSCRIPTION, CASH | FULL (code) | `lib/services/rev-rec.ts:38-40` | — |
| **The user election: company default method** | FULL | Settings → "Rev Rec" tab, `settings/rev-rec-config.tsx:82-86` → `POST /api/rev-rec/config {kind:'default'}`. Also set in the new-entity wizard, onboarding, and the create-company dialog. | — |
| **Election: job-type → method map per company** | FULL | `rev-rec-config.tsx:112-116` (`kind:'map'`). Live `rev_rec_method_map` = 2 rows. | — |
| **Election: per-job override** | FULL | `jobs/[id]/job-detail-client.tsx:271-287` (`rev_rec_method_override`) | — |
| Recognition engine posts the delta: CR Revenue / DR 2410 Deferred (billings in excess) and/or DR 1180 Unbilled (contract asset) | FULL (code) | `rev-rec.ts`; `/rev-rec` "Run" tab (`rev-rec-run.tsx`) with preview → post | — |
| **Underbilling accrual (1180)** as a separate adjust-to-target POC accrual, preview then post, accrue or reverse | FULL (code) | `lib/rev-rec/unbilled-accrual-service.ts`, `api/rev-rec/accrue-unbilled`, `/rev-rec` "Accrual" tab (`rev-rec-accrual.tsx`) | **No company-level "auto-accrue underbillings" on/off switch.** The choice is implicit: jobs without a method use the accrual. The code comment says to pick one per job. |
| Scheduled monthly recognition | PARTIAL | Job `revrec.monthly` (1st of month, `defaultEnabled:true`) **proposes only** unless the autonomy dial "Scheduled revenue recognition" is set to auto. It has never run (no `job_runs` rows). | — |
| WIP schedule (over/under billing by job) | FULL (report) | `/jobs/wip`, `lib/jobcost/wip.ts`, report `wip` | The WIP screen itself does not post an over/under JE; that is done by rev-rec. |
| Rev-rec reporting: deferred rollforward, contract waterfall, revenue by method | FULL (code) | `rev-rec-reports.tsx`, `lib/services/rev-rec-reporting.ts` | — |

## 6. Payables email import (inbound email → bill) — **Code BUILT; does NOT work in prod today**

| Feature | Depth | Evidence | What's missing |
|---|---|---|---|
| Webhook `POST /api/webhooks/inbound-email` (provider-agnostic JSON, shared-secret, de-dup by messageId) | FULL (code) | `app/api/webhooks/inbound-email/route.ts`, `lib/ap/inbound-intake.ts` | — |
| Inbound address | PARTIAL | **Per org, not per company**: `core.organizations.inbound_ap_address` (mig 135), live `ap-revived-interiors@…`, `ap-merit-management-group-live@inbound.meritbooks.app`. The bill lands on `resolveDefaultLocationId`. | A per-company address. **The address is not shown anywhere in the UI** (grep finds no UI reference). |
| Parse attachment → PROPOSED draft in the AP intake queue (Claude vision; Azure DI optional) | FULL (code) | `lib/ap/doc-intelligence/*`, `/bills/intake-queue` shows "Received by email from …" | — |
| **Provider wired** | **NO** | `INBOUND_EMAIL_SECRET` is **not set in Vercel**, so the route fails closed and rejects every request (`authorizeInbound`). No MX record or email-parse provider has been provisioned (`docs/IT-RUNBOOK-email-ingestion.md` hands this to IT). | Secret, DNS/MX for `inbound.meritbooks.app`, and a parse provider (SendGrid / Postmark / Cloudflare). |
| Connect a Gmail/Outlook mailbox (Option A in the runbook) | **MISSING** | No Gmail or Graph ingestion code | OAuth apps, token storage, poller. |
| Manual upload → AI parse → draft | FULL (code) | `api/bills/intake`, `api/bills/parse`, `/bills/intake-queue` | — |

## 7. Split transactions — **MISSING**

| Feature | Depth | Evidence |
|---|---|---|
| Split one bank-feed transaction across multiple GL accounts, departments, companies, or jobs | **MISSING** | `api/bank-feed/approve/route.ts:142-149` always builds exactly **2 lines** (one `body.account_id`, one `department_id`/`class_id`, one `job_id` vs cash). No split code exists in `bank-feed/*` or `edit-panel.tsx`, and no `transaction_splits` table. |
| Cross-company (intercompany) split from a bank line | MISSING | — |
| Workaround | — | Post a manual multi-line JE in `/journal-entries`. Expense reports have lines; bills support multi-line. |

## 8. Reports and FP&A

### 8a. `/reports` catalog (`app/(app)/reports/report-viewer.tsx:135-180`)
Every report has: entity multi-select (grouped by industry), period presets/custom, Accrual/Cash/Tax/Custom basis overlay (P&L/BS/TB only), Summary/Detail view where flagged, export to PDF/XLSX/CSV (`api/reports/export/*`), saved views (`saved-views.tsx`; live 0), report packs/compiler with scheduled email delivery (`report-compiler.tsx`, `saved-packs.tsx`, `lib/reports/compiler/scheduled-delivery.tsx`; live packs 0), and an AI narrative panel (`narrative-panel.tsx`). GL drill-down from statement lines (`gl-drill-down.tsx`). **No charts in `/reports`.**

| Report | Comparatives | Drill | Depth / notes |
|---|---|---|---|
| Profit & Loss | prior period, prior year, budget | yes | FULL |
| P&L by Month (12 col) | — | — | FULL |
| **P&L by Department** | — | yes | **STUB.** It renders the plain `PnlReport` with no department dimension (`report-viewer.tsx:737-739`; export maps to the same income-statement URL, `build-model.ts:460`). Output is identical to the P&L. |
| **P&L by Class** | — | yes | **STUB.** Same issue as P&L by Department. |
| Balance Sheet | prior period, prior year | yes | FULL |
| Cash Flow (indirect) | — | — | PARTIAL: **first selected entity only** (`locationId={locIds.split(',')[0]}`) |
| Cash Flow (direct) | — | — | FULL |
| Changes in Equity / Equity Table | — | — | PARTIAL (generic table) |
| Debt Schedule | — | — | PARTIAL (generic table) |
| Trial Balance | — | yes | FULL |
| Consolidated Statements (with IC eliminations) | — | — | PARTIAL (generic table). The deeper `/consolidation` screen has NCI, FX translation, and ownership. |
| Budget vs Actual | — | — | PARTIAL (generic table) |
| AR Aging, AP Aging | — | detail | FULL |
| Income by Customer, Sales by Customer, Customer Balances, Open Invoices | — | some | PARTIAL (generic table) |
| Expense by Vendor | — | detail | FULL |
| Vendor Balances, Open Bills, Open Items AR+AP | — | — | PARTIAL (generic table) |
| **1099 Summary** | — | — | **BROKEN in /reports**: falls through to *"Report not yet implemented."* (not in `urlMap`, `:765-781`). The real 1099 work is on `/compliance-1099`. |
| **Sales Tax Summary** | — | — | **BROKEN in /reports**: same "not yet implemented". Use `/sales-tax-return`. |
| Job Profitability, WIP Schedule, Job Cost Detail | — | — | FULL / PARTIAL / PARTIAL |
| General Ledger, Transaction List | — | — | PARTIAL: `GenericReport` **renders only the first 200 rows** (`rows.slice(0,200)`, `report-viewer.tsx:~800`). Export is the only way to see the rest. |
| Dealer reports (when the pack is on) | — | — | `lib/dealer/reports/catalog.ts`. Invalid keys show "Report not yet implemented" (`dealer/reports/report-panel.tsx:48`). Live dealer data: 0. |
| Elsewhere: basis-adjustment authoring (`/reports/basis-adjustments`), AR collections/DSO (`/invoices/collections`, `/collections`), rev-rec reports, WIP (`/jobs/wip`), job P&L statement with chart (`jobs/[id]/job-pl-statement.tsx`), inventory valuation, tax package / M-1 / provision, borrowing-base certificate, covenant compliance, close status, 13-week cash | — | — | Mostly FULL (code) |

**CFO verdict:** core GAAP statements (P&L, BS, TB, direct CF, aging) are real, with comparatives and drill-down on P&L/BS. Gaps:
- No departmental or class P&L (mislabeled stubs).
- No multi-entity columnar P&L (side-by-side entities) in /reports. It exists only as the ranked net-income view on `/profitability`.
- No % of revenue column beyond the P&L, no trailing-12, no custom report builder, no charts in reports.
- Two catalog entries are dead and generic tables are capped at 200 rows.

### 8b. FP&A surfaces
| Surface | What it shows | Depth |
|---|---|---|
| `/fpna` (`fpna-dashboard.tsx`, `lib/fpna/dashboard.ts`, `kpi-config.ts`) | 16 configurable KPI tiles with prior-period delta pills: Revenue, Gross profit, Gross margin, COGS, Opex, Operating income/margin, Net income/margin, Cash, Monthly burn, Runway, AR, AP, Working capital, Current ratio. Role layouts (Controller/CFO/Owner); customize/reorder (persisted **client-side only**). Charts: **revenue bars + net-income line by month** (inline SVG), **gross-margin trend sparkline**. Plan-variance table (actual vs budget vs forecast, $ and %). NL scenario bar (`fpna-nl-scenario.tsx`). | FULL (code). No DSO/DPO/EBITDA, no cohort or unit economics, no drill from tiles. |
| `/budgets` (+ `/budgets/drivers`, `/budgets/reforecast`) | Account-by-month entry grid, CSV/XLSX import, budget-vs-actual, scenario modeler, NL scenario, driver-based build (`lib/budget/drivers.ts`), reforecast/roll-forward (`lib/budget/reforecast.ts`) | FULL (code). Live: 12 budget rows, **0 budget_versions**. No approval workflow on versions. |
| `/forecast` | Driver forecast grid (`lib/forecast/driver-forecast.ts`) | PARTIAL |
| `/cash` (tabs: dashboard, **13-week forecast**, obligations, trend) | 13-week weekly opening→net→closing from open AR/AP by due date (`lib/cash/forecast.ts`); obligations (debt, leases, payroll); cash trend; treasury | PARTIAL. AR/AP only. **No payroll/recurring/opex run-rate in the 13-week** unless it comes in as obligations. No scenario. |
| `/profitability` | Per-entity P&L and margin, ranked, "Net income by entity" chart | FULL (code). Entity dimension only (no dept, customer, or product profitability). |
| `/board-package` (+ PDF/XLSX) | Cover, deterministic KPI summary (revenue, margins, cash, AR/AP, leverage/liquidity ratios), statements passed through verbatim, **AI executive summary** (facts-only), notes plus a subsequent-events placeholder; branded PDF | FULL (code). One SVG chart. No budget variance section, no commentary workflow. |
| `/portfolio`, `/portfolio/[locationId]` | All-company RAG roll-up (close, cash, exceptions, overdue) | FULL (code) |
| `/covenants`, `/borrowing-base` | Covenant tests (AI-parsed from loan docs) and BBC | FULL (code). Live: 1 covenant, 0 measurements. |
| Scheduled "after hard close, push BvA to owners and snapshot the forecast" | **MISSING** | `registry.ts:242` stub |

---

## 9. Other areas (brief)

| Area | Depth | Evidence | Key gaps |
|---|---|---|---|
| **Bank feed** | FULL (code) | `bank-feed/*` (≈4.5k lines): confidence-sorted list, confidence explainer, batch/vendor select, edit panel with GL search, keyboard shortcuts, saved views, duplicate detection, statement import (`api/bank-feed/import-statement`) | **No splits.** Plaid pull is **user-triggered only** (`registry.ts:220` stub for incremental sync). Newest live bank txn is 2026-06-10, so the feed is stale. |
| **Credit cards** | PARTIAL | `/credit-cards` feed with receipt badges | Receipt capture and chase do not exist. |
| **Bank reconciliation** | FULL (code) | `/reconciliation` (workspace, autopilot, history, analytics), 10 tested services in `lib/services/reconciliation-*` (match, statement-match, plug, aging, close-gate, memo, adjustment-classify) | Live reconciliations = **0**. |
| **AP / bills** | FULL (code) | `/bills` (1.7k lines), `/bills/intake-queue` (AI parse), `/bills/policy` (AI-compiled approval policy + deterministic engine), N-step approvals (`/settings/approvals`), optional approver-release threshold (mig 174), retainage, POs (`/purchase-orders`, goods receipts, three-way match in `lib/procurement/three-way-match.ts`) | Email-in not live (§6). Live: 2 bills, 0 POs. Pay-run agent proposal is a stub (`registry.ts:226`). |
| **AR / invoices / collections** | FULL (code) | `/invoices` (3k lines): send via Resend (`lib/invoices/send-invoice.tsx`), PDF, Stripe pay link (`app/pay/[token]`, webhook), reminders (`api/invoices/[id]/remind`), credit memos, recurring panel, contract import; `/collections` with send (`api/collections/send`); customer statements and portal (`app/portal/customer/[token]`); cash application; customer deposits | Automated dunning cadence is a stub (`registry.ts:230`). Recurring invoices can't run unattended (`:228`). Live: 3 invoices. |
| **Payroll** | PARTIAL | `/payroll` (2.8k lines): run wizard, register CSV/XLSX import with mappings, run detail, GL posting (`lib/money/posting/payroll-posting.ts`); provider adapters Gusto, Check (scaffolded, "TODO confirm endpoints"), file, mock | **No live provider** (no keys; decision pending, task #32). Live: 0 runs. Working path today: import a register from an outside payroll provider and post it. |
| **Expenses** | PARTIAL | `/expenses` reports (build → submit → approve → reimburse), card match, `/expenses/policy` (AI-compiled policy engine) | No receipt capture (§1). Live: 0. |
| **Close** | FULL (code) | `/close` orchestration grid (AUTO/MANUAL tasks across INITIAL/MID/FINAL phases with blockers), Year-End tab, `/close-status`, `/periods` (OPEN/SOFT/HARD), DB period lock | `close_checklists` = 0 rows. Period-engine auto-posting can't be scheduled (`registry.ts:232`). |
| **GL / JE** | FULL (code) | `/journal-entries`: form (incl. Reversing type), AI composer (`je-ai-composer.tsx`), drawer/peek, recurring JEs (`/recurring-journal-entries`, nightly propose job ran ok), COA (`/chart-of-accounts`), 6 DB integrity triggers | — |
| **Schedules** (fixed assets, leases ASC 842, prepaids, insurance, intangibles, tax depreciation) | FULL (code) | Each has a page, AI doc parse (lease/insurance), and posting | Live: 5 fixed assets, 0 leases. `prepaid.amortize` job is registered. |
| **Debt / covenants** | FULL (code) | `/debt` (register, AI parse, schedule; 3 instruments, 72 schedule lines live), `/covenants`, `/borrowing-base` | Lender-pack drafting is a stub (`registry.ts:234`). |
| **Consolidation / intercompany / internal invoices** | FULL (code) | `/consolidation` (ownership %, NCI, FX rates, eliminations), `/intercompany`, `/internal-invoices` (dept chargeback with roll-up netting) | Live: 1 IC txn, 1 internal invoice. |
| **Tax / 1099 / sales tax** | PARTIAL-FULL | `/compliance-1099` (box classify, thresholds, **1099-MISC PDF**, **IRS FIRE file** `lib/tax/1099/fire-file*.ts`, TIN store); `/sales-tax-return`, `/sales-tax-calendar`; `/tax-package`, `/tax-provision` (ASC 740), `/book-to-tax` (M-1), `/tax-depreciation` (MACRS) | No IRIS e-file transmission (file generation only). Sales tax: 0 rates and 0 filings configured. |
| **Dealer pack** | FULL (code), 0 use | 71 API routes, `/dealer/*` (units 2k lines, deals, floor-plan notes, lender statements, OEM statements, incentives, warranty, imports, reports, settings). Projects app has the DMS front end (`apps/projects`, mig 1109). | Live dealer tables all 0. Several dealer pages are thin wrappers around workspaces. |
| **Onboarding / import / conversion** | FULL (code), in progress (task #11) | `/onboarding` (3.4k-line wizard, smart intake, formation intake, readiness, tour, conversion, portfolio, opening-balance reconciliation, WIP import), `/import` | QuickBooks connect has no prod keys; other ERP catalog entries are `PLANNED` with `authorizeUrl:null` ("coming soon"). |
| **Integrations** | PARTIAL | Plaid (link, exchange, sync, map); Stripe (Connect + webhooks); QuickBooks OAuth/pull/import (code present, **no Vercel keys**); ERP catalog mostly PLANNED | No live accounting, field-service, or payroll connector. |
| **Portals** | PARTIAL | Customer portal (statement, pay), vendor upload portal, auditor access (`api/audit-access`, `/pbc`) | Neither portal link is emailed automatically. Live PBC = 0. |
| **RBAC / admin** | FULL (code) | `/settings/roles` (custom roles, permission sets), `/settings/access/{reviews,requests,log}`, `/settings/approvals`, `/settings/autonomy`, SoD, field masks, auth policy (MFA/step-up), client-scoped RLS, access-expiry sweep job (ran ok) | Quarterly review campaign auto-open is a stub (`registry.ts:238`). Billing activation shows "coming soon" (`settings/billing`). |
| **AI agents / autonomy** | PARTIAL | `/agents` + `lib/agents/runner.ts` with 6 recipes (ap-intake, close-run, collections-autopilot, order-to-cash, pay-run, procure-to-pay). The runner **never posts**; it pauses at human gates. Also `/ai-decisions` log (111 rows), `/categorize`, NL query/draft-bill/draft-invoice (`api/nl/*`), learned vendor memory, autonomy dials. | Agents are on-demand only. The scheduled agent jobs are stubs. |
| **Controls / exceptions** | FULL (code) | `controls.nightly` job (ran ok), detectors in `lib/controls/*` (duplicate payment, anomalous JE, out-of-policy expense, revenue-not-recognized, …), `/controls`, Inbox → Exceptions | — |
| **Notifications** | **MISSING** | No notification center or bell. Watch rules and digests are a stub (`registry.ts:240`). Email is used only for invoices, reminders, statements, collections, invites, auditor invites, and scheduled report packs. | In-app notifications, digests, SMS, push. |
| **Mobile** | **MISSING** | No PWA manifest, no native or Workforce app | — |
| **Scheduler** | PARTIAL | Vercel cron `/api/cron/tick` every 5 min. 8 implemented jobs have run (reports.packs, vendors.compliance_scan, access.expiry_sweep, events.drain, controls.nightly, recurring_je.propose, scheduler.prune_runs, dealer.controls_nightly=skipped). **11 registered jobs are stubs** (`registry.ts:218-242`): plaid sync, integrations sync, chase sender, pay-run draft, recurring invoices, dunning, period-engine, lender packs, payroll funding, access campaign, digests, FP&A push. | — |

## 10. Doc-vs-reality discrepancies worth correcting
1. The `/reports` catalog advertises **P&L by Department** and **P&L by Class**, but both render the plain P&L.
2. **1099 Summary** and **Sales Tax Summary** in `/reports` show "Report not yet implemented."
3. The generic report tables (GL, transaction list, balances, open items, BvA, consolidated) silently **truncate at 200 rows** on screen.
4. The Cash Flow (indirect) report uses **only the first selected entity**.
5. The "positive-pay" CSV is not a positive-pay format (no check number or account number). NACHA has placeholder bank fields.
6. The "Receipt Chase Configuration" settings do nothing, and `chase_reminder_count` on receipts is never written.
7. AP email-in is documented as built (handoff s48). It is **unreachable in prod** because `INBOUND_EMAIL_SECRET` is unset and no MX/provider exists, and the address is never shown to users.
8. Vendor-compliance "chase" increments counters and logs `CHASE_SCHEDULED` but sends nothing.
