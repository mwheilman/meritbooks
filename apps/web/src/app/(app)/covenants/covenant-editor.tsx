'use client';

import { useState } from 'react';
import { dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, X } from 'lucide-react';

/** The subset of a covenant the editor reads/writes. */
export interface EditorCovenant {
  id?: string;
  loan_name: string;
  facility: string | null;
  lender_name: string | null;
  location_id: string | null;
  covenant_type: 'DSCR' | 'FCCR' | 'LEVERAGE' | 'CURRENT_RATIO' | 'MIN_LIQUIDITY' | 'TNW' | 'CUSTOM';
  threshold: number;
  direction: 'MIN' | 'MAX';
  test_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  warn_headroom_pct: number;
  status: 'ACTIVE' | 'WAIVED' | 'CURED' | 'INACTIVE';
  effective_date: string | null;
  maturity_date: string | null;
  notes: string | null;
  measurement: {
    trailingMonths?: number;
    annualPrincipalCents?: number;
    fixedChargeAddonCents?: number;
    revolverAvailabilityCents?: number;
    intangiblesCents?: number;
    netOfCash?: boolean;
  } | null;
}

interface LocationOption {
  id: string;
  name: string;
}

const TYPE_OPTIONS: { value: EditorCovenant['covenant_type']; label: string; dir: 'MIN' | 'MAX'; unit: 'ratio' | 'currency' }[] = [
  { value: 'DSCR', label: 'DSCR (debt service coverage)', dir: 'MIN', unit: 'ratio' },
  { value: 'FCCR', label: 'FCCR (fixed charge coverage)', dir: 'MIN', unit: 'ratio' },
  { value: 'LEVERAGE', label: 'Leverage (net debt / EBITDA)', dir: 'MAX', unit: 'ratio' },
  { value: 'CURRENT_RATIO', label: 'Current ratio', dir: 'MIN', unit: 'ratio' },
  { value: 'MIN_LIQUIDITY', label: 'Minimum liquidity ($)', dir: 'MIN', unit: 'currency' },
  { value: 'TNW', label: 'Tangible net worth ($)', dir: 'MIN', unit: 'currency' },
  { value: 'CUSTOM', label: 'Custom ratio', dir: 'MIN', unit: 'ratio' },
];

const EMPTY: EditorCovenant = {
  loan_name: '',
  facility: '',
  lender_name: '',
  location_id: null,
  covenant_type: 'DSCR',
  threshold: 1.25,
  direction: 'MIN',
  test_frequency: 'QUARTERLY',
  warn_headroom_pct: 0.1,
  status: 'ACTIVE',
  effective_date: null,
  maturity_date: null,
  notes: '',
  measurement: { trailingMonths: 12, netOfCash: true },
};

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function CovenantEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial?: EditorCovenant | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditorCovenant>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const isEdit = Boolean(initial?.id);

  const typeMeta = TYPE_OPTIONS.find((t) => t.value === form.covenant_type)!;
  const isCurrency = typeMeta.unit === 'currency';

  const set = <K extends keyof EditorCovenant>(k: K, v: EditorCovenant[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setMeas = (patch: Partial<NonNullable<EditorCovenant['measurement']>>) =>
    setForm((f) => ({ ...f, measurement: { ...(f.measurement ?? {}), ...patch } }));

  async function save() {
    if (!form.loan_name.trim()) {
      addToast('error', 'Loan / facility name is required');
      return;
    }
    setSaving(true);
    const payload = {
      loan_name: form.loan_name.trim(),
      facility: form.facility?.trim() || undefined,
      lender_name: form.lender_name?.trim() || undefined,
      location_id: form.location_id,
      covenant_type: form.covenant_type,
      threshold: form.threshold,
      direction: form.direction,
      test_frequency: form.test_frequency,
      warn_headroom_pct: form.warn_headroom_pct,
      status: form.status,
      effective_date: form.effective_date || null,
      maturity_date: form.maturity_date || null,
      notes: form.notes?.trim() || undefined,
      measurement: form.measurement ?? {},
    };
    const res = isEdit
      ? await api.patch(`/api/covenants/${initial!.id}`, payload)
      : await api.post('/api/covenants', payload);
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', isEdit ? 'Covenant updated' : 'Covenant defined');
    onSaved();
  }

  const inputCls =
    'w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:border-emerald-500 focus:outline-none';
  const labelCls = 'block text-xs font-medium text-slate-400 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">{isEdit ? 'Edit covenant' : 'Define covenant'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={labelCls}>Loan / facility name *</label>
            <input className={inputCls} value={form.loan_name} onChange={(e) => set('loan_name', e.target.value)} placeholder="Term Loan A" />
          </div>
          <div>
            <label className={labelCls}>Facility</label>
            <input className={inputCls} value={form.facility ?? ''} onChange={(e) => set('facility', e.target.value)} placeholder="$25M Senior Secured" />
          </div>
          <div>
            <label className={labelCls}>Lender</label>
            <input className={inputCls} value={form.lender_name ?? ''} onChange={(e) => set('lender_name', e.target.value)} placeholder="Northwest Bank" />
          </div>

          <div>
            <label className={labelCls}>Company (scope)</label>
            <select className={inputCls} value={form.location_id ?? ''} onChange={(e) => set('location_id', e.target.value || null)}>
              <option value="">Consolidated (all companies)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Test frequency</label>
            <select className={inputCls} value={form.test_frequency} onChange={(e) => set('test_frequency', e.target.value as EditorCovenant['test_frequency'])}>
              <option value="MONTHLY">Monthly</option>
              <option value="QUARTERLY">Quarterly</option>
              <option value="ANNUAL">Annual</option>
            </select>
          </div>

          <div>
            <label className={labelCls}>Covenant type</label>
            <select
              className={inputCls}
              value={form.covenant_type}
              onChange={(e) => {
                const t = TYPE_OPTIONS.find((o) => o.value === (e.target.value as EditorCovenant['covenant_type']))!;
                setForm((f) => ({ ...f, covenant_type: t.value, direction: t.dir }));
              }}
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Direction</label>
            <select className={inputCls} value={form.direction} onChange={(e) => set('direction', e.target.value as 'MIN' | 'MAX')}>
              <option value="MIN">Minimum (value ≥ threshold)</option>
              <option value="MAX">Maximum (value ≤ threshold)</option>
            </select>
          </div>

          <div>
            <label className={labelCls}>Threshold {isCurrency ? '(dollars)' : '(ratio, e.g. 1.25)'}</label>
            {isCurrency ? (
              <input
                className={inputCls}
                type="number"
                value={form.threshold}
                onChange={(e) => set('threshold', num(e.target.value, 0))}
                placeholder="1000000"
              />
            ) : (
              <input
                className={inputCls}
                type="number"
                step="0.01"
                value={form.threshold}
                onChange={(e) => set('threshold', num(e.target.value, 0))}
                placeholder="1.25"
              />
            )}
          </div>
          <div>
            <label className={labelCls}>Warn band (headroom fraction)</label>
            <input className={inputCls} type="number" step="0.01" min="0" max="1" value={form.warn_headroom_pct} onChange={(e) => set('warn_headroom_pct', num(e.target.value, 0.1))} />
          </div>

          <div>
            <label className={labelCls}>Effective date</label>
            <input className={inputCls} type="date" value={form.effective_date ?? ''} onChange={(e) => set('effective_date', e.target.value || null)} />
          </div>
          <div>
            <label className={labelCls}>Maturity date</label>
            <input className={inputCls} type="date" value={form.maturity_date ?? ''} onChange={(e) => set('maturity_date', e.target.value || null)} />
          </div>

          {/* Measurement config */}
          <div className="col-span-2 mt-2 pt-3 border-t border-slate-800">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Measurement definition</p>
            <p className="text-[11px] text-slate-600 mb-3">
              Ratios are computed from the ledger by account role/type. These optional inputs cover the
              parts the P&amp;L does not carry (scheduled principal, fixed-charge add-ons, revolver
              availability, intangibles).
            </p>
          </div>
          <div>
            <label className={labelCls}>Trailing window (months)</label>
            <input className={inputCls} type="number" min="1" max="60" value={form.measurement?.trailingMonths ?? 12} onChange={(e) => setMeas({ trailingMonths: num(e.target.value, 12) })} />
          </div>
          <div>
            <label className={labelCls}>Scheduled principal / window ($)</label>
            <input className={inputCls} type="number" value={centsToDollars(form.measurement?.annualPrincipalCents ?? 0)} onChange={(e) => setMeas({ annualPrincipalCents: dollarsToCents(num(e.target.value, 0)) })} />
          </div>
          <div>
            <label className={labelCls}>Fixed-charge add-on ($, rent/leases)</label>
            <input className={inputCls} type="number" value={centsToDollars(form.measurement?.fixedChargeAddonCents ?? 0)} onChange={(e) => setMeas({ fixedChargeAddonCents: dollarsToCents(num(e.target.value, 0)) })} />
          </div>
          <div>
            <label className={labelCls}>Revolver availability ($)</label>
            <input className={inputCls} type="number" value={centsToDollars(form.measurement?.revolverAvailabilityCents ?? 0)} onChange={(e) => setMeas({ revolverAvailabilityCents: dollarsToCents(num(e.target.value, 0)) })} />
          </div>
          <div>
            <label className={labelCls}>Intangibles ($, for TNW)</label>
            <input className={inputCls} type="number" value={centsToDollars(form.measurement?.intangiblesCents ?? 0)} onChange={(e) => setMeas({ intangiblesCents: dollarsToCents(num(e.target.value, 0)) })} />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={form.measurement?.netOfCash !== false} onChange={(e) => setMeas({ netOfCash: e.target.checked })} />
              Leverage net of cash
            </label>
          </div>

          <div className="col-span-2">
            <label className={labelCls}>Notes</label>
            <textarea className={inputCls} rows={2} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} placeholder="Credit agreement §7.1(a); tested quarterly on consolidated results." />
          </div>

          {isEdit && (
            <div>
              <label className={labelCls}>Status</label>
              <select className={inputCls} value={form.status} onChange={(e) => set('status', e.target.value as EditorCovenant['status'])}>
                <option value="ACTIVE">Active</option>
                <option value="WAIVED">Waived</option>
                <option value="CURED">Cured</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Define covenant'}
          </button>
        </div>
      </div>
    </div>
  );
}
