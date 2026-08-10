'use client';

import { useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Trash2, Receipt, Search, Upload, X, Pencil, Check, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';
import { parseRateCsv, labelForRow, type ParsedRateRow, type RateImportError } from '@/lib/tax/rate-provider/csv-import';

/**
 * Sales-Tax Rates admin (GATE 11d / live rate adapter). Lists the tenant's
 * effective-dated combined-rate rows and lets an accounting admin add, edit (rate /
 * end date), deactivate, SEARCH, and BULK-IMPORT them. These rates drive
 * tax-at-invoice-creation through the provider-agnostic adapter: the internal-table
 * provider resolves most-specific-wins POSTAL > CITY > COUNTY > STATE among active,
 * effective-dated rows (an Avalara/TaxJar adapter is a later credential swap behind the
 * same interface). RLS-scoped read/write via /api/tax/rates.
 */

interface RateRow {
  id: string;
  country?: string | null;
  state: string | null;
  county: string | null;
  city: string | null;
  postalCode?: string | null;
  category?: string | null;
  jurisdictionLabel: string | null;
  combinedRatePct: number;
  effectiveDate: string | null;
  endDate: string | null;
  isActive: boolean;
  source?: string | null;
}

const todayISO = () => new Date().toISOString().split('T')[0];

const SOURCE_STYLE: Record<string, string> = {
  MANUAL: 'bg-slate-700/40 text-slate-300 border-slate-600',
  IMPORT: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  PROVIDER: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',
};

export function SalesTaxRates() {
  const { data, isLoading, error, refetch } = useQuery<{ data: RateRow[]; unavailable?: boolean }>('/api/tax/rates');
  const rows = useMemo(() => data?.data ?? [], [data]);

  // Add form
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [county, setCounty] = useState('');
  const [postal, setPostal] = useState('');
  const [category, setCategory] = useState('');
  const [ratePct, setRatePct] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);

  // Search
  const [search, setSearch] = useState('');

  // Inline edit
  const [editId, setEditId] = useState<string | null>(null);
  const [editRate, setEditRate] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Import
  const [showImport, setShowImport] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.jurisdictionLabel, r.state, r.city, r.county, r.postalCode, r.category]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [rows, search]);

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
          postal_code: postal.trim() || null,
          category: category.trim() || null,
          combined_rate_pct: rate,
          effective_date: effectiveDate,
          end_date: endDate || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        addToast('success', 'Rate added');
        setState(''); setCity(''); setCounty(''); setPostal(''); setCategory(''); setRatePct(''); setEndDate('');
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

  function beginEdit(r: RateRow) {
    setEditId(r.id);
    setEditRate(String(r.combinedRatePct));
    setEditEnd(r.endDate ?? '');
  }

  async function saveEdit(id: string) {
    const rate = parseFloat(editRate);
    if (!Number.isFinite(rate) || rate < 0) { addToast('error', 'Enter a valid rate'); return; }
    setEditSaving(true);
    try {
      const res = await fetch(`/api/tax/rates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ combined_rate_pct: rate, end_date: editEnd || null }),
      });
      if (res.ok) { addToast('success', 'Rate updated'); setEditId(null); refetch(); }
      else { const b = await res.json().catch(() => ({})); addToast('error', b.error ?? 'Could not update rate'); }
    } catch {
      addToast('error', 'Network error');
    } finally {
      setEditSaving(false);
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <Receipt className="w-4 h-4 text-emerald-400" /> Sales-Tax Rates
          </h3>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Effective-dated combined rates by jurisdiction. When an invoice is created with
            Auto tax on, the provider resolves the most-specific rate for the customer&apos;s
            ship-to (a postal or city row beats a bare state row) and accrues it to Sales Tax
            Payable. Leave the finer fields blank for a state-wide rate. Tax-exempt customers
            are never charged.
          </p>
        </div>
        <button
          onClick={() => setShowImport((v) => !v)}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-slate-700 text-slate-200 hover:bg-slate-800"
        >
          <Upload className="w-4 h-4" /> Import CSV
        </button>
      </div>

      {showImport && <ImportPanel onClose={() => setShowImport(false)} onImported={() => { setShowImport(false); refetch(); }} />}

      {/* Add form */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">State *</label>
            <input value={state} onChange={(e) => setState(e.target.value)} placeholder="IA"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">County</label>
            <input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="Polk"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">City</label>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Des Moines"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Postal</label>
            <input value={postal} onChange={(e) => setPostal(e.target.value)} placeholder="50309"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white font-mono" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Category</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="(all)"
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

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="w-4 h-4 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search jurisdiction, state, city, ZIP…"
          aria-label="Search sales-tax rates"
          className="w-full pl-8 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white placeholder:text-slate-500"
        />
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading rates…</div>
      ) : error ? (
        <div className="text-sm text-red-400">Could not load rates.</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
          No sales-tax rates configured yet. Add one above or import a CSV to enable automatic tax on invoices.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
          No rates match &ldquo;{search}&rdquo;.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Jurisdiction</th>
                <th className="px-3 py-2 text-left">State</th>
                <th className="px-3 py-2 text-left">Postal</th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-left">Effective</th>
                <th className="px-3 py-2 text-left">End</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((r) => {
                const editing = editId === r.id;
                const src = (r.source ?? 'MANUAL').toUpperCase();
                return (
                  <tr key={r.id} className="text-slate-200">
                    <td className="px-3 py-2">{r.jurisdictionLabel || [r.postalCode, r.city, r.county, r.state].filter(Boolean).join(', ')}</td>
                    <td className="px-3 py-2 font-mono">{r.state}</td>
                    <td className="px-3 py-2 font-mono text-slate-400">{r.postalCode || '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{r.category || 'All'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {editing ? (
                        <input type="number" value={editRate} onChange={(e) => setEditRate(e.target.value)} min={0} step={0.001}
                          aria-label="Edit rate percent"
                          className="w-20 px-1.5 py-1 bg-slate-800 border border-slate-600 rounded text-right font-mono text-white" />
                      ) : `${r.combinedRatePct}%`}
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-400">{r.effectiveDate}</td>
                    <td className="px-3 py-2 font-mono text-slate-400">
                      {editing ? (
                        <input type="date" value={editEnd} onChange={(e) => setEditEnd(e.target.value)}
                          aria-label="Edit end date"
                          className="px-1.5 py-1 bg-slate-800 border border-slate-600 rounded text-white" />
                      ) : (r.endDate ?? '—')}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${SOURCE_STYLE[src] ?? SOURCE_STYLE.MANUAL}`}>
                        {src}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {editing ? (
                        <div className="inline-flex items-center gap-1">
                          <button onClick={() => saveEdit(r.id)} disabled={editSaving} title="Save"
                            className="p-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-50">
                            {editSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                          </button>
                          <button onClick={() => setEditId(null)} title="Cancel" className="p-1 text-slate-500 hover:text-slate-300">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1">
                          <button onClick={() => beginEdit(r)} title="Edit rate / end date" className="p-1 text-slate-500 hover:text-emerald-400">
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => retire(r.id)} title="Retire this rate" className="p-1 text-slate-500 hover:text-red-400">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── CSV bulk import panel ───────────────────────────────────────────────────────
function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<{ rows: ParsedRateRow[]; errors: RateImportError[] } | null>(null);
  const [importing, setImporting] = useState(false);

  function loadText(text: string) {
    setCsv(text);
    const parsed = parseRateCsv(text);
    setPreview({ rows: parsed.rows, errors: parsed.errors });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { addToast('error', 'File too large (max 10MB)'); return; }
    const text = await f.text();
    loadText(text);
  }

  async function doImport() {
    if (!preview || preview.rows.length === 0) { addToast('error', 'No valid rows to import'); return; }
    setImporting(true);
    try {
      const res = await fetch('/api/tax/rates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        addToast('success', `Imported ${body.inserted} rate${body.inserted === 1 ? '' : 's'}${body.skipped ? `, skipped ${body.skipped}` : ''}`);
        onImported();
      } else {
        addToast('error', body.error ?? 'Import failed');
      }
    } catch {
      addToast('error', 'Network error');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <FileSpreadsheet className="w-4 h-4 text-blue-400" /> Bulk import rates
        </div>
        <button onClick={onClose} className="p-1 text-slate-500 hover:text-slate-300" aria-label="Close import panel"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-xs text-slate-400">
        CSV columns: <code className="text-slate-300">state, county, city, postal, rate, effective_date</code>{' '}
        (optional <code className="text-slate-300">category, end_date</code>). Imported rows are tagged
        source <span className="text-blue-300 font-medium">IMPORT</span>. Rows that fail validation are listed below and skipped.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" onChange={onFile} className="hidden" />
        <button onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border border-slate-700 text-slate-200 hover:bg-slate-800">
          <Upload className="w-4 h-4" /> Choose CSV file
        </button>
        <span className="text-xs text-slate-500">or paste below</span>
      </div>

      <textarea
        value={csv}
        onChange={(e) => loadText(e.target.value)}
        rows={4}
        placeholder="state,county,city,postal,rate,effective_date&#10;IA,Polk,Des Moines,50309,7.0,2026-01-01"
        aria-label="Paste CSV rate rows"
        className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs font-mono text-white placeholder:text-slate-600"
      />

      {preview && (
        <div className="space-y-2">
          <div className="flex items-center gap-4 text-xs">
            <span className="text-emerald-400">{preview.rows.length} valid</span>
            {preview.errors.length > 0 && (
              <span className="text-amber-400 inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {preview.errors.length} skipped</span>
            )}
          </div>

          {preview.rows.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded border border-slate-800">
              <table className="w-full text-xs">
                <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-500 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">Jurisdiction</th>
                    <th className="px-2 py-1 text-right">Rate</th>
                    <th className="px-2 py-1 text-left">Effective</th>
                    <th className="px-2 py-1 text-left">End</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {preview.rows.slice(0, 200).map((r, i) => (
                    <tr key={i} className="text-slate-300">
                      <td className="px-2 py-1">{labelForRow(r)}{r.category ? ` · ${r.category}` : ''}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">{r.combined_rate_pct}%</td>
                      <td className="px-2 py-1 font-mono text-slate-400">{r.effective_date}</td>
                      <td className="px-2 py-1 font-mono text-slate-400">{r.end_date ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.errors.length > 0 && (
            <ul className="max-h-28 overflow-y-auto text-[11px] text-amber-400/90 space-y-0.5">
              {preview.errors.slice(0, 50).map((e, i) => (
                <li key={i}>Line {e.line}: {e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={doImport} disabled={importing || !preview || preview.rows.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
          {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Import {preview?.rows.length ? `${preview.rows.length} row${preview.rows.length === 1 ? '' : 's'}` : ''}
        </button>
      </div>
    </div>
  );
}
