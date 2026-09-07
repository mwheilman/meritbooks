'use client';

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Upload, Loader2, X, FileSpreadsheet, CheckCircle2, AlertTriangle } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { addToast } from '@/hooks';

/**
 * Self-contained "Import budget (CSV/XLSX)" affordance for the Budget Entry grid.
 * Uploads the file to POST /api/budgets/import — first as a dry run to preview the
 * mapping (layout, matched vs unmatched accounts, footing, errors), then, on confirm,
 * writes the folded monthly cells into public.budgets. Reloads the grid on success.
 */

interface MatchedAccount { accountNumber: string; accountName: string; annualCents: number }
interface ColumnMapping { account: string; annual: string; months: string[] }
interface Preview {
  ok: boolean;
  dryRun?: boolean;
  layout: 'monthly' | 'annual';
  fileName: string;
  fiscalYear: number;
  columns: ColumnMapping;
  parsedTotalCents: number;
  matchedTotalCents: number;
  rowCount: number;
  accountCount: number;
  matched: MatchedAccount[];
  unmatched: string[];
  cellsToWrite: number;
  errors: { row: number; message: string }[];
  error?: string;
}

export function BudgetImport({ locationId, fiscalYear, departmentId, onImported }: {
  locationId: string;
  fiscalYear: number;
  departmentId: string | null;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setPreview(null);
    setFileName(null);
    fileRef.current = null;
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const post = useCallback(async (file: File, dryRun: boolean): Promise<Preview | null> => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('companyId', locationId);
    fd.append('fiscalYear', String(fiscalYear));
    if (departmentId) fd.append('departmentId', departmentId);
    fd.append('dryRun', dryRun ? 'true' : 'false');
    const res = await fetch('/api/budgets/import', { method: 'POST', body: fd });
    const json = (await res.json().catch(() => null)) as (Preview & { error?: string }) | null;
    if (!res.ok) {
      addToast('error', json?.error ?? `Import failed (${res.status})`);
      return json && 'layout' in json ? json : null; // 422 previews still carry detail
    }
    return json;
  }, [locationId, fiscalYear, departmentId]);

  const onSelectFile = useCallback(async (file: File) => {
    fileRef.current = file;
    setFileName(file.name);
    setBusy(true);
    const p = await post(file, true);
    setBusy(false);
    if (p) setPreview(p);
  }, [post]);

  const confirm = useCallback(async () => {
    if (!fileRef.current) return;
    setBusy(true);
    const res = await post(fileRef.current, false);
    setBusy(false);
    if (res && res.ok) {
      addToast('success', `Imported ${res.cellsToWrite ?? 0} budget cells across ${res.matched?.length ?? res.accountCount} accounts.`);
      setOpen(false);
      reset();
      onImported();
    } else if (res) {
      setPreview(res); // show blocking errors
    }
  }, [post, reset, onImported]);

  const canWrite = !!preview && preview.errors.length === 0 && preview.matched.length > 0;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={!locationId}
        title={locationId ? 'Import a budget spreadsheet' : 'Select a company first'}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Upload size={12} /> Import budget
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && (setOpen(false), reset())}>
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <FileSpreadsheet size={16} className="text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">Import budget (CSV / XLSX)</h2>
              </div>
              <button onClick={() => { setOpen(false); reset(); }} disabled={busy} className="text-slate-500 hover:text-white disabled:opacity-40"><X size={16} /></button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-400">
                FY {fiscalYear}{departmentId ? ' · department' : ' · company-level'}. Provide an <span className="text-slate-200">Account</span> column (number or name) plus either
                twelve monthly columns (Jan…Dec) or a single Annual/Total column. Amounts in dollars. Re-importing overwrites the same cells.
              </p>

              {/* Dropzone / file picker */}
              <label
                className="flex flex-col items-center justify-center gap-2 py-7 rounded-xl border-2 border-dashed border-slate-700 hover:border-emerald-500/60 cursor-pointer transition-colors"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onSelectFile(f); }}
              >
                <Upload size={20} className="text-slate-500" />
                <span className="text-xs text-slate-400">{fileName ?? 'Drop a .csv or .xlsx file, or click to choose'}</span>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onSelectFile(f); }}
                />
              </label>

              {busy && !preview && (
                <div className="flex items-center justify-center gap-2 py-3 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading file…</div>
              )}

              {/* Preview */}
              {preview && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Stat label="Layout" value={preview.layout === 'monthly' ? 'Monthly' : 'Annual'} />
                    <Stat label="Accounts matched" value={`${preview.matched.length}/${preview.accountCount}`} />
                    <Stat label="Cells to write" value={String(preview.cellsToWrite)} />
                    <Stat label="Matched total" value={formatMoney(preview.matchedTotalCents)} mono />
                  </div>

                  <div className="text-2xs text-slate-500">
                    Mapped: <span className="text-slate-300">Account = “{preview.columns.account || '—'}”</span>
                    {preview.layout === 'annual'
                      ? <> · <span className="text-slate-300">Annual = “{preview.columns.annual || '—'}”</span></>
                      : <> · <span className="text-slate-300">{preview.columns.months.filter(Boolean).length} monthly columns</span></>}
                  </div>

                  {preview.errors.length > 0 && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-red-400 mb-1.5"><AlertTriangle size={13} /> {preview.errors.length} issue{preview.errors.length === 1 ? '' : 's'} — fix and re-upload</div>
                      <ul className="space-y-0.5 max-h-28 overflow-y-auto">
                        {preview.errors.slice(0, 20).map((e, i) => (
                          <li key={i} className="text-2xs text-red-300/90">{e.row > 0 ? `Row ${e.row}: ` : ''}{e.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {preview.unmatched.length > 0 && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400 mb-1"><AlertTriangle size={13} /> {preview.unmatched.length} account{preview.unmatched.length === 1 ? '' : 's'} not in the chart of accounts (skipped)</div>
                      <p className="text-2xs text-amber-300/80">{preview.unmatched.slice(0, 12).join(', ')}{preview.unmatched.length > 12 ? '…' : ''}</p>
                    </div>
                  )}

                  {canWrite && (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle2 size={13} /> Ready to import {preview.cellsToWrite} cells for {preview.matched.length} accounts.</div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button onClick={() => { setOpen(false); reset(); }} disabled={busy} className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-600 disabled:opacity-40">Cancel</button>
              <button
                onClick={confirm}
                disabled={busy || !canWrite}
                className={clsx('flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  canWrite && !busy ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700')}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {busy ? 'Importing…' : 'Import budget'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-800/40 border border-slate-800 px-2.5 py-2">
      <div className="text-2xs uppercase text-slate-500">{label}</div>
      <div className={clsx('text-xs text-slate-200 mt-0.5', mono && 'font-mono')}>{value}</div>
    </div>
  );
}
