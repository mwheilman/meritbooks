'use client';

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, X } from 'lucide-react';

export type Cadence = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'OTHER';
export type SubStatus = 'DETECTED' | 'ACTIVE' | 'UNDER_REVIEW' | 'CANCELLING' | 'CANCELLED' | 'KEPT';

export interface EditorSubscription {
  id?: string;
  vendor_name: string;
  product: string | null;
  category: string | null;
  amount_cents: number;
  billing_cadence: Cadence;
  first_seen_date: string | null;
  last_charged_date: string | null;
  next_renewal_date: string | null;
  status: SubStatus;
  auto_renews: boolean;
  notice_period_days: number | null;
  cancellation_terms: string | null;
  cancellation_method: string | null;
  notes: string | null;
  source?: 'DETECTED' | 'MANUAL' | 'PARSED';
}

const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'OTHER', label: 'Other' },
];
const STATUS_OPTIONS: { value: SubStatus; label: string }[] = [
  { value: 'DETECTED', label: 'Detected' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'CANCELLING', label: 'Cancelling' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'KEPT', label: 'Kept' },
];

export const EMPTY_SUB: EditorSubscription = {
  vendor_name: '',
  product: null,
  category: null,
  amount_cents: 0,
  billing_cadence: 'MONTHLY',
  first_seen_date: null,
  last_charged_date: null,
  next_renewal_date: null,
  status: 'ACTIVE',
  auto_renews: true,
  notice_period_days: null,
  cancellation_terms: null,
  cancellation_method: null,
  notes: null,
  source: 'MANUAL',
};

function centsToDollarStr(cents: number | null): string {
  return cents === null ? '' : String(Math.round(cents) / 100);
}
function dollarStrToCents(v: string): number {
  const n = Number(v.trim());
  return !Number.isFinite(n) || n < 0 ? 0 : Math.round(n * 100);
}

export function SubscriptionEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: EditorSubscription | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [s, setS] = useState<EditorSubscription>(initial ?? EMPTY_SUB);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(initial?.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  const set = <K extends keyof EditorSubscription>(k: K, v: EditorSubscription[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  async function save() {
    if (!s.vendor_name.trim()) {
      addToast('error', 'Vendor name is required.');
      return;
    }
    setSaving(true);
    const payload = {
      vendor_name: s.vendor_name.trim(),
      product: s.product?.trim() || null,
      category: s.category?.trim() || null,
      amount_cents: s.amount_cents,
      billing_cadence: s.billing_cadence,
      first_seen_date: s.first_seen_date || null,
      last_charged_date: s.last_charged_date || null,
      next_renewal_date: s.next_renewal_date || null,
      status: s.status,
      auto_renews: s.auto_renews,
      notice_period_days: s.notice_period_days,
      cancellation_terms: s.cancellation_terms?.trim() || null,
      cancellation_method: s.cancellation_method?.trim() || null,
      notes: s.notes?.trim() || null,
      ...(isEdit ? {} : { source: s.source ?? 'MANUAL' }),
    };
    const res = isEdit
      ? await api.patch(`/api/subscriptions/${initial!.id}`, payload)
      : await api.post('/api/subscriptions', payload);
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', isEdit ? 'Subscription updated' : 'Subscription added');
    onSaved();
  }

  const inputCls =
    'w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-sm text-white focus:border-emerald-500 focus:outline-none';
  const labelCls = 'block text-[11px] text-slate-500 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit subscription' : 'Add subscription'}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">{isEdit ? 'Edit subscription' : 'Add subscription'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-7">
            <label className={labelCls}>Vendor / service *</label>
            <input className={inputCls} value={s.vendor_name} onChange={(e) => set('vendor_name', e.target.value)} placeholder="Adobe Creative Cloud" />
          </div>
          <div className="col-span-5">
            <label className={labelCls}>Product / plan</label>
            <input className={inputCls} value={s.product ?? ''} onChange={(e) => set('product', e.target.value || null)} placeholder="Teams — 10 seats" />
          </div>

          <div className="col-span-4">
            <label className={labelCls}>Amount ($/charge)</label>
            <input className={inputCls} type="number" step="0.01" value={centsToDollarStr(s.amount_cents)} onChange={(e) => set('amount_cents', dollarStrToCents(e.target.value))} placeholder="52.99" />
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Billing cadence</label>
            <select className={inputCls} value={s.billing_cadence} onChange={(e) => set('billing_cadence', e.target.value as Cadence)}>
              {CADENCE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Category</label>
            <input className={inputCls} value={s.category ?? ''} onChange={(e) => set('category', e.target.value || null)} placeholder="Design software" />
          </div>

          <div className="col-span-4">
            <label className={labelCls}>Next renewal</label>
            <input className={inputCls} type="date" value={s.next_renewal_date ?? ''} onChange={(e) => set('next_renewal_date', e.target.value || null)} />
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Notice required (days)</label>
            <input className={inputCls} type="number" step="1" min="0" value={s.notice_period_days ?? ''} onChange={(e) => set('notice_period_days', e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))))} placeholder="30" />
          </div>
          <div className="col-span-4">
            <label className={labelCls}>Status</label>
            <select className={inputCls} value={s.status} onChange={(e) => set('status', e.target.value as SubStatus)}>
              {STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>

          <div className="col-span-6">
            <label className={labelCls}>Cancellation method</label>
            <input className={inputCls} value={s.cancellation_method ?? ''} onChange={(e) => set('cancellation_method', e.target.value || null)} placeholder="Account portal / email" />
          </div>
          <div className="col-span-6 flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={s.auto_renews} onChange={(e) => set('auto_renews', e.target.checked)} className="accent-emerald-500" />
              Auto-renews
            </label>
          </div>

          <div className="col-span-12">
            <label className={labelCls}>Cancellation terms</label>
            <textarea className={clsx(inputCls, 'resize-none')} rows={2} value={s.cancellation_terms ?? ''} onChange={(e) => set('cancellation_terms', e.target.value || null)} placeholder="Notice period, refund policy, how to cancel…" />
          </div>
          <div className="col-span-12">
            <label className={labelCls}>Notes</label>
            <textarea className={clsx(inputCls, 'resize-none')} rows={2} value={s.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Add subscription'}
          </button>
        </div>
      </div>
    </div>
  );
}
