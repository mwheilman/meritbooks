'use client';

import { useState, useRef, useEffect } from 'react';
import { Download, Loader2, ChevronDown, FileText, Sheet } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { resolveExportSpec, type ExportMeta } from '@/lib/reports/export/build-model';
import { toCsv, downloadBlob } from '@/lib/reports/export/csv';
import { buildExportFilename } from '@/lib/reports/export/statement-model';

/**
 * Export the currently-viewed statement (PDF or CSV) for the active
 * report + period + company/consolidation filters. It re-fetches the SAME
 * endpoint the on-screen table uses (so the export ties to what the user sees),
 * builds a normalized StatementModel, then either writes CSV in-browser or POSTs
 * the model to the server PDF renderer. Wires FPB Dimension 7's dead buttons.
 */
export function ExportMenu({
  reportKey, sd, ed, locIds, basis, reportLabel, entityLabel, periodLabel, basisLabel,
}: {
  reportKey: string;
  sd: string;
  ed: string;
  locIds: string;
  basis: string;
  reportLabel: string;
  entityLabel: string;
  periodLabel: string;
  basisLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const spec = resolveExportSpec(reportKey, { sd, ed, locIds, basis });
  const disabled = !spec;

  async function run(fmt: 'pdf' | 'csv') {
    if (!spec || busy) return;
    setOpen(false);
    setBusy(fmt);
    try {
      // 1. Re-fetch the exact report payload the viewer renders.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await api.get<any>(spec.url, spec.query);
      if (res.error || !res.data) {
        throw new Error(res.error?.error ?? 'Could not load report data.');
      }

      // 2. Project it into the normalized statement model.
      const meta: ExportMeta = { reportLabel, entityLabel, periodLabel, basisLabel, accent: '#10b981' };
      const model = spec.build(res.data, meta);

      if (!model.rows.some((r) => r.kind === 'account' || r.kind === 'total')) {
        addToast('error', 'Nothing to export for the selected filters.');
        return;
      }

      // 3a. CSV — built and downloaded entirely client-side.
      if (fmt === 'csv') {
        const blob = new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8' });
        downloadBlob(blob, buildExportFilename(model.title, 'csv'));
        addToast('success', 'CSV exported.');
        return;
      }

      // 3b. PDF — server renders via @react-pdf/renderer (kept out of the client bundle).
      const resp = await fetch('/api/reports/export/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      });
      if (!resp.ok) {
        let msg = 'PDF export failed.';
        try { const j = await resp.json(); msg = j.error ?? msg; } catch { /* binary/no-body */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      downloadBlob(blob, buildExportFilename(model.title, 'pdf'));
      addToast('success', 'PDF exported.');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy !== null}
        title={disabled ? 'Export not available for this report' : 'Export this statement'}
        className="btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {busy === 'pdf' ? 'Building PDF…' : busy === 'csv' ? 'Building CSV…' : 'Export'}
        {!busy && <ChevronDown size={12} className="text-slate-500" />}
      </button>

      {open && !disabled && (
        <div className="absolute top-full right-0 mt-1 w-44 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 py-1">
          <button onClick={() => run('pdf')} className={clsx('w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 transition-colors')}>
            <FileText size={13} className="text-emerald-400" /> PDF (branded)
          </button>
          <button onClick={() => run('csv')} className={clsx('w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 transition-colors')}>
            <Sheet size={13} className="text-emerald-400" /> Excel (CSV)
          </button>
        </div>
      )}
    </div>
  );
}
