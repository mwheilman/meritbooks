'use client';

import { useMemo, useState } from 'react';
import { Loader2, AlertCircle, X, Building2, Landmark } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';

// White-label copy: a "company" is any client entity / book of record in this tenant.

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Date(2000, i).toLocaleString('en', { month: 'long' }),
}));

const REV_REC_METHODS: { value: string; label: string; help: string }[] = [
  { value: 'POINT_OF_SALE', label: 'Point of Sale', help: 'Recognize revenue when the sale closes. Retail, product sales.' },
  { value: 'AS_BILLED', label: 'As Billed', help: 'Recognize as invoices are issued. Time & materials.' },
  { value: 'PCT_COMPLETE', label: 'Percentage of Completion', help: 'Recognize as the job progresses. Long-term construction.' },
  { value: 'PCT_COSTS_INCURRED', label: '% Costs Incurred (Cost-to-Cost)', help: 'PoC measured by costs incurred vs. total estimated.' },
  { value: 'COMPLETED_CONTRACT', label: 'Completed Contract', help: 'Recognize all revenue at completion. Short jobs.' },
  { value: 'MILESTONE', label: 'Milestone', help: 'Recognize at defined milestones. Phased delivery.' },
  { value: 'RATABLY', label: 'Ratably (Straight-Line)', help: 'Spread evenly over the service period.' },
  { value: 'SUBSCRIPTION', label: 'Subscription', help: 'Recurring recognition over the subscription term.' },
  { value: 'CASH', label: 'Cash Basis', help: 'Recognize when cash is received.' },
];

interface CreateCompanyDialogProps {
  /** Short codes already in use (case-insensitive) — for inline duplicate warning. */
  existingCodes: string[];
  baseCurrency?: string;
  defaultFiscalMonth?: number;
  onClose: () => void;
  /** Fired after a successful create with the new company's id + name. */
  onCreated: (locationId: string, name: string) => void;
}

interface CreateResult {
  success?: boolean;
  locationId?: string;
  accountCount?: number;
  periodsCreated?: number;
  error?: string;
}

export function CreateCompanyDialog({
  existingCodes,
  baseCurrency = 'USD',
  defaultFiscalMonth = 1,
  onClose,
  onCreated,
}: CreateCompanyDialogProps) {
  const [name, setName] = useState('');
  const [shortCode, setShortCode] = useState('');
  const [industry, setIndustry] = useState('');
  const [fiscalMonth, setFiscalMonth] = useState<number>(defaultFiscalMonth);
  const [revRec, setRevRec] = useState('POINT_OF_SALE');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const takenCodes = useMemo(
    () => new Set(existingCodes.map((c) => c.toUpperCase())),
    [existingCodes],
  );
  const codeUpper = shortCode.toUpperCase();
  const codeValid = /^[A-Z0-9]{1,10}$/.test(codeUpper);
  const codeDuplicate = codeValid && takenCodes.has(codeUpper);
  const canSubmit = name.trim().length > 0 && codeValid && !codeDuplicate && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    const res = await api.post<CreateResult>('/api/settings/entities', {
      name: name.trim(),
      short_code: codeUpper,
      industry: industry.trim() || undefined,
      fiscal_year_start_month: fiscalMonth,
      rev_rec_method: revRec,
    });
    setSubmitting(false);
    if (res.error || !res.data?.locationId) {
      setError(res.error?.error || res.data?.error || 'Could not create the company.');
      return;
    }
    addToast('success', `${name.trim()} added`);
    onCreated(res.data.locationId, name.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-slate-800 bg-surface-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-300">
              <Building2 size={16} />
            </div>
            <div>
              <h2 className="text-subheading font-semibold text-white">Add a company</h2>
              <p className="text-body-sm text-slate-500">
                Creates its own book of record — fiscal calendar and chart of accounts included.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 py-5">
          <div>
            <label className="mb-1 block text-label text-slate-400">Company name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Manufacturing LLC"
              className="input"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-label text-slate-400">Short code</label>
              <input
                type="text"
                value={shortCode}
                onChange={(e) =>
                  setShortCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))
                }
                placeholder="ACME"
                className={clsx('input font-mono', codeDuplicate && 'border-red-500/60')}
              />
              {codeDuplicate ? (
                <p className="mt-1 text-[11px] text-red-400">That short code is already in use.</p>
              ) : (
                <p className="mt-1 text-[11px] text-slate-500">Uppercase letters &amp; numbers.</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-label text-slate-400">
                Industry <span className="text-slate-600">(optional)</span>
              </label>
              <input
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Manufacturing"
                className="input"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-label text-slate-400">Fiscal year start</label>
              <select
                value={fiscalMonth}
                onChange={(e) => setFiscalMonth(Number(e.target.value))}
                className="input"
              >
                {MONTHS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-label text-slate-400">Base currency</label>
              <div className="flex h-[38px] items-center gap-2 rounded-lg border border-slate-700/60 bg-surface-850 px-3 text-sm text-slate-300">
                <Landmark size={13} className="text-slate-500" />
                {baseCurrency}
                <span className="ml-auto text-[10px] text-slate-600">inherited</span>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-label text-slate-400">Default revenue recognition</label>
            <select value={revRec} onChange={(e) => setRevRec(e.target.value)} className="input">
              {REV_REC_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              {REV_REC_METHODS.find((m) => m.value === revRec)?.help} Refine it per job type later in
              Settings.
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-fg">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 bg-surface-900 px-6 py-3.5">
          <button onClick={onClose} className="btn-ghost btn-sm">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit} className="btn-primary btn-sm gap-1.5">
            {submitting && <Loader2 size={13} className="animate-spin" />}
            Add company
          </button>
        </div>
      </div>
    </div>
  );
}
