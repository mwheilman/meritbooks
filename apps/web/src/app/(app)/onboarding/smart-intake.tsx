'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import {
  UploadCloud, Loader2, Sparkles, FileText, ArrowRight, AlertTriangle, HelpCircle,
} from 'lucide-react';
import { clsx } from 'clsx';

/**
 * SMART INTAKE — "drop everything, we sort it."
 *
 * A single multi-file drop zone. Each file is sent to the universal classifier
 * (`POST /api/onboarding/intake/classify`), which detects what the document is and
 * where it belongs. The user gets a queue of "this is a Loan Agreement → Continue to
 * Debt" hand-offs — no need to know which of a dozen uploaders to use. Classification
 * only READS the first page; nothing is parsed or posted here. The user continues to
 * the right domain's review flow, where AI proposes and the human confirms as always.
 */

interface Classified {
  ok: boolean;
  docType: string;
  label: string;
  confidence: number;
  route: string;
  parseEndpoint: string | null;
  note: string | null;
}

interface QueueItem {
  id: string;
  name: string;
  status: 'classifying' | 'done' | 'error';
  result?: Classified;
  error?: string;
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function confidenceTone(c: number): string {
  if (c >= 0.75) return 'text-emerald-400';
  if (c >= 0.5) return 'text-amber-400';
  return 'text-slate-400';
}

export function SmartIntake() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const classify = useCallback(async (file: File, id: string) => {
    if (!ALLOWED.includes(file.type)) {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'error', error: 'PDF or image only' } : x)));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'error', error: 'File too large (max 10MB)' } : x)));
      return;
    }
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/onboarding/intake/classify', { method: 'POST', body: fd });
      const data = (await res.json()) as Classified & { error?: string };
      if (!res.ok) {
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'error', error: data.error ?? 'Could not read that file' } : x)));
        return;
      }
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'done', result: data } : x)));
    } catch {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'error', error: 'Network error' } : x)));
    }
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const newItems: QueueItem[] = arr.map((f) => ({
      id: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: f.name,
      status: 'classifying',
    }));
    setItems((xs) => [...xs, ...newItems]);
    arr.forEach((f, i) => void classify(f, newItems[i].id));
  }, [classify]);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  return (
    <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.04] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="text-indigo-400" />
        <div>
          <p className="text-sm font-medium text-white">Or just drop everything you have</p>
          <p className="text-[11px] text-slate-500">
            Loans, leases, bills, your trial balance, operating agreement, W-9s — we detect each one and send it to the right place.
          </p>
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={clsx(
          'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center cursor-pointer transition-colors',
          dragOver ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-indigo-500/50',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,image/*"
          className="hidden"
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
        />
        <UploadCloud size={26} className="text-slate-500 mb-2" />
        <p className="text-sm text-slate-200 font-medium">Drop documents here — one or many</p>
        <p className="text-[11px] text-slate-500 mt-1">PDF or image · up to 10MB each · nothing is saved until you review it</p>
      </div>

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-3 rounded-lg border border-slate-800 bg-surface-900 px-3 py-2.5">
              <FileText size={15} className="shrink-0 text-slate-500" />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{it.name}</span>

              {it.status === 'classifying' && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
                  <Loader2 size={13} className="animate-spin text-indigo-400" /> Reading…
                </span>
              )}

              {it.status === 'error' && (
                <span className="inline-flex items-center gap-1 text-[11px] text-red-400">
                  <AlertTriangle size={12} /> {it.error}
                </span>
              )}

              {it.status === 'done' && it.result && (
                <>
                  <span className="inline-flex items-center gap-1.5 text-[11px]">
                    {it.result.docType === 'UNKNOWN'
                      ? <HelpCircle size={13} className="text-slate-500" />
                      : <Sparkles size={13} className="text-indigo-400" />}
                    <span className="text-slate-200 font-medium">{it.result.label}</span>
                    {it.result.docType !== 'UNKNOWN' && (
                      <span className={clsx('font-mono', confidenceTone(it.result.confidence))}>
                        {Math.round(it.result.confidence * 100)}%
                      </span>
                    )}
                  </span>
                  <Link
                    href={it.result.route}
                    className="shrink-0 inline-flex items-center gap-1 rounded-md bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 px-2.5 py-1 text-[11px] font-medium text-indigo-300"
                  >
                    {it.result.docType === 'UNKNOWN' ? 'Choose where it goes' : 'Continue'} <ArrowRight size={12} />
                  </Link>
                </>
              )}
            </div>
          ))}
          <p className="text-[10px] text-slate-600">
            We detect the document type; you confirm every record on the next screen. A file we can&rsquo;t place is never lost — pick a home for it.
          </p>
        </div>
      )}
    </div>
  );
}
