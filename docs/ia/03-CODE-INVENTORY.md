# MeritBooks code inventory (code-evidence audit, 2026-10-17)

Maturity: LIVE = real data, wired · PARTIAL = exists with gaps/AI-dependent/credential-gated · STUB/MOCK · PLANNED-ONLY.
Global caveats: Plaid SANDBOX, Stripe TEST, prod on Clerk dev instance; Anthropic org reported disabled (AI degrades gracefully).
Retired (do not rebuild): chargeback engine, overhead/burden rate, 5 labor classifications, cost-allocation rules, in-app time tracking (→ PM module), MeritContext, coded platform-fee GL path.

## GL & multi-entity
COA tree + approval workflow (/chart-of-accounts) LIVE · 4 dimensions (location/dept/class/item) LIVE · manual JEs draft/post, control-account protection LIVE · recurring JEs (propose→approve→post, reversing) LIVE · fiscal periods + DB lock on insert (152) + posted-GL immutability (153) LIVE · year-end close to RE LIVE · reporting-basis overlay (accrual/cash/tax/custom) LIVE · multi-company add w/ COA seed LIVE · statistical accounts/period 13 PLANNED · transactional multi-currency PLANNED (FX only in consolidation).

## Consolidation & intercompany
Consolidated statements, ownership %, NCI, eliminations (/consolidation) LIVE · FX translation ASC 830 LIVE · intercompany matching & pair balances LIVE · internal (intercompany/department) invoices (/internal-invoices) LIVE · intercompany loans + promissory notes PLANNED.

## Close
Close Command Center: ordered task graph, 14 auto-verified checks, blocking hard-close gate (/close) LIVE · close status board across entities LIVE · close package export LIVE · close-run agent recipe PARTIAL (AI) · working papers/tickmarks/reviewer sign-off PLANNED.

## Bank feed & reconciliation
Plaid link/sync/map LIVE(sandbox) · bank-feed coding w/ confidence bands, approve/flag, bulk by band/vendor, saved views, duplicate detection (/bank-feed) LIVE · credit-card feed LIVE · statement PDF import (AI) PARTIAL (no CSV/OFX/BAI2) · reconciliation workspace, autopilot match (vendor40/amount40/date20), adjustment suggestions, difference decomposer, outstanding aging (/reconciliation) LIVE · AR/GL tie-out LIVE · transfers between accounts/entities PLANNED.

## AP / bills / payments
Bills create/intake/coding/hold (/bills) LIVE · AI bill OCR + intake queue PARTIAL (Azure DI creds) · inbound email→bill webhook PARTIAL (needs mail provider) · AP policy engine (NL→rules) LIVE · purchase orders, goods receipts, 3-way match LIVE · retainage payable/receivable LIVE · **pay runs / check processing: batches, check-number assignment, approve, release, remittance PDF (/checks, /api/ap/disbursements/*) LIVE (no check printing/MICR)** · positive-pay CSV + NACHA-shaped export PARTIAL · ACH/wire origination STUB · vendor payment profiles LIVE · vendors/vendor 360/ledger/dup detection LIVE · expenses (reports, lines, card match, approver queue, reimbursement batch, mileage/per-diem policy) LIVE · **receipts (upload, categorize, submit) LIVE (no mobile capture; receipt chase by SMS/push PLANNED)** · cost-approval rules LIVE · vendor credits UI, recurring bills, early-pay discounts, virtual card, delegation, requisitions PLANNED.

## AR / invoicing / collections
Invoices create/edit/void/write-off w/ dims, sales tax, retainage LIVE · invoice branding per entity + PDF LIVE · Resend email LIVE · recurring invoices LIVE · credit memos LIVE · estimates→invoice LIVE · customer deposits/retainers LIVE · Stripe Pay Now (/pay/[token]) LIVE(test) · cash application LIVE · collections worklist, dunning drafts, promise-to-pay, DSO (/collections) LIVE · customer statements + AR ledger LIVE · unified AR aging incl. unbilled 1180 LIVE · customers dedupe/merge, risk dossier LIVE · contract import→invoice schedule PARTIAL (AI) · AIA G702/G703 only in Projects app.

## Cash & treasury
Cash position across entities (/cash) LIVE · 13-week/direct cash forecast LIVE · renewals & obligations calendar (/obligations) LIVE · subscriptions tracker LIVE · **borrowing base calculator + certificate (/borrowing-base) LIVE** · min-cash alerts/transfer recommendations PLANNED.

## Debt & covenants
**Debt register: origination JE, P&I split, payoff, refinance, schedule (/debt) LIVE · loan doc parse → loan + covenants PARTIAL (AI) · covenant monitor (DSCR/FCCR/leverage), compute, compliance certificate (/debt tab, /covenants) LIVE** · existing-loan mode (no origination JE) LIVE.

## Leases / fixed assets / schedules
ASC 842 leases (commence, record period, CPI, modify, terminate) LIVE · lease parse PARTIAL · fixed assets (SL/DDB/MACRS/bonus, schedule, roll-forward, disposal) LIVE · tax depreciation book LIVE · prepaids LIVE · insurance (policy→prepaid amortization) LIVE · intangibles (amortize, impair) LIVE · physical asset tracking PLANNED.

## Payroll
Payroll register import → balanced JE (/payroll) LIVE · employees, pay schedules, register mappings LIVE · payroll runs (mock engine) STUB · Check/Gusto provider STUB (provider not chosen) · remittance LIVE · W-2/filing/direct deposit PLANNED.

## Jobs / WIP / construction / inventory
Jobs, job P&L, cost codes, change orders (/jobs) LIVE · WIP schedule (over/under billing), EAC (/jobs/wip) LIVE · Projects→Books event seam LIVE · inventory: items, movements w/ approval, FIFO/standard valuation, GL tie-out, reorder scan LIVE · lien waivers, subcontractor mgmt PLANNED.

## Revenue recognition
**9 methods per job (as-billed, % complete/cost-to-cost, completed contract, milestone, straight-line, subscription, point-of-sale…), deferred revenue 2410 (/rev-rec) LIVE · unbilled accrual 1180 self-reversing LIVE · deferred roll-forward, waterfall, method summary LIVE.**

## Tax
Sales-tax rate engine LIVE · Avalara/TaxJar STUB · sales-tax return worksheet + filing calendar (/tax/sales-tax) LIVE · 1099 NEC/MISC, W-9 gaps, Copy B, FIRE file (/vendor-compliance, /compliance-1099) PARTIAL (needs IRS TCC) · book-to-tax M-1/M-3 LIVE · ASC 740 provision LIVE · 1120-style return package LIVE · nexus tripwire LIVE.

## FP&A / budgets
**Budgets by account/entity, BvA (/budgets) LIVE · driver-based budgeting, reforecast, scenario modeler LIVE · budget import LIVE · FP&A dashboard, what-if/sensitivity, NL scenarios (/fpna) LIVE · profitability by entity (/profitability) LIVE** · versions/collaboration/workforce planning PLANNED.

## Reporting
P&L, P&L by month, BS, TB, cash flow (indirect/direct), equity changes, GL detail, txn list, open items, AR/AP aging, customer/vendor balances, sales by customer, expense by vendor, debt schedule, job cost, WIP (/reports) LIVE · comparatives, drill, saved views, export PDF/CSV/XLSX LIVE · report packs + scheduled email PARTIAL (no cron) · NL report compiler PARTIAL · flux narrative PARTIAL · board package (/board-package) LIVE · search (Postgres FTS) LIVE · role KPI dashboards, custom report writer PLANNED.

## Controls / exceptions / audit
Exception library (12 deterministic detectors: duplicate payment, missed accrual, intercompany imbalance, uncategorized leakage, revenue not recognized, nexus, anomalous JE, cutoff, cash application, bill anomaly, out-of-policy expense, payment fraud) LIVE · Action Inbox (/inbox) LIVE · Compliance & Controls / SOX command center (/compliance) LIVE · audit trail (/audit) LIVE · external auditor role + PBC (/pbc) LIVE · AI Decision Log (/ai-decisions) LIVE · approval workflows N-step by doc type/amount tier, simulator (/settings/approvals) LIVE · vendor compliance W-9/COI (/vendor-compliance) LIVE · observability LIVE.

## Onboarding / migration
Front door, self-serve org, wizard, readiness, tour LIVE · drop-anything intake PARTIAL (AI) · TB import (XLSX/QBO/AI), AR/AP/WIP/equity imports, formation docs LIVE · historical conversion w/ tie-out gate LIVE · many-companies onboarding LIVE · generic CSV import LIVE · sandbox, tenant reset/export LIVE.

## Integrations
QuickBooks Online OAuth pull PARTIAL (needs QBO_* creds) · Xero/Sage connectors STUB · Plaid LIVE(sandbox) · Stripe LIVE(test) · Resend LIVE · Clerk LIVE(dev) · Azure DI PARTIAL · Check payroll/Avalara/ACH STUB · Sentry PARTIAL · ERP catalog (~25 systems: ServiceTitan, Procore, Buildertrend…) PLANNED · M365 email ingestion blocked · **Ramp: NONE (planned, top priority)**.

## Admin / RBAC / security
System roles, custom roles (cloned from system role) + cell-level permission overrides (mig 130), role-filtered sidebar, page guards LIVE · money-movement SoD (preparer≠approver≠releaser) LIVE · team members, invites, deactivate LIVE · RLS on org_id only (client-level access is UI-only — MUST FIX) · AI autonomy dial per feature + kill switch (/settings/autonomy) LIVE · plan & billing STUB · operator console (/platform) LIVE · MFA/IP allowlist/session policy PLANNED.

## Portals & practice
Customer portal (magic link: invoices, balance, statement, pay) LIVE · vendor portal (W-9/COI/banking upload) LIVE · auditor access LIVE · firm-client portal (questions, document chase) PLANNED · team performance KPIs (/team) LIVE · client health LIVE · practice task mgmt PLANNED.

## Projects module (apps/projects, separate app, proj.* schema)
Jobs, cost codes, costs, schedule/dispatch, procurement commitments, billing (SOV, AIA), draws, retainage release, allowances, gates — LIVE/PARTIAL; talks to Books only via core.events.

## AI features (all via runAiGateway)
Extraction: BILL_PARSE, AP_DOC_INTAKE, STATEMENT_EXTRACT, CATEGORIZATION (vendor memory), CONTRACT_EXTRACT, ASSET_EXTRACT, LEASE_EXTRACT, DEBT_EXTRACT, COVENANT_EXTRACT, INSURANCE_EXTRACT, PREPAID_EXTRACT/SCHEDULE, SUBSCRIPTION_EXTRACT, W9/COI_EXTRACT, PAYROLL_REGISTER_EXTRACT, AP/EXPENSE_POLICY_EXTRACT, onboarding TB/WIP/EQUITY/FORMATION/INTAKE_CLASSIFY/CONVERSION_MAP.
Drafting: JE_COMPOSER, NL_ROUTER/QUERY/SAVED_QUESTION (⌘K), NL_BILL/INVOICE_DRAFT, NL_CATEGORIZE, NL_SCENARIO, BUDGET_DRIVER_MODEL/SCENARIO, DUNNING_DRAFT, RECON_MEMO/ADJUSTMENT, FLUX_NARRATIVE, BOARD_NARRATIVE, REPORT_COMPILER, COVENANT_DRIFT, CUSTOMER_RISK_SUMMARY/DEDUPE, JOB_EAC, OBJECT_EXPLAIN, SEARCH_PARSE, BOOK_TAX_TAG/DEPR.
Detect: EXCEPTION_PREDICTION, PAYMENT_FRAUD, THREE_WAY_MATCH, VENDOR_COMPLIANCE_RISK, INVENTORY_REORDER, SUBSCRIPTION_SCAN, W9_1099_GAP + the 12 deterministic detectors.
Agents: AGENT_ORCHESTRATION (AUTO/PROPOSE/HUMAN_GATE) with recipes AP intake, procure-to-pay, pay-run, close-run, order-to-cash, collections autopilot; learning (vendor memory, learned preferences).
