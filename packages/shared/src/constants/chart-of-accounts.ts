/**
 * Merit Top Level Chart of Accounts — seed data constants.
 * 7 account types → 11 sub-types → 71 account groups → 251 accounts.
 * display_order drives financial statement presentation, NOT account numbers.
 */

import type { AccountType, AccountSubType } from '../types/database';

export interface AccountTypeSeed {
  code: AccountType;
  name: string;
  normal_balance: 'DEBIT' | 'CREDIT';
  closes_to_retained_earnings: boolean;
  display_order: number;
  sub_types: AccountSubTypeSeed[];
}

export interface AccountSubTypeSeed {
  code: AccountSubType;
  name: string;
  display_order: number;
  groups: AccountGroupSeed[];
}

export interface AccountGroupSeed {
  name: string;
  display_order: number;
  accounts: AccountSeed[];
}

export interface AccountSeed {
  number: string;
  name: string;
  display_order: number;
  is_control_account?: boolean;
  is_company_specific?: boolean;
  is_bank_account?: boolean;
  is_credit_card?: boolean;
  require_department?: boolean;
  require_class?: boolean;
}

export const ACCOUNT_TYPE_HIERARCHY: AccountTypeSeed[] = [
  {
    code: 'ASSET',
    name: 'Assets',
    normal_balance: 'DEBIT',
    closes_to_retained_earnings: false,
    display_order: 1,
    sub_types: [
      {
        code: 'CURRENT_ASSET',
        name: 'Current Assets',
        display_order: 1,
        groups: [
          {
            name: 'Cash & Cash Equivalents',
            display_order: 1,
            accounts: [
              { number: '1000', name: 'Operating Checking', display_order: 1, is_bank_account: true, is_company_specific: true },
              { number: '1010', name: 'Payroll Checking', display_order: 2, is_bank_account: true, is_company_specific: true },
              { number: '1020', name: 'Savings Account', display_order: 3, is_bank_account: true, is_company_specific: true },
              { number: '1050', name: 'Petty Cash', display_order: 4 },
              { number: '1090', name: 'Undeposited Funds', display_order: 5 },
            ],
          },
          {
            name: 'Accounts Receivable',
            display_order: 2,
            accounts: [
              { number: '1100', name: 'Accounts Receivable', display_order: 1, is_control_account: true },
              { number: '1110', name: 'Retainage Receivable', display_order: 2 },
              { number: '1150', name: 'Allowance for Doubtful Accounts', display_order: 3 },
              { number: '1160', name: 'Intercompany Receivable', display_order: 4 },
            ],
          },
          {
            name: 'Inventory',
            display_order: 3,
            accounts: [
              { number: '1200', name: 'Inventory - Raw Materials', display_order: 1 },
              { number: '1210', name: 'Inventory - Work in Progress', display_order: 2 },
              { number: '1220', name: 'Inventory - Finished Goods', display_order: 3 },
            ],
          },
          {
            name: 'Prepaid Expenses',
            display_order: 4,
            accounts: [
              { number: '1300', name: 'Prepaid Insurance', display_order: 1 },
              { number: '1310', name: 'Prepaid Rent', display_order: 2 },
              { number: '1320', name: 'Prepaid Software Licenses', display_order: 3 },
              { number: '1330', name: 'Prepaid Other', display_order: 4 },
              { number: '1350', name: 'Employee Advances', display_order: 5 },
            ],
          },
          {
            name: 'Other Current Assets',
            display_order: 5,
            accounts: [
              { number: '1400', name: 'Security Deposits', display_order: 1 },
              { number: '1410', name: 'Due from Officers', display_order: 2 },
            ],
          },
        ],
      },
      {
        code: 'FIXED_ASSET',
        name: 'Fixed Assets',
        display_order: 2,
        groups: [
          {
            name: 'Property & Equipment',
            display_order: 1,
            accounts: [
              { number: '1500', name: 'Vehicles', display_order: 1 },
              { number: '1510', name: 'Equipment', display_order: 2 },
              { number: '1520', name: 'Furniture & Fixtures', display_order: 3 },
              { number: '1530', name: 'Computers & Technology', display_order: 4 },
              { number: '1540', name: 'Leasehold Improvements', display_order: 5 },
              { number: '1550', name: 'Buildings', display_order: 6 },
              { number: '1560', name: 'Land', display_order: 7 },
            ],
          },
          {
            name: 'Accumulated Depreciation',
            display_order: 2,
            accounts: [
              { number: '1600', name: 'Accum Depr - Vehicles', display_order: 1 },
              { number: '1610', name: 'Accum Depr - Equipment', display_order: 2 },
              { number: '1620', name: 'Accum Depr - Furniture', display_order: 3 },
              { number: '1630', name: 'Accum Depr - Computers', display_order: 4 },
              { number: '1640', name: 'Accum Depr - Leasehold', display_order: 5 },
              { number: '1650', name: 'Accum Depr - Buildings', display_order: 6 },
            ],
          },
        ],
      },
      {
        code: 'OTHER_ASSET',
        name: 'Other Assets',
        display_order: 3,
        groups: [
          {
            name: 'Intangible Assets',
            display_order: 1,
            accounts: [
              { number: '1700', name: 'Goodwill', display_order: 1 },
              { number: '1710', name: 'Other Intangibles', display_order: 2 },
              { number: '1720', name: 'Accum Amortization', display_order: 3 },
            ],
          },
        ],
      },
    ],
  },
  {
    code: 'LIABILITY',
    name: 'Liabilities',
    normal_balance: 'CREDIT',
    closes_to_retained_earnings: false,
    display_order: 2,
    sub_types: [
      {
        code: 'CURRENT_LIABILITY',
        name: 'Current Liabilities',
        display_order: 1,
        groups: [
          {
            name: 'Accounts Payable',
            display_order: 1,
            accounts: [
              { number: '2000', name: 'Accounts Payable', display_order: 1, is_control_account: true },
              { number: '2010', name: 'Retainage Payable', display_order: 2 },
              { number: '2020', name: 'Intercompany Payable', display_order: 3 },
            ],
          },
          {
            name: 'Credit Cards',
            display_order: 2,
            accounts: [
              { number: '2100', name: 'Credit Card - Primary', display_order: 1, is_credit_card: true, is_company_specific: true },
              { number: '2110', name: 'Credit Card - Secondary', display_order: 2, is_credit_card: true, is_company_specific: true },
              { number: '2120', name: 'Fuel Cards', display_order: 3, is_credit_card: true, is_company_specific: true },
            ],
          },
          {
            name: 'Payroll Liabilities',
            display_order: 3,
            accounts: [
              { number: '2200', name: 'Federal Payroll Tax Payable', display_order: 1 },
              { number: '2210', name: 'State Payroll Tax Payable', display_order: 2 },
              { number: '2220', name: 'FICA Payable', display_order: 3 },
              { number: '2230', name: 'Health Insurance Payable', display_order: 4 },
              { number: '2240', name: '401(k) Payable', display_order: 5 },
              { number: '2250', name: 'Workers Comp Payable', display_order: 6 },
              { number: '2260', name: 'Accrued Wages', display_order: 7 },
            ],
          },
          {
            name: 'Sales Tax',
            display_order: 4,
            accounts: [
              { number: '2300', name: 'Sales Tax Payable', display_order: 1 },
            ],
          },
          {
            name: 'Other Current Liabilities',
            display_order: 5,
            accounts: [
              { number: '2400', name: 'Accrued Expenses', display_order: 1 },
              { number: '2410', name: 'Deferred Revenue', display_order: 2 },
              { number: '2420', name: 'Customer Deposits', display_order: 3 },
              { number: '2430', name: 'Current Portion of LT Debt', display_order: 4 },
              { number: '2440', name: 'Line of Credit', display_order: 5, is_company_specific: true },
            ],
          },
        ],
      },
      {
        code: 'LONG_TERM_LIABILITY',
        name: 'Long-Term Liabilities',
        display_order: 2,
        groups: [
          {
            name: 'Long-Term Debt',
            display_order: 1,
            accounts: [
              { number: '2500', name: 'Term Loan', display_order: 1, is_company_specific: true },
              { number: '2510', name: 'SBA Loan', display_order: 2, is_company_specific: true },
              { number: '2520', name: 'Equipment Loan', display_order: 3, is_company_specific: true },
              { number: '2530', name: 'Mortgage', display_order: 4, is_company_specific: true },
              { number: '2540', name: 'Intercompany Loan Payable', display_order: 5 },
            ],
          },
        ],
      },
    ],
  },
  {
    code: 'EQUITY',
    name: 'Equity',
    normal_balance: 'CREDIT',
    closes_to_retained_earnings: false,
    display_order: 3,
    sub_types: [
      {
        code: 'EQUITY',
        name: 'Equity',
        display_order: 1,
        groups: [
          {
            name: "Owner's Equity",
            display_order: 1,
            accounts: [
              { number: '3000', name: "Owner's Capital", display_order: 1 },
              { number: '3010', name: "Owner's Draw", display_order: 2 },
              { number: '3020', name: 'Retained Earnings', display_order: 3 },
              { number: '3030', name: 'Current Year Earnings', display_order: 4 },
              { number: '3040', name: 'Additional Paid-In Capital', display_order: 5 },
            ],
          },
        ],
      },
    ],
  },
  {
    code: 'REVENUE',
    name: 'Revenue',
    normal_balance: 'CREDIT',
    closes_to_retained_earnings: true,
    display_order: 4,
    sub_types: [
      {
        code: 'REVENUE',
        name: 'Revenue',
        display_order: 1,
        groups: [
          {
            name: 'Service Revenue',
            display_order: 1,
            accounts: [
              { number: '4000', name: 'Service Revenue', display_order: 1 },
              { number: '4010', name: 'Construction Revenue', display_order: 2 },
              { number: '4020', name: 'HVAC Revenue', display_order: 3 },
              { number: '4030', name: 'Cabinetry Revenue', display_order: 4 },
              { number: '4040', name: 'Maintenance Revenue', display_order: 5 },
            ],
          },
          {
            name: 'Product Revenue',
            display_order: 2,
            accounts: [
              { number: '4100', name: 'Equipment Sales', display_order: 1 },
              { number: '4110', name: 'Material Sales', display_order: 2 },
              { number: '4120', name: 'Parts Sales', display_order: 3 },
            ],
          },
          {
            name: 'Chargeback Revenue',
            display_order: 3,
            accounts: [
              { number: '4200', name: 'Management Fee Revenue', display_order: 1 },
              { number: '4210', name: 'Shared Services Revenue', display_order: 2 },
            ],
          },
          {
            name: 'Other Revenue',
            display_order: 4,
            accounts: [
              { number: '4300', name: 'Rental Income', display_order: 1 },
              { number: '4310', name: 'Rebates & Discounts Earned', display_order: 2 },
            ],
          },
        ],
      },
    ],
  },
  {
    code: 'COGS',
    name: 'Cost of Goods Sold',
    normal_balance: 'DEBIT',
    closes_to_retained_earnings: true,
    display_order: 5,
    sub_types: [
      {
        code: 'COST_OF_GOODS_SOLD',
        name: 'Cost of Goods Sold',
        display_order: 1,
        groups: [
          {
            name: 'Direct Labor',
            display_order: 1,
            accounts: [
              { number: '5000', name: 'Direct Labor', display_order: 1, require_department: true },
              { number: '5010', name: 'Subcontractor Labor', display_order: 2 },
              { number: '5020', name: 'Contract Labor', display_order: 3 },
            ],
          },
          {
            name: 'Materials',
            display_order: 2,
            accounts: [
              { number: '5100', name: 'Materials', display_order: 1 },
              { number: '5110', name: 'Equipment Costs', display_order: 2 },
              { number: '5120', name: 'Supplies', display_order: 3 },
              { number: '5130', name: 'Freight & Delivery', display_order: 4 },
            ],
          },
          {
            name: 'Other COGS',
            display_order: 3,
            accounts: [
              { number: '5200', name: 'Permits & Licenses', display_order: 1 },
              { number: '5210', name: 'Job-Specific Insurance', display_order: 2 },
              { number: '5220', name: 'Warranty Costs', display_order: 3 },
              { number: '5230', name: 'COGS Clearing', display_order: 4 },
              { number: '5240', name: 'WIP - Work in Progress', display_order: 5 },
            ],
          },
        ],
      },
    ],
  },
  {
    code: 'OPEX',
    name: 'Operating Expenses',
    normal_balance: 'DEBIT',
    closes_to_retained_earnings: true,
    display_order: 6,
    sub_types: [
      {
        code: 'OPERATING_EXPENSE',
        name: 'Operating Expenses',
        display_order: 1,
        groups: [
          {
            name: 'Payroll & Benefits',
            display_order: 1,
            accounts: [
              { number: '6000', name: 'Salaries & Wages', display_order: 1 },
              { number: '6010', name: 'Payroll Taxes', display_order: 2 },
              { number: '6020', name: 'Health Insurance', display_order: 3 },
              { number: '6030', name: '401(k) Match', display_order: 4 },
              { number: '6040', name: 'Workers Compensation', display_order: 5 },
              { number: '6050', name: 'Bonuses', display_order: 6 },
              { number: '6060', name: 'PTO & Vacation', display_order: 7 },
            ],
          },
          {
            name: 'Occupancy',
            display_order: 2,
            accounts: [
              { number: '6100', name: 'Rent', display_order: 1 },
              { number: '6110', name: 'Utilities', display_order: 2 },
              { number: '6120', name: 'Property Tax', display_order: 3 },
              { number: '6130', name: 'Building Maintenance', display_order: 4 },
              { number: '6140', name: 'Janitorial', display_order: 5 },
            ],
          },
          {
            name: 'Vehicle Expenses',
            display_order: 3,
            accounts: [
              { number: '6200', name: 'Fuel', display_order: 1 },
              { number: '6210', name: 'Vehicle Maintenance', display_order: 2 },
              { number: '6220', name: 'Vehicle Insurance', display_order: 3 },
              { number: '6230', name: 'Vehicle Lease', display_order: 4 },
              { number: '6240', name: 'Tolls & Parking', display_order: 5 },
            ],
          },
          {
            name: 'Technology',
            display_order: 4,
            accounts: [
              { number: '6300', name: 'Software Subscriptions', display_order: 1 },
              { number: '6310', name: 'IT Services', display_order: 2 },
              { number: '6320', name: 'Phone & Internet', display_order: 3 },
              { number: '6330', name: 'Computer Equipment (< Cap Threshold)', display_order: 4 },
            ],
          },
          {
            name: 'Professional Services',
            display_order: 5,
            accounts: [
              { number: '6400', name: 'Legal Fees', display_order: 1 },
              { number: '6410', name: 'Accounting Fees', display_order: 2 },
              { number: '6420', name: 'Consulting', display_order: 3 },
            ],
          },
          {
            name: 'Marketing & Sales',
            display_order: 6,
            accounts: [
              { number: '6500', name: 'Advertising', display_order: 1 },
              { number: '6510', name: 'Marketing', display_order: 2 },
              { number: '6520', name: 'Meals & Entertainment', display_order: 3 },
              { number: '6530', name: 'Travel', display_order: 4 },
            ],
          },
          {
            name: 'Office & Administrative',
            display_order: 7,
            accounts: [
              { number: '6600', name: 'Office Supplies', display_order: 1 },
              { number: '6610', name: 'Postage & Shipping', display_order: 2 },
              { number: '6620', name: 'Printing', display_order: 3 },
              { number: '6630', name: 'Bank Fees', display_order: 4 },
              { number: '6640', name: 'Dues & Subscriptions', display_order: 5 },
              { number: '6650', name: 'Training & Education', display_order: 6 },
              { number: '6660', name: 'Miscellaneous', display_order: 7 },
            ],
          },
          {
            name: 'Insurance',
            display_order: 8,
            accounts: [
              { number: '6700', name: 'General Liability Insurance', display_order: 1 },
              { number: '6710', name: 'Professional Liability Insurance', display_order: 2 },
              { number: '6720', name: 'Property Insurance', display_order: 3 },
              { number: '6730', name: 'Umbrella Insurance', display_order: 4 },
            ],
          },
          {
            name: 'Depreciation & Amortization',
            display_order: 9,
            accounts: [
              { number: '6800', name: 'Depreciation Expense', display_order: 1 },
              { number: '6810', name: 'Amortization Expense', display_order: 2 },
            ],
          },
        ],
      },
    ],
  },
  {
    code: 'OTHER',
    name: 'Other Income & Expense',
    normal_balance: 'DEBIT',
    closes_to_retained_earnings: true,
    display_order: 7,
    sub_types: [
      {
        code: 'OTHER_INCOME',
        name: 'Other Income',
        display_order: 1,
        groups: [
          {
            name: 'Other Income',
            display_order: 1,
            accounts: [
              { number: '7000', name: 'Interest Income', display_order: 1 },
              { number: '7010', name: 'Gain on Sale of Assets', display_order: 2 },
              { number: '7020', name: 'Other Income', display_order: 3 },
            ],
          },
        ],
      },
      {
        code: 'OTHER_EXPENSE',
        name: 'Other Expense',
        display_order: 2,
        groups: [
          {
            name: 'Other Expense',
            display_order: 1,
            accounts: [
              { number: '8000', name: 'Interest Expense', display_order: 1 },
              { number: '8010', name: 'Loss on Sale of Assets', display_order: 2 },
              { number: '8020', name: 'Penalties & Fines', display_order: 3 },
              { number: '8030', name: 'Other Expense', display_order: 4 },
            ],
          },
        ],
      },
    ],
  },
];

// Computed stats
export const COA_STATS = {
  accountTypes: 7,
  subTypes: 11,
  groups: ACCOUNT_TYPE_HIERARCHY.reduce((sum, t) =>
    sum + t.sub_types.reduce((s, st) => s + st.groups.length, 0), 0),
  accounts: ACCOUNT_TYPE_HIERARCHY.reduce((sum, t) =>
    sum + t.sub_types.reduce((s, st) =>
      s + st.groups.reduce((g, gr) => g + gr.accounts.length, 0), 0), 0),
} as const;
