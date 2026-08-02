'use client';

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  UploadCloud, Loader2, X, Sparkles, AlertTriangle, Info, FileText,
} from 'lucide-react';
import { DebtForm, type DebtFormInitial } from './debt-form';

type Frequency = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

interface ProposedLoan {
  loan_name: string;
  lender: string | null;
  facility: string | null;
  principal: number | null;
  interest_rate: number | null;
  rate_type: 'FIXED' | 'VARIABLE';
  amortization_method: 'AMORTIZING' | 'INTEREST_ONLY';
  payment_frequency: Frequency;
  term_periods: number | null;
  payment: number | null;
  origination_date: string | null;
  maturity_date: string | null;
  notes: string | null;
  snippet: string | null;
  lowConfidenceFields: string[];
}

interface ParseResponse {
  loan: ProposedLoan;
  meta: { fileName: string; model: string; documentNote: string | null };
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function DebtParseReview({ onClose, onConfirmed }: { onClose: () => void; onConfirmed: () => void }) {
  const [phase, setPhase] = useState<'upload' | 'parsing' | 'review'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ParseResponse['meta'] | null>(null);
  const [initial, setInitial] = useState<DebtFormInitial | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const parse = useCallback(async (file: File) => {
    setError(null);
    if (!ALLOWED.includes(file.type)) { setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('File too large. Maximum 10MB.'); return; }
    setPhase('parsing');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/debt/parse', { method: 'POST', body: formData });
      const body = (await res.json()) as ParseResponse | { error: string };
      if (!res.ok || 'error' in body) {
        setError('error' in body ? body.error : 'Failed to parse document');
        setPhase('upload');
        return;
      }
      const l = body.loan;
      setMeta(body.meta);
      setSnippet(l.snippet);
      setInitial({
        loan_name: l.loan_name,
        lender: l.lender,
        facility: l.facility,
        principal_dollars: l.principal,
        interest_rate: l.interest_rate,
        rate_type: l.rate_type,
        amortization_method: l.amortization_method,
        payment_frequency: l.payment_frequency,
        term_periods: l.term_periods,
        payment_dollars: l.payment,
        origination_date: l.origination_date,
        maturity_date: l.maturity_date,
        notes: l.notes,
        lowConfidenceFields: l.lowConfidenceFields,
      });
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-4xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Add a loan from a document</h2>
              <p className="text-[11px] text-slate-500">
                Drop a loan agreement — AI proposes the terms; you review and confirm. Nothing is saved until you confirm.
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
                <p className="text-sm text-slate-300">Reading the loan document and extracting terms…</p>
                <p className="text-[11px] text-slate-500 mt-1">This can take 15-30 seconds for a long document.</p>
              </>
            ) : (
              <>
                <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
                <p className="text-sm text-slate-200 font-medium">Drop a loan / promissory note here</p>
                <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
              </>
            )}
          </div>
        )}

        {phase === 'review' && initial && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <FileText size={13} className="text-indigo-400" />
              <span className="truncate max-w-[280px]">{meta?.fileName}</span>
              {initial.lowConfidenceFields && initial.lowConfidenceFields.length > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-400/80">
                  <AlertTriangle size={11} /> review highlighted fields
                </span>
              )}
            </div>
            {meta?.documentNote && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                <Info size={13} className="mt-0.5 shrink-0 text-slate-500" /> {meta.documentNote}
              </div>
            )}
            {snippet && (
              <p className="mb-4 text-[11px] text-slate-400 italic bg-slate-900/60 rounded-md px-2 py-1.5 border-l-2 border-indigo-500/40">
                &ldquo;{snippet}&rdquo;
              </p>
            )}
            <DebtForm initial={initial} onClose={onClose} onSaved={onConfirmed} />
          </>
        )}
      </div>
    </div>
  );
}
