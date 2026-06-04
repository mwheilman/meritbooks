/**
 * Transaction-type catalog and payment rails (typed, code-side mirror of
 * core.transaction_types seeded in migration 029).
 *
 * Kept in sync with the migration by hand; the DB table is the runtime source of
 * truth (and what the UI reads), this union is the compile-time guard so a
 * template can only be registered for a real transaction type.
 */

export const TRANSACTION_TYPES = [
  // Purchases & operating expenses
  'vendor_bill',
  'bill_payment',
  'direct_expense',
  'prepaid_purchase',
  'inventory_purchase',
  'vendor_credit',
  // Revenue & receivables
  'customer_invoice',
  'cash_sale',
  'customer_payment',
  'deferred_revenue',
  'progress_billing',
  'retainage',
  'customer_refund',
  'bad_debt',
  // Cash & bank
  'bank_transfer',
  'bank_fee',
  'interest_income',
  'undeposited_funds',
  'nsf_reversal',
  // Credit cards
  'cc_charge',
  'cc_payment',
  'cc_refund',
  // Payroll
  'payroll_run',
  'payroll_remittance',
  // Fixed assets
  'asset_acquisition',
  'depreciation',
  'asset_disposal',
  // Debt & financing
  'loan_draw',
  'loan_payment',
  'accrued_interest',
  // Equity
  'owner_contribution',
  'owner_draw',
  // Tax
  'sales_tax_remittance',
  'income_tax_accrual',
  // Period-end & inter-company
  'accrual',
  'deferral',
  'lease_inception',
  'lease_payment',
  'internal_invoice',
  // Reserved future slots (GATE 11)
  'purchase_order',
  'po_receipt',
  'inventory_adjustment',
  'encumbrance',
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Payment rails. A rail is NOT a transaction type — it only decides which
 * account sits on the cash side of the entry and whether there is a clearing
 * step (Spec Part A.3).
 */
export const PAYMENT_RAILS = [
  'cash',
  'check',
  'ach',
  'wire',
  'debit_card',
  'credit_card',
  'on_account', // AP / AR — the obligation rail
] as const;

export type PaymentRail = (typeof PAYMENT_RAILS)[number];

export function isTransactionType(value: string): value is TransactionType {
  return (TRANSACTION_TYPES as readonly string[]).includes(value);
}

export function isPaymentRail(value: string): value is PaymentRail {
  return (PAYMENT_RAILS as readonly string[]).includes(value);
}
