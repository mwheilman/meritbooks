'use client';

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  UploadCloud, FileText, Loader2, X, Trash2, Sparkles, AlertTriangle, Info,
} from 'lucide-react';

/** Shape returned by /api/covenants/parse (mirrors ProposedCovenant). */
interface ProposedCovenant {
  loan_name: string;
  facility: string | null;
  lender_name: string | null;
  covenant_type: 'DSCR' | 'FCCR' | 'LEVERAGE' | 'CURRENT_RATIO' | 'MIN_LIQUIDITY' | 'TNW' | 'CUSTOM';
  threshold_unit: 'RATIO' | 'CURRENCY';
  threshold: number | null;
  direction: 'MIN' | 'MAX';
  test_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | null;
  measurement: { trailingMonths?: number };
  effective_date: string | null;
  maturity_date: string | null;
  notes: string | null;
  snippet: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

interface ParseResponse {
  covenants: ProposedCovenant[];
  meta: { fileName: string; model: string; documentNote: string | null; covenantCount: number; sourceDocumentId: string | null };
}

/** A review row = one proposed covenant with a local id + resolved (non-null) frequency. */
interface Row extends Omit<ProposedCovenant, 'test_frequency'> {
  _id: string;
  test_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
}

interface LocationOption {
  id: string;
  name: string;
}

const TYPE_OPTIONS: { value: Row['covenant_type']; label: string; dir: 'MIN' | 'MAX'; unit: 'RATIO' | 'CURRENCY' }[] = [
  { value: 'DSCR', label: 'DSCR', dir: 'MIN', unit: 'RATIO' },
  { value: 'FCCR', label: 'FCCR', dir: 'MIN', unit: 'RATIO' },
  { value: 'LEVERAGE', label: 'Leverage', dir: 'MAX', unit: 'RATIO' },
  { value: 'CURRENT_RATIO', label: 'Current ratio', dir: 'MIN', unit: 'RATIO' },
  { value: 'MIN_LIQUIDITY', label: 'Min liquidity', dir: 'MIN', unit: 'CURRENCY' },
  { value: 'TNW', label: 'Tangible net worth', dir: 'MIN', unit: 'CURRENCY' },
  { value: 'CUSTOM', label: 'Custom', dir: 'MIN', unit: 'RATIO' },
];

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let ROW_SEQ = 0;
function toRow(p: ProposedCovenant): Row {
  ROW_SEQ += 1;
  return { ...p, _id: `r${ROW_SEQ}`, test_frequency: p.test_frequency ?? 'QUARTERLY' };
}

export function CovenantParseReview({
  onClose,
  onConfirmed,
}: {
  onClose: () => void;
  onConfirmed: (count: number) => void;
}) {
  const [phase, setPhase] = useState<'upload' | 'parsing' | 'review' | 'confirming'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ParseResponse['meta'] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const [locationId, setLocationId] = useState<string>('');

  const parse = useCallback(async (file: File) => {
    setError(null);
    if (!ALLOWED.includes(file.type)) {
      setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large. Maximum 10MB.');
      return;
    }
    setPhase('parsing');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/covenants/parse', { method: 'POST', body: formData });
      const body = (await res.json()) as ParseResponse | { error: string };
      if (!res.ok || 'error' in body) {
        setError('error' in body ? body.error : 'Failed to parse document');
        setPhase('upload');
        return;
      }
      setMeta(body.meta);
      setRows(body.covenants.map(toRow));
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setPhase('upload');
    }
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  const setRow = <K extends keyof Row>(id: string, k: K, v: Row[K]) =>
    setRows((rs) => rs.map((r) => (r._id === id ? { ...r, [k]: v } : r)));

  function changeType(id: string, type: Row['covenant_type']) {
    const meta = TYPE_OPTIONS.find((t) => t.value === type)!;
    setRows((rs) =>
      rs.map((r) =>
        r._id === id
          ? { ...r, covenant_type: type, direction: meta.dir, threshold_unit: meta.unit, lowConfidenceFields: r.lowConfidenceFields.filter((f) => f !== 'covenant_type') }
          : r,
      ),
    );
  }

  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r._id !== id));
  }

  async function confirmAll() {
    const missing = rows.filter((r) => !r.loan_name.trim() || r.threshold === null || !Number.isFinite(r.threshold as number));
    if (missing.length > 0) {
      addToast('error', 'Each covenant needs a loan name and a threshold before confirming.');
      return;
    }
    setPhase('confirming');
    let ok = 0;
    let failed = 0;
    // The retained source document links to the FIRST covenant successfully created
    // from this agreement (a single PDF backs the whole set).
    let sourceLinked = false;
    for (const r of rows) {
      const payload = {
        loan_name: r.loan_name.trim(),
        facility: r.facility?.trim() || undefined,
        lender_name: r.lender_name?.trim() || undefined,
        location_id: locationId || null,
        covenant_type: r.covenant_type,
        threshold: Number(r.threshold),
        direction: r.direction,
        test_frequency: r.test_frequency,
        warn_headroom_pct: 0.1,
        status: 'ACTIVE',
        effective_date: r.effective_date || null,
        maturity_date: r.maturity_date || null,
        notes: r.notes?.trim() || undefined,
        measurement: r.measurement ?? {},
        source_document_id: !sourceLinked ? meta?.sourceDocumentId ?? undefined : undefined,
      };
      const res = await api.post('/api/covenants', payload);
      if (res.error) failed += 1;
      else {
        ok += 1;
        if (payload.source_document_id) sourceLinked = true;
      }
    }
    if (failed > 0) {
      addToast('error', `${ok} covenant(s) added · ${failed} failed`);
      setPhase('review');
      if (ok > 0) onConfirmed(ok);
      return;
    }
    addToast('success', `${ok} covenant${ok === 1 ? '' : 's'} added to the monitor`);
    onConfirmed(ok);
  }

  const inputCls =
    'w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';
  const flag = (r: Row, field: string) =>
    r.lowConfidenceFields.includes(field) ? 'border-amber-500/60 ring-1 ring-amber-500/30' : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="card w-full max-w-5xl max-h-[92vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Extract covenants from a loan document</h2>
              <p className="text-[11px] text-slate-500">
                Drop a credit agreement — AI proposes the covenants; you review and confirm. Nothing is saved until you confirm.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* ── Upload / parsing ─────────────────────────────────────────── */}
        {(phase === 'upload' || phase === 'parsing') && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => phase === 'upload' && fileInput.current?.click()}
            className={clsx(
              'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors',
              phase === 'parsing'
                ? 'border-indigo-500/40 bg-indigo-500/5 cursor-default'
                : dragOver
                  ? 'border-emerald-500 bg-emerald-500/5 cursor-pointer'
                  : 'border-slate-700 hover:border-slate-600 cursor-pointer',
            )}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }}
            />
            {phase === 'parsing' ? (
              <>
                <Loader2 className="w-9 h-9 text-indigo-400 animate-spin mb-3" />
                <p className="text-sm text-slate-300">Reading the agreement and extracting covenants…</p>
                <p className="text-[11px] text-slate-500 mt-1">This can take 15-30 seconds for a long document.</p>
              </>
            ) : (
              <>
                <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
                <p className="text-sm text-slate-200 font-medium">Drop a loan / credit agreement here</p>
                <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
              </>
            )}
          </div>
        )}

        {/* ── Review table ─────────────────────────────────────────────── */}
        {(phase === 'review' || phase === 'confirming') && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <FileText size={13} className="text-indigo-400" />
                <span className="truncate max-w-[240px]">{meta?.fileName}</span>
                <span className="text-slate-600">·</span>
                <span>{rows.length} covenant{rows.length === 1 ? '' : 's'} proposed</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-slate-500">Scope</label>
                <select className={clsx(inputCls, 'w-auto')} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Consolidated</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {meta?.documentNote && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                <Info size={13} className="mt-0.5 shrink-0 text-slate-500" /> {meta.documentNote}
              </div>
            )}

            {rows.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-6 py-12 text-center">
                <FileText className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                <p className="text-sm text-slate-300">No financial covenants were detected in this document.</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  You can try another document, or add a covenant manually.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {rows.map((r) => {
                  const isCurrency = r.threshold_unit === 'CURRENCY';
                  return (
                    <div key={r._id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <div className="grid grid-cols-12 gap-2">
                        <div className="col-span-4">
                          <label className="block text-[10px] text-slate-500 mb-1">Loan / facility name</label>
                          <input className={clsx(inputCls, flag(r, 'loan_name'))} value={r.loan_name} onChange={(e) => setRow(r._id, 'loan_name', e.target.value)} placeholder="Term Loan A" />
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[10px] text-slate-500 mb-1">Facility</label>
                          <input className={inputCls} value={r.facility ?? ''} onChange={(e) => setRow(r._id, 'facility', e.target.value || null)} placeholder="$25M Senior Secured" />
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[10px] text-slate-500 mb-1">Lender</label>
                          <input className={inputCls} value={r.lender_name ?? ''} onChange={(e) => setRow(r._id, 'lender_name', e.target.value || null)} placeholder="Northwest Bank" />
                        </div>
                        <div className="col-span-2 flex items-end justify-end">
                          <button onClick={() => removeRow(r._id)} className="p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-slate-800" aria-label="Remove covenant" title="Remove">
                            <Trash2 size={14} />
                          </button>
                        </div>

                        <div className="col-span-3">
                          <label className="block text-[10px] text-slate-500 mb-1">Type</label>
                          <select className={clsx(inputCls, flag(r, 'covenant_type'))} value={r.covenant_type} onChange={(e) => changeType(r._id, e.target.value as Row['covenant_type'])}>
                            {TYPE_OPTIONS.map((t) => (
                              <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] text-slate-500 mb-1">Direction</label>
                          <select className={inputCls} value={r.direction} onChange={(e) => setRow(r._id, 'direction', e.target.value as 'MIN' | 'MAX')}>
                            <option value="MIN">Min ≥</option>
                            <option value="MAX">Max ≤</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] text-slate-500 mb-1">Threshold {isCurrency ? '($)' : '(ratio)'}</label>
                          <input
                            className={clsx(inputCls, flag(r, 'threshold'))}
                            type="number"
                            step={isCurrency ? '1' : '0.01'}
                            value={r.threshold ?? ''}
                            onChange={(e) => setRow(r._id, 'threshold', e.target.value === '' ? null : Number(e.target.value))}
                            placeholder={isCurrency ? '5000000' : '1.25'}
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] text-slate-500 mb-1">Frequency</label>
                          <select className={clsx(inputCls, flag(r, 'test_frequency'))} value={r.test_frequency} onChange={(e) => setRow(r._id, 'test_frequency', e.target.value as Row['test_frequency'])}>
                            <option value="MONTHLY">Monthly</option>
                            <option value="QUARTERLY">Quarterly</option>
                            <option value="ANNUAL">Annual</option>
                          </select>
                        </div>
                        <div className="col-span-3 grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-1">Effective</label>
                            <input className={inputCls} type="date" value={r.effective_date ?? ''} onChange={(e) => setRow(r._id, 'effective_date', e.target.value || null)} />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-1">Maturity</label>
                            <input className={inputCls} type="date" value={r.maturity_date ?? ''} onChange={(e) => setRow(r._id, 'maturity_date', e.target.value || null)} />
                          </div>
                        </div>

                        {r.snippet && (
                          <div className="col-span-12">
                            <p className="text-[10px] text-slate-600 mb-0.5">Source clause</p>
                            <p className="text-[11px] text-slate-400 italic bg-slate-900/60 rounded-md px-2 py-1.5 border-l-2 border-indigo-500/40">
                              &ldquo;{r.snippet}&rdquo;
                            </p>
                          </div>
                        )}
                        {r.lowConfidenceFields.length > 0 && (
                          <div className="col-span-12 flex items-center gap-1.5 text-[10px] text-amber-400/80">
                            <AlertTriangle size={11} /> Review the highlighted field{r.lowConfidenceFields.length === 1 ? '' : 's'} — the AI was unsure or the value was not stated.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <p className="text-[11px] text-slate-600 max-w-md">
                Confirmed covenants persist through the standard covenant create path — the same validation, tenant isolation, and ledger compute as manual entry.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                <button
                  onClick={confirmAll}
                  disabled={phase === 'confirming' || rows.length === 0}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                >
                  {phase === 'confirming' && <Loader2 size={14} className="animate-spin" />}
                  Confirm {rows.length} covenant{rows.length === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
