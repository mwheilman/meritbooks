'use client';

/** Wizard step 2 — drop a file (CSV / Excel / PDF / image) or paste the lender's email text. */

import { useId, useRef, useState, type DragEvent } from 'react';
import { clsx } from 'clsx';
import { ClipboardPaste, FileUp, Loader2, Sparkles, X } from 'lucide-react';
import type { ImportFileKind } from '@/lib/dealer/types';
import { MAX_IMPORT_BYTES } from '@/lib/dealer/imports/protocol';
import { Field, TextArea, Toggle } from '../../_components/forms';

const ACCEPT = '.csv,.xlsx,.xlsm,.txt,.tsv,.pdf,.png,.jpg,.jpeg,.webp,.gif';

function isSpreadsheet(name: string): boolean {
  return /\.(csv|xlsx|xlsm)$/i.test(name);
}

export function StepUpload({
  kind,
  busy,
  onSubmit,
}: {
  kind: ImportFileKind;
  busy: boolean;
  onSubmit: (input: { file: File | null; text: string | null; useAi: boolean }) => void;
}) {
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [useAi, setUseAi] = useState(false);
  const [drag, setDrag] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pasteId = useId();
  const aiId = useId();
  const hasAi = kind !== 'WARRANTY';

  function take(f: File | null | undefined) {
    if (!f) return;
    if (f.size > MAX_IMPORT_BYTES) {
      setProblem('That file is larger than 15 MB.');
      return;
    }
    if (/\.xls$/i.test(f.name)) {
      setProblem('Older .xls files can’t be read — save it as .xlsx or export CSV.');
      return;
    }
    setProblem(null);
    setFile(f);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDrag(false);
    take(e.dataTransfer.files?.[0]);
  }

  const ready = mode === 'file' ? !!file : text.trim().length > 0;

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="How to provide the data" className="inline-flex rounded-lg border border-slate-800 bg-surface-950 p-0.5">
        {(['file', 'paste'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={clsx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs', mode === m ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200')}
          >
            {m === 'file' ? <FileUp size={13} /> : <ClipboardPaste size={13} />}
            {m === 'file' ? 'Upload a file' : 'Paste email text'}
          </button>
        ))}
      </div>

      {mode === 'file' ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className={clsx(
            'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-10 text-center transition-colors',
            drag ? 'border-emerald-500/70 bg-emerald-500/[0.05]' : 'border-slate-700 bg-surface-950',
          )}
        >
          <FileUp size={22} className="mb-2 text-slate-500" />
          {file ? (
            <div className="flex items-center gap-2 text-sm text-white">
              <span className="font-mono">{file.name}</span>
              <span className="text-xs text-slate-500">{(file.size / 1024).toFixed(0)} KB</span>
              <button type="button" aria-label="Remove file" onClick={() => setFile(null)} className="rounded p-1 text-slate-500 hover:text-slate-200">
                <X size={13} />
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-300">Drag a file here, or</p>
          )}
          <button type="button" className="btn-secondary btn-sm mt-3" onClick={() => input.current?.click()}>
            Choose a file
          </button>
          <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label="Choose a file to import" onChange={(e) => take(e.target.files?.[0])} />
          <p className="mt-3 text-xs text-slate-500">CSV or Excel (.xlsx) map column by column without AI. PDFs and photos are read by AI. Up to 15 MB.</p>
        </div>
      ) : (
        <Field label="Paste the statement or audit table from the email" htmlFor={pasteId} hint="Tables copied from an email or a spreadsheet map without AI; plain text is read by AI.">
          <TextArea id={pasteId} value={text} onChange={setText} rows={10} placeholder="Paste the email body here…" maxLength={400_000} />
        </Field>
      )}

      {hasAi && ((mode === 'file' && file && isSpreadsheet(file.name)) || mode === 'paste') && (
        <label htmlFor={aiId} className="flex items-center gap-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.04] px-3 py-2 text-sm text-slate-300">
          <Toggle id={aiId} checked={useAi} onChange={setUseAi} label="Have the AI read it" />
          <span className="flex items-center gap-1.5">
            <Sparkles size={13} className="text-indigo-300" /> Have the AI read it instead of mapping columns (for messy layouts). You still review every line.
          </span>
        </label>
      )}

      {problem && <p className="text-sm text-amber-300" role="alert">{problem}</p>}

      <div className="flex justify-end">
        <button
          type="button"
          className="btn-primary btn-sm inline-flex items-center gap-1.5"
          disabled={!ready || busy}
          onClick={() => onSubmit({ file: mode === 'file' ? file : null, text: mode === 'paste' ? text : null, useAi })}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {busy ? 'Reading…' : 'Read the file'}
        </button>
      </div>
    </div>
  );
}
