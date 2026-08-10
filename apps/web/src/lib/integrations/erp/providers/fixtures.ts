/**
 * Provider-native FIXTURES — small, realistic sample payloads shaped exactly like
 * each provider's API/report records (native field names, native money format).
 *
 * These drive the MOCK adapter so the whole direct-API → conversion path is
 * exercisable NOW, before any OAuth credentials exist. Each provider's trial balance
 * is BALANCED (debits == credits) so the sample import can flow all the way to the
 * tie-out gate and post a balanced opening entry.
 *
 * Account codes/names deliberately mirror a standard small-business chart of accounts
 * so the conversion pipeline's number/name heuristics can auto-map most lines against
 * a seeded MeritBooks COA; anything unmatched is handled by the existing review UI.
 */

import type { MigrationProviderId } from './types';
import type { RawRecord } from './mapping';

export interface ProviderFixture {
  trialBalance: RawRecord[];
  accounts: RawRecord[];
  customers: RawRecord[];
  vendors: RawRecord[];
  openAR: RawRecord[];
  openAP: RawRecord[];
}

// ── QuickBooks Online (strings for money; AcctNum / DisplayName field names) ──────
const QBO_FIXTURE: ProviderFixture = {
  trialBalance: [
    { AcctNum: '1000', Name: 'Checking', Debit: '84250.00', Credit: '' },
    { AcctNum: '1200', Name: 'Accounts Receivable', Debit: '32500.00', Credit: '' },
    { AcctNum: '1500', Name: 'Equipment', Debit: '45000.00', Credit: '' },
    { AcctNum: '2000', Name: 'Accounts Payable', Debit: '', Credit: '18750.00' },
    { AcctNum: '2100', Name: 'Credit Card', Debit: '', Credit: '4500.00' },
    { AcctNum: '3000', Name: 'Opening Balance Equity', Debit: '', Credit: '138500.00' },
    // A TOTAL row (both a debit and a credit, no account code) is intentionally
    // OMITTED here; the conversion pipeline already excludes such rows on the CSV
    // path, and leaving it out keeps the preview's line count honest.
  ],
  accounts: [
    { AcctNum: '1000', Name: 'Checking', AccountType: 'Bank' },
    { AcctNum: '1200', Name: 'Accounts Receivable', AccountType: 'Accounts Receivable' },
    { AcctNum: '2000', Name: 'Accounts Payable', AccountType: 'Accounts Payable' },
    { AcctNum: '3000', Name: 'Opening Balance Equity', AccountType: 'Equity' },
    { AcctNum: '4000', Name: 'Sales', AccountType: 'Income' },
    { AcctNum: '5000', Name: 'Cost of Goods Sold', AccountType: 'Cost of Goods Sold' },
    { AcctNum: '6000', Name: 'Office Expense', AccountType: 'Expense' },
  ],
  customers: [
    { Id: '1', DisplayName: 'Northwind Traders', PrimaryEmailAddr: 'ap@northwind.example', PrimaryPhone: '515-555-0101' },
    { Id: '2', DisplayName: 'Cedar Ridge LLC', PrimaryEmailAddr: 'billing@cedarridge.example', PrimaryPhone: '515-555-0175' },
  ],
  vendors: [
    { Id: '10', DisplayName: 'Ace Supply Co', PrimaryEmailAddr: 'orders@acesupply.example', PrimaryPhone: '515-555-0190' },
    { Id: '11', DisplayName: 'Metro Utilities', PrimaryEmailAddr: 'billing@metroutil.example', PrimaryPhone: '515-555-0133' },
  ],
  openAR: [
    { CustomerName: 'Northwind Traders', DocNumber: 'INV-1042', TxnDate: '2025-12-05', DueDate: '2026-01-04', TotalAmt: '18500.00', Balance: '18500.00' },
    { CustomerName: 'Cedar Ridge LLC', DocNumber: 'INV-1043', TxnDate: '2025-12-18', DueDate: '2026-01-17', TotalAmt: '14000.00', Balance: '14000.00' },
  ],
  openAP: [
    { VendorName: 'Ace Supply Co', DocNumber: 'BILL-556', TxnDate: '2025-12-10', DueDate: '2026-01-09', TotalAmt: '12750.00', Balance: '12750.00' },
    { VendorName: 'Metro Utilities', DocNumber: 'BILL-557', TxnDate: '2025-12-22', DueDate: '2026-01-06', TotalAmt: '6000.00', Balance: '6000.00' },
  ],
};

// ── Xero (numbers for money; AccountCode / Class / ContactID field names) ─────────
const XERO_FIXTURE: ProviderFixture = {
  trialBalance: [
    { AccountCode: '1000', AccountName: 'Business Bank Account', Debit: 84250, Credit: 0 },
    { AccountCode: '1200', AccountName: 'Accounts Receivable', Debit: 32500, Credit: 0 },
    { AccountCode: '1500', AccountName: 'Office Equipment', Debit: 45000, Credit: 0 },
    { AccountCode: '2000', AccountName: 'Accounts Payable', Debit: 0, Credit: 18750 },
    { AccountCode: '2100', AccountName: 'Credit Card', Debit: 0, Credit: 4500 },
    { AccountCode: '3000', AccountName: 'Owner Funds Introduced', Debit: 0, Credit: 138500 },
  ],
  accounts: [
    { Code: '1000', Name: 'Business Bank Account', Class: 'ASSET' },
    { Code: '1200', Name: 'Accounts Receivable', Class: 'ASSET' },
    { Code: '2000', Name: 'Accounts Payable', Class: 'LIABILITY' },
    { Code: '3000', Name: 'Owner Funds Introduced', Class: 'EQUITY' },
    { Code: '4000', Name: 'Sales', Class: 'REVENUE' },
    { Code: '5000', Name: 'Cost of Goods Sold', Class: 'EXPENSE' },
  ],
  customers: [
    { ContactID: 'c-1', Name: 'Harbour Freight Ltd', EmailAddress: 'ap@harbourfreight.example', Phone: '515-555-0201' },
    { ContactID: 'c-2', Name: 'Willow Park Homes', EmailAddress: 'billing@willowpark.example', Phone: '515-555-0244' },
  ],
  vendors: [
    { ContactID: 'v-1', Name: 'Timber & Co', EmailAddress: 'orders@timberco.example', Phone: '515-555-0288' },
    { ContactID: 'v-2', Name: 'City Power', EmailAddress: 'billing@citypower.example', Phone: '515-555-0299' },
  ],
  openAR: [
    { Contact: 'Harbour Freight Ltd', InvoiceNumber: 'INV-2201', Date: '2025-12-08', DueDate: '2026-01-07', Total: 21000, AmountDue: 21000 },
    { Contact: 'Willow Park Homes', InvoiceNumber: 'INV-2202', Date: '2025-12-20', DueDate: '2026-01-19', Total: 11500, AmountDue: 11500 },
  ],
  openAP: [
    { Contact: 'Timber & Co', InvoiceNumber: 'BILL-880', Date: '2025-12-11', DueDate: '2026-01-10', Total: 14250, AmountDue: 14250 },
    { Contact: 'City Power', InvoiceNumber: 'BILL-881', Date: '2025-12-23', DueDate: '2026-01-07', Total: 4500, AmountDue: 4500 },
  ],
};

// ── Sage (strings for money; nominal_code / ledger_account_type field names) ──────
const SAGE_FIXTURE: ProviderFixture = {
  trialBalance: [
    { nominal_code: '1200', name: 'Bank Current Account', debit: '84250.00', credit: '0.00' },
    { nominal_code: '1100', name: 'Trade Debtors', debit: '32500.00', credit: '0.00' },
    { nominal_code: '0040', name: 'Furniture and Equipment', debit: '45000.00', credit: '0.00' },
    { nominal_code: '2100', name: 'Trade Creditors', debit: '0.00', credit: '18750.00' },
    { nominal_code: '2200', name: 'Credit Card Control', debit: '0.00', credit: '4500.00' },
    { nominal_code: '3000', name: "Owner's Capital", debit: '0.00', credit: '138500.00' },
  ],
  accounts: [
    { nominal_code: '1200', name: 'Bank Current Account', ledger_account_type: 'asset' },
    { nominal_code: '1100', name: 'Trade Debtors', ledger_account_type: 'asset' },
    { nominal_code: '2100', name: 'Trade Creditors', ledger_account_type: 'liability' },
    { nominal_code: '3000', name: "Owner's Capital", ledger_account_type: 'equity' },
    { nominal_code: '4000', name: 'Sales', ledger_account_type: 'income' },
    { nominal_code: '5000', name: 'Cost of Sales', ledger_account_type: 'cost_of_sales' },
  ],
  customers: [
    { id: 's-c-1', name: 'Ashford & Sons', email: 'ap@ashford.example', telephone: '515-555-0311' },
    { id: 's-c-2', name: 'Brookline Retail', email: 'billing@brookline.example', telephone: '515-555-0322' },
  ],
  vendors: [
    { id: 's-v-1', name: 'Pennine Supplies', email: 'orders@pennine.example', telephone: '515-555-0344' },
    { id: 's-v-2', name: 'National Grid Energy', email: 'billing@ngenergy.example', telephone: '515-555-0355' },
  ],
  openAR: [
    { contact_name: 'Ashford & Sons', reference: 'INV-3301', date: '2025-12-06', due_date: '2026-01-05', total_amount: '16750.00', outstanding_amount: '16750.00' },
    { contact_name: 'Brookline Retail', reference: 'INV-3302', date: '2025-12-19', due_date: '2026-01-18', total_amount: '15750.00', outstanding_amount: '15750.00' },
  ],
  openAP: [
    { contact_name: 'Pennine Supplies', reference: 'BILL-990', date: '2025-12-12', due_date: '2026-01-11', total_amount: '13250.00', outstanding_amount: '13250.00' },
    { contact_name: 'National Grid Energy', reference: 'BILL-991', date: '2025-12-24', due_date: '2026-01-08', total_amount: '5500.00', outstanding_amount: '5500.00' },
  ],
};

const FIXTURES: Record<MigrationProviderId, ProviderFixture> = {
  quickbooks: QBO_FIXTURE,
  xero: XERO_FIXTURE,
  sage: SAGE_FIXTURE,
};

export function getProviderFixture(id: MigrationProviderId): ProviderFixture {
  return FIXTURES[id];
}
