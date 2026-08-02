'use client';

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { UploadCloud, Loader2, X, Sparkles, AlertTriangle, Info } from 'lucide-react';
import type { PrepaidPrefill } from './prepaid-setup';

interface ProposedPrepaid {
  description: string | null;
  vendor_name: string | null;
  total_cents: number | null;
  term_months: number | null;
  start_date: string | null;
  end_date: string | null;
  expense_hint: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
  snippet: string | null;
}
interface ParseResponse {
  prepaid: ProposedPrepaid;
  suggestedPrepaidAccount: { id: string; name: string } | null;
  meta: { fileName: string; model: string; documentNote: string | null };
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Drop a prepaid invoice → parse via the gateway (PREPAID_EXTRACT) → hand the
 * proposed values to the setup form. Nothing persists here; the human confirms in
 * the setup modal (canon §3).
 */
export function PrepaidParseReview({
  onClose,
  onProposed,
}: {
  onClose: () => void;
  onProposed: (prefill: PrepaidPrefill) => void;
}) {
  const [phase, setPhase] = useState<'upload' | 'parsing'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const parse = useCallback(
    async (file: File) => {
      setError(null);
      setNote(null);
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
        const res = await fetch('/api/prepaid/parse', { method: 'POST', body: formData });
        const body = (await res.json()) as ParseResponse | { error: string };
        if (!res.ok || 'error' in body) {
          setError('error' in body ? body.error : 'Failed to parse document');
          setPhase('upload');
          return;
        }
        const p = body.prepaid;
        if (p.total_cents == null && body.meta.documentNote) {
          setNote(body.meta.documentNote);
          setPhase('upload');
          return;
        }
        onProposed({
          description: p.description ?? p.vendor_name,
          vendor_name: p.vendor_name,
          total_cents: p.total_cents,
          start_date: p.start_date,
          term_months: p.term_months,
          prepaid_account_id: body.suggestedPrepaidAccount?.id ?? null,
          source_type: 'PREPAID_DOC',
          origin: 'ai',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
        setPhase('upload');
      }
    },
    [onProposed],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Upload a prepaid invoice</h2>
              <p className="text-[11px] text-slate-500">
                AI reads the amount and coverage period, then pre-fills the setup form. Nothing is saved until you confirm.
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
        {note && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
            <Info size={13} className="mt-0.5 shrink-0 text-slate-500" /> {note}
          </div>
        )}

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => phase === 'upload' && fileInput.current?.click()}
          className={clsx(
            'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors',
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
              <p className="text-sm text-slate-300">Reading the invoice and extracting the prepaid terms…</p>
            </>
          ) : (
            <>
              <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
              <p className="text-sm text-slate-200 font-medium">Drop a prepaid invoice here</p>
              <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
