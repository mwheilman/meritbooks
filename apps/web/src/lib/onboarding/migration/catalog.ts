/**
 * Onboarding v2 — the SOURCE CATALOG for "Connect a source" (docs/ia/08-ONBOARDING-V2-SPEC.md §4.3–§4.4).
 *
 * Every system a client might be moving off of (a ledger) or keep running alongside MeritBooks
 * (a field / job / ERP system, bank, card, payroll …) appears here with an HONEST connection tier
 * and an export RECIPE. The recipe is always present: it is the day-one path for every system and
 * the fallback once an API connector exists (§4.3 "the upgrade path never changes the UI").
 *
 * Honesty rules (G-ON-7: the catalog never shows a status the product doesn't honor):
 *   • tier 'native_api' only where we really connect today: QuickBooks Online (live OAuth when the
 *     QBO_* credentials are configured) and Plaid for bank accounts. Everything else is 'recipe';
 *     "My system isn't listed" is 'generic_file'.
 *   • apiStatus describes the VENDOR side + our roadmap, never a promise:
 *       live            — we connect today.
 *       planned         — the vendor publishes an API; our connector is a later wave (07 confirms terms).
 *       partner_pending — an API exists only through a partner program; access isn't in place.
 *       no_public_api   — no public API we can use (or a file-only source); recipe (and, where the
 *                         system already syncs to QuickBooks, the temporary QuickBooks bridge) is the path.
 *   • Recipes we couldn't verify screen-by-screen are `status: 'draft'` and say "confirm with the
 *     client's {system} admin". Honesty beats precision.
 *
 * QuickBooks is a PIPE, never the books: ledgers are a one-time source archived at sign-off; a field
 * system that already syncs into QuickBooks may be read through it temporarily (`bridgeViaQuickBooks`).
 *
 * Slug ids reuse lib/integrations/erp/catalog.ts where the system already exists there. Pure data +
 * pure helpers — no I/O. Nothing tenant-specific (no client names) is hard-coded.
 */

import type { SourceRole, SourceTier, StagedEntity } from './types';

export type SourceGroup = 'ledger' | 'field' | 'bank' | 'payroll' | 'spend' | 'crm' | 'docs';
export type ApiStatus = 'live' | 'planned' | 'no_public_api' | 'partner_pending';

export interface RecipeStep {
  title: string;
  detail: string;
}

export interface RecipeFile {
  /** Stable slot key within the recipe ("trial_balance", "ar_aging" …). */
  key: string;
  label: string;
  entity: StagedEntity;
  required: boolean;
  hint: string;
}

export interface ExportRecipe {
  version: string;
  status: 'confirmed' | 'draft';
  summary: string;
  steps: RecipeStep[];
  files: RecipeFile[];
  afterGoLive: string;
}

export interface SourceSystem {
  id: string;
  name: string;
  group: SourceGroup;
  role: SourceRole;
  /** How it connects TODAY (honest). */
  tier: SourceTier;
  apiStatus: ApiStatus;
  /** What it can bring. */
  entities: StagedEntity[];
  /** Field / bank / card / payroll stay connected after go-live; ledgers are one-time. */
  ongoingFeed: boolean;
  /** Who uses it, in plain English. */
  oneLine: string;
  /** Already syncs into QuickBooks, so it can be read through QuickBooks temporarily. */
  bridgeViaQuickBooks?: boolean;
  /** ALWAYS present. */
  recipe: ExportRecipe;
  aliases?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared recipe pieces
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER_AFTER = (name: string): string =>
  `Archived and disconnected at sign-off. ${name} is a one-time source; MeritBooks becomes the book of record.`;

const FIELD_AFTER = (name: string): string =>
  `Stays as an ongoing feed of jobs and invoices dated after cutover. Anything in ${name} dated on or before ` +
  'cutover is linked for drill-down, never posted again: the opening balances already contain it.';

const DROP_STEP = (name: string, what = 'the files'): RecipeStep => ({
  title: `Drop ${what} below`,
  detail: `We recognize ${name} exports by their column headings, rules only. Rename nothing; title rows and total rows are fine.`,
});

const draftSummary = (name: string, extra: string): string =>
  `Recipe v1 · draft, confirm with the client's ${name} admin. ${extra}`;

interface LedgerFileHints {
  tb: string;
  coa: string;
  ar: string;
  ap: string;
  customers: string;
  vendors: string;
  items?: string;
  dims?: string;
  bank?: string;
  v1099?: string;
}

/** The standard ledger file slots (§4.4 ledger row): TB, chart, AR/AP detail, parties, lists, bank recs, 1099. */
function ledgerFiles(h: LedgerFileHints): RecipeFile[] {
  const files: RecipeFile[] = [
    { key: 'trial_balance', label: 'Trial balance as of your cutover date', entity: 'tb_line', required: true, hint: h.tb },
    { key: 'chart_of_accounts', label: 'Chart of accounts, with type and detail type', entity: 'account', required: true, hint: h.coa },
    { key: 'ar_aging', label: 'A/R aging detail as of your cutover date', entity: 'open_invoice', required: true, hint: h.ar },
    { key: 'ap_aging', label: 'A/P aging detail as of your cutover date', entity: 'open_bill', required: true, hint: h.ap },
    { key: 'customers', label: 'Customer list (email, phone, tax ID)', entity: 'customer', required: true, hint: h.customers },
    { key: 'vendors', label: 'Vendor list (1099 flag, tax ID)', entity: 'vendor', required: true, hint: h.vendors },
  ];
  if (h.items) files.push({ key: 'items', label: 'Products & services / item list', entity: 'item', required: false, hint: h.items });
  if (h.dims) files.push({ key: 'classes_locations', label: 'Classes, locations or departments', entity: 'dimension', required: false, hint: h.dims });
  if (h.bank) files.push({ key: 'bank_reconciliations', label: 'Last bank reconciliation, per bank and card account', entity: 'bank_balance', required: false, hint: h.bank });
  if (h.v1099) files.push({ key: 'vendor_1099', label: '1099 vendor summary, this calendar year to your cutover date', entity: 'vendor', required: false, hint: h.v1099 });
  return files;
}

interface FieldRecipeInput {
  jobs: string;
  invoices: string;
  customers: string;
  dims?: string;
  items?: string;
  extra?: string;
  /** Replace the generic job step with system-specific columns. */
  jobColumns?: string;
}

/** A draft field-system recipe: open jobs, open invoices, customers, business units, price book. */
function fieldRecipe(name: string, f: FieldRecipeInput): ExportRecipe {
  const steps: RecipeStep[] = [
    {
      title: `Export open jobs from ${name}`,
      detail:
        `${f.jobs} Keep ${f.jobColumns ?? 'job number, job name, customer, status, contract value, change orders, cost to date and billed to date'}. ` +
        'Export to Excel or CSV and keep the header row.',
    },
    {
      title: 'Export open invoices as of your cutover date',
      detail: `${f.invoices} These enrich the ledger's A/R aging with job detail; they don't replace it.`,
    },
    { title: 'Export customers', detail: `${f.customers} Include email, phone and service address.` },
  ];
  if (f.dims) steps.push({ title: 'Export business units / divisions', detail: f.dims });
  if (f.items) steps.push({ title: 'Export the price book', detail: f.items });
  steps.push(DROP_STEP(name));

  const files: RecipeFile[] = [
    { key: 'open_jobs', label: 'Open jobs (contract, change orders, cost and billed to date)', entity: 'job', required: true, hint: 'Excel or CSV, one row per job.' },
    { key: 'open_invoices', label: 'Open invoices as of your cutover date', entity: 'open_invoice', required: true, hint: 'One row per unpaid invoice, with the balance still open.' },
    { key: 'customers', label: 'Customers', entity: 'customer', required: false, hint: 'Linked to the ledger’s customers, not copied.' },
  ];
  if (f.dims) files.push({ key: 'business_units', label: 'Business units / divisions', entity: 'dimension', required: false, hint: 'Become departments in MeritBooks.' });
  if (f.items) files.push({ key: 'price_book', label: 'Price book / items', entity: 'item', required: false, hint: 'Services, materials and equipment.' });

  return {
    version: 'v1',
    status: 'draft',
    summary: draftSummary(name, f.extra ?? `The ledger stays the control for opening A/R; ${name} adds job identity, WIP inputs and invoice detail.`),
    steps,
    files,
    afterGoLive: FIELD_AFTER(name),
  };
}

interface PayrollRecipeInput {
  register: string;
  liabilities: string;
  ytd: string;
}

function payrollRecipe(name: string, p: PayrollRecipeInput): ExportRecipe {
  return {
    version: 'v1',
    status: 'draft',
    summary: draftSummary(name, 'Three reports set opening payroll: the register this year, liabilities owed at cutover, and year-to-date totals by employee (for W-2 continuity).'),
    steps: [
      { title: 'Export the payroll register for this year', detail: `${p.register} Date range: Jan 1 through your cutover date, by pay date. Excel or CSV.` },
      { title: 'Export payroll liabilities as of your cutover date', detail: `${p.liabilities} What was withheld or accrued but not yet paid at cutover.` },
      { title: 'Export year-to-date totals by employee', detail: `${p.ytd} Gross, taxes, deductions and net per employee through your cutover date.` },
      DROP_STEP(name),
    ],
    files: [
      { key: 'payroll_register', label: 'Payroll register, Jan 1 to your cutover date', entity: 'evidence', required: true, hint: 'By pay date, one row per check or per employee per run.' },
      { key: 'payroll_liabilities', label: 'Payroll liabilities as of your cutover date', entity: 'evidence', required: true, hint: 'Ties to the payroll liability accounts on the trial balance.' },
      { key: 'ytd_by_employee', label: 'Year-to-date totals by employee', entity: 'evidence', required: true, hint: 'Gross, taxes, deductions and net per employee.' },
    ],
    afterGoLive: 'Each pay run’s register keeps coming in as a file until a payroll connection is in place.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledgers (one-time)
// ─────────────────────────────────────────────────────────────────────────────

const QBO_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'confirmed',
  summary:
    'Nine QuickBooks Online reports, all as of your cutover date. Connecting QuickBooks pulls the same data automatically; use these exports when the connection isn’t available.',
  steps: [
    {
      title: 'Run the Trial Balance',
      detail:
        'Reports → search “Trial Balance”. Report period: Custom, from the first day of the fiscal year through your cutover date. ' +
        'Accounting method: Accrual. Run report, then the Export icon → Export to Excel.',
    },
    {
      title: 'Export the Account List',
      detail:
        'Reports → search “Account List”. Customize → Rows/Columns: keep Account #, Account, Type, Detail type and Description. Run report → Export to Excel.',
    },
    {
      title: 'Run A/R Aging Detail',
      detail:
        'Reports → “A/R Aging Detail”. As of: your cutover date. Aging method: Report date. Run report → Export to Excel. Keep every column; we skip the “Total for …” rows ourselves.',
    },
    {
      title: 'Run A/P Aging Detail',
      detail: 'Reports → “A/P Aging Detail”. Same settings: as of your cutover date, aging by report date. Export to Excel.',
    },
    {
      title: 'Export customers and vendors',
      detail:
        'Sales → Customers → Export icon → Export to Excel. Then Reports → “Vendor Contact List” → Customize → add Tax ID and Track payments for 1099 → Export to Excel.',
    },
    {
      title: 'Export Products and Services',
      detail: 'Settings ⚙ → All Lists → Products and Services → Export icon → Export to Excel.',
    },
    {
      title: 'Export Classes and Locations (if you use them)',
      detail: 'Settings ⚙ → All Lists → Classes, then Locations. Run report → Export to Excel. Skip if the company doesn’t track them.',
    },
    {
      title: 'Save the last reconciliation for each bank and card account',
      detail:
        'Settings ⚙ → Reconcile → History by account. Pick each account and open the last reconciliation on or before your cutover date. Export to Excel if offered, otherwise save the PDF.',
    },
    {
      title: 'Run the 1099 Contractor Summary',
      detail: 'Reports → “1099 Contractor Summary”. Date: Jan 1 of this year through your cutover date. Export to Excel.',
    },
  ],
  files: ledgerFiles({
    tb: 'Excel export of Reports → Trial Balance, Accrual, through your cutover date.',
    coa: 'Excel export of Reports → Account List with Type and Detail type.',
    ar: 'Reports → A/R Aging Detail as of your cutover date.',
    ap: 'Reports → A/P Aging Detail as of your cutover date.',
    customers: 'Sales → Customers → Export to Excel.',
    vendors: 'Reports → Vendor Contact List with Tax ID and Track payments for 1099.',
    items: 'Settings ⚙ → All Lists → Products and Services → Export.',
    dims: 'Settings ⚙ → All Lists → Classes / Locations.',
    bank: 'Reconcile → History by account → the last reconciliation on or before cutover.',
    v1099: 'Reports → 1099 Contractor Summary, this year to cutover.',
  }),
  afterGoLive: LEDGER_AFTER('QuickBooks'),
};

const QBD_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'confirmed',
  summary: 'QuickBooks Desktop (Pro, Premier or Enterprise). Every report uses Excel → Create New Worksheet; title rows and totals are fine.',
  steps: [
    {
      title: 'Run the Trial Balance',
      detail:
        'Reports → Accountant & Taxes → Trial Balance. Dates: From the first day of the fiscal year To your cutover date. ' +
        'Customize Report → Report Basis: Accrual. Excel → Create New Worksheet.',
    },
    {
      title: 'Run the Account Listing',
      detail: 'Reports → List → Account Listing. Customize Report → Display: keep Account, Type, Balance Total, Description and Accnt. #. Excel → Create New Worksheet.',
    },
    { title: 'Run A/R Aging Detail', detail: 'Reports → Customers & Receivables → A/R Aging Detail. Dates: your cutover date. Excel → Create New Worksheet.' },
    { title: 'Run A/P Aging Detail', detail: 'Reports → Vendors & Payables → A/P Aging Detail. Dates: your cutover date. Excel → Create New Worksheet.' },
    {
      title: 'Run the customer and vendor contact lists',
      detail:
        'Reports → List → Customer Contact List, then Vendor Contact List. On the vendor list, Customize Report → add Tax ID and Eligible for 1099. Excel → Create New Worksheet for each.',
    },
    { title: 'Run the Item Listing', detail: 'Reports → List → Item Listing. Excel → Create New Worksheet.' },
    { title: 'Export the Class List (if you use classes)', detail: 'Lists → Class List. Reports → Class List report, then Excel → Create New Worksheet. Skip if the company doesn’t use classes.' },
    {
      title: 'Save the last bank reconciliation per account',
      detail: 'Banking → Previous Reconciliation Reports. Pick each bank and card account and the statement ending on or before your cutover date. Choose Summary, then Display; export to Excel or save the PDF.',
    },
    { title: 'Run the 1099 Summary', detail: 'Reports → Vendors & Payables → 1099 Summary. Dates: Jan 1 of this year through your cutover date. Excel → Create New Worksheet.' },
  ],
  files: ledgerFiles({
    tb: 'Reports → Accountant & Taxes → Trial Balance, Accrual.',
    coa: 'Reports → List → Account Listing.',
    ar: 'Reports → Customers & Receivables → A/R Aging Detail.',
    ap: 'Reports → Vendors & Payables → A/P Aging Detail.',
    customers: 'Reports → List → Customer Contact List.',
    vendors: 'Reports → List → Vendor Contact List with Tax ID and Eligible for 1099.',
    items: 'Reports → List → Item Listing.',
    dims: 'Lists → Class List.',
    bank: 'Banking → Previous Reconciliation Reports (Summary).',
    v1099: 'Reports → Vendors & Payables → 1099 Summary.',
  }),
  afterGoLive: LEDGER_AFTER('QuickBooks Desktop'),
};

const XERO_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'confirmed',
  summary: 'Xero reports, all at your cutover date. Xero writes dates as “30 September 2026”; we read either format.',
  steps: [
    { title: 'Run the Trial Balance', detail: 'Accounting → Reports → Trial Balance. Date: your cutover date. Update → Export → Excel.' },
    { title: 'Export the chart of accounts', detail: 'Accounting → Chart of accounts → Export. Xero saves a CSV with Code, Name, Type and Tax Code.' },
    { title: 'Run Aged Receivables Detail', detail: 'Accounting → Reports → Aged Receivables Detail. Date: your cutover date; Ageing by due date. Update → Export → Excel.' },
    { title: 'Run Aged Payables Detail', detail: 'Accounting → Reports → Aged Payables Detail. Same settings. Update → Export → Excel.' },
    { title: 'Export contacts', detail: 'Contacts → All contacts → Export. Choose Customers, then Suppliers. Xero includes email, phone, address and tax number.' },
    { title: 'Export products and services', detail: 'Business → Products and services → Export.' },
    {
      title: 'List tracking categories (if you use them)',
      detail: 'Accounting → Advanced → Tracking categories. Xero has no export here: type each option into a one-column sheet headed with the category name, for example “Location”.',
    },
    { title: 'Run the Bank Reconciliation report per account', detail: 'Accounting → Reports → Bank Reconciliation. Pick each bank account; date: your cutover date. Export → Excel.' },
    { title: 'Run the 1099 report (US)', detail: 'Accounting → Reports → 1099 Report. Jan 1 of this year through your cutover date. Export.' },
  ],
  files: ledgerFiles({
    tb: 'Accounting → Reports → Trial Balance.',
    coa: 'Accounting → Chart of accounts → Export (CSV).',
    ar: 'Accounting → Reports → Aged Receivables Detail.',
    ap: 'Accounting → Reports → Aged Payables Detail.',
    customers: 'Contacts → Export → Customers.',
    vendors: 'Contacts → Export → Suppliers.',
    items: 'Business → Products and services → Export.',
    dims: 'A one-column sheet per tracking category.',
    bank: 'Accounting → Reports → Bank Reconciliation, per account.',
    v1099: 'Accounting → Reports → 1099 Report.',
  }),
  afterGoLive: LEDGER_AFTER('Xero'),
};

const INTACCT_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'draft',
  summary: draftSummary(
    'Sage Intacct',
    'Report names can differ by role and configuration. If the subscription has ended or is read-only, ask Sage for the data-archive export, or use the last reports you saved: we can rebuild the trial balance from them.',
  ),
  steps: [
    { title: 'Run the trial balance', detail: 'General Ledger → Reports → Trial balances. As of date: your cutover date; reporting method: Accrual. Run, then Export → Excel.' },
    { title: 'Export the chart of accounts', detail: 'General Ledger → Accounts (list view) → Export → CSV, with Account number, Title, Account type, Normal balance and Category.' },
    { title: 'Run the A/R aging', detail: 'Accounts Receivable → Reports → Aging. Detail, as of your cutover date, aging by due date. Export → Excel.' },
    { title: 'Run the A/P aging', detail: 'Accounts Payable → Reports → Aging. Same settings. Export → Excel.' },
    { title: 'Export customers and vendors', detail: 'Accounts Receivable → Customers and Accounts Payable → Vendors list views → Export → CSV. On vendors include Form 1099 type and Tax ID.' },
    { title: 'Export items (if used)', detail: 'Inventory Control or Order Entry → Items list → Export → CSV.' },
    { title: 'Export departments and locations', detail: 'Company → Departments and Company → Locations → Export. Include classes or projects if the company uses those dimensions.' },
    { title: 'Save the last bank reconciliation per account', detail: 'Cash Management → Reconcile bank → history. Export the last completed reconciliation on or before your cutover date for each checking and savings account.' },
    { title: 'Run the 1099 report', detail: 'Accounts Payable → Reports → 1099 report, Jan 1 of this year through your cutover date.' },
  ],
  files: ledgerFiles({
    tb: 'General Ledger → Reports → Trial balances.',
    coa: 'General Ledger → Accounts → Export.',
    ar: 'Accounts Receivable → Reports → Aging (detail).',
    ap: 'Accounts Payable → Reports → Aging (detail).',
    customers: 'Accounts Receivable → Customers → Export.',
    vendors: 'Accounts Payable → Vendors → Export with 1099 type and Tax ID.',
    items: 'Items list → Export.',
    dims: 'Company → Departments / Locations → Export.',
    bank: 'Cash Management → reconciliation history.',
    v1099: 'Accounts Payable → Reports → 1099 report.',
  }),
  afterGoLive: LEDGER_AFTER('Sage Intacct'),
};

const SAGE50_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'draft',
  summary: draftSummary('Sage 50', 'Sage 50 (US, formerly Peachtree). Every report has an Excel button on its toolbar. Departments set up by account masking are read from the account numbers, so there is nothing extra to export.'),
  steps: [
    { title: 'Run the General Ledger Trial Balance', detail: 'Reports & Forms → General Ledger → General Ledger Trial Balance. Options: the period ending on your cutover date. Excel.' },
    { title: 'Run the Chart of Accounts', detail: 'Reports & Forms → General Ledger → Chart of Accounts (account ID, description, type). Excel.' },
    { title: 'Run Aged Receivables', detail: 'Reports & Forms → Accounts Receivable → Aged Receivables, as of your cutover date, with invoice detail. Excel.' },
    { title: 'Run Aged Payables', detail: 'Reports & Forms → Accounts Payable → Aged Payables, as of your cutover date, with invoice detail. Excel.' },
    { title: 'Run the customer and vendor lists', detail: 'Reports & Forms → Accounts Receivable → Customer List, and Accounts Payable → Vendor List (add Tax ID and 1099 Type columns). Excel.' },
    { title: 'Run the Item List', detail: 'Reports & Forms → Inventory → Item List. Excel.' },
    { title: 'Run the Account Reconciliation report', detail: 'Reports & Forms → Account Reconciliation → Account Reconciliation, for each bank account, period ending on or before your cutover date. Excel.' },
    { title: 'Run 1099 vendor payments', detail: 'Reports & Forms → Accounts Payable → Vendor Ledgers filtered to 1099 vendors, Jan 1 of this year through your cutover date. Excel.' },
  ],
  files: ledgerFiles({
    tb: 'Reports & Forms → General Ledger → General Ledger Trial Balance.',
    coa: 'Reports & Forms → General Ledger → Chart of Accounts.',
    ar: 'Reports & Forms → Accounts Receivable → Aged Receivables.',
    ap: 'Reports & Forms → Accounts Payable → Aged Payables.',
    customers: 'Reports & Forms → Accounts Receivable → Customer List.',
    vendors: 'Reports & Forms → Accounts Payable → Vendor List with Tax ID and 1099 Type.',
    items: 'Reports & Forms → Inventory → Item List.',
    bank: 'Reports & Forms → Account Reconciliation.',
    v1099: 'Vendor Ledgers filtered to 1099 vendors.',
  }),
  afterGoLive: LEDGER_AFTER('Sage 50'),
};

const SAGE100_300_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'draft',
  summary: draftSummary('Sage 100 / 300', 'Sage 100 and Sage 300 name these reports slightly differently by version; the closest report is fine, we read the headings.'),
  steps: [
    { title: 'Run the trial balance', detail: 'Sage 100: General Ledger → Reports → Trial Balance. Sage 300: General Ledger → G/L Reports → Trial Balance. Period: the one ending on your cutover date. Export or print to Excel.' },
    { title: 'Run the chart of accounts', detail: 'General Ledger → Reports → Chart of Accounts (Sage 100) or G/L Accounts listing (Sage 300), with account type. Excel.' },
    { title: 'Run the A/R aging', detail: 'Sage 100: Accounts Receivable → Reports → Aged Invoice Report. Sage 300: A/R → Customer Transaction Reports → Aged Trial Balance. Detail, as of your cutover date.' },
    { title: 'Run the A/P aging', detail: 'Sage 100: Accounts Payable → Reports → Aged Invoice Report. Sage 300: A/P → Vendor Transaction Reports → Aged Trial Balance. Detail, as of your cutover date.' },
    { title: 'Run customer and vendor listings', detail: 'Accounts Receivable → Customer Listing; Accounts Payable → Vendor Listing with 1099 and tax ID. Excel.' },
    { title: 'Run the item listing (if used)', detail: 'Inventory Management → Item listing. Excel.' },
    { title: 'Save bank reconciliation status', detail: 'Sage 100: Bank Reconciliation → Reconciliation report. Sage 300: Bank Services → Reconciliation Status. As of your cutover date.' },
    { title: 'Run the 1099 report', detail: 'Accounts Payable → 1099 reports, Jan 1 of this year through your cutover date.' },
  ],
  files: ledgerFiles({
    tb: 'General Ledger trial balance for the cutover period.',
    coa: 'Chart of accounts with account type.',
    ar: 'Aged invoice / aged trial balance, detail.',
    ap: 'Aged invoice / aged trial balance, detail.',
    customers: 'Customer listing.',
    vendors: 'Vendor listing with 1099 and tax ID.',
    items: 'Item listing.',
    bank: 'Bank reconciliation status.',
    v1099: '1099 report, year to date.',
  }),
  afterGoLive: LEDGER_AFTER('Sage'),
};

const NETSUITE_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'draft',
  summary: draftSummary('NetSuite', 'Run each report for the subsidiary being migrated. Saved searches with the same columns work just as well.'),
  steps: [
    { title: 'Run the Trial Balance', detail: 'Reports → Financial → Trial Balance. As of: your cutover date; subsidiary: this company. Export → Excel.' },
    { title: 'Export the chart of accounts', detail: 'Lists → Accounting → Accounts → export icon (CSV), with Number, Name, Type and Subtype.' },
    { title: 'Run A/R Aging Detail', detail: 'Reports → Customers/Receivables → A/R Aging Detail. As of your cutover date. Export → Excel.' },
    { title: 'Run A/P Aging Detail', detail: 'Reports → Vendors/Payables → A/P Aging Detail. As of your cutover date. Export → Excel.' },
    { title: 'Export customers and vendors', detail: 'Lists → Relationships → Customers, then Vendors → export icon (CSV). On vendors include Tax ID and 1099 Eligible.' },
    { title: 'Export items', detail: 'Lists → Accounting → Items → export icon (CSV).' },
    { title: 'Export classes, departments and locations', detail: 'Setup → Company → Classes, Departments and Locations → export each list.' },
    { title: 'Save the last bank reconciliation per account', detail: 'Transactions → Bank → Reconcile Account Statement history (or the Reconciliation Summary report), for the statement ending on or before your cutover date.' },
    { title: 'Run 1099 vendor totals', detail: 'Reports → Vendors/Payables → 1099-MISC/NEC report, Jan 1 of this year through your cutover date.' },
  ],
  files: ledgerFiles({
    tb: 'Reports → Financial → Trial Balance.',
    coa: 'Lists → Accounting → Accounts → export.',
    ar: 'Reports → Customers/Receivables → A/R Aging Detail.',
    ap: 'Reports → Vendors/Payables → A/P Aging Detail.',
    customers: 'Lists → Relationships → Customers → export.',
    vendors: 'Lists → Relationships → Vendors → export with Tax ID and 1099 Eligible.',
    items: 'Lists → Accounting → Items → export.',
    dims: 'Setup → Company → Classes / Departments / Locations.',
    bank: 'Reconciliation history or summary.',
    v1099: '1099 vendor totals, year to date.',
  }),
  afterGoLive: LEDGER_AFTER('NetSuite'),
};

const SMALL_LEDGER_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'draft',
  summary: draftSummary('FreshBooks or Wave', 'Small-business ledgers with the same core reports. The closest report is fine; we read the headings.'),
  steps: [
    { title: 'Run the Trial Balance', detail: 'FreshBooks: Reports → Trial Balance. Wave: Reports → Trial Balance. Date: your cutover date; Accrual. Export to Excel or CSV.' },
    { title: 'Export the chart of accounts', detail: 'FreshBooks: Accounting → Chart of Accounts. Wave: Accounting → Chart of Accounts. Export, or copy the list with each account’s type.' },
    { title: 'Run the receivables aging', detail: 'FreshBooks: Reports → Accounts Aging. Wave: Reports → Aged Receivables. As of your cutover date, by invoice. Export.' },
    { title: 'Run the payables aging', detail: 'Wave: Reports → Aged Payables. FreshBooks: Bills → filter Unpaid → export. As of your cutover date.' },
    { title: 'Export customers and vendors', detail: 'FreshBooks: Clients → export; Bills → Vendors. Wave: Sales → Customers → export; Purchases → Vendors.' },
    DROP_STEP('FreshBooks and Wave'),
  ],
  files: ledgerFiles({
    tb: 'Reports → Trial Balance as of your cutover date.',
    coa: 'Accounting → Chart of Accounts.',
    ar: 'Accounts aging / aged receivables by invoice.',
    ap: 'Aged payables / unpaid bills.',
    customers: 'Clients or customers export.',
    vendors: 'Vendors export.',
  }),
  afterGoLive: LEDGER_AFTER('The old ledger'),
};

const SPREADSHEET_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'confirmed',
  summary: 'Books kept in Excel or Google Sheets. Use these column headings and we read the files with rules only. Title rows above the headings are fine.',
  steps: [
    { title: 'Trial balance', detail: 'One row per account as of your cutover date with columns Account number, Account name, Debit, Credit. Debits must equal credits.' },
    { title: 'Open invoices', detail: 'One row per unpaid customer invoice: Customer, Invoice #, Date, Due date, Open balance.' },
    { title: 'Open bills', detail: 'One row per unpaid vendor bill: Vendor, Bill #, Date, Due date, Open balance.' },
    { title: 'Customers and vendors', detail: 'Name, Email, Phone, Address, Tax ID; for vendors add a 1099 column (Yes / No).' },
    { title: 'Save and drop', detail: 'Save each as .xlsx or .csv (Google Sheets: File → Download) and drop them below.' },
  ],
  files: ledgerFiles({
    tb: 'Account number, Account name, Debit, Credit.',
    coa: 'Account number, Account name, Type (Asset, Liability, Equity, Income, Expense).',
    ar: 'Customer, Invoice #, Date, Due date, Open balance.',
    ap: 'Vendor, Bill #, Date, Due date, Open balance.',
    customers: 'Name, Email, Phone, Address.',
    vendors: 'Name, Email, Phone, Tax ID, 1099.',
  }),
  afterGoLive: LEDGER_AFTER('The spreadsheet'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Field / job / ERP systems with system-specific recipes
// ─────────────────────────────────────────────────────────────────────────────

const INNERGY_RECIPE: ExportRecipe = {
  version: 'v1',
  status: 'draft',
  summary: 'Recipe v1 · draft, confirm with the client’s Innergy admin. Innergy has no public API: export and drop for the opening; QuickBooks stays the control for balances, Innergy for job identity and WIP inputs.',
  steps: [
    { title: 'Open Innergy and go to the Jobs list', detail: 'Filter status to Active and On hold. Leave the date range blank so every open job comes through.' },
    { title: 'Export the WIP view to Excel', detail: 'Use the WIP columns: contract, change orders, cost to date, billed to date, retainage. Keep the header row.' },
    { title: 'Export open AR and AP', detail: 'Both as Excel, as of your cutover date. These enrich QuickBooks’ agings; they don’t replace them.' },
    { title: 'Drop the three files below', detail: 'We recognize Innergy exports by their headers. Rename nothing.' },
  ],
  files: [
    { key: 'wip', label: 'Innergy WIP export (open jobs)', entity: 'job', required: true, hint: 'Contract, change orders, cost to date, billed to date, retainage.' },
    { key: 'open_ar', label: 'Open AR as of your cutover date', entity: 'open_invoice', required: true, hint: 'Excel, one row per open invoice.' },
    { key: 'open_ap', label: 'Open AP as of your cutover date', entity: 'open_bill', required: true, hint: 'Excel, one row per open bill.' },
  ],
  afterGoLive:
    'Monthly WIP file until Innergy access lands. The QuickBooks bridge, if turned on, carries daily invoices; anything also dropped as a file is matched, not posted twice.',
};

const SERVICETITAN_RECIPE = fieldRecipe('ServiceTitan', {
  jobs: 'Reports → create a report from the Jobs template. Filter Job Status to In Progress, Scheduled and On Hold.',
  jobColumns: 'Job #, Customer, Business Unit, Job Type, Status, job total (contract), invoiced to date and total costs',
  invoices: 'Accounting → Reports → A/R Aging (by invoice) as of your cutover date. Export to Excel.',
  customers: 'Reports → Customers template → export to Excel.',
  dims: 'Settings → Business Units. Export the list, or copy the names into a one-column sheet headed “Business unit”.',
  items: 'Pricebook → Export (services, materials and equipment).',
  extra: 'ServiceTitan has an API; our connector is a later wave, so today it is export and drop. The ledger stays the control for opening A/R.',
});

const BUILDERTREND_RECIPE = fieldRecipe('Buildertrend', {
  jobs: 'Jobs → Jobs List, filter Status: Open. Export to Excel. Then Financial → Job Costing Budget for the same jobs.',
  jobColumns: 'job name, customer (owner), status, contract price, approved change orders, costs and amount invoiced',
  invoices: 'Financial → Owner Invoices, filter Unpaid, as of your cutover date. Export to Excel.',
  customers: 'Customers → Customer Contacts → Export to Excel.',
  items: 'Settings → Cost Codes / Cost Items library → export, if the company uses one.',
  extra: 'Buildertrend syncs to QuickBooks, so it can also be read through QuickBooks temporarily. The ledger stays the control for opening A/R.',
});

const SIMPRO_RECIPE = fieldRecipe('simPRO', {
  jobs: 'Jobs → filter Stage: Pending and Progress (include On hold). Use the job list’s export, or Reports → Job reports → Work in Progress.',
  jobColumns: 'Job No., Customer, Cost Centre / business unit, Stage, contract total, variations (change orders), cost to date and invoiced to date',
  invoices: 'Reports → Debtors (aged receivables), by invoice, as of your cutover date. Export to Excel.',
  customers: 'People → Customers → export to CSV.',
  dims: 'Setup → Accounts Setup → Cost Centres / Business Groups. Export or copy the names into a one-column sheet headed “Business unit”.',
  items: 'Catalogue → export (catalogue items and pre-builds).',
  extra: 'simPRO has an API; our connector is a later wave, so today it is export and drop. The ledger stays the control for opening A/R; simPRO adds the job and lines.',
});

const RFMS_RECIPE = fieldRecipe('RFMS', {
  jobs: 'Orders / Jobs: open sales orders and installs not yet fully invoiced. Use the job costing or open-orders report and export to Excel.',
  jobColumns: 'order or job number, customer, store, status, order total (contract), change orders, cost to date and billed to date',
  invoices: 'Accounts Receivable → Aged Trial Balance (by invoice) as of your cutover date. Export to Excel.',
  customers: 'Customers → customer list export.',
  dims: 'Stores / branches: copy the store names into a one-column sheet headed “Store”.',
  items: 'Products / price list export (styles, colors, labor items).',
  extra: 'Flooring ERP. The ledger stays the control for opening A/R; RFMS adds the order and install detail.',
});

const CSYSTEMS_RECIPE = fieldRecipe('C-Systems', {
  jobs: 'Service: open work orders (repair orders) not yet invoiced. Export the open work-order report to Excel.',
  jobColumns: 'work order #, customer, department, status, quoted total (contract), parts and labor cost to date and billed to date',
  invoices: 'Accounts Receivable → aging by invoice as of your cutover date. Export to Excel.',
  customers: 'Customer list export.',
  dims: 'Departments or stores (sales, parts, service): copy the names into a one-column sheet headed “Department”.',
  items: 'Parts and whole-goods inventory list export (the inventory valuation at cutover is evidence for the inventory account).',
  extra: 'Dealer management system. If the ledger it fed has been cancelled or is read-only, these exports plus the last saved trial balance are how the opening is rebuilt.',
});

const FIELDEDGE_RECIPE = fieldRecipe('FieldEdge', {
  jobs: 'Reports → Work Orders, filter Status: open / in progress / on hold. Export to Excel.',
  jobColumns: 'work order #, customer, department, status, total (contract), cost to date and billed to date',
  invoices: 'Reports → Invoices (or A/R aging) filtered to unpaid as of your cutover date. Export to Excel.',
  customers: 'Customers → export.',
  dims: 'Departments / divisions: copy the names into a one-column sheet headed “Department”.',
  items: 'Price book → export (flat-rate tasks and parts).',
  extra: 'FieldEdge syncs to QuickBooks, so it can also be read through QuickBooks temporarily. The ledger stays the control for opening A/R.',
});

/** Construction ledgers that sit in the field group: TB + AR/AP + jobs/WIP (one-time). */
function constructionLedgerRecipe(name: string, tb: string, wip: string): ExportRecipe {
  return {
    version: 'v1',
    status: 'draft',
    summary: draftSummary(name, `${name} is a construction ledger: it brings the opening balances and the WIP schedule, then is archived.`),
    steps: [
      { title: 'Run the trial balance', detail: `${tb} As of your cutover date. Export to Excel.` },
      { title: 'Export the chart of accounts', detail: 'General ledger account list with account type. Export to Excel.' },
      { title: 'Run the A/R and A/P agings', detail: 'Receivables and payables aging by invoice, as of your cutover date. Include retainage columns. Export each to Excel.' },
      { title: 'Run the WIP schedule', detail: `${wip} Keep contract, approved change orders, estimated cost, cost to date, billed to date, over/under billing and retainage.` },
      { title: 'Export customers and vendors', detail: 'Client and vendor (subcontractor) lists, with tax ID and 1099 flag on vendors.' },
      DROP_STEP(name),
    ],
    files: [
      ...ledgerFiles({
        tb: 'Trial balance as of your cutover date.',
        coa: 'Account list with type.',
        ar: 'A/R aging by invoice, with retainage.',
        ap: 'A/P aging by invoice, with retainage.',
        customers: 'Client list.',
        vendors: 'Vendor / subcontractor list with tax ID and 1099.',
      }),
      { key: 'wip', label: 'WIP schedule as of your cutover date', entity: 'job', required: true, hint: 'One row per open job.' },
    ],
    afterGoLive: LEDGER_AFTER(name),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bank, card, spend, CRM, docs
// ─────────────────────────────────────────────────────────────────────────────

const STATEMENT_STEPS: RecipeStep[] = [
  {
    title: 'Download the statement that covers your cutover date',
    detail: 'In online banking: Statements → the month containing your cutover date → Download PDF. If the statement ends after your cutover date, also download that month’s transactions as CSV, OFX or QFX.',
  },
  { title: 'One file per account', detail: 'Every checking, savings, credit card and loan account on the trial balance. The statement balance is what the bank tie-out proves against.' },
  { title: 'Add the last reconciliation, if you have it', detail: 'The ledger’s last bank reconciliation on or before cutover tells us which checks and deposits were still outstanding.' },
  { title: 'Drop the files below', detail: 'PDF statements go through the document reader; CSV, OFX and QFX are read with rules only.' },
];

const STATEMENT_FILES: RecipeFile[] = [
  { key: 'statements', label: 'Statement covering your cutover date, per account', entity: 'bank_balance', required: true, hint: 'PDF is fine; OFX, QFX or CSV if your bank offers it.' },
  { key: 'bank_reconciliations', label: 'Last bank reconciliation, per account', entity: 'bank_balance', required: false, hint: 'From the ledger, on or before cutover.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// THE CATALOG
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCE_SYSTEMS: readonly SourceSystem[] = [
  // ── Ledgers (one-time) ──────────────────────────────────────────────────────
  {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'native_api',
    apiStatus: 'live',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'item', 'dimension', 'open_invoice', 'open_bill', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'The most common small-business ledger. Connect once per company; read-only, archived at sign-off.',
    recipe: QBO_RECIPE,
    aliases: ['QBO', 'QuickBooks', 'Intuit QuickBooks', 'QB Online'],
  },
  {
    id: 'quickbooks-desktop',
    name: 'QuickBooks Desktop',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'item', 'dimension', 'open_invoice', 'open_bill', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'QuickBooks Pro, Premier or Enterprise installed on a PC or hosted server.',
    recipe: QBD_RECIPE,
    aliases: ['QBD', 'QuickBooks Enterprise', 'QuickBooks Pro', 'QuickBooks Premier'],
  },
  {
    id: 'xero',
    name: 'Xero',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'item', 'dimension', 'open_invoice', 'open_bill', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'Cloud ledger popular with small businesses and their advisors.',
    recipe: XERO_RECIPE,
  },
  {
    id: 'sage-intacct',
    name: 'Sage Intacct',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'item', 'dimension', 'open_invoice', 'open_bill', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'Mid-market cloud ledger with departments, locations and multi-entity.',
    recipe: INTACCT_RECIPE,
    aliases: ['Intacct'],
  },
  {
    id: 'sage-50',
    name: 'Sage 50',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'item', 'open_invoice', 'open_bill', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'Desktop small-business ledger, formerly Peachtree.',
    recipe: SAGE50_RECIPE,
    aliases: ['Peachtree', 'Sage 50cloud', 'Sage'],
  },
  {
    id: 'sage-100-300',
    name: 'Sage 100 / 300',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'item', 'open_invoice', 'open_bill', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'Sage’s on-premise ERP ledgers for distributors and mid-size companies.',
    recipe: SAGE100_300_RECIPE,
    aliases: ['Sage 100', 'Sage 300', 'Sage ERP', 'MAS 90', 'MAS 200', 'Accpac', 'Sage'],
  },
  {
    id: 'netsuite',
    name: 'NetSuite',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'item', 'dimension', 'open_invoice', 'open_bill', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'Oracle’s cloud ERP for multi-subsidiary companies.',
    recipe: NETSUITE_RECIPE,
    aliases: ['Oracle NetSuite'],
  },
  {
    id: 'freshbooks-wave',
    name: 'FreshBooks / Wave',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'open_invoice', 'open_bill'],
    ongoingFeed: false,
    oneLine: 'Invoicing-first ledgers used by very small businesses.',
    recipe: SMALL_LEDGER_RECIPE,
    aliases: ['FreshBooks', 'Wave', 'Wave Accounting'],
  },
  {
    id: 'spreadsheets',
    name: 'Spreadsheets',
    group: 'ledger',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'open_invoice', 'open_bill'],
    ongoingFeed: false,
    oneLine: 'Books kept in Excel or Google Sheets, or a bookkeeper’s workbook.',
    recipe: SPREADSHEET_RECIPE,
    aliases: ['Excel', 'Google Sheets', 'CSV', 'Workbook'],
  },

  // ── Field / job / ERP (ongoing) ─────────────────────────────────────────────
  {
    id: 'servicetitan',
    name: 'ServiceTitan',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer', 'dimension', 'item'],
    ongoingFeed: true,
    oneLine: 'Dispatch, jobs and invoicing for residential and commercial trades.',
    bridgeViaQuickBooks: true,
    recipe: SERVICETITAN_RECIPE,
  },
  {
    id: 'buildertrend',
    name: 'Buildertrend',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer', 'item'],
    ongoingFeed: true,
    oneLine: 'Project management for home builders and remodelers.',
    bridgeViaQuickBooks: true,
    recipe: BUILDERTREND_RECIPE,
  },
  {
    id: 'innergy',
    name: 'Innergy',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'open_bill'],
    ongoingFeed: true,
    oneLine: 'ERP for millwork and custom cabinetry shops: jobs, WIP and purchasing.',
    bridgeViaQuickBooks: true,
    recipe: INNERGY_RECIPE,
  },
  {
    id: 'simpro',
    name: 'simPRO',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer', 'dimension', 'item'],
    ongoingFeed: true,
    oneLine: 'Job management for HVAC, electrical, plumbing and security contractors.',
    bridgeViaQuickBooks: true,
    recipe: SIMPRO_RECIPE,
    aliases: ['Simpro', 'simPRO Premium'],
  },
  {
    id: 'rfms',
    name: 'RFMS',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'partner_pending',
    entities: ['job', 'open_invoice', 'customer', 'dimension', 'item'],
    ongoingFeed: true,
    oneLine: 'Flooring business ERP: measure, sell, install.',
    recipe: RFMS_RECIPE,
    aliases: ['RFMS Online'],
  },
  {
    id: 'c-systems',
    name: 'C-Systems',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer', 'dimension', 'item'],
    ongoingFeed: true,
    oneLine: 'Dealer management for equipment dealers: parts, service work orders and whole goods.',
    recipe: CSYSTEMS_RECIPE,
    aliases: ['c-Systems', 'CSystems', 'C Systems'],
  },
  {
    id: 'fieldedge',
    name: 'FieldEdge',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer', 'dimension', 'item'],
    ongoingFeed: true,
    oneLine: 'Dispatch and service management for HVAC, plumbing and electrical.',
    bridgeViaQuickBooks: true,
    recipe: FIELDEDGE_RECIPE,
    aliases: ['Field Edge'],
  },
  {
    id: 'procore',
    name: 'Procore',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'Construction project and financials management.',
    recipe: fieldRecipe('Procore', {
      jobs: 'Company → Portfolio, filter to active projects. For each, Budget and Prime Contracts → Export (or the Company-level Prime Contracts and Budget reports).',
      invoices: 'Invoicing (owner invoices / payment applications) filtered to unpaid as of your cutover date → Export.',
      customers: 'Company Directory → Companies, filter to owners / clients → Export.',
    }),
  },
  {
    id: 'jobber',
    name: 'Jobber',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer', 'item'],
    ongoingFeed: true,
    oneLine: 'Quoting, scheduling and invoicing for small field teams.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('Jobber', {
      jobs: 'Reports → Jobs (or Work → Jobs), filter to active and requires-invoicing → Export CSV.',
      invoices: 'Reports → Aged receivables, or Invoices filtered to Awaiting payment / Past due → Export CSV.',
      customers: 'Clients → Export (client list).',
      items: 'Settings → Products & Services → Export.',
    }),
  },
  {
    id: 'housecall-pro',
    name: 'Housecall Pro',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer', 'item'],
    ongoingFeed: true,
    oneLine: 'Scheduling, invoicing and payments for home-service pros.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('Housecall Pro', {
      jobs: 'Reporting → Jobs, filter to open / unscheduled / in progress → Export CSV.',
      invoices: 'Reporting → Invoices filtered to unpaid as of your cutover date → Export CSV.',
      customers: 'Customers → Export.',
      items: 'Price book → Export.',
    }),
  },
  {
    id: 'buildops',
    name: 'BuildOps',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'partner_pending',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'Service and project management for commercial contractors.',
    recipe: fieldRecipe('BuildOps', {
      jobs: 'Projects and Jobs lists, filtered to open → Export.',
      invoices: 'Accounting → Invoices filtered to unpaid as of your cutover date → Export.',
      customers: 'Customers → Export.',
    }),
  },
  {
    id: 'servicetrade',
    name: 'ServiceTrade',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'Service management for commercial mechanical and fire-protection contractors.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('ServiceTrade', {
      jobs: 'Jobs, filtered to open / scheduled / completed-not-invoiced → Export CSV.',
      invoices: 'Invoices filtered to unpaid as of your cutover date → Export CSV.',
      customers: 'Companies (customers) → Export.',
    }),
  },
  {
    id: 'jobtread',
    name: 'JobTread',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'Estimating, job costing and project management for builders and remodelers.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('JobTread', {
      jobs: 'Jobs list filtered to open → Export, with the budget vs actual (job costing) columns.',
      invoices: 'Documents → customer invoices filtered to unpaid as of your cutover date → Export.',
      customers: 'Customers → Export.',
    }),
  },
  {
    id: 'knowify',
    name: 'Knowify',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'Job costing and project management for contractors.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('Knowify', {
      jobs: 'Reports → Job Costing / WIP report for active jobs → Export to Excel.',
      invoices: 'Invoices filtered to unpaid as of your cutover date → Export.',
      customers: 'Clients → Export.',
    }),
  },
  {
    id: 'contractor-foreman',
    name: 'Contractor Foreman',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'All-in-one construction management for small contractors.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('Contractor Foreman', {
      jobs: 'Projects filtered to open → Export, with the project financial summary columns.',
      invoices: 'Invoices filtered to unpaid as of your cutover date → Export.',
      customers: 'Directory → Customers → Export.',
    }),
  },
  {
    id: 'foundation',
    name: 'Foundation Software',
    group: 'field',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'open_invoice', 'open_bill', 'job'],
    ongoingFeed: false,
    oneLine: 'Construction accounting and job-cost payroll (a ledger; archived at sign-off).',
    recipe: constructionLedgerRecipe('Foundation', 'General Ledger → Reports → Trial Balance.', 'Job Cost → Reports → WIP Schedule (over/under billing).'),
    aliases: ['Foundation', 'FOUNDATION Software'],
  },
  {
    id: 'sage-100-contractor',
    name: 'Sage 100 Contractor',
    group: 'field',
    role: 'ledger_source',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['account', 'tb_line', 'customer', 'vendor', 'open_invoice', 'open_bill', 'job'],
    ongoingFeed: false,
    oneLine: 'Construction accounting and job cost, formerly Master Builder (a ledger; archived at sign-off).',
    recipe: constructionLedgerRecipe('Sage 100 Contractor', 'General Ledger → Trial Balance report.', 'Job cost → Work in Progress report.'),
    aliases: ['Master Builder', 'Sage Master Builder'],
  },
  {
    id: 'jobnimbus',
    name: 'JobNimbus',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'CRM and project management for roofing and exterior contractors.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('JobNimbus', {
      jobs: 'Jobs board / list filtered to open statuses → Export.',
      invoices: 'Invoices filtered to unpaid as of your cutover date → Export.',
      customers: 'Contacts → Export.',
    }),
  },
  {
    id: 'acculynx',
    name: 'AccuLynx',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['job', 'open_invoice', 'customer'],
    ongoingFeed: true,
    oneLine: 'Business management for roofing contractors.',
    bridgeViaQuickBooks: true,
    recipe: fieldRecipe('AccuLynx', {
      jobs: 'Reports → Jobs / Job Profitability for open jobs → Export.',
      invoices: 'Reports → Receivables (unpaid invoices) as of your cutover date → Export.',
      customers: 'Contacts → Export.',
    }),
  },
  {
    id: 'compufloor',
    name: 'Comp-U-Floor',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer', 'item'],
    ongoingFeed: true,
    oneLine: 'ERP for flooring dealers and contractors.',
    recipe: fieldRecipe('Comp-U-Floor', {
      jobs: 'Open orders / jobs report → Export to Excel.',
      invoices: 'Accounts receivable aging by invoice as of your cutover date → Export.',
      customers: 'Customer list → Export.',
      items: 'Product / price list → Export.',
    }),
    aliases: ['CompuSystems', 'Comp U Floor', 'Compufloor'],
  },
  {
    id: 'qfloors',
    name: 'QFloors',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer', 'item'],
    ongoingFeed: true,
    oneLine: 'Flooring business and inventory software.',
    recipe: fieldRecipe('QFloors', {
      jobs: 'Open jobs / orders report → Export to Excel.',
      invoices: 'Receivables aging by invoice as of your cutover date → Export.',
      customers: 'Customer list → Export.',
      items: 'Products / inventory list → Export.',
    }),
  },
  {
    id: 'rollmaster',
    name: 'RollMaster',
    group: 'field',
    role: 'field_system',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['job', 'open_invoice', 'customer', 'item'],
    ongoingFeed: true,
    oneLine: 'Flooring ERP with roll and inventory management.',
    recipe: fieldRecipe('RollMaster', {
      jobs: 'Open orders / jobs report → Export to Excel.',
      invoices: 'A/R aging by invoice as of your cutover date → Export.',
      customers: 'Customer list → Export.',
      items: 'Products / inventory list → Export.',
    }),
  },

  // ── Bank & card ─────────────────────────────────────────────────────────────
  {
    id: 'plaid',
    name: 'Bank & card accounts (Plaid)',
    group: 'bank',
    role: 'bank',
    tier: 'native_api',
    apiStatus: 'live',
    entities: ['bank_balance'],
    ongoingFeed: true,
    oneLine: 'Connect checking, savings and card accounts at most US banks. Read-only.',
    recipe: {
      version: 'v1',
      status: 'confirmed',
      summary: 'Connecting through Plaid pulls balances and transactions automatically. If a bank won’t connect, use statements instead.',
      steps: STATEMENT_STEPS,
      files: STATEMENT_FILES,
      afterGoLive: 'Stays connected: transactions after cutover flow into the bank feed for categorization and reconciliation.',
    },
    aliases: ['Bank feed', 'Bank connection'],
  },
  {
    id: 'ramp',
    name: 'Ramp',
    group: 'bank',
    role: 'card_spend',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['bank_balance', 'vendor', 'open_bill'],
    ongoingFeed: true,
    oneLine: 'Corporate cards, bill pay and reimbursements with receipts and coding.',
    recipe: {
      version: 'v1',
      status: 'draft',
      summary: draftSummary('Ramp', 'Ramp has an API; our connector is a later wave. For the opening we need the card balance, unpaid bills and vendors at cutover.'),
      steps: [
        { title: 'Download the card statement covering your cutover date', detail: 'Statements → the statement period containing your cutover date → download (PDF or CSV).' },
        { title: 'Export unpaid bills', detail: 'Bill Pay → Bills, filter to unpaid / awaiting approval / scheduled as of your cutover date → Export CSV.' },
        { title: 'Export vendors', detail: 'Vendors → Export CSV.' },
        DROP_STEP('Ramp'),
      ],
      files: [
        { key: 'card_statement', label: 'Card statement covering your cutover date', entity: 'bank_balance', required: true, hint: 'The statement balance ties to the card liability account.' },
        { key: 'open_bills', label: 'Unpaid bills as of your cutover date', entity: 'open_bill', required: false, hint: 'Bill Pay → Bills → Export.' },
        { key: 'vendors', label: 'Vendors', entity: 'vendor', required: false, hint: 'Vendors → Export.' },
      ],
      afterGoLive: 'Stays connected after go-live: card transactions with receipts and coding, bills and reimbursements flow in as MeritBooks documents.',
    },
  },
  {
    id: 'bank-statements',
    name: 'Bank statement files',
    group: 'bank',
    role: 'bank',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['bank_balance'],
    ongoingFeed: true,
    oneLine: 'Statements as PDF, OFX, QFX, CSV or BAI2, for any bank, card or loan.',
    recipe: {
      version: 'v1',
      status: 'confirmed',
      summary: 'For any bank, card or loan account: the statement covering your cutover date proves the opening cash.',
      steps: STATEMENT_STEPS,
      files: STATEMENT_FILES,
      afterGoLive: 'Statement files are evidence for the bank tie-out. After go-live, connect the account through Plaid or keep dropping monthly statements.',
    },
    aliases: ['OFX', 'QFX', 'BAI2', 'Statements', 'Amex', 'Chase', 'US Bank'],
  },

  // ── Payroll ─────────────────────────────────────────────────────────────────
  {
    id: 'gusto',
    name: 'Gusto',
    group: 'payroll',
    role: 'payroll',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['evidence'],
    ongoingFeed: true,
    oneLine: 'Payroll, benefits and HR for small businesses.',
    recipe: payrollRecipe('Gusto', {
      register: 'Reports → Payroll journal (Payroll Journal report).',
      liabilities: 'Reports → tax liabilities / taxes and debits report as of your cutover date.',
      ytd: 'Reports → Employee summary (year-to-date by employee).',
    }),
  },
  {
    id: 'adp',
    name: 'ADP',
    group: 'payroll',
    role: 'payroll',
    tier: 'recipe',
    apiStatus: 'partner_pending',
    entities: ['evidence'],
    ongoingFeed: true,
    oneLine: 'Payroll and HR (RUN for small business, Workforce Now for mid-size).',
    recipe: payrollRecipe('ADP', {
      register: 'Reports → Payroll Register (RUN) or Payroll Register / Payroll Summary (Workforce Now).',
      liabilities: 'Reports → Liabilities / Tax Liability report.',
      ytd: 'Reports → Earnings Record or Employee YTD Summary.',
    }),
    aliases: ['ADP RUN', 'ADP Workforce Now'],
  },
  {
    id: 'paychex',
    name: 'Paychex',
    group: 'payroll',
    role: 'payroll',
    tier: 'recipe',
    apiStatus: 'partner_pending',
    entities: ['evidence'],
    ongoingFeed: true,
    oneLine: 'Payroll and HR services (Paychex Flex).',
    recipe: payrollRecipe('Paychex', {
      register: 'Reports → Payroll Journal.',
      liabilities: 'Reports → Tax liability / Cash Requirements report as of your cutover date.',
      ytd: 'Reports → Employee Earnings (year to date).',
    }),
    aliases: ['Paychex Flex'],
  },
  {
    id: 'quickbooks-payroll',
    name: 'QuickBooks Payroll',
    group: 'payroll',
    role: 'payroll',
    tier: 'recipe',
    apiStatus: 'partner_pending',
    entities: ['evidence'],
    ongoingFeed: true,
    oneLine: 'Payroll run inside QuickBooks Online or Desktop.',
    recipe: payrollRecipe('QuickBooks Payroll', {
      register: 'Reports → Payroll Summary (or Payroll Details) by pay date.',
      liabilities: 'Reports → Payroll Tax Liability as of your cutover date.',
      ytd: 'Reports → Payroll Summary by Employee, year to date.',
    }),
    aliases: ['QBO Payroll', 'Intuit Payroll'],
  },
  {
    id: 'paylocity',
    name: 'Paylocity',
    group: 'payroll',
    role: 'payroll',
    tier: 'recipe',
    apiStatus: 'partner_pending',
    entities: ['evidence'],
    ongoingFeed: true,
    oneLine: 'Payroll and HR for mid-size employers.',
    recipe: payrollRecipe('Paylocity', {
      register: 'Reports → Payroll Register.',
      liabilities: 'Reports → Tax Liability report as of your cutover date.',
      ytd: 'Reports → Year-to-Date Earnings by Employee.',
    }),
  },

  // ── Spend / AP tools ───────────────────────────────────────────────────────
  {
    id: 'concur',
    name: 'SAP Concur',
    group: 'spend',
    role: 'card_spend',
    tier: 'recipe',
    apiStatus: 'partner_pending',
    entities: ['vendor', 'open_bill'],
    ongoingFeed: false,
    oneLine: 'Expense reports and invoice (AP) approvals.',
    recipe: {
      version: 'v1',
      status: 'draft',
      summary: draftSummary('Concur', 'One-time: approved-but-unpaid items and vendors at cutover. Approval chains are kept as evidence when setting up approvals.'),
      steps: [
        { title: 'Export approved, unpaid items', detail: 'Reporting → Intelligence: expense reports and invoices approved but not yet paid as of your cutover date → Export to Excel.' },
        { title: 'Export vendors', detail: 'Invoice → Vendor Manager → export the vendor list.' },
        DROP_STEP('Concur'),
      ],
      files: [
        { key: 'open_bills', label: 'Approved, unpaid items as of your cutover date', entity: 'open_bill', required: true, hint: 'Excel, one row per report or invoice.' },
        { key: 'vendors', label: 'Vendors', entity: 'vendor', required: false, hint: 'Vendor Manager export.' },
      ],
      afterGoLive: 'One-time. After go-live, expenses and bills are captured in MeritBooks.',
    },
    aliases: ['Concur'],
  },
  {
    id: 'bill-com',
    name: 'BILL (Bill.com)',
    group: 'spend',
    role: 'card_spend',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['vendor', 'open_bill'],
    ongoingFeed: false,
    oneLine: 'AP automation: bill approvals and vendor payments.',
    recipe: {
      version: 'v1',
      status: 'draft',
      summary: draftSummary('BILL', 'One-time: unpaid bills and vendors at cutover. Vendor bank details are never imported; vendors re-enter them through the vendor portal.'),
      steps: [
        { title: 'Export unpaid bills', detail: 'Payables → Bills, filter to unpaid / approving / scheduled as of your cutover date → Export (CSV).' },
        { title: 'Export vendors', detail: 'Payables → Vendors → Export (CSV), with tax ID and 1099 flag.' },
        DROP_STEP('BILL'),
      ],
      files: [
        { key: 'open_bills', label: 'Unpaid bills as of your cutover date', entity: 'open_bill', required: true, hint: 'One row per bill.' },
        { key: 'vendors', label: 'Vendors (tax ID, 1099)', entity: 'vendor', required: false, hint: 'Payables → Vendors → Export.' },
      ],
      afterGoLive: 'One-time. After go-live, bills and vendor payments run in MeritBooks.',
    },
    aliases: ['Bill.com', 'BILL', 'Bill'],
  },

  // ── CRM (customers master data only) ───────────────────────────────────────
  {
    id: 'hubspot',
    name: 'HubSpot',
    group: 'crm',
    role: 'crm',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['customer'],
    ongoingFeed: false,
    oneLine: 'CRM. Brings customer companies and contacts only; no pipeline in Books.',
    recipe: {
      version: 'v1',
      status: 'draft',
      summary: draftSummary('HubSpot', 'Customer master data only: names, contacts and addresses. Deals and pipeline stay in HubSpot.'),
      steps: [
        { title: 'Export customer companies', detail: 'CRM → Companies, filter Lifecycle stage: Customer → Export (CSV or XLSX) with Company name, Phone, Street address, City, State, Postal code.' },
        { title: 'Export customer contacts (optional)', detail: 'CRM → Contacts, filter Lifecycle stage: Customer → Export with First name, Last name, Email, Phone, Associated company.' },
        DROP_STEP('HubSpot'),
      ],
      files: [{ key: 'customers', label: 'Customer companies', entity: 'customer', required: true, hint: 'Matched to the ledger’s customers, not duplicated.' }],
      afterGoLive: 'Optional: keep enriching customer contact details. No pipeline data comes into Books.',
    },
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    group: 'crm',
    role: 'crm',
    tier: 'recipe',
    apiStatus: 'planned',
    entities: ['customer'],
    ongoingFeed: false,
    oneLine: 'CRM. Brings customer accounts and contacts only; no pipeline in Books.',
    recipe: {
      version: 'v1',
      status: 'draft',
      summary: draftSummary('Salesforce', 'Customer master data only. Opportunities and pipeline stay in Salesforce.'),
      steps: [
        { title: 'Run an Accounts report', detail: 'Reports → New Report → Accounts. Filter Type: Customer. Columns: Account Name, Phone, Billing Address, Website. Export → Details only → .xlsx.' },
        DROP_STEP('Salesforce', 'the file'),
      ],
      files: [{ key: 'customers', label: 'Customer accounts', entity: 'customer', required: true, hint: 'Matched to the ledger’s customers, not duplicated.' }],
      afterGoLive: 'Optional: keep enriching customer contact details. No pipeline data comes into Books.',
    },
  },

  // ── Documents + generic ────────────────────────────────────────────────────
  {
    id: 'documents',
    name: 'Documents drop',
    group: 'docs',
    role: 'docs',
    tier: 'recipe',
    apiStatus: 'no_public_api',
    entities: ['evidence'],
    ongoingFeed: false,
    oneLine: 'Loans, leases, bank recs, formation papers: the paper behind the balances.',
    recipe: {
      version: 'v1',
      status: 'confirmed',
      summary: 'The document reader proposes what each file is and pulls the figures; a person confirms before anything is used.',
      steps: [
        { title: 'Gather the paper behind the balances', detail: 'Loan statements or notes as of your cutover date, leases, the last bank reconciliations, the depreciation schedule, the last sales-tax return, and formation papers (articles, operating agreement, EIN letter).' },
        { title: 'Drop them below', detail: 'PDF, photo or Excel. One file per document is easiest; a combined PDF is fine.' },
      ],
      files: [
        { key: 'loans', label: 'Loan statements / notes as of your cutover date', entity: 'evidence', required: false, hint: 'Ties each loan balance on the trial balance.' },
        { key: 'leases', label: 'Leases', entity: 'evidence', required: false, hint: 'Equipment, vehicle and property leases.' },
        { key: 'sales_tax', label: 'Last sales-tax return', entity: 'evidence', required: false, hint: 'Ties sales tax payable.' },
        { key: 'depreciation', label: 'Depreciation / fixed-asset schedule', entity: 'evidence', required: false, hint: 'Ties fixed assets and accumulated depreciation.' },
        { key: 'formation', label: 'Formation documents', entity: 'evidence', required: false, hint: 'Articles, operating agreement, EIN letter.' },
      ],
      afterGoLive: 'One-time. Documents stay attached to the client as evidence on the conversion certificate.',
    },
    aliases: ['PDF', 'Loans', 'Leases', 'Files'],
  },
  {
    id: 'other-file',
    name: 'My system isn’t listed',
    group: 'docs',
    role: 'docs',
    tier: 'generic_file',
    apiStatus: 'no_public_api',
    entities: ['tb_line', 'account', 'open_invoice', 'open_bill', 'customer', 'vendor', 'item', 'job', 'bank_balance'],
    ongoingFeed: false,
    oneLine: 'Any system that can export Excel or CSV. We record what it is so a recipe or connector can follow.',
    recipe: {
      version: 'v1',
      status: 'confirmed',
      summary: 'Export the closest reports the system has. Each file is recognized by its column headings; anything we can’t place, you map column by column and the map is saved for next time.',
      steps: [
        { title: 'Export the closest reports you can', detail: 'Trial balance as of your cutover date; open invoices and open bills as of the same date; customer and vendor lists; open jobs. Excel or CSV; title rows and totals are fine.' },
        { title: 'Drop the files below', detail: 'We read the headings with rules only and tell you what each file looks like before anything is staged.' },
        { title: 'Tell us the system’s name', detail: 'We record it so a dedicated recipe or connector can be built.' },
      ],
      files: [
        { key: 'trial_balance', label: 'Trial balance as of your cutover date', entity: 'tb_line', required: false, hint: 'Account, Debit, Credit (or a signed Balance).' },
        { key: 'ar_aging', label: 'Open invoices as of your cutover date', entity: 'open_invoice', required: false, hint: 'Customer, Invoice #, Date, Due date, Open balance.' },
        { key: 'ap_aging', label: 'Open bills as of your cutover date', entity: 'open_bill', required: false, hint: 'Vendor, Bill #, Date, Due date, Open balance.' },
        { key: 'customers', label: 'Customers', entity: 'customer', required: false, hint: 'Name, Email, Phone, Address.' },
        { key: 'vendors', label: 'Vendors', entity: 'vendor', required: false, hint: 'Name, Tax ID, 1099.' },
        { key: 'open_jobs', label: 'Open jobs', entity: 'job', required: false, hint: 'Job #, Contract, Cost to date, Billed to date.' },
      ],
      afterGoLive: 'Depends on what it is: a ledger is archived at sign-off; anything else can keep sending files.',
    },
    aliases: ['Other', 'Not listed', 'Generic', 'CSV', 'Excel'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const GROUPS: { group: SourceGroup; label: string; blurb: string }[] = [
  { group: 'ledger', label: 'Ledger', blurb: 'The books you are moving off. Read once, proved, then archived at sign-off.' },
  { group: 'field', label: 'Field, job & ERP systems', blurb: 'Jobs, customers, price book and open invoices. Stays connected after go-live as a feed.' },
  { group: 'bank', label: 'Bank & card', blurb: 'Balances at cutover prove opening cash; transactions after cutover feed the bank feed.' },
  { group: 'payroll', label: 'Payroll', blurb: 'Registers, liabilities at cutover and year-to-date by employee.' },
  { group: 'spend', label: 'Spend & AP tools', blurb: 'Unpaid bills and vendors at cutover.' },
  { group: 'crm', label: 'CRM', blurb: 'Customer names and contacts only. No pipeline comes into Books.' },
  { group: 'docs', label: 'Documents & everything else', blurb: 'Loans, leases and bank recs, or any system that exports a spreadsheet.' },
];

const BY_ID: ReadonlyMap<string, SourceSystem> = new Map(SOURCE_SYSTEMS.map((s) => [s.id, s]));

export function getSourceSystem(id: string): SourceSystem | null {
  return BY_ID.get(id) ?? null;
}

/** The catalog grouped for the wizard, in display order. Empty groups are omitted. */
export function sourceGroups(): { group: SourceGroup; label: string; blurb: string; systems: SourceSystem[] }[] {
  return GROUPS.map((g) => ({ ...g, systems: SOURCE_SYSTEMS.filter((s) => s.group === g.group) })).filter((g) => g.systems.length > 0);
}

const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Name / id / alias contains the query (case- and punctuation-insensitive). Blank query = everything. */
export function searchSourceSystems(q: string): SourceSystem[] {
  const needle = fold(q ?? '');
  if (!needle) return [...SOURCE_SYSTEMS];
  return SOURCE_SYSTEMS.filter((s) => [s.name, s.id, ...(s.aliases ?? [])].some((h) => fold(h).includes(needle)));
}

/** The read-only promise shown above every connect / preview panel. */
export const READ_ONLY_PROMISE = (systemName: string): string =>
  `MeritBooks will only read. Nothing in ${systemName} changes.`;

/** The recipe slot for an entity (required slots first), or null when the recipe has none. */
export function recipeFileFor(system: SourceSystem, entity: StagedEntity): RecipeFile | null {
  const matches = system.recipe.files.filter((f) => f.entity === entity);
  return matches.find((f) => f.required) ?? matches[0] ?? null;
}
