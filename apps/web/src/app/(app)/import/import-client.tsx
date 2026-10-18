'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Upload, Database, BookOpen, ArrowRight, ArrowLeft, Check, AlertTriangle,
  Loader2, FileSpreadsheet, CircleCheck,
} from 'lucide-react';
import { IMPORT_TYPES, getImportType, type ImportTypeDef } from '@/lib/import/definitions';
import { parseCsv, autoMap, type ParsedCsv } from '@/lib/import/csv';

interface Company { id: string; name: string; short_code: string }
interface ApiResult {
  ok: boolean;
  inserted?: number;
  willInsert?: number;
  lines?: number;
  skipped?: number;
  errors?: { row: number; message: string }[];
  destination?: string;
  entryNumber?: string;
  error?: string;
}

type Step = 'select' | 'upload' | 'map' | 'review' | 'done';

const NONE = '__none__';

export default function ImportClient() {
  const [step, setStep] = useState<Step>('select');
  const [def, setDef] = useState<ImportTypeDef | null>(null);
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [asOfDate, setAsOfDate] = useState('');
  const [preview, setPreview] = useState<ApiResult | null>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setCompanies(Array.isArray(d) ? d : []))
      .catch(() => setCompanies([]));
  }, []);

  const masterTypes = IMPORT_TYPES.filter((t) => t.target === 'core');
  const ledgerTypes = IMPORT_TYPES.filter((t) => t.target === 'books');

  const reset = useCallback(() => {
    setStep('select'); setDef(null); setCsv(null); setFileName('');
    setMapping({}); setCompanyId(''); setAsOfDate(''); setPreview(null);
    setResult(null); setError('');
  }, []);

  const pickType = (t: ImportTypeDef) => { reset(); setDef(getImportType(t.key) ?? null); setStep('upload'); };

  const onFile = useCallback(async (file: File) => {
    setError('');
    if (!def) return;
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError('That file has no data rows. Make sure the first line is a header row.');
        return;
      }
      setCsv(parsed);
      setFileName(file.name);
      setMapping(autoMap(parsed.headers, def.fields));
      setStep('map');
    } catch {
      setError('Could not read that file. Please upload a .csv file.');
    }
  }, [def]);

  const mappingComplete = useMemo(() => {
    if (!def) return false;
    const reqOk = def.fields.filter((f) => f.required).every((f) => mapping[f.key] && mapping[f.key] !== NONE);
    const companyOk = !def.requiresCompany || !!companyId;
    const dateOk = !def.requiresAsOfDate || !!asOfDate;
    return reqOk && companyOk && dateOk;
  }, [def, mapping, companyId, asOfDate]);

  const callApi = useCallback(async (dryRun: boolean): Promise<ApiResult> => {
    const cleanMapping: Record<string, string> = {};
    Object.entries(mapping).forEach(([k, v]) => { if (v && v !== NONE) cleanMapping[k] = v; });
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: def!.key, mapping: cleanMapping, rows: csv!.rows,
        companyId: def!.requiresCompany ? companyId : undefined,
        asOfDate: def!.requiresAsOfDate ? asOfDate : undefined,
        dryRun,
      }),
    });
    const data = (await res.json()) as ApiResult;
    if (!res.ok && data.error) throw new Error(data.error);
    return data;
  }, [def, csv, mapping, companyId, asOfDate]);

  const runReview = async () => {
    setBusy(true); setError('');
    try { setPreview(await callApi(true)); setStep('review'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Validation failed'); }
    finally { setBusy(false); }
  };

  const runCommit = async () => {
    setBusy(true); setError('');
    try { setResult(await callApi(false)); setStep('done'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Import failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-4xl mx-auto pb-16">
      <Stepper step={step} />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {/* STEP 1 — SELECT TYPE */}
      {step === 'select' && (
        <div className="space-y-6">
          <TypeGroup
            title="Master data" sub="Lands in the shared Suite Core layer — referenced by every module."
            icon={<Database size={15} className="text-brand-400" />} types={masterTypes} onPick={pickType}
          />
          <TypeGroup
            title="Ledger data" sub="Lands in the MeritBooks ledger (Books). Posts against a chosen company."
            icon={<BookOpen size={15} className="text-brand-400" />} types={ledgerTypes} onPick={pickType}
          />
        </div>
      )}

      {/* STEP 2 — UPLOAD */}
      {step === 'upload' && def && (
        <div>
          <BackBtn onClick={() => setStep('select')} label="Choose a different type" />
          <h2 className="text-lg font-semibold text-white mb-1">{def.label}</h2>
          <p className="text-sm text-slate-400 mb-5">{def.description} <span className="text-slate-500">→ {def.destination}</span></p>
          <label className="block cursor-pointer rounded-xl border-2 border-dashed border-slate-700 hover:border-brand-500/60 bg-surface-900 px-6 py-12 text-center transition-colors">
            <input type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            <Upload size={28} className="mx-auto mb-3 text-slate-500" />
            <p className="text-sm text-slate-300 font-medium">Drop a CSV here or click to browse</p>
            <p className="text-xs text-slate-500 mt-1">First row must be column headers. Up to 10,000 rows.</p>
          </label>
          <FieldHint def={def} />
        </div>
      )}

      {/* STEP 3 — MAP */}
      {step === 'map' && def && csv && (
        <div>
          <BackBtn onClick={() => setStep('upload')} label="Upload a different file" />
          <div className="flex items-center gap-2 text-sm text-slate-400 mb-4">
            <FileSpreadsheet size={15} /> <span className="text-slate-300">{fileName}</span>
            <span className="text-slate-600">·</span> <span>{csv.rows.length} rows</span>
          </div>

          {(def.requiresCompany || def.requiresAsOfDate) && (
            <div className="grid grid-cols-2 gap-3 mb-5">
              {def.requiresCompany && (
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Post to company</label>
                  <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white">
                    <option value="">Select a company…</option>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.short_code})</option>)}
                  </select>
                  {companies.length === 0 && <p className="text-2xs text-amber-400 mt-1">No companies yet — import Companies/Entities first.</p>}
                </div>
              )}
              {def.requiresAsOfDate && (
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Balances as of</label>
                  <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white" />
                </div>
              )}
            </div>
          )}

          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Match your columns</p>
          <div className="rounded-xl border border-slate-800 divide-y divide-slate-800 overflow-hidden">
            {def.fields.map((f) => (
              <div key={f.key} className="flex items-center gap-3 px-4 py-2.5 bg-surface-900">
                <div className="w-1/2">
                  <span className="text-sm text-slate-200">{f.label}</span>
                  {f.required && <span className="text-rose-400 ml-1">*</span>}
                  {f.help && <p className="text-2xs text-slate-500">{f.help}</p>}
                </div>
                <ArrowRight size={14} className="text-slate-600 shrink-0" />
                <select value={mapping[f.key] || NONE}
                  onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                  className="flex-1 rounded-lg border border-slate-700 bg-surface-950 px-2.5 py-1.5 text-sm text-white">
                  <option value={NONE}>— Not mapped —</option>
                  {csv.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>

          <button disabled={!mappingComplete || busy} onClick={runReview}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Validate {csv.rows.length} rows
          </button>
          {!mappingComplete && <p className="text-2xs text-slate-500 mt-2">Map all required fields{def.requiresCompany ? ' and pick a company' : ''} to continue.</p>}
        </div>
      )}

      {/* STEP 4 — REVIEW */}
      {step === 'review' && def && preview && (
        <div>
          <BackBtn onClick={() => setStep('map')} label="Adjust mapping" />
          <h2 className="text-lg font-semibold text-white mb-4">Review</h2>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <Stat label="Will import" value={preview.willInsert ?? 0} tone="ok" />
            <Stat label="Skipped (duplicates)" value={preview.skipped ?? 0} tone="muted" />
            <Stat label="Errors" value={preview.errors?.length ?? 0} tone={preview.errors?.length ? 'bad' : 'muted'} />
          </div>
          <p className="text-xs text-slate-500 mb-4">Destination: <span className="font-mono text-slate-400">{preview.destination}</span></p>

          {preview.errors && preview.errors.length > 0 && (
            <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/5 max-h-64 overflow-y-auto">
              {preview.errors.map((e, i) => (
                <div key={i} className="flex gap-3 px-4 py-2 text-sm border-b border-rose-500/10 last:border-0">
                  <span className="text-rose-400/70 font-mono text-xs w-12 shrink-0">{e.row ? `Row ${e.row}` : '—'}</span>
                  <span className="text-rose-200/90">{e.message}</span>
                </div>
              ))}
            </div>
          )}

          <button
            disabled={busy || !preview.ok || (preview.willInsert ?? 0) === 0}
            onClick={runCommit}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
            Import {preview.willInsert ?? 0} records
          </button>
          {!preview.ok && <p className="text-2xs text-amber-400 mt-2">Fix the errors above (edit your CSV and re-upload) before importing.</p>}
        </div>
      )}

      {/* STEP 5 — DONE */}
      {step === 'done' && result && (
        <div className="text-center py-10">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-brand-500/15 flex items-center justify-center">
            <CircleCheck size={30} className="text-brand-400" />
          </div>
          <h2 className="text-lg font-semibold text-white">Import complete</h2>
          <p className="text-sm text-slate-400 mt-1">
            {result.inserted ?? 0} record{(result.inserted ?? 0) === 1 ? '' : 's'} imported
            {result.lines ? ` (${result.lines} lines)` : ''}
            {result.entryNumber ? ` as ${result.entryNumber}` : ''}
            {result.skipped ? ` · ${result.skipped} skipped` : ''}.
          </p>
          {result.errors && result.errors.length > 0 && (
            <div className="mt-4 text-left max-w-lg mx-auto rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs text-amber-300 mb-1">{result.errors.length} entr{result.errors.length === 1 ? 'y' : 'ies'} could not be posted:</p>
              {result.errors.map((e, i) => <p key={i} className="text-xs text-amber-200/80">{e.message}</p>)}
            </div>
          )}
          <button onClick={reset}
            className="mt-6 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-white/[0.03] transition-colors">
            Import more data
          </button>
        </div>
      )}
    </div>
  );
}

// ── small presentational pieces ──────────────────────────────────────────
function Stepper({ step }: { step: Step }) {
  const steps: { k: Step; label: string }[] = [
    { k: 'select', label: 'Type' }, { k: 'upload', label: 'Upload' },
    { k: 'map', label: 'Map' }, { k: 'review', label: 'Review' }, { k: 'done', label: 'Done' },
  ];
  const idx = steps.findIndex((s) => s.k === step);
  return (
    <div className="flex items-center gap-2 mb-6">
      {steps.map((s, i) => (
        <div key={s.k} className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-2xs font-semibold ${i <= idx ? 'bg-brand-500 text-white' : 'bg-slate-800 text-slate-500'}`}>{i + 1}</span>
          <span className={`text-xs ${i <= idx ? 'text-slate-200' : 'text-slate-500'}`}>{s.label}</span>
          {i < steps.length - 1 && <span className="w-6 h-px bg-slate-800" />}
        </div>
      ))}
    </div>
  );
}

function TypeGroup({ title, sub, icon, types, onPick }: { title: string; sub: string; icon: React.ReactNode; types: ImportTypeDef[]; onPick: (t: ImportTypeDef) => void }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">{icon}<h3 className="text-sm font-semibold text-white">{title}</h3></div>
      <p className="text-xs text-slate-500 mb-3">{sub}</p>
      <div className="grid grid-cols-2 gap-3">
        {types.map((t) => (
          <button key={t.key} onClick={() => onPick(t)}
            className="text-left rounded-xl border border-slate-800 bg-surface-900 hover:border-brand-500/50 hover:bg-white/[0.02] px-4 py-3 transition-colors">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-100">{t.label}</span>
              <ArrowRight size={14} className="text-slate-600" />
            </div>
            <p className="text-2xs text-slate-500 mt-1 font-mono">{t.destination}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function FieldHint({ def }: { def: ImportTypeDef }) {
  return (
    <div className="mt-5 rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-3">
      <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Expected columns</p>
      <div className="flex flex-wrap gap-1.5">
        {def.fields.map((f) => (
          <span key={f.key} className="inline-flex items-center rounded-md bg-slate-800 px-2 py-0.5 text-2xs text-slate-300">
            {f.label}{f.required && <span className="text-rose-400 ml-0.5">*</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'bad' | 'muted' }) {
  const color = tone === 'ok' ? 'text-brand-400' : tone === 'bad' ? 'text-rose-400' : 'text-slate-300';
  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
      <p className={`text-2xl font-semibold font-mono ${color}`}>{value}</p>
      <p className="text-2xs text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}

function BackBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 mb-4 transition-colors">
      <ArrowLeft size={13} /> {label}
    </button>
  );
}
