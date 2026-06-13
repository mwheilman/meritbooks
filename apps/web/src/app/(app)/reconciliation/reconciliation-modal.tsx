'use client';

import { useState, useMemo } from 'react';
import { X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

interface AccountTarget {
  id: string;            // bank_account id
  accountName: string;
  locationId: string | null;
  locationCode: string;
  balanceCents: number;
}

interface PeriodMonth {
  month: number;
  status: string;        // OPEN | SOFT_CLOSE | HARD_CLOSE | NONE
  periodId: string | null;
  closedAt: string | null;
}
interface PeriodGridRow {
  locationId: string;
  locationName: string;
  shortCode: string;
  months: PeriodMonth[];
}
interface PeriodResponse {
  year: number;
  grid: PeriodGridRow[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dollarsToCents(v: string): number {
  const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function ReconciliationModal({
  account,
  onClose,
  onCreated,
}: {
  account: AccountTarget;
  onClose: () => void;
  onCreated: () => void;
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [periodId, setPeriodId] = useState<string>('');
  const [statement, setStatement] = useState('');
  const [deposits, setDeposits] = useState('');
  const [checks, setChecks] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: periodData } = useQuery<PeriodResponse>('/api/periods', { year: String(year) });

  // Months that have a real, postable period for THIS account's company.
  const availablePeriods = useMemo(() => {
    const row = (periodData?.grid ?? []).find((g) => g.locationId === account.locationId);
    if (!row) return [] as Array<{ periodId: string; label: string }>;
    return row.months
      .filter((m) => m.periodId && m.status !== 'HARD_CLOSE')
      .map((m) => ({ periodId: m.periodId as string, label: `${MONTHS[m.month - 1]} ${year}` }));
  }, [periodData, account.locationId, year]);

  const statementCents = dollarsToCents(statement);
  const depositsCents = dollarsToCents(deposits);
  const checksCents = dollarsToCents(checks);
  const adjustedPreview = statementCents + depositsCents - checksCents;

  const canSubmit = !!periodId && statement.trim().length > 0 && !saving;

  async function handleSubmit() {
    if (!periodId) {
      addToast('error', 'Select a period to reconcile');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bank_account_id: account.id,
          fiscal_period_id: periodId,
          statement_ending_balance_cents: statementCents,
          outstanding_deposits_cents: depositsCents,
          outstanding_checks_cents: checksCents,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result?.id) {
        if (result.is_reconciled) {
          addToast('success', 'Reconciled — GL ties to the statement exactly');
        } else {
          addToast('success', `Reconciliation saved — difference ${formatMoney(result.difference_cents)}`);
        }
        onCreated();
        onClose();
      } else {
        addToast('error', result?.error ?? 'Failed to start reconciliation');
      }
    } catch {
      addToast('error', 'Network error while reconciling');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[92vw] bg-surface-900 border border-slate-700 rounded-xl z-50 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-white">Reconcile {account.accountName}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {account.locationCode} · GL cash balance is computed automatically
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          {/* Period */}
          <div>
            <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Statement Period</label>
            <div className="flex gap-2">
              <select
                value={year}
                onChange={(e) => { setYear(parseInt(e.target.value, 10)); setPeriodId(''); }}
                className="px-3 py-2 bg-slate-800/60 border border-slate-700 rounded-md text-sm text-slate-200"
              >
                {[currentYear + 1, currentYear, currentYear - 1, currentYear - 2].map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <select
                value={periodId}
                onChange={(e) => setPeriodId(e.target.value)}
                className="flex-1 px-3 py-2 bg-slate-800/60 border border-slate-700 rounded-md text-sm text-slate-200"
              >
                <option value="">Select month…</option>
                {availablePeriods.map((p) => (
                  <option key={p.periodId} value={p.periodId}>{p.label}</option>
                ))}
              </select>
            </div>
            {availablePeriods.length === 0 && (
              <p className="mt-1.5 flex items-center gap-1.5 text-amber-400 text-xs">
                <AlertCircle size={12} /> No open periods for this company in {year}
              </p>
            )}
          </div>

          {/* Statement ending balance */}
          <MoneyInput label="Statement Ending Balance" value={statement} onChange={setStatement} placeholder="0.00" />

          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Outstanding Deposits" value={deposits} onChange={setDeposits} placeholder="0.00" />
            <MoneyInput label="Outstanding Checks" value={checks} onChange={setChecks} placeholder="0.00" />
          </div>

          {/* Adjusted preview */}
          <div className="rounded-lg bg-slate-800/40 px-4 py-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">Adjusted bank balance</span>
            <span className="font-mono tabular-nums text-sm text-slate-200">{formatMoney(adjustedPreview)}</span>
          </div>
          <p className="text-2xs text-slate-600">
            The GL balance and the final difference are calculated from posted entries when you save.
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-md text-sm text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={clsx(
              'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium',
              canSubmit ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-600 cursor-not-allowed'
            )}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            Reconcile
          </button>
        </div>
      </div>
    </>
  );
}

function MoneyInput({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div>
      <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">{label}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-7 pr-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 font-mono tabular-nums focus:outline-none focus:ring-1 focus:ring-brand-500/40 focus:border-brand-500/40"
        />
      </div>
    </div>
  );
}
