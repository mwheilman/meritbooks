'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { dollarsToCents } from '@meritbooks/shared';
import { UploadCloud, FileText, Loader2, X, Sparkles, AlertTriangle, Info } from 'lucide-react';

/** Shape returned by /api/leases/parse (mirrors ProposedLease, payment in DOLLARS). */
interface ProposedLease {
  lessor: string | null;
  description: string | null;
  classification: 'OPERATING' | 'FINANCE';
  commencement_date: string | null;
  end_date: string | null;
  payment_dollars: number | null;
  payment_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | null;
  payment_timing: 'ARREARS' | 'ADVANCE';
  term_months: number | null;
  discount_rate: number | null;
  notes: string | null;
  snippet: string | null;
  lowConfidenceFields: string[];
}

interface ParseResponse {
  lease: ProposedLease;
  meta: { fileName: string; model: string; documentNote: string | null; decisionId: string | null; sourceDocumentId: string | null };
}

interface LocationOption {
  id: string;
  name: string;
}

/** Editable review form derived from the proposal (non-null defaults). */
interface Form {
  lessor: string;
  description: string;
  classification: 'OPERATING' | 'FINANCE';
  commencement_date: string;
  end_date: string;
  payment_dollars: string;
  payment_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  payment_timing: 'ARREARS' | 'ADVANCE';
  term_months: string;
  discount_rate_pct: string;
  notes: string;
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function toForm(p: ProposedLease): Form {
  return {
    lessor: p.lessor ?? '',
    description: p.description ?? '',
    classification: p.classification,
    commencement_date: p.commencement_date ?? '',
    end_date: p.end_date ?? '',
    payment_dollars: p.payment_dollars != null ? String(p.payment_dollars) : '',
    payment_frequency: p.payment_frequency ?? 'MONTHLY',
    payment_timing: p.payment_timing,
    term_months: p.term_months != null ? String(p.term_months) : '',
    discount_rate_pct: p.discount_rate != null ? String(+(p.discount_rate * 100).toFixed(4)) : '',
    notes: p.notes ?? '',
  };
}

export function LeaseParseReview({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [phase, setPhase] = useState<'upload' | 'parsing' | 'review' | 'saving'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ParseResponse['meta'] | null>(null);
  const [flags, setFlags] = useState<string[]>([]);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const [locationId, setLocationId] = useState<string>('');
  // Default the company to the active company (this modal lives inside a
  // company-scoped page) so the lease lands on the right entity by default.
  const { activeCompanyId } = useActiveCompany();
  useEffect(() => {
    if (!locationId && isSpecificCompany(activeCompanyId)) setLocationId(activeCompanyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompanyId]);

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
      const res = await fetch('/api/leases/parse', { method: 'POST', body: formData });
      const body = (await res.json()) as ParseResponse | { error: string };
      if (!res.ok || 'error' in body) {
        setError('error' in body ? body.error : 'Failed to parse document');
        setPhase('upload');
        return;
      }
      setMeta(body.meta);
      setDecisionId(body.meta.decisionId);
      setFlags(body.lease.lowConfidenceFields);
      setSnippet(body.lease.snippet);
      setForm(toForm(body.lease));
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

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  async function confirm() {
    if (!form) return;
    if (!locationId) {
      addToast('error', 'Choose the company/location that will carry this lease.');
      return;
    }
    const payment = dollarsToCents(form.payment_dollars);
    const term = parseInt(form.term_months, 10);
    const rate = form.discount_rate_pct === '' ? 0 : Number(form.discount_rate_pct) / 100;
    if (!form.lessor.trim()) return addToast('error', 'A lessor name is required.');
    if (!(payment > 0)) return addToast('error', 'Enter a positive payment amount.');
    if (!form.commencement_date || !form.end_date) return addToast('error', 'Commencement and end dates are required.');
    if (!Number.isInteger(term) || term <= 0) return addToast('error', 'Enter a whole-month term.');

    setPhase('saving');
    const res = await api.post('/api/leases', {
      lessor: form.lessor.trim(),
      description: form.description.trim() || undefined,
      location_id: locationId,
      classification: form.classification,
      commencement_date: form.commencement_date,
      end_date: form.end_date,
      payment_cents: payment,
      payment_frequency: form.payment_frequency,
      payment_timing: form.payment_timing,
      term_months: term,
      discount_rate: rate,
      ai_decision_id: decisionId,
      source_document_id: meta?.sourceDocumentId ?? undefined,
      notes: form.notes.trim() || undefined,
    });
    if (res.error) {
      addToast('error', res.error.error || 'Failed to create the lease.');
      setPhase('review');
      return;
    }
    addToast('success', 'Lease created — ROU asset and liability set up with the full schedule.');
    onCreated();
  }

  const inputCls =
    'w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';
  const flag = (field: string) => (flags.includes(field) ? 'border-amber-500/60 ring-1 ring-amber-500/30' : '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Set up a lease from its agreement</h2>
              <p className="text-[11px] text-slate-500">
                Drop a lease — AI proposes the terms and classification; you confirm. Nothing is booked until you confirm.
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
                <p className="text-sm text-slate-300">Reading the lease and extracting the terms…</p>
                <p className="text-[11px] text-slate-500 mt-1">This can take 15-30 seconds for a long document.</p>
              </>
            ) : (
              <>
                <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
                <p className="text-sm text-slate-200 font-medium">Drop a lease agreement here</p>
                <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
              </>
            )}
          </div>
        )}

        {(phase === 'review' || phase === 'saving') && form && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <FileText size={13} className="text-indigo-400" />
                <span className="truncate max-w-[240px]">{meta?.fileName}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-slate-500">Company</label>
                <select className={clsx(inputCls, 'w-auto')} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Select…</option>
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

            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-7">
                <label className="block text-[10px] text-slate-500 mb-1">Lessor</label>
                <input className={clsx(inputCls, flag('lessor'))} value={form.lessor} onChange={(e) => set('lessor', e.target.value)} placeholder="Prologis" />
              </div>
              <div className="col-span-5">
                <label className="block text-[10px] text-slate-500 mb-1">Classification (ASC 842)</label>
                <select className={clsx(inputCls, flag('classification'))} value={form.classification} onChange={(e) => set('classification', e.target.value as Form['classification'])}>
                  <option value="OPERATING">Operating (single lease expense)</option>
                  <option value="FINANCE">Finance (interest + amortization)</option>
                </select>
              </div>

              <div className="col-span-12">
                <label className="block text-[10px] text-slate-500 mb-1">Description</label>
                <input className={inputCls} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Warehouse — 1200 Industrial Pkwy" />
              </div>

              <div className="col-span-3">
                <label className="block text-[10px] text-slate-500 mb-1">Commencement</label>
                <input className={clsx(inputCls, flag('commencement_date'))} type="date" value={form.commencement_date} onChange={(e) => set('commencement_date', e.target.value)} />
              </div>
              <div className="col-span-3">
                <label className="block text-[10px] text-slate-500 mb-1">End date</label>
                <input className={clsx(inputCls, flag('end_date'))} type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
              </div>
              <div className="col-span-3">
                <label className="block text-[10px] text-slate-500 mb-1">Term (months)</label>
                <input className={clsx(inputCls, flag('term_months'))} type="number" min="1" step="1" value={form.term_months} onChange={(e) => set('term_months', e.target.value)} placeholder="60" />
              </div>
              <div className="col-span-3">
                <label className="block text-[10px] text-slate-500 mb-1">Discount rate (%)</label>
                <input className={clsx(inputCls, flag('discount_rate'))} type="number" min="0" step="0.01" value={form.discount_rate_pct} onChange={(e) => set('discount_rate_pct', e.target.value)} placeholder="6" />
              </div>

              <div className="col-span-4">
                <label className="block text-[10px] text-slate-500 mb-1">Payment ($ / period)</label>
                <input className={clsx(inputCls, flag('payment_amount'))} type="number" min="0" step="0.01" value={form.payment_dollars} onChange={(e) => set('payment_dollars', e.target.value)} placeholder="10000" />
              </div>
              <div className="col-span-4">
                <label className="block text-[10px] text-slate-500 mb-1">Frequency</label>
                <select className={clsx(inputCls, flag('payment_frequency'))} value={form.payment_frequency} onChange={(e) => set('payment_frequency', e.target.value as Form['payment_frequency'])}>
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="ANNUAL">Annual</option>
                </select>
              </div>
              <div className="col-span-4">
                <label className="block text-[10px] text-slate-500 mb-1">Timing</label>
                <select className={inputCls} value={form.payment_timing} onChange={(e) => set('payment_timing', e.target.value as Form['payment_timing'])}>
                  <option value="ARREARS">In arrears (period end)</option>
                  <option value="ADVANCE">In advance (period start)</option>
                </select>
              </div>

              {snippet && (
                <div className="col-span-12">
                  <p className="text-[10px] text-slate-600 mb-0.5">Source clause</p>
                  <p className="text-[11px] text-slate-400 italic bg-slate-900/60 rounded-md px-2 py-1.5 border-l-2 border-indigo-500/40">
                    &ldquo;{snippet}&rdquo;
                  </p>
                </div>
              )}
              {flags.length > 0 && (
                <div className="col-span-12 flex items-center gap-1.5 text-[10px] text-amber-400/80">
                  <AlertTriangle size={11} /> Review the highlighted field{flags.length === 1 ? '' : 's'} — the AI was unsure or the value was not stated.
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between">
              <p className="text-[11px] text-slate-600 max-w-sm">
                On confirm, MeritBooks computes the ROU asset + lease liability at present value and the full amortization schedule.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                <button
                  onClick={confirm}
                  disabled={phase === 'saving'}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                >
                  {phase === 'saving' && <Loader2 size={14} className="animate-spin" />}
                  Confirm &amp; create lease
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
