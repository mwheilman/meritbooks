'use client';

/**
 * Export the dealer report on screen. The model came back with the report, so the
 * file is exactly what the person is looking at: CSV is written in the browser;
 * XLSX and PDF are rendered by the existing server routes from the same model
 * (the same pipeline as the reports page's export menu).
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileText, Loader2, Sheet, Table } from 'lucide-react';
import { addToast } from '@/hooks/use-toast';
import { buildStatementSummary } from '@/lib/reports/export/build-model';
import { downloadBlob, toCsv } from '@/lib/reports/export/csv';
import { buildExportFilename, type StatementModel } from '@/lib/reports/export/statement-model';

type Fmt = 'xlsx' | 'csv' | 'pdf';

export function DealerExportMenu({ model, disabled }: { model: StatementModel | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Fmt | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const empty = !model || !model.rows.some((r) => r.kind === 'account' || r.kind === 'total' || r.kind === 'subtotal');

  async function run(fmt: Fmt) {
    if (!model || busy) return;
    setOpen(false);
    if (empty) {
      addToast('error', 'Nothing to export for the selected period.');
      return;
    }
    setBusy(fmt);
    try {
      if (fmt === 'csv') {
        downloadBlob(new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8' }), buildExportFilename(model.title, 'csv'));
        addToast('success', 'CSV exported.');
        return;
      }
      const payload: unknown = fmt === 'xlsx' && model.columns.length > 1 ? { title: model.title, sheets: [buildStatementSummary(model), model] } : model;
      const resp = await fetch(fmt === 'xlsx' ? '/api/reports/export/xlsx' : '/api/reports/export/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let msg = `${fmt.toUpperCase()} export failed.`;
        try {
          const j = (await resp.json()) as { error?: string };
          msg = j.error ?? msg;
        } catch {
          /* binary / empty body */
        }
        throw new Error(msg);
      }
      downloadBlob(await resp.blob(), buildExportFilename(model.title, fmt));
      addToast('success', `${fmt === 'xlsx' ? 'Excel workbook' : 'PDF'} exported.`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !model || busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-secondary btn-sm flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {busy === 'pdf' ? 'Building PDF…' : busy === 'xlsx' ? 'Building Excel…' : busy === 'csv' ? 'Building CSV…' : 'Export'}
        {!busy && <ChevronDown size={12} className="text-slate-500" />}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl">
          <button role="menuitem" type="button" onClick={() => run('xlsx')} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 focus:bg-slate-800 focus:outline-none">
            <Sheet size={13} className="text-emerald-400" /> Excel (.xlsx)
          </button>
          <button role="menuitem" type="button" onClick={() => run('csv')} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 focus:bg-slate-800 focus:outline-none">
            <Table size={13} className="text-emerald-400" /> CSV (raw data)
          </button>
          <div className="my-1 border-t border-slate-800" />
          <button role="menuitem" type="button" onClick={() => run('pdf')} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 focus:bg-slate-800 focus:outline-none">
            <FileText size={13} className="text-emerald-400" /> PDF (branded)
          </button>
        </div>
      )}
    </div>
  );
}
