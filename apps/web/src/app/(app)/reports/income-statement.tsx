'use client';

import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';

interface StatementLine {
  label: string;
  amount: number; // cents
  indent?: number;
  isBold?: boolean;
  isSubtotal?: boolean;
  isTotal?: boolean;
  accountNumber?: string;
}

// Demo P&L data — will be computed from v_income_statement view
const DEMO_PNL: StatementLine[] = [
  // Revenue
  { label: 'Revenue', amount: 0, isBold: true, indent: 0 },
  { label: 'Service Revenue', accountNumber: '4000', amount: 48500000, indent: 2 },
  { label: 'Construction Revenue', accountNumber: '4010', amount: 32100000, indent: 2 },
  { label: 'HVAC Revenue', accountNumber: '4020', amount: 28700000, indent: 2 },
  { label: 'Cabinetry Revenue', accountNumber: '4030', amount: 18400000, indent: 2 },
  { label: 'Equipment Sales', accountNumber: '4100', amount: 5200000, indent: 2 },
  { label: 'Management Fee Revenue', accountNumber: '4200', amount: 12800000, indent: 2 },
  { label: 'Total Revenue', amount: 145700000, isSubtotal: true },

  // COGS
  { label: 'Cost of Goods Sold', amount: 0, isBold: true, indent: 0 },
  { label: 'Direct Labor', accountNumber: '5000', amount: 38200000, indent: 2 },
  { label: 'Subcontractor Labor', accountNumber: '5010', amount: 14600000, indent: 2 },
  { label: 'Materials', accountNumber: '5100', amount: 22400000, indent: 2 },
  { label: 'Equipment Costs', accountNumber: '5110', amount: 4800000, indent: 2 },
  { label: 'Supplies', accountNumber: '5120', amount: 3200000, indent: 2 },
  { label: 'Permits & Licenses', accountNumber: '5200', amount: 1400000, indent: 2 },
  { label: 'Total Cost of Goods Sold', amount: 84600000, isSubtotal: true },

  // Gross Profit
  { label: 'Gross Profit', amount: 61100000, isTotal: true },

  // OpEx
  { label: 'Operating Expenses', amount: 0, isBold: true, indent: 0 },
  { label: 'Salaries & Wages', accountNumber: '6000', amount: 18400000, indent: 2 },
  { label: 'Payroll Taxes', accountNumber: '6010', amount: 1840000, indent: 2 },
  { label: 'Health Insurance', accountNumber: '6020', amount: 2100000, indent: 2 },
  { label: 'Rent', accountNumber: '6100', amount: 4200000, indent: 2 },
  { label: 'Utilities', accountNumber: '6110', amount: 1800000, indent: 2 },
  { label: 'Fuel', accountNumber: '6200', amount: 3400000, indent: 2 },
  { label: 'Vehicle Maintenance', accountNumber: '6210', amount: 1200000, indent: 2 },
  { label: 'Software Subscriptions', accountNumber: '6300', amount: 2400000, indent: 2 },
  { label: 'General Liability Insurance', accountNumber: '6700', amount: 3700000, indent: 2 },
  { label: 'Depreciation Expense', accountNumber: '6800', amount: 1245000, indent: 2 },
  { label: 'Other Operating Expenses', amount: 4800000, indent: 2 },
  { label: 'Total Operating Expenses', amount: 45085000, isSubtotal: true },

  // EBITDA
  { label: 'EBITDA', amount: 16015000, isTotal: true },

  // Other
  { label: 'Other Income / (Expense)', amount: 0, isBold: true, indent: 0 },
  { label: 'Interest Income', accountNumber: '7000', amount: 120000, indent: 2 },
  { label: 'Interest Expense', accountNumber: '8000', amount: -840000, indent: 2 },
  { label: 'Total Other', amount: -720000, isSubtotal: true },

  // Net Income
  { label: 'Net Income', amount: 15295000, isTotal: true },
];

interface IncomeStatementProps {
  period: string;
}

export function IncomeStatement({ period }: IncomeStatementProps) {
  return (
    <div className="card">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 text-center">
        <p className="text-xs text-slate-500 uppercase tracking-wider">Merit Management Group — All Companies</p>
        <h2 className="text-lg font-semibold text-white mt-1">Income Statement</h2>
        <p className="text-sm text-slate-400">For the period ending {formatPeriod(period)}</p>
      </div>

      {/* Column headers */}
      <div className="flex items-center px-6 py-2 border-b border-slate-800/50">
        <span className="flex-1 text-2xs font-semibold uppercase tracking-wider text-slate-500">Account</span>
        <span className="w-32 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Current Period</span>
      </div>

      {/* Lines */}
      <div className="divide-y divide-slate-800/20">
        {DEMO_PNL.map((line, i) => (
          <div
            key={i}
            className={clsx(
              'flex items-center px-6 py-2',
              line.isTotal && 'bg-slate-800/20 border-t border-slate-700',
              line.isSubtotal && 'border-t border-slate-800/50',
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
                  line.isSubtotal && 'font-medium text-slate-300 border-t border-slate-700 pt-1',
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

      {/* Footer */}
      <div className="px-6 py-3 border-t border-slate-800 flex items-center justify-between">
        <span className="text-2xs text-slate-600">Generated from gl_entry_lines · {DEMO_PNL.length} line items</span>
        <span className="text-2xs text-slate-600">Unaudited</span>
      </div>
    </div>
  );
}

function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  const date = new Date(Number(year), Number(month) - 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
