'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2, Receipt } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';

/**
 * Sales-Tax Rates admin (GATE 11d). Lists the tenant's effective-dated combined-rate
 * rows and lets an accounting admin add one. These rates drive tax-at-invoice-creation
 * (most-specific-wins: a city row beats a bare state row). RLS-scoped read/write via
 * /api/tax/rates.
 */

interface RateRow {
  id: string;
  state: string | null;
  county: string | null;
  city: string | null;
  jurisdictionLabel: string | null;
  combinedRatePct: number;
  effectiveDate: string | null;
  endDate: string | null;
  isActive: boolean;
}

const todayISO = () => new Date().toISOString().split('T')[0];

export function SalesTaxRates() {
  const { data, isLoading, error, refetch } = useQuery<{ data: RateRow[]; unavailable?: boolean }>('/api/tax/rates');
  const rows = data?.data ?? [];

  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [county, setCounty] = useState('');
  const [ratePct, setRatePct] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);

  async function addRate() {
    const rate = parseFloat(ratePct);
    if (!state.trim()) { addToast('error', 'State is required'); return; }
    if (!Number.isFinite(rate) || rate < 0) { addToast('error', 'Enter a valid rate percentage'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/tax/rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: state.trim(),
          city: city.trim() || null,
          county: county.trim() || null,
          combined_rate_pct: rate,
          effective_date: effectiveDate,
          end_date: endDate || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        addToast('success', 'Rate added');
        setState(''); setCity(''); setCounty(''); setRatePct(''); setEndDate('');
        refetch();
      } else {
        addToast('error', body.error ?? 'Could not add rate');
      }
    } catch {
      addToast('error', 'Network error');
    } finally {
      setSaving(false);
    }
  }

  async function retire(id: string) {
    try {
      const res = await fetch(`/api/tax/rates/${id}`, { method: 'DELETE' });
      if (res.ok) { addToast('success', 'Rate retired'); refetch(); }
      else addToast('error', 'Could not retire rate');
    } catch {
      addToast('error', 'Network error');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <Receipt className="w-4 h-4 text-emerald-400" /> Sales-Tax Rates
        </h3>
        <p className="text-sm text-slate-400 mt-1 max-w-2xl">
          Effective-dated combined rates by jurisdiction. When an invoice is created with
          Auto tax on, the most-specific rate for the customer&apos;s ship-to (a city row
          beats a bare state row) is applied and accrued to Sales Tax Payable. Leave city
          and county blank for a state-wide rate. Tax-exempt customers are never charged.
        </p>
      </div>

      {/* Add form */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">State *</label>
            <input value={state} onChange={(e) => setState(e.target.value)} placeholder="IA"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">City</label>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Des Moines"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">County</label>
            <input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="Polk"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Rate % *</label>
            <input type="number" value={ratePct} onChange={(e) => setRatePct(e.target.value)} min={0} step={0.001} placeholder="7.0"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white text-right font-mono" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Effective *</label>
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">End (opt.)</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={addRate} disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add rate
          </button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading rates…</div>
      ) : error ? (
        <div className="text-sm text-red-400">Could not load rates.</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
          No sales-tax rates configured yet. Add one above to enable automatic tax on invoices.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Jurisdiction</th>
                <th className="px-3 py-2 text-left">State</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-left">Effective</th>
                <th className="px-3 py-2 text-left">End</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((r) => (
                <tr key={r.id} className="text-slate-200">
                  <td className="px-3 py-2">{r.jurisdictionLabel || [r.city, r.county, r.state].filter(Boolean).join(', ')}</td>
                  <td className="px-3 py-2 font-mono">{r.state}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.combinedRatePct}%</td>
                  <td className="px-3 py-2 font-mono text-slate-400">{r.effectiveDate}</td>
                  <td className="px-3 py-2 font-mono text-slate-400">{r.endDate ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => retire(r.id)} title="Retire this rate"
                      className="p-1 text-slate-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
