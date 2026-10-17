'use client';

/**
 * Connected-system fallback + sample-data labelling for the A/R and A/P review
 * sections (FPB-onboarding B3, principle 7 "Never fake it").
 *
 * When the "Connected system" tile can't do a REAL pull (no live connection yet), we
 * never silently load demo data. Instead the user gets the exact export steps for
 * their system, then the CSV drop zones right below. Sample data is only offered
 * where `sampleImportsEnabledClient()` allows it, and is always labelled loudly.
 */

import { useId, useState } from 'react';
import { FileDown, FlaskConical, Info } from 'lucide-react';
import { clsx } from 'clsx';

export type SubledgerKind = 'ar' | 'ap';
type SystemId = 'quickbooks' | 'xero' | 'sage';

const SYSTEMS: { id: SystemId; label: string }[] = [
  { id: 'quickbooks', label: 'QuickBooks Online' },
  { id: 'xero', label: 'Xero' },
  { id: 'sage', label: 'Sage' },
];

/** Exact report names per system — "Export in 60 seconds" (FPB B2/B3). */
const STEPS: Record<SubledgerKind, Record<SystemId, string[]>> = {
  ar: {
    quickbooks: [
      'Reports → search “Open Invoices” → set the date to your cutover date → Run report.',
      'Export (top-right) → Export to Excel, then save it as CSV.',
      'Optional: Sales → Customers → Export (customer list) for contact details.',
    ],
    xero: [
      'Accounting → Reports → “Aged Receivables Detail” → set the date to your cutover date → Update.',
      'Export → Excel, then save it as CSV.',
      'Optional: Contacts → Customers → Export for contact details.',
    ],
    sage: [
      'Reports → Customers → “Aged Debtors” (detailed) → set the date to your cutover date.',
      'Export → CSV.',
      'Optional: Contacts → Customers → Export for contact details.',
    ],
  },
  ap: {
    quickbooks: [
      'Reports → search “Unpaid Bills” → set the date to your cutover date → Run report.',
      'Export (top-right) → Export to Excel, then save it as CSV.',
      'Optional: Expenses → Vendors → Export (vendor list) for contact details.',
    ],
    xero: [
      'Accounting → Reports → “Aged Payables Detail” → set the date to your cutover date → Update.',
      'Export → Excel, then save it as CSV.',
      'Optional: Contacts → Suppliers → Export for contact details.',
    ],
    sage: [
      'Reports → Suppliers → “Aged Creditors” (detailed) → set the date to your cutover date.',
      'Export → CSV.',
      'Optional: Contacts → Suppliers → Export for contact details.',
    ],
  },
};

export function ConnectedSystemFallback({ kind }: { kind: SubledgerKind }) {
  const [system, setSystem] = useState<SystemId>('quickbooks');
  const groupId = useId();
  const noun = kind === 'ar' ? 'open invoices (what customers owe you)' : 'unpaid bills (what you owe vendors)';

  return (
    <div className="rounded-2xl border border-slate-800 bg-surface-900 p-4 space-y-3" role="region" aria-labelledby={`${groupId}-title`}>
      <div className="flex items-start gap-2">
        <FileDown size={16} className="mt-0.5 shrink-0 text-brand-400" aria-hidden />
        <div>
          <p id={`${groupId}-title`} className="text-sm font-semibold text-ink-hi">Export from your system in about a minute</p>
          <p className="mt-0.5 text-xs text-slate-400">
            Your accounting system isn’t connected to MeritBooks yet, so we can’t pull these for you. Export your{' '}
            {noun}, then drop the file below.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Which system are you exporting from?">
        {SYSTEMS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={system === s.id}
            aria-controls={`${groupId}-steps`}
            onClick={() => setSystem(s.id)}
            className={clsx(
              'rounded-lg border px-2.5 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
              system === s.id
                ? 'border-brand-500/50 bg-brand-500/10 text-brand-300'
                : 'border-slate-700 text-slate-400 hover:text-slate-200',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <ol id={`${groupId}-steps`} role="tabpanel" className="list-decimal space-y-1 pl-5 text-xs text-slate-300">
        {STEPS[kind][system].map((step) => <li key={step}>{step}</li>)}
      </ol>
    </div>
  );
}

/** Loud, unmissable label shown above any proposal built from sample (demo) data. */
export function SampleDataBanner() {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200" role="alert">
      <FlaskConical size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        <strong className="mr-1 rounded bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-100">Sample data</strong>
        These are demo records, not your books. Use this only to try the flow — don’t import it into a real company.
      </span>
    </div>
  );
}

/** Small, clearly-labelled "try sample data" link (rendered only where allowed). */
export function SampleDataLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded text-xs text-amber-300/90 hover:text-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
    >
      <Info size={12} aria-hidden />
      <span className="rounded bg-amber-500/20 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-amber-100">Sample data</span>
      {label}
    </button>
  );
}
