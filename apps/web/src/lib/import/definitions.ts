/**
 * Import pipeline — type & field definitions.
 *
 * The pipeline enforces the Suite Core split:
 *   MASTER DATA  → core schema   (customers, vendors, items, entities)
 *   LEDGER DATA  → Books (public) (trial balance, open AR, open AP, GL history)
 *
 * Pure module — safe to import from both the client UI and the API route.
 */

export type ImportTarget = 'core' | 'books';

export type ImportFieldType =
  | 'text'
  | 'number'
  | 'money' // dollars in the CSV → cents in the DB
  | 'date' // any parseable date → YYYY-MM-DD
  | 'boolean'
  | 'enum';

export interface ImportFieldDef {
  key: string;
  label: string;
  type: ImportFieldType;
  required?: boolean;
  /** Lowercased header fragments used to auto-map a CSV column to this field. */
  aliases?: string[];
  /** Allowed values for enum fields (first is the default). */
  enumValues?: string[];
  /** Default applied when the mapped cell is blank. */
  default?: string | number | boolean;
  help?: string;
}

export interface ImportTypeDef {
  key: string;
  label: string;
  target: ImportTarget;
  /** Human description of where the data lands. */
  destination: string;
  description: string;
  fields: ImportFieldDef[];
  /** Ledger imports post against a single chosen company (location). */
  requiresCompany?: boolean;
  /** Trial balance is posted as of a single date. */
  requiresAsOfDate?: boolean;
  /** GL-history rows are grouped into balanced entries by this field key. */
  groupBy?: string;
}

const ITEM_TYPES = ['INVENTORY', 'NON_INVENTORY', 'SERVICE', 'LABOR', 'OTHER'];

export const IMPORT_TYPES: ImportTypeDef[] = [
  // ───────────────────────── MASTER DATA → CORE ─────────────────────────
  {
    key: 'entities',
    label: 'Companies / Entities',
    target: 'core',
    destination: 'core.locations',
    description: 'Each row becomes a company (entity). Multi-entity is native — every company carries its own books.',
    fields: [
      { key: 'name', label: 'Company Name', type: 'text', required: true, aliases: ['name', 'company', 'entity', 'legal name'] },
      { key: 'short_code', label: 'Short Code', type: 'text', required: true, aliases: ['code', 'short', 'abbr', 'shortcode'], help: 'Up to 10 chars, A–Z/0–9. Uppercased automatically.' },
      { key: 'industry', label: 'Industry', type: 'text', aliases: ['industry', 'sector', 'vertical'] },
      { key: 'fiscal_year_start_month', label: 'Fiscal Year Start Month', type: 'number', aliases: ['fiscal', 'fy start', 'year start'], default: 1, help: '1–12. Defaults to January.' },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    target: 'core',
    destination: 'core.customers',
    description: 'Accounts-receivable customers, shared across every Suite module.',
    fields: [
      { key: 'name', label: 'Customer Name', type: 'text', required: true, aliases: ['name', 'customer', 'company', 'client'] },
      { key: 'email', label: 'Email', type: 'text', aliases: ['email', 'e-mail'] },
      { key: 'phone', label: 'Phone', type: 'text', aliases: ['phone', 'tel'] },
      { key: 'address_line1', label: 'Address 1', type: 'text', aliases: ['address', 'address1', 'street', 'addr'] },
      { key: 'address_line2', label: 'Address 2', type: 'text', aliases: ['address2', 'suite', 'unit'] },
      { key: 'city', label: 'City', type: 'text', aliases: ['city'] },
      { key: 'state', label: 'State', type: 'text', aliases: ['state', 'province'] },
      { key: 'zip', label: 'ZIP', type: 'text', aliases: ['zip', 'postal'] },
      { key: 'payment_terms_days', label: 'Payment Terms (days)', type: 'number', aliases: ['terms', 'net', 'payment terms'], default: 30 },
      { key: 'credit_limit_cents', label: 'Credit Limit', type: 'money', aliases: ['credit limit', 'limit'] },
    ],
  },
  {
    key: 'vendors',
    label: 'Vendors',
    target: 'core',
    destination: 'core.vendors',
    description: 'Accounts-payable vendors, shared across every Suite module.',
    fields: [
      { key: 'name', label: 'Vendor Name', type: 'text', required: true, aliases: ['name', 'vendor', 'supplier', 'payee', 'company'] },
      { key: 'email', label: 'Email', type: 'text', aliases: ['email', 'e-mail'] },
      { key: 'phone', label: 'Phone', type: 'text', aliases: ['phone', 'tel'] },
      { key: 'address_line1', label: 'Address 1', type: 'text', aliases: ['address', 'address1', 'street'] },
      { key: 'address_line2', label: 'Address 2', type: 'text', aliases: ['address2', 'suite', 'unit'] },
      { key: 'city', label: 'City', type: 'text', aliases: ['city'] },
      { key: 'state', label: 'State', type: 'text', aliases: ['state', 'province'] },
      { key: 'zip', label: 'ZIP', type: 'text', aliases: ['zip', 'postal'] },
      { key: 'payment_terms_days', label: 'Payment Terms (days)', type: 'number', aliases: ['terms', 'net', 'payment terms'], default: 30 },
      { key: 'is_1099_eligible', label: '1099 Eligible', type: 'boolean', aliases: ['1099', '1099 eligible'] },
    ],
  },
  {
    key: 'items',
    label: 'Items / Products & Services',
    target: 'core',
    destination: 'core.items',
    description: 'Catalog of products and services. Thin canonical record; Inventory module adds the deep fields later.',
    fields: [
      { key: 'sku', label: 'SKU', type: 'text', required: true, aliases: ['sku', 'code', 'item', 'item code', 'part'] },
      { key: 'name', label: 'Name', type: 'text', required: true, aliases: ['name', 'description', 'item name'] },
      { key: 'item_type', label: 'Type', type: 'enum', enumValues: ITEM_TYPES, aliases: ['type', 'item type', 'category'], default: 'INVENTORY' },
      { key: 'unit_of_measure', label: 'Unit of Measure', type: 'text', aliases: ['uom', 'unit', 'measure'] },
      { key: 'default_unit_cost_cents', label: 'Default Unit Cost', type: 'money', aliases: ['cost', 'unit cost', 'price'] },
    ],
  },

  // ───────────────────────── LEDGER → BOOKS (public) ─────────────────────────
  {
    key: 'trial_balance',
    label: 'Trial Balance (opening balances)',
    target: 'books',
    destination: 'public.gl_entries (one balanced opening-balance entry)',
    description: 'Opening balances by account, posted as one balanced journal entry for the selected company as of a date.',
    requiresCompany: true,
    requiresAsOfDate: true,
    fields: [
      { key: 'account_number', label: 'Account Number', type: 'text', required: true, aliases: ['account', 'acct', 'account number', 'gl', 'number'] },
      { key: 'debit_cents', label: 'Debit', type: 'money', aliases: ['debit', 'dr', 'debits'] },
      { key: 'credit_cents', label: 'Credit', type: 'money', aliases: ['credit', 'cr', 'credits'] },
    ],
  },
  {
    key: 'open_ar',
    label: 'Open AR (unpaid customer invoices)',
    target: 'books',
    destination: 'public.invoices',
    description: 'Outstanding customer invoices. Customers are matched by name to core.customers.',
    requiresCompany: true,
    fields: [
      { key: 'customer_name', label: 'Customer Name', type: 'text', required: true, aliases: ['customer', 'name', 'client', 'bill to'] },
      { key: 'invoice_number', label: 'Invoice #', type: 'text', required: true, aliases: ['invoice', 'invoice number', 'number', 'doc'] },
      { key: 'invoice_date', label: 'Invoice Date', type: 'date', required: true, aliases: ['date', 'invoice date', 'issued'] },
      { key: 'due_date', label: 'Due Date', type: 'date', required: true, aliases: ['due', 'due date'] },
      { key: 'total_cents', label: 'Invoice Total', type: 'money', required: true, aliases: ['total', 'amount', 'invoice total'] },
      { key: 'amount_paid_cents', label: 'Amount Paid', type: 'money', aliases: ['paid', 'amount paid'], default: 0 },
      { key: 'memo', label: 'Memo', type: 'text', aliases: ['memo', 'note', 'description'] },
    ],
  },
  {
    key: 'open_ap',
    label: 'Open AP (unpaid vendor bills)',
    target: 'books',
    destination: 'public.bills',
    description: 'Outstanding vendor bills. Vendors are matched by name to core.vendors.',
    requiresCompany: true,
    fields: [
      { key: 'vendor_name', label: 'Vendor Name', type: 'text', required: true, aliases: ['vendor', 'name', 'supplier', 'payee'] },
      { key: 'bill_number', label: 'Bill #', type: 'text', aliases: ['bill', 'bill number', 'invoice', 'number', 'ref'] },
      { key: 'bill_date', label: 'Bill Date', type: 'date', required: true, aliases: ['date', 'bill date', 'issued'] },
      { key: 'due_date', label: 'Due Date', type: 'date', required: true, aliases: ['due', 'due date'] },
      { key: 'total_cents', label: 'Bill Total', type: 'money', required: true, aliases: ['total', 'amount', 'bill total'] },
      { key: 'amount_paid_cents', label: 'Amount Paid', type: 'money', aliases: ['paid', 'amount paid'], default: 0 },
    ],
  },
  {
    key: 'gl_history',
    label: 'GL History (historical journal entries)',
    target: 'books',
    destination: 'public.gl_entries',
    description: 'Historical journal entries. Rows sharing an Entry Ref are grouped into one balanced entry. Accounts matched by number.',
    requiresCompany: true,
    groupBy: 'entry_ref',
    fields: [
      { key: 'entry_ref', label: 'Entry Ref', type: 'text', required: true, aliases: ['entry', 'ref', 'entry ref', 'journal', 'je'], help: 'Rows with the same value become one journal entry.' },
      { key: 'entry_date', label: 'Entry Date', type: 'date', required: true, aliases: ['date', 'entry date', 'posted'] },
      { key: 'account_number', label: 'Account Number', type: 'text', required: true, aliases: ['account', 'acct', 'gl', 'number'] },
      { key: 'debit_cents', label: 'Debit', type: 'money', aliases: ['debit', 'dr'] },
      { key: 'credit_cents', label: 'Credit', type: 'money', aliases: ['credit', 'cr'] },
      { key: 'memo', label: 'Memo', type: 'text', aliases: ['memo', 'note', 'description'] },
    ],
  },
];

export function getImportType(key: string): ImportTypeDef | undefined {
  return IMPORT_TYPES.find((t) => t.key === key);
}
