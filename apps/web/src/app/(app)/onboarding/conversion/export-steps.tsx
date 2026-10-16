'use client';

import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { clsx } from 'clsx';
import { formatLongDate, isIsoDate } from '@/lib/onboarding/conversion';

/**
 * "Export your trial balance in about a minute" — the exact report names per system
 * (FPB B2: the guided-export path, never a dead "not connected"). Shared by the
 * conversion upload screen and the wizard's QuickBooks / Xero / Sage tiles so the
 * steps can never drift between the two.
 */

export type ExportSystem = 'quickbooks' | 'xero' | 'sage';

const SYSTEMS: { id: ExportSystem; label: string }[] = [
  { id: 'quickbooks', label: 'QuickBooks Online' },
  { id: 'xero', label: 'Xero' },
  { id: 'sage', label: 'Sage' },
];

function stepsFor(system: ExportSystem, dateLabel: string): string[] {
  switch (system) {
    case 'quickbooks':
      return [
        'Go to Reports and open “Trial Balance” (search for it if you don’t see it).',
        `Set the report date to ${dateLabel} and click Run report.`,
        'Click the export icon → Export to Excel, then drop that file here.',
      ];
    case 'xero':
      return [
        'Go to Accounting → Reports and open “Trial Balance”.',
        `Set the date to ${dateLabel} and click Update.`,
        'Click Export → Excel, then drop that file here.',
      ];
    case 'sage':
      return [
        'Go to Reporting and open “Trial Balance”.',
        `Set the date to ${dateLabel} and run the report.`,
        'Export it to Excel or CSV, then drop that file here.',
      ];
  }
}

export interface TrialBalanceExportStepsProps {
  /** Opening-balance (cutover) date shown inside the steps. */
  asOfDate: string | null;
  /** Which system's steps to show first. Default QuickBooks Online. */
  initialSystem?: ExportSystem;
  /** Show the system switcher (default true). */
  showSwitcher?: boolean;
  title?: string;
}

export function TrialBalanceExportSteps({
  asOfDate, initialSystem = 'quickbooks', showSwitcher = true, title,
}: TrialBalanceExportStepsProps) {
  const [system, setSystem] = useState<ExportSystem>(initialSystem);
  const id = useId();
  const dateLabel = isIsoDate(asOfDate) ? formatLongDate(asOfDate) : 'your opening-balance date';
  const label = SYSTEMS.find((s) => s.id === system)?.label ?? 'your system';

  return (
    <div className="rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-3 text-xs text-slate-400" role="region" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
        <Info size={13} className="text-blue-400" aria-hidden />
        {title ?? `Getting the file from ${label} (about a minute)`}
      </p>
      {showSwitcher && (
        <div className="flex flex-wrap gap-1.5 mb-2" role="tablist" aria-label="Which system are you exporting from?">
          {SYSTEMS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={system === s.id}
              aria-controls={`${id}-steps`}
              onClick={() => setSystem(s.id)}
              className={clsx(
                'rounded-md border px-2 py-0.5 text-2xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                system === s.id ? 'border-brand-500/50 bg-brand-500/10 text-brand-300' : 'border-slate-700 text-slate-400 hover:text-slate-200',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <ol id={`${id}-steps`} role={showSwitcher ? 'tabpanel' : undefined} className="list-decimal pl-5 space-y-0.5">
        {stepsFor(system, dateLabel).map((s) => <li key={s}>{s}</li>)}
      </ol>
      <p className="mt-1.5 text-slate-500">
        A trial balance is simply a list of every account and its balance on one date. Not the General Ledger — that&apos;s
        every transaction, and can&apos;t set opening balances on its own.
      </p>
    </div>
  );
}
