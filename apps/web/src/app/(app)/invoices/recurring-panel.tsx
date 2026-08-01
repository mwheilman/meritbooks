'use client';

import { useState, useEffect } from 'react';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import {
  Plus, X, Loader2, Repeat, AlertCircle, Play, Pause, Zap, Send, Trash2, Pencil, CalendarClock,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

interface TemplateRow {
  id: string;
  name: string;
  frequency: Frequency;
  intervalCount: number;
  startDate: string;
  nextRunDate: string | null;
  endDate: string | null;
  occurrencesRemaining: number | null;
  isActive: boolean;
  autoSend: boolean;
  amountCents: number;
  lineCount: number;
  lastGeneratedAt: string | null;
  isDue: boolean;
  customer: { id: string; name: string } | null;
  location: { id: string; name: string; shortCode: string } | null;
}
interface LocationOption { id: string; name: string; short_code: string }
interface CustomerOption { id: string; name: string }
interface AccountOption { id: string; account_number: string; name: string }

const FREQ_UNIT: Record<Frequency, string> = {
  WEEKLY: 'week', BIWEEKLY: 'two weeks', MONTHLY: 'month',
  QUARTERLY: 'quarter', SEMIANNUAL: 'six months', ANNUAL: 'year',
};

function cadenceLabel(freq: Frequency, interval: number): string {
  if (interval <= 1) {
    return freq === 'BIWEEKLY' ? 'Every two weeks' : freq === 'SEMIANNUAL' ? 'Every six months' : `Every ${FREQ_UNIT[freq]}`;
  }
  return `Every ${interval} ${FREQ_UNIT[freq]}${interval > 1 && !FREQ_UNIT[freq].endsWith('s') ? 's' : ''}`;
}

// ─── Panel ────────────────────────────────────────────────────────────
export function RecurringPanel() {
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<{
    data: TemplateRow[];
    counts: { ALL: number; ACTIVE: number; PAUSED: number; DUE: number };
  }>(`/api/recurring-invoices?_k=${refreshKey}`);

  const templates = data?.data ?? [];
  const counts = data?.counts ?? { ALL: 0, ACTIVE: 0, PAUSED: 0, DUE: 0 };
  const refresh = () => { setRefreshKey((k) => k + 1); setShowCreate(false); setEditId(null); };

  async function generateDue() {
    setGenerating(true);
    try {
      const res = await fetch('/api/recurring-invoices/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { addToast('error', result.error ?? 'Generation failed'); return; }
      const created = result.invoices_created ?? 0;
      const sent = result.invoices_sent ?? 0;
      if (created === 0) addToast('success', 'No invoices due — everything is up to date');
      else addToast('success', `Generated ${created} invoice${created === 1 ? '' : 's'}${sent > 0 ? `, sent ${sent}` : ''}`);
      if ((result.errors ?? []).length > 0) addToast('error', `${result.errors.length} template(s) had errors`);
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setGenerating(false);
    }
  }

  async function toggleActive(t: TemplateRow) {
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/recurring-invoices/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !t.isActive }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); addToast('error', e.error ?? 'Update failed'); return; }
      addToast('success', t.isActive ? 'Schedule paused' : 'Schedule resumed');
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyId(null);
    }
  }

  async function runOne(t: TemplateRow) {
    setBusyId(t.id);
    try {
      const res = await fetch('/api/recurring-invoices/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: t.id }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { addToast('error', result.error ?? 'Generation failed'); return; }
      const created = result.invoices_created ?? 0;
      addToast(created > 0 ? 'success' : 'success', created > 0 ? `Generated ${created} invoice${created === 1 ? '' : 's'}` : 'Nothing due for this schedule');
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(t: TemplateRow) {
    if (!confirm(`Delete recurring schedule "${t.name}"? Invoices already generated are unaffected.`)) return;
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/recurring-invoices/${t.id}`, { method: 'DELETE' });
      if (!res.ok) { const e = await res.json().catch(() => ({})); addToast('error', e.error ?? 'Delete failed'); return; }
      addToast('success', 'Schedule deleted');
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Recurring Invoices</h2>
          <p className="text-sm text-gray-400 mt-1">Bill customers automatically on a schedule — Books mints each invoice when it&apos;s due</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={generateDue}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4 text-amber-400" />}
            Generate due now
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> New Schedule
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Active', value: String(counts.ACTIVE), sub: 'running schedules' },
          { label: 'Due now', value: String(counts.DUE), sub: 'awaiting generation' },
          { label: 'Paused', value: String(counts.PAUSED), sub: 'not billing' },
          { label: 'Total', value: String(counts.ALL), sub: 'all schedules' },
        ].map((c) => (
          <div key={c.label} className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <span className="text-sm text-gray-400">{c.label}</span>
            <p className="text-xl font-mono font-semibold text-white mt-2">{c.value}</p>
            <p className="text-xs text-gray-500 mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      {error ? (
        <div className="p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-red-400">Failed to load recurring schedules</p>
          <p className="text-sm text-gray-500 mt-1">{error}</p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16">
          <Repeat className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No recurring schedules</p>
          <p className="text-sm text-gray-500 mt-1">Create a schedule to bill a customer automatically each period</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                <th className="pb-3 pr-4">Schedule</th>
                <th className="pb-3 pr-4">Customer</th>
                <th className="pb-3 pr-4">Cadence</th>
                <th className="pb-3 pr-4">Next run</th>
                <th className="pb-3 pr-4 text-right">Amount</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="py-3 pr-4">
                    <div className="text-white font-medium">{t.name}</div>
                    <div className="text-xs text-gray-500">
                      {t.location?.name ?? '—'}
                      {t.autoSend && <span className="ml-2 px-1.5 py-0.5 text-[10px] bg-indigo-500/20 text-indigo-300 rounded">auto-send</span>}
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-gray-300">{t.customer?.name ?? '—'}</td>
                  <td className="py-3 pr-4 text-gray-400 text-xs">{cadenceLabel(t.frequency, t.intervalCount)}</td>
                  <td className="py-3 pr-4">
                    <span className={`font-mono text-xs ${t.isDue ? 'text-amber-400' : 'text-gray-400'}`}>{t.nextRunDate ?? '—'}</span>
                    {t.isDue && <span className="ml-1 text-[10px] text-amber-400">due</span>}
                    {t.occurrencesRemaining != null && (
                      <div className="text-[10px] text-gray-500">{t.occurrencesRemaining} left</div>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-white">{formatMoney(t.amountCents)}</td>
                  <td className="py-3 pr-4">
                    <span className={`px-2 py-0.5 text-xs rounded-full ${t.isActive ? 'bg-emerald-500/20 text-emerald-300' : 'bg-gray-500/20 text-gray-400'}`}>
                      {t.isActive ? 'Active' : 'Paused'}
                    </span>
                  </td>
                  <td className="py-3 text-right whitespace-nowrap">
                    {busyId === t.id ? (
                      <Loader2 className="w-4 h-4 animate-spin text-emerald-400 inline" />
                    ) : (
                      <div className="inline-flex items-center gap-1">
                        {t.isActive && t.isDue && (
                          <button onClick={() => runOne(t)} title="Generate now" className="p-1.5 text-gray-400 hover:text-amber-400 hover:bg-gray-700/50 rounded"><Send className="w-4 h-4" /></button>
                        )}
                        <button onClick={() => toggleActive(t)} title={t.isActive ? 'Pause' : 'Resume'} className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700/50 rounded">
                          {t.isActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        </button>
                        <button onClick={() => setEditId(t.id)} title="Edit" className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700/50 rounded"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => remove(t)} title="Delete" className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700/50 rounded"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <TemplateModal onClose={() => setShowCreate(false)} onSaved={refresh} />}
      {editId && <TemplateModal templateId={editId} onClose={() => setEditId(null)} onSaved={refresh} />}
    </div>
  );
}

// ─── Create / edit modal ──────────────────────────────────────────────
interface TLine { description: string; account_id: string; quantity: number; unit_price_cents: number }

interface TemplateDetail {
  id: string; name: string; frequency: Frequency; intervalCount: number;
  startDate: string; nextRunDate: string | null; endDate: string | null;
  occurrencesRemaining: number | null; autoSend: boolean; memo: string | null;
  taxCents: number; terms: number; isProgressBill: boolean;
  lines: { description: string; accountId: string; quantity: number; unitPriceCents: number }[];
  customer: { id: string; name: string } | null;
  location: { id: string; name: string; shortCode: string } | null;
}

function TemplateModal({ templateId, onClose, onSaved }: { templateId?: string; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!templateId;
  const { data: detail } = useQuery<TemplateDetail>(templateId ? `/api/recurring-invoices/${templateId}` : '', undefined, { enabled: isEdit });

  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('MONTHLY');
  const [intervalCount, setIntervalCount] = useState(1);
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState('');
  const [occurrences, setOccurrences] = useState('');
  const [terms, setTerms] = useState(30);
  const [autoSend, setAutoSend] = useState(false);
  const [memo, setMemo] = useState('');
  const [taxCents, setTaxCents] = useState(0);
  const [lines, setLines] = useState<TLine[]>([{ description: '', account_id: '', quantity: 1, unit_price_cents: 0 }]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const { data: custData } = useQuery<{ data: CustomerOption[] }>('/api/customers?per_page=200');
  const { data: acctData } = useQuery<{ data: AccountOption[] }>(locationId ? `/api/accounts/search?location_id=${locationId}&q=4` : null);

  const locations = locData?.data ?? [];
  const customers = custData?.data ?? [];
  const accounts = acctData?.data ?? [];

  // Hydrate the form from the loaded template when editing.
  useEffect(() => {
    if (!detail) return;
    setName(detail.name);
    setLocationId(detail.location?.id ?? '');
    setCustomerId(detail.customer?.id ?? '');
    setFrequency(detail.frequency);
    setIntervalCount(detail.intervalCount);
    setStartDate(detail.startDate);
    setEndDate(detail.endDate ?? '');
    setOccurrences(detail.occurrencesRemaining != null ? String(detail.occurrencesRemaining) : '');
    setTerms(detail.terms);
    setAutoSend(detail.autoSend);
    setMemo(detail.memo ?? '');
    setTaxCents(detail.taxCents);
    setLines(detail.lines.length ? detail.lines.map((l) => ({ description: l.description, account_id: l.accountId, quantity: l.quantity, unit_price_cents: l.unitPriceCents })) : [{ description: '', account_id: '', quantity: 1, unit_price_cents: 0 }]);
  }, [detail]);

  const subtotal = lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price_cents), 0);
  const total = subtotal + taxCents;

  const updateLine = (i: number, patch: Partial<TLine>) => setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    setFormError('');
    if (!name || !locationId || !customerId || !startDate) { setFormError('Name, company, customer, and start date are required'); return; }
    if (lines.some((l) => !l.description || !l.account_id)) { setFormError('Each line needs a description and a GL account'); return; }
    if (endDate && endDate < startDate) { setFormError('End date cannot precede start date'); return; }

    setSubmitting(true);
    try {
      const linePayload = lines.map((l) => ({ description: l.description, account_id: l.account_id, quantity: l.quantity, unit_price_cents: l.unit_price_cents }));
      let res: Response;
      if (isEdit) {
        res = await fetch(`/api/recurring-invoices/${templateId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name, frequency, interval_count: intervalCount,
            end_date: endDate || null,
            occurrences_remaining: occurrences ? parseInt(occurrences, 10) : null,
            auto_send: autoSend, memo: memo || null, tax_cents: taxCents, terms, lines: linePayload,
          }),
        });
      } else {
        res = await fetch('/api/recurring-invoices', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name, location_id: locationId, customer_id: customerId, frequency, interval_count: intervalCount,
            start_date: startDate, end_date: endDate || undefined,
            occurrences: occurrences ? parseInt(occurrences, 10) : undefined,
            auto_send: autoSend, memo: memo || undefined, tax_cents: taxCents, terms, lines: linePayload,
          }),
        });
      }
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(result.error ?? 'Failed to save schedule'); return; }
      addToast('success', isEdit ? 'Schedule updated' : 'Recurring schedule created');
      onSaved();
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-8 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl mb-8">
        <div className="flex items-center justify-between p-6 border-b border-gray-700/50">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2"><CalendarClock className="w-5 h-5 text-emerald-400" /> {isEdit ? 'Edit Recurring Schedule' : 'New Recurring Schedule'}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-5">
          {formError && <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{formError}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Schedule name *</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly retainer — Acme" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Company *</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={isEdit} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white disabled:opacity-60">
                <option value="">Select company</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Customer *</label>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={isEdit} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white disabled:opacity-60">
                <option value="">Select customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Frequency *</label>
                <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                  <option value="WEEKLY">Weekly</option>
                  <option value="BIWEEKLY">Biweekly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="SEMIANNUAL">Semiannual</option>
                  <option value="ANNUAL">Annual</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Every</label>
                <input type="number" min={1} max={52} value={intervalCount} onChange={(e) => setIntervalCount(Math.max(1, parseInt(e.target.value, 10) || 1))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white text-right font-mono" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Start date *</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={isEdit} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">End date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1"># Occurrences</label>
              <input type="number" min={1} value={occurrences} onChange={(e) => setOccurrences(e.target.value)} placeholder="∞" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600 text-right font-mono" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Net terms (days)</label>
              <input type="number" min={0} value={terms} onChange={(e) => setTerms(Math.max(0, parseInt(e.target.value, 10) || 0))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white text-right font-mono" />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">Line items</label>
              <button onClick={() => setLines((p) => [...p, { description: '', account_id: '', quantity: 1, unit_price_cents: 0 }])} className="text-xs text-emerald-400 hover:text-emerald-300">+ Add line</button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <input type="text" value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} placeholder="Description" className="col-span-4 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder:text-gray-600" />
                  <select value={l.account_id} onChange={(e) => updateLine(i, { account_id: e.target.value })} className="col-span-3 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white">
                    <option value="">GL account…</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                  </select>
                  <input type="number" min={0} step={0.01} value={l.quantity} onChange={(e) => updateLine(i, { quantity: parseFloat(e.target.value) || 0 })} className="col-span-1 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono" />
                  <input type="number" min={0} step={0.01} value={(l.unit_price_cents / 100).toFixed(2)} onChange={(e) => updateLine(i, { unit_price_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} className="col-span-2 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono" />
                  <div className="col-span-1 text-right font-mono text-sm text-white">{formatMoney(Math.round(l.quantity * l.unit_price_cents))}</div>
                  <button onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))} className="col-span-1 p-1 text-gray-500 hover:text-red-400"><X className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          </div>

          {/* Totals + memo + auto-send */}
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Memo (prints on each invoice)</label>
                <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} className="accent-emerald-500 w-4 h-4" />
                Auto-send each generated invoice by email
              </label>
              <p className="text-[11px] text-gray-500">If email isn&apos;t configured, invoices are still generated and posted for review.</p>
            </div>
            <div className="border-t border-gray-700/50 pt-2 space-y-2 self-end">
              <div className="flex justify-between text-sm"><span className="text-gray-400">Subtotal</span><span className="font-mono text-white">{formatMoney(subtotal)}</span></div>
              <div className="flex justify-between text-sm items-center">
                <span className="text-gray-400">Tax</span>
                <input type="number" min={0} step={0.01} value={(taxCents / 100).toFixed(2)} onChange={(e) => setTaxCents(Math.round((parseFloat(e.target.value) || 0) * 100))} className="w-24 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono" />
              </div>
              <div className="flex justify-between text-base font-semibold border-t border-gray-700/50 pt-2"><span className="text-white">Per invoice</span><span className="font-mono text-emerald-400">{formatMoney(total)}</span></div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-700/50">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button onClick={submit} disabled={submitting} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Repeat className="w-4 h-4" />} {isEdit ? 'Save Schedule' : 'Create Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
