'use client';

import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';

interface BSLine {
  label: string;
  amount: number;
  indent?: number;
  isBold?: boolean;
  isSubtotal?: boolean;
  isTotal?: boolean;
  accountNumber?: string;
}

const DEMO_BS: BSLine[] = [
  // Assets
  { label: 'ASSETS', amount: 0, isBold: true },

  { label: 'Current Assets', amount: 0, isBold: true, indent: 1 },
  { label: 'Operating Checking', accountNumber: '1000', amount: 23480000, indent: 2 },
  { label: 'Payroll Checking', accountNumber: '1010', amount: 4200000, indent: 2 },
  { label: 'Savings Account', accountNumber: '1020', amount: 8500000, indent: 2 },
  { label: 'Accounts Receivable', accountNumber: '1100', amount: 31200000, indent: 2 },
  { label: 'Retainage Receivable', accountNumber: '1110', amount: 4800000, indent: 2 },
  { label: 'Inventory - Raw Materials', accountNumber: '1200', amount: 6400000, indent: 2 },
  { label: 'Prepaid Insurance', accountNumber: '1300', amount: 3700000, indent: 2 },
  { label: 'Prepaid Software', accountNumber: '1320', amount: 1200000, indent: 2 },
  { label: 'Total Current Assets', amount: 83480000, isSubtotal: true, indent: 1 },

  { label: 'Fixed Assets', amount: 0, isBold: true, indent: 1 },
  { label: 'Vehicles', accountNumber: '1500', amount: 12400000, indent: 2 },
  { label: 'Equipment', accountNumber: '1510', amount: 8200000, indent: 2 },
  { label: 'Computers & Technology', accountNumber: '1530', amount: 3400000, indent: 2 },
  { label: 'Accum Depr - Vehicles', accountNumber: '1600', amount: -4800000, indent: 2 },
  { label: 'Accum Depr - Equipment', accountNumber: '1610', amount: -3200000, indent: 2 },
  { label: 'Accum Depr - Computers', accountNumber: '1630', amount: -1800000, indent: 2 },
  { label: 'Total Fixed Assets', amount: 14200000, isSubtotal: true, indent: 1 },

  { label: 'TOTAL ASSETS', amount: 97680000, isTotal: true },

  // Liabilities
  { label: 'LIABILITIES', amount: 0, isBold: true },

  { label: 'Current Liabilities', amount: 0, isBold: true, indent: 1 },
  { label: 'Accounts Payable', accountNumber: '2000', amount: 18740000, indent: 2 },
  { label: 'Credit Cards', accountNumber: '2100', amount: 4200000, indent: 2 },
  { label: 'Federal Payroll Tax', accountNumber: '2200', amount: 1200000, indent: 2 },
  { label: 'State Payroll Tax', accountNumber: '2210', amount: 480000, indent: 2 },
  { label: 'Accrued Expenses', accountNumber: '2400', amount: 3200000, indent: 2 },
  { label: 'Customer Deposits', accountNumber: '2420', amount: 8500000, indent: 2 },
  { label: 'Current Portion LT Debt', accountNumber: '2430', amount: 2400000, indent: 2 },
  { label: 'Total Current Liabilities', amount: 38720000, isSubtotal: true, indent: 1 },

  { label: 'Long-Term Liabilities', amount: 0, isBold: true, indent: 1 },
  { label: 'Term Loans', accountNumber: '2500', amount: 18200000, indent: 2 },
  { label: 'Equipment Loans', accountNumber: '2520', amount: 6400000, indent: 2 },
  { label: 'Total Long-Term Liabilities', amount: 24600000, isSubtotal: true, indent: 1 },

  { label: 'TOTAL LIABILITIES', amount: 63320000, isTotal: true },

  // Equity
  { label: 'EQUITY', amount: 0, isBold: true },
  { label: "Owner's Capital", accountNumber: '3000', amount: 15000000, indent: 1 },
  { label: "Owner's Draw", accountNumber: '3010', amount: -4200000, indent: 1 },
  { label: 'Retained Earnings', accountNumber: '3020', amount: 8265000, indent: 1 },
  { label: 'Current Year Earnings', accountNumber: '3030', amount: 15295000, indent: 1 },
  { label: 'TOTAL EQUITY', amount: 34360000, isTotal: true },

  { label: 'TOTAL LIABILITIES & EQUITY', amount: 97680000, isTotal: true },
];

interface BalanceSheetProps {
  period: string;
}

export function BalanceSheet({ period }: BalanceSheetProps) {
  const [year, month] = period.split('-');
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  const asOfDate = `${period}-${lastDay}`;

  return (
    <div className="card">
      <div className="px-6 py-4 border-b border-slate-800 text-center">
        <p className="text-xs text-slate-500 uppercase tracking-wider">Merit Management Group — All Companies</p>
        <h2 className="text-lg font-semibold text-white mt-1">Balance Sheet</h2>
        <p className="text-sm text-slate-400">As of {new Date(asOfDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
      </div>

      <div className="flex items-center px-6 py-2 border-b border-slate-800/50">
        <span className="flex-1 text-2xs font-semibold uppercase tracking-wider text-slate-500">Account</span>
        <span className="w-32 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance</span>
      </div>

      <div className="divide-y divide-slate-800/20">
        {DEMO_BS.map((line, i) => (
          <div
            key={i}
            className={clsx(
              'flex items-center px-6 py-2',
              line.isTotal && 'bg-slate-800/20 border-t border-slate-700',
            )}
          >
            <span
              className={clsx(
                'flex-1 text-sm',
                line.isBold && 'font-semibold text-white',
                line.isTotal && 'font-bold text-white',
                line.isSubtotal && 'font-medium text-slate-300',
                !line.isBold && !line.isTotal && !line.isSubtotal && 'text-slate-400',
              )}
              style={{ paddingLeft: `${(line.indent ?? 0) * 16}px` }}
            >
              {line.accountNumber && (
                <span className="text-2xs text-slate-600 font-mono mr-2">{line.accountNumber}</span>
              )}
              {line.label}
            </span>
            {(line.amount !== 0 || line.isSubtotal || line.isTotal) && (
              <span
                className={clsx(
                  'w-32 text-right font-mono tabular-nums text-sm',
                  line.isTotal && 'font-bold text-white',
                  line.isSubtotal && 'font-medium text-slate-300',
                  line.amount < 0 && 'text-red-400',
                  !line.isTotal && !line.isSubtotal && line.amount > 0 && 'text-slate-300',
                )}
              >
                {formatMoney(line.amount)}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="px-6 py-3 border-t border-slate-800 flex items-center justify-between">
        <span className="text-2xs text-slate-600">Generated from v_balance_sheet</span>
        <span className="text-2xs text-slate-600">Unaudited</span>
      </div>
    </div>
  );
}
