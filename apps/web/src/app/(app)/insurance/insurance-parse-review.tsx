'use client';

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { UploadCloud, FileText, Loader2, X, Trash2, Sparkles, AlertTriangle, Info } from 'lucide-react';

/** Mirrors ProposedPolicy from lib/insurance/parse-policy. Amounts are cents. */
interface ProposedPolicy {
  carrier: string | null;
  policy_number: string | null;
  coverage_type: 'GL' | 'PROPERTY' | 'AUTO' | 'WC' | 'CYBER' | 'UMBRELLA' | 'PROFESSIONAL' | 'OTHER';
  coverage_limit_cents: number | null;
  deductible_cents: number | null;
  premium_cents: number | null;
  premium_frequency: 'ANNUAL' | 'SEMIANNUAL' | 'QUARTERLY' | 'MONTHLY' | 'ONE_TIME';
  effective_date: string | null;
  expiration_date: string | null;
  broker: string | null;
  notes: string | null;
  snippet: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

interface ParseResponse {
  policies: ProposedPolicy[];
  meta: { fileName: string; model: string; documentNote: string | null; policyCount: number };
}

interface Row extends ProposedPolicy {
  _id: string;
}

const COVERAGE_OPTIONS: { value: Row['coverage_type']; label: string }[] = [
  { value: 'GL', label: 'General liability' },
  { value: 'PROPERTY', label: 'Property' },
  { value: 'AUTO', label: 'Auto' },
  { value: 'WC', label: 'Workers comp' },
  { value: 'CYBER', label: 'Cyber' },
  { value: 'UMBRELLA', label: 'Umbrella' },
  { value: 'PROFESSIONAL', label: 'Professional' },
  { value: 'OTHER', label: 'Other' },
];

const FREQ_OPTIONS: { value: Row['premium_frequency']; label: string }[] = [
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'SEMIANNUAL', label: 'Semiannual' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'ONE_TIME', label: 'One-time' },
];

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let ROW_SEQ = 0;
function toRow(p: ProposedPolicy): Row {
  ROW_SEQ += 1;
  return { ...p, _id: `r${ROW_SEQ}` };
}

/** Cents → editable whole-dollar string ('' when null). */
function centsToDollarStr(cents: number | null): string {
  return cents === null ? '' : String(Math.round(cents) / 100);
}
/** Whole-dollar string → cents (null when blank/invalid). */
function dollarStrToCents(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function InsuranceParseReview({
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
      const res = await fetch('/api/insurance/parse', { method: 'POST', body: formData });
      const body = (await res.json()) as ParseResponse | { error: string };
      if (!res.ok || 'error' in body) {
        setError('error' in body ? body.error : 'Failed to parse document');
        setPhase('upload');
        return;
      }
      setMeta(body.meta);
      setRows(body.policies.map(toRow));
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

  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r._id !== id));
  }

  async function confirmAll() {
    setPhase('confirming');
    let ok = 0;
    let failed = 0;
    for (const r of rows) {
      const payload = {
        carrier: r.carrier?.trim() || null,
        policy_number: r.policy_number?.trim() || null,
        coverage_type: r.coverage_type,
        coverage_limit_cents: r.coverage_limit_cents,
        deductible_cents: r.deductible_cents,
        premium_cents: r.premium_cents,
        premium_frequency: r.premium_frequency,
        effective_date: r.effective_date || null,
        expiration_date: r.expiration_date || null,
        status: 'ACTIVE' as const,
        broker: r.broker?.trim() || null,
        notes: r.notes?.trim() || null,
      };
      const res = await api.post('/api/insurance', payload);
      if (res.error) failed += 1;
      else ok += 1;
    }
    if (failed > 0) {
      addToast('error', `${ok} policy(ies) added · ${failed} failed`);
      setPhase('review');
      if (ok > 0) onConfirmed(ok);
      return;
    }
    addToast('success', `${ok} polic${ok === 1 ? 'y' : 'ies'} added to the register`);
    onConfirmed(ok);
  }

  const inputCls =
    'w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';
  const flag = (r: Row, field: string) =>
    r.lowConfidenceFields.includes(field) ? 'border-amber-500/60 ring-1 ring-amber-500/30' : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-5xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Extract policies from an insurance document</h2>
              <p className="text-[11px] text-slate-500">
                Drop a policy or declarations page — AI proposes the terms; you review and confirm. Nothing is saved until you confirm.
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
                <p className="text-sm text-slate-300">Reading the policy and extracting terms…</p>
                <p className="text-[11px] text-slate-500 mt-1">This can take 15-30 seconds for a long document.</p>
              </>
            ) : (
              <>
                <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
                <p className="text-sm text-slate-200 font-medium">Drop an insurance policy / declarations page here</p>
                <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
              </>
            )}
          </div>
        )}

        {/* ── Review ───────────────────────────────────────────────────── */}
        {(phase === 'review' || phase === 'confirming') && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <FileText size={13} className="text-indigo-400" />
                <span className="truncate max-w-[240px]">{meta?.fileName}</span>
                <span className="text-slate-600">·</span>
                <span>{rows.length} polic{rows.length === 1 ? 'y' : 'ies'} proposed</span>
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
                <p className="text-sm text-slate-300">No insurance policy was detected in this document.</p>
                <p className="text-[11px] text-slate-500 mt-1">Try another document, or add a policy manually.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {rows.map((r) => (
                  <div key={r._id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                    <div className="grid grid-cols-12 gap-2">
                      <div className="col-span-4">
                        <label className="block text-[10px] text-slate-500 mb-1">Carrier</label>
                        <input className={clsx(inputCls, flag(r, 'carrier'))} value={r.carrier ?? ''} onChange={(e) => setRow(r._id, 'carrier', e.target.value || null)} placeholder="The Hartford" />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Policy #</label>
                        <input className={inputCls} value={r.policy_number ?? ''} onChange={(e) => setRow(r._id, 'policy_number', e.target.value || null)} placeholder="GL-99123" />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Coverage</label>
                        <select className={clsx(inputCls, flag(r, 'coverage_type'))} value={r.coverage_type} onChange={(e) => setRow(r._id, 'coverage_type', e.target.value as Row['coverage_type'])}>
                          {COVERAGE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                        </select>
                      </div>
                      <div className="col-span-2 flex items-end justify-end">
                        <button onClick={() => removeRow(r._id)} className="p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-slate-800" aria-label="Remove policy" title="Remove">
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Limit ($)</label>
                        <input className={clsx(inputCls, flag(r, 'coverage_limit'))} type="number" step="1" value={centsToDollarStr(r.coverage_limit_cents)} onChange={(e) => setRow(r._id, 'coverage_limit_cents', dollarStrToCents(e.target.value))} placeholder="1000000" />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Deductible ($)</label>
                        <input className={inputCls} type="number" step="1" value={centsToDollarStr(r.deductible_cents)} onChange={(e) => setRow(r._id, 'deductible_cents', dollarStrToCents(e.target.value))} placeholder="5000" />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Premium ($)</label>
                        <input className={clsx(inputCls, flag(r, 'premium'))} type="number" step="1" value={centsToDollarStr(r.premium_cents)} onChange={(e) => setRow(r._id, 'premium_cents', dollarStrToCents(e.target.value))} placeholder="18000" />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Frequency</label>
                        <select className={inputCls} value={r.premium_frequency} onChange={(e) => setRow(r._id, 'premium_frequency', e.target.value as Row['premium_frequency'])}>
                          {FREQ_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                        </select>
                      </div>

                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Effective</label>
                        <input className={inputCls} type="date" value={r.effective_date ?? ''} onChange={(e) => setRow(r._id, 'effective_date', e.target.value || null)} />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-500 mb-1">Expiration</label>
                        <input className={clsx(inputCls, flag(r, 'expiration_date'))} type="date" value={r.expiration_date ?? ''} onChange={(e) => setRow(r._id, 'expiration_date', e.target.value || null)} />
                      </div>
                      <div className="col-span-6">
                        <label className="block text-[10px] text-slate-500 mb-1">Broker</label>
                        <input className={inputCls} value={r.broker ?? ''} onChange={(e) => setRow(r._id, 'broker', e.target.value || null)} placeholder="Marsh" />
                      </div>

                      {r.snippet && (
                        <div className="col-span-12">
                          <p className="text-[10px] text-slate-600 mb-0.5">Source line</p>
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
                ))}
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <p className="text-[11px] text-slate-600 max-w-md">
                Confirmed policies persist through the standard create path — the same validation and tenant isolation as manual entry.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                <button
                  onClick={confirmAll}
                  disabled={phase === 'confirming' || rows.length === 0}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                >
                  {phase === 'confirming' && <Loader2 size={14} className="animate-spin" />}
                  Confirm {rows.length} polic{rows.length === 1 ? 'y' : 'ies'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
