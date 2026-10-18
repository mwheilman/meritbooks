'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, X } from 'lucide-react';

export interface EditorPolicy {
  id?: string;
  carrier: string | null;
  policy_number: string | null;
  coverage_type: 'GL' | 'PROPERTY' | 'AUTO' | 'WC' | 'CYBER' | 'UMBRELLA' | 'PROFESSIONAL' | 'OTHER';
  coverage_limit_cents: number | null;
  deductible_cents: number | null;
  premium_cents: number | null;
  premium_frequency: 'ANNUAL' | 'SEMIANNUAL' | 'QUARTERLY' | 'MONTHLY' | 'ONE_TIME';
  effective_date: string | null;
  expiration_date: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
  broker: string | null;
  notes: string | null;
}

const COVERAGE_OPTIONS: { value: EditorPolicy['coverage_type']; label: string }[] = [
  { value: 'GL', label: 'General liability' },
  { value: 'PROPERTY', label: 'Property' },
  { value: 'AUTO', label: 'Auto' },
  { value: 'WC', label: 'Workers comp' },
  { value: 'CYBER', label: 'Cyber' },
  { value: 'UMBRELLA', label: 'Umbrella' },
  { value: 'PROFESSIONAL', label: 'Professional' },
  { value: 'OTHER', label: 'Other' },
];
const FREQ_OPTIONS: { value: EditorPolicy['premium_frequency']; label: string }[] = [
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'SEMIANNUAL', label: 'Semiannual' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'ONE_TIME', label: 'One-time' },
];
const STATUS_OPTIONS: { value: EditorPolicy['status']; label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const EMPTY: EditorPolicy = {
  carrier: null,
  policy_number: null,
  coverage_type: 'GL',
  coverage_limit_cents: null,
  deductible_cents: null,
  premium_cents: null,
  premium_frequency: 'ANNUAL',
  effective_date: null,
  expiration_date: null,
  status: 'ACTIVE',
  broker: null,
  notes: null,
};

function centsToDollarStr(cents: number | null): string {
  return cents === null ? '' : String(Math.round(cents) / 100);
}
function dollarStrToCents(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function InsuranceEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: EditorPolicy | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [p, setP] = useState<EditorPolicy>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(initial?.id);

  const set = <K extends keyof EditorPolicy>(k: K, v: EditorPolicy[K]) => setP((prev) => ({ ...prev, [k]: v }));

  async function save() {
    if (p.expiration_date && p.effective_date && p.expiration_date < p.effective_date) {
      addToast('error', 'Expiration date cannot be before the effective date.');
      return;
    }
    setSaving(true);
    const payload = {
      carrier: p.carrier?.trim() || null,
      policy_number: p.policy_number?.trim() || null,
      coverage_type: p.coverage_type,
      coverage_limit_cents: p.coverage_limit_cents,
      deductible_cents: p.deductible_cents,
      premium_cents: p.premium_cents,
      premium_frequency: p.premium_frequency,
      effective_date: p.effective_date || null,
      expiration_date: p.expiration_date || null,
      status: p.status,
      broker: p.broker?.trim() || null,
      notes: p.notes?.trim() || null,
    };
    const res = isEdit
      ? await api.patch(`/api/insurance/${initial!.id}`, payload)
      : await api.post('/api/insurance', payload);
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', isEdit ? 'Policy updated' : 'Policy added');
    onSaved();
  }

  const inputCls =
    'w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-sm text-white focus:border-emerald-500 focus:outline-none';
  const labelCls = 'block text-[11px] text-slate-500 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">{isEdit ? 'Edit policy' : 'Add policy'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-7">
            <label className={labelCls}>Carrier</label>
            <input className={inputCls} value={p.carrier ?? ''} onChange={(e) => set('carrier', e.target.value || null)} placeholder="The Hartford" />
          </div>
          <div className="col-span-5">
            <label className={labelCls}>Policy number</label>
            <input className={inputCls} value={p.policy_number ?? ''} onChange={(e) => set('policy_number', e.target.value || null)} placeholder="GL-99123" />
          </div>

          <div className="col-span-4">
            <label className={labelCls}>Coverage type</label>
            <select className={inputCls} value={p.coverage_type} onChange={(e) => set('coverage_type', e.target.value as EditorPolicy['coverage_type'])}>
              {COVERAGE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Coverage limit ($)</label>
            <input className={inputCls} type="number" step="1" value={centsToDollarStr(p.coverage_limit_cents)} onChange={(e) => set('coverage_limit_cents', dollarStrToCents(e.target.value))} placeholder="1000000" />
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Deductible ($)</label>
            <input className={inputCls} type="number" step="1" value={centsToDollarStr(p.deductible_cents)} onChange={(e) => set('deductible_cents', dollarStrToCents(e.target.value))} placeholder="5000" />
          </div>

          <div className="col-span-4">
            <label className={labelCls}>Premium ($)</label>
            <input className={inputCls} type="number" step="1" value={centsToDollarStr(p.premium_cents)} onChange={(e) => set('premium_cents', dollarStrToCents(e.target.value))} placeholder="18000" />
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Premium frequency</label>
            <select className={inputCls} value={p.premium_frequency} onChange={(e) => set('premium_frequency', e.target.value as EditorPolicy['premium_frequency'])}>
              {FREQ_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Status</label>
            <select className={inputCls} value={p.status} onChange={(e) => set('status', e.target.value as EditorPolicy['status'])}>
              {STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>

          <div className="col-span-4">
            <label className={labelCls}>Effective date</label>
            <input className={inputCls} type="date" value={p.effective_date ?? ''} onChange={(e) => set('effective_date', e.target.value || null)} />
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Expiration date</label>
            <input className={inputCls} type="date" value={p.expiration_date ?? ''} onChange={(e) => set('expiration_date', e.target.value || null)} />
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Broker</label>
            <input className={inputCls} value={p.broker ?? ''} onChange={(e) => set('broker', e.target.value || null)} placeholder="Marsh" />
          </div>

          <div className="col-span-12">
            <label className={labelCls}>Notes</label>
            <textarea className={clsx(inputCls, 'resize-none')} rows={2} value={p.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} placeholder="Endorsements, named insureds, sublimits…" />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Add policy'}
          </button>
        </div>
      </div>
    </div>
  );
}
