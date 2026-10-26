/** Display words for journal-entry sources and types (list, drawer). */
export const JE_SOURCE_LABELS: Record<string, string> = {
  BANK_FEED: 'Bank feed',
  BILL: 'AP bill',
  AP: 'AP',
  AR: 'AR',
  RECEIPT: 'Receipt',
  PAYROLL: 'Payroll',
  MANUAL: 'Manual',
  REV_REC: 'Rev rec',
  DEPRECIATION: 'Depreciation',
  FIXED_ASSETS: 'Fixed assets',
  INTERCOMPANY: 'Intercompany',
  CASH_MGMT: 'Cash',
  SYSTEM: 'System',
};

export const JE_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  ADJUSTING: 'Adjusting',
  CLOSING: 'Closing',
  REVERSING: 'Reversing',
  RECURRING: 'Recurring',
  SYSTEM: 'System',
};
