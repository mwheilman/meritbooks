'use client';

/**
 * Import a payroll register from a SPREADSHEET (CSV / XLSX) — the DETERMINISTIC,
 * no-AI complement to the drop-and-parse AI path (`register-import.tsx`).
 *
 * Flow: drop a CSV/XLSX register exported from ADP / Gusto / QuickBooks Payroll /
 * Paychex (or any spreadsheet) → we auto-detect the header row and MAP each column
 * to a payroll field (gross wages, each withholding, employer taxes, deductions, net
 * pay) → the reviewer adjusts the mapping with a LIVE preview and can save it as a
 * reusable per-provider template → we build the BALANCED payroll JE (DR gross wages +
 * DR employer taxes → CR net-pay clearing + CR each tax/withholding liability),
 * addressed by account role → the reviewer picks the company + confirms → it posts to
 * the GL through the SAME gated confirm route the AI path uses (`postJournalEntry` /
 * `check_journal_balance()`).
 *
 * No model is ever called. Nothing is written until the human confirms a balanced
 * entry, and the confirm route re-validates the balance server-side.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import {
  UploadCloud, Loader2, X, FileSpreadsheet, AlertTriangle, CheckCircle2, Info, ChevronDown,
  Search, Scale, Table2, Save, Trash2, ArrowRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import {
  guessMapping, aggregateRows, applySavedMapping, headerSignature,
  TARGET_LABELS,
  type ColumnMapping, type PayrollFieldTarget, type SavedMappingColumn,
} from '@/lib/payroll/register-csv';

// ── Types ─────────────────────────────────────────────────────────────────────
interface ParseResponse {
  fileName: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  mapping: ColumnMapping[];
}
interface ProposedLine {
  roleKey: string;
  side: 'DR' | 'CR';
  cents: number;
  label: string;
  degraded: boolean;
  suggestedAccountId: string | null;
  suggestedAccountNumber: string | null;
  unresolved: boolean;
}
interface BuildResponse {
  register: { payDate: string | null; periodStart: string | null; periodEnd: string | null; employeeCount: number | null; grossCents: number; netCents: number; lowConfidenceFields: string[] };
  lines: ProposedLine[];
  balance: { totalDebitCents: number; totalCreditCents: number; balanced: boolean; imbalanceCents: number; registerFoots: boolean; footingDeltaCents: number };
  unresolvedRoles: string[];
}
interface SavedMapping { id: string; providerName: string; mapping: SavedMappingColumn[]; headerSignature: string | null; updatedAt: string }
interface LocationOption { id: string; name: string; short_code: string }
interface AccountOption { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const todayIso = () => new Date().toISOString().slice(0, 10);
const centsToInput = (c: number) => centsToDollars(c).toFixed(2);
const inputToCents = (s: string) => dollarsToCents(Number(String(s).replace(/[$,\s]/g, '')) || 0);

// The order the target dropdown lists options in.
const TARGET_ORDER: PayrollFieldTarget[] = [
  'ignore', 'employee', 'gross', 'fed_wh', 'state_wh', 'local_wh',
  'fica_ss', 'fica_medicare', 'fica', 'net', 'employer_tax', 'deduction',
];

// ── Inline account picker (searches this company's approved COA) ────────────────
function AccountPicker({
  value, accounts, onChange, placeholder, invalid,
}: {
  value: string; accounts: AccountOption[]; onChange: (id: string) => void; placeholder: string; invalid: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const selected = accounts.find((a) => a.id === value);
  const q = search.trim().toLowerCase();
  const filtered = q ? accounts.filter((a) => a.accountNumber.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) : accounts;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className={clsx('w-full text-left px-2 py-1.5 rounded-lg border text-xs truncate relative',
          selected ? 'bg-slate-800 border-slate-700 text-white' : invalid ? 'bg-slate-800/50 border-amber-500/50 text-slate-400' : 'bg-slate-800/50 border-slate-700/50 text-slate-500')}>
        {selected ? `${selected.accountNumber} · ${selected.name}` : placeholder}
        <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500" />
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-slate-800">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search accounts..." autoFocus
                className="w-full pl-7 pr-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50" />
            </div>
          </div>
          <div className="max-h-44 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-500 text-center">{accounts.length === 0 ? 'Select a company first' : 'No matches'}</p>
            ) : filtered.slice(0, 40).map((a) => (
              <button key={a.id} type="button" onClick={() => { onChange(a.id); setOpen(false); setSearch(''); }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 flex items-center gap-2">
                <span className="font-mono text-slate-500 w-12 shrink-0">{a.accountNumber}</span>
                <span className="text-slate-300 truncate">{a.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Review line draft (post stage) ──────────────────────────────────────────────
interface LineDraft {
  key: string; roleKey: string; side: 'DR' | 'CR'; label: string; amountInput: string;
  accountId: string; degraded: boolean; suggestedAccountId: string | null;
}

// ── Main modal ───────────────────────────────────────────────────────────────
export function ImportRegisterCsv({ open, onClose, onPosted }: { open: boolean; onClose: () => void; onPosted: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'map' | 'building' | 'review' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parsed file + mapping
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [truncated, setTruncated] = useState(false);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [payDate, setPayDate] = useState(todayIso());
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');

  // Save-mapping controls
  const [providerName, setProviderName] = useState('');
  const [savingMapping, setSavingMapping] = useState(false);

  // Review (post) stage
  const [drafts, setDrafts] = useState<LineDraft[]>([]);
  const [locationId, setLocationId] = useState('');
  const [memo, setMemo] = useState('');
  const [unresolvedRoles, setUnresolvedRoles] = useState<string[]>([]);
  const [registerFoots, setRegisterFoots] = useState(true);
  const [footingDelta, setFootingDelta] = useState(0);
  const [reg, setReg] = useState<BuildResponse['register'] | null>(null);
  const [postedEntryNumber, setPostedEntryNumber] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loadingAccts, setLoadingAccts] = useState(false);

  const { data: locData } = useQuery<LocationOption[]>(open ? '/api/locations' : null);
  const locations = useMemo(() => locData ?? [], [locData]);
  const { data: savedData, refetch: refetchSaved } = useQuery<{ mappings: SavedMapping[] }>(open ? '/api/payroll/register-mappings' : null);
  const savedMappings = useMemo(() => savedData?.mappings ?? [], [savedData]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setPhase('idle'); setError(null); setFileName(null); setHeaders([]); setRows([]); setTruncated(false);
      setMapping([]); setPayDate(todayIso()); setPeriodStart(''); setPeriodEnd(''); setProviderName('');
      setDrafts([]); setLocationId(''); setMemo(''); setUnresolvedRoles([]); setRegisterFoots(true);
      setFootingDelta(0); setReg(null); setPostedEntryNumber(null); setSaving(false); setAccounts([]);
    }
  }, [open]);

  // Load company chart in the review stage; default each line to its suggested account.
  useEffect(() => {
    if (!locationId) { setAccounts([]); return; }
    let alive = true;
    setLoadingAccts(true);
    fetch(`/api/accounts?location_id=${locationId}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => {
        if (!alive) return;
        const list = (d.data ?? []) as AccountOption[];
        setAccounts(list);
        const usableIds = new Set(list.filter((a) => a.isActive && a.approvalStatus === 'APPROVED').map((a) => a.id));
        setDrafts((prev) => prev.map((ln) => (
          !ln.accountId && ln.suggestedAccountId && usableIds.has(ln.suggestedAccountId)
            ? { ...ln, accountId: ln.suggestedAccountId } : ln
        )));
      })
      .catch(() => alive && setAccounts([]))
      .finally(() => alive && setLoadingAccts(false));
    return () => { alive = false; };
  }, [locationId]);

  const usableAccounts = useMemo(() => accounts.filter((a) => a.isActive && a.approvalStatus === 'APPROVED'), [accounts]);

  // Live preview aggregation (pure, client-side) as the mapping changes.
  const agg = useMemo(() => aggregateRows(rows, mapping), [rows, mapping]);
  const employerTaxTotal = useMemo(() => agg.employerTaxes.reduce((s, t) => s + t.cents, 0), [agg]);
  const withheldTotal = useMemo(
    () => agg.federalWithholdingCents + agg.stateWithholdingCents + agg.localWithholdingCents + agg.ficaEmployeeCents + agg.deductions.reduce((s, d) => s + d.cents, 0),
    [agg],
  );
  const hasGross = agg.grossCents > 0;
  const hasNet = agg.netCents > 0;

  if (!open) return null;

  // ── File handling ──────────────────────────────────────────────────────────
  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) { setError('File too large. Maximum 10MB.'); setPhase('error'); return; }
    setFileName(file.name);
    setPhase('parsing');
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/payroll/import-register/csv/parse', { method: 'POST', body: form });
    let body: ParseResponse & { error?: string };
    try { body = await res.json(); } catch { setError('The server returned an unreadable response.'); setPhase('error'); return; }
    if (!res.ok) { setError(body.error || 'Failed to read the file.'); setPhase('error'); return; }

    setHeaders(body.headers);
    setRows(body.rows);
    setTruncated(body.truncated);

    // Auto-apply a saved template whose header signature matches; else use the guess.
    const sig = headerSignature(body.headers);
    const match = savedMappings.find((m) => m.headerSignature && m.headerSignature === sig);
    if (match) {
      setMapping(applySavedMapping(body.headers, match.mapping));
      setProviderName(match.providerName);
      addToast('info', `Applied saved mapping "${match.providerName}"`);
    } else {
      setMapping(body.mapping.length ? body.mapping : guessMapping(body.headers));
    }
    setPhase('map');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const setColTarget = (index: number, target: PayrollFieldTarget) =>
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, target, label: undefined } : m)));
  const setColLabel = (index: number, label: string) =>
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, label } : m)));

  const applySaved = (id: string) => {
    const m = savedMappings.find((x) => x.id === id);
    if (!m) return;
    setMapping(applySavedMapping(headers, m.mapping));
    setProviderName(m.providerName);
    addToast('info', `Applied mapping "${m.providerName}"`);
  };

  const saveMapping = async () => {
    if (!providerName.trim()) { addToast('error', 'Name this mapping (e.g. your processor) before saving'); return; }
    setSavingMapping(true);
    const res = await api.post<{ ok: boolean; id: string }>('/api/payroll/register-mappings', {
      providerName: providerName.trim(),
      mapping: mapping.map((m) => ({ header: m.header, target: m.target, label: m.label })),
      headerSignature: headerSignature(headers),
    });
    setSavingMapping(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Saved mapping "${providerName.trim()}"`);
    refetchSaved();
  };

  const deleteSaved = async (id: string, name: string) => {
    const res = await api.delete<{ ok: boolean }>(`/api/payroll/register-mappings?id=${id}`);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Deleted mapping "${name}"`);
    refetchSaved();
  };

  // ── Build the balanced entry (deterministic, server-side aggregation) ────────
  const buildEntry = async () => {
    setError(null);
    setPhase('building');
    const res = await api.post<BuildResponse>('/api/payroll/import-register/csv/build', {
      rows, mapping,
      payDate: payDate || null,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
    });
    if (res.error) { setError(res.error.error); setPhase('map'); addToast('error', res.error.error); return; }
    const b = res.data!;
    setReg(b.register);
    setUnresolvedRoles(b.unresolvedRoles ?? []);
    setRegisterFoots(b.balance.registerFoots);
    setFootingDelta(b.balance.footingDeltaCents);
    setMemo(`Payroll register (spreadsheet) — pay date ${b.register.payDate ?? payDate}`.trim());
    setDrafts(b.lines.map((l, i) => ({
      key: `${i}-${l.roleKey}-${l.side}`,
      roleKey: l.roleKey, side: l.side, label: l.label,
      amountInput: centsToInput(l.cents), accountId: '',
      degraded: l.degraded, suggestedAccountId: l.suggestedAccountId,
    })));
    setPhase('review');
  };

  const patchLine = (key: string, patch: Partial<LineDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  // Live balance from editable review drafts.
  const totalDebits = drafts.filter((d) => d.side === 'DR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const totalCredits = drafts.filter((d) => d.side === 'CR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const imbalance = totalDebits - totalCredits;
  const balanced = imbalance === 0 && totalDebits > 0;
  const allAccountsPicked = drafts.every((d) => inputToCents(d.amountInput) === 0 || !!d.accountId);
  const canPost = !saving && balanced && allAccountsPicked && !!locationId && !!payDate && drafts.length >= 2;

  const confirmPost = async () => {
    setSaving(true);
    const lines = drafts.filter((d) => inputToCents(d.amountInput) > 0).map((d) => ({
      accountId: d.accountId,
      debitCents: d.side === 'DR' ? inputToCents(d.amountInput) : 0,
      creditCents: d.side === 'CR' ? inputToCents(d.amountInput) : 0,
      memo: d.label,
    }));
    const res = await api.post<{ ok: boolean; entryNumber: string; alreadyPosted: boolean }>(
      '/api/payroll/import-register/confirm',
      { locationId, payDate, memo, lines },
    );
    if (res.error) { setSaving(false); addToast('error', res.error.error); return; }
    setPostedEntryNumber(res.data?.entryNumber ?? null);
    setSaving(false);
    setPhase('done');
    addToast('success', res.data?.alreadyPosted ? 'Payroll register already posted' : 'Payroll register posted to the ledger');
    onPosted();
  };

  // Can we build? Need at least a gross column that sums > 0.
  const canBuild = hasGross;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="w-full max-w-4xl bg-surface-900 border border-slate-800 rounded-2xl shadow-2xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <FileSpreadsheet size={16} className="text-emerald-400" /> Import register from spreadsheet
            </h2>
            <p className="text-2xs text-slate-500 mt-0.5">
              CSV or Excel from any processor — no AI. Map the columns once, save the mapping, and post a balanced payroll entry.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Idle: dropzone */}
          {phase === 'idle' && (
            <>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={clsx('cursor-pointer rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors',
                  dragOver ? 'border-emerald-500 bg-emerald-500/5' : 'border-slate-700 hover:border-slate-600 bg-slate-800/20')}>
                <FileSpreadsheet size={28} className="mx-auto text-slate-500 mb-3" />
                <p className="text-sm text-slate-300">Drop a payroll register spreadsheet, or <span className="text-emerald-400">browse</span></p>
                <p className="text-2xs text-slate-500 mt-1">CSV, TSV, or XLSX · up to 10MB · first row must be column headers</p>
              </div>
              <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
              <div className="flex items-start gap-2 text-2xs text-slate-500">
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>Fully deterministic — no model reads your file. Export the payroll register from ADP, Gusto, QuickBooks Payroll, Paychex, or your spreadsheet. Prefer a PDF? Use <span className="text-slate-300">Import payroll register</span> instead.</span>
              </div>
              {savedMappings.length > 0 && (
                <div className="text-2xs text-slate-500">
                  {savedMappings.length} saved column mapping{savedMappings.length === 1 ? '' : 's'} — we auto-apply the matching one when you drop a file.
                </div>
              )}
            </>
          )}

          {(phase === 'parsing' || phase === 'building') && (
            <div className="py-16 text-center">
              <Loader2 size={28} className="mx-auto text-emerald-400 animate-spin mb-3" />
              <p className="text-sm text-slate-300">{phase === 'parsing' ? `Reading ${fileName ?? 'file'}…` : 'Building the balanced payroll entry…'}</p>
              <p className="text-2xs text-slate-500 mt-1">{phase === 'parsing' ? 'Parsing rows and detecting the column mapping.' : 'Summing the mapped columns and resolving accounts.'}</p>
            </div>
          )}

          {phase === 'error' && (
            <div className="py-12 text-center">
              <AlertTriangle size={24} className="mx-auto text-red-400 mb-2" />
              <p className="text-sm text-red-400">{error}</p>
              <button onClick={() => { setPhase('idle'); setError(null); }} className="mt-3 px-3 py-1.5 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Try another file</button>
            </div>
          )}

          {phase === 'done' && (
            <div className="py-12 text-center">
              <CheckCircle2 size={28} className="mx-auto text-emerald-400 mb-2" />
              <p className="text-sm text-emerald-300">Payroll register posted{postedEntryNumber ? ` — entry ${postedEntryNumber}` : ''}.</p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button onClick={() => { setPhase('idle'); setDrafts([]); setPostedEntryNumber(null); }} className="px-3 py-1.5 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Import another</button>
                <button onClick={onClose} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium text-white">Done</button>
              </div>
            </div>
          )}

          {/* ── Stage: MAP ─────────────────────────────────────────────────────── */}
          {phase === 'map' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-2xs text-slate-500">
                  <FileSpreadsheet size={12} /> <span className="text-slate-400">{fileName}</span>
                  <span className="text-slate-600">·</span> <span>{rows.length} row{rows.length === 1 ? '' : 's'}{truncated ? ' (first 20,000)' : ''}</span>
                  <span className="text-slate-600">·</span> <span>{headers.length} columns</span>
                </div>
                {savedMappings.length > 0 && (
                  <div className="flex items-center gap-2">
                    <select onChange={(e) => { if (e.target.value) applySaved(e.target.value); e.target.value = ''; }}
                      className="px-2 py-1.5 rounded-lg text-2xs text-slate-300 bg-slate-800 border border-slate-700" defaultValue="">
                      <option value="">Apply saved mapping…</option>
                      {savedMappings.map((m) => <option key={m.id} value={m.id}>{m.providerName}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {/* Mapping table with a sample preview */}
              <div className="card overflow-hidden">
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-surface-900 z-10">
                      <tr className="border-b border-slate-800 text-2xs uppercase tracking-wider text-slate-500">
                        <th className="text-left px-3 py-2 font-semibold w-48">Column</th>
                        <th className="text-left px-3 py-2 font-semibold">Sample values</th>
                        <th className="text-left px-3 py-2 font-semibold w-64">Maps to</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {mapping.map((m) => {
                        const samples = rows.slice(0, 3).map((r) => r[m.index]).filter((v) => (v ?? '').trim() !== '');
                        const isLabelled = m.target === 'employer_tax' || m.target === 'deduction';
                        return (
                          <tr key={m.index} className="align-top">
                            <td className="px-3 py-2">
                              <span className="text-xs text-slate-200 flex items-center gap-1.5"><Table2 size={11} className="text-slate-500" /> {m.header || `Column ${m.index + 1}`}</span>
                            </td>
                            <td className="px-3 py-2">
                              <span className="text-2xs text-slate-500 font-mono">{samples.length ? samples.join(', ') : '—'}</span>
                            </td>
                            <td className="px-3 py-2">
                              <select value={m.target} onChange={(e) => setColTarget(m.index, e.target.value as PayrollFieldTarget)}
                                className={clsx('w-full px-2 py-1.5 rounded-lg text-xs bg-slate-800 border',
                                  m.target === 'ignore' ? 'border-slate-700 text-slate-500' : 'border-emerald-600/40 text-white')}>
                                {TARGET_ORDER.map((t) => <option key={t} value={t}>{TARGET_LABELS[t]}</option>)}
                              </select>
                              {isLabelled && (
                                <input type="text" value={m.label ?? m.header} onChange={(e) => setColLabel(m.index, e.target.value)}
                                  placeholder="GL line label" className="mt-1 w-full px-2 py-1 rounded-lg text-2xs text-slate-200 bg-slate-800/60 border border-slate-700 placeholder:text-slate-600" />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Live preview */}
              <div className="rounded-xl border border-slate-800 bg-slate-800/20 p-3">
                <div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-slate-400">Live preview — mapped totals</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <PreviewTile label="Gross wages" value={formatMoney(agg.grossCents)} tone="debit" />
                  <PreviewTile label="Withheld & deductions" value={formatMoney(withheldTotal)} />
                  <PreviewTile label="Employer taxes" value={formatMoney(employerTaxTotal)} tone="debit" />
                  <PreviewTile label="Net pay (take-home)" value={formatMoney(agg.netCents)} tone="net" />
                </div>
                {/* Footing / balance readiness */}
                <div className={clsx('mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
                  !hasGross ? 'bg-slate-800/40 border border-slate-700 text-slate-400'
                    : agg.registerFoots ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                    : 'bg-amber-500/10 border border-amber-500/30 text-amber-200')}>
                  <Scale size={14} className="shrink-0" />
                  {!hasGross ? <span>Map a <span className="text-slate-200">Gross wages</span> column to build the entry.</span>
                    : agg.registerFoots ? <span>The register foots — gross equals net + withholdings + deductions. The payroll entry will balance.</span>
                    : <span>Register is off by <span className="font-mono">{formatMoney(Math.abs(agg.footingDeltaCents))}</span> (gross − withholdings − deductions vs net). Check your column mapping{hasNet ? '' : ' — no net pay column is mapped yet'}.</span>}
                </div>
              </div>

              {/* Period + save-mapping */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Pay date</label>
                  <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700" />
                </div>
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Period start (optional)</label>
                  <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700" />
                </div>
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Period end (optional)</label>
                  <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700" />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-800/30 border border-slate-800 px-3 py-2">
                <Save size={13} className="text-slate-500" />
                <span className="text-2xs text-slate-400">Reuse this mapping next time:</span>
                <input type="text" value={providerName} onChange={(e) => setProviderName(e.target.value)}
                  placeholder="e.g. ADP, Gusto" className="px-2 py-1 rounded-lg text-2xs text-white bg-slate-800 border border-slate-700 placeholder:text-slate-600 w-32" />
                <button onClick={() => void saveMapping()} disabled={savingMapping || !providerName.trim()}
                  className="px-2.5 py-1 rounded-lg text-2xs text-slate-200 border border-slate-700 hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1">
                  {savingMapping ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save mapping
                </button>
                {savedMappings.map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-2xs text-slate-400">
                    {m.providerName}
                    <button onClick={() => void deleteSaved(m.id, m.providerName)} className="text-slate-500 hover:text-red-400"><Trash2 size={10} /></button>
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-between pt-1">
                <button onClick={() => { setPhase('idle'); }} className="text-2xs text-slate-500 hover:text-slate-300">Upload a different file</button>
                <button onClick={() => void buildEntry()} disabled={!canBuild}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium text-white flex items-center gap-1.5">
                  Build balanced entry <ArrowRight size={13} />
                </button>
              </div>
            </div>
          )}

          {/* ── Stage: REVIEW (accounts + post) ─────────────────────────────────── */}
          {phase === 'review' && (
            <div className="space-y-4">
              {!registerFoots && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
                  <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-2xs text-amber-200/90">
                    The register does not foot — gross minus withholdings and deductions is off from net pay by
                    {' '}<span className="font-mono">{formatMoney(Math.abs(footingDelta))}</span>. Review the amounts before posting.
                  </p>
                </div>
              )}
              {unresolvedRoles.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
                  <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-2xs text-amber-200/90">
                    No account role is mapped for: <span className="font-mono">{unresolvedRoles.join(', ')}</span>. Pick an account for each line below (or map the role on the Account Roles screen).
                  </p>
                </div>
              )}

              {reg && (
                <div className="rounded-xl border border-slate-800 bg-slate-800/20 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-slate-500">
                    <span className="font-semibold uppercase tracking-wider text-slate-400">Register totals</span>
                    {reg.payDate && <span>Pay date {reg.payDate}</span>}
                    {(reg.periodStart || reg.periodEnd) && <span>Period {reg.periodStart ?? '—'} → {reg.periodEnd ?? '—'}</span>}
                    {typeof reg.employeeCount === 'number' && reg.employeeCount > 0 && <span>{reg.employeeCount} employee{reg.employeeCount === 1 ? '' : 's'}</span>}
                  </div>
                  <p className="text-2xs text-slate-500">
                    Posts as: DR gross wages + DR employer taxes → CR net pay (to cash / in-transit) + CR the tax &amp; deduction liabilities. Review the account for every line before posting.
                  </p>
                </div>
              )}

              {/* Company + pay date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Company</label>
                  <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700">
                    <option value="">Select company…</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Pay date</label>
                  <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg text-xs text-white bg-slate-800 border border-slate-700" />
                </div>
              </div>

              {/* Lines */}
              <div className="card overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-800 text-2xs uppercase tracking-wider text-slate-500">
                      <th className="text-left px-3 py-2 font-semibold">Line</th>
                      <th className="text-left px-3 py-2 font-semibold w-56">Account</th>
                      <th className="text-right px-3 py-2 font-semibold w-24">Debit</th>
                      <th className="text-right px-3 py-2 font-semibold w-24">Credit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {drafts.map((d) => (
                      <tr key={d.key} className="align-top">
                        <td className="px-3 py-2">
                          <span className="text-xs text-slate-200">{d.label}</span>
                          {d.degraded && <span className="block text-2xs text-amber-400/80 mt-0.5">Unmapped — verify account</span>}
                        </td>
                        <td className="px-3 py-2">
                          <AccountPicker value={d.accountId} accounts={usableAccounts}
                            invalid={inputToCents(d.amountInput) > 0 && !d.accountId}
                            placeholder={!locationId ? 'Pick a company first' : loadingAccts ? 'Loading…' : 'Select account'}
                            onChange={(id) => patchLine(d.key, { accountId: id })} />
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {d.side === 'DR' ? (
                            <input type="number" min="0" step="0.01" value={d.amountInput}
                              onChange={(e) => patchLine(d.key, { amountInput: e.target.value })}
                              className="w-20 px-2 py-1 rounded-lg text-xs text-emerald-300 font-mono text-right bg-slate-800 border border-slate-700" />
                          ) : <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {d.side === 'CR' ? (
                            <input type="number" min="0" step="0.01" value={d.amountInput}
                              onChange={(e) => patchLine(d.key, { amountInput: e.target.value })}
                              className="w-20 px-2 py-1 rounded-lg text-xs text-red-300 font-mono text-right bg-slate-800 border border-slate-700" />
                          ) : <span className="text-slate-700">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-800 text-xs font-mono">
                      <td className="px-3 py-2 text-slate-400" colSpan={2}>Totals</td>
                      <td className="px-3 py-2 text-right text-emerald-300">{formatMoney(totalDebits)}</td>
                      <td className="px-3 py-2 text-right text-red-300">{formatMoney(totalCredits)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Balance banner */}
              <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
                totalDebits === 0 ? 'bg-slate-800/40 border border-slate-700 text-slate-400'
                  : balanced ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                  : 'bg-red-500/10 border border-red-500/30 text-red-300')}>
                <Scale size={14} className="shrink-0" />
                {totalDebits === 0 ? <span>Enter the register amounts above to build the balanced entry.</span>
                  : balanced ? <span>Balanced — debits equal credits at <span className="font-mono">{formatMoney(totalDebits)}</span>.</span>
                  : <span>Out of balance by <span className="font-mono">{formatMoney(Math.abs(imbalance))}</span> — debits <span className="font-mono">{formatMoney(totalDebits)}</span> vs credits <span className="font-mono">{formatMoney(totalCredits)}</span>. Fix the amounts before posting.</span>}
              </div>

              <div className="flex items-center justify-between pt-1">
                <button onClick={() => setPhase('map')} className="text-2xs text-slate-500 hover:text-slate-300">Back to column mapping</button>
                <button onClick={() => void confirmPost()} disabled={!canPost}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium text-white flex items-center gap-1.5">
                  {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Confirm &amp; post payroll entry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewTile({ label, value, tone }: { label: string; value: string; tone?: 'debit' | 'net' }) {
  return (
    <div className="rounded-lg bg-slate-900/40 px-2.5 py-2">
      <p className="text-2xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className={clsx('mt-0.5 font-mono text-sm font-semibold tabular-nums',
        tone === 'net' ? 'text-emerald-400' : tone === 'debit' ? 'text-slate-200' : 'text-slate-300')}>{value}</p>
    </div>
  );
}
