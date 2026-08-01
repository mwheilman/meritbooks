# Digest — Build Spec v4.3 + Transaction Posting Engine Spec (GATE 2)

> Faithful digest. Master Doc supersedes the Build Spec on conflict; the Posting Engine Spec is
> the GATE 2 source of truth. Read `CANON-ANCHOR.md` first.

## Build Spec v4.3 — essentials

**Identity.** MeritBooks IS the general ledger — AI-native book of record, multi-entity. Module 1 of 12. The **pivot** (binding): the original "automation layer on QBO/Sage" design is ABANDONED; MeritBooks owns the GL with DB-enforced double-entry, a unified COA, and all sub-ledgers. Replaces six systems (QBO, Sage Intacct, Double/Keeper, Jirav, Asset Panda, Concur).

**6 structurally-enforced principles:** AI-first/human-approved ("never makes a financial decision autonomously"); learn from every correction; double-entry at the DB level (`check_journal_balance()`); document lineage; multi-tenant from day one (RLS per `org_id`); audit everything.

**Chart of Accounts:** unified master COA; only company-specific accounts = cash, credit card, bank debt (flagged `is_company_specific`, tied to a Location). **251 seed accounts / 71 groups / 11 sub-types / 7 types** (repo template actually encodes 137 — see anchor). **Four GL dimensions per line: Location (mandatory), Department, Class, Item.** `validate_dimensions()` enforces the stricter of per-account and per-location flags.

**Seven account types (range, normal balance, closes-to-RE):** Asset 10000–19999 (Dr, no); Liabilities 20000–29999 (Cr, no); Equity 30000–39999 (Cr, no except RE); Revenue 40000–49999 (Cr, yes); COGS 50000–59999 (Dr, yes); OpEx 60000–69999 (Dr, yes); Other 70000–99999 (Dr, yes). Income statement: Revenue − COGS = Gross Profit; − OpEx = EBITDA; − Other = Net Income. **6000-series OpEx historically powered the overhead burden rate — that engine is RETIRED (Master Doc Part VI); do not rebuild.** Retained Earnings = 39990.

**Triggers (exact names):** `check_journal_balance()`, `enforce_period_lock()`, `protect_control_accounts()`, `isolate_company_accounts()`, `validate_dimensions()`, `enforce_coa_approval()`.

**Seven-stage pipeline:** Ingest → Extract (AI OCR) → Categorize (cache-first ~78%/zero cost, else Claude with full COA) → Score → Review (human gate) → Post → Audit. **Matching:** vendor pattern (100 recent, 85% Levenshtein) → bill-payment (±2% amt, ±60d) → receipt (±$5, ±3d). **Composite = Vendor 40% + Amount 40% + Date 20%.** Routing ≥90% auto-categorize / 70–89% review / <70% flagged. **Auto-approve: confidence ≥85% AND trusted vendor (`auto_approve=true`) AND amount ≤ $10,000.**

**JE entry types:** STANDARD, RECURRING, REVERSING, STATISTICAL, CLOSING, SUB_LEDGER. **Source modules:** MANUAL, AR, AP, CASH_MGMT, FIXED_ASSETS, PAYROLL, INVENTORY, SYSTEM.

**Roles (7 web):** Org Admin, CFO (no daily processing), Accounting Manager, Senior Accountant, Accountant (assigned companies), Check Processor (SoD), Viewer. + 3 mobile.

## Transaction Universe & Posting Engine Spec (GATE 2 source of truth)

Policy elections (cap thresholds, lease classification, rev-rec policy, bad-debt method, sales tax) are **configurable per tenant, never hard-coded** — "the system applies a policy rather than inventing one."

**Mental model (6):**
1. Every transaction is a balanced JE; `postJournalEntry` rejects anything unbalanced.
2. **Account TYPE decides debit/credit mechanically** — derived from COA, "cannot miscode an expense as a credit." Contra-accounts opposite their parent.
3. **Rails (cash/check/ACH/wire/debit/credit card/on-account) are NOT transaction types** — the rail picks the cash-side account + clearing. **Credit card → Credit Card Payable (liability).**
4. **Two-step lifecycles (AP, AR, CC payable, accrued) are where bookkeeping breaks** — the #1 error (and Session-20 audit gap) is recording a settlement as a new expense; the engine must **clear the obligation.**
5. **AI proposes facts; the engine does the accounting; a human approves.** "The AI never writes debits and credits."
6. **UNIVERSAL OVERRIDE-AT-REVIEW** — "every transaction passes through an approval review where ANY field is editable before it posts — universal, not a rev-rec feature." Overriding a flagged/non-standard treatment requires a documented reason → Decision Log + audit. Post-posting = reversal-on-edit, never silent mutation.

**Transaction universe (GL templates, DR/CR):**
- Vendor bill: DR Expense(or asset) / CR AP (+ CR Sales/Use Tax Payable). Pay: DR AP / CR Cash.
- Direct expense: DR Expense / CR Cash (or CR Credit Card Payable).
- Prepaid: buy DR Prepaid Asset / CR Cash-or-AP; each period DR Expense / CR Prepaid.
- Inventory: buy DR Inventory / CR AP-or-Cash; sell DR COGS / CR Inventory.
- Customer invoice: DR AR / CR Revenue (+ CR Sales Tax Payable). **For rev-rec-managed jobs credit Deferred Revenue 2410, not Revenue.**
- Cash sale: DR Cash/Undeposited / CR Revenue.
- Customer payment: DR Cash / CR AR.
- Deferred revenue/deposit: receive DR Cash / CR Deferred Revenue; earn DR Deferred / CR Revenue.
- Progress billing & retainage: DR AR / CR Revenue (or CR Billings in Excess); Retainage: DR Retainage Receivable / CR Revenue.
- Bad debt (allowance): DR Bad Debt Expense / CR Allowance; write off DR Allowance / CR AR.
- Bank transfer (own accounts): **DR Receiving Bank / CR Sending Bank** (no income/expense).
- Bank/merchant fee: DR Fee Expense / CR Cash. Interest income: DR Cash / CR Interest Income.
- CC charge: DR Expense / CR Credit Card Payable. CC statement pay: DR Credit Card Payable / CR Cash ("must not re-expense the charges").
- Payroll run: DR Wage/Salary, DR Employer Tax, DR Benefits / CR Cash(net), CR Payroll Tax Payable, CR Benefit/Retirement Payables, CR Other Withholding Payables. Remit: DR payables / CR Cash.
- Fixed asset acquire (over cap threshold): DR Fixed Asset / CR Cash/AP/Loan. Depreciation: DR Depreciation Expense / CR Accumulated Depreciation. Disposal: DR Cash + DR Accum Dep / CR Fixed Asset, CR Gain (or DR Loss).
- Loan draw: DR Cash / CR Loan Payable. Loan payment: DR Loan Payable(principal) + DR Interest Expense / CR Cash. Accrued interest: DR Interest Expense / CR Interest Payable.
- Owner contribution: DR Cash / CR Owner's Capital. Owner draw: DR Owner Draws / CR Cash.
- Sales/use tax: CR Sales Tax Payable at invoicing; remit DR Sales Tax Payable / CR Cash.
- Period-end: accrued expense DR Expense / CR Accrued Liabilities (reverse next period); accrued/unbilled revenue DR Unbilled Receivable / CR Revenue.
- Leases (ASC 842): DR Right-of-Use Asset / CR Lease Liability; period DR Lease Expense (operating) or DR Interest + DR Amortization (finance) / CR Cash.
- Inter-company/inter-department: eliminating accounts net to zero at consolidation.

**Account numbers introduced:** Deferred Revenue **2410**; Unbilled Receivable / Contract Asset **1180**; Retained Earnings **39990**. (Others resolved by role, not number.)

**Six-layer AI architecture:** (1) Ingestion; (2) Extraction (AI facts); (3) Classification (AI proposes type/account/dimensions/rail, flags judgment items — "it proposes, it never posts"); (4) **Deterministic posting engine** (facts+type → balanced entry: posting template per type, account-type-aware direction, rail-aware cash side, lifecycle-aware settlement, exception hooks); (5) Confidence routing + human approval; (6) Continuous controls, learning, audit.

**GATE 2 build requirements:** transaction_type taxonomy (enumerated ~39 types); posting-template registry (roles, not numbers); account-role resolution (COA tags AP/AR/cash-by-rail/tax-payable/undeposited/RE/accum-dep); lifecycle state machines (AP/AR/CC/accruals that CLEAR obligations — closes gaps 1–3); exception/schedule engine (prepaid amort, depreciation, deferred-rev, lease, loan amort, rev-rec); tax handling; consistent org resolution + reversal-on-edit; account-type-aware posting + job→WIP redirect; gateway-wired AI proposal returning real account_id.

**Rev-rec is the AUTHORITY (supersedes Build Spec's 4 methods): NINE methods** in `rev-rec.ts`: PCT_COSTS_INCURRED, PCT_COMPLETE, COMPLETED_CONTRACT, POINT_OF_SALE, MILESTONE, AS_BILLED, RATABLY, SUBSCRIPTION, CASH. Resolved per job: override → company job-type map → company default (canonical order also includes the per-revenue-type tier — see anchor). Each run posts the **earned delta**: CR Revenue; DR Deferred (2410) to relieve billings-in-excess; DR Unbilled (1180) where earned > billed. **The posting engine delegates revenue timing to this service — does not re-implement it.**

**Override at review + batch approval:** all fields editable at review (account, dimensions, rail, splits, tax, GAAP election); AI recommendation is the default, not a lock; documented reason on flagged overrides. **Batch approval:** filterable queue, approve the filtered set in one action, but **each entry still posts individually through the engine + guardrails → a batch may PARTIALLY SUCCEED** (never all-or-nothing silently). **Flagged/judgment items (defer, capitalize, prepaid, WIP, low-confidence) are EXCLUDED from blind batch approval by default.** Auto-pilot is per-tenant, per-task, OFF by default — "there is never a global 'let the AI run' switch."

**Foundation seams (built in GATE 2):** multi-currency = `currency` (NOT NULL, default home) + nullable `fx_rate` on monetary rows, **inert until enabled** (the ONE foregone item). Multi-entity = `parent_entity_id` (nullable self-ref) + `ownership_pct` on the entity record; **consolidation built as its own gate (11a, mandatory).**

### Posting rules a builder must not violate
See `CANON-ANCHOR.md` §3. Additional from this spec: never blind-batch judgment items; never make a batch all-or-nothing; never treat an own-account transfer as income/expense; never hard-code role accounts by number in templates; never treat a per-tenant policy election as an engine constant; seam (don't skip) currency + entity-hierarchy columns even while inert.
