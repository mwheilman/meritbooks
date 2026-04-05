'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { Download, Calendar, Building2 } from 'lucide-react';
import { IncomeStatement } from './income-statement';
import { BalanceSheet } from './balance-sheet';
import { TrialBalance } from './trial-balance';

const REPORT_TABS = [
  { key: 'pnl', label: 'Income Statement' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'tb', label: 'Trial Balance' },
  { key: 'cf', label: 'Cash Flow' },
  { key: 'gl', label: 'GL Detail' },
  { key: 'consolidated', label: 'Consolidated' },
] as const;

type ReportType = typeof REPORT_TABS[number]['key'];

const DEMO_PERIODS = [
  { value: '2026-03', label: 'March 2026' },
  { value: '2026-02', label: 'February 2026' },
  { value: '2026-01', label: 'January 2026' },
  { value: '2025-12', label: 'December 2025' },
];

export function ReportViewer() {
  const [activeReport, setActiveReport] = useState<ReportType>('pnl');
  const [period, setPeriod] = useState('2026-03');
  const [company, setCompany] = useState('all');

  return (
    <div>
      {/* Report tabs */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800 w-fit mb-4">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveReport(tab.key)}
            className={clsx(
              'px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap',
              activeReport === tab.key
                ? 'bg-slate-800 text-white font-medium'
                : 'text-slate-400 hover:text-slate-300'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-500" />
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="input w-48"
          >
            {DEMO_PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Building2 size={14} className="text-slate-500" />
          <select
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="input w-56"
          >
            <option value="all">All Companies (Consolidated)</option>
            <option value="mmg">Merit Management Group</option>
            <option value="scc">Swan Creek Construction</option>
            <option value="icc">Iowa Custom Cabinetry</option>
            <option value="hh">Heartland HVAC</option>
            <option value="dm">Dorrian Mechanical</option>
          </select>
        </div>

        <div className="ml-auto">
          <button className="btn-secondary btn-sm">
            <Download size={14} />
            Export PDF
          </button>
        </div>
      </div>

      {/* Report content */}
      {activeReport === 'pnl' && <IncomeStatement period={period} />}
      {activeReport === 'bs' && <BalanceSheet period={period} />}
      {activeReport === 'tb' && <TrialBalance period={period} />}
      {(activeReport === 'cf' || activeReport === 'gl' || activeReport === 'consolidated') && (
        <div className="card p-12 text-center">
          <p className="text-sm text-slate-500">
            {activeReport === 'cf' ? 'Cash Flow Statement' : activeReport === 'gl' ? 'GL Detail Report' : 'Consolidated Statements'} — under development
          </p>
        </div>
      )}
    </div>
  );
}
