'use client';

import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';

interface TBLine {
  accountNumber: string;
  accountName: string;
  accountType: string;
  debitCents: number;
  creditCents: number;
  netBalance: number;
}

const DEMO_TB: TBLine[] = [
  { accountNumber: '1000', accountName: 'Operating Checking', accountType: 'ASSET', debitCents: 23480000, creditCents: 0, netBalance: 23480000 },
  { accountNumber: '1010', accountName: 'Payroll Checking', accountType: 'ASSET', debitCents: 4200000, creditCents: 0, netBalance: 4200000 },
  { accountNumber: '1020', accountName: 'Savings Account', accountType: 'ASSET', debitCents: 8500000, creditCents: 0, netBalance: 8500000 },
  { accountNumber: '1100', accountName: 'Accounts Receivable', accountType: 'ASSET', debitCents: 31200000, creditCents: 0, netBalance: 31200000 },
  { accountNumber: '1300', accountName: 'Prepaid Insurance', accountType: 'ASSET', debitCents: 3700000, creditCents: 0, netBalance: 3700000 },
  { accountNumber: '1500', accountName: 'Vehicles', accountType: 'ASSET', debitCents: 12400000, creditCents: 0, netBalance: 12400000 },
  { accountNumber: '1600', accountName: 'Accum Depr - Vehicles', accountType: 'ASSET', debitCents: 0, creditCents: 4800000, netBalance: -4800000 },
  { accountNumber: '2000', accountName: 'Accounts Payable', accountType: 'LIABILITY', debitCents: 0, creditCents: 18740000, netBalance: 18740000 },
  { accountNumber: '2100', accountName: 'Credit Cards', accountType: 'LIABILITY', debitCents: 0, creditCents: 4200000, netBalance: 4200000 },
  { accountNumber: '2500', accountName: 'Term Loans', accountType: 'LIABILITY', debitCents: 0, creditCents: 18200000, netBalance: 18200000 },
  { accountNumber: '3000', accountName: "Owner's Capital", accountType: 'EQUITY', debitCents: 0, creditCents: 15000000, netBalance: 15000000 },
  { accountNumber: '3020', accountName: 'Retained Earnings', accountType: 'EQUITY', debitCents: 0, creditCents: 8265000, netBalance: 8265000 },
  { accountNumber: '4000', accountName: 'Service Revenue', accountType: 'REVENUE', debitCents: 0, creditCents: 48500000, netBalance: 48500000 },
  { accountNumber: '4010', accountName: 'Construction Revenue', accountType: 'REVENUE', debitCents: 0, creditCents: 32100000, netBalance: 32100000 },
  { accountNumber: '5000', accountName: 'Direct Labor', accountType: 'COGS', debitCents: 38200000, creditCents: 0, netBalance: 38200000 },
  { accountNumber: '5100', accountName: 'Materials', accountType: 'COGS', debitCents: 22400000, creditCents: 0, netBalance: 22400000 },
  { accountNumber: '6000', accountName: 'Salaries & Wages', accountType: 'OPEX', debitCents: 18400000, creditCents: 0, netBalance: 18400000 },
  { accountNumber: '6100', accountName: 'Rent', accountType: 'OPEX', debitCents: 4200000, creditCents: 0, netBalance: 4200000 },
  { accountNumber: '6700', accountName: 'GL Insurance', accountType: 'OPEX', debitCents: 3700000, creditCents: 0, netBalance: 3700000 },
  { accountNumber: '8000', accountName: 'Interest Expense', accountType: 'OTHER', debitCents: 840000, creditCents: 0, netBalance: 840000 },
];

interface TrialBalanceProps {
  period: string;
}

export function TrialBalance({ period }: TrialBalanceProps) {
  const totalDebits = DEMO_TB.reduce((s, l) => s + l.debitCents, 0);
  const totalCredits = DEMO_TB.reduce((s, l) => s + l.creditCents, 0);
  const isBalanced = totalDebits === totalCredits;

  return (
    <div className="card">
      <div className="px-6 py-4 border-b border-slate-800 text-center">
        <p className="text-xs text-slate-500 uppercase tracking-wider">Merit Management Group — All Companies</p>
        <h2 className="text-lg font-semibold text-white mt-1">Trial Balance</h2>
        <p className="text-sm text-slate-400">As of {formatPeriod(period)}</p>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="px-6 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-20">Acct #</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Account Name</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-20">Type</th>
            <th className="px-6 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500 w-36">Debit</th>
            <th className="px-6 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500 w-36">Credit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/20">
          {DEMO_TB.map((line) => (
            <tr key={line.accountNumber} className="table-row-hover">
              <td className="px-6 py-2.5 text-sm font-mono text-brand-400">{line.accountNumber}</td>
              <td className="px-4 py-2.5 text-sm text-slate-300">{line.accountName}</td>
              <td className="px-4 py-2.5">
                <span className="text-2xs text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded font-mono">
                  {line.accountType}
                </span>
              </td>
              <td className="px-6 py-2.5 text-right text-sm font-mono tabular-nums text-slate-300">
                {line.debitCents > 0 ? formatMoney(line.debitCents) : ''}
              </td>
              <td className="px-6 py-2.5 text-right text-sm font-mono tabular-nums text-slate-300">
                {line.creditCents > 0 ? formatMoney(line.creditCents) : ''}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-700 bg-slate-800/20">
            <td colSpan={3} className="px-6 py-3 text-sm font-bold text-white">Totals</td>
            <td className="px-6 py-3 text-right text-sm font-mono tabular-nums font-bold text-white">
              {formatMoney(totalDebits)}
            </td>
            <td className="px-6 py-3 text-right text-sm font-mono tabular-nums font-bold text-white">
              {formatMoney(totalCredits)}
            </td>
          </tr>
          <tr>
            <td colSpan={5} className="px-6 py-2 text-center">
              <span className={clsx(
                'text-xs font-medium',
                isBalanced ? 'text-emerald-400' : 'text-red-400'
              )}>
                {isBalanced ? '✓ Trial balance is in balance' : `✗ Out of balance by ${formatMoney(Math.abs(totalDebits - totalCredits))}`}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  return new Date(Number(year), Number(month) - 1, lastDay).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
