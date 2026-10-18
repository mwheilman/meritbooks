'use client';

import { useRef, useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, X, Sparkles, UploadCloud, FileText } from 'lucide-react';
import type { Cadence } from './subscription-editor';

interface ProposedTerms {
  vendor_name: string | null;
  product: string | null;
  category: string | null;
  amount_cents: number | null;
  billing_cadence: Cadence;
  next_renewal_date: string | null;
  auto_renews: boolean | null;
  notice_period_days: number | null;
  cancellation_method: string | null;
  cancellation_terms: string | null;
  notes: string | null;
  snippet: string | null;
  lowConfidenceFields: string[];
}

function fmtCents(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function SubscriptionParseReview({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [terms, setTerms] = useState<ProposedTerms | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, saving, onClose]);

  async function upload(file: File) {
    setBusy(true);
    setFileName(file.name);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/subscriptions/parse-agreement', { method: 'POST', body: form });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      addToast('error', body.error ?? 'Failed to parse agreement');
      return;
    }
    const body = await res.json();
    setTerms(body.terms as ProposedTerms);
    addToast('success', 'Terms extracted — review and confirm');
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  async function confirmAdd() {
    if (!terms) return;
    if (!terms.vendor_name) {
      addToast('error', 'A vendor name is required — edit it after adding if the parse missed it.');
      return;
    }
    setSaving(true);
    const res = await api.post('/api/subscriptions', {
      vendor_name: terms.vendor_name,
      product: terms.product,
      category: terms.category,
      amount_cents: terms.amount_cents ?? 0,
      billing_cadence: terms.billing_cadence,
      next_renewal_date: terms.next_renewal_date,
      status: 'ACTIVE',
      auto_renews: terms.auto_renews ?? true,
      notice_period_days: terms.notice_period_days,
      cancellation_method: terms.cancellation_method,
      cancellation_terms: terms.cancellation_terms,
      notes: terms.notes,
      source: 'PARSED',
    });
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Subscription added from agreement');
    onSaved();
  }

  const low = new Set(terms?.lowConfidenceFields ?? []);
  const rowCls = (field: string) =>
    clsx('flex justify-between gap-4 py-1.5 border-b border-slate-800 text-sm', low.has(field) && 'bg-amber-500/5');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-xl max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Upload subscription agreement">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Sparkles size={16} className="text-indigo-400" /> Upload subscription agreement
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!terms && (
          <>
            <p className="text-sm text-slate-400 mb-3">
              Drop the agreement / order form. AI extracts the exact terms — renewal date, notice period, auto-renew,
              cancellation method — for you to confirm. Nothing is written until you add it.
            </p>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={clsx(
                'cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors',
                dragOver ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-600',
              )}
            >
              {busy ? (
                <div className="flex flex-col items-center gap-2 text-slate-400">
                  <Loader2 size={26} className="animate-spin text-indigo-400" />
                  <span className="text-sm">Extracting terms…</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-slate-400">
                  <UploadCloud size={26} className="text-slate-500" />
                  <span className="text-sm">Drop a PDF or image, or click to browse</span>
                </div>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
            />
          </>
        )}

        {terms && (
          <>
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
              <FileText size={13} /> {fileName}
              {low.size > 0 && <span className="ml-auto text-amber-400">{low.size} field(s) need review</span>}
            </div>
            <div className="rounded-lg border border-slate-800 px-3">
              <div className={rowCls('vendor_name')}><span className="text-slate-500">Vendor</span><span className="text-white">{terms.vendor_name ?? '—'}</span></div>
              <div className={rowCls('product')}><span className="text-slate-500">Product</span><span className="text-white">{terms.product ?? '—'}</span></div>
              <div className={rowCls('amount_cents')}><span className="text-slate-500">Amount</span><span className="text-white font-mono">{fmtCents(terms.amount_cents)} / {terms.billing_cadence.toLowerCase()}</span></div>
              <div className={rowCls('next_renewal_date')}><span className="text-slate-500">Next renewal</span><span className="text-white">{terms.next_renewal_date ?? '—'}</span></div>
              <div className={rowCls('auto_renews')}><span className="text-slate-500">Auto-renews</span><span className="text-white">{terms.auto_renews === null ? '—' : terms.auto_renews ? 'Yes' : 'No'}</span></div>
              <div className={rowCls('notice_period_days')}><span className="text-slate-500">Notice required</span><span className="text-white">{terms.notice_period_days === null ? '—' : `${terms.notice_period_days} days`}</span></div>
              <div className={rowCls('cancellation_method')}><span className="text-slate-500">Cancel via</span><span className="text-white">{terms.cancellation_method ?? '—'}</span></div>
            </div>
            {terms.snippet && (
              <p className="mt-3 text-xs text-slate-500 italic border-l-2 border-slate-700 pl-3">“{terms.snippet}”</p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={() => setTerms(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Upload another</button>
              <button onClick={confirmAdd} disabled={saving} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
                {saving && <Loader2 size={14} className="animate-spin" />}
                Add to register
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
