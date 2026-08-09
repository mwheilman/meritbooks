'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Upload, ArrowRight, ArrowLeft, Check, AlertTriangle, Loader2, FileSpreadsheet,
  CircleCheck, Sparkles, ShieldCheck, Scale, ListChecks, Lock, FileText, Filter,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { parseCsv, autoMap, type ParsedCsv } from '@/lib/import/csv';
import {
  CONVERSION_SOURCE_FIELDS,
  type SourceLine,
  type MappingTable,
  type OpeningBalanceLine,
  type BalanceCheck,
  type BalanceSheetCheck,
  type MappingSource,
} from '@/lib/onboarding/conversion';

interface Company { id: string; name: string; short_code: string }
interface CoaAccount { accountNumber: string; name: string; accountType: string }

interface Session {
  id: string;
  status: string;
  posted: boolean;
  postedGlEntryId?: string | null;
  blockers?: string[];
  companyShortCode: string;
  asOfDate: string;
  sourceLines: SourceLine[];
  mapping: MappingTable;
  openingBalances: OpeningBalanceLine[];
  balance: BalanceCheck;
  balanceSheet?: BalanceSheetCheck;
  unmapped: string[];
  unknownTargets: string[];
  sourceTotals: { debitCents: number; creditCents: number };
  plAcknowledged?: boolean;
  tiedOut: boolean;
  tiedOutBy: string | null;
  tiedOutAt: string | null;
  aiUsed?: boolean;
  aiError?: string | null;
  excluded?: { row: number; reason: string }[];
  excludedCount?: number;
  zeroRows?: number;
}

interface PostResult { ok: boolean; glEntryId?: string; entryNumber?: string; lineCount?: number; totalDebitCents?: number; alreadyPosted?: boolean }

type Step = 'setup' | 'map' | 'review' | 'done';
const NONE = '__none__';

export default function ConversionClient() {
  const [step, setStep] = useState<Step>('setup');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [asOfDate, setAsOfDate] = useState('');
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState('');
  const [colMapping, setColMapping] = useState<Record<string, string>>({});
  const [session, setSession] = useState<Session | null>(null);
  const [coa, setCoa] = useState<CoaAccount[]>([]);
  const [posted, setPosted] = useState<PostResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setCompanies(Array.isArray(d) ? d : []))
      .catch(() => setCompanies([]));
  }, []);

  const reset = useCallback(() => {
    setStep('setup'); setCompanyId(''); setAsOfDate(''); setCsv(null); setFileName('');
    setColMapping({}); setSession(null); setPosted(null); setError('');
  }, []);

  const onFile = useCallback(async (file: File) => {
    setError('');
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError('That file has no data rows. The first line must be column headers.');
        return;
      }
      setCsv(parsed);
      setFileName(file.name);
      setColMapping(autoMap(parsed.headers, CONVERSION_SOURCE_FIELDS));
      setStep('map');
    } catch {
      setError('Could not read that file. Please upload a .csv file.');
    }
  }, []);

  const setupComplete = !!companyId && !!asOfDate;
  const mappingComplete = useMemo(
    () => CONVERSION_SOURCE_FIELDS.filter((f) => f.required).every((f) => colMapping[f.key] && colMapping[f.key] !== NONE),
    [colMapping],
  );

  const loadCoa = useCallback(async (locId: string) => {
    try {
      const r = await fetch(`/api/accounts?location_id=${encodeURIComponent(locId)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { data?: CoaAccount[] };
      setCoa((j.data ?? []).filter((a) => a.accountNumber));
    } catch { /* non-fatal — dropdowns fall back to text */ }
  }, []);

  // STEP: analyze — POST to create the session (AI proposes the mapping).
  const analyze = async () => {
    if (!csv) return;
    setBusy(true); setError('');
    const cleanMapping: Record<string, string> = {};
    Object.entries(colMapping).forEach(([k, v]) => { if (v && v !== NONE) cleanMapping[k] = v; });
    try {
      const res = await fetch('/api/onboarding/conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, asOfDate, mapping: cleanMapping, rows: csv.rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not analyze the file');
      await loadCoa(companyId);
      setSession(data as Session);
      setStep('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally { setBusy(false); }
  };

  // Human remap → PATCH.
  const remap = async (sourceAccount: string, target: string) => {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/onboarding/conversion/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappingUpdates: { [sourceAccount]: target === NONE ? null : target } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not update the mapping');
      setSession(data as Session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remap failed');
    } finally { setBusy(false); }
  };

  const toggleTieOut = async (tieOut: boolean) => {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/onboarding/conversion/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tieOut }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.blockers?.[0] as string) ?? data.error ?? 'Could not tie out');
      setSession(data as Session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tie-out failed');
    } finally { setBusy(false); }
  };

  // Acknowledge a mid-year go-live (open income-statement balances are intended).
  const ackPl = async (acknowledgePl: boolean) => {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/onboarding/conversion/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgePl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not update acknowledgment');
      setSession(data as Session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally { setBusy(false); }
  };

  const goLive = async () => {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/onboarding/conversion/${session.id}/post`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error((data.blockers?.[0] as string) ?? data.error ?? 'Could not post the opening entry');
      setPosted(data as PostResult);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Posting failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="max-w-4xl mx-auto pb-16">
      <Stepper step={step} />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {step === 'setup' && (
        <SetupStep
          companies={companies} companyId={companyId} setCompanyId={setCompanyId}
          asOfDate={asOfDate} setAsOfDate={setAsOfDate} setupComplete={setupComplete} onFile={onFile}
        />
      )}

      {step === 'map' && csv && (
        <MapStep
          csv={csv} fileName={fileName} colMapping={colMapping} setColMapping={setColMapping}
          mappingComplete={mappingComplete} busy={busy} onBack={() => setStep('setup')} onAnalyze={analyze}
        />
      )}

      {step === 'review' && session && (
        <ReviewStep
          session={session} coa={coa} busy={busy}
          onBack={() => setStep('map')} onRemap={remap} onTieOut={toggleTieOut} onPost={goLive} onAckPl={ackPl}
        />
      )}

      {step === 'done' && posted && (
        <DoneStep posted={posted} onReset={reset} />
      )}
    </div>
  );
}

// ───────────────────────────── STEP 1: SETUP ─────────────────────────────
function SetupStep({
  companies, companyId, setCompanyId, asOfDate, setAsOfDate, setupComplete, onFile,
}: {
  companies: Company[]; companyId: string; setCompanyId: (v: string) => void;
  asOfDate: string; setAsOfDate: (v: string) => void; setupComplete: boolean; onFile: (f: File) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Company to convert</label>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white">
            <option value="">Select a company…</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.short_code})</option>)}
          </select>
          {companies.length === 0 && <p className="text-2xs text-amber-400 mt-1">No companies yet — import Companies/Entities first.</p>}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Opening balances as of</label>
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white" />
          <p className="text-2xs text-slate-500 mt-1">Usually the day before your first live day (e.g. prior year-end).</p>
        </div>
      </div>

      <label className={`block rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${setupComplete ? 'cursor-pointer border-slate-700 hover:border-brand-500/60 bg-surface-900' : 'border-slate-800 bg-surface-900/40 cursor-not-allowed opacity-60'}`}>
        <input type="file" accept=".csv,text/csv" className="hidden" disabled={!setupComplete}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        <Upload size={28} className="mx-auto mb-3 text-slate-500" />
        <p className="text-sm text-slate-300 font-medium">Drop a trial balance CSV here or click to browse</p>
        <p className="text-xs text-slate-500 mt-1">First row must be column headers: an account column, and debit / credit columns.</p>
      </label>
      {!setupComplete && <p className="text-2xs text-slate-500">Pick a company and an as-of date to enable the upload.</p>}

      <div className="rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-3">
        <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Expected columns</p>
        <div className="flex flex-wrap gap-1.5">
          {CONVERSION_SOURCE_FIELDS.map((f) => (
            <span key={f.key} className="inline-flex items-center rounded-md bg-slate-800 px-2 py-0.5 text-2xs text-slate-300">
              {f.label}{f.required && <span className="text-rose-400 ml-0.5">*</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── STEP 2: MAP COLUMNS ─────────────────────────────
function MapStep({
  csv, fileName, colMapping, setColMapping, mappingComplete, busy, onBack, onAnalyze,
}: {
  csv: ParsedCsv; fileName: string; colMapping: Record<string, string>;
  setColMapping: (fn: (m: Record<string, string>) => Record<string, string>) => void;
  mappingComplete: boolean; busy: boolean; onBack: () => void; onAnalyze: () => void;
}) {
  return (
    <div>
      <BackBtn onClick={onBack} label="Change company or file" />
      <div className="flex items-center gap-2 text-sm text-slate-400 mb-4">
        <FileSpreadsheet size={15} /> <span className="text-slate-300">{fileName}</span>
        <span className="text-slate-600">·</span> <span>{csv.rows.length} rows</span>
      </div>
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Match your columns</p>
      <div className="rounded-xl border border-slate-800 divide-y divide-slate-800 overflow-hidden">
        {CONVERSION_SOURCE_FIELDS.map((f) => (
          <div key={f.key} className="flex items-center gap-3 px-4 py-2.5 bg-surface-900">
            <div className="w-1/2">
              <span className="text-sm text-slate-200">{f.label}</span>
              {f.required && <span className="text-rose-400 ml-1">*</span>}
              {f.help && <p className="text-2xs text-slate-500">{f.help}</p>}
            </div>
            <ArrowRight size={14} className="text-slate-600 shrink-0" />
            <select value={colMapping[f.key] || NONE}
              onChange={(e) => setColMapping((m) => ({ ...m, [f.key]: e.target.value }))}
              className="flex-1 rounded-lg border border-slate-700 bg-surface-950 px-2.5 py-1.5 text-sm text-white">
              <option value={NONE}>— Not mapped —</option>
              {csv.headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>
      <button disabled={!mappingComplete || busy} onClick={onAnalyze}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        Analyze &amp; propose account mapping
      </button>
      <p className="text-2xs text-slate-500 mt-2">AI proposes the account mapping only. It never sees or changes a single balance — every figure comes straight from your file.</p>
    </div>
  );
}

// ───────────────────────────── STEP 3: REVIEW + TIE-OUT ─────────────────────────────
interface SourceRow { sourceAccount: string; sourceName: string | null; debitCents: number; creditCents: number }

function ReviewStep({
  session, coa, busy, onBack, onRemap, onTieOut, onPost, onAckPl,
}: {
  session: Session; coa: CoaAccount[]; busy: boolean;
  onBack: () => void; onRemap: (src: string, target: string) => void;
  onTieOut: (v: boolean) => void; onPost: () => void; onAckPl: (v: boolean) => void;
}) {
  // Aggregate source lines per source account (client-side, for the mapping table).
  const sourceRows: SourceRow[] = useMemo(() => {
    const map = new Map<string, SourceRow>();
    for (const l of session.sourceLines) {
      const key = l.sourceAccount;
      const cur = map.get(key) ?? { sourceAccount: key, sourceName: l.sourceName, debitCents: 0, creditCents: 0 };
      cur.debitCents += l.debitCents || 0;
      cur.creditCents += l.creditCents || 0;
      if (!cur.sourceName && l.sourceName) cur.sourceName = l.sourceName;
      map.set(key, cur);
    }
    return [...map.values()]
      .filter((r) => r.debitCents !== 0 || r.creditCents !== 0)
      .sort((a, b) => a.sourceAccount.localeCompare(b.sourceAccount));
  }, [session.sourceLines]);

  const blockers = session.blockers ?? [];
  const readyToTieOut = blockers.length === 0 && !session.tiedOut;
  const bal = session.balance;

  return (
    <div>
      <BackBtn onClick={onBack} label="Re-map columns" />

      {/* Opening TB summary + balance check */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <SummaryStat label="Opening accounts" value={String(session.openingBalances.length)} tone="muted" mono />
        <SummaryStat label="Total debits" value={formatMoney(bal.totalDebitCents)} tone="ok" mono />
        <SummaryStat label="Total credits" value={formatMoney(bal.totalCreditCents)} tone="ok" mono />
      </div>

      <BalanceBanner balance={bal} />

      {/* Book vs source reconciliation */}
      <div className="mt-3 rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
        <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Book vs source reconciliation</p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <ReconLine label="Source file debits" value={session.sourceTotals.debitCents} />
          <ReconLine label="Booked debits" value={bal.totalDebitCents} />
          <ReconLine label="Source file credits" value={session.sourceTotals.creditCents} />
          <ReconLine label="Booked credits" value={bal.totalCreditCents} />
        </div>
      </div>

      {/* Excluded rows (non-silent): totals / subtotal / blank rows the parser set aside */}
      {(session.excludedCount ?? 0) > 0 && (
        <div className="mt-3 rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Filter size={14} className="text-slate-400" />
            <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500">
              {session.excludedCount} row{session.excludedCount === 1 ? '' : 's'} excluded as totals/summary
              {session.zeroRows ? ` · ${session.zeroRows} zero-balance row${session.zeroRows === 1 ? '' : 's'} skipped` : ''}
            </p>
          </div>
          <ul className="space-y-0.5 max-h-28 overflow-y-auto">
            {(session.excluded ?? []).slice(0, 20).map((e, i) => (
              <li key={i} className="text-2xs text-slate-500">
                <span className="font-mono text-slate-600">Row {e.row}</span> — {e.reason}
              </li>
            ))}
          </ul>
          <p className="text-2xs text-slate-600 mt-1.5">Nothing was dropped silently. If a real account was excluded, add a Debit/Credit (or Signed Balance) value for it and re-upload.</p>
        </div>
      )}

      {/* Balance-sheet identity — Assets = Liabilities + Equity */}
      {session.balanceSheet && <BalanceSheetPanel bs={session.balanceSheet} />}

      {/* What's left to tie out */}
      <div className="mt-4 rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <ListChecks size={15} className="text-brand-400" />
          <p className="text-sm font-semibold text-white">What&apos;s left to tie out</p>
        </div>
        {blockers.length === 0 ? (
          <p className="text-sm text-emerald-300 flex items-center gap-2"><Check size={15} /> Nothing outstanding — the opening trial balance is ready to tie out.</p>
        ) : (
          <ul className="space-y-1.5">
            {blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-amber-200/90">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" /> <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* AI mapping notice — degrade-safe: mapping is always completable by hand */}
      {session.aiError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-700 bg-surface-900/60 px-4 py-2.5 text-xs text-slate-300">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-slate-500" />
          <span>
            {session.aiError} Accounts matched by number/name are set automatically; use the
            &ldquo;Maps to&rdquo; dropdown on each remaining row to map it yourself. AI is a convenience, not a
            requirement — you can complete the entire mapping manually.
          </span>
        </div>
      )}

      {/* Mapping table */}
      <p className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        Account mapping <span className="text-slate-600 normal-case font-normal">— AI proposes, you confirm. Balances shown are your file&apos;s numbers.</span>
      </p>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-950 text-2xs uppercase tracking-wider text-slate-500">
              <th className="text-left font-medium px-3 py-2">Source account</th>
              <th className="text-right font-medium px-3 py-2">Debit</th>
              <th className="text-right font-medium px-3 py-2">Credit</th>
              <th className="text-left font-medium px-3 py-2">Maps to (MeritBooks COA)</th>
              <th className="text-left font-medium px-3 py-2">Basis</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {sourceRows.map((r) => {
              const m = session.mapping[r.sourceAccount];
              const target = m?.targetAccountNumber ?? NONE;
              const unmapped = !m?.targetAccountNumber;
              return (
                <tr key={r.sourceAccount} className={`bg-surface-900 ${unmapped ? 'ring-1 ring-inset ring-amber-500/20' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-mono text-slate-200">{r.sourceAccount}</div>
                    {r.sourceName && <div className="text-2xs text-slate-500">{r.sourceName}</div>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{r.debitCents ? formatMoney(r.debitCents) : <span className="text-slate-600">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{r.creditCents ? formatMoney(r.creditCents) : <span className="text-slate-600">—</span>}</td>
                  <td className="px-3 py-2">
                    <select value={target} disabled={busy || session.posted}
                      onChange={(e) => onRemap(r.sourceAccount, e.target.value)}
                      className={`w-full rounded-md border px-2 py-1 text-xs text-white bg-surface-950 ${unmapped ? 'border-amber-500/40' : 'border-slate-700'}`}>
                      <option value={NONE}>— Unmapped —</option>
                      {coa.length === 0 && m?.targetAccountNumber && (
                        <option value={m.targetAccountNumber}>{m.targetAccountNumber}</option>
                      )}
                      {coa.map((a) => (
                        <option key={a.accountNumber} value={a.accountNumber}>{a.accountNumber} — {a.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2"><MappingBadge source={m?.source ?? 'unmapped'} confidence={m?.confidence ?? null} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Opening journal-entry preview — the EXACT balanced entry that will post */}
      <OpeningEntryPreview lines={session.openingBalances} bal={bal} companyShortCode={session.companyShortCode} asOfDate={session.asOfDate} />

      {/* Mid-year go-live acknowledgment — only when the balance sheet doesn't stand alone */}
      {session.balanceSheet && !session.balanceSheet.standalone && session.balanceSheet.plNetCents !== 0 && (
        <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-amber-500"
            checked={!!session.plAcknowledged}
            disabled={busy || session.posted}
            onChange={(e) => onAckPl(e.target.checked)}
          />
          <span className="text-xs text-amber-200/90">
            I understand this is a <span className="font-medium">mid-year go-live</span> — income-statement accounts carry{' '}
            <span className="font-mono">{formatMoney(Math.abs(session.balanceSheet.plNetCents))}</span> of open balances that
            will post as current-year activity (normally the prior year&apos;s P&amp;L is closed into retained earnings).
          </span>
        </label>
      )}

      {/* Tie-out + go-live gate */}
      <div className="mt-6 rounded-xl border border-slate-800 bg-surface-900 p-4">
        {!session.tiedOut ? (
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-brand-400" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">Tie-out gate</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Go-live is blocked until a person confirms the opening trial balance is reconciled to the prior books.
              </p>
              <button disabled={!readyToTieOut || busy} onClick={() => onTieOut(true)}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                Mark opening trial balance tied out
              </button>
              {!readyToTieOut && <p className="text-2xs text-slate-500 mt-2">Resolve everything under &ldquo;What&apos;s left to tie out&rdquo; first.</p>}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <ShieldCheck size={16} /> <span className="font-medium">Tied out</span>
              {session.tiedOutAt && <span className="text-2xs text-slate-500">· {new Date(session.tiedOutAt).toLocaleString()}</span>}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button disabled={busy || session.posted} onClick={onPost}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Scale size={16} />}
                Post opening balances &amp; go live
              </button>
              <button disabled={busy || session.posted} onClick={() => onTieOut(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.03] disabled:opacity-40 transition-colors">
                <Lock size={13} /> Reopen for edits
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── STEP 4: DONE ─────────────────────────────
function DoneStep({ posted, onReset }: { posted: PostResult; onReset: () => void }) {
  return (
    <div className="text-center py-10">
      <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-brand-500/15 flex items-center justify-center">
        <CircleCheck size={30} className="text-brand-400" />
      </div>
      <h2 className="text-lg font-semibold text-white">{posted.alreadyPosted ? 'Already live' : 'Conversion complete — you are live'}</h2>
      <p className="text-sm text-slate-400 mt-1">
        Opening balances posted as one balanced journal entry
        {posted.entryNumber ? <> (<span className="font-mono text-slate-300">{posted.entryNumber}</span>)</> : ''}
        {posted.lineCount ? ` across ${posted.lineCount} accounts` : ''}
        {posted.totalDebitCents != null ? ` totaling ${formatMoney(posted.totalDebitCents)}` : ''}.
        MeritBooks now owns this company&apos;s general ledger.
      </p>
      <button onClick={onReset}
        className="mt-6 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-white/[0.03] transition-colors">
        Convert another company
      </button>
    </div>
  );
}

// ───────────────────────────── small pieces ─────────────────────────────
function Stepper({ step }: { step: Step }) {
  const steps: { k: Step; label: string }[] = [
    { k: 'setup', label: 'Upload' }, { k: 'map', label: 'Columns' },
    { k: 'review', label: 'Review & tie out' }, { k: 'done', label: 'Go live' },
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

function BalanceBanner({ balance }: { balance: BalanceCheck }) {
  if (balance.balanced) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
        <Scale size={16} /> <span>In balance — debits equal credits ({formatMoney(balance.totalDebitCents)}).</span>
      </div>
    );
  }
  const diff = Math.abs(balance.differenceCents);
  const side = balance.differenceCents > 0 ? 'debits exceed credits' : 'credits exceed debits';
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>Out of balance by <span className="font-mono font-semibold">{formatMoney(diff)}</span> — {side}. This blocks go-live until it&apos;s resolved.</span>
    </div>
  );
}

function BalanceSheetPanel({ bs }: { bs: BalanceSheetCheck }) {
  const le = bs.liabilitiesCents + bs.equityCents;
  const ties = bs.standalone;
  return (
    <div className={`mt-3 rounded-xl border px-4 py-3 ${ties ? 'border-slate-800 bg-surface-900' : 'border-amber-500/30 bg-amber-500/5'}`}>
      <div className="flex items-center gap-2 mb-2">
        <Scale size={14} className={ties ? 'text-brand-400' : 'text-amber-400'} />
        <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance sheet identity — assets = liabilities + equity</p>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
        <ReconLine label="Total assets" value={bs.assetsCents} />
        <ReconLine label="Liabilities + equity" value={le} />
      </div>
      {ties ? (
        <p className="mt-2 text-2xs text-emerald-300 flex items-center gap-1.5"><Check size={12} /> The balance sheet ties on its own — no open income-statement balances.</p>
      ) : (
        <p className="mt-2 text-2xs text-amber-300/90 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            Income-statement accounts carry <span className="font-mono">{formatMoney(Math.abs(bs.plNetCents))}</span> of open balances
            (a mid-year go-live). A year-end opening balance normally has none. Acknowledge below to proceed.
          </span>
        </p>
      )}
    </div>
  );
}

function OpeningEntryPreview({
  lines, bal, companyShortCode, asOfDate,
}: {
  lines: OpeningBalanceLine[]; bal: BalanceCheck; companyShortCode: string; asOfDate: string;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-2">
        <FileText size={15} className="text-brand-400" />
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Opening entry preview
          <span className="text-slate-600 normal-case font-normal"> — the exact balanced journal entry that will post</span>
        </p>
      </div>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="flex items-center justify-between bg-surface-950 px-3 py-2 text-2xs text-slate-500">
          <span>Opening balance (historical conversion) — <span className="font-mono text-slate-400">{companyShortCode}</span> as of <span className="font-mono text-slate-400">{asOfDate}</span></span>
          <span>{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-950 text-2xs uppercase tracking-wider text-slate-500">
              <th className="text-left font-medium px-3 py-2">Account</th>
              <th className="text-right font-medium px-3 py-2">Debit</th>
              <th className="text-right font-medium px-3 py-2">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {lines.map((l) => (
              <tr key={l.targetAccountNumber} className="bg-surface-900">
                <td className="px-3 py-1.5">
                  <span className="font-mono text-slate-200">{l.targetAccountNumber}</span>
                  {l.targetName && <span className="text-slate-400"> — {l.targetName}</span>}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-emerald-300">{l.debitCents ? formatMoney(l.debitCents) : <span className="text-slate-700">—</span>}</td>
                <td className="px-3 py-1.5 text-right font-mono text-rose-300">{l.creditCents ? formatMoney(l.creditCents) : <span className="text-slate-700">—</span>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-surface-950 border-t border-slate-700 text-sm font-semibold">
              <td className="px-3 py-2 text-slate-300">Total</td>
              <td className="px-3 py-2 text-right font-mono text-emerald-300">{formatMoney(bal.totalDebitCents)}</td>
              <td className="px-3 py-2 text-right font-mono text-rose-300">{formatMoney(bal.totalCreditCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function ReconLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-200">{formatMoney(value)}</span>
    </div>
  );
}

function MappingBadge({ source, confidence }: { source: MappingSource; confidence: number | null }) {
  const cfg: Record<MappingSource, { label: string; cls: string }> = {
    ai: { label: 'AI', cls: 'bg-indigo-500/15 text-indigo-300' },
    heuristic: { label: 'Auto', cls: 'bg-blue-500/15 text-blue-300' },
    human: { label: 'You', cls: 'bg-emerald-500/15 text-emerald-300' },
    unmapped: { label: 'Unmapped', cls: 'bg-amber-500/15 text-amber-300' },
  };
  const c = cfg[source];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-medium ${c.cls}`}>
      {c.label}{confidence != null && source !== 'human' ? ` ${Math.round(confidence * 100)}%` : ''}
    </span>
  );
}

function SummaryStat({ label, value, tone, mono }: { label: string; value: string; tone: 'ok' | 'bad' | 'muted'; mono?: boolean }) {
  const color = tone === 'ok' ? 'text-brand-400' : tone === 'bad' ? 'text-rose-400' : 'text-slate-200';
  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
      <p className={`text-xl font-semibold ${mono ? 'font-mono' : ''} ${color}`}>{value}</p>
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
