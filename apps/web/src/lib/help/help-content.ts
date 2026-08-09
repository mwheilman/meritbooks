/**
 * Route-keyed help content registry.
 *
 * Maps a route path (or the closest parent path) to a concise, page-specific
 * explanation surfaced by the in-app HelpButton ("?" icon). Content is written
 * to be accurate to what each page actually does — it names real features that
 * exist in the product, not aspirational ones.
 *
 * Lookup order (see `getHelpContent`):
 *   1. Exact pathname match.
 *   2. Longest matching parent prefix (so /portfolio/abc → /portfolio,
 *      /inventory/123 → /inventory, /bills/policy → /bills/policy then /bills).
 *   3. A sensible generic fallback.
 *
 * Keep entries short and specific. `whatItDoes` is one or two sentences.
 * `keyFeatures` are the load-bearing capabilities. `tips` are optional
 * power-user notes.
 */

export interface HelpContent {
  /** Human title shown in the panel header (usually the page name). */
  title: string;
  /** One or two sentences: what this page is for. */
  whatItDoes: string;
  /** The capabilities worth calling out. */
  keyFeatures: string[];
  /** Optional power-user tips / things people miss. */
  tips?: string[];
}

/**
 * The registry. Keys are pathnames under the authenticated app.
 * Order does not matter — lookup does longest-prefix resolution.
 */
export const HELP_CONTENT: Record<string, HelpContent> = {
  '/dashboard': {
    title: 'Dashboard',
    whatItDoes:
      'Your portfolio overview across every entity — the health of the books at a glance, read live from the general ledger rather than asserted.',
    keyFeatures: [
      'Cross-entity KPIs and balances rolled up from posted GL activity',
      'Fast jump-off points into the modules that need attention',
      'Numbers reflect the real ledger, so they always tie to the reports',
    ],
    tips: [
      'Use the company selector in the top bar to scope the view to a single entity or All Companies.',
      'Press ⌘/ to open search, or ⌘K for the CPA Desk command bar from anywhere.',
    ],
  },

  '/inbox': {
    title: 'Inbox',
    whatItDoes:
      'Everything that needs a human, in one queue — approvals and policy blocks, AI-flagged exceptions you can resolve inline, time-sensitive alerts, and unposted drafts.',
    keyFeatures: [
      'Unified approval queue across bills, journal entries, payments, expenses, and payroll',
      'AI exceptions (duplicate payments, anomalous entries, uncategorized leakage) resolvable without leaving the page',
      'Time-sensitive alerts and unposted drafts surfaced before they become problems',
    ],
    tips: [
      'This is the fastest daily driver — clear the Inbox and the books stay current.',
      'Policy-blocked items show exactly which rule stopped them and what will cure it.',
    ],
  },

  '/bank-feed': {
    title: 'Bank Feed',
    whatItDoes:
      'AI-categorized bank and card transactions, sorted lowest-confidence first so your attention lands where it matters. Approve, flag, or edit each one; high-confidence items batch-approve.',
    keyFeatures: [
      'Confidence bars and match badges (matched to bill, matched to receipt, unmatched)',
      'Composite match score = vendor 40% + amount 40% + date 20%; auto-categorize at ≥90%',
      'Smart batch selection ("select all ≥90%") and click-a-vendor to select every transaction from them',
      'Edit slide-out with inline GL account search, vendor recents, and the AI reasoning behind each suggestion',
      'Credit-card statement reconciliation and Apply Deposits (cash application) live as tabs alongside the feed',
    ],
    tips: [
      'Keyboard shortcuts: j/k to move, a to approve, f to flag, Space to select, Esc to close.',
      'Refresh pulls new transactions and re-runs duplicate detection.',
      'The old /credit-cards and /cash-application URLs now redirect into the Credit Cards and Apply Deposits tabs here.',
    ],
  },

  '/bills': {
    title: 'Bills (Accounts Payable)',
    whatItDoes:
      'Vendor invoices with AI extraction and compliance tracking — capture a bill, let the AI read it, and route it through approval to a scheduled payment.',
    keyFeatures: [
      'Drop-and-parse intake: email or upload a bill and the AI extracts vendor, amount, dates, and GL coding',
      'Vendor compliance gate — a missing or expired W-9/COI blocks payment until cured or overridden',
      '3-way match against purchase orders and goods receipts where a PO exists',
      'Routes into the approval workflow, then to a check run / disbursement batch',
    ],
    tips: [
      'The intake queue holds partially-read bills so you can confirm the AI extraction before it becomes a bill.',
      'Bill approval policies (Bills → Policy) let you set who must approve by amount tier.',
    ],
  },

  '/bills/policy': {
    title: 'Bill Approval Policy',
    whatItDoes:
      'Define the deterministic rules that govern how bills are approved and paid — who signs off, at what amount, and what conditions block a payment.',
    keyFeatures: [
      'Amount-tiered approval requirements enforced on every bill',
      'Deterministic engine — the same policy applies identically every time, with a clear audit trail',
      'Versioned rulesets you review and activate',
    ],
  },

  '/bills/intake-queue': {
    title: 'Bill Intake Queue',
    whatItDoes:
      'The staging area for AI-read bills — documents that arrived by email or upload and have been parsed, waiting for you to confirm before they post as bills.',
    keyFeatures: [
      'Provider-agnostic email-to-bill and drop-and-parse capture',
      'Side-by-side of the source document and the AI-extracted fields',
      'Confirm, correct, or reject before anything hits AP',
    ],
  },

  '/invoices': {
    title: 'Invoices (Accounts Receivable)',
    whatItDoes:
      'Create, send, and track customer invoices — from draft through sent, paid, and, when needed, written off to bad debt. AR aging is derived from real invoice state.',
    keyFeatures: [
      'Email an invoice with a hosted, tokenized pay page (Stripe card / ACH)',
      'Payment → PAID → balanced GL post is automatic and resume-safe (the database guarantees no double-post)',
      'Write-off to bad debt with the correct GL role; written-off invoices drop out of AR aging',
      'Sales tax calculated at invoice time by jurisdiction where configured',
    ],
    tips: [
      'Collections & DSO gives you the aging worklist and overdue chase; the Collections module adds risk-scored dunning.',
      'Drop a customer contract/SOW and the AI proposes an invoice and a revenue-recognition schedule.',
    ],
  },

  '/journal-entries': {
    title: 'Journal Entries',
    whatItDoes:
      'Create, review, and post manual journal entries to the general ledger. Double-entry is enforced at the database — an unbalanced entry cannot post.',
    keyFeatures: [
      'Balanced-entry enforcement plus period-lock, control-account, and approved-account guards',
      'Compose entries by hand or describe them in natural language and let the AI draft the lines',
      'Full approval and audit trail with machine-vs-human attribution',
    ],
    tips: [
      'Recurring Journal Entries automate standard monthly accruals from a template.',
      'Entries only post into an OPEN or SOFT_CLOSE period — check Fiscal Periods if a post is rejected.',
    ],
  },

  '/recurring-journal-entries': {
    title: 'Recurring Journal Entries',
    whatItDoes:
      'Templates for standard monthly accruals and allocations — define the entry once, and each period it is generated for approval and posting.',
    keyFeatures: [
      'Reusable templates with per-period generation',
      'Runs land in an approval queue before they post — never silently',
      'Active/total template counts and awaiting-approval status at a glance',
    ],
  },

  '/reconciliation': {
    title: 'Bank Reconciliation',
    whatItDoes:
      'Clear statement lines against the GL and reconcile the account to the statement balance — with an auto-match assist and a must-tie gate before close.',
    keyFeatures: [
      'Line check-off and lock, with a running cleared-vs-statement difference',
      'Statement-PDF OCR anchor and auto check-off of matched lines',
      'Plug / stale-item detector and an AI-drafted reconciliation memo',
      'Auto-adjusting entries for the small, explainable differences',
    ],
    tips: [
      'The reconciliation must tie before the period can be hard-closed — this is a close gate, not just a report.',
    ],
  },

  '/reports': {
    title: 'Financial Reports',
    whatItDoes:
      'Generate financial statements from GL data across one or all entities — balance sheet, P&L, trial balance, and more, on the period and basis you choose.',
    keyFeatures: [
      'Statements read live from posted GL, so they always tie to the ledger',
      'Period selection and multi-entity scope',
      'NL Report Compiler — ask for "3 years of P&L + balance sheet on accrual in one PDF" and get it',
      'Save report packs and schedule recurring delivery',
    ],
    tips: [
      'Both accrual and cash-basis P&L are supported.',
    ],
  },

  '/fpna': {
    title: 'FP&A Dashboard',
    whatItDoes:
      'Financial planning and analysis read live from the books — KPIs, cash runway, variance to plan, and trends, none of it hand-asserted.',
    keyFeatures: [
      'KPI tiles, cash-runway, and plan-variance computed from posted actuals',
      'Trend series across periods',
      'Feeds the NL FP&A Copilot — ask questions in plain English and pin the answers',
    ],
    tips: [
      'Pair with Budgets & Planning (driver-based budgets and rolling reforecast) to make variance meaningful.',
    ],
  },

  '/close': {
    title: 'Close',
    whatItDoes:
      'Run the period-end close as an orchestrated checklist — a dependency graph of tasks with auto-verification, so nothing closes out of order or half-done.',
    keyFeatures: [
      'Dependency-aware close checklist with auto-verify on each step',
      'Fiscal-period status control (OPEN → SOFT_CLOSE → HARD_CLOSE)',
      'Year-end close view for the annual roll-forward',
      'Gates like bank-rec-must-tie enforced before hard close',
    ],
    tips: [
      'Close-Status gives the at-a-glance readiness across entities.',
    ],
  },

  '/assets': {
    title: 'Assets & Schedules',
    whatItDoes:
      'Every capitalized asset and amortization schedule in one place — fixed assets, leases, prepaids, insurance, intangibles, and the parallel tax-depreciation book.',
    keyFeatures: [
      'Unified hub over all asset sub-ledgers, each with its own drop-and-parse intake',
      'Book depreciation/amortization posts on demand per period',
      'Tax depreciation (MACRS) runs in parallel and feeds the book-vs-tax difference',
    ],
    tips: [
      'Drop a fixed-asset invoice, lease, prepaid, or policy document and the AI sets up the schedule for you to confirm.',
    ],
  },

  '/tax': {
    title: 'Tax',
    whatItDoes:
      'The tax workspace — book-to-tax reconciliation, the ASC 740 income-tax provision, sales-tax filings, and the return-package hand-off, all in one place.',
    keyFeatures: [
      'Book-to-Tax (Schedule M-1) with permanent/temporary difference tagging',
      'Income Tax Provision (ASC 740) — current + deferred, computed then human-approved',
      'Sales-tax return prep, filing calendar, and liability tracking',
      'A 1120-style return package an accountant can take straight to the return',
    ],
    tips: [
      'Everything here aggregates from the ledger and is read-only until you explicitly post the provision entry.',
    ],
  },

  '/consolidation': {
    title: 'Consolidation',
    whatItDoes:
      'Multi-entity consolidated financials — combine the group and eliminate the intercompany noise, with ownership %, currency translation, eliminations, and non-controlling interest.',
    keyFeatures: [
      'Intercompany auto-match and elimination entries',
      'Ownership-% consolidation with non-controlling interest (NCI)',
      'Foreign-currency translation for non-base-currency entities',
      'Consolidated statements that tie back to each entity’s books',
    ],
    tips: [
      'Intercompany internal invoices flow here as eliminations — no manual wash entries.',
    ],
  },

  '/intercompany': {
    title: 'Intercompany',
    whatItDoes:
      'Internal invoicing between departments and entities — the modern replacement for the retired chargeback engine, feeding consolidation eliminations cleanly.',
    keyFeatures: [
      'Inter-department / inter-entity internal invoices',
      'Balances that auto-match and eliminate on consolidation',
      'Intercompany-balance exception detection when two sides disagree',
    ],
  },

  '/vendors': {
    title: 'Vendors',
    whatItDoes:
      'Your vendor master — a 360° record per vendor with contact detail, compliance status, payment history, and dedupe.',
    keyFeatures: [
      'W-9, GL COI, and WC COI compliance badges per vendor at a glance',
      'Vendor 360 dossier linking bills, payments, and documents',
      'Deduplication to keep the master clean',
    ],
    tips: [
      'Vendor Compliance is where the AI chases missing/expired W-9s and COIs and blocks payment until cured.',
    ],
  },

  '/vendor-compliance': {
    title: 'Vendor Compliance',
    whatItDoes:
      'The AI tracks each vendor’s W-9 and insurance certificates, scores compliance risk, and tees up chase actions — with a hard payment block on non-compliant vendors.',
    keyFeatures: [
      'Automated W-9 / COI tracking with expiration monitoring',
      'Risk scoring and prioritized chase queue',
      'Vendors with a missing or expired document are blocked from payment until cured or overridden',
      'Drop-and-parse intake reads uploaded W-9s and COIs',
    ],
  },

  '/customers': {
    title: 'Customers',
    whatItDoes:
      'Your customer master — a credit and risk dossier per customer with contact detail, balances, and dedupe.',
    keyFeatures: [
      'Credit/risk dossier per customer',
      'Deduplication of overlapping records',
      'Ties into invoicing, collections, and cash application',
    ],
  },

  '/payroll': {
    title: 'Payroll',
    whatItDoes:
      'Run payroll each pay period: draft the roster, preview the provider-computed gross-to-net, approve under separation of duties, then release the funding. Every run posts a balanced, job-costed entry to the ledger.',
    keyFeatures: [
      'Draft → preview gross-to-net → approve (SoD) → release funding',
      'Every run posts a balanced, job-costed payroll journal entry',
      'Payroll-register import (drop-and-parse) for provider-computed runs',
    ],
    tips: [
      'Approval and release are deliberately separate actions for separation of duties.',
    ],
  },

  // ---- Cash / treasury -----------------------------------------------------
  '/cash': {
    title: 'Cash Position',
    whatItDoes:
      'Where the money is and where it is going — live cash across accounts, the direct cash-flow statement, and the 13-week driver-based forecast (now a tab here).',
    keyFeatures: [
      'Live cash balances by account',
      'Direct-method cash flow statement',
      '13-week cash forecast driven by AR, AP, and recurring commitments',
    ],
    tips: [
      'The old /forecast URL now redirects into the Forecast tab of this page.',
    ],
  },

  '/debt': {
    title: 'Debt & Loans',
    whatItDoes:
      'The debt register and amortization schedules — plus covenant monitoring (now a tab here). Drop a loan document and the AI builds the schedule.',
    keyFeatures: [
      'Loan register with amortization schedules generated from the terms',
      'Variable-rate resets, refinance, and payoff handling',
      'Covenant-breach monitor (DSCR / FCCR / leverage) as a tab',
    ],
    tips: [
      'The old /covenants URL now redirects into the Covenants tab here.',
    ],
  },

  '/collections': {
    title: 'Collections',
    whatItDoes:
      'Chase overdue AR two ways — by aging bucket and DSO, or by risk score with an escalating dunning cadence and pay-date prediction. The AI drafts every notice; you approve each send.',
    keyFeatures: [
      'Aging-bucket + DSO worklist and a risk-scored view side by side',
      'Escalating dunning cadence with predicted pay dates',
      'AI-drafted reminders — nothing sends without your approval',
    ],
  },

  '/checks': {
    title: 'Check Run',
    whatItDoes:
      'Tee up payments from due bills, approve them under separation of duties, then export the bank file and release. Release posts to the GL — it never moves money itself.',
    keyFeatures: [
      'Select due bills into a payment batch',
      'Approve then release as separate SoD steps',
      'Exports a NACHA / bank file you upload to the bank; release posts the GL entry',
      'Idempotent release — a concurrent double-release cannot double-pay',
    ],
    tips: [
      'MeritBooks never initiates the transfer; you upload the exported file to your bank.',
    ],
  },

  '/purchase-orders': {
    title: 'Purchase Orders',
    whatItDoes:
      'General vendor procurement with a 3-way match — purchase order → goods receipt → bill — so you only pay for what was ordered and received.',
    keyFeatures: [
      'PO creation and lifecycle tracking',
      '3-way match against goods receipts and the vendor bill',
      'Feeds the procure-to-pay flow into AP and the pay run',
    ],
  },

  '/retainage': {
    title: 'Retainage Payable',
    whatItDoes:
      'Track retainage withheld from subcontractor bills, held until the work is accepted, then released and paid.',
    keyFeatures: [
      'Retainage withheld and tracked per subcontractor bill',
      'Held until acceptance, then released for payment',
    ],
  },

  '/expenses': {
    title: 'Expenses & Cards',
    whatItDoes:
      'Employee expense reports and corporate-card reconciliation — build from receipts, submit, approve, reimburse, and match card charges.',
    keyFeatures: [
      'Receipt → report → submit → approve → reimburse workflow',
      'Corporate-card charge reconciliation',
      'Deterministic expense-policy enforcement on every line',
    ],
    tips: [
      'Expense Policy compiles your written policy into a versioned ruleset the engine enforces automatically.',
    ],
  },

  '/expenses/policy': {
    title: 'Expense Policy',
    whatItDoes:
      'Drop your written expense policy and the AI compiles it into a structured, versioned ruleset you review and activate. A deterministic engine then enforces it on every expense.',
    keyFeatures: [
      'AI compiles prose policy → structured rules',
      'You review and activate each version',
      'Deterministic enforcement — same rule, same result, every time',
    ],
  },

  '/receipts': {
    title: 'Receipts',
    whatItDoes:
      'AI-extracted receipts awaiting review — the OCR queue that feeds expense reports and bank-feed matches.',
    keyFeatures: [
      'AI reads vendor, amount, and date off each receipt',
      'Review and confirm before it flows into an expense report or match',
    ],
  },

  // ---- Budgets / planning --------------------------------------------------
  '/budgets': {
    title: 'Budgets & Planning',
    whatItDoes:
      'Author annual budgets by account, build them from drivers, and roll them forward against posted GL actuals.',
    keyFeatures: [
      'By-account budget authoring',
      'Driver-based build (volume × rate assumptions)',
      'Rolling reforecast against real actuals',
    ],
  },

  // ---- AI / automation surfaces -------------------------------------------
  '/categorize': {
    title: 'AI Categorizer',
    whatItDoes:
      'Describe an incoming transaction and the AI proposes the right GL account, vendor, and department from your own books. Every suggestion is recorded in the AI Decision Log.',
    keyFeatures: [
      'Natural-language description → proposed GL coding',
      'Suggestions grounded in your own chart of accounts and vendor history',
      'Every proposal is logged for audit',
    ],
  },

  '/ai-decisions': {
    title: 'AI Decision Log',
    whatItDoes:
      'Every AI proposal, its inputs, the entry it suggested, and how it was dispositioned — a full audit trail. Nothing AI-suggested posts without a record here.',
    keyFeatures: [
      'Complete input → proposal → disposition trail for each AI decision',
      'Filter by capability and outcome',
      'The accountability backbone for AI automation',
    ],
  },

  '/agents': {
    title: 'Supervised Agents',
    whatItDoes:
      'The run list and step timeline for MeritBooks’ agentic loops — supervised, multi-step automations like AP intake→code→approve and procure-to-pay that always stop for a human at the money step.',
    keyFeatures: [
      'Run history with a per-step timeline you can inspect',
      'Recipes for order-to-cash, close-run, and pay-run',
      'Human-in-the-loop by design — agents propose, people approve',
    ],
  },

  '/settings/autonomy': {
    title: 'AI Autonomy',
    whatItDoes:
      'Govern what every AI capability is allowed to do on its own — and stop it all with a single kill switch.',
    keyFeatures: [
      'Per-capability autonomy levels (suggest / draft / auto)',
      'One master kill switch across the whole platform',
      'Dispositions wire straight into the exception library',
    ],
  },

  '/compliance': {
    title: 'Compliance & Controls',
    whatItDoes:
      'One shell for regulatory filings and the financial-control command center. The Filings tab tracks obligations and their due dates; the Controls tab is a read-only view of every control — exceptions, segregation of duties, AI autonomy, and the audit trail.',
    keyFeatures: [
      'Regulatory-filing tracker with obligations, owners, and due dates',
      'Live exception library (duplicate pay, anomalous JE, uncategorized leakage, intercompany imbalance)',
      'Segregation-of-duties posture, AI autonomy state, and the full audit trail',
    ],
    tips: [
      'Jump straight to controls at /compliance?tab=controls — the old /controls URL redirects here.',
    ],
  },

  '/controls': {
    title: 'Controls & Compliance',
    whatItDoes:
      'A read-only command center for every financial control — exceptions, segregation of duties, AI autonomy, and the audit trail, in one view.',
    keyFeatures: [
      'Live exception library (duplicate pay, anomalous JE, uncategorized leakage, intercompany imbalance)',
      'Segregation-of-duties posture',
      'AI autonomy state and the full audit trail',
    ],
  },

  '/audit': {
    title: 'Audit Trail',
    whatItDoes:
      'Every action across the system, with machine-vs-human attribution — who (or what) did what, and when.',
    keyFeatures: [
      'Immutable action log',
      'Actor attribution separates AI actions from human ones',
      'Filter by actor type to isolate automated activity',
    ],
  },

  '/documents': {
    title: 'Document Management Center',
    whatItDoes:
      'Every retained source document in one place — contracts, bills, statements, policies, W-9s, and COIs. Upload, filter by type, and trace each document back to the record it supports.',
    keyFeatures: [
      'Central store for all source documents',
      'Filter/browse by document type',
      'Each file links back to the record it backs up; drop-and-parse sources land here',
    ],
  },

  '/obligations': {
    title: 'Renewals & Obligations',
    whatItDoes:
      'Every date-driven obligation across the platform in one calendar — lease term-ends, debt maturities and payments, covenant tests, insurance and subscription renewals, W-9/COI expirations, and recurring invoices — ranked by urgency.',
    keyFeatures: [
      'Unified obligations calendar pulling from every module',
      'Urgency ranking so nothing lapses',
      'Drill from any item straight to its source record',
    ],
  },

  '/subscriptions': {
    title: 'Subscription Catcher',
    whatItDoes:
      'Detects recurring subscriptions from your bank feed and bills, tracks their terms and renewal dates, and flags creep — new spend, price hikes, overlapping tools, and zombie subscriptions.',
    keyFeatures: [
      'Auto-detection of recurring spend from the bank feed and bills',
      'Creep detection: price hikes, overlaps, and zombie subscriptions',
      'Keep or cancel each — a cancel drafts the request for you to send (nothing cancels automatically)',
    ],
  },

  // ---- Assets sub-ledgers --------------------------------------------------
  '/fixed-assets': {
    title: 'Fixed Assets',
    whatItDoes:
      'The fixed-asset register — capitalize, depreciate by method, dispose, and roll forward. Add an asset straight from its capex invoice.',
    keyFeatures: [
      'Multiple depreciation methods with a period roll-forward',
      'Disposal handling with the correct gain/loss GL treatment',
      '"Add from invoice" — drop a capex invoice and the AI creates the asset record',
    ],
  },

  '/leases': {
    title: 'Lease Management (ASC 842)',
    whatItDoes:
      'Drop a lease agreement, confirm the extracted terms, and MeritBooks sets up the right-of-use asset, the lease liability, and the amortization schedule — then posts each period on demand.',
    keyFeatures: [
      'ASC 842 ROU asset + lease liability from the parsed lease',
      'Amortization schedule posted per period',
      'Modifications and variable/CPI payment handling',
    ],
  },

  '/prepaids': {
    title: 'Prepaid Expenses',
    whatItDoes:
      'Amortize prepaid costs — insurance, subscriptions, retainers — straight-line from the prepaid asset into expense, posting each month on schedule.',
    keyFeatures: [
      'Straight-line amortization from prepaid asset to expense',
      'Scheduled monthly posting',
      'Drop a prepaid invoice and the schedule is built for you',
    ],
  },

  '/insurance': {
    title: 'Insurance Register',
    whatItDoes:
      'Drop your insurance policies and the AI extracts carrier, coverage, limits, deductible, and premium for you to confirm. MeritBooks then tracks coverage and flags renewals before they lapse.',
    keyFeatures: [
      'AI extraction of policy terms from the document',
      'Coverage tracking with renewal alerts',
      'Feeds the unified obligations calendar',
    ],
  },

  '/intangibles': {
    title: 'Intangible Assets',
    whatItDoes:
      'Software, patents, customer lists, and goodwill — MeritBooks amortizes finite-lived intangibles straight-line to the ledger and holds goodwill for impairment (ASC 350).',
    keyFeatures: [
      'Straight-line amortization of finite-lived intangibles',
      'Goodwill held for impairment rather than amortized (ASC 350)',
      'Posts to the ledger per period',
    ],
  },

  // ---- Tax sub-pages -------------------------------------------------------
  '/book-to-tax': {
    title: 'Book-to-Tax (Schedule M-1)',
    whatItDoes:
      'Bridge book net income to taxable income. Every difference is classified permanent vs temporary on its labeled M-1 line — the AI proposes the tag, the ledger computes the number.',
    keyFeatures: [
      'Permanent vs temporary difference tagging on labeled M-1 lines',
      'AI proposes the classification; you confirm',
      'Feeds the tax provision and the return package',
    ],
  },

  '/tax-depreciation': {
    title: 'Tax Depreciation (MACRS)',
    whatItDoes:
      'The parallel tax book — MACRS / §179 / bonus by class — and its reconciliation to posted book depreciation. The book-vs-tax delta is proposed as a temporary M-1 difference the ledger records only once you confirm.',
    keyFeatures: [
      'MACRS / §179 / bonus by asset class',
      'Reconciliation to book depreciation',
      'Book-vs-tax delta flows to Schedule M-1 on confirmation',
    ],
  },

  '/tax-provision': {
    title: 'Income Tax Provision (ASC 740)',
    whatItDoes:
      'Current + deferred tax from the book-to-tax differences. The ledger computes the numbers from book net income and the M-1 permanent/temporary split; a human approves and posts the balanced provision entry.',
    keyFeatures: [
      'Current and deferred tax computed from the M-1 split',
      'Effective-rate reconciliation',
      'Human approves and posts the balanced provision entry',
    ],
  },

  '/tax-package': {
    title: 'Tax Return Package',
    whatItDoes:
      'A 1120-style corporate tax hand-off an accountant can take straight to the return — M-1, tax-vs-book depreciation, the ASC 740 provision with effective-rate reconciliation, and the DTA/DTL rollforward. Aggregated from the ledger; nothing recomputes or posts.',
    keyFeatures: [
      'Book income → taxable income (Schedule M-1)',
      'Tax-vs-book depreciation and the deferred-tax rollforward',
      'Export-ready, read-only hand-off',
    ],
  },

  '/tax/sales-tax': {
    title: 'Sales Tax',
    whatItDoes:
      'Sales/use-tax collected, owed, and filed — calculated at invoice time by jurisdiction and reconciled to the Sales Tax Payable account.',
    keyFeatures: [
      'Tax calculated at invoice by jurisdiction',
      'Collected-vs-remitted and net-owed by period',
      'GL tie-out to Sales Tax Payable',
      'Filing Calendar of upcoming returns and a Return Worksheet to prep each filing, both as tabs here',
    ],
    tips: [
      'The old /sales-tax-calendar and /sales-tax-return URLs now redirect into the Calendar and Worksheet tabs.',
    ],
  },

  '/sales-tax-return': {
    title: 'Sales Tax Return',
    whatItDoes:
      'Filing-ready sales/use-tax liability by jurisdiction — taxable vs exempt sales, tax collected, rate reconciliation, and a Sales Tax Payable GL tie-out. Read-only: nothing is filed or remitted here.',
    keyFeatures: [
      'Liability by jurisdiction with taxable/exempt split',
      'Rate reconciliation and GL tie-out',
      'Read-only prep for the actual filing',
    ],
  },

  '/sales-tax-calendar': {
    title: 'Sales Tax Filing Calendar',
    whatItDoes:
      'Upcoming and overdue sales/use-tax returns by jurisdiction, with tax collected vs remitted and the net still owed each period. Due dates are computed from each state’s filing frequency.',
    keyFeatures: [
      'Per-jurisdiction due dates from filing frequency',
      'Collected vs remitted and net owed per period',
      'Marking a period filed records the filing (it does not post a remittance)',
    ],
  },

  '/compliance-1099': {
    title: '1099-NEC Readiness',
    whatItDoes:
      'Vendors paid $600 or more by check / ACH / wire in the year — card payments excluded (those are 1099-K). Flag gaps to queue a W-9 chase, then generate the 1099s.',
    keyFeatures: [
      'Automatic $600 threshold detection by payment method',
      'Gap flags queue a W-9 chase',
      'Generates 1099-NEC and IRS e-file (FIRE/IRIS) format',
    ],
  },

  // ---- Jobs / operations ---------------------------------------------------
  '/jobs': {
    title: 'Jobs & Projects',
    whatItDoes:
      'Budget tracking, cost analysis, and profitability across all entities — job costing with cost-to-complete/EAC and WIP over/under billing.',
    keyFeatures: [
      'Per-job budget vs actual with cost-to-complete and EAC',
      'WIP schedule with over/under billing',
      'Profitability by job and entity',
    ],
  },

  '/inventory': {
    title: 'Inventory',
    whatItDoes:
      'Item master and stock valuation — FIFO or weighted-average — with receipts, reorder alerts, and issue-to-job/invoice.',
    keyFeatures: [
      'FIFO and weighted-average valuation',
      'Receipt links, reorder alerts, and on-hand value',
      'Issue inventory to a job or an invoice',
    ],
  },

  '/chart-of-accounts': {
    title: 'Chart of Accounts',
    whatItDoes:
      'Your general-ledger account structure — accounts by type, sub-type, and group, with an approval step before a new account can be posted to.',
    keyFeatures: [
      'Accounts organized by type / sub-type / group',
      'New-account approval gate',
      'Account roles map special accounts (AR, AP, retainage, bad debt, tax) for the engine',
    ],
  },

  '/periods': {
    title: 'Fiscal Periods',
    whatItDoes:
      'Open, close, and generate accounting periods per company. Entries can only post into an OPEN or SOFT_CLOSE period.',
    keyFeatures: [
      'Per-company period status (OPEN / SOFT_CLOSE / HARD_CLOSE)',
      'Generate periods for a fiscal year',
      'The database enforces the period lock on every post',
    ],
  },

  '/rev-rec': {
    title: 'Revenue Recognition',
    whatItDoes:
      'Preview and post period revenue recognition. Each job recognizes by its resolved method (override → job-type mapping → company default).',
    keyFeatures: [
      'Method resolution: job override → job-type mapping → company default',
      'Preview the recognition before you post it',
      'Supports all configured rev-rec methods',
    ],
  },

  '/departments': {
    title: 'Departments',
    whatItDoes:
      'The department dimension per company — the cost centers that tag transactions and drive departmental reporting and internal invoicing.',
    keyFeatures: [
      'Department master per entity',
      'Drives departmental P&L and internal invoicing',
    ],
  },

  '/internal-invoices': {
    title: 'Internal Invoices',
    whatItDoes:
      'Inter-department internal invoicing — charge one department for another’s work, feeding consolidation eliminations cleanly.',
    keyFeatures: [
      'Department-to-department internal invoices',
      'Auto-eliminates on consolidation',
    ],
  },

  '/cash-application': {
    title: 'Cash Application',
    whatItDoes:
      'Apply received payments against open invoices and tie the AR subledger out to the GL.',
    keyFeatures: [
      'Match incoming cash to open invoices',
      'Subledger-to-GL tie-out',
    ],
  },

  '/credit-cards': {
    title: 'Credit Cards',
    whatItDoes:
      'Corporate-card accounts and their charges — feeding expense reconciliation and the bank feed.',
    keyFeatures: [
      'Card account and charge tracking',
      'Flows into expense reports and bank-feed matching',
    ],
  },

  '/exceptions': {
    title: 'Exceptions',
    whatItDoes:
      'The financial-control exception library — AI-detected issues like duplicate payments, anomalous journal entries, uncategorized leakage, and intercompany imbalances, each with a disposition.',
    keyFeatures: [
      'Detect-only controls that surface, never silently block',
      'Duplicate-pay, anomalous-JE, uncategorized-leakage, and intercompany-balance detectors',
      'Dispositions feed the audit trail and autonomy governance',
    ],
  },

  '/flagged': {
    title: 'Flagged Transactions',
    whatItDoes:
      'Bank-feed and AI-flagged transactions that need a closer look before they are approved and posted.',
    keyFeatures: [
      'Low-confidence and rule-flagged transactions in one place',
      'Resolve, recategorize, or approve',
    ],
  },

  // ---- Portfolio / practice ------------------------------------------------
  '/portfolio': {
    title: 'Portfolio',
    whatItDoes:
      'Every company on one screen — close status, cash, exceptions, and overdue balances, with a red/amber/green roll-up.',
    keyFeatures: [
      'Cross-entity roll-up with RAG status',
      'Drill into any entity for a period snapshot',
      'The multi-client practice view — the white-label moat',
    ],
  },

  '/profitability': {
    title: 'Portfolio Profitability',
    whatItDoes:
      'Per-entity P&L and margin for the period — ranked, and derived from the books rather than asserted.',
    keyFeatures: [
      'Ranked per-entity P&L and margin',
      'Computed live from posted GL',
    ],
  },

  '/board-package': {
    title: 'Board Package',
    whatItDoes:
      'Assemble a board-ready financial package — KPIs, statements, an AI executive summary, and notes — and export it as a branded PDF.',
    keyFeatures: [
      'KPIs + statements + AI-drafted executive summary + notes',
      'Branded, board-ready PDF export',
    ],
  },

  // ---- Admin / settings ----------------------------------------------------
  '/team': {
    title: 'Team & Access',
    whatItDoes:
      'Manage who’s on the team, their role, and the companies they can see — invitations, role assignment, and per-entity access.',
    keyFeatures: [
      'Invite members and assign roles',
      'Scope each person to the entities they may see',
      'Delegated-admin / practice model for management vs preparer scope',
    ],
  },

  '/settings': {
    title: 'Settings',
    whatItDoes:
      'Organization configuration — company profile, fiscal setup, integrations, approvals, and the AI autonomy controls.',
    keyFeatures: [
      'Org and per-company configuration',
      'Approval workflows, payments, and autonomy live under here',
    ],
  },

  '/settings/approvals': {
    title: 'Approval Workflows',
    whatItDoes:
      'Configure N-step approval chains per document type and amount tier — who must approve a bill, journal entry, payment, expense, or payroll run, and in what order.',
    keyFeatures: [
      'Multi-step chains by document type and amount tier',
      'Documents route automatically',
      'A type with no active workflow keeps its existing single-approver behavior',
    ],
  },

  '/settings/new-entity': {
    title: 'Add Company',
    whatItDoes:
      'Set up a new entity — fiscal calendar, base currency, and a seeded chart of accounts.',
    keyFeatures: [
      'Fiscal-year and base-currency configuration',
      'Seeded chart of accounts to start posting immediately',
    ],
  },

  '/operations': {
    title: 'Operations',
    whatItDoes:
      'How the system and your team are working, at a glance — throughput, automation rates, and team activity (manager-restricted).',
    keyFeatures: [
      'System and team activity overview',
      'Automation and processing metrics',
    ],
  },

  '/platform': {
    title: 'Operator Console',
    whatItDoes:
      'MeritBooks platform administration — cross-tenant fee revenue and oversight for the operator of the white-label platform.',
    keyFeatures: [
      'Cross-tenant realized fee revenue (read from invoice events)',
      'Platform oversight surface',
    ],
  },

  '/onboarding': {
    title: 'Onboarding',
    whatItDoes:
      'The unified first-run wizard — stand up the book of record: fiscal setup, entities, chart of accounts, and (optionally) a historical conversion or ERP connection.',
    keyFeatures: [
      'Guided first-run book-of-record setup',
      'Historical conversion import from your prior system',
      'Connect an existing ERP as a migration source',
    ],
  },

  '/sandbox': {
    title: 'Sandbox',
    whatItDoes:
      'Seed a COA-complete test tenant and exercise the full cross-module chain — cost, recognition, billing, and the closed-period rejection — end to end through the real services.',
    keyFeatures: [
      'Spin up a fully-seeded test tenant',
      'Run the real posting engine end to end',
      'Safe place to prove behavior without touching production books',
    ],
  },

  '/close-status': {
    title: 'Close Status',
    whatItDoes:
      'At-a-glance close readiness across every entity — which companies are open, soft-closed, or hard-closed, and what still stands between them and a clean close.',
    keyFeatures: [
      'Per-entity period status roll-up',
      'Outstanding close blockers surfaced per company',
    ],
  },

  '/year-end-close': {
    title: 'Year-End Close',
    whatItDoes:
      'The annual close — roll income and expense into retained earnings, lock the fiscal year, and open the next one.',
    keyFeatures: [
      'Income-statement roll-forward to retained earnings',
      'Fiscal-year lock and next-year open',
    ],
  },

  '/import': {
    title: 'Import',
    whatItDoes:
      'Bring data into the book of record — historical conversions and file imports from your prior accounting system.',
    keyFeatures: [
      'File-based import of historical data',
      'Feeds the onboarding historical-conversion pipeline',
    ],
  },

  '/integrations': {
    title: 'Integrations',
    whatItDoes:
      'Connect external systems — ERP and accounting sources — as one-time migration imports or ongoing feeds.',
    keyFeatures: [
      'ERP connector framework ("connect your existing system")',
      'Prior systems (QuickBooks/Sage) are migration sources, not the book of record',
    ],
  },

  '/search': {
    title: 'Search',
    whatItDoes:
      'Semantic search across your books and documents — ask in plain language and get the record, entry, or document you meant, not just keyword hits.',
    keyFeatures: [
      'Semantic (meaning-based) retrieval, not just keyword match',
      'Spans records and stored documents',
    ],
  },
};

/** The generic fallback for any route without its own entry. */
export const GENERIC_HELP: HelpContent = {
  title: 'About this page',
  whatItDoes:
    'MeritBooks is your book of record — this screen is one surface of the general ledger. Data here is read live from posted GL activity and respects your role and entity access.',
  keyFeatures: [
    'Every number ties back to the general ledger — nothing here is hand-asserted',
    'AI proposes; a human approves anything that posts or moves money',
    'Loading, empty, and error states are handled throughout',
  ],
  tips: [
    'Use the company selector in the top bar to scope to one entity or All Companies.',
    'Press ⌘K for the CPA Desk command bar, or ⌘/ for search, from any page.',
  ],
};

/**
 * Resolve help content for a pathname.
 *
 * Strips query/hash, then tries an exact match, then the longest matching
 * parent prefix (so dynamic segments like /portfolio/<id> resolve to
 * /portfolio), and finally the generic fallback.
 */
export function getHelpContent(pathname: string | null | undefined): HelpContent {
  if (!pathname) return GENERIC_HELP;

  // Normalize: drop query/hash, strip a trailing slash (but keep root).
  let path = pathname.split('?')[0].split('#')[0];
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  if (HELP_CONTENT[path]) return HELP_CONTENT[path];

  // Longest matching parent prefix.
  const keys = Object.keys(HELP_CONTENT)
    .filter((key) => path === key || path.startsWith(key + '/'))
    .sort((a, b) => b.length - a.length);

  if (keys.length > 0) return HELP_CONTENT[keys[0]];

  return GENERIC_HELP;
}
