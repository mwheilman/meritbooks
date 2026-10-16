'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  Upload, ArrowRight, ArrowLeft, AlertTriangle, Loader2, FileSpreadsheet,
  CircleCheck, Sparkles, CalendarDays, Info, Building2,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import {
  CONVERSION_SOURCE_FIELDS,
  cutoverExplanation,
  defaultCutoverDate,
  formatLongDate,
  isIsoDate,
} from '@/lib/onboarding/conversion';
import { parseAccountingAmount } from '@/lib/import/spreadsheet';
import { displayNameFromStoragePath } from '@/lib/uploads/paths';
import { ReviewStep } from './review-step';
import { TrialBalanceExportSteps } from './export-steps';
import {
  NONE,
  type CoaAccount,
  type Company,
  type LoadedFile,
  type PostResult,
  type SessionView,
  type Step,
  type TbImportResponse,
} from './types';

/**
 * Historical conversion — "bring your opening balances over".
 *
 * Optional prefill (the onboarding wizard passes these so the user is never asked
 * twice): `defaultCompanyId` skips the company picker; `defaultAsOfDate` replaces the
 * default cutover (last day of the previous month).
 */
export interface ConversionClientProps {
  defaultCompanyId?: string | null;
  defaultAsOfDate?: string | null;
  /**
   * Smart Intake handoff (FPB §5): a trial balance / GL file the user ALREADY dropped,
   * by storage path (`intake/{orgId}/…`). Read straight from storage — never re-upload.
   */
  initialStoragePath?: string | null;
  /**
   * Open straight into REVIEW for an already-staged session (e.g. the wizard's live
   * QuickBooks pull staged one). Falls back to the `?sessionId=` query param.
   */
  initialSessionId?: string | null;
}

/** Plain-English failure for a file that is a GL detail export rather than a TB. */
const GL_DETAIL_CODE = 'GL_DETAIL_NOT_TB';

const ACCEPT = '.xlsx,.xlsm,.csv,.pdf,image/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/pdf';

export default function ConversionClient({
  defaultCompanyId = null, defaultAsOfDate = null, initialStoragePath = null, initialSessionId = null,
}: ConversionClientProps = {}) {
  const initialDate = isIsoDate(defaultAsOfDate) ? defaultAsOfDate : defaultCutoverDate();
  const [step, setStep] = useState<Step>('setup');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesState, setCompaniesState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? '');
  const [pickCompany, setPickCompany] = useState(!defaultCompanyId);
  const [asOfDate, setAsOfDate] = useState(initialDate);
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [colMapping, setColMapping] = useState<Record<string, string>>({});
  const [session, setSession] = useState<SessionView | null>(null);
  const [coa, setCoa] = useState<CoaAccount[]>([]);
  const [posted, setPosted] = useState<PostResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);
  const [notice, setNotice] = useState('');
  // The Smart Intake file waiting to be read (cleared once we've tried it).
  const [pendingIntake, setPendingIntake] = useState<string | null>(
    initialStoragePath && initialStoragePath.startsWith('intake/') ? initialStoragePath : null,
  );

  const loadCompanies = useCallback(async () => {
    setCompaniesState('loading');
    try {
      const r = await fetch('/api/locations');
      if (!r.ok) throw new Error();
      const d: unknown = await r.json();
      setCompanies(Array.isArray(d) ? (d as Company[]) : []);
      setCompaniesState('ready');
    } catch {
      setCompaniesState('error');
    }
  }, []);
  useEffect(() => { void loadCompanies(); }, [loadCompanies]);

  const loadCoa = useCallback(async (locId: string) => {
    try {
      const r = await fetch(`/api/accounts?location_id=${encodeURIComponent(locId)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { data?: CoaAccount[] };
      setCoa((j.data ?? []).filter((a) => a.accountNumber));
    } catch { /* non-fatal — dropdowns fall back to the current value */ }
  }, []);

  // Resume straight into REVIEW with ?sessionId (direct-API migrations stage the same session).
  useEffect(() => {
    const sessionId = initialSessionId ?? new URLSearchParams(window.location.search).get('sessionId');
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      setHydrating(true);
      try {
        const r = await fetch(`/api/onboarding/conversion/${encodeURIComponent(sessionId)}`);
        const data = (await r.json()) as SessionView & { error?: string };
        if (!r.ok) throw new Error(data.error ?? 'We could not load that conversion.');
        if (cancelled) return;
        setCompanyId(data.companyId);
        setAsOfDate(data.asOfDate);
        await loadCoa(data.companyId);
        setSession(data);
        setStep('review');
      } catch (e) {
        if (!cancelled) setError({ message: e instanceof Error ? e.message : 'We could not load that conversion.' });
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadCoa, initialSessionId]);

  const reset = useCallback(() => {
    setStep('setup'); setFile(null); setColMapping({}); setSession(null); setPosted(null); setError(null); setNotice('');
    if (!defaultCompanyId) setCompanyId('');
    setAsOfDate(initialDate);
  }, [defaultCompanyId, initialDate]);

  // One drop zone for everything: Excel/CSV are read on the server deterministically
  // (QuickBooks title rows, blank headers, TOTAL rows); PDFs/photos are read by AI.
  // Shared reader for both ingress shapes: a dropped File (multipart) or a Smart Intake
  // storage path (JSON { storagePath } — the file is already in storage).
  const readTb = useCallback(async (input: { file: File } | { storagePath: string }, fileName: string) => {
    setError(null); setNotice(''); setReading(true);
    try {
      let res: Response;
      if ('file' in input) {
        const fd = new FormData();
        fd.append('file', input.file);
        res = await fetch('/api/onboarding/import/tb', { method: 'POST', body: fd });
      } else {
        res = await fetch('/api/onboarding/import/tb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storagePath: input.storagePath }),
        });
      }
      const data = (await res.json()) as TbImportResponse;
      if (!res.ok) {
        setError(data.code === GL_DETAIL_CODE
          ? { message: data.error ?? 'This is a General Ledger report, not a trial balance. Export the Trial Balance instead.', details: ['Tip: the steps below show exactly where to find the Trial Balance in QuickBooks Online.'] }
          : { message: data.error ?? 'We could not read that file.' });
        return;
      }
      const rows = data.rows ?? [];
      if (rows.length === 0) { setError({ message: 'We didn’t find any account rows in that file. Try the Excel export of your trial balance.' }); return; }
      const headers = data.headers ?? Object.keys(rows[0] ?? {});
      const loaded: LoadedFile = {
        fileName,
        headers,
        rows,
        rowNumbers: Array.isArray(data.rowNumbers) && data.rowNumbers.length === rows.length ? data.rowNumbers : null,
        recognized: data.source === 'spreadsheet' || data.source == null,
        asOfDateHint: isIsoDate(data.asOfDateHint ?? null) ? (data.asOfDateHint as string) : null,
        notice: data.notice ?? null,
        skipped: (data.dropped ?? []).map((d) => ({ row: d.row ?? null, reason: d.reason ?? d.snippet ?? 'Skipped' })),
        titleLines: data.detected?.titleLines ?? [],
      };
      setFile(loaded);
      setColMapping(data.mapping ?? {});
      setStep('map');
    } catch {
      setError({ message: 'We could not read that file. Try an Excel (.xlsx) or CSV export of your trial balance.' });
    } finally {
      setReading(false);
    }
  }, []);

  const onFile = useCallback((f: File) => readTb({ file: f }, f.name), [readTb]);

  // Smart Intake handoff: once a company is chosen, read the file the user already
  // dropped — straight from storage, no second upload.
  useEffect(() => {
    if (!pendingIntake || !companyId || hydrating || step !== 'setup') return;
    const path = pendingIntake;
    setPendingIntake(null);
    void readTb({ storagePath: path }, displayNameFromStoragePath(path));
  }, [pendingIntake, companyId, hydrating, step, readTb]);

  const mappingComplete = useMemo(
    () => CONVERSION_SOURCE_FIELDS.filter((f) => f.required).every((f) => colMapping[f.key] && colMapping[f.key] !== NONE)
      && ['debit_cents', 'credit_cents', 'amount_cents'].some((k) => colMapping[k] && colMapping[k] !== NONE),
    [colMapping],
  );

  const analyze = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    const cleanMapping: Record<string, string> = {};
    Object.entries(colMapping).forEach(([k, v]) => { if (v && v !== NONE) cleanMapping[k] = v; });
    try {
      const res = await fetch('/api/onboarding/conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId, asOfDate, mapping: cleanMapping, rows: file.rows,
          rowNumbers: file.rowNumbers ?? undefined, fileName: file.fileName,
        }),
      });
      const data = (await res.json()) as SessionView & { error?: string; errors?: { row: number; message: string }[] };
      if (!res.ok) {
        setError({ message: data.error ?? 'We could not match your accounts.', details: data.errors?.slice(0, 10).map((e) => `Row ${e.row}: ${e.message}`) });
        return;
      }
      await loadCoa(companyId);
      setSession(data);
      setStep('review');
    } catch {
      setError({ message: 'We could not match your accounts. Check your connection and try again.' });
    } finally { setBusy(false); }
  };

  /** Shared PATCH/POST → SessionView handler with all-blockers error display. */
  const callSession = async (url: string, method: 'PATCH' | 'POST', body: unknown): Promise<boolean> => {
    if (!session) return false;
    setBusy(true); setError(null); setNotice('');
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as SessionView & { error?: string; blockers?: string[]; saved?: { targetsChanged: number; accepted: number } };
      if (!res.ok) { setError({ message: data.error ?? 'That didn’t save.', details: data.blockers }); return false; }
      setSession(data);
      if (data.saved) {
        const parts: string[] = [];
        if (data.saved.accepted) parts.push(`${data.saved.accepted} strong match${data.saved.accepted === 1 ? '' : 'es'} accepted`);
        if (data.saved.targetsChanged) parts.push(`${data.saved.targetsChanged} account${data.saved.targetsChanged === 1 ? '' : 's'} changed`);
        setNotice(parts.length ? `Saved — ${parts.join(', ')}.` : 'Saved.');
      }
      return true;
    } catch {
      setError({ message: 'That didn’t save. Check your connection and try again.' });
      return false;
    } finally { setBusy(false); }
  };

  const saveMapping = (changes: Record<string, string | null>, acceptStrong: boolean) => {
    if (!session) return Promise.resolve(false);
    return callSession(`/api/onboarding/conversion/${session.id}/mapping`, 'POST', {
      changes: Object.entries(changes).map(([sourceAccount, target]) => ({ sourceAccount, target })),
      ...(acceptStrong ? { acceptSuggestedAtOrAbove: 0.9 } : {}),
    });
  };
  const toggleTieOut = (tieOut: boolean) => { if (session) void callSession(`/api/onboarding/conversion/${session.id}`, 'PATCH', { tieOut }); };
  const ackPl = (acknowledgePl: boolean) => { if (session) void callSession(`/api/onboarding/conversion/${session.id}`, 'PATCH', { acknowledgePl }); };

  const goLive = async () => {
    if (!session) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/onboarding/conversion/${session.id}/post`, { method: 'POST' });
      const data = (await res.json()) as PostResult & { error?: string; blockers?: string[] };
      if (!res.ok) { setError({ message: data.error ?? 'We could not post the opening balances.', details: data.blockers }); return; }
      setPosted(data);
      setStep('done');
    } catch {
      setError({ message: 'We could not post the opening balances. Check your connection and try again.' });
    } finally { setBusy(false); }
  };

  const company = companies.find((c) => c.id === companyId) ?? null;

  return (
    <div className="max-w-4xl mx-auto pb-16">
      <Stepper step={step} />

      <div aria-live="assertive">
        {error && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p>{error.message}</p>
              {error.details && error.details.length > 0 && (
                <ul className="mt-1.5 list-disc pl-4 space-y-0.5 text-xs text-rose-200/90">
                  {error.details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
      <div aria-live="polite">
        {notice && <div className="mb-4 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-4 py-2 text-sm text-emerald-300">{notice}</div>}
      </div>

      {hydrating && (
        <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-surface-900 px-4 py-6 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Loading your conversion…
        </div>
      )}

      {!hydrating && step === 'setup' && pendingIntake && !companyId && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-500/25 bg-blue-500/5 px-4 py-2.5 text-sm text-blue-200" role="status">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            We have <span className="font-medium text-white">{displayNameFromStoragePath(pendingIntake)}</span> from your drop.
            Choose the company it belongs to and we&apos;ll read it — no need to upload it again.
          </span>
        </div>
      )}

      {!hydrating && step === 'setup' && (
        <SetupStep
          companies={companies} companiesState={companiesState} onRetryCompanies={loadCompanies}
          companyId={companyId} setCompanyId={setCompanyId} company={company}
          pickCompany={pickCompany} onChangeCompany={() => setPickCompany(true)}
          asOfDate={asOfDate} setAsOfDate={setAsOfDate} onFile={onFile} reading={reading}
        />
      )}

      {step === 'map' && file && (
        <MapStep
          file={file} asOfDate={asOfDate} onUseFileDate={(d) => setAsOfDate(d)}
          colMapping={colMapping} setColMapping={setColMapping}
          mappingComplete={mappingComplete} busy={busy} onBack={() => setStep('setup')} onAnalyze={analyze}
        />
      )}

      {step === 'review' && session && (
        <ReviewStep
          session={session} coa={coa} busy={busy}
          onBack={() => setStep(file ? 'map' : 'setup')} onSaveMapping={saveMapping}
          onTieOut={toggleTieOut} onPost={goLive} onAckPl={ackPl}
        />
      )}

      {step === 'done' && posted && <DoneStep posted={posted} onReset={reset} />}
    </div>
  );
}

// ───────────────────────────── STEP 1: COMPANY, DATE, FILE ─────────────────────────────
function SetupStep({
  companies, companiesState, onRetryCompanies, companyId, setCompanyId, company, pickCompany, onChangeCompany,
  asOfDate, setAsOfDate, onFile, reading,
}: {
  companies: Company[]; companiesState: 'loading' | 'ready' | 'error'; onRetryCompanies: () => void;
  companyId: string; setCompanyId: (v: string) => void; company: Company | null;
  pickCompany: boolean; onChangeCompany: () => void;
  asOfDate: string; setAsOfDate: (v: string) => void; onFile: (f: File) => void; reading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const ready = !!companyId && isIsoDate(asOfDate) && !reading;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="conv-company" className="block text-xs font-medium text-slate-400 mb-1">Which company?</label>
          {!pickCompany ? (
            <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm">
              <span className="flex items-center gap-2 text-white">
                <Building2 size={14} className="text-slate-500" />
                {company ? `${company.name} (${company.short_code})` : companiesState === 'loading' ? 'Loading…' : 'Selected company'}
              </span>
              <button type="button" onClick={onChangeCompany} className="text-2xs text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline">Change</button>
            </div>
          ) : companiesState === 'error' ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
              We couldn&apos;t load your companies. <button type="button" onClick={onRetryCompanies} className="underline">Try again</button>
            </div>
          ) : (
            <select id="conv-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} disabled={companiesState === 'loading'}
              className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white disabled:opacity-60">
              <option value="">{companiesState === 'loading' ? 'Loading companies…' : 'Choose a company…'}</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.short_code})</option>)}
            </select>
          )}
          {pickCompany && companiesState === 'ready' && companies.length === 0 && (
            <p className="text-2xs text-amber-400 mt-1">
              No companies yet — <Link href="/onboarding" className="underline">add your company first</Link>.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="conv-asof" className="block text-xs font-medium text-slate-400 mb-1">Opening balances as of</label>
          <div className="relative">
            <CalendarDays size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input id="conv-asof" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-surface-900 pl-9 pr-3 py-2 text-sm text-white" />
          </div>
          <p className="text-2xs text-slate-400 mt-1">{cutoverExplanation(asOfDate)}</p>
        </div>
      </div>

      <div>
        <input ref={inputRef} id="conv-file" type="file" accept={ACCEPT} className="sr-only" disabled={!ready}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        <label
          htmlFor="conv-file"
          onDragOver={(e) => { if (ready) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (ready && f) onFile(f); }}
          onKeyDown={(e) => { if (ready && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
          tabIndex={ready ? 0 : -1}
          aria-disabled={!ready}
          className={`block rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            ready ? `cursor-pointer ${dragOver ? 'border-brand-500 bg-brand-500/5' : 'border-slate-700 hover:border-brand-500/60 bg-surface-900'}` : 'border-slate-800 bg-surface-900/40 cursor-not-allowed opacity-60'}`}
        >
          {reading ? (
            <>
              <Loader2 size={26} className="mx-auto mb-3 text-brand-400 animate-spin" />
              <p className="text-sm text-slate-300 font-medium">Reading your file…</p>
            </>
          ) : (
            <>
              <Upload size={28} className="mx-auto mb-3 text-slate-500" />
              <p className="text-sm text-slate-200 font-medium">Drop your account balances (trial balance) here, or click to choose a file</p>
              <p className="text-xs text-slate-500 mt-1">Excel (.xlsx), CSV, or PDF — straight from your old system, title rows and all.</p>
            </>
          )}
        </label>
        {!companyId && <p className="text-2xs text-slate-500 mt-2">Choose a company first.</p>}
      </div>

      <TrialBalanceExportSteps asOfDate={asOfDate} />
    </div>
  );
}

// ───────────────────────────── STEP 2: CHECK COLUMNS ─────────────────────────────
function MapStep({
  file, asOfDate, onUseFileDate, colMapping, setColMapping, mappingComplete, busy, onBack, onAnalyze,
}: {
  file: LoadedFile; asOfDate: string; onUseFileDate: (d: string) => void;
  colMapping: Record<string, string>; setColMapping: (fn: (m: Record<string, string>) => Record<string, string>) => void;
  mappingComplete: boolean; busy: boolean; onBack: () => void; onAnalyze: () => void;
}) {
  const preview = file.rows.slice(0, 6);
  const dateMismatch = file.asOfDateHint && file.asOfDateHint !== asOfDate;
  const totals = useMemo(() => sumDollarColumns(file.rows, colMapping), [file.rows, colMapping]);

  return (
    <div>
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 mb-4 transition-colors">
        <ArrowLeft size={13} /> Choose a different file
      </button>

      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400 mb-1">
        <FileSpreadsheet size={15} /> <span className="text-slate-200">{file.fileName}</span>
        <span className="text-slate-600">·</span> <span>{file.rows.length} account row{file.rows.length === 1 ? '' : 's'} found</span>
        {totals && <><span className="text-slate-600">·</span><span className="font-mono">Debits {formatMoney(totals.debit)} · Credits {formatMoney(totals.credit)}</span></>}
      </div>
      {file.titleLines.length > 0 && <p className="text-2xs text-slate-500 mb-3">Report: {file.titleLines.slice(0, 3).join(' · ')}</p>}

      {dateMismatch && file.asOfDateHint && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-200">
          <span>Your file says its balances are as of <strong>{formatLongDate(file.asOfDateHint)}</strong>, but you chose {formatLongDate(asOfDate)}.</span>
          <button type="button" onClick={() => onUseFileDate(file.asOfDateHint as string)}
            className="rounded-md border border-amber-500/40 px-2.5 py-1 text-xs hover:bg-amber-500/10">Use {formatLongDate(file.asOfDateHint)}</button>
        </div>
      )}
      {file.notice && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-blue-500/25 bg-blue-500/5 px-4 py-2.5 text-xs text-blue-200">
          <Info size={14} className="mt-0.5 shrink-0" /> <span>{file.notice} Match the columns below instead.</span>
        </div>
      )}

      {/* Preview */}
      <div className="rounded-xl border border-slate-800 overflow-x-auto mb-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-950 text-2xs uppercase tracking-wider text-slate-500">
              {file.headers.map((h) => <th key={h} scope="col" className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {preview.map((r, i) => (
              <tr key={i} className="bg-surface-900">
                {file.headers.map((h) => <td key={h} className="px-3 py-1.5 text-slate-300 whitespace-nowrap">{r[h] || <span className="text-slate-700">—</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {file.rows.length > preview.length && <p className="bg-surface-950 px-3 py-1.5 text-2xs text-slate-500">…and {file.rows.length - preview.length} more</p>}
      </div>

      {file.skipped.length > 0 && (
        <details className="mb-4 rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-2.5">
          <summary className="cursor-pointer text-xs text-slate-400">{file.skipped.length} row{file.skipped.length === 1 ? '' : 's'} skipped (totals, headings, notes)</summary>
          <ul className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
            {file.skipped.slice(0, 40).map((d, i) => (
              <li key={i} className="text-2xs text-slate-500">{d.row != null && <span className="font-mono text-slate-600">Row {d.row} — </span>}{d.reason}</li>
            ))}
          </ul>
        </details>
      )}

      <details open={!file.recognized || !mappingComplete} className="rounded-xl border border-slate-800 bg-surface-900">
        <summary className="cursor-pointer px-4 py-2.5 text-sm text-slate-300">
          {file.recognized && mappingComplete ? 'We matched your columns automatically — open to change them' : 'Tell us which column is which'}
        </summary>
        <div className="divide-y divide-slate-800 border-t border-slate-800">
          {CONVERSION_SOURCE_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-2.5">
              <label htmlFor={`col-${f.key}`} className="sm:w-1/2">
                <span className="text-sm text-slate-200">{f.label}</span>
                {f.required && <span className="text-rose-400 ml-1">*</span>}
                {f.help && <span className="block text-2xs text-slate-500">{f.help}</span>}
              </label>
              <ArrowRight size={14} className="hidden sm:block text-slate-600 shrink-0" />
              <select id={`col-${f.key}`} value={colMapping[f.key] || NONE}
                onChange={(e) => setColMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                className="flex-1 rounded-lg border border-slate-700 bg-surface-950 px-2.5 py-1.5 text-sm text-white">
                <option value={NONE}>— Not in my file —</option>
                {file.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          ))}
        </div>
      </details>

      <button type="button" disabled={!mappingComplete || busy} onClick={onAnalyze}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        Match my accounts
      </button>
      {!mappingComplete && <p className="text-2xs text-amber-300/90 mt-2">Choose the account column and either Debit/Credit or a single Balance column.</p>}
      <p className="text-2xs text-slate-500 mt-2">We suggest which MeritBooks account each of yours becomes. We never change an amount — every number comes straight from your file.</p>
    </div>
  );
}

/** Debit/credit totals of the mapped dollar columns, in cents, for a quick sanity line. */
function sumDollarColumns(rows: Record<string, string>[], mapping: Record<string, string>): { debit: number; credit: number } | null {
  const d = mapping.debit_cents && mapping.debit_cents !== NONE ? mapping.debit_cents : null;
  const c = mapping.credit_cents && mapping.credit_cents !== NONE ? mapping.credit_cents : null;
  if (!d || !c) return null;
  const toCents = (v: string | undefined): number => {
    const p = parseAccountingAmount(v ?? '');
    return p.ok ? p.cents : 0;
  };
  let debit = 0; let credit = 0;
  for (const r of rows) {
    const dv = toCents(r[d]); const cv = toCents(r[c]);
    if (dv < 0) credit += -dv; else debit += dv;
    if (cv < 0) debit += -cv; else credit += cv;
  }
  return { debit, credit };
}

// ───────────────────────────── STEP 4: DONE ─────────────────────────────
function DoneStep({ posted, onReset }: { posted: PostResult; onReset: () => void }) {
  return (
    <div className="text-center py-10">
      <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-brand-500/15 flex items-center justify-center">
        <CircleCheck size={30} className="text-brand-400" />
      </div>
      <h2 className="text-lg font-semibold text-white">{posted.alreadyPosted ? 'Already live' : 'You’re live'}</h2>
      <p className="text-sm text-slate-400 mt-1 max-w-xl mx-auto">
        Your opening balances were posted as one balanced journal entry
        {posted.entryNumber ? <> (<span className="font-mono text-slate-300">{posted.entryNumber}</span>)</> : ''}
        {posted.lineCount ? ` across ${posted.lineCount} accounts` : ''}
        {posted.totalDebitCents != null ? `, totaling ${formatMoney(posted.totalDebitCents)}` : ''}.
        From here on, MeritBooks keeps this company&apos;s books.
      </p>
      {(posted.periodsCreated ?? 0) > 0 && (
        <p className="text-2xs text-slate-500 mt-2">We also set up {posted.periodsCreated} accounting month{posted.periodsCreated === 1 ? '' : 's'} for this company.</p>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link href="/journal-entries" className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-400 transition-colors">
          See the opening entry
        </Link>
        <button type="button" onClick={onReset}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-white/[0.03] transition-colors">
          Convert another company
        </button>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { k: Step; label: string }[] = [
    { k: 'setup', label: 'Upload' }, { k: 'map', label: 'Check columns' },
    { k: 'review', label: 'Check the numbers match' }, { k: 'done', label: 'Go live' },
  ];
  const idx = steps.findIndex((s) => s.k === step);
  return (
    <ol className="flex flex-wrap items-center gap-2 mb-6" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.k} className="flex items-center gap-2" aria-current={i === idx ? 'step' : undefined}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-2xs font-semibold ${i <= idx ? 'bg-brand-500 text-white' : 'bg-slate-800 text-slate-500'}`}>{i + 1}</span>
          <span className={`text-xs ${i <= idx ? 'text-slate-200' : 'text-slate-500'}`}>{s.label}</span>
          {i < steps.length - 1 && <span className="w-6 h-px bg-slate-800" />}
        </li>
      ))}
    </ol>
  );
}
