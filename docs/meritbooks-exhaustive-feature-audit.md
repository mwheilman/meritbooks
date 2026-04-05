# MeritBooks — Exhaustive Line-Item Feature Audit

**Date:** April 5, 2026  
**Scope:** Every individual feature, sub-feature, report, workflow, metric, view, and detail extracted from ALL source documents, cross-referenced against deployed code at `github.com/mwheilman/meritbooks`  
**Source Documents Read:**
- MeritBooks-Architecture-Build-Spec-v4_3.docx (28 sections, 2,860 lines)
- MeritBooks-Complete-Feature-Catalog.md (569 lines, 36 features)
- MeritBooks-Gap-Analysis.md (220 lines)
- handoff-v15.md (315 lines)
- Doc7.pdf (7,647 lines — backend build transcript)
- Doc8.pdf (10,071 lines — frontend build transcript)
- Doc9.pdf / Doc9_2.pdf (23 pages — schema design session transcript)
- MeritBooks-Product-Architecture-v1 through v3_1.docx (all versions)
- Prior chat sessions 1-3 in this project
- CFO Schema Specification (referenced throughout v4.3)
- Accounting Manager feedback (3 requests, incorporated in v4.3 Section 5)

**Deployed Codebase Inventory:**
- 21 web pages (Next.js App Router)
- 7 API routes
- 4 service modules (categorization, chargeback, gl-posting, overhead-rate)
- 9 SQL migrations (55 tables, 9 views, 6+ enforcement triggers)
- 6 shared UI components
- 1 seed data file

---

## STATUS KEY

| Code | Meaning | Definition |
|------|---------|------------|
| ✅ BUILT | Deployed & functional | Page + component + API route or service + schema table all present in `github.com/mwheilman/meritbooks` |
| 🔶 PARTIAL | Some pieces exist | Schema table exists but no page, OR page exists with demo data but no API/service wiring, OR partial implementation |
| ⬜ SCHEMA | Schema only | Database table or view exists in migrations but no frontend page or API route |
| ❌ MISSING | Not built | Nothing in deployed codebase |

---

## CATEGORY 1: GENERAL LEDGER & CHART OF ACCOUNTS
*Source: v4.3 §04 (Governed by Sage Intacct), §05, CFO Schema Spec*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 1 | Multi-dimensional GL with 4 dimensions (Location, Dept, Class, Item) | ✅ BUILT | `002_dimensions.sql`: locations, departments, classes, items tables + junction tables (location_departments, location_classes, location_items). `gl_entry_lines` carries location_id, department_id, class_id, item_id as FKs |
| 2 | Unified COA using dimensions instead of account proliferation | ✅ BUILT | `003_chart_of_accounts.sql`: accounts table with account_group_id FK. `001_foundation.sql`: account_types (7), account_sub_types (11), account_groups (71) |
| 3 | 251 seed accounts from Merit Top Level COA | ⬜ SCHEMA | `seed/index.ts` exists but only has placeholder structure — actual 251 account seed data not confirmed populated |
| 4 | Real-time posting from sub-ledgers (AP, AR, payroll, fixed assets) | 🔶 PARTIAL | `gl-posting.ts` service exists (170 lines). `gl/post/route.ts` API. But only general JE posting — no sub-ledger auto-posting pipelines |
| 5 | Multi-book support (GAAP, tax, cash, accrual simultaneously) | ❌ MISSING | No book_type or reporting_basis field on gl_entries or any book management tables |
| 6 | Continuous close (close sub-ledgers independently) | 🔶 PARTIAL | `fiscal_periods` table has status (OPEN/CLOSED/LOCKED) + `enforce_period_lock()` trigger. But no sub-ledger-specific period tracking |
| 7 | Statistical accounts and statistical journals | ⬜ SCHEMA | `gl_entries.entry_type` includes STATISTICAL enum value. No UI or API support |
| 8 | Account groups with independent display_order (Accounting Mgr request #2) | ✅ BUILT | display_order on account_types, account_sub_types, account_groups tables in `001_foundation.sql` |
| 9 | COA approval workflow — Request → Approve → Activate (Accounting Mgr request #3) | ✅ BUILT | `accounts` table: approval_status, requested_by, approved_by, approved_at. `enforce_coa_approval()` trigger in `003_chart_of_accounts.sql`. Only APPROVED accounts accept postings |
| 10 | COA tree view in UI | ✅ BUILT | `chart-of-accounts/account-tree.tsx` (page + component deployed) |
| 11 | Journal entry templates for non-accountants (Claude NL-to-JE) | ❌ MISSING | No NL-to-JE interface or template system |
| 12 | Journal entry approval workflows (sequential approvers) | 🔶 PARTIAL | `gl_entries` has status (DRAFT/POSTED/REVERSED) but no approval chain fields (approver_id, approval_date, multi-step workflow) |
| 13 | Journal entry import from spreadsheets | ❌ MISSING | No import UI or CSV/XLSX parser for JEs |
| 14 | Recurring journal entries with reversing flag | ⬜ SCHEMA | `recurring_templates` table in `007_close_audit_compliance.sql`. No page or API |
| 15 | Adjusting entries via Period 13 | 🔶 PARTIAL | `fiscal_periods.period_number` supports 1-13. No specific Period 13 UI or workflow |
| 16 | Year-end closing entries to Retained Earnings | ❌ MISSING | No year-end close automation. Schema has `closes_to_retained_earnings` flag on account_types but no closing engine |
| 17 | Intercompany auto-balancing JEs | ⬜ SCHEMA | `intercompany_balances` and `intercompany_loans` tables exist in `008_sub_ledgers.sql`. No auto-JE generation |
| 18 | Reporting accounts (alternate COAs for different standards) | ❌ MISSING | No alternate COA structure |
| 19 | AI outlier detection on posted journal entries | ❌ MISSING | No anomaly detection service |
| 20 | Required dimension enforcement per account/location | ✅ BUILT | `require_department`, `require_class`, `require_item` flags on both accounts and locations tables. `validate_dimensions()` trigger referenced but actual trigger function in code needs verification |
| 21 | Field-level audit trail — who/when/what changed per JE (Accounting Mgr request #1) | ✅ BUILT | `audit_log` table with table_name, record_id, action, field_name, old_value, new_value, user_id, ip_address. `v_journal_entry_audit` view in `009_reporting_views.sql` |
| 22 | Opening balance entry workflow | ❌ MISSING | No opening balance wizard or entry type |
| 23 | 7 account types with number ranges (10000-99999) | ✅ BUILT | `001_foundation.sql`: account_types table seeded in `seed/index.ts` |
| 24 | 11 account sub-types | ✅ BUILT | `001_foundation.sql`: account_sub_types table |
| 25 | 71 account groups | ✅ BUILT | `001_foundation.sql`: account_groups table |
| 26 | Control account protection (no manual posting) | ✅ BUILT | `is_control_account` flag on accounts. `enforce_control_accounts()` trigger in `004_general_ledger.sql` |
| 27 | Company-specific account isolation | ✅ BUILT | `is_company_specific` + `company_location_id` on accounts. Enforcement trigger present |
| 28 | Income Statement calculation (Revenue − COGS = Gross Profit − OpEx = Operating Income ± Other = Net Income) | ⬜ SCHEMA | `v_income_statement` view in `009_reporting_views.sql`. Demo data in `income-statement.tsx` but not wired to view |

**Category 1 Score: 12 BUILT, 6 PARTIAL, 5 SCHEMA, 5 MISSING = 28 total**

---

## CATEGORY 2: ACCOUNTS PAYABLE
*Source: v4.3 §04 (Governed by Sage Intacct)*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 29 | Bill entry with AI OCR extraction (scan/email/upload) | 🔶 PARTIAL | `bills/page.tsx` + `bill-list.tsx` deployed. `bills/create/route.ts` API. But no actual OCR/Claude integration in deployed code |
| 30 | Bill line items with dimensional coding (4 dimensions) | ⬜ SCHEMA | `bill_lines` table in `005_transactions.sql` with location_id, department_id, class_id, item_id. No line-item UI |
| 31 | Duplicate invoice detection | ❌ MISSING | No duplicate detection logic |
| 32 | Configurable approval workflows (value-based, role-based) | ❌ MISSING | No approval workflow engine for bills |
| 33 | Approval delegation for out-of-office approvers | ❌ MISSING | No delegation system |
| 34 | Vendor defaults (terms, discounts, GL, payment priority) — AI-learned | 🔶 PARTIAL | `vendor_patterns` table in `005_transactions.sql`. `categorization.ts` service (200 lines). Pattern matching exists but no terms/discount defaults |
| 35 | Recurring bills | ⬜ SCHEMA | `recurring_templates` table exists. No bill-specific recurring UI |
| 36 | 3-way match (PO → receipt → invoice) with tolerance exceptions | ❌ MISSING | No PO system at all |
| 37 | Bill payment via check | 🔶 PARTIAL | No check printing page deployed. Schema has no check management tables |
| 38 | Bill payment via ACH | ❌ MISSING | No electronic payment integration |
| 39 | Bill payment via virtual card | ❌ MISSING | |
| 40 | Batch payment processing | ❌ MISSING | |
| 41 | Payment scheduling | ❌ MISSING | |
| 42 | Early payment discount tracking (2/10 net 30) | ❌ MISSING | |
| 43 | Vendor credits and debit memos | ❌ MISSING | |
| 44 | Purchase orders with approval workflows | ❌ MISSING | |
| 45 | PO-to-bill conversion (single and multi-document) | ❌ MISSING | |
| 46 | Purchase requisitions | ❌ MISSING | |
| 47 | Spend management (budget controls on POs) | ❌ MISSING | |
| 48 | Positive pay file generation for bank fraud protection | ❌ MISSING | No positive pay in deployed code (was in prior HTML prototype only) |
| 49 | 1099 contractor tracking ($600+ threshold, W-9, TIN masking) | 🔶 PARTIAL | Vendor table has `is_1099` flag. No 1099 tracking page deployed |
| 50 | 1099 form preparation and e-filing export | ❌ MISSING | |
| 51 | Separation of duties (preparer ≠ approver ≠ check printer) | ❌ MISSING | No role-based duty separation enforcement |

**Category 2 Score: 0 BUILT, 4 PARTIAL, 2 SCHEMA, 17 MISSING = 23 total**

---

## CATEGORY 3: ACCOUNTS RECEIVABLE
*Source: v4.3 §04, §21 (Governed by Sage+QBO). Entire module was MISSING — now partially built*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 52 | Invoice creation with line items and dimensional coding | 🔶 PARTIAL | `invoices/page.tsx` + `invoice-list.tsx` deployed with demo data. `invoices` + `invoice_lines` tables in `008_sub_ledgers.sql`. No create/edit UI beyond list view |
| 53 | Invoice templates (customizable per entity: logo, colors, terms, bank info) | ❌ MISSING | |
| 54 | Recurring invoices (auto-generate on schedule) | ❌ MISSING | |
| 55 | Estimates / quotes with estimate-to-invoice conversion | ❌ MISSING | |
| 56 | Progress invoicing / AIA billing (G702/G703) | 🔶 PARTIAL | `invoice_list.tsx` shows `isProgressBill` and `appNumber` fields in demo data. No AIA form generation |
| 57 | Sales receipts (immediate payment at point of sale) | ❌ MISSING | |
| 58 | Credit memos, adjustments, and refunds | ❌ MISSING | |
| 59 | Payment receipt and application (apply to invoices, partial payment) | ⬜ SCHEMA | `customer_payments` + `payment_applications` tables in `008_sub_ledgers.sql`. No UI |
| 60 | Customer deposits / prepayments | ❌ MISSING | |
| 61 | Customer statements (generate and send) | ❌ MISSING | |
| 62 | Online payment acceptance (CC, ACH) | ❌ MISSING | |
| 63 | Automated dunning / collection letters | ❌ MISSING | |
| 64 | Collection case management (assign case owners, notes, activity log) | ❌ MISSING | |
| 65 | Customer self-service portal (view invoices, make payments) | ❌ MISSING | |
| 66 | Bill-back invoicing (intercompany) — Chargeback engine | 🔶 PARTIAL | `chargebacks/page.tsx` deployed. `chargebacks/generate/route.ts` API + `chargeback.ts` service. Demo data only |
| 67 | AR aging reports (summary/detail, by entity) | ⬜ SCHEMA | `v_ar_aging` view in `009_reporting_views.sql`. No AR aging page |
| 68 | Customer balance reports (summary/detail) | ❌ MISSING | |
| 69 | Open invoices report | ❌ MISSING | |
| 70 | Revenue by customer report | ❌ MISSING | |
| 71 | Unbilled charges / unbilled time reports | ❌ MISSING | |
| 72 | Customer master file / directory | ⬜ SCHEMA | `customers` table in `008_sub_ledgers.sql`. No customer management page |

**Category 3 Score: 0 BUILT, 3 PARTIAL, 3 SCHEMA, 15 MISSING = 21 total**

---

## CATEGORY 4: BANKING & RECONCILIATION
*Source: v4.3 §04, §06 (Custom AI exceeds all platforms)*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 73 | Bank account connection via Plaid | 🔶 PARTIAL | Architecture designed for Plaid. `bank_accounts` table in `005_transactions.sql`. No Plaid integration code deployed |
| 74 | Bank feed transaction import (automated daily) | 🔶 PARTIAL | `bank-feed/page.tsx` + `bank-feed-list.tsx` + `bank-feed-filters.tsx` deployed. Demo data. `bank-feed/approve/route.ts` API exists |
| 75 | Manual bank file import (CSV, QIF, XLS, OFX, BAI2, CAMT.053) | ❌ MISSING | No file import capability |
| 76 | AI transaction categorization (Claude + vendor pattern cache) | 🔶 PARTIAL | `categorization.ts` service (200 lines) with pattern matching + Claude fallback logic. `ai_audit_log` table for logging. Not wired to live Claude API in deployed code |
| 77 | 3-step matching algorithm (vendor 40% + amount 40% + date 20%) | 🔶 PARTIAL | Algorithm described in `categorization.ts`. Confidence scoring logic present. Not processing real transactions |
| 78 | Confidence-based routing (≥90% auto / 70-89% review / <70% flagged) | 🔶 PARTIAL | Thresholds defined in categorization service. `confidence_bar.tsx` UI component. Flagged page deployed |
| 79 | Bank reconciliation workflow (start → match → clear → finish) | 🔶 PARTIAL | `reconciliation/page.tsx` + `reconciliation-view.tsx` deployed. `bank_reconciliations` table in `007_close_audit_compliance.sql`. Demo data only |
| 80 | Auto-matching rules (configurable field matching) | ❌ MISSING | |
| 81 | Credit card feed import and reconciliation | 🔶 PARTIAL | `credit-cards/page.tsx` + `credit-card-feed.tsx` deployed. Demo data |
| 82 | Fund transfers between accounts/entities | ❌ MISSING | |
| 83 | Cash position reporting (real-time across all entities) | 🔶 PARTIAL | `cash/page.tsx` + `cash-dashboard.tsx` deployed. `v_cash_position` view. Demo data |
| 84 | Reconciliation history and reports | ❌ MISSING | |
| 85 | Reclassify GL accounts post-reconciliation (if period open) | ❌ MISSING | |

**Category 4 Score: 0 BUILT, 8 PARTIAL, 0 SCHEMA, 5 MISSING = 13 total**

---

## CATEGORY 5: FINANCIAL REPORTING
*Source: v4.3 §04, §20 — #1 BLOCKER for book of record*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 86 | P&L (standard) with date range, company, department filters | 🔶 PARTIAL | `reports/income-statement.tsx` (145 lines) with demo data rendering. `v_income_statement` view exists. Not wired to live GL data |
| 87 | P&L by month | ❌ MISSING | No multi-period column layout |
| 88 | P&L by customer | ❌ MISSING | |
| 89 | P&L by class | ❌ MISSING | |
| 90 | P&L by department (departmental P&L) | ❌ MISSING | |
| 91 | P&L comparison (period vs period, YoY) | ❌ MISSING | No comparative column logic |
| 92 | P&L detail | ❌ MISSING | No drill-through to transactions |
| 93 | P&L as % of total income | ❌ MISSING | |
| 94 | Balance Sheet (standard) with as-of date, company filter | 🔶 PARTIAL | `reports/balance-sheet.tsx` (142 lines) with demo data. `v_balance_sheet` view exists. Not wired |
| 95 | Balance Sheet comparison (period vs period) | ❌ MISSING | |
| 96 | Balance Sheet detail | ❌ MISSING | |
| 97 | Balance Sheet summary | ❌ MISSING | |
| 98 | Statement of Cash Flows (direct method) | ❌ MISSING | Tab exists in `report-viewer.tsx` but shows "Coming soon" |
| 99 | Statement of Cash Flows (indirect method) | ❌ MISSING | |
| 100 | Statement of Changes in Equity | ❌ MISSING | |
| 101 | Trial Balance (adjusted vs unadjusted, by period, by entity) | 🔶 PARTIAL | `reports/trial-balance.tsx` (114 lines) demo data. `v_trial_balance` view. `gl/trial-balance/route.ts` API route. Not confirmed wired end-to-end |
| 102 | General Ledger detail (by account, date range, with source doc links) | ⬜ SCHEMA | `v_gl_detail` view exists in `009_reporting_views.sql`. Tab in report-viewer but shows "Coming soon" |
| 103 | Transaction detail by account | ❌ MISSING | |
| 104 | Transaction list by date / by customer / by vendor | ❌ MISSING | |
| 105 | Consolidated statements across entities with eliminations | ❌ MISSING | Tab exists in report-viewer but shows "Coming soon". No elimination logic |
| 106 | Project profitability summary | ⬜ SCHEMA | `v_job_profitability` view exists. No report page |
| 107 | AP aging summary and detail | ⬜ SCHEMA | `v_ap_aging` view exists. No report page |
| 108 | AR aging summary and detail | ⬜ SCHEMA | `v_ar_aging` view exists. No report page |
| 109 | Vendor balance summary/detail and vendor activity | ❌ MISSING | |
| 110 | Customer balance summary/detail and customer activity | ❌ MISSING | |
| 111 | Open invoices / unpaid bills | ❌ MISSING | |
| 112 | Reconciliation reports | ❌ MISSING | |
| 113 | Budget vs actual with variance ($ and %) | ❌ MISSING | No budget page deployed (was in prior HTML prototype only) |
| 114 | Custom Report Writer (drag-and-drop, saved views, scheduling) | ❌ MISSING | |
| 115 | Interactive drill-down from summary to transaction | ❌ MISSING | |
| 116 | KPI dashboards (configurable by role) | ❌ MISSING | |
| 117 | Board / investor reporting packages with AI narrative | ❌ MISSING | |
| 118 | Report export (PDF, Excel, CSV) | ❌ MISSING | Export buttons present in UI but no export logic |
| 119 | Scheduled report delivery (email) | ❌ MISSING | |
| 120 | AI-generated report commentary (variance explanations) | ❌ MISSING | |

**Category 5 Score: 0 BUILT, 3 PARTIAL, 4 SCHEMA, 28 MISSING = 35 total**

---

## CATEGORY 6: MONTH-END CLOSE & AUDIT
*Source: v4.3 §04, §13 (Governed by Double + Sage)*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 121 | Cross-entity progress table (17 entities × 3 phases) | 🔶 PARTIAL | `close/page.tsx` + `close-grid.tsx` deployed with demo data. `close_checklists` table exists |
| 122 | Initial Close checklist (Due Day 3): issue sales invoices | ❌ MISSING | Checklist items not individually tracked |
| 123 | Initial Close: verify bank feed posted (auto-verified ⚡) | ❌ MISSING | No auto-verification engine |
| 124 | Initial Close: reconcile all cash/credit/fuel accounts | ❌ MISSING | |
| 125 | Initial Close: reconcile payroll liabilities to $0 | ❌ MISSING | |
| 126 | Initial Close: save AP summary report (auto-verified: AP aging = BS AP) | ❌ MISSING | |
| 127 | Mid-Close checklist (Due Day 7): depreciation posted | ❌ MISSING | |
| 128 | Mid-Close: prepaids amortized | ❌ MISSING | |
| 129 | Mid-Close: Rev Rec entered | ❌ MISSING | |
| 130 | Mid-Close: 10-10-10 deferred revenue calculated | ❌ MISSING | |
| 131 | Mid-Close: bonus accrual booked | ❌ MISSING | |
| 132 | Final Close checklist (Due Day 10): management review | ❌ MISSING | |
| 133 | Final Close: variance analysis | ❌ MISSING | |
| 134 | Final Close: financial statement preparation | ❌ MISSING | |
| 135 | Auto-verification badges (⚡) on system-confirmable items | ❌ MISSING | |
| 136 | Working papers — balance sheet account documentation | ❌ MISSING | No working papers page deployed. `working_papers` table in `007_close_audit_compliance.sql` |
| 137 | Working papers — preparer + reviewer sign-off | ⬜ SCHEMA | `working_papers` has prepared_by, reviewed_by, status |
| 138 | Working papers — 5 tickmarks (✓ Σ ◊ ↕ T) | ❌ MISSING | |
| 139 | Period Close Gate (all checks must pass) | ❌ MISSING | `enforce_period_lock()` trigger exists but no gate UI with prerequisite checking |
| 140 | Period Close Gate — bank rec complete check | ❌ MISSING | |
| 141 | Period Close Gate — checklist complete check | ❌ MISSING | |
| 142 | Period Close Gate — working papers approved check | ❌ MISSING | |
| 143 | Period Close Gate — open items resolved check | ❌ MISSING | |
| 144 | Period Close Gate — compliance current check | ❌ MISSING | |
| 145 | Period Close Gate — intercompany balanced check | ❌ MISSING | |
| 146 | Period Close Gate — manager override with documented reason | ❌ MISSING | |
| 147 | Regulatory Compliance Dashboard — entity × obligation grid | 🔶 PARTIAL | `compliance/page.tsx` + `compliance-grid.tsx` deployed with demo data. `compliance_obligations` + `compliance_filings` tables exist |
| 148 | Compliance: Filed This Month metric | ❌ MISSING | Demo metrics only |
| 149 | Compliance: Due Within 7 Days metric | ❌ MISSING | |
| 150 | Compliance: Overdue with penalty exposure metric | ❌ MISSING | |
| 151 | Compliance: Auto-Verified via GL data (22 of 34) | ❌ MISSING | |
| 152 | Filing archive with on-time rate, auto-verified rate, total penalties YTD | ❌ MISSING | |

**Category 6 Score: 0 BUILT, 2 PARTIAL, 1 SCHEMA, 29 MISSING = 32 total**

---

## CATEGORY 7: TRANSACTION PROCESSING (Daily Workflow)
*Source: v4.3 §09, Feature Catalog §§1-6*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 153 | Dashboard — TTM revenue metric | 🔶 PARTIAL | `dashboard/page.tsx` deployed. `metric-card.tsx` component. Demo data |
| 154 | Dashboard — Pending review count (receipts/bills/JEs breakdown) | 🔶 PARTIAL | Demo data in dashboard |
| 155 | Dashboard — EBITDA metric | 🔶 PARTIAL | Demo |
| 156 | Dashboard — Active companies count | 🔶 PARTIAL | Demo |
| 157 | Dashboard — 30-day processing volume chart | 🔶 PARTIAL | Demo |
| 158 | Dashboard — Live activity feed | 🔶 PARTIAL | `dashboard/activity-feed.tsx` deployed. Demo data |
| 159 | Dashboard — Company summary table (per-entity pending, AI accuracy, sync status) | 🔶 PARTIAL | `dashboard/company-summary.tsx` deployed. Demo data |
| 160 | Bank Feed — AI-categorized transactions with confidence bars | 🔶 PARTIAL | Page + list + filters deployed. `confidence-bar.tsx` component. Demo data |
| 161 | Bank Feed — Match status badges (matched to bill/receipt/unmatched) | 🔶 PARTIAL | Demo badges in UI |
| 162 | Bank Feed — 3 actions per transaction (Approve, Flag, Edit) | 🔶 PARTIAL | Buttons in UI. `bank-feed/approve/route.ts` API |
| 163 | Bank Feed — Batch approve for high-confidence items | ❌ MISSING | No batch selection UI |
| 164 | Credit Cards — Transaction review with receipt matching status | 🔶 PARTIAL | `credit-cards/page.tsx` deployed. Demo data |
| 165 | Credit Cards — Chase indicator (reminder count) | ❌ MISSING | Not in deployed UI |
| 166 | Receipts — AI extraction with pre-populated fields | 🔶 PARTIAL | `receipts/page.tsx` + `receipt-queue.tsx` deployed. `receipts/submit/route.ts` API. Demo data |
| 167 | Receipts — Original image alongside extracted data | ❌ MISSING | No image display in deployed page |
| 168 | Receipts — Source indicator (email/mobile/manual) | ❌ MISSING | |
| 169 | Receipts — Batch approve | ❌ MISSING | |
| 170 | Bills — Vendor compliance status badge on bills | ❌ MISSING | Not in deployed `bill-list.tsx` |
| 171 | Bills — Line-item detail view | ❌ MISSING | |
| 172 | Flagged Items — Low-confidence review queue | 🔶 PARTIAL | `flagged/page.tsx` + `flagged-queue.tsx` deployed. Demo data |
| 173 | Flagged Items — AI note explaining uncertainty | 🔶 PARTIAL | Demo notes in flagged queue |
| 174 | Flagged Items — Inline resolve with notes | ❌ MISSING | No resolve action in deployed code |

**Category 7 Score: 0 BUILT, 14 PARTIAL, 0 SCHEMA, 8 MISSING = 22 total**

---

## CATEGORY 8: FINANCIAL MANAGEMENT SCREENS
*Source: v4.3 §10, Feature Catalog §§7-18*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 175 | Journal Entries — Create/review/post manual JEs | 🔶 PARTIAL | `journal-entries/page.tsx` + `je-list.tsx` deployed. Demo data. `gl/post/route.ts` API |
| 176 | Journal Entries — Draft/Posted/All tabs | 🔶 PARTIAL | Demo tabs in UI |
| 177 | Journal Entries — Balanced DR/CR line items mapped to GL accounts | 🔶 PARTIAL | Schema enforces via trigger. UI has demo JEs |
| 178 | Journal Entries — Entry types: STANDARD, RECURRING, REVERSING, STATISTICAL, CLOSING, SUB_LEDGER | ⬜ SCHEMA | `gl_entries.entry_type` enum. No UI support for type selection |
| 179 | Journal Entries — Source modules: MANUAL, AR, AP, CASH_MGMT, FIXED_ASSETS, PAYROLL, INVENTORY, SYSTEM | ⬜ SCHEMA | `gl_entries.source_module` enum |
| 180 | Payroll Journal Entries — ADP import per company per period | ❌ MISSING | No payroll page deployed |
| 181 | Payroll JEs — Gross Wages/FICA/FUTA/SUTA/Health/401k breakdown | ❌ MISSING | |
| 182 | Payroll JEs — Edit Allocations + Approve & Post | ❌ MISSING | |
| 183 | Recurring Transactions — Auto-generated entries per period | ❌ MISSING | `recurring_templates` table exists but no page |
| 184 | Recurring Transactions — Frequency (monthly/quarterly/annually) | ⬜ SCHEMA | In `recurring_templates` table |
| 185 | Recurring Transactions — Reversing flag | ⬜ SCHEMA | |
| 186 | Revenue Recognition — 4 methods (% costs, % complete, completed contract, POS) | ❌ MISSING | No rev rec page deployed |
| 187 | Revenue Recognition — Monthly automation (1st at 2:00 AM) | ❌ MISSING | No scheduled job |
| 188 | Revenue Recognition — Two COGS routing trees | ❌ MISSING | |
| 189 | Revenue Recognition — Monthly snapshots | ❌ MISSING | |
| 190 | Revenue Recognition — Correction approach (true-up forward / retroactive) per company | ❌ MISSING | |
| 191 | WIP Reports — Job-level WIP schedule (contract, costs, % complete, over/under) | ❌ MISSING | No WIP page deployed |
| 192 | Fixed Assets — Asset register with auto-depreciation | ❌ MISSING | `fixed_assets` table in `008_sub_ledgers.sql`. No page |
| 193 | Fixed Assets — MACRS 3/5/7/10/15/20yr, SL, DDB methods | ⬜ SCHEMA | `fixed_assets.depreciation_method` enum |
| 194 | Fixed Assets — Monthly depreciation auto-JE to GL | ❌ MISSING | |
| 195 | Fixed Assets — Disposal with gain/loss calculation + JE | ❌ MISSING | |
| 196 | Fixed Assets — Transfer between entities with intercompany JE | ❌ MISSING | |
| 197 | Fixed Assets — Impairment recording | ❌ MISSING | |
| 198 | Fixed Assets — Depreciation schedule and forecast reports | ❌ MISSING | |
| 199 | Fixed Assets — Asset valuation reports (cost, NBV, accumulated dep) | ❌ MISSING | |
| 200 | Check Management — Print Queue (batch select + print) | ❌ MISSING | No check page deployed |
| 201 | Check Management — Check History (printed/cleared/void/stale) | ❌ MISSING | |
| 202 | Check Management — Positive Pay (bank exception matching) | ❌ MISSING | |
| 203 | Intercompany Balances — Track between entities | ❌ MISSING | `intercompany_balances` + `intercompany_loans` tables exist. No page |
| 204 | Intercompany — 3-tier approval workflow (Manager → CFO → Owner) | ❌ MISSING | |
| 205 | Intercompany — AI document generation (Promissory Note, Borrower Resolution) | ❌ MISSING | |
| 206 | Intercompany — Built-in e-signature | ❌ MISSING | |
| 207 | Intercompany — Loan tracking with P&I payments, both sides posted | ❌ MISSING | |
| 208 | Debt Schedule — instrument, lender, balance, rate, maturity, payment | ❌ MISSING | `debt_instruments` table exists. No page |
| 209 | Equity Schedule — holder, class, units, ownership %, contributions, distributions | ❌ MISSING | `equity_holders` table exists. No page |

**Category 8 Score: 0 BUILT, 3 PARTIAL, 5 SCHEMA, 27 MISSING = 35 total**

---

## CATEGORY 9: CASH INTELLIGENCE
*Source: v4.3 §11, Feature Catalog §§17-18*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 210 | Daily Cash Report — per-company cash positions from bank feeds | 🔶 PARTIAL | `cash/page.tsx` + `cash-dashboard.tsx` deployed. `v_cash_position` view. Demo data |
| 211 | Daily Cash — minimum cash target alerts | ❌ MISSING | No threshold alerting |
| 212 | Daily Cash — AI proactive insights (transfer recommendations) | ❌ MISSING | |
| 213 | 13-Week Cashflow — rolling forecast (13 weekly columns) | 🔶 PARTIAL | `forecast/page.tsx` + `forecast-grid.tsx` deployed. Demo data |
| 214 | 13-Week Cashflow — synthesizes bank feeds + AP/AR aging + payroll + recurring + historical | ❌ MISSING | No data integration |
| 215 | 13-Week Cashflow — 4 AI intelligence categories (risk, AR patterns, seasonal, confidence) | ❌ MISSING | |
| 216 | 13-Week Cashflow — confidence degradation (92%/78%/64%) | ❌ MISSING | |
| 217 | Scenario Modeling — toggleable what-if scenarios | ❌ MISSING | |
| 218 | Scenario Modeling — NL scenario queries via Claude (v3.1 enhancement) | ❌ MISSING | |
| 219 | Scenario Modeling — chainable scenarios | ❌ MISSING | |
| 220 | Self-correcting accuracy — Forecast vs Actual with AI explanations | ❌ MISSING | |

**Category 9 Score: 0 BUILT, 2 PARTIAL, 0 SCHEMA, 9 MISSING = 11 total**

---

## CATEGORY 10: CHARGEBACK BILLING ENGINE
*Source: v4.3 §12, Feature Catalog §§10, 23-25*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 221 | OH Allocation Formula — recalculated monthly from 6000-series OpEx | 🔶 PARTIAL | `overhead-rate.ts` service (140 lines). `overhead-rate/route.ts` API. `overhead_rate_periods` table. Formula implemented but not connected to real P&L |
| 222 | 5 labor classifications (Overhead/DirectAssigned/Production/OwnerGroup/DealTeam) | ⬜ SCHEMA | `employees` table has `labor_type` enum with all 5 types. No classification management UI |
| 223 | Production target: 37.5 hr/wk, <70% utilization for 2 periods = flagged | ❌ MISSING | No utilization tracking or flagging |
| 224 | Supervisor gate — production employees only clock to assigned companies | ❌ MISSING | No supervisor approval flow |
| 225 | Burdened cost formula: Base/12 + 7.65% FICA + 3.50% WC + $680/mo benefits | 🔶 PARTIAL | Implemented in `overhead-rate.ts` but not connected to payroll data |
| 226 | Chargeback Manager — per-company summary table | 🔶 PARTIAL | `chargebacks/page.tsx` + `chargeback-dashboard.tsx` deployed. Demo data |
| 227 | Chargeback Invoice — 6 sections (COGS-Labor, OpEx-Labor, COGS-Expenses, OpEx-Expenses, Shared Costs, Direct Assigned) | 🔶 PARTIAL | `chargeback.ts` service (165 lines) implements GL classification. Invoice structure partially implemented |
| 228 | Chargeback Invoice — GL classification rules (Office=OpEx, Field=COGS/OpEx by job) | 🔶 PARTIAL | Classification logic in `chargeback.ts` |
| 229 | Chargeback Invoice — Generate Invoice button (one-click, posts both sides) | 🔶 PARTIAL | `chargebacks/generate/route.ts` API exists. Not confirmed functional |
| 230 | Chargeback Invoice — full line-item detail with source lineage | ❌ MISSING | No detailed invoice preview UI |
| 231 | Chargeback Invoice — invoice # format CB-2026-0215-SC | ❌ MISSING | |
| 232 | Cost Allocation Rules — Employee Classifications tab (4 types detailed) | ❌ MISSING | No cost allocation page deployed |
| 233 | Cost Allocation Rules — OH Auto-Calc Pipeline visual (QBO P&L feed) | ❌ MISSING | |
| 234 | Cost Allocation Rules — Expense Rules tab | ❌ MISSING | |
| 235 | Cost Allocation Rules — Shared Cost Rules tab (6 rules with $ amounts) | ⬜ SCHEMA | `shared_cost_rules` + `shared_cost_allocations` tables. No page |
| 236 | Time Review — imported from QB Time, AI correction suggestions | ❌ MISSING | `time_entries` table exists. No page |
| 237 | Time Review — batch "Approve All Corrected" | ❌ MISSING | |
| 238 | Two-phase chargeback (Merit-only Phase 1 + white-label Phase 2) — v3.1 enhancement | ❌ MISSING | |

**Category 10 Score: 0 BUILT, 6 PARTIAL, 2 SCHEMA, 10 MISSING = 18 total**

---

## CATEGORY 11: VENDOR MANAGEMENT & COMPLIANCE
*Source: v4.3 §14, Feature Catalog §§28-29*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 239 | Vendor Directory — AI-learned defaults (GL, job, auto-approve at 95%+) | 🔶 PARTIAL | `vendors/page.tsx` + `vendor-list.tsx` deployed. `vendors` table with `ai_confidence`, `auto_approve`. `vendor_patterns` table. Demo data |
| 240 | Vendor compliance — W-9 tracking (no expiration) | ⬜ SCHEMA | `vendor_compliance_docs` table in `005_transactions.sql` |
| 241 | Vendor compliance — GL COI tracking (annual) | ⬜ SCHEMA | Same table |
| 242 | Vendor compliance — WC COI tracking (annual) | ⬜ SCHEMA | Same table |
| 243 | Vendor compliance — WC Exemption tracking | ⬜ SCHEMA | Same table |
| 244 | Missing/expired docs trigger automatic payment holds | ⬜ SCHEMA | `vendor_payment_holds` table exists |
| 245 | Auto-chase: reminders every 2 weeks from 60 days, then weekly | ❌ MISSING | No chase automation |
| 246 | Organization-level outreach (one doc covers all 17 companies) | ❌ MISSING | |
| 247 | Self-service vendor portal via magic link | ❌ MISSING | |
| 248 | Claude auto-parses uploaded compliance documents | ❌ MISSING | |
| 249 | Payment hold overrides — one-time, temporary, permanent | ⬜ SCHEMA | `vendor_payment_holds.override_type` enum |
| 250 | All payment hold overrides audit-logged | ❌ MISSING | |
| 251 | 1099 Tracking page — vendors with $600+ payments, W-9 status, export | ❌ MISSING | No 1099 page deployed |

**Category 11 Score: 0 BUILT, 1 PARTIAL, 6 SCHEMA, 6 MISSING = 13 total**

---

## CATEGORY 12: JOB COSTING & PROJECT ACCOUNTING
*Source: v4.3 §04, §22 — #3 BLOCKER*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 252 | Job/project setup (number, name, customer, contract, estimated cost) | 🔶 PARTIAL | `jobs/page.tsx` + `job-list.tsx` deployed with demo data. `jobs` table in `008_sub_ledgers.sql` |
| 253 | Phase/cost code structure within jobs | ⬜ SCHEMA | `job_phases` + `job_cost_codes` tables in `008_sub_ledgers.sql` |
| 254 | Budget at phase level with cost code breakdown | ❌ MISSING | Schema has budget fields but no budget management UI |
| 255 | Cost tracking by category (labor, materials, subcontractor) | ⬜ SCHEMA | `job_cost_entries` table with `cost_type` enum |
| 256 | WIP schedule (contract, costs to date, % complete, over/under billed) | ⬜ SCHEMA | `v_job_profitability` view exists |
| 257 | Job profitability analysis (margin %, trend, estimated vs actual) | 🔶 PARTIAL | `job-list.tsx` shows profitMargin and pctComplete in demo. `v_job_profitability` view |
| 258 | Progress billing / AIA billing (G702/G703) | ❌ MISSING | No AIA form generation |
| 259 | Change order management (scope, cost, revenue impact, approval) | ⬜ SCHEMA | `change_orders` table in `008_sub_ledgers.sql`. No UI |
| 260 | Retainage tracking (withhold %, receivable, payable, release) | ❌ MISSING | No retainage fields or workflow |
| 261 | Revenue recognition integration (4 methods feed from job data) | ❌ MISSING | |
| 262 | Subcontractor management (agreements, insurance, lien waivers) | ❌ MISSING | |
| 263 | Resource management and utilization reporting | ❌ MISSING | |
| 264 | Project time and expense capture (mobile + receipts) | ❌ MISSING | No mobile app deployed |
| 265 | Estimated vs actual tracking at phase/cost code level | ❌ MISSING | |

**Category 12 Score: 0 BUILT, 2 PARTIAL, 4 SCHEMA, 8 MISSING = 14 total**

---

## CATEGORY 13: FP&A & BUDGETING (Jirav Replacement)
*Source: v4.3 §04, §23*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 266 | Annual budget creation by account, department, entity, period | ❌ MISSING | |
| 267 | Top-down budgeting (set total, allocate across departments) | ❌ MISSING | |
| 268 | Bottom-up budgeting (departments submit, roll up) | ❌ MISSING | |
| 269 | Import prior year actuals as starting point | ❌ MISSING | |
| 270 | Industry-specific budget templates | ❌ MISSING | |
| 271 | Collaborative budget workflow (assign to dept heads) | ❌ MISSING | |
| 272 | Budget version control and audit trail | ❌ MISSING | |
| 273 | Rolling forecasts with auto-update from actuals | ❌ MISSING | |
| 274 | AI-assisted autoforecast (historicals + seasonality) | 🔶 PARTIAL | 13-week forecast has some AI logic. No budget-specific AI |
| 275 | Driver-based forecasting (revenue/cost drivers) | ❌ MISSING | |
| 276 | 3-statement pro forma modeling (P&L, BS, CF simultaneously) | ❌ MISSING | |
| 277 | Cash flow forecasting with working capital assumptions | 🔶 PARTIAL | 13-week forecast deployed |
| 278 | Forecast roll-forward (update with latest actuals in clicks) | ❌ MISSING | |
| 279 | Confidence bands on forecasts | ❌ MISSING | |
| 280 | Scenario planning: create multiple what-if scenarios | ❌ MISSING | |
| 281 | Scenario comparison side-by-side across 3 statements | ❌ MISSING | |
| 282 | NL scenario queries via AI (v3.1) | ❌ MISSING | |
| 283 | Workforce planning (new hires, raises, bonuses, benefits impact) | ❌ MISSING | |
| 284 | Headcount planning with burden rate impact modeling | ❌ MISSING | |
| 285 | Custom KPI creation and tracking | ❌ MISSING | |
| 286 | KPI dashboards configurable by role | ❌ MISSING | |
| 287 | Board/investor reporting packages with AI narrative | ❌ MISSING | |
| 288 | Report export and scheduled delivery | ❌ MISSING | |

**Category 13 Score: 0 BUILT, 2 PARTIAL, 0 SCHEMA, 21 MISSING = 23 total**

---

## CATEGORY 14: EXPENSE MANAGEMENT (Concur Replacement)
*Source: v4.3 §04*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 289 | Receipt capture via mobile camera with AI OCR | ❌ MISSING | No mobile app deployed. Receipt page exists but desktop only |
| 290 | Receipt capture via email forwarding (M365 inbox) | ❌ MISSING | No M365 integration |
| 291 | Receipt data auto-population (vendor, amount, date, category) | 🔶 PARTIAL | Categorization service has this logic but not deployed end-to-end |
| 292 | Receipt-to-card matching (±$5 amount, ±3 days) | 🔶 PARTIAL | Algorithm in categorization service |
| 293 | Receipt chase: push+SMS reminders until submitted | ❌ MISSING | No push notification system |
| 294 | Chase: configurable intervals (15m/30m/1hr/2hr/4hr) | ❌ MISSING | |
| 295 | Chase: escalation thresholds and supervisor notification | ❌ MISSING | |
| 296 | Chase: quiet hours (configurable per org) | ❌ MISSING | |
| 297 | Chase: auto-approve threshold ($10/$25/$50/$100/Never) | ❌ MISSING | |
| 298 | Corporate card feed import and management | 🔶 PARTIAL | Credit cards page deployed with demo data |
| 299 | Formal expense report creation (group expenses into report) | ❌ MISSING | |
| 300 | Expense report multi-level approval chains | ❌ MISSING | |
| 301 | Expense policy engine (rules by category, amount, role) | ❌ MISSING | |
| 302 | Spending limits by employee/department/category | ❌ MISSING | |
| 303 | Out-of-policy flagging with exception workflow | ❌ MISSING | |
| 304 | Per diem auto-calculation (GSA/IRS rates) | ❌ MISSING | |
| 305 | Mileage tracking and reimbursement (IRS standard rate) | ❌ MISSING | |
| 306 | Cash advance tracking | ❌ MISSING | |
| 307 | Reimbursement processing (direct deposit to employee) | ❌ MISSING | |
| 308 | Spend analytics by category/dept/vendor/employee/period | ❌ MISSING | |

**Category 14 Score: 0 BUILT, 3 PARTIAL, 0 SCHEMA, 17 MISSING = 20 total**

---

## CATEGORY 15: FIXED ASSETS — PHYSICAL TRACKING (Asset Panda Replacement)
*Source: v4.3 §04*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 309 | Barcode/QR generation and label printing | ❌ MISSING | |
| 310 | Mobile barcode scanning via camera (no hardware needed) | ❌ MISSING | |
| 311 | Check-in / check-out tracking with history log | ❌ MISSING | |
| 312 | Asset assignment to person / department / location | ❌ MISSING | |
| 313 | Mobile audit with offline mode (sync on reconnect) | ❌ MISSING | |
| 314 | GPS coordinates capture on scan | ❌ MISSING | |
| 315 | Preventive maintenance scheduling with notifications | ❌ MISSING | |
| 316 | Repair ticket creation and cost tracking | ❌ MISSING | |
| 317 | Warranty and insurance tracking with expiration alerts | ❌ MISSING | |
| 318 | Asset photos and document gallery | ❌ MISSING | |
| 319 | Custom fields per asset type/category | ❌ MISSING | |
| 320 | Inspection checklists (custom per asset type) | ❌ MISSING | |
| 321 | Asset kitting / bundling | ❌ MISSING | |
| 322 | Audit discrepancy reporting (expected vs found) | ❌ MISSING | |
| 323 | Asset Panda bidirectional sync (v3.1 enhancement) | ❌ MISSING | |

**Category 15 Score: 0 BUILT, 0 PARTIAL, 0 SCHEMA, 15 MISSING = 15 total**

---

## CATEGORY 16: PRACTICE & CLIENT MANAGEMENT (Double Replacement)
*Source: v4.3 §04 — Maps to MeritBooks Practice tab (MeritWork engine)*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 324 | Client relationship dashboard (close status, open items, staff) | ❌ MISSING | |
| 325 | Client portal (branded, secure document/report sharing) | ❌ MISSING | |
| 326 | Client transaction question workflow (ask → respond → resolve) | ❌ MISSING | |
| 327 | Integrated email client within platform | ❌ MISSING | |
| 328 | Email-to-task conversion | ❌ MISSING | |
| 329 | Task management with tags, assignments, due dates, subtasks | ❌ MISSING | |
| 330 | Workflow templates for repeatable processes | 🔶 PARTIAL | Close checklists serve as workflow templates |
| 331 | Management report generation (P&L, BS, KPIs, graphs in 4 clicks) | ❌ MISSING | |
| 332 | Report templates with client branding | ❌ MISSING | |
| 333 | Time tracking per client with auto-capture from Processor | ❌ MISSING | |
| 334 | Client properties and classification (service tier, industry) | ❌ MISSING | |
| 335 | Internal team chat linked to tasks | ❌ MISSING | |

**Category 16 Score: 0 BUILT, 1 PARTIAL, 0 SCHEMA, 11 MISSING = 12 total**

---

## CATEGORY 17: TEAM PERFORMANCE & ADMINISTRATION
*Source: v4.3 §24, Feature Catalog §§30-33*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 336 | Stack Rankings — Transaction Volume (Receipts, Bills, JEs, Total) | 🔶 PARTIAL | `team/page.tsx` + `team-dashboard.tsx` deployed. Demo data only |
| 337 | Stack Rankings — Dollar Volume (Receipt $, Bill $, JE $, Total $, Avg $/Txn) | ❌ MISSING | Single view in demo, not 4 distinct rankings |
| 338 | Stack Rankings — Companies Managed (count, assigned entities, txns/company, backlog) | ❌ MISSING | |
| 339 | Stack Rankings — Timeliness (avg time/txn, same-day %, within 24hr %, overdue, trend) | ❌ MISSING | |
| 340 | Stack Rankings — 5 time periods (Daily, Weekly, Monthly, Quarterly, Yearly) | ❌ MISSING | |
| 341 | Stack Rankings — Status badges (On Fire, On Track, Improving, Behind) | ❌ MISSING | |
| 342 | Billing Efficiency — production employees hrs billed vs 37.5hr target, stack-ranked | ❌ MISSING | |
| 343 | Billing Efficiency — <70% utilization for 2 periods = flagged | ❌ MISSING | |
| 344 | User Management — table with role, companies, last active, invite button | 🔶 PARTIAL | `team/team-dashboard.tsx` has user listing in demo data |
| 345 | User Management — Invite User functionality | ❌ MISSING | No invite flow |
| 346 | User Management — Dynamic sidebar per role | 🔶 PARTIAL | `sidebar.tsx` shows all nav items but no role-based filtering |
| 347 | Department Setup Wizard — AI-powered (describe workflow in English) | ❌ MISSING | |
| 348 | Department Setup — Configuration Lock (web vs mobile) | ❌ MISSING | |
| 349 | Department Setup — Overview Grid with status cards | ❌ MISSING | |
| 350 | Department Setup — PM tool integrations (ClickUp, Jira, etc.) | ❌ MISSING | |
| 351 | Settings — Organization (name, contact, email) | 🔶 PARTIAL | `settings/page.tsx` + `settings-tabs.tsx` deployed |
| 352 | Settings — Integrations (M365, Plaid status per company) | 🔶 PARTIAL | Settings page exists but no live integrations |
| 353 | Settings — Receipt Chase full configuration (timing, escalation, channels, quiet hours, auto-approve) | ❌ MISSING | |
| 354 | Settings — Credit Card Assignments (card → cardholder mapping) | ❌ MISSING | |
| 355 | Settings — Portfolio Companies management with Add Company modal | ❌ MISSING | |
| 356 | Settings — AI Usage Dashboard (cost by feature, by company, cache hit rate) | ❌ MISSING | |

**Category 17 Score: 0 BUILT, 5 PARTIAL, 0 SCHEMA, 16 MISSING = 21 total**

---

## CATEGORY 18: AI INTELLIGENCE FEATURES
*Source: v4.3 §07, Feature Catalog §§34-36*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 357 | CPA Desk — in-app AI accounting advisor (slide-out, indigo theme) | ❌ MISSING | |
| 358 | CPA Desk — context awareness (screen, COA, GL rules, GAAP) | ❌ MISSING | |
| 359 | CPA Desk — quick-action buttons (categorization, GAAP, amortization, capitalize vs expense, GL lookup) | ❌ MISSING | |
| 360 | CPA Desk — set up recurring JE from AI response | ❌ MISSING | |
| 361 | CPA Desk — every session audit-logged | ❌ MISSING | |
| 362 | System Console — admin AI development interface (emerald theme) | ❌ MISSING | |
| 363 | System Console — maintenance mode toggle | ❌ MISSING | |
| 364 | System Console — NL change requests → Claude generates code diffs | ❌ MISSING | |
| 365 | System Console — Apply/Preview/Reject buttons | ❌ MISSING | |
| 366 | Suggest a Feature — user submission modal with status tracking | ❌ MISSING | |
| 367 | AI Learn From Every Correction — vendor pattern update on human correction | 🔶 PARTIAL | `categorization.ts` has `learnFromCorrection()` method |
| 368 | AI Cost Transparency — per-feature, per-company usage tracking | ❌ MISSING | `ai_audit_log` table exists but no dashboard |

**Category 18 Score: 0 BUILT, 1 PARTIAL, 0 SCHEMA, 11 MISSING = 12 total**

---

## CATEGORY 19: ONBOARDING & SETUP
*Source: v4.3 §08, Feature Catalog §§1-3*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 369 | Org Setup Wizard — Step 1: Organization Profile | ❌ MISSING | No onboarding wizard deployed |
| 370 | Org Setup Wizard — Step 2: Connect Banking (Plaid) | ❌ MISSING | |
| 371 | Org Setup Wizard — Step 3: Portfolio Companies | ❌ MISSING | |
| 372 | Org Setup Wizard — Step 4: Chart of Accounts (251 seed accounts) | ❌ MISSING | |
| 373 | Org Setup Wizard — Step 5: Team Setup | ❌ MISSING | |
| 374 | Org Setup Wizard — Step 6: Overhead Allocation Configuration | ❌ MISSING | |
| 375 | Org Setup Wizard — Step 7: Email Integration (M365 OAuth2) | ❌ MISSING | |
| 376 | Org Setup Wizard — Step 8: Review & Launch (confetti) | ❌ MISSING | |
| 377 | Accountant Onboarding — Step 1: Profile | ❌ MISSING | |
| 378 | Accountant Onboarding — Step 2: Rev Rec setup per company | ❌ MISSING | |
| 379 | Accountant Onboarding — Step 3: GL Classification & Chargeback rules training | ❌ MISSING | |
| 380 | Accountant Onboarding — Step 4: Platform Tour | ❌ MISSING | |
| 381 | Accountant Onboarding — Step 5: Preferences & Go | ❌ MISSING | |
| 382 | Department Setup Wizard — AI config from plain English description | ❌ MISSING | |

**Category 19 Score: 0 BUILT, 0 PARTIAL, 0 SCHEMA, 14 MISSING = 14 total**

---

## CATEGORY 20: MOBILE APPLICATION
*Source: v4.3 §15, Feature Catalog Mobile section*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 383 | Time Clock — Company picker (assigned + supervisor-gated) | ❌ MISSING | No mobile app deployed at all |
| 384 | Time Clock — Job picker (from ERP sync) | ❌ MISSING | |
| 385 | Time Clock — Phase picker (Demo, Rough-In, Trim, Punch List) | ❌ MISSING | |
| 386 | Time Clock — Live timer with GPS confirmation | ❌ MISSING | |
| 387 | Time Clock — Manual hours for office workers (no timer, no GPS) | ❌ MISSING | |
| 388 | Time Clock — 6 department-specific quick-tag sets | ❌ MISSING | |
| 389 | Time Clock — Merit/All access supervisor approval gate | ❌ MISSING | |
| 390 | Time Clock — Switch job capability during active timer | ❌ MISSING | |
| 391 | Time Clock — Time history (this week + last week) | ❌ MISSING | |
| 392 | Receipt Capture — Overdue receipt chase cards | ❌ MISSING | |
| 393 | Receipt Capture — Camera with alignment frame | ❌ MISSING | |
| 394 | Receipt Capture — AI processing animation | ❌ MISSING | |
| 395 | Receipt Capture — Pre-populated confirm screen (vendor, amount, date) | ❌ MISSING | |
| 396 | Receipt Capture — 6 purchase type options (Materials, Tools, Gas, Meals, Office, Not sure) | ❌ MISSING | |
| 397 | Receipt Capture — Card match notice | ❌ MISSING | |
| 398 | Receipt Capture — Push notification ("Missing receipt: Shell Gas $68.42...") | ❌ MISSING | |
| 399 | Mobile Department Setup — 4-step wizard | ❌ MISSING | |
| 400 | Mobile Activity Feed | ❌ MISSING | |

**Category 20 Score: 0 BUILT, 0 PARTIAL, 0 SCHEMA, 18 MISSING = 18 total**

---

## CATEGORY 21: SECURITY, RBAC & PLATFORM
*Source: v4.3 §§16-17, Feature Catalog Security section*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 401 | Clerk SSO with multi-tenant orgs | ✅ BUILT | `middleware.ts` has Clerk integration. `sign-in` page deployed |
| 402 | JWT with org/role claims + JWKS validation | 🔶 PARTIAL | Middleware exists. Claims processing needs verification |
| 403 | MFA enforced for Admin and CFO roles | ❌ MISSING | No MFA enforcement |
| 404 | 7 web roles (Org Admin, CFO, Acct Mgr, Sr Accountant, Accountant, Check Processor, Viewer) | 🔶 PARTIAL | Navigation exists but no role-based filtering. Schema supports roles |
| 405 | 3 mobile roles (Field Worker, Department Head, Cardholder) | ❌ MISSING | No mobile app |
| 406 | Screen-level permissions per role | ❌ MISSING | All pages visible to all users |
| 407 | PostgreSQL RLS on every table | ✅ BUILT | Every migration file has RLS policies with org_id isolation |
| 408 | AES-256-GCM encryption for integration credentials | ❌ MISSING | No encryption implementation |
| 409 | Session management (30-min idle, 12-hr absolute, 5 concurrent max) | ❌ MISSING | |
| 410 | IP allowlisting by CIDR for admin roles | ❌ MISSING | |
| 411 | Account lockout after 5 failed attempts | ❌ MISSING | |
| 412 | Device fingerprinting | ❌ MISSING | |
| 413 | Soft deletes for financial data | 🔶 PARTIAL | Some tables have `deleted_at`. Not consistent across all financial tables |
| 414 | AI audit trail (model version, prompt, output, confidence, human response) | ⬜ SCHEMA | `ai_audit_log` table in `007_close_audit_compliance.sql` |
| 415 | Data export tracking (user, timestamp, scope, format) | ❌ MISSING | |
| 416 | Dark/Light theme toggle | ❌ MISSING | CSS has dark theme only. No toggle |
| 417 | Company Switcher (global filter) | ❌ MISSING | No company filter in header |
| 418 | Emerald brand (#10b981), Plus Jakarta Sans + JetBrains Mono | ✅ BUILT | `globals.css` + `tailwind.config.ts` confirm emerald brand and fonts |

**Category 21 Score: 3 BUILT, 3 PARTIAL, 1 SCHEMA, 11 MISSING = 18 total**

---

## CATEGORY 22: AUTOMATION PIPELINE
*Source: v4.3 §19*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 419 | Hourly: Email Sync (M365 inbox → Claude parse → route → store → attach to JE) | ❌ MISSING | |
| 420 | Daily 1:00 AM: Bank Feed Categorization (pull → match → auto-categorize → queue) | ❌ MISSING | |
| 421 | Monthly 1st 12:01 AM: OH Rate Recalculation (pull P&L → recalc burden rate) | ❌ MISSING | Formula exists in service but no scheduled job |
| 422 | Monthly 1st 2:00 AM: Revenue Recognition (calc % → generate JEs → post → snapshot) | ❌ MISSING | |
| 423 | Configurable cadence: Chargeback Generation | ❌ MISSING | |
| 424 | Continuous: Receipt Chase (event-driven push+SMS on CC transaction) | ❌ MISSING | |
| 425 | Daily: Vendor Compliance Check (scan for expiring COIs, send chase) | ❌ MISSING | |

**Category 22 Score: 0 BUILT, 0 PARTIAL, 0 SCHEMA, 7 MISSING = 7 total**

---

## CATEGORY 23: v3.1 APPROVED ENHANCEMENTS
*Source: v4.3 §25*

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 426 | Configurable quiet hours per-org (replacing hardcoded 9PM-6AM) | ❌ MISSING | |
| 427 | Office worker start/stop timer (no GPS) on web + mobile | ❌ MISSING | |
| 428 | NL scenario modeling for 13-week forecast (chainable) | ❌ MISSING | |
| 429 | Two-phase chargebacks (Merit Phase 1 + white-label Phase 2) | ❌ MISSING | |
| 430 | Asset Panda bidirectional sync | ❌ MISSING | |
| 431 | Borrowing base calculator (upload bank template, auto-fill from AR/inventory) | ❌ MISSING | |
| 432 | Subscription/large annual charge tracker (pattern-based alerts) | ❌ MISSING | |
| 433 | Usage cost per company (AI + infrastructure, feeds billing) | ❌ MISSING | |
| 434 | CPA Desk → MeritContext (persistent memory across sessions) | ❌ MISSING | |
| 435 | 3 white-label tiers (Processor, Practice, Complete) | ❌ MISSING | |
| 436 | Module selection config via System Console (AI-powered) | ❌ MISSING | |

**Category 23 Score: 0 BUILT, 0 PARTIAL, 0 SCHEMA, 11 MISSING = 11 total**

---

## GRAND SUMMARY

| Category | BUILT | PARTIAL | SCHEMA | MISSING | Total |
|----------|-------|---------|--------|---------|-------|
| 1. GL & COA | 12 | 6 | 5 | 5 | 28 |
| 2. Accounts Payable | 0 | 4 | 2 | 17 | 23 |
| 3. Accounts Receivable | 0 | 3 | 3 | 15 | 21 |
| 4. Banking & Reconciliation | 0 | 8 | 0 | 5 | 13 |
| 5. Financial Reporting | 0 | 3 | 4 | 28 | 35 |
| 6. Month-End Close & Audit | 0 | 2 | 1 | 29 | 32 |
| 7. Transaction Processing | 0 | 14 | 0 | 8 | 22 |
| 8. Financial Mgmt Screens | 0 | 3 | 5 | 27 | 35 |
| 9. Cash Intelligence | 0 | 2 | 0 | 9 | 11 |
| 10. Chargeback Engine | 0 | 6 | 2 | 10 | 18 |
| 11. Vendor Mgmt & Compliance | 0 | 1 | 6 | 6 | 13 |
| 12. Job Costing & Projects | 0 | 2 | 4 | 8 | 14 |
| 13. FP&A & Budgeting | 0 | 2 | 0 | 21 | 23 |
| 14. Expense Management | 0 | 3 | 0 | 17 | 20 |
| 15. Fixed Assets Physical | 0 | 0 | 0 | 15 | 15 |
| 16. Practice & Client Mgmt | 0 | 1 | 0 | 11 | 12 |
| 17. Team & Administration | 0 | 5 | 0 | 16 | 21 |
| 18. AI Intelligence | 0 | 1 | 0 | 11 | 12 |
| 19. Onboarding & Setup | 0 | 0 | 0 | 14 | 14 |
| 20. Mobile Application | 0 | 0 | 0 | 18 | 18 |
| 21. Security, RBAC, Platform | 3 | 3 | 1 | 11 | 18 |
| 22. Automation Pipeline | 0 | 0 | 0 | 7 | 7 |
| 23. v3.1 Enhancements | 0 | 0 | 0 | 11 | 11 |
| **TOTALS** | **15** | **69** | **33** | **344** | **461** |

---

## COVERAGE ANALYSIS

**Total Features Audited: 461**

| Status | Count | % |
|--------|-------|---|
| ✅ BUILT (fully deployed & functional) | 15 | 3.3% |
| 🔶 PARTIAL (some pieces exist) | 69 | 15.0% |
| ⬜ SCHEMA (database only) | 33 | 7.2% |
| ❌ MISSING (nothing built) | 344 | 74.6% |

**Effective coverage (BUILT + PARTIAL): 84 of 461 = 18.2%**

**What's actually solid:** The database schema is well-designed. 55 tables across 9 migrations with proper RLS, 6 enforcement triggers, and 9 reporting views. The GL foundation (COA hierarchy, dimensional model, balanced-entry enforcement, period locking, COA approval workflow) is production-grade. The schema for sub-ledgers (jobs, invoices, fixed assets, intercompany) exists but has zero frontend or API coverage.

**What's deployed as UI:** 21 pages with demo data and basic navigation. Zero pages are wired to live database queries. Every page renders hardcoded demo arrays. The pages look good (emerald brand, clean layout) but are essentially interactive mockups.

**The 3 Blockers (from v4.3 §27):**
1. **Financial Reporting Engine** — 0/35 BUILT. Cannot be a book of record without P&L, BS, CF, TB
2. **Accounts Receivable** — 0/21 BUILT. Portfolio companies invoice customers
3. **Job Costing & Project Accounting** — 0/14 BUILT. HVAC/construction are job-based businesses

---

## RECOMMENDED BUILD SEQUENCE

Based on dependency analysis and business impact:

| Priority | Module | Features | Rationale |
|----------|--------|----------|-----------|
| P0-BLOCKER | Financial Reporting Engine | 35 | Can't function as book of record without statements. Wire existing views to UI |
| P0-BLOCKER | Wire all pages to Supabase | 21 pages | Replace demo data with real queries. Foundation for everything else |
| P1-HIGH | Accounts Receivable | 21 | Revenue collection invisible without AR. Schema exists |
| P1-HIGH | Job Costing & Projects | 14 | HVAC/construction core business. Schema exists |
| P1-HIGH | Bank Reconciliation | 13 | Every book of record needs bank rec |
| P2-HIGH | AP Payment Processing | 23 | Bills exist but can't be paid |
| P2-HIGH | FP&A / Budgeting | 23 | Team actively uses Jirav today |
| P3-MEDIUM | Month-End Close | 32 | Schema + page partially exist |
| P3-MEDIUM | Chargeback Engine wiring | 18 | Core Merit value prop |
| P3-MEDIUM | Fixed Assets (financial) | 8 | Schema exists, need UI + automation |
| P4-MEDIUM | Onboarding Wizard | 14 | Required for white-label customers |
| P4-MEDIUM | RBAC enforcement | 7+ | Screen-level permissions needed |
| P5-LOWER | Expense Management | 20 | Receipt capture exists, need policies |
| P5-LOWER | Vendor Compliance automation | 13 | Schema exists, need chase engine |
| P6-FUTURE | Mobile Application | 18 | React Native from HTML prototype |
| P6-FUTURE | AI Intelligence (CPA Desk, Console) | 12 | Value-add, not blocker |
| P6-FUTURE | Practice Management | 12 | MeritWork engine prerequisite |
| P6-FUTURE | Physical Asset Tracking | 15 | Asset Panda replacement |
| P6-FUTURE | v3.1 Enhancements | 11 | Post-launch enhancements |
