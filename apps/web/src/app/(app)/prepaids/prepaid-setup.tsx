'use client';

import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, X, Sparkles, AlertTriangle } from 'lucide-react';

interface AccountOption {
  id: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  isActive: boolean;
  approvalStatus: string;
}
interface LocationOption {
  id: string;
  name: string;
}

/** Pre-fill payload (from a bill proposal or a parsed document). */
export interface PrepaidPrefill {
  description?: string | null;
  vendor_name?: string | null;
  total_cents?: number | null;
  start_date?: string | null;
  term_months?: number | null;
  location_id?: string | null;
  department_id?: string | null;
  expense_account_id?: string | null;
  prepaid_account_id?: string | null;
  source_type?: 'BILL' | 'INVOICE' | 'MANUAL' | 'PREPAID_DOC';
  source_id?: string | null;
  origin?: 'ai' | 'bill' | 'manual';
}

/** Client-side even-split preview (mirrors lib/prepaid/schedule even-split). */
function previewSchedule(totalCents: number, months: number): { first: number; last: number } | null {
  if (totalCents <= 0 || months <= 0) return null;
  const per = Math.floor(totalCents / months);
  const last = totalCents - per * (months - 1);
  return { first: months === 1 ? last : per, last };
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export function PrepaidSetup({
  prefill,
  onClose,
  onSaved,
}: {
  prefill?: PrepaidPrefill | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: acctResp } = useQuery<{ data: AccountOption[] }>('/api/accounts?approval_status=APPROVED');
  const { data: locResp } = useQuery<LocationOption[]>('/api/locations');
  const accounts = acctResp?.data ?? [];
  const locations = locResp ?? [];

  const expenseAccounts = accounts.filter((a) => a.isActive && ['OPEX', 'COGS', 'OTHER'].includes(a.accountType));
  const assetAccounts = accounts.filter((a) => a.isActive && a.accountType === 'ASSET');

  const [description, setDescription] = useState(prefill?.description ?? prefill?.vendor_name ?? '');
  const [amountDollars, setAmountDollars] = useState(
    prefill?.total_cents != null ? (prefill.total_cents / 100).toFixed(2) : '',
  );
  const [months, setMonths] = useState<string>(prefill?.term_months != null ? String(prefill.term_months) : '12');
  const [startDate, setStartDate] = useState(prefill?.start_date ?? todayISO());
  const [locationId, setLocationId] = useState(prefill?.location_id ?? '');
  // Default the company/location to the active company (this modal lives inside a
  // company-scoped page) so a fresh company's form is usable without re-picking.
  const { activeCompanyId } = useActiveCompany();
  useEffect(() => {
    if (!locationId && isSpecificCompany(activeCompanyId)) setLocationId(activeCompanyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompanyId]);
  const [expenseAccountId, setExpenseAccountId] = useState(prefill?.expense_account_id ?? '');
  const [prepaidAccountId, setPrepaidAccountId] = useState(prefill?.prepaid_account_id ?? '');
  const [saving, setSaving] = useState(false);

  const totalCents = Math.round((Number(amountDollars) || 0) * 100);
  const monthsNum = Math.trunc(Number(months) || 0);
  const preview = useMemo(() => previewSchedule(totalCents, monthsNum), [totalCents, monthsNum]);

  const canSave =
    totalCents > 0 && monthsNum >= 1 && !!startDate && !!locationId && !!expenseAccountId && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    const res = await api.post<{ id: string }>('/api/prepaid', {
      location_id: locationId,
      expense_account_id: expenseAccountId,
      prepaid_account_id: prepaidAccountId || undefined,
      total_cents: totalCents,
      start_date: startDate,
      months: monthsNum,
      department_id: prefill?.department_id ?? undefined,
      memo: description.trim() || undefined,
      source_type: prefill?.source_type ?? 'MANUAL',
      source_id: prefill?.source_id ?? undefined,
    });
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Prepaid schedule created');
    onSaved();
  }

  const inputCls =
    'w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-sm text-white focus:border-emerald-500 focus:outline-none';
  const labelCls = 'block text-[11px] text-slate-500 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {prefill?.origin === 'ai' && <Sparkles size={18} className="text-indigo-400" />}
            <div>
              <h2 className="text-lg font-semibold text-white">Set up prepaid amortization</h2>
              <p className="text-[11px] text-slate-500">
                Straight-line: DR expense / CR prepaid asset each period.
                {prefill?.origin === 'ai' && ' Review the AI-proposed values before saving.'}
                {prefill?.origin === 'bill' && ' Defaulted from the bill line — confirm the term and accounts.'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>Description</label>
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Annual liability insurance premium" />
          </div>

          <div>
            <label className={labelCls}>Prepaid amount ($)</label>
            <input className={inputCls} type="number" step="0.01" min="0" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} placeholder="12000.00" />
          </div>
          <div>
            <label className={labelCls}>Term (months)</label>
            <input className={inputCls} type="number" step="1" min="1" value={months} onChange={(e) => setMonths(e.target.value)} placeholder="12" />
          </div>

          <div>
            <label className={labelCls}>Start date</label>
            <input className={inputCls} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Company / location</label>
            <select className={inputCls} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Select…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>Expense account (DR)</label>
            <select className={inputCls} value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
              <option value="">Select…</option>
              {expenseAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.accountNumber ? `${a.accountNumber} · ` : ''}{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Prepaid asset (CR)</label>
            <select className={clsx(inputCls, !prepaidAccountId && 'border-amber-500/50')} value={prepaidAccountId} onChange={(e) => setPrepaidAccountId(e.target.value)}>
              <option value="">Auto-resolve (Prepaid Expenses)</option>
              {assetAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.accountNumber ? `${a.accountNumber} · ` : ''}{a.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Preview */}
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          {preview ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
              <Stat label="Periods" value={`${monthsNum}`} />
              <Stat label="Per period" value={formatMoney(preview.first)} />
              {preview.last !== preview.first && <Stat label="Final period" value={formatMoney(preview.last)} />}
              <Stat label="Total" value={formatMoney(totalCents)} />
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">Enter an amount and term to preview the monthly amortization.</p>
          )}
        </div>

        {!prepaidAccountId && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            The prepaid-asset credit leg will be auto-resolved to your &ldquo;Prepaid Expenses&rdquo; asset account. Pick one explicitly if you have several.
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button
            onClick={save}
            disabled={!canSave}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-40 flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Create schedule
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-slate-500">{label}: </span>
      <span className="text-slate-200 font-mono">{value}</span>
    </div>
  );
}
